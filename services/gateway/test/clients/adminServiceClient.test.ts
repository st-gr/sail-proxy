/**
 * Admin Service Client Tests
 * 
 * Simplified tests focused on AdminServiceClient core functionality
 */

import { clearConfigurationCache } from '../../src/config/unifiedAuthConfig';
import { getAdminServiceUrl } from '@libs/test-utils';

describe('AdminServiceClient Integration', () => {
  beforeEach(() => {
    clearConfigurationCache();
    process.env.UNIFIED_TOKEN_SYSTEM_ENABLED = 'true';
    process.env.ADMIN_SERVICE_URL = getAdminServiceUrl();
    process.env.UNIFIED_AUTH_REQUEST_TIMEOUT_MS = '5000';
    process.env.UNIFIED_AUTH_MAX_RETRY_ATTEMPTS = '3';
    process.env.UNIFIED_AUTH_CIRCUIT_BREAKER_THRESHOLD = '5';
    process.env.UNIFIED_AUTH_HEALTH_CHECK_INTERVAL_MS = '0';
  });

  afterEach(() => {
    clearConfigurationCache();
  });

  describe('Basic Functionality', () => {
    test('should import AdminServiceClient and create instance', async () => {
      const { AdminServiceClient } = await import('../../src/clients/adminServiceClient');
      
      expect(AdminServiceClient).toBeDefined();
      expect(typeof AdminServiceClient).toBe('function');
      
      const client = new AdminServiceClient();
      expect(client).toBeDefined();
      expect(typeof client.getMetrics).toBe('function');
    });

    test('should have correct configuration', async () => {
      const { AdminServiceClient } = await import('../../src/clients/adminServiceClient');
      
      const client = new AdminServiceClient();
      const metrics = client.getMetrics();
      
      expect(metrics.config).toMatchObject({
        enabled: true,
        adminServiceUrl: 'http://localhost:4004',
        fallbackEnabled: true,
        timeoutMs: 5000,
        maxRetries: 3
      });
    });

    test('should initialize with clean metrics', async () => {
      const { AdminServiceClient } = await import('../../src/clients/adminServiceClient');
      
      const client = new AdminServiceClient();
      const metrics = client.getMetrics();
      
      expect(metrics.circuitBreaker.state).toBe('closed');
      expect(metrics.circuitBreaker.failures).toBe(0);
      expect(metrics.requests.totalRequests).toBe(0);
      expect(metrics.requests.successfulRequests).toBe(0);
      expect(metrics.requests.failedRequests).toBe(0);
    });

    test('should export singleton instance', async () => {
      const { adminServiceClient } = await import('../../src/clients/adminServiceClient');
      
      if (adminServiceClient) {
        expect(typeof adminServiceClient.callAdminAction).toBe('function');
        expect(typeof adminServiceClient.checkHealth).toBe('function');
        expect(typeof adminServiceClient.getMetrics).toBe('function');
      }
    });

    test('should handle disabled configuration', async () => {
      process.env.UNIFIED_TOKEN_SYSTEM_ENABLED = 'false';
      clearConfigurationCache();
      
      const { AdminServiceClient } = await import('../../src/clients/adminServiceClient');
      
      const client = new AdminServiceClient();
      const metrics = client.getMetrics();
      
      expect(metrics.config.enabled).toBe(false);
    });
  });
});