/**
 * Holds the running secret resolver's handle (secretResolver.ts's createSecretResolver()
 * return value) so admin-service.ts's setSiemCredential/deleteSiemCredential can trigger an
 * immediate refresh, and index.ts's gracefulShutdown can tear it down, without requiring
 * admin-service.ts.
 *
 * That indirection matters, not just tidiness: admin-service.ts cannot be required directly
 * in a Jest test (see dispatcherHandle.ts's doc comment for why), and `dist/srv/admin-service.js`
 * / `dist/services/admin/src/srv/admin-service.js` are two separate compiled copies, so
 * requiring admin-service.ts by path from elsewhere would reach a SEPARATE module instance
 * whose handle reads back null. This module is required by both sides via a plain relative
 * path with no such divergence, so there is only ever one instance of it.
 */
import { createSecretResolver } from './secretResolver';
import type { SecretResolverHandle } from './secretResolver';

let handle: SecretResolverHandle | null = null;

export function setSecretResolverHandle(h: SecretResolverHandle | null): void {
  handle = h;
}

/** Returns true when a live resolver was refreshed, false when none is running. */
export async function refreshSecretResolver(): Promise<boolean> {
  if (!handle) return false;
  await handle.refresh();
  return true;
}

/**
 * Creates the live resolver, registers its handle, and runs an initial refresh before
 * returning it - so a sink built immediately afterwards (admin-service.ts's
 * initializeSiemDispatcher, which needs `resolve` synchronously to pass as resolveSiemDispatch's
 * `getSecret`) sees the real stored credential rather than an empty snapshot that only catches
 * up on the first periodic tick, up to 60s later. Callers own tearing it down again (via
 * stopSecretResolver) when the thing that needed it does not end up starting, or on shutdown.
 *
 * `configurationId` must be the configuration the caller is about to build its sinks from, not
 * "whichever is active at some later moment" - see createSecretResolver's doc comment for the
 * invariant that pinning keeps.
 */
export async function startSecretResolver(configurationId: string): Promise<SecretResolverHandle> {
  const resolver = createSecretResolver({ configurationId });
  setSecretResolverHandle(resolver);
  await resolver.refresh();
  return resolver;
}

/**
 * Stops the running resolver, if one is set, and clears the handle. Returns whether it
 * actually stopped something - mirrors dispatcherHandle.ts's stopSiemDispatcher, including
 * why callers must not unconditionally log success on this. Idempotent: safe to call from
 * more than one cleanup path (a decision not to start the dispatcher, an error during
 * startup, and process shutdown all call this, and at most one of them finds a handle).
 */
export function stopSecretResolver(): boolean {
  if (!handle) return false;
  handle.stop();
  handle = null;
  return true;
}
