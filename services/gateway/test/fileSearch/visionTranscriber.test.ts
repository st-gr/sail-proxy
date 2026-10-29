/**
 * The vision transcriber (fileSearch/visionTranscriber.ts) with a fake engine: page selection per
 * mode, the call's shape (image part, data URL, fixed template), render bounds, sanitising, the
 * per-file ceilings and failure stops, the OCR fallback, the usage records, the memo, the model
 * check and the estimate. No SAP, no poppler, no sharp.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => mockLogger }));

let mockVisionConfig: any;
let mockForced = false;
jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  default: {
    getFileSearchConfig: () => ({ parsing: { ocr: { languages: ['eng'] }, ...(mockVisionConfig ? { vision: mockVisionConfig } : {}) } }),
    isPseudonymizationForcedForFileSearch: () => mockForced,
  },
  getFileSearchConfig: () => ({ parsing: { ocr: { languages: ['eng'] } } }),
}));

import {
  BLANK_PAGE_REPLY, checkVisionModel, estimateVisionTokens, MAX_PAGE_CHARS, resolveVisionSettings, sanitizeTranscription,
  selectVisionPages, tableLikePage, transcribePdfPages, VISION_DEFAULTS, VISION_SYSTEM_PROMPT, VisionCallRecord,
  VisionDeps, VisionMemo, visionModeOf, resetVisionWarningsForTests, defaultVisionDeps, visionSwitchedOff,
  ESTIMATED_INPUT_TOKENS_PER_PAGE, visionImagesUnmasked, VISION_UNMASKED_WARNING, VISION_CONFIG_RANGES,
} from '../../src/fileSearch/visionTranscriber';
import { CompletionCall, CompletionError, CompletionResult, CompletionUsage } from '../../src/fileSearch/orchestrationCompletion';
import { OcrDeps, ocrPdfPages, OcrMemo } from '../../src/fileSearch/extractors/pdfOcr';

const PDF = Buffer.from('%PDF-fake');
const TEXT_PAGE = 'This page has a perfectly good text layer with enough characters to count as text. '.repeat(4);
const usage = (input: number, output: number): CompletionUsage => ({ input, cacheWrite: 0, cachedRead: 0, output });

/** pdftotext-style output: every page ends with a form feed. */
const doc = (...pages: string[]) => pages.map((p) => `${p}\f`).join('');

interface Fake {
  deps: VisionDeps;
  calls: CompletionCall[];
  renders: Array<{ page: number; dpi: number }>;
  images: Array<{ maxSidePx: number }>;
  clock: { t: number };
}

function fake(reply: (call: CompletionCall, n: number) => Promise<CompletionResult> | CompletionResult, opts: {
  longSide?: number | null; unavailable?: string | null; layout?: string; tickPerCall?: number;
} = {}): Fake {
  const calls: CompletionCall[] = [];
  const renders: Array<{ page: number; dpi: number }> = [];
  const images: Array<{ maxSidePx: number }> = [];
  const clock = { t: 1_000_000 };
  const deps: VisionDeps = {
    unavailable: () => opts.unavailable ?? null,
    pageSize: async () => (opts.longSide === undefined ? 842 : opts.longSide),
    render: async (_pdf, page, dpi) => {
      renders.push({ page, dpi });
      return Buffer.from(`PGM-${page}`);
    },
    toImage: async (pgm, maxSidePx) => {
      images.push({ maxSidePx });
      return { dataUrl: `data:image/png;base64,${pgm.toString('base64')}`, width: 1100, height: 1568, bytes: 10 };
    },
    layoutText: async () => opts.layout ?? '',
    complete: async (call) => {
      calls.push(call);
      clock.t += opts.tickPerCall ?? 0;
      return reply(call, calls.length);
    },
    now: () => clock.t,
  };
  return { deps, calls, renders, images, clock };
}

const ok = (text: string, u = usage(1500, 600)): CompletionResult => ({ text, usage: u, elapsedMs: 900 });
const pageOf = (call: CompletionCall) => Number(/page (\d+)/.exec(call.messages[0].text)![1]);

beforeEach(() => {
  mockVisionConfig = undefined;
  mockForced = false;
  mockLogger.warn.mockClear();
  resetVisionWarningsForTests();
});

