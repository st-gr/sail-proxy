import * as semver from 'semver';

export type PluginHelp = { summary: string; settings?: Record<string, string> };

export type PluginManifest = {
  id: string;
  version: string;
  runtime: 'node';
  gateway: string;
  hooks?: Record<string, unknown>;
  settings?: { schema: Record<string, unknown>; defaults?: Record<string, unknown> };
  help: Record<string, PluginHelp>;
};

export class PluginPackageError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PluginPackageError';
    this.code = code;
  }
}

const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const invalid = (message: string): PluginPackageError => new PluginPackageError('MANIFEST_INVALID', message);

// A plain walk: the schema compile check lives in admin, which owns Ajv.
const containsRef = (node: unknown): boolean => {
  if (Array.isArray(node)) return node.some(containsRef);
  if (!isRecord(node)) return false;
  return Object.keys(node).some(key => key === '$ref' || containsRef(node[key]));
};

const validateHelp = (help: unknown): Record<string, PluginHelp> => {
  if (!isRecord(help) || Object.keys(help).length === 0) {
    throw invalid('help must list at least one language');
  }
  for (const [lang, entry] of Object.entries(help)) {
    if (!isRecord(entry) || typeof entry.summary !== 'string' || entry.summary.trim() === '') {
      throw invalid(`help.${lang} needs a summary`);
    }
    if (entry.settings !== undefined) {
      if (!isRecord(entry.settings) || Object.values(entry.settings).some(text => typeof text !== 'string')) {
        throw invalid(`help.${lang}.settings must map keys to text`);
      }
    }
  }
  return help as Record<string, PluginHelp>;
};

export const validateManifest = (raw: unknown): PluginManifest => {
  if (!isRecord(raw)) throw invalid('manifest.json must be an object');
  if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) {
    throw invalid('id must match ^[a-zA-Z0-9_-]+$');
  }
  if (raw.id === 'node_modules') throw invalid('id "node_modules" is reserved');
  if (typeof raw.version !== 'string' || semver.valid(raw.version) === null) {
    throw invalid('version must be a semver version');
  }
  if (typeof raw.runtime !== 'string') throw invalid('runtime is required');
  if (raw.runtime !== 'node') {
    throw new PluginPackageError('RUNTIME_UNSUPPORTED', `runtime "${raw.runtime}" is not supported; use "node"`);
  }
  if (typeof raw.gateway !== 'string' || semver.validRange(raw.gateway) === null) {
    throw invalid('gateway must be a semver range');
  }
  if (raw.hooks !== undefined && !isRecord(raw.hooks)) throw invalid('hooks must be an object');
  if (raw.settings !== undefined) {
    if (!isRecord(raw.settings) || !isRecord(raw.settings.schema)) throw invalid('settings.schema must be an object');
    if (raw.settings.defaults !== undefined && !isRecord(raw.settings.defaults)) {
      throw invalid('settings.defaults must be an object');
    }
    if (containsRef(raw.settings.schema)) {
      throw new PluginPackageError('SCHEMA_REF_REFUSED', 'settings.schema must not use $ref');
    }
  }
  validateHelp(raw.help);
  return raw as unknown as PluginManifest;
};

export const isCompatible = (manifest: Pick<PluginManifest, 'gateway'>, gatewayVersion: string): boolean => {
  const version = semver.valid(gatewayVersion);
  if (version === null) return false;
  return semver.satisfies(version, manifest.gateway, { includePrerelease: true });
};
