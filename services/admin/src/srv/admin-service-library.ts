/**
 * Model Library handlers (spec sections 3 and 4), registered on AdminService from
 * admin-service.ts init(). Kept out of admin-service.ts on purpose. All rules live in
 * services/modelEntitlementService.ts; this file only maps requests to them and errors to
 * HTTP statuses.
 */
import { getDefaultLogger } from '@libs/logger';
import * as ent from '../services/modelEntitlementService';
import * as gw from '../services/gatewayDeploymentClient';
import { setManualPrice, revertToSapPrice } from '../services/modelPriceService';
import { modelCostService } from '../services/modelCostService';
import { recordAuditEvent, AuditEventInput } from '../services/auditEventService';
import { invalidateForEmails } from '../services/credentialInvalidation';
import { cuFactor as configuredCuFactor, isProductive, SAP_CU_FACTOR } from '../services/sapCapacityService';
import { clientContext } from '../utils/clientIp';
import { USERS, backfillUsers } from '../services/usersService';
import * as profiles from '../services/quotaProfilesService';

const cds = require('@sap/cds');
const logger = getDefaultLogger();

function roles(req: any): string[] {
  const r = req.user?.roles || req.user?.scope || [];
  return Array.isArray(r) ? r : Object.keys(r);
}
const isAdmin = (req: any) => ent.isAdminRole(roles(req));
const email = (req: any): string => req.user?.id || 'anonymous';

/**
 * Input rejected by a service's own argument validation - modelPriceService.assertPrice and
 * revertToSapPrice both throw plain Errors with these wordings. They are the caller's fault,
 * so they must not be reported as a server error.
 */
const CALLER_ERROR = /must be|is required|no SAP price/;

/**
 * Map an EntitlementError onto the HTTP status it carries. The message already names the
 * offending model ids where the rule is about models; only the dependants of a 409 need
 * spelling out, so that the caller sees who blocks the delete. A plain Error is a 400 when it
 * reads as bad input and a logged 500 otherwise.
 */
function fail(req: any, e: any): void {
  if (e instanceof ent.EntitlementError) {
    const d = e.details;
    const suffix = d && Array.isArray(d.assignments) && Array.isArray(d.children)
      ? ` (assigned to: ${d.assignments.join(', ') || '-'}; children: ${d.children.join(', ') || '-'})`
      : '';
    req.reject(e.status, `${e.message}${suffix}`);
    return;
  }
  const message = e instanceof Error ? e.message : String(e);
  if (CALLER_ERROR.test(message)) { req.reject(400, message); return; }
  logger.error('AdminService/Library', 'unexpected error', e instanceof Error ? e : new Error(String(e)));
  req.reject(500, message);
}

async function audit(req: any, action: string, resourceId: string, details?: any, resourceType = 'ModelCatalog'): Promise<void> {
  await recordAuditEvent({
    actorId: email(req), actorType: isAdmin(req) ? 'admin_user' : 'user', action, resourceType, resourceId,
    outcome: 'success', severity: 'low', ...clientContext(req), details: details ? JSON.stringify(details).slice(0, 1000) : undefined
  });
}

/**
 * An audit write must never decide the outcome of the action it records: a throwing audit would
 * otherwise turn a deployment that AI Core actually created into a 502, or a gateway 409 into a
 * 500. recordAuditEvent swallows its own failures today, so this is the guard that keeps that
 * property from depending on it.
 */
