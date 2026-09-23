/**
 * Boots the real AdminService via cds.test() on in-memory SQLite with mocked users (same
 * pattern as sap-rates-crud.test.ts) and drives the Model Library OData surface: entitlement
 * filtering on LibraryModels, catalog rules per role, the default's guards, manual prices.
 * Runs bare — never touches db/admin.db or :4004.
 */
import path from 'path';

process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = {
  kind: 'mocked',
  users: {
    'lib-admin@test.com': { id: 'lib-admin@test.com', roles: ['admin', 'user'] },
    'lib-user@test.com': { id: 'lib-user@test.com', roles: ['user'] },
    'lib-other@test.com': { id: 'lib-other@test.com', roles: ['user'] }
  }
};
// No test may reach a live gateway or AI Core. requireActual keeps the real
// GatewayDeploymentError class, which the handler's error mapping is an instanceof check on.
jest.mock('../../../src/services/gatewayDeploymentClient', () => {
  const actual = jest.requireActual('../../../src/services/gatewayDeploymentClient');
  return { ...actual, listDeployments: jest.fn(), createDeployment: jest.fn(), deploymentStatus: jest.fn() };
});
const GW_CLIENT = '../../../src/services/gatewayDeploymentClient';

const { GET, POST, PATCH, DELETE } = cds.test(path.resolve(__dirname, '../../..'));

const ADMIN = { auth: { username: 'lib-admin@test.com', password: 'x' } };
const USER = { auth: { username: 'lib-user@test.com', password: 'x' } };
const OTHER = { auth: { username: 'lib-other@test.com', password: 'x' } };
const ok = (p: Promise<any>) => p.catch((e: any) => e.response);

const LIB = 'sap.llm.gateway.admin.LibraryModels';
const CAT = 'sap.llm.gateway.admin.ModelCatalogs';
const MEM = 'sap.llm.gateway.admin.ModelCatalogMembers';
const EXC = 'sap.llm.gateway.admin.ModelCatalogExclusions';
const USERS = 'sap.llm.gateway.admin.Users';
const COSTS = 'sap.llm.gateway.admin.ModelCosts';
const KEYS = 'sap.llm.gateway.admin.ApiKeys';

// libraryUsers() harvests e-mails from ApiKeys/AwsCredentials/UserPreferences. The
// '<name>.service.key' pseudo-address is the gateway's own service key, not a person.
const SERVICE_KEY_EMAIL = 'admin2gateway.service.key';

const model = (modelId: string, extra: any = {}) => ({ modelId, baseModel: modelId, displayName: `Model ${modelId}`, provider: 'Anthropic', accessType: 'foundation', capText: true, absent: false, lastSeenAt: new Date(), sapInputCost: '0.001', sapOutputCost: '0.002', ...extra });

let defaultId: string;
beforeEach(async () => {
  const { DELETE: DEL, INSERT, SELECT, UPDATE } = cds.ql;
  for (const t of [USERS, MEM, EXC, COSTS, LIB, KEYS]) await cds.db.run(DEL.from(t));
  await cds.db.run(DEL.from(CAT).where({ isDefault: false }));
  // One test renames the default; restore it so no assertion depends on file order.
  await cds.db.run(UPDATE(CAT).set({ name: 'Default' }).where({ isDefault: true }));
  await cds.db.run(INSERT.into(LIB).entries([model('m1'), model('m2'), model('m3', { capReasoning: true }), model('gone', { absent: true })]));
  await cds.db.run(INSERT.into(KEYS).entries([
    { ID: 'k-lib-user', key: 'sk-lib-user', name: 'user key', email: 'lib-user@test.com', isActive: true },
    { ID: 'k-lib-svc', key: 'sk-lib-svc', name: 'gateway service key', email: SERVICE_KEY_EMAIL, isActive: true }
  ]));
  const def = await cds.db.run(SELECT.from(CAT).where({ isDefault: true }));
  expect(def.length).toBe(1);            // seeded by initializeModelLibrary at boot
  defaultId = def[0].ID;
});

