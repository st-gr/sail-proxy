/**
 * END-TO-END STREAMING PARITY for the hosted `file_search` tool.
 *
 * Everything below is written against the bytes (or the merged response object) the CLIENT
 * actually receives, with the REAL pseudonymization layer installed underneath the REAL
 * hosted-tool layer — the production nesting. Nothing here inspects an intermediate value.
 *
 * WHAT THIS SUITE COVERS THAT NOTHING ELSE DOES:
 *
 *   1. TRANSPORT PARITY. One fixture, driven twice — once as a streaming turn, once as a
 *      blocking one — and the client-visible `output` arrays compared item for item. The
 *      two transports reach that array by completely different routes (the streaming one
 *      rebuilds it inside `writeFinalTerminal` from `clientItems` plus the last round's
 *      items; the blocking one assembles it in the after handler's loop), and nothing before
 *      this suite compared them.
 *   2. ONE `response.created`, ONE `response.completed`. A continuation is a SECOND
 *      deployment call with its own `response.created`/`.completed`; the interceptor drops
 *      the former and swallows the latter. A client that sees two of either treats the turn
 *      as finished at the first one and discards the model's real answer.
 *   3. THE QUERY ASYMMETRY, PROVEN BY HITS RATHER THAN BY SHAPE — on BOTH transports. See
 *      the corpus note below; this is the one property in the whole feature whose failure
 *      mode is silence.
 *   4. THE `include` GATE for the raw results, on both transports. OpenAI omits the field
 *      entirely unless it was asked for, and the passages are the client's own documents,
 *      so getting this wrong is either a spec divergence or a needless payload. READ THE
 *      `GATE_KEY` NOTE BELOW BEFORE CHANGING ANYTHING HERE: the token is
 *      `file_search_call.results`, named after the output item rather than after the tool,
 *      and this suite pins both that it opens the gate and that the tool-named
 *      `file_search.results` does not.
 *
 * NOT COVERED HERE, ON PURPOSE — each already pinned elsewhere, and repeating it would
 * only make this file slower to read:
 *   - mixed-tool turns, per-descriptor caps, frame-level index/sequence shifting
 *     -> test/hosted-tool-both-tools.test.ts
 *   - `file_citation` offsets against the unmasked bytes, and the six annotation sites
 *     -> test/filesearch-citations-wiring.test.ts
 *   - the masked/raw rendering split and the asymmetry at DESCRIPTOR level
 *     -> test/responses-filesearch-execute.test.ts
 *
 * ------------------------------------------------------------------------------------
 * WHY `searchVectorStores` IS MOCKED AS A CORPUS AND NOT AS A STUB
 *
 * The failure mode when the query masking is implemented backwards is ZERO HITS, NOT AN
 * EXCEPTION: a raw corpus searched for `MASKED_EMAIL_1f2e3d4c` simply matches nothing, and
 * "no passages found" is exactly what an empty store looks like. A mock that returns a
 * fixed hit list regardless of its argument would stay green through that bug — the code
 * ran, no error was thrown, and the test proved nothing.
 *
 * So the mock below is a tiny CORPUS: a document matches only when EVERY search term of the
 * query appears in it. Feed it the raw query and it returns the passage; feed it the masked
 * one and the mask token matches no document and it returns `[]` — silently, the same way
 * pgvector would. `expect(hits).toBeGreaterThan(0)` is therefore a real assertion about the
 * query that was actually issued, not about control flow.
 *
 * @see ../src/plugins/fileSearch/descriptor.ts - the asymmetry, in its own header
 * @see ../src/plugins/hostedTool/engine.ts - the interceptor and the continuation loop
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Readable } from 'stream';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));

const mockPost = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: (...a: any[]) => mockPost(...a) },
}));

// Spread the real module: the descriptor narrows on `SearchStoreNotFoundError` and friends,
// and replacing it wholesale would change what an error means. Only the entry point is
// swapped, for the corpus described in this file's header.
const searchSpy = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../src/fileSearch/search', () => {
  const actual = jest.requireActual<any>('../src/fileSearch/search');
  return { ...actual, __esModule: true, searchVectorStores: (...a: any[]) => searchSpy(...a) };
});

// `prepare()` reaches the pool directly through `assertStoresAccessible`.
const poolQuery = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../src/fileSearch/db', () => ({
  __esModule: true,
  getPool: () => ({ query: (...a: any[]) => poolQuery(...a) }),
}));

// One mock serving BOTH plugins: pseudonymization reads getConfig/getSubstitutedModel, the
// file_search descriptor reads the tool config. The two result bounds come from the real
// module so the descriptor and this mock cannot agree with each other while disagreeing
// with configService.
const mockConfig: any = { api_config: { defaultHooks: {}, model_list_changes: {} } };
const toolConfig = { enabled: true, maxSearchesPerRequest: 5, maxNumResultsDefault: 10 };
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getConfig: () => mockConfig,
    getSubstitutedModel: (_p: string, m: string) => m,
    getFileSearchToolConfig: () => toolConfig,
  },
  getConfig: () => mockConfig,
  getSubstitutedModel: (_p: string, m: string) => m,
  getFileSearchToolConfig: () => toolConfig,
  getFileSearchConfig: () => ({ embeddingDimensions: 3, hybrid: { rrfK: 60, lexicalEnabled: true, candidates: 50 } }),
  MIN_RESULTS_DEFAULT: jest.requireActual<any>('../src/services/configService').MIN_RESULTS_DEFAULT,
  MAX_RESULTS_DEFAULT: jest.requireActual<any>('../src/services/configService').MAX_RESULTS_DEFAULT,
}));

// Registration is an import-time side effect of the plugin shim, exactly as `pluginLoader`
// triggers it at boot. Neither array is otherwise referenced.
import pseudoRules = require('../src/plugins/pseudonymization/index');
import fileSearchRules = require('../src/plugins/responsesFileSearchPlugin');
import { hostedToolAfterHandler } from '../src/plugins/hostedTool/engine';

const pseudoBefore = (pseudoRules as any[]).find(r => r.strategy === 'before').handler;
const fsBefore = (fileSearchRules as any[]).find(r => r.strategy === 'before').handler;

const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };
const utils = { logger } as any;

const OWNER = 'owner@corp.example';
const STORE = 'vs_handbook';
const MASKING = { method: 'pseudonymization', entities: [{ type: 'profile-email' }] };

// ------------------------------------------------------------------------------ the corpus

/** The address that appears in the prompt AND in the model's search query — which is what
 *  makes the masked-vs-raw query observable rather than theoretical. */
