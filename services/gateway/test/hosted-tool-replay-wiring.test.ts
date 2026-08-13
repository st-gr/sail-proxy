/**
 * Task 4 of the hosted-tool-result-replay design: the engine records each rendered call
 * item's result in the process-local cache (`resultCache.ts`, Task 2) at the moment the
 * client-visible `<type>_call` item is built.
 *
 * Only render sites that carry a REAL `ToolExecResult` may write to the cache. Three sites
 * in `engine.ts` (`replaceHostedToolCalls`, `clientVisibleItems`, the streaming
 * interceptor's `failedPlaceholder`) render a FAILED placeholder for a call that never
 * produced anything usable — a cap-exhausted call, a stranded mid-stream item, a call whose
 * own `execute()` returned `status: 'failed'` — and none of those may leave an entry behind.
 * That guard lives once, inside `cacheRenderedResult`, and is exercised here both by driving
 * a genuinely failed call through the real (non-placeholder) render site and, in the
 * mutation check recorded in the task report, by physically removing the streaming call
 * site and confirming only the streaming case regresses.
 *
 * BOTH TRANSPORTS are driven through the real `web_search` descriptor (`responsesWebSearchPlugin`),
 * matching `test/responses-websearch-plugin.test.ts`'s mocks and `after`/`before` handlers —
 * the streaming loop itself (`before` + `res.write(sse(...))` + settle) is the pattern
 * `test/responses-websearch-characterization.test.ts` already uses for this same plugin,
 * copied here because `responses-websearch-plugin.test.ts` alone never drives the streaming
 * interceptor.
 *
 * The file_search case drives the real `fileSearchDescriptor` (not a synthetic stand-in)
 * through `hostedToolAfterHandler` directly, with `prepare()`'s result stashed by hand — the
 * lighter-weight harness `test/responses-filesearch-execute.test.ts` already uses for this
 * descriptor's `execute()` — so the assertion is about the real `cachePayloadFrom` hook, not
 * a reimplementation of it.
 *
 * Extended again in Task 5, which adds the read side.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Readable } from 'stream';

const mockExecuteWebSearch = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../src/plugins/webSearch/searchExecutor', () => ({
  __esModule: true,
  executeWebSearch: (...a: any[]) => mockExecuteWebSearch(...a),
}));

// The REAL search.ts, with only its network/database entry point replaced — same approach
// as responses-filesearch-execute.test.ts, so fileSearchDescriptor.execute() runs for real.
const searchSpy = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../src/fileSearch/search', () => {
  const actual = jest.requireActual<any>('../src/fileSearch/search');
  return { ...actual, __esModule: true, searchVectorStores: (...args: any[]) => searchSpy(...args) };
});

jest.mock('../src/fileSearch/db', () => ({
  __esModule: true,
  getPool: () => ({ query: async () => ({ rows: [] }) }),
}));

const mockPost = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: (...a: any[]) => mockPost(...a) },
}));

const mockMaxSearches = jest.fn<() => number>();
const fileSearchToolConfig = { enabled: true, maxSearchesPerRequest: 5, maxNumResultsDefault: 10 };
jest.mock('../src/services/configService', () => {
  const actual = jest.requireActual<any>('../src/services/configService');
  return {
    __esModule: true,
    default: {
      getWebSearchMaxSearches: () => mockMaxSearches(),
      getFileSearchToolConfig: () => fileSearchToolConfig,
      getFileSearchConfig: () => ({ embeddingDimensions: 3, hybrid: { rrfK: 60, lexicalEnabled: true, candidates: 50 } }),
    },
    getFileSearchToolConfig: () => fileSearchToolConfig,
    getFileSearchConfig: () => ({ embeddingDimensions: 3, hybrid: { rrfK: 60, lexicalEnabled: true, candidates: 50 } }),
    MIN_RESULTS_DEFAULT: actual.MIN_RESULTS_DEFAULT,
    MAX_RESULTS_DEFAULT: actual.MAX_RESULTS_DEFAULT,
    // Read by resultCache.ts's putToolResult — this suite's whole point is asserting what
    // that function stores, so it must actually reach it rather than throwing (best-effort,
    // caught silently) inside putToolResult's own try/catch.
    getHostedToolResultCacheTtlSeconds: actual.getHostedToolResultCacheTtlSeconds,
    getHostedToolResultCacheMaxEntries: actual.getHostedToolResultCacheMaxEntries,
  };
});

import pluginRules = require('../src/plugins/responsesWebSearchPlugin');
import { hostedToolAfterHandler } from '../src/plugins/hostedTool/engine';
import { registerDescriptor } from '../src/plugins/hostedTool/registry';
import { fileSearchDescriptor } from '../src/plugins/fileSearch/descriptor';
import { SearchHit } from '../src/fileSearch/search';
import { ReplacementMap } from '../src/plugins/pseudonymization/replacementMap';
import { getToolResult, putToolResult, __resetToolResultCacheForTests } from '../src/plugins/hostedTool/resultCache';
import { HostedToolDescriptor, ParsedCall, ToolExecResult } from '../src/plugins/hostedTool/descriptor';

registerDescriptor(fileSearchDescriptor);

/**
 * A descriptor whose `cachePayloadFrom` throws — pins the fix-round-1 guarantee that
 * `cacheRenderedResult` must catch a throwing hook itself rather than letting it escape into
 * the render path. `execute()` always succeeds, so the only way this call's render could ever
 * come out `status: 'failed'` is the bug this test exists to catch: the throw escaping into
 * `hostedToolAfterHandler`'s outer catch, which converts EVERY hosted-tool call in the
 * response to a failed placeholder.
 */