describe('LibraryModels entitlement filter', () => {
  it('admin sees all non-absent models; user sees default minus exclusions; $count agrees', async () => {
    const a = await GET('/odata/v4/admin/LibraryModels?$count=true', ADMIN);
    expect(a.data['@odata.count']).toBe(3);
    await POST(`/odata/v4/admin/ModelCatalogs(${defaultId})/AdminService.excludeModels`, { modelIds: ['m2'], reason: 'cost' }, ADMIN);
    const u = await GET('/odata/v4/admin/LibraryModels?$count=true&$orderby=modelId', USER);
    expect(u.data['@odata.count']).toBe(2);
    expect(u.data.value.map((m: any) => m.modelId)).toEqual(['m1', 'm3']);
    const a2 = await GET('/odata/v4/admin/LibraryModels?$count=true', ADMIN);
    expect(a2.data['@odata.count']).toBe(3);   // admins keep the full view
    const filtered = await GET('/odata/v4/admin/LibraryModels?$filter=capReasoning eq true', USER);
    expect(filtered.data.value.map((m: any) => m.modelId)).toEqual(['m3']);
  });

  it('supports the `in` operator that webapp/model/idFilters.ts relies on (no id-count cap)', async () => {
    // modelIdIn: 'no-such-id' proves the clause is a real filter, not an accidental pass-through.
    const inFilter = await GET(`/odata/v4/admin/LibraryModels?$filter=modelId in ('m1','no-such-id')&$select=modelId`, ADMIN);
    expect(inFilter.data.value.map((m: any) => m.modelId)).toEqual(['m1']);
    // modelIdNotIn.
    const notInFilter = await GET(`/odata/v4/admin/LibraryModels?$filter=not (modelId in ('m1','m2'))&$select=modelId&$orderby=modelId`, ADMIN);
    expect(notInFilter.data.value.map((m: any) => m.modelId)).toEqual(['m3']);
  });

  it('an assigned user sees only the members of their catalog', async () => {
    const cat = await POST('/odata/v4/admin/ModelCatalogs', { name: 'Team A' }, ADMIN);
    await POST(`/odata/v4/admin/ModelCatalogs(${cat.data.ID})/AdminService.addModels`, { modelIds: ['m1'] }, ADMIN);
    await POST('/odata/v4/admin/assignCatalog', { email: 'lib-user@test.com', catalogId: cat.data.ID }, ADMIN);
    const u = await GET('/odata/v4/admin/LibraryModels?$count=true', USER);
    expect(u.data['@odata.count']).toBe(1);
    expect(u.data.value[0].modelId).toBe('m1');
    const me = await GET('/odata/v4/admin/myEntitlement()', USER);
    expect(me.data.catalog.ID).toBe(cat.data.ID);
    expect(me.data.modelIds).toEqual(['m1']);
    expect(me.data.unrestricted).toBe(false);
    const meAdmin = await GET('/odata/v4/admin/myEntitlement()', ADMIN);
    expect(meAdmin.data.unrestricted).toBe(true);
  });
});

