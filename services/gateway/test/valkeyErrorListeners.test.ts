// Every iovalkey client this service creates must carry an 'error' listener.
//
// This is not style. An iovalkey client with no 'error' listener turns every
// connection-level error into an unhandled error event. In production that is
// node-level fatal. In Jest it surfaces as:
//
//   ● Test suite failed to run
//     Connection is closed.
//       at close (iovalkey/built/redis/event_handler.js:189:25)
//
// raised when the socket goes away at force-exit and attributed to whichever
// suite happened to be LOADING in that worker — so the failure lands on a file
// with no connection to the code that opened the connection. It was found that
// way: three different innocent suites (token-count-service,
// docker-manifest-sync, one unidentified), always with every test passing and
// the suite itself never running, roughly once per thirty full runs.
//
// The path that produced it: unifiedValidationCache.ts imports
// enhancedValidationCache.ts, which constructs `validationCache` as a
// MODULE-LEVEL singleton — so importing it is enough to open a client — and
// nothing ever closed it.
process.env.VALIDATION_TOKEN_SECRET = process.env.VALIDATION_TOKEN_SECRET || 'x'.repeat(32);

import EnhancedValidationCache from '../src/services/enhancedValidationCache';

const VALKEY_URL = process.env.VALKEY_URL || 'redis://localhost:6379';

/** Waits for the lazily-created client to appear, since initializeDistributedCache
 *  is async and the constructor does not await it. */
async function waitForClient(cache: any, timeoutMs = 3000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cache.distributedClient) return cache.distributedClient;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 25); });
  }
  return null;
}

describe('iovalkey clients carry an error listener', () => {
  describe('EnhancedValidationCache', () => {
    let cache: any;

    afterEach(async () => {
      if (cache) await cache.destroy().catch(() => {});
      cache = null;
    });

    it('attaches an error listener to its distributed client', async () => {
      cache = new EnhancedValidationCache({ enableDistributed: true, valkeyUrl: VALKEY_URL });
      const client = await waitForClient(cache);

      // A null client means valkey was unreachable and the cache disabled
      // distributed mode — a legitimate outcome that this assertion must not
      // silently pass on, because it would pass whether or not the listener
      // exists.
      expect(client).not.toBeNull();
      expect(client.listenerCount('error')).toBeGreaterThan(0);
    });

    it('survives an error event on that client instead of throwing', async () => {
      cache = new EnhancedValidationCache({ enableDistributed: true, valkeyUrl: VALKEY_URL });
      const client = await waitForClient(cache);
      expect(client).not.toBeNull();

      // With no listener this call throws — that is precisely the unhandled
      // error event that kills an unrelated suite at force-exit.
      expect(() => client.emit('error', new Error('Connection is closed.'))).not.toThrow();
    });

    it('never publishes a client whose connection has not answered', async () => {
      // Pointed at a port nothing is listening on, iovalkey queues the ping and
      // retries for a long time. Throughout that window the client is live and
      // emitting connection errors, and it must never become the cache's client
      // — a half-open connection that briefly looks usable is how a `get` ends
      // up waiting on a socket that will never answer.
      cache = new EnhancedValidationCache({
        enableDistributed: true,
        valkeyUrl: 'redis://127.0.0.1:1', // reserved port, never listening
      });

      const client = await waitForClient(cache, 2000);
      expect(client).toBeNull();
    }, 15_000);
  });
});

// Two things are NOT covered here, both deliberately, and both live in
// valkeyFailedClientCleanup.test.ts which mocks iovalkey:
//   - the error listener going on BEFORE the ping is awaited;
//   - the give-up path disconnecting the client rather than dropping it.
// Reaching either against a real socket means waiting out the full retry
// budget, and jest module mocks are file-scoped, so they cannot sit beside the
// real-client assertions above.
