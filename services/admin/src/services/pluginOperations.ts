/**
 * The plugin actions behind /api/plugins (spec 2026-11-04 §7, §8): upload, enable, disable and
 * remove. Each answers `{ status, body }`; the router only translates the HTTP. Errors are
 * `{ error: <CODE>, message }`, with the package library's own code for a refused package.
 *
 * Nothing here holds a transaction open: every store call is its own statement, the package is parsed
 * before the first write, and the change marker goes out after the write has committed.
 */
import * as crypto from 'crypto';
import Ajv from 'ajv';
import { getDefaultLogger } from '@libs/logger';
import { PluginPackageError, isCompatible, parsePluginPackage } from '@libs/plugin-package';
import type { PluginManifest } from '@libs/plugin-package';
import { recordAuditEvent } from './auditEventService';
import type { AuditEventInput } from './auditEventService';
import { clientContext } from '../utils/clientIp';
import { getAdminVersion } from './adminVersion';
import { publishPluginsChanged } from './pluginsNotifier';
import { readGatewayStatus, reportedRuleIds, shippedIds } from './pluginStatus';
import * as store from './pluginStore';
import { activeConfigCallbackIds } from './pluginConfigRefs';
import { storedSettingsWarnings } from './pluginConfigChecks';

const logger = getDefaultLogger();

export type OperationResult = { status: number; body: Record<string, unknown> | unknown[] };
export type Actor = { id: string; req?: unknown };

const MAX_ID_LENGTH = 64;
// The name of GET /api/plugins/settings-schemas; the regex of an id allows it, so upload refuses it.
const RESERVED_IDS = new Set(['settings-schemas']);
// Settings schemas are compiled only to learn that they can be; the options of the configuration check.
// A new instance per check: one shared instance remembers a schema's `$id` and refuses it the next time.
const newAjv = (): Ajv => new Ajv({ allErrors: true, strict: false, validateFormats: false });

const fail = (status: number, error: string, message: string): OperationResult => ({ status, body: { error, message } });

/** 413 for the size limit, 400 for every other refusal of the library. */
export const packageErrorStatus = (code: string): number => (code === 'TOO_LARGE' ? 413 : 400);

export function refuseWhenOff(): OperationResult | null {
  return store.isInstallEnabled()
    ? null
    : fail(403, 'INSTALLED_PLUGINS_DISABLED', 'Installing plugins is switched off: INSTALLED_PLUGINS_ENABLED is set to false on the admin service.');
}

export const audit = (actor: Actor, action: string, pluginId: string, severity: AuditEventInput['severity'], details: Record<string, unknown>): Promise<unknown> =>
  recordAuditEvent({
    actorId: actor.id, actorType: 'admin_user', action, resourceType: 'Plugin', resourceId: pluginId,
    outcome: 'success', severity, ...clientContext({ http: { req: actor.req } }), details: JSON.stringify(details),
  });

const parseManifest = (text: string): PluginManifest | undefined => {
  try { return JSON.parse(text) as PluginManifest; } catch { return undefined; }
};

/** What is wrong with a parsed manifest beyond the library's own checks (storage keys, schema, range), or null. */
function manifestProblem(manifest: PluginManifest): { error: string; message: string } | null {
  if (manifest.id.length > MAX_ID_LENGTH || manifest.version.length > MAX_ID_LENGTH) {
    return { error: 'MANIFEST_INVALID', message: `id and version must each be at most ${MAX_ID_LENGTH} characters` };
  }
  if (RESERVED_IDS.has(manifest.id)) {
    return { error: 'MANIFEST_INVALID', message: `"${manifest.id}" is a reserved name and cannot be a plugin id` };
  }
  try {
    isCompatible(manifest, getAdminVersion());
  } catch {
    return { error: 'MANIFEST_INVALID', message: 'gateway must be a semver range' };
  }
  if (manifest.settings) {
    try {
      newAjv().compile(manifest.settings.schema);
    } catch (error) {
      return { error: 'SETTINGS_SCHEMA_INVALID', message: `settings.schema cannot be compiled: ${(error as Error).message}` };
    }
  }
  return null;
}

export async function uploadPackage(bytes: Buffer, actor: Actor): Promise<OperationResult> {
  const off = refuseWhenOff();
  if (off) return off;
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return fail(400, 'NOT_A_ZIP', 'Send the package as the body of the request, with Content-Type application/zip.');

  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  let manifest: PluginManifest;
  try {
    manifest = parsePluginPackage(bytes).manifest;
  } catch (error) {
    if (error instanceof PluginPackageError) return fail(packageErrorStatus(error.code), error.code, error.message);
    throw error;
  }
  const problem = manifestProblem(manifest);
  if (problem) return fail(400, problem.error, problem.message);

  // With no gateway report the check is skipped; the gateway's own collision check then decides.
  const status = await readGatewayStatus();
  if (shippedIds(status.instances).has(manifest.id)) {
    return fail(409, 'PLUGIN_ID_TAKEN', `A plugin shipped with the gateway already uses the id "${manifest.id}".`);
  }

  const earlier = await sameVersion(manifest, sha256);
  if (earlier) return earlier;
  try {
    await store.insertPackage({
      pluginId: manifest.id, version: manifest.version, sha256, manifest: JSON.stringify(manifest),
      contentBase64: bytes.toString('base64'), sizeBytes: bytes.length,
    }, actor.id);
  } catch (error) {
    if (!store.isUniqueViolation(error)) throw error;
    const raced = await sameVersion(manifest, sha256);
    if (raced) return raced;
    throw error;
  }
  await audit(actor, 'plugin.upload', manifest.id, 'high', { version: manifest.version, sha256, sizeBytes: bytes.length });
  return { status: 201, body: { id: manifest.id, version: manifest.version, sha256, sizeBytes: bytes.length, enabled: false } };
}

