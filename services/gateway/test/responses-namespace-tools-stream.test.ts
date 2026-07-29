import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockMode = jest.fn<() => string>();
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: { getNamespaceToolMode: () => mockMode() },
  getNamespaceToolMode: () => mockMode(),
}));

import pluginRules = require('../src/plugins/responsesNamespaceToolsPlugin');

const before = (pluginRules as any[]).find(r => r.strategy === 'before').handler;
const utils = { logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() } };

const fn = (name: string) => ({ type: 'function', name, parameters: { type: 'object', properties: {} }, strict: false });
const NS = { type: 'namespace', name: 'multi_agent_v1', tools: [fn('spawn_agent')] };
const sse = (o: any) => `data: ${JSON.stringify(o)}\n\n`;

function mockRes() {
  const written: string[] = [];
  return {
    written,
    write(c: any) { written.push(c.toString()); return true; },
    end() { return this as any; },
    on() { return this as any; },
  } as any;
}

const frames = (w: string[]) => w.join('').split('\n\n').map(b => b.trim())
  .filter(b => b.startsWith('data: ')).map(b => JSON.parse(b.slice(6)));

describe('responsesNamespaceToolsPlugin — streaming', () => {
  beforeEach(() => { mockMode.mockReset(); mockMode.mockReturnValue('flatten'); });

  async function streamingReq(res: any) {
    const req: any = { body: { stream: true, tools: [fn('exec_command'), { ...NS }] } };
    await before({ req, res, utils });
    return req;
  }

  it('adds the namespace to the function_call in added, done and the terminal frame', async () => {
    const res = mockRes();
    await streamingReq(res);
    const call = { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'spawn_agent', arguments: '{"task":"x"}' };

    res.write(sse({ type: 'response.created', response: { id: 'r1' } }));
    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } }));
    res.write(sse({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"task":"x"}' }));
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: { ...call } }));
    res.write(sse({ type: 'response.completed', response: { id: 'r1', output: [{ ...call }], usage: {} } }));

    const f = frames(res.written);
    const added = f.find(x => x.type === 'response.output_item.added');
    const done = f.find(x => x.type === 'response.output_item.done');
    const completed = f.find(x => x.type === 'response.completed');

    expect(added.item.namespace).toBe('multi_agent_v1');
    expect(done.item.namespace).toBe('multi_agent_v1');
    expect(completed.response.output[0].namespace).toBe('multi_agent_v1');
  });

  it('leaves frames for non-namespaced tools byte-identical', async () => {
    const res = mockRes();
    await streamingReq(res);
    const raw = sse({ type: 'response.output_item.added', output_index: 0,
      item: { type: 'function_call', id: 'fc_2', call_id: 'c2', name: 'exec_command', arguments: '{}' } });

    res.write(raw);

    expect(res.written.join('')).toBe(raw);
  });

  it('passes an unrelated frame through byte-identical', async () => {
    const res = mockRes();
    await streamingReq(res);
    const raw = sse({ type: 'response.output_text.delta', output_index: 0, delta: 'hello' });

    res.write(raw);

    expect(res.written.join('')).toBe(raw);
  });

  it('reassembles a frame split across chunk boundaries', async () => {
    const res = mockRes();
    await streamingReq(res);
    const block = sse({ type: 'response.output_item.done', output_index: 0,
      item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'spawn_agent', arguments: '{}' } });

    res.write(block.slice(0, 30));
    res.write(block.slice(30));

    expect(frames(res.written)[0].item.namespace).toBe('multi_agent_v1');
  });

  // `frames()` above joins and re-splits on \n\n, so it cannot see damage to a non-`data:`
  // line. This asserts on the raw written string instead — preserving `event:`/`id:` lines
  // through a rewrite is the whole point of rebuildBlockWithSubstitution.
  it('preserves event: and id: lines on a frame it rewrites', async () => {
    const res = mockRes();
    await streamingReq(res);
    const frame = { type: 'response.output_item.done', output_index: 0,
      item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'spawn_agent', arguments: '{}' } };
    const block = `event: response.output_item.done\nid: 42\ndata: ${JSON.stringify(frame)}\n\n`;

    res.write(block);

    const out: string = res.written.join('');
    expect(out).not.toBe(block);                                  // it really was rewritten
    expect(out.startsWith('event: response.output_item.done\nid: 42\ndata: ')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(true);
    const dataLine = out.split('\n').find((l: string) => l.startsWith('data: '))!;
    expect(JSON.parse(dataLine.slice(6)).item.namespace).toBe('multi_agent_v1');
  });

  it('re-nests .incomplete and .failed terminals and leaves an unmapped sibling call alone', async () => {
    for (const type of ['response.incomplete', 'response.failed']) {
      const res = mockRes();
      await streamingReq(res);

      res.write(sse({ type, response: { id: 'r1', output: [
        { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'spawn_agent', arguments: '{}' },
        { type: 'function_call', id: 'fc_2', call_id: 'c2', name: 'exec_command', arguments: '{}' },
        { type: 'reasoning', id: 'rs_1' },
      ] } }));

      const out = frames(res.written)[0];
      expect(out.type).toBe(type);
      expect(out.response.output[0].namespace).toBe('multi_agent_v1');
      expect('namespace' in out.response.output[1]).toBe(false);
      expect(out.response.output[2]).toEqual({ type: 'reasoning', id: 'rs_1' });
    }
  });

  it('flushes and re-nests an unterminated final block on res.end', async () => {
    const res = mockRes();
    await streamingReq(res);
    const block = sse({ type: 'response.output_item.done', output_index: 0,
      item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'spawn_agent', arguments: '{}' } });

    res.write(block.slice(0, -2));                                // everything but the \n\n
    expect(res.written).toHaveLength(0);                          // held back as a partial

    res.end();

    expect(res.written).toHaveLength(1);
    expect(frames(res.written)[0].item.namespace).toBe('multi_agent_v1');
  });

  it('keeps the stream alive when the downstream write throws, and never emits a headless block', async () => {
    const res = mockRes();
    const attempts: string[] = [];
    // The layer below is gone. Every attempt is still recorded, so what the fallback
    // would have put on the wire is observable.
    res.write = (c: any) => { attempts.push(c.toString()); throw new Error('socket destroyed'); };
    await streamingReq(res);
    const block = sse({ type: 'response.output_item.done', output_index: 0,
      item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'spawn_agent', arguments: '{}' } });
    const errorsBefore = (utils.logger.error as any).mock.calls.length;

    // Split so a partial block is held back first: the fallback owes the stream
    // `carried + chunk`, never the chunk alone — that would be a block with its head
    // missing, which is corruption rather than a drop.
    res.write(block.slice(0, 20));
    expect(() => res.write(block.slice(20))).not.toThrow();
    expect(res.write(block)).toBe(true);                          // and keeps reporting success
    expect(() => res.end()).not.toThrow();

    expect(attempts.length).toBeGreaterThan(0);
    for (const attempt of attempts) expect(attempt.startsWith('data: ')).toBe(true);
    expect((utils.logger.error as any).mock.calls.length).toBeGreaterThan(errorsBefore);
  });

  // pseudonymizationPlugin's interceptor sits directly below this one and deliberately pops
  // the write callback so "it must fire even when we buffer". This interceptor must not
  // swallow the argument before it ever gets there.
  it('forwards a write callback exactly once, and fires it while buffering a partial block', async () => {
    const res = mockRes();
    const seen: any[][] = [];
    res.write = (_c: any, ...rest: any[]) => { seen.push(rest); return true; };
    await streamingReq(res);
    const a = sse({ type: 'response.output_text.delta', output_index: 0, delta: 'a' });
    const b = sse({ type: 'response.output_text.delta', output_index: 0, delta: 'b' });

    const cb1 = jest.fn();
    res.write(a + b, cb1);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual([]);                                  // not on the first block
    expect(seen[1]).toEqual([cb1]);                               // once, on the last

    const cb2 = jest.fn();
    res.write(a.slice(0, 10), cb2);                               // held back entirely

    expect(seen).toHaveLength(2);                                 // nothing handed down
    expect(cb2).toHaveBeenCalledTimes(1);                         // but the callback still fired
  });

  it('does not install an interceptor for a non-streaming request', async () => {
    const res = mockRes();
    const original = res.write;
    const req: any = { body: { stream: false, tools: [{ ...NS }] } };

    await before({ req, res, utils });

    expect(res.write).toBe(original);
  });

  it('does not install an interceptor when there is no namespace tool', async () => {
    const res = mockRes();
    const original = res.write;
    const req: any = { body: { stream: true, tools: [fn('exec_command')] } };

    await before({ req, res, utils });

    expect(res.write).toBe(original);
  });
});
