/**
 * Valkey Distributed Cache Adapter Integration Tests
 * 
 * Tests the Valkey adapter with real functionality and error handling
 */

// Set encryption key globally before any imports
process.env.METADATA_ENCRYPTION_KEY = 'test-encryption-key-32-chars-minimum-length-required-for-validation-and-more-chars';

import { ValkeyDistributedCacheAdapter } from '../../src/services/valkeyDistributedCacheAdapter';
import { UnifiedCacheEntry } from '../../src/services/unifiedValidationCache';

describe('Valkey Distributed Cache Adapter Integration', () => {
  let adapter: ValkeyDistributedCacheAdapter;
  const originalEnv = { ...process.env };

  beforeAll(() => {
    process.env.METADATA_ENCRYPTION_KEY = 'test-encryption-key-32-chars-minimum-length-required-for-validation';
    process.env.NODE_ENV = 'test';
  });

  beforeEach(() => {
    adapter = new ValkeyDistributedCacheAdapter({});
  });

  afterEach(async () => {
    jest.clearAllMocks();
    // Close Redis connection to prevent handle leaks
    if (adapter) {
      await adapter.disconnect();
    }
    // Small delay to allow async cleanup to complete
    await new Promise(resolve => setTimeout(resolve, 10));
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  const createTestCacheEntry = (authType: 'api_key' | 'aws_credential' = 'api_key'): UnifiedCacheEntry => ({
    data: {
      valid: true,
      authType,
      data: {
        keyId: 'test-key-123',
        name: 'Test Key',
        email: 'test@example.com',
        permissions: ['read', 'write'],
        rateLimits: {
          requestsPerMinute: 100,
          requestsPerHour: 1000,
          requestsPerDay: 10000
        },
        metadata: {
          isActive: true,
          lastUsed: new Date().toISOString()
        }
      },
      auditInfo: {
        requestId: 'test-request-id',
        validationTime: Date.now(),
        cacheHit: false
      }
    },
    timestamp: Date.now(),
    expiresAt: Date.now() + 60000,
    encrypted: false,
    accessCount: 0,
    lastAccessed: Date.now(),
    authType,
    tokenSource: 'admin_service'
  });

  describe('Adapter Initialization', () => {
    test('should create adapter instance', () => {
      expect(adapter).toBeDefined();
      expect(adapter).toBeInstanceOf(ValkeyDistributedCacheAdapter);
    });

    test('should handle connection configuration', async () => {
      // Test with Valkey URL
      process.env.VALKEY_URL = 'redis://localhost:6379';
      const testAdapter = new ValkeyDistributedCacheAdapter({});
      expect(testAdapter).toBeDefined();
      
      // Clean up test adapter
      await testAdapter.disconnect();
      
      delete process.env.VALKEY_URL;
    });
  });

  describe('Cache Operations', () => {
    test('should set and get cache entries', async () => {
      const testKey = 'test-cache-key';
      const testEntry = createTestCacheEntry();

      await adapter.set(testKey, testEntry, 60);
      const retrieved = await adapter.get(testKey);

      expect(retrieved).toBeDefined();
      expect((retrieved?.data as any).valid).toBe(true);
      expect((retrieved?.data as any).data.keyId).toBe('test-key-123');
    });

    test('should handle cache misses', async () => {
      const result = await adapter.get('non-existent-key');
      expect(result).toBeNull();
    });

    test('should delete cache entries', async () => {
      const testKey = 'delete-test-key';
      const testEntry = createTestCacheEntry();

      await adapter.set(testKey, testEntry, 60);
      await adapter.delete(testKey);
      
      const result = await adapter.get(testKey);
      expect(result).toBeNull();
    });

    test('should handle TTL correctly', async () => {
      const testKey = 'ttl-test-key';
      const testEntry = createTestCacheEntry();

      // Set with very short TTL
      await adapter.set(testKey, testEntry, 1); // 1 second
      
      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1100)); // Wait 1.1 seconds
      
      const result = await adapter.get(testKey);
      expect(result).toBeNull();
    });
  });

  describe('Error Handling', () => {
    test('should handle connection errors gracefully', async () => {
      // Test with invalid Valkey URL
      process.env.VALKEY_URL = 'redis://invalid-host:6379';
      
      const testAdapter = new ValkeyDistributedCacheAdapter({});
      const testKey = 'error-test-key';
      const testEntry = createTestCacheEntry();

      // `set` REJECTS when the connection cannot be established: both
      // establishConnection and set log and then rethrow. Awaiting the promise
      // here is not a style preference — it is what stops this test leaking one.
      //
      // The previous form was `await expect(async () => { await
      // testAdapter.set(...) }).not.toThrow()`. That is vacuous twice over: an
      // async function never throws synchronously, so `.not.toThrow()` can
      // never fail, and `toThrow` invokes the function and DISCARDS the promise
      // it returns (the outer `await` applies to expect()'s own result). So
      // `set` kept running, unawaited, against `redis://invalid-host:6379`,
      // past the end of this test. When that socket eventually closed,
      // iovalkey's close handler called flushQueue(new Error('Connection is
      // closed')), the rejection propagated back out through set(), and nothing
      // was holding the promise.
      //
      // Jest attributes an unhandled rejection to whichever suite is LOADING in
      // that worker when it arrives, so this produced an intermittent
      // "Test suite failed to run: Connection is closed." on a completely
      // unrelated file, with every test still passing. Five different innocent
      // suites were hit that way before it was traced back here.
      await expect(testAdapter.set(testKey, testEntry, 60)).rejects.toThrow();

      // Clean up test adapter (invalid connection shouldn't need cleanup but try anyway)
      try {
        await testAdapter.disconnect();
      } catch (error) {
        // Ignore cleanup errors for invalid connections
      }
      
      delete process.env.VALKEY_URL;
    });

    test('should handle malformed data gracefully', async () => {
      const testKey = 'malformed-test-key';
      
      // Same correction as above: awaited, so the promise cannot outlive the
      // test. This one runs against the healthy `adapter`, so it resolves
      // rather than rejecting — a miss yields null.
      await expect(adapter.get(testKey)).resolves.toBeNull();
    });
  });

  describe('Performance', () => {
    test('should handle concurrent operations', async () => {
      const promises = [];
      const numOperations = 10;

      for (let i = 0; i < numOperations; i++) {
        const key = `concurrent-test-${i}`;
        const entry = createTestCacheEntry();
        promises.push(adapter.set(key, entry, 60));
      }

      await Promise.all(promises);

      // Verify all entries were set
      const retrievePromises = [];
      for (let i = 0; i < numOperations; i++) {
        const key = `concurrent-test-${i}`;
        retrievePromises.push(adapter.get(key));
      }

      const results = await Promise.all(retrievePromises);
      const validResults = results.filter(result => result !== null);
      
      // Should have some successful operations
      expect(validResults.length).toBeGreaterThan(0);
    });
  });
});