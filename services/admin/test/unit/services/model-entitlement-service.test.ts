/**
 * Entitlement rules (spec section 3) against the real CDS model on an in-memory SQLite database:
 * effective sets, subset check, pruning of children, guards, and the block the validation
 * service hands to the gateway.
 */
import path from 'path';

// Makes @sap/cds's service-implementation lookup consider the .ts sibling of admin-service.cds
// (see sap-rates-crud.test.ts) - kept for consistency even though this suite is DB-only.
process.env.CDS_TYPESCRIPT = 'true';

const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.test(path.resolve(__dirname, '../../..'));

import * as ent from '../../../src/services/modelEntitlementService';

const LIB = 'sap.llm.gateway.admin.LibraryModels';
const CAT = 'sap.llm.gateway.admin.ModelCatalogs';
const MEM = 'sap.llm.gateway.admin.ModelCatalogMembers';
const EXC = 'sap.llm.gateway.admin.ModelCatalogExclusions';
const USERS = 'sap.llm.gateway.admin.Users';

const model = (modelId: string, extra: any = {}) => ({ modelId, baseModel: modelId, displayName: modelId, provider: 'Test', accessType: 'foundation', absent: false, lastSeenAt: new Date(), ...extra });

let db: any;
beforeAll(async () => { db = await cds.connect.to('db'); });
beforeEach(async () => {
  const { DELETE, INSERT } = cds.ql;
  for (const t of [USERS, MEM, EXC, CAT, LIB]) await db.run(DELETE.from(t));
  await db.run(INSERT.into(LIB).entries([model('m1'), model('m2'), model('m3'), model('m4', { absent: true })]));
});

describe('default catalog', () => {
  it('ensureDefaultCatalog creates exactly one default and is idempotent', async () => {
    const a = await ent.ensureDefaultCatalog(db);
    const b = await ent.ensureDefaultCatalog(db);
    expect(a.ID).toBe(b.ID);
    expect(a.isDefault).toBe(true);
    expect(a.name).toBe('Default');
    const { SELECT } = cds.ql;
    expect((await db.run(SELECT.from(CAT).where({ isDefault: true }))).length).toBe(1);
  });

  it('effective set = all non-absent models minus exclusions', async () => {
    const def = await ent.ensureDefaultCatalog(db);
    expect([...await ent.effectiveModelIds(db, def)].sort()).toEqual(['m1', 'm2', 'm3']);
    await ent.excludeModels(db, def, ['m2'], 'too expensive');
    expect([...await ent.effectiveModelIds(db, def)].sort()).toEqual(['m1', 'm3']);
    await ent.includeModels(db, def, ['m2']);
    expect([...await ent.effectiveModelIds(db, def)].sort()).toEqual(['m1', 'm2', 'm3']);
  });
});

describe('entitlementFor / entitlementBlockFor', () => {
  it('unassigned user gets the default; admin is unrestricted in the UI but the wire block still follows the assignment', async () => {
    const def = await ent.ensureDefaultCatalog(db);
    await ent.excludeModels(db, def, ['m3'], 'x');
    const user = await ent.entitlementFor(db, 'u@test.com', false);
    expect(user.catalog.ID).toBe(def.ID);
    expect(user.modelIds!.sort()).toEqual(['m1', 'm2']);
    const admin = await ent.entitlementFor(db, 'a@test.com', true);
    expect(admin.modelIds).toBeNull();
    expect(await ent.entitlementBlockFor(db, 'a@test.com')).toEqual({ catalogId: def.ID, catalogName: 'Default', mode: 'all', exclude: ['m3'] });
    await ent.includeModels(db, def, ['m3']);
    expect(await ent.entitlementBlockFor(db, 'a@test.com')).toEqual({ catalogId: def.ID, catalogName: 'Default', mode: 'all' });
  });

  it('assigned user gets the catalog members as a list block', async () => {
    await ent.ensureDefaultCatalog(db);
    const { INSERT } = cds.ql;
    await db.run(INSERT.into(CAT).entries([{ ID: 'c1', name: 'Team A' }]));
    const cat = { ID: 'c1', name: 'Team A', isDefault: false, ownerEmail: null, parent_ID: null } as any;
    await ent.addMembers(db, cat, ['m1', 'm3'], 'admin@test.com');
    await ent.assignCatalog(db, 'u@test.com', 'c1');
    expect(await ent.entitlementBlockFor(db, 'u@test.com')).toEqual({ catalogId: 'c1', catalogName: 'Team A', mode: 'list', include: ['m1', 'm3'] });
    const e = await ent.entitlementFor(db, 'u@test.com', false);
    expect(e.modelIds!.sort()).toEqual(['m1', 'm3']);
  });
});

