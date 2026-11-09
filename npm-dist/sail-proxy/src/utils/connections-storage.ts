import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync, openSync, closeSync, statSync, rmSync } from 'fs';
import { getConfigPath, ensureConfigDir } from './paths';

/**
 * connections.json in the config dir: the Connections a standalone gateway serves. The rules
 * duplicate the gateway's (services/gateway/src/connections/fileBackend.ts) on purpose, the CLI
 * package must not import gateway source; test/connections-storage.test.js pins both against
 * services/gateway/test/fixtures/connections-file-cases.json. Errors carry a path, never a value.
 */
export type ConnectionType = 'openai' | 'azure-openai' | 'anthropic' | 'bedrock';
export type SecretValue = string | { env: string };

export interface ConnectionModelEntry {
  upstreamModel: string;
  family?: 'openai' | 'claude';
  displayName?: string;
  capabilities?: string[];
}

export interface ConnectionEntry {
  name: string;
  type: ConnectionType;
  active?: boolean;
  settings?: Record<string, string>;
  secret?: SecretValue;
  sessionToken?: SecretValue;
  models?: ConnectionModelEntry[];
}

export interface ConnectionsFile {
  version: 1;
  connections: ConnectionEntry[];
}

export class ConnectionsFileError extends Error {
  /** code is 'unknown_setting' for a setting the type does not take, else 'invalid'. */
  constructor(public readonly path: string, public readonly reason: string, public readonly code: 'invalid' | 'unknown_setting' = 'invalid') {
    super(path ? `connections file: ${reason} at ${path}` : `connections file: ${reason}`);
    this.name = 'ConnectionsFileError';
  }
}

const CONNECTIONS_FILE = 'connections.json';
/** How long a change waits for another CLI command's lock, and when a lock counts as left by a dead writer. */
const LOCK_WAIT_MS = 3_000;
const LOCK_STALE_MS = 30_000;
const FILE_TYPES: readonly string[] = ['openai', 'azure-openai', 'anthropic', 'bedrock'];
const NAME_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;
/** An env-ref name; anything else (a pasted key, say) is refused without echoing it. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FAMILIES: readonly string[] = ['openai', 'claude'];
const TOP_KEYS = ['version', 'connections'];
const CONNECTION_KEYS = ['name', 'type', 'active', 'settings', 'secret', 'sessionToken', 'models'];
const MODEL_KEYS = ['upstreamModel', 'family', 'displayName', 'capabilities'];
const SETTINGS_KEYS: Record<string, readonly string[]> = {
  'openai': ['baseUrl', 'organization', 'project'],
  'azure-openai': ['endpoint', 'apiMode', 'apiVersion', 'authMode', 'tenantId', 'clientId'],
  'anthropic': ['baseUrl', 'anthropicVersion'],
  'bedrock': ['region', 'authMode', 'accessKeyId', 'runtimeEndpoint'],
};
// The cockpit's rules (services/admin/src/services/connectionValidation.ts), ported: same checks, path-only errors.
const REGION = /^[a-z]{2}(-[a-z]+)+-\d+$/;
/** No `/`: ids travel in URL paths. */
const UPSTREAM_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const URL_SETTINGS = ['endpoint', 'baseUrl', 'runtimeEndpoint'];
const LOOPBACK = new Set(['localhost', '127.0.0.1']);

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const present = (v: string | undefined): boolean => typeof v === 'string' && v.trim().length > 0;

/** https anywhere; http only on loopback, where test fakes listen. null when fine or absent. */
function urlError(value: string | undefined): string | null {
  if (!present(value)) return null;
  let url: URL;
  try { url = new URL(value as string); } catch { return 'must be a URL'; }
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return null;
  return 'must be an https URL (http only on localhost or 127.0.0.1)';
}

/** The per-type rules; an absent apiMode/authMode takes the cockpit's default (v1, api-key, access-key). */
function checkTypeRules(type: string, s: Record<string, string>, at: string): void {
  const fail = (key: string, reason: string): ConnectionsFileError => new ConnectionsFileError(`${at}.settings.${key}`, reason);
  for (const key of URL_SETTINGS) {
    const e = urlError(s[key]);
    if (e) throw fail(key, e);
  }
  if (type === 'azure-openai') {
    if (!present(s.endpoint)) throw fail('endpoint', 'is required for azure-openai');
    const apiMode = s.apiMode ?? 'v1';
    if (!['v1', 'deployments'].includes(apiMode)) throw fail('apiMode', 'must be v1 or deployments');
    if (apiMode === 'deployments' && !present(s.apiVersion)) throw fail('apiVersion', 'is required when apiMode is deployments');
    const authMode = s.authMode ?? 'api-key';
    if (!['api-key', 'entra-client-secret'].includes(authMode)) throw fail('authMode', 'must be api-key or entra-client-secret');
    if (authMode === 'entra-client-secret') {
      if (!present(s.tenantId)) throw fail('tenantId', 'is required for entra-client-secret');
      if (!present(s.clientId)) throw fail('clientId', 'is required for entra-client-secret');
    }
  } else if (type === 'bedrock') {
    if (typeof s.region !== 'string' || !REGION.test(s.region)) throw fail('region', 'must be an AWS region such as us-east-1');
    const authMode = s.authMode ?? 'access-key';
    if (!['access-key', 'bearer'].includes(authMode)) throw fail('authMode', 'must be access-key or bearer');
    if (authMode === 'access-key' && !present(s.accessKeyId)) throw fail('accessKeyId', 'is required for access-key');
  }
}

