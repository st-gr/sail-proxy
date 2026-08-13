import { describe, it, expect, jest, beforeEach } from '@jest/globals';

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
import { ReplacementMap } from '../src/plugins/pseudonymization/replacementMap';

const before = (pluginRules as any[]).find(r => r.strategy === 'before').handler;
const after = (pluginRules as any[]).find(r => r.strategy === 'after').handler;

const utils = { logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() } };
const RESULTS = [{ title: 'Berlin weather', url: 'https://w.example/berlin', snippet: 'Mild', content: 'Mild and dry' }];

// Must match the plugin's private REWROTE_FLAG key. In production the before
// handler sets this on `req` and the after handler reads it back off the same
// `req` within one request lifecycle; after-handler tests that exercise the
// "the before handler already rewrote this request" path set it directly.
const REWROTE_FLAG = '__responsesWebSearchRewritten';

describe('responsesWebSearchPlugin — before handler', () => {
  beforeEach(() => { mockExecuteWebSearch.mockReset(); mockExecuteWebSearch.mockResolvedValue(RESULTS); });

  it('rewrites the hosted tool into a function tool', async () => {
    const req: any = { body: { model: 'gpt-5.3-codex--deployed', input: 'hi', tools: [{ type: 'web_search', external_web_access: false }] } };

    await before({ req, res: {} as any, utils });

    expect(req.body.tools[0].type).toBe('function');
    expect(req.body.tools[0].name).toBe('web_search');
    expect(mockExecuteWebSearch).not.toHaveBeenCalled();
  });

  it('leaves a request with no hosted tool untouched', async () => {
    const req: any = { body: { input: 'hi', tools: [{ type: 'function', name: 'exec_command' }] } };
    const snapshot = JSON.parse(JSON.stringify(req.body));

    const result = await before({ req, res: {} as any, utils });

    expect(result).toEqual({ stop: false });
    expect(req.body).toEqual(snapshot);
  });

  it('executes a pending search and appends its function_call_output', async () => {
    const req: any = { body: {
      tools: [{ type: 'web_search' }],
      input: [{ type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{"query":"weather in Berlin"}' }],
    } };

    await before({ req, res: {} as any, utils });

    expect(mockExecuteWebSearch).toHaveBeenCalledWith('weather in Berlin', utils.logger);
    const last = req.body.input[req.body.input.length - 1];
    expect(last.type).toBe('function_call_output');
    expect(last.call_id).toBe('call_1');
    expect(last.output).toContain('https://w.example/berlin');
  });

  it('never throws when the search fails, and still appends a well-formed function_call_output', async () => {
    mockExecuteWebSearch.mockRejectedValue(new Error('perplexity down'));
    const req: any = { body: {
      tools: [{ type: 'web_search' }],
      input: [{ type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{"query":"x"}' }],
    } };

    await expect(before({ req, res: {} as any, utils })).resolves.toEqual({ stop: false });
    expect(req.body.tools[0].type).toBe('function');

    // The request must still be well-formed: every pending function_call has a
    // matching function_call_output by call_id, even though the search failed.
    // A resolved promise alone doesn't prove this — a bug that aborts the drain
    // loop on the first throw would still resolve { stop: false } while leaving
    // call_1 unanswered, and the deployment would reject the turn.
    const outputs = req.body.input.filter((i: any) => i.type === 'function_call_output');
    expect(outputs).toHaveLength(1);
    expect(outputs[0].call_id).toBe('call_1');
    // The mocked rejection goes through execute()'s own catch, which sets code
    // 'web_search_failed' — distinct from the generic 'web_search_unavailable'
    // fallback renderOutput uses only when a call carries no error at all (never ran).
    const parsed = JSON.parse(outputs[0].output);
    expect(parsed.results).toBeUndefined();
    expect(parsed.error.code).toBe('web_search_failed');
  });

  it('answers a later pending search even when an earlier one in the same drain fails', async () => {
    // findPendingResponsesSearch resolves back-to-front, so with call_2 last in
    // `input` it is drained first. Making call_2 the one that fails proves a
    // mid-loop throw doesn't abort the remaining iterations.
    mockExecuteWebSearch.mockImplementation(async (query: any) => {
      if (query === 'weather in Munich') throw new Error('perplexity down');
      if (query === 'weather in Berlin') return RESULTS;
      return [];
    });

    const req: any = { body: {
      tools: [{ type: 'web_search' }],
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{"query":"weather in Berlin"}' },
        { type: 'function_call', call_id: 'call_2', name: 'web_search', arguments: '{"query":"weather in Munich"}' },
      ],
    } };

    await before({ req, res: {} as any, utils });

    const outputs = req.body.input.filter((i: any) => i.type === 'function_call_output');
    expect(outputs).toHaveLength(2);

    const byCallId: Record<string, any> = Object.fromEntries(outputs.map((o: any) => [o.call_id, o]));
    const call2 = JSON.parse(byCallId['call_2'].output);
    expect(call2.results).toBeUndefined();
    expect(call2.error.code).toBe('web_search_failed');
    expect(byCallId['call_1'].output).toContain('https://w.example/berlin');
  });

  it('drains all pending searches in one turn, each matched by call_id', async () => {
    mockExecuteWebSearch.mockImplementation(async (query: any) => {
      if (query === 'weather in Berlin') return [{ title: 'Berlin weather', url: 'https://w.example/berlin', snippet: 'Mild', content: 'Mild and dry' }];
      if (query === 'weather in Munich') return [{ title: 'Munich weather', url: 'https://w.example/munich', snippet: 'Sunny', content: 'Sunny and warm' }];
      return [];
    });

    const req: any = { body: {
      tools: [{ type: 'web_search' }],
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{"query":"weather in Berlin"}' },
        { type: 'function_call', call_id: 'call_2', name: 'web_search', arguments: '{"query":"weather in Munich"}' },
      ],
    } };

    await before({ req, res: {} as any, utils });

    expect(mockExecuteWebSearch).toHaveBeenCalledTimes(2);
    expect(mockExecuteWebSearch).toHaveBeenCalledWith('weather in Berlin', utils.logger);
    expect(mockExecuteWebSearch).toHaveBeenCalledWith('weather in Munich', utils.logger);

    const outputs = req.body.input.filter((i: any) => i.type === 'function_call_output');
    expect(outputs).toHaveLength(2);

    const byCallId: Record<string, any> = Object.fromEntries(outputs.map((o: any) => [o.call_id, o]));
    expect(byCallId['call_1'].output).toContain('https://w.example/berlin');
    expect(byCallId['call_2'].output).toContain('https://w.example/munich');
  });
});

describe('responsesWebSearchPlugin — after handler', () => {
  beforeEach(() => {
    mockExecuteWebSearch.mockReset(); mockExecuteWebSearch.mockResolvedValue(RESULTS);
    mockPost.mockReset();
    mockMaxSearches.mockReset(); mockMaxSearches.mockReturnValue(3);
  });

  // Updated for the continuation loop (Task 5): with an upstream context stashed, the
  // after handler no longer hands the client a formatted dump of the search results —
  // it POSTs the results back to the deployment and returns the MODEL's real answer.
  // The `message` here is therefore the model's answer, not the synthetic result dump
  // the pre-continuation dead end ended the turn with. The `reasoning` item still comes
  // first: only the function_call is substituted, everything else keeps its position.
  it('replaces a web_search function call with web_search_call + the model\'s continuation answer', async () => {
    const req: any = {
      body: { input: 'weather?', tools: [{ type: 'function', name: 'web_search' }] },
      [REWROTE_FLAG]: true,
      __responsesUpstream: {
        url: 'https://sap.example/deployments/d1/responses',
        headers: { Authorization: 'Bearer t' },
        timeoutMs: 1000,
        payload: { model: 'gpt-5.3-codex', input: 'weather?' },
      },
    };
    const upstreamResponse = {
      id: 'resp_1',
      output: [
        { type: 'reasoning', id: 'rs_1', summary: [] },
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"weather in Berlin"}' },
      ],
    };
    mockPost.mockResolvedValue({ data: {
      output: [{ type: 'message', id: 'msg_2', role: 'assistant', status: 'completed',
                 content: [{ type: 'output_text', text: 'It is mild and dry in Berlin.', annotations: [] }] }],
      usage: { input_tokens: 10, output_tokens: 5 },
    } });

    const out = await after({ req, upstreamResponse, utils });

    expect(mockPost).toHaveBeenCalledTimes(1);
    const [url, body] = mockPost.mock.calls[0];
    expect(url).toBe('https://sap.example/deployments/d1/responses');
    expect(body.input[body.input.length - 1]).toMatchObject({ type: 'function_call_output', call_id: 'call_1' });

    expect(out.output.map((i: any) => i.type)).toEqual(['reasoning', 'web_search_call', 'message']);
    expect(out.output[0].id).toBe('rs_1');
    expect(out.output[1].action.query).toBe('weather in Berlin');
    expect(out.output[2].content[0].text).toBe('It is mild and dry in Berlin.');
    expect(out.output.some((i: any) => i.type === 'function_call')).toBe(false);
  });

  it('passes a response with no web_search call through unchanged', async () => {
    const req: any = { body: {}, [REWROTE_FLAG]: true };
    const upstreamResponse = { output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }] };

    const out = await after({ req, upstreamResponse, utils });

    expect(out).toBe(upstreamResponse);
    expect(mockExecuteWebSearch).not.toHaveBeenCalled();
  });

  it('emits a failed web_search_call when the search throws', async () => {
    mockExecuteWebSearch.mockRejectedValue(new Error('perplexity down'));
    const req: any = { body: {}, [REWROTE_FLAG]: true };
    const upstreamResponse = { output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"x"}' }] };

    const out = await after({ req, upstreamResponse, utils });

    expect(out.output[0].type).toBe('web_search_call');
    expect(out.output[0].status).toBe('failed');
  });

  it('returns the original response when output is not an array', async () => {
    const req: any = { body: {}, [REWROTE_FLAG]: true };
    const upstreamResponse = { error: 'nope' };

    expect(await after({ req, upstreamResponse, utils })).toBe(upstreamResponse);
  });

  it('passes a request whose tools were never rewritten through untouched, even if the output contains a function_call named web_search', async () => {
    // No hosted `web_search` tool on the original request, so the before
    // handler never set REWROTE_FLAG (e.g. a client shipping its own function
    // tool literally named `web_search` that it executes client-side — matched
    // by the `tools:hasWebSearch` hook regex, but not a hosted tool). The after
    // handler must not claim a function_call it didn't create the need for.
    const req: any = { body: { tools: [{ type: 'function', name: 'web_search', parameters: {} }] } };
    const upstreamResponse = {
      output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"x"}' }],
    };

    const out = await after({ req, upstreamResponse, utils });

    expect(out).toBe(upstreamResponse);
    expect(mockExecuteWebSearch).not.toHaveBeenCalled();
  });
});

