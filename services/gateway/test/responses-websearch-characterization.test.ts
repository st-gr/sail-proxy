/**
 * CHARACTERIZATION suite for the hosted `web_search` machinery in
 * `src/plugins/responsesWebSearchPlugin.ts`.
 *
 * The existing suites (`responses-websearch-stream.test.ts`,
 * `responses-websearch-plugin.test.ts`, the adapter/cap/continuation/query-remasking
 * files) assert BEHAVIOUR: "a web_search_call is emitted", "usage is summed", "the raw
 * function_call does not survive". This one asserts the exact bytes written to `res`, in
 * order, and the exact request bodies POSTed upstream — the things a refactor changes
 * silently while every behavioural assertion stays green.
 *
 * It exists as the gate on the hosted-tool extraction that follows (the `file_search`
 * work): the extraction must leave this file UNCHANGED and still green. Anything here
 * that needs editing to keep passing is, by construction, a behaviour change.
 *
 * WHY LITERAL BYTES RATHER THAN A SNAPSHOT. A fresh jest snapshot is written on first run
 * and passes unconditionally, so it proves nothing until a human has read it. The expected
 * frames below are spelled out as literals instead: they are reviewable in the diff, and a
 * key-order or field change in the emitted JSON fails them.
 *
 * ID NORMALISATION. `syntheticId()` mints ids from `Date.now()` and a module-global
 * counter, so they differ per run and per test order. `normalizeSyntheticIds` rewrites
 * only ids of that shape (`ws_`/`msg_`/`resp_` followed by 7+ base36 chars) to
 * `<prefix>_SYNTH<n>` in first-appearance order. Fixture ids (`resp_1`, `msg_2`, `fc_1`)
 * are deliberately short and are never rewritten.
 *
 * MUTATION-TESTED. Each named CHARACTERIZATION test below was verified to FAIL against a
 * deliberately mutated plugin; see the task report for the mutation list and output.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Readable } from 'stream';

const mockExecuteWebSearch = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../src/plugins/webSearch/searchExecutor', () => ({
  __esModule: true,
  executeWebSearch: (...a: any[]) => mockExecuteWebSearch(...a),
}));

const mockPost = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: (...a: any[]) => mockPost(...a) },
}));

const mockMaxSearches = jest.fn<() => number>();
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: { getWebSearchMaxSearches: () => mockMaxSearches() },
}));

import pluginRules = require('../src/plugins/responsesWebSearchPlugin');

const before = (pluginRules as any[]).find(r => r.strategy === 'before').handler;
const after = (pluginRules as any[]).find(r => r.strategy === 'after').handler;

const utils = { logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() } };

/** Must match the plugin's private REWROTE_FLAG — the after handler's entry condition. */
const REWROTE_FLAG = '__responsesWebSearchRewritten';

// --------------------------------------------------------------------------- fixtures

const RESULTS = [{
  title: 'Node LTS', url: 'https://nodejs.example/lts',
  snippet: 'Node 22 is LTS', content: 'Node 22 entered LTS in October',
}];

/** The formatted-result text `buildSearchMessageItem` produces for RESULTS + 'node lts'. */
const DUMP_TEXT = 'Web search results for "node lts":\n\n1. Node LTS — Node 22 is LTS (https://nodejs.example/lts)';

/** The `function_call_output` JSON the continuation carries back for `call_1`. */
const CALL_OUTPUT_JSON = JSON.stringify({
  results: [{
    title: 'Node LTS', url: 'https://nodejs.example/lts',
    snippet: 'Node 22 is LTS', content: 'Node 22 entered LTS in October',
  }],
});

const REASONING = { type: 'reasoning', id: 'rs_1', encrypted_content: 'gAAAAABopaque==', summary: [] };
const FC = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"node lts"}' };
const MSG2 = {
  type: 'message', id: 'msg_2', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: 'Node 22 is the current LTS.', annotations: [] }],
};

const UPSTREAM = () => ({
  url: 'https://sap.example/d1/responses',
  headers: { Authorization: 'Bearer t' },
  timeoutMs: 5000,
  payload: { model: 'm', input: 'node lts?', stream: true },
});

/**
 * The first deployment call's frames exactly as responsesController writes them through
 * `res.write`: a reasoning item at output_index 0, a suppressed web_search call at 1, and
 * a terminal frame naming both. `sequence_number` is present on every frame — the
 * continuation's own numbers are shifted past the highest of them.
 */
const FIXTURE_FIRST_CALL = [
  { type: 'response.created', sequence_number: 0, response: { id: 'resp_1' } },
  { type: 'response.in_progress', sequence_number: 1, response: { id: 'resp_1' } },
  { type: 'response.output_item.added', sequence_number: 2, output_index: 0, item: REASONING },
  { type: 'response.output_item.done', sequence_number: 3, output_index: 0, item: REASONING },
  { type: 'response.output_item.added', sequence_number: 4, output_index: 1, item: { ...FC, arguments: '' } },
  { type: 'response.function_call_arguments.delta', sequence_number: 5, output_index: 1, delta: '{"query":"node lts"}' },
  { type: 'response.function_call_arguments.done', sequence_number: 6, output_index: 1, arguments: '{"query":"node lts"}' },
  { type: 'response.output_item.done', sequence_number: 7, output_index: 1, item: FC },
  {
    type: 'response.completed', sequence_number: 8,
    response: { id: 'resp_1', status: 'completed', output: [REASONING, FC], usage: { input_tokens: 10, output_tokens: 2 } },
  },
];