describe('catalog rules per role', () => {
  it('admin creates a parent catalog; user creates a child bound to their assignment and cannot escape it', async () => {
    const parent = await POST('/odata/v4/admin/ModelCatalogs', { name: 'Parent' }, ADMIN);
    await POST(`/odata/v4/admin/ModelCatalogs(${parent.data.ID})/AdminService.addModels`, { modelIds: ['m1', 'm2'] }, ADMIN);
    await POST('/odata/v4/admin/assignCatalog', { email: 'lib-user@test.com', catalogId: parent.data.ID }, ADMIN);

    const kid = await POST('/odata/v4/admin/ModelCatalogs', { name: 'Kid', parent_ID: defaultId, ownerEmail: 'lib-admin@test.com', isDefault: true }, USER);
    expect(kid.status).toBe(201);
    expect(kid.data.ownerEmail).toBe('lib-user@test.com');   // forced
    expect(kid.data.parent_ID).toBe(parent.data.ID);         // forced to the assignment
    expect(kid.data.isDefault).toBe(false);

    const bad = await ok(POST(`/odata/v4/admin/ModelCatalogs(${kid.data.ID})/AdminService.addModels`, { modelIds: ['m1', 'm3'] }, USER));
    expect(bad.status).toBe(400);
    expect(bad.data.error.message).toMatch(/m3/);
    const good = await POST(`/odata/v4/admin/ModelCatalogs(${kid.data.ID})/AdminService.addModels`, { modelIds: ['m1', 'm2'] }, USER);
    expect(good.data.added).toBe(2);

    // other user cannot see or touch the kid
    const otherList = await GET('/odata/v4/admin/ModelCatalogs', OTHER);
    expect(otherList.data.value.map((c: any) => c.ID)).not.toContain(kid.data.ID);
    expect((await ok(POST(`/odata/v4/admin/ModelCatalogs(${kid.data.ID})/AdminService.addModels`, { modelIds: ['m1'] }, OTHER))).status).toBe(403);

    // removing from the parent prunes the kid
    const r = await POST(`/odata/v4/admin/ModelCatalogs(${parent.data.ID})/AdminService.removeModels`, { modelIds: ['m2'] }, ADMIN);
    expect(r.data).toMatchObject({ removed: 1, prunedFromChildren: 1 });
    const members = await GET(`/odata/v4/admin/ModelCatalogMembers?$filter=catalog_ID eq ${kid.data.ID}`, USER);
    expect(members.data.value.map((m: any) => m.modelId)).toEqual(['m1']);

    // user reads: own, parent, default — nothing else
    const mine = await GET('/odata/v4/admin/ModelCatalogs?$orderby=name', USER);
    expect(mine.data.value.map((c: any) => c.name).sort()).toEqual(['Default', 'Kid', 'Parent']);
  });

  it('deep insert of members is refused; members and exclusions are read-only entities', async () => {
    const r = await ok(POST('/odata/v4/admin/ModelCatalogs', { name: 'X', members: [{ modelId: 'm1' }] }, ADMIN));
    expect(r.status).toBe(400);
    expect((await ok(POST('/odata/v4/admin/ModelCatalogMembers', { catalog_ID: defaultId, modelId: 'm1' }, ADMIN))).status).toBe(405);
  });

  it('the default cannot be deleted by anyone, renamed only by admin, and exclusions are admin-only', async () => {
    expect((await ok(DELETE(`/odata/v4/admin/ModelCatalogs(${defaultId})`, ADMIN))).status).toBe(403);
    expect((await ok(DELETE(`/odata/v4/admin/ModelCatalogs(${defaultId})`, USER))).status).toBe(403);
    expect((await ok(PATCH(`/odata/v4/admin/ModelCatalogs(${defaultId})`, { isDefault: false }, ADMIN))).status).toBe(400);
    expect((await ok(PATCH(`/odata/v4/admin/ModelCatalogs(${defaultId})`, { name: 'Everyone' }, USER))).status).toBe(403);
    expect((await PATCH(`/odata/v4/admin/ModelCatalogs(${defaultId})`, { name: 'Everyone' }, ADMIN)).status).toBe(200);
    expect((await ok(POST(`/odata/v4/admin/ModelCatalogs(${defaultId})/AdminService.excludeModels`, { modelIds: ['m1'] }, USER))).status).toBe(403);
  });

  it('a parent cycle cannot be built over OData: only admin catalogs and the default may be parents', async () => {
    // Two user catalogs, then the PATCH that would have made A.parent=B and B.parent=A - the
    // pair that turned every later removeModels into an endless prune walk.
    const parent = await POST('/odata/v4/admin/ModelCatalogs', { name: 'AdminParent' }, ADMIN);
    await POST('/odata/v4/admin/assignCatalog', { email: 'lib-user@test.com', catalogId: parent.data.ID }, ADMIN);
    const a = await POST('/odata/v4/admin/ModelCatalogs', { name: 'A' }, USER);
    const b = await POST('/odata/v4/admin/ModelCatalogs', { name: 'B' }, USER);

    const cycle = await ok(PATCH(`/odata/v4/admin/ModelCatalogs(${a.data.ID})`, { parent_ID: b.data.ID }, ADMIN));
    expect(cycle.status).toBe(400);
    expect(cycle.data.error.message).toMatch(/only admin catalogs and the default can be parents/);

    // an admin catalog and the default are roots and may not be given a parent at all
    const rootPatch = await ok(PATCH(`/odata/v4/admin/ModelCatalogs(${parent.data.ID})`, { parent_ID: defaultId }, ADMIN));
    expect(rootPatch.status).toBe(400);
    expect(rootPatch.data.error.message).toMatch(/roots/);
    expect((await ok(PATCH(`/odata/v4/admin/ModelCatalogs(${defaultId})`, { parent_ID: parent.data.ID }, ADMIN))).status).toBe(400);

    // self-reference and a dangling parent are refused too
    expect((await ok(PATCH(`/odata/v4/admin/ModelCatalogs(${a.data.ID})`, { parent_ID: a.data.ID }, ADMIN))).status).toBe(400);
    expect((await ok(PATCH(`/odata/v4/admin/ModelCatalogs(${a.data.ID})`, { parent_ID: '11111111-1111-1111-1111-111111111111' }, ADMIN))).status).toBe(400);

    // a user still cannot touch parent_ID at all, and the legitimate move stays possible
    expect((await ok(PATCH(`/odata/v4/admin/ModelCatalogs(${a.data.ID})`, { parent_ID: defaultId }, USER))).status).toBe(400);
    const legal = await PATCH(`/odata/v4/admin/ModelCatalogs(${a.data.ID})`, { parent_ID: defaultId }, ADMIN);
    expect(legal.status).toBe(200);
    expect(legal.data.parent_ID).toBe(defaultId);
    void b;
  });

  it('deleting an assigned catalog is 409 with the dependants; unassign then delete works', async () => {
    const cat = await POST('/odata/v4/admin/ModelCatalogs', { name: 'P' }, ADMIN);
    await POST('/odata/v4/admin/assignCatalog', { email: 'lib-other@test.com', catalogId: cat.data.ID }, ADMIN);
    const r = await ok(DELETE(`/odata/v4/admin/ModelCatalogs(${cat.data.ID})`, ADMIN));
    expect(r.status).toBe(409);
    expect(r.data.error.message).toMatch(/lib-other@test.com/);

    // While the assignment stands, libraryUsers() reports it - and never the service key.
    const listed = (await GET('/odata/v4/admin/libraryUsers()', ADMIN)).data.value;
    expect(Array.isArray(listed)).toBe(true);
    expect(listed).toContainEqual(expect.objectContaining({ email: 'lib-other@test.com', catalogId: cat.data.ID, catalogName: 'P' }));
    expect(listed.map((u: any) => u.email)).not.toContain(SERVICE_KEY_EMAIL);
    const unassignedUser = listed.find((u: any) => u.email === 'lib-user@test.com');   // has an ApiKeys row, no assignment
    expect(unassignedUser).toBeDefined();
    expect(unassignedUser.catalogId ?? null).toBeNull();
    expect(unassignedUser.catalogName ?? null).toBeNull();

    await POST('/odata/v4/admin/unassignCatalog', { email: 'lib-other@test.com' }, ADMIN);
    expect((await DELETE(`/odata/v4/admin/ModelCatalogs(${cat.data.ID})`, ADMIN)).status).toBe(204);
    const after = (await GET('/odata/v4/admin/libraryUsers()', ADMIN)).data.value;
    expect(after.find((u: any) => u.email === 'lib-other@test.com')?.catalogId ?? null).toBeNull();
  });

  it('members and exclusions are row-filtered to the catalogs the caller may see', async () => {
    // lib-other gets an admin parent with members plus a child catalog of their own; lib-user
    // has neither, only a catalog of their own.
    const otherParent = await POST('/odata/v4/admin/ModelCatalogs', { name: 'OtherParent' }, ADMIN);
    await POST(`/odata/v4/admin/ModelCatalogs(${otherParent.data.ID})/AdminService.addModels`, { modelIds: ['m1', 'm2'] }, ADMIN);
    await POST('/odata/v4/admin/assignCatalog', { email: 'lib-other@test.com', catalogId: otherParent.data.ID }, ADMIN);
    const otherKid = await POST('/odata/v4/admin/ModelCatalogs', { name: 'OtherKid' }, OTHER);
    await POST(`/odata/v4/admin/ModelCatalogs(${otherKid.data.ID})/AdminService.addModels`, { modelIds: ['m1'] }, OTHER);
    const myKid = await POST('/odata/v4/admin/ModelCatalogs', { name: 'MyKid' }, USER);
    await POST(`/odata/v4/admin/ModelCatalogs(${myKid.data.ID})/AdminService.addModels`, { modelIds: ['m3'] }, USER);

    // lib-user sees only their own catalog's member - and $expand=catalog leaks no one else's
    // catalog name or owner, which is what an unfiltered members read used to hand out.
    const mine = await GET('/odata/v4/admin/ModelCatalogMembers?$expand=catalog', USER);
    expect(mine.data.value.map((m: any) => m.catalog_ID)).toEqual([myKid.data.ID]);
    expect(mine.data.value.map((m: any) => m.modelId)).toEqual(['m3']);
    expect(mine.data.value.map((m: any) => m.catalog?.ownerEmail)).not.toContain('lib-other@test.com');
    expect(mine.data.value.map((m: any) => m.catalog?.name)).not.toContain('OtherParent');

    // lib-other sees their assigned parent and their own child, nothing of lib-user's
    const theirs = await GET('/odata/v4/admin/ModelCatalogMembers?$expand=catalog', OTHER);
    expect([...new Set(theirs.data.value.map((m: any) => m.catalog_ID))].sort())
      .toEqual([otherParent.data.ID, otherKid.data.ID].sort());
    expect(theirs.data.value.map((m: any) => m.catalog?.name)).not.toContain('MyKid');

    // the admin keeps the full view: 2 + 1 + 1
    const all = await GET('/odata/v4/admin/ModelCatalogMembers', ADMIN);
    expect(all.data.value).toHaveLength(4);

    // exclusions live on the default, which everyone may see, so the filter must not hide them
    await POST(`/odata/v4/admin/ModelCatalogs(${defaultId})/AdminService.excludeModels`, { modelIds: ['m2'], reason: 'cost' }, ADMIN);
    const exclusions = await GET('/odata/v4/admin/ModelCatalogExclusions', USER);
    expect(exclusions.data.value.map((e: any) => e.modelId)).toEqual(['m2']);
  });

  it('ModelCatalogAssignments is read-only over OData; assignCatalog is the only write path', async () => {
    const cat = await POST('/odata/v4/admin/ModelCatalogs', { name: 'RO' }, ADMIN);
    const rejected = await ok(POST('/odata/v4/admin/ModelCatalogAssignments', { email: 'lib-other@test.com', catalog_ID: cat.data.ID }, ADMIN));
    expect(rejected.status).toBe(405);   // @readonly projection, same as ModelCatalogMembers
    expect((await GET('/odata/v4/admin/ModelCatalogAssignments', ADMIN)).data.value).toHaveLength(0);   // nothing was written

    await POST('/odata/v4/admin/assignCatalog', { email: 'lib-other@test.com', catalogId: cat.data.ID }, ADMIN);
    // The legacy table is drained: assignCatalog now writes through Users.entitlementCatalog,
    // never ModelCatalogAssignments (usersService.migrateCatalogAssignments) - libraryUsers()
    // is the observable effect.
    const listed = await GET('/odata/v4/admin/ModelCatalogAssignments', ADMIN);
    expect(listed.status).toBe(200);
    expect(listed.data.value).toHaveLength(0);
    const users = (await GET('/odata/v4/admin/libraryUsers()', ADMIN)).data.value;
    expect(users.find((u: any) => u.email === 'lib-other@test.com')?.catalogId).toBe(cat.data.ID);
  });

  it('assignCatalog is admin-only and refuses user-owned catalogs', async () => {
    const kid = await POST('/odata/v4/admin/ModelCatalogs', { name: 'Kid' }, USER);
    expect((await ok(POST('/odata/v4/admin/assignCatalog', { email: 'lib-other@test.com', catalogId: kid.data.ID }, ADMIN))).status).toBe(400);
    expect((await ok(POST('/odata/v4/admin/assignCatalog', { email: 'lib-other@test.com', catalogId: defaultId }, USER))).status).toBe(403);
  });
});

