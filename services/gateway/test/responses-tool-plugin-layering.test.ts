/**
 * The two Responses tool plugins, driven together in the shipped hook order.
 *
 * THE HEADLINE, because it looks like a mistake and is not: the two hook arrays ship in
 * OPPOSITE orders, deliberately.
 *
 *   defaultHooks.openai.responses-stream : pseudonymization -> namespace -> web-search
 *   defaultHooks.openai.responses        : pseudonymization -> web-search -> namespace
 *
 * They must disagree because two different mechanisms consume them, and the two mechanisms
 * walk the array in opposite directions:
 *
 *   - `res.write` interceptors (streaming). Each `before` handler patches `res.write` and
 *     binds its `originalWrite` at install time, so the LAST installed is OUTERMOST and
 *     nests the earlier ones inside it. Anything an outer interceptor GENERATES itself
 *     never passes through the layers above it — and responsesWebSearchPlugin generates
 *     plenty: a continuation round's frames are parsed off its own POST body, never off
 *     `res.write`. So the namespace layer has to install FIRST (earlier in the array) to
 *     end up UNDERNEATH web-search and see those generated frames.
 *
 *   - the after-handler chain (non-streaming). `executeAfterPlugins`
 *     (src/services/pluginExecutor.ts) walks the array IN ORDER, feeding each handler the
 *     previous one's return value. `responsesWebSearchPlugin`'s after handler returns
 *     `{...current, output: [...clientItems, ...finalOutput]}` where `finalOutput` comes
 *     from the continuation POST's response — content the namespace handler never saw. So
 *     the namespace handler has to run LAST (later in the array) to see it.
 *
 * Same requirement — "the namespace layer must observe what web-search produced" — and
 * inverted array positions, because inside-out nesting and in-order chaining are opposites.
 * Making the two arrays agree reintroduces one of the two bugs: a `spawn_agent` call the
 * model makes in a continuation round reaches Codex with no `namespace`, and
 * `codex_core::tools::router` refuses it — `unsupported call: spawn_agent`, the exact
 * silent failure the namespace plugin exists to prevent.
 *
 * These tests pin both directions by behavior rather than by config shape
 * (responses-hooks-config.test.ts covers the config shape), and they READ the order out of
 * the shipped config rather than restating it, so either array being "tidied" into
 * agreement with the other fails here.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';

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
const mockMode = jest.fn<() => string>();
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getWebSearchMaxSearches: () => mockMaxSearches(),
    getNamespaceToolMode: () => mockMode(),
  },
  getNamespaceToolMode: () => mockMode(),
}));

import webSearchRules = require('../src/plugins/responsesWebSearchPlugin');
import namespaceRules = require('../src/plugins/responsesNamespaceToolsPlugin');

const webSearchBefore = (webSearchRules as any[]).find(r => r.strategy === 'before').handler;
const namespaceBefore = (namespaceRules as any[]).find(r => r.strategy === 'before').handler;
const webSearchAfter = (webSearchRules as any[]).find(r => r.strategy === 'after').handler;
const namespaceAfter = (namespaceRules as any[]).find(r => r.strategy === 'after').handler;

const utils = { logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() } };
const RESULTS = [{ title: 'Node releases', url: 'https://n.example/lts', snippet: 'LTS', content: 'Node 22 is LTS' }];

const fn = (name: string) => ({ type: 'function', name, parameters: { type: 'object', properties: {} }, strict: false });
const NS = { type: 'namespace', name: 'multi_agent_v1', tools: [fn('spawn_agent'), fn('close_agent')] };

function mockRes(): any {
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
  };
}

function frames(written: string[]): any[] {
  return written.join('')
    .split('\n\n')
    .map(b => b.trim())
    .filter(b => b.length > 0)
    .map(b => b.split('\n').find(l => l.startsWith('data: ')))
    .filter((line): line is string => typeof line === 'string')
    .map(line => JSON.parse(line.slice(6)));
}

const sse = (obj: any): string => `data: ${JSON.stringify(obj)}\n\n`;
const settleAll = (): Promise<unknown> => new Promise(r => setTimeout(r, 20));

function upstreamStream(fs: any[]): any {
  return { data: Readable.from(fs.map(f => `data: ${JSON.stringify(f)}\n\n`)) };
}

/**
 * A Codex turn exactly as the 400 that started this branch enumerates it: the hosted
 * web_search tool AND the namespace wrapper in the same request.
 */
