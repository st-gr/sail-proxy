/**
 * Spend and token admission (spec §2 item 3): the state document the admin publishes is read
 * (cached 10 s), each window is compared to the effective limit, a stale document (previous day)
 * counts as empty for the rolled-over window, and a missing store fails open with one
 * quota_unenforced per five minutes. In-memory Valkey double; no admin, no LLM.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const emitted: any[] = [];
jest.mock('../src/services/securityEventEmitter', () => ({ __esModule: true, default: {
  emitQuotaExceeded: jest.fn(async (d: any) => { emitted.push({ kind: 'exceeded', ...d }); }),
  emitQuotaUnenforced: jest.fn(async (d: any) => { emitted.push({ kind: 'unenforced', ...d }); }) } }));
jest.mock('../src/services/configService', () => ({ __esModule: true, default: {}, getTrustForwardedFor: () => false }));
jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));

import { createQuotaEnforcement } from '../src/middlewares/quotaEnforcement';
import { MemoryRateLimitStore } from '../src/services/rateLimitStore';
import { QuotaStateReader, quotaKeyFor } from '../src/services/quotaStateReader';

let now = Date.parse('2026-09-07T10:00:00Z');
const clock = () => now;

/** Enough of iovalkey for the reader: get() over a map, status 'ready', or throwing when "down". */
function fakeValkey(docs: Record<string, any>, down = false) {
  return { status: down ? 'end' : 'ready', get: async (k: string) => { if (down) throw new Error('ECONNREFUSED'); return docs[k] ? JSON.stringify(docs[k]) : null; } };
}
const limits = (over: any = {}) => ({ requestsPerMinute: null, spendPerDay: null, spendPerWeek: null, spendPerMonth: null, tokensPerDay: null, tokensPerWeek: null, tokensPerMonth: null, ...over });
const doc = (used: any, over: any = {}) => ({
  email: 'u@test.com', status: 'active', limits: limits(over.limits), used: { day: { requests: 0, tokens: 0, sapCost: 0 }, week: { requests: 0, tokens: 0, sapCost: 0 }, month: { requests: 0, tokens: 0, sapCost: 0 }, ...used },
  windowStart: { day: '2026-09-07T00:00:00.000Z', week: '2026-09-07T00:00:00.000Z', month: '2026-09-01T00:00:00.000Z', ...(over.windowStart || {}) },
  quotaResetAt: null, updatedAt: '2026-09-07T09:59:00.000Z'
});
function req(userLimits: any = {}): any {
  return { unifiedAuth: { valid: true, authType: 'api_key', data: { keyId: 'k1', email: 'u@test.com', rateLimits: {},
    user: { email: 'u@test.com', status: 'active', roles: [], limits: limits(userLimits) } } },
    body: {}, headers: {}, socket: { remoteAddress: '203.0.113.7' }, originalUrl: '/v1/chat/completions', method: 'POST', get: () => 'jest' };
}
function res(): any { const r: any = { statusCode: 200, headers: {} }; r.status = (c: number) => { r.statusCode = c; return r; }; r.json = (b: any) => { r.body = b; return r; }; r.set = (h: any) => { Object.assign(r.headers, h); return r; }; return r; }
async function call(mw: any, r: any) { const s = res(); const next = jest.fn(); await mw(r, s, next); return { s, next }; }
const build = (client: any) => createQuotaEnforcement({ store: () => new MemoryRateLimitStore(clock), clock, standalone: () => false, stateReader: () => new QuotaStateReader(client, clock) });

beforeEach(() => { emitted.length = 0; now = Date.parse('2026-09-07T10:00:00Z'); });