const throwingCacheDescriptor: HostedToolDescriptor = {
  type: 'cache_throws',
  functionName: 'cache_throws_fn',
  rewriteTool: (hosted: any) => hosted,
  prepare: async () => undefined,
  maxCallsPerRequest: () => 5,
  parseCall: (callId: string, rawArguments: string): ParsedCall => ({ callId, rawArguments, args: {} }),
  execute: async (call: ParsedCall): Promise<ToolExecResult> => ({ call, status: 'completed', payload: { ok: true } }),
  renderOutput: (r: ToolExecResult) => ({ type: 'function_call_output', call_id: r.call.callId, output: '' }),
  renderCallItem: (r: ToolExecResult) => ({ type: 'cache_throws_call', id: 'ct_1', status: r.status }),
  renderResultMessage: () => null,
  cachePayloadFrom: (): unknown => { throw new Error('cachePayloadFrom exploded'); },
};
registerDescriptor(throwingCacheDescriptor);

const before = (pluginRules as any[]).find(r => r.strategy === 'before').handler;
const after = (pluginRules as any[]).find(r => r.strategy === 'after').handler;

const utils = { logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() } };

/** Must match the engine's private REWROTE_FLAG / PREPARED_FLAG. */
const REWROTE_FLAG = '__responsesWebSearchRewritten';
const PREPARED_FLAG = '__hostedToolPrepared';

const OWNER = 'owner@example.com';

const RESULTS = [{
  title: 'AI roundup', url: 'https://news.example/ai',
  snippet: "Today's AI news", content: "Today's AI news, in full.",
}];

// --------------------------------------------------------------------------- SSE harness
// Same shape as responses-websearch-characterization.test.ts's own helpers — deliberately,
// so this suite's streaming mechanics stay recognisably the same approach.

function sse(obj: any): string { return `data: ${JSON.stringify(obj)}\n\n`; }

function captureWrites(): any {
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

/** An axios streaming response whose body replays `frames` as SSE blocks. */
function upstreamStream(frames: any[]): any {
  return { data: Readable.from(frames.map(f => sse(f))) };
}

/** Every frame written to `res`, parsed. No id normalisation: the assertions need the real id. */
function writtenFrames(res: any): any[] {
  return res.written.join('')
    .split('\n\n')
    .filter((b: string) => b.length > 0)
    .map((b: string) => b.split('\n').find((l: string) => l.startsWith('data: ')))
    .filter((l: any): l is string => typeof l === 'string')
    .map((l: string) => JSON.parse(l.slice(6)));
}

const settleAll = () => new Promise(r => setTimeout(r, 25));

const UPSTREAM = () => ({
  url: 'https://sap.example/d1/responses',
  headers: { Authorization: 'Bearer t' },
  timeoutMs: 5000,
  payload: { model: 'm', input: 'ai news?', stream: true },
});

const FC_QUERY = 'latest AI news today';
const FC = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: `{"query":"${FC_QUERY}"}` };

