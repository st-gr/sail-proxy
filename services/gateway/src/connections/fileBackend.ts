/**
 * The Connections snapshot from connections.json, for a standalone gateway without an admin
 * (spec 2026-10-27 E). The file is re-read on every fetch (the registry's TTL and reload decide
 * how often); a missing file is no connections, a malformed one rejects so the registry keeps its
 * last snapshot. Secrets are inline or `{ "env": NAME }` refs resolved at fetch time. Validation
 * errors carry a path (`connections[1].models[0].family`), never a value, and nothing here logs one.
 * The same rules are shared with the CLI through test/fixtures/connections-file-cases.json.
 */
import { promises as fsp } from 'fs';
import * as path from 'path';
import { getDefaultLogger } from '@libs/logger';
import type { Connection, ConnectionBackend, ConnectionModel, ModelFamily, ProviderType } from './types';

const logger = getDefaultLogger();

export class ConnectionsFileError extends Error {
  constructor(public readonly path: string, reason: string) {
    super(path ? `connections file: ${reason} at ${path}` : `connections file: ${reason}`);
    this.name = 'ConnectionsFileError';
  }
}

const FILE_TYPES: readonly string[] = ['openai', 'azure-openai', 'anthropic', 'bedrock'];
const NAME_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;
/** An env-ref name; anything else (a pasted key, say) is refused without echoing it. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FAMILIES: readonly string[] = ['openai', 'claude'];
const TOP_KEYS = ['version', 'connections'];
const CONNECTION_KEYS = ['name', 'type', 'active', 'settings', 'secret', 'sessionToken', 'models'];
const MODEL_KEYS = ['upstreamModel', 'family', 'displayName', 'capabilities'];
// What the adapters read, per provider type.
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
const present = (v: string | null | undefined): boolean => typeof v === 'string' && v.trim().length > 0;

/** https anywhere; http only on loopback, where test fakes listen. null when fine or absent. */
function urlError(value: string | null | undefined): string | null {
  if (!present(value)) return null;
  let url: URL;
  try { url = new URL(value as string); } catch { return 'must be a URL'; }
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return null;
  return 'must be an https URL (http only on localhost or 127.0.0.1)';
}

