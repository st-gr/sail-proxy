/**
 * Entitlement catalogs (spec section 3). One module owns every rule so the OData handlers in
 * admin-service-library.ts and the validation service call the same code:
 *  - effective set: default = all non-absent LibraryModels minus exclusions; other = members
 *  - a user catalog's members ⊆ parent's effective set; shrinking a parent prunes children
 *  - the default catalog is never deletable; assigned or parent catalogs are 409
 *  - the wire block follows the ASSIGNMENT for everyone (the gateway cannot see roles)
 * Call from within a CAP request handler or a cds.tx(): the multi-statement mutations (prune,
 * remove, re-parent) rely on the ambient transaction for atomicity.
 */
import { v4 as uuidv4 } from 'uuid';
import { getDefaultLogger } from '@libs/logger';
import { USERS, isServiceKeyEmail, touch } from './usersService';
import { DEEP_CONTEXT_SUFFIX } from './pricingTwins';

const cds = require('@sap/cds');
const logger = getDefaultLogger();

const LIB = 'sap.llm.gateway.admin.LibraryModels';
const CAT = 'sap.llm.gateway.admin.ModelCatalogs';
const MEM = 'sap.llm.gateway.admin.ModelCatalogMembers';
const EXC = 'sap.llm.gateway.admin.ModelCatalogExclusions';

export const DEFAULT_CATALOG_NAME = 'Default';

export interface Catalog {
  ID: string;
  name: string;
  description?: string | null;
  isDefault: boolean;
  ownerEmail?: string | null;
  parent_ID?: string | null;
}

export interface EntitlementBlock {
  catalogId: string;
  catalogName: string;
  mode: 'all' | 'list';
  exclude?: string[];
  include?: string[];
}