describe('subset check and pruning', () => {
  it('a child may only hold models from its parent; removing from the parent prunes the child', async () => {
    const def = await ent.ensureDefaultCatalog(db);
    const { INSERT, SELECT } = cds.ql;
    await db.run(INSERT.into(CAT).entries([{ ID: 'p', name: 'Parent' }, { ID: 'k', name: 'Kid', ownerEmail: 'u@test.com', parent_ID: 'p' }]));
    const parent = { ID: 'p', isDefault: false, parent_ID: null } as any;
    const kid = { ID: 'k', isDefault: false, parent_ID: 'p', ownerEmail: 'u@test.com' } as any;
    await ent.addMembers(db, parent, ['m1', 'm2'], 'admin@test.com');
    await expect(ent.addMembers(db, kid, ['m1', 'm3'], 'u@test.com')).rejects.toMatchObject({ status: 400, code: 'not_in_parent', details: ['m3'] });
    await ent.addMembers(db, kid, ['m1', 'm2'], 'u@test.com');
    const r = await ent.removeMembers(db, parent, ['m2']);
    expect(r).toEqual({ removed: 1, prunedFromChildren: 1 });
    expect((await db.run(SELECT.from(MEM).where({ catalog_ID: 'k' }))).map((m: any) => m.modelId)).toEqual(['m1']);
    // duplicates are ignored, not errors
    expect(await ent.addMembers(db, parent, ['m1'], 'admin@test.com')).toEqual({ added: 0 });
    void def;
  });

  it('excluding from the default prunes children whose parent is the default', async () => {
    const def = await ent.ensureDefaultCatalog(db);
    const { INSERT, SELECT } = cds.ql;
    await db.run(INSERT.into(CAT).entries([{ ID: 'k', name: 'Kid', ownerEmail: 'u@test.com', parent_ID: def.ID }]));
    const kid = { ID: 'k', isDefault: false, parent_ID: def.ID, ownerEmail: 'u@test.com' } as any;
    await ent.addMembers(db, kid, ['m1', 'm2'], 'u@test.com');
    const r = await ent.excludeModels(db, def, ['m2'], 'no');
    expect(r).toEqual({ excluded: 1, prunedFromChildren: 1 });
    expect((await db.run(SELECT.from(MEM).where({ catalog_ID: 'k' }))).map((m: any) => m.modelId)).toEqual(['m1']);
  });

  it('a parent cycle written straight into the database terminates instead of hanging', async () => {
    // The UPDATE handler refuses to create A.parent=B / B.parent=A, but a row that predates it
    // (or a direct write like this one) must not turn removeModels into an infinite recursion.
    await ent.ensureDefaultCatalog(db);
    const { INSERT, UPDATE, SELECT } = cds.ql;
    await db.run(INSERT.into(CAT).entries([
      { ID: 'a', name: 'A', ownerEmail: 'u@test.com' },
      { ID: 'b', name: 'B', ownerEmail: 'u@test.com' }
    ]));
    await db.run(UPDATE(CAT).set({ parent_ID: 'b' }).where({ ID: 'a' }));
    await db.run(UPDATE(CAT).set({ parent_ID: 'a' }).where({ ID: 'b' }));
    await db.run(INSERT.into(MEM).entries([
      { ID: 'ma', catalog_ID: 'a', modelId: 'm1' },
      { ID: 'mb', catalog_ID: 'b', modelId: 'm1' }
    ]));

    // Both directions of the cycle, plus a self-parent, all have to come back.
    await expect(ent.pruneChildren(db, 'a', ['m1'])).resolves.toBe(1);
    await db.run(INSERT.into(MEM).entries([{ ID: 'ma2', catalog_ID: 'a', modelId: 'm2' }, { ID: 'mb2', catalog_ID: 'b', modelId: 'm2' }]));
    await expect(ent.pruneChildren(db, 'b', ['m2'])).resolves.toBe(1);
    await db.run(UPDATE(CAT).set({ parent_ID: 'a' }).where({ ID: 'a' }));
    await expect(ent.pruneChildren(db, 'a', ['m3'])).resolves.toBe(0);
    // pruning walks the children, never the root it was called on: b lost m1 to the first call
    // and a lost m2 to the second, while each root kept its own row.
    expect((await db.run(SELECT.from(MEM).where({ catalog_ID: 'a' }))).map((m: any) => m.modelId)).toEqual(['m1']);
    expect((await db.run(SELECT.from(MEM).where({ catalog_ID: 'b' }))).map((m: any) => m.modelId)).toEqual(['m2']);
  }, 15000);

  it('re-assigning a user re-parents and prunes their catalogs', async () => {
    const def = await ent.ensureDefaultCatalog(db);
    const { INSERT, SELECT } = cds.ql;
    await db.run(INSERT.into(CAT).entries([{ ID: 'p', name: 'P' }, { ID: 'k', name: 'Kid', ownerEmail: 'u@test.com', parent_ID: def.ID }]));
    await ent.addMembers(db, { ID: 'p', isDefault: false, parent_ID: null } as any, ['m1'], 'a');
    await ent.addMembers(db, { ID: 'k', isDefault: false, parent_ID: def.ID, ownerEmail: 'u@test.com' } as any, ['m1', 'm2'], 'u');
    const r = await ent.assignCatalog(db, 'u@test.com', 'p');
    expect(r).toEqual({ prunedFromChildren: 1 });
    const kid = (await db.run(SELECT.from(CAT).where({ ID: 'k' })))[0];
    expect(kid.parent_ID).toBe('p');
    const back = await ent.unassignCatalog(db, 'u@test.com');
    expect(back).toEqual({ prunedFromChildren: 0 });
    expect((await db.run(SELECT.from(CAT).where({ ID: 'k' })))[0].parent_ID).toBe(def.ID);
  });
});

