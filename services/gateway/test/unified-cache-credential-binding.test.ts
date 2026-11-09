/**
 * The unified validation cache answers "is this credential valid, and whose is it?" without a
 * round-trip to the admin, so its entries are authentication decisions.
 *
 * A2: the cache key used to be a 31-bit string hash of the raw credential, and a hit was never
 * checked against the presented credential - two keys with the same hash shared one identity.
 * A3: the "encrypted" entry spread the plaintext data and kept a serialized plaintext copy next to
 * a ciphertext of a stub, so user data and the AWS secretAccessKey were written to Valkey as-is.
 *
 * No ValKey here: the distributed tier is replaced by an in-memory fake so the exact value written
 * to it can be inspected, and the invalidation lib gets a fake command client.
 */

// The module graph constructs a SecureMetadataExchange at import time, which refuses a key
// shorter than 32 chars - so this has to be set before the imports below.
process.env.METADATA_ENCRYPTION_KEY = 'test-encryption-key-32-chars-minimum-length-required-for-validation';

import { describe, it, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { UnifiedValidationCache, UnifiedCacheEntry } from '../src/services/unifiedValidationCache';
import { ValkeyDistributedCacheAdapter } from '../src/services/valkeyDistributedCacheAdapter';
import { UnifiedValidationResponse } from '../src/clients/adminServiceClient';
import { clearConfigurationCache } from '../src/config/unifiedAuthConfig';
import { CacheInvalidationService } from '@libs/cache-invalidation/cacheInvalidationService';
import { getDefaultLogger } from '@libs/logger';

/** The hash the cache keyed on before the fix: ((h << 5) - h) + c, 32-bit, Math.abs, base 36. */
const legacyHash = (key: string): string => {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash) + key.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
};

// h*31 + c is linear, so 'Aa' and 'BB' (65*31+97 = 66*31+66) collide after any common prefix and
// keep colliding through any common suffix: two distinct, realistic-looking keys, one legacy hash.
const KEY_A = 'sk-fixture-7d1c' + 'Aa' + '93be40a2f5c81e6d';
const KEY_B = 'sk-fixture-7d1c' + 'BB' + '93be40a2f5c81e6d';

const ACCESS_KEY_ID = 'FIXTUREACCESSKEYID01';
const SECRET = 'fixtureSecretAccessKey0123456789abcdefXY';
const SIGNING_KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';

const apiKeyResponse = (keyId: string, email: string): UnifiedValidationResponse => ({
  valid: true,
  authType: 'api_key',
  data: {
    keyId,
    name: `${keyId}-name`,
    email,
    permissions: ['read'],
    rateLimits: { requestsPerMinute: 100, requestsPerHour: 1000, requestsPerDay: 10000 },
    metadata: { isActive: true, lastUsed: new Date().toISOString() }
  },
  auditInfo: { requestId: 'req-fixture-1', validationTime: Date.now(), cacheHit: false }
});

const awsResponse = (): UnifiedValidationResponse => ({
  valid: true,
  authType: 'aws_credential',
  data: {
    credentialId: 'cred-fixture-42',
    // an older admin sent the secret; the current one sends day-scoped signing keys
    secretAccessKey: SECRET,
    signingKeys: [{ date: '20260926', region: 'eu-central-1', service: 'bedrock', key: SIGNING_KEY }],
    region: 'eu-central-1',
    sapAiRegion: 'eu10',
    userId: 'avery.fixture@example.com',
    permissions: ['bedrock:InvokeModel'],
    rateLimits: { requestsPerMinute: 100, requestsPerHour: 1000, requestsPerDay: 10000 },
    metadata: { isActive: true, lastUsed: new Date().toISOString() }
  } as any,
  auditInfo: { requestId: 'req-aws', validationTime: Date.now(), cacheHit: false }
});

