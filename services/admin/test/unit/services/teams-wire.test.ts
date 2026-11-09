// services/admin/test/unit/services/teams-wire.test.ts
/**
 * What the validation payload carries once teams exist (spec 2026-10-14 §4/§5): the user block's
 * member-profile step and teamIds, the team block, the intersected entitlement block, the team
 * tool-policy block, and a pin that validation-service.ts attaches them in all four assemblies.
 */
import fs from 'fs';
import path from 'path';
process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.test(path.resolve(__dirname, '../../..'));

import * as users from '../../../src/services/usersService';
import * as lookups from '../../../src/services/teamLookups';
import * as teams from '../../../src/services/teamsService';
import * as profiles from '../../../src/services/quotaProfilesService';
import * as ent from '../../../src/services/modelEntitlementService';
import * as tp from '../../../src/services/toolPolicyService';
import * as quota from '../../../src/services/userQuotaService';

const KEYS = 'sap.llm.gateway.admin.ApiKeys';
const CAT = 'sap.llm.gateway.admin.ModelCatalogs';
const MEM = 'sap.llm.gateway.admin.ModelCatalogMembers';
const EXC = 'sap.llm.gateway.admin.ModelCatalogExclusions';
let db: any;
const { INSERT, UPDATE, DELETE, SELECT } = cds.ql;

beforeAll(async () => { db = await cds.connect.to('db'); });
beforeEach(async () => {
  for (const t of [lookups.MEMBERS, lookups.TEAMS, KEYS, users.USERS, profiles.PROFILES, MEM, EXC, CAT, tp.ALLOWS, tp.DENIES, tp.SENSITIVE, tp.UNTRUSTED, tp.POLICIES]) await db.run(DELETE.from(t));
  await db.run(INSERT.into(lookups.TEAMS).entries([{ ID: 't-a', name: 'Alpha' }, { ID: 't-b', name: 'Beta' }]));
  await db.run(INSERT.into(KEYS).entries({ ID: 'k-1', key: 'sk-1', name: 'k1', email: 'u@test.com', isActive: true }));
  await users.touch(db, 'u@test.com', { roles: ['user'] });
});

describe('user block', () => {
  it('carries teamIds and the member-profile step', async () => {
    await profiles.ensureStarterProfiles(db);
    const [light] = await db.run(SELECT.from(profiles.PROFILES).where({ name: 'Light' }));
    await db.run(UPDATE(lookups.TEAMS).set({ memberQuotaProfile_ID: light.ID }).where({ ID: 't-a' }));
    await teams.addMember(db, 't-a', 'u@test.com', 'member');
    await teams.addMember(db, 't-b', 'u@test.com', 'member');
    // two addMember calls can share a millisecond: pin distinct createdAt so "oldest first" is deterministic
    await db.run(UPDATE(lookups.MEMBERS).set({ createdAt: '2026-01-01T00:00:00.000Z' }).where({ team_ID: 't-a' }));
    await db.run(UPDATE(lookups.MEMBERS).set({ createdAt: '2026-01-02T00:00:00.000Z' }).where({ team_ID: 't-b' }));
    const block = await users.wireBlock(db, 'u@test.com');
    expect(block.teamIds).toEqual(['t-a', 't-b']);
    expect(block.limits.tokensPerDay).toBe(500000);
    expect((await users.wireBlock(db, 'nobody@test.com')).teamIds).toEqual([]);
  });
});

describe('a failing team lookup degrades instead of dropping the user block', () => {
  afterEach(() => jest.restoreAllMocks());
  const breakTeamLookups = () => {
    jest.spyOn(lookups, 'memberProfileLimits').mockRejectedValue(new Error('no such table: TeamMembers'));
    jest.spyOn(lookups, 'teamIdsOf').mockRejectedValue(new Error('no such table: TeamMembers'));
    jest.spyOn(lookups, 'primaryTeamOf').mockRejectedValue(new Error('no such table: TeamMembers'));
  };
  it('wireBlock still carries the deactivation and the user\'s own limits', async () => {
    await db.run(UPDATE(users.USERS).set({ status: 'deactivated', tokensPerDay: 1234 }).where({ email: 'u@test.com' }));
    breakTeamLookups();
    const block = await users.wireBlock(db, 'u@test.com');
    expect(block.status).toBe('deactivated');
    expect(block.limits.tokensPerDay).toBe(1234);
    expect(block.teamIds).toEqual([]);
  });
  it('buildDocument and status still answer, without the team step', async () => {
    await db.run(UPDATE(users.USERS).set({ status: 'deactivated', tokensPerDay: 1234 }).where({ email: 'u@test.com' }));
    breakTeamLookups();
    const doc = await quota.buildDocument(db, 'u@test.com', new Date(), 'EUR');
    expect(doc).toMatchObject({ status: 'deactivated', primaryTeamId: null, limits: { tokensPerDay: 1234 } });
    const st = await quota.status(db, 'u@test.com', new Date(), 'EUR');
    expect(st).toMatchObject({ status: 'deactivated', teamLimits: null, limits: { tokensPerDay: 1234 } });
  });
});