describe('the default catalog is seeded, never assumed', () => {
  // entitlementBlockFor feeds the gateway. If the default row is missing it used to throw, the
  // caller swallowed that, and the validation answered with no block at all - unrestricted, and
  // cached for an hour on both sides. It must seed instead.
  it('entitlementBlockFor and entitlementFor recreate a missing default rather than throwing', async () => {
    const { DELETE, SELECT } = cds.ql;
    await ent.ensureDefaultCatalog(db);
    await db.run(DELETE.from(CAT).where({ isDefault: true }));
    expect((await db.run(SELECT.from(CAT).where({ isDefault: true }))).length).toBe(0);

    const block = await ent.entitlementBlockFor(db, 'u@test.com');
    expect(block.mode).toBe('all');
    expect(block.catalogName).toBe('Default');
    expect((await db.run(SELECT.from(CAT).where({ isDefault: true }))).length).toBe(1);

    await db.run(DELETE.from(CAT).where({ isDefault: true }));
    const ui = await ent.entitlementFor(db, 'u@test.com', false);
    expect(ui.catalog.isDefault).toBe(true);
    expect(ui.modelIds!.sort()).toEqual(['m1', 'm2', 'm3']);
    expect((await db.run(SELECT.from(CAT).where({ isDefault: true }))).length).toBe(1);
  });
});

describe('guards', () => {
  it('the default is never deletable; a catalog with dependants is 409', async () => {
    const def = await ent.ensureDefaultCatalog(db);
    await expect(ent.assertDeletable(db, def)).rejects.toMatchObject({ status: 403, code: 'default_catalog' });
    const { INSERT } = cds.ql;
    await db.run(INSERT.into(CAT).entries([{ ID: 'p', name: 'P' }, { ID: 'k', name: 'Kid', ownerEmail: 'u@test.com', parent_ID: 'p' }]));
    await ent.assignCatalog(db, 'v@test.com', 'p');
    await expect(ent.assertDeletable(db, { ID: 'p', isDefault: false } as any)).rejects.toMatchObject({ status: 409, code: 'has_dependants', details: { assignments: ['v@test.com'], children: ['k'] } });
    await expect(ent.assertDeletable(db, { ID: 'k', isDefault: false } as any)).resolves.toBeUndefined();
  });

  it('assignCatalog refuses a user-owned catalog', async () => {
    await ent.ensureDefaultCatalog(db);
    const { INSERT } = cds.ql;
    await db.run(INSERT.into(CAT).entries([{ ID: 'k', name: 'Kid', ownerEmail: 'u@test.com' }]));
    await expect(ent.assignCatalog(db, 'v@test.com', 'k')).rejects.toMatchObject({ status: 400, code: 'not_assignable' });
  });

  it('affectedEmails: assigned users for a catalog, everyone for the default', async () => {
    const def = await ent.ensureDefaultCatalog(db);
    const { INSERT } = cds.ql;
    await db.run(INSERT.into(CAT).entries([{ ID: 'p', name: 'P' }]));
    await ent.assignCatalog(db, 'v@test.com', 'p');
    expect(await ent.affectedEmails(db, 'p')).toEqual(['v@test.com']);
    expect(await ent.affectedEmails(db, def.ID)).toBe('everyone');
  });

  it('isAdminRole matches admin, Admin and *.admin only', () => {
    expect(ent.isAdminRole(['user', 'admin'])).toBe(true);
    expect(ent.isAdminRole(['xs.admin'])).toBe(true);
    expect(ent.isAdminRole(['non-admin', 'admin-readonly'])).toBe(false);
  });
});