const EMAIL = 'dana@handbook.com';

/** The one passage in the corpus, verbatim as it is stored: RAW. */
const CHUNK = `Reimbursement requests must be filed by ${EMAIL} within thirty calendar days of travel.`;

const DOCUMENT = {
  fileId: 'file_handbook',
  filename: 'handbook.md',
  score: 0.91,
  attributes: { dept: 'finance' },
  text: CHUNK,
};

/** The query the model emits. Both of its terms occur in the passage — but only while the
 *  address is the real one. `reimbursement MASKED_EMAIL_…` matches nothing. */
const RAW_QUERY = `reimbursement ${EMAIL}`;
const maskedQuery = (token: string): string => `reimbursement ${token}`;

/**
 * A one-document corpus with AND semantics over the query's terms — see this file's header
 * for why the mock is a corpus rather than a stub. `_` is inside the term class on purpose,
 * so a `MASKED_EMAIL_1f2e3d4c` token stays ONE term and fails the match as a whole instead
 * of being split into fragments that might coincidentally hit.
 */
function corpusSearch(opts: any): any {
  const terms = String(opts?.query ?? '').toLowerCase().match(/[a-z0-9@._+-]{4,}/g) ?? [];
  const haystack = DOCUMENT.text.toLowerCase();
  const matched = terms.length > 0 && terms.every(term => haystack.includes(term));
  return {
    object: 'vector_store.search_results.page',
    searchQuery: opts?.query,
    data: matched
      ? [{
        fileId: DOCUMENT.fileId,
        filename: DOCUMENT.filename,
        score: DOCUMENT.score,
        attributes: DOCUMENT.attributes,
        content: [{ type: 'text', text: DOCUMENT.text }],
      }]
      : [],
    hasMore: false,
    nextPage: null,
    mode: 'rrf_only',
  };
}