/** Stands in for the ValKey tier: records every key and the exact serialized entry written. */
const fakeValkey = () => {
  const store = new Map<string, string>();
  return {
    store,
    set: jest.fn(async (key: string, entry: UnifiedCacheEntry) => { store.set(key, JSON.stringify(entry)); }),
    get: jest.fn(async (key: string) => (store.has(key) ? JSON.parse(store.get(key)!) : null)),
    delete: jest.fn(async (key: string) => store.delete(key)),
    clear: jest.fn(async () => { store.clear(); }),
    clearPattern: jest.fn(async () => 0),
    disconnect: jest.fn(async () => undefined)
  };
};

const newCache = (encryptTokenData: boolean) => {
  // Local tier only: no adapter is constructed, so no ValKey connection is attempted.
  const cache = new UnifiedValidationCache({ enableDistributed: false, encryptTokenData });
  const valkey = fakeValkey();
  (cache as any).valkeyAdapter = valkey;
  return { cache, valkey };
};

const localEntries = (cache: UnifiedValidationCache): Map<string, UnifiedCacheEntry> => (cache as any).unifiedCache;

beforeAll(() => {
  process.env.UNIFIED_TOKEN_SYSTEM_ENABLED = 'true';
});

describe('A2: a cache entry belongs to exactly one credential', () => {
  let cache: UnifiedValidationCache;
  let valkey: ReturnType<typeof fakeValkey>;

  beforeEach(() => {
    clearConfigurationCache();
    ({ cache, valkey } = newCache(true));
  });

  afterEach(async () => {
    (cache as any).valkeyAdapter = null;
    await cache.destroy();
  });

  it('the fixture keys really collide under the legacy hash', () => {
    expect(KEY_A).not.toBe(KEY_B);
    expect(legacyHash(KEY_A)).toBe(legacyHash(KEY_B));
  });

  it('a key whose legacy hash collides with a cached key is a miss, not the other identity', async () => {
    await cache.setUnifiedToken(KEY_A, apiKeyResponse('key-a', 'robin.a@example.com'), { ttl: 600000 });

    expect(await cache.getUnifiedToken(KEY_B, 'api_key')).toBeNull();
  });

  it('two colliding keys get distinct entries and keep distinct identities', async () => {
    await cache.setUnifiedToken(KEY_A, apiKeyResponse('key-a', 'robin.a@example.com'), { ttl: 600000 });
    await cache.setUnifiedToken(KEY_B, apiKeyResponse('key-b', 'sasha.b@example.com'), { ttl: 600000 });

    const written = valkey.set.mock.calls.map(call => call[0] as string);
    expect(written).toHaveLength(2);
    expect(written[0]).not.toBe(written[1]);
    for (const key of written) {
      expect(key).toMatch(/^unified:apikey:[0-9a-f]{64}$/);
    }

    expect(((await cache.getUnifiedToken(KEY_A, 'api_key'))!.data as any).keyId).toBe('key-a');
    expect(((await cache.getUnifiedToken(KEY_B, 'api_key'))!.data as any).keyId).toBe('key-b');
  });

  it('a distributed hit is decrypted with the presented key only (fresh process, colliding key misses)', async () => {
    await cache.setUnifiedToken(KEY_A, apiKeyResponse('key-a', 'robin.a@example.com'), { ttl: 600000 });
    localEntries(cache).clear(); // another gateway process: only ValKey has the entry

    expect(await cache.getUnifiedToken(KEY_B, 'api_key')).toBeNull();
    expect(((await cache.getUnifiedToken(KEY_A, 'api_key'))!.data as any).keyId).toBe('key-a');
  });

  it('invalidation by credential removes that entry from both tiers and leaves the colliding one', async () => {
    await cache.setUnifiedToken(KEY_A, apiKeyResponse('key-a', 'robin.a@example.com'), { ttl: 600000 });
    await cache.setUnifiedToken(KEY_B, apiKeyResponse('key-b', 'sasha.b@example.com'), { ttl: 600000 });
    const keyOfA = valkey.set.mock.calls[0][0] as string;

    expect(await cache.clearByCredentialId(KEY_A, 'api_key')).toBe(true);

    expect(valkey.store.has(keyOfA)).toBe(false);
    expect(await cache.getUnifiedToken(KEY_A, 'api_key')).toBeNull();
    expect(((await cache.getUnifiedToken(KEY_B, 'api_key'))!.data as any).keyId).toBe('key-b');
  });

  it("the invalidation lib deletes the same ValKey key the cache wrote (admin publishes the raw credential)", async () => {
    await cache.setUnifiedToken(KEY_A, apiKeyResponse('key-a', 'robin.a@example.com'), { ttl: 600000 });
    await cache.setUnifiedToken(ACCESS_KEY_ID, awsResponse(), { ttl: 600000 });
    const [keyOfA, keyOfAws] = valkey.set.mock.calls.map(call => call[0] as string);

    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() };
    const subscriber = new CacheInvalidationService({ channelName: 'cache-invalidation', enableLogging: false, serviceName: 'gateway' }, logger);
    const del = jest.fn(async () => 1);
    (subscriber as any).commandClient = { del };
    (subscriber as any).isCommandConnected = true;

    await subscriber.processInvalidationEvent({ type: 'api_key_deleted', credentialId: KEY_A, authType: 'api_key', timestamp: Date.now() });
    await subscriber.processInvalidationEvent({ type: 'aws_credential_deleted', credentialId: ACCESS_KEY_ID, authType: 'aws_credential', timestamp: Date.now() });

    expect(del).toHaveBeenCalledWith(`unified-cache:${keyOfA}`);
    expect(del).toHaveBeenCalledWith(`unified-cache:${keyOfAws}`);
  });
});

