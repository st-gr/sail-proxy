/**
 * The streaming Anthropic path must run the search and emit the golden blocks.
 *
 * Before this task it forwarded the rewritten tool_use straight to the client:
 * 14 frames against the golden's 76, one `tool_use` block where the golden has
 * server_tool_use + web_search_tool_result + text, and no search count. Claude
 * Code always streams, so this is the path that matters.
 *
 * axios is mocked: no deployment is called and no search leaves the process.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { EventEmitter } from 'events';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

const searchCalls: string[] = [];
let searchQueue: any[][] = [];
jest.mock('../src/plugins/webSearch/searchExecutor', () => ({
  __esModule: true,
  executeWebSearch: jest.fn(async (query: string) => {
    searchCalls.push(query);
    if (searchQueue.length > 0) return searchQueue.shift();
    // Every field `SearchResult` declares. `content` above all: it is required,
    // and `buildResponseWithSearchResults` on the sibling non-streaming path does
    // an unguarded `Buffer.from(result.content)` — a mock that omits it throws
    // inside a catch block and yields a test that passes against broken code.
    return [{
      title: 'Zig Downloads',
      url: 'https://ziglang.org/download/',
      snippet: 'Zig 0.16.0 is current',
      content: 'Zig 0.16.0 is the current release, published in 2026.',
      date: 'February 13, 2026',
    }];
  }),
}));

/** The continuation turn the deployment returns once it has the results. */
const CONTINUATION_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","type":"message","role":"assistant","content":[],"usage":{"input_tokens":40,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Zig 0.16.0."}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":40,"output_tokens":9}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join('');

const postBodies: any[] = [];
let postResponses: string[] = [];
/**
 * When set, the model keeps asking for another search and only writes an answer
 * once it has been HANDED a tool_result that is not search results — i.e. once
 * the cap has told it the budget is spent. That is the behaviour the fix depends
 * on, so the fixture makes the answer conditional on the message actually being
 * sent rather than handing it over unprompted.
 */
let answerOnlyWhenBudgetSpent = false;

/** True when the last message's tool_results are prose, not a `{"results":[…]}` payload. */
function toldBudgetIsSpent(body: any): boolean {
  const last = body?.messages?.[body.messages.length - 1];
  const blocks = Array.isArray(last?.content) ? last.content : [];
  return blocks.length > 0
    && blocks.every((b: any) => b?.type === 'tool_result' && !String(b.content).includes('"results"'));
}

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: jest.fn(async (_url: string, body: any) => {
      postBodies.push(body);
      if (answerOnlyWhenBudgetSpent && toldBudgetIsSpent(body)) {
        const answering: any = new EventEmitter();
        answering.destroy = () => {};
        setImmediate(() => {
          answering.emit('data', Buffer.from(CONTINUATION_SSE));
          answering.emit('end');
        });
        return { status: 200, data: answering, headers: {} };
      }
      const sse = postResponses.length > 0 ? postResponses.shift()! : CONTINUATION_SSE;
      const stream: any = new EventEmitter();
      stream.destroy = () => {};
      setImmediate(() => {
        stream.emit('data', Buffer.from(sse));
        stream.emit('end');
      });
      return { status: 200, data: stream, headers: {} };
    }),
  },
}));

import {
  installWebSearchStreamInterception,
} from '../src/plugins/webSearch/anthropicWebSearchStream';

/** Collects everything written to the client. */
function mockRes() {
  const r: any = Object.assign(new EventEmitter(), { chunks: [] as string[], ended: false });
  r.setHeader = () => {};
  r.write = (s: any) => { r.chunks.push(s.toString()); return true; };
  // A real ServerResponse flips `writableEnded` on end(); the fake used to set
  // only its own `ended` flag, so nothing that guards on `writableEnded` — which
  // is what the production code must guard on — could be tested at all.
  r.end = () => { r.ended = true; r.writableEnded = true; };
  r.writable = true;
  r.writableEnded = false;
  r.destroyed = false;
  return r;
}

