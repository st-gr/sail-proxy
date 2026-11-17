/**
 * Thinking round trip through the real routes (the unit behaviour is in
 * pseudonymization-thinking-roundtrip.test.ts): a deployed model streams thinking with a
 * placeholder, the client gets the value and a marked signature; its next request reaches the
 * deployment with the signature and the thinking the deployment produced, byte for byte.
 *
 * The controllers, awsBedrockService, plugin executor, plugin loader and pseudonymization plugin
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
    getBetaHeaderRenames: () => ({}),
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

// A Connection model: the decision and the dispatch are doubles; the test reads what the dispatch
// was handed.
const externalDecision: jest.Mock<any> = jest.fn();
const dispatched: jest.Mock<any> = jest.fn();
jest.mock('../src/upstreams/externalTarget', () => ({ resolveExternalTarget: (...a: any[]) => externalDecision(...a) }));
jest.mock('../src/upstreams/messagesDispatch', () => ({ dispatchMessages: (...a: any[]) => dispatched(...a) }));

import { handleBedrockRequest } from '../src/controllers/awsBedrockController';
import { handleMessages } from '../src/controllers/anthropicController';
import { RECORD_MARK, applyRecord, splitSignature } from '../src/pluginSupport/pseudonymization/thinkingRoundTrip';
import { EMAIL, PSEUDONYMIZATION_HOOK, TEXT, configFor, mockReq, registerPlugins, run } from './forcedRouteHarness';
import { decodeEventStream, payloadJson } from './bedrockEventStreamDecoder';

const PLACEHOLDER = /MASKED_EMAIL_[0-9a-f]+/;
const SIGNATURE = 'EqQBCkgIBhABGAIiQL9hb3V0cHV0K3NpZ25hdHVyZS9vZitDbGF1ZGU9PQ==';
const chains = {
  'aws-bedrock': { invoke: [PSEUDONYMIZATION_HOOK], 'invoke-with-response-stream': [PSEUDONYMIZATION_HOOK], 'converse-stream': [PSEUDONYMIZATION_HOOK] },
  anthropic: { invoke: [PSEUDONYMIZATION_HOOK], 'invoke-with-response-stream': [PSEUDONYMIZATION_HOOK] },
};

const invokeBody = (messages: any[]) => ({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 2048, thinking: { type: 'enabled', budget_tokens: 1024 }, messages });
const firstTurn = () => [{ role: 'user', content: [{ type: 'text', text: TEXT }] }];
/** Turn 2 of a tool loop, with the thinking block the client holds. */
const secondTurn = (thinking: any) => [
  ...firstTurn(),
  { role: 'assistant', content: [thinking, { type: 'tool_use', id: 't1', name: 'send', input: { to: EMAIL } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'sent' }] },
];
const sse = (event: unknown) => Buffer.from(`data: ${JSON.stringify(event)}\n\n`);
const ended = async (res: any) => {
  for (const deadline = Date.now() + 10000; !res.writableEnded && Date.now() < deadline;) await new Promise((r) => setTimeout(r, 10));
  expect(res.writableEnded).toBe(true);
};
const bedrock = (subpath: string, body: any) => run(handleBedrockRequest,
  mockReq(body, `/aws-bedrock/model/${NATIVE}/${subpath}`, { modelId: NATIVE, subpath }));

/** A deployment that thinks about the address it was given, in a stream; returns what it wrote. */
function streamingDeployment(): { masked: () => string } {
  let masked = '';
  upstream.mockImplementation(async (_url: any, body: any) => {
    const ph = JSON.stringify(body).match(PLACEHOLDER)![0];
    masked = `The user wants mail to ${ph} today.`;
    const cut = masked.indexOf(ph) + 6; // "MASKED" | "_EMAIL_…": the split the rehearsal hit
    return {
      status: 200,
      data: Readable.from([
        sse({ type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 1 } } }),
        sse({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
        sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: masked.slice(0, cut) } }),
        sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: masked.slice(cut) } }),
        sse({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: SIGNATURE } }),
        sse({ type: 'content_block_stop', index: 0 }),
        sse({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
        sse({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: `Sent to ${ph}.` } }),
        sse({ type: 'content_block_stop', index: 1 }),
        sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } }),
        sse({ type: 'message_stop' }),
      ]),
    };
  });
  return { masked: () => masked };
}

/** The Anthropic events of a binary Bedrock stream (`chunk` frames carry them base64-encoded). */
function eventsOf(res: any): any[] {
  const frames = decodeEventStream(Buffer.concat(res.writes.map((w: any) => (Buffer.isBuffer(w) ? w : Buffer.from(w)))));
  return frames.filter((f) => f.headers[':event-type'] === 'chunk').map((f) => JSON.parse(Buffer.from(payloadJson(f).bytes, 'base64').toString('utf8')));
}

beforeEach(() => {
  registerPlugins();
  externalDecision.mockReset();
  externalDecision.mockResolvedValue({ kind: 'sap' });
  dispatched.mockReset();
  (global as any).matcherCache?.clear?.();
  upstream.mockReset();
  upstream.mockImplementation(() => Promise.reject(new Error('upstream not reachable in this test')));
  mockConfig.api_config = configFor(['aws-bedrock', 'anthropic'], chains);
});