describe('A3: nothing secret or identifying is written to ValKey in plaintext', () => {
  let cache: UnifiedValidationCache;
  let valkey: ReturnType<typeof fakeValkey>;

  afterEach(async () => {
    (cache as any).valkeyAdapter = null;
    await cache.destroy();
  });

  describe('with cache encryption on (the default)', () => {
    beforeEach(() => {
      clearConfigurationCache();
      ({ cache, valkey } = newCache(true));
    });

    it('an AWS entry carries no secret, no access key id, no plaintext data and no plaintext copy', async () => {
      await cache.setUnifiedToken(ACCESS_KEY_ID, awsResponse(), { ttl: 600000 });

      expect(valkey.set).toHaveBeenCalledTimes(1);
      const [key, entry] = valkey.set.mock.calls[0] as [string, UnifiedCacheEntry];
      const written = JSON.stringify(entry);

      expect(key).not.toContain(ACCESS_KEY_ID);
      for (const plaintext of [SECRET, 'secretAccessKey', SIGNING_KEY, 'signingKeys', ACCESS_KEY_ID, 'cred-fixture-42', 'avery.fixture@example.com', 'eu-central-1', 'bedrock:InvokeModel', '__originalData', '__originalEntry']) {
        expect(written).not.toContain(plaintext);
      }
      // the in-process tier holds the same entry
      expect(JSON.stringify(localEntries(cache).get(key))).toBe(written);
    });

    it('the AWS hit still serves the validation, minus the secret', async () => {
      await cache.setUnifiedToken(ACCESS_KEY_ID, awsResponse(), { ttl: 600000 });
      localEntries(cache).clear();

      const hit = await cache.getUnifiedToken(ACCESS_KEY_ID, 'aws_credential');
      expect(hit).not.toBeNull();
      expect(hit!.valid).toBe(true);
      expect((hit!.data as any).credentialId).toBe('cred-fixture-42');
      expect((hit!.data as any).region).toBe('eu-central-1');
      expect(hit!.data).not.toHaveProperty('secretAccessKey');
      expect(hit!.data).not.toHaveProperty('signingKeys');
    });

    it('an API key entry carries neither the raw key nor the plaintext identity', async () => {
      await cache.setUnifiedToken(KEY_A, apiKeyResponse('key-a', 'robin.a@example.com'), { ttl: 600000 });

      const [key, entry] = valkey.set.mock.calls[0] as [string, UnifiedCacheEntry];
      const written = JSON.stringify(entry);
      expect(key).not.toContain(KEY_A);
      for (const plaintext of [KEY_A, 'key-a', 'robin.a@example.com', '__originalData']) {
        expect(written).not.toContain(plaintext);
      }
      expect(((await cache.getUnifiedToken(KEY_A, 'api_key'))!.data as any).email).toBe('robin.a@example.com');
    });
  });

  describe('with cache encryption switched off', () => {
    beforeEach(() => {
      clearConfigurationCache();
      ({ cache, valkey } = newCache(false));
    });

    it('the secretAccessKey and the signing keys are still never cached, in either tier', async () => {
      await cache.setUnifiedToken(ACCESS_KEY_ID, awsResponse(), { ttl: 600000 });

      const [key, entry] = valkey.set.mock.calls[0] as [string, UnifiedCacheEntry];
      expect(JSON.stringify(entry)).toContain('cred-fixture-42'); // plaintext: this really is the entry
      expect(JSON.stringify(entry)).not.toContain(SECRET);
      expect(JSON.stringify(entry)).not.toContain('secretAccessKey');
      expect(JSON.stringify(entry)).not.toContain(SIGNING_KEY);
      expect(JSON.stringify(entry)).not.toContain('signingKeys');
      expect(JSON.stringify(localEntries(cache).get(key))).not.toContain(SECRET);
      expect(JSON.stringify(localEntries(cache).get(key))).not.toContain(SIGNING_KEY);
    });
  });
});

