/**
 * Admin Service Client Integration Tests
 * 
 * Tests AdminServiceClient functionality and metrics
 */

import { AdminServiceClient } from '../../src/clients/adminServiceClient';

describe('Admin Service Client Integration', () => {
  let client: AdminServiceClient;

  beforeEach(() => {
    client = new AdminServiceClient();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Client Creation', () => {
    test('should create AdminServiceClient successfully', () => {
      expect(client).toBeDefined();
      expect(client).toBeInstanceOf(AdminServiceClient);
    });
  });

  describe('Metrics Access', () => {
    test('should provide client metrics', () => {
      const metrics = client.getMetrics();
      
      expect(metrics).toBeDefined();
      expect(metrics.circuitBreaker).toBeDefined();
      expect(metrics.requests).toBeDefined();
      expect(metrics.config).toBeDefined();
    });

    test('should have circuit breaker metrics', () => {
      const metrics = client.getMetrics();
      
      expect(metrics.circuitBreaker.state).toBeDefined();
      expect(['CLOSED', 'OPEN', 'HALF_OPEN', 'closed', 'open', 'half_open']).toContain(metrics.circuitBreaker.state);
    });

    test('should have request metrics', () => {
      const metrics = client.getMetrics();
      
      expect(metrics.requests.totalRequests).toBeDefined();
      expect(typeof metrics.requests.totalRequests).toBe('number');
    });

    test('should have configuration metrics', () => {
      const metrics = client.getMetrics();
      
      expect(typeof metrics.config.enabled).toBe('boolean');
      expect(metrics.config.adminServiceUrl).toBeDefined();
      expect(typeof metrics.config.fallbackEnabled).toBe('boolean');
      expect(typeof metrics.config.timeoutMs).toBe('number');
      expect(typeof metrics.config.maxRetries).toBe('number');
    });
  });

  describe('Configuration', () => {
    test('should have valid configuration values', () => {
      const metrics = client.getMetrics();
      
      expect(metrics.config.timeoutMs).toBeGreaterThan(0);
      expect(metrics.config.maxRetries).toBeGreaterThanOrEqual(0);
      
      if (metrics.config.adminServiceUrl) {
        expect(metrics.config.adminServiceUrl).toMatch(/^https?:\/\//);
      }
    });
  });
});