/** The answer when this id and version are already stored: 200 for the same package, 409 for another. */
async function sameVersion(manifest: PluginManifest, sha256: string): Promise<OperationResult | null> {
  const existing = await store.findPackage(manifest.id, manifest.version);
  if (!existing) return null;
  if (existing.sha256 === sha256) {
    return { status: 200, body: { id: manifest.id, version: manifest.version, sha256, sizeBytes: existing.sizeBytes, unchanged: true } };
  }
  return fail(409, 'VERSION_EXISTS', `Version ${manifest.version} of "${manifest.id}" is already stored with different content; raise the version.`);
}

export async function enablePlugin(id: string, version: unknown, actor: Actor): Promise<OperationResult> {
  const off = refuseWhenOff();
  if (off) return off;
  if (typeof version !== 'string' || version === '') return fail(400, 'VERSION_REQUIRED', 'Name the version to enable as {"version": "1.2.3"}.');
  const outcome = await store.enableVersion(id, version, actor.id, (pkg) => {
    const manifest = parseManifest(pkg.manifest);
    return !!manifest && isCompatible(manifest, getAdminVersion());
  });
  if (outcome.status === 'missing') return fail(404, 'PACKAGE_NOT_FOUND', `"${id}" has no stored version ${version}.`);
  if (outcome.status === 'refused') {
    const needs = parseManifest(outcome.pkg.manifest)?.gateway ?? '(unreadable manifest)';
    return fail(409, 'INCOMPATIBLE', `"${id}" ${version} needs gateway ${needs}; this is ${getAdminVersion()}.`);
  }
  await publishPluginsChanged();
  await audit(actor, 'plugin.enable', id, 'high', { version, sha256: outcome.pkg.sha256, previousVersion: outcome.previous });
  const warnings = await storedSettingsWarnings(id, version, outcome.pkg.manifest);
  return { status: 200, body: { id, enabledVersion: version, sha256: outcome.pkg.sha256, warnings } };
}

export async function disablePlugin(id: string, actor: Actor): Promise<OperationResult> {
  const previous = (await store.readEnabledVersions()).get(id) ?? null;
  if (previous === null && !(await hasPackages(id))) return fail(404, 'PLUGIN_NOT_FOUND', `There is no plugin "${id}".`);
  // The warning reads what the gateways report now; a gateway that reloads after the marker would report without the rules.
  const warnings = await hookWarnings(id);
  await store.setEnabledVersion(id, null, actor.id);
  await publishPluginsChanged();
  await audit(actor, 'plugin.disable', id, 'medium', { previousVersion: previous });
  return { status: 200, body: { id, enabledVersion: null, warnings } };
}

export async function removeVersion(id: string, version: string, actor: Actor): Promise<OperationResult> {
  const outcome = await store.removeStoredVersion(id, version);
  if (outcome.status === 'missing') return fail(404, 'PACKAGE_NOT_FOUND', `"${id}" has no stored version ${version}.`);
  if (outcome.status === 'enabled') {
    return fail(409, 'VERSION_ENABLED', `Version ${version} of "${id}" is enabled; disable it or enable another version first.`);
  }
  await audit(actor, 'plugin.remove', id, 'medium', { version, sha256: outcome.pkg.sha256 });
  return { status: 200, body: { id, version, removed: true } };
}

const hasPackages = async (id: string): Promise<boolean> => (await store.countPackages(id)) > 0;

/** Hooks in the active configuration that still name a rule this plugin is reported to provide. */
async function hookWarnings(id: string): Promise<{ code: string; message: string; ruleIds: string[] }[]> {
  try {
    const reported = reportedRuleIds((await readGatewayStatus()).instances, id);
    if (reported.size === 0) return [];
    const named = [...(await activeConfigCallbackIds())].filter((rule) => reported.has(rule));
    return named.length === 0 ? [] : [{
      code: 'HOOKS_REFERENCE_PLUGIN',
      message: `The active configuration still has hooks that name rules of "${id}": ${named.join(', ')}. They do nothing until the plugin is enabled again.`,
      ruleIds: named,
    }];
  } catch (error) {
    logger.warn('Plugins', `Could not check the active configuration for hooks of "${id}": ${(error as Error)?.message ?? error}`);
    return [];
  }
}
