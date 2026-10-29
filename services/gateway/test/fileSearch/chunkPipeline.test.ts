// The file → chunk rows pipeline without a database: what the context writer is
// given (each chunk's document offset, heading path, table header; never a chunk
// of only whitespace), the context and embedding input it produces, the per-file
// limit checked before chunking with the same estimate for both strategies, and
// static output exactly chunkText's.
let mockConfig: any;
jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
  default: { getFileSearchConfig: () => mockConfig },
}));

const writerMock = jest.fn();
jest.mock('../../src/fileSearch/contextWriter', () => ({
  ...jest.requireActual('../../src/fileSearch/contextWriter'),
  writeChunkContexts: (...a: any[]) => writerMock(...a),
}));

const offThreadMock = jest.fn();
jest.mock('../../src/fileSearch/structureChunkThread', () => {
  const actual = jest.requireActual('../../src/fileSearch/structureChunkThread');
  return { ...actual, chunkStructuredOffThread: (...a: any[]) => offThreadMock(...a) };
});

import {
  chunkContext, estimatedChunkCount, FileHasTooManyChunksError, FileTooLargeError, maxChunksPerFile, prepareFileChunks,
} from '../../src/fileSearch/chunkPipeline';
import { embeddingInputOf } from '../../src/fileSearch/chunkRows';
import { chunkText, estimateTokens } from '../../src/fileSearch/chunker';
import { chunkStructuredWithSections, countTokens } from '../../src/fileSearch/structureChunker';

// Long enough that each Repeat section is chunked into several identical pieces.
const SAME = 'Same words again and again, the same sentence that repeats in both sections of this guide, '
  + 'long enough that a chunk of one hundred tokens holds one paragraph of it and the heading line, or two of them.';
const REPEAT_BODY = [SAME, SAME, SAME, SAME].join('\n\n');
const DOC = [
  '# Guide', '', 'Intro words about the guide and the gateway, long enough to stand alone as a section of its own here.', '',
  '## Ports', '', '| Port | Service |', '| --- | --- |',
  ...Array.from({ length: 50 }, (_, i) => `| ${8000 + i} | service-${i} |`), '',
  '## Repeat', '', REPEAT_BODY, '',
  '## Repeat too', '', REPEAT_BODY, '',
  '## Blank', '', `Start.${' \t'.repeat(400)}End of the blank section, with a few more words.`,
].join('\n');

const STRUCTURE = { type: 'structure' as const, max_tokens: 100, overlap_tokens: 0, contextual: true };
const opts = (deadline = Date.now() + 600_000) => ({
  extractTimeoutMs: 5000, maxTokensPerFile: 1_000_000, deadline, caller: null, embeddingDimensions: 1536,
});

beforeEach(() => {
  mockConfig = { contextual: { fileDeadlineMs: 360_000 }, ingestion: { extractTimeoutMs: 5000 } };
  writerMock.mockReset();
  writerMock.mockImplementation(async (_doc: string, chunks: any[]) => ({
    contexts: chunks.map((c, i) => (i % 2 === 0 ? `Sentence ${i}.` : null)),
    failed: Math.floor(chunks.length / 2),
    usage: { input: 10, cacheWrite: 0, cachedRead: 5, output: 2 },
    model: 'fake',
  }));
  offThreadMock.mockReset();
  offThreadMock.mockImplementation(async (text: string, o: any, x: any) => {
    const { chunks, sections } = chunkStructuredWithSections(text, o);
    return {
      chunks, starts: chunks.map((c) => sections[c.section].start + c.sectionOffset),
      documentTokens: x?.countDocument ? countTokens(text) : undefined, elapsedMs: 1, offThread: true,
    };
  });
});

describe('chunkContext and embeddingInputOf', () => {
  it('joins heading path, sentence and table header, those present; null when none', () => {
    expect(chunkContext('A > B', 'It is about B.', '| x |\n| --- |')).toBe('A > B\nIt is about B.\n| x |\n| --- |');
    expect(chunkContext('A > B', null)).toBe('A > B');
    expect(chunkContext(null, 'Only a sentence.')).toBe('Only a sentence.');
    expect(chunkContext(null, null, undefined)).toBeNull();
    expect(chunkContext('  ', '')).toBeNull();
  });

  it('embeds context + text, text alone without a context, nothing for whitespace', () => {
    expect(embeddingInputOf({ text: 'body', context: 'A > B' })).toBe('A > B\n\nbody');
    expect(embeddingInputOf({ text: 'body', context: null })).toBe('body');
    expect(embeddingInputOf({ text: 'body' })).toBe('body');
    expect(embeddingInputOf({ text: ' \t\n ', context: 'A' })).toBeNull();
  });
});

