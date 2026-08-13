/**
 * WHEN, IN THE STREAM, A `file_citation` IS ALLOWED TO APPEAR.
 *
 * `docs/developer/chapter-16-file-search-tool.md` makes a specific, client-visible promise
 * about ordering:
 *
 *   "Annotations arrive AFTER `response.output_text.done`, not interleaved before it. OpenAI
 *    emits `response.output_text.annotation.added` frames as the text streams. The gateway
 *    cannot: an annotation is a pair of offsets into the complete message, and the gateway
 *    only learns the complete text at `.done`. So the annotations appear on the
 *    `response.output_item.done` frame and inside the terminal `response.completed` — both of
 *    which carry the finished item — and NEVER ON A DELTA."
 *
 * Nothing asserted it. That matters more than an ordering nit usually would, because the
 * failure it guards against is not a crash: a citation attached to a delta would carry
 * offsets into a PARTIAL string, so a client rendering incrementally would underline the
 * wrong words (or a range past the end of the text it has) and nothing anywhere would throw.
 * The divergence is also the reason a client must render citations from the final item; a
 * document that claims the ordering while the code drifts from it is worse than no document.
 *
 * So this suite asserts the claim as three separate, independently-failing properties:
 *
 *   1. NO frame the client receives carries a `file_citation` at any point BEFORE the
 *      `response.output_text.done` for that message.
 *   2. No `response.output_text.delta` (and no `content_part.added`) ever carries a non-empty
 *      `annotations` array.
 *   3. The gateway emits NO `response.output_text.annotation.added` frames at all — the
 *      OpenAI mechanism chapter 16 says it cannot implement.
 *
 * ...and pairs them with the assertion that makes them non-vacuous: the citation really is
 * there, on `output_item.done` and in the terminal frame. Without that, a build producing
 * zero annotations would sail through all three.
 *
 * The real pseudonymization SSE interceptor sits underneath the real hosted-tool one, as in
 * production, so these are the bytes the client actually receives.
 *
 * @see ./filesearch-citations-wiring.test.ts - WHAT the annotation contains, and its offsets
 * @see ../src/plugins/hostedTool/engine.ts - the annotation sites
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

const searchSpy = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../src/fileSearch/search', () => {
  const actual = jest.requireActual<any>('../src/fileSearch/search');
  return { ...actual, __esModule: true, searchVectorStores: (...args: any[]) => searchSpy(...args) };
});

const poolQuery = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../src/fileSearch/db', () => ({
  __esModule: true,
  getPool: () => ({ query: (...a: any[]) => poolQuery(...a) }),
}));

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

// Registration is an import-time side effect of the plugin shims, exactly as `pluginLoader`
// triggers it at boot.
import pseudoRules = require('../src/plugins/pseudonymization/index');
import fileSearchRules = require('../src/plugins/responsesFileSearchPlugin');
import { SearchHit } from '../src/fileSearch/search';

const pseudoBefore = (pseudoRules as any[]).find(r => r.strategy === 'before').handler;
const fsBefore = (fileSearchRules as any[]).find(r => r.strategy === 'before').handler;

const utils = { logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() } } as any;

const OWNER = 'owner@corp.example';
const EMAIL = 'dana@handbook.com';
const MASKING = { method: 'pseudonymization', entities: [{ type: 'profile-email' }] };

/** The chunk as it sits in the corpus: RAW. The citation anchors on this. */
const RAW_CHUNK = `Reimbursement requests must be filed by ${EMAIL} within thirty days of travel.`;
const PREFIX = 'The handbook is clear. ';
const SUFFIX = ' Ask them for the form.';
const PROMPT = `What does the handbook say about expenses? Ask ${EMAIL} if unsure.`;

const UPSTREAM = {
  url: 'https://sap.example/d1/responses',
  headers: { Authorization: 'Bearer t' },
  timeoutMs: 5000,
  payload: { model: 'gpt-5.3-codex--deployed', input: 'x', stream: true },
};