// ----------------------------------------------------------------------------- the fixture

const PROMPT = `What does the handbook say about expenses? ${EMAIL} filed one last week.`;
const PREFIX = 'The handbook is clear. ';
const SUFFIX = ' Ask them for the form.';

const REASONING = { type: 'reasoning', id: 'rs_1', encrypted_content: 'gAAAAAopaque==', summary: [] };

/** The model's answer, quoting the retrieved passage verbatim. In the deployment's own
 *  rendering it quotes the MASKED passage, because that is what it was shown. */
const answerText = (address: string): string => `${PREFIX}${CHUNK.replace(EMAIL, address)}${SUFFIX}`;
const answerItem = (address: string): any => ({
  id: 'msg_model', type: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: answerText(address), annotations: [] }],
});

const callItem = (args: string): any => ({
  type: 'function_call', id: 'fc_1', call_id: 'call_fs', name: 'file_search', arguments: args,
});

const UPSTREAM = (stream: boolean): any => ({
  url: 'https://sap.example/d1/responses',
  headers: { Authorization: 'Bearer t' },
  timeoutMs: 5000,
  payload: { model: 'gpt-5.3-codex--deployed', input: 'x', stream },
});

// ----------------------------------------------------------------------------- the harness

const sse = (o: any): string => `data: ${JSON.stringify(o)}\n\n`;
const streamOf = (frames: any[]): any => ({ data: Readable.from(frames.map(sse)) });

function mockRes(): any {
  const written: string[] = [];
  return {
    written,
    write(chunk: any) { written.push(String(chunk)); return true; },
    end(chunk?: any) { if (chunk) written.push(String(chunk)); return this; },
    status() { return this; },
    json() { return this; },
    setHeader() { /* no-op */ },
    headersSent: false,
    writableEnded: false,
  };
}

/** Every `data:` payload in the bytes the client received, parsed, in order. */
function frames(res: any): any[] {
  return res.written.join('')
    .split('\n\n')
    .map((b: string) => b.trim())
    .filter((b: string) => b.length > 0)
    .map((b: string) => b.split('\n').find((l: string) => l.startsWith('data: ')))
    .filter((l: any): l is string => typeof l === 'string')
    .map((l: string) => JSON.parse(l.slice(6)));
}

/** The turn's last terminal frame. */
function terminalFrame(res: any): any {
  return frames(res).filter(f => f.type === 'response.completed').pop();
}

/** Poll until the client's terminal frame is on the wire, then a beat for any straggler. */
async function settle(res: any, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => { setTimeout(resolve, 2); });
    if (frames(res).some(f => f.type === 'response.completed')) break;
  }
  await new Promise(resolve => { setTimeout(resolve, 20); });
}

/**
 * THE TOKEN THAT OPENS THE RAW-RESULTS GATE — OpenAI's own, and now the gateway's.
 *
 * `file_search_call.results` is named after the OUTPUT ITEM (`file_search_call`), not after
 * the tool, which is also what this feature's spec and `fileSearch/descriptor.ts`'s doc
 * comments say (`renderCallItem`'s: "`results` only under
 * `include: ["file_search_call.results"]`, matching OpenAI").
 *
 * Task 11 found the gateway keying the gate on `` `${descriptor.type}.results` `` instead —
 * `file_search.results`, a token no client sends — and pinned both halves rather than
 * changing `web_search`'s observable surface inside a test-only task. Task 12 fixed
 * `renderOptsFor` (one `_call` in the template literal, which corrects `web_search`
 * identically) and deleted the divergence test that asserted the bug. The two constants stay
 * distinct so that reverting the fix fails the NAMED test below rather than four unrelated
 * ones: `GATE_KEY` is the token the gateway must honour, `NOT_THE_GATE_KEY` is the old
 * tool-named token that must now be ignored like any other unrelated `include` entry.
 */
