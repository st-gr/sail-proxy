/**
 * Forced pseudonymization on the deployed /aws-bedrock routes, for bodies that are not Anthropic
 * messages: Bedrock Converse (`converse`, `converse-stream`) and the Amazon Nova invoke body (the
 * same untyped `{ text }` blocks) are masked before the deployment and restored in the answer,
 * streamed or not; a body the plugin has no extractor for (a Llama/Mistral `prompt`, a Titan
 * `inputText`) is refused with 503 `pseudonymization_failed`, never sent unmasked.
 *
 * The controller, awsBedrockService, plugin executor, plugin loader and pseudonymization plugin
 * are the REAL modules; configService, modelService and axios (the deployment) are mocked.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Readable } from 'stream';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {} }),
  createSafePreview: () => '',
  createHeadersPreview: () => '',
}));

const mockConfig: any = { api_config: {} };
jest.mock('../src/services/configService', () => {
  const svc: Record<string, any> = {
    getConfig: () => mockConfig,
    get: () => undefined,
    getSubstitutedModel: (_p: string, m: string) => m,
    getHookConfig: (modelId: string, subpath: string, endpoint?: string) => {
      const override = mockConfig.api_config.models?.overrides?.[modelId]?.hooks?.[subpath];
      if (override) return override;
      return endpoint ? mockConfig.api_config.hooks?.defaults?.[endpoint]?.[subpath] || null : null;
    },
    shouldEmulateStreaming: () => false,
    getUnsupportedParams: () => [],
    getParamRenames: () => ({}),
    getSAPAICoreConfig: () => ({ url: 'http://mock-sap', resourceGroup: 'default' }),
    getTimeout: () => 1000,
    getWebSearchMaxSearches: () => 0,
    getSupportedBetaHeaders: () => [],
    getExcludedBetaHeaders: () => [],
  };
  const proxy = new Proxy(svc, { get: (t, k: string) => (k in t ? t[k] : (k === '__esModule' ? true : () => undefined)) });
  return { __esModule: true, default: proxy, ...svc };
});

const NATIVE = 'anthropic--claude-4-sonnet--deployed';
jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: (m: string) => Promise.resolve(m === 'anthropic--claude-4-sonnet--deployed'
      ? {
        id: m, owned_by: 'anthropic', executableId: 'aws-bedrock', accessType: 'deployment',
        deploymentUrl: 'https://deployed.example.com/native',
        subpaths_native: ['invoke', 'invoke-with-response-stream', 'converse', 'converse-stream'],
      }
      : require('./forcedRouteHarness').catalogueDetails(m)),
    modelSupportsStreaming: () => true,
    getAuthToken: () => Promise.resolve('tok'),
    markModelAsNonStreaming: () => {},
  },
}));

const upstream: jest.Mock<any> = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: (...a: any[]) => upstream(...a), get: (...a: any[]) => upstream(...a) },
}));

jest.mock('../src/utils/payloadLogger', () => ({ savePayload: () => {}, isPayloadLoggingEnabled: () => false }));
jest.mock('../src/utils/usageTracker', () => ({
  createUsageMetrics: () => ({
    startTime: Date.now(), inputTokens: 0, outputTokens: 0,
    cacheCreationInputTokens: 0, cacheReadInputTokens: 0, imageInputTokens: 0,
  }),
  emitUsageEvent: () => {},
  updateTokenCounts: () => {},
}));

import { handleBedrockRequest } from '../src/controllers/awsBedrockController';
import pseudonymizationRules = require('../src/plugins/pseudonymization/index');
import { EMAIL, PSEUDONYMIZATION_HOOK, configFor, mockReq, registerPlugins, run } from './forcedRouteHarness';
import { decodeEventStream, payloadJson } from './bedrockEventStreamDecoder';

const PLACEHOLDER = /MASKED_EMAIL_[0-9a-f]+/;
const chains = { 'aws-bedrock': { invoke: [PSEUDONYMIZATION_HOOK], 'invoke-with-response-stream': [PSEUDONYMIZATION_HOOK], converse: [PSEUDONYMIZATION_HOOK], 'converse-stream': [PSEUDONYMIZATION_HOOK] } };

const bedrock = (model: string, subpath: string, body: any) => run(handleBedrockRequest,
  mockReq(body, `/aws-bedrock/model/${model}/${subpath}`, { modelId: model, subpath }));

/** The body the deployment received, and the placeholder it carries for EMAIL. */
function sent(): { body: any; placeholder: string } {
  expect(upstream).toHaveBeenCalledTimes(1);
  const body = upstream.mock.calls[0][1];
  const text = JSON.stringify(body);
  expect(text).not.toContain(EMAIL);
  const placeholder = text.match(PLACEHOLDER)?.[0];
  expect(placeholder).toBeDefined();
  return { body, placeholder: placeholder! };
}

