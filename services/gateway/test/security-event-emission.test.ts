import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const emitted: any[] = [];
jest.mock('../src/services/securityEventEmitter', () => ({
  __esModule: true,
  default: {
    emitQuotaExceeded: jest.fn(async (d: any) => { emitted.push({ kind: 'rate_limit', ...d }); }),
    emitQuotaUnenforced: jest.fn(async () => {}),
    emitUnauthorizedAccess: jest.fn(async (d: any) => { emitted.push({ kind: 'unauthorized', ...d }); }),
    emitFailedAuth: jest.fn(async (d: any) => { emitted.push({ kind: 'failed_auth', ...d }); }),
    setValkeyClient: jest.fn(),
  },
}));

function res(): any {
  const r: any = { statusCode: 200, headers: {} as Record<string, string>, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  r.set = (h: Record<string, string>) => { Object.assign(r.headers, h); return r; };
  return r;
}
function req(): any {
  return {
    apiKey: { key: 'sk-test', id: 'k1' },
    socket: { remoteAddress: '203.0.113.7' },
    originalUrl: '/v1/messages', method: 'POST', get: () => 'jest', body: {}, headers: {},
  };
}

describe('rate limit rejection emits a security event', () => {
  beforeEach(() => { emitted.length = 0; });

  it('emits when the limiter returns 429', async () => {
    // Drive quotaEnforcement past its threshold and assert an event was emitted carrying
    // the client IP and endpoint. Import the middleware AFTER the mock above.
    const { createQuotaEnforcement } = await import('../src/middlewares/quotaEnforcement');
    const { MemoryRateLimitStore } = await import('../src/services/rateLimitStore');

    process.env.RATE_LIMIT_RPM = '1';
    try {
      const quotaEnforcement = createQuotaEnforcement({ store: () => new MemoryRateLimitStore(), standalone: () => true });

      await quotaEnforcement(req(), res(), () => {});
      const second = res();
      await quotaEnforcement(req(), second, () => {});

      expect(second.statusCode).toBe(429);
      expect(emitted.some(e => e.kind === 'rate_limit')).toBe(true);
      const event = emitted.find(e => e.kind === 'rate_limit');
      expect(event.clientIP).toBe('203.0.113.7');
      expect(event.endpoint).toBe('/v1/messages');
    } finally {
      delete process.env.RATE_LIMIT_RPM;
    }
  });
});
