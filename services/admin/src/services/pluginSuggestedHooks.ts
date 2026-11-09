/**
 * POST /api/plugins/:id/suggested-hooks and /api/plugins/suggested-hooks (spec 2026-11-04 §7): a new stored
 * configuration made from the active one with the enabled versions' suggested hooks merged in. It goes through createConfiguration,
 * so the usual validation applies, and it is never activated: the admin activates it the usual way,
 * which keeps config history as the undo.
 */
import { isDeepStrictEqual } from 'util';
import type { PluginManifest } from '@libs/plugin-package';
import { activeConfiguration } from './pluginConfigRefs';
import { HookConflictError, hasSuggestedHooks, mergeSuggestedHooks } from './pluginHooks';
import { audit } from './pluginOperations';
import type { Actor, OperationResult } from './pluginOperations';
import * as store from './pluginStore';

const cds = require('@sap/cds');

const MAX_NAME_LENGTH = 100; // ApiConfigurations.name

const fail = (status: number, error: string, message: string, extra: Record<string, unknown> = {}): OperationResult =>
  ({ status, body: { error, message, ...extra } });

/** Single plugin: POST /api/plugins/:id/suggested-hooks. */
export function addSuggestedHooks(id: string, actor: Actor): Promise<OperationResult> {
  return addSuggestedHooksFor([id], actor);
}

/**
 * Several plugins, one configuration: activating one of several would leave out the hooks of the others.
 * A plugin that is missing or not enabled refuses the whole request. One with nothing to add is left out and
 * named in `warnings`; when that is all of them, the first one's refusal is the answer.
 */
export async function addSuggestedHooksFor(ids: string[], actor: Actor): Promise<OperationResult> {
  const enabled = await store.readEnabledManifests();
  const candidates: { id: string; version: string; manifest: PluginManifest }[] = [];
  const nothingToAdd: OperationResult[] = [];
  for (const id of ids) {
    const found = enabled.get(id);
    if (!found) {
      return (await store.countPackages(id)) === 0
        ? fail(404, 'PLUGIN_NOT_FOUND', `There is no plugin "${id}".`)
        : fail(409, 'PLUGIN_NOT_ENABLED', `"${id}" is not enabled; enable a version first.`);
    }
    let manifest: PluginManifest;
    try {
      manifest = JSON.parse(found.manifest) as PluginManifest;
    } catch {
      return fail(409, 'MANIFEST_UNREADABLE', `The manifest of "${id}" ${found.version} cannot be read.`);
    }
    if (hasSuggestedHooks(manifest)) candidates.push({ id, version: found.version, manifest });
    else nothingToAdd.push(fail(400, 'NO_SUGGESTED_HOOKS', `"${id}" ${found.version} suggests no hooks.`));
  }
  if (candidates.length === 0) return nothingToAdd[0];

  const active = await activeConfiguration();
  if (!active) return fail(409, 'NO_ACTIVE_CONFIGURATION', 'No configuration is active, so there is nothing to add the hooks to. Activate a configuration first.');

  let apiConfig = (active.configData.api_config ?? {}) as Record<string, unknown>;
  const added: typeof candidates = [];
  const mergeWarnings: string[] = [];
  for (const candidate of candidates) {
    let merged: ReturnType<typeof mergeSuggestedHooks>;
    try {
      merged = mergeSuggestedHooks(apiConfig, candidate.manifest);
    } catch (error) {
      if (error instanceof HookConflictError) return fail(409, 'HOOK_CONFLICT', error.message);
      throw error;
    }
    if (isDeepStrictEqual(merged.apiConfig, apiConfig)) {
      nothingToAdd.push(fail(409, 'HOOKS_ALREADY_PRESENT', `The active configuration already has all hooks of "${candidate.id}" ${candidate.version}.`));
      continue;
    }
    apiConfig = merged.apiConfig;
    added.push(candidate);
    mergeWarnings.push(...merged.warnings);
  }
  if (added.length === 0) return nothingToAdd[0];

  const labels = added.map((plugin) => `${plugin.id} ${plugin.version}`);
  const name = (added.length === 1 ? `${labels[0]} suggested hooks` : `Suggested hooks: ${labels.join(', ')}`).slice(0, MAX_NAME_LENGTH);
  const description = added.length === 1
    ? `Hooks suggested by plugin "${added[0].id}" ${added[0].version}, added to the configuration that was active.`
    : `Hooks suggested by plugins ${labels.join(', ')}, added to the configuration that was active.`;
  const req: any = actor.req;
  const user = new cds.User({ id: actor.id, roles: req?.user?.roles ?? [], attr: req?.user?.attr ?? {} });
  const created = await cds.tx({ user }, () => cds.services.AdminService.send('createConfiguration', {
    name,
    configData: JSON.stringify({ ...active.configData, api_config: apiConfig }),
    description,
  }));
  if (!created?.success) {
    if (Array.isArray(created?.errors)) {
      return fail(400, 'CONFIGURATION_INVALID', 'The configuration with the suggested hooks is not valid; nothing was created.', { errors: created.errors, warnings: created.warnings ?? [] });
    }
    throw new Error(created?.error ?? 'createConfiguration failed');
  }
  for (const plugin of added) await audit(actor, 'plugin.suggest_hooks', plugin.id, 'medium', { version: plugin.version, configId: created.configId });
  const leftOut = nothingToAdd.map((refusal) => String((refusal.body as { message?: unknown }).message));
  return { status: 200, body: { configId: created.configId, version: created.version, name, warnings: [...mergeWarnings, ...leftOut, ...(created.warnings ?? [])] } };
}
