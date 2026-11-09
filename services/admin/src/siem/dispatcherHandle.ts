/**
 * Holds the running SIEM dispatcher's handle (siem/dispatcher.ts's startDispatcher() return
 * value) so index.ts's gracefulShutdown can stop it without requiring admin-service.ts.
 *
 * That indirection matters, not just tidiness: admin-service.ts cannot be required directly
 * in a Jest test (see siemConfigResolver.ts's doc comment — importing it opens a real Valkey
 * connection and starts uncancelled timers as import-time side effects of sibling
 * singletons), so the wiring that matters for Task 7C — "does stop() actually reach the
 * handle that was set" — could not be tested if it lived only inside that class. It also
 * removes a real footgun: CDS loads admin-service.ts's impl via a path that differs between
 * environments (an absolute `/app/.../dist/srv/admin-service.js` under docker-jwt, a relative
 * `srv/admin-service.js` otherwise — see index.ts's serviceImplementations). If
 * gracefulShutdown ever `require()`d admin-service.ts by a path that resolved to a SEPARATE
 * module instance from the one CDS loaded, its handle would read back null and shutdown would
 * silently do nothing while logging success. This module is required by both sides via a
 * plain relative path with no such divergence, so there is only ever one instance of it.
 */
export interface DispatcherHandle {
  stop(): void;
}

let handle: DispatcherHandle | null = null;

/** Called by admin-service.ts's initializeSiemDispatcher() once startDispatcher() returns. */
export function setSiemDispatcherHandle(h: DispatcherHandle | null): void {
  handle = h;
}

/**
 * Stops the running dispatcher, if one is set, and clears the handle. Returns whether it
 * actually stopped something — callers (index.ts's gracefulShutdown) must not unconditionally
 * log success: a false return means there was no handle (the dispatcher was never started, or
 * this was already called), which is not the same thing as "successfully stopped a dispatcher
 * that was ticking against the DB a moment ago."
 */
export function stopSiemDispatcher(): boolean {
  if (!handle) return false;
  handle.stop();
  handle = null;
  return true;
}
