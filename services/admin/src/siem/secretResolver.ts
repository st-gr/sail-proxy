import { getDefaultLogger } from '@libs/logger';
import { getCredential, listCredentialNames } from './credentialStore';

const logger = getDefaultLogger();

/**
 * Resolves a secret by the credential-slot NAME that api_config.json records for a sink. The
 * encrypted credential store (credentialStore.ts) is the only source - there is no
 * environment fallback. Synchronous on purpose: the sinks resolve their secrets at send time
 * and making that async would change every sink's send path.
 */
export type SecretResolver = (name: string) => string | undefined;

export interface SecretResolverHandle {
  resolve: SecretResolver;
  /** Reloads the snapshot. Never rejects - a failed refresh keeps the previous snapshot. */
  refresh(): Promise<void>;
  stop(): void;
}

export interface SecretResolverOptions {
  /**
   * The configuration whose credentials this resolver serves - required, and fixed for the
   * resolver's life. See createSecretResolver below for why it is pinned rather than
   * re-selected.
   */
  configurationId: string;
  /** How often to reload stored credentials. Default 60s: a rotation takes effect within it. */
  refreshIntervalMs?: number;
}

/**
 * Pinned to one configuration on purpose. The dispatcher (admin-service.ts's
 * initializeSiemDispatcher) builds its sinks once at init() from the configuration that is
 * active then, and nothing rebuilds them on activation - so the sinks in flight belong to that
 * configuration for the life of the process. This used to re-select the ACTIVE configuration on
 * every refresh instead, which meant activating a different configuration silently re-pointed
 * every running sink at the new configuration's credentials: a sink built from configuration A
 * would, one refresh later, ship A's events under B's org key, with validateConfig() === [] and
 * no warning anywhere. Activating a configuration with no credentials of its own was worse
 * still - resolve() went undefined and datadogSink kept sending 'DD-API-KEY: ""' indefinitely,
 * because validateConfig() is never re-consulted once a sink is built.
 *
 * The invariant this restores: the credentials a sink resolves always belong to the
 * configuration that sink was built from. The accepted consequence is that activating a
 * configuration does not change SIEM credentials until a restart - already true of every other
 * aspect of the dispatcher, which does not rebuild its sinks on activation either. Rotating a
 * credential ON the pinned configuration still takes effect within one refresh interval (and
 * immediately, via secretResolverHandle.ts, when set through setSiemCredential).
 */
export function createSecretResolver(opts: SecretResolverOptions): SecretResolverHandle {
  let snapshot = new Map<string, string>();
  let timer: NodeJS.Timeout | undefined;

  const refresh = async (): Promise<void> => {
    try {
      const next = new Map<string, string>();
      for (const { name } of await listCredentialNames(opts.configurationId)) {
        // getCredential returns null only for "genuinely absent or undecryptable" - a row
        // that fails to decrypt is treated as absent, so it drops out of the snapshot and
        // un-credentials the sink: there is no environment fallback to catch it. A DB
        // failure while reading the row is a different case: getCredential does not swallow
        // it, and it propagates to the outer catch below so this whole refresh is abandoned
        // in favour of the previous snapshot, rather than this one name being silently
        // dropped as if deleted.
        const value = await getCredential(opts.configurationId, name);
        if (value !== null) next.set(name, value);
      }
      snapshot = next;
    } catch (error) {
      // Keep the previous snapshot: a transient DB failure - whether from listCredentialNames
      // or from a single getCredential row read above - must not un-credential every sink and
      // turn a delivery pause into a burst of auth failures.
      logger.error(
        'SiemSecretResolver',
        'Failed to refresh stored credentials; keeping the previous snapshot',
        error as Error,
      );
    }
  };

  if (opts.refreshIntervalMs !== 0) {
    timer = setInterval(() => { void refresh(); }, opts.refreshIntervalMs ?? 60_000);
    timer.unref?.();
  }

  return {
    resolve: (name: string) => snapshot.get(name),
    refresh,
    stop: () => { if (timer) clearInterval(timer); },
  };
}
