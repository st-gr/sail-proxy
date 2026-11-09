/**
 * The chunk context writer (fileSearch/contextWriter.ts) against a fake completion: message
 * layout, the document window rule, the concurrency bound, the soft deadline, best-effort
 * failure counting, usage totals and output sanitising. No network.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

const mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => mockLogger }));

let mockContextual: any;
jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  default: { getFileSearchConfig: () => ({ contextual: mockContextual }) },
}));

import {
  writeChunkContexts, sanitizeContext, documentWindows, estimateContextTokens, CONTEXT_SYSTEM_PROMPT, ContextChunk,
} from '../../src/fileSearch/contextWriter';
import { chunkStructured, countTokens, structuredSections } from '../../src/fileSearch/structureChunker';
import { CompletionError, CompletionCall, CompletionResult } from '../../src/fileSearch/orchestrationCompletion';

const DEFAULTS = {
  model: 'gemini-3.5-flash-lite', maxDocumentTokens: 32000, concurrency: 4, requestTimeoutMs: 30000, fileDeadlineMs: 360000,
};

function ok(text = 'This chunk is about X.', usage = { input: 10, cacheWrite: 0, cachedRead: 90, output: 8 }): CompletionResult {
  return { text, usage, elapsedMs: 3 };
}

type Fake = jest.Mock<(call: CompletionCall) => Promise<CompletionResult>>;
const fake = (impl?: (call: CompletionCall, n: number) => Promise<CompletionResult>): Fake => {
  let n = 0;
  return jest.fn((call: CompletionCall) => (impl ? impl(call, n++) : Promise.resolve(ok())));
};

const chunkText = (call: CompletionCall) => call.messages[1].text;
const docText = (call: CompletionCall) => call.messages[0].text;

beforeEach(() => {
  jest.clearAllMocks();
  mockContextual = { ...DEFAULTS };
});

const DOC = '# Guide\n\nIntro text.\n\n## Install\n\nRun the installer.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
const CHUNKS: ContextChunk[] = [
  { text: '# Guide\n\nIntro text.', headingPath: 'Guide' },
  { text: '## Install\n\nRun the installer.', headingPath: 'Guide > Install' },
  { text: '| 1 | 2 |', headingPath: 'Guide > Install', tableHeader: '| a | b |\n|---|---|' },
];

describe('message layout', () => {
  it('document first (identical for every chunk when it fits), then the chunk with its heading path and table header', async () => {
    const complete = fake();
    const r = await writeChunkContexts(DOC, CHUNKS, { complete });
    expect(r.contexts).toEqual(['This chunk is about X.', 'This chunk is about X.', 'This chunk is about X.']);
    expect(r.failed).toBe(0);
    expect(complete).toHaveBeenCalledTimes(3);
    const calls = complete.mock.calls.map((c) => c[0]);
    for (const call of calls) {
      expect(call.model).toBe('gemini-3.5-flash-lite');
      expect(call.system).toBe(CONTEXT_SYSTEM_PROMPT);
      expect(call.messages).toHaveLength(2);
      expect(docText(call)).toBe(`<document>\n${DOC}\n</document>`);
      expect(call.params).toMatchObject({ temperature: 0 });
      expect(call.params?.max_tokens).toBeGreaterThan(0);
      expect(call.timeoutMs).toBe(30000);
    }
    expect(chunkText(calls[0])).toContain('Guide');
    expect(chunkText(calls[0])).toContain('<chunk>\n# Guide\n\nIntro text.\n</chunk>');
    expect(chunkText(calls[1])).toContain('Guide > Install');
    expect(chunkText(calls[2])).toContain('| a | b |\n|---|---|');
    expect(chunkText(calls[2])).toContain('<chunk>\n| 1 | 2 |\n</chunk>');
    // the system instruction carries no document or chunk text
    expect(CONTEXT_SYSTEM_PROMPT).not.toContain('Intro text');
  });

  it('a chunk without heading path or table header gets neither line', async () => {
    const complete = fake();
    await writeChunkContexts('plain text only', [{ text: 'plain text only', headingPath: null }], { complete });
    const t = chunkText(complete.mock.calls[0][0]);
    expect(t).not.toMatch(/Section:|Table header/);
  });

  it('settings come from file_search.contextual; per-call overrides win', async () => {
    mockContextual = { ...DEFAULTS, model: 'anthropic--claude-4.5-haiku', requestTimeoutMs: 1234 };
    const complete = fake();
    const r = await writeChunkContexts(DOC, CHUNKS.slice(0, 1), { complete });
    expect(complete.mock.calls[0][0]).toMatchObject({ model: 'anthropic--claude-4.5-haiku', timeoutMs: 1234 });
    expect(r.model).toBe('anthropic--claude-4.5-haiku');
    const complete2 = fake();
    await writeChunkContexts(DOC, CHUNKS.slice(0, 1), { complete: complete2, settings: { model: 'gpt-5-nano' } });
    expect(complete2.mock.calls[0][0].model).toBe('gpt-5-nano');
  });

  it('invalid settings fall back to the defaults', async () => {
    mockContextual = { model: '', maxDocumentTokens: -1, concurrency: 0, requestTimeoutMs: 'x', fileDeadlineMs: NaN };
    const complete = fake();
    const r = await writeChunkContexts(DOC, CHUNKS.slice(0, 1), { complete });
    expect(r.model).toBe('gemini-3.5-flash-lite');
    expect(complete.mock.calls[0][0].timeoutMs).toBe(30000);
  });

  it('no chunks → no call', async () => {
    const complete = fake();
    const r = await writeChunkContexts(DOC, [], { complete });
    expect(r).toMatchObject({ contexts: [], failed: 0, usage: { input: 0, cacheWrite: 0, cachedRead: 0, output: 0 } });
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('document window rule', () => {
  // 400 lines of 50 chars = 20,000 chars; documentTokens 10,000 → 2 chars per token.
  const lines = Array.from({ length: 400 }, (_, i) => `line ${String(i).padStart(4, '0')} ${'x'.repeat(39)}`);
  const BIG = lines.join('\n');
  const chunks: ContextChunk[] = Array.from({ length: 40 }, (_, i) => ({
    text: lines.slice(i * 10, i * 10 + 10).join('\n'), headingPath: null,
  }));

  it('whole document when it fits the window', async () => {
    const complete = fake();
    await writeChunkContexts(BIG, chunks.slice(0, 2), { complete, documentTokens: 10000, settings: { maxDocumentTokens: 10000 } });
    expect(docText(complete.mock.calls[0][0])).toBe(`<document>\n${BIG}\n</document>`);
  });

  it('a larger document: fixed half-overlapping windows; each chunk gets one that contains it; neighbours share it', async () => {
    const complete = fake();
    await writeChunkContexts(BIG, chunks, {
      complete, documentTokens: 10000, settings: { maxDocumentTokens: 2000, concurrency: 1 },
    });
    const prefixes = complete.mock.calls.map((c) => docText(c[0]));
    const distinct = new Set(prefixes);
    // window ≈ 4,000 chars, stride ≈ 2,000 → about 9 windows for 40 chunks
    expect(distinct.size).toBeGreaterThan(1);
    expect(distinct.size).toBeLessThanOrEqual(10);
    complete.mock.calls.forEach((c, i) => {
      const prefix = docText(c[0]);
      expect(prefix.startsWith('<document_excerpt>\n')).toBe(true);
      const body = prefix.slice('<document_excerpt>\n'.length, -'\n</document_excerpt>'.length);
      expect(body.length).toBeLessThanOrEqual(4000);
      expect(body).toContain(chunks[i].text);
      // snapped to whole lines
      expect(BIG.includes(body)).toBe(true);
      expect(body.startsWith('line ')).toBe(true);
      expect(body.endsWith('x')).toBe(true);
    });
  });

  it('documentWindows: deterministic, covering, the last one ends at the end', () => {
    const w = documentWindows(BIG.length, 4000);
    expect(w[0].start).toBe(0);
    expect(w[w.length - 1].end).toBe(BIG.length);
    for (let i = 1; i < w.length; i++) expect(w[i].start).toBeLessThan(w[i - 1].end);
    expect(documentWindows(BIG.length, 4000)).toEqual(w);
    expect(documentWindows(100, 4000)).toEqual([{ start: 0, end: 100 }]);
  });

  it('uses a given start offset to place a chunk whose text repeats', async () => {
    const rep = `${'A'.repeat(3000)}\nDUP\n${'B'.repeat(3000)}\nDUP\n${'C'.repeat(3000)}`;
    const second = rep.lastIndexOf('DUP');
    const complete = fake();
    await writeChunkContexts(rep, [{ text: 'DUP', start: second }], {
      complete, documentTokens: 9000, settings: { maxDocumentTokens: 3000 },
    });
    const body = docText(complete.mock.calls[0][0]);
    expect(body).toContain('C');
    expect(body).not.toContain('AAAA');
  });
});

describe('concurrency, deadline and failures', () => {
  it('the first call runs alone (it writes the cache); afterwards at most `concurrency` in flight', async () => {
    let inFlight = 0;
    let max = 0;
    const log: number[] = [];
    const complete = fake(async () => {
      inFlight++; max = Math.max(max, inFlight); log.push(inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return ok();
    });
    const many = Array.from({ length: 20 }, (_, i) => ({ text: `chunk ${i}`, headingPath: null }));
    const r = await writeChunkContexts('doc', many, { complete, settings: { concurrency: 3 } });
    expect(r.failed).toBe(0);
    expect(log[0]).toBe(1);
    expect(max).toBe(3);
  });

  it('partial failure: failed chunks stay null and are counted; the writer never throws', async () => {
    const complete = fake(async (_c, n) => {
      if (n === 1) throw new CompletionError('request_failed', 'HTTP 500', 500);
      if (n === 2) throw new CompletionError('timeout', 'timed out');
      if (n === 3) throw new Error('something odd');
      return ok();
    });
    const five = Array.from({ length: 5 }, (_, i) => ({ text: `c${i}`, headingPath: null }));
    const r = await writeChunkContexts('doc', five, { complete, settings: { concurrency: 1 } });
    expect(r.contexts.filter((c) => c === null)).toHaveLength(3);
    expect(r.failed).toBe(3);
    expect(r.contexts[0]).toBe('This chunk is about X.');
    expect(r.contexts[4]).toBe('This chunk is about X.');
    expect(r.stopped).toBeUndefined();
  });

  it('every call failing: stops after a few failures with no success, counts all chunks failed', async () => {
    const complete = fake(async () => { throw new CompletionError('request_failed', 'HTTP 400', 400); });
    const many = Array.from({ length: 50 }, (_, i) => ({ text: `c${i}`, headingPath: null }));
    const r = await writeChunkContexts('doc', many, { complete, settings: { concurrency: 2 } });
    expect(r.failed).toBe(50);
    expect(r.contexts.every((c) => c === null)).toBe(true);
    expect(r.stopped).toBe('failing');
    expect(complete.mock.calls.length).toBeLessThanOrEqual(5);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('a truncated reply (finish_reason length) is a failed context whose usage is kept', async () => {
    const complete = fake(async (_c, n) => {
      if (n === 1) throw new CompletionError('truncated', 'cut', undefined, { input: 50, cacheWrite: 0, cachedRead: 0, output: 200 });
      return ok('Fine.', { input: 50, cacheWrite: 0, cachedRead: 0, output: 5 });
    });
    const r = await writeChunkContexts('doc', CHUNKS, { complete, settings: { concurrency: 1 } });
    expect(r.contexts).toEqual(['Fine.', null, 'Fine.']);
    expect(r.failed).toBe(1);
    expect(r.usage.output).toBe(210);
  });

  it('an outage after earlier successes: stops after max(4, 2 × concurrency) failures in a row', async () => {
    const complete = fake(async (_c, n) => {
      if (n < 5) return ok();
      throw new CompletionError('request_failed', 'HTTP 429', 429);
    });
    const many = Array.from({ length: 100 }, (_, i) => ({ text: `c${i}`, headingPath: null }));
    const r = await writeChunkContexts('doc', many, { complete, settings: { concurrency: 3 } });
    expect(r.stopped).toBe('failing');
    // 5 successes, then 6 failures in a row (+ at most the calls already in flight)
    expect(complete.mock.calls.length).toBeGreaterThanOrEqual(11);
    expect(complete.mock.calls.length).toBeLessThanOrEqual(13);
    expect(r.failed).toBe(95);
  });

  it('with concurrency 1 the floor of 4 applies', async () => {
    const complete = fake(async (_c, n) => {
      if (n < 2) return ok();
      throw new CompletionError('timeout', 'slow');
    });
    const many = Array.from({ length: 20 }, (_, i) => ({ text: `c${i}`, headingPath: null }));
    const r = await writeChunkContexts('doc', many, { complete, settings: { concurrency: 1 } });
    expect(complete).toHaveBeenCalledTimes(6);
    expect(r).toMatchObject({ stopped: 'failing', failed: 18 });
  });

  it('isolated failures between successes do not stop the writer', async () => {
    const complete = fake(async (_c, n) => {
      if (n % 2 === 1) throw new CompletionError('request_failed', 'HTTP 500', 500);
      return ok();
    });
    const many = Array.from({ length: 30 }, (_, i) => ({ text: `c${i}`, headingPath: null }));
    const r = await writeChunkContexts('doc', many, { complete, settings: { concurrency: 1 } });
    expect(r.stopped).toBeUndefined();
    expect(complete).toHaveBeenCalledTimes(30);
    expect(r.failed).toBe(15);
  });

  it('per-file input ceiling: no call starts once the file spent it (cached reads count)', async () => {
    const complete = fake(async () => ok('Fine.', { input: 100, cacheWrite: 0, cachedRead: 900, output: 5 }));
    const ten = Array.from({ length: 10 }, (_, i) => ({ text: `c${i}`, headingPath: null }));
    const r = await writeChunkContexts('doc', ten, { complete, settings: { concurrency: 1, maxInputTokensPerFile: 2500 } });
    expect(complete).toHaveBeenCalledTimes(3);
    expect(r).toMatchObject({ failed: 7, stopped: 'budget' });
  });

  it('no deployment: stops at once', async () => {
    const complete = fake(async () => { throw new CompletionError('no_deployment', 'none'); });
    const r = await writeChunkContexts('doc', CHUNKS, { complete });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ failed: 3, stopped: 'no_deployment' });
  });

  it('soft deadline: no call starts after it; the rest are counted failed', async () => {
    let clock = 0;
    const complete = fake(async () => { clock += 1000; return ok(); });
    const ten = Array.from({ length: 10 }, (_, i) => ({ text: `c${i}`, headingPath: null }));
    const r = await writeChunkContexts('doc', ten, {
      complete, now: () => clock, settings: { concurrency: 1, fileDeadlineMs: 3500 },
    });
    expect(complete).toHaveBeenCalledTimes(4);
    expect(r.failed).toBe(6);
    expect(r.stopped).toBe('deadline');
    expect(r.contexts.slice(0, 4).every((c) => typeof c === 'string')).toBe(true);
  });

  it('an aborted signal stops the writer without throwing', async () => {
    const ac = new AbortController();
    const complete = fake(async (_c, n) => { if (n === 1) ac.abort(); return ok(); });
    const ten = Array.from({ length: 10 }, (_, i) => ({ text: `c${i}`, headingPath: null }));
    const r = await writeChunkContexts('doc', ten, { complete, signal: ac.signal, settings: { concurrency: 1 } });
    expect(r.stopped).toBe('aborted');
    expect(complete).toHaveBeenCalledTimes(2);
    expect(r.failed).toBe(8);
  });
});

describe('usage', () => {
  it('totals every completed call and reports each one, including an empty reply that still billed', async () => {
    const complete = fake(async (_c, n) => {
      if (n === 0) return ok('First.', { input: 1000, cacheWrite: 990, cachedRead: 0, output: 10 });
      if (n === 1) throw new CompletionError('empty_response', 'empty', undefined, { input: 12, cacheWrite: 0, cachedRead: 990, output: 0 });
      if (n === 2) throw new CompletionError('request_failed', 'HTTP 500', 500);
      return ok('Fourth.', { input: 11, cacheWrite: 0, cachedRead: 990, output: 9 });
    });
    const onCall = jest.fn();
    const four = Array.from({ length: 4 }, (_, i) => ({ text: `c${i}`, headingPath: null }));
    const r = await writeChunkContexts('doc', four, { complete, onCall, settings: { concurrency: 1 } });
    expect(r.usage).toEqual({ input: 1023, cacheWrite: 990, cachedRead: 1980, output: 19 });
    expect(r.failed).toBe(2);
    expect(onCall).toHaveBeenCalledTimes(3);
    expect(onCall.mock.calls[0][0]).toMatchObject({ model: 'gemini-3.5-flash-lite', usage: { input: 1000, cacheWrite: 990 } });
  });

  it('a throwing onCall is ignored', async () => {
    const complete = fake();
    const r = await writeChunkContexts(DOC, CHUNKS, { complete, onCall: () => { throw new Error('sink'); } });
    expect(r.failed).toBe(0);
  });

  it('a reply that sanitises to nothing counts as failed but its usage is kept', async () => {
    const complete = fake(async () => ok('```\n```', { input: 5, cacheWrite: 0, cachedRead: 0, output: 2 }));
    const r = await writeChunkContexts(DOC, CHUNKS.slice(0, 1), { complete });
    expect(r.contexts).toEqual([null]);
    expect(r.failed).toBe(1);
    expect(r.usage.output).toBe(2);
  });
});

describe('sanitizeContext', () => {
  it('drops code fences, labels, wrapping quotes and markdown emphasis; collapses whitespace', () => {
    expect(sanitizeContext('```text\nThis section covers ports.\n```')).toBe('This section covers ports.');
    expect(sanitizeContext('Context: "The install chapter,  step 2."')).toBe('The install chapter, step 2.');
    expect(sanitizeContext('  **Install** guide:\n\n  the Docker   ports.  ')).toBe('Install guide: the Docker ports.');
    expect(sanitizeContext('# Heading\nThe text.')).toBe('Heading The text.');
  });

  it('keeps at most two sentences', () => {
    expect(sanitizeContext('One is here. Two is here. Three is here.')).toBe('One is here. Two is here.');
    expect(sanitizeContext('Only one, e.g. like this.')).toBe('Only one, e.g. like this.');
  });

  it('caps the length at a word boundary', () => {
    const long = `${'word '.repeat(400)}end.`;
    const out = sanitizeContext(long)!;
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out.endsWith('word')).toBe(true);
  });

  it('nothing left → null', () => {
    expect(sanitizeContext('')).toBeNull();
    expect(sanitizeContext('```\n```')).toBeNull();
    expect(sanitizeContext('  "" ')).toBeNull();
  });
});

describe('estimateContextTokens', () => {
  const CORPUS = join(__dirname, '../../../../ci/file-search-eval/corpus/markdown');
  const doc = readFileSync(join(CORPUS, 'developer-chapter-16-file-search-tool.md'), 'utf8');
  const opts = { maxTokens: 800, overlapTokens: 0, format: 'markdown' as const };
  const structured = chunkStructured(doc, opts);
  const sectionStarts = structuredSections(doc, opts).map((x) => x.start);
  const chunks: ContextChunk[] = structured.map((c) => ({
    text: c.text, headingPath: c.headingPath, tableHeader: c.tableHeader, start: sectionStarts[c.section] + c.sectionOffset,
  }));
  const documentTokens = countTokens(doc);

  /** The tokens the writer actually sends, counted from the calls a fake completion receives. */
  async function actualInput(settings: any): Promise<number> {
    let total = 0;
    const complete = fake(async (call) => {
      total += countTokens(call.system) + call.messages.reduce((n, m) => n + countTokens(m.text), 0);
      return ok();
    });
    await writeChunkContexts(doc, chunks, { complete, documentTokens, settings: { concurrency: 1, ...settings } });
    return total;
  }

  it('the corpus document is large enough to exercise both rules', () => {
    expect(documentTokens).toBeGreaterThan(12000);
    expect(chunks.length).toBeGreaterThan(10);
  });

  it.each([
    ['whole document', { maxDocumentTokens: 64000 }],
    ['windows', { maxDocumentTokens: 8192 }],
  ])('matches what the writer sends within 15%% (%s)', async (_name, settings) => {
    const est = estimateContextTokens(documentTokens, chunks.length, settings);
    const actual = await actualInput(settings);
    expect(est.calls).toBe(chunks.length);
    expect(est.input / actual).toBeGreaterThan(0.85);
    expect(est.input / actual).toBeLessThan(1.15);
    expect(est.outputUpperBound).toBe(chunks.length * 200);
  });

  it('the per-file input ceiling caps the calls; nothing for no chunks', () => {
    const full = estimateContextTokens(documentTokens, chunks.length, { maxDocumentTokens: 64000 });
    const capped = estimateContextTokens(documentTokens, chunks.length, { maxDocumentTokens: 64000, maxInputTokensPerFile: 3 * documentTokens });
    expect(capped.calls).toBeLessThan(full.calls);
    expect(capped.calls).toBeGreaterThanOrEqual(3);
    expect(estimateContextTokens(documentTokens, 0)).toEqual({ input: 0, outputUpperBound: 0, calls: 0 });
  });
});
