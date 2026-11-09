/**
 * A key passed as ?key= / ?api_key= is masked in apiKeyAuth's log lines and in the failed-auth
 * security event; the sanitiser keeps path and other parameters, and routing still sees the key.
 *
 * @see ../src/utils/redactUrl.ts
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const loggerCalls = { debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() };
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: (...a: any[]) => loggerCalls.error(...a),
    warn: (...a: any[]) => loggerCalls.warn(...a),
    info: (...a: any[]) => loggerCalls.info(...a),
    debug: (...a: any[]) => loggerCalls.debug(...a),
    trace: jest.fn(),
  }),
}));

const mockValidateApiKey: any = jest.fn();
jest.mock('../src/services/apiKeyService', () => ({
  __esModule: true,
  default: {
    validateApiKey: (...a: any[]) => mockValidateApiKey(...a),
    listApiKeys: async () => [],
    findInactiveApiKeyId: async () => null,
  },
}));

const mockEmitFailedAuth: any = jest.fn();
jest.mock('../src/services/securityEventEmitter', () => ({
  __esModule: true,
  default: { emitFailedAuth: (...a: any[]) => mockEmitFailedAuth(...a) },
}));

import apiKeyAuth from '../src/middlewares/apiKeyAuth';

const KEY = 'sk-test-FAKE-INVALID-KEY-1234567890';

function leaksKey(text: string): boolean {
  for (let i = 0; i + 8 <= KEY.length; i++) if (text.includes(KEY.slice(i, i + 8))) return true;
  return false;
}

const originalDebug = process.env.DEBUG;

describe('apiKeyAuth masks a key passed in the URL', () => {
  beforeEach(() => {
    for (const fn of Object.values(loggerCalls)) fn.mockClear();
    mockValidateApiKey.mockReset();
    mockEmitFailedAuth.mockReset();
    (mockEmitFailedAuth as any).mockResolvedValue(undefined);
    process.env.DEBUG = 'true';
  });

  afterEach(() => {
    if (originalDebug === undefined) delete process.env.DEBUG; else process.env.DEBUG = originalDebug;
  });

  it.each(['key', 'api_key'])('?%s= is masked in log lines and in the security event', async (param) => {
    mockValidateApiKey.mockResolvedValue(null);
    const originalUrl = `/openrouter/api/v1/chat?${param}=${KEY}&x=1`;
    const req: any = {
      headers: { 'user-agent': 'curl/8' }, query: { [param]: KEY }, body: {}, method: 'GET',
      originalUrl, ip: '127.0.0.1', connection: { remoteAddress: '127.0.0.1' },
      get: (n: string) => (n.toLowerCase() === 'user-agent' ? 'curl/8' : undefined),
    };
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    await apiKeyAuth(req, res, jest.fn());

    const logged = [...Object.values(loggerCalls)].flatMap((f) => f.mock.calls.flat())
      .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
    expect(logged.some((s) => s.includes(`/openrouter/api/v1/chat?${param}=***&x=1`))).toBe(true);
    expect(logged.filter(leaksKey)).toEqual([]);

    expect(mockEmitFailedAuth).toHaveBeenCalled();
    const events = mockEmitFailedAuth.mock.calls.map((c: any[]) => c[0]);
    for (const e of events) {
      expect(e.endpoint).toBe(`/openrouter/api/v1/chat?${param}=***&x=1`);
      expect(leaksKey(e.endpoint)).toBe(false); // credentialMaterial is the emitter's deliberate, separate field
    }
    expect(req.originalUrl).toBe(originalUrl); // routing is untouched
    expect(req.query[param]).toBe(KEY);
  });

  it('masks a key in the referer of the DEBUG header dump', async () => {
    mockValidateApiKey.mockResolvedValue(null);
    const req: any = {
      headers: { referer: `http://h/p?key=${KEY}&x=1` }, query: {}, body: {}, method: 'GET', originalUrl: '/v1/models',
      ip: '127.0.0.1', connection: { remoteAddress: '127.0.0.1' }, get: () => undefined,
    };
    await apiKeyAuth(req, { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as any, jest.fn());
    const logged = Object.values(loggerCalls).flatMap((f) => f.mock.calls.flat()).map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
    expect(logged.some((s) => s.includes('http://h/p?key=***&x=1'))).toBe(true);
    expect(logged.filter(leaksKey)).toEqual([]);
  });
});
