// services/admin/test/integration/http/teams-odata.test.ts
/**
 * Teams over OData (spec 2026-10-14 §7) on cds.test(): grants, draft create and edit with the
 * unique name and the window order, the virtuals, the row filter for team admins, the invalidation
 * and republish a change costs, the delete guard. Mocked users; the cache invalidation and the
 * quota store are mocked so their calls can be asserted.
 */
import path from 'path';
process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'tm-admin@test.com': { id: 'tm-admin@test.com', roles: ['admin', 'user'] },
  'tm-lead@test.com': { id: 'tm-lead@test.com', roles: ['user'] },
  'tm-member@test.com': { id: 'tm-member@test.com', roles: ['user'] },
  'tm-other@test.com': { id: 'tm-other@test.com', roles: ['user'] } } };
jest.mock('../../../src/services/cacheInvalidationService', () => ({
  cacheInvalidationService: { bulkInvalidate: jest.fn(), invalidatePattern: jest.fn(), invalidateApiKey: jest.fn(), invalidateAwsCredential: jest.fn() }, default: {} }));
const written = new Map<string, any>();
jest.mock('../../../src/services/quotaStateStore', () => ({
  ...jest.requireActual('../../../src/services/quotaStateStore'),
  quotaStateStore: { initialize: jest.fn(), available: () => true, setJson: jest.fn(async (k: string, v: any) => { written.set(k, v); return true; }),
    getJson: jest.fn(async () => null), getNumber: jest.fn(async () => 0), del: jest.fn(async (k: string) => { written.delete(k); return true; }), shutdown: jest.fn() } }));

const { GET, POST, PATCH, DELETE } = cds.test(path.resolve(__dirname, '../../..'));
const { cacheInvalidationService } = require('../../../src/services/cacheInvalidationService');
import * as users from '../../../src/services/usersService';
import * as lookups from '../../../src/services/teamLookups';
import * as teams from '../../../src/services/teamsService';
import * as profiles from '../../../src/services/quotaProfilesService';

const ADMIN = { auth: { username: 'tm-admin@test.com', password: 'x' } };
const LEAD = { auth: { username: 'tm-lead@test.com', password: 'x' } };
const MEMBER = { auth: { username: 'tm-member@test.com', password: 'x' } };
const OTHER = { auth: { username: 'tm-other@test.com', password: 'x' } };
const ok = (p: Promise<any>) => p.catch((e: any) => e.response);
const S = '/odata/v4/admin';
const KEYS = 'sap.llm.gateway.admin.ApiKeys';
const AUDIT = 'sap.llm.gateway.admin.AuditEvents';
const t = (id: string, active = true) => `${S}/Teams(ID=${id},IsActiveEntity=${active})`;
const message = (r: any): string => String(r?.data?.error?.message ?? r?.data?.message ?? '');

/** Creates a team through the draft flow the Fiori list uses: POST creates a draft, draftActivate makes it active. */
async function createTeam(data: any) {
  const draft = await POST(`${S}/Teams`, data, ADMIN);
  expect(draft.status).toBe(201);
  const activated = await POST(`${t(draft.data.ID, false)}/AdminService.draftActivate`, {}, ADMIN);
  expect(activated.status).toBe(201);
  return activated.data;
}
/** Edits an active team through the draft flow: draftEdit, PATCH the draft, draftActivate. */
async function editTeam(id: string, patch: any, who = ADMIN) {
  const edit = await ok(POST(`${t(id)}/AdminService.draftEdit`, { PreserveChanges: true }, who));
  if (edit.status !== 201) return edit;
  const patched = await ok(PATCH(t(id, false), patch, who));
  if (patched.status >= 400) { await ok(POST(`${t(id, false)}/AdminService.draftActivate`, {}, who)).catch(() => undefined); await ok(DELETE(t(id, false), who)); return patched; }
  return ok(POST(`${t(id, false)}/AdminService.draftActivate`, {}, who));
}

beforeEach(async () => {
  const { DELETE: DEL, INSERT } = cds.ql;
  written.clear();
  for (const tbl of [lookups.MEMBERS, lookups.TEAMS, AUDIT, KEYS, users.USERS, profiles.PROFILES]) await cds.db.run(DEL.from(tbl));
  try { await cds.db.run(DEL.from('AdminService.Teams.drafts')); } catch { /* no draft table */ }
  await cds.db.run(INSERT.into(KEYS).entries([{ ID: 'k-lead', key: 'sk-lead', name: 'lead', email: 'tm-lead@test.com', isActive: true }, { ID: 'k-member', key: 'sk-member', name: 'member', email: 'tm-member@test.com', isActive: true }]));
  for (const e of ['tm-admin@test.com', 'tm-lead@test.com', 'tm-member@test.com', 'tm-other@test.com']) await users.touch(cds.db, e, { roles: ['user'] });
  await profiles.ensureStarterProfiles(cds.db);
  (cacheInvalidationService.bulkInvalidate as jest.Mock).mockClear();
});