const GATE_KEY = 'file_search_call.results';
const NOT_THE_GATE_KEY = 'file_search.results';

interface TurnOpts { include?: string[]; masking?: boolean }

/**
 * Open a turn through the REAL pseudonymization before handler and the REAL file_search
 * before handler, in that order — the production hook order, which is also what installs
 * the two res.write interceptors in the production nesting (pseudonymization innermost).
 */
async function openTurn(stream: boolean, opts: TurnOpts = {}): Promise<{ req: any; res: any; token: string }> {
  const res = mockRes();
  const req: any = {
    headers: {},
    apiKeyInfo: { email: OWNER },
    body: {
      model: 'gpt-5.3-codex--deployed',
      stream,
      input: PROMPT,
      tools: [{ type: 'file_search', vector_store_ids: [STORE] }],
      ...(opts.include ? { include: opts.include } : {}),
      ...(opts.masking === false ? {} : { masking: MASKING }),
    },
    __responsesUpstream: UPSTREAM(stream),
    __responsesExtraUsage: { input_tokens: 0, output_tokens: 0 },
  };

  await pseudoBefore({ req, res, utils });
  await fsBefore({ req, res, utils });

  const token = req.__pseudonymizationMap?.forward?.get(EMAIL);
  return { req, res, token };
}

/**
 * The deployment's first STREAMING round, numbered the way responsesController writes it:
 * an `output_item.added`/`.done` pair per item at ascending `output_index`, with a
 * monotonically increasing `sequence_number` across the round.
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
 * The continuation round in which the model finally answers. Its `output_index` restarts at
 * 0 and so do its `sequence_number`s, exactly as a fresh deployment call numbers them.
 */
function continuationFrames(address: string): any[] {
  const item = answerItem(address);
  const text = item.content[0].text;
  return [
    { type: 'response.created', sequence_number: 0, response: { id: 'resp_2' } },
    { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', sequence_number: 2, output_index: 0, content_index: 0, item_id: 'msg_model', delta: text },
    { type: 'response.output_text.done', sequence_number: 3, output_index: 0, content_index: 0, item_id: 'msg_model', text },
    { type: 'response.output_item.done', sequence_number: 4, output_index: 0, item },
    {
      type: 'response.completed', sequence_number: 5,
      response: { id: 'resp_2', status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 7 } },
    },
  ];
}

/**
 * Drive a whole STREAMING turn and return the client's terminal frame plus every frame.
 *
 * The model's query arrives MASKED here — the interceptor sits behind pseudonymization's
 * res.write and reads bytes still in flight — which is the production shape and the input
 * the descriptor's unmasking branch exists for.
 */
async function runStreamingTurn(opts: TurnOpts = {}): Promise<{ req: any; res: any; output: any[]; events: any[] }> {
  const { req, res, token } = await openTurn(true, opts);
  const address = opts.masking === false ? EMAIL : token;
  mockPost.mockResolvedValueOnce(streamOf(continuationFrames(address)));

  for (const frame of firstRoundFrames([REASONING, callItem(JSON.stringify({ query: maskedQuery(address) }))])) {
    res.write(sse(frame));
  }
  await settle(res);

  const terminal = terminalFrame(res);
  return { req, res, output: terminal?.response?.output ?? [], events: frames(res) };
}

/**
 * Drive the same turn on the NON-STREAMING transport.
 *
 * The first response is handed over ALREADY UNMASKED, because on this path
 * pseudonymizationPlugin's after handler (hook index 0) has run before the engine sees it —
 * so the model's query reaches the descriptor raw. The CONTINUATION response is handed over
 * masked, exactly as the deployment produces it: the engine's own `unmaskResponsesOutput` is
 * what unmasks that one.
 */
