/**
 * GET /api/plugins/settings-schemas (spec 2026-11-04 §6): the settings schema of each enabled plugin,
 * with the plugin's help for the asked language written into `title`/`description`, for the config
 * form to add under `plugins`. Reads manifests only, never package content.
 */
import { getDefaultLogger } from '@libs/logger';
import { applyHelpToSchema, resolveHelp } from '@libs/plugin-package';
import type { PluginManifest } from '@libs/plugin-package';
import type { OperationResult } from './pluginOperations';
import { readEnabledManifests } from './pluginStore';

const logger = getDefaultLogger();

const DEFAULT_LANG = 'en';
const MAX_LANG_LENGTH = 35;

// A plugin version's fallback is logged once per process, however often the config app asks.
const loggedFallback = new Set<string>();

export type SettingsSchemaEntry = { id: string; schema: object; summary: string; helpFallback: boolean };

const langOf = (raw: unknown): string =>
  typeof raw === 'string' && raw.trim() !== '' && raw.length <= MAX_LANG_LENGTH ? raw.trim() : DEFAULT_LANG;

// The form shows a setting's default where the document holds no value, so the manifest defaults go into the
// top-level properties' `default`. A default the schema declares itself wins. Works on the copy help produced.
function withManifestDefaults(schema: object, defaults: Record<string, unknown> | undefined): object {
  const properties = (schema as { properties?: Record<string, Record<string, unknown>> }).properties;
  if (!properties || !defaults) return schema;
  for (const [key, value] of Object.entries(defaults)) {
    const property = Object.prototype.hasOwnProperty.call(properties, key) ? properties[key] : undefined;
    if (property && typeof property === 'object' && property.default === undefined) property.default = value;
  }
  return schema;
}

function entryOf(id: string, version: string, manifestText: string, lang: string): SettingsSchemaEntry | null {
  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(manifestText) as PluginManifest;
  } catch {
    return null;
  }
  if (!manifest.settings?.schema || typeof manifest.help !== 'object' || manifest.help === null || Object.keys(manifest.help).length === 0) return null;
  const { lang: used, fallback, help } = resolveHelp(manifest, lang);
  if (fallback && !loggedFallback.has(`${id}@${version}`)) {
    loggedFallback.add(`${id}@${version}`);
    logger.info('Plugins', `"${id}" ${version} has no help in "${lang}"; showing "${used}".`);
  }
  const schema = applyHelpToSchema(manifest.settings.schema, help.settings);
  return { id, schema: withManifestDefaults(schema, manifest.settings.defaults), summary: help.summary, helpFallback: fallback };
}

export async function listSettingsSchemas(lang: unknown): Promise<OperationResult> {
  const wanted = langOf(lang);
  const enabled = await readEnabledManifests();
  const entries = [...enabled.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([id, found]) => entryOf(id, found.version, found.manifest, wanted))
    .filter((e): e is SettingsSchemaEntry => e !== null);
  return { status: 200, body: entries };
}
