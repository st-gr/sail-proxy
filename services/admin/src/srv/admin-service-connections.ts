/**
 * Connections handlers (spec 2026-10-23 §4), registered on AdminService from admin-service.ts
 * init(). ProviderConnections and their ConnectionModels: validated (services/connectionValidation),
 * defaulted per provider type, audited by field name only, and announced to the gateway through
 * the Valkey change marker once the request's transaction has committed.
 *
 * CREATE is redirected to the base tables, as for QuotaProfiles: the projections are SQL views and
 * an INSERT into a view is refused by the database. Reads and writes join the request's own
 * transaction through cds.run - a cds.tx(fn) here would deadlock the admin's single SQLite
 * connection against the one the request already holds.
 */
import {
  validateConnection, connectionDefaults, validateUpstreamModel, defaultFamily, modelIdFor, FAMILIES, ProviderType,
} from '../services/connectionValidation';
import { parseServiceKey, tenantFromServiceKey, tenantFromAuthUrl } from '@libs/service-key-parser/parser';
import { deleteConnectionCredential, setConnectionCredential, maskHint, MissingConnectionKeyError, CONNECTION_KEY_ENV } from '../services/connectionCredentialStore';
import { upsertTenant, setTenantBilling } from '../services/sapTenants';
import { costRecalculationService } from '../services/costRecalculationService';
import { isProductive } from '../services/sapCapacityService';
import { quotaCurrency } from '../services/userQuotaService';
import { addPricesToModels, addPricesToExpandedModels, closeListPrices } from '../services/connectionModelPrices';
import { publishConnectionsChanged } from '../services/connectionsNotifier';
import { recordAuditEvent, AuditEventInput } from '../services/auditEventService';
import { clientContext } from '../utils/clientIp';
import * as gatewayConnections from '../services/gatewayConnectionsClient';
import { getDefaultLogger } from '@libs/logger';

const cds = require('@sap/cds');
const logger = getDefaultLogger();

export const CONNECTIONS = 'sap.llm.gateway.admin.ProviderConnections';
export const CONNECTION_MODELS = 'sap.llm.gateway.admin.ConnectionModels';
const CREDENTIALS = 'sap.llm.gateway.admin.ConnectionCredentials';
const SAP = 'sap-ai-core';
const SERVICE_MODELS = 'AdminService.ConnectionModels';
const LIBRARY = 'sap.llm.gateway.admin.LibraryModels';
const MODEL_COSTS = 'sap.llm.gateway.admin.ModelCosts';
const PRICES = 'sap.llm.gateway.admin.SapCapacityUnitPrice';
const OPEN_END = '9999-12-31T00:00:00.000Z';
const CURRENCY = /^[A-Z]{3}$/;

const actor = (req: any): string => req.user?.id || 'anonymous';
/**
 * The key of a request, whether CAP hands it over as `{ ID }` or as the bare UUID. A call made through
 * the service (srv.run) has no params: the key is then the `ID = <value>` of the query's target.
 */
export const keyId = (req: any): string => {
  const p = req.params?.[req.params.length - 1];
  if (p !== undefined) return typeof p === 'object' && p !== null ? p.ID : p;
  const where = (req.query?.DELETE?.from ?? req.query?.UPDATE?.entity)?.ref?.[0]?.where;
  return Array.isArray(where) && where[0]?.ref?.[0] === 'ID' && where[1] === '=' ? where[2]?.val : undefined as any;
};
export const audit = (req: any, action: string, resourceId: string, severity: AuditEventInput['severity'] = 'medium'): AuditEventInput => ({
  actorId: actor(req), actorType: 'admin_user', action, resourceType: 'ProviderConnection', resourceId,
  outcome: 'success', severity, ...clientContext(req)
});
const MANAGED_FIELDS: ReadonlySet<string> = new Set(['ID', 'createdAt', 'createdBy', 'modifiedAt', 'modifiedBy']);
/** What the audit trail records of an update: the fields touched, never their values. */
const fieldNames = (data: Record<string, any>): string[] => Object.keys(data || {}).filter((f) => !MANAGED_FIELDS.has(f));
/** Equal as stored: null and undefined alike, numbers and timestamps compared as text. */
const sameValue = (a: any, b: any): boolean => (a ?? null) === (b ?? null) || (a != null && b != null && String(a) === String(b));

/** Announce the change to the gateway once the request's transaction has committed; a rolled-back write announces nothing. */
export function announceOnSuccess(req: any): void {
  req.on('succeeded', () => { void publishConnectionsChanged(); });
}

/**
 * Once after the admin is up (spec 2026-10-25 §5): gateways that booted on their last-known or the
 * environment's SAP target refetch the snapshot and converge. The marker carries no target data.
 * Valkey may still be connecting at boot, so an unsent marker is retried once.
 */
export function announceConnectionsAtBoot(retryMs = 5000): void {
  // A boot hook never throws: a failure is logged and not retried (only an unsent marker is).
  const send = async (): Promise<boolean> => {
    try { return await publishConnectionsChanged(); } catch (error) {
      logger.warn('Connections', `The boot change marker was not sent: ${(error as Error)?.message ?? error}`);
      return true;
    }
  };
  void send().then((sent) => {
    if (!sent) setTimeout(() => { void send(); }, retryMs).unref?.();
  });
}

