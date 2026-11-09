// services/admin/test/unit/services/teams-service.test.ts
/**
 * Team rules (spec 2026-10-14 §3/§4) on in-memory SQLite through cds.test(): the primary-flag
 * invariant, credential clearing on membership end, the request team of a credential, pool and
 * member-profile resolution, dependants. No gateway, no Valkey.
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.test(path.resolve(__dirname, '../../..'));

import * as lookups from '../../../src/services/teamLookups';
import * as teams from '../../../src/services/teamsService';
import * as users from '../../../src/services/usersService';
import * as profiles from '../../../src/services/quotaProfilesService';

const KEYS = 'sap.llm.gateway.admin.ApiKeys';
const AWS = 'sap.llm.gateway.admin.AwsCredentials';
let db: any;
const { INSERT, SELECT, UPDATE } = cds.ql;

// two addMember calls can share a millisecond: pin distinct createdAt so "oldest first" is deterministic
const pinOrder = async () => {
  await db.run(UPDATE(lookups.MEMBERS).set({ createdAt: '2026-01-01T00:00:00.000Z' }).where({ team_ID: 't-a' }));
  await db.run(UPDATE(lookups.MEMBERS).set({ createdAt: '2026-01-02T00:00:00.000Z' }).where({ team_ID: 't-b' }));
};

beforeAll(async () => { db = await cds.connect.to('db'); });
beforeEach(async () => {
  for (const t of [lookups.MEMBERS, lookups.TEAMS, KEYS, AWS, users.USERS, profiles.PROFILES]) await db.run(cds.ql.DELETE.from(t));
  await db.run(INSERT.into(lookups.TEAMS).entries([{ ID: 't-a', name: 'Alpha' }, { ID: 't-b', name: 'Beta' }]));
  await db.run(INSERT.into(KEYS).entries([{ ID: 'k-1', key: 'sk-1', name: 'k1', email: 'u@test.com', isActive: true }]));
  await db.run(INSERT.into(AWS).entries({ ID: 'c-1', accessKeyId: 'AKIA1', secretHash: 'h', salt: 's', name: 'c', email: 'u@test.com', userId: 'u@test.com', region: 'us-east-1', isActive: true }));
});

describe('memberships', () => {
  it('the first membership is primary, the second is not; the Users row is touched into existence', async () => {
    const a = await teams.addMember(db, 't-a', 'u@test.com', 'member');
    const b = await teams.addMember(db, 't-b', 'u@test.com', 'admin');
    await pinOrder();
    expect(a.isPrimary).toBe(true); expect(b.isPrimary).toBe(false); expect(b.role).toBe('admin');
    expect(await users.getUser(db, 'u@test.com')).not.toBeNull();
    expect((await lookups.primaryTeamOf(db, 'u@test.com'))?.ID).toBe('t-a');
    expect(await lookups.teamIdsOf(db, 'u@test.com')).toEqual(['t-a', 't-b']);
    expect(await lookups.isTeamAdmin(db, 'u@test.com', 't-b')).toBe(true);
    expect(await lookups.isTeamAdmin(db, 'u@test.com', 't-a')).toBe(false);
    expect(await lookups.adminTeamIdsOf(db, 'u@test.com')).toEqual(['t-b']);
  });

  it('refuses a duplicate (409), an unknown team (404), a service key (400) and a bad role (400)', async () => {
    await teams.addMember(db, 't-a', 'u@test.com', 'member');
    await expect(teams.addMember(db, 't-a', 'u@test.com', 'member')).rejects.toMatchObject({ status: 409, code: 'already_member' });
    await expect(teams.addMember(db, 't-x', 'u@test.com', 'member')).rejects.toMatchObject({ status: 404 });
    await expect(teams.addMember(db, 't-a', 'admin2gateway.service.key', 'member')).rejects.toMatchObject({ status: 400, code: 'not_a_user' });
    await expect(teams.addMember(db, 't-a', 'v@test.com', 'owner' as any)).rejects.toMatchObject({ status: 400, code: 'bad_role' });
  });

  it('removing the primary promotes the oldest remaining membership and clears credentials bound to THAT team only (review focus 2)', async () => {
    await teams.addMember(db, 't-a', 'u@test.com', 'member');
    await teams.addMember(db, 't-b', 'u@test.com', 'member');
    await pinOrder();
    await teams.setCredentialTeam(db, { apiKeyId: 'k-1' }, 't-b');          // bound to Beta
    await teams.setCredentialTeam(db, { awsCredentialId: 'c-1' }, 't-a');   // bound to Alpha
    const r = await teams.removeMember(db, 't-a', 'u@test.com');
    expect(r.promotedPrimary).toBe('t-b');
    expect((await lookups.membershipsOf(db, 'u@test.com')).map((m) => [m.team_ID, m.isPrimary])).toEqual([['t-b', true]]);
    expect((await db.run(SELECT.one.from(KEYS).columns('team_ID').where({ ID: 'k-1' }))).team_ID).toBe('t-b');
    expect((await db.run(SELECT.one.from(AWS).columns('team_ID').where({ ID: 'c-1' }))).team_ID).toBeNull();
  });

  it('setPrimary moves the flag; setMemberRole changes the role; removing the last membership leaves no primary', async () => {
    await teams.addMember(db, 't-a', 'u@test.com', 'member');
    await teams.addMember(db, 't-b', 'u@test.com', 'member');
    await pinOrder();
    await teams.setPrimary(db, 't-b', 'u@test.com');
    expect((await lookups.primaryTeamOf(db, 'u@test.com'))?.ID).toBe('t-b');
    expect((await teams.setMemberRole(db, 't-a', 'u@test.com', 'admin')).role).toBe('admin');
    await teams.removeMember(db, 't-b', 'u@test.com');
    await teams.removeMember(db, 't-a', 'u@test.com');
    expect(await lookups.primaryTeamOf(db, 'u@test.com')).toBeNull();
    await expect(teams.removeMember(db, 't-a', 'u@test.com')).rejects.toMatchObject({ status: 404, code: 'not_member' });
  });
});

describe('primaryTeamIdsFor', () => {
  it('picks the oldest primary when an e-mail carries two, the same team primaryTeamOf names', async () => {
    await db.run(INSERT.into(lookups.MEMBERS).entries([
      { ID: 'm-old', team_ID: 't-a', email: 'u@test.com', role: 'member', isPrimary: true, createdAt: '2026-01-01T00:00:00.000Z' },
      { ID: 'm-new', team_ID: 't-b', email: 'u@test.com', role: 'member', isPrimary: true, createdAt: '2026-01-02T00:00:00.000Z' },
      { ID: 'm-v', team_ID: 't-b', email: 'v@test.com', role: 'member', isPrimary: true, createdAt: '2026-01-03T00:00:00.000Z' }
    ]));
    const byEmail = await lookups.primaryTeamIdsFor(db, ['u@test.com', 'v@test.com', 'w@test.com']);
    expect(byEmail.get('u@test.com')).toBe('t-a');
    expect(byEmail.get('u@test.com')).toBe((await lookups.primaryTeamOf(db, 'u@test.com'))?.ID);
    expect(byEmail.get('v@test.com')).toBe('t-b');
    expect(byEmail.has('w@test.com')).toBe(false);
  });
});

describe('the request team of a credential', () => {
  it("is the credential's own team, else the owner's primary, else none; a non-member team is refused", async () => {
    expect(await lookups.requestTeamFor(db, { apiKeyId: 'k-1' })).toBeNull();
    await teams.addMember(db, 't-a', 'u@test.com', 'member');
    expect(await lookups.requestTeamFor(db, { apiKeyId: 'k-1' })).toEqual({ teamId: 't-a', name: 'Alpha' });
    expect(await lookups.requestTeamFor(db, { awsCredentialId: 'c-1' })).toEqual({ teamId: 't-a', name: 'Alpha' });
    await expect(teams.setCredentialTeam(db, { apiKeyId: 'k-1' }, 't-b')).rejects.toMatchObject({ status: 400, code: 'not_a_member' });
    await teams.addMember(db, 't-b', 'u@test.com', 'member');
    await teams.setCredentialTeam(db, { apiKeyId: 'k-1' }, 't-b');
    expect(await lookups.requestTeamFor(db, { apiKeyId: 'k-1' })).toEqual({ teamId: 't-b', name: 'Beta' });
    await teams.setCredentialTeam(db, { apiKeyId: 'k-1' }, null);
    expect(await lookups.requestTeamFor(db, { apiKeyId: 'k-1' })).toEqual({ teamId: 't-a', name: 'Alpha' });
    expect(await lookups.requestTeamFor(db, { apiKeyId: 'k-missing' })).toBeNull();
  });
});

describe('limits', () => {
  it('poolLimits: own value, else the pool profile, else unlimited, with the source', () => {
    const team: any = { requestsPerMinute: 10, spendPerDay: '5.5', tokensPerDay: null };
    const profile: any = { tokensPerDay: 1000, spendPerDay: 99, spendPerWeek: null };
    const { limits, limitSource } = lookups.poolLimits(team, profile);
    expect(limits).toMatchObject({ requestsPerMinute: 10, spendPerDay: 5.5, tokensPerDay: 1000, spendPerWeek: null });
    expect(limitSource).toMatchObject({ requestsPerMinute: 'team', spendPerDay: 'team', tokensPerDay: 'profile', spendPerWeek: 'unlimited' });
  });

  it('memberProfileLimits: lowest per field across the teams, naming the team; null when no team carries a member profile', async () => {
    await profiles.ensureStarterProfiles(db);
    const [light] = await db.run(SELECT.from(profiles.PROFILES).where({ name: 'Light' }));
    const [power] = await db.run(SELECT.from(profiles.PROFILES).where({ name: 'Power' }));
    await teams.addMember(db, 't-a', 'u@test.com', 'member');
    await teams.addMember(db, 't-b', 'u@test.com', 'member');
    expect(await lookups.memberProfileLimits(db, 'u@test.com')).toBeNull();
    await db.run(cds.ql.UPDATE(lookups.TEAMS).set({ memberQuotaProfile_ID: power.ID }).where({ ID: 't-a' }));
    await db.run(cds.ql.UPDATE(lookups.TEAMS).set({ memberQuotaProfile_ID: light.ID }).where({ ID: 't-b' }));
    const m = await lookups.memberProfileLimits(db, 'u@test.com');
    expect(m?.limits.tokensPerDay).toBe(500000); expect(m?.teamByField.tokensPerDay).toBe('Beta');
    expect(m?.limits.spendPerMonth).toBe(150); expect(m?.teamByField.spendPerMonth).toBe('Beta');
  });
});

describe('dependants and deletion', () => {
  it('lists the teams using a profile, a catalog or a policy; a team with members cannot be deleted', async () => {
    await db.run(cds.ql.UPDATE(lookups.TEAMS).set({ quotaProfile_ID: 'p-1', entitlementCatalog_ID: 'c-1', toolPolicy_ID: 'tp-1' }).where({ ID: 't-a' }));
    await db.run(cds.ql.UPDATE(lookups.TEAMS).set({ memberQuotaProfile_ID: 'p-1' }).where({ ID: 't-b' }));
    expect((await lookups.teamsUsingProfile(db, 'p-1')).map((t) => t.name).sort()).toEqual(['Alpha', 'Beta']);
    expect((await lookups.teamsUsingCatalog(db, 'c-1')).map((t) => t.name)).toEqual(['Alpha']);
    expect((await lookups.teamsUsingPolicy(db, 'tp-1')).map((t) => t.name)).toEqual(['Alpha']);
    await teams.addMember(db, 't-a', 'u@test.com', 'member');
    await expect(teams.assertDeletable(db, (await lookups.getTeam(db, 't-a'))!)).rejects.toMatchObject({ status: 409, code: 'has_members' });
    await teams.removeMember(db, 't-a', 'u@test.com');
    await teams.deleteTeam(db, 't-a');
    expect(await lookups.getTeam(db, 't-a')).toBeNull();
  });

  it('validateTeamWrite: trimmed non-empty name on create, ordered windows against the stored row', () => {
    expect(teams.validateTeamWrite({ name: '  ' }, null)).toContain('name is required');
    expect(teams.validateTeamWrite({ tokensPerDay: 100 }, { tokensPerMonth: 10 } as any)).toContain('tokensPerDay must not exceed tokensPerMonth');
    expect(teams.validateTeamWrite({ name: 'Ok', spendPerDay: 1, spendPerWeek: 2 }, null)).toEqual([]);
  });
});
