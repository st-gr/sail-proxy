/**
 * The /aws-bedrock controller answers its streaming subpaths in AWS event stream
 * framing (see bedrock-eventstream-encoder.test.ts for the format) and leaves
 * everything above the socket on SSE: a before-plugin that wraps res.write — as the
 * response cache and pseudonymization do — still reads the SSE the service writes.
 * Non-streaming subpaths keep their JSON.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { decodeEventStream, chunkEvent } from './bedrockEventStreamDecoder';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
  createSafePreview: jest.fn(() => ''),
  createHeadersPreview: jest.fn(() => ''),
}));
jest.mock('../src/config/unifiedAuthConfig', () => ({ __esModule: true, isStandaloneMode: jest.fn(() => false) }));
jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: { getModelDetails: jest.fn(async () => ({ id: 'test-model', executableId: 'aws-bedrock', accessType: 'deployment' })) },
}));
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getSubstitutedModel: (_provider: string, modelId: string) => modelId,
    getHookConfig: () => ({ before: [] }),
    getConfig: () => ({ api_config: { platform: { logging: { payload_logging_enabled: false } } } }),
  },
}));

/** What a write-wrapping before-plugin saw. */
let pluginSaw = '';
jest.mock('../src/services/pluginExecutor', () => ({
  __esModule: true,
  executeBeforePlugins: jest.fn(async (_req: any, res: any) => {
    const write = res.write.bind(res);
    res.write = (chunk: any, ...rest: any[]) => { pluginSaw += String(chunk); return write(chunk, ...rest); };
    return { stop: false };
  }),
  executeAfterPlugins: jest.fn(async (_req: any, _res: any, data: any) => data),
}));

const mockProcess = jest.fn<(...args: any[]) => any>();
jest.mock('../src/services/awsBedrockService', () => ({
  __esModule: true,
  default: { processBedrockRequest: (...args: any[]) => (mockProcess as any)(...args) },
}));

import * as sseWriter from '../src/utils/sseWriter';
import { executeAfterPlugins } from '../src/services/pluginExecutor';
import { handleBedrockRequest } from '../src/controllers/awsBedrockController';

let server: Server;
let base: string;
beforeEach(async () => {
  pluginSaw = '';
  mockProcess.mockReset();
  (executeAfterPlugins as jest.Mock).mockClear();
  const app = express();
  app.use(express.json());
  app.post('/aws-bedrock/model/:modelId/:subpath', (req, res, next) => {
    (req as any).unifiedAuth = { valid: true, authType: 'aws_credential', data: { id: 'aws-key-1' } };
    return handleBedrockRequest(req as any, res, next);
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

const post = (subpath: string) => fetch(`${base}/aws-bedrock/model/test-model/${subpath}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
});

describe('awsBedrockController: AWS event stream on streaming subpaths', () => {
  it('invoke-with-response-stream: frames on the wire, SSE for the plugin above', async () => {
    mockProcess.mockImplementation(async ({ res }: any) => {
      sseWriter.writeEventStream(res, 'message_start', '{"type":"message_start","message":{"role":"assistant"}}');
      sseWriter.writeEventStream(res, 'message_stop', '{"type":"message_stop"}');
      res.end();
    });
    const r = await post('invoke-with-response-stream');
    expect(r.headers.get('content-type')).toBe('application/vnd.amazon.eventstream');
    const frames = decodeEventStream(Buffer.from(await r.arrayBuffer()));
    expect(frames.map(chunkEvent)).toEqual([
      { type: 'message_start', message: { role: 'assistant' } },
      { type: 'message_stop' },
    ]);
    expect(pluginSaw).toContain('event: message_start\ndata: ');
  });

  it('converse-stream is framed as Converse events', async () => {
    mockProcess.mockImplementation(async ({ res }: any) => {
      sseWriter.writeChunk(res, { messageStart: { role: 'assistant' } });
      res.end();
    });
    const r = await post('converse-stream');
    expect(r.headers.get('content-type')).toBe('application/vnd.amazon.eventstream');
    expect(decodeEventStream(Buffer.from(await r.arrayBuffer())).map((f) => f.headers[':event-type'])).toEqual(['messageStart']);
  });

  it('a stream that fails before its first frame answers with the status and a JSON error', async () => {
    mockProcess.mockRejectedValue(Object.assign(new Error('quota exceeded'), { status: 429 }));
    const r = await post('invoke-with-response-stream');
    expect(r.status).toBe(429);
    expect(r.headers.get('content-type')).toMatch(/^application\/json/);
    expect(((await r.json()) as any).error.message).toBe('quota exceeded');
  });

  it('invoke (not streaming) keeps its JSON answer', async () => {
    mockProcess.mockResolvedValue({ content: [{ type: 'text', text: 'pong' }], usage: { input_tokens: 1, output_tokens: 1 } });
    const r = await post('invoke');
    expect(r.headers.get('content-type')).toMatch(/^application\/json/);
    expect(((await r.json()) as any).content[0].text).toBe('pong');
  });
});

describe('awsBedrockController: after-plugins', () => {
  // The service runs the after-plugins itself once a stream has ended, with the captured
  // events. The controller's own call came while the stream was still running, with no
  // result, and the pseudonymization plugin logged "returned undefined" for every stream.
  it('a streaming request leaves the after-plugins to the service', async () => {
    mockProcess.mockImplementation(async ({ res }: any) => { res.end(); });
    await (await post('invoke-with-response-stream')).arrayBuffer();
    expect(executeAfterPlugins).not.toHaveBeenCalled();
  });

  it('a non-streaming request still runs them on its result', async () => {
    mockProcess.mockResolvedValue({ content: [], usage: { input_tokens: 1, output_tokens: 1 } });
    await (await post('invoke')).json();
    expect(executeAfterPlugins).toHaveBeenCalledTimes(1);
  });
});