/** The continuation deployment call's frames: the model's real answer. */
const FIXTURE_CONTINUATION = [
  { type: 'response.created', sequence_number: 0, response: { id: 'resp_2' } },
  { type: 'response.in_progress', sequence_number: 1, response: { id: 'resp_2' } },
  { type: 'response.output_item.added', sequence_number: 2, output_index: 0, item: { ...MSG2, content: [] } },
  { type: 'response.output_text.delta', sequence_number: 3, output_index: 0, content_index: 0, item_id: 'msg_2', delta: 'Node 22 is the current LTS.' },
  { type: 'response.output_item.done', sequence_number: 4, output_index: 0, item: MSG2 },
  {
    type: 'response.completed', sequence_number: 5,
    response: { id: 'resp_2', status: 'completed', output: [MSG2], usage: { input_tokens: 40, output_tokens: 7 } },
  },
];

/** The non-streaming twin of FIXTURE_FIRST_CALL / FIXTURE_CONTINUATION. */
const FIXTURE_BLOCKING_FIRST = {
  id: 'resp_1', status: 'completed', output: [REASONING, FC], usage: { input_tokens: 10, output_tokens: 2 },
};
const FIXTURE_BLOCKING_CONTINUATION = {
  id: 'resp_2', status: 'completed', output: [MSG2], usage: { input_tokens: 40, output_tokens: 7 },
};

// ---------------------------------------------------------------------------- harness

/** Collects every res.write payload in order, exactly as bytes. */
function captureWrites() {
  const written: string[] = [];
  let ended = false;
  return {
    written,
    get ended() { return ended; },
    write(chunk: any) { written.push(String(chunk)); return true; },
    end(chunk?: any) { if (chunk !== undefined) written.push(String(chunk)); ended = true; return this as any; },
    setHeader() { /* no-op */ },
    getHeader() { return undefined; },
    headersSent: false,
    statusCode: 200,
    writableEnded: false,
  } as any;
}

function sse(obj: any): string { return `data: ${JSON.stringify(obj)}\n\n`; }

/** An axios streaming response whose body replays `frames` as SSE blocks. */
function upstreamStream(frames: any[]): any {
  return { data: Readable.from(frames.map(f => sse(f))) };
}

function writeFirstCall(res: any): void {
  for (const f of FIXTURE_FIRST_CALL) res.write(sse(f));
}

/** Let a whole continuation settle: the search, the POST, and the continuation stream. */
const settleAll = () => new Promise(r => setTimeout(r, 25));

/**
 * Rewrite `syntheticId()`-minted ids to stable `<prefix>_SYNTH<n>` names, numbered in
 * first-appearance order. 7+ base36 chars after the underscore is the discriminator:
 * `Date.now().toString(36)` alone is 8, while every fixture id here is 1-2.
 */
function normalizeSyntheticIds(text: string): string {
  const seen = new Map<string, string>();
  return text.replace(/\b(ws|msg|resp)_[0-9a-z]{7,}\b/g, (match, prefix: string) => {
    if (!seen.has(match)) seen.set(match, `${prefix}_SYNTH${seen.size + 1}`);
    return seen.get(match) as string;
  });
}

/** The exact SSE blocks written to `res`, with synthetic ids normalised. */
function writtenBlocks(res: any): string[] {
  return normalizeSyntheticIds(res.written.join(''))
    .split('\n\n')
    .filter(b => b.length > 0)
    .map(b => `${b}\n\n`);
}

/** Every frame written to `res`, parsed, with synthetic ids normalised. */
function frames(res: any): any[] {
  return writtenBlocks(res)
    .map(b => b.split('\n').find(l => l.startsWith('data: ')))
    .filter((l): l is string => typeof l === 'string')
    .map(l => JSON.parse(l.slice(6)));
}

/** Deep-normalise synthetic ids inside a parsed object (for output-array comparisons). */
function normalizeIds<T>(value: T): T {
  return JSON.parse(normalizeSyntheticIds(JSON.stringify(value)));
}

/** The `web_search_call` item the plugin synthesises for `call_1`, as normalised. */
const WS_CALL = { type: 'web_search_call', id: 'ws_SYNTH1', status: 'completed', action: { type: 'search', query: 'node lts' } };
/** The formatted-result `message` item, as normalised. */
const DUMP_MSG = {
  type: 'message', id: 'msg_SYNTH2', role: 'assistant', status: 'completed',
  content: [{
    type: 'output_text', text: DUMP_TEXT,
    annotations: [{ type: 'url_citation', url: 'https://nodejs.example/lts', title: 'Node LTS' }],
  }],
};

function streamingReq(): any {
  return {
    body: { stream: true, input: 'node lts?', tools: [{ type: 'web_search' }] },
    __responsesUpstream: UPSTREAM(),
    __responsesExtraUsage: { input_tokens: 0, output_tokens: 0 },
  };
}

beforeEach(() => {
  mockExecuteWebSearch.mockReset();
  mockExecuteWebSearch.mockResolvedValue(RESULTS);
  mockPost.mockReset();
  mockMaxSearches.mockReset();
  mockMaxSearches.mockReturnValue(3);
});

// =========================================================================== the suite

