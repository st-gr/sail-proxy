// Hermetic (mocked iovalkey, no real valkey server) coverage of the
// publish/subscribe wiring itself — Task 11 review's "spec gap" item:
// repository.ts's enqueueIngestion must publish, and ingestWorker.ts's
// startIngestWorker must subscribe and wake on a hint. The property that
// polling alone still drains the queue with valkey ABSENT is proven
// elsewhere (every test in ingestWorker.test.ts and its integration
// counterpart runs with no VALKEY_URL set); this file proves the wiring
// itself actually calls through to valkey correctly when it IS configured,
// which no other test exercises.
let mockCreatedInstances: any[] = [];

jest.mock('iovalkey', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { EventEmitter: EE } = require('events');
  class FakeRedis extends EE {
    url: string;
    subscribeCalls: string[] = [];
    publishCalls: Array<[string, string]> = [];
    disconnectCalled = false;
    constructor(url: string) {
      super();
      this.url = url;
      mockCreatedInstances.push(this);
    }
    async subscribe(channel: string) {
      this.subscribeCalls.push(channel);
    }
    async publish(channel: string, message: string) {
      this.publishCalls.push([channel, message]);
      return 1;
    }
    async disconnect() {
      this.disconnectCalled = true;
    }
  }
  return { __esModule: true, default: FakeRedis };
});

let mockDistributedCachingEnabled = true;
jest.mock('../../src/config/unifiedAuthConfig', () => ({
  shouldEnableDistributedCaching: () => mockDistributedCachingEnabled,
}));

import { publishIngestHint, subscribeIngestHints, closePublisher, __resetForTests } from '../../src/fileSearch/ingestHint';

describe('ingestHint (hermetic, mocked iovalkey)', () => {
  const originalValkeyUrl = process.env.VALKEY_URL;

  beforeEach(() => {
    mockCreatedInstances = [];
    mockDistributedCachingEnabled = true;
    process.env.VALKEY_URL = 'redis://fake-valkey:6379';
    __resetForTests();
  });

  afterEach(() => {
    if (originalValkeyUrl === undefined) delete process.env.VALKEY_URL;
    else process.env.VALKEY_URL = originalValkeyUrl;
  });

  it('publishIngestHint publishes storeId/fileId as JSON on the shared channel', async () => {
    await publishIngestHint('vs_1', 'file-1');

    expect(mockCreatedInstances.length).toBe(1);
    expect(mockCreatedInstances[0].publishCalls.length).toBe(1);
    const [channel, message] = mockCreatedInstances[0].publishCalls[0];
    expect(channel).toBe('file_search:ingest_hint');
    expect(JSON.parse(message)).toEqual({ storeId: 'vs_1', fileId: 'file-1' });
  });

  it('publishIngestHint reuses one publisher connection across multiple calls', async () => {
    await publishIngestHint('vs_1', 'file-1');
    await publishIngestHint('vs_2', 'file-2');

    expect(mockCreatedInstances.length).toBe(1); // one connection, not one per call
    expect(mockCreatedInstances[0].publishCalls.length).toBe(2);
  });

  it('publishIngestHint is a silent no-op (never throws) when the underlying publish rejects', async () => {
    await publishIngestHint('vs_1', 'file-1'); // creates the connection
    mockCreatedInstances[0].publish = async () => { throw new Error('connection reset'); };

    await expect(publishIngestHint('vs_2', 'file-2')).resolves.toBeUndefined();
  });

  it('publishIngestHint is a no-op that never connects when distributed caching is disabled', async () => {
    mockDistributedCachingEnabled = false;
    await publishIngestHint('vs_1', 'file-1');
    expect(mockCreatedInstances.length).toBe(0);
  });

  it('subscribeIngestHints subscribes to the shared channel and calls onHint for a matching message', async () => {
    const onHint = jest.fn();
    const sub = subscribeIngestHints(onHint);

    expect(mockCreatedInstances.length).toBe(1);
    // subscribe() is called (possibly still resolving on a microtask) —
    // flush once so it has registered.
    await Promise.resolve();
    expect(mockCreatedInstances[0].subscribeCalls).toContain('file_search:ingest_hint');

    mockCreatedInstances[0].emit('message', 'file_search:ingest_hint', '{"storeId":"vs_1","fileId":"file-1"}');
    expect(onHint).toHaveBeenCalledTimes(1);

    await sub.close();
    expect(mockCreatedInstances[0].disconnectCalled).toBe(true);
  });

  it('subscribeIngestHints ignores a message on an unrelated channel', () => {
    const onHint = jest.fn();
    subscribeIngestHints(onHint);

    mockCreatedInstances[0].emit('message', 'some:other:channel', 'irrelevant');
    expect(onHint).not.toHaveBeenCalled();
  });

  it('subscribeIngestHints returns a no-op subscription that never connects when distributed caching is disabled', async () => {
    mockDistributedCachingEnabled = false;
    const onHint = jest.fn();
    const sub = subscribeIngestHints(onHint);

    expect(mockCreatedInstances.length).toBe(0);
    await expect(sub.close()).resolves.toBeUndefined(); // safe to call regardless
  });

  it('closePublisher disconnects the lazily-created publisher connection', async () => {
    await publishIngestHint('vs_1', 'file-1'); // creates the connection
    expect(mockCreatedInstances.length).toBe(1);
    expect(mockCreatedInstances[0].disconnectCalled).toBe(false);

    await closePublisher();

    expect(mockCreatedInstances[0].disconnectCalled).toBe(true);
  });

  it('closePublisher is a safe no-op when no publish ever happened', async () => {
    await expect(closePublisher()).resolves.toBeUndefined();
    expect(mockCreatedInstances.length).toBe(0);
  });

  it('a publish after closePublisher reconnects rather than reusing the closed connection', async () => {
    await publishIngestHint('vs_1', 'file-1');
    const firstConnection = mockCreatedInstances[0];
    await closePublisher();

    await publishIngestHint('vs_2', 'file-2');

    expect(mockCreatedInstances.length).toBe(2); // a fresh connection, not the closed one
    expect(mockCreatedInstances[1]).not.toBe(firstConnection);
    expect(mockCreatedInstances[1].publishCalls.length).toBe(1);
  });
});