const converseBody = () => ({
  system: [{ text: `Customer contact: ${EMAIL}` }],
  messages: [
    { role: 'user', content: [{ text: `Email ${EMAIL} the invoice.` }] },
    { role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name: 'lookup', input: { email: EMAIL, tags: [EMAIL] } } }] },
    {
      role: 'user',
      content: [{ toolResult: { toolUseId: 't1', content: [{ text: `Found ${EMAIL}` }, { json: { owner: EMAIL } }] } }],
    },
  ],
  inferenceConfig: { maxTokens: 64 },
});

beforeEach(() => {
  registerPlugins();
  (global as any).matcherCache?.clear?.();
  upstream.mockReset();
  upstream.mockImplementation(() => Promise.reject(new Error('upstream not reachable in this test')));
  mockConfig.api_config = configFor(['aws-bedrock'], chains);
});

describe('the plugin on a Converse body, forced', () => {
  it('masks system, message text, tool-call input and tool-result text and json; the note is an untyped system block', async () => {
    const before = (pseudonymizationRules as any[]).find((r) => r.strategy === 'before').handler;
    const req: any = { __endpoint: 'aws-bedrock', body: converseBody(), headers: {} };
    const res: any = { json: jest.fn(), status: jest.fn(() => res) };
    const r = await before({ req, res, utils: { logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} } } });

    expect(r).toEqual({ stop: false });
    const text = JSON.stringify(req.body);
    expect(text).not.toContain(EMAIL);
    expect(req.body.system[0].text).toMatch(PLACEHOLDER);
    expect(req.body.messages[0].content[0].text).toMatch(PLACEHOLDER);
    expect(req.body.messages[1].content[0].toolUse.input.email).toMatch(PLACEHOLDER);
    expect(req.body.messages[1].content[0].toolUse.input.tags[0]).toMatch(PLACEHOLDER);
    expect(req.body.messages[2].content[0].toolResult.content[0].text).toMatch(PLACEHOLDER);
    expect(req.body.messages[2].content[0].toolResult.content[1].json.owner).toMatch(PLACEHOLDER);
    const note = req.body.system[req.body.system.length - 1];
    expect(Object.keys(note)).toEqual(['text']);
    expect(note.text).toContain('MASKED_<TYPE>_<id>');
  });
});

