// services/admin/test/integration/http/teams-polish-odata.test.ts
/**
 * Teams polish (docs/superpowers/notes/2026-10-15-teams-polish-design.md) over OData on cds.test():
 * Entitlements & Quotas assigns a catalog and both profile slots to a team (platform admins only,
 * same side effects as a draft save, an open draft follows), and the member actions keep an open
 * draft's member list in step so they work while the team is in edit mode.
 */
import path from 'path';
process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'tp-admin@test.com': { id: 'tp-admin@test.com', roles: ['admin', 'user'] },
  'tp-lead@test.com': { id: 'tp-lead@test.com', roles: ['user'] },
  'tp-member@test.com': { id: 'tp-member@test.com', roles: ['user'] } } };
jest.mock('../../../src/services/cacheInvalidationService', () => ({
  cacheInvalidationService: { bulkInvalidate: jest.fn(), invalidatePattern: jest.fn(), invalidateApiKey: jest.fn(), invalidateAwsCredential: jest.fn() }, default: {} }));
const written = new Map<string, any>();
jest.mock('../../../src/services/quotaStateStore', () => ({
  ...jest.requireActual('../../../src/services/quotaStateStore'),
  quotaStateStore: { initialize: jest.fn(), available: () => true, setJson: jest.fn(async (k: string, v: any) => { written.set(k, v); return true; }),
    getJson: jest.fn(async () => null), getNumber: jest.fn(async () => 0), del: jest.fn(async (k: string) => { written.delete(k); return true; }), shutdown: jest.fn() } }));

const { GET, POST, PATCH } = cds.test(path.resolve(__dirname, '../../..'));
const { cacheInvalidationService } = require('../../../src/services/cacheInvalidationService');
import * as users from '../../../src/services/usersService';
import * as lookups from '../../../src/services/teamLookups';
import * as teams from '../../../src/services/teamsService';
import * as profiles from '../../../src/services/quotaProfilesService';

const ADMIN = { auth: { username: 'tp-admin@test.com', password: 'x' } };
const LEAD = { auth: { username: 'tp-lead@test.com', password: 'x' } };
const ok = (p: Promise<any>) => p.catch((e: any) => e.response);
const S = '/odata/v4/admin';
const CATALOGS = 'sap.llm.gateway.admin.ModelCatalogs';
const AUDIT = 'sap.llm.gateway.admin.AuditEvents';
const t = (id: string, active = true) => `${S}/Teams(ID=${id},IsActiveEntity=${active})`;
const message = (r: any): string => String(r?.data?.error?.message ?? r?.data?.message ?? '');

async function createTeam(data: any) {
  const draft = await POST(`${S}/Teams`, data, ADMIN);
  expect(draft.status).toBe(201);
  const activated = await POST(`${t(draft.data.ID, false)}/AdminService.draftActivate`, {}, ADMIN);
  expect(activated.status).toBe(201);
  return activated.data;
}
const stored = async (id: string) => cds.db.run(cds.ql.SELECT.one.from(lookups.TEAMS).where({ ID: id }));
const draftMembers = async (id: string) =>
  ((await GET(`${t(id, false)}/members?$select=email,role,isPrimary&$orderby=email`, ADMIN)).data.value as any[]).map((m) => `${m.email}:${m.role}:${m.isPrimary}`);
let light: any; let heavy: any;

beforeEach(async () => {
  const { DELETE: DEL, INSERT } = cds.ql;
  written.clear();
  for (const tbl of [lookups.MEMBERS, lookups.TEAMS, AUDIT, lookups.KEYS, users.USERS, profiles.PROFILES]) await cds.db.run(DEL.from(tbl));
  await cds.db.run(INSERT.into(lookups.KEYS).entries({ ID: 'k-lead', key: 'sk-lead', name: 'lead', email: 'tp-lead@test.com', isActive: true }));
  for (const d of ['AdminService.TeamMembers.drafts', 'AdminService.Teams.drafts']) { try { await cds.db.run(DEL.from(d)); } catch { /* no draft table */ } }
  await cds.db.run(DEL.from(CATALOGS).where({ ID: { in: ['c-admin', 'c-personal'] } }));
  await cds.db.run(INSERT.into(CATALOGS).entries([{ ID: 'c-admin', name: 'Engineering' }, { ID: 'c-personal', name: 'Mine', ownerEmail: 'tp-lead@test.com' }]));
  for (const e of ['tp-admin@test.com', 'tp-lead@test.com', 'tp-member@test.com']) await users.touch(cds.db, e, { roles: ['user'] });
  await profiles.ensureStarterProfiles(cds.db);
  [light] = await cds.db.run(cds.ql.SELECT.from(profiles.PROFILES).where({ name: 'Light' }));
  [heavy] = await cds.db.run(cds.ql.SELECT.from(profiles.PROFILES).where({ name: { '!=': 'Light' } }).limit(1));
  (cacheInvalidationService.bulkInvalidate as jest.Mock).mockClear();
});