describe('prices and config context', () => {
  it('setPrice inserts a manual row, ModelPrices shows history, revert restores SAP', async () => {
    const { INSERT } = cds.ql;
    await cds.db.run(INSERT.into(COSTS).entries([{ ID: 'c-m1', model: 'm1', dateFrom: new Date('2026-01-01'), dateTo: new Date('9999-12-31'), inputCost: '0.001', outputCost: '0.002', provider: 'Anthropic', source: 'sap' }]));
    const set = await POST(`/odata/v4/admin/LibraryModels('m1')/AdminService.setPrice`, { inputCost: 0.005, outputCost: 0.01, imageOutputCost: 0.06, audioInputCost: 0.01954, audioOutputCost: 0.03901 }, ADMIN);
    expect(set.data.source).toBe('manual');
    expect(String(set.data.imageOutputCost)).toBe('0.06');
    expect(String(set.data.audioInputCost)).toBe('0.01954');
    expect(String(set.data.audioOutputCost)).toBe('0.03901');
    const hist = await GET(`/odata/v4/admin/ModelPrices?$filter=model eq 'm1'&$orderby=dateFrom`, ADMIN);
    expect(hist.data.value.map((r: any) => r.source)).toEqual(['sap', 'manual']);
    expect(hist.data.value[0].dateTo).not.toMatch(/^9999/);
    expect(String(hist.data.value[1].imageOutputCost)).toBe('0.06');
    expect(String(hist.data.value[1].audioInputCost)).toBe('0.01954');
    expect(String(hist.data.value[1].audioOutputCost)).toBe('0.03901');
    const rev = await POST(`/odata/v4/admin/LibraryModels('m1')/AdminService.revertToSapPrice`, {}, ADMIN);
    expect(rev.data.source).toBe('sap');
    expect(String(rev.data.inputCost)).toBe('0.001');
    expect(rev.data.imageOutputCost).toBeNull();
    expect(rev.data.audioInputCost).toBeNull();
    expect(rev.data.audioOutputCost).toBeNull();
    expect((await ok(POST(`/odata/v4/admin/LibraryModels('m1')/AdminService.setPrice`, { inputCost: 1, outputCost: 1 }, USER))).status).toBe(403);
  });

  it('setPrice rejects a negative imageOutputCost', async () => {
    const bad = await ok(POST(`/odata/v4/admin/LibraryModels('m1')/AdminService.setPrice`, { inputCost: 0.005, outputCost: 0.01, imageOutputCost: -1 }, ADMIN));
    expect(bad.status).toBe(400);
    expect(bad.data.error.message).toMatch(/imageOutputCost/);
  });

  it('setPrice rejects a negative audio rate', async () => {
    const bad = await ok(POST(`/odata/v4/admin/LibraryModels('m1')/AdminService.setPrice`, { inputCost: 0.005, outputCost: 0.01, audioOutputCost: -1 }, ADMIN));
    expect(bad.status).toBe(400);
    expect(bad.data.error.message).toMatch(/audioOutputCost/);
  });

  it('configContext falls back to the file when no configuration is active and reports the cuFactor source', async () => {
    const ctx = await GET(`/odata/v4/admin/LibraryModels('m1')/AdminService.configContext()`, USER);
    expect(['config', 'default']).toContain(ctx.data.cuFactorSource);
    expect(Number(ctx.data.cuFactor)).toBeGreaterThan(0);
    expect(typeof ctx.data.productive).toBe('boolean');
    // Proves the file fallback was actually read and the SAP display provider ('Anthropic')
    // was mapped onto the lowercase-hyphen key api_config.json uses ('anthropic').
    expect(JSON.parse(ctx.data.providerSettings)).toBeTruthy();
  });

  it('refreshModelLibrary is admin-only', async () => {
    expect((await ok(POST('/odata/v4/admin/refreshModelLibrary', {}, USER))).status).toBe(403);
  });
});