const FIRST_CALL_FRAMES = [
  { type: 'response.created', sequence_number: 0, response: { id: 'resp_1' } },
  { type: 'response.in_progress', sequence_number: 1, response: { id: 'resp_1' } },
  { type: 'response.output_item.added', sequence_number: 2, output_index: 0, item: { ...FC, arguments: '' } },
  { type: 'response.function_call_arguments.done', sequence_number: 3, output_index: 0, arguments: FC.arguments },
  { type: 'response.output_item.done', sequence_number: 4, output_index: 0, item: FC },
  {
    type: 'response.completed', sequence_number: 5,
    response: { id: 'resp_1', status: 'completed', output: [FC], usage: { input_tokens: 10, output_tokens: 2 } },
  },
];

const MSG2 = {
  type: 'message', id: 'msg_2', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: 'Here is the AI news.', annotations: [] }],
};

const CONTINUATION_FRAMES = [
  { type: 'response.created', sequence_number: 0, response: { id: 'resp_2' } },
  { type: 'response.in_progress', sequence_number: 1, response: { id: 'resp_2' } },
  { type: 'response.output_item.added', sequence_number: 2, output_index: 0, item: { ...MSG2, content: [] } },
  { type: 'response.output_item.done', sequence_number: 3, output_index: 0, item: MSG2 },
  {
    type: 'response.completed', sequence_number: 4,
    response: { id: 'resp_2', status: 'completed', output: [MSG2], usage: { input_tokens: 40, output_tokens: 7 } },
  },
];

function streamingReq(): any {
  return {
    body: { stream: true, input: 'ai news?', tools: [{ type: 'web_search' }] },
    apiKeyInfo: { email: OWNER },
    __responsesUpstream: UPSTREAM(),
    __responsesExtraUsage: { input_tokens: 0, output_tokens: 0 },
  };
}

beforeEach(() => {
  __resetToolResultCacheForTests();
  mockExecuteWebSearch.mockReset();
  mockExecuteWebSearch.mockResolvedValue(RESULTS);
  mockPost.mockReset();
  mockMaxSearches.mockReset();
  mockMaxSearches.mockReturnValue(3);
  searchSpy.mockReset();
});

