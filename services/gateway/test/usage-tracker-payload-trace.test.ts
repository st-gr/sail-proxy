/**
 * The usage tracker hands a finished request to the light payload trace while capture is on: the
 * duration from metrics.startTime, the tokens from the metrics, the caller's credential and auth type.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { randomBytes } from 'node:crypto';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));
jest.mock('../src/services/usageEventEmitter', () => ({ __esModule: true, default: { emit: jest.fn(async () => undefined) } }));
jest.mock('../src/config/unifiedAuthConfig', () => ({
  ...(jest.requireActual('../src/config/unifiedAuthConfig') as object),
  isStandaloneMode: () => false,
}));
jest.mock('../src/toolGovernance/record', () => ({ toolsForEvent: () => undefined }));

const mockConfig: any = { api_config: { observability: {} } };
jest.mock('../src/services/configService', () => {
  const actual: any = jest.requireActual('../src/services/configService');
  return {
    __esModule: true,
    ...actual,
    default: { getConfig: () => mockConfig },
    getCachedConfig: () => mockConfig,
    getTrustForwardedFor: () => false,
  };
});

import { emitUsageEvent, createUsageMetrics } from '../src/utils/usageTracker';
import securityEventEmitter from '../src/services/securityEventEmitter';

const ENV_NAMES = ['VALKEY_URL', 'METADATA_ENCRYPTION_KEY', 'GATEWAY_STANDALONE'];
let savedEnv: Record<string, string | undefined>;
let xadd: jest.Mock<(...a: any[]) => Promise<string>>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_NAMES) savedEnv[k] = process.env[k];
  process.env.VALKEY_URL = 'redis://localhost:6379';
  process.env.METADATA_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  delete process.env.GATEWAY_STANDALONE;
  mockConfig.api_config.observability = { payload_capture: { enabled: true } };
  xadd = jest.fn(async (..._a: any[]) => '1-0');
  securityEventEmitter.setValkeyClient({ status: 'ready', xadd } as any);
});
afterEach(() => {
  jest.useRealTimers();
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  securityEventEmitter.setValkeyClient(undefined);
});

const traces = () => xadd.mock.calls.filter(c => c[0] === 'payload-traces').map(c => JSON.parse(String(c[6])));
const request = (auth: any) => ({
  ...auth,
  originalUrl: '/openai/v1/chat/completions',
  debugRequestId: 'req-wiring',
  headers: {},
  body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello from Jane Roe' }] },
  get: () => 'jest',
} as any);

describe('emitUsageEvent → emitPayloadTrace', () => {
  it('passes the duration, tokens, credential and auth type of an API key request', async () => {
    jest.useFakeTimers({ now: 1_800_000_000_000, doNotFake: ['setImmediate', 'nextTick'] });
    const metrics = createUsageMetrics();
    metrics.startTime = Date.now() - 1234;
    metrics.inputTokens = 21;
    metrics.outputTokens = 13;

    await emitUsageEvent(request({ unifiedAuth: { valid: true, authType: 'api_key', data: { id: 'key-jane' } } }), metrics, 'gpt-4o', 201);
    await new Promise(r => setImmediate(r));

    expect(traces()).toHaveLength(1);
    expect(traces()[0]).toMatchObject({
      requestId: 'req-wiring', model: 'gpt-4o', statusCode: 201, durationMs: 1234,
      inputTokens: 21, outputTokens: 13, credentialId: 'key-jane', authType: 'api_key',
    });
  });

  it('passes an AWS credential and its auth type', async () => {
    await emitUsageEvent(
      request({ unifiedAuth: { valid: true, authType: 'aws_credential', data: { credentialId: 'aws-cred-jane' } } }),
      createUsageMetrics(), 'claude-x', 200,
    );
    await new Promise(r => setImmediate(r));
    expect(traces()[0]).toMatchObject({ credentialId: 'aws-cred-jane', authType: 'aws_credential' });
  });

  it('publishes no trace while capture is off and the request is in no raw session', async () => {
    mockConfig.api_config.observability = {};
    await emitUsageEvent(request({ unifiedAuth: { valid: true, authType: 'api_key', data: { id: 'key-jane' } } }), createUsageMetrics(), 'gpt-4o', 200);
    await new Promise(r => setImmediate(r));
    expect(traces()).toHaveLength(0);
  });
});