describe('responsesWebSearchPlugin — CHARACTERIZATION: streaming frame bytes', () => {
  it('CHARACTERIZATION: single web_search, streaming — exact frame sequence', async () => {
    const res = captureWrites();
    const req = streamingReq();
    mockPost.mockResolvedValue(upstreamStream(FIXTURE_CONTINUATION));

    await before({ req, res, utils });
    writeFirstCall(res);
    await settleAll();

    // The exact bytes. Every field, every key order, every frame that does and does not
    // reach the client. This is the pin; the assertions after it say WHY each part matters.
    expect(writtenBlocks(res)).toEqual([
      // --- the first call, passed through untouched
      sse({ type: 'response.created', sequence_number: 0, response: { id: 'resp_1' } }),
      sse({ type: 'response.in_progress', sequence_number: 1, response: { id: 'resp_1' } }),
      sse({ type: 'response.output_item.added', sequence_number: 2, output_index: 0, item: REASONING }),
      sse({ type: 'response.output_item.done', sequence_number: 3, output_index: 0, item: REASONING }),
      // --- the suppressed function_call's frames are GONE; these two stand in for it,
      //     at the same output_index, and carry no sequence_number of their own.
      sse({ type: 'response.output_item.added', output_index: 1, item: WS_CALL }),
      sse({ type: 'response.output_item.done', output_index: 1, item: WS_CALL }),
      // --- the continuation, spliced in: created/in_progress dropped, output_index
      //     shifted by 2 (past reasoning@0 and the web_search_call@1), sequence_number
      //     shifted by 9 (past the first call's highest, 8).
      sse({ type: 'response.output_item.added', sequence_number: 11, output_index: 2, item: { ...MSG2, content: [] } }),
      sse({ type: 'response.output_text.delta', sequence_number: 12, output_index: 2, content_index: 0, item_id: 'msg_2', delta: 'Node 22 is the current LTS.' }),
      sse({ type: 'response.output_item.done', sequence_number: 13, output_index: 2, item: MSG2 }),
      // --- ONE terminal frame for the whole turn: the continuation's, with every earlier
      //     item prefixed onto response.output and usage summed across both calls. Neither
      //     round carries `input_tokens_details`, so the merged cache breakdown sums to zero
      //     and `total_tokens` recomputes to 59 (T10).
      sse({
        type: 'response.completed', sequence_number: 14,
        response: {
          id: 'resp_2', status: 'completed',
          output: [REASONING, WS_CALL, MSG2],
          usage: {
            input_tokens: 50, output_tokens: 9,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            total_tokens: 59,
          },
        },
      }),
    ]);

    const events = frames(res);

    // Exactly one of each turn-level frame reaches the client, however many deployment
    // calls the splice made.
    expect(events.filter(e => e.type === 'response.created')).toHaveLength(1);
    expect(events.filter(e => e.type === 'response.completed')).toHaveLength(1);
    expect(events.filter(e => e.type === 'response.in_progress')).toHaveLength(1);

    // The event order, as a flat list — the readable form of the byte pin above.
    expect(events.map(e => e.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.output_item.done',
      'response.output_item.added',
      'response.output_item.done',
      'response.output_item.added',
      'response.output_text.delta',
      'response.output_item.done',
      'response.completed',
    ]);

    // No raw function_call may reach the client, in a frame or in the final output array.
    const items = events.map(e => e.item).filter(Boolean);
    expect(items.some((i: any) => i.type === 'function_call')).toBe(false);
    expect(items.some((i: any) => i.type === 'web_search_call')).toBe(true);

    // sequence_number stays strictly increasing and duplicate-free across the splice.
    const seqs = events.map(e => e.sequence_number).filter(n => typeof n === 'number');
    expect(seqs).toEqual([0, 1, 2, 3, 11, 12, 13, 14]);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    // output_index never goes backwards and never reuses an index across the splice.
    expect(events.map(e => e.output_index).filter(n => typeof n === 'number')).toEqual([0, 0, 1, 1, 2, 2, 2]);
  });

  it('CHARACTERIZATION: no raw web_search function_call survives — streaming', async () => {
    const res = captureWrites();
    const req = streamingReq();
    mockPost.mockResolvedValue(upstreamStream(FIXTURE_CONTINUATION));

    await before({ req, res, utils });
    writeFirstCall(res);
    await settleAll();

    const events = frames(res);
    const items = events.map(e => e.item).filter(Boolean);
    expect(items.some((i: any) => i.type === 'function_call' && i.name === 'web_search')).toBe(false);
    expect(items.some((i: any) => i.type === 'web_search_call')).toBe(true);

    const terminal = events[events.length - 1];
    expect(terminal.type).toBe('response.completed');
    expect(terminal.response.output.some((i: any) => i.type === 'function_call')).toBe(false);
    expect(terminal.response.output.map((i: any) => i.type)).toEqual(['reasoning', 'web_search_call', 'message']);
  });

  it('CHARACTERIZATION: exactly one response.created and one response.completed survive the splice', async () => {
    const res = captureWrites();
    const req = streamingReq();
    mockPost.mockResolvedValue(upstreamStream(FIXTURE_CONTINUATION));

    await before({ req, res, utils });
    writeFirstCall(res);
    await settleAll();

    const types = frames(res).map(e => e.type);
    expect(types.filter(t => t === 'response.created')).toHaveLength(1);
    expect(types.filter(t => t === 'response.in_progress')).toHaveLength(1);
    expect(types.filter(t => t === 'response.completed')).toHaveLength(1);
    // The client's terminal frame is the LAST frame: nothing may follow it.
    expect(types[types.length - 1]).toBe('response.completed');
    expect(types[0]).toBe('response.created');
  });

  it('CHARACTERIZATION: continuation output_index is shifted past every index already streamed', async () => {
    const res = captureWrites();
    const req = streamingReq();
    mockPost.mockResolvedValue(upstreamStream(FIXTURE_CONTINUATION));

    await before({ req, res, utils });
    writeFirstCall(res);
    await settleAll();

    const events = frames(res);
    // The first call used 0 (reasoning) and 1 (the injected web_search_call); the
    // continuation's own output_index 0 must therefore reach the client as 2.
    expect(events.map(e => e.output_index).filter(n => typeof n === 'number')).toEqual([0, 0, 1, 1, 2, 2, 2]);
    const continuationItem = events.find(e => e.type === 'response.output_text.delta');
    expect(continuationItem.output_index).toBe(2);
    // No index the first call already used is reused by the continuation.
    const firstCallIndices = new Set([0, 1]);
    const afterSplice = events.slice(events.findIndex(e => e.type === 'response.output_text.delta'));
    expect(afterSplice.every(e => typeof e.output_index !== 'number' || !firstCallIndices.has(e.output_index))).toBe(true);
  });

  it('CHARACTERIZATION: continuation sequence_number is shifted so the client stream stays strictly increasing', async () => {
    const res = captureWrites();
    const req = streamingReq();
    mockPost.mockResolvedValue(upstreamStream(FIXTURE_CONTINUATION));

    await before({ req, res, utils });
    writeFirstCall(res);
    await settleAll();

    const seqs = frames(res).map(e => e.sequence_number).filter(n => typeof n === 'number');
    expect(seqs).toEqual([0, 1, 2, 3, 11, 12, 13, 14]);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    expect(new Set(seqs).size).toBe(seqs.length);
    // The shift clears the first call's highest sequence_number (8), including the
    // numbers spent on the suppressed function_call's own frames (4-7).
    expect(Math.min(...seqs.slice(4))).toBeGreaterThan(8);
  });

  it('CHARACTERIZATION: no upstream context — exact pre-continuation frame sequence', async () => {
    const res = captureWrites();
    // No __responsesUpstream: nothing to continue with, so the turn ends with the
    // formatted-result dump, exactly as it did before the splice existed.
    const req: any = { body: { stream: true, input: 'node lts?', tools: [{ type: 'web_search' }] } };

    await before({ req, res, utils });
    writeFirstCall(res);
    await settleAll();

    expect(mockPost).not.toHaveBeenCalled();
    expect(writtenBlocks(res)).toEqual([
      sse({ type: 'response.created', sequence_number: 0, response: { id: 'resp_1' } }),
      sse({ type: 'response.in_progress', sequence_number: 1, response: { id: 'resp_1' } }),
      sse({ type: 'response.output_item.added', sequence_number: 2, output_index: 0, item: REASONING }),
      sse({ type: 'response.output_item.done', sequence_number: 3, output_index: 0, item: REASONING }),
      sse({ type: 'response.output_item.added', output_index: 1, item: WS_CALL }),
      sse({ type: 'response.output_item.done', output_index: 1, item: WS_CALL }),
      sse({ type: 'response.output_item.added', output_index: 1, item: { ...DUMP_MSG, content: [] } }),
      sse({
        type: 'response.content_part.added', output_index: 1, content_index: 0, item_id: 'msg_SYNTH2',
        part: { type: 'output_text', text: '', annotations: [] },
      }),
      sse({ type: 'response.output_text.delta', output_index: 1, content_index: 0, item_id: 'msg_SYNTH2', delta: DUMP_TEXT }),
      sse({ type: 'response.output_text.done', output_index: 1, content_index: 0, item_id: 'msg_SYNTH2', text: DUMP_TEXT }),
      sse({ type: 'response.content_part.done', output_index: 1, content_index: 0, item_id: 'msg_SYNTH2', part: DUMP_MSG.content[0] }),
      sse({ type: 'response.output_item.done', output_index: 1, item: DUMP_MSG }),
      sse({
        type: 'response.completed', sequence_number: 8,
        response: {
          id: 'resp_1', status: 'completed',
          output: [REASONING, WS_CALL, DUMP_MSG],
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      }),
    ]);
  });

  it('CHARACTERIZATION: continuation POST failure falls back to a synthetic web_search_call + message pair', async () => {
    const res = captureWrites();
    const req = streamingReq();
    mockPost.mockRejectedValue(new Error('deployment 500'));

    await before({ req, res, utils });
    writeFirstCall(res);
    res.end();
    await settleAll();

    const events = frames(res);
    const terminal = events[events.length - 1];
    expect(terminal.type).toBe('response.completed');
    expect(terminal.response.output.map((i: any) => i.type)).toEqual(['reasoning', 'web_search_call', 'message']);
    expect(terminal.response.output.some((i: any) => i.type === 'function_call')).toBe(false);
    // The withheld result dump is handed over after all: it is the client's only view of
    // what the search found once the model's own answer is unreachable.
    expect(events.some(e => e.type === 'response.output_text.delta' && e.delta === DUMP_TEXT)).toBe(true);
    expect(events.filter(e => e.type === 'response.completed')).toHaveLength(1);
    // Only the first call's usage: no second call ever completed. No round carries
    // `input_tokens_details`, so the cache breakdown is zero and `total_tokens` recomputes
    // to 12 (T10).
    expect(terminal.response.usage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      total_tokens: 12,
    });
    expect(res.ended).toBe(true);
  });
});

