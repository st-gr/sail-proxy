/**
 * Quota profiles over OData (spec 2026-09-08) end to end on cds.test(): admin-only CRUD with the
 * window-order check and a unique, trimmed name; assignQuotaProfile/unassignQuotaProfile as the
 * ONLY write path for Users.quotaProfile_ID (cds drops the read-only field from a draft PATCH
 * before any handler runs — the users-app annotates it Common.FieldControl: #ReadOnly — so the
 * association can only move through the two actions), each audited and each
 * republishing the user's quota document and invalidating the credential cache; the 409 that
 * guards a profile while it is assigned; and the republish + invalidation an edit costs every
 * assignee.
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'uq-admin@test.com': { id: 'uq-admin@test.com', roles: ['admin', 'user'] },
  'uq-user@test.com': { id: 'uq-user@test.com', roles: ['user'] } } };
jest.mock('../../../src/services/cacheInvalidationService', () => ({
  cacheInvalidationService: { bulkInvalidate: jest.fn(), invalidatePattern: jest.fn(), invalidateApiKey: jest.fn(), invalidateAwsCredential: jest.fn() }, default: {} }));
jest.mock('../../../src/services/quotaStateStore', () => ({
  ...jest.requireActual('../../../src/services/quotaStateStore'),
  quotaStateStore: { initialize: jest.fn(), available: () => false, setJson: jest.fn(async () => false), getJson: jest.fn(async () => null), getNumber: jest.fn(async () => 0), shutdown: jest.fn() } }));

const { GET, POST, PATCH, DELETE } = cds.test(path.resolve(__dirname, '../../..'));
import * as users from '../../../src/services/usersService';

// The handlers run through cds' own require of src/srv/*.ts, which resolves to the same jest module
// registry entries these two mocks replaced - so the calls asserted below are the handlers' own.
const { cacheInvalidationService } = require('../../../src/services/cacheInvalidationService');
const { quotaStateStore, quotaKeyFor } = require('../../../src/services/quotaStateStore');

const ADMIN = { auth: { username: 'uq-admin@test.com', password: 'x' } };
const USER = { auth: { username: 'uq-user@test.com', password: 'x' } };
const ok = (p: Promise<any>) => p.catch((e: any) => e.response);
const S = '/odata/v4/admin';
const USERS = 'sap.llm.gateway.admin.Users';
const KEYS = 'sap.llm.gateway.admin.ApiKeys';
const AUDIT = 'sap.llm.gateway.admin.AuditEvents';
const PROFILES = 'sap.llm.gateway.admin.QuotaProfiles';
const u = (email: string) => `${S}/Users(email='${encodeURIComponent(email)}',IsActiveEntity=true)`;
const ud = (email: string) => `${S}/Users(email='${encodeURIComponent(email)}',IsActiveEntity=false)`;
const message = (r: any): string => String(r?.data?.error?.message ?? r?.data?.message ?? '');

beforeEach(async () => {
  const { DELETE: DEL, INSERT } = cds.ql;
  // Users before QuotaProfiles: the assignment lives on the Users row.
  for (const t of [AUDIT, USERS, KEYS, PROFILES]) await cds.db.run(DEL.from(t));
  try { await cds.db.run(DEL.from('AdminService.Users.drafts')); } catch { /* no draft table */ }
  await cds.db.run(INSERT.into(KEYS).entries({ ID: 'k-qp', key: 'sk-qp-user', name: 'qp', email: 'uq-user@test.com', isActive: true }));
  await users.touch(cds.db, 'uq-admin@test.com', { roles: ['admin', 'user'] });
  await users.touch(cds.db, 'uq-user@test.com', { roles: ['user'] });
  (cacheInvalidationService.bulkInvalidate as jest.Mock).mockClear();
  (quotaStateStore.setJson as jest.Mock).mockClear();
});

