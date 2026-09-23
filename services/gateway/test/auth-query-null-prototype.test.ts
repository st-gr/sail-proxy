/**
 * The auth middlewares read the API key from the query string too (`?api_key=`,
 * `?key=`). Since express 4.22 a bracketed parameter (`?api_key[a]=1`) arrives as
 * a null-prototype object; before this fix both extractors returned it "as string",
 * so it reached apiKeyService / the unified validation service, the failure branch
 * threw inside credentialIdentity(), and the catch answered 500 (legacy path) or
 * fell back after a wasted admin round trip (unified path) — with no failed-auth
 * security event on either path. A non-string key must count as "no key".
 *
 * The request objects below carry exactly what express 4.22 produces:
 * `Object.create(null)` values with no toString/valueOf.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const emitFailedAuth: any = (jest.fn() as any).mockResolvedValue(undefined);
jest.mock('../src/services/securityEventEmitter', () => ({
  __esModule: true,
  default: { emitFailedAuth: (...args: any[]) => emitFailedAuth(...args) },
}));

const mockValidateApiKey: any = jest.fn();
jest.mock('../src/services/apiKeyService', () => ({
  __esModule: true,
  default: { validateApiKey: (...args: any[]) => mockValidateApiKey(...args), listApiKeys: jest.fn() },
}));

const unifiedValidate: any = jest.fn();
jest.mock('../src/services/unifiedApiKeyValidationService', () => ({
  __esModule: true,
  unifiedApiKeyValidationService: { validateApiKey: (...args: any[]) => unifiedValidate(...args) },
}));

jest.mock('../src/config/unifiedAuthConfig', () => ({
  __esModule: true,
  getCachedUnifiedAuthConfig: () => ({ enabled: true, fallbackToLocal: true, adminServiceUrl: 'http://admin.invalid', timeout: 1000 }),
}));

jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: { getConfig: () => ({ api_config: {} }) },
  getConfig: () => ({ api_config: {} }),
  getTrustForwardedFor: () => false,
}));

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));

import apiKeyAuth from '../src/middlewares/apiKeyAuth';
import unifiedTokenAuth from '../src/middlewares/unifiedTokenAuth';
import { installUnhandledRejectionLogger } from '../src/utils/processGuards';

/** What express 4.22 hands a handler for `?api_key[a]=1`. */
function bracketed(): unknown {
  return Object.assign(Object.create(null), { a: '1' });
}

function makeReq(query: Record<string, unknown>) {
  const headers: Record<string, any> = { 'user-agent': 'jest' };
  return {
    headers, query, body: {}, method: 'POST', originalUrl: '/v1/chat/completions', path: '/v1/chat/completions',
    ip: '127.0.0.1', connection: { remoteAddress: '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' },
    get: (name: string) => headers[name.toLowerCase()],
  } as any;
}

function makeRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((body: any) => { res.body = body; return res; });
  res.setHeader = jest.fn();
  return res;
}

beforeEach(() => {
  emitFailedAuth.mockClear();
  mockValidateApiKey.mockReset();
  mockValidateApiKey.mockResolvedValue(null);
  unifiedValidate.mockReset();
});

describe('apiKeyAuth with a bracketed ?api_key', () => {
  it('treats the object as a missing key: 401 "required", the missing-key event, no validation call', async () => {
    const req = makeReq({ api_key: bracketed() });
    const res = makeRes();
    const next = jest.fn();
    await apiKeyAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body.error.message).toMatch(/API key is required/);
    expect(mockValidateApiKey).not.toHaveBeenCalled();
    expect(emitFailedAuth).toHaveBeenCalledTimes(1);
    expect(emitFailedAuth.mock.calls[0][0]).toMatchObject({ credentialId: 'missing', authType: 'api_key', statusCode: 401 });
  });

  it('still validates a string ?api_key and reports it as invalid with a hashed identity', async () => {
    const req = makeReq({ api_key: 'sk-not-a-real-key-000000000000' });
    const res = makeRes();
    await apiKeyAuth(req, res, jest.fn());
    expect(mockValidateApiKey).toHaveBeenCalledWith('sk-not-a-real-key-000000000000');
    expect(res.statusCode).toBe(401);
    expect(res.body.error.message).toMatch(/Invalid API key/);
    const event = emitFailedAuth.mock.calls[0][0];
    expect(event.credentialId).toMatch(/^[0-9a-f]{64}$/);
    expect(event.credentialId).not.toBe('missing');
  });

  it('an array-valued ?api_key takes its first element', async () => {
    const req = makeReq({ api_key: ['sk-first-000000000000000000000', 'sk-second'] });
    const res = makeRes();
    await apiKeyAuth(req, res, jest.fn());
    expect(mockValidateApiKey).toHaveBeenCalledWith('sk-first-000000000000000000000');
  });
});

describe('unifiedTokenAuth with a bracketed ?api_key or ?key', () => {
  it('never hands a non-string key to the unified validation service and answers 401, not 500', async () => {
    for (const query of [{ api_key: bracketed() }, { key: bracketed() }]) {
      emitFailedAuth.mockClear();
      const req = makeReq(query);
      const res = makeRes();
      const next = jest.fn();
      await unifiedTokenAuth(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
      for (const call of unifiedValidate.mock.calls) {
        expect(typeof call[0].apiKey).toBe('string');
      }
    }
  });
});

describe('installUnhandledRejectionLogger', () => {
  it('registers one process listener that logs the reason without throwing', () => {
    const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() } as any;
    const before = process.listenerCount('unhandledRejection');
    installUnhandledRejectionLogger(logger);
    installUnhandledRejectionLogger(logger);
    expect(process.listenerCount('unhandledRejection')).toBe(before + 1);
    const listener = process.listeners('unhandledRejection').slice(-1)[0] as (reason: unknown, p: Promise<unknown>) => void;
    expect(() => listener(new Error('boom'), Promise.resolve())).not.toThrow();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(logger.error.mock.calls[0][1])).toMatch(/boom/);
  });
});
