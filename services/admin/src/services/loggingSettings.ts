/**
 * Logging switches and levels outside the configuration versions. One record (db/schema/logging-settings.cds,
 * ID 'gateway') whose values are laid over the active configuration at the moment the admin hands it
 * to the gateway (config-service.ts configurationForGateway, validation-service.ts getConfig). The
 * stored configuration versions, and what the cockpit shows as the active configuration, never
 * change because of it. The overlay writes where the gateway reads: platform.logging.defaultLevel and
 * .components (Logger.applyLoggingConfig), observability.gateway_log.enabled (gatewayLogSettings) and
 * observability.payload_capture.enabled (payloadCaptureSettings).
 *
 * A timed entry runs out by itself: the expiry check compares what the overlay gives now with what it
 * gave at the last hand-over and hands the configuration over again when they differ.
 */
import { getDefaultLogger } from '@libs/logger';

const cds = require('@sap/cds');
const logger = getDefaultLogger();

export const LOGGING_SETTINGS_ENTITY = 'sap.llm.gateway.admin.LoggingSettings';
export const LOGGING_SETTINGS_ID = 'gateway';
export const LEVELS = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'];
const MAX_COMPONENTS = 50;
const MAX_COMPONENT_NAME = 80;
const MAX_MINUTES = 1440;
/** The environment variables a gateway reports as fixing a setting; anything else in a report is dropped. */
const REPORTED_VARIABLES = ['LOG_LEVEL', 'PAYLOAD_LOGGING_ENABLED', 'GATEWAY_LOG_SHIPPING'];
const INTERVAL_MS = 60_000;
const MAX_ENVIRONMENT_REPORT = 500; // LoggingSettings.environmentFixed is String(500)

export interface LoggingSettingsRow {
  ID?: string;
  logStorageEnabled?: boolean | null;
  payloadCaptureEnabled?: boolean | null;
  defaultLevel?: string | null;
  defaultLevelUntil?: string | Date | null;
  componentLevels?: string | null;
  environmentFixed?: string | null;
  environmentReportedAt?: string | Date | null;
}

/** What the record sets right now: entries that have run out are left out. */
export interface ActiveLoggingSettings {
  logStorageEnabled?: boolean;
  payloadCaptureEnabled?: boolean;
  defaultLevel?: { level: string; until?: string };
  components: Record<string, { level: string; until?: string }>;
}

/** A refused input: `key` is a message of _i18n/messages*.properties, `args` fill its {0}. */
export class LoggingSettingsError extends Error {
  constructor(public key: string, public args: string[] = []) {
    super(key);
  }
}

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const running = (until: unknown, now: Date): boolean => until == null || new Date(until as string).getTime() > now.getTime();
const iso = (v: unknown): string | undefined => (v == null ? undefined : new Date(v as string).toISOString());

/** The record's entries that apply at `now`. Throws on a componentLevels that is not a JSON object. */
export function activeLoggingSettings(settings: LoggingSettingsRow | null | undefined, now: Date): ActiveLoggingSettings {
  const active: ActiveLoggingSettings = { components: {} };
  if (!settings) return active;
  if (typeof settings.logStorageEnabled === 'boolean') active.logStorageEnabled = settings.logStorageEnabled;
  if (typeof settings.payloadCaptureEnabled === 'boolean') active.payloadCaptureEnabled = settings.payloadCaptureEnabled;
  if (settings.defaultLevel && running(settings.defaultLevelUntil, now)) {
    active.defaultLevel = { level: settings.defaultLevel, until: iso(settings.defaultLevelUntil) };
  }
  if (settings.componentLevels) {
    const parsed = JSON.parse(settings.componentLevels);
    if (!isObject(parsed)) throw new Error('componentLevels is not a JSON object');
    for (const [name, entry] of Object.entries(parsed)) {
      if (isObject(entry) && typeof entry.level === 'string' && running(entry.until, now)) {
        active.components[name] = entry.until ? { level: entry.level, until: iso(entry.until) } : { level: entry.level };
      }
    }
  }
  return active;
}