describe('grants and the draft flow', () => {
  it('an admin creates a team through the draft flow; a user cannot create; the name is unique and trimmed; windows are ordered', async () => {
    const team = await createTeam({ name: '  Alpha ', description: 'd', tokensPerDay: 100, tokensPerMonth: 1000 });
    expect(team.name).toBe('Alpha');
    expect((await GET(t(team.ID), ADMIN)).data).toMatchObject({ name: 'Alpha', memberCount: 0, canEdit: true, canManageMembers: true, effectiveTokensPerDay: 100, limitSourceTokensPerDay: 'team', limitSourceSpendPerDay: 'unlimited', tokensPerDayDefaultText: 'unlimited' });
    expect((await ok(POST(`${S}/Teams`, { name: 'Beta' }, LEAD))).status).toBe(403);
    const dup = await ok(POST(`${S}/Teams`, { name: 'Alpha' }, ADMIN));
    const dupActivate = dup.status === 201 ? await ok(POST(`${t(dup.data.ID, false)}/AdminService.draftActivate`, {}, ADMIN)) : dup;
    expect(dupActivate.status).toBe(400); expect(message(dupActivate)).toMatch(/already exists/);
    const bad = await editTeam(team.ID, { tokensPerDay: 5000 });
    expect(bad.status).toBe(400); expect(message(bad)).toMatch(/tokensPerDay must not exceed tokensPerMonth/);
  });

  it('a pool-profile assignment through the draft fills the default lines and the pool virtuals', async () => {
    const [light] = await cds.db.run(cds.ql.SELECT.from(profiles.PROFILES).where({ name: 'Light' }));
    const team = await createTeam({ name: 'Alpha' });
    const saved = await editTeam(team.ID, { quotaProfile_ID: light.ID, spendPerDay: 3 });
    expect(saved.status).toBe(200);
    const row = (await GET(t(team.ID), ADMIN)).data;
    expect(row).toMatchObject({ quotaProfileName: 'Light', effectiveSpendPerDay: 3, limitSourceSpendPerDay: 'team', effectiveTokensPerDay: 500000, limitSourceTokensPerDay: 'profile', spendPerDayDefaultText: '25.00 USD (Light profile)', usedTokensDay: 0, sapCostCurrency: 'USD' });
    expect(written.get(`quota:team:${team.ID}`).limits).toMatchObject({ spendPerDay: 3, tokensPerDay: 500000 });
  });

  it('a personal catalog cannot be assigned to a team', async () => {
    await cds.db.run(cds.ql.INSERT.into('sap.llm.gateway.admin.ModelCatalogs').entries({ ID: 'c-personal', name: 'Mine', ownerEmail: 'tm-lead@test.com' }));
    const team = await createTeam({ name: 'Alpha' });
    const r = await editTeam(team.ID, { entitlementCatalog_ID: 'c-personal' });
    expect(r.status).toBe(400); expect(message(r)).toMatch(/admin catalogs/);
  });
});

describe('the Fiori create flow (Ruling R2)', () => {
  it('a never-activated draft takes one-field PATCHes without a name; an emptied name is refused; activation still needs the name', async () => {
    const draft = await POST(`${S}/Teams`, {}, ADMIN);
    expect(draft.status).toBe(201);
    expect((await ok(PATCH(t(draft.data.ID, false), { description: 'd' }, ADMIN))).status).toBe(200);
    expect((await ok(PATCH(t(draft.data.ID, false), { tokensPerMonth: 1000 }, ADMIN))).status).toBe(200);
    const emptied = await ok(PATCH(t(draft.data.ID, false), { name: '' }, ADMIN));
    expect(emptied.status).toBe(400); expect(message(emptied)).toMatch(/needs a name/);
    const nameless = await ok(POST(`${t(draft.data.ID, false)}/AdminService.draftActivate`, {}, ADMIN));
    expect(nameless.status).toBe(400); expect(message(nameless)).toMatch(/needs a name|Value is required/);
    expect((await ok(PATCH(t(draft.data.ID, false), { name: 'Gamma', tokensPerDay: 5000 }, ADMIN))).status).toBe(200);
    const unordered = await ok(POST(`${t(draft.data.ID, false)}/AdminService.draftActivate`, {}, ADMIN));
    expect(unordered.status).toBe(400); expect(message(unordered)).toMatch(/tokensPerDay must not exceed tokensPerMonth/);
    expect((await ok(PATCH(t(draft.data.ID, false), { tokensPerDay: 100 }, ADMIN))).status).toBe(200);
    expect((await ok(POST(`${t(draft.data.ID, false)}/AdminService.draftActivate`, {}, ADMIN))).status).toBe(201);
    expect((await GET(t(draft.data.ID), ADMIN)).data).toMatchObject({ name: 'Gamma', description: 'd', tokensPerDay: 100, tokensPerMonth: 1000 });
  });

  it('a never-activated draft carries the pool virtuals in the create response and on read, so the object page can bind them', async () => {
    const draft = await POST(`${S}/Teams`, {}, ADMIN);
    expect(draft.status).toBe(201);
    expect(draft.data).toMatchObject({ memberCount: 0, usedSpendMonth: 0, usedTokensMonth: 0, sapCostCurrency: 'USD' });
    for (const k of ['effectiveSpendPerMonth', 'effectiveSpendPerMonthCurrency', 'spendPerMonthDefaultText', 'requestsPerMinuteDefaultText']) expect(draft.data).toHaveProperty(k);
    expect((await ok(PATCH(t(draft.data.ID, false), { tokensPerMonth: 1000 }, ADMIN))).status).toBe(200);
    const row = (await GET(t(draft.data.ID, false), ADMIN)).data;
    expect(row).toMatchObject({ effectiveTokensPerMonth: 1000, limitSourceTokensPerMonth: 'team', usedTokensMonth: 0, sapCostCurrency: 'USD' });
    expect(row).toHaveProperty('tokensPerDayDefaultText');
  });
});

