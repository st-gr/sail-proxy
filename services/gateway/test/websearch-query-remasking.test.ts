/**
 * The masked query must be what reaches Perplexity — and the unmasked one what reaches
 * the client (finding I5 of the spec).
 *
 * This is the one suite that instantiates the REAL pseudonymization plugin next to the
 * web-search plugins instead of mocking it. Every other web-search suite stubs
 * searchExecutor and never runs pseudonymization, which is precisely why the
 * response-side ordering defect survived: pseudonymizationPlugin sits at index 0 of the
 * single hook array, so on the RESPONSE side it unmasks the model's function_call
 * arguments / tool_use input in place BEFORE the web-search after handler reads the
 * query out of them and ships it to a third-party model.
 *
 * Only `executeWebSearch` is mocked (no network); the masking, the unmasking and the
 * re-masking are all the production code paths.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));

const mockConfig: any = { api_config: { defaultHooks: {}, model_list_changes: {} } };
// getWebSearchMaxSearches: none of the scenarios below stash __responsesUpstream, so
// the continuation loop always takes its no-upstream fallback after exactly one
// search — this just needs to be a positive number for that first iteration to run.
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: { getConfig: () => mockConfig, getSubstitutedModel: (_p: string, m: string) => m, getWebSearchMaxSearches: () => 3 },
  getConfig: () => mockConfig,
  getSubstitutedModel: (_p: string, m: string) => m,
  getWebSearchMaxSearches: () => 3,
}));

const mockExecuteWebSearch = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../src/plugins/webSearch/searchExecutor', () => ({
  __esModule: true,
  executeWebSearch: (...a: any[]) => mockExecuteWebSearch(...a),
}));

// Only used by the continuation test below (which stashes __responsesUpstream); every
// other scenario in this file never reaches axios.post at all.
const mockPost = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: (...a: any[]) => mockPost(...a) },
}));

import pseudoRules = require('../src/plugins/pseudonymization/index');
import responsesRules = require('../src/plugins/responsesWebSearchPlugin');
import anthropicRules = require('../src/plugins/webSearchPlugin');

const pseudoBefore = (pseudoRules as any[]).find(r => r.strategy === 'before').handler;
const pseudoAfter = (pseudoRules as any[]).find(r => r.strategy === 'after').handler;
const responsesBefore = (responsesRules as any[]).find(r => r.strategy === 'before').handler;
const responsesAfter = (responsesRules as any[]).find(r => r.strategy === 'after').handler;
const anthropicBefore = (anthropicRules as any[]).find(r => r.strategy === 'before').handler;
const anthropicAfter = (anthropicRules as any[]).find(r => r.strategy === 'after').handler;

const utils = { logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() } };
const masking = { method: 'pseudonymization', entities: [{ type: 'profile-email' }] };
const RESULTS = [{ title: 'Contact page', url: 'https://w.example/contact', snippet: 'Reachable', content: 'Reachable here' }];

const PII = 'john@test.com';

function mockRes() {
  const written: string[] = [];
  return {
    written,
    write(chunk: any) { written.push(String(chunk)); return true; },
    end(chunk?: any) { if (chunk) written.push(String(chunk)); return this as any; },
    setHeader() { /* no-op */ },
  } as any;
}

const sse = (o: any) => `data: ${JSON.stringify(o)}\n\n`;
const settle = () => new Promise(r => setTimeout(r, 0));

