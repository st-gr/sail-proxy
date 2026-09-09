/**
 * Usage sums per calendar window over both usage entities with the watermark, the effective
 * limits and sources, the state document the gateway reads, and the publisher (store mocked).
 * Synthetic rows only — no gateway, no LLM.
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.test(path.resolve(__dirname, '../../..'));

const stored: Record<string, { value: any; ttl: number }> = {};
jest.mock('../../../src/services/quotaStateStore', () => {
  const actual = jest.requireActual('../../../src/services/quotaStateStore');
  return {
    ...actual,
    quotaStateStore: {
      initialize: jest.fn(), available: () => true,
      setJson: jest.fn(async (key: string, value: any, ttl: number) => { stored[key] = { value, ttl }; return true; }),
      getJson: jest.fn(async (key: string) => stored[key]?.value ?? null),
      getNumber: jest.fn(async () => 0), shutdown: jest.fn()
    }
  };
});

import * as quota from '../../../src/services/userQuotaService';
import { quotaKeyFor } from '../../../src/services/quotaStateStore';
import * as users from '../../../src/services/usersService';
import * as counters from '../../../src/services/usageCounters';
import * as profiles from '../../../src/services/quotaProfilesService';

const USERS = 'sap.llm.gateway.admin.Users';
const KEYS = 'sap.llm.gateway.admin.ApiKeys';
const AWS = 'sap.llm.gateway.admin.AwsCredentials';
const KEY_USAGE = 'sap.llm.gateway.admin.ApiKeyUsage';
const AWS_USAGE = 'sap.llm.gateway.admin.AwsCredentialUsage';
const NOW = new Date('2026-09-07T10:00:00Z');     // Monday: day == week start

let db: any;
beforeAll(async () => { db = await cds.connect.to('db'); });
beforeEach(async () => {
  const { DELETE, INSERT } = cds.ql;
  for (const t of [KEY_USAGE, AWS_USAGE, USERS, KEYS, AWS, counters.BUCKETS, profiles.PROFILES]) await db.run(DELETE.from(t));
  for (const k of Object.keys(stored)) delete stored[k];
  await db.run(INSERT.into(KEYS).entries({ ID: 'k-q', key: 'sk-q', name: 'k', email: 'q@test.com', isActive: true }));
  await db.run(INSERT.into(AWS).entries({ ID: 'c-q', accessKeyId: 'AKIAQ', secretHash: 'h', salt: 's', name: 'c', email: 'q@test.com', userId: 'legacy-user-id', region: 'us-east-1', isActive: true }));
});

const keyRow = (validFrom: string, tokens: number, sapCost: number, email = 'q@test.com') => ({
  apiKey_ID: 'k-q', email, validFrom, validTo: validFrom, provider: 'anthropic', model: 'm', statusCode: 200,
  inputTokens: tokens, outputTokens: 0, totalTokens: tokens, sapCost, sapCostCurrency: 'USD', usageSignature: `${email}-${validFrom}-${tokens}`
});
const awsRow = (validFrom: string, tokens: number, sapCost: number) => ({
  credential_ID: 'c-q', userId: 'legacy-user-id', validFrom, validTo: validFrom, provider: 'aws-bedrock', modelId: 'm', statusCode: 200,
  inputTokens: tokens, outputTokens: 0, sapCost, sapCostCurrency: 'USD', usageSignature: `aws-${validFrom}-${tokens}`
});

// Runs before any other test in this file touches quotaCurrency (computeUsage below calls it
// implicitly), so the module-level cache is still cold and the assertion below is meaningful.
describe('quotaCurrency memoisation', () => {
  it('resolves the SAP capacity-unit price once and reuses it on the next call within the TTL', async () => {
    const spy = jest.spyOn(require('../../../src/services/sapCapacityService'), '_lookupPrice');
    try {
      await quota.quotaCurrency(NOW);
      await quota.quotaCurrency(NOW);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('computeUsage', () => {
  it('sums both entities per window, AWS rows by the credential of the e-mail, honouring the watermark', async () => {
    const { INSERT, UPDATE } = cds.ql;
    await db.run(INSERT.into(KEY_USAGE).entries([
      keyRow('2026-09-07T09:00:00Z', 100, 0.1),      // today
      keyRow('2026-09-03T09:00:00Z', 1000, 1.0),     // last week, this month
      keyRow('2026-08-30T09:00:00Z', 5000, 5.0),     // last month
      keyRow('2026-09-07T08:00:00Z', 7, 0.07, 'someone-else@test.com')
    ]));
    await db.run(INSERT.into(AWS_USAGE).entries([awsRow('2026-09-07T09:30:00Z', 10, 0.02)]));
    await counters.rebuild(db, { now: NOW });
    const u = await quota.computeUsage(db, 'q@test.com', NOW, null);
    expect(u.day).toEqual({ requests: 2, tokens: 110, sapCost: 0.12, sapCostByCurrency: { USD: 0.12 } });
    expect(u.week).toEqual({ requests: 2, tokens: 110, sapCost: 0.12, sapCostByCurrency: { USD: 0.12 } });
    expect(u.month).toEqual({ requests: 3, tokens: 1110, sapCost: 1.12, sapCostByCurrency: { USD: 1.12 } });
    // The watermark now lives on the Users row and takes effect only once rebuild() re-derives the
    // buckets from it (spec §3.4/§3.5) — computeUsage's own quotaResetAt argument no longer applies
    // one dynamically, so honouring it here means going through the real mechanism.
    await users.touch(db, 'q@test.com');
    await db.run(UPDATE(USERS).set({ quotaResetAt: '2026-09-07T09:15:00Z' }).where({ email: 'q@test.com' }));
    await counters.rebuild(db, { now: NOW });
    const reset = await quota.computeUsage(db, 'q@test.com', NOW, null);
    expect(reset.day).toEqual({ requests: 1, tokens: 10, sapCost: 0.02, sapCostByCurrency: { USD: 0.02 } });
    expect(reset.month.tokens).toBe(10);
  });

  it('groups sapCost by currency — only the quota currency feeds spend, every currency is reported', async () => {
    const { INSERT } = cds.ql;
    await db.run(INSERT.into(KEY_USAGE).entries([
      keyRow('2026-09-07T09:00:00Z', 100, 0.1),                                    // USD
      { ...keyRow('2026-09-07T09:05:00Z', 300, 0.3), sapCostCurrency: 'EUR', usageSignature: 'eur-row' }
    ]));
    await counters.rebuild(db, { now: NOW });
    const u = await quota.computeUsage(db, 'q@test.com', NOW, null);
    expect(u.day.sapCost).toBe(0.1);
    expect(u.day.sapCostByCurrency).toEqual({ USD: 0.1, EUR: 0.3 });

    const doc = await quota.buildDocument(db, 'q@test.com', NOW);
    expect(doc.sapCostCurrency).toBe('USD');
  });

  it('computeUsageMany reads a page of users with one bucket query', async () => {
    const { INSERT } = cds.ql;
    await db.run(INSERT.into(KEY_USAGE).entries([keyRow('2026-09-07T09:00:00Z', 100, 0.1), keyRow('2026-09-07T09:00:00Z', 7, 0.07, 'someone-else@test.com')]));
    await counters.rebuild(db, { now: NOW });
    let reads = 0;
    const counting = { run: (q: any) => { if (q?.SELECT?.from?.ref?.[0] === counters.BUCKETS) reads += 1; return db.run(q); } };
    const many = await quota.computeUsageMany(counting, ['q@test.com', 'someone-else@test.com', 'nobody@test.com'], NOW, 'USD');
    expect(reads).toBe(1);
    expect(many.get('q@test.com')!.day).toMatchObject({ tokens: 100, sapCost: 0.1 });
    expect(many.get('someone-else@test.com')!.day).toMatchObject({ tokens: 7, sapCost: 0.07 });
    expect(many.get('nobody@test.com')!.month).toEqual({ requests: 0, tokens: 0, sapCost: 0, sapCostByCurrency: {} });
  });
});

describe('quotaCurrency', () => {
  const PRICE = 'sap.llm.gateway.admin.SapCapacityUnitPrice';

  it('falls back to USD when no capacity-unit price row is active', async () => {
    const { DELETE, SELECT, INSERT } = cds.ql;
    const existing = await db.run(SELECT.from(PRICE));
    await db.run(DELETE.from(PRICE));
    try {
      expect(await quota.quotaCurrency(NOW)).toBe('USD');
    } finally {
      if (existing.length > 0) await db.run(INSERT.into(PRICE).entries(existing));
    }
  });
});

describe('status and document', () => {
  it('combines limits, sources, used, remaining and resets; publishes the document under the hashed key', async () => {
    const { INSERT, UPDATE } = cds.ql;
    await users.touch(db, 'q@test.com', { roles: ['user'] });
    await db.run(UPDATE(USERS).set({ tokensPerDay: 1000, spendPerMonth: '2.5000' }).where({ email: 'q@test.com' }));
    await db.run(INSERT.into(KEY_USAGE).entries([keyRow('2026-09-07T09:00:00Z', 400, 0.5)]));
    await counters.rebuild(db, { now: NOW });

    const s = await quota.status(db, 'q@test.com', NOW);
    expect(s).toMatchObject({ email: 'q@test.com', status: 'active', roles: ['user'], sapCostCurrency: 'USD' });
    expect(s.limits).toMatchObject({ tokensPerDay: 1000, spendPerMonth: 2.5, tokensPerWeek: null });
    expect(s.limitSource).toMatchObject({ tokensPerDay: 'user', tokensPerWeek: 'unlimited' });
    expect(s.used.day).toEqual({ requests: 1, tokens: 400, sapCost: 0.5, sapCostByCurrency: { USD: 0.5 } });
    expect(s.remaining).toMatchObject({ tokensDay: 600, spendMonth: 2, tokensWeek: null });
    expect(s.resetsAt).toEqual({ day: new Date('2026-09-08T00:00:00Z'), week: new Date('2026-09-14T00:00:00Z'), month: new Date('2026-10-01T00:00:00Z') });

    expect(await quota.publish(db, 'q@test.com', NOW)).toBe(true);
    const key = quotaKeyFor('q@test.com');
    expect(key).toMatch(/^quota:user:[0-9a-f]{64}$/);
    expect(stored[key].ttl).toBe(86400);
    expect(stored[key].value).toMatchObject({
      email: 'q@test.com', status: 'active', limits: { tokensPerDay: 1000 }, sapCostCurrency: 'USD',
      used: { day: { tokens: 400, sapCost: 0.5 } },
      windowStart: { day: '2026-09-07T00:00:00.000Z', week: '2026-09-07T00:00:00.000Z', month: '2026-09-01T00:00:00.000Z' },
      quotaResetAt: null
    });
  });

  it('an assigned quota profile fills the fields the user leaves empty, and names itself', async () => {
    const { UPDATE, SELECT } = cds.ql;
    await profiles.ensureStarterProfiles(db);
    const [standard] = await db.run(SELECT.from(profiles.PROFILES).where({ name: 'Standard' }));
    await users.touch(db, 'q@test.com', { roles: ['user'] });
    await db.run(UPDATE(USERS).set({ quotaProfile_ID: standard.ID, requestsPerMinute: 5 }).where({ email: 'q@test.com' }));

    const s = await quota.status(db, 'q@test.com', NOW);
    expect(s.quotaProfileName).toBe('Standard');
    expect(s.limits).toMatchObject({ requestsPerMinute: 5, tokensPerDay: 5000000, spendPerDay: 250 });
    expect(s.limitSource).toMatchObject({ requestsPerMinute: 'user', tokensPerDay: 'profile', spendPerDay: 'profile' });
    // the document the gateway reads carries the profile's limits too
    expect((await quota.buildDocument(db, 'q@test.com', NOW)).limits).toMatchObject({ requestsPerMinute: 5, tokensPerDay: 5000000 });
    // the page read resolves the same figures from its one profile query
    expect((await quota.statusMany(db, ['q@test.com'], NOW)).get('q@test.com')).toEqual(s);

    const without = await quota.status(db, 'someone-else@test.com', NOW);
    expect(without.quotaProfileName).toBeNull();
    expect(without.limitSource.tokensPerDay).toBe('unlimited');
  });

  it('a user without a row still gets a document (active, platform limits)', async () => {
    const doc = await quota.buildDocument(db, 'nobody@test.com', NOW);
    expect(doc).toMatchObject({ email: 'nobody@test.com', status: 'active', sapCostCurrency: 'USD', used: { day: { requests: 0, tokens: 0, sapCost: 0 } } });
  });
});

describe('statusMany', () => {
  const quotaLimits = require('../../../src/services/quotaLimits');

  it('resolves the platform defaults once for the page, not once per user, and every row keeps the same figures', async () => {
    const { INSERT } = cds.ql;
    const emails = ['p1@test.com', 'p2@test.com', 'p3@test.com'];
    for (const email of emails) await users.touch(db, email, { roles: ['user'] });
    await db.run(INSERT.into(KEY_USAGE).entries([{ ...keyRow('2026-09-07T09:00:00Z', 400, 0.5), email: 'p2@test.com', usageSignature: 'p2-row' }]));
    await counters.rebuild(db, { now: NOW });

    const defaults = jest.spyOn(quotaLimits, 'platformQuotaDefaults');
    let many: Map<string, any>;
    try {
      many = await quota.statusMany(db, emails, NOW);
      expect(defaults).toHaveBeenCalledTimes(1);
    } finally {
      defaults.mockRestore();
    }

    expect([...many.keys()].sort()).toEqual(emails);
    // one currency for the whole page, and the same figures a single-row status() reports
    expect([...many.values()].map((s: any) => s.sapCostCurrency)).toEqual(['USD', 'USD', 'USD']);
    expect(many.get('p2@test.com')).toMatchObject({ email: 'p2@test.com', status: 'active', used: { day: { tokens: 400, requests: 1 } } });
    expect(many.get('p1@test.com')!.used.day).toEqual({ requests: 0, tokens: 0, sapCost: 0, sapCostByCurrency: {} });
    const single = await quota.status(db, 'p2@test.com', NOW);
    expect(many.get('p2@test.com')).toEqual(single);
  });

  it('status() given the platform defaults does not resolve them again; without them it does', async () => {
    await users.touch(db, 'p4@test.com', { roles: ['user'] });
    const defaults = jest.spyOn(quotaLimits, 'platformQuotaDefaults');
    try {
      const platform = await quotaLimits.platformQuotaDefaults(db);
      defaults.mockClear();
      await quota.status(db, 'p4@test.com', NOW, 'USD', platform);
      expect(defaults).not.toHaveBeenCalled();
      await quota.status(db, 'p4@test.com', NOW, 'USD');
      expect(defaults).toHaveBeenCalledTimes(1);
    } finally {
      defaults.mockRestore();
    }
  });

  it('one unreadable user does not take the rest of the page down', async () => {
    for (const email of ['ok1@test.com', 'ok2@test.com']) await users.touch(db, email, { roles: ['user'] });
    // The page's usage now comes from ONE shared bucket query (computeUsageMany), which legitimately
    // mentions every requested e-mail including boom's — a real failure there would fail the whole
    // page, not just boom's row (a genuine architectural tradeoff of one query per page). What stays
    // isolated per row is everything status() still reads per user (getUser here) — that's what this
    // test exercises: the bucket query is exempted, boom's own per-user query still fails.
    const failing = { run: (q: any) => {
      const isBucketQuery = q?.SELECT?.from?.ref?.[0] === counters.BUCKETS;
      return (!isBucketQuery && String(JSON.stringify(q)).includes('boom@test.com')) ? Promise.reject(new Error('boom')) : db.run(q);
    } };
    const many = await quota.statusMany(failing as any, ['ok1@test.com', 'boom@test.com', 'ok2@test.com'], NOW);
    expect([...many.keys()].sort()).toEqual(['ok1@test.com', 'ok2@test.com']);
  });
});

describe('republishAll', () => {
  it('publishes every user, chunked (bounded fan-out) rather than all at once', async () => {
    for (let i = 0; i < 30; i++) await users.touch(db, `bulk-${i}@test.com`);
    const n = await quota.republishAll();
    expect(n).toBe(30);
    expect(Object.keys(stored).length).toBe(30);
  });
});

describe('profileLimitsOf', () => {
  it('coerces the profile\'s limits to numbers (Decimal columns arrive as strings on Postgres) and keeps nulls', () => {
    const limits = quota.profileLimitsOf({ ID: 'p1', name: 'P', description: null, requestsPerMinute: null, spendPerDay: '250.0000', spendPerWeek: null, spendPerMonth: '3000', tokensPerDay: 5000000, tokensPerWeek: null, tokensPerMonth: null } as any);
    expect(limits).toEqual({ requestsPerMinute: null, spendPerDay: 250, spendPerWeek: null, spendPerMonth: 3000, tokensPerDay: 5000000, tokensPerWeek: null, tokensPerMonth: null });
    expect(typeof limits!.spendPerDay).toBe('number');
    expect(quota.profileLimitsOf(null)).toBeNull();
  });
});