describe('row filter and member reads', () => {
  it('a team admin reads only the teams they administer; a member and an outsider read nothing', async () => {
    const a = await createTeam({ name: 'Alpha' }); const b = await createTeam({ name: 'Beta' });
    await teams.addMember(cds.db, a.ID, 'tm-lead@test.com', 'admin');
    await teams.addMember(cds.db, b.ID, 'tm-lead@test.com', 'member');
    await teams.addMember(cds.db, a.ID, 'tm-member@test.com', 'member');
    expect((await GET(`${S}/Teams?$orderby=name`, ADMIN)).data.value.map((x: any) => x.name)).toEqual(['Alpha', 'Beta']);
    const lead = (await GET(`${S}/Teams?$orderby=name`, LEAD)).data.value;
    expect(lead.map((x: any) => [x.name, x.canEdit, x.canManageMembers, x.memberCount])).toEqual([['Alpha', false, true, 2]]);
    expect((await GET(`${S}/Teams`, MEMBER)).data.value).toEqual([]);
    expect((await ok(GET(t(b.ID), LEAD))).status).toBe(404);
    expect((await GET(`${S}/TeamMembers?$orderby=email`, LEAD)).data.value.map((m: any) => m.email)).toEqual(['tm-lead@test.com', 'tm-member@test.com']);
    expect((await GET(`${S}/TeamMembers`, OTHER)).data.value).toEqual([]);
    expect((await ok(editTeam(a.ID, { description: 'x' }, LEAD))).status).toBeGreaterThanOrEqual(400);
  });
});

describe('$expand for team admins (Ruling R8)', () => {
  it('refuses expands into admin-only entities unless they name only the whitelisted columns; a platform admin expands freely', async () => {
    const [light] = await cds.db.run(cds.ql.SELECT.from(profiles.PROFILES).where({ name: 'Light' }));
    const a = await createTeam({ name: 'Alpha' });
    expect((await editTeam(a.ID, { quotaProfile_ID: light.ID })).status).toBe(200);
    await teams.addMember(cds.db, a.ID, 'tm-lead@test.com', 'admin');
    await teams.addMember(cds.db, a.ID, 'tm-member@test.com', 'member');
    for (const url of [
      `${S}/Teams?$expand=quotaProfile`, `${S}/Teams?$expand=memberQuotaProfile`, `${S}/Teams?$expand=toolPolicy`, `${S}/Teams?$expand=entitlementCatalog`,
      `${S}/Teams?$expand=members($expand=user)`, `${S}/TeamMembers?$expand=user`, `${S}/TeamMembers?$expand=team`,
      `${S}/Teams?$expand=quotaProfile($select=ID,name,tokensPerDay)`, `${S}/TeamMembers?$expand=user($select=email,rolesSnapshot)`,
      `${t(a.ID)}?$expand=quotaProfile`
    ]) {
      const r = await ok(GET(url, LEAD));
      expect([url, r.status]).toEqual([url, 403]);
    }
    const teamsRead = (await GET(`${S}/Teams?$expand=quotaProfile($select=ID,name)`, LEAD)).data.value;
    expect(Object.keys(teamsRead[0].quotaProfile).sort()).toEqual(['ID', 'name']);
    expect(teamsRead[0].quotaProfile.name).toBe('Light');
    const membersRead = (await GET(`${S}/TeamMembers?$orderby=email&$expand=user($select=email,displayName,status,lastSeenAt)`, LEAD)).data.value;
    expect(membersRead.map((m: any) => m.user.email)).toEqual(['tm-lead@test.com', 'tm-member@test.com']);
    // Users is draft-enabled: lean draft adds its IsActiveEntity flag to the expand on its own.
    expect(Object.keys(membersRead[0].user).filter((k) => k !== 'IsActiveEntity').sort()).toEqual(['displayName', 'email', 'lastSeenAt', 'status']);
    const nested = await GET(`${S}/Teams?$expand=members($select=email,role;$expand=user($select=email,displayName))`, LEAD);
    expect(nested.data.value[0].members.length).toBe(2);
    const full = (await GET(`${S}/Teams?$expand=quotaProfile`, ADMIN)).data.value;
    expect(full[0].quotaProfile).toMatchObject({ name: 'Light', tokensPerDay: 500000 });
  });
});