describe('web-search query re-masking (real pseudonymization plugin)', () => {
  beforeEach(() => { jest.clearAllMocks(); mockExecuteWebSearch.mockResolvedValue(RESULTS); mockPost.mockReset(); });

  it('Responses, non-streaming: Perplexity gets the masked query, the client gets unmasked output', async () => {
    const res = mockRes();
    const req: any = {
      headers: {},
      body: {
        model: 'gpt-5.3-codex--deployed',
        input: `Find the company behind ${PII}`,
        tools: [{ type: 'web_search' }],
        masking,
      },
    };

    // Request side, in hook-array order.
    await pseudoBefore({ req, res, utils });
    await responsesBefore({ req, res, utils });

    const token = req.__pseudonymizationMap.forward.get(PII);
    expect(token).toBeDefined();
    expect(req.body.input).not.toContain(PII);

    // What the deployment emits: the model copied the masked token into its arguments.
    const upstreamResponse: any = {
      object: 'response', status: 'completed',
      output: [
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: JSON.stringify({ query: `company behind ${token}` }) },
      ],
    };

    // Response side, in hook-array order: pseudonymization FIRST.
    const unmasked = await pseudoAfter({ req, res, upstreamResponse, utils });
    // Precondition of the whole defect — if this ever stops holding, the guard below
    // becomes a no-op and this assertion is what says so.
    expect(unmasked.output[0].arguments).toContain(PII);

    const final = await responsesAfter({ req, res, upstreamResponse: unmasked, utils });

    expect(mockExecuteWebSearch).toHaveBeenCalledTimes(1);
    const sentQuery = mockExecuteWebSearch.mock.calls[0][0] as string;
    expect(sentQuery).toBe(`company behind ${token}`);
    expect(sentQuery).not.toContain(PII);

    const clientBody = JSON.stringify(final);
    expect(clientBody).toContain(PII);
    expect(clientBody).not.toContain('MASKED_');
    expect(final.output.map((i: any) => i.type)).toEqual(['web_search_call', 'message']);
  });

  it('Responses, streaming: Perplexity gets the masked query, the client gets unmasked frames', async () => {
    const res = mockRes();
    const req: any = {
      headers: {},
      body: {
        model: 'gpt-5.3-codex--deployed',
        stream: true,
        input: `Find the company behind ${PII}`,
        tools: [{ type: 'web_search' }],
        masking,
      },
    };

    // Order matters: pseudonymization patches res.write first, the interceptor on top of
    // it — so the interceptor reads frames while they are still masked.
    await pseudoBefore({ req, res, utils });
    await responsesBefore({ req, res, utils });

    const token = req.__pseudonymizationMap.forward.get(PII);
    const args = JSON.stringify({ query: `company behind ${token}` });

    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '' } }));
    res.write(sse({ type: 'response.function_call_arguments.delta', output_index: 0, delta: args }));
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: args } }));
    await settle();
    res.write(sse({ type: 'response.completed', response: { id: 'resp_1', output: [] } }));
    res.end();

    expect(mockExecuteWebSearch).toHaveBeenCalledTimes(1);
    const sentQuery = mockExecuteWebSearch.mock.calls[0][0] as string;
    expect(sentQuery).toBe(`company behind ${token}`);
    expect(sentQuery).not.toContain(PII);

    const wire = res.written.join('');
    expect(wire).toContain(PII);
    expect(wire).not.toContain('MASKED_');
  });

  it('Anthropic, non-streaming: Perplexity gets the masked query, the client gets unmasked content', async () => {
    const res = mockRes();
    const req: any = {
      headers: {},
      body: {
        model: 'claude-sonnet-4',
        messages: [{ role: 'user', content: `Find the company behind ${PII}` }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        masking,
      },
    };

    await pseudoBefore({ req, res, utils });
    await anthropicBefore({ req, res, utils });

    const token = req.__pseudonymizationMap.forward.get(PII);
    expect(token).toBeDefined();

    const upstreamResponse: any = {
      type: 'message', role: 'assistant', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'web_search', input: { query: `company behind ${token}` } }],
    };

    const unmasked = await pseudoAfter({ req, res, upstreamResponse, utils });
    expect(unmasked.content[0].input.query).toContain(PII);

    const final = await anthropicAfter({ req, res, upstreamResponse: unmasked, utils });

    expect(mockExecuteWebSearch).toHaveBeenCalledTimes(1);
    const sentQuery = mockExecuteWebSearch.mock.calls[0][0] as string;
    expect(sentQuery).toBe(`company behind ${token}`);
    expect(sentQuery).not.toContain(PII);

    const clientBody = JSON.stringify(final);
    expect(clientBody).toContain(PII);
    expect(clientBody).not.toContain('MASKED_');
  });

  it('Responses continuation: the deployment gets no raw PII, and the client-visible answer gets no MASKED_ tokens', async () => {
    const res = mockRes();
    const req: any = {
      headers: {},
      body: {
        model: 'gpt-5.3-codex--deployed',
        input: `Find the company behind ${PII}`,
        tools: [{ type: 'web_search' }],
        masking,
      },
    };

    await pseudoBefore({ req, res, utils });
    await responsesBefore({ req, res, utils });

    const token = req.__pseudonymizationMap.forward.get(PII);
    expect(token).toBeDefined();

    // Set by responsesController in production, right before the after-plugin chain
    // runs; stashed here directly since this test drives the plugin handlers, not the
    // controller.
    req.__responsesUpstream = {
      url: 'https://sap.example/deployments/d1/responses',
      headers: { Authorization: 'Bearer t' },
      timeoutMs: 1000,
      payload: { model: 'gpt-5.3-codex', input: req.body.input },
    };

    const upstreamResponse: any = {
      output: [
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: JSON.stringify({ query: `company behind ${token}` }) },
      ],
    };

    // Response side, in hook-array order: pseudonymization FIRST — this is what leaves
    // `unmasked.output[0].arguments` (the function_call the continuation POST carries
    // forward) holding the RAW PII value, same as production.
    const unmasked = await pseudoAfter({ req, res, upstreamResponse, utils });
    expect(unmasked.output[0].arguments).toContain(PII);

    mockPost.mockResolvedValue({ data: {
      output: [{ type: 'message', id: 'msg_2', role: 'assistant', status: 'completed',
                 content: [{ type: 'output_text', text: `The company is linked to ${token}.`, annotations: [] }] }],
      usage: { input_tokens: 5, output_tokens: 5 },
    } });

    const final = await responsesAfter({ req, res, upstreamResponse: unmasked, utils });

    // 1) The whole conversation POSTed back to the deployment — not just the search
    //    query — must carry no raw PII, including the model's own (now-unmasked)
    //    function_call.arguments passed through into the continuation's `input`.
    expect(mockPost).toHaveBeenCalledTimes(1);
    const [, body] = mockPost.mock.calls[0];
    const outboundBody = JSON.stringify(body);
    expect(outboundBody).not.toContain(PII);
    expect(outboundBody).toContain(token);

    // 2) The continuation response — a SECOND deployment call pseudonymizationPlugin's
    //    own after handler never sees — must still reach the client fully unmasked.
    //    The deployment echoed the same placeholder token back in its answer (as a real
    //    model would, having never seen the real value either); the client must see the
    //    real value, not the token.
    const clientBody = JSON.stringify(final);
    expect(clientBody).toContain(PII);
    expect(clientBody).not.toContain('MASKED_');
    expect(clientBody).not.toContain(token);
  });

  it('leaves the query untouched when no masking ran (absent config = unchanged behavior)', async () => {
    const res = mockRes();
    const req: any = { headers: {}, body: { model: 'gpt-5.3-codex--deployed', input: 'plain query', tools: [{ type: 'web_search' }] } };

    await responsesBefore({ req, res, utils });
    expect(req.__pseudonymizationMap).toBeUndefined();

    const upstreamResponse: any = {
      output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: JSON.stringify({ query: `mail ${PII}` }) }],
    };
    await responsesAfter({ req, res, upstreamResponse, utils });

    expect(mockExecuteWebSearch).toHaveBeenCalledWith(`mail ${PII}`, utils.logger);
  });
});