describe('hosted-tool engine — caching the rendered result under its item id', () => {
  it('caches a completed web_search result under the STREAMED call item\'s id', async () => {
    const res = captureWrites();
    const req = streamingReq();
    mockPost.mockResolvedValue(upstreamStream(CONTINUATION_FRAMES));

    await before({ req, res, utils });
    for (const frame of FIRST_CALL_FRAMES) res.write(sse(frame));
    await settleAll();

    const callItem = writtenFrames(res)
      .find((f: any) => f.type === 'response.output_item.done' && f.item?.type === 'web_search_call')?.item;
    expect(callItem).toBeDefined();

    const cached = getToolResult(callItem.id, OWNER);
    expect(cached?.query).toBe(FC_QUERY);
    expect(cached?.status).toBe('completed');
    expect(Array.isArray(cached?.payload)).toBe(true);
    expect((cached?.payload as any[])[0]?.url).toBe('https://news.example/ai');
  });

  it('caches a completed web_search result under the NON-STREAMING call item\'s id', async () => {
    const req: any = {
      body: { stream: false, input: 'ai news?', tools: [{ type: 'web_search' }] },
      apiKeyInfo: { email: OWNER },
      [REWROTE_FLAG]: true,
      __responsesUpstream: UPSTREAM(),
    };
    mockPost.mockResolvedValue({ data: { output: [MSG2], usage: { input_tokens: 40, output_tokens: 7 } } });

    const out = await after({ req, upstreamResponse: { output: [FC] }, utils });

    const callItem = out.output.find((i: any) => i.type === 'web_search_call');
    expect(callItem).toBeDefined();

    const cached = getToolResult(callItem.id, OWNER);
    expect(cached?.query).toBe(FC_QUERY);
    expect(cached?.status).toBe('completed');
    expect(Array.isArray(cached?.payload)).toBe(true);
    expect((cached?.payload as any[])[0]?.url).toBe('https://news.example/ai');
  });

  it('never caches a call whose own execute() reported failure — the guard inside cacheRenderedResult', async () => {
    mockExecuteWebSearch.mockRejectedValue(new Error('web search is down'));
    const req: any = { body: {}, apiKeyInfo: { email: OWNER }, [REWROTE_FLAG]: true };

    const out = await after({ req, upstreamResponse: { output: [FC] }, utils });

    const callItem = out.output.find((i: any) => i.type === 'web_search_call');
    expect(callItem?.status).toBe('failed');
    expect(getToolResult(callItem.id, OWNER)).toBeUndefined();
  });

  it('routes a file_search payload through cachePayloadFrom: the cache keeps raw hits, never maskedResults', async () => {
    const RAW_TEXT = 'Contact alice@example.com about it';
    const hits: SearchHit[] = [{
      fileId: 'file_1', filename: 'handbook.md', score: 0.9, attributes: {},
      content: [{ type: 'text', text: RAW_TEXT }],
    }];
    searchSpy.mockResolvedValue({
      object: 'vector_store.search_results.page', searchQuery: 'expense policy',
      data: hits, hasMore: false, nextPage: null, mode: 'reranked',
    });

    // A real, live ReplacementMap, empty at the start — proves masking genuinely ran (the
    // map gains the email) rather than merely proving the cache dropped a field that was
    // never populated in the first place.
    const map = new ReplacementMap('pseudonymization');
    expect(map.forward.size).toBe(0);

    const req: any = {
      body: {},
      apiKeyInfo: { email: OWNER },
      [REWROTE_FLAG]: true,
      [PREPARED_FLAG]: new Map([
        ['file_search', { storeIds: ['vs_1'], maxNumResults: 10, filters: undefined, rankingOptions: undefined }],
      ]),
      __pseudonymizationMap: map,
    };
    const fsCall = {
      type: 'function_call', id: 'fc_fs', call_id: 'call_fs', name: 'file_search',
      arguments: '{"query":"expense policy"}',
    };

    const out = await after({ req, upstreamResponse: { output: [fsCall] }, utils });

    // The live map really was extended — this is not a vacuous "no maskedResults key"
    // check against a payload that was never masked in the first place.
    expect(map.forward.has('alice@example.com')).toBe(true);

    const callItem = out.output.find((i: any) => i.type === 'file_search_call');
    expect(callItem).toBeDefined();

    const cached = getToolResult(callItem.id, OWNER);
    expect(cached?.status).toBe('completed');
    const payload: any = cached?.payload;
    expect(payload.hits).toHaveLength(1);
    expect(payload.hits[0].content[0].text).toBe(RAW_TEXT);
    expect(Object.keys(payload)).not.toContain('maskedResults');
  });

  it('never lets a throwing cachePayloadFrom hook corrupt the turn: caught and logged, the render stays intact and nothing gets cached (fix round 1)', async () => {
    (utils.logger.error as jest.Mock).mockClear();
    const req: any = { body: {}, apiKeyInfo: { email: OWNER }, [REWROTE_FLAG]: true };
    const call = {
      type: 'function_call', id: 'fc_ct', call_id: 'call_ct', name: 'cache_throws_fn', arguments: '{}',
    };

    const out = await hostedToolAfterHandler({ req, res: {} as any, upstreamResponse: { output: [call] }, utils });

    // The turn completed normally — the whole point of the fix. Before it, the throw escaped
    // into hostedToolAfterHandler's outer catch, which converts EVERY hosted-tool call in the
    // response to a FAILED placeholder; that would flip this to 'failed' and this assertion
    // would catch the regression.
    const callItem = out.output.find((i: any) => i.type === 'cache_throws_call');
    expect(callItem).toBeDefined();
    expect(callItem.status).toBe('completed');
    expect(out.output.some((i: any) => i.type === 'function_call')).toBe(false);

    // The write itself failed — nothing was cached.
    expect(getToolResult(callItem.id, OWNER)).toBeUndefined();

    // But not silently from an operator's point of view: the throw was logged rather than
    // swallowed without a trace.
    expect(utils.logger.error).toHaveBeenCalledWith(expect.stringContaining('cache_throws'));
  });
});