describe('modes and selection', () => {
  it('visionModeOf: a setting without a valid vision field is off', () => {
    expect(visionModeOf(undefined)).toBe('off');
    expect(visionModeOf({ type: 'structure' })).toBe('off');
    expect(visionModeOf({ type: 'structure', vision: 'everything' })).toBe('off');
    for (const m of ['off', 'no_text', 'auto', 'all'] as const) expect(visionModeOf({ type: 'static', vision: m })).toBe(m);
  });

  it('no_text = pages without a text layer; all = every page; off = none', () => {
    const pages = [TEXT_PAGE, '  \n', TEXT_PAGE, 'p. 4', ''];
    expect(selectVisionPages('no_text', pages, 4)).toEqual([2, 4]);
    expect(selectVisionPages('all', pages, 4)).toEqual([1, 2, 3, 4]);
    expect(selectVisionPages('off', pages, 4)).toEqual([]);
  });

  it('auto = no text layer, little text (< 200 characters) or a table-heavy layout page', () => {
    const table = Array.from({ length: 20 }, (_, i) => `name_${i}        value ${i}        note`).join('\n');
    const prose = Array.from({ length: 30 }, () => 'plain prose line with single spaces').join('\n');
    const caption = 'Figure 3: the deployment diagram.';
    const pages = [TEXT_PAGE, '', TEXT_PAGE, caption];
    expect(selectVisionPages('auto', pages, 4, [prose, '', table, caption])).toEqual([2, 3, 4]);
    // Without (or with a mismatched) layout pass, by text amount only.
    expect(selectVisionPages('auto', pages, 4)).toEqual([2, 4]);
    expect(selectVisionPages('auto', pages, 4, [table])).toEqual([2, 4]);
  });

  it('tableLikePage: at least 15 gap lines making up at least 30 % of the lines', () => {
    const gap = (n: number) => Array.from({ length: n }, (_, i) => `col ${i}     col b`);
    const prose = (n: number) => Array.from({ length: n }, () => 'a normal sentence');
    expect(tableLikePage([...gap(15), ...prose(30)].join('\n'))).toBe(true);
    expect(tableLikePage([...gap(14), ...prose(5)].join('\n'))).toBe(false);
    expect(tableLikePage([...gap(15), ...prose(40)].join('\n'))).toBe(false);
    // Leading indentation is not a column gap.
    expect(tableLikePage(Array.from({ length: 30 }, () => '        indented code line').join('\n'))).toBe(false);
  });
});