/** SQLite: "UNIQUE constraint failed"; Postgres: SQLSTATE 23505. */
function isUniqueViolation(err: any): boolean {
  return err?.code === '23505' || /UNIQUE constraint failed|duplicate key value/i.test(String(err?.message ?? err ?? ''));
}

/** Server-owned fields a client may send but never sets. */
function stripServerFields(data: Record<string, any>, fields: string[]): void {
  for (const f of fields) delete data[f];
}

// The virtuals too: draft activation hands them over with the row read from the draft.
const CONNECTION_SERVER_FIELDS = ['credentialHint', 'credentialUpdatedAt', 'lastTestAt', 'lastTestResult', 'providerTypeText', 'publishedModels'];
const MODEL_SERVER_FIELDS = ['modelId', 'isPublished'];
// sap-ai-core: what the stored service key says; set by setCredential only.
const SAP_KEY_FIELDS = ['endpoint', 'region', 'clientId', 'tenantId'];

/**
 * A deep write would reach ConnectionModels past its own handlers (computed id, immutable
 * upstream model, family check, audit): models are written through their own entity or the
 * `models` navigation only.
 */
function refuseDeepModels(req: any): boolean {
  if (!('models' in (req.data || {}))) return false;
  req.reject(400, 'models cannot be written with their connection; use the models navigation (ProviderConnections(<ID>)/models) or ConnectionModels');
  return true;
}

/**
 * name and providerType as the client sent them on an update. They are @Core.Immutable, and cds
 * drops such fields from req.data before any handler runs (a silent 200): a direct PATCH that tries
 * to change one is still refused with A's 400. Draft activation sends no body, so nothing here.
 * In a $batch (JSON or multipart) req.req is the sub-request, with that request's own body.
 */
function immutableSent(req: any): Record<string, any> {
  const body = req.req?.body;
  if (!body || typeof body !== 'object') return {};
  const sent: Record<string, any> = {};
  for (const f of ['name', 'providerType']) if (f in body) sent[f] = body[f];
  return sent;
}

/**
 * The connection actions work on the saved connection: a draft key is refused (the UI hides them
 * there too), and so is any key that is not recognisably the active one (fail closed).
 */
function refuseDraftKey(req: any): boolean {
  const p = req.params?.[req.params.length - 1];
  const isObject = typeof p === 'object' && p !== null;
  if (isObject && p.IsActiveEntity === true) return false;
  req.reject(400, isObject && p.IsActiveEntity === false
    ? 'this action works on the saved connection; save or discard the draft first'
    : 'this action needs the key of a saved connection (ID and IsActiveEntity=true)');
  return true;
}

/** SAP AI Core connections have no models of their own: the tenant's come through the Model Library. */
function rejectModels(req: any): void {
  req.reject({ status: 400, code: 'models_not_supported', message: 'SAP AI Core connections have no models of their own; the tenant\'s models come through the Model Library' });
}

/** The contexts of a running connection-delete cascade: the connection's own delete announces the change, once. */
const cascadeDeletes = new WeakSet<object>();

/** The value list of ProviderConnections.providerType: the codes of connectionValidation, texts from _i18n. */
const PROVIDER_TYPE_TEXTS: Record<ProviderType, string> = {
  'anthropic': 'connections.providerType.anthropic', 'azure-openai': 'connections.providerType.azureOpenai',
  'bedrock': 'connections.providerType.bedrock', 'openai': 'connections.providerType.openai',
  'sap-ai-core': 'connections.providerType.sapAiCore',
};

/** The value lists of ProviderConnections.apiMode and .authMode (the codes connectionValidation accepts). */
const API_MODE_TEXTS: Record<string, string> = { 'v1': 'connections.apiMode.v1', 'deployments': 'connections.apiMode.deployments' };
const AUTH_MODES: { code: string; providerType: ProviderType; key: string }[] = [
  { code: 'api-key', providerType: 'azure-openai', key: 'connections.authMode.apiKey' },
  { code: 'entra-client-secret', providerType: 'azure-openai', key: 'connections.authMode.entraClientSecret' },
  { code: 'access-key', providerType: 'bedrock', key: 'connections.authMode.accessKey' },
  { code: 'bearer', providerType: 'bedrock', key: 'connections.authMode.bearer' },
];
const label = (key: string, locale: string | undefined, fallback: string): string => cds.i18n.labels.at(key, locale) ?? fallback;

/** The value of `<field> eq '<value>'` in a read's $filter (a value list's In parameter); undefined without one. */
function filterValue(req: any, field: string): any {
  const where = req.query?.SELECT?.where;
  if (!Array.isArray(where)) return undefined;
  const i = where.findIndex((t: any, k: number) => t?.ref?.[0] === field && where[k + 1] === '=');
  return i >= 0 ? where[i + 2]?.val : undefined;
}

/**
 * Fills the virtuals of the connections a read returned: the provider type's text, and
 * publishedModels from one grouped count for the whole result. The gateway serves the active
 * rows of active connections only: an inactive connection (as saved; a draft shows its saved
 * connection's count) counts none.
 */
