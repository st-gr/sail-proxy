// Limits and errors of the built-in PowerPoint/Excel reader (pptx.ts, xlsx.ts), and its time
// slicing.
//
// An uploaded .pptx/.xlsx is a zip of XML parts and is hostile input: the reader never writes to
// disk (entry names are only lookup keys), inflates only the parts it needs, each in Node's thread
// pool with an output cap, refuses DTDs (no entity expansion), caps every XML token, and reads the
// XML in slices with a yield after each one. Any limit violation or broken structure is a
// DocumentReadError — a permanent failure of the file (a retry reads the same bytes); running past
// the extraction time limit is an ExtractionTimeoutError, transient like a pandoc timeout.
//
// The caps bound the work, but a step between two yields can still take a while on a crafted file
// (it is checked against the time limit only between slices and row batches). That is why the
// gateway runs the reader in a worker thread (ooxmlThread.ts) with a hard wall-clock limit and a
// heap limit; the slicing only matters for the in-process fallback.

import { ExtractionTimeoutError } from '../runners';

export const OOXML_LIMITS = Object.freeze({
  /** Entries in the archive's central directory. */
  maxEntries: 10_000,
  /** Inflated size of one part the reader reads. */
  maxEntryBytes: 64 * 1024 * 1024,
  /** Inflated size of all parts the reader reads together. */
  maxTotalBytes: 256 * 1024 * 1024,
  /** Inflated/compressed size of one part (zip bomb), checked for parts over ratioMinBytes. */
  maxRatio: 200,
  ratioMinBytes: 1024 * 1024,
  /** Element nesting in one XML part. */
  maxXmlDepth: 256,
  /** Characters of one XML token: a tag (name and attributes), a text node, a comment, CDATA. */
  maxTokenChars: 1024 * 1024,
  /** Characters of one custom number format code (Excel allows 255); longer codes show raw numbers. */
  maxNumFmtChars: 1024,
  /** Rows of one slide table. */
  maxTableRows: 100_000,
  maxSlides: 2_000,
  maxSheets: 1_000,
  /** Non-empty cells of a workbook, all sheets together. */
  maxCells: 500_000,
  /** Characters of the Markdown text the reader returns (the gateway's heap receives it whole;
   *  ingestion's maxTokensPerFile refuses longer texts anyway). */
  maxOutputChars: 32 * 1024 * 1024,
  /** Characters of XML scanned between two yields to the event loop. */
  sliceChars: 128 * 1024,
});

export type OoxmlLimits = { readonly [K in keyof typeof OOXML_LIMITS]: number };
export type OoxmlKind = 'PowerPoint' | 'Excel';
/** The kinds a DocumentReadError names: the built-in reader's, and legacy Word (legacyDoc.ts). */
export type DocumentKind = OoxmlKind | 'Word';

export interface OoxmlReadOptions {
  /** The extraction time limit (ExtractOptions.timeoutMs); none = unbounded. */
  timeoutMs?: number;
  /** Test seam: tighter limits. */
  limits?: Partial<OoxmlLimits>;
}

/** The file cannot be read: broken, hostile or over a limit. Permanent (ingestWorker.isPermanentFailure). */
export class DocumentReadError extends Error {
  constructor(readonly kind: DocumentKind, readonly reason: string) {
    super(`Could not read the ${kind} file: ${reason}`);
    this.name = 'DocumentReadError';
  }
}

/** A reason without the kind; the reader turns it into a DocumentReadError of its kind. */
export class OoxmlFault extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'OoxmlFault';
  }
}

/** Shared state of one read: limits, the deadline, the inflated byte total. */
export class ReadContext {
  readonly limits: OoxmlLimits;
  private readonly deadline: number;
  inflatedBytes = 0;
  outputChars = 0;

  constructor(readonly kind: OoxmlKind, opts: OoxmlReadOptions, private readonly label = `the ${kind} reader`) {
    this.limits = Object.freeze({ ...OOXML_LIMITS, ...(opts.limits ?? {}) });
    this.timeoutMs = opts.timeoutMs;
    this.deadline = opts.timeoutMs === undefined ? Infinity : Date.now() + opts.timeoutMs;
  }

  readonly timeoutMs: number | undefined;

  /** Yield to the event loop, then fail if the time limit has passed. */
  async tick(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.checkTime();
  }

  /** Counts characters of the text being built; fails past maxOutputChars. */
  addOutput(chars: number): void {
    this.outputChars += chars;
    if (this.outputChars > this.limits.maxOutputChars) {
      throw new OoxmlFault(`its text is longer than the limit (more than ${this.limits.maxOutputChars} characters)`);
    }
  }

  checkTime(): void {
    if (Date.now() > this.deadline) throw new ExtractionTimeoutError(this.label, this.timeoutMs ?? 0);
  }
}

/** Run a read, turning its faults into DocumentReadErrors of `kind`. */
export async function asDocumentRead<T>(kind: OoxmlKind, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error: any) {
    if (error instanceof OoxmlFault) throw new DocumentReadError(kind, error.message);
    // A backstop: a structure so large that a step ran out of stack or array length is no
    // transient failure either.
    if (error instanceof RangeError) throw new DocumentReadError(kind, 'it is too large or too deeply structured to read');
    throw error;
  }
}
