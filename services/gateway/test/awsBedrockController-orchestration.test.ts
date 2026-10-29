/**
 * /aws-bedrock on a model without a deployment. The route used to send every model to
 * `/v2/inference/deployments/<configurationId>`, which SAP answers 404 ("Deployment not found") —
 * a configuration is not a deployment — so only `--deployed` models worked. Such models are now
 * served through SAP orchestration by handing the request to the /anthropic flow (entitlement,
 * plugins, streaming, usage and errors as there): invoke bodies are Anthropic Messages already,
 * Converse bodies are translated (bedrockConverse.ts), answers go back in Bedrock's shape, and the
 * Bedrock controller emits no usage of its own for them (the /anthropic flow does).
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { decodeEventStream, chunkEvent, payloadJson } from './bedrockEventStreamDecoder';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
  createSafePreview: jest.fn(() => ''),
  createHeadersPreview: jest.fn(() => ''),
}));
jest.mock('../src/config/unifiedAuthConfig', () => ({ __esModule: true, isStandaloneMode: jest.fn(() => false) }));
const details: Record<string, any> = {
  'anthropic--claude-4.5-haiku': { id: 'anthropic--claude-4.5-haiku', executableId: 'aws-bedrock', owned_by: 'anthropic' },
  'amazon--nova-pro': { id: 'amazon--nova-pro', executableId: 'aws-bedrock', owned_by: 'amazon' },
  'anthropic--claude-4.5-haiku--deployed': { id: 'anthropic--claude-4.5-haiku--deployed', executableId: 'aws-bedrock', accessType: 'deployment', deploymentUrl: 'https://sap/d1' },
};
jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: { getModelDetails: jest.fn(async (id: string) => details[id] ?? null) },
}));
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getSubstitutedModel: (_provider: string, modelId: string) => modelId,
    getHookConfig: () => undefined,
    getConfig: () => ({ api_config: { platform: { logging: { payload_logging_enabled: false } } } }),
  },
}));
jest.mock('../src/services/pluginExecutor', () => ({
  __esModule: true,
  executeBeforePlugins: jest.fn(async () => ({ stop: false })),
  executeAfterPlugins: jest.fn(async (_req: any, _res: any, data: any) => data),
}));
const mockProcess = jest.fn<(...args: any[]) => any>();
jest.mock('../src/services/awsBedrockService', () => ({
  __esModule: true,
  default: { processBedrockRequest: (...args: any[]) => mockProcess(...args) },
}));
const mockHandleMessages = jest.fn<(...args: any[]) => any>();
jest.mock('../src/controllers/anthropicController', () => ({
  __esModule: true,
  handleMessages: (...args: any[]) => mockHandleMessages(...args),
}));
const mockEmitUsage = jest.fn();
jest.mock('../src/utils/usageTracker', () => ({
  __esModule: true,
  createUsageMetrics: () => ({}),
  updateTokenCounts: jest.fn(),
  emitUsageEvent: (...args: any[]) => mockEmitUsage(...args),
}));

import * as sseWriter from '../src/utils/sseWriter';
import { handleBedrockRequest } from '../src/controllers/awsBedrockController';

let server: Server;
let base: string;
beforeEach(async () => {
  mockProcess.mockReset();
  mockHandleMessages.mockReset();
  mockEmitUsage.mockReset();
  const app = express();
  app.use(express.json());
  app.post('/aws-bedrock/model/:modelId/:subpath', (req, res, next) => {
    (req as any).unifiedAuth = { valid: true, authType: 'aws_credential', data: { id: 'aws-key-1' } };
    return handleBedrockRequest(req as any, res, next);
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));

const post = (model: string, subpath: string, body: any) => fetch(`${base}/aws-bedrock/model/${model}/${subpath}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const anthropicAnswer = {
  id: 'msg_1', type: 'message', role: 'assistant', model: 'anthropic--claude-4.5-haiku',
  content: [{ type: 'text', text: 'pong' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 1 },
};
const invokeBody = { anthropic_version: 'bedrock-2023-05-31', max_tokens: 50, messages: [{ role: 'user', content: 'ping' }] };
const converseBody = { messages: [{ role: 'user', content: [{ text: 'ping' }] }], inferenceConfig: { maxTokens: 50 } };

describe('awsBedrockController: models without a deployment go through orchestration', () => {
  it('invoke: the Anthropic body reaches the /anthropic flow; its answer is the invoke answer', async () => {
    mockHandleMessages.mockImplementation(async (req: any, res: any) => {
      expect(req.body).toEqual({ max_tokens: 50, messages: [{ role: 'user', content: 'ping' }], model: 'anthropic--claude-4.5-haiku', stream: false });
      res.json(anthropicAnswer);
    });
    const r = await post('anthropic--claude-4.5-haiku', 'invoke', invokeBody);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(anthropicAnswer);
    expect(mockProcess).not.toHaveBeenCalled();
    expect(mockEmitUsage).not.toHaveBeenCalled();
  });

  it('invoke-with-response-stream: the Anthropic SSE goes out as Bedrock chunk frames', async () => {
    mockHandleMessages.mockImplementation(async (req: any, res: any) => {
      expect(req.body.stream).toBe(true);
      sseWriter.writeEventStream(res, 'message_start', '{"type":"message_start","message":{"role":"assistant"}}');
      sseWriter.writeEventStream(res, 'message_stop', '{"type":"message_stop"}');
      res.end();
    });
    const r = await post('anthropic--claude-4.5-haiku', 'invoke-with-response-stream', invokeBody);
    expect(r.headers.get('content-type')).toBe('application/vnd.amazon.eventstream');
    expect(decodeEventStream(Buffer.from(await r.arrayBuffer())).map(chunkEvent).map((e) => e.type)).toEqual(['message_start', 'message_stop']);
  });

  it('converse: the request is translated in, the answer out', async () => {
    mockHandleMessages.mockImplementation(async (req: any, res: any) => {
      expect(req.body).toEqual({ model: 'anthropic--claude-4.5-haiku', stream: false, max_tokens: 50, messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }] });
      res.json(anthropicAnswer);
    });
    const r = await post('anthropic--claude-4.5-haiku', 'converse', converseBody);
    const body: any = await r.json();
    expect(body.output).toEqual({ message: { role: 'assistant', content: [{ text: 'pong' }] } });
    expect(body.stopReason).toBe('end_turn');
    expect(body.usage).toEqual({ inputTokens: 5, outputTokens: 1, totalTokens: 6 });
    expect(mockEmitUsage).not.toHaveBeenCalled();
  });

  it('converse-stream: Anthropic events go out as Converse frames', async () => {
    mockHandleMessages.mockImplementation(async (_req: any, res: any) => {
      sseWriter.writeEventStream(res, 'message_start', '{"type":"message_start","message":{"role":"assistant","usage":{"input_tokens":5,"output_tokens":1}}}');
      sseWriter.writeEventStream(res, 'content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pong"}}');
      sseWriter.writeEventStream(res, 'message_delta', '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}');
      sseWriter.writeEventStream(res, 'message_stop', '{"type":"message_stop"}');
      res.end();
    });
    const r = await post('anthropic--claude-4.5-haiku', 'converse-stream', converseBody);
    const frames = decodeEventStream(Buffer.from(await r.arrayBuffer()));
    expect(frames.map((f) => f.headers[':event-type'])).toEqual(['messageStart', 'contentBlockDelta', 'messageStop', 'metadata']);
    expect(payloadJson(frames[1])).toEqual({ contentBlockIndex: 0, delta: { text: 'pong' } });
  });

  it('a stream the /anthropic flow answered without streaming (Nova) still leaves as stream frames', async () => {
    mockHandleMessages.mockImplementation(async (_req: any, res: any) => { res.json(anthropicAnswer); });
    const r = await post('amazon--nova-pro', 'converse-stream', converseBody);
    expect(r.headers.get('content-type')).toBe('application/vnd.amazon.eventstream');
    const frames = decodeEventStream(Buffer.from(await r.arrayBuffer()));
    expect(frames.map((f) => f.headers[':event-type'])).toEqual(['messageStart', 'contentBlockDelta', 'contentBlockStop', 'messageStop', 'metadata']);
    expect(payloadJson(frames[1])).toEqual({ contentBlockIndex: 0, delta: { text: 'pong' } });
  });

  it('an error from the /anthropic flow answers in Bedrock\'s shape', async () => {
    mockHandleMessages.mockImplementation(async (_req: any, res: any) => {
      res.status(429).json({ type: 'error', error: { type: 'rate_limit_error', message: 'quota exceeded' } });
    });
    const r = await post('anthropic--claude-4.5-haiku', 'converse', converseBody);
    expect(r.status).toBe(429);
    expect(r.headers.get('x-amzn-errortype')).toBe('ThrottlingException');
    expect(await r.json()).toEqual({ message: 'quota exceeded' });
  });

  it('invoke on a non-Claude model without a deployment is refused with a pointer to converse', async () => {
    const r = await post('amazon--nova-pro', 'invoke', { messages: [] });
    expect(r.status).toBe(400);
    expect(r.headers.get('x-amzn-errortype')).toBe('ValidationException');
    expect(((await r.json()) as any).message).toMatch(/converse/);
    expect(mockHandleMessages).not.toHaveBeenCalled();
  });

  it('converse on a non-Claude model without a deployment goes through orchestration too', async () => {
    mockHandleMessages.mockImplementation(async (_req: any, res: any) => { res.json(anthropicAnswer); });
    const r = await post('amazon--nova-pro', 'converse', converseBody);
    expect(r.status).toBe(200);
    expect(mockHandleMessages).toHaveBeenCalledTimes(1);
  });

  it('a deployed model still goes to its deployment', async () => {
    mockProcess.mockResolvedValue(anthropicAnswer);
    const r = await post('anthropic--claude-4.5-haiku--deployed', 'invoke', invokeBody);
    expect(r.status).toBe(200);
    expect(mockProcess).toHaveBeenCalledTimes(1);
    expect(mockHandleMessages).not.toHaveBeenCalled();
  });
});