describe('the transcription call', () => {
  it('mode off: the text is returned untouched and nothing is rendered or called', async () => {
    const f = fake(() => ok('x'));
    const text = doc('', TEXT_PAGE);
    expect((await transcribePdfPages(text, PDF, { mode: 'off' }, f.deps)).text).toBe(text);
    expect((await transcribePdfPages(text, PDF, { mode: 'bogus' as any }, f.deps)).text).toBe(text);
    expect(f.calls).toHaveLength(0);
    expect(f.renders).toHaveLength(0);
  });

  it('sends one image part (a data URL) and a page instruction per page; the template is the fixed prompt', async () => {
    const f = fake((call) => ok(`# Page ${pageOf(call)}\n\n| a | b |\n| --- | --- |\n| 1 | 2 |`));
    const out = (await transcribePdfPages(doc('', TEXT_PAGE, ''), PDF, { mode: 'no_text' }, f.deps)).text;
    expect(f.calls).toHaveLength(2);
    const call = f.calls[0];
    expect(call.model).toBe('gemini-3.5-flash-lite');
    expect(call.system).toBe(VISION_SYSTEM_PROMPT);
    expect(call.messages).toEqual([{ text: 'Transcribe page 1.', images: [`data:image/png;base64,${Buffer.from('PGM-1').toString('base64')}`] }]);
    expect(call.params).toEqual({ temperature: 0, max_tokens: 4096 });
    expect(call.system).not.toContain('base64');
    // Pages replaced in place; every form feed kept; the text page untouched.
    expect(out).toBe(doc('# Page 1\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n', TEXT_PAGE, '# Page 3\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n'));
  });

  it('renders within the bound: A4 at 134 dpi, small pages at most 200 dpi, a huge box lower; images capped at 1568 px', async () => {
    const a4 = fake(() => ok('t'));
    await transcribePdfPages(doc(''), PDF, { mode: 'all' }, a4.deps);
    expect(a4.renders).toEqual([{ page: 1, dpi: 134 }]);
    expect(a4.images).toEqual([{ maxSidePx: 1568 }]);
    const small = fake(() => ok('t'), { longSide: 300 });
    await transcribePdfPages(doc(''), PDF, { mode: 'all' }, small.deps);
    expect(small.renders[0].dpi).toBe(200);
    const huge = fake(() => ok('t'), { longSide: 14_400 });
    await transcribePdfPages(doc(''), PDF, { mode: 'all' }, huge.deps);
    expect(huge.renders[0].dpi).toBe(7);
  });

  it('a page whose size cannot be read is not sent and counts as failed, without counting against the model', async () => {
    const f = fake(() => ok('t'), { longSide: null });
    const memo = new VisionMemo();
    const text = doc('', '', '', '', '');
    expect((await transcribePdfPages(text, PDF, { mode: 'all', memo }, f.deps)).text).toBe(text);
    expect(f.calls).toHaveLength(0);
    expect(memo.totals()).toMatchObject({ selected: 5, visionPages: 0, skippedPages: 5, failedPages: 5, stopped: null });
  });

  it('auto skips the layout pass when every page is decided already or nothing can be rendered', async () => {
    let layoutCalls = 0;
    const f = fake(() => ok('T'));
    const deps: VisionDeps = { ...f.deps, layoutText: async () => { layoutCalls += 1; return ''; } };
    const memo = new VisionMemo();
    const text = doc('', TEXT_PAGE);
    await transcribePdfPages(text, PDF, { mode: 'all', memo, sha256: 's' }, deps);
    await transcribePdfPages(text, PDF, { mode: 'auto', memo, sha256: 's' }, deps);
    expect(layoutCalls).toBe(0);
    await transcribePdfPages(text, PDF, { mode: 'auto' }, { ...deps, unavailable: () => 'pdftoppm is not installed' });
    expect(layoutCalls).toBe(0);
    await transcribePdfPages(text, PDF, { mode: 'auto' }, deps);
    expect(layoutCalls).toBe(1);
  });

  it('auto runs the layout pass and sends the table-heavy page', async () => {
    const table = Array.from({ length: 20 }, (_, i) => `name_${i}        value ${i}`).join('\n');
    const f = fake(() => ok('| name | value |'), { layout: doc(TEXT_PAGE, table) });
    await transcribePdfPages(doc(TEXT_PAGE, TEXT_PAGE), PDF, { mode: 'auto' }, f.deps);
    expect(f.calls.map(pageOf)).toEqual([2]);
  });
});

describe('sanitizeTranscription', () => {
  it('removes a fence around the whole reply, control characters (form feeds) and extra blank lines', () => {
    expect(sanitizeTranscription('```markdown\n# T\n\ntext\n```')).toBe('# T\n\ntext');
    expect(sanitizeTranscription('a\fb\u000bc\r\nd   \n\n\n\ne f')).toBe('abc\nd\n\ne\nf');
    // A fence inside the page stays.
    expect(sanitizeTranscription('intro\n```\ncode\n```')).toBe('intro\n```\ncode\n```');
  });

  it('a blank-page reply is recognised; an empty reply is empty', () => {
    expect(sanitizeTranscription(' [Blank page] ')).toBe(BLANK_PAGE_REPLY);
    expect(sanitizeTranscription('blank page.')).toBe(BLANK_PAGE_REPLY);
    expect(sanitizeTranscription(' \n\f ')).toBe('');
  });

  it('caps a page at MAX_PAGE_CHARS, at a line break', () => {
    const out = sanitizeTranscription(Array.from({ length: 3000 }, (_, i) => `line ${i} of the page`).join('\n'));
    expect(out.length).toBeLessThanOrEqual(MAX_PAGE_CHARS);
    expect(out.endsWith('of the page')).toBe(true);
  });

  it('the stored page never gains a form feed', async () => {
    const f = fake(() => ok('one\ftwo'));
    const out = (await transcribePdfPages(doc('', TEXT_PAGE), PDF, { mode: 'no_text' }, f.deps)).text;
    expect(out.split('\f')).toHaveLength(3);
    expect(out.startsWith('onetwo\n\f')).toBe(true);
  });
});

