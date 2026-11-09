// services/admin/test/integration/http/teams-part-b-odata.test.ts
/**
 * Teams Part B over OData: the credential pages, the read-only team views, team admins and the analytics scope.
 * Mocked users; the cache invalidation and the quota store are mocked so their calls can be asserted.
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

jest.mock('../../../src/services/groundingGatewayClient', () => ({
  ...jest.requireActual('../../../src/services/groundingGatewayClient'),
  callGateway: jest.fn(async () => ({ status: 200, headers: {}, data: { deleted: 0 } }))
}));

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
const AWS = 'sap.llm.gateway.admin.AwsCredentials';
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
  for (const tbl of [lookups.MEMBERS, lookups.TEAMS, AUDIT, KEYS, AWS, users.USERS, profiles.PROFILES]) await cds.db.run(DEL.from(tbl));
  try { await cds.db.run(DEL.from('AdminService.Teams.drafts')); } catch { /* no draft table */ }
  await cds.db.run(INSERT.into(KEYS).entries([{ ID: 'k-lead', key: 'sk-lead', name: 'lead', email: 'tm-lead@test.com', isActive: true }, { ID: 'k-member', key: 'sk-member', name: 'member', email: 'tm-member@test.com', isActive: true }]));
  await cds.db.run(INSERT.into(AWS).entries({ ID: 'c-lead', accessKeyId: 'AKIALEAD0000000000', secretHash: 'h', salt: 's', name: 'lead-aws', email: 'tm-lead@test.com', userId: 'tm-lead@test.com', isActive: true }));
  for (const e of ['tm-admin@test.com', 'tm-lead@test.com', 'tm-member@test.com', 'tm-other@test.com']) await users.touch(cds.db, e, { roles: ['user'] });
  await profiles.ensureStarterProfiles(cds.db);
  (cacheInvalidationService.bulkInvalidate as jest.Mock).mockClear();
});

const keysOf = async (who: any, name: string) => (await GET(`${S}/ApiKeys?$select=ID,effectiveTeamName,followsPrimaryTeam&$filter=${encodeURIComponent(`IsActiveEntity eq true and name eq '${name}'`)}`, who)).data.value[0];

describe('the credential pages (Part B Task 3)', () => {
  it('a key reads its effective team: the bound one, else the owner primary, else none - also when $select omits email and team_ID', async () => {
    const a = await createTeam({ name: 'Alpha' }); const b = await createTeam({ name: 'Beta' });
    await teams.addMember(cds.db, a.ID, 'tm-lead@test.com', 'member');   // first membership: primary
    await teams.addMember(cds.db, b.ID, 'tm-lead@test.com', 'member');
    expect(await keysOf(LEAD, 'lead')).toMatchObject({ effectiveTeamName: 'Alpha', followsPrimaryTeam: true });
    await POST(`${S}/setApiKeyTeam`, { keyId: 'k-lead', teamId: b.ID }, LEAD);
    expect(await keysOf(LEAD, 'lead')).toMatchObject({ effectiveTeamName: 'Beta', followsPrimaryTeam: false });
    expect(await keysOf(MEMBER, 'member')).toMatchObject({ effectiveTeamName: null, followsPrimaryTeam: null });
  });

  it('an AWS credential reads its effective team; setAwsCredentialTeam binds and clears it; createAwsCredentials takes a teamId', async () => {
    const a = await createTeam({ name: 'Alpha' }); const b = await createTeam({ name: 'Beta' });
    await teams.addMember(cds.db, a.ID, 'tm-lead@test.com', 'member');
    await teams.addMember(cds.db, b.ID, 'tm-lead@test.com', 'member');
    const aws = async () => (await GET(`${S}/AwsCredentials?$select=ID,effectiveTeamName,followsPrimaryTeam&$filter=${encodeURIComponent("name eq 'lead-aws'")}`, LEAD)).data.value[0];
    expect(await aws()).toMatchObject({ effectiveTeamName: 'Alpha', followsPrimaryTeam: true });
    expect((await POST(`${S}/setAwsCredentialTeam`, { credentialId: 'c-lead', teamId: b.ID }, LEAD)).data.team_ID).toBe(b.ID);
    expect(await aws()).toMatchObject({ effectiveTeamName: 'Beta', followsPrimaryTeam: false });
    expect((await ok(POST(`${S}/setAwsCredentialTeam`, { credentialId: 'c-lead', teamId: b.ID }, MEMBER))).status).toBe(403);
    expect((await POST(`${S}/setAwsCredentialTeam`, { credentialId: 'c-lead', teamId: null }, ADMIN)).data.team_ID).toBeNull();
    const created = await POST(`${S}/createAwsCredentials`, { userId: 'tm-lead@test.com', email: 'tm-lead@test.com', name: 'bound-aws', description: 'x', permissions: [], teamId: b.ID }, ADMIN);
    expect(created.status).toBe(200);
    expect((await cds.db.run(cds.ql.SELECT.one.from(AWS).columns('team_ID').where({ ID: created.data.id }))).team_ID).toBe(b.ID);
  });

  it('credentialTeamChoices lists the owner teams to the owner and to admins, refuses anyone else, and is empty without a team', async () => {
    const a = await createTeam({ name: 'Alpha' }); const b = await createTeam({ name: 'Beta' });
    await teams.addMember(cds.db, b.ID, 'tm-lead@test.com', 'member');   // Beta first: primary
    await teams.addMember(cds.db, a.ID, 'tm-lead@test.com', 'member');
    const own = await GET(`${S}/credentialTeamChoices(email='tm-lead@test.com')`, LEAD);
    expect(own.data.value).toEqual([{ teamId: a.ID, name: 'Alpha', isPrimary: false }, { teamId: b.ID, name: 'Beta', isPrimary: true }]);
    expect((await GET(`${S}/credentialTeamChoices(email='tm-lead@test.com')`, ADMIN)).data.value).toHaveLength(2);
    expect((await ok(GET(`${S}/credentialTeamChoices(email='tm-lead@test.com')`, MEMBER))).status).toBe(403);
    expect((await GET(`${S}/credentialTeamChoices(email='tm-other@test.com')`, OTHER)).data.value).toEqual([]);
  });
});

