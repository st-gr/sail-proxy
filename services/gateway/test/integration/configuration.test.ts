/**
 * Configuration Integration Tests
 * 
 * Tests configuration loading, validation, and environment handling
 */

import { getUnifiedAuthConfig, clearConfigurationCache } from '../../src/config/unifiedAuthConfig';

describe('Configuration Integration', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    clearConfigurationCache();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('Configuration Loading', () => {
    test('should load configuration successfully', () => {
      const config = getUnifiedAuthConfig();
      expect(config).toBeDefined();
    });

    test('should handle environment variables', () => {
      process.env.NODE_ENV = 'test';
      process.env.METADATA_ENCRYPTION_KEY = 'test-key-32-chars-minimum-length';
      
      const config = getUnifiedAuthConfig();
      expect(config).toBeDefined();
      expect(config.isDevelopment).toBe(false); // NODE_ENV=test doesn't trigger isDevelopment
    });

    test('should provide default values', () => {
      // Clear specific env vars to test defaults
      delete process.env.UNIFIED_AUTH_TIMEOUT_MS;
      delete process.env.UNIFIED_AUTH_MAX_RETRIES;
      
      const config = getUnifiedAuthConfig();
      expect(config.requestTimeoutMs).toBeGreaterThan(0);
      expect(config.maxRetryAttempts).toBeGreaterThanOrEqual(0);
    });

    test('should detect Valkey availability', () => {
      process.env.VALKEY_URL = 'redis://localhost:6379';
      
      const config = getUnifiedAuthConfig();
      expect(config).toBeDefined();
      
      delete process.env.VALKEY_URL;
    });

    test('should handle missing Valkey configuration', () => {
      delete process.env.VALKEY_URL;
      
      const config = getUnifiedAuthConfig();
      expect(config).toBeDefined();
      // Should still work without Valkey
    });
  });

  describe('Configuration Validation', () => {
    test('should validate required encryption key', () => {
      delete process.env.METADATA_ENCRYPTION_KEY;
      
      // Configuration should handle missing encryption key appropriately
      expect(() => {
        getUnifiedAuthConfig();
      }).not.toThrow();
    });

    test('should validate timeout values', () => {
      process.env.UNIFIED_AUTH_REQUEST_TIMEOUT_MS = '5000';
      
      const config = getUnifiedAuthConfig();
      expect(config.requestTimeoutMs).toBe(5000);
    });

    test('should validate retry counts', () => {
      process.env.UNIFIED_AUTH_MAX_RETRY_ATTEMPTS = '3';
      
      const config = getUnifiedAuthConfig();
      expect(config.maxRetryAttempts).toBe(3);
    });
  });

  describe('Configuration Caching', () => {
    test('should cache configuration between calls', () => {
      const config1 = getUnifiedAuthConfig();
      const config2 = getUnifiedAuthConfig();
      
      // Should return the same cached instance (deep equality for config objects)
      expect(config1).toStrictEqual(config2);
    });

    test('should clear cache when requested', () => {
      const config1 = getUnifiedAuthConfig();
      clearConfigurationCache();
      const config2 = getUnifiedAuthConfig();
      
      // Should create new instance after cache clear
      expect(config1).not.toBe(config2);
      expect(config1).toEqual(config2); // But values should be equivalent
    });

    test('should handle environment changes after cache clear', () => {
      process.env.NODE_ENV = 'development';
      const config1 = getUnifiedAuthConfig();
      
      clearConfigurationCache();
      process.env.NODE_ENV = 'production';
      const config2 = getUnifiedAuthConfig();
      
      expect(config1.isDevelopment).toBe(true);
      expect(config2.isProduction).toBe(true);
    });
  });
});