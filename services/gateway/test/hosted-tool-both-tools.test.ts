/**
 * ONE turn calling BOTH real hosted tools — `web_search` and `file_search` together.
 *
 * This is the case that motivated extracting `hostedTool/engine.ts` in the first place. Two
 * independent per-tool loops would each continue the turn, and the second would POST a
 * conversation the first had already advanced.
 *
 * `test/hosted-tool-engine.test.ts` already pins that generalisation with SYNTHETIC
 * descriptors, and this suite deliberately does not repeat it. The question here is a
 * different one: that the TWO DESCRIPTORS THAT ACTUALLY SHIP compose. Both are registered by
 * importing their plugin shims, exactly as `pluginLoader` does at boot — nothing below
 * registers a descriptor of its own, so `__resetRegistry()` is never called either (it would
 * clear the two import-time registrations for the rest of the file).
 *
 * WHAT IS COVERED THAT NOTHING ELSE COVERS:
 *
 *   1. one continuation POST for the whole turn, carrying every call's
 *      `function_call_output` — each rendered by its OWN descriptor, which is checkable here
 *      and not with two fakes: `web_search` emits `{results:[{title,url,snippet,...}]}` and
 *      `file_search` emits `{results:[{file_id,filename,score,...}]}`, so a descriptor mix-up
 *      is a visible diff rather than a shape that happens to match;
 *   2. the client sees one `web_search_call` and one `file_search_call` and no `function_call`;
 *   3. the two tools' caps are INDEPENDENT — `web_search`'s comes from
 *      `getWebSearchMaxSearches()`, `file_search`'s from `getFileSearchToolConfig()`, two
 *      unrelated config paths that a shared counter would silently collapse;
 *   4. one tool failing does not take the turn (or the other tool) down with it;
 *   5. THE FRAME-LEVEL MACHINERY WITH TWO DESCRIPTORS REGISTERED. `output_index` and
 *      `sequence_number` shifting across a mixed-tool round, and the interleaving queue with
 *      two tools in flight, are descriptor-agnostic BY CONSTRUCTION — the interceptor keys off
 *      `output_index` and never off the tool — but that is an argument, not a test. A
 *      mixed-tool streaming round where both tools' synthetic items are spliced is exactly
 *      where an index-shifting bug hides. Two tests below are that round;
 *   6. (this suite's own addition) the descriptors compose in `annotateItem`'s chaining loop:
 *      `file_search` implements `annotateMessage` and `web_search` does not, so the mixed
 *      turn's answer carries `file_citation` annotations and nothing from `web_search`.
 *
 * FIXTURE HYGIENE, because reviews on this branch have repeatedly found tests that passed
 * whether or not the covered behaviour existed — every time because a fixture made two things
 * coincide. Here:
 *
 *   - emission order is neither registration order (web_search, then file_search) nor
 *     grouped-by-tool order nor sorted-by-call-id order: the model emits file, web, file;
 *   - the two caps are DIFFERENT numbers (1 and 3), and the turn spends both exactly;
 *   - the two tools' spliced items land at DIFFERENT `output_index` values, and the
 *     continuation's own items are asserted to land past BOTH of them — so an offset computed
 *     from only the first descriptor's items collides rather than coinciding;
 *   - the slow tool is the one emitted FIRST, so arrival order and resolution order disagree.
 *
 * MUTATION-TESTED; see `.superpowers/sdd/2026-08-04-file-search-tool/task-10-report.md` for
 * the mutation list, the named test each one fails, and the output.
 *
 * @see test/hosted-tool-engine.test.ts - the same engine with synthetic descriptors
 * @see src/plugins/hostedTool/engine.ts - the machinery under test
 * @see src/plugins/webSearch/descriptor.ts, src/plugins/fileSearch/descriptor.ts
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Readable } from 'stream';

const mockPost = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: (...a: any[]) => mockPost(...a) },
}));

const mockExecuteWebSearch = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../src/plugins/webSearch/searchExecutor', () => ({
  __esModule: true,
  executeWebSearch: (...a: any[]) => mockExecuteWebSearch(...a),
}));

// Spread the real module: `SearchStoreNotFoundError` and friends are what the descriptor's
// `errorCodeFor` narrows on, so replacing the module wholesale would make every failure a
// generic `file_search_unavailable` and test 4 below would pass for the wrong reason.
const mockSearchVectorStores = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../src/fileSearch/search', () => {
  const actual = jest.requireActual<any>('../src/fileSearch/search');
  return { ...actual, __esModule: true, searchVectorStores: (...a: any[]) => mockSearchVectorStores(...a) };
});

// `file_search`'s prepare() calls `assertStoresAccessible`, which reads the pool directly.
const mockPoolQuery = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../src/fileSearch/db', () => ({
  __esModule: true,
  getPool: () => ({ query: (...a: any[]) => mockPoolQuery(...a) }),
}));

/**
 * The two caps come from two UNRELATED config accessors, which is the point of test 3: they
 * are `let`s so a test can set them independently, and the module's real MIN/MAX bounds are
 * re-exported from the actual module so the descriptor's validation and this mock cannot
 * agree with each other while disagreeing with configService.
 */