describe('responsesWebSearchPlugin — continuation', () => {
  beforeEach(() => {
    mockExecuteWebSearch.mockReset(); mockExecuteWebSearch.mockResolvedValue(RESULTS);
    mockPost.mockReset();
    mockMaxSearches.mockReturnValue(3);
  });

  function reqWithUpstream(body: any = {}): any {
    return {
      body: { input: 'what is the node lts?', ...body },
      [REWROTE_FLAG]: true,
      __responsesUpstream: {
        url: 'https://sap.example/deployments/d1/responses',
        headers: { Authorization: 'Bearer t' },
        timeoutMs: 1000,
        payload: { model: 'gpt-5.3-codex', input: 'what is the node lts?' },
      },
    };
  }

  it('calls the deployment again so the model answers from the results', async () => {
    const req = reqWithUpstream();
    mockPost.mockResolvedValue({ data: {
      output: [{ type: 'message', id: 'msg_2', role: 'assistant', status: 'completed',
                 content: [{ type: 'output_text', text: 'Node 22 is the current LTS.', annotations: [] }] }],
      usage: { input_tokens: 40, output_tokens: 7 },
    } });

    const out = await after({ req, upstreamResponse: {
      output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"query":"node lts"}' }],
    }, utils });

    expect(mockPost).toHaveBeenCalledTimes(1);
    const [url, body] = mockPost.mock.calls[0];
    expect(url).toBe('https://sap.example/deployments/d1/responses');
    expect(body.model).toBe('gpt-5.3-codex');
    expect(body.input[body.input.length - 1]).toMatchObject({ type: 'function_call_output', call_id: 'call_1' });
    // Pin the WHOLE sequence, head to tail: the user's original prompt, then the
    // model's own function_call, then the result. Checking only the tail item (above)
    // cannot catch the original input being dropped entirely — a mutation to seed
    // `history` as `[]` instead of `normalizeInputToItems(req.body?.input)` passes
    // every other assertion in this file untouched.
    expect(body.input.map((i: any) => i.type)).toEqual(['message', 'function_call', 'function_call_output']);
    expect(body.input[0]).toMatchObject({
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'what is the node lts?' }],
    });

    expect(out.output.map((i: any) => i.type)).toEqual(['web_search_call', 'message']);
    expect(out.output[1].content[0].text).toBe('Node 22 is the current LTS.');
    expect(out.output.some((i: any) => i.type === 'function_call')).toBe(false);
  });

  it('keeps every intermediate round\'s output, in its original order, across a 2-round continuation', async () => {
    // The route runs `store: false`, so the client replays `output` into the next turn's
    // `input`. Accumulating only the web_search_call items and appending the LAST round's
    // output to them dropped every intermediate round entirely — the reasoning items with
    // their encrypted_content, and any assistant text written BEFORE the search — and
    // hoisted the searches ahead of the reasoning that produced them. Both losses are
    // invisible to a length assertion: the defect's round-3 output had the right count
    // and the wrong contents, which is why this pins the whole list head to tail.
    //
    // Same 2-search / 3-round scenario the streaming path is driven through, and it must
    // produce the same client-visible list, since only the transport differs.
    const req = reqWithUpstream();
    const searchCall = (id: string, q: string) =>
      ({ type: 'function_call', id: `fc_${id}`, call_id: id, name: 'web_search', arguments: `{"query":"${q}"}` });
    const message = (id: string, text: string) =>
      ({ type: 'message', id, role: 'assistant', status: 'completed',
         content: [{ type: 'output_text', text, annotations: [] }] });

    mockPost
      // round 2: thinks again, then searches again
      .mockResolvedValueOnce({ data: { output: [
        { type: 'reasoning', id: 'rs_2', summary: [], encrypted_content: 'enc_rs_2' },
        searchCall('call_2', 'node 22 release date'),
      ], usage: { input_tokens: 20, output_tokens: 3 } } })
      // round 3: the real answer
      .mockResolvedValueOnce({ data: { output: [
        { type: 'reasoning', id: 'rs_3', summary: [], encrypted_content: 'enc_rs_3' },
        message('msg_final', 'Node 22 is the current LTS.'),
      ], usage: { input_tokens: 30, output_tokens: 9 } } });

    const out = await after({ req, upstreamResponse: { output: [
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc_rs_1' },
      message('msg_pre', 'Let me look that up.'),
      searchCall('call_1', 'node lts'),
    ] }, utils });

    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(out.output.map((i: any) => i.type)).toEqual([
      'reasoning', 'message', 'web_search_call', 'reasoning', 'web_search_call', 'reasoning', 'message',
    ]);
    // Identity, not just shape: each surviving item is the one the model actually emitted,
    // in the round it emitted it, with its opaque encrypted_content intact.
    expect(out.output[0]).toMatchObject({ id: 'rs_1', encrypted_content: 'enc_rs_1' });
    expect(out.output[1].content[0].text).toBe('Let me look that up.');   // written BEFORE searching
    expect(out.output[2].action.query).toBe('node lts');
    expect(out.output[3]).toMatchObject({ id: 'rs_2', encrypted_content: 'enc_rs_2' });
    expect(out.output[4].action.query).toBe('node 22 release date');
    expect(out.output[5]).toMatchObject({ id: 'rs_3', encrypted_content: 'enc_rs_3' });
    expect(out.output[6].content[0].text).toBe('Node 22 is the current LTS.');
    expect(out.output.some((i: any) => i.type === 'function_call')).toBe(false);
  });

  it('accumulates continuation usage onto the request', async () => {
    const req = reqWithUpstream();
    mockPost.mockResolvedValue({ data: { output: [{ type: 'message', content: [] }], usage: { input_tokens: 40, output_tokens: 7 } } });

    await after({ req, upstreamResponse: {
      output: [{ type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{"query":"q"}' }],
    }, utils });

    expect(req.__responsesExtraUsage).toEqual({
      input_tokens: 40, output_tokens: 7, cache_creation_tokens: 0, cache_read_tokens: 0,
    });
  });

  it('loops for a second search and stops at the configured cap', async () => {
    mockMaxSearches.mockReturnValue(2);
    const req = reqWithUpstream();
    const searchCall = (id: string) => ({ type: 'function_call', call_id: id, name: 'web_search', arguments: '{"query":"q"}' });
    mockPost
      .mockResolvedValueOnce({ data: { output: [searchCall('call_2')], usage: { input_tokens: 1, output_tokens: 1 } } })
      .mockResolvedValueOnce({ data: { output: [searchCall('call_3')], usage: { input_tokens: 1, output_tokens: 1 } } });

    const out = await after({ req, upstreamResponse: { output: [searchCall('call_1')] }, utils });

    expect(mockExecuteWebSearch).toHaveBeenCalledTimes(2);
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(out.output.filter((i: any) => i.type === 'web_search_call')).toHaveLength(2);
    // the cap stopped the loop with a call still outstanding: it must not leak
    expect(out.output.some((i: any) => i.type === 'function_call')).toBe(false);
  });

  it('returns the pre-continuation response when the continuation call fails, without conflating the search outcome with the continuation outcome', async () => {
    const req = reqWithUpstream();
    mockPost.mockRejectedValue(new Error('deployment 500'));

    const out = await after({ req, upstreamResponse: {
      output: [{ type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{"query":"q"}' }],
    }, utils });

    // The SEARCH succeeded (mockExecuteWebSearch resolves RESULTS by default in this
    // describe's beforeEach) — only the continuation POST failed. The web_search_call's
    // status reports whether the search succeeded, not whether the continuation did, so
    // it must stay 'completed' here rather than being overwritten to 'failed'.
    expect(out.output[0].type).toBe('web_search_call');
    expect(out.output[0].status).toBe('completed');
    // With no model answer coming (the continuation never happened), the results
    // already in hand must still reach the client as a message — a turn with only a
    // web_search_call and no content would be worse than the dump this feature
    // replaced.
    expect(out.output[1].type).toBe('message');
    expect(out.output[1].content[0].annotations[0].url).toBe('https://w.example/berlin');
    expect(out.output.some((i: any) => i.type === 'function_call')).toBe(false);
  });

  it('preserves an item\'s original position — a reasoning item that preceded the call still precedes it — even when the continuation POST fails', async () => {
    // The no-upstream and cap-overflow fallbacks splice their pair in at the call's
    // original position; a continuation-POST failure must do the same rather than
    // prepending it ahead of everything else via the flat searchItems array (that
    // flat-prepend is only correct for a call whose continuation actually succeeded,
    // since only then is there a later model answer for it to precede).
    const req = reqWithUpstream();
    mockPost.mockRejectedValue(new Error('deployment 500'));

    const out = await after({ req, upstreamResponse: {
      output: [
        { type: 'reasoning', id: 'rs_1', summary: [] },
        { type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{"query":"q"}' },
      ],
    }, utils });

    expect(out.output.map((i: any) => i.type)).toEqual(['reasoning', 'web_search_call', 'message']);
  });

  it('still attempts the continuation with a failure output when the search itself throws — status stays independent in this direction too', async () => {
    mockExecuteWebSearch.mockRejectedValue(new Error('perplexity down'));
    const req = reqWithUpstream();
    mockPost.mockResolvedValue({ data: { output: [{ type: 'message', content: [] }], usage: { input_tokens: 1, output_tokens: 1 } } });

    const out = await after({ req, upstreamResponse: {
      output: [{ type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{"query":"q"}' }],
    }, utils });

    // A failed search still gets a continuation attempt (an error output, not results: [])
    // so the model can tell the user the search was unavailable — mirrors the before
    // handler's pending-search behavior. Here the continuation itself succeeds, proving the
    // two statuses (search outcome vs. continuation outcome) stay independent in this
    // direction too: search failed, continuation succeeded.
    expect(mockPost).toHaveBeenCalledTimes(1);
    const [, body] = mockPost.mock.calls[0];
    const parsed = JSON.parse(body.input[body.input.length - 1].output);
    expect(parsed.results).toBeUndefined();
    expect(parsed.error.code).toBe('web_search_failed');
    expect(out.output[0].type).toBe('web_search_call');
    expect(out.output[0].status).toBe('failed');
  });

  it('passes through untouched when the upstream context is missing', async () => {
    const req: any = { body: {}, [REWROTE_FLAG]: true };   // no __responsesUpstream
    const upstreamResponse = { output: [{ type: 'function_call', call_id: 'c', name: 'web_search', arguments: '{"query":"q"}' }] };

    const out = await after({ req, upstreamResponse, utils });

    expect(mockPost).not.toHaveBeenCalled();
    expect(out.output.some((i: any) => i.type === 'web_search_call')).toBe(true);   // still no raw call leaked
    expect(out.output.some((i: any) => i.type === 'function_call')).toBe(false);
  });

  it('resolves every web_search call in one turn, not just the first, when the model fires them in parallel', async () => {
    // Codex CLI defaults parallel_tool_calls to true. A continuation POSTed with only
    // ONE of two calls answered by a function_call_output is a malformed turn the
    // deployment rejects, so both must be searched and both must get an output.
    const req = reqWithUpstream();
    mockExecuteWebSearch.mockImplementation(async (q: string) =>
      (q.includes('Berlin') ? RESULTS : [{ title: 'Munich weather', url: 'https://w.example/munich', snippet: 'Sunny', content: 'Sunny' }]));
    mockPost.mockResolvedValue({ data: {
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Both done.', annotations: [] }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    } });

    const upstreamResponse = { output: [
      { type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{"query":"weather in Berlin"}' },
      { type: 'function_call', call_id: 'call_2', name: 'web_search', arguments: '{"query":"weather in Munich"}' },
    ] };

    const out = await after({ req, upstreamResponse, utils });

    expect(mockExecuteWebSearch).toHaveBeenCalledTimes(2);
    expect(mockPost).toHaveBeenCalledTimes(1);

    const [, body] = mockPost.mock.calls[0];
    const fcOutputs = body.input.filter((i: any) => i.type === 'function_call_output');
    expect(fcOutputs.map((o: any) => o.call_id).sort()).toEqual(['call_1', 'call_2']);

    expect(out.output.filter((i: any) => i.type === 'web_search_call')).toHaveLength(2);
    expect(out.output.some((i: any) => i.type === 'function_call')).toBe(false);
  });

  it('keeps an earlier search\'s usage after a later search\'s continuation fails', async () => {
    mockMaxSearches.mockReturnValue(3);
    const req = reqWithUpstream();
    const searchCall = (id: string) => ({ type: 'function_call', call_id: id, name: 'web_search', arguments: '{"query":"q"}' });
    mockPost
      .mockResolvedValueOnce({ data: { output: [searchCall('call_2')], usage: { input_tokens: 10, output_tokens: 5 } } })
      .mockRejectedValueOnce(new Error('deployment 500'));

    const out = await after({ req, upstreamResponse: { output: [searchCall('call_1')] }, utils });

    // The internal billing accumulator only ever saw the one successful continuation.
    expect(req.__responsesExtraUsage).toEqual({
      input_tokens: 10, output_tokens: 5, cache_creation_tokens: 0, cache_read_tokens: 0,
    });
    // And the client-visible response.usage must report that same total, not silently
    // drop it because a LATER round's continuation failed.
    expect(out.usage).toMatchObject({ input_tokens: 10, output_tokens: 5 });
    expect(out.output.some((i: any) => i.type === 'function_call')).toBe(false);
  });

  it('never leaks a raw function_call, and preserves the model\'s own item ordering, when something throws before the loop resolves anything', async () => {
    const req = reqWithUpstream();
    mockMaxSearches.mockImplementation(() => { throw new Error('config service is down'); });

    const out = await after({ req, upstreamResponse: {
      output: [
        { type: 'reasoning', id: 'rs_1', summary: [] },
        { type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{"query":"weather in Berlin"}' },
      ],
    }, utils });

    expect(mockPost).not.toHaveBeenCalled();
    expect(out.output.map((i: any) => i.type)).toEqual(['reasoning', 'web_search_call', 'message']);
    expect(out.output[1].status).toBe('failed');
    expect(out.output.some((i: any) => i.type === 'function_call')).toBe(false);
  });

  it('sends a reasoning item\'s encrypted_content to the continuation POST byte-identical, even when a short masked original collides with it as a substring', async () => {
    // Uses the REAL ReplacementMap, same as query-masking.test.ts, so this proves the
    // actual production remasking path — not a hand-shaped stand-in — leaves an opaque
    // field alone. "male" is exactly the class of short original a dictionary/NER entity
    // type (profile-gender, profile-nationality, a short surname) routinely mints.
    const map = new ReplacementMap('pseudonymization');
    map.getPlaceholder('profile-gender', 'male');

    const req = reqWithUpstream();
    req.__pseudonymizationMap = map;

    const encryptedContent = 'gAAAAABmZmaleXk9pQ0lVSk1URXhKUTBGVVNVSU8maledGhlcmVzdA==';
    mockPost.mockResolvedValue({ data: { output: [{ type: 'message', content: [] }], usage: { input_tokens: 1, output_tokens: 1 } } });

    await after({ req, upstreamResponse: {
      output: [
        { type: 'reasoning', id: 'rs_male_1', summary: [], encrypted_content: encryptedContent },
        { type: 'function_call', id: 'fc_1', call_id: 'call_male_1', name: 'web_search', arguments: '{"query":"q"}' },
      ],
    }, utils });

    expect(mockPost).toHaveBeenCalledTimes(1);
    const [, body] = mockPost.mock.calls[0];
    const reasoningInBody = body.input.find((i: any) => i.type === 'reasoning');
    expect(reasoningInBody.encrypted_content).toBe(encryptedContent);
    expect(reasoningInBody.id).toBe('rs_male_1');
    const fcOutput = body.input.find((i: any) => i.type === 'function_call_output');
    expect(fcOutput.call_id).toBe('call_male_1');
  });
});
