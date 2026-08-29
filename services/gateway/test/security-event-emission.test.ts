import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const emitted: any[] = [];
jest.mock('../src/services/securityEventEmitter', () => ({
  __esModule: true,
  default: {
    emitRateLimitExceeded: jest.fn(async (d: any) => { emitted.push({ kind: 'rate_limit', ...d }); }),
    emitUnauthorizedAccess: jest.fn(async (d: any) => { emitted.push({ kind: 'unauthorized', ...d }); }),
    emitFailedAuth: jest.fn(async (d: any) => { emitted.push({ kind: 'failed_auth', ...d }); }),
    setValkeyClient: jest.fn(),
  },
}));

describe('rate limit rejection emits a security event', () => {
  beforeEach(() => { emitted.length = 0; });

  it('emits when the limiter returns 429', async () => {
    // Drive rateLimiter past its threshold and assert an event was emitted carrying
    // the client IP and endpoint. Import the middleware AFTER the mock above.
    const rateLimiter = (await import('../src/middlewares/rateLimiter')).default;
    expect(typeof rateLimiter).toBe('function');

    // rateLimiter only increments its counter inside res.on('finish', ...), so the
    // stub here has to actually capture and let us fire that callback per request
    // (mirrors test/rateLimiter-log-redaction.test.ts) — otherwise the counter
    // never advances and the loop below can never reach 429.
    const finishHandlers: Array<() => void> = [];
    const res: any = {
      statusCode: 200,
      status(c: number) { this.statusCode = c; return this; },
      json() { return this; },
      on(event: string, cb: () => void) { if (event === 'finish') finishHandlers.push(cb); return this; },
    };
    const req: any = {
      headers: {}, ip: '203.0.113.9', connection: { remoteAddress: '203.0.113.9' },
      originalUrl: '/anthropic/v1/messages', method: 'POST',
      get: () => 'jest',
      // rateLimiter keys off req.apiKey.key (not apiKeyId) and dereferences
      // req.body.model unconditionally, so both must be present or every call
      // falls into the "no valid authentication" 401 branch / throws.
      apiKey: { key: 'test-key' }, body: {},
    };

    // Call until the limiter rejects; the exact threshold is read from config.
    for (let i = 0; i < 200 && res.statusCode !== 429; i++) {
      await new Promise<void>(resolve => rateLimiter(req, res, () => resolve()) ?? resolve());
      finishHandlers.splice(0).forEach(cb => cb());
      if (res.statusCode === 429) break;
    }

    expect(res.statusCode).toBe(429);
    expect(emitted.some(e => e.kind === 'rate_limit')).toBe(true);
  });
});
