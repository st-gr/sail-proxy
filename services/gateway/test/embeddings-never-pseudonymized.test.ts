/**
 * Guard: embeddings are NEVER pseudonymized, even when the configuration forces
 * pseudonymization for the openai endpoint. A masked input would be embedded instead of
 * the real text, so the vector would describe a placeholder. The fail-closed refusal that
 * applies to chat (openai-deployed-plugins.test.ts) must not apply here either.
 *
 * The plugin executor is mocked to MASK whatever it is given: if a future change wires
 * the plugin chain into the embeddings route, the input SAP receives changes and this fails.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

const shippedHooks = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'api_config.json'), 'utf-8'),
).api_config.hooks;
const mockConfig: any = { api_config: { hooks: shippedHooks, models: { overrides: {} }, observability: {} } };
jest.mock('../src/services/configService', () => {
  const svc = {
    getConfig: () => mockConfig,
    getSubstitutedModel: (_p: string, m: string) => m,
    getHookConfig: (_m: string, subpath: string, endpoint?: string) =>
      (endpoint ? mockConfig.api_config.hooks.defaults[endpoint]?.[subpath] : null) || null,
  };
  return { __esModule: true, default: svc, ...svc };
});

const mockExecuteBeforePlugins = jest.fn(async (req: any) => {
  req.body.input = 'MASKED_EMAIL_deadbeef';
  return { stop: false };
});
jest.mock('../src/services/pluginExecutor', () => ({
  executeBeforePlugins: (req: any) => mockExecuteBeforePlugins(req),
  executeAfterPlugins: (_req: any, _res: any, body: any) => Promise.resolve(body),
}));

const mockCreateEmbedding: jest.Mock<any> = jest.fn();
jest.mock('../src/services/sapAIService', () => ({
  __esModule: true,
  default: { createEmbedding: (...a: any[]) => mockCreateEmbedding(...a) },
}));

jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: { getModelById: () => Promise.resolve({ versions: [{ capabilities: ['embedding'] }] }) },
}));

jest.mock('../src/utils/usageTracker', () => ({
  createUsageMetrics: () => ({}),
  emitUsageEvent: jest.fn(),
  updateTokenCounts: jest.fn(),
}));

jest.mock('../src/utils/modelEntitlement', () => ({
  enforceEntitlement: () => true,
}));

import { handleEmbedding } from '../src/controllers/embeddingController';

const TEXT = 'Invoice for jane.roe@example.org';

describe('embeddings are never pseudonymized', () => {
  beforeEach(() => {
    mockCreateEmbedding.mockReset();
    mockExecuteBeforePlugins.mockClear();
  });

  it('sends the original input to SAP and is not refused while pseudonymization is forced', async () => {
    expect(shippedHooks.defaults.openai.pseudonymization.enabled).toBe(true);
    mockCreateEmbedding.mockResolvedValue({
      request_id: 'r',
      final_result: {
        object: 'list', model: 'm',
        data: [{ object: 'embedding', embedding: [0.1, 0.2], index: 0 }],
        usage: { prompt_tokens: 5, total_tokens: 5 },
      },
    });
    const res: any = {
      statusCode: 200, body: undefined,
      status(c: number) { this.statusCode = c; return this; },
      json(b: any) { this.body = b; return this; },
    };
    const next = jest.fn();
    await handleEmbedding({ body: { model: 'text-embedding-3-small', input: TEXT }, headers: {} } as any, res, next as any);

    expect(next).not.toHaveBeenCalled();
    expect(mockExecuteBeforePlugins).not.toHaveBeenCalled();
    expect(mockCreateEmbedding).toHaveBeenCalledTimes(1);
    expect((mockCreateEmbedding.mock.calls[0][0] as any).input.text).toBe(TEXT);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
});
