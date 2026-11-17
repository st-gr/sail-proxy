/**
 * The usage tracker's gate for the light payload trace: while payload capture is off, only a request
 * of a raw capture session goes on to emitPayloadTrace (which then builds a facts-only trace); any
 * other request still costs one property check and nothing else.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const emitPayloadTrace = jest.fn(async (..._a: any[]) => undefined);
jest.mock('../src/services/payloadTrace', () => ({ emitPayloadTrace: (...a: any[]) => emitPayloadTrace(...a) }));
jest.mock('../src/services/usageEventEmitter', () => ({ __esModule: true, default: { emit: jest.fn(async () => undefined) } }));
jest.mock('../src/services/siemUsageEvent', () => ({ emitSiemUsageEvent: jest.fn(), payloadCaptureOn: () => false }));
jest.mock('../src/config/unifiedAuthConfig', () => ({ isStandaloneMode: () => false }));
jest.mock('../src/toolGovernance/record', () => ({ toolsForEvent: () => undefined }));
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));
import { emitUsageEvent, createUsageMetrics } from '../src/utils/usageTracker';

const base = (extra: any = {}) => ({ unifiedAuth: { valid: true, authType: 'api_key', data: { keyId: 'k1' } }, originalUrl: '/openai/v1/chat/completions', get: () => 'jest', ...extra } as any);

beforeEach(() => { emitPayloadTrace.mockClear(); });

describe('the light trace gate with payload capture off', () => {
  it('a request of a raw capture session still gets its light trace', async () => {
    await emitUsageEvent(base({ __rawCaptureSessionId: 'sess-1' }), createUsageMetrics(), 'gpt-4o', 200);
    expect(emitPayloadTrace).toHaveBeenCalledTimes(1);
    expect((emitPayloadTrace.mock.calls[0] as any[])[1]).toMatchObject({ model: 'gpt-4o', statusCode: 200, credentialId: 'k1' });
  });

  it('any other request gets none', async () => {
    await emitUsageEvent(base(), createUsageMetrics(), 'gpt-4o', 200);
    expect(emitPayloadTrace).not.toHaveBeenCalled();
  });
});