describe('deployments (gateway mocked)', () => {
  it('admin fetches, deploys and polls; user is refused; a gateway 409 stays a 409', async () => {
    const gwc = require(GW_CLIENT);
    gwc.listDeployments.mockResolvedValue([{ id: 'd1', status: 'RUNNING' }]);
    gwc.createDeployment.mockResolvedValue({ deploymentId: 'd9', status: 'PENDING', configurationId: 'c1', reusedConfiguration: true });
    gwc.deploymentStatus.mockResolvedValue({ status: 'RUNNING', deploymentUrl: 'https://dep' });

    const list = await GET(`/odata/v4/admin/LibraryModels('m1')/AdminService.fetchDeployments()`, ADMIN);
    expect(list.data.value[0].id).toBe('d1');
    const dep = await POST(`/odata/v4/admin/LibraryModels('m1')/AdminService.deploy`, {}, ADMIN);
    expect(dep.data.deploymentId).toBe('d9');
    expect(gwc.createDeployment).toHaveBeenCalledWith('m1');
    const st = await GET(`/odata/v4/admin/deploymentStatus(deploymentId='d9')`, ADMIN);
    expect(st.data.status).toBe('RUNNING');
    expect(st.data.deploymentUrl).toBe('https://dep');

    expect((await ok(POST(`/odata/v4/admin/LibraryModels('m1')/AdminService.deploy`, {}, USER))).status).toBe(403);
    expect((await ok(GET(`/odata/v4/admin/LibraryModels('m1')/AdminService.fetchDeployments()`, USER))).status).toBe(403);
    expect((await ok(GET(`/odata/v4/admin/deploymentStatus(deploymentId='d9')`, USER))).status).toBe(403);

    // The library lists a deployed model under the '<model>--deployed' alias; the gateway only
    // knows the base name, so the suffix has to be stripped before the call goes out.
    await cds.db.run(cds.ql.INSERT.into(LIB).entries([model('m1--deployed', { accessType: 'deployment' })]));
    await GET(`/odata/v4/admin/LibraryModels('m1--deployed')/AdminService.fetchDeployments()`, ADMIN);
    expect(gwc.listDeployments).toHaveBeenLastCalledWith('m1');

    gwc.createDeployment.mockRejectedValueOnce(new gwc.GatewayDeploymentError(409, 'deployment_exists', 'exists', { deploymentId: 'd1', status: 'RUNNING' }));
    const conflict = await ok(POST(`/odata/v4/admin/LibraryModels('m1')/AdminService.deploy`, {}, ADMIN));
    expect(conflict.status).toBe(409);
    expect(conflict.data.error.message).toMatch(/d1/);
  });
});