function toolTurnReq(): any {
  return {
    body: {
      stream: true,
      input: 'node lts?',
      tools: [{ type: 'web_search' }, fn('exec_command'), JSON.parse(JSON.stringify(NS))],
    },
    __responsesUpstream: {
      url: 'https://sap.example/d1/responses',
      headers: { Authorization: 'Bearer t' },
      timeoutMs: 5000,
      payload: { model: 'm', input: 'node lts?', stream: true },
    },
    __responsesExtraUsage: { input_tokens: 0, output_tokens: 0 },
  };
}

/**
 * The order is READ FROM THE SHIPPED CONFIG rather than hard-coded, so these tests fail if
 * either hook array is ever reordered — the config is the only place the order is
 * expressed, and a test that restated it would pass happily while the running gateway did
 * the wrong thing.
 */
const apiConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'api_config.json'), 'utf-8'));
const hookIds = (subpath: string): string[] => (apiConfig.api_config.defaultHooks.openai[subpath] as any[])
  .map(entry => entry?.request?.callback?.id)
  .filter((id: unknown): id is string => typeof id === 'string');

const STREAM_HOOK_IDS = hookIds('responses-stream');
const NON_STREAM_HOOK_IDS = hookIds('responses');

const BEFORE_HANDLERS: Record<string, (ctx: any) => Promise<any>> = {
  responsesWebSearchPlugin: webSearchBefore,
  responsesNamespaceToolsPlugin: namespaceBefore,
};

const AFTER_HANDLERS: Record<string, (ctx: any) => Promise<any>> = {
  responsesWebSearchPlugin: webSearchAfter,
  responsesNamespaceToolsPlugin: namespaceAfter,
};

/**
 * Run the before handlers in the shipped hook-array order. pseudonymizationPlugin sits at
 * index 0 and is not modelled here — it patches res.write innermost, and nothing these
 * tests assert on depends on the unmasker.
 */
async function installInShippedOrder(req: any, res: any): Promise<void> {
  for (const id of STREAM_HOOK_IDS) {
    const handler = BEFORE_HANDLERS[id];
    if (handler) await handler({ req, res, utils });
  }
}

const WEB_SEARCH_CALL = {
  type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"node lts"}',
};

/** The first deployment call: one web_search, then the terminal that triggers the continuation. */
function writeFirstCall(res: any): void {
  res.write(sse({ type: 'response.created', response: { id: 'resp_1' } }));
  res.write(sse({ type: 'response.output_item.added', output_index: 0, item: WEB_SEARCH_CALL }));
  res.write(sse({ type: 'response.output_item.done', output_index: 0, item: WEB_SEARCH_CALL }));
  res.write(sse({
    type: 'response.completed',
    response: { id: 'resp_1', output: [], usage: { input_tokens: 10, output_tokens: 2 } },
  }));
}