describe('admission from the state document', () => {
  it('429 quota_exceeded when today\'s tokens reach the day limit, with resets_at and headers', async () => {
    const mw = build(fakeValkey({ [quotaKeyFor('u@test.com')]: doc({ day: { requests: 3, tokens: 1000, sapCost: 0.1 } }, { limits: { tokensPerDay: 1000 } }) }));
    const r = await call(mw, req({ tokensPerDay: 1000 }));
    expect(r.s.statusCode).toBe(429);
    expect(r.s.body).toEqual({ error: { type: 'quota_exceeded', scope: 'user', dimension: 'tokens', window: 'day', limit: 1000, used: 1000, resets_at: '2026-09-08T00:00:00.000Z' } });
    expect(r.s.headers['Retry-After']).toBe(String((Date.parse('2026-09-08T00:00:00Z') - now) / 1000));
    expect(emitted[0]).toMatchObject({ kind: 'exceeded', dimension: 'tokens', window: 'day', ownerEmail: 'u@test.com', clientIP: '203.0.113.7' });
  });

  it('spend per month is admitted below the limit and refused at it; the document\'s limits win over the block', async () => {
    const client = fakeValkey({ [quotaKeyFor('u@test.com')]: doc({ month: { requests: 9, tokens: 5, sapCost: 2.5 } }, { limits: { spendPerMonth: 2.5 } }) });
    const mw = build(client);
    const r = await call(mw, req({ spendPerMonth: 100 }));      // the wire block is older than the document
    expect(r.s.statusCode).toBe(429);
    expect(r.s.body.error).toMatchObject({ dimension: 'spend', window: 'month', limit: 2.5, used: 2.5, resets_at: '2026-10-01T00:00:00.000Z' });
  });

  it('a document from yesterday counts as empty for the day window, the month still counts', async () => {
    const client = fakeValkey({ [quotaKeyFor('u@test.com')]: doc({ day: { requests: 1, tokens: 999, sapCost: 0 }, month: { requests: 1, tokens: 999, sapCost: 0 } },
      { limits: { tokensPerDay: 100, tokensPerMonth: 999 }, windowStart: { day: '2026-09-06T00:00:00.000Z', week: '2026-08-31T00:00:00.000Z' } }) });
    const r = await call(build(client), req());
    expect(r.s.statusCode).toBe(429);
    expect(r.s.body.error).toMatchObject({ dimension: 'tokens', window: 'month' });
  });

  it('no document → pass; the read is cached for ten seconds', async () => {
    const docs: Record<string, any> = {};
    const client = fakeValkey(docs);
    const mw = build(client);
    expect((await call(mw, req({ tokensPerDay: 1 }))).next).toHaveBeenCalled();
    docs[quotaKeyFor('u@test.com')] = doc({ day: { requests: 1, tokens: 1, sapCost: 0 } }, { limits: { tokensPerDay: 1 } });
    expect((await call(mw, req({ tokensPerDay: 1 }))).next).toHaveBeenCalled();     // still the cached "no document"
    now += 10_001;
    expect((await call(mw, req({ tokensPerDay: 1 }))).s.statusCode).toBe(429);
  });

  it('store unreachable → pass, and one quota_unenforced per five minutes', async () => {
    const mw = build(fakeValkey({}, true));
    expect((await call(mw, req({ tokensPerDay: 1 }))).next).toHaveBeenCalled();
    await call(mw, req({ tokensPerDay: 1 }));
    expect(emitted.filter(e => e.kind === 'unenforced')).toHaveLength(1);
    now += 5 * 60_000 + 1;
    await call(mw, req({ tokensPerDay: 1 }));
    expect(emitted.filter(e => e.kind === 'unenforced')).toHaveLength(2);
  });

  it('no user block (standalone / fallback) → no admission check at all', async () => {
    const mw = build(fakeValkey({ [quotaKeyFor('u@test.com')]: doc({ day: { requests: 1, tokens: 10, sapCost: 0 } }, { limits: { tokensPerDay: 1 } }) }));
    const r = await call(mw, { apiKey: { key: 'sk-x', id: 'k1', email: 'u@test.com' }, body: {}, headers: {}, socket: { remoteAddress: '203.0.113.7' }, originalUrl: '/v1/messages', method: 'POST', get: () => 'jest' });
    expect(r.next).toHaveBeenCalled();
  });
});