describe('team block', () => {
  it('is the pool limits with the team id and name', async () => {
    await db.run(UPDATE(lookups.TEAMS).set({ spendPerDay: 12 }).where({ ID: 't-a' }));
    expect(await lookups.wireTeamBlock(db, { teamId: 't-a', name: 'Alpha' })).toMatchObject({ teamId: 't-a', teamName: 'Alpha', limits: { spendPerDay: 12, tokensPerDay: null } });
  });
});

describe('entitlement block with a team (spec §4 table)', () => {
  const seed = async () => {
    const def = await ent.ensureDefaultCatalog(db);
    await db.run(INSERT.into(CAT).entries([{ ID: 'c-o', name: 'Owner', isDefault: false }, { ID: 'c-t', name: 'Team', isDefault: false }]));
    await db.run(INSERT.into(MEM).entries([{ ID: 'm1', catalog_ID: 'c-o', modelId: 'a' }, { ID: 'm2', catalog_ID: 'c-o', modelId: 'b' }, { ID: 'm3', catalog_ID: 'c-o', modelId: 'x' },
      { ID: 'm4', catalog_ID: 'c-t', modelId: 'b' }, { ID: 'm5', catalog_ID: 'c-t', modelId: 'c' }, { ID: 'm6', catalog_ID: 'c-t', modelId: 'x' }]));
    await db.run(INSERT.into(EXC).entries({ ID: 'e1', catalog_ID: def.ID, modelId: 'x' }));
    return def;
  };
  it('all × all = all minus exclusions; no team = today\'s block', async () => {
    const def = await seed();
    expect(await ent.entitlementBlockFor(db, 'u@test.com')).toEqual({ catalogId: def.ID, catalogName: 'Default', mode: 'all', exclude: ['x'] });
    expect(await ent.entitlementBlockFor(db, 'u@test.com', { teamId: 't-a', name: 'Alpha' })).toEqual({ catalogId: def.ID, catalogName: 'Default', mode: 'all', exclude: ['x'] });
  });
  it('list × all = the owner list minus exclusions; all × list = the team list minus exclusions, naming the team catalog', async () => {
    const def = await seed();
    await db.run(UPDATE(users.USERS).set({ entitlementCatalog_ID: 'c-o' }).where({ email: 'u@test.com' }));
    expect(await ent.entitlementBlockFor(db, 'u@test.com')).toEqual({ catalogId: 'c-o', catalogName: 'Owner', mode: 'list', include: ['a', 'b', 'x'] });
    expect(await ent.entitlementBlockFor(db, 'u@test.com', { teamId: 't-a', name: 'Alpha' })).toEqual({ catalogId: 'c-o', catalogName: 'Owner', mode: 'list', include: ['a', 'b'] });
    await db.run(UPDATE(users.USERS).set({ entitlementCatalog_ID: null }).where({ email: 'u@test.com' }));
    await db.run(UPDATE(lookups.TEAMS).set({ entitlementCatalog_ID: 'c-t' }).where({ ID: 't-a' }));
    expect(await ent.entitlementBlockFor(db, 'u@test.com', { teamId: 't-a', name: 'Alpha' })).toEqual({ catalogId: def.ID, catalogName: 'Default', teamCatalogId: 'c-t', teamCatalogName: 'Team', mode: 'list', include: ['b', 'c'] });
  });
  it('list × list = the intersection', async () => {
    await seed();
    await db.run(UPDATE(users.USERS).set({ entitlementCatalog_ID: 'c-o' }).where({ email: 'u@test.com' }));
    await db.run(UPDATE(lookups.TEAMS).set({ entitlementCatalog_ID: 'c-t' }).where({ ID: 't-a' }));
    expect(await ent.entitlementBlockFor(db, 'u@test.com', { teamId: 't-a', name: 'Alpha' })).toEqual({ catalogId: 'c-o', catalogName: 'Owner', teamCatalogId: 'c-t', teamCatalogName: 'Team', mode: 'list', include: ['b', 'x'] });
  });
});

describe('team tool-policy block', () => {
  it('is the team policy\'s block, or null when the team names none', async () => {
    expect(await tp.teamPolicyBlockFor(db, 't-a')).toBeNull();
    await db.run(INSERT.into(tp.POLICIES).entries({ ID: 'tp-1', name: 'Strict', isDefault: false, mode: 'reject' }));
    await db.run(INSERT.into(tp.DENIES).entries({ ID: 'd1', policy_ID: 'tp-1', pattern: 'mcp:*' }));
    await db.run(UPDATE(lookups.TEAMS).set({ toolPolicy_ID: 'tp-1' }).where({ ID: 't-a' }));
    expect(await tp.teamPolicyBlockFor(db, 't-a')).toMatchObject({ policyId: 'tp-1', policyName: 'Strict', mode: 'reject', deny: ['mcp:*'] });
    expect(await tp.teamPolicyBlockFor(db, 't-missing')).toBeNull();
  });
});

describe('validation-service wiring pin', () => {
  it('every assembly attaches team, teamToolPolicy and passes the team to the entitlement block', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../../src/srv/validation-service.ts'), 'utf8');
    expect(src.match(/team: await this\.teamBlock\(/g)?.length).toBe(4);
    expect(src.match(/teamToolPolicy: await this\.teamToolPolicyBlock\(/g)?.length).toBe(4);
    expect(src.match(/entitlement: await this\.entitlementBlock\([^)]*, team\)/g)?.length).toBe(4);
  });
});
