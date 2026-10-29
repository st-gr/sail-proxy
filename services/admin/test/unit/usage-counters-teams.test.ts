// services/admin/test/unit/usage-counters-teams.test.ts
/**
 * Team buckets (spec 2026-10-14 §6): folded and upserted like the user buckets, rebuilt from the
 * rows' team column, scoped or full, honouring a team's reset watermark. Real in-memory SQLite.
 */
import { join } from 'path';
const cds = require('@sap/cds');
import * as counters from '../../src/services/usageCounters';

const TEAMS = 'sap.llm.gateway.admin.Teams';
const KEY_USAGE = 'sap.llm.gateway.admin.ApiKeyUsage';
const AWS_USAGE = 'sap.llm.gateway.admin.AwsCredentialUsage';
const now = new Date('2026-10-14T10:00:00Z');
const row = (o: any) => ({ validFrom: '2026-10-14T09:00:00.000Z', validTo: '9999-12-31T00:00:00.000Z', provider: 'p', statusCode: 200, inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 7, sapCost: 0.5, sapCostCurrency: 'USD', usageSignature: `s-${Math.random()}`, ...o });

describe('team usage buckets', () => {
  let db: any;
  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } };
    db = await cds.connect.to('db');
    await cds.deploy(join(__dirname, '../../src/db/schema')).to(db);
  });
  beforeEach(async () => {
    for (const t of [counters.TEAM_BUCKETS, counters.BUCKETS, KEY_USAGE, AWS_USAGE, TEAMS]) await db.run(cds.ql.DELETE.from(t));
    await db.run(cds.ql.INSERT.into(TEAMS).entries([{ ID: 't-a', name: 'Alpha' }, { ID: 't-b', name: 'Beta' }]));
  });
  const teamBuckets = async () => (await db.run(cds.ql.SELECT.from(counters.TEAM_BUCKETS).orderBy('teamId', 'day', 'currency')))
    .map((r: any) => ({ teamId: r.teamId, day: counters.dayOf(r.day), currency: r.currency, requests: Number(r.requests), tokens: Number(r.tokens), sapCost: Number(r.sapCost), externalCost: Number(r.externalCost) }));

  it('folds by team, day and currency (fresh tokens only) and upserts cumulatively; rows without a team fold into nothing', async () => {
    const inc = counters.foldTeamIncrements([row({ team_ID: 't-a' }), row({ team_ID: 't-a', inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 1 }), row({ team_ID: null })], (r) => r.team_ID);
    expect(inc).toEqual([{ teamId: 't-a', day: '2026-10-14', currency: 'USD', requests: 2, tokens: 153, sapCost: 1, externalCost: 0 }]);
    await counters.applyTeamIncrements(db, inc, now);
    await counters.applyTeamIncrements(db, inc, now);
    expect(await teamBuckets()).toEqual([{ teamId: 't-a', day: '2026-10-14', currency: 'USD', requests: 4, tokens: 306, sapCost: 2, externalCost: 0 }]);
    const windows = counters.windowsFromBuckets(await counters.readTeamBuckets(db, ['t-a'], counters.windowHorizon(now)), now, 'USD');
    expect(windows.month).toMatchObject({ requests: 4, tokens: 306, sapCost: 2 });
  });

  it('rebuild derives team buckets from both usage tables, scoped by teamIds or in full, and honours the team watermark', async () => {
    await db.run(cds.ql.INSERT.into(KEY_USAGE).entries([row({ apiKey_ID: 'k', email: 'u@test.com', model: 'm', team_ID: 't-a', teamName: 'Alpha' }), row({ apiKey_ID: 'k', email: 'u@test.com', model: 'm', team_ID: 't-b', teamName: 'Beta', validFrom: '2026-10-13T09:00:00.000Z' })]));
    await db.run(cds.ql.INSERT.into(AWS_USAGE).entries([row({ credential_ID: 'c', userId: 'u@test.com', modelId: 'm', team_ID: 't-a', teamName: 'Alpha', inputTokens: 10, outputTokens: 0, sapCost: 0.25 })]));
    const r = await counters.rebuild(db, { now, teamIds: ['t-a'] });
    expect(r.teams).toBe(1); expect(r.teamBuckets).toBe(1);
    expect(await teamBuckets()).toEqual([{ teamId: 't-a', day: '2026-10-14', currency: 'USD', requests: 2, tokens: 160, sapCost: 0.75, externalCost: 0 }]);
    // the user buckets were not touched by a team-scoped rebuild
    expect((await db.run(cds.ql.SELECT.from(counters.BUCKETS))).length).toBe(0);
    const full = await counters.rebuild(db, { now });
    expect(full.teams).toBe(2); expect(full.users).toBe(1);
    expect((await teamBuckets()).map((b: any) => [b.teamId, b.day])).toEqual([['t-a', '2026-10-14'], ['t-b', '2026-10-13']]);
    // a watermark after Beta's row: Beta counts only from then on
    await db.run(cds.ql.UPDATE(TEAMS).set({ quotaResetAt: '2026-10-13T12:00:00.000Z' }).where({ ID: 't-b' }));
    await counters.rebuild(db, { now });
    expect((await teamBuckets()).map((b: any) => b.teamId)).toEqual(['t-a']);
  });

  it('rebuildTeamsIfEmpty builds the team buckets once from rows that carry a team', async () => {
    await db.run(cds.ql.INSERT.into(KEY_USAGE).entries([row({ apiKey_ID: 'k', email: 'u@test.com', model: 'm', team_ID: 't-a', teamName: 'Alpha' })]));
    expect(await counters.rebuildTeamsIfEmpty(db, now)).toBe(true);
    expect((await teamBuckets()).length).toBe(1);
    expect(await counters.rebuildTeamsIfEmpty(db, now)).toBe(false);
  });
});
