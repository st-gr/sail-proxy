/**
 * The weak METADATA_ENCRYPTION_KEY warning: once per process, whether the light trace seals an
 * unmasked prompt first or a raw capture collector opens first.
 *
 * @see ../src/utils/sealKeyWarning.ts
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { randomBytes } from 'node:crypto';

const mockLog = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => mockLog }));

const mockConfig: any = { api_config: { observability: { payload_capture: { enabled: true } } } };
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

import { buildPayloadTrace } from '../src/services/payloadTrace';
import { openCollector, clearRawCaptureState } from '../src/services/rawCapture';
import { resetSealKeyWarning } from '../src/utils/sealKeyWarning';

const LIMITS = { stageMaxBytes: 262144, maxStages: 40, requestMaxBytes: 2097152 };
const CTX = { model: 'gpt-4o', statusCode: 200, durationMs: 42 };
const ENV_NAMES = ['VALKEY_URL', 'ADMIN_SERVICE_URL', 'UNIFIED_TOKEN_SYSTEM_ENABLED', 'GATEWAY_STANDALONE', 'METADATA_ENCRYPTION_KEY'];

let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_NAMES) savedEnv[k] = process.env[k];
  process.env.VALKEY_URL = 'redis://localhost:6379';
  process.env.ADMIN_SERVICE_URL = 'http://localhost:4004';
  process.env.UNIFIED_TOKEN_SYSTEM_ENABLED = 'true';
  delete process.env.GATEWAY_STANDALONE;
  process.env.METADATA_ENCRYPTION_KEY = 'short';
  mockLog.warn.mockClear();
  clearRawCaptureState();
  resetSealKeyWarning();
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  clearRawCaptureState();
});

function req(extra: any = {}): any {
  return {
    headers: {},
    originalUrl: '/openai/v1/chat/completions',
    debugRequestId: 'req-1',
    body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'Write to Jane Roe' }] },
    ...extra,
  };
}

const keyWarnings = () => mockLog.warn.mock.calls.filter((c) => String(c[1]).includes('METADATA_ENCRYPTION_KEY'));

describe('the weak seal key warning', () => {
  it('is given when a light trace seals an unmasked prompt, and not again for a raw collector', () => {
    expect(buildPayloadTrace(req(), CTX, process.env)!.sealedPrompt).toBeDefined();
    expect(keyWarnings()).toHaveLength(1);
    expect(String(keyWarnings()[0][1])).toContain('too-short');
    buildPayloadTrace(req(), CTX, process.env);
    openCollector('req-2', 's-1', 'cred-jane', LIMITS);
    expect(keyWarnings()).toHaveLength(1);
  });

  it('is given when a raw collector opens first, and not again for a light trace', () => {
    openCollector('req-2', 's-1', 'cred-jane', LIMITS);
    expect(keyWarnings()).toHaveLength(1);
    buildPayloadTrace(req(), CTX, process.env);
    expect(keyWarnings()).toHaveLength(1);
  });

  it('is not given for a masked light trace, which seals nothing', () => {
    buildPayloadTrace(req({ __pseudonymization: { maskedInputs: ['Write to MASKED_PERSON_1a2b'], config: { method: 'pseudonymization' } } }), CTX, process.env);
    expect(keyWarnings()).toHaveLength(0);
  });

  it('is not given for a strong key', () => {
    process.env.METADATA_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    buildPayloadTrace(req(), CTX, process.env);
    openCollector('req-2', 's-1', 'cred-jane', LIMITS);
    expect(keyWarnings()).toHaveLength(0);
  });
});
