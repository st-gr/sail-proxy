/**
 * F1 (final-review, usage-accounting audit): `handleBedrockRequest`'s
 * non-streaming billing fold at awsBedrockController.ts:143-150 used a 2-arg
 * `updateTokenCounts` on both branches, dropping the cache read/write
 * categories that `result.usage` can now carry:
 *
 *  - "AWS Bedrock format" branch (result.usage.inputTokens/outputTokens
 *    defined): raw Converse `usage`, cache fields `cacheWriteInputTokens` /
 *    `cacheReadInputTokens` (awsBedrockService.ts:689-690, unconfirmed by
 *    capture — see task-T6 report).
 *  - "Anthropic-transformed format" branch (result.usage.input_tokens/
 *    output_tokens defined): either a raw SAP native-passthrough Anthropic
 *    body or `transformBedrockToAnthropicResponse`'s output
 *    (awsBedrockService.ts:916-924), both carrying `cache_creation_input_tokens`
 *    / `cache_read_input_tokens`.
 *
 * `updateTokenCounts`/`emitUsageEvent` are used unmocked (real usageTracker),
 * mirroring test/awsBedrock-native-stream-cache-usage.test.ts's style: the
 * emitted usage event (memory queue) is the observation point for the real
 * fold arithmetic, not mock call args.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  }),
  createSafePreview: jest.fn(() => ''),
  createHeadersPreview: jest.fn(() => ''),
}));

jest.mock('../src/config/unifiedAuthConfig', () => ({
  __esModule: true,
  isStandaloneMode: jest.fn(() => false),
}));

jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: jest.fn(async () => ({ id: 'test-model', executableId: 'aws-bedrock' })),
  },
}));

jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getSubstitutedModel: (_provider: string, modelId: string) => modelId,
    getHookConfig: () => undefined,
    getConfig: () => ({ api_config: { logging: { payload_logging_enabled: false } } }),
  },
}));

jest.mock('../src/services/pluginExecutor', () => ({
  __esModule: true,
  executeBeforePlugins: jest.fn(async () => ({ stop: false })),
  executeAfterPlugins: jest.fn(async (_req: any, _res: any, data: any) => data),
}));

const mockProcessBedrockRequest = jest.fn();
jest.mock('../src/services/awsBedrockService', () => ({
  __esModule: true,
  default: {
    processBedrockRequest: (...args: any[]) => (mockProcessBedrockRequest as any)(...args),
  },
}));

import { handleBedrockRequest } from '../src/controllers/awsBedrockController';
import usageEmitter from '../src/services/usageEventEmitter';

function mockRes() {
  const r: any = {
    statusCode: 200,
    headersSent: false,
    setHeader: () => {},
    status: (code: number) => { r.statusCode = code; return r; },
    json: (body: any) => { r.body = body; return r; },
  };
  return r;
}

function buildReq(modelId: string) {
  const req: any = {
    params: { modelId, subpath: 'invoke' },
    body: { messages: [{ role: 'user', content: 'hi' }] },
    headers: {},
    originalUrl: `/aws-bedrock/model/${modelId}/invoke`,
    unifiedAuth: { valid: true, authType: 'aws_credential', data: { id: 'aws-key-1' } },
  };
  return req;
}

async function runAndGetEvent(usage: any) {
  usageEmitter.setValkeyClient(null);
  usageEmitter.getAndClearMemoryQueue();
  // @ts-ignore - Jest mock typing issues
  mockProcessBedrockRequest.mockResolvedValue({ usage });

  const req = buildReq('test-model');
  const res = mockRes();
  await handleBedrockRequest(req, res, (() => {}) as any);

  const events = usageEmitter.getAndClearMemoryQueue();
  expect(events).toHaveLength(1);
  return events[0];
}

describe('awsBedrockController: non-streaming billing fold cache fields (F1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('AWS Bedrock format branch (result.usage.inputTokens/outputTokens)', () => {
    it('folds cacheWriteInputTokens/cacheReadInputTokens into the emitted usage event', async () => {
      const event = await runAndGetEvent({
        inputTokens: 12,
        outputTokens: 34,
        cacheWriteInputTokens: 250,
        cacheReadInputTokens: 5000,
      });

      expect(event.inputTokens).toBe(12);
      expect(event.outputTokens).toBe(34);
      expect(event.cacheCreationInputTokens).toBe(250);
      expect(event.cacheReadInputTokens).toBe(5000);
    });

    it('pins unchanged behaviour for a details-less usage payload', async () => {
      const event = await runAndGetEvent({
        inputTokens: 7,
        outputTokens: 3,
      });

      expect(event.inputTokens).toBe(7);
      expect(event.outputTokens).toBe(3);
      expect(event.cacheCreationInputTokens).toBe(0);
      expect(event.cacheReadInputTokens).toBe(0);
    });
  });

  describe('Anthropic-transformed format branch (result.usage.input_tokens/output_tokens)', () => {
    it('folds cache_creation_input_tokens/cache_read_input_tokens into the emitted usage event', async () => {
      const event = await runAndGetEvent({
        input_tokens: 20,
        output_tokens: 40,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 6000,
      });

      expect(event.inputTokens).toBe(20);
      expect(event.outputTokens).toBe(40);
      expect(event.cacheCreationInputTokens).toBe(300);
      expect(event.cacheReadInputTokens).toBe(6000);
    });

    it('pins unchanged behaviour for a details-less usage payload', async () => {
      const event = await runAndGetEvent({
        input_tokens: 9,
        output_tokens: 5,
      });

      expect(event.inputTokens).toBe(9);
      expect(event.outputTokens).toBe(5);
      expect(event.cacheCreationInputTokens).toBe(0);
      expect(event.cacheReadInputTokens).toBe(0);
    });
  });
});