async function runNonStreamingTurn(opts: TurnOpts = {}): Promise<{ req: any; output: any[]; merged: any }> {
  const { req, token } = await openTurn(false, opts);
  const address = opts.masking === false ? EMAIL : token;
  mockPost.mockResolvedValueOnce({
    data: { id: 'resp_2', status: 'completed', output: [answerItem(address)], usage: { input_tokens: 5, output_tokens: 7 } },
  });

  const merged = await hostedToolAfterHandler({
    req,
    res: mockRes(),
    utils,
    upstreamResponse: {
      id: 'resp_1',
      status: 'completed',
      output: [REASONING, callItem(JSON.stringify({ query: RAW_QUERY }))],
      usage: { input_tokens: 10, output_tokens: 2 },
    },
  } as any);

  return { req, merged, output: merged?.output ?? [] };
}

/** The `file_search_call` item in a client-visible output array. */
function findCallItem(output: any[]): any {
  return (output || []).find((i: any) => i?.type === 'file_search_call');
}

/** How many passages the CLIENT was actually given for this turn. Only meaningful under the
 *  raw-results `include` gate, which every hits assertion below requests — see `GATE_KEY`. */
function hitCountOf(output: any[]): number {
  const results = findCallItem(output)?.results;
  return Array.isArray(results) ? results.length : 0;
}

/**
 * Ids minted by `syntheticId` (`<prefix>_<base36 time><base36 counter>`) differ between two
 * runs of the same turn by construction. Everything else — the fixture's own short ids
 * (`rs_1`, `msg_model`), every field of every item — is compared verbatim.
 */
function normalizeIds(value: any): any {
  return JSON.parse(JSON.stringify(value), (key, v) => (
    key === 'id' && typeof v === 'string' ? v.replace(/^([a-z]+)_[0-9a-z]{7,}$/, '$1_#') : v
  ));
}

/** Every `function_call_output` in the n-th continuation POST. */
function postedOutputs(n: number): any[] {
  return ((mockPost.mock.calls[n] as any[])[1].input as any[]).filter((i: any) => i.type === 'function_call_output');
}

beforeEach(() => {
  jest.clearAllMocks();
  poolQuery.mockResolvedValue({ rows: [{ id: STORE, status: 'completed', embedding_dim: 3 }] });
  searchSpy.mockImplementation(async (opts: any) => corpusSearch(opts));
});

// ==================================================================== the fixture is honest

describe('the corpus fixture', () => {
  it('returns the passage for the RAW query and nothing at all for the masked one', async () => {
    // The premise of every hits assertion below. If this ever stops holding — a term class
    // that splits the mask token, a passage edited to contain the word "masked" — those
    // assertions would pass whether or not the descriptor unmasked anything.
    expect(corpusSearch({ query: RAW_QUERY }).data).toHaveLength(1);
    expect(corpusSearch({ query: maskedQuery('MASKED_EMAIL_1f2e3d4c') }).data).toHaveLength(0);
    // ...and it fails SILENTLY, which is the whole reason this suite asserts on hit counts.
    expect(() => corpusSearch({ query: maskedQuery('MASKED_EMAIL_1f2e3d4c') })).not.toThrow();
  });
});

// ============================================================================ real hits, PII