const sse = (o: any): string => `data: ${JSON.stringify(o)}\n\n`;
const streamOf = (f: any[]): any => ({ data: Readable.from(f.map(sse)) });
const settle = (): Promise<unknown> => new Promise(r => { setTimeout(r, 0); });
const settleAll = (): Promise<unknown> => new Promise(r => { setTimeout(r, 30); });

function mockRes(): any {
  const written: string[] = [];
  return {
    written,
    write(chunk: any) { written.push(String(chunk)); return true; },
    end(chunk?: any) { if (chunk) written.push(String(chunk)); return this; },
    setHeader() { /* no-op */ },
    headersSent: false,
    writableEnded: false,
  };
}

/** Every `data:` payload the client received, parsed, IN WIRE ORDER — which is the only
 *  thing this suite is about. */
function frames(written: string[]): any[] {
  return written.join('')
    .split('\n\n')
    .map(b => b.trim())
    .filter(b => b.length > 0)
    .map(b => b.split('\n').find(l => l.startsWith('data: ')))
    .filter((l): l is string => typeof l === 'string')
    .map(l => JSON.parse(l.slice(6)));
}

function hit(text: string): SearchHit {
  return {
    fileId: 'file_handbook',
    filename: 'handbook.md',
    score: 0.91,
    attributes: {},
    content: [{ type: 'text', text }],
  };
}

/**
 * Install pseudonymization's SSE unmask interceptor, then the hosted-tool one — the
 * production nesting. `res.written` is therefore what the client receives.
 */
async function openTurn(): Promise<{ req: any; res: any; token: string }> {
  const res = mockRes();
  const req: any = {
    headers: {},
    apiKeyInfo: { email: OWNER },
    body: {
      model: 'gpt-5.3-codex--deployed',
      stream: true,
      input: PROMPT,
      tools: [{ type: 'file_search', vector_store_ids: ['vs_1'] }],
      masking: MASKING,
    },
    __responsesUpstream: UPSTREAM,
  };

  await pseudoBefore({ req, res, utils });
  await fsBefore({ req, res, utils });

  const token = req.__pseudonymizationMap.forward.get(EMAIL);
  expect(typeof token).toBe('string');       // the fixture is worthless without it
  return { req, res, token };
}

/**
 * The continuation round in which the model answers, QUOTING the passage verbatim (in the
 * masked rendering it was shown) so that an annotation genuinely anchors. The text is
 * streamed as SEVERAL deltas, because a single-delta round could not distinguish "no
 * annotation on a delta" from "no delta worth annotating".
 */
function answerRound(token: string): any[] {
  const text = `${PREFIX}${RAW_CHUNK.replace(EMAIL, token)}${SUFFIX}`;
  const item = {
    id: 'msg_model', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  const cut = Math.floor(text.length / 2);
  return [
    { type: 'response.created', response: { id: 'resp_2' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    {
      type: 'response.content_part.added',
      output_index: 0, content_index: 0, item_id: 'msg_model',
      part: { type: 'output_text', text: '', annotations: [] },
    },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_model', delta: text.slice(0, cut) },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_model', delta: text.slice(cut) },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: 'msg_model', text },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: { id: 'resp_2', status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 7 } },
    },
  ];
}

/** Drive the first (upstream) round: one file_search call, then its terminal frame. */
async function driveFirstRound(res: any): Promise<void> {
  const call = {
    type: 'function_call', id: 'fc_1', call_id: 'call_fs', name: 'file_search',
    arguments: '{"query":"expense reimbursement"}',
  };
  res.write(sse({ type: 'response.created', response: { id: 'resp_1' } }));
  res.write(sse({ type: 'response.output_item.added', output_index: 0, item: call }));
  res.write(sse({ type: 'response.output_item.done', output_index: 0, item: call }));
  await settle();
  res.write(sse({
    type: 'response.completed',
    response: { id: 'resp_1', status: 'completed', output: [call], usage: { input_tokens: 11, output_tokens: 3 } },
  }));
  await settleAll();
}

