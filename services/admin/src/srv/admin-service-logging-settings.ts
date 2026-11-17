/**
 * getLoggingSettings, setLoggingSettings, resetLoggingSettings on AdminService (admin only, see
 * admin-service.cds): the logging switches and levels kept outside the configuration versions
 * (services/loggingSettings.ts). A writing action validates, writes the record in one short
 * transaction, records one audit event `logging.settings.change`, then hands the configuration to
 * the gateway again through the activation's publish, without a new version.
 *
 * Every database access is its own short cds.tx, and none touches the request's transaction: the
 * admin's SQLite has one connection, and no transaction may stay open across the publish.
 */
import { getDefaultLogger } from '@libs/logger';
import {
  LOGGING_SETTINGS_ENTITY, LOGGING_SETTINGS_ID, LoggingSettingsError, LoggingSettingsRow,
  activeLoggingSettings, environmentFixedOf, settingsFromInput, loadLoggingSettings, valkeyIsConfigured, hasEntriesThatEnd
} from '../services/loggingSettings';
import { recordAuditEvent } from '../services/auditEventService';
import { GATEWAY_LOG_ENTITY, gatewayLogSettings } from '../services/gatewayLogIngest';
import { payloadCaptureSettings } from '../services/payloadTraceIngest';
import { sealKeyStatus } from '@libs/trace-seal';
import { clientContext } from '../utils/clientIp';

const cds = require('@sap/cds');
const logger = getDefaultLogger();

/** The part of the configuration service these actions use (config-service.ts). */
export interface LoggingSettingsHandOver {
  republishForLoggingSettings(): Promise<boolean>;
}

type Settings = Pick<LoggingSettingsRow, 'logStorageEnabled' | 'payloadCaptureEnabled' | 'defaultLevel' | 'defaultLevelUntil' | 'componentLevels'>;
const FIELDS: (keyof Settings)[] = ['logStorageEnabled', 'payloadCaptureEnabled', 'defaultLevel', 'defaultLevelUntil', 'componentLevels'];
const NOTHING: Settings = { logStorageEnabled: null, payloadCaptureEnabled: null, defaultLevel: null, defaultLevelUntil: null, componentLevels: null };
const AUDIT_DETAILS_MAX = 1000; // AuditEvents.details is String(1000)

const readRow = (tx: any): Promise<LoggingSettingsRow | null> =>
  tx.run(cds.ql.SELECT.one.from(LOGGING_SETTINGS_ENTITY).where({ ID: LOGGING_SETTINGS_ID })).then((r: any) => r ?? null);

/** A field as the audit event shows it: times as ISO strings, componentLevels as an object. */
function shown(field: keyof Settings, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (field === 'defaultLevelUntil') return new Date(value as string).toISOString();
  if (field === 'componentLevels') { try { return JSON.parse(value as string); } catch { return value; } }
  return value;
}

/** { field: { old, new } } for each field that changed, shortened to fit AuditEvents.details. */
export function auditDetails(before: Settings | null, after: Settings): string {
  const changed: Record<string, { old: unknown; new: unknown }> = {};
  for (const field of FIELDS) {
    const oldValue = shown(field, before?.[field]);
    const newValue = shown(field, after[field]);
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) changed[field] = { old: oldValue, new: newValue };
  }
  const full = JSON.stringify({ changed });
  if (full.length <= AUDIT_DETAILS_MAX || !changed.componentLevels) return full.slice(0, AUDIT_DETAILS_MAX);
  // Too long with every component: name the components whose level changed instead.
  const was = (changed.componentLevels.old ?? {}) as Record<string, unknown>;
  const now = (changed.componentLevels.new ?? {}) as Record<string, unknown>;
  const names = [...new Set([...Object.keys(was), ...Object.keys(now)])].filter((n) => JSON.stringify(was[n]) !== JSON.stringify(now[n]));
  const rest = { ...changed };
  delete rest.componentLevels;
  for (let kept = names.length; kept >= 0; kept--) {
    const text = JSON.stringify({ changed: rest, componentLevelsChanged: names.slice(0, kept), more: names.length - kept });
    if (text.length <= AUDIT_DETAILS_MAX) return text;
  }
  return JSON.stringify({ changed: Object.keys(changed) });
}

