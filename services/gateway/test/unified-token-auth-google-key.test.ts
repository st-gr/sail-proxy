/**
 * Gemini SDK clients send their API key as `x-goog-api-key`; REST callers may use `?key=`.
 * unifiedTokenAuth's extractApiKey must accept both, and sanitizeHeaders must redact
 * `x-goog-api-key` in logs the same way it already redacts `x-api-key`.
 *
 * @see ../src/middlewares/unifiedTokenAuth.ts
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
}));

jest.mock('../src/config/unifiedAuthConfig', () => ({
  __esModule: true,
  isStandaloneMode: () => false,
  shouldEnableDistributedCaching: () => false,
  getCachedUnifiedAuthConfig: () => ({ enabled: true, fallbackToLocal: false }),
}));

const mockValidateApiKey = jest.fn<any>();
jest.mock('../src/services/unifiedApiKeyValidationService', () => ({
  __esModule: true,
  unifiedApiKeyValidationService: { validateApiKey: (...args: any[]) => mockValidateApiKey(...args) },
}));

jest.mock('../src/services/securityEventEmitter', () => ({
  __esModule: true,
  default: { emitFailedAuth: (jest.fn() as any).mockResolvedValue(undefined) },
}));

import unifiedTokenAuth from '../src/middlewares/unifiedTokenAuth';

const FAKE_KEY = 'sk-test-google-key';

function makeReq(overrides: Record<string, any> = {}) {
  const headers: Record<string, any> = { 'user-agent': 'GeminiSDK/1.0', ...overrides.headers };
  const query = { ...overrides.query };
  return {
    headers,
    query,
    body: {},
    method: 'POST',
    originalUrl: '/google/v1beta/models/gemini-2.5-pro:generateContent',
    path: '/google/v1beta/models/gemini-2.5-pro:generateContent',
    ip: '127.0.0.1',
    connection: { remoteAddress: '127.0.0.1' },
    get: (name: string) => headers[name.toLowerCase()],
  } as any;
}

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as any;
}

function validResult() {
  return {
    valid: true,
    authType: 'api_key' as const,
    data: { keyId: 'k-1', name: 'gemini-caller', email: 'caller@test.com', permissions: ['models:read'] },
    token: 'unified-token',
    auditInfo: { requestId: 'req-1', validationTime: 1, cacheHit: false, source: 'admin_service' as const, responseTime: 1 },
  };
}

describe('unifiedTokenAuth accepts the key shapes Gemini clients send', () => {
  beforeEach(() => {
    mockValidateApiKey.mockReset();
  });

  it('resolves the same key from x-goog-api-key as an x-api-key request would', async () => {
    mockValidateApiKey.mockResolvedValue(validResult());
    const req = makeReq({ headers: { 'x-goog-api-key': FAKE_KEY } });
    const res = makeRes();
    const next = jest.fn();

    await unifiedTokenAuth(req, res, next);

    expect(mockValidateApiKey).toHaveBeenCalledTimes(1);
    expect(mockValidateApiKey.mock.calls[0][0]).toMatchObject({ apiKey: FAKE_KEY });
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.apiKey.key).toBe(FAKE_KEY);
  });

  it('resolves the key from a ?key= query parameter', async () => {
    mockValidateApiKey.mockResolvedValue(validResult());
    const req = makeReq({ query: { key: FAKE_KEY } });
    const res = makeRes();
    const next = jest.fn();

    await unifiedTokenAuth(req, res, next);

    expect(mockValidateApiKey).toHaveBeenCalledTimes(1);
    expect(mockValidateApiKey.mock.calls[0][0]).toMatchObject({ apiKey: FAKE_KEY });
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.apiKey.key).toBe(FAKE_KEY);
  });

  it('redacts x-goog-api-key in the sanitised headers handed to the validation service', async () => {
    mockValidateApiKey.mockResolvedValue(validResult());
    const req = makeReq({ headers: { 'x-goog-api-key': FAKE_KEY } });
    const res = makeRes();
    const next = jest.fn();

    await unifiedTokenAuth(req, res, next);

    const sanitizedHeaders = (mockValidateApiKey.mock.calls[0][0] as any).headers;
    expect(sanitizedHeaders['x-goog-api-key']).toBe('[REDACTED]');
    expect(sanitizedHeaders['x-goog-api-key']).not.toContain(FAKE_KEY);
  });
});