let mockWebSearchCap = 3;
let mockFileSearchToolConfig = { enabled: true, maxSearchesPerRequest: 5, maxNumResultsDefault: 10 };
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getWebSearchMaxSearches: () => mockWebSearchCap,
    getFileSearchToolConfig: () => mockFileSearchToolConfig,
  },
  getWebSearchMaxSearches: () => mockWebSearchCap,
  getFileSearchToolConfig: () => mockFileSearchToolConfig,
  getFileSearchConfig: () => ({ embeddingDimensions: 3, hybrid: { rrfK: 60, lexicalEnabled: true, candidates: 50 } }),
  MIN_RESULTS_DEFAULT: jest.requireActual<any>('../src/services/configService').MIN_RESULTS_DEFAULT,
  MAX_RESULTS_DEFAULT: jest.requireActual<any>('../src/services/configService').MAX_RESULTS_DEFAULT,
}));

// Registration is an import-time side effect of the two plugin shims — the same thing
// `pluginLoader` triggers at boot. Both are needed and neither is otherwise referenced.
import webSearchRules = require('../src/plugins/responsesWebSearchPlugin');
import fileSearchRules = require('../src/plugins/responsesFileSearchPlugin');
import { hostedToolBeforeHandler, hostedToolAfterHandler } from '../src/plugins/hostedTool/engine';
import { descriptorForType } from '../src/plugins/hostedTool/registry';
import { webSearchDescriptor } from '../src/plugins/webSearch/descriptor';
import { fileSearchDescriptor } from '../src/plugins/fileSearch/descriptor';
import { SearchStoreNotFoundError } from '../src/fileSearch/search';

const utils = { logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() } };

const OWNER = 'owner@corp.example';
const STORE = 'vs_handbook';

// ------------------------------------------------------------------------------- fixtures

/** The web result set. Its wire shape is `title/url/snippet/content/date` — nothing
 *  `file_search` produces looks like this, which is what makes a descriptor mix-up visible. */
const WEB_RESULTS = [{
  title: 'Berlin forecast',
  url: 'https://weather.example/berlin',
  snippet: 'Mild all week',
  content: 'Berlin stays mild and dry through Friday.',
  date: '2026-08-01',
}];

/** The retrieved passage, verbatim as it sits in the corpus. One sentence, comfortably over
 *  `CITATION_NEEDLE_MIN_LENGTH`, so the citation test below anchors on it. */
const CHUNK = 'Expense claims must be submitted within thirty calendar days of the trip.';

const HIT = {
  fileId: 'file_handbook',
  filename: 'handbook.md',
  score: 0.87,
  attributes: { dept: 'finance' },
  content: [{ type: 'text', text: CHUNK }],
};

const REASONING = { type: 'reasoning', id: 'rs_1', encrypted_content: 'gAAAAAopaque==', summary: [] };

/** The model's real answer, quoting the passage verbatim — see the citation test. */
const ANSWER_TEXT = `Two things. ${CHUNK} Berlin will be mild.`;
const FINAL_MSG = {
  type: 'message', id: 'msg_final', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: ANSWER_TEXT, annotations: [] }],
};