describe('read-only team views (Part B Task 5)', () => {
  it('a quota profile counts the distinct teams using it as pool or member profile', async () => {
    const light = (await cds.db.run(cds.ql.SELECT.one.from(profiles.PROFILES).where({ name: 'Light' }))).ID;
    await createTeam({ name: 'Alpha', quotaProfile_ID: light, memberQuotaProfile_ID: light });   // counts once
    await createTeam({ name: 'Beta', memberQuotaProfile_ID: light });
    await createTeam({ name: 'Gamma' });
    const rows = (await GET(`${S}/QuotaProfiles?$select=ID,name,assignedUsers,assignedTeams`, ADMIN)).data.value;
    expect(rows.find((r: any) => r.ID === light).assignedTeams).toBe(2);
    expect(rows.filter((r: any) => r.ID !== light).every((r: any) => r.assignedTeams === 0)).toBe(true);
  });

  it('admins read a user\'s memberships with the team name, a policy\'s teams, and the teams of a catalog', async () => {
    const a = await createTeam({ name: 'Alpha' });
    await teams.addMember(cds.db, a.ID, 'tm-lead@test.com', 'admin');
    const u = await GET(`${S}/Users?$filter=${encodeURIComponent("email eq 'tm-lead@test.com' and IsActiveEntity eq true")}&$expand=memberships($select=role,isPrimary;$expand=team($select=name))`, ADMIN);
    expect(u.data.value[0].memberships).toEqual([expect.objectContaining({ role: 'admin', isPrimary: true, team: expect.objectContaining({ name: 'Alpha' }) })]);

    const policy = await POST(`${S}/ToolPolicies`, { name: 'Strict', mode: 'reject' }, ADMIN);
    await POST(`${S}/ToolPolicies(ID=${policy.data.ID},IsActiveEntity=false)/AdminService.draftActivate`, {}, ADMIN);
    await editTeam(a.ID, { toolPolicy_ID: policy.data.ID });
    const p = await GET(`${S}/ToolPolicies(ID=${policy.data.ID},IsActiveEntity=true)?$expand=assignedTeams($select=ID,name)`, ADMIN);
    expect(p.data.assignedTeams.map((x: any) => x.name)).toEqual(['Alpha']);

    const catalogId = cds.utils.uuid();
    await cds.db.run(cds.ql.INSERT.into('sap.llm.gateway.admin.ModelCatalogs').entries({ ID: catalogId, name: 'Team catalog', isDefault: false }));
    await editTeam(a.ID, { entitlementCatalog_ID: catalogId });
    const c = await GET(`${S}/Teams?$select=ID,name&$filter=${encodeURIComponent(`entitlementCatalog_ID eq ${catalogId} and IsActiveEntity eq true`)}`, ADMIN);
    expect(c.data.value.map((x: any) => x.name)).toEqual(['Alpha']);
  });
});

describe('team admins in the Teams app (Part B Task 7)', () => {
  it('TeamPermissions hides Create and Delete for everyone but platform admins', async () => {
    expect((await GET(`${S}/TeamPermissions`, ADMIN)).data).toMatchObject({ createHidden: false, deleteHidden: false });
    expect((await GET(`${S}/TeamPermissions`, LEAD)).data).toMatchObject({ createHidden: true, deleteHidden: true });
    expect((await GET(`${S}/TeamPermissions`, MEMBER)).data).toMatchObject({ createHidden: true, deleteHidden: true });
  });

  it('canResetQuota holds for a platform admin on a saved team only - never on a draft that was never saved', async () => {
    const a = await createTeam({ name: 'Alpha' });
    await teams.addMember(cds.db, a.ID, 'tm-lead@test.com', 'admin');
    expect((await GET(`${t(a.ID)}?$select=ID,canResetQuota`, ADMIN)).data.canResetQuota).toBe(true);
    expect((await GET(`${t(a.ID)}?$select=ID,canResetQuota`, LEAD)).data.canResetQuota).toBe(false);
    const draft = await POST(`${S}/Teams`, { name: 'Unsaved' }, ADMIN);
    expect(draft.data.canResetQuota).toBe(false);
    expect((await GET(`${t(draft.data.ID, false)}?$select=ID,canResetQuota`, ADMIN)).data.canResetQuota).toBe(false);
  });
});