function blocksOf(res: any): string[] {
  return res.chunks.join('').split('\n\n').filter((b: string) => b.trim().length > 0);
}

function framesOf(res: any): any[] {
  return blocksOf(res)
    .map((b: string) => b.split('\n').find((l) => l.startsWith('data: ')))
    .filter(Boolean)
    .map((l: any) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
    .filter(Boolean);
}

/** The frames the deployment emits when the model calls the rewritten web_search tool. */
const UPSTREAM_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"web_search","input":{}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"zig version\\"}"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":10,"output_tokens":20}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join('');

function testLogger() {
  return {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  };
}

async function runTurn(upstream: string | string[] = UPSTREAM_SSE, overrides: any = {}) {
  const res = mockRes();
  const handle = installWebSearchStreamInterception({
    res,
    targetUrl: 'https://sap.example/d1/invoke-with-response-stream',
    authToken: 'tok',
    requestBody: { anthropic_version: 'bedrock-2023-05-31', messages: [{ role: 'user', content: 'zig version' }] },
    timeoutMs: 5000,
    logger: testLogger(),
    ...overrides,
  });
  // The parser writes through res.write; simulate that.
  const chunks = Array.isArray(upstream) ? upstream : [upstream];
  for (const c of chunks) res.write(c);
  await handle.finalize();
  return res;
}

