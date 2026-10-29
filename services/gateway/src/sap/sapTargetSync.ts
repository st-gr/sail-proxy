/**
 * Follows the admin's active SAP AI Core connection (spec 2026-10-25 §5): every Connections
 * snapshot refresh (the change marker, the registry TTL, the first load at boot) compares the
 * active `sap-ai-core` connection with the current target and switches without a restart.
 *
 * - A new target is installed only after it obtained an OAuth token. A key that fails keeps the
 *   previous target serving - a broken key never takes SAP traffic down - and the log names the
 *   tenant and the reason, never the secret. The next refresh tries again.
 * - Every installed connection target is written as the encrypted last-known copy (lastKnownTarget.ts).
 * - No active connection: the environment target comes back and the last-known copy is cleared.
 * - Boot: the admin's answer if it comes within the registry's wait, else the last-known copy,
 *   else the environment target.
 *
 * The target is built from the credential JSON (`credentials.secret`: aiCoreUrl, authUrl, clientId,
 * clientSecret, region) and `settings.resourceGroup` only; the tenant is `<subdomain>.<landscape>` of the auth URL. The
 * endpoint/region/clientId/tenantId columns are display copies an administrator could patch.
 */
import axios from 'axios';
import { tenantFromAuthUrl } from '@libs/service-key-parser/parser';
import { getDefaultLogger } from '@libs/logger';
import type { Connection } from '../connections/types';
import { FRESH_WAIT_MS, type ConnectionRegistry } from '../connections/connectionRegistry';
import { failureOf, probe, PROBE_TIMEOUT_MS, resultOf } from '../upstreams/probe';
import type { TestResult } from '../upstreams/types';
import { environmentSapTarget, installSapTarget, latestSapTarget, sapTargetFingerprint, type SapTarget } from './sapTarget';
import { clearLastKnown, hasLastKnown, loadLastKnown, saveLastKnown } from './lastKnownTarget';

const logger = getDefaultLogger();

export type SyncResult = 'unchanged' | 'installed' | 'kept-previous' | 'environment';

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** The SAP target a `sap-ai-core` connection describes; throws when its credential is unusable. */
export function targetFromConnection(c: Connection): SapTarget {
  let key: any;
  try {
    key = JSON.parse(c.credentials?.secret ?? '');
  } catch {
    throw new Error('The connection credential is not a SAP AI Core target');
  }
  const aiCoreUrl = text(key?.aiCoreUrl);
  const authUrl = text(key?.authUrl);
  const clientId = text(key?.clientId);
  const clientSecret = text(key?.clientSecret);
  if (!aiCoreUrl || !authUrl || !clientId || !clientSecret) throw new Error('The connection credential is incomplete');
  const inputs = {
    aiCoreUrl,
    authUrl,
    clientId,
    clientSecret,
    region: text(key.region),
    resourceGroup: text(c.settings?.resourceGroup) || 'default',
    tenant: tenantFromAuthUrl(authUrl, aiCoreUrl).zone,
    source: 'connection' as const,
    connectionId: c.id,
  };
  return { ...inputs, fingerprint: sapTargetFingerprint(inputs), version: 0 };
}

/** A client-credentials grant against the target's auth URL; the reason code only on failure. */
async function requestToken(t: SapTarget): Promise<{ ok: true; token: string } | Extract<TestResult, { ok: false }>> {
  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', t.clientId);
    params.append('client_secret', t.clientSecret);
    const response = await axios.post(t.authUrl, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: PROBE_TIMEOUT_MS,
      validateStatus: () => true,
    });
    const result = resultOf(response);
    if (!result.ok) return result;
    const token = response.data?.access_token;
    return typeof token === 'string' && token ? { ok: true, token } : { ok: false, error: { reason: 'upstream_error', status: response.status } };
  } catch (error) {
    return failureOf(error) as Extract<TestResult, { ok: false }>;
  }
}

/** Can this target obtain an OAuth token? Nothing is cached or installed. */
export async function probeSapToken(t: SapTarget): Promise<{ ok: true } | { ok: false; reason: string; status?: number }> {
  const result = await requestToken(t);
  if (result.ok) return { ok: true };
  return { ok: false, reason: result.error.reason, ...(result.error.status ? { status: result.error.status } : {}) };
}

/** The cockpit's connection test: a token, then the foundation-model list with it. Never installs. */
export async function testSapTarget(t: SapTarget): Promise<TestResult> {
  const token = await requestToken(t);
  if (!token.ok) return token;
  try {
    return resultOf(await probe(`${t.aiCoreUrl}/v2/lm/scenarios/foundation-models/models`, {
      Authorization: `Bearer ${token.token}`,
      'AI-Resource-Group': t.resourceGroup,
    }));
  } catch (error) {
    return failureOf(error);
  }
}

const sameTarget = (a: SapTarget, b: SapTarget) => a.fingerprint === b.fingerprint && a.connectionId === b.connectionId;

/**
 * Whether this process has seen a SAP AI Core connection (in a snapshot, or as a last-known copy
 * at boot). Until then a snapshot without one is the normal state of an installation that never
 * had one, and the shared copy is left alone (no Valkey write on every refresh).
 */
let sapConnectionSeen = false;
/** Whether this process has looked for a copy left from a connection removed while it was down. */
let leftoverChecked = false;
/**
 * Whether the shared copy is known to be gone: cleared (or found absent) for a snapshot without an
 * active connection, and no copy written since. Saves a Valkey DEL on every later refresh.
 */
