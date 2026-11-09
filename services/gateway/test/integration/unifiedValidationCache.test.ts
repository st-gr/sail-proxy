/**
 * Unified Validation Cache Integration Tests
 * 
 * Tests cache functionality, performance, distributed caching, 
 * and integration with unified auth.
 */

// Set encryption key globally before any imports
process.env.METADATA_ENCRYPTION_KEY = 'test-encryption-key-32-chars-minimum-length-required-for-validation-and-more-chars';

import { UnifiedValidationCache } from '../../src/services/unifiedValidationCache';
import { UnifiedValidationResponse } from '../../src/clients/adminServiceClient';
import { getCachedUnifiedAuthConfig, clearConfigurationCache } from '../../src/config/unifiedAuthConfig';

describe('Unified Validation Cache Integration', () => {
  let cache: UnifiedValidationCache;
  const originalEnv = { ...process.env };

  beforeAll(() => {
    // Set test environment
    process.env.NODE_ENV = 'test';
    process.env.UNIFIED_TOKEN_SYSTEM_ENABLED = 'true';
    process.env.METADATA_ENCRYPTION_KEY = 'test-encryption-key-32-chars-minimum-length-required-for-validation';
  });

  beforeEach(() => {
    clearConfigurationCache();
    cache = new UnifiedValidationCache();
  });

  afterEach(async () => {
    jest.clearAllMocks();
    // Close Redis connections to prevent handle leaks
    if (cache && (cache as any).distributedAdapter) {
      try {
        await (cache as any).distributedAdapter.disconnect();
      } catch (error) {
        // Ignore cleanup errors
      }
    }
    // Small delay to allow async cleanup to complete  
    await new Promise(resolve => setTimeout(resolve, 10));
  });

  afterAll(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('Cache Initialization', () => {
    test('should create cache instance successfully', () => {
      expect(cache).toBeDefined();
      expect(cache).toBeInstanceOf(UnifiedValidationCache);
    });

    test('should initialize with proper configuration', () => {
      const config = getCachedUnifiedAuthConfig();
      expect(config).toBeDefined();
    });
  });

  describe('Basic Cache Operations', () => {
    test('should set and get cache values', async () => {
      const testKey = 'test-api-key';
      const testResponse: UnifiedValidationResponse = {
        valid: true,
        authType: 'api_key',
        data: {
          keyId: 'test-key',
          name: 'Test Key',
          email: 'test@example.com',
          permissions: ['read'],
          rateLimits: { requestsPerMinute: 100, requestsPerHour: 1000, requestsPerDay: 10000 },
          metadata: { isActive: true, lastUsed: new Date().toISOString() }
        },
        auditInfo: { requestId: 'test-req', validationTime: Date.now(), cacheHit: false }
      };

      await cache.setUnifiedToken(testKey, testResponse, { ttl: 60000 });
      const retrieved = await cache.getUnifiedToken(testKey, 'api_key');

      expect(retrieved).toBeDefined();
      expect(retrieved?.valid).toBe(true);
      expect(retrieved?.auditInfo.requestId).toBe('test-req');
    });

    test('should handle cache misses gracefully', async () => {
      const result = await cache.get('non-existent-key');
      expect(result).toBeNull();
    });

    test('should respect TTL expiration', async () => {
      const testKey = 'test-ttl-key';
      const testResponse: UnifiedValidationResponse = {
        valid: true,
        authType: 'api_key',
        data: {
          keyId: 'test-key',
          name: 'Test Key',
          email: 'test@example.com',
          permissions: ['read'],
          rateLimits: { requestsPerMinute: 100, requestsPerHour: 1000, requestsPerDay: 10000 },
          metadata: { isActive: true, lastUsed: new Date().toISOString() }
        },
        auditInfo: { requestId: 'test-req', validationTime: Date.now(), cacheHit: false }
      };

      // Set with very short TTL using unified token method
      await cache.setUnifiedToken(testKey, testResponse, { ttl: 1 }); // 1ms
      
      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const result = await cache.get(testKey);
      expect(result).toBeNull();
    });
  });

  describe('Performance Tests', () => {
    test('should handle high-frequency operations', async () => {
      const iterations = 100;
      const startTime = Date.now();

      for (let i = 0; i < iterations; i++) {
        const key = `performance-test-key-${i}`;
        const response: UnifiedValidationResponse = {
          valid: true,
          authType: 'api_key',
          data: {
            keyId: `test-key-${i}`,
            name: `Test Key ${i}`,
            email: 'test@example.com',
            permissions: ['read'],
            rateLimits: { requestsPerMinute: 100, requestsPerHour: 1000, requestsPerDay: 10000 },
            metadata: { isActive: true, lastUsed: new Date().toISOString() }
          },
          auditInfo: { requestId: `test-req-${i}`, validationTime: Date.now(), cacheHit: false }
        };
        
        await cache.setUnifiedToken(key, response, { ttl: 60000 });
        await cache.getUnifiedToken(key, 'api_key');
      }

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(5000); // Should complete within 5 seconds
    });
  });

  describe('Distributed Caching', () => {
    test('should handle distributed cache availability', async () => {
      // Test with Valkey URL configured
      process.env.VALKEY_URL = 'redis://localhost:6379';
      
      const testCache = new UnifiedValidationCache();
      expect(testCache).toBeDefined();
      
      // Clean up test cache
      if ((testCache as any).distributedAdapter) {
        try {
          await (testCache as any).distributedAdapter.disconnect();
        } catch (error) {
          // Ignore cleanup errors
        }
      }
      
      delete process.env.VALKEY_URL;
    });

    test('should fallback to memory when distributed cache unavailable', async () => {
      // Ensure no Valkey URL
      delete process.env.VALKEY_URL;
      
      const testCache = new UnifiedValidationCache();
      const testKey = 'fallback-test-key';
      const testResponse: UnifiedValidationResponse = {
        valid: true,
        authType: 'api_key',
        data: {
          keyId: 'fallback-key',
          name: 'Fallback Key',
          email: 'test@example.com',
          permissions: ['read'],
          rateLimits: { requestsPerMinute: 100, requestsPerHour: 1000, requestsPerDay: 10000 },
          metadata: { isActive: true, lastUsed: new Date().toISOString() }
        },
        auditInfo: { requestId: 'fallback-req', validationTime: Date.now(), cacheHit: false }
      };

      await testCache.setUnifiedToken(testKey, testResponse, { ttl: 60000 });
      const result = await testCache.getUnifiedToken(testKey, 'api_key');
      
      expect(result).toBeDefined();
      expect(result?.valid).toBe(true);
      
      // Clean up test cache (though this one shouldn't have distributed adapter)
      if ((testCache as any).distributedAdapter) {
        try {
          await (testCache as any).distributedAdapter.disconnect();
        } catch (error) {
          // Ignore cleanup errors
        }
      }
    });
  });
});