async function addConnectionVirtuals(result: any, locale: string | undefined): Promise<void> {
  const rows: any[] = (Array.isArray(result) ? result : [result]).filter((r) => r && r.ID);
  if (!rows.length) return;
  for (const row of rows) {
    const key = PROVIDER_TYPE_TEXTS[row.providerType as ProviderType];
    if (key) row.providerTypeText = label(key, locale, row.providerType);
  }
  const ids = rows.map((r) => r.ID);
  const counts: any[] = await cds.run(cds.ql.SELECT.from(CONNECTION_MODELS).columns('connection_ID', 'count(1) as n')
    .where({ connection_ID: { in: ids } }).and({ isPublished: true }).groupBy('connection_ID'));
  const saved: any[] = await cds.run(cds.ql.SELECT.from(CONNECTIONS).columns('ID', 'isActive').where({ ID: { in: ids } }));
  const inactive = new Set(saved.filter((c) => c.isActive === false).map((c) => c.ID));
  const countOf = new Map(counts.map((c) => [c.connection_ID, Number(c.n)]));
  for (const row of rows) row.publishedModels = inactive.has(row.ID) ? 0 : countOf.get(row.ID) ?? 0;
}

export function registerConnectionHandlers(service: any): void {
  // cds.server (cds watch, cds.test) emits 'listening'; the Docker entry point (src/index.ts) calls it itself.
  cds.once('listening', () => announceConnectionsAtBoot());

  service.on('READ', 'ConnectionProviderTypes', (req: any) => Object.entries(PROVIDER_TYPE_TEXTS)
    .map(([code, key]) => ({ code, text: cds.i18n.labels.at(key, req.locale) ?? code })));
  service.on('READ', 'ConnectionApiModes', (req: any) => Object.entries(API_MODE_TEXTS)
    .map(([code, key]) => ({ code, text: label(key, req.locale, code) })));
  service.on('READ', 'ConnectionPriceRegions', async () => {
    const rows: { region: string }[] = await cds.run(cds.ql.SELECT.distinct.from(PRICES).columns('region').where('region is not null').orderBy('region'));
    return rows.map((r) => ({ region: r.region }));
  });
  service.on('READ', 'ConnectionAuthModes', (req: any) => {
    const providerType = filterValue(req, 'providerType');
    return AUTH_MODES.filter((m) => providerType === undefined || m.providerType === providerType)
      .map((m) => ({ code: m.code, providerType: m.providerType, text: label(m.key, req.locale, m.code) }));
  });

  // The cockpit's draft of an SAP AI Core connection starts at the installation's billing classification
  // (platform.billing.productive), so the usual case is one click: its checkbox would show "not chosen" (null)
  // exactly like "non-productive". A direct create (CREATE below) still has to name productive.
  service.before('NEW', 'ProviderConnections.drafts', (req: any) => {
    if (req.data?.providerType === SAP && req.data.productive == null) req.data.productive = isProductive();
  });
  service.before('CREATE', 'ProviderConnections', async (req: any) => {
    if (refuseDeepModels(req)) return;
    stripServerFields(req.data, CONNECTION_SERVER_FIELDS);
    if (req.data.providerType === SAP) stripServerFields(req.data, SAP_KEY_FIELDS);
    const defaults = connectionDefaults(req.data.providerType);
    for (const [k, v] of Object.entries(defaults)) if (req.data[k] === undefined || req.data[k] === null) req.data[k] = v;
    // The SAP target of the installation changes through activate only: a new one starts inactive.
    if (req.data.providerType === SAP) req.data.isActive = false;
    const errors = validateConnection(req.data);
    if (errors.length) { req.reject(400, errors.join('; ')); return; }
    const clash = await cds.run(cds.ql.SELECT.one.from(CONNECTIONS).columns('ID').where({ name: req.data.name }));
    if (clash) req.reject(409, `a connection named '${req.data.name}' already exists`);
  });

  service.on('CREATE', 'ProviderConnections', async (req: any) => {
    const { INSERT, SELECT } = cds.ql;
    const now = new Date().toISOString();
    const data = { ...req.data, ID: req.data.ID ?? cds.utils.uuid(), createdAt: now, createdBy: actor(req), modifiedAt: now, modifiedBy: actor(req) };
    try {
      await cds.run(INSERT.into(CONNECTIONS).entries(data));
    } catch (err: any) {
      if (isUniqueViolation(err)) { req.reject(409, `a connection named '${data.name}' already exists`); return; }
      throw err;
    }
    await recordAuditEvent({ ...audit(req, 'connection.create', data.ID), details: JSON.stringify({ name: data.name, providerType: data.providerType }) });
    announceOnSuccess(req);
    // A direct create of the draft-enabled entity answers with req.data, not with this return value:
    // the stored row (database defaults, managed fields) goes into req.data as well.
    const row = await cds.run(SELECT.one.from(CONNECTIONS).where({ ID: data.ID }));
    Object.assign(req.data, row);
    return row;
  });

  service.before('UPDATE', 'ProviderConnections', async (req: any) => {
    if (refuseDeepModels(req)) return;
    stripServerFields(req.data, CONNECTION_SERVER_FIELDS);
    const existing = await cds.run(cds.ql.SELECT.one.from(CONNECTIONS).where({ ID: keyId(req) }));
    if (!existing) return; // the generic handler answers 404
    if (existing.providerType === SAP) stripServerFields(req.data, SAP_KEY_FIELDS);
    const errors = validateConnection({ ...req.data, ...immutableSent(req) }, existing);
    if (errors.length) { req.reject(400, errors.join('; ')); return; }
    if (existing.providerType === SAP && 'isActive' in req.data) {
      // A client's change is refused; draft activation hands over the (possibly stale) draft value, which is dropped.
      const body = req.req?.body;
      if (body && typeof body === 'object' && 'isActive' in body && !sameValue(body.isActive, existing.isActive)) {
        req.reject({ status: 400, code: 'use_activate_action', message: 'isActive of an SAP AI Core connection is set with the activate and deactivate actions' }); return;
      }
      delete req.data.isActive;
    }
    // The test gate covers the target as it serves: the active connection's resource group does not change
    // under it (deactivate first, or activate another connection); an inactive one needs a new test.
    if (existing.providerType === SAP && 'resourceGroup' in req.data && !sameValue(req.data.resourceGroup, existing.resourceGroup)) {
      if (existing.isActive) { req.reject({ status: 409, code: 'connection_active', message: 'CONNECTION_ACTIVE_RESOURCE_GROUP' }); return; }
      req.data.lastTestResult = null;
      req.data.lastTestAt = null;
    }
    // Draft activation hands over the whole row: the audit names the fields whose value changed.
    req._changedFields = fieldNames(req.data).filter((f) => !sameValue(req.data[f], existing[f]));
    if (existing.providerType === SAP && existing.tenantId) req._sapTenant = existing.tenantId;
  });

  service.after('UPDATE', 'ProviderConnections', async (_row: any, req: any) => {
    await recordAuditEvent({ ...audit(req, 'connection.update', keyId(req)), details: JSON.stringify({ fields: req._changedFields ?? fieldNames(req.data) }) });
    announceOnSuccess(req);
    // The tenant's billing follows its connection (spec 2026-10-25 §6): a changed productive flag or
    // price region goes to the tenant row in this transaction and reprices its rows after the commit.
    const billing = (req._changedFields ?? []).filter((f: string) => f === 'productive' || f === 'priceRegion');
    if (req._sapTenant && billing.length) {
      const zone: string = req._sapTenant;
      const patch = Object.fromEntries(billing.map((f: string) => [f, req.data[f] ?? null]));
      if (await setTenantBilling(zone, patch)) {
        req.on('succeeded', () => { void costRecalculationService.repriceTenant(zone); });
      }
    }
  });

  service.on(['setCredential', 'clearCredential', 'testConnection', 'fetchModels', 'addModel', 'activate', 'deactivate'], 'ProviderConnections.drafts', (req: any) => { refuseDraftKey(req); });

  // The credential is no composition child (so no read can expand it): it goes with its connection here.
  // Its models go with it, one by one through the service so each is audited and its price closed.
  service.before('DELETE', 'ProviderConnections', async (req: any) => {
    const id = keyId(req);
    const target = await cds.run(cds.ql.SELECT.one.from(CONNECTIONS).columns('providerType', 'isActive').where({ ID: id }));
    if (target?.providerType === SAP && target.isActive) {
      req.reject({ status: 409, code: 'connection_active', message: 'this SAP AI Core connection is the active SAP target; deactivate it first' }); return;
    }
    const models: { ID: string }[] = await cds.run(cds.ql.SELECT.from(CONNECTION_MODELS).columns('ID').where({ connection_ID: id }));
    // The nested deletes share this request's context; it is marked for the cascade only.
    if (req.context) cascadeDeletes.add(req.context);
    try {
      for (const m of models) await service.run(cds.ql.DELETE.from(SERVICE_MODELS, m.ID));
    } finally { cascadeDeletes.delete(req.context); }
    await deleteConnectionCredential(id);
  });

  service.after('DELETE', 'ProviderConnections', async (_row: any, req: any) => {
    await recordAuditEvent(audit(req, 'connection.delete', keyId(req)));
    announceOnSuccess(req);
  });

  service.before('CREATE', 'ConnectionModels', async (req: any) => {
    stripServerFields(req.data, MODEL_SERVER_FIELDS);
    const connectionId = req.data.connection_ID ?? (req.params?.length > 1 ? (typeof req.params[0] === 'object' ? req.params[0].ID : req.params[0]) : undefined);
    const connection = connectionId ? await cds.run(cds.ql.SELECT.one.from(CONNECTIONS).columns('ID', 'name', 'providerType').where({ ID: connectionId })) : null;
    if (!connection) { req.reject(400, 'a model belongs to an existing connection'); return; }
    if (connection.providerType === SAP) { rejectModels(req); return; }
    req.data.connection_ID = connection.ID;
    const upstreamError = validateUpstreamModel(req.data.upstreamModel);
    if (upstreamError) { req.reject(400, upstreamError); return; }
    req.data.family = req.data.family ?? defaultFamily(connection.providerType as ProviderType);
    if (!(FAMILIES as readonly string[]).includes(req.data.family)) { req.reject(400, `family must be one of ${FAMILIES.join(', ')}`); return; }
    req.data.modelId = modelIdFor(req.data.upstreamModel, connection.name);
    req.data.isPublished = false;
    // SAP wins a clash (the gateway drops the external entry), so a colliding id would never be served.
    const libraryRow = await cds.run(cds.ql.SELECT.one.from(LIBRARY).columns('modelId', 'origin').where({ modelId: req.data.modelId }));
    if (libraryRow && libraryRow.origin !== 'external') { req.reject(409, `model id '${req.data.modelId}' is already an SAP AI Core model`); return; }
    const duplicate = await cds.run(cds.ql.SELECT.one.from(CONNECTION_MODELS).columns('ID').where({ modelId: req.data.modelId }));
    if (duplicate) req.reject(409, `model id '${req.data.modelId}' already exists`);
  });

  service.on('CREATE', 'ConnectionModels', async (req: any) => {
    const { INSERT, SELECT } = cds.ql;
    const now = new Date().toISOString();
    const data = { ...req.data, ID: req.data.ID ?? cds.utils.uuid(), createdAt: now, createdBy: actor(req), modifiedAt: now, modifiedBy: actor(req) };
    try {
      await cds.run(INSERT.into(CONNECTION_MODELS).entries(data));
    } catch (err: any) {
      if (isUniqueViolation(err)) { req.reject(409, `model id '${data.modelId}' already exists`); return; }
      throw err;
    }
    await recordAuditEvent({ ...audit(req, 'connection.model.create', data.ID), details: JSON.stringify({ modelId: data.modelId }) });
    announceOnSuccess(req);
    return cds.run(SELECT.one.from(CONNECTION_MODELS).where({ ID: data.ID }));
  });

  service.before('UPDATE', 'ConnectionModels', async (req: any) => {
    stripServerFields(req.data, MODEL_SERVER_FIELDS);
    const existing = await cds.run(cds.ql.SELECT.one.from(CONNECTION_MODELS).where({ ID: keyId(req) }));
    if (!existing) return;
    if ('upstreamModel' in req.data && req.data.upstreamModel !== existing.upstreamModel) { req.reject(400, 'upstreamModel cannot be changed; add a new model instead'); return; }
    if ('connection_ID' in req.data && req.data.connection_ID !== existing.connection_ID) { req.reject(400, 'a model cannot move to another connection'); return; }
    if ('family' in req.data && !(FAMILIES as readonly string[]).includes(req.data.family)) req.reject(400, `family must be one of ${FAMILIES.join(', ')}`);
  });

  service.after('UPDATE', 'ConnectionModels', async (_row: any, req: any) => {
    await recordAuditEvent({ ...audit(req, 'connection.model.update', keyId(req)), details: JSON.stringify({ fields: fieldNames(req.data) }) });
    announceOnSuccess(req);
  });

  service.before('DELETE', 'ConnectionModels', async (req: any) => {
    const model = await cds.run(cds.ql.SELECT.one.from(CONNECTION_MODELS).columns('modelId').where({ ID: keyId(req) }));
    if (model) await closeListPrices([model.modelId]);
  });

  service.after('DELETE', 'ConnectionModels', async (_row: any, req: any) => {
    await recordAuditEvent(audit(req, 'connection.model.delete', keyId(req)));
    if (!cascadeDeletes.has(req.context)) announceOnSuccess(req);
  });

  service.after('READ', 'ConnectionModels', async (result: any) => { await addPricesToModels(result); });
  // An expanded `models` does not run the ConnectionModels read handler: its rows are enriched here.
  // providerTypeText is computed from providerType: a read that selects the text alone reads the type too.
  service.before('READ', ['ProviderConnections', 'ProviderConnections.drafts'], (req: any) => {
    const columns = req.query?.SELECT?.columns;
    const selects = (name: string) => Array.isArray(columns) && columns.some((c: any) => c?.ref?.[0] === name);
    if (selects('providerTypeText') && !selects('providerType')) columns.push({ ref: ['providerType'] });
  });
  service.after('READ', 'ProviderConnections', async (result: any, req: any) => {
    await addPricesToExpandedModels(result);
    await addConnectionVirtuals(result, req.locale);
  });
  // A draft shows the count of its active connection (models are not part of the draft).
  service.after('READ', 'ProviderConnections.drafts', async (result: any, req: any) => {
    await addPricesToExpandedModels(result);
    await addConnectionVirtuals(result, req.locale);
  });

  // The connection rules run because the model is written through the service, not the table.
  service.on('addModel', 'ProviderConnections', async (req: any) => {
    if (refuseDraftKey(req)) return;
    const owner = await cds.run(cds.ql.SELECT.one.from(CONNECTIONS).columns('providerType').where({ ID: keyId(req) }));
    if (owner?.providerType === SAP) { rejectModels(req); return; }
    const { upstreamModel, displayName, family } = req.data;
    const created = await service.run(cds.ql.INSERT.into(SERVICE_MODELS).entries({ connection_ID: keyId(req), upstreamModel, displayName, family }));
    const id = created?.ID ?? (Array.isArray(created) ? created[0]?.ID : undefined);
    return service.run(cds.ql.SELECT.one.from(SERVICE_MODELS).where({ ID: id }));
  });

  service.on('remove', 'ConnectionModels', async (req: any) => {
    const id = keyId(req);
    if (!(await cds.run(cds.ql.SELECT.one.from(CONNECTION_MODELS).columns('ID').where({ ID: id })))) { req.reject(404, 'model not found'); return; }
    await service.run(cds.ql.DELETE.from(SERVICE_MODELS, id));
  });

  service.on('setCredential', 'ProviderConnections', async (req: any) => {
    const id = keyId(req);
    // Each refusal carries a code: the cockpit's credential dialog shows its own text for it.
    const connection = await cds.run(cds.ql.SELECT.one.from(CONNECTIONS).columns('ID', 'name', 'providerType', 'authMode', 'productive', 'priceRegion', 'isActive', 'tenantId').where({ ID: id }));
    if (!connection) { req.reject({ status: 404, code: 'connection_not_found', message: 'connection not found' }); return; }
    const secret = typeof req.data.secret === 'string' ? req.data.secret.trim() : '';
    if (!secret) { req.reject({ status: 400, code: 'secret_required', message: 'secret is required' }); return; }
    const sessionToken = typeof req.data.sessionToken === 'string' && req.data.sessionToken.trim() ? req.data.sessionToken.trim() : undefined;
    if (sessionToken && !(connection.providerType === 'bedrock' && connection.authMode === 'access-key')) {
      req.reject({ status: 400, code: 'session_token_not_applicable', message: 'sessionToken applies to bedrock connections with access-key auth only' }); return;
    }
    // sap-ai-core: the secret is the service key JSON; what is stored is the gateway's target (ruling R2).
    let sap: { parsed: ReturnType<typeof parseServiceKey>; tenant: ReturnType<typeof tenantFromServiceKey> } | null = null;
    if (connection.providerType === SAP) {
      try {
        const parsed = parseServiceKey(secret);
        // One tenant name everywhere: the SAP AI Core tenant key (`<subdomain>.<landscape>` from the auth URL)
        // the gateway derives for the same key (sapTargetSync). The key's identityzone is only validated; its id is kept.
        const { zoneId } = tenantFromServiceKey(secret);
        sap = { parsed, tenant: { ...tenantFromAuthUrl(parsed.AUTH_URL, parsed.SAP_AI_CORE_URL), zoneId } };
      } catch (err) {
        // The parser's messages name a field, never a value.
        req.reject({ status: 400, code: 'service_key_invalid', message: (err as Error).message }); return;
      }
      // The active connection takes a rotated key of its own tenant only: another tenant goes through its own test.
      if (connection.isActive && sap.tenant.zone !== connection.tenantId) {
        req.reject({ status: 409, code: 'tenant_mismatch', message: 'A key of another SAP AI Core tenant: create a new connection, test it and activate it' }); return;
      }
    }
    const stored = sap
      ? { secret: JSON.stringify({ aiCoreUrl: sap.parsed.SAP_AI_CORE_URL, authUrl: sap.parsed.AUTH_URL, clientId: sap.parsed.CLIENT_ID, clientSecret: sap.parsed.CLIENT_SECRET, region: sap.parsed.SAP_AI_REGION }) }
      : sessionToken ? { secret, sessionToken } : { secret };
    try {
      await setConnectionCredential(id, stored, actor(req));
    } catch (err) {
      if (err instanceof MissingConnectionKeyError) {
        req.reject({ status: 503, code: 'credential_key_missing', message: `Connection credentials cannot be stored: ${CONNECTION_KEY_ENV} is not set` }); return;
      }
      throw err;
    }
    if (sap) {
      // The hint masks the client id (the stored JSON would mask to its brackets). A new key is untested:
      // activate asks for a passing test of this key, not of the one it replaces.
      await cds.run(cds.ql.UPDATE(CONNECTIONS).set({
        endpoint: sap.parsed.SAP_AI_CORE_URL, region: sap.parsed.SAP_AI_REGION, clientId: sap.parsed.CLIENT_ID, tenantId: sap.tenant.zone,
        credentialHint: maskHint(sap.parsed.CLIENT_ID), lastTestAt: null, lastTestResult: null,
      }).where({ ID: id }));
      await upsertTenant(sap.tenant, { productive: connection.productive ?? undefined, priceRegion: connection.priceRegion ?? null });
    }
    await recordAuditEvent({ ...audit(req, 'connection.credential.set', id, 'high'), details: JSON.stringify(sap ? { connection: connection.name, tenant: sap.tenant.zone } : { connection: connection.name }) });
    announceOnSuccess(req);
    return cds.run(cds.ql.SELECT.one.from(CONNECTIONS).where({ ID: id }));
  });

  /**
   * The one active SAP AI Core connection is the installation's SAP target (spec 2026-10-25 §4).
   * Activating one deactivates every other in the same transaction; deactivating the last returns
   * the gateway to the environment key. Both announce the change; the gateway compares fingerprints.
   */
  const sapConnection = async (req: any): Promise<any> => {
    if (refuseDraftKey(req)) return null;
    const connection = await cds.run(cds.ql.SELECT.one.from(CONNECTIONS).columns('ID', 'name', 'providerType', 'tenantId', 'lastTestResult').where({ ID: keyId(req) }));
    if (!connection) { req.reject({ status: 404, code: 'connection_not_found', message: 'connection not found' }); return null; }
    if (connection.providerType !== SAP) { req.reject({ status: 400, code: 'not_sap_ai_core', message: 'activate and deactivate apply to SAP AI Core connections only' }); return null; }
    return connection;
  };

  service.on('activate', 'ProviderConnections', async (req: any) => {
    const connection = await sapConnection(req);
    if (!connection) return;
    const credential = await cds.run(cds.ql.SELECT.one.from(CREDENTIALS).columns('ID').where({ connection_ID: connection.ID }));
    if (!credential) { req.reject({ status: 409, code: 'no_credential', message: 'store the service key before activating the connection' }); return; }
    if (connection.lastTestResult !== 'ok') { req.reject({ status: 409, code: 'test_required', message: 'test the connection successfully before activating it' }); return; }
    const { SELECT, UPDATE } = cds.ql;
    const previous: any[] = await cds.run(SELECT.from(CONNECTIONS).columns('name')
      .where({ providerType: SAP }).and({ isActive: true }).and({ ID: { '!=': connection.ID } }));
    await cds.run(UPDATE(CONNECTIONS).set({ isActive: false }).where({ providerType: SAP }).and({ ID: { '!=': connection.ID } }));
    await cds.run(UPDATE(CONNECTIONS).set({ isActive: true }).where({ ID: connection.ID }));
    await recordAuditEvent({ ...audit(req, 'connection.sap.activate', connection.ID, 'high'),
      details: JSON.stringify({ connection: connection.name, tenant: connection.tenantId ?? null, deactivated: previous.map((p) => p.name) }) });
    announceOnSuccess(req);
    return cds.run(SELECT.one.from(CONNECTIONS).where({ ID: connection.ID }));
  });

  service.on('deactivate', 'ProviderConnections', async (req: any) => {
    const connection = await sapConnection(req);
    if (!connection) return;
    await cds.run(cds.ql.UPDATE(CONNECTIONS).set({ isActive: false }).where({ ID: connection.ID }));
    await recordAuditEvent({ ...audit(req, 'connection.sap.deactivate', connection.ID, 'high'),
      details: JSON.stringify({ connection: connection.name, tenant: connection.tenantId ?? null }) });
    announceOnSuccess(req);
    return cds.run(cds.ql.SELECT.one.from(CONNECTIONS).where({ ID: connection.ID }));
  });

  service.on('clearCredential', 'ProviderConnections', async (req: any) => {
    const id = keyId(req);
    const connection = await cds.run(cds.ql.SELECT.one.from(CONNECTIONS).columns('ID', 'name', 'providerType', 'isActive').where({ ID: id }));
    if (!connection) { req.reject(404, 'connection not found'); return; }
    // The active SAP target without a key would leave the gateway with nothing to call: deactivate first (as for delete).
    if (connection.providerType === SAP && connection.isActive) {
      req.reject({ status: 409, code: 'connection_active', message: 'this SAP AI Core connection is the active SAP target; deactivate it first' }); return;
    }
    await deleteConnectionCredential(id);
    await recordAuditEvent({ ...audit(req, 'connection.credential.clear', id, 'high'), details: JSON.stringify({ connection: connection.name }) });
    announceOnSuccess(req);
    return cds.run(cds.ql.SELECT.one.from(CONNECTIONS).where({ ID: id }));
  });

  /**
   * A gateway 401/403 refused the admin's own service key, not the cockpit user: passed on as such it
   * would read as the user's sign-in failing (and a Basic-auth 401 freezes the browser tab). 502.
   */
  const cockpitStatus = (status: number): number => (status === 401 || status === 403 ? 502 : status);

  /**
   * The gateway's snapshot holds active connections only, so it answers 404 for an inactive one.
   * Asked after the gateway call, never before: a read first would hold the request's SQLite
   * connection across the call, and the gateway's key validation calling back would hang.
   */
  const isInactive = async (e: any, id: string): Promise<boolean> => {
    if (!(e instanceof gatewayConnections.GatewayConnectionsError) || e.status !== 404 || e.code !== 'connection_not_found') return false;
    const connection = await cds.run(cds.ql.SELECT.one.from(CONNECTIONS).columns('isActive').where({ ID: id }));
    return !!connection && !connection.isActive;
  };

  // The gateway is called before this handler touches the database: it calls back into the admin
  // (key validation, the snapshot), and on SQLite the request must not hold the one connection then.
  service.on('testConnection', 'ProviderConnections', async (req: any) => {
    const id = keyId(req);
    let result: gatewayConnections.ConnectionTestResult;
    try {
      result = await gatewayConnections.testConnection(id);
    } catch (e: any) {
      if (await isInactive(e, id)) result = { ok: false, error: { reason: 'inactive' } };
      else if (e instanceof gatewayConnections.GatewayConnectionsError) { req.reject(cockpitStatus(e.status), `${e.code}: ${e.message}`); return; }
      else throw e;
    }
    const failure = result.ok ? null : result.error;
    const summary = failure ? `${failure.reason}${failure.status ? `:${failure.status}` : ''}` : 'ok';
    await cds.run(cds.ql.UPDATE(CONNECTIONS).set({ lastTestAt: new Date().toISOString(), lastTestResult: summary.slice(0, 500) }).where({ ID: id }));
    await recordAuditEvent({ ...audit(req, 'connection.test', id, 'low'), details: JSON.stringify({ result: summary }) });
    return { ok: result.ok, reason: failure?.reason ?? null, status: failure?.status ?? null, code: failure?.code ?? null };
  });

  service.on('fetchModels', 'ProviderConnections', async (req: any) => {
    try {
      return await gatewayConnections.listConnectionModels(keyId(req));
    } catch (e: any) {
      if (await isInactive(e, keyId(req))) { req.reject(409, 'The connection is not active; activate it to list its models.'); return; }
      if (e instanceof gatewayConnections.GatewayConnectionsError) { req.reject(cockpitStatus(e.status), `${e.code}: ${e.message}`); return; }
      throw e;
    }
  });

  service.on('setListPrice', 'ConnectionModels', async (req: any) => {
    const id = keyId(req);
    const model = await cds.run(cds.ql.SELECT.one.from(CONNECTION_MODELS).columns('ID', 'modelId', 'displayName', 'connection_ID').where({ ID: id }));
    if (!model) { req.reject(404, 'model not found'); return; }
    const price = (field: string, required: boolean): number | null | undefined => {
      const raw = req.data[field];
      if (raw === undefined || raw === null || raw === '') return required ? undefined : null;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    };
    const inputCost = price('inputCost', true);
    const outputCost = price('outputCost', true);
    const cacheReadCost = price('cacheReadCost', false);
    const cacheCreationCost = price('cacheCreationCost', false);
    if (inputCost === undefined || outputCost === undefined || cacheReadCost === undefined || cacheCreationCost === undefined) {
      req.reject(400, 'inputCost and outputCost are required; every cost is a number >= 0 per 1K tokens'); return;
    }
    const now = new Date();
    const currency = req.data.currency ?? await quotaCurrency(now);
    if (typeof currency !== 'string' || !CURRENCY.test(currency)) { req.reject(400, 'currency must be a three-letter upper-case ISO code'); return; }
    const connection = await cds.run(cds.ql.SELECT.one.from(CONNECTIONS).columns('providerType').where({ ID: model.connection_ID }));
    const { UPDATE, INSERT } = cds.ql;
    const nowIso = now.toISOString();
    await cds.run(UPDATE(MODEL_COSTS).set({ dateTo: nowIso })
      .where({ model: model.modelId }).and({ pricingKind: 'list_price' }).and({ dateTo: { '>': nowIso } }));
    await cds.run(INSERT.into(MODEL_COSTS).entries({
      model: model.modelId, displayName: model.displayName ?? model.modelId, dateFrom: nowIso, dateTo: OPEN_END,
      inputCost, outputCost, cacheReadInputCost: cacheReadCost, cacheCreationInputCost: cacheCreationCost,
      provider: connection?.providerType ?? null, source: 'manual', pricingKind: 'list_price', currency,
    }));
    await recordAuditEvent({ ...audit(req, 'connection.price.set', id), details: JSON.stringify({ modelId: model.modelId, inputCost, outputCost, cacheReadCost, cacheCreationCost, currency }) });
    announceOnSuccess(req);
    return service.run(cds.ql.SELECT.one.from(SERVICE_MODELS).where({ ID: id }));
  });

  service.on('publish', 'ConnectionModels', async (req: any) => setPublished(req, true));
  service.on('unpublish', 'ConnectionModels', async (req: any) => setPublished(req, false));
}