export class EntitlementError extends Error {
  status: number;
  code: string;
  details?: any;
  constructor(status: number, code: string, message: string, details?: any) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isAdminRole(roles: string[]): boolean {
  return roles.some(r => typeof r === 'string' && (r === 'admin' || r === 'Admin' || r.endsWith('.admin')));
}

function uniq(ids: string[]): string[] {
  return [...new Set((ids || []).filter(id => typeof id === 'string' && id.trim().length > 0))];
}

export async function getDefaultCatalog(db: any): Promise<Catalog> {
  const { SELECT } = cds.ql;
  const rows = await db.run(SELECT.from(CAT).where({ isDefault: true }));
  if (rows.length === 0) throw new EntitlementError(500, 'no_default', 'default catalog missing');
  return rows[0];
}

export async function ensureDefaultCatalog(db: any): Promise<Catalog> {
  const { SELECT, INSERT } = cds.ql;
  const rows = await db.run(SELECT.from(CAT).where({ isDefault: true }));
  if (rows.length > 0) return rows[0];
  const row = { ID: uuidv4(), name: DEFAULT_CATALOG_NAME, description: 'Every model the gateway offers, minus the exclusions below', isDefault: true, ownerEmail: null, parent_ID: null };
  await db.run(INSERT.into(CAT).entries([row]));
  logger.info('ModelEntitlement', 'Default catalog created');
  return row as Catalog;
}

export async function getCatalog(db: any, id: string): Promise<Catalog | null> {
  const { SELECT } = cds.ql;
  const rows = await db.run(SELECT.from(CAT).where({ ID: id }));
  return rows[0] ?? null;
}

export async function getAssignedCatalog(db: any, email: string): Promise<Catalog | null> {
  const { SELECT } = cds.ql;
  const user = await db.run(SELECT.one.from(USERS).columns('entitlementCatalog_ID').where({ email }));
  if (!user?.entitlementCatalog_ID) return null;
  return getCatalog(db, user.entitlementCatalog_ID);
}

async function memberIds(db: any, catalogId: string): Promise<string[]> {
  const { SELECT } = cds.ql;
  const rows = await db.run(SELECT.from(MEM).columns('modelId').where({ catalog_ID: catalogId }));
  return rows.map((r: any) => r.modelId);
}

async function exclusionIds(db: any, catalogId: string): Promise<string[]> {
  const { SELECT } = cds.ql;
  const rows = await db.run(SELECT.from(EXC).columns('modelId').where({ catalog_ID: catalogId }));
  return rows.map((r: any) => r.modelId);
}

export async function effectiveModelIds(db: any, catalog: Catalog): Promise<Set<string>> {
  const { SELECT } = cds.ql;
  if (catalog.isDefault) {
    // A --deep-context row is a pricing-only twin of its parent sap-rpt-*-large model (see
    // librarySnapshot.deriveDeepContextRows): it is not itself callable, so it never appears as
    // an offerable model in the default catalog even though it is present and non-absent.
    const all = await db.run(SELECT.from(LIB).columns('modelId').where({ absent: false }).and('modelId not like', `%${DEEP_CONTEXT_SUFFIX}`));
    const excluded = new Set(await exclusionIds(db, catalog.ID));
    return new Set(all.map((r: any) => r.modelId).filter((id: string) => !excluded.has(id)));
  }
  return new Set(await memberIds(db, catalog.ID));
}

/**
 * UI-side entitlement: admins see everything (modelIds null); others their assignment or the
 * default. Seeds the default rather than reading it, because a missing default must not make the
 * caller unrestricted - see entitlementBlockFor.
 */
export async function entitlementFor(db: any, email: string, isAdmin: boolean): Promise<{ catalog: Catalog; modelIds: string[] | null }> {
  const catalog = (await getAssignedCatalog(db, email)) ?? (await ensureDefaultCatalog(db));
  if (isAdmin) return { catalog, modelIds: null };
  return { catalog, modelIds: [...await effectiveModelIds(db, catalog)] };
}

/**
 * Wire-side block for the gateway. Assignment only - see spec section 5, "limitation".
 * ensureDefaultCatalog, not getDefaultCatalog: a throw here is swallowed further up and the
 * caller ends up with NO block, i.e. unrestricted, which both caches then keep for an hour.
 * Seeding the missing default instead keeps the failure mode closed.
 */
export async function entitlementBlockFor(db: any, email: string): Promise<EntitlementBlock> {
  const assigned = await getAssignedCatalog(db, email);
  if (assigned && !assigned.isDefault) {
    return { catalogId: assigned.ID, catalogName: assigned.name, mode: 'list', include: await memberIds(db, assigned.ID) };
  }
  const def = assigned ?? (await ensureDefaultCatalog(db));
  const exclude = await exclusionIds(db, def.ID);
  const block: EntitlementBlock = { catalogId: def.ID, catalogName: def.name, mode: 'all' };
  if (exclude.length > 0) block.exclude = exclude;
  return block;
}

async function parentEffectiveSet(db: any, catalog: Catalog): Promise<Set<string> | null> {
  if (!catalog.parent_ID) return null;
  const parent = await getCatalog(db, catalog.parent_ID);
  if (!parent) throw new EntitlementError(500, 'parent_missing', `parent ${catalog.parent_ID} of ${catalog.ID} not found`);
  return effectiveModelIds(db, parent);
}

export async function addMembers(db: any, catalog: Catalog, modelIds: string[], actor: string): Promise<{ added: number }> {
  const { INSERT, SELECT } = cds.ql;
  const ids = uniq(modelIds);
  if (catalog.isDefault) throw new EntitlementError(400, 'default_has_no_members', 'the default catalog is defined by exclusions, not members');
  const allowed = await parentEffectiveSet(db, catalog);
  if (allowed) {
    const outside = ids.filter(id => !allowed.has(id));
    if (outside.length > 0) throw new EntitlementError(400, 'not_in_parent', `models not in the parent catalog: ${outside.join(', ')}`, outside);
  }
  const existing = new Set(await memberIds(db, catalog.ID));
  const fresh = ids.filter(id => !existing.has(id));
  if (fresh.length === 0) return { added: 0 };
  const names = await db.run(SELECT.from(LIB).columns('modelId', 'displayName').where({ modelId: { in: fresh } }));
  const nameOf = new Map(names.map((r: any) => [r.modelId, r.displayName]));
  await db.run(INSERT.into(MEM).entries(fresh.map(id => ({ ID: uuidv4(), catalog_ID: catalog.ID, modelId: id, displayName: nameOf.get(id) ?? id }))));
  logger.info('ModelEntitlement', `${actor} added ${fresh.length} model(s) to catalog ${catalog.ID}`);
  return { added: fresh.length };
}

/**
 * Prune `removedIds` from every descendant of `parentId`. The parent chain is data, not a
 * guaranteed tree: a cycle (A.parent = B, B.parent = A) would otherwise recurse forever and hang
 * the request that removed a model. `visited` carries the ids already descended into, so every
 * catalog is walked at most once and a revisit ends that branch. The UPDATE handler in
 * admin-service-library.ts refuses to create such a link in the first place; this is the second
 * line of defence for rows written before it or straight into the database.
 */
export async function pruneChildren(db: any, parentId: string, removedIds: string[], visited: Set<string> = new Set()): Promise<number> {
  const { SELECT, DELETE } = cds.ql;
  const ids = uniq(removedIds);
  if (ids.length === 0) return 0;
  if (visited.has(parentId)) return 0;
  visited.add(parentId);
  const children = await db.run(SELECT.from(CAT).columns('ID').where({ parent_ID: parentId }));
  let pruned = 0;
  for (const child of children) {
    if (visited.has(child.ID)) continue;
    const n = await db.run(DELETE.from(MEM).where({ catalog_ID: child.ID, modelId: { in: ids } }));
    pruned += typeof n === 'number' ? n : 0;
    pruned += await pruneChildren(db, child.ID, ids, visited);
  }
  return pruned;
}

export async function removeMembers(db: any, catalog: Catalog, modelIds: string[]): Promise<{ removed: number; prunedFromChildren: number }> {
  const { DELETE } = cds.ql;
  const ids = uniq(modelIds);
  if (ids.length === 0) return { removed: 0, prunedFromChildren: 0 };
  const removed = await db.run(DELETE.from(MEM).where({ catalog_ID: catalog.ID, modelId: { in: ids } }));
  const prunedFromChildren = await pruneChildren(db, catalog.ID, ids);
  return { removed: typeof removed === 'number' ? removed : 0, prunedFromChildren };
}

export async function excludeModels(db: any, defaultCatalog: Catalog, modelIds: string[], reason: string | null): Promise<{ excluded: number; prunedFromChildren: number }> {
  const { INSERT } = cds.ql;
  if (!defaultCatalog.isDefault) throw new EntitlementError(400, 'not_default', 'exclusions exist only on the default catalog');
  const ids = uniq(modelIds);
  const existing = new Set(await exclusionIds(db, defaultCatalog.ID));
  const fresh = ids.filter(id => !existing.has(id));
  if (fresh.length > 0) {
    await db.run(INSERT.into(EXC).entries(fresh.map(id => ({ ID: uuidv4(), catalog_ID: defaultCatalog.ID, modelId: id, reason: reason ?? null }))));
  }
  const prunedFromChildren = await pruneChildren(db, defaultCatalog.ID, ids);
  return { excluded: fresh.length, prunedFromChildren };
}

export async function includeModels(db: any, defaultCatalog: Catalog, modelIds: string[]): Promise<{ included: number }> {
  const { DELETE } = cds.ql;
  if (!defaultCatalog.isDefault) throw new EntitlementError(400, 'not_default', 'exclusions exist only on the default catalog');
  const ids = uniq(modelIds);
  if (ids.length === 0) return { included: 0 };
  const n = await db.run(DELETE.from(EXC).where({ catalog_ID: defaultCatalog.ID, modelId: { in: ids } }));
  return { included: typeof n === 'number' ? n : 0 };
}

/** Re-parent every catalog owned by `email` to `newParent` and prune what the new parent lacks. */
async function reparentUserCatalogs(db: any, email: string, newParent: Catalog): Promise<number> {
  const { SELECT, UPDATE } = cds.ql;
  const owned = await db.run(SELECT.from(CAT).where({ ownerEmail: email }));
  const allowed = await effectiveModelIds(db, newParent);
  let pruned = 0;
  for (const cat of owned) {
    await db.run(UPDATE(CAT).set({ parent_ID: newParent.ID }).where({ ID: cat.ID }));
    const members = await memberIds(db, cat.ID);
    const gone = members.filter(id => !allowed.has(id));
    if (gone.length > 0) {
      const r = await removeMembers(db, { ...cat, parent_ID: newParent.ID }, gone);
      pruned += r.removed + r.prunedFromChildren;
    }
  }
  return pruned;
}

export async function assignCatalog(db: any, email: string, catalogId: string): Promise<{ prunedFromChildren: number }> {
  const catalog = await getCatalog(db, catalogId);
  if (!catalog) throw new EntitlementError(404, 'catalog_not_found', `catalog ${catalogId} not found`);
  if (catalog.ownerEmail) throw new EntitlementError(400, 'not_assignable', 'only admin catalogs and the default can be assigned');
  if (isServiceKeyEmail(email)) throw new EntitlementError(400, 'not_a_user', `${email} is a platform service credential, not a user`);
  const { UPDATE } = cds.ql;
  await touch(db, email);
  await db.run(UPDATE(USERS).set({ entitlementCatalog_ID: catalog.ID }).where({ email }));
  const prunedFromChildren = await reparentUserCatalogs(db, email, catalog);
  logger.info('ModelEntitlement', `Assigned catalog ${catalog.ID} to ${email}`);
  return { prunedFromChildren };
}

export async function unassignCatalog(db: any, email: string): Promise<{ prunedFromChildren: number }> {
  await db.run(cds.ql.UPDATE(USERS).set({ entitlementCatalog_ID: null }).where({ email }));
  const def = await getDefaultCatalog(db);
  const prunedFromChildren = await reparentUserCatalogs(db, email, def);
  return { prunedFromChildren };
}

export async function assertDeletable(db: any, catalog: Catalog): Promise<void> {
  const { SELECT } = cds.ql;
  if (catalog.isDefault) throw new EntitlementError(403, 'default_catalog', 'the default catalog cannot be deleted');
  const assignments = (await db.run(SELECT.from(USERS).columns('email').where({ entitlementCatalog_ID: catalog.ID }))).map((r: any) => r.email);
  const children = (await db.run(SELECT.from(CAT).columns('ID').where({ parent_ID: catalog.ID }))).map((r: any) => r.ID);
  if (assignments.length > 0 || children.length > 0) {
    throw new EntitlementError(409, 'has_dependants', 'catalog is assigned or has child catalogs', { assignments, children });
  }
}

/** Who must have their gateway cache entries invalidated when `catalogId` changes. */
export async function affectedEmails(db: any, catalogId: string): Promise<string[] | 'everyone'> {
  const { SELECT } = cds.ql;
  const cat = await getCatalog(db, catalogId);
  if (cat?.isDefault) return 'everyone';
  const rows = await db.run(SELECT.from(USERS).columns('email').where({ entitlementCatalog_ID: catalogId }));
  return rows.map((r: any) => r.email);
}
