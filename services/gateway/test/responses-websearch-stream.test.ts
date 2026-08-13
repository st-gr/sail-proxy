import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { PassThrough, Readable } from 'stream';

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
mockMaxSearches.mockReturnValue(3);

import pluginRules = require('../src/plugins/responsesWebSearchPlugin');
import { abortResponsesStreamContinuation, awaitResponsesStreamIdle } from '../src/utils/responsesStreamIdle';

const before = (pluginRules as any[]).find(r => r.strategy === 'before').handler;
const utils = { logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() } };
const RESULTS = [{ title: 'Berlin weather', url: 'https://w.example/berlin', snippet: 'Mild', content: 'Mild and dry' }];

function mockRes() {
  const written: string[] = [];
  let ended = false;
  return {
    written,
    get ended() { return ended; },
    write(chunk: any) { written.push(chunk.toString()); return true; },
    end(chunk?: any) { if (chunk) written.push(chunk.toString()); ended = true; return this as any; },
    setHeader() { /* no-op */ },
    headersSent: false,
    writableEnded: false,
  } as any;
}

/**
 * Extracts the JSON payload of every `data:` line in the written bytes. Looks for the
 * `data:` line anywhere within each block (not just at its start) so blocks that also
 * carry a leading `event:` line — real SSE, which sse() below doesn't produce but
 * sseWithEvent() does — are still picked up. This is a superset of the original
 * start-anchored check: every block the old version matched, this one still matches.
 */
function frames(written: string[]): any[] {
  return written.join('')
    .split('\n\n')
    .map(b => b.trim())
    .filter(b => b.length > 0)
    .map(b => b.split('\n').find(l => l.startsWith('data: ')))
    .filter((line): line is string => typeof line === 'string')
    .map(line => JSON.parse(line.slice(6)));
}

function sse(obj: any): string { return `data: ${JSON.stringify(obj)}\n\n`; }

function sseWithEvent(eventName: string, obj: any): string { return `event: ${eventName}\ndata: ${JSON.stringify(obj)}\n\n`; }

/** Let the queued search promise settle. */
const settle = () => new Promise(r => setTimeout(r, 0));

/**
 * Let a whole continuation settle: the search, the POST, and every 'data'/'end' event of
 * the continuation's own stream, which need real event-loop turns rather than the single
 * microtask drain `settle` gives.
 */
const settleAll = () => new Promise(r => setTimeout(r, 20));

/** An axios streaming response whose body replays `frames` as SSE blocks. */
function upstreamStream(frames: any[]): any {
  return { data: Readable.from(frames.map(f => `data: ${JSON.stringify(f)}\n\n`)) };
}

const UPSTREAM = () => ({
  url: 'https://sap.example/d1/responses',
  headers: { Authorization: 'Bearer t' },
  timeoutMs: 5000,
  payload: { model: 'm', input: 'node lts?', stream: true },
});