/** A `function_call` against one of the two REWRITTEN function tools. The function names are
 *  the descriptors' own (`web_search` / `file_search`), not this suite's invention. */
function fc(name: 'web_search' | 'file_search', callId: string, query: string): any {
  return {
    type: 'function_call', id: `fc_${callId}`, call_id: callId,
    name, arguments: JSON.stringify({ query }),
  };
}

const UPSTREAM = (stream: boolean) => ({
  url: 'https://sap.example/d1/responses',
  headers: { Authorization: 'Bearer t' },
  timeoutMs: 5000,
  payload: { model: 'gpt-5.4--deployed', input: 'go', stream },
});

function captureWrites(): any {
  const written: string[] = [];
  let ended = false;
  return {
    written,
    get ended() { return ended; },
    write(chunk: any) { written.push(String(chunk)); return true; },
    end(chunk?: any) { if (chunk !== undefined) written.push(String(chunk)); ended = true; return this as any; },
    status() { return this; },
    json() { return this; },
    setHeader() { /* no-op */ },
    getHeader() { return undefined; },
    headersSent: false,
    statusCode: 200,
    writableEnded: false,
  } as any;
}

/**
 * Open a turn carrying BOTH hosted tools, through the REAL before handler — which is what
 * rewrites the two hosted entries into function tools and runs each descriptor's `prepare()`.
 * `file_search` refuses to search without a prepared configuration, so skipping this would
 * make every test below pass against a tool that never ran.
 */
async function openTurn(stream: boolean): Promise<{ req: any; res: any }> {
  const res = captureWrites();
  const req: any = {
    apiKeyInfo: { email: OWNER },
    body: {
      model: 'gpt-5.4--deployed',
      stream,
      input: 'what does the handbook say, and how is the weather?',
      tools: [{ type: 'web_search' }, { type: 'file_search', vector_store_ids: [STORE] }],
    },
    __responsesUpstream: UPSTREAM(stream),
    __responsesExtraUsage: { input_tokens: 0, output_tokens: 0 },
  };
  await hostedToolBeforeHandler({ req, res, utils });
  return { req, res };
}

/** One non-streaming deployment response. */
function firstTurn(output: any[]): any {
  return { id: 'resp_1', status: 'completed', output, usage: { input_tokens: 10, output_tokens: 2 } };
}
function reply(id: string, output: any[]): any {
  return { data: { id, status: 'completed', output, usage: { input_tokens: 5, output_tokens: 1 } } };
}

/** The `input` array of the n-th POST the engine made. */
function postedInput(n: number): any[] {
  return (mockPost.mock.calls[n] as any[])[1].input;
}

/** Every `function_call_output` in a POSTed conversation, in order. */
function postedOutputs(n: number): any[] {
  return postedInput(n).filter((i: any) => i.type === 'function_call_output');
}

/** The POSTs that ANSWER a hosted-tool call, i.e. the continuations. */
function continuationPosts(): any[][] {
  return (mockPost.mock.calls as any[][]).filter(
    call => ((call[1]?.input ?? []) as any[]).some((i: any) => i.type === 'function_call_output'));
}

function itemsOfType(response: any, type: string): any[] {
  return (response?.output || []).filter((i: any) => i.type === type);
}

// -------------------------------------------------------------------- streaming harness

function sse(obj: any): string { return `data: ${JSON.stringify(obj)}\n\n`; }

/** An axios streaming response whose body replays `frames` as SSE blocks. */
function upstreamStream(frames: any[]): any {
  return { data: Readable.from(frames.map(f => sse(f))) };
}

/** Every frame written to `res`, parsed, in order. */
function streamedFrames(res: any): any[] {
  return res.written.join('')
    .split('\n\n')
    .map((b: string) => b.trim())
    .filter((b: string) => b.length > 0)
    .map((b: string) => b.split('\n').find((l: string) => l.startsWith('data: ')))
    .filter((l: any): l is string => typeof l === 'string')
    .map((l: string) => JSON.parse(l.slice(6)));
}

function terminalFrame(res: any): any {
  const all = streamedFrames(res);
  return all[all.length - 1];
}

