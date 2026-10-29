// services/admin/test/unit/entities/teams-schema.test.ts
/**
 * The Teams data model (spec 2026-10-14 §3): the three new entities, the additive columns on the
 * credential and usage tables, and the navigation from Users and ToolPolicies. Compiled from the
 * schema folder and deployed to in-memory SQLite, so a column CAP cannot deploy fails here.
 */
import path from 'path';
const cds = require('@sap/cds');

const SCHEMA = path.resolve(__dirname, '../../../src/db/schema');
const NS = 'sap.llm.gateway.admin';

describe('teams schema', () => {
  let csn: any;
  beforeAll(async () => { csn = await cds.load(SCHEMA); });

  it('declares Teams with the pool, the four associations and the members composition', () => {
    const t = csn.definitions[`${NS}.Teams`];
    expect(t.elements.name.notNull).toBe(true);
    for (const f of ['requestsPerMinute', 'spendPerDay', 'spendPerWeek', 'spendPerMonth', 'tokensPerDay', 'tokensPerWeek', 'tokensPerMonth', 'quotaResetAt']) expect(t.elements[f]).toBeDefined();
    expect(t.elements.quotaProfile.target).toBe(`${NS}.QuotaProfiles`);
    expect(t.elements.memberQuotaProfile.target).toBe(`${NS}.QuotaProfiles`);
    expect(t.elements.entitlementCatalog.target).toBe(`${NS}.ModelCatalogs`);
    expect(t.elements.toolPolicy.target).toBe(`${NS}.ToolPolicies`);
    expect(t.elements.members.type).toBe('cds.Composition');
    expect(t.elements.memberCount.virtual).toBe(true);
  });

  it('declares TeamMembers keyed by cuid with role, isPrimary and the unique (team, email) pair', () => {
    const m = csn.definitions[`${NS}.TeamMembers`];
    expect(m.elements.team.target).toBe(`${NS}.Teams`);
    expect(m.elements.email.notNull).toBe(true);
    expect(m.elements.role.default.val).toBe('member');
    expect(m.elements.isPrimary.type).toBe('cds.Boolean');
    expect(m['@assert.unique.member']).toEqual([{ '=': 'team' }, { '=': 'email' }]);
  });

  it('declares TeamUsageDaily keyed by (teamId, day, currency)', () => {
    const b = csn.definitions[`${NS}.TeamUsageDaily`];
    expect(Object.entries(b.elements).filter(([, e]: any) => e.key).map(([k]) => k)).toEqual(['teamId', 'day', 'currency']);
  });

  it('adds the additive columns and navigations', () => {
    expect(csn.definitions[`${NS}.ApiKeys`].elements.team.target).toBe(`${NS}.Teams`);
    expect(csn.definitions[`${NS}.AwsCredentials`].elements.team.target).toBe(`${NS}.Teams`);
    for (const e of ['ApiKeyUsage', 'AwsCredentialUsage']) {
      expect(csn.definitions[`${NS}.${e}`].elements.team.target).toBe(`${NS}.Teams`);
      expect(csn.definitions[`${NS}.${e}`].elements.teamName.length).toBe(100);
    }
    expect(csn.definitions[`${NS}.Users`].elements.memberships.target).toBe(`${NS}.TeamMembers`);
    expect(csn.definitions[`${NS}.ToolPolicies`].elements.assignedTeams.target).toBe(`${NS}.Teams`);
    expect(csn.definitions[`${NS}.QuotaProfiles`].elements.assignedTeams.virtual).toBe(true);
  });

  it('deploys to SQLite and accepts a team, a membership and a bucket', async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } };
    const db = await cds.connect.to('db');
    await cds.deploy(SCHEMA).to(db);
    const { INSERT, SELECT } = cds.ql;
    await db.run(INSERT.into(`${NS}.Teams`).entries({ ID: 't1', name: 'Alpha' }));
    await db.run(INSERT.into(`${NS}.TeamMembers`).entries({ ID: 'm1', team_ID: 't1', email: 'a@test.com', role: 'admin', isPrimary: true }));
    await db.run(INSERT.into(`${NS}.TeamUsageDaily`).entries({ teamId: 't1', day: '2026-10-14', currency: 'USD', requests: 1, tokens: 2, sapCost: 0.5 }));
    expect((await db.run(SELECT.from(`${NS}.TeamMembers`).where({ team_ID: 't1' }))).length).toBe(1);
    // Match the message, not toThrow: in a full run better-sqlite3's SqliteError comes from the realm of
    // the first suite that loaded the native module, so it is no `instanceof Error` here.
    await expect(db.run(INSERT.into(`${NS}.TeamMembers`).entries({ ID: 'm2', team_ID: 't1', email: 'a@test.com' }))).rejects.toMatchObject({ message: expect.stringMatching(/UNIQUE/i) });
  });
});