describe('failures, ceilings and stops', () => {
  it("finish_reason 'length' (truncated) fails the page, keeps its text, and its usage is still recorded", async () => {
    const records: VisionCallRecord[] = [];
    const f = fake(() => { throw new CompletionError('truncated', 'cut', undefined, usage(1600, 4096)); });
    const memo = new VisionMemo();
    const text = doc(TEXT_PAGE);
    expect((await transcribePdfPages(text, PDF, { mode: 'all', memo, onCall: (r) => records.push(r) }, f.deps)).text).toBe(text);
    expect(records).toEqual([{ model: 'gemini-3.5-flash-lite', usage: usage(1600, 4096), elapsedMs: 0 }]);
    expect(memo.totals()).toMatchObject({ visionPages: 0, skippedPages: 1, failedPages: 1, usage: usage(1600, 4096) });
  });

  it('truncated replies (dense pages) fail their page but never stop a served model', async () => {
    const f = fake((_c, n) => (n <= 5
      ? Promise.reject(new CompletionError('truncated', 'cut', undefined, usage(1235, 4096)))
      : ok('T')));
    const memo = new VisionMemo();
    await transcribePdfPages(doc('', '', '', '', '', '', ''), PDF, { mode: 'all', memo, settings: { concurrency: 1 } }, f.deps);
    expect(f.calls).toHaveLength(7);
    expect(memo.totals()).toMatchObject({ visionPages: 2, failedPages: 5, stopped: null });
  });

  it('a page vision failed on falls back to OCR when it has no text layer; a transcribed page is not OCRed', async () => {
    const f = fake((call) => (pageOf(call) === 1 ? ok('VISION ONE') : Promise.reject(new CompletionError('request_failed', 'boom', 500))));
    const afterVision = await transcribePdfPages(doc('', ''), PDF, { mode: 'no_text' }, f.deps);
    // A short transcription (fewer than 16 characters) is still the model's page: OCR keeps off it.
    expect(afterVision).toEqual({ text: doc('VISION ONE\n', ''), transcribed: [1] });
    const recognised: number[] = [];
    const ocrDeps: OcrDeps = {
      status: async () => ({ enabled: true, languages: ['eng'], reason: 'test' }),
      pageSize: async () => 842,
      render: async (_pdf, page) => Buffer.from(String(page)),
      recognise: async (image) => { recognised.push(Number(image.toString())); return `OCR PAGE ${image.toString()}`; },
      now: () => 0,
    };
    const ocrMemo = new OcrMemo();
    expect(await ocrPdfPages(afterVision.text, PDF, { memo: ocrMemo, keepPages: afterVision.transcribed }, ocrDeps))
      .toBe(doc('VISION ONE\n', 'OCR PAGE 2\n'));
    expect(recognised).toEqual([2]);
    expect(ocrMemo.totals()).toMatchObject({ candidates: 1, ocrPages: 1 });
  });

  it('at most maxPagesPerFile pages, in page order; the rest keep their text and are counted skipped', async () => {
    const f = fake(() => ok('T'));
    const memo = new VisionMemo();
    await transcribePdfPages(doc('', '', '', ''), PDF, { mode: 'all', memo, settings: { maxPagesPerFile: 2, concurrency: 1 } }, f.deps);
    expect(f.calls.map(pageOf)).toEqual([1, 2]);
    expect(memo.counters()).toEqual({ visionPages: 2, visionSkippedPages: 2 });
    expect(memo.totals().failedPages).toBe(0);
  });

  it('the input-token ceiling stops new calls (calls in flight finish)', async () => {
    const f = fake(() => ok('T', usage(1000, 10)));
    const memo = new VisionMemo();
    await transcribePdfPages(doc('', '', '', '', ''), PDF, { mode: 'all', memo, settings: { maxInputTokensPerFile: 2500, concurrency: 1 } }, f.deps);
    expect(f.calls).toHaveLength(3);
    expect(memo.totals()).toMatchObject({ visionPages: 3, skippedPages: 2, failedPages: 0, stopped: 'input_budget' });
  });

  it('the output-token ceiling stops new calls', async () => {
    const f = fake(() => ok('T', usage(100, 3000)));
    const memo = new VisionMemo();
    await transcribePdfPages(doc('', '', '', ''), PDF, { mode: 'all', memo, settings: { maxOutputTokensPerFile: 5000, concurrency: 1 } }, f.deps);
    expect(f.calls).toHaveLength(2);
    expect(memo.totals().stopped).toBe('output_budget');
  });

  it('the per-file deadline: min(fileDeadlineMs, 40 % of the time left before the caller deadline)', async () => {
    const f = fake(() => ok('T'), { tickPerCall: 10_000 });
    const memo = new VisionMemo();
    // 40 % of 100 s = 40 s < 240 s; each call takes 10 s; a page needs 2 s left to start.
    await transcribePdfPages(doc('', '', '', '', '', ''), PDF,
      { mode: 'all', memo, deadline: f.clock.t + 100_000, settings: { concurrency: 1 } }, f.deps);
    expect(f.calls).toHaveLength(4);
    expect(memo.totals()).toMatchObject({ visionPages: 4, skippedPages: 2, stopped: 'deadline' });
    // Each call's timeout is bounded by what is left of the file's deadline.
    expect(f.calls[3].timeoutMs).toBe(10_000);
  });

  it('the first 3 calls all failing stops the file (the model is most likely not served)', async () => {
    const f = fake(() => Promise.reject(new CompletionError('request_failed', 'not served', 404)));
    const memo = new VisionMemo();
    const text = doc('', '', '', '', '', '');
    expect((await transcribePdfPages(text, PDF, { mode: 'all', memo, settings: { concurrency: 1 } }, f.deps)).text).toBe(text);
    expect(f.calls).toHaveLength(3);
    expect(memo.totals()).toMatchObject({ skippedPages: 6, failedPages: 3, stopped: 'failing' });
  });

  it('max(4, 2 × concurrency) failures in a row after successes stop the file', async () => {
    const f = fake((_c, n) => (n <= 2 ? ok('T') : Promise.reject(new CompletionError('timeout', 'slow'))));
    const memo = new VisionMemo();
    await transcribePdfPages(doc(...Array.from({ length: 10 }, () => '')), PDF, { mode: 'all', memo, settings: { concurrency: 1 } }, f.deps);
    expect(f.calls).toHaveLength(6);
    expect(memo.totals()).toMatchObject({ visionPages: 2, failedPages: 4, skippedPages: 8, stopped: 'failing' });
  });

  it('no orchestration deployment stops at once; an abort stops too', async () => {
    const none = fake(() => Promise.reject(new CompletionError('no_deployment', 'none')));
    const memo = new VisionMemo();
    await transcribePdfPages(doc('', '', ''), PDF, { mode: 'all', memo, settings: { concurrency: 1 } }, none.deps);
    expect(none.calls).toHaveLength(1);
    expect(memo.totals().stopped).toBe('no_deployment');

    const controller = new AbortController();
    const aborting = fake(() => { controller.abort(); return ok('T'); });
    const memo2 = new VisionMemo();
    await transcribePdfPages(doc('', '', ''), PDF, { mode: 'all', memo: memo2, signal: controller.signal, settings: { concurrency: 1 } }, aborting.deps);
    expect(aborting.calls).toHaveLength(1);
    expect(memo2.totals()).toMatchObject({ visionPages: 1, stopped: 'aborted' });
  });

  it('a blank-page reply keeps the page and is not a model failure; an empty reply is', async () => {
    const f = fake((_c, n) => ok(n % 2 === 1 ? BLANK_PAGE_REPLY : 'text'));
    const memo = new VisionMemo();
    const out = (await transcribePdfPages(doc('', '', '', ''), PDF, { mode: 'all', memo, settings: { concurrency: 1 } }, f.deps)).text;
    expect(out).toBe(doc('', 'text\n', '', 'text\n'));
    expect(memo.totals()).toMatchObject({ visionPages: 2, skippedPages: 2, failedPages: 0 });
    const empty = fake(() => ok('   '));
    const memo2 = new VisionMemo();
    await transcribePdfPages(doc(''), PDF, { mode: 'all', memo: memo2 }, empty.deps);
    expect(memo2.totals()).toMatchObject({ skippedPages: 1, failedPages: 1 });
  });

  it('never throws: an unexpected error from the engine keeps the page', async () => {
    const f = fake(() => { throw new TypeError('bug'); });
    const text = doc('');
    expect((await transcribePdfPages(text, PDF, { mode: 'all' }, f.deps)).text).toBe(text);
    const broken: VisionDeps = { ...f.deps, layoutText: () => { throw new Error('sync'); }, unavailable: () => { throw new Error('x'); } };
    expect((await transcribePdfPages(text, PDF, { mode: 'auto' }, broken)).text).toBe(text);
  });

  it('unavailable (no pdftoppm, no sharp): nothing is called, every selected page keeps its text and is counted', async () => {
    const f = fake(() => ok('T'), { unavailable: 'pdftoppm is not installed' });
    const memo = new VisionMemo();
    const text = doc('', TEXT_PAGE, '');
    expect((await transcribePdfPages(text, PDF, { mode: 'no_text', memo }, f.deps)).text).toBe(text);
    expect(f.calls).toHaveLength(0);
    expect(memo.totals()).toMatchObject({ selected: 2, skippedPages: 2, failedPages: 0, unavailable: 'pdftoppm is not installed' });
  });
});