describe('prepareFileChunks', () => {
  it('structure + contextual: the writer gets every non-blank chunk at its own document offset, with heading path and table header', async () => {
    const prepared = await prepareFileChunks('guide.md', Buffer.from(DOC), STRUCTURE, opts());
    const { chunks } = prepared;
    expect(chunks.some((c) => !/\S/.test(c.text))).toBe(true);
    expect(writerMock).toHaveBeenCalledTimes(1);
    const [document, sent, options] = writerMock.mock.calls[0];
    expect(document).toBe(DOC);
    const nonBlank = chunks.filter((c) => /\S/.test(c.text));
    expect(sent.map((c: any) => c.text)).toEqual(nonBlank.map((c) => c.text));
    for (const c of sent) expect(DOC.startsWith(c.text, c.start)).toBe(true);
    // identical chunk texts in the two Repeat sections are placed apart, each at its own offset
    const counts = new Map<string, number>();
    for (const c of sent) counts.set(c.text, (counts.get(c.text) ?? 0) + 1);
    const twice = sent.filter((c: any) => (counts.get(c.text) ?? 0) > 1);
    expect(twice.length).toBeGreaterThanOrEqual(2);
    expect(new Set(twice.map((c: any) => c.start)).size).toBe(twice.length);
    expect(sent.some((c: any) => c.tableHeader === '| Port | Service |\n| --- | --- |')).toBe(true);
    expect(sent.map((c: any) => c.headingPath)).toEqual(nonBlank.map((c) => c.headingPath));
    expect(options.documentTokens).toBe(countTokens(DOC));
    expect(options.settings.fileDeadlineMs).toBeLessThanOrEqual(300_000); // half of the remaining 600 s
    expect(typeof options.onCall).toBe('function');

    // contexts: heading path, then the sentence where one was written, then the table header
    nonBlank.forEach((c, k) => {
      const tableHeader = sent[k].tableHeader;
      expect(c.context).toBe([c.headingPath, k % 2 === 0 ? `Sentence ${k}.` : null, tableHeader].filter(Boolean).join('\n'));
    });
    for (const c of chunks.filter((x) => !/\S/.test(x.text))) expect(c.context).toBeNull();
    expect(prepared.context).toEqual({ model: 'fake', input: 10, cachedRead: 5, output: 2, failed: Math.floor(nonBlank.length / 2) });
    expect(chunks.map((c) => c.ord)).toEqual(chunks.map((_, i) => i));
  });

  it('the writer\'s stop reason reaches the file\'s context totals', async () => {
    for (const stopped of ['deadline', 'budget', 'failing'] as const) {
      writerMock.mockImplementationOnce(async (_doc: string, chunks: any[]) => ({
        contexts: chunks.map(() => null), failed: chunks.length, usage: { input: 1, cacheWrite: 0, cachedRead: 0, output: 0 }, model: 'fake', stopped,
      }));
      // eslint-disable-next-line no-await-in-loop
      const prepared = await prepareFileChunks('guide.md', Buffer.from(DOC), STRUCTURE, opts());
      expect(prepared.context?.stopped).toBe(stopped);
    }
  });

  it('the writer\'s deadline is the configured one when that is shorter than half the time left', async () => {
    mockConfig.contextual.fileDeadlineMs = 10_000;
    await prepareFileChunks('guide.md', Buffer.from(DOC), STRUCTURE, opts());
    expect(writerMock.mock.calls[0][2].settings.fileDeadlineMs).toBe(10_000);
  });

  it('structure without contextual: heading path (and table header) as context, no writer call, no document count', async () => {
    const prepared = await prepareFileChunks('guide.md', Buffer.from(DOC), { ...STRUCTURE, contextual: false }, opts());
    expect(writerMock).not.toHaveBeenCalled();
    expect(offThreadMock.mock.calls[0][2]).toMatchObject({ countDocument: false });
    expect(prepared.context).toBeUndefined();
    expect(prepared.chunks.filter((c) => /\S/.test(c.text)).every((c) => c.context === c.headingPath
      || c.context === `${c.headingPath}\n| Port | Service |\n| --- | --- |`)).toBe(true);
  });

  it('static: exactly chunkText\'s chunks, no structure, no context, the thread never used', async () => {
    const setting = { type: 'static' as const, max_tokens: 200, overlap_tokens: 50, contextual: false };
    const prepared = await prepareFileChunks('guide.md', Buffer.from(DOC), setting, opts());
    expect(prepared.chunks.map((c) => ({ ord: c.ord, text: c.text, tokens: c.tokens })))
      .toEqual(chunkText(DOC, { type: 'static', static: { max_chunk_size_tokens: 200, chunk_overlap_tokens: 50 } }));
    expect(prepared.chunks.every((c) => c.section === null && c.context === null && c.headingPath === null)).toBe(true);
    expect(offThreadMock).not.toHaveBeenCalled();
    expect(writerMock).not.toHaveBeenCalled();
  });

  it('the per-file limit uses the same estimate for both strategies and is checked before chunking', async () => {
    const limit = estimateTokens(DOC) - 1;
    for (const setting of [STRUCTURE, { type: 'static' as const, max_tokens: 800, overlap_tokens: 400, contextual: false }]) {
      // eslint-disable-next-line no-await-in-loop
      await expect(prepareFileChunks('guide.md', Buffer.from(DOC), setting, { ...opts(), maxTokensPerFile: limit }))
        .rejects.toBeInstanceOf(FileTooLargeError);
    }
    expect(offThreadMock).not.toHaveBeenCalled();
  });

  it('the chunk ceiling: 128 MiB of float32 vectors per file, never below a legal file at the default 800/400', () => {
    expect(maxChunksPerFile(1536, 5_000_000)).toBe(21845);
    expect(maxChunksPerFile(3072, 5_000_000)).toBe(12500);
    expect(maxChunksPerFile(4000, 5_000_000)).toBe(12500);
    expect(maxChunksPerFile(4000, 1_000_000)).toBe(8388);
  });

  it('a 5M-token file at the default 800/400 setting passes the ceiling at 1536, 3072 and 4000 dimensions', async () => {
    // 3,846,153 words × 1.3 = 4,999,999 estimated tokens, the per-file limit.
    const text = 'lorem '.repeat(3_846_153);
    const setting = { type: 'static' as const, max_tokens: 800, overlap_tokens: 400, contextual: false };
    for (const dims of [1536, 3072, 4000]) {
      // eslint-disable-next-line no-await-in-loop
      const { chunks } = await prepareFileChunks('big.md', Buffer.from(text), setting,
        { ...opts(), maxTokensPerFile: 5_000_000, embeddingDimensions: dims });
      expect(chunks.length).toBeGreaterThan(8388);
      expect(chunks.length).toBeLessThanOrEqual(maxChunksPerFile(dims, 5_000_000));
    }
  }, 120_000);

  it('extraction reports the text\'s length before chunking and before any context call', async () => {
    const order: string[] = [];
    writerMock.mockImplementationOnce(async (_d: string, chunks: any[]) => {
      order.push('writer');
      return { contexts: chunks.map(() => null), failed: chunks.length, usage: { input: 0, cacheWrite: 0, cachedRead: 0, output: 0 }, model: 'fake' };
    });
    offThreadMock.mockImplementationOnce(async (text: string, o: any, x: any) => {
      order.push('chunk');
      const { chunks, sections } = chunkStructuredWithSections(text, o);
      return { chunks, starts: chunks.map((c) => sections[c.section].start + c.sectionOffset), documentTokens: x?.countDocument ? countTokens(text) : undefined, elapsedMs: 1, offThread: true };
    });
    await prepareFileChunks('guide.md', Buffer.from(DOC), STRUCTURE, {
      ...opts(), onExtracted: async (x) => { order.push(`extracted ${x.textChars} ${x.estimatedTokens}`); },
    });
    expect(order).toEqual([`extracted ${DOC.length} ${estimateTokens(DOC)}`, 'chunk', 'writer']);
    expect(estimatedChunkCount(8000, { max_tokens: 800, overlap_tokens: 400 }, 100)).toBe(20);
    expect(estimatedChunkCount(8000, { max_tokens: 100, overlap_tokens: 0 }, 50)).toBe(50); // within the ceiling
  });

  it('a file over the chunk ceiling is refused right after chunking (both strategies), before any context call', async () => {
    const dims = 11_184_810; // a ceiling of 3 chunks (with a per-file limit of at most 1,200 tokens)
    expect(maxChunksPerFile(dims, 1_000)).toBe(3);
    for (const setting of [STRUCTURE, { type: 'static' as const, max_tokens: 100, overlap_tokens: 0, contextual: false }]) {
      // eslint-disable-next-line no-await-in-loop
      const err = await prepareFileChunks('guide.md', Buffer.from(DOC), setting,
        { ...opts(), maxTokensPerFile: 1_000, embeddingDimensions: dims }).catch((e) => e);
      expect(err).toBeInstanceOf(FileHasTooManyChunksError);
      expect(err.message).toMatch(
        /^The file has \d+ chunks, more than the 3 a file may have at 11184810 embedding dimensions\. Choose a larger chunk size \(max_tokens\) or split the file\.$/);
    }
    expect(offThreadMock).toHaveBeenCalledTimes(1); // chunked once (structure), then refused
    expect(writerMock).not.toHaveBeenCalled();
  });
});