/**
 * Task 5: the read side. The before handler now rewrites every replayed `<type>_call` item
 * in `body.input` into the `function_call`/`function_call_output` pair the model's rewritten
 * tool list actually uses, BEFORE the pre-existing pending-call drain runs. A cache hit
 * restores the model's own prior tool use verbatim, without re-running the search; a cache
 * miss leaves the `function_call` deliberately unsatisfied so the existing drain (below,
 * unedited) re-executes the recorded query live.
 *
 * `ctxFor` mirrors `responses-websearch-plugin.test.ts`'s before-handler block: `before` is
 * called directly with `{ req, res, utils }`, and owner identity is read off
 * `req.apiKeyInfo.email` the same way `ownerEmailFrom` reads it in production.
 */
function ctxFor(body: any, ownerEmail: string): any {
  return { req: { body, apiKeyInfo: { email: ownerEmail } }, res: {} as any, utils };
}

describe('replayed hosted call items, on the way in', () => {
  const replayed = (id: string) => ({ type: 'web_search_call', id, status: 'completed',
    action: { type: 'search', query: 'latest AI news today' } });

  beforeEach(() => {
    __resetToolResultCacheForTests();
    mockExecuteWebSearch.mockReset();
    mockExecuteWebSearch.mockResolvedValue(RESULTS);
    mockMaxSearches.mockReset();
    mockMaxSearches.mockReturnValue(3);
  });

  it('CACHE HIT: becomes a function_call plus its function_call_output, carrying the real results', async () => {
    putToolResult('ws_hit1234', { toolType: 'web_search', ownerEmail: 'owner@example.com',
      payload: [{ title: 'Reuters', url: 'https://r.com/a', snippet: 's', content: 'c' }],
      status: 'completed', query: 'latest AI news today' });
    const body: any = { tools: [{ type: 'web_search' }], input: [replayed('ws_hit1234')], stream: false };
    await before(ctxFor(body, 'owner@example.com'));
    const types = body.input.map((i: any) => i.type);
    expect(types).toEqual(['function_call', 'function_call_output']);
    expect(JSON.parse(body.input[1].output).results[0].url).toBe('https://r.com/a');
    expect(body.input[1].call_id).toBe('ws_hit1234');
    expect(mockExecuteWebSearch).not.toHaveBeenCalled(); // a hit must not re-run the search
  });

  /**
   * Inverted, deliberately: this used to assert that a miss becomes a `function_call` the
   * drain then executes live (`expect(mockExecuteWebSearch).toHaveBeenCalledWith(...)`). That
   * pinned the reported defect — replaying history re-ran the recorded query and spent part
   * of the per-turn search budget on it. A miss now pairs with a `not_retained` output
   * directly in the rewrite, so nothing is ever executed.
   */
  it('CACHE MISS: becomes a satisfied pair that re-runs nothing', async () => {
    const body: any = { tools: [{ type: 'web_search' }], stream: false,
      input: [{ type: 'web_search_call', id: 'ws_miss123', status: 'completed',
                action: { type: 'search', query: 'latest AI news today' } }] };
    await before(ctxFor(body, OWNER));
    const types = body.input.map((i: any) => i.type);
    expect(types).toEqual(['function_call', 'function_call_output']);
    const out = JSON.parse(body.input[1].output);
    expect(out.error.code).toBe('not_retained');
    expect(out.results).toBeUndefined();
    expect(mockExecuteWebSearch).not.toHaveBeenCalled();   // the whole point
    expect(body.input[1].call_id).toBe('ws_miss123');
  });

  /**
   * The regression test for the reported symptom: a codex conversation replayed four prior
   * web_search_call items whose cache entries were gone, the drain re-ran three of them live
   * and hit the per-request cap of 3 on the fourth, and the model emitted no new tool call
   * that turn because history replay had already spent the entire budget. Four replayed
   * misses must now consume zero of that budget.
   */
  it('four replayed misses leave the per-turn search budget untouched', async () => {
    const body: any = { tools: [{ type: 'web_search' }], stream: false,
      input: ['a','b','c','d'].map(s => ({ type: 'web_search_call', id: `ws_${s}`,
        status: 'completed', action: { type: 'search', query: `q${s}` } })) };
    await before(ctxFor(body, OWNER));
    expect(mockExecuteWebSearch).not.toHaveBeenCalled();
    const outs = body.input.filter((i: any) => i.type === 'function_call_output')
      .map((i: any) => JSON.parse(i.output));
    expect(outs).toHaveLength(4);
    expect(outs.every((o: any) => o.error?.code === 'not_retained')).toBe(true);
  });

  it('no hosted call item is left in the outbound input — the deployment never sees the hosted shape', async () => {
    const body: any = { tools: [{ type: 'web_search' }],
      input: [replayed('ws_hit1234'), { type: 'message', role: 'user', content: [] }], stream: false };
    await before(ctxFor(body, 'owner@example.com'));
    expect(body.input.some((i: any) => i.type === 'web_search_call')).toBe(false);
  });

  it('a replayed item with no recoverable query is dropped, not guessed at', async () => {
    const body: any = { tools: [{ type: 'web_search' }],
      input: [{ type: 'web_search_call', id: 'ws_bad', status: 'completed' }], stream: false };
    await before(ctxFor(body, 'owner@example.com'));
    expect(body.input).toEqual([]);
  });

  /**
   * Fix round 1: the reviewer found that a recoverable-query item with no `id` fell through
   * the query guard untouched and became an orphaned `function_call` — `call_id: undefined`
   * — that the drain's own `typeof call_id !== 'string'` check then skips forever, so it
   * reaches the deployment with no matching output and no tool of its type. Guarded the same
   * way as the no-query case: dropped, not forwarded.
   */
  it('a replayed item with a recoverable query but no id is dropped — no orphaned function_call reaches the deployment', async () => {
    const body: any = { tools: [{ type: 'web_search' }],
      input: [{ type: 'web_search_call', status: 'completed',
        action: { type: 'search', query: 'latest AI news today' } }], stream: false };
    await before(ctxFor(body, 'owner@example.com'));
    expect(body.input).toEqual([]);
    expect(body.input.some((i: any) => i.type === 'function_call')).toBe(false);
    expect(mockExecuteWebSearch).not.toHaveBeenCalled();
  });

  /** Same guard, non-string id (a number) — `typeof item.id !== 'string'` catches it too. */
  it('a replayed item whose id is not a string is dropped the same way', async () => {
    const body: any = { tools: [{ type: 'web_search' }],
      input: [{ type: 'web_search_call', id: 12345, status: 'completed',
        action: { type: 'search', query: 'latest AI news today' } }], stream: false };
    await before(ctxFor(body, 'owner@example.com'));
    expect(body.input).toEqual([]);
    expect(mockExecuteWebSearch).not.toHaveBeenCalled();
  });

  it('leaves a turn with no replayed items exactly as it found it', async () => {
    const input = [{ type: 'message', role: 'user', content: [] }];
    const body: any = { tools: [{ type: 'web_search' }], input: [...input], stream: false };
    await before(ctxFor(body, 'owner@example.com'));
    expect(body.input).toEqual(input);
  });

  /**
   * Step 7 of the Task 5 brief originally established that past `MAX_PENDING_CALLS_PER_TURN`
   * (engine.ts, =4), replayed misses fed to the pending-call DRAIN needed a per-`descriptor.type`
   * cap (`callsRunByType`) and a post-loop sweep so no `function_call` was left ORPHANED —
   * reproduced then with 5 replayed misses: `function_call=5, function_call_output=4,
   * orphans=1`. Task 2 of the replay-miss-no-reexecution design moved the miss case out of the
   * drain entirely: every reconstructed `function_call` is now paired with its output (a hit's
   * cached results, or `not_retained` on a miss) directly in the rewrite above, before the
   * drain ever runs, so replayed items no longer reach `callsRunByType` or the post-loop sweep
   * at all. This test still pins the pairing invariant — no orphan `function_call` past the old
   * 4-item boundary — now guaranteed structurally by the rewrite instead.
   */
  it('more than 4 replayed cache misses in one turn leaves zero orphaned function_call items — every call is paired to an output', async () => {
    const body: any = {
      tools: [{ type: 'web_search' }],
      input: [
        replayed('ws_miss_1'), replayed('ws_miss_2'), replayed('ws_miss_3'),
        replayed('ws_miss_4'), replayed('ws_miss_5'),
      ],
      stream: false,
    };
    await before(ctxFor(body, 'owner@example.com'));

    const calls = body.input.filter((i: any) => i.type === 'function_call');
    const outputs = body.input.filter((i: any) => i.type === 'function_call_output');
    expect(calls).toHaveLength(5);
    expect(outputs).toHaveLength(5);

    const outputCallIds = new Set(outputs.map((o: any) => o.call_id));
    const orphans = calls.filter((c: any) => !outputCallIds.has(c.call_id));
    expect(orphans).toEqual([]);

    // The cap (3) still holds even past the MAX_PENDING_CALLS_PER_TURN boundary: no more
    // than 3 of the 5 ever ran live.
    expect(mockExecuteWebSearch.mock.calls.length).toBeLessThanOrEqual(3);
  });

  /**
   * Fix round 1, minor finding: the six cases above only ever drive `web_search`, whose
   * `rehydratePayload` ignores `ctx` entirely — so nothing at THIS layer proved the ctx the
   * rewrite builds (`replacementMap`, `maskingConfig`) is the right one for a descriptor
   * that actually reads it. `file_search` is that descriptor, and masking retrieved document
   * text through the REPLAYING request's own live map is the security-sensitive half of the
   * whole design: cached text is raw (`resultCache.ts`'s header), and under `anonymization`
   * a cached placeholder from the ORIGINAL request means something else entirely on replay.
   * Task 3's suite already pins that `rehydratePayload` masks correctly given a ctx; this
   * proves the rewrite in `engine.ts` hands it one that actually works, end to end through
   * the real before handler.
   */
  it('CACHE HIT (file_search): the rewrite masks the cached raw document text through the replaying request\'s own map before it reaches function_call_output', async () => {
    putToolResult('fs_hit1', {
      toolType: 'file_search',
      ownerEmail: OWNER,
      payload: {
        hits: [{
          fileId: 'file_1', filename: 'handbook.md', score: 0.9, attributes: {},
          content: [{ type: 'text', text: 'Contact alice@example.com about the renewal' }],
        }],
        queries: ['expense policy'],
      },
      status: 'completed',
      query: 'expense policy',
    });

    // A live, empty ReplacementMap — the replaying request's own map, distinct from
    // whatever map (if any) minted the cached text originally. Empty at the start proves
    // masking genuinely ran during THIS rewrite rather than the assertion passing vacuously
    // against a map that already happened to hold the pairing.
    const map = new ReplacementMap('pseudonymization');
    expect(map.forward.size).toBe(0);

    const req: any = {
      body: {
        tools: [{ type: 'file_search' }],
        input: [{ type: 'file_search_call', id: 'fs_hit1', status: 'completed', queries: ['expense policy'] }],
        stream: false,
      },
      apiKeyInfo: { email: OWNER },
      __pseudonymizationMap: map,
    };

    await before({ req, res: {} as any, utils });

    const types = req.body.input.map((i: any) => i.type);
    expect(types).toEqual(['function_call', 'function_call_output']);

    const output = req.body.input[1];
    expect(output.call_id).toBe('fs_hit1');
    const results = JSON.parse(output.output).results;
    expect(results).toHaveLength(1);
    // Masked: the placeholder is present, the raw address is not.
    expect(results[0].text).not.toContain('alice@example.com');
    expect(results[0].text).toMatch(/MASKED_EMAIL_\d+/);
    // And the map that minted it is the replaying request's own live map.
    expect(map.forward.has('alice@example.com')).toBe(true);
  });
});