describe('deny-by-default query shapes for team admins (Ruling R8b)', () => {
  it('refuses navigation paths in $select/$filter/lambdas and any $apply; flat reads and the whitelisted expands still answer', async () => {
    const [light] = await cds.db.run(cds.ql.SELECT.from(profiles.PROFILES).where({ name: 'Light' }));
    const a = await createTeam({ name: 'Alpha' });
    expect((await editTeam(a.ID, { quotaProfile_ID: light.ID })).status).toBe(200);
    await teams.addMember(cds.db, a.ID, 'tm-lead@test.com', 'admin');
    for (const url of [
      `${S}/Teams?$select=ID,quotaProfile/tokensPerDay`, `${S}/TeamMembers?$select=email,user/rolesSnapshot`,
      `${S}/TeamMembers?$select=email,user/quotaProfile/tokensPerDay`,
      `${S}/Teams?$apply=aggregate(quotaProfile/tokensPerDay with max as x)`, `${S}/Teams?$apply=groupby((name))`,
      `${S}/TeamMembers?$apply=filter(user/memberships/any(z:z/team/spendPerDay eq 77))/aggregate($count as c)`,
      `${S}/Teams?$filter=quotaProfile/tokensPerDay gt 0`, `${S}/Teams?$orderby=quotaProfile/tokensPerDay`,
      `${S}/TeamMembers?$filter=user/memberships/any(z:z/team/name eq 'x')`,
      `${S}/Teams?$expand=members($filter=user/rolesSnapshot ne null)`,
      `${S}/TeamMembers?$select=email,user/rolesSnapshot,user/tokensPerDay,user/statusReason`, `${S}/TeamMembers?$select=email,user/toolPolicy/mode`,
      `${S}/TeamMembers?$select=email,user/memberships/team/name`, `${S}/TeamMembers?$apply=aggregate(user/rolesSnapshot with max as x)`,
      `${S}/TeamMembers?$apply=aggregate(user/memberships/team/name with max as x)`,
      `${S}/Teams?$apply=groupby((name),aggregate(quotaProfile/tokensPerDay with sum as x))`,
      // a $filter/$orderby/$search inside a whitelisted expand is an oracle on the target's hidden columns
      `${S}/Teams?$expand=quotaProfile($select=ID,name;$filter=tokensPerDay gt 400000)`,
      `${S}/Teams?$expand=quotaProfile($select=ID,name;$filter=tokensPerDay gt 600000)`,
      `${S}/Teams?$expand=quotaProfile($select=ID,name;$filter=400000 lt tokensPerDay)`,
      `${S}/Teams?$expand=quotaProfile($select=ID,name;$orderby=tokensPerDay)`,
      `${S}/TeamMembers?$select=email&$expand=user($select=email;$filter=contains(rolesSnapshot,'user'))`,
      `${S}/TeamMembers?$select=email&$expand=user($select=email;$filter=contains(rolesSnapshot,'zzz'))`,
      `${S}/TeamMembers?$select=email&$expand=user($select=email;$search=user)`
    ]) {
      const r = await ok(GET(url, LEAD));
      expect([url, r.status]).toEqual([url, 403]);
    }
    expect((await GET(`${S}/Teams?$filter=name eq 'Alpha'&$orderby=name&$count=true&$top=5`, LEAD)).data.value.map((x: any) => x.name)).toEqual(['Alpha']);
    expect((await GET(`${S}/Teams?$filter=contains(name,'Alp')`, LEAD)).data.value.length).toBe(1);
    expect((await GET(`${S}/Teams/$count`, LEAD)).data).toBe(1);
    expect((await GET(`${S}/Teams?$expand=quotaProfile($select=ID,name)`, LEAD)).data.value[0].quotaProfile.name).toBe('Light');
    expect((await GET(`${S}/Teams?$expand=quotaProfile($select=ID,name;$filter=name eq 'Light')`, LEAD)).data.value[0].quotaProfile.name).toBe('Light');
    expect((await GET(`${S}/TeamMembers?$expand=user($select=email,displayName,status,lastSeenAt)`, LEAD)).data.value[0].user.email).toBe('tm-lead@test.com');
    expect((await GET(`${S}/Teams?$select=ID,quotaProfile/tokensPerDay`, ADMIN)).status).toBe(200);
  });
});

describe('the Fiori Elements draft list for team admins (Ruling R8c)', () => {
  it('allows SiblingEntity/IsActiveEntity and a DraftAdministrativeData expand; any other SiblingEntity path is refused', async () => {
    const a = await createTeam({ name: 'Alpha' });
    await teams.addMember(cds.db, a.ID, 'tm-lead@test.com', 'admin');
    const list = await ok(GET(`${S}/Teams?$count=true&$filter=(IsActiveEntity eq false or SiblingEntity/IsActiveEntity eq null)&$orderby=name&$select=ID,name,IsActiveEntity,HasActiveEntity,HasDraftEntity&$expand=DraftAdministrativeData($select=DraftUUID,InProcessByUser)&$skip=0&$top=30`, LEAD));
    expect(list.status).toBe(200);
    expect(list.data.value.map((x: any) => x.name)).toEqual(['Alpha']);
    for (const url of [
      `${S}/Teams?$filter=SiblingEntity/name eq 'Alpha'`, `${S}/Teams?$select=ID,SiblingEntity/name`, `${S}/Teams?$orderby=SiblingEntity/description`,
      `${S}/Teams?$filter=SiblingEntity/quotaProfile/tokensPerDay gt 0`, `${S}/Teams?$expand=SiblingEntity($select=ID,name)`
    ]) {
      const r = await ok(GET(url, LEAD));
      expect([url, r.status]).toEqual([url, 403]);
    }
  });
});

