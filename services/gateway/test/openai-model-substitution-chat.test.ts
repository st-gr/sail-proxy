/**
 * A renamed chat completion end to end: substituteOpenAICompatibleModel in front of
 * handleChatCompletion, the way routes/chatRoutes.ts chains them, with SAP AI Core
 * mocked at sapAIService. Proves what reaches upstream, what the client reads back
 * (non-streaming and every streamed chunk) and which name the usage event records.
 *
 * The response reports the name the request was forwarded under, like the
 * anthropic, aws-bedrock and openrouter paths do; usage is recorded under that
 * upstream name too, since cost is per real model.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

// The rename lists under test, keyed by provider, read through getSubstitutedModel's
// own contract (first exact match, else the input unchanged).
const renames: Record<string, Array<{ from: string; to: string }>> = {
  openai: [{ from: 'GPT-4', to: 'o1' }, { from: 'GPT-3.5', to: 'GPT-4' }],
  perplexity: [{ from: 'web-answers', to: 'sonar-pro' }],
  anthropic: [{ from: 'claude-3-5-haiku-20241022', to: 'anthropic--claude-4.5-haiku' }],
};
const substitutedFor = jest.fn((provider: string, model: string) =>
  (renames[provider] || []).find((r) => r.from === model)?.to ?? model);

jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    // Read by the forced-pseudonymization check: nothing forces masking here.
    getConfig: () => ({}),
    getSubstitutedModel: (provider: string, model: string) => substitutedFor(provider, model),
    shouldEmulateStreaming: () => false,
    getUnsupportedParams: () => [],
    getParamRenames: () => ({}),
    getHookConfig: () => undefined,
    getSAPAICoreConfig: () => ({ url: 'http://mock-sap', resourceGroup: 'default' }),
    getOpenAIDeploymentApiVersion: () => undefined,
  },
}));

const ownerOf = (model: string) => (model.startsWith('sonar') ? 'perplexity' : model.startsWith('anthropic--') ? 'anthropic' : 'openai');
jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: (model: string) => Promise.resolve({ id: model, owned_by: ownerOf(model) }),
    modelSupportsStreaming: () => true,
    getAuthToken: () => Promise.resolve('tok'),
    markModelAsNonStreaming: () => {},
  },
}));

jest.mock('../src/utils/modelUtils', () => ({
  mapModelParameters: (p: Record<string, any>) => ({ ...p }),
  getDefaultParameters: () => ({}),
}));

jest.mock('../src/services/pluginExecutor', () => ({
  executeBeforePlugins: () => Promise.resolve({ stop: false }),
  executeAfterPlugins: (_req: any, _res: any, body: any) => Promise.resolve(body),
}));

jest.mock('../src/utils/payloadLogger', () => ({
  savePayload: () => {},
}));

const upstreamModels: string[] = [];
const upstreamName = (payload: any) => payload.config.modules.prompt_templating.model.name;

jest.mock('../src/services/sapAIService', () => ({
  __esModule: true,
  default: {
    completeChat: (payload: any) => {
      upstreamModels.push(upstreamName(payload));
      return Promise.resolve({
        final_result: {
          id: 'chatcmpl-up', model: upstreamName(payload),
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        },
      });
    },
    streamChatCompletion: async (payload: any, onChunk: any) => {
      upstreamModels.push(upstreamName(payload));
      // SAP labels some chunks with a model of its own; the gateway restamps every chunk.
      await onChunk({ final_result: { id: 'c1', model: 'gpt-4', choices: [{ index: 0, delta: { role: 'assistant', content: 'h' }, finish_reason: null }] } });
      await onChunk({
        final_result: {
          id: 'c2', model: upstreamName(payload),
          choices: [{ index: 0, delta: { content: 'i' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        },
      });
      await onChunk({ done: true });
    },
  },
}));

const usageModels: string[] = [];
jest.mock('../src/utils/usageTracker', () => ({
  createUsageMetrics: () => ({ startTime: Date.now(), inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }),
  emitUsageEvent: (...args: any[]) => { usageModels.push(args[2] as string); },
  updateTokenCounts: (m: any, input: number, output: number, cacheCreation?: number, cacheRead?: number) => {
    m.inputTokens += input || 0;
    m.outputTokens += output || 0;
    m.cacheCreationInputTokens += cacheCreation || 0;
    m.cacheReadInputTokens += cacheRead || 0;
  },
}));

import { handleChatCompletion } from '../src/controllers/openaiController';
import { substituteOpenAICompatibleModel } from '../src/middlewares/modelSubstitution';

const app = express();
app.use(express.json());
app.post('/v1/chat/completions', substituteOpenAICompatibleModel, handleChatCompletion as any);

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !cond(); i++) await new Promise<void>((r) => setImmediate(r));
}

/** The JSON objects of an SSE body, [DONE] left out. */
function sseObjects(text: string): any[] {
  return text.split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice('data: '.length)));
}

const ask = (model: string, extra: Record<string, unknown> = {}) =>
  request(app).post('/v1/chat/completions').send({ model, messages: [{ role: 'user', content: 'hi' }], ...extra });

beforeEach(() => {
  upstreamModels.length = 0;
  usageModels.length = 0;
  substitutedFor.mockClear();
});

describe('chat completions: model renames for openai and perplexity', () => {
  it('non-streaming: GPT-4 reaches SAP as o1, and the response and usage name o1', async () => {
    const res = await ask('GPT-4');
    expect(res.status).toBe(200);
    expect(upstreamModels).toEqual(['o1']);
    expect(res.body.model).toBe('o1');
    await waitFor(() => usageModels.length > 0);
    expect(usageModels).toEqual(['o1']);
  });

  it('streaming: GPT-4 reaches SAP as o1, and every chunk carrying a model names o1', async () => {
    const res = await ask('GPT-4', { stream: true, stream_options: { include_usage: true } });
    expect(res.status).toBe(200);
    expect(upstreamModels).toEqual(['o1']);
    const chunks = sseObjects(res.text);
    const withModel = chunks.filter((c) => 'model' in c);
    expect(withModel.length).toBeGreaterThanOrEqual(2);
    expect(withModel.map((c) => c.model)).toEqual(withModel.map(() => 'o1'));
    await waitFor(() => usageModels.length > 0);
    expect(usageModels).toEqual(['o1']);
  });

  it('perplexity: a providers.perplexity rename reaches SAP under its new name', async () => {
    const res = await ask('web-answers');
    expect(res.status).toBe(200);
    expect(upstreamModels).toEqual(['sonar-pro']);
    expect(res.body.model).toBe('sonar-pro');
  });

  it('perplexity streaming: every chunk names the forwarded model', async () => {
    const res = await ask('web-answers', { stream: true });
    expect(upstreamModels).toEqual(['sonar-pro']);
    const withModel = sseObjects(res.text).filter((c) => 'model' in c);
    expect(withModel.length).toBeGreaterThanOrEqual(2);
    expect(new Set(withModel.map((c) => c.model))).toEqual(new Set(['sonar-pro']));
  });

  it('an unmatched model is forwarded and reported unchanged', async () => {
    const res = await ask('gpt-4.1');
    expect(upstreamModels).toEqual(['gpt-4.1']);
    expect(res.body.model).toBe('gpt-4.1');
  });

  it('consults only the openai and perplexity lists, openai first', async () => {
    await ask('claude-3-5-haiku-20241022');
    expect(upstreamModels).toEqual(['claude-3-5-haiku-20241022']);
    expect(substitutedFor.mock.calls.map((c) => c[0])).toEqual(['openai', 'perplexity']);
  });
});