describe('QuotaProfiles', () => {
  it('admin CRUD; a user gets 403; names are unique; the window order is enforced', async () => {
    const created = await POST(`${S}/QuotaProfiles`, { name: 'Team A', tokensPerDay: 1000, tokensPerWeek: 5000 }, ADMIN);
    expect(created.status).toBe(201);
    expect((await ok(GET(`${S}/QuotaProfiles`, USER))).status).toBe(403);
    expect((await ok(POST(`${S}/QuotaProfiles`, { name: 'Team A' }, ADMIN))).status).toBe(400);
    const bad = await ok(PATCH(`${S}/QuotaProfiles(${created.data.ID})`, { tokensPerDay: 9000 }, ADMIN));   // day > week
    expect(bad.status).toBe(400); expect(message(bad)).toMatch(/tokensPerDay.*tokensPerWeek/);
    expect((await PATCH(`${S}/QuotaProfiles(${created.data.ID})`, { tokensPerDay: 2000 }, ADMIN)).status).toBe(200);
    // the name is trimmed on the way in, and required on CREATE
    const trimmed = await POST(`${S}/QuotaProfiles`, { name: '  Team B  ' }, ADMIN);
    expect(trimmed.data.name).toBe('Team B');
    expect((await ok(POST(`${S}/QuotaProfiles`, { name: '   ' }, ADMIN))).status).toBe(400);
  });

  it('assign and unassign write the association, audit, and are the only write path', async () => {
    const p = (await POST(`${S}/QuotaProfiles`, { name: 'P', spendPerDay: 5 }, ADMIN)).data;
    const assigned = await POST(`${S}/assignQuotaProfile`, { email: 'uq-user@test.com', profileId: p.ID }, ADMIN);
    expect(assigned.data).toMatchObject({ email: 'uq-user@test.com', quotaProfile_ID: p.ID, quotaProfileName: 'P', limitSourceSpendPerDay: 'profile', spendPerDayDefaultText: '5.00 USD (P profile)' });
    expect(Number(assigned.data.effectiveSpendPerDay)).toBe(5);
    // the user's quota document is rewritten with the profile's limit, and their credentials forgotten
    expect(quotaStateStore.setJson).toHaveBeenCalledWith(quotaKeyFor('uq-user@test.com'), expect.objectContaining({ limits: expect.objectContaining({ spendPerDay: 5 }) }), expect.anything());
    expect(cacheInvalidationService.bulkInvalidate).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ credentialId: 'sk-qp-user', authType: 'api_key', reason: 'constraints' })]));

    const list = (await GET(`${S}/QuotaProfiles(${p.ID})`, ADMIN)).data; expect(list.assignedUsers).toBe(1);
    const profileUsers = (await GET(`${S}/quotaProfileUsers()`, ADMIN)).data.value;
    expect(profileUsers.find((x: any) => x.email === 'uq-user@test.com')).toMatchObject({ profileId: p.ID, profileName: 'P' });
    expect(profileUsers.find((x: any) => x.email === 'uq-admin@test.com')).toMatchObject({ profileId: null, profileName: null });
    expect((await ok(GET(`${S}/quotaProfileUsers()`, USER))).status).toBe(403);

    // the draft flow does not move the association: cds drops quotaProfile_ID from the payload
    // (Common.FieldControl: #ReadOnly) before the app's read-only guard ever runs, so the PATCH
    // returns 200 but the field is unchanged.
    await POST(`${u('uq-user@test.com')}/AdminService.draftEdit`, { PreserveChanges: true }, ADMIN);
    const draftWrite = await ok(PATCH(ud('uq-user@test.com'), { quotaProfile_ID: null }, ADMIN));
    expect(draftWrite.status).toBe(200);
    expect((await GET(u('uq-user@test.com'), ADMIN)).data.quotaProfile_ID).toBe(p.ID);

    const [audit] = await cds.db.run(cds.ql.SELECT.from(AUDIT).where({ action: 'quota_profile.assign', resourceId: 'uq-user@test.com' }));
    expect(audit).toBeTruthy();
    expect(audit.resourceType).toBe('User');

    const un = await POST(`${S}/unassignQuotaProfile`, { email: 'uq-user@test.com' }, ADMIN);
    expect(un.data).toMatchObject({ quotaProfile_ID: null, quotaProfileName: null, limitSourceSpendPerDay: 'unlimited', spendPerDayDefaultText: 'unlimited' });
    const [unaudit] = await cds.db.run(cds.ql.SELECT.from(AUDIT).where({ action: 'quota_profile.unassign', resourceId: 'uq-user@test.com' }));
    expect(unaudit).toBeTruthy();
    expect((await ok(POST(`${S}/assignQuotaProfile`, { email: 'uq-user@test.com', profileId: p.ID }, USER))).status).toBe(403);
    expect((await ok(POST(`${S}/assignQuotaProfile`, { email: 'nobody@test.com', profileId: p.ID }, ADMIN))).status).toBe(404);
    expect((await ok(POST(`${S}/assignQuotaProfile`, { email: 'uq-user@test.com', profileId: '11111111-1111-1111-1111-111111111111' }, ADMIN))).status).toBe(404);
  });

  it('deleting an assigned profile is refused with 409 naming the users; after unassign it goes', async () => {
    const p = (await POST(`${S}/QuotaProfiles`, { name: 'P' }, ADMIN)).data;
    await POST(`${S}/assignQuotaProfile`, { email: 'uq-user@test.com', profileId: p.ID }, ADMIN);
    const refused = await ok(DELETE(`${S}/QuotaProfiles(${p.ID})`, ADMIN));
    expect(refused.status).toBe(409); expect(message(refused)).toContain('uq-user@test.com');
    await POST(`${S}/unassignQuotaProfile`, { email: 'uq-user@test.com' }, ADMIN);
    expect((await DELETE(`${S}/QuotaProfiles(${p.ID})`, ADMIN)).status).toBe(204);
    const [audit] = await cds.db.run(cds.ql.SELECT.from(AUDIT).where({ action: 'quota_profile.delete' }));
    expect(audit).toBeTruthy();
  });

  it('editing a profile republishes and invalidates its users', async () => {
    const p = (await POST(`${S}/QuotaProfiles`, { name: 'P', tokensPerDay: 1000 }, ADMIN)).data;
    await POST(`${S}/assignQuotaProfile`, { email: 'uq-user@test.com', profileId: p.ID }, ADMIN);
    (cacheInvalidationService.bulkInvalidate as jest.Mock).mockClear();
    (quotaStateStore.setJson as jest.Mock).mockClear();

    expect((await PATCH(`${S}/QuotaProfiles(${p.ID})`, { tokensPerDay: 2000 }, ADMIN)).status).toBe(200);

    expect(cacheInvalidationService.bulkInvalidate).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ credentialId: 'sk-qp-user', authType: 'api_key', reason: 'constraints' })]));
    expect(quotaStateStore.setJson).toHaveBeenCalledWith(quotaKeyFor('uq-user@test.com'), expect.objectContaining({ limits: expect.objectContaining({ tokensPerDay: 2000 }) }), expect.anything());
    expect((await GET(u('uq-user@test.com'), ADMIN)).data).toMatchObject({ effectiveTokensPerDay: 2000, limitSourceTokensPerDay: 'profile', quotaProfileName: 'P', tokensPerDayDefaultText: '2,000 (P profile)' });
    const [audit] = await cds.db.run(cds.ql.SELECT.from(AUDIT).where({ action: 'quota_profile.update', resourceId: p.ID }));
    expect(audit).toBeTruthy();
    expect(audit.details).toContain('tokensPerDay');
  });

  it('creating a profile is audited with the limits it was created with', async () => {
    const p = (await POST(`${S}/QuotaProfiles`, { name: 'Audited', tokensPerDay: 1000 }, ADMIN)).data;
    const [audit] = await cds.db.run(cds.ql.SELECT.from(AUDIT).where({ action: 'quota_profile.create', resourceId: p.ID }));
    expect(audit).toBeTruthy();
    expect(audit.resourceType).toBe('QuotaProfile');
    expect(audit.details).toContain('tokensPerDay');
  });

  it('a description-only edit is audited but republishes nothing', async () => {
    const p = (await POST(`${S}/QuotaProfiles`, { name: 'P', tokensPerDay: 1000 }, ADMIN)).data;
    await POST(`${S}/assignQuotaProfile`, { email: 'uq-user@test.com', profileId: p.ID }, ADMIN);
    (cacheInvalidationService.bulkInvalidate as jest.Mock).mockClear();
    (quotaStateStore.setJson as jest.Mock).mockClear();

    expect((await PATCH(`${S}/QuotaProfiles(${p.ID})`, { description: 'the team that ships' }, ADMIN)).status).toBe(200);

    // No limit moved, so no assignee's document or cached validation is stale.
    expect(quotaStateStore.setJson).not.toHaveBeenCalled();
    expect(cacheInvalidationService.bulkInvalidate).not.toHaveBeenCalled();
    const [audit] = await cds.db.run(cds.ql.SELECT.from(AUDIT).where({ action: 'quota_profile.update', resourceId: p.ID }));
    expect(audit).toBeTruthy();
    expect(JSON.parse(audit.details).fields).toEqual(['description']);
  });
});

describe('QuotaProfiles create race', () => {
  it('a name that lands between the uniqueness check and the insert is refused with the same 400, not a 500', async () => {
    // Deterministic race: a before-handler registered here runs after the service's own name
    // check (registration order) and before the redirected INSERT, and slips the same name in.
    const srv = await cds.connect.to('AdminService');
    let raced = false;
    srv.before('CREATE', 'QuotaProfiles', async (req: any) => {
      if (req.data.name !== 'Raced' || raced) return;
      raced = true;
      await cds.db.run(cds.ql.INSERT.into(PROFILES).entries({ ID: cds.utils.uuid(), name: 'Raced' }));
    });
    const res = await ok(POST(`${S}/QuotaProfiles`, { name: 'Raced', tokensPerDay: 10 }, ADMIN));
    expect(raced).toBe(true);                       // the check passed; the INSERT met the constraint
    expect(res.status).toBe(400);
    expect(message(res)).toMatch(/already exists/);
    // (The injected row shares the request's transaction and is rolled back with the 400; a real
    // competitor's row is committed on its own and stays - what matters here is the status.)
  });
});