describe('what a change costs', () => {
  it('a limits, association or name change invalidates every member and republishes the team; a member-profile change republishes the members; a description edit does neither', async () => {
    const [light] = await cds.db.run(cds.ql.SELECT.from(profiles.PROFILES).where({ name: 'Light' }));
    const team = await createTeam({ name: 'Alpha' });
    await teams.addMember(cds.db, team.ID, 'tm-lead@test.com', 'member');
    await teams.addMember(cds.db, team.ID, 'tm-member@test.com', 'member');
    (cacheInvalidationService.bulkInvalidate as jest.Mock).mockClear(); written.clear();
    expect((await editTeam(team.ID, { description: 'renamed' })).status).toBe(200);
    expect(cacheInvalidationService.bulkInvalidate).not.toHaveBeenCalled();
    expect(written.size).toBe(0);
    expect((await editTeam(team.ID, { name: 'Alpha Prime' })).status).toBe(200);
    expect((cacheInvalidationService.bulkInvalidate as jest.Mock).mock.calls[0][0].map((c: any) => c.credentialId).sort()).toEqual(['sk-lead', 'sk-member']);
    expect(written.has(`quota:team:${team.ID}`)).toBe(true);
    (cacheInvalidationService.bulkInvalidate as jest.Mock).mockClear(); written.clear();
    expect((await editTeam(team.ID, { spendPerMonth: 100 })).status).toBe(200);
    expect((cacheInvalidationService.bulkInvalidate as jest.Mock).mock.calls[0][0].map((c: any) => c.credentialId).sort()).toEqual(['sk-lead', 'sk-member']);
    expect(written.has(`quota:team:${team.ID}`)).toBe(true);
    written.clear();
    expect((await editTeam(team.ID, { memberQuotaProfile_ID: light.ID })).status).toBe(200);
    expect([...written.keys()].filter((k) => k.startsWith('quota:user:')).length).toBe(2);
    const audits = await cds.db.run(cds.ql.SELECT.from(AUDIT).columns('action').where({ resourceId: team.ID }).orderBy('createdAt'));
    expect(audits.map((a: any) => a.action)).toEqual(['team.create', 'team.update', 'team.update', 'team.update', 'team.update']);
  });
});

describe('delete', () => {
  it('refuses a team with members, naming them; deletes an empty team and drops its document', async () => {
    const team = await createTeam({ name: 'Alpha' });
    await teams.addMember(cds.db, team.ID, 'tm-lead@test.com', 'member');
    const refused = await ok(DELETE(t(team.ID), ADMIN));
    expect(refused.status).toBe(409); expect(message(refused)).toMatch(/tm-lead@test.com/);
    await teams.removeMember(cds.db, team.ID, 'tm-lead@test.com');
    expect((await ok(DELETE(t(team.ID), LEAD))).status).toBe(403);
    expect((await DELETE(t(team.ID), ADMIN)).status).toBe(204);
    expect(written.has(`quota:team:${team.ID}`)).toBe(false);
    expect(await lookups.getTeam(cds.db, team.ID)).toBeNull();
  });
});

describe('membership actions', () => {
  it('a platform admin or a team admin adds, promotes, demotes, moves the primary and removes; a member cannot; unknown users are refused for team admins', async () => {
    const team = await createTeam({ name: 'Alpha' });
    const beta = await createTeam({ name: 'Beta' });
    expect((await POST(`${t(team.ID)}/AdminService.addMember`, { email: 'tm-lead@test.com', role: 'admin' }, ADMIN)).data.memberCount).toBe(1);
    expect((cacheInvalidationService.bulkInvalidate as jest.Mock).mock.calls.at(-1)[0].map((c: any) => c.credentialId)).toEqual(['sk-lead']);
    expect(written.has(`quota:user:${require('crypto').createHash('sha256').update('tm-lead@test.com').digest('hex')}`)).toBe(true);
    expect((await POST(`${t(team.ID)}/AdminService.addMember`, { email: 'tm-member@test.com', role: 'member' }, LEAD)).data.memberCount).toBe(2);
    expect((await ok(POST(`${t(team.ID)}/AdminService.addMember`, { email: 'tm-other@test.com', role: 'member' }, MEMBER))).status).toBe(403);
    expect((await ok(POST(`${t(team.ID)}/AdminService.addMember`, { email: 'tm-member@test.com', role: 'member' }, LEAD))).status).toBe(409);
    expect((await ok(POST(`${t(team.ID)}/AdminService.addMember`, { email: 'unknown@test.com', role: 'member' }, LEAD))).status).toBe(404);
    expect((await POST(`${t(team.ID)}/AdminService.addMember`, { email: 'brand-new@test.com', role: 'member' }, ADMIN)).status).toBe(200);
    expect(await users.getUser(cds.db, 'brand-new@test.com')).not.toBeNull();
    await POST(`${t(team.ID)}/AdminService.setMemberRole`, { email: 'tm-member@test.com', role: 'admin' }, LEAD);
    expect((await lookups.membershipOf(cds.db, team.ID, 'tm-member@test.com'))?.role).toBe('admin');
    await POST(`${t(beta.ID)}/AdminService.addMember`, { email: 'tm-member@test.com', role: 'member' }, ADMIN);
    await POST(`${t(beta.ID)}/AdminService.setPrimary`, { email: 'tm-member@test.com' }, ADMIN);
    expect((await lookups.primaryTeamOf(cds.db, 'tm-member@test.com'))?.ID).toBe(beta.ID);
    expect((await POST(`${t(team.ID)}/AdminService.removeMember`, { email: 'tm-member@test.com' }, LEAD)).data.memberCount).toBe(2);
    const audits = (await cds.db.run(cds.ql.SELECT.from(AUDIT).columns('action').where({ resourceType: 'Team' }))).map((a: any) => a.action);
    expect(audits).toEqual(expect.arrayContaining(['team.member_added', 'team.member_role_changed', 'team.primary_changed', 'team.member_removed']));
  });
});