describe('a PII-bearing query reaches the corpus unmasked', () => {
  it('returns real hits with PII in the query on the STREAMING path', async () => {
    // The failure mode is ZERO HITS, not an exception. Asserting the code ran proves
    // nothing — these assertions are that documents actually came back.
    const { output } = await runStreamingTurn({ include: [GATE_KEY] });

    const call = findCallItem(output);
    expect(call).toBeDefined();
    expect(call.status).toBe('completed');
    expect(call.queries[0]).not.toMatch(/MASKED_/);
    expect(call.queries[0]).toBe(RAW_QUERY);

    expect(hitCountOf(output)).toBeGreaterThan(0);
    // The passages the client gets are RAW: these are its own documents.
    expect(call.results[0].text).toBe(CHUNK);
    expect(call.results[0].file_id).toBe(DOCUMENT.fileId);

    // The search really was issued with the raw address, not merely reported that way.
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect((searchSpy.mock.calls[0] as any[])[0].query).toBe(RAW_QUERY);

    // And the deployment was told about the passage in its MASKED rendering — the split
    // that makes searching raw safe in the first place.
    const forDeployment = JSON.parse(postedOutputs(0)[0].output);
    expect(forDeployment.results).toHaveLength(1);
    expect(forDeployment.results[0].text).not.toContain(EMAIL);
    expect(forDeployment.results[0].text).toMatch(/MASKED_EMAIL_/);
  });

  it('returns real hits with PII in the query on the NON-STREAMING path', async () => {
    const { output } = await runNonStreamingTurn({ include: [GATE_KEY] });

    const call = findCallItem(output);
    expect(call).toBeDefined();
    expect(call.queries[0]).toBe(RAW_QUERY);
    expect(call.queries[0]).not.toMatch(/MASKED_/);

    expect(hitCountOf(output)).toBeGreaterThan(0);
    expect(call.results[0].text).toBe(CHUNK);

    // On this transport the query arrives raw and must be used AS-IS. Re-masking it here —
    // the one thing the descriptor's header tells you not to do — searches for a token that
    // appears in no document and yields the same silent zero.
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect((searchSpy.mock.calls[0] as any[])[0].query).toBe(RAW_QUERY);

    const forDeployment = JSON.parse(postedOutputs(0)[0].output);
    expect(forDeployment.results).toHaveLength(1);
    expect(forDeployment.results[0].text).toMatch(/MASKED_EMAIL_/);
  });
});

// ================================================================================== parity

describe('streaming and non-streaming produce the same client-visible turn', () => {
  it('produces identical client-visible output for the same turn', async () => {
    // ONE fixture, driven twice. The two transports build this array by entirely different
    // routes — `writeFinalTerminal` rebuilds it from `clientItems` plus the last round's
    // items, while the after handler assembles it in its continuation loop — and a drift
    // between them is invisible to every per-transport suite.
    const streamed = await runStreamingTurn({ include: [GATE_KEY] });
    const blocking = await runNonStreamingTurn({ include: [GATE_KEY] });

    expect(normalizeIds(streamed.output)).toEqual(normalizeIds(blocking.output));

    // Not vacuously equal: both really are the whole turn.
    expect(streamed.output.map((i: any) => i.type)).toEqual(['reasoning', 'file_search_call', 'message']);
    expect(hitCountOf(streamed.output)).toBeGreaterThan(0);
    expect(hitCountOf(blocking.output)).toBeGreaterThan(0);
    // The reasoning item and its encrypted_content survive on both.
    expect(streamed.output[0]).toEqual(REASONING);
    expect(blocking.output[0]).toEqual(REASONING);
    // No raw function_call on either.
    expect(streamed.output.some((i: any) => i.type === 'function_call')).toBe(false);
    expect(blocking.output.some((i: any) => i.type === 'function_call')).toBe(false);
  });

  it('gives the client the same unmasked answer text and the same citations on both', async () => {
    const streamed = await runStreamingTurn();
    const blocking = await runNonStreamingTurn();

    const streamedMsg = streamed.output.find((i: any) => i.type === 'message');
    const blockingMsg = blocking.output.find((i: any) => i.type === 'message');

    // Unmasked on both — the streaming path gets there through pseudonymization's res.write,
    // the blocking one through the engine's own `unmaskResponsesOutput`.
    expect(streamedMsg.content[0].text).toBe(answerText(EMAIL));
    expect(blockingMsg.content[0].text).toBe(answerText(EMAIL));
    expect(JSON.stringify(streamed.output)).not.toContain('MASKED_');

    // The offsets are computed against two different strings (masked on one path, unmasked
    // on the other) and still have to land on the same words.
    const a = streamedMsg.content[0].annotations;
    const b = blockingMsg.content[0].annotations;
    expect(a).toEqual(b);
    expect(a).toHaveLength(1);
    expect(streamedMsg.content[0].text.slice(a[0].start_index, a[0].end_index)).toBe(CHUNK);
  });

  it('sums usage across both deployment calls on both transports', async () => {
    // Neither round carries `input_tokens_details`, so the merged cache breakdown sums to
    // zero on both fields and `total_tokens` recomputes to 24 (T10).
    const expectedUsage = {
      input_tokens: 15,
      output_tokens: 9,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      total_tokens: 24,
    };
    const { res } = await runStreamingTurn();
    expect(terminalFrame(res).response.usage).toEqual(expectedUsage);

    const { merged } = await runNonStreamingTurn();
    expect(merged.usage).toEqual(expectedUsage);
  });
});

