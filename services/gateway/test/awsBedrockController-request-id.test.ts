/**
 * C6 (whole-solution review, usage/billing audit): with payload logging off,
 * `handleBedrockRequest` (awsBedrockController.ts:47-49) clobbered the unique
 * `debugRequestId` middleware sets on every request with `undefined`:
 * `payloadLoggingActive ? (req.debugRequestId || uuidv4()) : undefined`.
 * `usageTracker.ts`'s `extractAuthInfo`/event build then falls back to the
 * literal `'unknown'` for every Bedrock usage event. Combined with the admin's
 * cross-batch dedup keyed on `requestId` (usageEventProcessor.ts), every
 * Bedrock event after the first in a process lifetime was silently dropped.
 *
 * Every other controller (anthropicController.ts:200-202,
 * openRouterController.ts:37-40) always fills a missing debugRequestId,
 * regardless of payload logging — payload logging itself is gated inside
 * `payloadLogger.savePayload`/`isPayloadLoggingEnabled()`, not by whether an
 * id exists. Bedrock must follow the same pattern: a unique id always reaches
 * the emitted usage event.
 */
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
    getModelDetails: jest.fn(async () => ({ id: 'test-model', executableId: 'aws-bedrock', accessType: 'deployment' })),
  },
}));

jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getSubstitutedModel: (_provider: string, modelId: string) => modelId,
    getHookConfig: () => undefined,
    // Payload logging OFF — this is the condition that used to clobber the id.
    getConfig: () => ({ api_config: { platform: { logging: { payload_logging_enabled: false } } } }),
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

describe('awsBedrockController: request id survives payload logging being off (C6)', () => {
  // Payload logging is also switched on by DEBUG or PAYLOAD_LOGGING_ENABLED, which a developer's
  // services/gateway/.env may set (modules call dotenv.config() on import). Pin both off here.
  const savedEnv = { DEBUG: process.env.DEBUG, PAYLOAD_LOGGING_ENABLED: process.env.PAYLOAD_LOGGING_ENABLED };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DEBUG = 'false';
    process.env.PAYLOAD_LOGGING_ENABLED = 'false';
  });
  afterAll(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('never emits a usage event with requestId "unknown"', async () => {
    const event = await runAndGetEvent({ inputTokens: 1, outputTokens: 1 });

    expect(event.requestId).toBeDefined();
    expect(event.requestId).not.toBe('unknown');
  });

  it('gives two separate requests two different request ids', async () => {
    const first = await runAndGetEvent({ inputTokens: 1, outputTokens: 1 });
    const second = await runAndGetEvent({ inputTokens: 2, outputTokens: 2 });

    expect(first.requestId).not.toBe(second.requestId);
  });

  it('hands awsBedrockService an empty debugRequestId with payload logging off, while the emitted usage event still gets a unique id', async () => {
    // Fix-round-1 regression: awsBedrockService uses the id it is HANDED (not
    // req.debugRequestId) as a truthiness switch for more than payload-log
    // gating — it also buffers every streamed response chunk into
    // capturedResponseChunks whenever that id is truthy, regardless of whether
    // payload logging is enabled (awsBedrockService.ts:1152-1154, 1246-1248,
    // 1513-1515). Always handing it a real id would buffer every Bedrock
    // streaming response in memory even with logging off (the production
    // default), so the service handoff must stay gated on
    // payloadLoggingActive even though req.debugRequestId itself is always
    // unique now.
    const event = await runAndGetEvent({ inputTokens: 1, outputTokens: 1 });

    expect(mockProcessBedrockRequest).toHaveBeenCalledTimes(1);
    const optionsArg = (mockProcessBedrockRequest as any).mock.calls[0][0];
    expect(optionsArg.debugRequestId).toBe('');

    // The emitted usage event (read off req.debugRequestId, not the service
    // handoff) still carries a unique, non-'unknown' id.
    expect(event.requestId).toBeDefined();
    expect(event.requestId).not.toBe('unknown');
  });
});