describe('myTeams, candidates and status', () => {
  it('myTeams lists the caller\'s memberships with the pool; candidates exclude members and service keys; teamQuotaStatus is admin-only', async () => {
    const team = await createTeam({ name: 'Alpha', spendPerMonth: 50 });
    await teams.addMember(cds.db, team.ID, 'tm-lead@test.com', 'admin');
    const mine = (await GET(`${S}/myTeams()`, LEAD)).data.value;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ teamId: team.ID, name: 'Alpha', role: 'admin', isPrimary: true });
    expect(mine[0].pool).toMatchObject({ name: 'Alpha', sapCostCurrency: 'USD' });
    expect(Number(mine[0].pool.limits.spendPerMonth)).toBe(50);
    expect((await GET(`${S}/myTeams()`, OTHER)).data.value).toEqual([]);
    await cds.db.run(cds.ql.INSERT.into(users.USERS).entries({ email: 'admin2gateway.service.key', status: 'active' }));
    const candidates = (await GET(`${S}/teamMemberCandidates(teamId=${team.ID})`, LEAD)).data.value.map((c: any) => c.email);
    expect(candidates).toEqual(['tm-admin@test.com', 'tm-member@test.com', 'tm-other@test.com']);
    expect((await ok(GET(`${S}/teamMemberCandidates(teamId=${team.ID})`, MEMBER))).status).toBe(403);
    expect((await GET(`${S}/teamQuotaStatus(teamId=${team.ID})`, ADMIN)).data).toMatchObject({ teamId: team.ID, limitSource: { spendPerMonth: 'team' } });
    expect((await ok(GET(`${S}/teamQuotaStatus(teamId=${team.ID})`, LEAD))).status).toBe(403);
  });
});

describe('credential binding and creation', () => {
  it('owners and admins bind a credential to one of the owner\'s teams; null follows the primary; non-members are refused; createApiKey takes a teamId', async () => {
    const a = await createTeam({ name: 'Alpha' }); const b = await createTeam({ name: 'Beta' });
    await teams.addMember(cds.db, a.ID, 'tm-lead@test.com', 'member');
    await teams.addMember(cds.db, b.ID, 'tm-lead@test.com', 'member');
    expect((await POST(`${S}/setApiKeyTeam`, { keyId: 'k-lead', teamId: b.ID }, LEAD)).data.team_ID).toBe(b.ID);
    expect((cacheInvalidationService.bulkInvalidate as jest.Mock).mock.calls.at(-1)[0].map((c: any) => c.credentialId)).toEqual(['sk-lead']);
    expect((await ok(POST(`${S}/setApiKeyTeam`, { keyId: 'k-lead', teamId: a.ID }, MEMBER))).status).toBe(403);
    expect((await ok(POST(`${S}/setApiKeyTeam`, { keyId: 'k-member', teamId: a.ID }, ADMIN))).status).toBe(400);
    expect((await POST(`${S}/setApiKeyTeam`, { keyId: 'k-lead', teamId: null }, ADMIN)).data.team_ID).toBeNull();
    const created = await POST(`${S}/createApiKey`, { name: 'bound', email: 'tm-lead@test.com', teamId: a.ID }, LEAD);
    expect(created.status).toBe(200);
    expect((await cds.db.run(cds.ql.SELECT.one.from(KEYS).columns('team_ID').where({ ID: created.data.id }))).team_ID).toBe(a.ID);
    const refused = await ok(POST(`${S}/createApiKey`, { name: 'bad', email: 'tm-member@test.com', teamId: a.ID }, ADMIN));
    expect(refused.status).toBe(400);
  });
});