describe('responsesWebSearchPlugin — CHARACTERIZATION: continuation POST bodies', () => {
  const FC_A = { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'web_search', arguments: '{"query":"node lts"}' };
  const FC_B = { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'web_search', arguments: '{"query":"node lts"}' };

  it('CHARACTERIZATION: two parallel web_search calls resolve into ONE continuation POST — streaming', async () => {
    const res = captureWrites();
    const req = streamingReq();
    mockPost.mockResolvedValue(upstreamStream(FIXTURE_CONTINUATION));

    await before({ req, res, utils });
    res.write(sse({ type: 'response.output_item.added', sequence_number: 0, output_index: 0, item: FC_A }));
    res.write(sse({ type: 'response.output_item.done', sequence_number: 1, output_index: 0, item: FC_A }));
    res.write(sse({ type: 'response.output_item.added', sequence_number: 2, output_index: 1, item: FC_B }));
    res.write(sse({ type: 'response.output_item.done', sequence_number: 3, output_index: 1, item: FC_B }));
    res.write(sse({
      type: 'response.completed', sequence_number: 4,
      response: { id: 'resp_1', status: 'completed', output: [FC_A, FC_B], usage: { input_tokens: 10, output_tokens: 2 } },
    }));
    await settleAll();

    const posts = (mockPost.mock.calls as any[][]).map(c => ({ url: c[0], body: c[1], config: c[2] }));
    const continuations = posts.filter(p => (p.body.input || []).some((i: any) => i.type === 'function_call_output'));
    expect(continuations).toHaveLength(1);
    expect(posts).toHaveLength(1);

    // ONE POST carrying BOTH function_call_outputs: a turn POSTed with any function_call
    // left unanswered is malformed and the deployment rejects it outright.
    const outputs = continuations[0].body.input.filter((i: any) => i.type === 'function_call_output');
    expect(outputs).toHaveLength(2);

    // Compared as a SET, deliberately. On this path the outputs are appended from
    // `roundResolved`, which `performSearch` pushes to AFTER `await executeWebSearch` —
    // i.e. in search-RESOLUTION order, not stream order. The instant mock makes it
    // deterministic here, but it is incidental, not a production invariant: two real
    // Perplexity calls can settle either way round. What IS load-bearing is that every
    // call is answered exactly once, in one POST.
    const byCallId = [...outputs].sort((a: any, b: any) => a.call_id.localeCompare(b.call_id));
    expect(byCallId).toEqual([
      { type: 'function_call_output', call_id: 'call_a', output: CALL_OUTPUT_JSON },
      { type: 'function_call_output', call_id: 'call_b', output: CALL_OUTPUT_JSON },
    ]);

    // The rest of the conversation IS ordered: the original prompt as a user message,
    // then both raw function_calls in the order the model emitted them.
    expect(continuations[0].body.input).toHaveLength(5);
    expect(continuations[0].body.input.slice(0, 3)).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'node lts?' }] },
      FC_A,
      FC_B,
    ]);
    expect(continuations[0].body.stream).toBe(true);
    expect(continuations[0].config.responseType).toBe('stream');
    expect(mockExecuteWebSearch).toHaveBeenCalledTimes(2);
  });

  it('CHARACTERIZATION: two parallel web_search calls resolve into ONE continuation POST — non-streaming', async () => {
    const req: any = { body: { stream: false, input: 'node lts?', tools: [{ type: 'web_search' }] }, __responsesUpstream: UPSTREAM() };
    req[REWROTE_FLAG] = true;
    mockPost.mockResolvedValue({ data: FIXTURE_BLOCKING_CONTINUATION });

    const upstreamResponse = {
      id: 'resp_1', status: 'completed', output: [FC_A, FC_B], usage: { input_tokens: 10, output_tokens: 2 },
    };
    await after({ req, res: {} as any, utils, upstreamResponse });

    const posts = (mockPost.mock.calls as any[][]).map(c => ({ url: c[0], body: c[1] }));
    const continuations = posts.filter(p => (p.body.input || []).some((i: any) => i.type === 'function_call_output'));
    expect(continuations).toHaveLength(1);
    expect(posts).toHaveLength(1);

    const outputs = continuations[0].body.input.filter((i: any) => i.type === 'function_call_output');
    expect(outputs).toHaveLength(2);
    // Ordered, unlike the streaming twin above: the after handler awaits each search
    // sequentially inside `for (const call of batch)` and pushes to `resolved` in batch
    // order, so this IS stream order and pinning it is pinning a real invariant.
    expect(outputs.map((o: any) => o.call_id)).toEqual(['call_a', 'call_b']);
    expect(continuations[0].body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'node lts?' }] },
      FC_A,
      FC_B,
      { type: 'function_call_output', call_id: 'call_a', output: CALL_OUTPUT_JSON },
      { type: 'function_call_output', call_id: 'call_b', output: CALL_OUTPUT_JSON },
    ]);
    expect(mockExecuteWebSearch).toHaveBeenCalledTimes(2);
  });

  it('CHARACTERIZATION: the stashed upstream payload is never mutated by a continuation', async () => {
    const res = captureWrites();
    const req = streamingReq();
    mockPost.mockResolvedValue(upstreamStream(FIXTURE_CONTINUATION));

    await before({ req, res, utils });
    writeFirstCall(res);
    await settleAll();

    expect(req.__responsesUpstream.payload).toEqual(UPSTREAM().payload);
  });
});