let lastKnownCleared = false;

/** Writes the last-known copy; the next snapshot without an active connection clears it again. */
async function remember(t: SapTarget): Promise<void> {
  lastKnownCleared = false;
  await saveLastKnown(t);
}

/** Brings the SAP target in line with the snapshot's active `sap-ai-core` connection. Never throws. */
export async function syncSapTarget(connections: Connection[]): Promise<SyncResult> {
  const active = connections.find((c) => c.providerType === 'sap-ai-core' && c.isActive === true);
  const current = latestSapTarget();
  if (connections.some((c) => c.providerType === 'sap-ai-core')) sapConnectionSeen = true;

  if (!active) {
    if (!sapConnectionSeen) {
      // Once per process: a copy of a connection the administrator removed or deactivated while
      // this gateway was down must not be installed by a later boot during an admin outage.
      if (!leftoverChecked) {
        leftoverChecked = true;
        lastKnownCleared = (await hasLastKnown()) ? await clearLastKnown() : true;
      }
      return 'unchanged';
    }
    if (!lastKnownCleared) lastKnownCleared = await clearLastKnown();
    if (current.source === 'environment') return 'unchanged';
    installSapTarget(environmentSapTarget());
    logger.info('SapTarget', `No active SAP AI Core connection: serving the environment target again (tenant ${latestSapTarget().tenant})`);
    return 'environment';
  }

  let next: SapTarget;
  try {
    next = targetFromConnection(active);
  } catch {
    if (current.source === 'environment') {
      // As for a failed token: the administrator's choice, as last installed, rather than the environment key.
      const lastKnown = await loadLastKnown();
      if (lastKnown && lastKnown.connectionId === active.id) {
        installSapTarget(lastKnown);
        logger.warn('SapTarget', `SAP AI Core connection ${active.name} (tenant ${lastKnown.tenant}): its credential is unusable (no_credential); serving its last-known target instead of the environment target`);
        return 'installed';
      }
    }
    const message = `SAP AI Core connection ${active.name} kept-previous: its credential is unusable (no_credential); still serving tenant ${current.tenant}`;
    if (current.source === 'environment') logger.error('SapTarget', `${message} from the environment target`);
    else logger.warn('SapTarget', message);
    return 'kept-previous';
  }
  if (sameTarget(next, current)) return 'unchanged';

  const probed = await probeSapToken(next);
  if (!probed.ok) {
    const reason = `${probed.reason}${probed.status ? ` ${probed.status}` : ''}`;
    if (latestSapTarget().source !== 'environment') {
      logger.warn('SapTarget', `SAP AI Core connection ${active.name} (tenant ${next.tenant}) kept-previous: the token request failed (${reason}); still serving tenant ${latestSapTarget().tenant}`);
      return 'kept-previous';
    }
    // Still on the environment target, which after a tenant move is the old tenant: the
    // administrator's choice is served anyway, and fails as SAP failures do, rather than the
    // environment key silently serving (and booking) another tenant.
    const lastKnown = await loadLastKnown();
    if (lastKnown && lastKnown.connectionId === next.connectionId && lastKnown.fingerprint === next.fingerprint) {
      installSapTarget(lastKnown);
      logger.warn('SapTarget', `SAP AI Core connection ${active.name} (tenant ${next.tenant}): the token request failed (${reason}); serving its last-known target instead of the environment target`);
      return 'installed';
    }
    installSapTarget(next);
    await remember(latestSapTarget());
    logger.warn('SapTarget', `SAP AI Core connection ${active.name} (tenant ${next.tenant}) installed although the token request failed (${reason}): the administrator chose it, and the environment target must not serve in its place`);
    return 'installed';
  }
  installSapTarget(next);
  await remember(latestSapTarget());
  return 'installed';
}

let pending: Connection[] | null = null;
let running: Promise<void> | null = null;

/** Runs syncs one at a time, the newest snapshot last; snapshots that arrive meanwhile collapse into one. */
function requestSync(connections: Connection[]): Promise<void> {
  pending = connections;
  if (!running) {
    running = (async () => {
      while (pending) {
        const next = pending;
        pending = null;
        await syncSapTarget(next); // eslint-disable-line no-await-in-loop
      }
    })().finally(() => { running = null; });
  }
  return running;
}

/**
 * Wires the registry to the SAP target and makes the boot decision (index.ts, after setBackend):
 * resolves once the first admin answer is installed, or, when the admin has not answered within
 * `bootWaitMs`, once the last-known copy (if any) is installed. A later answer still wins.
 */
export async function startSapTargetSync(registry: ConnectionRegistry, options: { bootWaitMs?: number } = {}): Promise<void> {
  let answered = false;
  registry.onRefresh((connections) => {
    answered = true;
    void requestSync(connections);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = new Promise<void>((resolve) => { timer = setTimeout(resolve, options.bootWaitMs ?? FRESH_WAIT_MS); });
  await Promise.race([registry.ensureFresh(), wait]);
  clearTimeout(timer);

  if (answered) {
    await running;
    return;
  }
  const lastKnown = await loadLastKnown();
  leftoverChecked = true;
  if (lastKnown) sapConnectionSeen = true;
  if (lastKnown && !answered && latestSapTarget().source === 'environment') {
    installSapTarget(lastKnown);
    logger.info('SapTarget', `The admin has not answered yet: serving the last-known SAP AI Core target (tenant ${lastKnown.tenant})`);
  }
}