describe('resets and the team-admin flag', () => {
  it('resetQuota (bound, admin) and resetTeamQuotas move the watermark and drop the buckets; whoami reports isTeamAdmin', async () => {
    const team = await createTeam({ name: 'Alpha' });
    await teams.addMember(cds.db, team.ID, 'tm-lead@test.com', 'admin');
    const r = await POST(`${t(team.ID)}/AdminService.resetQuota`, {}, ADMIN);
    expect(r.data).toMatchObject({ teamId: team.ID, ok: true });
    expect((await ok(POST(`${t(team.ID)}/AdminService.resetQuota`, {}, LEAD))).status).toBe(403);
    expect((await POST(`${S}/resetTeamQuotas`, { teamIds: [team.ID, 'missing'] }, ADMIN)).data.value.map((x: any) => x.ok)).toEqual([true, false]);
    expect((await POST(`${S}/whoami`, {}, LEAD)).data.isTeamAdmin).toBe(true);
    expect((await POST(`${S}/whoami`, {}, MEMBER)).data.isTeamAdmin).toBe(false);
    expect((await POST(`${S}/getCurrentUserPreferences`, {}, LEAD)).data.isTeamAdmin).toBe(true);
  });
});

describe('credential and usage rows carry the team ID only (Ruling R9)', () => {
  it('a plain user cannot navigate into Teams from a credential or a usage row; $select=team_ID answers for their own rows', async () => {
    const a = await createTeam({ name: 'Alpha', spendPerDay: 7 });
    await teams.addMember(cds.db, a.ID, 'tm-lead@test.com', 'member');
    const now = new Date(Date.now() - 60000).toISOString(); const until = '9999-12-31T00:00:00.000Z';   // temporal: only rows valid now are read
    await cds.db.run(cds.ql.INSERT.into('sap.llm.gateway.admin.AwsCredentials').entries({ ID: 'c-lead', accessKeyId: 'AKIATEAMSPROBE01', secretAccessKey: 'x', secretHash: 'h', salt: 's', userId: 'tm-lead@test.com', email: 'tm-lead@test.com', name: 'aws', isActive: true, team_ID: a.ID }));
    await cds.db.run(cds.ql.INSERT.into('sap.llm.gateway.admin.ApiKeyUsage').entries({ ID: 'u-key', apiKey_ID: 'k-lead', email: 'tm-lead@test.com', team_ID: a.ID, teamName: 'Alpha', validFrom: now, validTo: until }));
    await cds.db.run(cds.ql.INSERT.into('sap.llm.gateway.admin.AwsCredentialUsage').entries({ ID: 'u-aws', credential_ID: 'c-lead', team_ID: a.ID, teamName: 'Alpha', validFrom: now, validTo: until }));
    await cds.db.run(cds.ql.UPDATE(KEYS).set({ team_ID: a.ID }).where({ ID: 'k-lead' }));
    for (const set of ['ApiKeys', 'ActiveApiKeys', 'AwsCredentials', 'ActiveAwsCredentials', 'ExpiredAwsCredentials', 'ApiKeyUsage', 'AwsCredentialUsage']) {
      expect([set, (await ok(GET(`${S}/${set}?$select=ID&$expand=team`, LEAD))).status]).toEqual([set, 400]);
    }
    expect((await ok(GET(`${S}/AwsCredentials?$select=ID&$expand=team($expand=members($expand=user))`, LEAD))).status).toBe(400);
    expect((await GET(`${S}/AwsCredentials?$select=ID,team_ID`, LEAD)).data.value).toEqual([expect.objectContaining({ ID: 'c-lead', team_ID: a.ID })]);
    expect((await GET(`${S}/ApiKeys?$select=ID,team_ID`, LEAD)).data.value).toEqual([expect.objectContaining({ ID: 'k-lead', team_ID: a.ID })]);
    expect((await GET(`${S}/ApiKeyUsage?$select=ID,team_ID,teamName&$filter=email eq 'tm-lead@test.com'`, LEAD)).data.value).toEqual([expect.objectContaining({ ID: 'u-key', team_ID: a.ID, teamName: 'Alpha' })]);
    expect((await GET(`${S}/AwsCredentialUsage?$select=ID,team_ID,teamName`, LEAD)).data.value).toEqual([expect.objectContaining({ ID: 'u-aws', team_ID: a.ID, teamName: 'Alpha' })]);
  });
});

