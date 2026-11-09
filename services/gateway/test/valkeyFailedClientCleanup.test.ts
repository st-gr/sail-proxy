// When EnhancedValidationCache gives up on its distributed client, it must
// DISCONNECT that client — not merely set the field to null.
//
// Dropping the reference leaves a live socket with retries still scheduled and
// nothing holding it. The connection outlives the object that gave up on it,
// and its eventual close raises `Connection is closed` with no owner left to
// attribute it to — which is how an unrelated test suite ends up reported as
// "failed to run".
//
// iovalkey is mocked here because reaching this path against a real socket
// means waiting out the whole retry budget (enableOfflineQueue keeps the ping
// queued through ~20 attempts). Jest module mocks are file-scoped, so this
// cannot live beside the real-client assertions in valkeyErrorListeners.test.ts.
process.env.VALIDATION_TOKEN_SECRET = process.env.VALIDATION_TOKEN_SECRET || 'x'.repeat(32);

const fakeClients: any[] = [];
// 'reject' reproduces a refused connection; 'hang' reproduces one still
// retrying, which is the state a client is in when the cache is destroyed
// mid-attempt.
let pingBehaviour: 'reject' | 'hang' = 'reject';

jest.mock('iovalkey', () => {
  const { EventEmitter } = require('events');
  class FakeValkey extends EventEmitter {
    disconnectCalls = 0;

    quitCalls = 0;

    ping(): Promise<never> {
      if (pingBehaviour === 'hang') return new Promise<never>(() => {});
      return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:1'));
    }

    disconnect(): void { this.disconnectCalls += 1; }

    async quit(): Promise<void> { this.quitCalls += 1; }
  }
  return {
    __esModule: true,
    default: function construct(this: any) {
      const client = new FakeValkey();
      fakeClients.push(client);
      return client;
    },
  };
});

import EnhancedValidationCache from '../src/services/enhancedValidationCache';

describe('a distributed client the cache gives up on', () => {
  beforeEach(() => { fakeClients.length = 0; pingBehaviour = 'reject'; });

  it('is disconnected, not just dereferenced', async () => {
    const cache: any = new EnhancedValidationCache({
      enableDistributed: true,
      valkeyUrl: 'redis://127.0.0.1:1',
    });

    // initializeDistributedCache is invoked by the constructor without being
    // awaited; calling it directly means the assertions cannot race it. That
    // produces more than one client — the constructor's own attempt plus this
    // one — so every client created must be accounted for, not just the last.
    await cache.initializeDistributedCache();
    // The constructor's own (un-awaited) attempt is a separate promise chain
    // and may still be settling; let it finish before counting clients, or the
    // assertion races it and sees one that has not reached its catch yet.
    await new Promise((r) => { setTimeout(r, 50); });

    expect(fakeClients.length).toBeGreaterThan(0);
    expect(cache.distributedClient).toBeNull();
    expect(cache.config.enableDistributed).toBe(false);
    // The point of the test: no abandoned client is left un-disconnected.
    for (const client of fakeClients) {
      expect(client.disconnectCalls).toBe(1);
    }
  });

  it('tracks a connection still in flight so destroy() can close it', async () => {
    // A client whose ping has not answered is not this.distributedClient yet,
    // so destroy() used to walk straight past it and leave the socket retrying
    // for the rest of the retry budget — the same leak in a different window.
    //
    // enableDistributed:false keeps the CONSTRUCTOR from starting its own
    // attempt (initialize() requires both flags), while the direct call below
    // still runs (initializeDistributedCache only requires valkeyUrl). Without
    // that, two attempts race for the connectingClient field and the assertion
    // reads whichever one happened to win.
    pingBehaviour = 'hang';
    const cache: any = new EnhancedValidationCache({
      enableDistributed: false,
      valkeyUrl: 'redis://127.0.0.1:1',
    });

    void cache.initializeDistributedCache(); // never settles, by construction
    await new Promise((r) => { setTimeout(r, 20); });

    expect(fakeClients).toHaveLength(1);
    expect(cache.connectingClient).toBe(fakeClients[0]);
    expect(cache.distributedClient).toBeNull(); // not published — ping never answered

    await cache.destroy();

    expect(cache.connectingClient).toBeNull();
    expect(fakeClients[0].disconnectCalls).toBe(1);
  });

  it('still attaches an error listener before the ping that fails', async () => {
    const cache: any = new EnhancedValidationCache({
      enableDistributed: true,
      valkeyUrl: 'redis://127.0.0.1:1',
    });
    await cache.initializeDistributedCache();

    // The listener must go on BEFORE ping() is awaited — otherwise the failing
    // connection can emit into a client with no handler during exactly the
    // window this whole change exists to close.
    expect(fakeClients[0].listenerCount('error')).toBeGreaterThan(0);
  });
});
