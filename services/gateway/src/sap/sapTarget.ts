/**
 * The SAP AI Core target every SAP call uses: service URL, OAuth credentials, region, resource
 * group and the tenant they belong to. Callers read it with currentSapTarget() at call time, never
 * into a module constant, so an installed target takes effect on the next call.
 *
 * Until a target is installed it is built from the environment, with the same defaults the
 * gateway always used (region us-east-1, resource group default, SAP_AI_CORE_URL else the region's
 * AI API URL). The environment is read lazily and rebuilt only when one of its inputs changes, so
 * a dotenv load that runs after this module was imported is still seen.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { createHash } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { tenantFromAuthUrl } from '@libs/service-key-parser/parser';
import { getDefaultLogger } from '@libs/logger';

const logger = getDefaultLogger();

export interface SapTarget {
  aiCoreUrl: string;
  authUrl: string;
  clientId: string;
  clientSecret: string;
  region: string;
  resourceGroup: string;
  tenant: string;
  source: 'environment' | 'connection';
  connectionId: string | null;
  fingerprint: string;
  version: number;
}

type SapTargetInputs = Omit<SapTarget, 'fingerprint' | 'version'>;

/** The tenant of an environment whose AUTH_URL is missing or has no usable host. */
const UNKNOWN_TENANT = 'unknown';

const listeners: Array<(t: SapTarget) => void> = [];
let version = 0;
let installed: SapTarget | null = null;
let environmentCache: { key: string; target: SapTarget } | null = null;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** sha256 hex of url|auth|client|group|tenant|sha256(secret): names the target without carrying the secret. */
export function sapTargetFingerprint(t: SapTargetInputs): string {
  return sha256([t.aiCoreUrl, t.authUrl, t.clientId, t.resourceGroup, t.tenant, sha256(t.clientSecret)].join('|'));
}

function tenantOf(authUrl: string, aiCoreUrl: string): string {
  if (!authUrl) return UNKNOWN_TENANT;
  try {
    return tenantFromAuthUrl(authUrl, aiCoreUrl).zone;
  } catch {
    return UNKNOWN_TENANT;
  }
}

/** The AWS region of a SAP AI Core region, whichever format it has: "us-east-1" (environment) or "prod.us-east-1" (service key). */
export function awsRegionFromSapRegion(sapRegion: string): string {
  return sapRegion.includes('.') ? (sapRegion.split('.')[1] || 'us-east-1') : sapRegion;
}

/** The target the environment describes; never throws, whatever the environment holds. */
export function environmentSapTarget(): SapTarget {
  const key = JSON.stringify([process.env.AUTH_URL, process.env.CLIENT_ID, process.env.CLIENT_SECRET, process.env.SAP_AI_REGION, process.env.SAP_AI_CORE_URL, process.env.SAP_AI_RESOURCE_GROUP]);
  if (environmentCache && environmentCache.key === key) return environmentCache.target;

  const region = process.env.SAP_AI_REGION || 'us-east-1';
  const aiCoreUrl = process.env.SAP_AI_CORE_URL || `https://api.ai.${region}.aws.ml.hana.ondemand.com`;
  const authUrl = process.env.AUTH_URL || '';
  const inputs: SapTargetInputs = {
    aiCoreUrl,
    authUrl,
    clientId: process.env.CLIENT_ID || '',
    clientSecret: process.env.CLIENT_SECRET || '',
    region,
    resourceGroup: process.env.SAP_AI_RESOURCE_GROUP || 'default',
    tenant: tenantOf(authUrl, aiCoreUrl),
    source: 'environment',
    connectionId: null
  };
  const target: SapTarget = { ...inputs, fingerprint: sapTargetFingerprint(inputs), version };
  environmentCache = { key, target };
  return target;
}

/** The target installed last, else the environment's. */
export function latestSapTarget(): SapTarget {
  return installed ?? environmentSapTarget();
}

/** The target a request started with; it keeps it when another one is installed meanwhile. */
const pinned = new AsyncLocalStorage<SapTarget>();

/** The target SAP calls use now: the one the running request started with, else the latest. */
export function currentSapTarget(): SapTarget {
  return pinned.getStore() ?? latestSapTarget();
}

/** Runs `fn` (and everything it awaits or schedules) against `target`, whatever is installed meanwhile. */
export function withSapTarget<T>(target: SapTarget, fn: () => T): T {
  return pinned.run(target, fn);
}

/**
 * Runs a background job (a file_search worker item) against the target installed now: its SAP calls
 * and the usage events it emits share that one target, whatever is installed while it runs.
 */
export function withLatestSapTarget<T>(fn: () => T): T {
  return pinned.run(latestSapTarget(), fn);
}

/**
 * Whether a cache filled from `target` may be written: false once a newer target was installed.
 * The guard keeps an old target's data out of the caches; it does not keep a request pinned to the
 * old target A from reading what the new target B refilled after a switch (a model list, a
 * deployment id). Such a call can fail in the switch window; it is never booked to the wrong
 * tenant, because the usage event carries the pinned target's tenant.
 */
export function isLatestSapTarget(target: SapTarget): boolean {
  return target.version === latestSapTarget().version;
}

/** Makes `next` the current target under a new version and tells every listener. */
export function installSapTarget(next: SapTarget): void {
  version += 1;
  const { fingerprint: _ignored, version: _old, ...inputs } = next;
  installed = { ...inputs, fingerprint: sapTargetFingerprint(inputs), version };
  for (const listener of listeners) {
    try {
      listener(installed);
    } catch (error) {
      logger.error('SapTarget', 'A target-change listener failed', error instanceof Error ? error : new Error(String(error)));
    }
  }
  logger.info('SapTarget', `SAP AI Core target is now ${installed.source} tenant ${installed.tenant} (version ${installed.version})`);
}

/** Registers a listener called after every installSapTarget, e.g. to drop a cache the old target filled. */
export function onSapTargetChange(listener: (t: SapTarget) => void): void {
  listeners.push(listener);
}

/**
 * Pins the request to the current target and stamps it with that tenant, before the routes run:
 * the SAP call goes where the usage event (which carries the stamp) says, even when a new target
 * is installed while the request runs.
 */
export function sapTenantMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const target = currentSapTarget();
  stampSapTenant(req, target);
  withSapTarget(target, next);
}

/** The serving tenant and where its target came from, as the request's usage event carries them. */
export function stampSapTenant(req: object, target: SapTarget): void {
  (req as any).__sapTenant = target.tenant;
  (req as any).__sapTenantSource = target.source;
}
