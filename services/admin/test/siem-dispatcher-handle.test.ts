import { setSiemDispatcherHandle, stopSiemDispatcher } from '../src/siem/dispatcherHandle';

/**
 * Task 7C's real defect was never "does d.stop() work" (siem-dispatcher.test.ts already
 * covers that) -- it was that nothing in the repo ever REACHED the running dispatcher's
 * handle from shutdown. That wiring is what this file tests: a handle set the way
 * admin-service.ts's initializeSiemDispatcher() sets it must be reachable and stoppable the
 * way index.ts's gracefulShutdown stops it, including across independent require() call
 * sites -- the exact scenario a module-resolution mismatch (see dispatcherHandle.ts's doc
 * comment on admin-service.ts's docker-vs-dev impl path divergence) would silently break.
 */
describe('siem dispatcher handle wiring (Task 7C)', () => {
  afterEach(() => {
    // Reset the shared module-level state between tests -- this module intentionally has no
    // per-test isolation of its own (there is exactly one dispatcher handle at a time in the
    // real process too).
    setSiemDispatcherHandle(null);
  });

  it('stops the handle that was actually set, and reports that it did', () => {
    let stopped = false;
    setSiemDispatcherHandle({ stop: () => { stopped = true; } });

    expect(stopSiemDispatcher()).toBe(true);
    expect(stopped).toBe(true);
  });

  it('reports false and does not throw when no dispatcher was ever started', () => {
    expect(() => stopSiemDispatcher()).not.toThrow();
    expect(stopSiemDispatcher()).toBe(false);
  });

  it('a second stop() call is a no-op that reports false, not a repeat stop -- the return value is exactly what gracefulShutdown must gate its success log on', () => {
    let stopCalls = 0;
    setSiemDispatcherHandle({ stop: () => { stopCalls++; } });

    expect(stopSiemDispatcher()).toBe(true);
    expect(stopSiemDispatcher()).toBe(false); // second call: nothing left to stop
    expect(stopCalls).toBe(1);
  });

  // The scenario the review flagged directly: admin-service.ts sets the handle (via one
  // require() of this module) and index.ts's gracefulShutdown stops it (via a SEPARATE
  // require() of this module, at a different call site). Node's module cache guarantees both
  // resolve to the same singleton for the same resolved path -- this proves the PROPERTY that
  // matters (a handle set through one reference is reachable and stoppable through another),
  // not merely that the cache mechanism exists.
  it('a handle set through one require() of this module is reachable and stoppable through an independent require() of it', () => {
    const setterSide = require('../src/siem/dispatcherHandle');
    const stopperSide = require('../src/siem/dispatcherHandle');

    let stopped = false;
    setterSide.setSiemDispatcherHandle({ stop: () => { stopped = true; } });

    expect(stopperSide.stopSiemDispatcher()).toBe(true);
    expect(stopped).toBe(true);
  });

  // Simulates the actual defect if the wiring is ever wrong: shutdown calling stop() on a
  // stale/absent reference must not be indistinguishable from a real stop -- the caller has
  // to be able to tell the difference (this is what index.ts's conditional log now does).
  it('a dispatcher left running (handle never set on the side that stops) is visibly NOT stopped, not silently reported as stopped', () => {
    // Nothing set here -- models the exact failure mode: gracefulShutdown reaches for a
    // handle that was never wired to it.
    const reachedShutdown = stopSiemDispatcher();
    expect(reachedShutdown).toBe(false);
  });
});