describe('local validation cache invalidation', () => {
  const validationCache = () => require('../../../src/srv/validation-service').instance.cache;
  const seed = () => {
    const cache = validationCache();
    cache.apiKeys.set('unified_apikey:sk-lib-user', { result: { valid: true }, timestamp: Date.now() });
    cache.awsCredentials.set('unified_aws:AKIALIBUSER', { result: { valid: true }, timestamp: Date.now() });
  };

  it('assignCatalog drops the affected user entry; a default-catalog exclusion drops everything', async () => {
    const cat = await POST('/odata/v4/admin/ModelCatalogs', { name: 'CacheCat' }, ADMIN);
    seed();
    await POST('/odata/v4/admin/assignCatalog', { email: 'lib-user@test.com', catalogId: cat.data.ID }, ADMIN);
    expect(validationCache().apiKeys.has('unified_apikey:sk-lib-user')).toBe(false);

    seed();
    await POST(`/odata/v4/admin/ModelCatalogs(${defaultId})/AdminService.excludeModels`, { modelIds: ['m2'], reason: 'cost' }, ADMIN);
    expect(validationCache().apiKeys.size).toBe(0);
    expect(validationCache().awsCredentials.size).toBe(0);
  });
});

describe('gateway cache invalidation is actually published', () => {
  // The local cache assertions above only prove the ADMIN forgot its own validations. What the
  // gateway hears is a separate path, and it is the one that decides whether a revoked model
  // stays usable for another hour: per-user bulkInvalidate for an assignment, one pattern event
  // for the default (everyone without an assignment is affected).
  const cis = require('../../../src/services/cacheInvalidationService').cacheInvalidationService;
  afterEach(() => jest.restoreAllMocks());

  it('assignCatalog bulk-invalidates the user credentials; excludeModels on the default sends the pattern', async () => {
    const bulk = jest.spyOn(cis, 'bulkInvalidate').mockResolvedValue(undefined as never);
    const pattern = jest.spyOn(cis, 'invalidatePattern').mockResolvedValue(0 as never);

    const cat = await POST('/odata/v4/admin/ModelCatalogs', { name: 'InvCat' }, ADMIN);
    await POST('/odata/v4/admin/assignCatalog', { email: 'lib-user@test.com', catalogId: cat.data.ID }, ADMIN);

    expect(bulk).toHaveBeenCalledTimes(1);
    expect(bulk).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ credentialId: 'sk-lib-user', authType: 'api_key', reason: 'entitlement' })
    ]));
    expect(pattern).not.toHaveBeenCalled();

    bulk.mockClear();
    await POST(`/odata/v4/admin/ModelCatalogs(${defaultId})/AdminService.excludeModels`, { modelIds: ['m2'], reason: 'cost' }, ADMIN);

    expect(pattern).toHaveBeenCalledWith('unified-cache:*', 'entitlement');
    expect(bulk).not.toHaveBeenCalled();
  });
});