// =========================================================== exactly one open, one close

describe('the streaming turn opens once and closes once', () => {
  it('emits exactly one response.created and one response.completed', async () => {
    const { events } = await runStreamingTurn();

    // The continuation is a SECOND deployment call carrying its own pair. A client that
    // sees two `response.completed` frames treats the turn as over at the first one and
    // throws the model's real answer away.
    expect(events.filter(e => e.type === 'response.created')).toHaveLength(1);
    expect(events.filter(e => e.type === 'response.completed')).toHaveLength(1);
    expect(events.filter(e => e.type === 'response.in_progress')).toHaveLength(1);

    // Two deployment calls really did happen — otherwise this passes for the wrong reason.
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(events.some(e => e.type === 'response.output_text.done')).toBe(true);

    // The terminal frame is genuinely LAST: nothing follows the client's close.
    const all = events;
    expect(all[all.length - 1].type).toBe('response.completed');
    expect(all[0].type).toBe('response.created');
  });

  it('never lets a raw function_call frame reach the client', async () => {
    const { events } = await runStreamingTurn();
    expect(events.some(e => e.item?.type === 'function_call')).toBe(false);
    expect(events.some(e => e.type === 'response.function_call_arguments.done')).toBe(false);
    // Its replacement is announced with its own pair of item events.
    const done = events.filter(e => e.type === 'response.output_item.done');
    expect(done.map(e => e.item.type)).toEqual(['reasoning', 'file_search_call', 'message']);
  });
});

// ================================================================== the `include` gate

describe('the raw-results include gate', () => {
  it('omits results entirely when include was NOT requested — streaming', async () => {
    const { output } = await runStreamingTurn();
    const call = findCallItem(output);
    expect(call).toBeDefined();
    // OpenAI omits the field, rather than sending an empty array.
    expect(call.results).toBeUndefined();
    expect(Object.keys(call)).toEqual(['id', 'type', 'status', 'queries']);
    // The tool really did find something — this is a rendering decision, not an empty search.
    expect((searchSpy.mock.calls[0] as any[])[0].query).toBe(RAW_QUERY);
    expect(JSON.parse(postedOutputs(0)[0].output).results).toHaveLength(1);
  });

  it('omits results entirely when include was NOT requested — non-streaming', async () => {
    const { output } = await runNonStreamingTurn();
    const call = findCallItem(output);
    expect(call).toBeDefined();
    expect(call.results).toBeUndefined();
    expect(Object.keys(call)).toEqual(['id', 'type', 'status', 'queries']);
    expect(JSON.parse(postedOutputs(0)[0].output).results).toHaveLength(1);
  });

  it('includes the raw passages when include WAS requested — streaming', async () => {
    const { output } = await runStreamingTurn({ include: [GATE_KEY] });
    const call = findCallItem(output);
    expect(Array.isArray(call.results)).toBe(true);
    expect(call.results.length).toBeGreaterThan(0);
    expect(call.results[0]).toEqual({
      file_id: DOCUMENT.fileId,
      filename: DOCUMENT.filename,
      score: DOCUMENT.score,
      attributes: DOCUMENT.attributes,
      text: CHUNK,
    });
  });

  it('includes the raw passages when include WAS requested — non-streaming', async () => {
    const { output } = await runNonStreamingTurn({ include: [GATE_KEY] });
    const call = findCallItem(output);
    expect(Array.isArray(call.results)).toBe(true);
    expect(call.results.length).toBeGreaterThan(0);
    expect(call.results[0].text).toBe(CHUNK);
  });

  it('ignores an unrelated include entry', async () => {
    // `include` is matched per descriptor, so another tool's entry — or a message-level one
    // a client sends for its own reasons — must not open this gate.
    const { output } = await runStreamingTurn({ include: ['reasoning.encrypted_content', 'message.output_text.logprobs'] });
    expect(findCallItem(output).results).toBeUndefined();
  });

  /**
   * THE REGRESSION GUARD for the fix described in the `GATE_KEY` note above. Reverting
   * `renderOptsFor` to `` `${descriptor.type}.results` `` swaps which of these two tokens
   * works, so BOTH halves are asserted here, on BOTH transports: the documented token must
   * open the gate, and the old tool-named token must not. Either half alone would still pass
   * under the reverted code with the other constant substituted.
   */
  it('opens on OpenAI\'s documented file_search_call.results and NOT on the tool-named file_search.results', async () => {
    expect(NOT_THE_GATE_KEY).not.toBe(GATE_KEY);

    // The old, tool-named token is now just another unrelated include entry.
    const streamedOld = await runStreamingTurn({ include: [NOT_THE_GATE_KEY] });
    expect(findCallItem(streamedOld.output).results).toBeUndefined();

    const blockingOld = await runNonStreamingTurn({ include: [NOT_THE_GATE_KEY] });
    expect(findCallItem(blockingOld.output).results).toBeUndefined();

    // ...and the token OpenAI documents does open it, with real passages behind it — so the
    // assertions above are the gate staying shut, not an empty search on both sides.
    const streamedNew = await runStreamingTurn({ include: [GATE_KEY] });
    expect(hitCountOf(streamedNew.output)).toBeGreaterThan(0);

    const blockingNew = await runNonStreamingTurn({ include: [GATE_KEY] });
    expect(hitCountOf(blockingNew.output)).toBeGreaterThan(0);
  });
});