const changesSomething = (a: ActiveLoggingSettings): boolean =>
  a.logStorageEnabled !== undefined || a.payloadCaptureEnabled !== undefined || a.defaultLevel !== undefined || Object.keys(a.components).length > 0;

/** Where the object at `keys` below `root` is, created (as an empty object) where it is missing. */
function objectAt(root: Record<string, any>, keys: string[]): Record<string, any> {
  let at = root;
  for (const key of keys) {
    if (!isObject(at[key])) at[key] = {};
    at = at[key];
  }
  return at;
}

/**
 * The configuration with the record laid over it, of the same kind it was given (a JSON string or an
 * object). When the record sets something that applies, the result is a copy; when nothing applies,
 * it is the input itself (the same reference). Creates only what it sets; the input is never changed.
 * Throws on a corrupt record or a string that is not JSON (overlayForGateway catches that).
 */
export function overlayLoggingSettings(configData: any, settings: LoggingSettingsRow | null, now: Date): any {
  return overlayActive(configData, activeLoggingSettings(settings, now));
}

function overlayActive(configData: any, active: ActiveLoggingSettings): any {
  if (!changesSomething(active)) return configData;
  const asString = typeof configData === 'string';
  const config = asString ? JSON.parse(configData) : structuredClone(configData);
  if (!isObject(config)) return configData;
  if (active.defaultLevel) objectAt(config, ['api_config', 'platform', 'logging']).defaultLevel = active.defaultLevel.level;
  const names = Object.keys(active.components);
  if (names.length > 0) {
    const logging = objectAt(config, ['api_config', 'platform', 'logging']);
    logging.components = { ...(isObject(logging.components) ? logging.components : {}) };
    for (const name of names) logging.components[name] = active.components[name].level;
  }
  if (active.logStorageEnabled !== undefined) objectAt(config, ['api_config', 'observability', 'gateway_log']).enabled = active.logStorageEnabled;
  if (active.payloadCaptureEnabled !== undefined) objectAt(config, ['api_config', 'observability', 'payload_capture']).enabled = active.payloadCaptureEnabled;
  return asString ? JSON.stringify(config) : config;
}

function level(value: unknown): string {
  const text = String(value);
  const upper = text.toUpperCase();
  if (typeof value !== 'string' || !LEVELS.includes(upper)) throw new LoggingSettingsError('LOGGING_LEVEL_INVALID', [text]);
  return upper;
}

function untilAfter(minutes: unknown, now: Date): string {
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) {
    throw new LoggingSettingsError('LOGGING_MINUTES_INVALID', [String(minutes)]);
  }
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

const given = (v: unknown): boolean => v !== undefined && v !== null && v !== '';

/**
 * The record setLoggingSettings stores (it replaces the record's settings, it does not merge). Throws
 * a LoggingSettingsError for an invalid input and for a setting the gateway's environment fixes.
 */