describe('responsesWebSearchPlugin — CHARACTERIZATION: the cap-overflow batch', () => {
  // A batch whose parallel calls exceed the search budget left for this request. POSTing a
  // continuation for it would leave some call without a function_call_output — the
  // malformed-turn shape the deployment rejects outright — so the batch is spliced IN
  // PLACE instead and the loop stops. Before this pair of tests the branch
  // (`overflow` at responsesWebSearchPlugin.ts:1342/1378, `capReached` at :663) had no
  // coverage anywhere in the repo: every other fixture pins the cap to 3 and never issues
  // more parallel calls than the remaining budget, so it is never entered.
  const CAP_FC_A = { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'web_search', arguments: '{"query":"node lts"}' };
  const CAP_FC_B = { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'web_search', arguments: '{"query":"deno lts"}' };
  // Task 2 fix round 2: a capped call's dump message used to fall through to
  // `buildSearchMessageItem([], query, ...)`, which reads as "the search ran and found
  // nothing" — exactly the conflation this whole task removes, and unreachable from the
  // `renderOutput` fix alone because `capReached` blocks every path that would carry it.
  //
  // Fix round 3: the non-streaming overflow batch below and the streaming test that follows
  // it used to produce TWO DIFFERENT texts for the same situation — the non-streaming
  // splice's stranded call went through `failedResult(call)` with no code (a generic
  // "could not be run"), because the `overflow`/`used >= capFor(descriptor)` admission
  // check here never threaded `cap_reached` through the way `performCall`'s own cap branch
  // does. Now that it does (`hostedToolAfterHandler`'s per-round admission loop,
  // `engine.ts`), both transports produce the SAME text — one constant, not two.
  //
  // Fix round 4: that ONE constant was itself wrong. It was fix round 2's `renderOutput`
  // text verbatim — MODEL-facing, carrying an instruction ("Do not tell the user…") that a
  // live acceptance run then showed rendered UNPARAPHRASED as the sole final message a human
  // saw in the TUI, since `capReached` forecloses every continuation and this dump IS the
  // last thing rendered on that path. This is the USER-facing text now — a plain statement
  // of what happened, no imperative — matching what a person actually reads. See
  // `webSearch/descriptor.ts`'s `FAILURE_MESSAGES`.
  const CAP_TEXT = "This turn's web-search budget was used up, so some of the requested "
    + 'searches were not run.';

  it('CHARACTERIZATION: a batch that overflows the remaining cap is spliced in place, with NO continuation POST — non-streaming', async () => {
    mockMaxSearches.mockReturnValue(1);                        // budget 1, two parallel calls
    const req: any = { body: { stream: false, input: 'node lts?', tools: [{ type: 'web_search' }] }, __responsesUpstream: UPSTREAM() };
    req[REWROTE_FLAG] = true;
    mockPost.mockResolvedValue({ data: FIXTURE_BLOCKING_CONTINUATION });

    const result = await after({
      req, res: {} as any, utils,
      upstreamResponse: { id: 'resp_1', status: 'completed', output: [REASONING, CAP_FC_A, CAP_FC_B], usage: { input_tokens: 10, output_tokens: 2 } },
    });

    // An upstream context IS available — only the overflow stops the continuation.
    expect(req.__responsesUpstream.url).toBeTruthy();
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockExecuteWebSearch).toHaveBeenCalledTimes(1);     // only the in-budget call ran

    // Both calls still get client-facing items, in place, so neither is ever an item with
    // no events; the one the budget could not cover is a `failed` placeholder.
    expect(normalizeIds(result.output)).toEqual([
      REASONING,
      { type: 'web_search_call', id: 'ws_SYNTH1', status: 'completed', action: { type: 'search', query: 'node lts' } },
      {
        type: 'message', id: 'msg_SYNTH2', role: 'assistant', status: 'completed',
        content: [{
          type: 'output_text', text: DUMP_TEXT,
          annotations: [{ type: 'url_citation', url: 'https://nodejs.example/lts', title: 'Node LTS' }],
        }],
      },
      { type: 'web_search_call', id: 'ws_SYNTH3', status: 'failed', action: { type: 'search', query: 'deno lts' } },
      {
        type: 'message', id: 'msg_SYNTH4', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: CAP_TEXT, annotations: [] }],
      },
    ]);
    expect(result.output.some((i: any) => i.type === 'function_call')).toBe(false);
    // No continuation happened, so usage is the first call's untouched.
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 2 });
  });

  it('CHARACTERIZATION: a batch that overflows the remaining cap is spliced in place, with NO continuation POST — streaming', async () => {
    mockMaxSearches.mockReturnValue(1);
    const res = captureWrites();
    const req = streamingReq();
    mockPost.mockResolvedValue(upstreamStream(FIXTURE_CONTINUATION));

    await before({ req, res, utils });
    res.write(sse({ type: 'response.created', sequence_number: 0, response: { id: 'resp_1' } }));
    res.write(sse({ type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: CAP_FC_A }));
    res.write(sse({ type: 'response.output_item.done', sequence_number: 2, output_index: 0, item: CAP_FC_A }));
    res.write(sse({ type: 'response.output_item.added', sequence_number: 3, output_index: 1, item: CAP_FC_B }));
    res.write(sse({ type: 'response.output_item.done', sequence_number: 4, output_index: 1, item: CAP_FC_B }));
    res.write(sse({
      type: 'response.completed', sequence_number: 5,
      response: { id: 'resp_1', status: 'completed', output: [CAP_FC_A, CAP_FC_B], usage: { input_tokens: 10, output_tokens: 2 } },
    }));
    await settleAll();

    expect(mockPost).not.toHaveBeenCalled();
    expect(mockExecuteWebSearch).toHaveBeenCalledTimes(1);

    const events = frames(res);
    // `capReached` blocks any continuation, so BOTH searches fall back to the result dump
    // — the client's only view of what was found.
    expect(events.map(e => e.type)).toEqual([
      'response.created',
      'response.output_item.added', 'response.output_item.done',                      // web_search_call @0
      'response.output_item.added', 'response.content_part.added',
      'response.output_text.delta', 'response.output_text.done',
      'response.content_part.done', 'response.output_item.done',                      // its dump @0
      'response.output_item.added', 'response.output_item.done',                      // web_search_call @1
      'response.output_item.added', 'response.content_part.added',
      'response.output_text.delta', 'response.output_text.done',
      'response.content_part.done', 'response.output_item.done',                      // its dump @1
      'response.completed',
    ]);
    // Each web_search_call stays with its own dump rather than both dumps arriving in one
    // lump after both pairs.
    expect(events.map(e => e.output_index).filter(n => typeof n === 'number'))
      .toEqual([...Array(8).fill(0), ...Array(8).fill(1)]);

    const terminal = events[events.length - 1];
    expect(terminal.response.output.map((i: any) => i.type))
      .toEqual(['web_search_call', 'message', 'web_search_call', 'message']);
    expect(terminal.response.output.map((i: any) => i.status))
      .toEqual(['completed', 'completed', 'failed', 'completed']);
    expect(terminal.response.output.some((i: any) => i.type === 'function_call')).toBe(false);
    expect(terminal.response.output[3].content[0].text).toBe(CAP_TEXT);
  });
});