describe('a credential row shows its tool policy by name only (Ruling R9b)', () => {
  it('a plain user cannot walk from toolPolicy on to the teams or the users of the policy; toolPolicy/name still answers', async () => {
    const pol = 'a0000000-0000-4000-8000-000000000001';
    await cds.db.run(cds.ql.INSERT.into('sap.llm.gateway.admin.ToolPolicies').entries({ ID: pol, name: 'Shared', mode: 'monitor' }));
    const secret = await createTeam({ name: 'Secret', spendPerDay: 7 });
    await cds.db.run(cds.ql.UPDATE(lookups.TEAMS).set({ toolPolicy_ID: pol }).where({ ID: secret.ID }));
    await teams.addMember(cds.db, secret.ID, 'tm-member@test.com', 'admin');
    await cds.db.run(cds.ql.UPDATE(users.USERS).set({ toolPolicy_ID: pol }).where({ email: 'tm-member@test.com' }));
    await cds.db.run(cds.ql.UPDATE(KEYS).set({ toolPolicy_ID: pol }).where({ ID: 'k-lead' }));
    await cds.db.run(cds.ql.INSERT.into('sap.llm.gateway.admin.RateLimits').entries({ ID: 'rl-lead', apiKey_ID: 'k-lead', requestsPerMinute: 60 }));
    for (const u of [
      `${S}/ApiKeys?$select=ID&$expand=toolPolicy($expand=assignedTeams)`,
      `${S}/ActiveApiKeys?$select=ID&$expand=toolPolicy($expand=assignedTeams)`,
      `${S}/ApiKeys?$select=ID&$expand=toolPolicy($expand=assignedUsersList($expand=memberships($expand=team)))`,
      `${S}/RateLimits?$select=ID&$expand=apiKey($select=ID;$expand=toolPolicy($expand=assignedTeams))`,
      `${S}/ApiKeys?$select=ID&$expand=toolPolicy($select=description)`
    ]) expect([u, (await ok(GET(u, LEAD))).status]).toEqual([u, 400]);
    expect((await GET(`${S}/ApiKeys?$select=ID&$expand=toolPolicy($select=name)`, LEAD)).data.value).toEqual([expect.objectContaining({ ID: 'k-lead', toolPolicy: expect.objectContaining({ name: 'Shared' }) })]);
    expect((await GET(`${S}/ApiKeys?$select=ID,name&$expand=toolPolicy($select=ID,name)&$filter=toolPolicy_ID eq ${pol}`, ADMIN)).data.value).toEqual([expect.objectContaining({ ID: 'k-lead', toolPolicy: { ID: pol, name: 'Shared' } })]);
    expect((await ok(GET(`${S}/ToolPolicyNames`, LEAD))).status).toBe(403);
  });
});

describe('rebuildUsageCounters republishes team documents', () => {
  it('the unscoped rebuild writes every team document; a scoped one does not', async () => {
    const team = await createTeam({ name: 'Rebuild', spendPerDay: 3 });
    written.clear();
    expect((await POST(`${S}/rebuildUsageCounters`, { emails: ['tm-lead@test.com'] }, ADMIN)).status).toBe(200);
    expect(written.has(`quota:team:${team.ID}`)).toBe(false);
    expect((await POST(`${S}/rebuildUsageCounters`, { emails: [] }, ADMIN)).status).toBe(200);
    expect(written.has(`quota:team:${team.ID}`)).toBe(true);
  });
});

describe('carried Part A findings', () => {
  it('a team draft PATCH that carries members is refused (members change only through the actions)', async () => {
    const a = await createTeam({ name: 'Alpha' });
    const r = await editTeam(a.ID, { members: [{ email: 'tm-other@test.com', role: 'member' }] });
    expect(r.status).toBe(400);
    expect(message(r)).toMatch(/members/);
    expect(await lookups.memberEmails(cds.db, a.ID)).toEqual([]);
  });

  it('a user reads the security events of their own AWS credential only; an admin reads all', async () => {
    const { INSERT } = cds.ql;
    await cds.db.run(INSERT.into('sap.llm.gateway.admin.AwsCredentials').entries([
      { ID: '5ec00000-0000-4000-8000-00000000000a', accessKeyId: 'AKIASECPROBE0001', secretAccessKey: 'x', secretHash: 'h', salt: 's', userId: 'tm-lead@test.com', email: 'tm-lead@test.com', name: 'aws-lead', isActive: true },
      { ID: '5ec00000-0000-4000-8000-00000000000b', accessKeyId: 'AKIASECPROBE0002', secretAccessKey: 'x', secretHash: 'h', salt: 's', userId: 'tm-other@test.com', email: 'tm-other@test.com', name: 'aws-other', isActive: true }]));
    await cds.db.run(INSERT.into('sap.llm.gateway.admin.AwsCredentialSecurityEvents').entries([
      { ID: '5ec00000-0000-4000-8000-0000000000e1', credential_ID: '5ec00000-0000-4000-8000-00000000000a', eventType: 'failed_auth', severity: 'medium' },
      { ID: '5ec00000-0000-4000-8000-0000000000e2', credential_ID: '5ec00000-0000-4000-8000-00000000000b', eventType: 'failed_auth', severity: 'medium' }]));
    expect((await GET(`${S}/AwsCredentialSecurityEvents?$select=ID`, LEAD)).data.value.map((e: any) => e.ID)).toEqual(['5ec00000-0000-4000-8000-0000000000e1']);
    expect((await GET(`${S}/AwsCredentials(ID=5ec00000-0000-4000-8000-00000000000a,IsActiveEntity=true)?$select=ID&$expand=securityEvents($select=ID)`, LEAD)).data.securityEvents.map((e: any) => e.ID)).toEqual(['5ec00000-0000-4000-8000-0000000000e1']);
    expect((await ok(GET(`${S}/AwsCredentialSecurityEvents(ID=5ec00000-0000-4000-8000-0000000000e2,IsActiveEntity=true)`, LEAD))).status).toBe(404);
    expect((await GET(`${S}/AwsCredentialSecurityEvents?$select=ID&$orderby=ID`, ADMIN)).data.value.map((e: any) => e.ID)).toEqual(expect.arrayContaining(['5ec00000-0000-4000-8000-0000000000e1', '5ec00000-0000-4000-8000-0000000000e2']));
  });
});