/** Run a whole streaming turn and hand back the client's frames, in order. */
async function runTurn(): Promise<any[]> {
  const { res, token } = await openTurn();
  mockPost.mockResolvedValueOnce(streamOf(answerRound(token)));
  await driveFirstRound(res);
  return frames(res.written);
}

const citationsOn = (frame: any): number => JSON.stringify(frame ?? null).split('"file_citation"').length - 1;

describe('when a file_citation is allowed to appear in the stream (chapter 16\'s ordering claim)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    poolQuery.mockResolvedValue({ rows: [{ id: 'vs_1', status: 'completed', embedding_dim: 3 }] });
    searchSpy.mockResolvedValue({ data: [hit(RAW_CHUNK)] });
  });

  it('carries the citation on output_item.done and in the terminal frame — the premise of every assertion below', async () => {
    const all = await runTurn();

    const done = all.find(f => f.type === 'response.output_item.done' && f.item?.id === 'msg_model');
    expect(done).toBeDefined();
    expect(done.item.content[0].annotations).toHaveLength(1);
    expect(done.item.content[0].annotations[0].type).toBe('file_citation');

    const terminal = all.filter(f => f.type === 'response.completed').pop();
    const message = terminal.response.output.find((i: any) => i?.id === 'msg_model');
    expect(message.content[0].annotations).toHaveLength(1);
    expect(message.content[0].annotations[0].type).toBe('file_citation');
  });

  it('emits NO file_citation anywhere before the output_text.done for that message', async () => {
    const all = await runTurn();

    const doneAt = all.findIndex(f => f.type === 'response.output_text.done' && f.item_id === 'msg_model');
    expect(doneAt).toBeGreaterThan(-1);

    // THE assertion. An annotation is a pair of offsets into the COMPLETE message; the
    // gateway does not know that string until `.done`, so anything it emitted earlier would
    // be indexing a partial string — silently wrong, never an error.
    const early = all.slice(0, doneAt + 1).filter(f => citationsOn(f) > 0);
    expect(early.map(f => f.type)).toEqual([]);

    // ...and it really did appear afterwards, so the slice above is not just an empty stream.
    expect(all.slice(doneAt + 1).some(f => citationsOn(f) > 0)).toBe(true);
  });

  it('never puts a non-empty annotations array on a delta or on a content_part.added', async () => {
    const all = await runTurn();

    const deltas = all.filter(f => f.type === 'response.output_text.delta');
    // The fixture streams the answer in more than one piece on purpose — a
    // single-delta round would make this pass for the wrong reason.
    expect(deltas.length).toBeGreaterThan(1);
    for (const delta of deltas) {
      expect(citationsOn(delta)).toBe(0);
      expect(delta.annotations ?? []).toEqual([]);
      expect(delta.part?.annotations ?? []).toEqual([]);
    }

    for (const part of all.filter(f => f.type === 'response.content_part.added')) {
      expect(citationsOn(part)).toBe(0);
      expect(part.part?.annotations ?? []).toEqual([]);
    }
  });

  it('emits no response.output_text.annotation.added frames at all — the OpenAI mechanism the gateway cannot implement', async () => {
    const all = await runTurn();

    // Chapter 16 documents this as a deliberate ordering divergence rather than an omission.
    // If these frames ever start being emitted, the chapter is wrong and a client that trusts
    // it will render citations twice.
    expect(all.filter(f => f.type === 'response.output_text.annotation.added')).toEqual([]);
    expect(all.some(f => String(f.type).includes('annotation'))).toBe(false);

    // Non-vacuous: the turn really did produce a citation, on the finished item.
    const done = all.find(f => f.type === 'response.output_item.done' && f.item?.id === 'msg_model');
    expect(done.item.content[0].annotations).toHaveLength(1);
  });
});
