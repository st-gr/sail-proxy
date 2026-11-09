/**
 * What the admin checks about plugins when a configuration is validated or saved (spec 2026-11-04 §6):
 * `plugins.<id>` against the enabled plugin's settings schema, and `callback.id`s against the rules
 * the gateways report. Runs on every validate and save, so it reads the manifests of enabled plugins
 * only, never package content. Standalone has no such check.
 *
 * A failure to read the store or the status is a warning, never an error: it must not stop a save.
 */
import Ajv from 'ajv';
import { getDefaultLogger } from '@libs/logger';
import { activeConfiguration, callbackIds } from './pluginConfigRefs';
import { readGatewayStatus } from './pluginStatus';
import { readEnabledManifests } from './pluginStore';

const logger = getDefaultLogger();

export type PluginCheckResult = { errors: string[]; warnings: string[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A new Ajv per compile: one shared instance remembers a schema's `$id` and refuses it the next time. */
const newAjv = (): Ajv => new Ajv({ allErrors: true, strict: false, validateFormats: false });

/** The ways `value` breaks `schema`, as `<instance path> <message>` (the path is empty for the value itself). */
export function settingsViolations(schema: Record<string, unknown>, value: unknown): string[] {
  const validate = newAjv().compile(schema);
  if (validate(value)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? 'is not valid'}`.trim());
}

type Enabled = Map<string, { version: string; manifest: string }>;

function checkSettings(plugins: Record<string, unknown>, enabled: Enabled, result: PluginCheckResult): void {
  for (const [id, value] of Object.entries(plugins)) {
    const found = enabled.get(id);
    if (!found) {
      result.warnings.push(`plugins.${id} has settings, but "${id}" is not an enabled plugin; they are kept and do nothing.`);
      continue;
    }
    let schema: Record<string, unknown> | undefined;
    try {
      schema = (JSON.parse(found.manifest) as { settings?: { schema?: Record<string, unknown> } }).settings?.schema;
    } catch {
      result.warnings.push(`plugins.${id} could not be checked: the manifest of "${id}" ${found.version} is unreadable.`);
      continue;
    }
    if (!schema) continue;
    try {
      for (const violation of settingsViolations(schema, value)) result.errors.push(`/api_config/plugins/${id}${violation.startsWith('/') ? '' : ' '}${violation}`);
    } catch (error) {
      result.warnings.push(`plugins.${id} could not be checked: the settings schema of "${id}" ${found.version} does not compile (${(error as Error).message}).`);
    }
  }
}

/** The callback ids that hooks.defaults.* and models.overrides.*.hooks.* name. */
function hookCallbackIds(apiConfig: Record<string, unknown>): Set<string> {
  const found = callbackIds((apiConfig.hooks as any)?.defaults);
  const overrides = (apiConfig.models as any)?.overrides;
  if (isRecord(overrides)) for (const model of Object.values(overrides)) callbackIds(isRecord(model) ? model.hooks : undefined, found);
  return found;
}

async function checkCallbacks(apiConfig: Record<string, unknown>, result: PluginCheckResult): Promise<void> {
  const named = hookCallbackIds(apiConfig);
  if (named.size === 0) return;
  let status;
  try {
    status = await readGatewayStatus();
  } catch (error) {
    logger.warn('Plugins', `Could not read the gateways' plugin status: ${(error as Error)?.message ?? error}`);
    result.warnings.push('The hooks could not be checked against the rules the gateways report: the status could not be read.');
    return;
  }
  if (!status.available || status.instances.length === 0) return;
  const reported = new Set<string>();
  for (const i of status.instances) {
    i.plugins.forEach((p) => p.rules.forEach((r) => reported.add(r.id)));
  }
  // One warning for all of them: a configuration whose plugin is not loaded can name twenty rules.
  const missing = [...named].filter((id) => !reported.has(id)).sort();
  if (missing.length === 1) {
    result.warnings.push(`A hook names the rule "${missing[0]}", which no gateway reports; the hook does nothing until a plugin provides it.`);
  } else if (missing.length > 1) {
    result.warnings.push(`Hooks name ${missing.length} rules no gateway reports, so those hooks do nothing until a plugin provides them: ${missing.map((id) => `"${id}"`).join(', ')}.`);
  }
}

export async function checkPluginConfig(apiConfig: unknown): Promise<PluginCheckResult> {
  const result: PluginCheckResult = { errors: [], warnings: [] };
  if (!isRecord(apiConfig)) return result;
  // A plugins section that is not an object is the configuration schema's to refuse.
  if (isRecord(apiConfig.plugins) && Object.keys(apiConfig.plugins).length > 0) {
    try {
      checkSettings(apiConfig.plugins, await readEnabledManifests(), result);
    } catch (error) {
      logger.warn('Plugins', `Could not read the enabled plugins to check their settings: ${(error as Error)?.message ?? error}`);
      result.warnings.push('The plugin settings could not be checked: the enabled plugins could not be read.');
    }
  }
  await checkCallbacks(apiConfig, result);
  return result;
}

export type EnableWarning = { code: string; message: string };

/**
 * Enabling a version: the settings the active configuration already stores for the plugin, checked against
 * the new version's schema. Only a warning, since the plugin must tolerate settings it did not expect.
 */
export async function storedSettingsWarnings(id: string, version: string, manifestText: string): Promise<EnableWarning[]> {
  try {
    const schema = (JSON.parse(manifestText) as { settings?: { schema?: Record<string, unknown> } }).settings?.schema;
    if (!schema) return [];
    const stored = ((await activeConfiguration())?.configData.api_config as any)?.plugins?.[id];
    if (stored === undefined) return [];
    const violations = settingsViolations(schema, stored);
    return violations.length === 0 ? [] : [{
      code: 'STORED_SETTINGS_INVALID',
      message: `The active configuration stores settings for "${id}" that do not fit version ${version}: ${violations.join('; ')}. Saving that configuration again will be refused until they are fixed.`,
    }];
  } catch (error) {
    logger.warn('Plugins', `Could not check the stored settings of "${id}" against version ${version}: ${(error as Error)?.message ?? error}`);
    return [];
  }
}
