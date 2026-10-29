/**
 * Whether pseudonymization is forced for a request, and whether the plugin will actually run.
 *
 * "Forced" has one definition, used by the plugin itself and by the controllers that refuse a
 * forced request the plugin would not see: `models.overrides.<model>.pseudonymization.enabled`
 * (the model that serves the request, after substitution) first, then
 * `hooks.defaults.<endpoint>.pseudonymization.enabled` for every endpoint on the request's path:
 * the one the controller set as `__endpoint`, and any route that handed the request on to another
 * route's flow (recordRouteEndpoint; Bedrock models without a deployment run the /anthropic flow).
 *
 * "Will run" is the plugin executor's own selection (pluginLoader.selectRule): the resolved hook
 * chain has an entry for pseudonymizationPlugin, its match fits this request, and the plugin is
 * registered. A forced request for which that is not true is refused with 503
 * `pseudonymization_hook_missing` before anything is sent upstream.
 *
 * The check marks a forced request (MUST_RUN_FLAG). Should the plugin then not be reached after
 * all (an earlier plugin in the chain changed what its hook matches on), the executor refuses the
 * request at the end of the before-chain instead of letting it go on unmasked.
 */
import { Response } from 'express';
import { getDefaultLogger } from '@libs/logger';
import configService, { PseudonymizationConfig, DefaultHookEntry } from '../../services/configService';
import pluginLoader from '../../services/pluginLoader';
import { PSEUDONYMIZATION_RULE_ID, MUST_RUN_FLAG, EXEMPT_FLAG } from './failClosed';

const logger = getDefaultLogger();

export const PSEUDONYMIZATION_HOOK_MISSING_CODE = 'pseudonymization_hook_missing';

/** The model that serves the request, set by the controller when it differs from `body.model`. */
export const SERVED_MODEL_FIELD = '__servedModel';

/** Endpoints the request passed through before the flow that serves it (recordRouteEndpoint). */
export const ROUTE_ENDPOINTS_FIELD = '__routeEndpoints';

/**
 * Record that the request entered through `endpoint` before being handed to another route's flow,
 * which sets its own `__endpoint`: that route's force flag still applies (readForceSource).
 */
export function recordRouteEndpoint(req: any, endpoint: string): void {
  const seen: string[] = Array.isArray(req[ROUTE_ENDPOINTS_FIELD]) ? req[ROUTE_ENDPOINTS_FIELD] : [];
  if (!seen.includes(endpoint)) req[ROUTE_ENDPOINTS_FIELD] = [...seen, endpoint];
}


/**
 * The model whose per-model settings apply: the served model the controller recorded (a bare
 * name on /responses served by its `--deployed` twin, whose overrides are keyed by that id), else
 * the model the request names.
 */
export function servedModelOf(req: any): string | undefined {
  const served = req?.[SERVED_MODEL_FIELD];
  if (typeof served === 'string' && served) return served;
  const named = req?.body?.model;
  return typeof named === 'string' && named ? named : undefined;
}

export interface ForceSource {
  /** The configuration block that forces masking. */
  block: PseudonymizationConfig;
  source: 'model' | 'endpoint';
}

/**
 * The configuration block that forces pseudonymization for this request, or null when nothing
 * forces it. Throws when the configuration cannot be read: the caller decides what an unknown
 * answer means, and both callers treat it as forced.
 */
export function readForceSource(req: any): ForceSource | null {
  const config = configService.getConfig();

  // Per-model force flag. The substitution lookup reads the `anthropic` provider's
  // substitute_models whatever the endpoint: inherited from the plugin, which always resolved its
  // per-model settings that way (Claude clients send names that config maps to served ids); for a
  // name with no substitution it returns the name unchanged. Quiet: this runs at the end of every
  // hook chain without the plugin, and the request is not being substituted here.
  const modelName = servedModelOf(req);
  const overrides = config?.api_config?.models?.overrides;
  if (modelName && overrides) {
    const substituted = configService.getSubstitutedModel('anthropic', modelName, { quiet: true }) || modelName;
    const block = overrides[substituted]?.pseudonymization;
    if (block?.enabled) return { block, source: 'model' };
  }

  // Per-endpoint force flag (hooks.defaults[endpoint].pseudonymization.enabled): the serving
  // flow's endpoint first, then every route the request entered through.
  const endpointHooks = config?.api_config?.hooks?.defaults as Record<string, DefaultHookEntry> | undefined;
  const routeEndpoints = Array.isArray(req?.[ROUTE_ENDPOINTS_FIELD]) ? req[ROUTE_ENDPOINTS_FIELD] : [];
  for (const endpoint of [req?.__endpoint, ...routeEndpoints]) {
    if (!endpoint) continue;
    const block = endpointHooks?.[endpoint]?.pseudonymization;
    if (block?.enabled) return { block, source: 'endpoint' };
  }

  return null;
}

