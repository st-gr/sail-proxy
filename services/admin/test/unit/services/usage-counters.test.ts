/**
 * usageCounters: bucket folding, the upsert, the read, and the window derivation (spec §3.1–3.3).
 * In-memory SQLite through cds.test(); no gateway, no Valkey.
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.test(path.resolve(__dirname, '../../..'));

import * as counters from '../../../src/services/usageCounters';

let db: any;
beforeAll(async () => { db = await cds.connect.to('db'); });
beforeEach(async () => { await db.run(cds.ql.DELETE.from(counters.BUCKETS)); });

describe('utcDay / dayOf / windowHorizon', () => {
  it('keys buckets by the UTC calendar date', () => {
    expect(counters.utcDay(new Date('2026-09-07T23:59:59.999Z'))).toBe('2026-09-07');
    expect(counters.utcDay('2026-09-08T00:00:00.000Z')).toBe('2026-09-08');
    expect(counters.dayOf('2026-09-07')).toBe('2026-09-07');
    expect(counters.dayOf(new Date('2026-09-07T05:00:00Z'))).toBe('2026-09-07');
  });
  it('the horizon is the earlier of the ISO week start and the month start', () => {
    expect(counters.utcDay(counters.windowHorizon(new Date('2026-09-02T10:00:00Z')))).toBe('2026-08-31'); // Wednesday, week began Monday Aug 31
    expect(counters.utcDay(counters.windowHorizon(new Date('2026-09-20T10:00:00Z')))).toBe('2026-09-01'); // week began Sep 14, month wins
  });
});

describe('foldIncrements', () => {
  it('sums records per owner, day and currency; skips unresolved and fallback owners', () => {
    const records = [
      { email: 'a@test.com', validFrom: '2026-09-07T09:00:00Z', inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 1, cacheReadInputTokens: 2, sapCost: 0.5, sapCostCurrency: 'USD' },
      { email: 'a@test.com', validFrom: '2026-09-07T10:00:00Z', inputTokens: 100, outputTokens: 0, sapCost: 0.25, sapCostCurrency: 'USD' },
      { email: 'a@test.com', validFrom: '2026-09-07T11:00:00Z', inputTokens: 3, outputTokens: 0, sapCost: null, sapCostCurrency: null },
      { email: 'a@test.com', validFrom: '2026-09-06T23:59:59Z', inputTokens: 7, outputTokens: 0, sapCost: 0.07, sapCostCurrency: 'EUR' },
      { email: 'unknown@example.com', validFrom: '2026-09-07T09:00:00Z', inputTokens: 999, outputTokens: 0, sapCost: 9, sapCostCurrency: 'USD' },
      { email: null, validFrom: '2026-09-07T09:00:00Z', inputTokens: 999, outputTokens: 0, sapCost: 9, sapCostCurrency: 'USD' }
    ];
    const out = counters.foldIncrements(records, (r) => r.email);
    expect(out).toEqual(expect.arrayContaining([
      { email: 'a@test.com', day: '2026-09-07', currency: 'USD', requests: 2, tokens: 116, sapCost: 0.75 },
      { email: 'a@test.com', day: '2026-09-07', currency: '', requests: 1, tokens: 3, sapCost: 0 },
      { email: 'a@test.com', day: '2026-09-06', currency: 'EUR', requests: 1, tokens: 7, sapCost: 0.07 }
    ]));
    expect(out).toHaveLength(3);
  });

  it('counts fresh tokens only: cache reads are priced, not counted', () => {
    const inc = counters.foldIncrements([
      { email: 'a@test.com', validFrom: '2026-09-07T09:00:00Z', inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 1, cacheReadInputTokens: 1000, sapCost: 0.5, sapCostCurrency: 'USD' }
    ], (r) => r.email);
    expect(inc).toEqual([{ email: 'a@test.com', day: '2026-09-07', currency: 'USD', requests: 1, tokens: 16, sapCost: 0.5 }]);
  });
});

describe('applyIncrements / readBuckets', () => {
  const inc = (day: string, currency: string, tokens: number, sapCost: number): counters.Increment =>
    ({ email: 'a@test.com', day, currency, requests: 1, tokens, sapCost });
  it('upserts: a second application adds to the same bucket; the read filters by day', async () => {
    await counters.applyIncrements(db, [inc('2026-09-07', 'USD', 10, 0.1), inc('2026-09-01', 'USD', 5, 0.05)]);
    await counters.applyIncrements(db, [inc('2026-09-07', 'USD', 10, 0.1)]);
    const all = await counters.readBuckets(db, ['a@test.com'], new Date('2026-09-01T00:00:00Z'));
    expect(all.map((r) => [r.day, r.currency, r.requests, r.tokens, r.sapCost]).sort()).toEqual([
      ['2026-09-01', 'USD', 1, 5, 0.05],
      ['2026-09-07', 'USD', 2, 20, 0.2]
    ]);
    const recent = await counters.readBuckets(db, ['a@test.com'], new Date('2026-09-02T00:00:00Z'));
    expect(recent).toHaveLength(1);
    expect(await counters.readBuckets(db, ['nobody@test.com'], new Date('2026-09-01T00:00:00Z'))).toEqual([]);
    expect(await counters.readBuckets(db, [], new Date('2026-09-01T00:00:00Z'))).toEqual([]);
  });
});

describe('windowsFromBuckets', () => {
  const NOW = new Date('2026-09-02T10:00:00Z');   // Wednesday: the ISO week began Monday Aug 31, last month
  const row = (day: string, currency: string, tokens: number, sapCost: number, requests = 1): counters.BucketRow =>
    ({ email: 'a@test.com', day, currency, requests, tokens, sapCost });
  it('derives day, week (crossing the month boundary) and month; spend per currency, the quota currency on sapCost', () => {
    const w = counters.windowsFromBuckets([
      row('2026-08-31', 'USD', 100, 1),
      row('2026-09-01', 'USD', 10, 0.1),
      row('2026-09-02', 'EUR', 1, 0.01),
      row('2026-09-02', '', 5, 0, 2),
      row('2026-08-30', 'USD', 1000, 10)          // before the week and the month: ignored
    ], NOW, 'USD');
    expect(w.day).toEqual({ requests: 3, tokens: 6, sapCost: 0, sapCostByCurrency: { EUR: 0.01 } });
    expect(w.week).toEqual({ requests: 5, tokens: 116, sapCost: 1.1, sapCostByCurrency: { USD: 1.1, EUR: 0.01 } });
    expect(w.month).toEqual({ requests: 4, tokens: 16, sapCost: 0.1, sapCostByCurrency: { USD: 0.1, EUR: 0.01 } });
  });
  it('no rows means zero everywhere', () => {
    const w = counters.windowsFromBuckets([], NOW, 'USD');
    for (const name of ['day', 'week', 'month'] as const) expect(w[name]).toEqual({ requests: 0, tokens: 0, sapCost: 0, sapCostByCurrency: {} });
  });
});

describe('rebuild', () => {
  const USERS = 'sap.llm.gateway.admin.Users';
  const KEYS = 'sap.llm.gateway.admin.ApiKeys';
  const AWS = 'sap.llm.gateway.admin.AwsCredentials';
  const KEY_USAGE = 'sap.llm.gateway.admin.ApiKeyUsage';
  const AWS_USAGE = 'sap.llm.gateway.admin.AwsCredentialUsage';
  const NOW = new Date('2026-09-07T10:00:00Z');                    // Monday: horizon = Sep 1 (month start)
  const keyRow = (email: string, validFrom: string, tokens: number, sapCost: number | null, currency: string | null, signature: string | null = `${email}-${validFrom}-${tokens}`) => ({
    apiKey_ID: 'k-r', email, validFrom, validTo: validFrom, provider: 'anthropic', model: 'm', statusCode: 200,
    inputTokens: tokens, outputTokens: 0, totalTokens: tokens, sapCost, sapCostCurrency: currency, usageSignature: signature
  });
  const awsRow = (credential_ID: string | null, userId: string, validFrom: string, tokens: number, sapCost: number, signature = `aws-${userId}-${validFrom}-${tokens}`) => ({
    credential_ID, userId, validFrom, validTo: validFrom, provider: 'aws-bedrock', modelId: 'm', statusCode: 200,
    inputTokens: tokens, outputTokens: 0, sapCost, sapCostCurrency: 'USD', usageSignature: signature
  });
  const bucketsOf = async (email: string) => (await counters.readBuckets(db, [email], new Date('2026-01-01T00:00:00Z')))
    .map((r) => [r.day, r.currency, r.requests, r.tokens, r.sapCost]).sort();

  beforeEach(async () => {
    const { DELETE, INSERT } = cds.ql;
    for (const t of [KEY_USAGE, AWS_USAGE, USERS, KEYS, AWS]) await db.run(DELETE.from(t));
    await db.run(INSERT.into(USERS).entries([{ email: 'a@test.com', status: 'active' }, { email: 'b@test.com', status: 'active' }, { email: 'r@test.com', status: 'active', quotaResetAt: '2026-09-05T12:00:00Z' }, { email: 'future@test.com', status: 'active', quotaResetAt: '2026-09-08T00:00:00Z' }]));
    await db.run(INSERT.into(KEYS).entries({ ID: 'k-r', key: 'sk-r', name: 'k', email: 'a@test.com', isActive: true }));
    await db.run(INSERT.into(AWS).entries({ ID: 'c-r', accessKeyId: 'AKIAR', secretHash: 'h', salt: 's', name: 'c', email: 'b@test.com', userId: 'legacy-user-id', isActive: true }));
    await db.run(INSERT.into(KEY_USAGE).entries([
      keyRow('a@test.com', '2026-09-07T09:00:00Z', 100, 0.1, 'USD'),
      keyRow('a@test.com', '2026-09-07T09:30:00Z', 50, 0.05, 'USD'),
      keyRow('a@test.com', '2026-09-03T09:00:00Z', 1000, null, null),            // unpriced: currency ''
      keyRow('a@test.com', '2026-08-30T09:00:00Z', 5000, 5, 'USD'),              // before the horizon: not rebuilt
      keyRow('a@test.com', '2026-09-06T09:00:00Z', 77, 0.77, 'USD', null),       // validation-log shape: no signature, never counts
      keyRow('unknown@example.com', '2026-09-07T09:00:00Z', 999, 9, 'USD'),      // fallback owner: never counts
      keyRow('r@test.com', '2026-09-05T11:00:00Z', 10, 0.01, 'USD'),             // before r's reset watermark
      keyRow('r@test.com', '2026-09-05T13:00:00Z', 20, 0.02, 'USD'),             // after it, same day
      keyRow('r@test.com', '2026-09-06T13:00:00Z', 30, 0.03, 'USD'),
      keyRow('future@test.com', '2026-09-06T09:00:00Z', 10, 0.01, 'USD')          // future's watermark is after NOW: not a reset yet, counts
    ]));
    await db.run(INSERT.into(AWS_USAGE).entries([
      awsRow('c-r', 'legacy-user-id', '2026-09-02T09:00:00Z', 5, 0.5),           // attributed through the credential
      awsRow('c-r', 'b@test.com', '2026-09-02T10:00:00Z', 6, 0.6),               // attributed through userId
      awsRow(null, 'b@test.com', '2026-09-04T10:00:00Z', 7, 0.7),                // credential deleted, userId kept
      awsRow(null, 'legacy-user-id', '2026-09-04T11:00:00Z', 8, 0.8)             // unattributable: skipped
    ]));
  });

  it('rebuilds every user from the horizon on, honouring reset watermarks, signatures, fallbacks and AWS attribution', async () => {
    await counters.applyIncrements(db, [{ email: 'a@test.com', day: '2026-09-06', currency: 'USD', requests: 9, tokens: 9, sapCost: 9 }]);   // stale, replaced
    const r = await counters.rebuild(db, { now: NOW });
    expect(r.users).toBe(4);
    expect(await bucketsOf('a@test.com')).toEqual([
      ['2026-09-03', '', 1, 1000, 0],
      ['2026-09-07', 'USD', 2, 150, 0.15]
    ]);
    expect(await bucketsOf('b@test.com')).toEqual([
      ['2026-09-02', 'USD', 2, 11, 1.1],
      ['2026-09-04', 'USD', 1, 7, 0.7]
    ]);
    expect(await bucketsOf('r@test.com')).toEqual([
      ['2026-09-05', 'USD', 1, 20, 0.02],
      ['2026-09-06', 'USD', 1, 30, 0.03]
    ]);
    expect(await bucketsOf('unknown@example.com')).toEqual([]);
    expect(await bucketsOf('legacy-user-id')).toEqual([]);
    expect(await bucketsOf('future@test.com')).toEqual([['2026-09-06', 'USD', 1, 10, 0.01]]);
  });

  it('a scoped rebuild leaves other users alone and keeps buckets before the horizon', async () => {
    await counters.applyIncrements(db, [
      { email: 'b@test.com', day: '2026-09-02', currency: 'USD', requests: 1, tokens: 1, sapCost: 1 },
      { email: 'a@test.com', day: '2026-08-15', currency: 'USD', requests: 1, tokens: 1, sapCost: 1 }
    ]);
    await counters.rebuild(db, { emails: ['a@test.com'], now: NOW });
    expect(await bucketsOf('b@test.com')).toEqual([['2026-09-02', 'USD', 1, 1, 1]]);
    expect(await bucketsOf('a@test.com')).toEqual([['2026-08-15', 'USD', 1, 1, 1], ['2026-09-03', '', 1, 1000, 0], ['2026-09-07', 'USD', 2, 150, 0.15]]);
  });

  it('a scoped rebuild for a user with only AWS usage scopes the AWS grouped read in SQL', async () => {
    await counters.applyIncrements(db, [{ email: 'a@test.com', day: '2026-09-06', currency: 'USD', requests: 9, tokens: 9, sapCost: 9 }]);   // untouched: out of scope
    await counters.rebuild(db, { emails: ['b@test.com'], now: NOW });
    expect(await bucketsOf('b@test.com')).toEqual([
      ['2026-09-02', 'USD', 2, 11, 1.1],
      ['2026-09-04', 'USD', 1, 7, 0.7]
    ]);
    expect(await bucketsOf('a@test.com')).toEqual([['2026-09-06', 'USD', 9, 9, 9]]);
  });

  it('a full rebuild applies the retention: buckets older than 62 days go', async () => {
    await counters.applyIncrements(db, [{ email: 'a@test.com', day: '2026-07-06', currency: 'USD', requests: 1, tokens: 1, sapCost: 1 }, { email: 'a@test.com', day: '2026-07-07', currency: 'USD', requests: 1, tokens: 1, sapCost: 1 }]);
    await counters.rebuild(db, { now: NOW });
    expect((await bucketsOf('a@test.com')).map((b) => b[0])).toEqual(['2026-07-07', '2026-09-03', '2026-09-07']);
  });

  it('rebuildIfEmpty runs once for an empty table with usage rows, then never again', async () => {
    expect(await counters.rebuildIfEmpty(db, NOW)).toBe(true);
    expect(await bucketsOf('a@test.com')).toHaveLength(2);
    expect(await counters.rebuildIfEmpty(db, NOW)).toBe(false);
    await db.run(cds.ql.DELETE.from(counters.BUCKETS));
    await db.run(cds.ql.DELETE.from(KEY_USAGE)); await db.run(cds.ql.DELETE.from(AWS_USAGE));
    expect(await counters.rebuildIfEmpty(db, NOW)).toBe(false);          // nothing to rebuild from
  });
});