/**
 * The file_search_call lifecycle frames, pinned against a REAL OpenAI stream
 * captured 2026-08-06 (docs/notes/openai-parity-capture-2026-08-06.md):
 *
 *   seq 2  output_index 0  response.output_item.added        item.type=file_search_call
 *   seq 3  output_index 0  response.file_search_call.in_progress
 *   seq 4  output_index 0  response.file_search_call.searching
 *   seq 5  output_index 0  response.file_search_call.completed
 *   seq 6  output_index 0  response.output_item.done         item.type=file_search_call
 *
 * A client driving a progress indicator off the tool lifecycle saw nothing from
 * us before this.
 */
describe('file_search_call lifecycle frames', () => {
  it('emits in_progress, searching and completed BETWEEN the call item added and done, at its output_index', async () => {
    const { events: all } = await runStreamingTurn();

    const idx = (t: string): number => all.findIndex((f) => f.type === t);
    const added = idx('response.output_item.added');
    const inProg = idx('response.file_search_call.in_progress');
    const searching = idx('response.file_search_call.searching');
    const completed = idx('response.file_search_call.completed');
    const doneIdx = all.findIndex(
      (f) => f.type === 'response.output_item.done' && f.item?.type === 'file_search_call',
    );

    expect(inProg).toBeGreaterThan(added);
    expect(searching).toBeGreaterThan(inProg);
    expect(completed).toBeGreaterThan(searching);
    expect(doneIdx).toBeGreaterThan(completed);

    // Same output_index as the call item they describe, and carrying its id —
    // both are how a client correlates them to the item.
    const callItem = all[doneIdx];
    for (const t of ['in_progress', 'searching', 'completed']) {
      const f = all.find((x) => x.type === `response.file_search_call.${t}`);
      expect(f.output_index).toBe(callItem.output_index);
      expect(f.item_id).toBe(callItem.item.id);
    }
  });

  it('emits exactly one of each, however many rounds the turn takes', async () => {
    const { events: all } = await runStreamingTurn();
    for (const t of ['in_progress', 'searching', 'completed']) {
      expect(all.filter((f) => f.type === `response.file_search_call.${t}`)).toHaveLength(1);
    }
  });
});
