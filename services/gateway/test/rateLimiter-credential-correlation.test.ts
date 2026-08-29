/**
 * NH3: rateLimiter hashed a RESOLVED API key (req.apiKey.key via credentialIdentity()) for
 * `rate_limit_exceeded` events even though req.apiKey.id — the ApiKeys row's stable cuid —
 * was available, and usageTracker.ts already uses that same field for audit/usage events.
 * The result: the same live key correlated as a row ID in some event types and a SHA-256
 * hash in others, defeating cross-event correlation for exactly the credential an operator
 * would want to trace. Fixed by shipping req.apiKey.id directly when it resolves, falling
 * back to credentialIdentity()'s hash only when it does not.
 *
 * @see ../src/middlewares/rateLimiter.ts
 * @see ../src/utils/usageTracker.ts
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const emitRateLimitExceeded: any = (jest.fn() as any).mockResolvedValue(undefined);
jest.mock('../src/services/securityEventEmitter', () => ({
  __esModule: true,
  default: { emitRateLimitExceeded: (...args: any[]) => emitRateLimitExceeded(...args) },
}));

import rateLimiter from '../src/middlewares/rateLimiter';
import { extractAuthInfo } from '../src/utils/usageTracker';

const RESOLVED_KEY_ID = 'cuid-fake-row-id-0000000000000000';
// Obviously-fake canary, shaped like a real key so the pre-fix hashing path would have
// engaged the same way it would for a real one.
const RAW_KEY = 'sk-canary-FAKE-0000000000000000000000000000';
const DEFAULT_RATE_LIMIT = 100;

function makeReq() {
  return {
    apiKey: { key: RAW_KEY, id: RESOLVED_KEY_ID },
    body: { model: 'gpt-4' },
    get: () => undefined,
    originalUrl: '/v1/chat/completions',
    method: 'POST',
  } as any;
}

function makeRes() {
  const finishHandlers: Array<() => void> = [];
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    on: (event: string, cb: () => void) => { if (event === 'finish') finishHandlers.push(cb); },
    triggerFinish: () => finishHandlers.forEach((cb) => cb()),
  } as any;
}

describe('rate limiter credential correlation', () => {
  beforeEach(() => {
    emitRateLimitExceeded.mockClear();
  });

  it('ships the resolved API key row ID as credentialId, matching usageTracker\'s audit-path identifier', async () => {
    const req = makeReq();

    // Drive the limiter to its threshold so the next request is over limit.
    for (let i = 0; i < DEFAULT_RATE_LIMIT; i++) {
      const res = makeRes();
      const next = jest.fn();
      rateLimiter(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      res.triggerFinish();
    }

    const res = makeRes();
    rateLimiter(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(429);

    // The emit is fire-and-forget (Promise.resolve(...).catch(...)); flush microtasks.
    await Promise.resolve();
    await Promise.resolve();

    expect(emitRateLimitExceeded).toHaveBeenCalledTimes(1);
    const payload = emitRateLimitExceeded.mock.calls[0][0];

    // Must be the resolved row ID, not a hash and not the raw key in any form.
    expect(payload.credentialId).toBe(RESOLVED_KEY_ID);
    expect(payload.credentialId).not.toMatch(/^[0-9a-f]{64}$/);
    expect(payload.credentialId).not.toContain(RAW_KEY);
    expect(JSON.stringify(payload)).not.toContain(RAW_KEY);

    // Same credential, same identifier as the audit/usage-tracking path.
    const auditInfo = extractAuthInfo(req);
    expect(auditInfo?.credentialId).toBe(RESOLVED_KEY_ID);
    expect(auditInfo?.credentialId).toBe(payload.credentialId);
  });

  it('falls back to hashing when the credential does not resolve to a row ID', async () => {
    const req = { apiKey: { key: RAW_KEY }, body: { model: 'gpt-4' }, get: () => undefined,
      originalUrl: '/v1/chat/completions', method: 'POST' } as any; // no .id

    for (let i = 0; i < DEFAULT_RATE_LIMIT; i++) {
      const res = makeRes();
      rateLimiter(req, res, jest.fn());
      res.triggerFinish();
    }
    const res = makeRes();
    rateLimiter(req, res, jest.fn());
    await Promise.resolve();
    await Promise.resolve();

    const payload = emitRateLimitExceeded.mock.calls[0][0];
    expect(payload.credentialId).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.credentialId).not.toContain(RAW_KEY);
    expect(payload.credentialHint).toBe(RAW_KEY.slice(0, 8));
  });
});