describe('Responses tool plugins — shipped layering (streaming: res.write interceptors nest inside-out)', () => {
  beforeEach(() => {
    mockExecuteWebSearch.mockReset();
    mockExecuteWebSearch.mockResolvedValue(RESULTS);
    mockPost.mockReset();
    mockMaxSearches.mockReset();
    mockMaxSearches.mockReturnValue(3);
    mockMode.mockReset();
    mockMode.mockReturnValue('flatten');
  });

  it('keeps masking innermost on BOTH subpaths — the one constraint that never moves', () => {
    for (const subpath of ['responses', 'responses-stream']) {
      expect(hookIds(subpath)[0]).toBe('pseudonymizationPlugin');
    }
  });

  // The three tests below are deliberately NOT a loop over the two subpaths. They used to
  // be, asserting `ns < ws` for both, and that is exactly how the non-streaming regression
  // was shipped: the assertion is true of one array and false of the other, on purpose.
  it('responses-stream lists namespace BEFORE web-search so the namespace write-interceptor installs first and ends up NESTED INSIDE web-search, which generates frames of its own', () => {
    const ids = hookIds('responses-stream');
    expect(ids.indexOf('responsesNamespaceToolsPlugin'))
      .toBeLessThan(ids.indexOf('responsesWebSearchPlugin'));
  });

  it('responses lists namespace AFTER web-search because after-handlers chain IN ARRAY ORDER, and the namespace handler must receive the output web-search rebuilt from its continuation POST', () => {
    const ids = hookIds('responses');
    expect(ids.indexOf('responsesNamespaceToolsPlugin'))
      .toBeGreaterThan(ids.indexOf('responsesWebSearchPlugin'));
  });

  /**
   * A guard against the specific "tidy-up" that caused this: the two arrays disagreeing
   * reads as an oversight, and making them agree silently breaks one of the two routes.
   * Whichever way they are made to agree, this fails and says why.
   */
  it('requires the two arrays to DISAGREE — inside-out interceptor nesting and in-order after-chaining are opposites, so making them match reintroduces one of the two bugs', () => {
    const rel = (subpath: string): number => {
      const ids = hookIds(subpath);
      return Math.sign(ids.indexOf('responsesNamespaceToolsPlugin') - ids.indexOf('responsesWebSearchPlugin'));
    };
    expect(rel('responses-stream')).toBe(-1);
    expect(rel('responses')).toBe(1);
    expect(rel('responses-stream')).not.toBe(rel('responses'));
  });

  /**
   * THE regression this layering exists for. The continuation round's `spawn_agent` call
   * is generated by the web-search interceptor from its own POST body, so it only reaches
   * the namespace layer if the namespace layer is installed BENEATH web-search.
   */
  it('restores the namespace on a function_call a continuation round emits', async () => {
    const res = mockRes();
    const req = toolTurnReq();
    const spawn = { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'spawn_agent', arguments: '{"task":"read the docs"}' };
    mockPost.mockResolvedValue(upstreamStream([
      { type: 'response.created', response: { id: 'resp_2' } },
      { type: 'response.in_progress' },
      { type: 'response.output_item.added', output_index: 0, item: spawn },
      { type: 'response.output_item.done', output_index: 0, item: spawn },
      { type: 'response.completed', response: { id: 'resp_2', output: [spawn], usage: { input_tokens: 40, output_tokens: 7 } } },
    ]));

    await installInShippedOrder(req, res);
    writeFirstCall(res);
    await settleAll();

    expect(mockPost).toHaveBeenCalledTimes(1);
    const f = frames(res.written);

    const added = f.find(x => x.type === 'response.output_item.added' && x.item?.name === 'spawn_agent');
    const done = f.find(x => x.type === 'response.output_item.done' && x.item?.name === 'spawn_agent');
    expect(added).toBeDefined();
    expect(done).toBeDefined();
    expect(added.item.namespace).toBe('multi_agent_v1');
    expect(done.item.namespace).toBe('multi_agent_v1');

    // The terminal frame is what a client reconstructs the finished turn from, and the
    // web-search interceptor rebuilds it wholesale from items it collected itself.
    const completed = f[f.length - 1];
    expect(completed.type).toBe('response.completed');
    const spawnItem = completed.response.output.find((i: any) => i.name === 'spawn_agent');
    expect(spawnItem).toBeDefined();
    expect(spawnItem.namespace).toBe('multi_agent_v1');
    // The web-search interceptor's own synthetic items are untouched by the namespace layer.
    expect(completed.response.output.some((i: any) => i.type === 'web_search_call')).toBe(true);
    for (const item of completed.response.output) {
      if (item.type !== 'function_call') expect('namespace' in item).toBe(false);
    }
  });

  /**
   * The first call's frames go through both layers too, and the web-search interceptor's
   * injected `web_search_call` / `message` frames must survive the namespace layer
   * unchanged — `renestFunctionCall` rejects them on `item.type !== 'function_call'`.
   */
  it('re-nests a first-call namespaced call while leaving injected web-search items alone', async () => {
    const res = mockRes();
    const req = toolTurnReq();
    delete req.__responsesUpstream;                       // no continuation: the fallback dump path
    const spawn = { type: 'function_call', id: 'fc_3', call_id: 'call_3', name: 'close_agent', arguments: '{}' };

    await installInShippedOrder(req, res);
    res.write(sse({ type: 'response.created', response: { id: 'resp_1' } }));
    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: WEB_SEARCH_CALL }));
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: WEB_SEARCH_CALL }));
    res.write(sse({ type: 'response.output_item.added', output_index: 1, item: spawn }));
    res.write(sse({ type: 'response.output_item.done', output_index: 1, item: spawn }));
    await settleAll();
    res.write(sse({ type: 'response.completed', response: { id: 'resp_1', output: [spawn], usage: {} } }));
    await settleAll();

    const f = frames(res.written);
    for (const x of f.filter(y => y.item?.name === 'close_agent')) {
      expect(x.item.namespace).toBe('multi_agent_v1');
    }
    // Injected by web-search, below which the namespace layer now sits: still verbatim.
    const injected = f.filter(x => x.type === 'response.output_item.added' && x.item?.type === 'web_search_call');
    expect(injected).toHaveLength(1);
    expect('namespace' in injected[0].item).toBe(false);

    const completed = f.find(x => x.type === 'response.completed');
    expect(completed.response.output.find((i: any) => i.name === 'close_agent').namespace).toBe('multi_agent_v1');
  });

  /**
   * The web-search interceptor writes whole `\n\n`-terminated blocks, so the namespace
   * layer below it never holds a tail — except for the one path that hands down an
   * unterminated final block, which web-search's deferred `end` must still flush through
   * the namespace layer's `patchedEnd`.
   */
  it('flushes a trailing partial block down through both layers on end', async () => {
    const res = mockRes();
    const req = toolTurnReq();
    delete req.__responsesUpstream;
    const spawn = { type: 'function_call', id: 'fc_4', call_id: 'call_4', name: 'spawn_agent', arguments: '{}' };
    const block = sse({ type: 'response.output_item.done', output_index: 0, item: spawn });

    await installInShippedOrder(req, res);
    res.write(block.slice(0, -2));                        // everything but the \n\n
    expect(res.written).toHaveLength(0);                  // held as a partial by web-search

    res.end();

    expect(res.ended).toBe(true);
    const f = frames(res.written);
    expect(f).toHaveLength(1);
    expect(f[0].item.namespace).toBe('multi_agent_v1');
  });
});

