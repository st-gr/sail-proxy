// Legacy Word (.doc, Word 97–2003 binary) text extraction via `antiword`.
//
// antiword (Alpine `antiword`, ≈ 0.5 MiB) is installed in the Docker image, which Kyma runs too;
// LibreOffice would read more but weighs ≈ 330 MiB. antiword is unmaintained and parses hostile
// bytes, so it runs only through the runner's sandbox (runners.ts): no shell, an empty
// environment, a wall-clock timeout that kills its process group, a cap on its output, low CPU
// priority. It needs a seekable file (it reads the OLE container by offset, so a pipe on stdin
// fails), so the bytes go to a private temporary file (runExtractorOnFile) removed after the run.
//
// Off when:
// - FILE_SEARCH_DOC is `off`: the npm standalone CLI (the lite gateway) always sets it
//   (npm-dist/sail-proxy, utils/gateway-env.ts), after the user's .env, so no setting turns .doc
//   reading on there. Unset or `auto`: on when antiword is on PATH.
// - antiword is not on this process's PATH (local dev without it).
// Either way the registry refuses a .doc permanently (registry.ts LegacyDocUnsupportedError).

import { DocumentReadError } from './ooxml/limits';
import { ExtractorExitError, resolveBinary, runExtractorOnFile } from './runners';

/** The env variable that switches .doc reading off. */
export const DOC_SWITCH_ENV = 'FILE_SEARCH_DOC';

/** The converter binary, resolved on this process's PATH. */
export const DOC_CONVERTER = 'antiword';

const OFF_VALUES = new Set(['off', 'false', '0', 'no', 'disabled']);

// -m UTF-8.txt: write UTF-8 (antiword's default mapping follows the locale, and the child has
// none). -w 0: a paragraph on one line rather than wrapped at 76 columns.
const ANTIWORD_ARGS = ['-m', 'UTF-8.txt', '-w', '0'] as const;

/** Whether FILE_SEARCH_DOC switches .doc reading off (an unknown value counts as `auto`). */
export function legacyDocSwitchedOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return OFF_VALUES.has((env[DOC_SWITCH_ENV] ?? '').trim().toLowerCase());
}

// Whether antiword is on PATH, found once per process. resolveBinary remembers a hit but rescans
// PATH on every miss, and a host without antiword (local dev) asks on every .doc upload and every
// supported-extension check; PATH does not change under a running gateway, so a miss is kept too.
let antiwordOnPath: boolean | undefined;

/** Forgets whether antiword was found (tests that change PATH). */
export function resetLegacyDocPathCache(): void {
  antiwordOnPath = undefined;
}

/** Whether this gateway reads .doc files: not switched off, and antiword on PATH. */
export function isLegacyDocEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (legacyDocSwitchedOff(env)) return false;
  if (antiwordOnPath === undefined) {
    try {
      resolveBinary(DOC_CONVERTER);
      antiwordOnPath = true;
    } catch {
      antiwordOnPath = false;
    }
  }
  return antiwordOnPath;
}

export interface LegacyDocOptions {
  timeoutMs: number;
  /** Test seam: a tighter output cap than the runner's default. */
  maxOutputBytes?: number;
}

/**
 * The text of a .doc file, one paragraph per line. The caller checks isLegacyDocEnabled first.
 *
 * @throws DocumentReadError when antiword refuses the file — not a Word document, encrypted or
 *   damaged (permanent: a retry reads the same bytes). antiword's stderr is not echoed: it names
 *   the temporary file and can quote the document.
 * @throws ExtractionTimeoutError / ExtractionOutputTooLargeError from the runner, and the runner's
 *   ExtractorExitError with exitCode null when antiword was killed by a signal (transient).
 */
export async function readLegacyDoc(bytes: Buffer, opts: LegacyDocOptions): Promise<string> {
  try {
    return await runExtractorOnFile(DOC_CONVERTER, [...ANTIWORD_ARGS], bytes, {
      timeoutMs: opts.timeoutMs,
      maxOutputBytes: opts.maxOutputBytes,
      lowPriority: true,
    });
  } catch (error) {
    // exitCode null: antiword ended by a signal (an OOM kill, say), not by refusing the file. That
    // says nothing about the bytes, so it stays a plain error and is retried like any transient one.
    if (error instanceof ExtractorExitError && error.exitCode !== null) {
      throw new DocumentReadError('Word', 'it is not a Word 97–2003 document, or it is encrypted or damaged');
    }
    throw error;
  }
}