/** Poll until the client's terminal frame is on the wire, then a beat for any straggler. */
async function settleStream(res: any, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => { setTimeout(resolve, 2); });
    if (streamedFrames(res).some(f => f.type === 'response.completed')) break;
  }
  await new Promise(resolve => { setTimeout(resolve, 15); });
}

/**
 * The deployment's first streaming call, as responsesController writes it: an
 * `output_item.added` / `.done` pair per item at ascending `output_index`, with a
 * monotonically increasing `sequence_number` across the whole round.
 */
function firstRoundFrames(items: any[]): any[] {
  const out: any[] = [
    { type: 'response.created', sequence_number: 0, response: { id: 'resp_1' } },
    { type: 'response.in_progress', sequence_number: 1, response: { id: 'resp_1' } },
  ];
  let seq = 2;
  items.forEach((item, index) => {
    const isCall = item.type === 'function_call';
    out.push({
      type: 'response.output_item.added', sequence_number: seq++, output_index: index,
      item: isCall ? { ...item, arguments: '' } : item,
    });
    if (isCall) {
      out.push({
        type: 'response.function_call_arguments.done', sequence_number: seq++,
        output_index: index, arguments: item.arguments,
      });
    }
    out.push({ type: 'response.output_item.done', sequence_number: seq++, output_index: index, item });
  });
  out.push({
    type: 'response.completed', sequence_number: seq,
    response: { id: 'resp_1', status: 'completed', output: items, usage: { input_tokens: 10, output_tokens: 2 } },
  });
  return out;
}

/**
 * The continuation round where the model finally answers. Its own `output_index` is 0 and its
 * `sequence_number`s restart at 0 — exactly as a fresh deployment call numbers them, and
 * exactly what the engine has to shift past everything the first round already used.
 */
function continuationAnswerFrames(respId: string): any[] {
  return [
    { type: 'response.created', sequence_number: 0, response: { id: respId } },
    { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...FINAL_MSG, content: [] } },
    { type: 'response.output_item.done', sequence_number: 2, output_index: 0, item: FINAL_MSG },
    {
      type: 'response.completed', sequence_number: 3,
      response: { id: respId, status: 'completed', output: [FINAL_MSG], usage: { input_tokens: 5, output_tokens: 1 } },
    },
  ];
}

beforeEach(() => {
  mockPost.mockReset();
  mockExecuteWebSearch.mockReset();
  mockSearchVectorStores.mockReset();
  mockPoolQuery.mockReset();
  utils.logger.error.mockClear();
  utils.logger.warn.mockClear();

  mockWebSearchCap = 3;
  mockFileSearchToolConfig = { enabled: true, maxSearchesPerRequest: 5, maxNumResultsDefault: 10 };

  // The store exists, is accessible to OWNER, is not expired and matches the configured
  // embedding dimension — so `prepare()` succeeds and `execute` is reachable.
  mockPoolQuery.mockResolvedValue({ rows: [{ id: STORE, status: 'completed', embedding_dim: 3 }] });
  mockExecuteWebSearch.mockResolvedValue(WEB_RESULTS);
  mockSearchVectorStores.mockResolvedValue({ data: [HIT] });
});

// ============================================================================ registration

describe('both hosted tools registered', () => {
  it('registers ONE descriptor per tool, from the two plugin shims', () => {
    // The rest of the suite is meaningless if only one of them is in the registry — every
    // "mixed turn" assertion would then be a single-tool turn with an unrecognised
    // function_call passed straight through.
    expect(descriptorForType('web_search')).toBe(webSearchDescriptor);
    expect(descriptorForType('file_search')).toBe(fileSearchDescriptor);
    expect(Array.isArray(webSearchRules)).toBe(true);
    expect(Array.isArray(fileSearchRules)).toBe(true);
  });

  it('rewrites BOTH hosted entries into function tools in one before-handler pass', async () => {
    const { req } = await openTurn(false);

    expect(req.body.tools.map((t: any) => t.type)).toEqual(['function', 'function']);
    expect(req.body.tools.map((t: any) => t.name)).toEqual(['web_search', 'file_search']);
    // file_search's prepare() actually ran: it validated the store against the caller.
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });
});

// ================================================================ the non-streaming path