/**
 * The non-streaming route, and the reason this whole correction exists: NOTHING chained
 * both after handlers, so an array order that broke the chain went green.
 *
 * `executeAfterPlugins` walks the hook array IN ORDER, handing each handler the previous
 * one's return value — the opposite direction to the interceptor nesting above. So on this
 * route the namespace handler must come LAST: web-search's after handler runs a
 * continuation loop and returns `{...current, output: [...clientItems, ...finalOutput]}`,
 * where `finalOutput` is lifted straight off the continuation POST's response. If the
 * namespace handler ran first, that continuation output would never have been re-nested,
 * and a `spawn_agent` the model emitted in a continuation round would reach Codex with no
 * `namespace` — `unsupported call: spawn_agent`.
 *
 * Reachability is low today (Codex CLI always streams) but not zero, and the failure is
 * silent, which is precisely what the namespace plugin exists to prevent.
 */
describe('Responses tool plugins — shipped layering (non-streaming: after-handlers chain in order)', () => {
  beforeEach(() => {
    mockExecuteWebSearch.mockReset();
    mockExecuteWebSearch.mockResolvedValue(RESULTS);
    mockPost.mockReset();
    mockMaxSearches.mockReset();
    mockMaxSearches.mockReturnValue(3);
    mockMode.mockReset();
    mockMode.mockReturnValue('flatten');
  });

  /** The same Codex turn as above, minus `stream` — so neither plugin installs an interceptor. */
  function nonStreamToolTurnReq(): any {
    return {
      body: {
        input: 'node lts?',
        tools: [{ type: 'web_search' }, fn('exec_command'), JSON.parse(JSON.stringify(NS))],
      },
      __responsesUpstream: {
        url: 'https://sap.example/d1/responses',
        headers: { Authorization: 'Bearer t' },
        timeoutMs: 5000,
        payload: { model: 'm', input: 'node lts?' },
      },
      __responsesExtraUsage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  /** Run the after handlers the way executeAfterPlugins does: array order, result chained. */
  async function runAfterInShippedOrder(req: any, res: any, upstreamResponse: any): Promise<any> {
    let current = upstreamResponse;
    for (const id of NON_STREAM_HOOK_IDS) {
      const handler = AFTER_HANDLERS[id];
      if (handler) current = await handler({ req, res, upstreamResponse: current, utils });
    }
    return current;
  }

  it('restores the namespace on a function_call the CONTINUATION round emits — the case that only works because the namespace handler runs last', async () => {
    const res = mockRes();
    const req = nonStreamToolTurnReq();
    for (const id of NON_STREAM_HOOK_IDS) {
      const handler = BEFORE_HANDLERS[id];
      if (handler) await handler({ req, res, utils });
    }
    expect(req.body.stream).toBeUndefined();               // no interceptor path involved
    expect(req.__namespaceToolMap).toEqual({ spawn_agent: 'multi_agent_v1', close_agent: 'multi_agent_v1' });

    // Round 1, straight from the deployment: a web_search call (which drives the
    // continuation) alongside a namespaced call the model made in the same turn.
    const firstRoundSpawn = {
      type: 'function_call', id: 'fc_1', call_id: 'call_a', name: 'close_agent', arguments: '{}',
    };
    const upstreamResponse = {
      id: 'resp_1',
      output: [{ type: 'reasoning', id: 'rs_1', summary: [] }, WEB_SEARCH_CALL, firstRoundSpawn],
      usage: { input_tokens: 10, output_tokens: 2 },
    };

    // Round 2, produced by web-search's own POST — never seen by anything upstream of it.
    const continuationSpawn = {
      type: 'function_call', id: 'fc_2', call_id: 'call_b', name: 'spawn_agent', arguments: '{"task":"read the docs"}',
    };
    mockPost.mockResolvedValue({ data: {
      id: 'resp_2',
      output: [continuationSpawn],
      usage: { input_tokens: 40, output_tokens: 7 },
    } });

    const out = await runAfterInShippedOrder(req, res, upstreamResponse);

    expect(mockPost).toHaveBeenCalledTimes(1);

    // THE assertion: the continuation round's call carries its namespace.
    const cont = out.output.find((i: any) => i.call_id === 'call_b');
    expect(cont).toBeDefined();
    expect(cont.namespace).toBe('multi_agent_v1');
    // Round 1 keeps working too — that half was never broken, and must not become so.
    const first = out.output.find((i: any) => i.call_id === 'call_a');
    expect(first.namespace).toBe('multi_agent_v1');

    // Web-search's own substitution survives, and its synthetic items are left alone:
    // renestFunctionCall rejects anything whose `type` is not `function_call`.
    expect(out.output.some((i: any) => i.type === 'web_search_call')).toBe(true);
    expect(out.output.some((i: any) => i.name === 'web_search')).toBe(false);
    for (const item of out.output) {
      if (item.type !== 'function_call') expect('namespace' in item).toBe(false);
    }
  });

  it('leaves a turn with no continuation intact — the namespace handler running last still re-nests the first reply', async () => {
    const res = mockRes();
    const req = nonStreamToolTurnReq();
    delete req.__responsesUpstream;                        // no continuation possible
    for (const id of NON_STREAM_HOOK_IDS) {
      const handler = BEFORE_HANDLERS[id];
      if (handler) await handler({ req, res, utils });
    }
    const spawn = { type: 'function_call', id: 'fc_1', call_id: 'call_a', name: 'spawn_agent', arguments: '{}' };

    const out = await runAfterInShippedOrder(req, res, { id: 'resp_1', output: [WEB_SEARCH_CALL, spawn] });

    expect(mockPost).not.toHaveBeenCalled();
    expect(out.output.find((i: any) => i.call_id === 'call_a').namespace).toBe('multi_agent_v1');
    expect(out.output.some((i: any) => i.type === 'web_search_call')).toBe(true);
  });
});