async function safeAudit(event: AuditEventInput): Promise<void> {
  try {
    await recordAuditEvent(event);
  } catch (e) {
    logger.warn('AdminService/Library', `audit event ${event.action} for ${event.resourceId} not recorded: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * The key of the entity a request is bound to. The shape of req.params[0] is not uniform in
 * this CAP version: ModelCatalogs (single UUID key) yields the bare id string for DELETE and
 * for every bound action, while LibraryModels yields { modelId: '…' }. Both are handled.
 */
const keyOf = (req: any, name: string): string => {
  const p = req.params?.[0];
  return p && typeof p === 'object' ? p[name] : p;
};

async function catalogFromReq(db: any, req: any): Promise<ent.Catalog> {
  const id = keyOf(req, 'ID');
  const cat = await ent.getCatalog(db, id);
  if (!cat) throw new ent.EntitlementError(404, 'catalog_not_found', `catalog ${id} not found`);
  return cat;
}

/**
 * The catalogs a non-admin caller may see at all: the ones they own, the one assigned to them,
 * and the default. Used to row-filter ModelCatalogMembers and ModelCatalogExclusions, whose
 * own READ would otherwise expose every catalog through $expand=catalog - the before-READ
 * handler on ModelCatalogs does not run for an expanded target.
 */
async function visibleCatalogIds(db: any, req: any): Promise<string[]> {
  const { SELECT } = cds.ql;
  const ids = new Set<string>();
  const owned = await db.run(SELECT.from('sap.llm.gateway.admin.ModelCatalogs').columns('ID').where({ ownerEmail: email(req) }));
  owned.forEach((c: any) => ids.add(c.ID));
  const assigned = await ent.getAssignedCatalog(db, email(req));
  if (assigned) ids.add(assigned.ID);
  ids.add((await ent.getDefaultCatalog(db)).ID);
  return [...ids];
}

function assertOwnerOrAdmin(req: any, cat: ent.Catalog): void {
  if (isAdmin(req)) return;
  if (cat.ownerEmail !== email(req)) throw new ent.EntitlementError(403, 'forbidden', 'not your catalog');
}

/**
 * Active ApiConfigurations row's configData, else the file the admin reads for platform.*
 * values. Both carry the same document, which is stored either wrapped in an `api_config`
 * key (as api_config.json is on disk) or already unwrapped, so unwrap once here.
 */
async function activeConfigJson(db: any): Promise<any> {
  const { SELECT } = cds.ql;
  const unwrap = (o: any) => (o && typeof o === 'object' ? (o.api_config ?? o) : {});
  const rows = await db.run(SELECT.from('sap.llm.gateway.admin.ApiConfigurations').where({ isActive: true }).orderBy('version desc').limit(1));
  if (rows.length > 0 && rows[0].configData) {
    try { return unwrap(JSON.parse(rows[0].configData)); } catch { /* fall through */ }
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs'); const path = require('path');
  try { return unwrap(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../api_config.json'), 'utf8'))); } catch { return {}; }
}

export function registerLibraryHandlers(service: any): void {
  // ---- LibraryModels: entitlement filter -------------------------------------------------
  service.before('READ', 'LibraryModels', async (req: any) => {
    const db = await cds.connect.to('db');
    req.query.where({ absent: false });
    if (isAdmin(req)) return;
    const { catalog } = await ent.entitlementFor(db, email(req), false);
    if (catalog.isDefault) {
      const { SELECT } = cds.ql;
      const excluded = (await db.run(SELECT.from('sap.llm.gateway.admin.ModelCatalogExclusions').columns('modelId').where({ catalog_ID: catalog.ID }))).map((r: any) => r.modelId);
      if (excluded.length > 0) req.query.where({ modelId: { 'not in': excluded } });
    } else {
      const ids = [...await ent.effectiveModelIds(db, catalog)];
      req.query.where({ modelId: { in: ids.length ? ids : ['__none__'] } });
    }
  });

  // ---- ModelCatalogs: row and column rules ------------------------------------------------
  service.before('READ', 'ModelCatalogs', async (req: any) => {
    if (isAdmin(req)) return;
    const db = await cds.connect.to('db');
    const assigned = await ent.getAssignedCatalog(db, email(req));
    const xpr: any[] = [{ ref: ['ownerEmail'] }, '=', { val: email(req) }, 'or', { ref: ['isDefault'] }, '=', { val: true }];
    if (assigned) xpr.push('or', { ref: ['ID'] }, '=', { val: assigned.ID });
    req.query.where(xpr);
  });

  service.before('CREATE', 'ModelCatalogs', async (req: any) => {
    if (req.data.members || req.data.exclusions) { req.reject(400, 'members and exclusions are maintained through addModels/removeModels/excludeModels/includeModels'); return; }
    req.data.isDefault = false;
    if (isAdmin(req)) {
      if (req.data.ownerEmail) { /* an admin may create a catalog on behalf of a user */
        const db = await cds.connect.to('db');
        const parent = (await ent.getAssignedCatalog(db, req.data.ownerEmail)) ?? (await ent.getDefaultCatalog(db));
        req.data.parent_ID = parent.ID;
      } else {
        req.data.parent_ID = null;
      }
      return;
    }
    const db = await cds.connect.to('db');
    const parent = (await ent.getAssignedCatalog(db, email(req))) ?? (await ent.getDefaultCatalog(db));
    req.data.ownerEmail = email(req);
    req.data.parent_ID = parent.ID;
  });

  service.before('UPDATE', 'ModelCatalogs', async (req: any) => {
    const db = await cds.connect.to('db');
    const cat = await ent.getCatalog(db, req.data.ID ?? keyOf(req, 'ID'));
    if (!cat) { req.reject(404, 'catalog not found'); return; }
    (req as any)._libCatalogBefore = cat;   // pre-image for the after-UPDATE invalidation
    if (req.data.members || req.data.exclusions) { req.reject(400, 'members and exclusions are maintained through the bound actions'); return; }
    if ('isDefault' in req.data && req.data.isDefault !== cat.isDefault) { req.reject(400, 'isDefault cannot be changed'); return; }
    // Only admin catalogs and the default are roots (spec section 3), and only they may be a
    // parent. Without this an admin could PATCH A.parent = B and B.parent = A, and the prune
    // walk that every removeModels/excludeModels performs would then cycle.
    if ('parent_ID' in req.data && req.data.parent_ID !== null && req.data.parent_ID !== undefined) {
      if (!cat.ownerEmail) { req.reject(400, 'admin catalogs and the default are roots and cannot have a parent'); return; }
      if (req.data.parent_ID === cat.ID) { req.reject(400, 'a catalog cannot be its own parent'); return; }
      const parent = await ent.getCatalog(db, req.data.parent_ID);
      if (!parent) { req.reject(400, `parent catalog ${req.data.parent_ID} not found`); return; }
      if (parent.ownerEmail) { req.reject(400, 'only admin catalogs and the default can be parents'); return; }
    }
    if (!isAdmin(req)) {
      if (cat.ownerEmail !== email(req)) { req.reject(403, 'not your catalog'); return; }
      for (const f of ['ownerEmail', 'parent_ID', 'isDefault']) if (f in req.data && req.data[f] !== (cat as any)[f]) { req.reject(400, `${f} cannot be changed`); return; }
    }
  });

  /**
   * CREATE has to be redirected onto the base table: the deployed AdminService_ModelCatalogs is
   * a SQL view, and an INSERT into a view is rejected by the database (UPDATE and DELETE are
   * resolved to the base table by cqn4sql, CREATE is not). Same redirect the ApiKeys and
   * SapCapacityUnitPrice handlers in admin-service.ts do.
   */
  service.on('CREATE', 'ModelCatalogs', async (req: any) => {
    const tx = cds.transaction(req);
    const { INSERT, SELECT } = cds.ql;
    const data = { ...req.data };
    data.ID ??= cds.utils.uuid();
    const now = new Date().toISOString();
    data.createdAt = now; data.createdBy = email(req);
    data.modifiedAt = now; data.modifiedBy = email(req);
    await tx.run(INSERT.into('sap.llm.gateway.admin.ModelCatalogs').entries(data));
    return tx.run(SELECT.one.from('sap.llm.gateway.admin.ModelCatalogs').where({ ID: data.ID }));
  });

  service.before('DELETE', 'ModelCatalogs', async (req: any) => {
    const db = await cds.connect.to('db');
    try {
      const cat = await catalogFromReq(db, req);
      assertOwnerOrAdmin(req, cat);
      await ent.assertDeletable(db, cat);
    } catch (e) { fail(req, e); }
  });
  service.after('DELETE', 'ModelCatalogs', async (_res: any, req: any) => { await audit(req, 'model_catalog.delete', String(keyOf(req, 'ID'))); });

  service.after('CREATE', 'ModelCatalogs', async (res: any, req: any) => {
    await audit(req, 'model_catalog.create', String(res?.ID ?? req.data?.ID), { name: req.data?.name, parent_ID: res?.parent_ID ?? null, ownerEmail: res?.ownerEmail ?? null });
  });

  service.after('UPDATE', 'ModelCatalogs', async (res: any, req: any) => {
    const id = String(res?.ID ?? req.data?.ID ?? keyOf(req, 'ID'));
    await audit(req, 'model_catalog.update', id, { fields: Object.keys(req.data || {}) });
    // Re-parenting a catalog changes what its assignees may reach, so their cached gateway
    // validations have to go. Only an admin can get here with a changed parent (the UPDATE
    // before-handler refuses it for owners), and DELETE needs no invalidation because
    // assertDeletable has already proved the catalog has neither assignees nor children.
    const before = (req as any)._libCatalogBefore;
    if (before && 'parent_ID' in (req.data || {}) && req.data.parent_ID !== before.parent_ID) {
      const db = await cds.connect.to('db');
      await invalidateForEmails(db, await ent.affectedEmails(db, id), 'entitlement');
    }
  });

  service.before('READ', ['ModelCatalogMembers', 'ModelCatalogExclusions'], async (req: any) => {
    if (isAdmin(req)) return;
    const db = await cds.connect.to('db');
    try {
      const ids = await visibleCatalogIds(db, req);
      req.query.where({ catalog_ID: { in: ids.length ? ids : ['__none__'] } });
    } catch (e) { fail(req, e); }
  });

  for (const entity of ['ModelCatalogMembers', 'ModelCatalogExclusions']) {
    for (const op of ['CREATE', 'UPDATE', 'DELETE']) {
      service.before(op, entity, (req: any) => { req.reject(405, `${entity} is maintained through the ModelCatalogs bound actions`); });
    }
  }

  // ---- bound actions on ModelCatalogs -----------------------------------------------------
  service.on('addModels', 'ModelCatalogs', async (req: any) => {
    const db = await cds.connect.to('db');
    try {
      const cat = await catalogFromReq(db, req);
      assertOwnerOrAdmin(req, cat);
      const r = await ent.addMembers(db, cat, req.data.modelIds || [], email(req));
      await audit(req, 'model_catalog.add_models', cat.ID, { modelIds: req.data.modelIds });
      await invalidateForEmails(db, await ent.affectedEmails(db, cat.ID), 'entitlement');
      return { added: r.added, prunedFromChildren: 0 };
    } catch (e) { return fail(req, e); }
  });

  service.on('removeModels', 'ModelCatalogs', async (req: any) => {
    const db = await cds.connect.to('db');
    try {
      const cat = await catalogFromReq(db, req);
      assertOwnerOrAdmin(req, cat);
      const r = await ent.removeMembers(db, cat, req.data.modelIds || []);
      await audit(req, 'model_catalog.remove_models', cat.ID, { modelIds: req.data.modelIds, ...r });
      await invalidateForEmails(db, await ent.affectedEmails(db, cat.ID), 'entitlement');
      return r;
    } catch (e) { return fail(req, e); }
  });

  service.on('excludeModels', 'ModelCatalogs', async (req: any) => {
    const db = await cds.connect.to('db');
    try {
      const cat = await catalogFromReq(db, req);
      const r = await ent.excludeModels(db, cat, req.data.modelIds || [], req.data.reason ?? null);
      await audit(req, 'model_catalog.exclude_models', cat.ID, { modelIds: req.data.modelIds, reason: req.data.reason, ...r });
      await invalidateForEmails(db, 'everyone', 'entitlement');
      return r;
    } catch (e) { return fail(req, e); }
  });

  service.on('includeModels', 'ModelCatalogs', async (req: any) => {
    const db = await cds.connect.to('db');
    try {
      const cat = await catalogFromReq(db, req);
      const r = await ent.includeModels(db, cat, req.data.modelIds || []);
      await audit(req, 'model_catalog.include_models', cat.ID, { modelIds: req.data.modelIds, ...r });
      await invalidateForEmails(db, 'everyone', 'entitlement');
      return r;
    } catch (e) { return fail(req, e); }
  });

  // ---- unbound ----------------------------------------------------------------------------
  service.on('myEntitlement', async (req: any) => {
    const db = await cds.connect.to('db');
    const { catalog, modelIds } = await ent.entitlementFor(db, email(req), isAdmin(req));
    return { catalog: { ID: catalog.ID, name: catalog.name, isDefault: catalog.isDefault }, modelIds: modelIds ?? [], unrestricted: modelIds === null };
  });

  service.on('assignCatalog', async (req: any) => {
    const db = await cds.connect.to('db');
    try {
      const r = await ent.assignCatalog(db, req.data.email, req.data.catalogId);
      await audit(req, 'model_catalog.assign', req.data.catalogId, { email: req.data.email, ...r });
      await invalidateForEmails(db, [req.data.email], 'entitlement');
      return r;
    } catch (e) { return fail(req, e); }
  });

  service.on('unassignCatalog', async (req: any) => {
    const db = await cds.connect.to('db');
    try {
      const r = await ent.unassignCatalog(db, req.data.email);
      await audit(req, 'model_catalog.unassign', 'default', { email: req.data.email, ...r });
      await invalidateForEmails(db, [req.data.email], 'entitlement');
      return r;
    } catch (e) { return fail(req, e); }
  });

  service.on('libraryUsers', async () => {
    const db = await cds.connect.to('db');
    const { SELECT } = cds.ql;
    // Self-healing: credentials that were inserted without a touch still get their row here.
    await backfillUsers(db);
    const rows = await db.run(SELECT.from(USERS).columns('email', 'displayName', 'status', 'entitlementCatalog_ID').orderBy('email'));
    const catalogs = await db.run(SELECT.from('sap.llm.gateway.admin.ModelCatalogs').columns('ID', 'name'));
    const nameOf = new Map<string, string>(catalogs.map((c: any) => [c.ID, c.name]));
    return rows.map((u: any) => ({
      email: u.email, displayName: u.displayName ?? null, status: u.status,
      catalogId: u.entitlementCatalog_ID ?? null,
      catalogName: u.entitlementCatalog_ID ? nameOf.get(u.entitlementCatalog_ID) ?? null : null
    }));
  });

  service.on('refreshModelLibrary', async (req: any) => {
    try {
      const r = await modelCostService.refreshFromGateway();
      await audit(req, 'model_library.refresh', 'gateway', r, 'ModelLibrary');
      // A refresh can add or retire models, which changes the default catalog's effective set
      // for everyone - not just the assignees of one catalog.
      await invalidateForEmails(await cds.connect.to('db'), 'everyone', 'entitlement');
      return r;
    } catch (e) { return fail(req, e); }
  });

  // ---- LibraryModels bound: prices and config context ------------------------------------
  const modelIdOf = (req: any) => keyOf(req, 'modelId');

  // The audit call sits outside the guarded block on purpose: only the write itself may turn
  // into an error status, so a failing audit can never be reported as a rejected price change.
  service.on('setPrice', 'LibraryModels', async (req: any) => {
    const db = await cds.connect.to('db');
    let row: any;
    try {
      row = await setManualPrice(db, { modelId: modelIdOf(req), inputCost: req.data.inputCost, outputCost: req.data.outputCost, cacheReadInputCost: req.data.cacheReadInputCost, cacheCreationInputCost: req.data.cacheCreationInputCost, actor: email(req) });
    } catch (e) { return fail(req, e); }
    await safeAudit({ actorId: email(req), actorType: 'admin_user', action: 'model_price.set', resourceType: 'ModelCosts', resourceId: modelIdOf(req), outcome: 'success', severity: 'medium', ...clientContext(req), details: JSON.stringify(req.data) });
    return row;
  });

  service.on('revertToSapPrice', 'LibraryModels', async (req: any) => {
    const db = await cds.connect.to('db');
    let row: any;
    try {
      row = await revertToSapPrice(db, modelIdOf(req), email(req));
    } catch (e) { return fail(req, e); }
    await safeAudit({ actorId: email(req), actorType: 'admin_user', action: 'model_price.revert', resourceType: 'ModelCosts', resourceId: modelIdOf(req), outcome: 'success', severity: 'medium', ...clientContext(req) });
    return row;
  });

  service.on('configContext', 'LibraryModels', async (req: any) => {
    const db = await cds.connect.to('db');
    const modelId = modelIdOf(req);
    const { SELECT } = cds.ql;
    const model = (await db.run(SELECT.from('sap.llm.gateway.admin.LibraryModels').where({ modelId })))[0];
    const cfg = await activeConfigJson(db);
    const override = cfg?.models?.overrides?.[modelId] ?? null;
    const providerKey = model?.provider ? String(model.provider).toLowerCase().replace(/\s+/g, '-') : null;
    const providerSettings = providerKey ? (cfg?.providers?.[providerKey] ?? cfg?.providers?.[model.provider] ?? null) : null;
    const configured = cfg?.platform?.billing?.cuFactor;
    const fromConfig = typeof configured === 'number' && configured > 0;
    return {
      override: override ? JSON.stringify(override) : null,
      providerSettings: providerSettings ? JSON.stringify(providerSettings) : null,
      cuFactor: fromConfig ? configured : (configuredCuFactor() || SAP_CU_FACTOR),
      cuFactorSource: fromConfig ? 'config' : 'default',
      productive: typeof cfg?.platform?.billing?.productive === 'boolean' ? cfg.platform.billing.productive : isProductive()
    };
  });

  // ---- deployments: the admin never holds AI Core credentials, the gateway does ------------
  /**
   * A GatewayDeploymentError already carries the status the gateway answered with, so it is
   * passed straight through - a 409 deployment_exists must not turn into a 500. The offending
   * deployment is named in the message, because the client needs it to poll or reuse.
   */
  const gwFail = (req: any, e: any) => {
    if (e instanceof gw.GatewayDeploymentError) { req.reject(e.status, `${e.message}${e.details?.deploymentId ? ` (deployment ${e.details.deploymentId}, ${e.details.status})` : ''}`); return; }
    req.reject(502, e instanceof Error ? e.message : String(e));
  };

  /**
   * The library lists a deployable model twice: '<model>' and the '<model>--deployed' alias for
   * the running deployment. Both refer to the same AI Core model name, so strip the suffix.
   */
  const deployableModelOf = (req: any): string => {
    const modelId = modelIdOf(req);
    return modelId.endsWith('--deployed') ? modelId.slice(0, -'--deployed'.length) : modelId;
  };

  service.on('fetchDeployments', 'LibraryModels', async (req: any) => {
    try {
      return await gw.listDeployments(deployableModelOf(req));
    } catch (e) { return gwFail(req, e); }
  });

  // Only the gateway call may decide the status: an audit after it can no longer reclassify a
  // deployment that was really created, and an audit in the catch can no longer swallow the
  // gateway's own 404/409.
  service.on('deploy', 'LibraryModels', async (req: any) => {
    const base = deployableModelOf(req);
    let r: { deploymentId: string; status: string; configurationId: string; reusedConfiguration: boolean };
    try {
      r = await gw.createDeployment(base);
    } catch (e) {
      await safeAudit({ actorId: email(req), actorType: 'admin_user', action: 'model_deployment.create', resourceType: 'Deployment', resourceId: base, outcome: 'failure', severity: 'high', ...clientContext(req), details: e instanceof Error ? e.message : String(e) });
      return gwFail(req, e);
    }
    await safeAudit({ actorId: email(req), actorType: 'admin_user', action: 'model_deployment.create', resourceType: 'Deployment', resourceId: r.deploymentId, outcome: 'success', severity: 'high', ...clientContext(req), details: JSON.stringify({ model: base, ...r }) });
    return r;
  });

  service.on('deploymentStatus', async (req: any) => {
    try { return await gw.deploymentStatus(req.data.deploymentId); } catch (e) { return gwFail(req, e); }
  });
}

/** Startup: guarantee the default catalog and the starter quota profiles exist (both idempotent). */
export async function initializeModelLibrary(): Promise<void> {
  try {
    const db = await cds.connect.to('db');
    await ent.ensureDefaultCatalog(db);
    await profiles.ensureStarterProfiles(db);
  } catch (e) {
    logger.warn('AdminService/Library', `default catalog / starter profile seed failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