describe('a turn calling web_search and file_search — the non-streaming transport', () => {
  /**
   * Emission order is file, web, file. That is not registration order (web, then file), not
   * grouped-by-tool order, and not sorted-by-call-id order (`call_fs1`, `call_fs2`,
   * `call_ws`) — so an engine that grouped per tool would POST twice, and one that grouped
   * per tool into a single POST would order the outputs wrongly.
   */
  const CALLS_BOTH_TOOLS = (): any[] => ([
    REASONING,
    fc('file_search', 'call_fs1', 'expense policy'),
    fc('web_search', 'call_ws', 'berlin weather'),
    fc('file_search', 'call_fs2', 'travel receipts'),
  ]);

  it('resolves web_search and file_search in ONE continuation POST', async () => {
    const { req, res } = await openTurn(false);
    mockPost.mockResolvedValue(reply('resp_2', [FINAL_MSG]));

    await hostedToolAfterHandler({
      req, res, utils, upstreamResponse: firstTurn(CALLS_BOTH_TOOLS()),
    });

    // ONE POST for the whole turn: not one per descriptor, not one per call.
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(continuationPosts()).toHaveLength(1);
    expect(utils.logger.error).not.toHaveBeenCalled();

    // Both tools really ran, each with its own arguments.
    expect(mockExecuteWebSearch.mock.calls.map(c => c[0])).toEqual(['berlin weather']);
    expect(mockSearchVectorStores.mock.calls.map((c: any[]) => c[0].query))
      .toEqual(['expense policy', 'travel receipts']);

    // Every function_call is carried forward and every one is answered, in EMISSION order.
    const input = postedInput(0);
    expect(input.filter((i: any) => i.type === 'function_call').map((i: any) => i.call_id))
      .toEqual(['call_fs1', 'call_ws', 'call_fs2']);
    const outputs = postedOutputs(0);
    expect(outputs.map((o: any) => o.call_id)).toEqual(['call_fs1', 'call_ws', 'call_fs2']);

    // Each output is rendered by its OWN descriptor. The two wire shapes are disjoint, so a
    // descriptor mix-up cannot hide behind a field that happens to line up.
    const parsed = outputs.map((o: any) => JSON.parse(o.output));
    expect(parsed[0]).toEqual({ results: [{
      file_id: 'file_handbook', filename: 'handbook.md', score: 0.87,
      attributes: { dept: 'finance' }, text: CHUNK,
    }] });
    expect(parsed[1]).toEqual({ results: [{
      title: 'Berlin forecast', url: 'https://weather.example/berlin',
      snippet: 'Mild all week', content: 'Berlin stays mild and dry through Friday.',
      date: '2026-08-01',
    }] });
    expect(parsed[2]).toEqual(parsed[0]);

    // The outputs are the LAST items: the round's own output precedes them.
    expect(input.slice(-3).map((i: any) => i.call_id)).toEqual(['call_fs1', 'call_ws', 'call_fs2']);
    // The reasoning item — and its encrypted_content — survives into the POSTed turn.
    expect(input).toContainEqual(REASONING);
  });

  it('emits one web_search_call and one file_search_call to the client, no function_calls', async () => {
    const { req, res } = await openTurn(false);
    mockPost.mockResolvedValue(reply('resp_2', [FINAL_MSG]));

    const result: any = await hostedToolAfterHandler({
      req,
      res,
      utils,
      upstreamResponse: firstTurn([
        REASONING, fc('file_search', 'call_fs', 'expense policy'), fc('web_search', 'call_ws', 'berlin weather'),
      ]),
    });

    const types = result.output.map((i: any) => i.type);
    expect(types).toContain('web_search_call');
    expect(types).toContain('file_search_call');
    expect(types).not.toContain('function_call');

    // Each synthetic item is the one its OWN descriptor renders: web_search carries
    // `action.query`, file_search carries `queries[]`. They are not interchangeable.
    expect(itemsOfType(result, 'web_search_call')).toEqual([
      { type: 'web_search_call', id: expect.stringMatching(/^ws_/), status: 'completed', action: { type: 'search', query: 'berlin weather' } },
    ]);
    expect(itemsOfType(result, 'file_search_call')).toEqual([
      { type: 'file_search_call', id: expect.stringMatching(/^fs_/), status: 'completed', queries: ['expense policy'] },
    ]);
    // Neither carries `results`: the request did not ask for them via `include`.
    expect(itemsOfType(result, 'file_search_call')[0].results).toBeUndefined();

    // The reasoning item still precedes both calls, and the model's own answer is last.
    expect(types).toEqual(['reasoning', 'file_search_call', 'web_search_call', 'message']);
  });

  it("applies each tool's OWN cap independently", async () => {
    // DIFFERENT numbers, from two unrelated config accessors, and the turn spends both
    // EXACTLY. Counted against one shared budget the fourth call is refused, `overflow`
    // blocks the continuation, and no POST happens at all.
    mockWebSearchCap = 1;
    mockFileSearchToolConfig = { ...mockFileSearchToolConfig, maxSearchesPerRequest: 3 };

    const { req, res } = await openTurn(false);
    mockPost.mockResolvedValue(reply('resp_2', [FINAL_MSG]));

    const result: any = await hostedToolAfterHandler({
      req,
      res,
      utils,
      upstreamResponse: firstTurn([
        fc('file_search', 'call_fs1', 'expense policy'),
        fc('web_search', 'call_ws', 'berlin weather'),
        fc('file_search', 'call_fs2', 'travel receipts'),
        fc('file_search', 'call_fs3', 'per diem rates'),
      ]),
    });

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(itemsOfType(result, 'web_search_call')).toHaveLength(1);
    expect(itemsOfType(result, 'file_search_call')).toHaveLength(3);
    // Not one of them was refused for budget: every call is within its OWN tool's cap.
    expect(result.output.filter((i: any) => i.status === 'failed')).toEqual([]);
    expect(mockExecuteWebSearch).toHaveBeenCalledTimes(1);
    expect(mockSearchVectorStores).toHaveBeenCalledTimes(3);
    expect(postedOutputs(0)).toHaveLength(4);
  });

  it('completes the turn when file_search fails and web_search succeeds', async () => {
    mockSearchVectorStores.mockRejectedValue(new SearchStoreNotFoundError(STORE));

    const { req, res } = await openTurn(false);
    mockPost.mockResolvedValue(reply('resp_2', [FINAL_MSG]));

    const result: any = await hostedToolAfterHandler({
      req,
      res,
      utils,
      upstreamResponse: firstTurn([
        fc('file_search', 'call_fs', 'expense policy'), fc('web_search', 'call_ws', 'berlin weather'),
      ]),
    });

    // The turn still reaches the model's own answer.
    expect(result.output.some((i: any) => i.type === 'message')).toBe(true);
    expect(itemsOfType(result, 'file_search_call')[0].status).toBe('failed');
    expect(itemsOfType(result, 'web_search_call')[0].status).toBe('completed');

    // One continuation, and it is WELL-FORMED: the failed call still gets an output, or the
    // deployment rejects the whole turn.
    expect(mockPost).toHaveBeenCalledTimes(1);
    const outputs = postedOutputs(0);
    expect(outputs.map((o: any) => o.call_id)).toEqual(['call_fs', 'call_ws']);
    // The model is told the search failed, in file_search's own error shape — and the
    // surviving tool's real results are unaffected.
    expect(JSON.parse(outputs[0].output).error.code).toBe('store_not_found');
    expect(JSON.parse(outputs[1].output).results).toHaveLength(1);
  });

  /**
   * THIS SUITE'S OWN ADDITION. `annotateItem` walks every descriptor that produced results
   * AND implements `annotateMessage`, chaining so a turn that called two tools can carry both
   * kinds of citation on one message. Only `file_search` implements the hook today, and that
   * asymmetry is the interesting half: with both descriptors registered, the mixed turn's
   * answer has to end up with file_citations and with NOTHING from `web_search` — not with
   * web_search's `url_citation` annotations, which it only ever puts on its own fallback dump
   * (an item a continued turn never emits).
   */
  it("carries file_search's citations onto the mixed turn's answer and nothing from web_search", async () => {
    const { req, res } = await openTurn(false);
    mockPost.mockResolvedValue(reply('resp_2', [FINAL_MSG]));

    const result: any = await hostedToolAfterHandler({
      req,
      res,
      utils,
      upstreamResponse: firstTurn([
        fc('file_search', 'call_fs', 'expense policy'), fc('web_search', 'call_ws', 'berlin weather'),
      ]),
    });

    const message = result.output.find((i: any) => i.type === 'message');
    const annotations = message.content[0].annotations;
    const start = ANSWER_TEXT.indexOf(CHUNK);
    expect(start).toBeGreaterThan(0);            // the needle really is inside the answer
    expect(annotations).toEqual([{
      type: 'file_citation',
      file_id: 'file_handbook',
      filename: 'handbook.md',
      // END of the span (last character), verified against a real OpenAI
      // response on 2026-08-06 — not the start, as this previously asserted.
      index: start + CHUNK.length - 1,
      start_index: start,
      end_index: start + CHUNK.length,
    }]);
    // Nothing from web_search: it has no annotateMessage hook, and its url_citations live
    // only on the result dump a continued turn never emits.
    expect(annotations.every((a: any) => a.type === 'file_citation')).toBe(true);
    // The text is untouched — annotations only.
    expect(message.content[0].text).toBe(ANSWER_TEXT);
  });
});

