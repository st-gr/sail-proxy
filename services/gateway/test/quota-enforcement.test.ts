/**
 * quotaEnforcement (spec §2): exact RPM at user and key scope with a two-bucket sliding window,
 * hour/day key buckets, the 429 body and X-RateLimit-* headers, one throttled quota_exceeded
 * event per user × dimension × window per minute, standalone per-key RPM, and fail-open when the
 * store is gone (quota_unenforced once per five minutes). Driven with the in-memory store — the
 * same algorithm the Valkey store runs.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const emitted: any[] = [];
jest.mock('../src/services/securityEventEmitter', () => ({
  __esModule: true,
  default: {
    emitQuotaExceeded: jest.fn(async (d: any) => { emitted.push({ kind: 'exceeded', ...d }); }),
    emitQuotaUnenforced: jest.fn(async (d: any) => { emitted.push({ kind: 'unenforced', ...d }); }),
  },
}));
jest.mock('../src/services/configService', () => ({ __esModule: true, default: {}, getTrustForwardedFor: () => false }));
const logs: string[] = [];
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({
  info: jest.fn(), warn: (...a: any[]) => logs.push(a.join(' ')), error: jest.fn(), debug: (...a: any[]) => logs.push(a.join(' ')), trace: jest.fn() }) }));

import { createQuotaEnforcement } from '../src/middlewares/quotaEnforcement';
import { MemoryRateLimitStore } from '../src/services/rateLimitStore';

const RAW_KEY = 'sk-canary-FAKE-0000000000000000000000000000';
let now = Date.parse('2026-09-07T10:00:00Z');
const clock = () => now;

function req(over: any = {}): any {
  return {
    unifiedAuth: { valid: true, authType: 'api_key', data: {
      keyId: 'k-row-1', email: 'u@test.com', rateLimits: { requestsPerMinute: 3, requestsPerHour: null, requestsPerDay: null },
      user: { email: 'u@test.com', status: 'active', roles: ['user'], limits: { requestsPerMinute: 2, spendPerDay: null, spendPerWeek: null, spendPerMonth: null, tokensPerDay: null, tokensPerWeek: null, tokensPerMonth: null } } } },
    apiKey: { key: RAW_KEY, id: 'k-row-1' },
    body: { model: 'gpt-4' }, headers: {}, socket: { remoteAddress: '203.0.113.7' }, ip: '203.0.113.7',
    originalUrl: '/v1/chat/completions', method: 'POST', get: () => 'jest', ...over
  };
}
function res(): any {
  const r: any = { statusCode: 200, headers: {} as Record<string, string>, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  r.set = (h: Record<string, string>) => { Object.assign(r.headers, h); return r; };
  return r;
}
async function call(mw: any, r = req()) { const s = res(); const next = jest.fn(); await mw(r, s, next); return { s, next }; }

describe('user- and key-scoped RPM', () => {
  let mw: any;
  beforeEach(() => { emitted.length = 0; logs.length = 0; now = Date.parse('2026-09-07T10:00:00Z');
    mw = createQuotaEnforcement({ store: () => new MemoryRateLimitStore(clock), clock, standalone: () => false }); });

  it('lets requests through up to the tightest limit, then answers 429 with body and headers', async () => {
    const a = await call(mw); expect(a.next).toHaveBeenCalled();
    expect(a.s.headers).toMatchObject({ 'X-RateLimit-Limit': '2', 'X-RateLimit-Remaining': '1' });
    const b = await call(mw); expect(b.next).toHaveBeenCalled();
    const c = await call(mw); expect(c.next).not.toHaveBeenCalled();
    expect(c.s.statusCode).toBe(429);
    expect(c.s.body).toEqual({ error: { type: 'rate_limit_exceeded', scope: 'user', dimension: 'requests', window: 'minute', limit: 2, used: 3, resets_at: '2026-09-07T10:01:00.000Z' } });
    expect(c.s.headers).toMatchObject({ 'Retry-After': '60', 'X-RateLimit-Limit': '2', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(Date.parse('2026-09-07T10:01:00Z') / 1000) });
  });

  it('the previous bucket decays: two requests in minute 0 count half at minute 1 + 30 s', async () => {
    await call(mw); await call(mw);
    now += 90_000;                                   // 10:01:30 — previous bucket 2 × (1 − 0.5) = 1 carried over → one more allowed
    expect((await call(mw)).next).toHaveBeenCalled();
    expect((await call(mw)).s.statusCode).toBe(429);
  });

  it('key scope applies when the user scope is unlimited', async () => {
    const noUserLimit = () => req({ unifiedAuth: { valid: true, authType: 'api_key', data: { keyId: 'k-row-1', email: 'u@test.com',
      rateLimits: { requestsPerMinute: 1, requestsPerHour: null, requestsPerDay: null }, user: null } } });
    expect((await call(mw, noUserLimit())).next).toHaveBeenCalled();
    const r = await call(mw, noUserLimit());
    expect(r.s.statusCode).toBe(429);
    expect(r.s.body.error).toMatchObject({ scope: 'key', dimension: 'requests', window: 'minute', limit: 1 });
  });

  it('hour and day key buckets are fixed windows', async () => {
    const hourly = () => req({ unifiedAuth: { valid: true, authType: 'api_key', data: { keyId: 'k-row-1', email: 'u@test.com',
      rateLimits: { requestsPerMinute: null, requestsPerHour: 2, requestsPerDay: null }, user: null } } });
    await call(mw, hourly()); await call(mw, hourly());
    const r = await call(mw, hourly());
    expect(r.s.body.error).toMatchObject({ scope: 'key', window: 'hour', limit: 2, resets_at: '2026-09-07T11:00:00.000Z' });
  });

  it('emits one quota_exceeded per user × dimension × window per minute, with the client IP and the row id', async () => {
    await call(mw); await call(mw); await call(mw); await call(mw);
    const exceeded = emitted.filter(e => e.kind === 'exceeded');
    expect(exceeded).toHaveLength(1);
    expect(exceeded[0]).toMatchObject({ credentialId: 'k-row-1', authType: 'api_key', ownerEmail: 'u@test.com', scope: 'user', dimension: 'requests', window: 'minute', limit: 2, used: 3, clientIP: '203.0.113.7', endpoint: '/v1/chat/completions' });
    now += 60_000; await call(mw); await call(mw); await call(mw);
    expect(emitted.filter(e => e.kind === 'exceeded')).toHaveLength(2);
  });

  it('never logs the raw key', async () => {
    await call(mw); await call(mw); await call(mw);
    expect(logs.join('\n')).not.toContain(RAW_KEY);
    expect(JSON.stringify(emitted)).not.toContain(RAW_KEY);
  });

  it('a deactivated user is refused with 401 user_deactivated before any counting', async () => {
    const r = await call(mw, req({ unifiedAuth: { valid: true, authType: 'api_key', data: { keyId: 'k-row-1', email: 'u@test.com',
      rateLimits: {}, user: { email: 'u@test.com', status: 'deactivated', roles: [], limits: {} } } } }));
    expect(r.s.statusCode).toBe(401);
    expect(r.s.body.error.type).toBe('user_deactivated');
  });

  it('answers 401 without any authentication', async () => {
    const r = await call(mw, { body: {}, headers: {}, originalUrl: '/x', method: 'POST', get: () => undefined });
    expect(r.s.statusCode).toBe(401);
  });

  it('a request rejected by the tighter user-minute limit does not also burn the key hour/day budget', async () => {
    const store = new MemoryRateLimitStore(clock);
    const mw2 = createQuotaEnforcement({ store: () => store, clock, standalone: () => false });
    const withHourDay = () => req({ unifiedAuth: { valid: true, authType: 'api_key', data: {
      keyId: 'k-row-1', email: 'u@test.com',
      rateLimits: { requestsPerMinute: null, requestsPerHour: 100, requestsPerDay: 100 },
      user: { email: 'u@test.com', status: 'active', roles: ['user'], limits: { requestsPerMinute: 2, spendPerDay: null, spendPerWeek: null, spendPerMonth: null, tokensPerDay: null, tokensPerWeek: null, tokensPerMonth: null } } } } });
    await call(mw2, withHourDay()); await call(mw2, withHourDay());
    const third = await call(mw2, withHourDay());
    expect(third.s.statusCode).toBe(429);
    expect(third.s.body.error).toMatchObject({ scope: 'user', window: 'minute' });
    const hour = Math.floor(now / 3_600_000);
    const day = Math.floor(now / 86_400_000);
    expect(await store.get(`rl:key:k-row-1:h:${hour}`)).toBe(2);
    expect(await store.get(`rl:key:k-row-1:d:${day}`)).toBe(2);
  });

  it('user scope keys on the UserBlock email, not the credential\'s own email/userId', async () => {
    const asA = () => req({ unifiedAuth: { valid: true, authType: 'api_key', data: { keyId: 'k-row-1', email: 'a@test.com',
      rateLimits: { requestsPerMinute: null, requestsPerHour: null, requestsPerDay: null },
      user: { email: 'u@test.com', status: 'active', roles: ['user'], limits: { requestsPerMinute: 1, spendPerDay: null, spendPerWeek: null, spendPerMonth: null, tokensPerDay: null, tokensPerWeek: null, tokensPerMonth: null } } } } });
    const asLegacy = () => req({ unifiedAuth: { valid: true, authType: 'api_key', data: { keyId: 'k-row-2', email: 'legacy-id',
      rateLimits: { requestsPerMinute: null, requestsPerHour: null, requestsPerDay: null },
      user: { email: 'u@test.com', status: 'active', roles: ['user'], limits: { requestsPerMinute: 1, spendPerDay: null, spendPerWeek: null, spendPerMonth: null, tokensPerDay: null, tokensPerWeek: null, tokensPerMonth: null } } } } });
    expect((await call(mw, asA())).next).toHaveBeenCalled();
    const second = await call(mw, asLegacy());
    expect(second.s.statusCode).toBe(429);
    expect(second.s.body.error).toMatchObject({ scope: 'user', limit: 1 });
  });

  it('AWS credentials get key-scope RPM from awsAuth.rateLimits', async () => {
    const awsReq = () => ({ isAwsAuthenticated: true, awsAuth: { credentialId: 'c1', userId: 'aws-user',
      rateLimits: { requestsPerMinute: 1, requestsPerHour: null, requestsPerDay: null }, user: null },
      body: {}, headers: {}, socket: { remoteAddress: '203.0.113.7' }, originalUrl: '/aws-bedrock/model/x/invoke', method: 'POST', get: () => 'jest' });
    expect((await call(mw, awsReq())).next).toHaveBeenCalled();
    const r = await call(mw, awsReq());
    expect(r.s.statusCode).toBe(429);
    expect(r.s.body.error).toMatchObject({ scope: 'key', limit: 1 });
  });
});

describe('degradation and standalone', () => {
  beforeEach(() => { emitted.length = 0; now = Date.parse('2026-09-07T10:00:00Z'); });

  it('falls back to the in-memory buckets when the store throws and emits quota_unenforced once per five minutes', async () => {
    const broken = { incr: async () => { throw new Error('ECONNREFUSED'); }, get: async () => { throw new Error('ECONNREFUSED'); } };
    const mw = createQuotaEnforcement({ store: () => broken as any, clock, standalone: () => false });
    await call(mw); await call(mw);
    expect((await call(mw)).s.statusCode).toBe(429);            // still enforced, from memory
    await call(mw);
    expect(emitted.filter(e => e.kind === 'unenforced')).toHaveLength(1);
    now += 5 * 60_000 + 1; await call(mw);
    expect(emitted.filter(e => e.kind === 'unenforced')).toHaveLength(2);
  });

  it('standalone: per-key RPM from RATE_LIMIT_RPM (default 100) in memory, no user scope, headers still set', async () => {
    process.env.RATE_LIMIT_RPM = '1';
    try {
      const mw = createQuotaEnforcement({ store: () => null, clock, standalone: () => true });
      const local = () => ({ apiKey: { key: RAW_KEY }, body: {}, headers: {}, socket: { remoteAddress: '::ffff:203.0.113.7' }, originalUrl: '/v1/messages', method: 'POST', get: () => 'jest' });
      const ok = await call(mw, local());
      expect(ok.next).toHaveBeenCalled();
      expect(ok.s.headers['X-RateLimit-Limit']).toBe('1');
      const r = await call(mw, local());
      expect(r.s.statusCode).toBe(429);
      expect(r.s.body.error).toMatchObject({ scope: 'key', limit: 1 });
      expect(emitted.find(e => e.kind === 'exceeded')?.clientIP).toBe('203.0.113.7');
    } finally {
      delete process.env.RATE_LIMIT_RPM;
    }
  });
});