describe('responsesWebSearchPlugin — streaming', () => {
  beforeEach(() => { mockExecuteWebSearch.mockReset(); mockExecuteWebSearch.mockResolvedValue(RESULTS); });

  it('suppresses web_search function-call frames and injects synthetic items', async () => {
    const res = mockRes();
    const req: any = { body: { stream: true, tools: [{ type: 'web_search' }], input: 'weather?' } };

    await before({ req, res, utils });

    res.write(sse({ type: 'response.created', response: { id: 'resp_1' } }));
    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '' } }));
    res.write(sse({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"query":"weather ' }));
    res.write(sse({ type: 'response.function_call_arguments.delta', output_index: 0, delta: 'in Berlin"}' }));
    res.write(sse({ type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"query":"weather in Berlin"}' }));
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"weather in Berlin"}' } }));
    await settle();
    res.write(sse({ type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 10, output_tokens: 2 } } }));

    const types = frames(res.written).map(f => f.type);

    expect(types).not.toContain('response.function_call_arguments.delta');
    expect(types).not.toContain('response.function_call_arguments.done');
    expect(types[0]).toBe('response.created');
    expect(types).toContain('response.output_text.delta');
    expect(types[types.length - 1]).toBe('response.completed');

    const added = frames(res.written).filter(f => f.type === 'response.output_item.added');
    expect(added.map(f => f.item.type)).toEqual(['web_search_call', 'message']);
    expect(added[0].item.action.query).toBe('weather in Berlin');

    expect(mockExecuteWebSearch).toHaveBeenCalledWith('weather in Berlin', utils.logger);
  });

  it('passes frames for other items straight through', async () => {
    const res = mockRes();
    const req: any = { body: { stream: true, tools: [{ type: 'web_search' }], input: 'hi' } };

    await before({ req, res, utils });

    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_9', call_id: 'call_9', name: 'exec_command', arguments: '' } }));
    res.write(sse({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"cmd":"ls"}' }));

    const types = frames(res.written).map(f => f.type);
    expect(types).toEqual(['response.output_item.added', 'response.function_call_arguments.delta']);
    expect(mockExecuteWebSearch).not.toHaveBeenCalled();
  });

  it('queues frames that arrive while the search is in flight, preserving order', async () => {
    let release: (v: any) => void = () => {};
    mockExecuteWebSearch.mockReturnValue(new Promise(r => { release = r; }));

    const res = mockRes();
    const req: any = { body: { stream: true, tools: [{ type: 'web_search' }], input: 'weather?' } };
    await before({ req, res, utils });

    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"q"}' } }));
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"q"}' } }));
    res.write(sse({ type: 'response.completed', response: { id: 'resp_1' } }));

    expect(frames(res.written).map(f => f.type)).not.toContain('response.completed');

    release(RESULTS);
    await settle();

    const types = frames(res.written).map(f => f.type);
    expect(types[types.length - 1]).toBe('response.completed');
    expect(types).toContain('response.output_item.added');
  });

  it('emits a failed web_search_call when the search rejects mid-stream', async () => {
    mockExecuteWebSearch.mockRejectedValue(new Error('perplexity down'));
    const res = mockRes();
    const req: any = { body: { stream: true, tools: [{ type: 'web_search' }], input: 'weather?' } };
    await before({ req, res, utils });

    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"q"}' } }));
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"q"}' } }));
    await settle();

    const added = frames(res.written).filter(f => f.type === 'response.output_item.added');
    expect(added[0].item.type).toBe('web_search_call');
    expect(added[0].item.status).toBe('failed');
  });

  it('defers res.end until a queued search has flushed', async () => {
    let release: (v: any) => void = () => {};
    mockExecuteWebSearch.mockReturnValue(new Promise(r => { release = r; }));

    const res = mockRes();
    const req: any = { body: { stream: true, tools: [{ type: 'web_search' }], input: 'weather?' } };
    await before({ req, res, utils });

    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"q"}' } }));
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"q"}' } }));
    res.end();

    expect(res.ended).toBe(false);

    release(RESULTS);
    await settle();

    expect(res.ended).toBe(true);
  });

  it('does not install an interceptor for a non-streaming request', async () => {
    const res = mockRes();
    const originalWrite = res.write;
    const req: any = { body: { stream: false, tools: [{ type: 'web_search' }], input: 'hi' } };

    await before({ req, res, utils });

    expect(res.write).toBe(originalWrite);
  });

  it('buffers two parallel searches and flushes both in ascending output_index order (later index resolves first)', async () => {
    const releases: Record<string, (v: any) => void> = {};
    mockExecuteWebSearch.mockImplementation(
      (query: string) => new Promise(r => { releases[query] = r; }),
    );

    const res = mockRes();
    const req: any = { body: { stream: true, tools: [{ type: 'web_search' }], input: 'weather?' } };
    await before({ req, res, utils });

    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_0', call_id: 'call_0', name: 'web_search', arguments: '{"query":"q0"}' } }));
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_0', call_id: 'call_0', name: 'web_search', arguments: '{"query":"q0"}' } }));
    res.write(sse({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"q1"}' } }));
    res.write(sse({ type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"q1"}' } }));
    res.write(sse({ type: 'response.completed', response: { id: 'resp_1' } }));
    res.end();

    // Later index (q1) resolves first — its frames must still wait for q0.
    releases['q1'](RESULTS);
    await settle();
    expect(res.ended).toBe(false);
    expect(frames(res.written).filter(f => f.type === 'response.output_item.added' && f.item.type === 'web_search_call')).toHaveLength(0);

    releases['q0'](RESULTS);
    await settle();

    const added = frames(res.written).filter(f => f.type === 'response.output_item.added' && (f.item.type === 'web_search_call' || f.item.type === 'message'));
    expect(added).toHaveLength(4);
    expect(added.map(f => f.output_index)).toEqual([0, 0, 1, 1]);

    const types = frames(res.written).map(f => f.type);
    expect(types[types.length - 1]).toBe('response.completed');
    expect(res.ended).toBe(true);
  });

  it('buffers two parallel searches and flushes both in ascending output_index order (earlier index resolves first)', async () => {
    const releases: Record<string, (v: any) => void> = {};
    mockExecuteWebSearch.mockImplementation(
      (query: string) => new Promise(r => { releases[query] = r; }),
    );

    const res = mockRes();
    const req: any = { body: { stream: true, tools: [{ type: 'web_search' }], input: 'weather?' } };
    await before({ req, res, utils });

    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_0', call_id: 'call_0', name: 'web_search', arguments: '{"query":"q0"}' } }));
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_0', call_id: 'call_0', name: 'web_search', arguments: '{"query":"q0"}' } }));
    res.write(sse({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"q1"}' } }));
    res.write(sse({ type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"q1"}' } }));
    res.write(sse({ type: 'response.completed', response: { id: 'resp_1' } }));
    res.end();

    // Earlier index (q0) resolves first — its frames must still wait for q1
    // so nothing is written out of ascending output_index order.
    releases['q0'](RESULTS);
    await settle();
    expect(res.ended).toBe(false);
    expect(frames(res.written).filter(f => f.type === 'response.output_item.added' && f.item.type === 'web_search_call')).toHaveLength(0);

    releases['q1'](RESULTS);
    await settle();

    const added = frames(res.written).filter(f => f.type === 'response.output_item.added' && (f.item.type === 'web_search_call' || f.item.type === 'message'));
    expect(added).toHaveLength(4);
    expect(added.map(f => f.output_index)).toEqual([0, 0, 1, 1]);

    const types = frames(res.written).map(f => f.type);
    expect(types[types.length - 1]).toBe('response.completed');
    expect(res.ended).toBe(true);
  });

  it('reassembles an SSE block split mid-JSON across chunk boundaries, byte-identical', async () => {
    const res = mockRes();
    const req: any = { body: { stream: true, tools: [{ type: 'web_search' }], input: 'hi' } };
    await before({ req, res, utils });

    const frame = { type: 'response.output_text.delta', output_index: 5, content_index: 0, item_id: 'msg_x', delta: 'hello world' };
    const block = sse(frame);
    const mid = Math.floor(block.length / 2);
    const part1 = block.slice(0, mid);
    const part2 = block.slice(mid);

    res.write(part1);
    expect(res.written.join('')).toBe('');

    res.write(part2);

    expect(res.written.join('')).toBe(block);
    expect(frames(res.written)).toEqual([frame]);
  });

  it('flushes an unterminated trailing block on end() instead of dropping it', async () => {
    const res = mockRes();
    const req: any = { body: { stream: true, tools: [{ type: 'web_search' }], input: 'hi' } };
    await before({ req, res, utils });

    const frame = { type: 'response.output_text.delta', output_index: 2, content_index: 0, item_id: 'msg_y', delta: 'partial' };
    const full = sse(frame);
    const withoutTerminator = full.slice(0, -2); // drop the trailing \n\n

    res.write(withoutTerminator);
    expect(res.written.join('')).toBe('');

    res.end();

    expect(res.written.join('')).toBe(withoutTerminator);
    expect(res.ended).toBe(true);
  });

  it('rewrites response.completed to replace the raw function_call with the synthetic items', async () => {
    const res = mockRes();
    const req: any = { body: { stream: true, tools: [{ type: 'web_search' }], input: 'weather?' } };
    await before({ req, res, utils });

    const fc = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"weather in Berlin"}' };
    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: fc }));
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: fc }));
    await settle();

    res.write(sse({ type: 'response.completed', response: { id: 'resp_1', output: [fc], usage: { input_tokens: 1, output_tokens: 1 } } }));

    const completed = frames(res.written).find(f => f.type === 'response.completed');
    expect(completed.response.output.some((i: any) => i.type === 'function_call' && i.name === 'web_search')).toBe(false);
    expect(completed.response.output.map((i: any) => i.type)).toEqual(['web_search_call', 'message']);
    expect(mockExecuteWebSearch).toHaveBeenCalledTimes(1);
  });

  it('interleaves buffered search results with unrelated items in arrival order, not resolution order', async () => {
    const releases: Record<string, (v: any) => void> = {};
    mockExecuteWebSearch.mockImplementation(
      (query: string) => new Promise(r => { releases[query] = r; }),
    );

    const res = mockRes();
    const req: any = { body: { stream: true, tools: [{ type: 'web_search' }], input: 'weather?' } };
    await before({ req, res, utils });

    // web_search @ output_index 0
    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_0', call_id: 'call_0', name: 'web_search', arguments: '{"query":"q0"}' } }));
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_0', call_id: 'call_0', name: 'web_search', arguments: '{"query":"q0"}' } }));

    // an ordinary reasoning item @ output_index 1 — must not be reordered relative to
    // the two searches that bracket it.
    res.write(sse({ type: 'response.output_item.added', output_index: 1, item: { type: 'reasoning', id: 'r_1' } }));
    res.write(sse({ type: 'response.output_item.done', output_index: 1, item: { type: 'reasoning', id: 'r_1' } }));

    // web_search @ output_index 2
    res.write(sse({ type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'web_search', arguments: '{"query":"q2"}' } }));
    res.write(sse({ type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'web_search', arguments: '{"query":"q2"}' } }));

    // Resolve the later search first — resolution order must not affect replay order.
    releases['q2'](RESULTS);
    releases['q0'](RESULTS);
    await settle();

    const orderedIndices = frames(res.written)
      .filter(f => typeof f.output_index === 'number')
      .map(f => f.output_index);

    expect(orderedIndices).toEqual([...Array(8).fill(0), 1, 1, ...Array(8).fill(2)]);
  });

  it('keeps the event: line on a terminal frame that needed no substitution', async () => {
    const res = mockRes();
    const req: any = { body: { stream: true, tools: [{ type: 'web_search' }], input: 'hi' } };
    await before({ req, res, utils });

    const block = sseWithEvent('response.completed', { type: 'response.completed', response: { id: 'resp_1' } });
    res.write(block);

    expect(res.written.join('')).toBe(block);
  });

  it('keeps the event: line on a terminal frame that was substituted', async () => {
    const res = mockRes();
    const req: any = { body: { stream: true, tools: [{ type: 'web_search' }], input: 'weather?' } };
    await before({ req, res, utils });

    const fc = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"weather in Berlin"}' };
    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: fc }));
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: fc }));
    await settle();

    const block = sseWithEvent('response.completed', { type: 'response.completed', response: { id: 'resp_1', output: [fc] } });
    res.write(block);

    const written = res.written.join('');
    expect(written).toContain('event: response.completed\n');

    const completed = frames(res.written).find(f => f.type === 'response.completed');
    expect(completed.response.output.map((i: any) => i.type)).toEqual(['web_search_call', 'message']);
  });

  it('logs and still ends the response instead of hanging when a buffered flush write throws', async () => {
    const res = mockRes();
    const realWrite = res.write.bind(res);
    let writeCalls = 0;
    // The interceptor installs on top of this, so `originalWrite` inside it is this
    // flaky function — the first write attempted during the flush (i.e. the first of
    // the search's own injected blocks, since the suppressed function_call itself never
    // reaches a raw write) throws once, simulating a torn-down socket mid-flush.
    res.write = (chunk: any) => {
      writeCalls += 1;
      if (writeCalls === 1) throw new Error('socket torn down');
      return realWrite(chunk);
    };

    const req: any = { body: { stream: true, tools: [{ type: 'web_search' }], input: 'weather?' } };
    await before({ req, res, utils });

    const errorCallsBefore = (utils.logger.error as jest.Mock).mock.calls.length;

    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"q"}' } }));
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"q"}' } }));
    res.end();

    // Must not throw / produce an unhandled rejection that fails the test.
    await settle();

    // Specifically the flush-failure path, not just some earlier logger.error call —
    // utils.logger is shared across tests in this file and never reset.
    const newErrorCalls = (utils.logger.error as jest.Mock).mock.calls.slice(errorCallsBefore);
    expect(newErrorCalls.some(call => String(call[0]).includes('flush failed'))).toBe(true);
    // A best-effort res.end() still runs even though the buffered write failed, so the
    // request doesn't hang open to the streaming timeout.
    expect(res.ended).toBe(true);
  });

  it('delivers a queue retained by a failed flush when res.end() arrives on a live socket', async () => {
    const res = mockRes();
    const realWrite = res.write.bind(res);
    let failNextWrite = false;
    res.write = (chunk: any) => {
      if (failNextWrite) { failNextWrite = false; throw new Error('socket hiccup'); }
      return realWrite(chunk);
    };

    let release: (v: any) => void = () => {};
    mockExecuteWebSearch.mockReturnValue(new Promise(r => { release = r; }));

    const req: any = { body: { stream: true, tools: [{ type: 'web_search' }], input: 'weather?' } };
    await before({ req, res, utils });

    const fc = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"q"}' };
    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: fc }));
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: fc }));
    // Arrives while the search is in flight, so it is queued behind the placeholder.
    res.write(sse({ type: 'response.output_item.added', output_index: 1, item: { type: 'reasoning', id: 'r_1' } }));

    // The flush this release triggers throws on its very first write: the queue is
    // deliberately retained for a later attempt, and endPending is false.
    failNextWrite = true;
    release(RESULTS);
    await settle();
    expect(res.written.join('')).toBe('');

    // Previously the fast path here closed the socket on top of the retained queue and
    // the whole body vanished with a clean stream close.
    res.end();

    const written = frames(res.written);
    expect(written.filter(f => f.type === 'response.output_item.added').map(f => f.item.type))
      .toEqual(['web_search_call', 'message', 'reasoning']);
    expect(res.ended).toBe(true);
  });

  it('substitutes a failed web_search_call for an item that never received output_item.done', async () => {
    const res = mockRes();
    const req: any = { body: { stream: true, tools: [{ type: 'web_search' }], input: 'weather?' } };
    await before({ req, res, utils });

    const fc = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"weather in Berlin"}' };
    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: fc }));

    // max_output_tokens hit mid-call: no .done ever arrives, the run just terminates.
    res.write(sse({
      type: 'response.incomplete',
      response: { id: 'resp_1', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [fc] },
    }));

    const terminal = frames(res.written).find(f => f.type === 'response.incomplete');
    // The item's own frames were suppressed, so the raw call must not survive here
    // either — Codex would see a web_search call with no output_item events at all.
    expect(terminal.response.output.some((i: any) => i.type === 'function_call')).toBe(false);
    expect(terminal.response.output.map((i: any) => i.type)).toEqual(['web_search_call', 'message']);
    expect(terminal.response.output[0].status).toBe('failed');
    expect(terminal.response.output[0].action.query).toBe('weather in Berlin');
    expect(mockExecuteWebSearch).not.toHaveBeenCalled();
  });

  it('takes the call_id from the .done frame when .added omitted it', async () => {
    const res = mockRes();
    const req: any = { body: { stream: true, tools: [{ type: 'web_search' }], input: 'weather?' } };
    await before({ req, res, utils });

    const added = { type: 'function_call', id: 'fc_1', name: 'web_search', arguments: '' };            // no call_id
    const done = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"q"}' };

    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: added }));
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: done }));
    await settle();

    res.write(sse({ type: 'response.completed', response: { id: 'resp_1', output: [done] } }));

    const completed = frames(res.written).find(f => f.type === 'response.completed');
    // Keyed on the fallback id, so the REAL result substitutes (status completed) rather
    // than the stranded-item placeholder, and no raw function_call leaks.
    expect(completed.response.output.map((i: any) => i.type)).toEqual(['web_search_call', 'message']);
    expect(completed.response.output[0].status).toBe('completed');
  });
});