describe('A3: the ValKey adapter stores the entry it is given, without a plaintext copy beside it', () => {
  it('setex receives exactly the serialized entry', async () => {
    const adapter = new ValkeyDistributedCacheAdapter({ valkeyUrl: 'redis://unused:6379', keyPrefix: 'unified-cache:' });
    const setex = jest.fn(async () => 'OK');
    (adapter as any).client = { setex };
    (adapter as any).isConnected = true;

    // an entry whose data looks "sensitive" to the old heuristic ('token', 'credentials')
    const entry: UnifiedCacheEntry = {
      data: { __encrypted: true, __encryptedData: { iv: 'aXY=', tag: 'dGFn', ciphertext: 'Y2lwaGVy' }, tokenHint: 'credentials' } as any,
      timestamp: Date.now(),
      expiresAt: Date.now() + 60000,
      encrypted: true,
      accessCount: 0,
      lastAccessed: Date.now(),
      authType: 'api_key',
      tokenSource: 'admin_service'
    };

    await adapter.set('unified:apikey:abc', entry, 60);

    expect(setex).toHaveBeenCalledWith('unified-cache:unified:apikey:abc', 60, JSON.stringify(entry));
  });
});

describe('clearing by credential never logs or DELs the raw credential', () => {
  let cache: UnifiedValidationCache;
  let valkey: ReturnType<typeof fakeValkey>;

  beforeEach(() => {
    clearConfigurationCache();
    ({ cache, valkey } = newCache(true));
  });

  afterEach(async () => {
    (cache as any).valkeyAdapter = null;
    await cache.destroy();
  });

  it('clearByCredentialId only sends a hashed key to ValKey delete, and only logs a label', async () => {
    const logger = getDefaultLogger();
    const infoSpy = jest.spyOn(logger, 'info');
    const errorSpy = jest.spyOn(logger, 'error');

    await cache.setUnifiedToken(KEY_A, apiKeyResponse('key-a', 'robin.a@example.com'), { ttl: 600000 });
    infoSpy.mockClear();

    expect(await cache.clearByCredentialId(KEY_A, 'api_key')).toBe(true);

    // Only one key is even attempted (the primary hashed key) - the unhashed legacy
    // variants that used to carry the raw credential into a Valkey DEL argument are gone.
    expect(valkey.delete).toHaveBeenCalledTimes(1);
    expect(valkey.delete).toHaveBeenCalledWith(expect.stringMatching(/^unified:apikey:[0-9a-f]{64}$/));

    for (const call of [...infoSpy.mock.calls, ...errorSpy.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain(KEY_A);
    }

    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