describe('responsesWebSearchPlugin — CHARACTERIZATION: usage', () => {
  it('CHARACTERIZATION: usage sums across continuation rounds, not just the last — streaming', async () => {
    const res = captureWrites();
    const req = streamingReq();
    mockPost.mockResolvedValue(upstreamStream(FIXTURE_CONTINUATION));

    await before({ req, res, utils });
    writeFirstCall(res);
    await settleAll();

    const events = frames(res);
    const terminal = events[events.length - 1];
    // 10 + 40 and 2 + 7: the LAST round alone would be 40 / 7.
    expect(terminal.response.usage.input_tokens).toBe(50);
    expect(terminal.response.usage.output_tokens).toBe(9);
    // Only the continuation's tokens are billed as EXTRA — responsesController already
    // reads the first call's off the captured raw stream.
    expect(req.__responsesExtraUsage).toEqual({
      input_tokens: 40, output_tokens: 7, cache_creation_tokens: 0, cache_read_tokens: 0,
    });
  });

  it('CHARACTERIZATION: usage sums across continuation rounds, not just the last — non-streaming', async () => {
    const req: any = { body: { stream: false, input: 'node lts?', tools: [{ type: 'web_search' }] }, __responsesUpstream: UPSTREAM() };
    req[REWROTE_FLAG] = true;
    mockPost.mockResolvedValue({ data: FIXTURE_BLOCKING_CONTINUATION });

    const result = await after({ req, res: {} as any, utils, upstreamResponse: FIXTURE_BLOCKING_FIRST });

    expect(result.usage.input_tokens).toBe(50);
    expect(result.usage.output_tokens).toBe(9);
    expect(req.__responsesExtraUsage).toEqual({
      input_tokens: 40, output_tokens: 7, cache_creation_tokens: 0, cache_read_tokens: 0,
    });
  });

  it('CHARACTERIZATION: usage sums across THREE deployment calls — streaming, two rounds', async () => {
    const res = captureWrites();
    const req = streamingReq();
    const fc2 = { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'web_search', arguments: '{"query":"node lts"}' };
    mockPost
      .mockResolvedValueOnce(upstreamStream([
        { type: 'response.output_item.added', sequence_number: 0, output_index: 0, item: fc2 },
        { type: 'response.output_item.done', sequence_number: 1, output_index: 0, item: fc2 },
        {
          type: 'response.completed', sequence_number: 2,
          response: { id: 'resp_2', status: 'completed', output: [fc2], usage: { input_tokens: 40, output_tokens: 7 } },
        },
      ]))
      .mockResolvedValueOnce(upstreamStream(FIXTURE_CONTINUATION.map(f => (
        f.type === 'response.completed'
          ? { ...f, response: { ...(f as any).response, id: 'resp_3', usage: { input_tokens: 60, output_tokens: 5 } } }
          : f
      ))));

    await before({ req, res, utils });
    writeFirstCall(res);
    await settleAll();

    expect(mockPost).toHaveBeenCalledTimes(2);
    const events = frames(res);
    const terminal = events[events.length - 1];
    // 10 + 40 + 60 and 2 + 7 + 5 — every round, not the last and not the first two.
    expect(terminal.response.usage.input_tokens).toBe(110);
    expect(terminal.response.usage.output_tokens).toBe(14);
    expect(req.__responsesExtraUsage).toEqual({
      input_tokens: 100, output_tokens: 12, cache_creation_tokens: 0, cache_read_tokens: 0,
    });

    // --- and the FRAMES, not just the numbers. A continuable round emits ONLY the
    // synthetic web_search_call for its search: the model's own answer arrives in the
    // round after it, so a formatted-result dump here would be a second, redundant
    // assistant message in front of that answer.
    expect(events.map(e => e.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',      // reasoning
      'response.output_item.done',
      'response.output_item.added',      // web_search_call, round 1 — no dump follows it
      'response.output_item.done',
      'response.output_item.added',      // web_search_call, round 2 — nor here
      'response.output_item.done',
      'response.output_item.added',      // the model's answer
      'response.output_text.delta',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(events.map(e => e.item?.type).filter(Boolean))
      .toEqual(['reasoning', 'reasoning', 'web_search_call', 'web_search_call', 'web_search_call', 'web_search_call', 'message', 'message']);
    // No result dump reached the client on either continuable round.
    expect(events.some(e => e.type === 'response.output_text.delta' && String(e.delta).startsWith('Web search results for'))).toBe(false);
    expect(events.filter(e => e.type === 'response.content_part.added')).toHaveLength(0);

    // Each round's items are shifted past every index and sequence_number already used.
    expect(events.map(e => e.output_index).filter(n => typeof n === 'number')).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 3]);
    const seqs = events.map(e => e.sequence_number).filter(n => typeof n === 'number');
    expect(seqs).toEqual([0, 1, 2, 3, 14, 15, 16, 17]);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);

    expect(terminal.response.output.map((i: any) => i.type))
      .toEqual(['reasoning', 'web_search_call', 'web_search_call', 'message']);
  });

  it('CHARACTERIZATION: a continuation that delivers nothing at all hands over the withheld result dump', async () => {
    // The round was COMMITTED — its terminal frame swallowed and its result dump withheld
    // on the bet that the model's own answer was coming — and then the continuation
    // produced not one item and no terminal frame. Without the hand-over the client is
    // left with a web_search_call and an empty synthesized terminal: no answer AND no
    // results, strictly worse than the dump this feature replaced.
    const res = captureWrites();
    const req = streamingReq();
    mockPost.mockResolvedValue(upstreamStream([]));            // the stream ends immediately

    await before({ req, res, utils });
    writeFirstCall(res);
    await settleAll();

    expect(mockPost).toHaveBeenCalledTimes(1);
    const events = frames(res);

    // The dump arrives with its own output_item events, so the message named in the
    // terminal frame is never an item with no events.
    expect(events.map(e => e.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',      // reasoning
      'response.output_item.done',
      'response.output_item.added',      // web_search_call
      'response.output_item.done',
      'response.output_item.added',      // the withheld dump, handed over after all
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',              // synthesized: the round's own was swallowed
    ]);
    expect(events.some(e => e.type === 'response.output_text.delta' && e.delta === DUMP_TEXT)).toBe(true);

    const terminal = events[events.length - 1];
    expect(terminal.type).toBe('response.completed');
    // The dump is spliced directly behind the web_search_call it belongs to.
    expect(normalizeIds(terminal.response.output)).toEqual([REASONING, WS_CALL, DUMP_MSG]);
    expect(events.filter(e => e.type === 'response.completed')).toHaveLength(1);
  });
});