export function settingsFromInput(
  input: { logStorageEnabled?: boolean | null; payloadCaptureEnabled?: boolean | null; defaultLevel?: string | null; defaultLevelMinutes?: number | null; componentLevels?: string | null },
  environmentFixed: Record<string, string>,
  now: Date
): Required<Pick<LoggingSettingsRow, 'logStorageEnabled' | 'payloadCaptureEnabled' | 'defaultLevel' | 'defaultLevelUntil' | 'componentLevels'>> {
  const logStorageEnabled = typeof input.logStorageEnabled === 'boolean' ? input.logStorageEnabled : null;
  if (logStorageEnabled === true && environmentFixed.GATEWAY_LOG_SHIPPING === 'off') {
    throw new LoggingSettingsError('LOGGING_FIXED_LOG_SHIPPING', ['off']);
  }

  const payloadCaptureEnabled = typeof input.payloadCaptureEnabled === 'boolean' ? input.payloadCaptureEnabled : null;

  let defaultLevel: string | null = null;
  let defaultLevelUntil: string | null = null;
  if (given(input.defaultLevel)) {
    defaultLevel = level(input.defaultLevel);
    if (environmentFixed.LOG_LEVEL) throw new LoggingSettingsError('LOGGING_FIXED_LOG_LEVEL', [environmentFixed.LOG_LEVEL]);
    if (given(input.defaultLevelMinutes)) defaultLevelUntil = untilAfter(input.defaultLevelMinutes, now);
  } else if (given(input.defaultLevelMinutes)) {
    throw new LoggingSettingsError('LOGGING_MINUTES_WITHOUT_LEVEL', [String(input.defaultLevelMinutes)]);
  }

  let componentLevels: string | null = null;
  if (given(input.componentLevels)) {
    let parsed: unknown;
    try { parsed = JSON.parse(String(input.componentLevels)); } catch { parsed = undefined; }
    if (!isObject(parsed)) throw new LoggingSettingsError('LOGGING_COMPONENTS_NOT_OBJECT');
    const names = Object.keys(parsed);
    if (names.length > MAX_COMPONENTS) throw new LoggingSettingsError('LOGGING_TOO_MANY_COMPONENTS', [String(names.length)]);
    const stored: Record<string, { level: string; until?: string }> = {};
    for (const name of names) {
      // eslint-disable-next-line no-control-regex
      if (name.length === 0 || name.length > MAX_COMPONENT_NAME || /[\u0000-\u001f\u007f-\u009f]/.test(name)) {
        throw new LoggingSettingsError('LOGGING_COMPONENT_NAME_INVALID', [JSON.stringify(name)]);
      }
      const entry = (parsed as Record<string, unknown>)[name];
      if (!isObject(entry) || entry.level === undefined) throw new LoggingSettingsError('LOGGING_COMPONENT_ENTRY_INVALID', [JSON.stringify(name)]);
      stored[name] = given(entry.minutes) ? { level: level(entry.level), until: untilAfter(entry.minutes, now) } : { level: level(entry.level) };
    }
    if (names.length > 0) componentLevels = JSON.stringify(stored);
  }
  return { logStorageEnabled, payloadCaptureEnabled, defaultLevel, defaultLevelUntil, componentLevels };
}