/** The answer of all three actions: the record now, the active configuration's own values, the environment report. */
async function settingsState(warning: string | null): Promise<any> {
  const now = new Date();
  const [row, active] = await cds.tx(async (tx: any) => [
    await readRow(tx),
    await tx.run(cds.ql.SELECT.one.from('sap.llm.gateway.admin.ApiConfigurations').columns('configData').where({ isActive: true }).orderBy('version desc'))
  ]);
  let record = activeLoggingSettings(null, now);
  try {
    record = activeLoggingSettings(row, now);
  } catch (error) {
    logger.error('LoggingSettings', 'The stored logging settings are corrupt', error as Error);
  }
  let config: any = {};
  try { config = active?.configData ? JSON.parse(active.configData) : {}; } catch { config = {}; }
  const logging = config?.api_config?.platform?.logging ?? {};
  const components = logging.components && typeof logging.components === 'object' ? logging.components : {};
  const fixed = environmentFixedOf(row);
  return {
    logStorageEnabled: record.logStorageEnabled ?? null,
    payloadCaptureEnabled: record.payloadCaptureEnabled ?? null,
    defaultLevel: record.defaultLevel?.level ?? null,
    defaultLevelUntil: record.defaultLevel?.until ?? null,
    componentLevels: Object.entries(record.components).map(([component, e]) => ({ component, level: e.level, until: e.until ?? null })),
    configurationLogStorageEnabled: gatewayLogSettings(config).enabled,
    configurationPayloadCaptureEnabled: payloadCaptureSettings(config).enabled,
    traceKeyStatus: sealKeyStatus(process.env),
    configurationDefaultLevel: typeof logging.defaultLevel === 'string' ? logging.defaultLevel.toUpperCase() : null,
    configurationComponentLevels: Object.entries(components).map(([component, level]) => ({ component, level: String(level).toUpperCase() })),
    configurationStoredLevel: gatewayLogSettings(config).minLevel,
    environmentReported: fixed !== null,
    environmentReportedAt: row?.environmentReportedAt ? new Date(row.environmentReportedAt as string).toISOString() : null,
    environmentFixed: Object.entries(fixed ?? {}).map(([variable, value]) => ({ variable, value })),
    payloadFileLoggingEnabled: payloadFileLoggingOn(fixed, logging),
    warning
  };
}

/**
 * Whether the gateway writes payload files (the debug file logger, not the audited traces): the
 * reported PAYLOAD_LOGGING_ENABLED decides when it is 'true' or 'false', as in the gateway's
 * payloadLogger; otherwise the configuration's platform.logging.payload_logging_enabled.
 */
function payloadFileLoggingOn(fixed: Record<string, string> | null, logging: any): boolean {
  const variable = fixed?.PAYLOAD_LOGGING_ENABLED;
  if (variable === 'true') return true;
  if (variable === 'false') return false;
  return logging?.payload_logging_enabled === true;
}

/** Writes `next` (or what `next` makes of the stored record), audits, republishes, answers. */
async function write(req: any, handOver: LoggingSettingsHandOver, next: (row: LoggingSettingsRow | null) => Settings): Promise<any> {
  let change: { before: LoggingSettingsRow | null; after: Settings };
  try {
    change = await cds.tx(async (tx: any) => {
      const before = await readRow(tx);
      const after = next(before);
      await tx.run(cds.ql.UPSERT.into(LOGGING_SETTINGS_ENTITY).entries({ ID: LOGGING_SETTINGS_ID, ...after }));
      return { before, after };
    });
  } catch (error) {
    if (error instanceof LoggingSettingsError) return req.reject({ status: 400, code: error.key, message: error.key, args: error.args });
    throw error;
  }
  // The hand-overs use the record kept in memory: refresh it before the republish.
  await loadLoggingSettings();
  await cds.tx(() => recordAuditEvent({
    actorId: req.user?.id || 'anonymous', actorType: 'admin_user', action: 'logging.settings.change',
    resourceType: 'LoggingSettings', resourceId: LOGGING_SETTINGS_ID, outcome: 'success', severity: 'medium',
    ...clientContext(req), details: auditDetails(change.before, change.after)
  }));
  const delivered = await handOver.republishForLoggingSettings();
  if (delivered) return settingsState(null);
  // Without Valkey a level with an end is not handed to the gateway at all (overlayForGateway).
  let endsWithoutValkey = false;
  try {
    endsWithoutValkey = !valkeyIsConfigured() && hasEntriesThatEnd(activeLoggingSettings({ ID: LOGGING_SETTINGS_ID, ...change.after }, new Date()));
  } catch { /* a record that cannot be read gets the plain warning */ }
  const key = endsWithoutValkey ? 'LOGGING_SETTINGS_TIMED_NEEDS_VALKEY' : 'LOGGING_SETTINGS_NOT_DELIVERED';
  return settingsState(cds.i18n.messages.at(key, req.locale) ?? key);
}

/**
 * The component names of the stored gateway log, each once, sorted without regard to case: the
 * Switches and levels tab suggests them for a component level, whose name must match exactly. One
 * DISTINCT read in its own short transaction; empty names are left out.
 */
async function gatewayLogComponents(): Promise<string[]> {
  const rows = await cds.tx((tx: any) => tx.run(cds.ql.SELECT.distinct.from(GATEWAY_LOG_ENTITY).columns('component')));
  const names = (rows as { component: string | null }[]).map((row) => row.component).filter((name): name is string => !!name && name.trim() !== '');
  return [...new Set(names)].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}

export function registerLoggingSettingsHandlers(service: any, handOver: LoggingSettingsHandOver): void {
  service.on('getLoggingSettings', () => settingsState(null));
  service.on('gatewayLogComponents', () => gatewayLogComponents());
  service.on('setLoggingSettings', (req: any) =>
    write(req, handOver, (row) => settingsFromInput(req.data ?? {}, environmentFixedOf(row) ?? {}, new Date())));
  service.on('resetLoggingSettings', (req: any) => write(req, handOver, () => NOTHING));
}