describe('FILE_SEARCH_VISION=off (the lite gateway)', () => {
  const saved = process.env.FILE_SEARCH_VISION;
  afterEach(() => {
    if (saved === undefined) delete process.env.FILE_SEARCH_VISION;
    else process.env.FILE_SEARCH_VISION = saved;
  });

  it('reads off values; unset or auto is not off', () => {
    expect(visionSwitchedOff({})).toBeNull();
    expect(visionSwitchedOff({ FILE_SEARCH_VISION: 'auto' })).toBeNull();
    for (const v of ['off', 'OFF', ' false ', '0', 'no', 'disabled']) {
      expect(visionSwitchedOff({ FILE_SEARCH_VISION: v })).toBe('switched off (FILE_SEARCH_VISION=off)');
    }
  });

  it('a store that opted in gets no call: unavailable once with a warning, pages keep their text; the model check refuses', async () => {
    process.env.FILE_SEARCH_VISION = 'off';
    mockLogger.warn.mockClear();
    expect(defaultVisionDeps.unavailable()).toBe('switched off (FILE_SEARCH_VISION=off)');
    const calls: CompletionCall[] = [];
    const deps: VisionDeps = { ...defaultVisionDeps, complete: async (c) => { calls.push(c); return ok('T'); } };
    const memo = new VisionMemo();
    const text = doc('', '');
    expect((await transcribePdfPages(text, PDF, { mode: 'all', memo }, deps)).text).toBe(text);
    expect((await transcribePdfPages(text, PDF, { mode: 'auto' }, deps)).text).toBe(text);
    expect(calls).toHaveLength(0);
    expect(memo.totals()).toMatchObject({ skippedPages: 2, unavailable: 'switched off (FILE_SEARCH_VISION=off)' });
    const warnings = mockLogger.warn.mock.calls.filter((c: any[]) => String(c[1]).includes('unavailable on this gateway'));
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0][1])).toContain('FILE_SEARCH_VISION=off');
    const complete = jest.fn<(c: CompletionCall) => Promise<CompletionResult>>();
    expect(await checkVisionModel({ complete })).toEqual({ model: 'gemini-3.5-flash-lite', result: 'unavailable' });
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('usage and the memo', () => {
  it('one record per call that spent tokens, with the split; totals sum them', async () => {
    const records: VisionCallRecord[] = [];
    const split = { input: 1200, cacheWrite: 0, cachedRead: 300, output: 500 };
    const f = fake((_c, n) => (n === 2
      ? Promise.reject(new CompletionError('request_failed', 'x', 500))
      : ok('T', split)));
    const memo = new VisionMemo();
    await transcribePdfPages(doc('', '', ''), PDF, { mode: 'all', memo, onCall: (r) => records.push(r), settings: { concurrency: 1 } }, f.deps);
    expect(records).toHaveLength(2); // the failed call reported no usage
    expect(records[0]).toEqual({ model: 'gemini-3.5-flash-lite', usage: split, elapsedMs: 900 });
    expect(memo.totals().usage).toEqual({ input: 2400, cacheWrite: 0, cachedRead: 600, output: 1000 });
  });

  it('a usage sink that throws is ignored', async () => {
    const f = fake(() => ok('T'));
    const out = (await transcribePdfPages(doc(''), PDF, { mode: 'all', onCall: () => { throw new Error('sink'); } }, f.deps)).text;
    expect(out).toBe(doc('T\n'));
  });

  it('a second extraction with the same memo calls nothing again and counts each page once', async () => {
    const f = fake((call) => ok(`P${pageOf(call)}`));
    const memo = new VisionMemo();
    const text = doc('', TEXT_PAGE, '');
    const first = (await transcribePdfPages(text, PDF, { mode: 'no_text', memo, sha256: 'abc' }, f.deps)).text;
    const second = (await transcribePdfPages(text, PDF, { mode: 'no_text', memo, sha256: 'abc' }, f.deps)).text;
    expect(second).toBe(first);
    expect(f.calls).toHaveLength(2);
    expect(memo.counters()).toEqual({ visionPages: 2, visionSkippedPages: 0 });
    // A wider mode on the same file only sends the pages not yet decided, and the ceilings span both.
    await transcribePdfPages(text, PDF, { mode: 'all', memo, sha256: 'abc' }, f.deps);
    expect(f.calls.map(pageOf)).toEqual([1, 3, 2]);
    expect(memo.totals()).toMatchObject({ selected: 3, visionPages: 3 });
  });

  it('maxPagesPerFile holds across a re-chunk\'s two extractions, also when their modes select different pages', async () => {
    const f = fake((call) => ok(`P${pageOf(call)}`));
    const memo = new VisionMemo();
    const settings = { maxPagesPerFile: 3, concurrency: 1 };
    // The store's setting (no_text) sends pages 1 and 5; the target (all) may add one more page only.
    const text = doc('', TEXT_PAGE, TEXT_PAGE, TEXT_PAGE, '', TEXT_PAGE);
    await transcribePdfPages(text, PDF, { mode: 'no_text', memo, sha256: 'abc', settings }, f.deps);
    const second = await transcribePdfPages(text, PDF, { mode: 'all', memo, sha256: 'abc', settings }, f.deps);
    expect(f.calls.map(pageOf)).toEqual([1, 5, 2]);
    expect(second.transcribed).toEqual([1, 2, 5]);
    expect(memo.counters()).toEqual({ visionPages: 3, visionSkippedPages: 3 });
    // The cap counts pages sent, not positions in one selection: three pages sent by no_text leave
    // nothing for all (by position, all would have sent its first three undecided pages as well).
    const g = fake((call) => ok(`P${pageOf(call)}`));
    const memo2 = new VisionMemo();
    const tail = doc(TEXT_PAGE, TEXT_PAGE, TEXT_PAGE, '', '', '');
    await transcribePdfPages(tail, PDF, { mode: 'no_text', memo: memo2, sha256: 'abc', settings }, g.deps);
    await transcribePdfPages(tail, PDF, { mode: 'all', memo: memo2, sha256: 'abc', settings }, g.deps);
    expect(g.calls.map(pageOf)).toEqual([4, 5, 6]);
    // Another file in the same memo has its own count.
    await transcribePdfPages(doc('', ''), PDF, { mode: 'all', memo: memo2, sha256: 'def', settings }, g.deps);
    expect(g.calls).toHaveLength(5);
  });
});

describe('pseudonymization: page images reach the model unmasked', () => {
  it('visionImagesUnmasked: a vision mode while pseudonymization is force-enabled for file_search content', () => {
    expect(visionImagesUnmasked('auto')).toBe(false);
    mockForced = true;
    expect(visionImagesUnmasked('auto')).toBe(true);
    expect(visionImagesUnmasked('off')).toBe(false);
  });

  it('the transcriber logs the warning once per process when it sends pages under forced pseudonymization', async () => {
    const f = fake(() => ok('T'));
    await transcribePdfPages(doc(''), PDF, { mode: 'all' }, f.deps);
    expect(mockLogger.warn.mock.calls.filter((c) => String(c[1]).includes('unmasked'))).toHaveLength(0);
    mockForced = true;
    await transcribePdfPages(doc(''), PDF, { mode: 'all' }, f.deps);
    await transcribePdfPages(doc(''), PDF, { mode: 'all' }, f.deps);
    const warned = mockLogger.warn.mock.calls.filter((c) => c[1] === VISION_UNMASKED_WARNING);
    expect(warned).toHaveLength(1);
    expect(VISION_UNMASKED_WARNING).toMatch(/page images .* unmasked/i);
  });
});

describe('settings, model check and estimate', () => {
  it('configured settings (file_search.parsing.vision) over the defaults; invalid values fall back', () => {
    expect(resolveVisionSettings()).toEqual(VISION_DEFAULTS);
    mockVisionConfig = { model: ' gemini-3.8-flash ', maxPagesPerFile: 10, concurrency: 0, maxSidePx: 'big' };
    // concurrency 0 is a whole number below its range: clamped to 1; a non-number falls back to the default.
    expect(resolveVisionSettings()).toMatchObject({ model: 'gemini-3.8-flash', maxPagesPerFile: 10, concurrency: 1, maxSidePx: 1568 });
    expect(resolveVisionSettings({ maxPagesPerFile: 3 }).maxPagesPerFile).toBe(3);
  });

  it('configured values outside the schema ranges are clamped into them, with one warning; overrides are not', () => {
    mockVisionConfig = { maxPagesPerFile: 100000, concurrency: 64, requestTimeoutMs: 10, fileDeadlineMs: 99_000_000,
      maxInputTokensPerFile: 5, maxOutputTokensPerFile: 1e12 };
    const clamped = { maxPagesPerFile: 1000, concurrency: 8, requestTimeoutMs: 5000, fileDeadlineMs: 1_800_000,
      maxInputTokensPerFile: 10_000, maxOutputTokensPerFile: 100_000_000 };
    expect(resolveVisionSettings()).toMatchObject(clamped);
    expect(resolveVisionSettings()).toMatchObject(clamped);
    const warned = mockLogger.warn.mock.calls.filter((c) => String(c[1]).includes('file_search.parsing.vision'));
    expect(warned).toHaveLength(1);
    expect(warned[0][1]).toMatch(/max_pages_per_file.*1000/);
    // In range: unchanged, no warning; an override (tests, the caller's own limits) is taken as given.
    mockLogger.warn.mockClear();
    mockVisionConfig = { maxPagesPerFile: 20, concurrency: 3 };
    expect(resolveVisionSettings()).toMatchObject({ maxPagesPerFile: 20, concurrency: 3 });
    expect(resolveVisionSettings({ maxInputTokensPerFile: 9000 }).maxInputTokensPerFile).toBe(9000);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('the clamping ranges are the schema\'s', () => {
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    const path = require('path');
    const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../admin/src/schemas/api-config-schema.json'), 'utf8'));
    const props = schema.$defs.capabilitiesGroup.properties.file_search.properties.parsing.properties.vision.properties;
    for (const [key, [min, max]] of Object.entries(VISION_CONFIG_RANGES)) {
      const snake = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
      expect([snake, props[snake].minimum, props[snake].maximum]).toEqual([snake, min, max]);
    }
  });

  it('checkVisionModel sends one small image and classifies the outcome', async () => {
    const calls: CompletionCall[] = [];
    const records: VisionCallRecord[] = [];
    const served = await checkVisionModel({
      onCall: (r) => records.push(r),
      complete: async (call) => { calls.push(call); return ok('[blank page]', usage(260, 4)); },
    });
    expect(served).toEqual({ model: 'gemini-3.5-flash-lite', result: 'served' });
    expect(calls[0].messages[0].images).toHaveLength(1);
    expect(calls[0].messages[0].images![0]).toMatch(/^data:image\/png;base64,/);
    expect(calls[0].system).toBe(VISION_SYSTEM_PROMPT);
    expect(records).toHaveLength(1);

    const reject = (e: unknown) => checkVisionModel({ complete: async () => { throw e; } });
    expect((await reject(new CompletionError('request_failed', 'no images', 400))).result).toBe('unavailable');
    expect((await reject(new CompletionError('request_failed', 'gone', 404))).result).toBe('unavailable');
    expect((await reject(new CompletionError('no_deployment', 'none'))).result).toBe('unavailable');
    expect((await reject(new CompletionError('request_failed', 'busy', 429))).result).toBe('unknown');
    expect((await reject(new CompletionError('timeout', 'slow'))).result).toBe('unknown');
    expect((await reject(new CompletionError('truncated', 'cut', undefined, usage(1, 64)))).result).toBe('served');
    expect((await reject(new Error('other'))).result).toBe('unknown');
  });

  it('estimateVisionTokens: pages × per-page estimate within the page cap and the ceilings', () => {
    // The live probe (2026-10-09) measured 1,235 input tokens per page on both models.
    expect(ESTIMATED_INPUT_TOKENS_PER_PAGE).toBe(1250);
    expect(estimateVisionTokens(0)).toEqual({ pages: 0, input: 0, outputUpperBound: 0 });
    expect(estimateVisionTokens(10)).toEqual({ pages: 10, input: 12_500, outputUpperBound: 40_960 });
    expect(estimateVisionTokens(500)).toEqual({ pages: 50, input: 62_500, outputUpperBound: 120_000 + 2 * 4096 });
    expect(estimateVisionTokens(100, { maxInputTokensPerFile: 9000 }).pages).toBe(8);
  });
});