/** The variables of the last environment report, or null when no gateway has reported yet. */
export function environmentFixedOf(row: LoggingSettingsRow | null | undefined): Record<string, string> | null {
  if (!row?.environmentReportedAt) return null;
  try {
    const parsed = JSON.parse(row.environmentFixed || '{}');
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The database read of the record; an object so that tests can watch or replace it. */
export const loggingSettingsStore = {
  /** Reads the row in its own short root transaction, closed before the caller goes on. */
  readRow: async (): Promise<LoggingSettingsRow | null> =>
    (await cds.tx(async (tx: any) => tx.run(cds.ql.SELECT.one.from(LOGGING_SETTINGS_ENTITY).where({ ID: LOGGING_SETTINGS_ID })))) ?? null
};

/**
 * The record as the hand-overs use it, kept in memory: a hand-over never reads the database for it
 * (it may run inside an activation's request transaction, which a failing statement would abort on
 * PostgreSQL, and a second transaction would deadlock the single SQLite connection). Loaded at admin
 * start, after each write, after an environment report and on each expiry tick.
 */
let cachedRecord: LoggingSettingsRow | null = null;
let firstLoadDone: () => void = () => undefined;
const firstLoad = new Promise<void>((resolve) => { firstLoadDone = resolve; });

/** Loads the record into memory. False (logged, the cache kept as it was) when the read failed. */
export async function loadLoggingSettings(): Promise<boolean> {
  try {
    cachedRecord = await loggingSettingsStore.readRow();
    return true;
  } catch (error) {
    logger.warn('LoggingSettings', `The logging settings could not be loaded; the hand-overs go on with what was loaded before (nothing after a start) and the next check tries again: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    firstLoadDone();
  }
}

/** Resolves once the first load at start has finished (or failed), or after maxWaitMs. */
export async function whenLoggingSettingsLoaded(maxWaitMs = 5000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([firstLoad, new Promise<void>((resolve) => { timer = setTimeout(resolve, maxWaitMs); timer.unref(); })]);
  clearTimeout(timer);
}

/** What the overlay gave in the last hand-over the gateway got; undefined until the first one after a start. */
let lastHandedOver: ActiveLoggingSettings | undefined;

/**
 * Records a hand-over the gateway got: call it only after a Valkey publish that succeeded. An HTTP
 * answer does not count (other gateways may only listen to the events). Without Valkey nothing is
 * ever marked, so the expiry check never compares and never republishes: there is nobody to publish
 * to. A gateway without Valkey fetches its configuration once per process, so it gets the overlay
 * only at its next start; that is why overlayForGateway leaves entries with an end out then.
 */
export function markHandedOver(handedOver: ActiveLoggingSettings | undefined): void {
  if (handedOver) lastHandedOver = handedOver;
}

/** Forgets the cached record and the last hand-over (tests). */
export function forgetHandOver(): void {
  lastHandedOver = undefined;
  lastAttempted = undefined;
}
export function forgetLoggingSettings(): void {
  cachedRecord = null;
  forgetHandOver();
}

/**
 * The configuration as the gateway gets it, with the cached record laid over it, and what the overlay
 * gave (for markHandedOver once the gateway got it). No database access. Never throws: on any error
 * (a corrupt record) the configuration is given as it is, handedOver is undefined, and the error is logged.
 */
export function overlayForGateway(
  configData: any, now: Date = new Date(), valkeyConfigured: boolean = valkeyIsConfigured()
): { configData: any; handedOver?: ActiveLoggingSettings } {
  try {
    const active = activeLoggingSettings(cachedRecord, now);
    const handedOver = valkeyConfigured ? active : withoutEntriesThatEnd(active);
    return { configData: overlayActive(configData, handedOver), handedOver };
  } catch (error) {
    logger.error('LoggingSettings', 'The logging settings could not be laid over the configuration; the gateway gets it without them', error as Error);
    return { configData };
  }
}

/** Whether this admin can publish to the gateways (the same test the expiry check uses). */
export const valkeyIsConfigured = (): boolean => !!process.env.VALKEY_URL?.trim();

/**
 * The entries that have no end. The gateway is handed a level, not its end: only the expiry
 * republish takes a timed level back, and without Valkey there is none. A gateway that fetched
 * the configuration during the window would keep the level until its next start.
 */
function withoutEntriesThatEnd(active: ActiveLoggingSettings): ActiveLoggingSettings {
  const lasting: ActiveLoggingSettings = { components: {} };
  if (active.logStorageEnabled !== undefined) lasting.logStorageEnabled = active.logStorageEnabled;
  if (active.payloadCaptureEnabled !== undefined) lasting.payloadCaptureEnabled = active.payloadCaptureEnabled;
  if (active.defaultLevel && !active.defaultLevel.until) lasting.defaultLevel = active.defaultLevel;
  for (const [name, entry] of Object.entries(active.components)) {
    if (!entry.until) lasting.components[name] = entry;
  }
  return lasting;
}

/** Whether any entry that applies now has an end. */
export function hasEntriesThatEnd(active: ActiveLoggingSettings): boolean {
  return !!active.defaultLevel?.until || Object.values(active.components).some((entry) => !!entry.until);
}

/** Stores a gateway's report of what its environment fixes. No republish, no audit event. Never throws. */
export async function storeEnvironmentReport(report: unknown, now: Date = new Date()): Promise<void> {
  if (!isObject(report)) return;
  const fixed: Record<string, string> = {};
  for (const name of REPORTED_VARIABLES) {
    // eslint-disable-next-line no-control-regex
    if (report[name] !== undefined && report[name] !== null) fixed[name] = String(report[name]).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 100);
  }
  const text = JSON.stringify(fixed);
  if (text.length > MAX_ENVIRONMENT_REPORT) {
    logger.warn('LoggingSettings', `The gateway's environment report was not stored: it is ${text.length} characters long, at most ${MAX_ENVIRONMENT_REPORT} fit`);
    return;
  }
  try {
    await cds.tx(async (tx: any) => {
      await tx.run(cds.ql.UPSERT.into(LOGGING_SETTINGS_ENTITY).entries({
        ID: LOGGING_SETTINGS_ID, environmentFixed: text, environmentReportedAt: now.toISOString()
      }));
    });
  } catch (error) {
    logger.warn('LoggingSettings', `The gateway's environment report could not be stored: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  await loadLoggingSettings();
}

const signature = (a: ActiveLoggingSettings): string => JSON.stringify([
  a.logStorageEnabled ?? null, a.payloadCaptureEnabled ?? null, a.defaultLevel?.level ?? null,
  Object.keys(a.components).sort().map((name) => [name, a.components[name].level])
]);

function whatChanged(before: ActiveLoggingSettings, now: ActiveLoggingSettings): string {
  const names: string[] = [];
  if (before.logStorageEnabled !== now.logStorageEnabled) names.push('log storing');
  if (before.payloadCaptureEnabled !== now.payloadCaptureEnabled) names.push('payload capture');
  if (before.defaultLevel?.level !== now.defaultLevel?.level) names.push(`default level ${before.defaultLevel?.level ?? '-'}`);
  for (const name of new Set([...Object.keys(before.components), ...Object.keys(now.components)])) {
    if (before.components[name]?.level !== now.components[name]?.level) names.push(`component ${name} ${before.components[name]?.level ?? '-'}`);
  }
  return names.join(', ');
}

/** The overlay of the last republish this check started, so that a retry is logged once. */
let lastAttempted: string | undefined;

/**
 * One expiry check: loads the record, then hands the configuration over again (through `republish`)
 * when what the overlay gives at `now` differs from what the gateway last got (the last hand-over
 * that succeeded). A timed entry that ran out, a record another admin instance wrote, or a publish
 * that failed all show up as such a difference, so a failed publish is tried again on the next check
 * - and only while the difference lasts. Before the first hand-over after a start (Valkey was not
 * reachable then) nothing can be compared: with Valkey configured each check tries one hand-over until
 * one succeeds, so a timed level still falls back; without Valkey there is nobody to publish to. True
 * when it republished successfully.
 */
export async function checkLoggingSettingsExpiry(
  republish: () => Promise<boolean>, now: Date = new Date(), valkeyConfigured: boolean = valkeyIsConfigured()
): Promise<boolean> {
  await loadLoggingSettings();
  const current = activeLoggingSettings(cachedRecord, now);
  const before = lastHandedOver;
  if (!before) {
    if (!valkeyConfigured || !(await republish())) return false;
    markHandedOver(current);
    return true;
  }
  if (signature(before) === signature(current)) return false;
  if (lastAttempted !== signature(current)) {
    lastAttempted = signature(current);
    logger.info('LoggingSettings', `The logging settings differ from what the gateway last got (${whatChanged(before, current)}), for example because a timed one ran out; the configuration is handed to the gateway again`);
  }
  if (!(await republish())) return false;
  markHandedOver(current);
  return true;
}

const isTestProcess = (): boolean => process.env.NODE_ENV === 'test' || !!process.env.JEST_WORKER_ID;

export interface LoggingSettingsExpiryHandle { stop: () => void }

/** Starts the expiry check once a minute (unref-ed). Null in a test process unless allowed. */
export function startLoggingSettingsExpiry(
  republish: () => Promise<boolean>,
  opts: { allowInTest?: boolean; intervalMs?: number } = {}
): LoggingSettingsExpiryHandle | null {
  if (isTestProcess() && !opts.allowInTest) return null;
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    checkLoggingSettingsExpiry(republish)
      .catch((error) => logger.warn('LoggingSettings', `The logging settings expiry check failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { busy = false; });
  }, opts.intervalMs ?? INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