describe('Entitlements & Quotas assigns a team (platform admins only)', () => {
  it('assigns and unassigns the catalog with the side effects of a draft save; personal and unknown catalogs are refused; a team admin gets 403', async () => {
    const team = await createTeam({ name: 'Alpha' });
    await teams.addMember(cds.db, team.ID, 'tp-lead@test.com', 'admin');
    const r = await POST(`${S}/assignTeamCatalog`, { teamId: team.ID, catalogId: 'c-admin' }, ADMIN);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ ID: team.ID, entitlementCatalog_ID: 'c-admin' });
    expect((await stored(team.ID)).entitlementCatalog_ID).toBe('c-admin');
    expect((cacheInvalidationService.bulkInvalidate as jest.Mock).mock.calls[0][0].map((c: any) => c.credentialId)).toEqual(['sk-lead']);
    expect(written.has(`quota:team:${team.ID}`)).toBe(true);
    const audits = await cds.db.run(cds.ql.SELECT.from(AUDIT).where({ resourceId: team.ID, action: 'team.update' }));
    expect(audits.some((a: any) => String(a.details).includes('c-admin'))).toBe(true);

    expect((await POST(`${S}/assignTeamCatalog`, { teamId: team.ID, catalogId: null }, ADMIN)).status).toBe(200);
    expect((await stored(team.ID)).entitlementCatalog_ID).toBeNull();

    const personal = await ok(POST(`${S}/assignTeamCatalog`, { teamId: team.ID, catalogId: 'c-personal' }, ADMIN));
    expect(personal.status).toBe(400); expect(message(personal)).toMatch(/admin catalogs/);
    expect((await ok(POST(`${S}/assignTeamCatalog`, { teamId: team.ID, catalogId: 'c-none' }, ADMIN))).status).toBe(404);
    expect((await ok(POST(`${S}/assignTeamCatalog`, { teamId: '00000000-0000-0000-0000-00000000000a', catalogId: 'c-admin' }, ADMIN))).status).toBe(404);
    expect((await ok(POST(`${S}/assignTeamCatalog`, { teamId: team.ID, catalogId: 'c-admin' }, LEAD))).status).toBe(403);
    expect((await stored(team.ID)).entitlementCatalog_ID).toBeNull();
  });

  it('assigns a profile to the pool slot or the member slot separately, unassigns each, and refuses a bad slot or a non-admin', async () => {
    const team = await createTeam({ name: 'Alpha' });
    await teams.addMember(cds.db, team.ID, 'tp-member@test.com', 'member');
    expect((await POST(`${S}/assignTeamQuotaProfile`, { teamId: team.ID, profileId: light.ID, slot: 'pool' }, ADMIN)).status).toBe(200);
    expect(await stored(team.ID)).toMatchObject({ quotaProfile_ID: light.ID, memberQuotaProfile_ID: null });
    expect(written.get(`quota:team:${team.ID}`).limits.tokensPerDay).toBe(500000);

    written.clear();
    const member = await POST(`${S}/assignTeamQuotaProfile`, { teamId: team.ID, profileId: heavy.ID, slot: 'member' }, ADMIN);
    expect(member.status).toBe(200);
    expect(member.data).toMatchObject({ quotaProfile_ID: light.ID, memberQuotaProfile_ID: heavy.ID, memberQuotaProfileName: heavy.name });
    // a member-profile change republishes the members' own quota documents (spec §5 matrix)
    expect([...written.keys()].filter((k) => k.startsWith('quota:user:')).length).toBe(1);

    expect((await POST(`${S}/assignTeamQuotaProfile`, { teamId: team.ID, profileId: null, slot: 'pool' }, ADMIN)).status).toBe(200);
    expect(await stored(team.ID)).toMatchObject({ quotaProfile_ID: null, memberQuotaProfile_ID: heavy.ID });
    expect((await POST(`${S}/assignTeamQuotaProfile`, { teamId: team.ID, profileId: null, slot: 'member' }, ADMIN)).status).toBe(200);
    expect(await stored(team.ID)).toMatchObject({ quotaProfile_ID: null, memberQuotaProfile_ID: null });

    expect((await ok(POST(`${S}/assignTeamQuotaProfile`, { teamId: team.ID, profileId: light.ID, slot: 'both' }, ADMIN))).status).toBe(400);
    expect((await ok(POST(`${S}/assignTeamQuotaProfile`, { teamId: team.ID, profileId: '00000000-0000-0000-0000-00000000000b', slot: 'pool' }, ADMIN))).status).toBe(404);
    expect((await ok(POST(`${S}/assignTeamQuotaProfile`, { teamId: team.ID, profileId: light.ID, slot: 'pool' }, LEAD))).status).toBe(403);
  });

  it('an open draft of the team follows the assignment, so saving the draft does not revert it', async () => {
    const team = await createTeam({ name: 'Alpha' });
    expect((await POST(`${t(team.ID)}/AdminService.draftEdit`, { PreserveChanges: true }, ADMIN)).status).toBe(201);
    expect((await PATCH(t(team.ID, false), { description: 'edited' }, ADMIN)).status).toBe(200);
    await POST(`${S}/assignTeamCatalog`, { teamId: team.ID, catalogId: 'c-admin' }, ADMIN);
    await POST(`${S}/assignTeamQuotaProfile`, { teamId: team.ID, profileId: light.ID, slot: 'member' }, ADMIN);
    expect((await POST(`${t(team.ID, false)}/AdminService.draftActivate`, {}, ADMIN)).status).toBe(200);
    expect(await stored(team.ID)).toMatchObject({ description: 'edited', entitlementCatalog_ID: 'c-admin', memberQuotaProfile_ID: light.ID });
  });
});