describe('responsesWebSearchPlugin — streaming continuation', () => {
  beforeEach(() => {
    mockExecuteWebSearch.mockReset();
    mockExecuteWebSearch.mockResolvedValue(RESULTS);
    mockPost.mockReset();
    mockMaxSearches.mockReset();
    mockMaxSearches.mockReturnValue(3);
  });

  /** A request as responsesController hands it to the plugin on the streaming path. */
  function continuationReq(): any {
    return {
      body: { stream: true, input: 'node lts?', tools: [{ type: 'web_search' }] },
      __responsesUpstream: UPSTREAM(),
      __responsesExtraUsage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  const FC = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"node lts"}' };

  /** The first deployment call's frames, as the controller writes them through res.write. */
  function writeFirstCall(res: any, opts: { usage?: any; index?: number } = {}): void {
    const index = opts.index ?? 0;
    res.write(sse({ type: 'response.created', response: { id: 'resp_1' } }));
    res.write(sse({ type: 'response.output_item.added', output_index: index, item: FC }));
    res.write(sse({ type: 'response.output_item.done', output_index: index, item: FC }));
    res.write(sse({
      type: 'response.completed',
      response: { id: 'resp_1', output: [], usage: opts.usage ?? { input_tokens: 10, output_tokens: 2 } },
    }));
  }

  it('splices the continuation stream in place of the result dump', async () => {
    const res = mockRes();
    const req = continuationReq();
    mockPost.mockResolvedValue(upstreamStream([
      { type: 'response.created', response: { id: 'resp_2' } },
      { type: 'response.in_progress' },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_2' } },
      { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_2', delta: 'Node 22.' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_2' } },
      { type: 'response.completed', response: { id: 'resp_2', output: [{ type: 'message', id: 'msg_2' }], usage: { input_tokens: 40, output_tokens: 7 } } },
    ]));

    await before({ req, res, utils });
    writeFirstCall(res);
    await settleAll();

    const f = frames(res.written);
    const types = f.map(x => x.type);

    expect(types.filter(t => t === 'response.created')).toHaveLength(1);      // the continuation's is dropped
    expect(types.filter(t => t === 'response.in_progress')).toHaveLength(0);
    expect(types.filter(t => t === 'response.completed')).toHaveLength(1);    // only the continuation's
    expect(types).toContain('response.output_text.delta');

    const added = f.filter(x => x.type === 'response.output_item.added').map(x => x.item.type);
    expect(added).toEqual(['web_search_call', 'message']);
    // The pre-continuation result dump must NOT also be emitted: the model's answer replaces it.
    expect(f.some(x => x.type === 'response.output_text.delta' && String(x.delta).startsWith('Web search results for'))).toBe(false);

    const completed = f[f.length - 1];
    expect(completed.type).toBe('response.completed');
    expect(completed.response.output.map((i: any) => i.type)).toEqual(['web_search_call', 'message']);
    expect(completed.response.usage.input_tokens).toBe(50);                   // 10 + 40
    expect(completed.response.usage.output_tokens).toBe(9);                   // 2 + 7
  });

  it('POSTs the whole turn — original input, the suppressed function_call and its output — as a stream', async () => {
    const res = mockRes();
    const req = continuationReq();
    const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'gAAAAABm+/=abc', summary: [] };
    mockPost.mockResolvedValue(upstreamStream([
      { type: 'response.completed', response: { id: 'resp_2', output: [], usage: {} } },
    ]));

    await before({ req, res, utils });
    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: reasoning }));
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: reasoning }));
    res.write(sse({ type: 'response.output_item.added', output_index: 1, item: FC }));
    res.write(sse({ type: 'response.output_item.done', output_index: 1, item: FC }));
    res.write(sse({ type: 'response.completed', response: { id: 'resp_1', output: [], usage: {} } }));
    await settleAll();

    expect(mockPost).toHaveBeenCalledTimes(1);
    const [url, body, config] = mockPost.mock.calls[0] as any[];
    expect(url).toBe(UPSTREAM().url);
    expect(body.stream).toBe(true);
    expect(config.responseType).toBe('stream');
    expect(config.headers).toEqual(UPSTREAM().headers);

    expect(body.input.map((i: any) => i.type)).toEqual(['message', 'reasoning', 'function_call', 'function_call_output']);
    // Opaque fields survive byte-identical — a rewritten encrypted_content gets the whole
    // continuation rejected, and a rewritten call_id breaks the pairing below.
    expect(body.input[1].encrypted_content).toBe(reasoning.encrypted_content);
    expect(body.input[2].call_id).toBe('call_1');
    expect(body.input[3].call_id).toBe('call_1');
    expect(body.input[3].output).toContain('https://w.example/berlin');
    // The stashed payload is shared by reference — it must not have been mutated.
    expect(req.__responsesUpstream.payload.input).toBe('node lts?');
  });

  it('offsets continuation output_index past the items already sent', async () => {
    const res = mockRes();
    const req = continuationReq();
    mockPost.mockResolvedValue(upstreamStream([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm' } },
      { type: 'response.completed', response: { output: [], usage: {} } },
    ]));

    await before({ req, res, utils });
    writeFirstCall(res, { index: 2 });
    await settleAll();

    const added = frames(res.written).filter(x => x.type === 'response.output_item.added');
    expect(added.map(x => x.output_index)).toEqual([2, 3]);   // web_search_call at 2, continuation message after it
  });

  it('bills the continuation call onto __responsesExtraUsage, not the client frame only', async () => {
    const res = mockRes();
    const req = continuationReq();
    mockPost.mockResolvedValue(upstreamStream([
      { type: 'response.completed', response: { output: [], usage: { input_tokens: 40, output_tokens: 7 } } },
    ]));

    await before({ req, res, utils });
    writeFirstCall(res);
    await settleAll();

    // The FIRST call's tokens are read off the captured raw stream by responsesController,
    // so only the continuation's belong here — double counting them is a billing bug.
    expect(req.__responsesExtraUsage).toEqual({
      input_tokens: 40, output_tokens: 7, cache_creation_tokens: 0, cache_read_tokens: 0,
    });
  });

  it('resolves the idle hook only once the continuation has finished writing', async () => {
    const res = mockRes();
    const req = continuationReq();
    let releasePost: (v: any) => void = () => {};
    mockPost.mockReturnValue(new Promise(r => { releasePost = r; }));

    await before({ req, res, utils });
    writeFirstCall(res);
    await settle();

    let idle = false;
    void (res as any).__responsesWebSearchIdle().then(() => { idle = true; });
    await settle();
    expect(idle).toBe(false);                                // the continuation is still open

    releasePost(upstreamStream([{ type: 'response.completed', response: { output: [], usage: {} } }]));
    await settleAll();
    expect(idle).toBe(true);
  });

  it('falls back to the result message when the continuation call fails', async () => {
    const res = mockRes();
    const req = continuationReq();
    mockPost.mockRejectedValue(new Error('deployment 500'));

    await before({ req, res, utils });
    writeFirstCall(res);
    res.end();                                               // as responsesController does once the stream is over
    await settleAll();

    const f = frames(res.written);
    expect(f.some(x => x.type === 'response.output_text.delta' && String(x.delta).startsWith('Web search results for'))).toBe(true);
    expect(f.filter(x => x.type === 'response.completed')).toHaveLength(1);
    const completed = f[f.length - 1];
    expect(completed.response.output.map((i: any) => i.type)).toEqual(['web_search_call', 'message']);
    expect(res.ended).toBe(true);
  });

  it('never leaves the stream open when the continuation rejects', async () => {
    const res = mockRes();
    const req = continuationReq();
    mockPost.mockRejectedValue(new Error('boom'));

    await before({ req, res, utils });
    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: FC }));
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: FC }));
    res.end();                                               // no terminal frame ever arrives
    await settleAll();

    expect(res.ended).toBe(true);
  });

  it('runs a second round when the continuation itself calls web_search', async () => {
    const res = mockRes();
    const req = continuationReq();
    const fc2 = { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'web_search', arguments: '{"query":"node 22 release date"}' };
    mockPost
      .mockResolvedValueOnce(upstreamStream([
        { type: 'response.output_item.added', output_index: 0, item: fc2 },
        { type: 'response.output_item.done', output_index: 0, item: fc2 },
        { type: 'response.completed', response: { id: 'resp_2', output: [], usage: { input_tokens: 40, output_tokens: 7 } } },
      ]))
      .mockResolvedValueOnce(upstreamStream([
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_3' } },
        { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_3', delta: 'Node 22.' },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_3' } },
        { type: 'response.completed', response: { id: 'resp_3', output: [{ type: 'message', id: 'msg_3' }], usage: { input_tokens: 60, output_tokens: 5 } } },
      ]));

    await before({ req, res, utils });
    writeFirstCall(res);
    await settleAll();

    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(mockExecuteWebSearch).toHaveBeenCalledTimes(2);
    // The second round's function_call must have reached the deployment paired with its output.
    const secondInput = (mockPost.mock.calls[1] as any[])[1].input;
    expect(secondInput.filter((i: any) => i.type === 'function_call_output').map((i: any) => i.call_id)).toEqual(['call_1', 'call_2']);

    const f = frames(res.written);
    expect(f.filter(x => x.type === 'response.completed')).toHaveLength(1);
    expect(f.filter(x => x.type === 'response.output_item.added').map(x => x.item.type))
      .toEqual(['web_search_call', 'web_search_call', 'message']);
    const completed = f[f.length - 1];
    expect(completed.response.output.map((i: any) => i.type)).toEqual(['web_search_call', 'web_search_call', 'message']);
    expect(completed.response.usage.input_tokens).toBe(110);                 // 10 + 40 + 60
    expect(req.__responsesExtraUsage).toEqual({
      input_tokens: 100, output_tokens: 12, cache_creation_tokens: 0, cache_read_tokens: 0,
    });
  });

  it('stops at the configured cap and hands the client the results instead of a further call', async () => {
    mockMaxSearches.mockReturnValue(1);
    const res = mockRes();
    const req = continuationReq();
    const fc2 = { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'web_search', arguments: '{"query":"again"}' };
    mockPost.mockResolvedValue(upstreamStream([
      { type: 'response.output_item.added', output_index: 0, item: fc2 },
      { type: 'response.output_item.done', output_index: 0, item: fc2 },
      { type: 'response.completed', response: { id: 'resp_2', output: [], usage: {} } },
    ]));

    await before({ req, res, utils });
    writeFirstCall(res);
    await settleAll();

    expect(mockPost).toHaveBeenCalledTimes(1);               // no second continuation past the cap
    expect(mockExecuteWebSearch).toHaveBeenCalledTimes(1);   // and no second search either

    const f = frames(res.written);
    expect(f.filter(x => x.type === 'response.completed')).toHaveLength(1);
    // The capped call still gets client-facing items, so it is never an item with no events.
    expect(f.filter(x => x.type === 'response.output_item.added').map(x => x.item.type))
      .toEqual(['web_search_call', 'web_search_call', 'message']);
    const capped = f.filter(x => x.type === 'response.output_item.done' && x.item.type === 'web_search_call').pop();
    expect(capped.item.status).toBe('failed');
    // Task 2 fix round 2: the capped call's dump must name the budget as the reason, never
    // read as though the search ran and found nothing. Fix round 4: this dump is USER-facing
    // (rendered verbatim as the assistant's message on this no-continuation path), so its
    // text is the plain statement `FAILURE_MESSAGES.cap_reached.user` in
    // webSearch/descriptor.ts, not the model-facing instruction `renderOutput` sends.
    expect(frames(res.written).some(x => x.type === 'response.output_text.delta'
      && String(x.delta).startsWith("This turn's web-search budget was used up"))).toBe(true);
    // No model-facing imperative may leak into what the user reads.
    expect(frames(res.written).some(x => x.type === 'response.output_text.delta'
      && /do not tell the user/i.test(String(x.delta)))).toBe(false);
  });

  it('stops the loop when it outlives the idle budget the controller allows it', async () => {
    // responsesController gives the WHOLE splice one getTimeout(true) idle budget — the
    // same value it stashes as `timeoutMs` — while the loop's own ceiling is
    // max_searches_per_request rounds of (search + per-stream watchdog), tens of minutes.
    // When the controller's clock expired first it emitted usage counting only the rounds
    // finished by then and called res.end(), which the interceptor defers while busy: the
    // client held a stalled-but-open socket and the later rounds' tokens landed in an
    // accumulator nobody read again. One clock, checked at the top of each round.
    //
    // Time is moved by hand rather than by real delays: the same `timeoutMs` also arms the
    // per-stream watchdog, so a budget small enough to expire on its own would race it.
    const realNow = Date.now.bind(Date);
    let offsetMs = 0;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offsetMs);
    try {
      const res = mockRes();
      const req = continuationReq();                          // timeoutMs: 5000
      const fc2 = { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'web_search', arguments: '{"query":"again"}' };
      let searches = 0;
      mockExecuteWebSearch.mockImplementation(async () => {
        searches += 1;
        if (searches > 1) offsetMs += 6000;                   // this round's search overran the budget
        return RESULTS;
      });
      mockPost.mockResolvedValue(upstreamStream([
        { type: 'response.output_item.added', output_index: 0, item: fc2 },
        { type: 'response.output_item.done', output_index: 0, item: fc2 },
        { type: 'response.completed', response: { id: 'resp_2', output: [], usage: { input_tokens: 40, output_tokens: 7 } } },
      ]));

      await before({ req, res, utils });
      writeFirstCall(res);
      await settleAll();

      // Round 2 asked for another search and the cap (3) would have allowed it — only the
      // deadline stopped a third deployment call from being opened.
      expect(mockExecuteWebSearch).toHaveBeenCalledTimes(2);
      expect(mockPost).toHaveBeenCalledTimes(1);

      // And the turn is CLOSED, not left stalled: one terminal frame, the results in hand
      // delivered, the socket free to be ended by the deferred res.end.
      const f = frames(res.written);
      expect(f.filter(x => x.type === 'response.completed')).toHaveLength(1);
      expect(f[f.length - 1].type).toBe('response.completed');
      expect(f[f.length - 1].response.output.map((i: any) => i.type))
        .toEqual(['web_search_call', 'web_search_call', 'message']);
      expect(f.some(x => x.type === 'response.output_text.delta' && String(x.delta).startsWith('Web search results for'))).toBe(true);
      res.end();
      await settleAll();
      expect(res.ended).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('closes the turn with a synthesized terminal when the continuation stream dies without one', async () => {
    const res = mockRes();
    const req = continuationReq();
    mockPost.mockResolvedValue(upstreamStream([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_2' } },
    ]));                                                     // no terminal frame at all

    await before({ req, res, utils });
    writeFirstCall(res);
    await settleAll();

    const f = frames(res.written);
    // The first call's terminal was swallowed, so one has to be put back or the client hangs.
    expect(f.filter(x => x.type === 'response.completed')).toHaveLength(1);
    // ...but a web_search_call and an empty terminal is nothing at all: no answer and no
    // results either, strictly worse than the dump this feature replaced. The dump the
    // commit withheld for an answer that never came is handed over after the fact, with
    // its output_item events, and named in the terminal frame right behind its own
    // web_search_call.
    expect(f[f.length - 1].response.output.map((i: any) => i.type)).toEqual(['web_search_call', 'message']);
    expect(f.some(x => x.type === 'response.output_text.delta' && String(x.delta).startsWith('Web search results for'))).toBe(true);
    const dump = f[f.length - 1].response.output[1];
    expect(dump.content[0].annotations[0].url).toBe('https://w.example/berlin');
    // The dump arrives with its own output_item events, behind the continuation's
    // half-streamed item (an output_item.added with no .done and no text — which is why
    // the client counts as empty-handed here).
    expect(f.filter(x => x.type === 'response.output_item.added').map(x => x.item.type))
      .toEqual(['web_search_call', 'message', 'message']);
    expect(f.filter(x => x.type === 'response.output_item.done').map(x => x.item.type))
      .toEqual(['web_search_call', 'message']);
  });

  it('does not repeat the withheld dump when the dead continuation did stream items', async () => {
    // The counterpart of the test above: the continuation died without a terminal frame,
    // but it had already produced a message, so the client is NOT empty-handed and the
    // dump would be a redundant second assistant message in front of the partial answer.
    const res = mockRes();
    const req = continuationReq();
    mockPost.mockResolvedValue(upstreamStream([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_2' } },
      { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_2', delta: 'Node 22.' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_2' } },
    ]));

    await before({ req, res, utils });
    writeFirstCall(res);
    await settleAll();

    const f = frames(res.written);
    expect(f[f.length - 1].response.output.map((i: any) => i.type)).toEqual(['web_search_call', 'message']);
    expect(f.some(x => x.type === 'response.output_text.delta' && String(x.delta).startsWith('Web search results for'))).toBe(false);
    expect(f.some(x => x.delta === 'Node 22.')).toBe(true);
  });

  it('continues a stream that ended without a terminal frame, once res.end arrives', async () => {
    const res = mockRes();
    const req = continuationReq();
    mockPost.mockResolvedValue(upstreamStream([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_2' } },
      { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_2', delta: 'Node 22.' },
      { type: 'response.completed', response: { id: 'resp_2', output: [{ type: 'message', id: 'msg_2' }], usage: {} } },
    ]));

    await before({ req, res, utils });
    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: FC }));
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: FC }));
    await settle();                                          // the search resolves first...
    expect(mockPost).not.toHaveBeenCalled();                 // ...but the turn isn't over yet
    res.end();                                               // no terminal frame ever arrived
    await settleAll();

    expect(mockPost).toHaveBeenCalledTimes(1);
    const f = frames(res.written);
    expect(f.some(x => x.type === 'response.output_text.delta' && x.delta === 'Node 22.')).toBe(true);
    expect(f.filter(x => x.type === 'response.completed')).toHaveLength(1);
    expect(res.ended).toBe(true);
  });

  it('does not continue past an .incomplete terminal, and streams the result dump instead', async () => {
    // max_output_tokens hit mid-turn is exactly what .incomplete means, and Codex sets
    // max_output_tokens on every request. Continuing here would put frames AFTER the
    // client's terminal frame and pay for a deployment call nobody is billed for.
    const res = mockRes();
    const req = continuationReq();
    mockPost.mockResolvedValue(upstreamStream([
      { type: 'response.completed', response: { output: [], usage: {} } },
    ]));

    await before({ req, res, utils });
    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: FC }));
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: FC }));
    await settle();
    res.write(sse({
      type: 'response.incomplete',
      response: { id: 'resp_1', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [FC] },
    }));
    res.end();
    await settleAll();

    expect(mockPost).not.toHaveBeenCalled();

    const f = frames(res.written);
    const terminals = f.filter(x => x.type === 'response.completed' || x.type === 'response.incomplete');
    expect(terminals).toHaveLength(1);
    expect(terminals[0].type).toBe('response.incomplete');
    expect(f[f.length - 1].type).toBe('response.incomplete');          // nothing follows the terminal

    // The dump the continuation branch withheld is streamed after all, so the message
    // named in response.output is not an item with no output_item events.
    expect(f.map(x => x.type)).toContain('response.content_part.added');
    expect(f.some(x => x.type === 'response.output_text.delta' && String(x.delta).startsWith('Web search results for'))).toBe(true);
    expect(f.filter(x => x.type === 'response.output_item.added').map(x => x.item.type)).toEqual(['web_search_call', 'message']);
    expect(terminals[0].response.output.map((i: any) => i.type)).toEqual(['web_search_call', 'message']);
  });

  it('starts the continuation on the upstream-end signal, so its tokens are billed', async () => {
    // A stream that ends with no terminal frame has neither a held terminal nor a
    // deferred res.end when the controller first asks whether the plugin is idle.
    const res = mockRes();
    const req = continuationReq();
    mockPost.mockResolvedValue(upstreamStream([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_2' } },
      { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_2', delta: 'Node 22.' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_2' } },
      { type: 'response.completed', response: { output: [], usage: { input_tokens: 40, output_tokens: 7 } } },
    ]));

    await before({ req, res, utils });
    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: FC }));
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: FC }));
    await settle();                                          // the search resolves; no terminal frame arrives

    // Exactly what responsesController does on the upstream stream's 'end' event.
    await awaitResponsesStreamIdle(res, 5000);

    // Both must already be true when the controller folds usage and emits the event.
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(req.__responsesExtraUsage).toEqual({
      input_tokens: 40, output_tokens: 7, cache_creation_tokens: 0, cache_read_tokens: 0,
    });
    expect(frames(res.written).some(x => x.delta === 'Node 22.')).toBe(true);

    res.end();
    expect(res.ended).toBe(true);
  });

  it('does not open a continuation for a client that has disconnected', async () => {
    const res = mockRes();
    const req = continuationReq();
    mockPost.mockResolvedValue(upstreamStream([
      { type: 'response.completed', response: { output: [], usage: {} } },
    ]));

    await before({ req, res, utils });
    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: FC }));
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: FC }));
    abortResponsesStreamContinuation(res);                   // req 'close' — Codex aborted the turn
    res.write(sse({ type: 'response.completed', response: { output: [FC], usage: {} } }));
    res.end();
    await settleAll();

    expect(mockPost).not.toHaveBeenCalled();
    // The turn still closes cleanly, with the results the search already paid for.
    const f = frames(res.written);
    expect(f.filter(x => x.type === 'response.completed')).toHaveLength(1);
    expect(f.filter(x => x.type === 'response.output_item.added').map(x => x.item.type)).toEqual(['web_search_call', 'message']);
    expect(res.ended).toBe(true);
  });

  it('destroys an in-flight continuation stream when the client disconnects', async () => {
    const res = mockRes();
    const req = continuationReq();
    const live = new PassThrough();
    mockPost.mockResolvedValue({ data: live });

    await before({ req, res, utils });
    writeFirstCall(res);
    res.end();
    await settleAll();

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(live.destroyed).toBe(false);                       // still streaming
    expect(res.ended).toBe(false);                            // and the response is still open

    abortResponsesStreamContinuation(res);
    await settleAll();

    expect(live.destroyed).toBe(true);
    expect(mockPost).toHaveBeenCalledTimes(1);                // no further round is started
    expect(res.ended).toBe(true);                             // the deferred end still runs
  });

  it('destroys a continuation body that arrives after the client has gone', async () => {
    // The abort can land while the POST is still in flight, when there is no stream yet
    // to destroy — the body would otherwise be drained in full for nobody.
    const res = mockRes();
    const req = continuationReq();
    const live = new PassThrough();
    let releasePost: (v: any) => void = () => {};
    mockPost.mockReturnValue(new Promise(r => { releasePost = r; }));

    await before({ req, res, utils });
    writeFirstCall(res);
    res.end();
    await settleAll();

    expect(mockPost).toHaveBeenCalledTimes(1);
    abortResponsesStreamContinuation(res);                   // nothing active to destroy yet
    releasePost({ data: live });
    await settleAll();

    expect(live.destroyed).toBe(true);
    expect(res.ended).toBe(true);
  });

  it('interleaves each withheld dump with its own web_search_call on a closing terminal', async () => {
    const releases: Record<string, (v: any) => void> = {};
    mockExecuteWebSearch.mockImplementation((query: string) => new Promise(r => { releases[query] = r; }));

    const res = mockRes();
    const req = continuationReq();
    const fc0 = { type: 'function_call', id: 'fc_0', call_id: 'call_0', name: 'web_search', arguments: '{"query":"q0"}' };
    const fc1 = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"q1"}' };

    await before({ req, res, utils });
    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: fc0 }));
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: fc0 }));
    res.write(sse({ type: 'response.output_item.added', output_index: 1, item: fc1 }));
    res.write(sse({ type: 'response.output_item.done', output_index: 1, item: fc1 }));
    res.write(sse({
      type: 'response.incomplete',
      response: { id: 'resp_1', status: 'incomplete', output: [fc0, fc1] },
    }));
    res.end();

    releases['q0'](RESULTS);
    releases['q1'](RESULTS);
    await settleAll();

    expect(mockPost).not.toHaveBeenCalled();
    // Each index's web_search_call and its result message stay together, rather than both
    // dumps arriving in one lump after both pairs.
    const orderedIndices = frames(res.written)
      .filter(f => typeof f.output_index === 'number')
      .map(f => f.output_index);
    expect(orderedIndices).toEqual([...Array(8).fill(0), ...Array(8).fill(1)]);

    const f = frames(res.written);
    expect(f.filter(x => x.type === 'response.incomplete')).toHaveLength(1);
    expect(f[f.length - 1].type).toBe('response.incomplete');
  });

  it('keeps items the dead continuation already streamed in the synthesized terminal', async () => {
    const res = mockRes();
    const req = continuationReq();
    mockPost.mockResolvedValue(upstreamStream([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_2' } },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_2' } },
    ]));                                                      // items, then the stream dies

    await before({ req, res, utils });
    writeFirstCall(res);
    await settleAll();

    const written = frames(res.written);
    const completed = written[written.length - 1];
    expect(completed.type).toBe('response.completed');
    // The message reached the client as output_item events, so it has to be in the array too.
    expect(completed.response.output.map((i: any) => i.type)).toEqual(['web_search_call', 'message']);
  });

  it('leaves a request with no upstream context on the pre-continuation path', async () => {
    const res = mockRes();
    const req: any = { body: { stream: true, input: 'q', tools: [{ type: 'web_search' }] } };

    await before({ req, res, utils });
    writeFirstCall(res);
    await settleAll();

    expect(mockPost).not.toHaveBeenCalled();
    const f = frames(res.written);
    expect(f.filter(x => x.type === 'response.output_item.added').map(x => x.item.type)).toEqual(['web_search_call', 'message']);
    expect(f.filter(x => x.type === 'response.completed')).toHaveLength(1);
  });
});