describe('thinking through the deployed Bedrock route', () => {
  it('stream, then the next turn: the client reads the value, the deployment gets its own text and signature back', async () => {
    const deployment = streamingDeployment();
    const first = await bedrock('invoke-with-response-stream', invokeBody(firstTurn()));
    await ended(first);

    const events = eventsOf(first);
    const thinking = events.filter((e) => e.delta?.type === 'thinking_delta').map((e) => e.delta.thinking).join('');
    const marked = events.filter((e) => e.delta?.type === 'signature_delta').map((e) => e.delta.signature).join('');
    expect(thinking).toBe(`The user wants mail to ${EMAIL} today.`);
    expect(events.filter((e) => e.delta?.type === 'text_delta').map((e) => e.delta.text).join('')).toBe(`Sent to ${EMAIL}.`);
    expect(JSON.stringify(events)).not.toMatch(/MASKED_/);
    expect(splitSignature(marked).signature).toBe(SIGNATURE);
    expect(applyRecord(thinking, splitSignature(marked).record!)).toBe(deployment.masked());

    // Turn 2: the client returns what it holds.
    upstream.mockReset();
    upstream.mockImplementation(async () => ({ status: 200, data: Readable.from([sse({ type: 'message_stop' })]) }));
    const second = await bedrock('invoke-with-response-stream', invokeBody(secondTurn({ type: 'thinking', thinking, signature: marked })));
    await ended(second);
    expect(upstream).toHaveBeenCalledTimes(1);
    const sent: any = upstream.mock.calls[0][1];
    expect(sent.messages[1].content[0]).toEqual({ type: 'thinking', thinking: deployment.masked(), signature: SIGNATURE });
    expect(JSON.stringify(sent)).not.toContain(EMAIL);
    expect(JSON.stringify(sent)).not.toContain(RECORD_MARK);
  });

  it('an answer in one piece: thinking restored and the signature marked', async () => {
    let masked = '';
    upstream.mockImplementation(async (_url: any, body: any) => {
      masked = `Mail ${JSON.stringify(body).match(PLACEHOLDER)![0]} now.`;
      return { status: 200, data: { id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'thinking', thinking: masked, signature: SIGNATURE }, { type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 5 } } };
    });
    const res = await bedrock('invoke', invokeBody(firstTurn()));
    expect(res.statusCode).toBe(200);
    const block = res.body.content[0];
    expect(block.thinking).toBe(`Mail ${EMAIL} now.`);
    expect(splitSignature(block.signature).signature).toBe(SIGNATURE);
    expect(applyRecord(block.thinking, splitSignature(block.signature).record!)).toBe(masked);
  });

  it('with masking off and no hook chain the next turn still reaches the deployment restored', async () => {
    // What a client holds from an earlier, masked turn.
    const deployment = streamingDeployment();
    const first = await bedrock('invoke-with-response-stream', invokeBody(firstTurn()));
    await ended(first);
    const events = eventsOf(first);
    const held = {
      type: 'thinking',
      thinking: events.filter((e) => e.delta?.type === 'thinking_delta').map((e) => e.delta.thinking).join(''),
      signature: events.filter((e) => e.delta?.type === 'signature_delta').map((e) => e.delta.signature).join(''),
    };

    mockConfig.api_config = configFor([], {}, false);
    upstream.mockReset();
    upstream.mockImplementation(async () => ({ status: 200, data: { id: 'm2', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } }));
    const res = await bedrock('invoke', invokeBody(secondTurn(held)));
    expect(res.statusCode).toBe(200);
    const sent: any = upstream.mock.calls[0][1];
    expect(sent.messages[1].content[0]).toEqual({ type: 'thinking', thinking: deployment.masked(), signature: SIGNATURE });
  });
});