describe('member actions while the team is in edit mode', () => {
  it('act at once on the saved team and keep the open draft\'s member list in step; saving the draft keeps them', async () => {
    const team = await createTeam({ name: 'Alpha' });
    await teams.addMember(cds.db, team.ID, 'tp-lead@test.com', 'member');
    expect((await POST(`${t(team.ID)}/AdminService.draftEdit`, { PreserveChanges: true }, ADMIN)).status).toBe(201);
    expect(await draftMembers(team.ID)).toEqual(['tp-lead@test.com:member:true']);

    expect((await POST(`${t(team.ID)}/AdminService.addMember`, { email: 'tp-member@test.com', role: 'member' }, ADMIN)).status).toBe(200);
    expect(await draftMembers(team.ID)).toEqual(['tp-lead@test.com:member:true', 'tp-member@test.com:member:true']);
    expect((await POST(`${t(team.ID)}/AdminService.setMemberRole`, { email: 'tp-lead@test.com', role: 'admin' }, ADMIN)).status).toBe(200);
    expect((await POST(`${t(team.ID)}/AdminService.removeMember`, { email: 'tp-member@test.com' }, ADMIN)).status).toBe(200);
    expect(await draftMembers(team.ID)).toEqual(['tp-lead@test.com:admin:true']);
    expect((await POST(`${t(team.ID)}/AdminService.addMember`, { email: 'tp-member@test.com', role: 'member' }, ADMIN)).status).toBe(200);

    expect((await PATCH(t(team.ID, false), { description: 'edited' }, ADMIN)).status).toBe(200);
    expect((await POST(`${t(team.ID, false)}/AdminService.draftActivate`, {}, ADMIN)).status).toBe(200);
    expect((await lookups.membersOf(cds.db, team.ID)).map((m) => `${m.email}:${m.role}`).sort()).toEqual(['tp-lead@test.com:admin', 'tp-member@test.com:member']);
    expect((await stored(team.ID)).description).toBe('edited');
  });

  it('a never-saved team has no members to manage yet: the actions answer 404', async () => {
    const draft = await POST(`${S}/Teams`, { name: 'Fresh' }, ADMIN);
    expect((await ok(POST(`${t(draft.data.ID)}/AdminService.addMember`, { email: 'tp-member@test.com', role: 'member' }, ADMIN))).status).toBe(404);
  });
});