export interface ForcedPseudonymizationCheck {
  /** Masking is forced for this request, or the configuration could not tell. */
  forced: boolean;
  /** The plugin executor would run pseudonymizationPlugin for this request with these hooks. */
  willRun: boolean;
}

/**
 * Answer both questions for a request about to run `hooks` (the chain getHookConfig resolved for
 * its model and subpath). Call it after setting `req.__endpoint` and right before
 * executeBeforePlugins, passing the model that serves the request (its per-model overrides are
 * the ones that apply); refuse when `forced && !willRun`.
 */
export function checkForcedPseudonymization(req: any, hooks: unknown, servedModel?: string): ForcedPseudonymizationCheck {
  if (servedModel) req[SERVED_MODEL_FIELD] = servedModel;
  let forced: boolean;
  try {
    forced = readForceSource(req) !== null;
  } catch {
    // A configuration that cannot be read cannot vouch that masking is optional.
    logger.error('pseudonymization', 'The pseudonymization force flags could not be read from the configuration; treating the request as forced');
    forced = true;
  }

  let willRun = false;
  try {
    const chain = !hooks ? [] : Array.isArray(hooks) ? hooks : [hooks];
    willRun = chain.some((hook: any) =>
      hook?.request?.callback?.id === PSEUDONYMIZATION_RULE_ID
      && pluginLoader.selectRule(req, hook, 'before')?.rule != null);
  } catch {
    logger.error('pseudonymization', 'Could not determine whether the pseudonymization plugin runs for this request; treating it as not running');
    willRun = false;
  }

  if (forced) req[MUST_RUN_FLAG] = true;
  return { forced, willRun };
}

/**
 * Embeddings are never pseudonymized: a masked input would be embedded instead of the real text,
 * so the vector would describe a placeholder. For an embedding request on a route that runs the
 * plugin chain, drop the pseudonymization plugin from `hooks` and exempt the request from the
 * executor's forced backstop; the other plugins still run. Returns the chain to run, or null when
 * nothing is left of it.
 */
export function exemptFromPseudonymization<T>(req: any, hooks: T): T | null {
  req[EXEMPT_FLAG] = true;
  if (!hooks) return null;
  const chain = (Array.isArray(hooks) ? hooks : [hooks])
    .filter((hook: any) => hook?.request?.callback?.id !== PSEUDONYMIZATION_RULE_ID);
  return chain.length ? (chain as unknown as T) : null;
}

/**
 * Refuse a forced request the pseudonymization plugin would not see: 503 `api_error` /
 * `pseudonymization_hook_missing`. Returns the message, for the caller's log line.
 */
function refuseHookMissing(res: Response, endpoint: string, subPaths: string[]): string {
  const keys = subPaths.map((s) => `\`${s}\``).join(' / ');
  const message = `Pseudonymization is enforced for this request but the pseudonymization plugin is not configured to run for ${keys}. `
    + `Activate a configuration whose hooks for ${keys} (under \`hooks.defaults.${endpoint}\` or the model's own hooks) `
    + 'run pseudonymizationPlugin for this request before using this route.';
  res.status(503).json({ error: { message, type: 'api_error', code: PSEUDONYMIZATION_HOOK_MISSING_CODE } });
  return message;
}

export interface ForcedRunTarget {
  /** The `hooks.defaults` key whose chain was resolved, named in the refusal. */
  endpoint: string;
  /** The hook keys that chain was resolved for, named in the refusal. */
  subPaths: string[];
  /** The model that serves the request, when it differs from `body.model`. */
  servedModel?: string;
  /** The log component of the caller. */
  component: string;
}

/**
 * The controllers' fail-closed step, right before executeBeforePlugins: when pseudonymization is
 * forced for this request and `hooks` would not run the plugin, answer 503
 * `pseudonymization_hook_missing` and return true (the caller returns without calling upstream).
 */
export function refuseIfForcedWithoutPlugin(req: any, res: Response, hooks: unknown, target: ForcedRunTarget): boolean {
  const { forced, willRun } = checkForcedPseudonymization(req, hooks, target.servedModel);
  if (!forced || willRun) return false;
  const message = refuseHookMissing(res, target.endpoint, target.subPaths);
  logger.error(target.component, `${message} (model=${servedModelOf(req) ?? 'unknown'})`);
  return true;
}