// ==================================================================== the streaming path

/**
 * THE FRAME-LEVEL MACHINERY WITH TWO DESCRIPTORS REGISTERED.
 *
 * The interceptor keys off `output_index` and never off the tool, so index shifting and the
 * interleaving queue are descriptor-agnostic by construction. "By construction" is an
 * argument; these two tests are the evidence. Both are mixed-tool rounds in which BOTH tools'
 * synthetic items are spliced into one stream — the shape where an index-shifting or
 * ordering bug hides, and the shape Codex CLI actually produces, since it always streams and
 * defaults `parallel_tool_calls` to true.
 */
describe('a turn calling web_search and file_search — the streaming transport', () => {
  it('shifts the continuation past BOTH tools spliced items, in index and in sequence_number', async () => {
    const { req, res } = await openTurn(true);
    mockPost.mockResolvedValue(upstreamStream(continuationAnswerFrames('resp_2')));

    // A reasoning item FIRST, so the two calls sit at non-zero indices and "shifted past the
    // reasoning item only" is distinguishable from "shifted past everything".
    const round = [REASONING, fc('file_search', 'call_fs', 'expense policy'), fc('web_search', 'call_ws', 'berlin weather')];
    const roundFrames = firstRoundFrames(round);
    for (const frame of roundFrames) res.write(sse(frame));
    await settleStream(res);

    expect(mockPost).toHaveBeenCalledTimes(1);
    const events = streamedFrames(res);

    // Both tools' raw function_call frames stayed suppressed, and each was replaced by its
    // own synthetic item at the index the suppressed call held — 1 for file, 2 for web.
    const done = events.filter(e => e.type === 'response.output_item.done');
    expect(done.map(e => ({ index: e.output_index, type: e.item.type }))).toEqual([
      { index: 0, type: 'reasoning' },
      { index: 1, type: 'file_search_call' },
      { index: 2, type: 'web_search_call' },
      { index: 3, type: 'message' },
    ]);
    expect(events.some(e => e.item?.type === 'function_call')).toBe(false);

    // THE SHIFT. The continuation numbered its own message `output_index: 0`; it reaches the
    // client at 3 — past BOTH spliced items, not just past the first one. An offset computed
    // from only one descriptor's items would land on 1 or 2 and collide with the other's.
    const answer = done[3];
    expect(answer.output_index).toBe(3);
    const splicedIndices = done.slice(1, 3).map(e => e.output_index);
    expect(splicedIndices).toEqual([1, 2]);                       // distinct, not reused
    expect(Math.min(...splicedIndices)).toBeGreaterThan(0);
    expect(answer.output_index).toBeGreaterThan(Math.max(...splicedIndices));
    // Every output_index the client is given is used by exactly one item.
    const indices = done.map(e => e.output_index);
    expect(new Set(indices).size).toBe(indices.length);

    // sequence_number stays monotonic across the whole client stream: the continuation
    // restarted at 0 and every one of its frames is shifted past the first round's highest.
    const seqs = events.map(e => e.sequence_number).filter((n: any) => typeof n === 'number');
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    const firstRoundMax = Math.max(...roundFrames.map(f => f.sequence_number));
    for (const frame of events.filter(e => e.item?.type === 'message' || e.type === 'response.completed')) {
      expect(frame.sequence_number).toBeGreaterThan(firstRoundMax);
    }

    // One response.created and one terminal frame for the whole mixed turn.
    expect(events.filter(e => e.type === 'response.created')).toHaveLength(1);
    expect(events.filter(e => e.type === 'response.completed')).toHaveLength(1);

    const terminal = terminalFrame(res);
    // Compared against the items the client was ACTUALLY announced, not against the raw
    // fixture: the answer carries file_search's citations by the time it reaches either
    // frame, and asserting the fixture here would only pin that the annotations are missing.
    expect(terminal.response.output).toEqual([
      REASONING,
      done[1].item,
      done[2].item,
      done[3].item,
    ]);
    expect(done[3].item.content[0].annotations.map((a: any) => a.type)).toEqual(['file_citation']);
    expect(done[3].item.content[0].text).toBe(ANSWER_TEXT);
    // Usage summed across both deployment calls: 10 + 5, 2 + 1. Neither round carries
    // `input_tokens_details`, so the merged cache breakdown sums to zero and `total_tokens`
    // recomputes to 18 (T10).
    expect(terminal.response.usage).toEqual({
      input_tokens: 15,
      output_tokens: 3,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      total_tokens: 18,
    });
  });

  it('splices both tools items in ARRIVAL order even when the second tool resolves first', async () => {
    // file_search is emitted FIRST and takes 30ms; web_search is emitted LAST and returns
    // immediately. Resolution order is therefore web-then-file, the opposite of arrival
    // order, and a plain assistant message arrives BETWEEN the two calls while file_search is
    // still in flight. Only the interleaving queue can put these three back in arrival order.
    mockSearchVectorStores.mockImplementation(async () => {
      await new Promise(resolve => { setTimeout(resolve, 30); });
      return { data: [HIT] };
    });

    const MID_MSG = {
      type: 'message', id: 'msg_mid', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Let me check both.', annotations: [] }],
    };

    const { req, res } = await openTurn(true);
    mockPost.mockResolvedValue(upstreamStream(continuationAnswerFrames('resp_2')));

    for (const frame of firstRoundFrames([
      fc('file_search', 'call_fs', 'expense policy'), MID_MSG, fc('web_search', 'call_ws', 'berlin weather'),
    ])) {
      res.write(sse(frame));
    }
    await settleStream(res);

    // The tools really did resolve out of order.
    expect(mockExecuteWebSearch).toHaveBeenCalledTimes(1);
    expect(mockSearchVectorStores).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledTimes(1);

    const events = streamedFrames(res);
    const done = events.filter(e => e.type === 'response.output_item.done');
    // ARRIVAL order, not resolution order — and the unrelated message keeps its place
    // BETWEEN the two calls rather than being hoisted or grouped behind them.
    expect(done.map(e => ({ index: e.output_index, type: e.item.type }))).toEqual([
      { index: 0, type: 'file_search_call' },
      { index: 1, type: 'message' },
      { index: 2, type: 'web_search_call' },
      { index: 3, type: 'message' },
    ]);
    expect(done[1].item).toEqual(MID_MSG);
    expect(done[3].item.id).toBe(FINAL_MSG.id);
    expect(done[3].item.content[0].text).toBe(ANSWER_TEXT);

    // A continued round emits no result dumps — the model's own answer is coming — so the
    // only `message` items are the model's own two.
    expect(events.filter(e => e.type === 'response.output_item.added' && e.item?.type === 'message')).toHaveLength(2);

    const terminal = terminalFrame(res);
    // The announced items, not the raw fixtures — see the twin assertion in the test above.
    expect(terminal.response.output).toEqual([
      done[0].item,
      MID_MSG,
      done[2].item,
      done[3].item,
    ]);
    expect(terminal.response.output.some((i: any) => i.type === 'function_call')).toBe(false);
    // Every item the terminal frame names really was announced by its own events.
    expect(done.map(e => e.item.id)).toEqual(terminal.response.output.map((i: any) => i.id));
  });
});