/** True when the model has a list price in force at `now`: no price, no inference. */
export async function hasActiveListPrice(modelId: string, now: Date = new Date()): Promise<boolean> {
  const nowIso = now.toISOString();
  const row = await cds.run(cds.ql.SELECT.one.from(MODEL_COSTS).columns('ID')
    .where({ model: modelId }).and({ pricingKind: 'list_price' }).and({ dateFrom: { '<=': nowIso } }).and({ dateTo: { '>': nowIso } }));
  return !!row;
}

async function setPublished(req: any, published: boolean): Promise<any> {
  const id = keyId(req);
  const model = await cds.run(cds.ql.SELECT.one.from(CONNECTION_MODELS).columns('ID', 'modelId').where({ ID: id }));
  if (!model) { req.reject(404, 'model not found'); return; }
  if (published && !(await hasActiveListPrice(model.modelId))) {
    req.reject({ status: 409, code: 'model_unpriced', message: `model_unpriced: set a list price for ${model.modelId} before publishing it` });
    return;
  }
  await cds.run(cds.ql.UPDATE(CONNECTION_MODELS).set({ isPublished: published }).where({ ID: id }));
  await recordAuditEvent({ ...audit(req, published ? 'connection.model.publish' : 'connection.model.unpublish', id), details: JSON.stringify({ modelId: model.modelId }) });
  announceOnSuccess(req);
  return cds.run(cds.ql.SELECT.one.from(CONNECTION_MODELS).where({ ID: id }));
}