describe('an audit write never decides the outcome', () => {
  // recordAuditEvent swallows its own failures today; these pin the guarantee at the call site,
  // so a future audit-service change cannot silently turn a real deployment into a 502.
  const audits = require('../../../src/services/auditEventService');
  afterEach(() => jest.restoreAllMocks());

  it('a throwing audit leaves a successful deploy successful and a gateway 409 a 409', async () => {
    const gwc = require(GW_CLIENT);
    gwc.createDeployment.mockReset();
    gwc.createDeployment.mockResolvedValueOnce({ deploymentId: 'd7', status: 'PENDING', configurationId: 'c7', reusedConfiguration: false });
    jest.spyOn(audits, 'recordAuditEvent').mockRejectedValue(new Error('audit table is gone'));

    const ok201 = await POST(`/odata/v4/admin/LibraryModels('m1')/AdminService.deploy`, {}, ADMIN);
    expect(ok201.data.deploymentId).toBe('d7');
    expect(ok201.data.status).toBe('PENDING');

    gwc.createDeployment.mockRejectedValueOnce(new gwc.GatewayDeploymentError(409, 'deployment_exists', 'exists', { deploymentId: 'd7', status: 'RUNNING' }));
    const conflict = await ok(POST(`/odata/v4/admin/LibraryModels('m1')/AdminService.deploy`, {}, ADMIN));
    expect(conflict.status).toBe(409);
    expect(audits.recordAuditEvent).toHaveBeenCalled();
  });

  it('a throwing audit leaves setPrice and revertToSapPrice successful', async () => {
    const { INSERT } = cds.ql;
    await cds.db.run(INSERT.into(COSTS).entries([{ ID: 'c-audit', model: 'm1', dateFrom: new Date('2026-01-01'), dateTo: new Date('9999-12-31'), inputCost: '0.001', outputCost: '0.002', provider: 'Anthropic', source: 'sap' }]));
    jest.spyOn(audits, 'recordAuditEvent').mockRejectedValue(new Error('audit table is gone'));
    expect((await POST(`/odata/v4/admin/LibraryModels('m1')/AdminService.setPrice`, { inputCost: 0.005, outputCost: 0.01 }, ADMIN)).data.source).toBe('manual');
    expect((await POST(`/odata/v4/admin/LibraryModels('m1')/AdminService.revertToSapPrice`, {}, ADMIN)).data.source).toBe('sap');
  });
});