function checkKeys(obj: Json, allowed: readonly string[], at: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new ConnectionsFileError(at ? `${at}.${key}` : key, 'unknown key');
  }
}

function checkSecret(value: unknown, at: string): void {
  if (typeof value === 'string') {
    if (!value) throw new ConnectionsFileError(at, 'must not be empty');
    return;
  }
  if (isObject(value)) {
    checkKeys(value, ['env'], at);
    if (typeof value.env !== 'string' || !ENV_NAME_PATTERN.test(value.env)) throw new ConnectionsFileError(`${at}.env`, 'must be an environment variable name ([A-Za-z_][A-Za-z0-9_]*)');
    return;
  }
  throw new ConnectionsFileError(at, 'must be a string or { "env": NAME }');
}

function checkModel(raw: unknown, at: string, seen: Set<string>): void {
  if (!isObject(raw)) throw new ConnectionsFileError(at, 'must be an object');
  checkKeys(raw, MODEL_KEYS, at);
  const upstreamModel = raw.upstreamModel;
  if (typeof upstreamModel !== 'string' || !UPSTREAM_MODEL.test(upstreamModel)) {
    throw new ConnectionsFileError(`${at}.upstreamModel`, "must be 1-64 characters of letters, digits, '.', '_', ':' and '-', starting with a letter or digit");
  }
  if (seen.has(upstreamModel)) throw new ConnectionsFileError(`${at}.upstreamModel`, 'duplicate within the connection');
  seen.add(upstreamModel);
  if (raw.family !== undefined && (typeof raw.family !== 'string' || !FAMILIES.includes(raw.family))) {
    throw new ConnectionsFileError(`${at}.family`, 'must be openai or claude');
  }
  if (raw.displayName !== undefined && typeof raw.displayName !== 'string') throw new ConnectionsFileError(`${at}.displayName`, 'must be a string');
  const caps = raw.capabilities;
  if (caps !== undefined && (!Array.isArray(caps) || caps.some((c) => typeof c !== 'string'))) {
    throw new ConnectionsFileError(`${at}.capabilities`, 'must be an array of strings');
  }
}

function checkConnection(raw: unknown, i: number, names: Set<string>): void {
  const at = `connections[${i}]`;
  if (!isObject(raw)) throw new ConnectionsFileError(at, 'must be an object');
  checkKeys(raw, CONNECTION_KEYS, at);
  const { name, type } = raw;
  if (typeof name !== 'string' || !NAME_PATTERN.test(name) || name.includes('--') || name === 'deployed') {
    throw new ConnectionsFileError(`${at}.name`, 'must match ^[a-z][a-z0-9-]{1,30}$, contain no "--" and not be "deployed"');
  }
  if (names.has(name)) throw new ConnectionsFileError(`${at}.name`, 'duplicate connection name');
  names.add(name);
  if (typeof type !== 'string' || !FILE_TYPES.includes(type)) throw new ConnectionsFileError(`${at}.type`, `must be one of ${FILE_TYPES.join(', ')}`);
  if (raw.active !== undefined && typeof raw.active !== 'boolean') throw new ConnectionsFileError(`${at}.active`, 'must be a boolean');
  const settings: Record<string, string> = {};
  if (raw.settings !== undefined) {
    if (!isObject(raw.settings)) throw new ConnectionsFileError(`${at}.settings`, 'must be an object');
    for (const [key, value] of Object.entries(raw.settings)) {
      if (!SETTINGS_KEYS[type].includes(key)) throw new ConnectionsFileError(`${at}.settings.${key}`, `unknown setting for ${type}`, 'unknown_setting');
      if (typeof value !== 'string') throw new ConnectionsFileError(`${at}.settings.${key}`, 'must be a string');
      settings[key] = value;
    }
  }
  checkTypeRules(type, settings, at);
  if (raw.sessionToken !== undefined && !(type === 'bedrock' && (settings.authMode ?? 'access-key') === 'access-key')) {
    throw new ConnectionsFileError(`${at}.sessionToken`, 'applies to bedrock with access-key auth only');
  }
  if (raw.secret !== undefined) checkSecret(raw.secret, `${at}.secret`);
  if (raw.sessionToken !== undefined) checkSecret(raw.sessionToken, `${at}.sessionToken`);
  if (raw.models !== undefined) {
    if (!Array.isArray(raw.models)) throw new ConnectionsFileError(`${at}.models`, 'must be an array');
    const seen = new Set<string>();
    raw.models.forEach((m, j) => checkModel(m, `${at}.models[${j}]`, seen));
  }
}