describe('anthropic streaming web_search', () => {
  beforeEach(() => {
    searchCalls.length = 0;
    postBodies.length = 0;
    searchQueue = [];
    postResponses = [];
    answerOnlyWhenBudgetSpent = false;
  });

  it('emits server_tool_use and web_search_tool_result instead of the raw tool_use', async () => {
    const res = await runTurn();
    const blocks = framesOf(res)
      .filter((f) => f.type === 'content_block_start')
      .map((f) => f.content_block.type);

    expect(blocks).toContain('server_tool_use');
    expect(blocks).toContain('web_search_tool_result');
    expect(blocks).not.toContain('tool_use');   // the raw call never reaches the client
  });

  it('never writes the model\'s own tool_use id or a tool_use block to the client', async () => {
    // The block-type assertion above only inspects content_block_start frames.
    // Nothing anywhere on the wire may name the rewritten call: `toolu_1` is the
    // id of a tool the client never declared, and it is the id the CONTINUATION
    // uses — leaking it invites the client to answer a call we already answered.
    // (`input_json_delta` does legitimately appear: it is how the golden streams
    // the server_tool_use block's own query.)
    const res = await runTurn();
    const wire = res.chunks.join('');
    // Quoted, always: the minted ids are `srvtoolu_<hex>`, so a bare `toolu_1`
    // substring matches `srvtoolu_1a3f...` one time in sixteen and the assertion
    // fails for a reason that has nothing to do with a leak.
    expect(wire).not.toContain('"toolu_1"');
    expect(wire).not.toContain('"type":"tool_use"');
  });

  it('runs the search with the query the model asked for', async () => {
    await runTurn();
    expect(searchCalls).toEqual(['zig version']);
  });

  it('runs the continuation so the model actually answers', async () => {
    const res = await runTurn();
    const text = framesOf(res)
      .filter((f) => f.type === 'content_block_delta' && f.delta?.type === 'text_delta')
      .map((f) => f.delta.text).join('');
    expect(text).toContain('Zig 0.16.0');
    expect(postBodies).toHaveLength(1);
    // The continuation carries the tool result back to the model.
    expect(JSON.stringify(postBodies[0])).toContain('tool_result');
    // ...keyed to the id the model actually used, or the deployment 400s.
    expect(JSON.stringify(postBodies[0])).toContain('toolu_1');
  });

  it('reports the search count on the final message_delta', async () => {
    const res = await runTurn();
    const deltas = framesOf(res).filter((f) => f.type === 'message_delta');
    expect(deltas).toHaveLength(1);
    const last = deltas[deltas.length - 1];
    expect(last.usage.server_tool_use).toEqual({ web_search_requests: 1, web_fetch_requests: 0 });
  });

  it('emits exactly one message_stop', async () => {
    // Two upstream turns each end with message_stop; the client must see one.
    const res = await runTurn();
    expect(framesOf(res).filter((f) => f.type === 'message_stop')).toHaveLength(1);
  });

  it('emits exactly one message_start', async () => {
    // The continuation is a second upstream turn and opens with its own
    // message_start. A client that has already begun a message treats a second
    // one as a protocol error.
    const res = await runTurn();
    expect(framesOf(res).filter((f) => f.type === 'message_start')).toHaveLength(1);
  });

  it('shifts continuation block indices past the blocks the client already saw', async () => {
    const res = await runTurn();
    const starts = framesOf(res).filter((f) => f.type === 'content_block_start');
    const indices = starts.map((f) => f.index);
    expect(indices).toEqual([0, 1, 2]);   // server_tool_use, result, continuation text
    expect(starts[2].content_block.type).toBe('text');
  });

  it('keeps client-visible indices contiguous when a passed block follows a held one', async () => {
    // The held web_search block consumes upstream index 0, so upstream's `text@1`
    // is the client's FIRST block and must arrive as index 0. Echoing upstream's
    // numbering leaves nothing at 0 and starts the client's content array with a
    // hole; api.anthropic.com always numbers contiguously from 0.
    const TEXT_AFTER_TOOL_USE = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"web_search","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"zig version\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Let me look."}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":10,"output_tokens":20}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('');

    const res = await runTurn(TEXT_AFTER_TOOL_USE);
    const frames = framesOf(res);

    const starts = frames.filter((f) => f.type === 'content_block_start');
    expect(starts.map((f) => f.index)).toEqual([0, 1, 2, 3]);
    expect(starts.map((f) => f.content_block.type))
      .toEqual(['text', 'server_tool_use', 'web_search_tool_result', 'text']);

    // The renumbering has to follow the block, not just its start: a delta or a
    // stop left on upstream's index addresses the wrong block entirely.
    const byIndex = (type: string) => frames.filter((f) => f.type === type).map((f) => f.index);
    expect(byIndex('content_block_delta')).toEqual([0, 1, 3]);
    expect(byIndex('content_block_stop')).toEqual([0, 1, 2, 3]);
    expect(frames.find((f) => f.type === 'content_block_delta' && f.index === 0).delta.text)
      .toBe('Let me look.');
  });

  it('passes SSE comments and ping frames through untouched', async () => {
    // sseWriter.writePing writes a bare `: ping` comment with no data line. A
    // re-serializing interceptor drops it and the keepalive dies.
    const res = await runTurn([': ping\n\n', UPSTREAM_SSE]);
    expect(res.chunks.join('')).toContain(': ping');
  });

  it('holds the tool_use across a chunk boundary that splits an SSE block', async () => {
    const split = UPSTREAM_SSE.length - 40;
    const res = await runTurn([UPSTREAM_SSE.slice(0, split), UPSTREAM_SSE.slice(split)]);
    expect(searchCalls).toEqual(['zig version']);
    expect(res.chunks.join('')).not.toContain('"toolu_1"');
  });

  it('runs a second round when the continuation searches again', async () => {
    const SECOND_TURN = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","type":"message","role":"assistant","content":[],"usage":{"input_tokens":40,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_2","name":"web_search","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"zig release date\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":40,"output_tokens":12}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('');
    postResponses = [SECOND_TURN, CONTINUATION_SSE];

    const res = await runTurn();

    expect(searchCalls).toEqual(['zig version', 'zig release date']);
    expect(postBodies).toHaveLength(2);
    // The second turn's raw tool_use must be suppressed exactly like the first.
    expect(res.chunks.join('')).not.toContain('"toolu_2"');
    const frames = framesOf(res);
    expect(frames.filter((f) => f.type === 'message_stop')).toHaveLength(1);
    const deltas = frames.filter((f) => f.type === 'message_delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0].usage.server_tool_use).toEqual({ web_search_requests: 2, web_fetch_requests: 0 });
  });

  /** A continuation that just asks for another search. The model that never stops. */
  const LOOPING = [
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_x","name":"web_search","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"again\\"}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');

  it('lets the model answer when the cap refuses its next search', async () => {
    // The defect this covers was found live, not here: at the cap the earlier
    // code dropped the outstanding call and broke out, and the real deployment
    // returned three server_tool_use blocks, three web_search_tool_result blocks,
    // ZERO text blocks and stop_reason "end_turn". Three searches, no answer.
    //
    // The model here keeps asking for another search and only writes its answer
    // once it has been TOLD the budget is spent — so the assertion fails unless
    // that final continuation is genuinely sent.
    answerOnlyWhenBudgetSpent = true;
    postResponses = [LOOPING, LOOPING, LOOPING, LOOPING, LOOPING];

    const res = await runTurn(UPSTREAM_SSE, { maxSearches: 2 });
    const frames = framesOf(res);

    // The cap held...
    expect(searchCalls).toHaveLength(2);
    const deltas = frames.filter((f) => f.type === 'message_delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0].usage.server_tool_use).toEqual({ web_search_requests: 2, web_fetch_requests: 0 });

    // ...and the user still got an answer.
    const text = frames
      .filter((f) => f.type === 'content_block_delta' && f.delta?.type === 'text_delta')
      .map((f) => f.delta.text).join('');
    expect(text).toContain('Zig 0.16.0');
    expect(frames.filter((f) => f.type === 'content_block_start'
      && f.content_block.type === 'text').length).toBeGreaterThanOrEqual(1);

    // Every tool_use we sent upstream was answered — an unanswered one is a 400.
    for (const body of postBodies) {
      const useIds = body.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])
        .filter((b: any) => b.type === 'tool_use').map((b: any) => b.id));
      const resultIds = body.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])
        .filter((b: any) => b.type === 'tool_result').map((b: any) => b.tool_use_id));
      expect(resultIds.sort()).toEqual(useIds.sort());
    }
  });

  it('stops searching once the per-request cap is reached', async () => {
    answerOnlyWhenBudgetSpent = true;
    postResponses = [LOOPING, LOOPING, LOOPING, LOOPING, LOOPING];

    const res = await runTurn(UPSTREAM_SSE, { maxSearches: 2 });

    expect(searchCalls).toHaveLength(2);
    const frames = framesOf(res);
    expect(frames.filter((f) => f.type === 'message_stop')).toHaveLength(1);
    const deltas = frames.filter((f) => f.type === 'message_delta');
    expect(deltas).toHaveLength(1);
    // The turn is over from the client's point of view: there is no tool_use block
    // for it to answer, so `tool_use` as a stop_reason would strand it.
    expect(deltas[0].delta.stop_reason).toBe('end_turn');
  });

  /** A request shaped like Claude Code's: web_search alongside the client's own tools. */
  function bodyWithTools(tools: any[]) {
    return {
      anthropic_version: 'bedrock-2023-05-31',
      messages: [{ role: 'user', content: 'zig version' }],
      tools,
    };
  }

  it('takes web_search off the table on the cap-reached continuation, keeping other tools', async () => {
    // Live, with the tool still declared, the model answered the "budget spent"
    // tool_result by asking for a FOURTH search. Prose is a suggestion; the tool
    // being absent is a constraint. Other tools must survive — a real request
    // carries many and the model may legitimately need them in the same turn.
    answerOnlyWhenBudgetSpent = true;
    postResponses = [LOOPING, LOOPING, LOOPING, LOOPING];

    await runTurn(UPSTREAM_SSE, {
      maxSearches: 2,
      requestBody: bodyWithTools([
        { name: 'web_search', input_schema: { type: 'object' } },
        { name: 'Read', input_schema: { type: 'object' } },
        { name: 'Bash', input_schema: { type: 'object' } },
      ]),
    });

    expect(postBodies).toHaveLength(3);

    // While budget remained, the tool stays offered — stripping it early would
    // break the very feature this module exists for.
    for (const body of postBodies.slice(0, 2)) {
      expect(body.tools.map((t: any) => t.name)).toEqual(['web_search', 'Read', 'Bash']);
    }

    const answering = postBodies[2];
    expect(answering.tools.map((t: any) => t.name)).toEqual(['Read', 'Bash']);
    expect(JSON.stringify(answering.tools)).not.toContain('web_search');
  });

  it('omits tools entirely rather than sending an empty array', async () => {
    answerOnlyWhenBudgetSpent = true;
    postResponses = [LOOPING, LOOPING, LOOPING, LOOPING];

    await runTurn(UPSTREAM_SSE, {
      maxSearches: 2,
      requestBody: bodyWithTools([{ name: 'web_search', input_schema: { type: 'object' } }]),
    });

    const answering = postBodies[postBodies.length - 1];
    // `tools: []` is not the same request as one declaring no tools.
    expect(Object.prototype.hasOwnProperty.call(answering, 'tools')).toBe(false);
  });

  it('drops a tool_choice that names the tool it just removed', async () => {
    // Stripping web_search while `tool_choice` still demands it is a 400.
    answerOnlyWhenBudgetSpent = true;
    postResponses = [LOOPING, LOOPING, LOOPING, LOOPING];

    await runTurn(UPSTREAM_SSE, {
      maxSearches: 2,
      requestBody: {
        ...bodyWithTools([
          { name: 'web_search', input_schema: { type: 'object' } },
          { name: 'Read', input_schema: { type: 'object' } },
        ]),
        tool_choice: { type: 'tool', name: 'web_search' },
      },
    });

    const answering = postBodies[postBodies.length - 1];
    expect(Object.prototype.hasOwnProperty.call(answering, 'tool_choice')).toBe(false);
    expect(answering.tools.map((t: any) => t.name)).toEqual(['Read']);
    // The earlier, still-searching rounds keep the caller's request intact.
    expect(postBodies[0].tool_choice).toEqual({ type: 'tool', name: 'web_search' });
  });

  it('never mutates the caller\'s request body', async () => {
    const requestBody = bodyWithTools([
      { name: 'web_search', input_schema: { type: 'object' } },
      { name: 'Read', input_schema: { type: 'object' } },
    ]);
    const snapshot = JSON.stringify(requestBody);
    answerOnlyWhenBudgetSpent = true;
    postResponses = [LOOPING, LOOPING, LOOPING, LOOPING];

    await runTurn(UPSTREAM_SSE, { maxSearches: 2, requestBody });

    expect(JSON.stringify(requestBody)).toBe(snapshot);
  });

  it('ends the turn when the model keeps searching even after the budget message', async () => {
    // The answering continuation is entitled to ignore us. It must not buy another
    // round: the budget is already spent, so granting one is an unbounded loop.
    postResponses = [LOOPING, LOOPING, LOOPING, LOOPING, LOOPING, LOOPING];

    const res = await runTurn(UPSTREAM_SSE, { maxSearches: 2 });
    const frames = framesOf(res);

    expect(searchCalls).toHaveLength(2);
    expect(postBodies).toHaveLength(3);   // two search rounds, then the answering one
    expect(frames.filter((f) => f.type === 'message_stop')).toHaveLength(1);
    expect(frames.filter((f) => f.type === 'message_delta')).toHaveLength(1);
    expect(res.chunks.join('')).not.toContain('"toolu_x"');
  });

  it('still terminates the client stream when the continuation POST fails', async () => {
    const axiosMock: any = jest.requireMock('axios');
    axiosMock.default.post.mockImplementationOnce(async () => { throw new Error('502 from SAP'); });

    const res = await runTurn();

    const frames = framesOf(res);
    // The search still happened and its blocks are on the wire.
    expect(frames.filter((f) => f.type === 'content_block_start').map((f) => f.content_block.type))
      .toEqual(['server_tool_use', 'web_search_tool_result']);
    expect(frames.filter((f) => f.type === 'message_stop')).toHaveLength(1);
    const deltas = frames.filter((f) => f.type === 'message_delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0].delta.stop_reason).toBe('end_turn');
    expect(deltas[0].usage.server_tool_use).toEqual({ web_search_requests: 1, web_fetch_requests: 0 });
  });

  it('emits the result block with an empty result set when the search throws', async () => {
    const executor: any = jest.requireMock('../src/plugins/webSearch/searchExecutor');
    executor.executeWebSearch.mockImplementationOnce(async () => { throw new Error('perplexity down'); });

    const res = await runTurn();

    const result = framesOf(res).find((f) => f.type === 'content_block_start'
      && f.content_block.type === 'web_search_tool_result');
    expect(result).toBeDefined();
    expect(result.content_block.content).toEqual([]);
    // The model still gets its turn; the client is not stranded mid-stream.
    expect(postBodies).toHaveLength(1);
  });

  describe('a held web_search block that yields no runnable query', () => {
    // The interceptor holds every frame of a web_search block as it arrives and
    // yields a pending call only if the accumulated input parses to a non-empty
    // query. When it does not, the block is GONE from the client's stream — so
    // letting the turn's own `stop_reason: "tool_use"` and `message_stop`
    // through tells the client to answer a tool call it was never shown, and it
    // waits forever. Three reachable triggers, one required ending.
    const cases: Array<[string, string]> = [
      // Stream truncated mid-input: the accumulated JSON never closes.
      ['truncated tool input', '{\\"query\\": \\"zig ver'],
      // The interceptor requires a NON-EMPTY query.
      ['an empty query', '{\\"query\\":\\"\\"}'],
    ];

    for (const [label, partialJson] of cases) {
      it(`ends the turn cleanly on ${label}`, async () => {
        const sse = [
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"web_search","input":{}}}\n\n',
          `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"${partialJson}"}}\n\n`,
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":10,"output_tokens":20}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ].join('');

        const res = await runTurn(sse);
        const frames = framesOf(res);

        // Nothing ran and nothing leaked.
        expect(searchCalls).toEqual([]);
        expect(postBodies).toEqual([]);
        expect(res.chunks.join('')).not.toContain('"toolu_1"');
        expect(res.chunks.join('')).not.toContain('"type":"tool_use"');

        // But the client still gets a coherent, TERMINATED turn.
        const deltas = frames.filter((f) => f.type === 'message_delta');
        expect(deltas).toHaveLength(1);
        expect(deltas[0].delta.stop_reason).toBe('end_turn');
        expect(frames.filter((f) => f.type === 'message_stop')).toHaveLength(1);
        expect(frames[frames.length - 1].type).toBe('message_stop');
      });
    }

    it('ends the turn cleanly when partial_json arrives as an object, not a string', async () => {
      // bedrockStreamParser.ts assigns `partial_json: delta.toolUse.input`
      // verbatim, so a non-string input reaches the interceptor as an object and
      // accumulates as the literal "[object Object]".
      const sse = [
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"web_search","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":{"query":"zig version"}}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join('');

      const res = await runTurn(sse);
      const frames = framesOf(res);

      expect(res.chunks.join('')).not.toContain('"type":"tool_use"');
      const deltas = frames.filter((f) => f.type === 'message_delta');
      expect(deltas).toHaveLength(1);
      expect(deltas[0].delta.stop_reason).toBe('end_turn');
      expect(frames.filter((f) => f.type === 'message_stop')).toHaveLength(1);
    });
  });

  it('passes an ordinary turn through untouched when no web_search is called', async () => {
    const plain = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":3,"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('');
    const res = await runTurn(plain);

    expect(searchCalls).toEqual([]);
    expect(postBodies).toEqual([]);          // no continuation
    const frames = framesOf(res);
    expect(frames.filter((f) => f.type === 'message_stop')).toHaveLength(1);
    const delta = frames.find((f) => f.type === 'message_delta');
    expect(delta.usage.server_tool_use).toBeUndefined();   // no search ran, no count
    // Byte-for-byte passthrough: an untouched turn must not be re-serialized.
    expect(res.chunks.join('')).toBe(plain);
  });

  describe('a client that goes away mid-search', () => {
    // The interception holds the stream open for SECONDS. Throughout, the
    // handler's `response.data.on('error')` stays wired to sseWriter.writeError,
    // which calls res.end(). Writing after end() makes a ServerResponse emit
    // 'error'; there is no uncaughtException handler anywhere in src/, so that
    // unhandled emit takes the process down along with every other in-flight
    // request. A plain client disconnect gets there by another route.
    function exploding(res: any) {
      // Models a real ServerResponse: writing after end throws rather than
      // silently succeeding, so an unguarded write fails the test loudly.
      const realWrite = res.write.bind(res);
      res.write = (s: any) => {
        if (res.writableEnded || res.destroyed) throw new Error('write after end');
        return realWrite(s);
      };
      return res;
    }

    it('writes nothing after res.end(), and does not throw', async () => {
      const res = exploding(mockRes());
      const handle = installWebSearchStreamInterception({
        res,
        targetUrl: 'https://sap.example/d1/invoke-with-response-stream',
        authToken: 'tok',
        requestBody: { messages: [{ role: 'user', content: 'zig version' }] },
        timeoutMs: 5000,
        logger: testLogger(),
      });

      res.write(UPSTREAM_SSE);
      const before = res.chunks.length;
      // The upstream stream errored: sseWriter.writeError ended the response
      // while finalize is about to run the search.
      res.end();

      await expect(handle.finalize()).resolves.toBeUndefined();
      expect(res.chunks.length).toBe(before);
    });

    it('abandons the search rather than paying for a client that has gone', async () => {
      const res = exploding(mockRes());
      const handle = installWebSearchStreamInterception({
        res,
        targetUrl: 'https://sap.example/d1/invoke-with-response-stream',
        authToken: 'tok',
        requestBody: { messages: [{ role: 'user', content: 'zig version' }] },
        timeoutMs: 5000,
        logger: testLogger(),
      });

      res.write(UPSTREAM_SSE);
      res.destroyed = true;          // client disconnected

      await handle.finalize();

      // No Perplexity call, no SAP continuation: seconds of work and real money
      // that would have gone to a closed socket.
      expect(searchCalls).toEqual([]);
      expect(postBodies).toEqual([]);
    });
  });

  it('restores res.write once the turn is finalized', async () => {
    const res = mockRes();
    const before = res.write;
    const handle = installWebSearchStreamInterception({
      res,
      targetUrl: 'https://sap.example/d1/invoke-with-response-stream',
      authToken: 'tok',
      requestBody: { messages: [] },
      timeoutMs: 5000,
      logger: testLogger(),
    });
    const patched = res.write;
    expect(patched).not.toBe(before);
    res.write(UPSTREAM_SSE);
    await handle.finalize();
    // Anything the streaming handler writes after finalize (its no-data fallback,
    // an error frame) must go straight out, not through a dead interceptor.
    expect(res.write).not.toBe(patched);
    res.write('event: ping\ndata: {"type":"ping"}\n\n');
    expect(res.chunks[res.chunks.length - 1]).toBe('event: ping\ndata: {"type":"ping"}\n\n');
  });
});