/** The per-type rules; an absent apiMode/authMode takes the cockpit's default (v1, api-key, access-key). */
function checkTypeRules(type: string, s: Record<string, string | null>, at: string): void {
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

/** A secret is a non-empty string or `{ "env": NAME }`; an unset or empty env var resolves to null. */
function resolveSecret(value: unknown, at: string, env: NodeJS.ProcessEnv): string | null {
  if (typeof value === 'string') {
    if (!value) throw new ConnectionsFileError(at, 'must not be empty');
    return value;
  }
  if (isObject(value)) {
    checkKeys(value, ['env'], at);
    if (typeof value.env !== 'string' || !ENV_NAME_PATTERN.test(value.env)) throw new ConnectionsFileError(`${at}.env`, 'must be an environment variable name ([A-Za-z_][A-Za-z0-9_]*)');
    // Own string properties only: a name such as toString must not resolve to Object.prototype's.
    const resolved = Object.prototype.hasOwnProperty.call(env, value.env) ? env[value.env] : undefined;
    return typeof resolved === 'string' && resolved ? resolved : null;
  }
  throw new ConnectionsFileError(at, 'must be a string or { "env": NAME }');
}

function parseModel(raw: unknown, at: string, type: string, seen: Set<string>, name: string): ConnectionModel {
  if (!isObject(raw)) throw new ConnectionsFileError(at, 'must be an object');
  checkKeys(raw, MODEL_KEYS, at);
  const upstreamModel = raw.upstreamModel;
  if (typeof upstreamModel !== 'string' || !UPSTREAM_MODEL.test(upstreamModel)) {
    throw new ConnectionsFileError(`${at}.upstreamModel`, "must be 1-64 characters of letters, digits, '.', '_', ':' and '-', starting with a letter or digit");
  }
  if (seen.has(upstreamModel)) throw new ConnectionsFileError(`${at}.upstreamModel`, 'duplicate within the connection');
  seen.add(upstreamModel);
  const defaultFamily: ModelFamily = type === 'anthropic' || type === 'bedrock' ? 'claude' : 'openai';
  if (raw.family !== undefined && (typeof raw.family !== 'string' || !FAMILIES.includes(raw.family))) {
    throw new ConnectionsFileError(`${at}.family`, 'must be openai or claude');
  }
  if (raw.displayName !== undefined && typeof raw.displayName !== 'string') throw new ConnectionsFileError(`${at}.displayName`, 'must be a string');
  const caps = raw.capabilities;
  if (caps !== undefined && (!Array.isArray(caps) || caps.some((c) => typeof c !== 'string'))) {
    throw new ConnectionsFileError(`${at}.capabilities`, 'must be an array of strings');
  }
  return {
    modelId: `${upstreamModel}--${name}`,
    upstreamModel,
    displayName: (raw.displayName as string | undefined) ?? null,
    family: (raw.family as ModelFamily | undefined) ?? defaultFamily,
    capabilities: (caps as string[] | undefined) ?? [],
    priced: true,
  };
}

function parseConnection(raw: unknown, i: number, names: Set<string>, env: NodeJS.ProcessEnv): Connection {
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

  const settings: Record<string, string | null> = {};
  if (raw.settings !== undefined) {
    if (!isObject(raw.settings)) throw new ConnectionsFileError(`${at}.settings`, 'must be an object');
    for (const [key, value] of Object.entries(raw.settings)) {
      if (!SETTINGS_KEYS[type].includes(key)) throw new ConnectionsFileError(`${at}.settings.${key}`, `unknown setting for ${type}`);
      if (typeof value !== 'string') throw new ConnectionsFileError(`${at}.settings.${key}`, 'must be a string');
      settings[key] = value;
    }
  }
  checkTypeRules(type, settings, at);

  if (raw.sessionToken !== undefined && !(type === 'bedrock' && (settings.authMode ?? 'access-key') === 'access-key')) {
    throw new ConnectionsFileError(`${at}.sessionToken`, 'applies to bedrock with access-key auth only');
  }
  const secret = raw.secret === undefined ? null : resolveSecret(raw.secret, `${at}.secret`, env);
  const sessionToken = raw.sessionToken === undefined ? null : resolveSecret(raw.sessionToken, `${at}.sessionToken`, env);

  const models: ConnectionModel[] = [];
  if (raw.models !== undefined) {
    if (!Array.isArray(raw.models)) throw new ConnectionsFileError(`${at}.models`, 'must be an array');
    const seen = new Set<string>();
    raw.models.forEach((m, j) => models.push(parseModel(m, `${at}.models[${j}]`, type, seen, name)));
  }

  return {
    id: name,
    name,
    providerType: type as ProviderType,
    isActive: raw.active !== false,
    settings,
    credentials: secret ? { secret, ...(sessionToken ? { sessionToken } : {}) } : null,
    models,
  };
}

/** Validates the file text and maps it to the snapshot; throws ConnectionsFileError (path only, no values). */
export function parseConnectionsFile(text: string, env: NodeJS.ProcessEnv): Connection[] {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { throw new ConnectionsFileError('', 'not valid JSON'); }
  if (!isObject(doc)) throw new ConnectionsFileError('', 'must be a JSON object');
  checkKeys(doc, TOP_KEYS, '');
  if (doc.version !== 1) throw new ConnectionsFileError('version', 'must be 1');
  if (!Array.isArray(doc.connections)) throw new ConnectionsFileError('connections', 'must be an array');
  const names = new Set<string>();
  return doc.connections.map((c, i) => parseConnection(c, i, names, env));
}

/** CONNECTIONS_FILE_PATH, else connections.json beside the config file; null when neither is set. */
export function connectionsFilePath(env: NodeJS.ProcessEnv): string | null {
  if (env.CONNECTIONS_FILE_PATH) return env.CONNECTIONS_FILE_PATH;
  if (env.CONFIG_FILE_PATH) return path.join(path.dirname(env.CONFIG_FILE_PATH), 'connections.json');
  return null;
}

export function fileConnectionBackend(filePath: string, env: NodeJS.ProcessEnv = process.env): ConnectionBackend {
  let warnedLoose = false;
  // The last refusal logged: a broken file is retried every 10 s and logged again only once it changes.
  let lastRefusal: string | null = null;
  return {
    fetch: async () => {
      let text: string;
      let mode: number;
      try {
        // Text and mode from one handle: a file replaced or removed in between cannot fail the fetch.
        const handle = await fsp.open(filePath, 'r');
        try {
          text = await handle.readFile('utf8');
          mode = (await handle.stat()).mode;
        } finally {
          await handle.close();
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return [];
        logger.error('ConnectionsFile', `${filePath} could not be read (${code ?? 'unknown error'}); keeping the last snapshot`);
        throw error;
      }
      if (!warnedLoose && process.platform !== 'win32' && mode & 0o077) {
        warnedLoose = true;
        logger.warn('ConnectionsFile', `${filePath} has permissions looser than 0600 (it holds secrets); run chmod 600 on it`);
      }
      try {
        const connections = parseConnectionsFile(text, env);
        lastRefusal = null;
        return connections;
      } catch (error) {
        if (error instanceof ConnectionsFileError && error.message !== lastRefusal) {
          lastRefusal = error.message;
          logger.warn('ConnectionsFile', `${filePath} refused at ${error.path || '(document)'}; keeping the last snapshot`);
        }
        throw error;
      }
    },
  };
}