describe('deployed Converse, forced', () => {
  it('converse: the deployment receives the masked body, the client the restored answer', async () => {
    upstream.mockImplementation(async (_url: any, body: any) => {
      const ph = JSON.stringify(body).match(PLACEHOLDER)![0];
      return {
        status: 200,
        data: {
          output: { message: { role: 'assistant', content: [{ text: `Sent to ${ph}.` }, { toolUse: { toolUseId: 't2', name: 'send', input: { to: ph } } }] } },
          stopReason: 'tool_use',
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      };
    });
    const res = await bedrock(NATIVE, 'converse', converseBody());

    const { body } = sent();
    expect(upstream.mock.calls[0][0]).toMatch(/\/converse$/);
    expect(body.system[0].text).toMatch(PLACEHOLDER);
    expect(res.statusCode).toBe(200);
    expect(res.body.output.message.content[0].text).toBe(`Sent to ${EMAIL}.`);
    expect(res.body.output.message.content[1].toolUse.input).toEqual({ to: EMAIL });
    expect(JSON.stringify(res.body)).not.toMatch(PLACEHOLDER);
  });

  it('converse, emulated (no native converse): masked before the deployment', async () => {
    upstream.mockImplementation(async () => ({ status: 200, data: { output: { message: { role: 'assistant', content: [{ text: 'ok' }] } }, stopReason: 'end_turn' } }));
    await bedrock('bedrock-claude--deployed', 'converse', converseBody());
    sent();
  });

  it('converse-stream: masked before the deployment; a placeholder split across deltas reaches the client restored', async () => {
    upstream.mockImplementation(async (_url: any, body: any) => {
      const ph = JSON.stringify(body).match(PLACEHOLDER)![0];
      const half = Math.floor(ph.length / 2);
      // SAP's native Converse stream: single-quoted dicts.
      const events = [
        "data: {'messageStart': {'role': 'assistant'}}\n\n",
        `data: {'contentBlockDelta': {'delta': {'text': 'Sent to ${ph.slice(0, half)}'}, 'contentBlockIndex': 0}}\n\n`,
        `data: {'contentBlockDelta': {'delta': {'text': '${ph.slice(half)}.'}, 'contentBlockIndex': 0}}\n\n`,
        "data: {'contentBlockStop': {'contentBlockIndex': 0}}\n\n",
        `data: {'contentBlockStart': {'start': {'toolUse': {'toolUseId': 't2', 'name': 'send'}}, 'contentBlockIndex': 1}}\n\n`,
        `data: {'contentBlockDelta': {'delta': {'toolUse': {'input': '{"to": "${ph.slice(0, half)}'}}, 'contentBlockIndex': 1}}\n\n`,
        `data: {'contentBlockDelta': {'delta': {'toolUse': {'input': '${ph.slice(half)}"}'}}, 'contentBlockIndex': 1}}\n\n`,
        "data: {'contentBlockStop': {'contentBlockIndex': 1}}\n\n",
        "data: {'messageStop': {'stopReason': 'tool_use'}}\n\n",
        "data: {'metadata': {'usage': {'inputTokens': 10, 'outputTokens': 5, 'totalTokens': 15}}}\n\n",
      ];
      return { status: 200, data: Readable.from(events.map((e) => Buffer.from(e))) };
    });
    const req = mockReq(converseBody(), `/aws-bedrock/model/${NATIVE}/converse-stream`, { modelId: NATIVE, subpath: 'converse-stream' });
    const res = await run(handleBedrockRequest, req);
    await new Promise((r) => res.writableEnded ? r(null) : setTimeout(r, 200));

    sent();
    const frames = decodeEventStream(Buffer.concat(res.writes.map((w: any) => (Buffer.isBuffer(w) ? w : Buffer.from(w)))));
    const deltas = frames.filter((f) => f.headers[':event-type'] === 'contentBlockDelta').map(payloadJson);
    const text = deltas.filter((d) => d.contentBlockIndex === 0).map((d) => d.delta.text ?? '').join('');
    const input = deltas.filter((d) => d.contentBlockIndex === 1).map((d) => d.delta.toolUse?.input ?? '').join('');
    expect(text).toBe(`Sent to ${EMAIL}.`);
    expect(JSON.parse(input)).toEqual({ to: EMAIL });
    expect(frames.map((f) => f.payload.toString('utf8')).join('')).not.toMatch(/MASKED_/);
  });
});

describe('deployed invoke, forced, bodies that are not Anthropic messages', () => {
  it('a Nova body (untyped text blocks) is masked before the deployment', async () => {
    upstream.mockImplementation(async (_url: any, body: any) => {
      const ph = JSON.stringify(body).match(PLACEHOLDER)![0];
      return { status: 200, data: { output: { message: { role: 'assistant', content: [{ text: `Hi ${ph}` }] } }, stopReason: 'end_turn' } };
    });
    const nova = { schemaVersion: 'messages-v1', system: [{ text: `Mail ${EMAIL}` }], messages: [{ role: 'user', content: [{ text: `Write to ${EMAIL}` }] }] };
    const res = await bedrock(NATIVE, 'invoke', nova);

    sent();
    expect(res.body.output.message.content[0].text).toBe(`Hi ${EMAIL}`);
  });

  it.each([
    ['Llama / Mistral prompt', { prompt: `<s>[INST] Write to ${EMAIL} [/INST]`, max_gen_len: 64 }],
    ['Titan inputText', { inputText: `Write to ${EMAIL}` }],
    ['Cohere message', { message: `Write to ${EMAIL}`, chat_history: [] }],
    ['no conversation at all', { foo: EMAIL }],
  ])('%s: 503 pseudonymization_failed, the deployment is never called', async (_n, body) => {
    const res = await bedrock(NATIVE, 'invoke', body);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: { message: expect.any(String), type: 'api_error', code: 'pseudonymization_failed' } });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('not forced, a prompt body still reaches the deployment', async () => {
    mockConfig.api_config = configFor([], chains);
    upstream.mockImplementation(async () => ({ status: 200, data: { generation: 'ok' } }));
    await bedrock(NATIVE, 'invoke', { prompt: `Write to ${EMAIL}` });
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
