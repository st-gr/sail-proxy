// services/admin/test/unit/services/team-quota-service.test.ts
/**
 * Team quota documents and status (spec 2026-10-14 §5/§6): pool limits from the row or its
 * profile, usage from the team buckets, the Valkey key, reset and republish. cds.test() in-memory;
 * the store is mocked so the document written can be read back.
 */
import path from 'path';
process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
const written = new Map<string, any>();
jest.mock('../../../src/services/quotaStateStore', () => ({
  ...jest.requireActual('../../../src/services/quotaStateStore'),
  quotaStateStore: { initialize: jest.fn(), available: () => true,
    setJson: jest.fn(async (k: string, v: any) => { written.set(k, v); return true; }), getJson: jest.fn(async () => null), getNumber: jest.fn(async () => 0),
    del: jest.fn(async (k: string) => { written.delete(k); return true; }), shutdown: jest.fn() } }));
cds.test(path.resolve(__dirname, '../../..'));

import * as tq from '../../../src/services/teamQuotaService';
import * as counters from '../../../src/services/usageCounters';
import * as lookups from '../../../src/services/teamLookups';
import * as profiles from '../../../src/services/quotaProfilesService';

let db: any;
const now = new Date('2026-10-14T10:00:00Z');
beforeAll(async () => { db = await cds.connect.to('db'); });
beforeEach(async () => {
  written.clear();
  for (const t of [counters.TEAM_BUCKETS, lookups.TEAMS, profiles.PROFILES]) await db.run(cds.ql.DELETE.from(t));
  await profiles.ensureStarterProfiles(db);
  const [light] = await db.run(cds.ql.SELECT.from(profiles.PROFILES).where({ name: 'Light' }));
  await db.run(cds.ql.INSERT.into(lookups.TEAMS).entries({ ID: 't-a', name: 'Alpha', spendPerDay: 3, quotaProfile_ID: light.ID }));
  await counters.applyTeamIncrements(db, [{ teamId: 't-a', day: '2026-10-14', currency: 'USD', requests: 4, tokens: 1500, sapCost: 2.5, externalCost: 0 }], now);
});

it('builds the document with pool limits (own > profile > unlimited) and the bucket usage, and publishes it under quota:team:<id>', async () => {
  expect(await tq.publishTeam(db, 't-a', now)).toBe(true);
  const doc = written.get('quota:team:t-a');
  expect(doc).toMatchObject({ teamId: 't-a', teamName: 'Alpha', sapCostCurrency: 'USD', quotaResetAt: null });
  expect(doc.limits).toMatchObject({ spendPerDay: 3, tokensPerDay: 500000, requestsPerMinute: 30, spendPerWeek: 75 });
  expect(doc.used.day).toMatchObject({ requests: 4, tokens: 1500, sapCost: 2.5 });
  expect(doc.windowStart.day).toBe('2026-10-14T00:00:00.000Z');
});

it('the pool document counts Connection spend with SAP spend in the quota currency', async () => {
  await counters.applyTeamIncrements(db, [{ teamId: 't-a', day: '2026-10-14', currency: 'USD', requests: 1, tokens: 10, sapCost: 0, externalCost: 0.5 }], now);
  await tq.publishTeam(db, 't-a', now);
  expect(written.get('quota:team:t-a').used.day).toMatchObject({ requests: 5, sapCost: 3 });
});

it('status carries the limit sources, the profile name and the remaining figures', async () => {
  const s = (await tq.teamStatus(db, 't-a', now))!;
  expect(s.limitSource).toMatchObject({ spendPerDay: 'team', tokensPerDay: 'profile', spendPerMonth: 'profile' });
  expect(s.quotaProfileName).toBe('Light');
  expect(s.remaining.spendDay).toBeCloseTo(0.5, 6);
  expect(s.remaining.tokensDay).toBe(498500);
  expect(s.resetsAt.day.toISOString()).toBe('2026-10-15T00:00:00.000Z');
  expect(await tq.teamStatus(db, 't-missing', now)).toBeNull();
});

it('reset moves the watermark, deletes the buckets and republishes; unpublish deletes the key', async () => {
  const r = await tq.resetTeamQuota(db, 't-a', now);
  expect(r.quotaResetAt).toEqual(now);
  expect((await db.run(cds.ql.SELECT.from(counters.TEAM_BUCKETS))).length).toBe(0);
  expect(written.get('quota:team:t-a').used.day.requests).toBe(0);
  await tq.unpublishTeam('t-a');
  expect(written.has('quota:team:t-a')).toBe(false);
  expect(await tq.republishAllTeams()).toBe(1);
});

it('a team deleted under the rollover timer stops being tracked (carried Part A finding)', async () => {
  expect(await tq.publishTeam(db, 't-a', now)).toBe(true);
  expect(tq.trackedTeamIds()).toContain('t-a');
  await db.run(cds.ql.DELETE.from(lookups.TEAMS).where({ ID: 't-a' }));
  expect(await tq.publishTeam(db, 't-a', now)).toBe(false);
  expect(tq.trackedTeamIds()).not.toContain('t-a');
});
