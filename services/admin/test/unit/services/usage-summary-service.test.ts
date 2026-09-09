/**
 * usageSummaryService: the home tiles' month figures from the per-user daily buckets — the pure fold
 * and the scoped read. In-memory SQLite through cds.test(); no gateway, no Valkey.
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.test(path.resolve(__dirname, '../../..'));

import * as counters from '../../../src/services/usageCounters';
import { foldSummary, usageSummary } from '../../../src/services/usageSummaryService';

let db: any;
beforeAll(async () => { db = await cds.connect.to('db'); });
beforeEach(async () => { await db.run(cds.ql.DELETE.from(counters.BUCKETS)); });

describe('foldSummary', () => {
  it('sums requests and tokens over every row, cost over the headline currency only, and names the others', () => {
    const rows = [
      { email: 'a@test.com', currency: 'USD', requests: 3, tokens: 300, sapCost: 0.3 },
      { email: 'a@test.com', currency: 'EUR', requests: 1, tokens: 100, sapCost: 0.1 },
      { email: 'b@test.com', currency: 'USD', requests: 2, tokens: 200, sapCost: 0.2 },
      { email: 'b@test.com', currency: '', requests: 4, tokens: 40, sapCost: 0 },
      { email: 'c@test.com', currency: 'CHF', requests: 1, tokens: 10, sapCost: 0 }   // no cost: not "another currency"
    ];
    expect(foldSummary(rows, 'USD')).toEqual({ requests: 11, tokens: 650, users: 3, sapCost: 0.5, sapCostCurrency: 'USD', otherCurrencies: ['EUR'] });
  });
  it('an empty month is all zeros in the quota currency', () => {
    expect(foldSummary([], 'EUR')).toEqual({ requests: 0, tokens: 0, users: 0, sapCost: 0, sapCostCurrency: 'EUR', otherCurrencies: [] });
  });
});

describe('usageSummary', () => {
  const now = new Date('2026-09-15T12:00:00Z');
  const seed = () => counters.applyIncrements(db, [
    { email: 'a@test.com', day: '2026-09-01', currency: 'USD', requests: 5, tokens: 500, sapCost: 0.5 },
    { email: 'a@test.com', day: '2026-09-14', currency: 'USD', requests: 1, tokens: 100, sapCost: 0.1 },
    { email: 'b@test.com', day: '2026-09-10', currency: 'USD', requests: 2, tokens: 200, sapCost: 0.2 },
    { email: 'b@test.com', day: '2026-08-31', currency: 'USD', requests: 9, tokens: 900, sapCost: 0.9 }   // last month: out
  ], now);

  it('scope self: the caller\'s own buckets of this month, one user', async () => {
    await seed();
    const s = await usageSummary(db, { email: 'a@test.com', isAdmin: false, now });
    expect(s).toMatchObject({ scope: 'self', monthStart: '2026-09-01', requests: 6, tokens: 600, users: 1, sapCost: 0.6, otherCurrencies: [] });
    expect(typeof s.sapCostCurrency).toBe('string');
  });
  it('scope all: every user\'s buckets of this month and the distinct user count; last month is excluded', async () => {
    await seed();
    const s = await usageSummary(db, { email: 'admin@test.com', isAdmin: true, now });
    expect(s).toMatchObject({ scope: 'all', monthStart: '2026-09-01', requests: 8, tokens: 800, users: 2, sapCost: 0.8 });
  });
  it('a user with nothing this month reads zeros, not an error', async () => {
    const s = await usageSummary(db, { email: 'nobody@test.com', isAdmin: false, now });
    expect(s).toMatchObject({ scope: 'self', requests: 0, tokens: 0, users: 1, sapCost: 0, otherCurrencies: [] });
  });
});