describe('responsesWebSearchPlugin — CHARACTERIZATION: transport parity', () => {
  it('CHARACTERIZATION: non-streaming output equals streaming output, item for item', async () => {
    // Streaming.
    const res = captureWrites();
    const streamReq = streamingReq();
    mockPost.mockResolvedValue(upstreamStream(FIXTURE_CONTINUATION));
    await before({ req: streamReq, res, utils });
    writeFirstCall(res);
    await settleAll();
    const streamedEvents = frames(res);
    const streamedOutput = streamedEvents[streamedEvents.length - 1].response.output;

    // Non-streaming, same fixtures.
    mockPost.mockReset();
    mockPost.mockResolvedValue({ data: FIXTURE_BLOCKING_CONTINUATION });
    const blockingReq: any = { body: { stream: false, input: 'node lts?', tools: [{ type: 'web_search' }] }, __responsesUpstream: UPSTREAM() };
    blockingReq[REWROTE_FLAG] = true;
    const blocking = await after({ req: blockingReq, res: {} as any, utils, upstreamResponse: FIXTURE_BLOCKING_FIRST });

    // The two transports must hand the client the SAME response.output for the same turn.
    expect(normalizeIds(blocking.output)).toEqual(normalizeIds(streamedOutput));
    expect(normalizeIds(blocking.output)).toEqual([REASONING, WS_CALL, MSG2]);
    // Same shape as the streaming transport's terminal usage above: no round carries
    // `input_tokens_details`, so the cache breakdown is zero and `total_tokens` recomputes
    // to 59 (T10).
    expect(blocking.usage).toEqual({
      input_tokens: 50,
      output_tokens: 9,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      total_tokens: 59,
    });
  });

  it('CHARACTERIZATION: no raw web_search function_call survives — non-streaming, continuation succeeded', async () => {
    // The committed round's items are accumulated through `clientVisibleItems`; the final
    // defensive filter only sweeps the LAST round's output, so this is the assertion that
    // pins the swap on every earlier round.
    const req: any = { body: { stream: false, input: 'node lts?', tools: [{ type: 'web_search' }] }, __responsesUpstream: UPSTREAM() };
    req[REWROTE_FLAG] = true;
    mockPost.mockResolvedValue({ data: FIXTURE_BLOCKING_CONTINUATION });

    const result = await after({ req, res: {} as any, utils, upstreamResponse: FIXTURE_BLOCKING_FIRST });

    expect(result.output.some((i: any) => i.type === 'function_call')).toBe(false);
    expect(result.output.map((i: any) => i.type)).toEqual(['reasoning', 'web_search_call', 'message']);
  });

  it('CHARACTERIZATION: no raw web_search function_call survives — non-streaming, continuation failed', async () => {
    const req: any = { body: { stream: false, input: 'node lts?', tools: [{ type: 'web_search' }] }, __responsesUpstream: UPSTREAM() };
    req[REWROTE_FLAG] = true;
    mockPost.mockRejectedValue(new Error('deployment 500'));

    const result = await after({ req, res: {} as any, utils, upstreamResponse: FIXTURE_BLOCKING_FIRST });

    expect(result.output.some((i: any) => i.type === 'function_call')).toBe(false);
    expect(result.output.some((i: any) => i.type === 'web_search_call')).toBe(true);
    expect(result.output.some((i: any) => i.type === 'message')).toBe(true);
    expect(normalizeIds(result.output)).toEqual([REASONING, WS_CALL, DUMP_MSG]);
  });
});
