/**
 * A default-catalog change is invalidated by pattern, not by credential: the admin publishes
 * 'unified-cache:*', which is the key prefix the ValKey tier stores unified entries behind
 * (unifiedValidationCache.ts, VALKEY_CACHE_KEY_PREFIX). The in-process map holds the SAME
 * entries under un-prefixed keys ('unified:apikey:<hash>'), so a literal match of that pattern
 * against local keys hits nothing and every gateway process keeps serving the stale entitlement
 * for the rest of the TTL.
 *
 * These cases run the real clearByPattern over real entries seeded through setUnifiedToken -
 * nothing here is mocked, and the cache is built with enableDistributed: false so no ValKey
 * connection is opened.
 */

// The module graph constructs a SecureMetadataExchange at import time, which refuses a key
// shorter than 32 chars - so this has to be set before the imports below, as in
// test/integration/unifiedValidationCache.test.ts.
process.env.METADATA_ENCRYPTION_KEY = 'test-encryption-key-32-chars-minimum-length-required-for-validation';

import { describe, it, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { UnifiedValidationCache } from '../src/services/unifiedValidationCache';
import { UnifiedValidationResponse } from '../src/clients/adminServiceClient';
import { clearConfigurationCache } from '../src/config/unifiedAuthConfig';

const response = (keyId: string): UnifiedValidationResponse => ({
  valid: true,
  authType: 'api_key',
  data: {
    keyId,
    name: keyId,
    email: `${keyId}@example.com`,
    permissions: ['read'],
    rateLimits: { requestsPerMinute: 100, requestsPerHour: 1000, requestsPerDay: 10000 },
    metadata: { isActive: true, lastUsed: new Date().toISOString() }
  },
  auditInfo: { requestId: `req-${keyId}`, validationTime: Date.now(), cacheHit: false }
});

describe('UnifiedValidationCache.clearByPattern reaches the in-process tier', () => {
  let cache: UnifiedValidationCache;

  beforeAll(() => {
    process.env.UNIFIED_TOKEN_SYSTEM_ENABLED = 'true';
  });

  beforeEach(async () => {
    clearConfigurationCache();
    // Local tier only: no adapter is constructed, so no ValKey connection is attempted.
    cache = new UnifiedValidationCache({ enableDistributed: false, encryptTokenData: false });
    await cache.setUnifiedToken('sk-lib-user', response('lib-user'), { ttl: 600000 });
    await cache.setUnifiedToken('sk-other-user', response('other-user'), { ttl: 600000 });

    // Guard: the entries really are in memory before anything is cleared.
    expect(await cache.getUnifiedToken('sk-lib-user', 'api_key')).not.toBeNull();
    expect(await cache.getUnifiedToken('sk-other-user', 'api_key')).not.toBeNull();
  });

  afterEach(async () => {
    await cache.destroy();
  });

  it("evicts local entries for the ValKey-prefixed pattern the admin publishes ('unified-cache:*')", async () => {
    const cleared = await cache.clearByPattern('unified-cache:*');

    expect(cleared).toBe(2);
    expect(await cache.getUnifiedToken('sk-lib-user', 'api_key')).toBeNull();
    expect(await cache.getUnifiedToken('sk-other-user', 'api_key')).toBeNull();
  });

  it('still honours a pattern written against the local key shape', async () => {
    const cleared = await cache.clearByPattern('unified:apikey:*');

    expect(cleared).toBe(2);
    expect(await cache.getUnifiedToken('sk-lib-user', 'api_key')).toBeNull();
  });

  it('leaves entries alone for an unrelated pattern', async () => {
    const cleared = await cache.clearByPattern('some-other-cache:*');

    expect(cleared).toBe(0);
    expect(await cache.getUnifiedToken('sk-lib-user', 'api_key')).not.toBeNull();
    expect(await cache.getUnifiedToken('sk-other-user', 'api_key')).not.toBeNull();
  });

  it('leaves entries alone for a prefixed pattern that addresses a different namespace', async () => {
    const cleared = await cache.clearByPattern('unified-cache:deployments:*');

    expect(cleared).toBe(0);
    expect(await cache.getUnifiedToken('sk-lib-user', 'api_key')).not.toBeNull();
  });
});