/** Throws ConnectionsFileError (with .path) unless the document is a valid connections file. */
export function validateConnectionsFile(doc: unknown): void {
  if (!isObject(doc)) throw new ConnectionsFileError('', 'must be a JSON object');
  checkKeys(doc, TOP_KEYS, '');
  if (doc.version !== 1) throw new ConnectionsFileError('version', 'must be 1');
  if (!Array.isArray(doc.connections)) throw new ConnectionsFileError('connections', 'must be an array');
  const names = new Set<string>();
  doc.connections.forEach((c, i) => checkConnection(c, i, names));
}

/** The published model id of an upstream model on a connection (spec 3). */
export function modelIdOf(upstreamModel: string, name: string): string {
  return `${upstreamModel}--${name}`;
}

export function readConnections(): ConnectionsFile {
  const filePath = getConfigPath(CONNECTIONS_FILE);
  if (!existsSync(filePath)) return { version: 1, connections: [] };
  let doc: unknown;
  try { doc = JSON.parse(readFileSync(filePath, 'utf-8')); } catch { throw new ConnectionsFileError('', 'not valid JSON'); }
  validateConnectionsFile(doc);
  return doc as ConnectionsFile;
}

/** Validates, then writes connections.json.tmp (0600) and renames it over the file. */
export function writeConnections(file: ConnectionsFile): void {
  validateConnectionsFile(file);
  ensureConfigDir();
  const filePath = getConfigPath(CONNECTIONS_FILE);
  const tmpPath = `${filePath}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
    if (process.platform !== 'win32') chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, filePath);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/**
 * Runs a read-change-write of the file under connections.json.lock, so two CLI commands at once
 * cannot lose each other's change. A lock older than LOCK_STALE_MS was left by a dead writer and is taken over.
 */
function withLock<T>(change: () => T): T {
  ensureConfigDir();
  const lockPath = `${getConfigPath(CONNECTIONS_FILE)}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lockPath, 'wx'));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let age = 0;
      try { age = Date.now() - statSync(lockPath).mtimeMs; } catch { continue; } // released meanwhile
      if (age > LOCK_STALE_MS) { rmSync(lockPath, { force: true }); continue; }
      if (Date.now() > deadline) throw new Error(`Another sail-proxy command is changing the connections; try again (or delete ${lockPath} if none is running)`);
      sleepSync(25);
    }
  }
  try {
    return change();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

function findConnection(file: ConnectionsFile, name: string): ConnectionEntry {
  const found = file.connections.find((c) => c.name === name);
  if (!found) throw new Error(`Unknown connection "${name}"`);
  return found;
}

export function addConnection(conn: ConnectionEntry): void {
  withLock(() => {
    const file = readConnections();
    if (file.connections.some((c) => c.name === conn.name)) throw new Error(`Connection "${conn.name}" already exists`);
    file.connections.push(conn);
    writeConnections(file);
  });
}

/** Returns the model ids the connection published, now withdrawn. */
export function removeConnection(name: string): string[] {
  return withLock(() => {
    const file = readConnections();
    const conn = findConnection(file, name);
    file.connections = file.connections.filter((c) => c.name !== name);
    writeConnections(file);
    return (conn.models ?? []).map((m) => modelIdOf(m.upstreamModel, name));
  });
}

export function addModel(name: string, model: ConnectionModelEntry): void {
  withLock(() => {
    const file = readConnections();
    const conn = findConnection(file, name);
    if ((conn.models ?? []).some((m) => m.upstreamModel === model.upstreamModel)) {
      throw new Error(`Model "${model.upstreamModel}" already exists on connection "${name}"`);
    }
    conn.models = [...(conn.models ?? []), model];
    writeConnections(file);
  });
}

export function removeModel(name: string, upstreamModel: string): void {
  withLock(() => {
    const file = readConnections();
    const conn = findConnection(file, name);
    if (!(conn.models ?? []).some((m) => m.upstreamModel === upstreamModel)) {
      throw new Error(`Unknown model "${upstreamModel}" on connection "${name}"`);
    }
    conn.models = (conn.models ?? []).filter((m) => m.upstreamModel !== upstreamModel);
    writeConnections(file);
  });
}