describe('the usage statistics team scope (Part B Task 9)', () => {
  const USAGE = 'sap.llm.gateway.admin.ApiKeyUsage';
  const AWS_USAGE = 'sap.llm.gateway.admin.AwsCredentialUsage';
  const row = (email: string, team: string | null, tokens: number) => ({
    apiKey_ID: email === 'tm-lead@test.com' ? 'k-lead' : 'k-member', email, team_ID: team, teamName: team ? 'Alpha' : null,
    validFrom: '2026-10-10T10:00:00Z', validTo: '9999-12-31T00:00:00.000Z', provider: 'openai', model: 'm', endpoint: '/v1/chat', statusCode: 200,
    inputTokens: tokens, outputTokens: 0, totalTokens: tokens, usageSignature: `${email}-${team}-${tokens}`
  });
  const stats = (who: any, teamId?: string) => ok(GET(`${S}/getUsageStatistics(startDate=2026-10-01,endDate=2026-10-31,granularity='day'${teamId ? `,teamId=${teamId}` : ''})`, who));
  const total = (r: any) => r.data.emailUsage.reduce((s: number, e: any) => s + Number(e.totalTokens), 0);
  const sum = (rows: any[]) => rows.reduce((s: number, e: any) => s + Number(e.totalTokens), 0);

  it('an admin of the team sees every member\'s rows of that team, nothing else; a plain member and an outsider are refused', async () => {
    await cds.db.run(cds.ql.DELETE.from(USAGE));
    const a = await createTeam({ name: 'Alpha' }); const b = await createTeam({ name: 'Beta' });
    await teams.addMember(cds.db, a.ID, 'tm-lead@test.com', 'admin');
    await teams.addMember(cds.db, a.ID, 'tm-member@test.com', 'member');
    await teams.addMember(cds.db, b.ID, 'tm-lead@test.com', 'member');
    await cds.db.run(cds.ql.INSERT.into(USAGE).entries([row('tm-member@test.com', a.ID, 10), row('tm-member@test.com', null, 20), row('tm-lead@test.com', a.ID, 30)]));

    const scoped = await stats(LEAD, a.ID);
    expect(scoped.status).toBe(200);
    expect(total(scoped)).toBe(40);
    expect(scoped.data.emailUsage.map((e: any) => e.email).sort()).toEqual(['tm-lead@test.com', 'tm-member@test.com']);
    expect(scoped.data.teamUsage.map((x: any) => x.teamId)).toEqual([a.ID]);
    expect(sum(scoped.data.apiKeyUsage)).toBe(40);
    expect(sum(scoped.data.endpointUsage)).toBe(40);
    expect(sum(scoped.data.modelUsage)).toBe(40);
    expect((await stats(LEAD, b.ID)).status).toBe(403);    // a plain member of Beta
    expect((await stats(MEMBER, a.ID)).status).toBe(403);
    expect((await stats(OTHER, a.ID)).status).toBe(403);
    expect(total(await stats(ADMIN, a.ID))).toBe(40);
    expect(total(await stats(ADMIN))).toBe(60);            // unscoped admin: unchanged
    expect(total(await stats(LEAD))).toBe(30);             // unscoped user: own rows, unchanged
  });

  it('a non-admin without teamId sees only their own rows in every breakdown', async () => {
    await cds.db.run(cds.ql.DELETE.from(USAGE)); await cds.db.run(cds.ql.DELETE.from(AWS_USAGE));
    await cds.db.run(cds.ql.INSERT.into(USAGE).entries([row('tm-member@test.com', null, 10), row('tm-lead@test.com', null, 30)]));
    const r = await stats(MEMBER);
    expect(r.status).toBe(200);
    for (const k of ['apiKeyUsage', 'emailUsage', 'endpointUsage', 'modelUsage']) expect([k, sum(r.data[k])]).toEqual([k, 10]);
    expect(r.data.emailUsage.map((e: any) => e.email)).toEqual(['tm-member@test.com']);
    expect(r.data.teamUsage.reduce((s: number, x: any) => s + Number(x.totalTokens), 0)).toBe(10);
    expect(sum((await stats(ADMIN)).data.modelUsage)).toBe(40);
  });
});

describe('team deletion cleans up its store shares (Part B Task 13)', () => {
  it('calls DELETE /admin/teams/<id>/shares after the delete commits', async () => {
    const { callGateway } = require('../../../src/services/groundingGatewayClient');
    const a = await createTeam({ name: 'Doomed' });
    expect((await DELETE(t(a.ID), ADMIN)).status).toBe(204);
    await new Promise((r) => setImmediate(r));
    expect(callGateway).toHaveBeenCalledWith(expect.objectContaining({ role: 'admin' }), 'delete', `/admin/teams/${a.ID}/shares`);
  });
});