describe('reasoning through the deployed Converse stream', () => {
  it('the client reads the value and gets one marked signature; the next turn reaches the deployment restored', async () => {
    let masked = '';
    upstream.mockImplementation(async (_url: any, body: any) => {
      const ph = JSON.stringify(body).match(PLACEHOLDER)![0];
      masked = `Mail ${ph} now.`;
      const cut = masked.indexOf(ph) + 9;
      // SAP's native Converse stream: single-quoted dicts.
      const events = [
        "data: {'messageStart': {'role': 'assistant'}}\n\n",
        `data: {'contentBlockDelta': {'delta': {'reasoningContent': {'text': '${masked.slice(0, cut)}'}}, 'contentBlockIndex': 0}}\n\n`,
        `data: {'contentBlockDelta': {'delta': {'reasoningContent': {'text': '${masked.slice(cut)}'}}, 'contentBlockIndex': 0}}\n\n`,
        `data: {'contentBlockDelta': {'delta': {'reasoningContent': {'signature': '${SIGNATURE}'}}, 'contentBlockIndex': 0}}\n\n`,
        "data: {'contentBlockStop': {'contentBlockIndex': 0}}\n\n",
        "data: {'contentBlockDelta': {'delta': {'text': 'ok'}, 'contentBlockIndex': 1}}\n\n",
        "data: {'contentBlockStop': {'contentBlockIndex': 1}}\n\n",
        "data: {'messageStop': {'stopReason': 'end_turn'}}\n\n",
        "data: {'metadata': {'usage': {'inputTokens': 10, 'outputTokens': 5, 'totalTokens': 15}}}\n\n",
      ];
      return { status: 200, data: Readable.from(events.map((e) => Buffer.from(e))) };
    });
    const converse = (messages: any[]) => ({ messages, inferenceConfig: { maxTokens: 2048 } });
    const first = await bedrock('converse-stream', converse([{ role: 'user', content: [{ text: TEXT }] }]));
    await ended(first);
    const frames = decodeEventStream(Buffer.concat(first.writes.map((w: any) => (Buffer.isBuffer(w) ? w : Buffer.from(w)))));
    const reasoning = frames.filter((f) => f.headers[':event-type'] === 'contentBlockDelta').map(payloadJson).map((d) => d.delta?.reasoningContent).filter(Boolean);
    const text = reasoning.map((r) => r.text ?? '').join('');
    const signatures = reasoning.filter((r) => typeof r.signature === 'string');
    expect(text).toBe(`Mail ${EMAIL} now.`);
    expect(signatures).toHaveLength(1);
    expect(applyRecord(text, splitSignature(signatures[0].signature).record!)).toBe(masked);

    upstream.mockReset();
    upstream.mockImplementation(async () => ({ status: 200, data: Readable.from([Buffer.from("data: {'messageStop': {'stopReason': 'end_turn'}}\n\n")]) }));
    const second = await bedrock('converse-stream', converse([
      { role: 'user', content: [{ text: TEXT }] },
      { role: 'assistant', content: [{ reasoningContent: { reasoningText: { text, signature: signatures[0].signature } } }, { text: 'ok' }] },
      { role: 'user', content: [{ text: 'go on' }] },
    ]));
    await ended(second);
    const sent: any = upstream.mock.calls[0][1];
    expect(sent.messages[1].content[0].reasoningContent.reasoningText).toEqual({ text: masked, signature: SIGNATURE });
    expect(JSON.stringify(sent)).not.toContain(EMAIL);
    expect(JSON.stringify(sent)).not.toContain(RECORD_MARK);
  });
});

describe('thinking through the Anthropic route', () => {
  it('the next turn reaches the deployment with the signature and the text it produced', async () => {
    const DEPLOYED = 'claude-sonnet-4--deployed';
    // The first turn through /aws-bedrock gives the client its copy; the routes share the record.
    const deployment = streamingDeployment();
    const first = await bedrock('invoke-with-response-stream', invokeBody(firstTurn()));
    await ended(first);
    const events = eventsOf(first);
    const held = {
      type: 'thinking',
      thinking: events.filter((e) => e.delta?.type === 'thinking_delta').map((e) => e.delta.thinking).join(''),
      signature: events.filter((e) => e.delta?.type === 'signature_delta').map((e) => e.delta.signature).join(''),
    };
    expect(held.thinking).toContain(EMAIL);

    upstream.mockReset();
    upstream.mockImplementation(async () => ({ status: 200, data: { id: 'm2', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } }));
    const res = await run(handleMessages, mockReq({ model: DEPLOYED, max_tokens: 2048, messages: secondTurn(held) }, '/anthropic/v1/messages'));
    expect(res.statusCode).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    const sent: any = upstream.mock.calls[0][1];
    expect(sent.messages[1].content[0]).toEqual({ type: 'thinking', thinking: deployment.masked(), signature: SIGNATURE });
    expect(JSON.stringify(sent)).not.toContain(EMAIL);
    expect(JSON.stringify(sent)).not.toContain(RECORD_MARK);
  });

  it('a model served by a connection: its dispatch gets the request restored too', async () => {
    const deployment = streamingDeployment();
    const first = await bedrock('invoke-with-response-stream', invokeBody(firstTurn()));
    await ended(first);
    const events = eventsOf(first);
    const held = {
      type: 'thinking',
      thinking: events.filter((e) => e.delta?.type === 'thinking_delta').map((e) => e.delta.thinking).join(''),
      signature: events.filter((e) => e.delta?.type === 'signature_delta').map((e) => e.delta.signature).join(''),
    };

    let handed: any;
    externalDecision.mockResolvedValue({ kind: 'external', target: { connection: {}, model: {}, adapter: {} } });
    dispatched.mockImplementation(async (req: any, res: any) => {
      handed = JSON.parse(JSON.stringify({ body: req.body, exact: Array.from(req.__thinkingExact || []) }));
      res.status(200).json({ ok: true });
    });
    await run(handleMessages, mockReq({ model: 'claude-via-connection', max_tokens: 2048, messages: secondTurn(held) }, '/anthropic/v1/messages'));
    expect(dispatched).toHaveBeenCalledTimes(1);
    expect(handed.body.messages[1].content[0]).toEqual({ type: 'thinking', thinking: deployment.masked(), signature: SIGNATURE });
    expect(handed.exact).toEqual([SIGNATURE]);
  });
});
