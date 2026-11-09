import { describe, beforeAll, afterAll, beforeEach, it, expect } from '@jest/globals';
import Valkey from 'iovalkey';

describe('Model List Valkey Storage Integration', () => {
  let valkeyClient: Valkey;
  const TEST_KEY = 'test:model-list:latest';
  const ACTUAL_KEY = 'model-list:latest';

  beforeAll(async () => {
    // Connect to Valkey
    valkeyClient = new Valkey({
      host: 'localhost',
      port: 6379,
      retryStrategy: (times: number) => Math.min(times * 50, 2000),
      maxRetriesPerRequest: 3
    });

    // Wait for connection
    await valkeyClient.ping();
  });

  afterAll(async () => {
    // Clean up test keys
    await valkeyClient.del(TEST_KEY);
    await valkeyClient.quit();
  });

  beforeEach(async () => {
    // Clean up before each test
    await valkeyClient.del(TEST_KEY);
  });

  describe('Valkey SET/GET operations', () => {
    it('should store and retrieve model list with TTL', async () => {
      const modelListEvent = {
        eventType: 'model-list-updated',
        timestamp: new Date().toISOString(),
        source: 'gateway-service',
        modelCount: 2,
        models: [
          { id: 'model1', name: 'Test Model 1' },
          { id: 'model2', name: 'Test Model 2' }
        ],
        configurationReceived: true
      };

      const eventJson = JSON.stringify(modelListEvent);

      // Store with 24h TTL (86400 seconds)
      await valkeyClient.set(TEST_KEY, eventJson, 'EX', 86400);

      // Retrieve
      const stored = await valkeyClient.get(TEST_KEY);
      expect(stored).toBe(eventJson);

      // Verify TTL is set
      const ttl = await valkeyClient.ttl(TEST_KEY);
      expect(ttl).toBeGreaterThan(86300); // Should be close to 86400
      expect(ttl).toBeLessThanOrEqual(86400);

      // Parse and verify structure
      const parsed = JSON.parse(stored!);
      expect(parsed.models).toHaveLength(2);
      expect(parsed.modelCount).toBe(2);
      expect(parsed.eventType).toBe('model-list-updated');
    });

    it('should handle missing key gracefully', async () => {
      const result = await valkeyClient.get('nonexistent:key');
      expect(result).toBeNull();
    });

    it('should verify actual model-list:latest key can be set and retrieved', async () => {
      const testEvent = {
        eventType: 'model-list-updated',
        timestamp: new Date().toISOString(),
        source: 'test',
        modelCount: 1,
        models: [{ id: 'test', name: 'Test' }],
        configurationReceived: false
      };

      // Use actual key name
      await valkeyClient.set(ACTUAL_KEY, JSON.stringify(testEvent), 'EX', 10);

      const retrieved = await valkeyClient.get(ACTUAL_KEY);
      expect(retrieved).not.toBeNull();

      const parsed = JSON.parse(retrieved!);
      expect(parsed.models).toHaveLength(1);

      // Clean up
      await valkeyClient.del(ACTUAL_KEY);
    });

    it('should handle TTL expiration', async () => {
      const testData = JSON.stringify({ test: 'data' });

      // Set with 1 second TTL
      await valkeyClient.set(TEST_KEY, testData, 'EX', 1);

      // Should exist immediately
      let result = await valkeyClient.get(TEST_KEY);
      expect(result).toBe(testData);

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Should be gone
      result = await valkeyClient.get(TEST_KEY);
      expect(result).toBeNull();
    });

    it('should handle large model lists', async () => {
      // Create a large model list
      const models = Array.from({ length: 100 }, (_, i) => ({
        id: `model-${i}`,
        name: `Test Model ${i}`,
        provider: 'test',
        capabilities: ['chat', 'completion']
      }));

      const largeEvent = {
        eventType: 'model-list-updated',
        timestamp: new Date().toISOString(),
        source: 'gateway-service',
        modelCount: models.length,
        models,
        configurationReceived: true
      };

      const eventJson = JSON.stringify(largeEvent);

      // Store
      await valkeyClient.set(TEST_KEY, eventJson, 'EX', 86400);

      // Retrieve
      const stored = await valkeyClient.get(TEST_KEY);
      const parsed = JSON.parse(stored!);

      expect(parsed.models).toHaveLength(100);
      expect(parsed.modelCount).toBe(100);
    });

    it('should verify SET fails gracefully when Valkey is unavailable', async () => {
      // Create a client with wrong port
      const badClient = new Valkey({
        host: 'localhost',
        port: 9999,
        retryStrategy: () => null, // Don't retry
        maxRetriesPerRequest: 1,
        connectTimeout: 100,
        lazyConnect: true
      });

      await expect(async () => {
        await badClient.set('test', 'value', 'EX', 10);
      }).rejects.toThrow();

      // Don't quit a never-connected client
      badClient.disconnect();
    });
  });

  describe('Dual-write simulation', () => {
    it('should simulate gateway dual-write pattern', async () => {
      const modelList = [
        { id: 'model1', name: 'Model 1' },
        { id: 'model2', name: 'Model 2' }
      ];

      const modelListEvent = {
        eventType: 'model-list-updated',
        timestamp: new Date().toISOString(),
        source: 'gateway-service',
        modelCount: modelList.length,
        models: modelList,
        configurationReceived: true
      };

      const eventJson = JSON.stringify(modelListEvent);

      // Simulate gateway dual-write
      // 1. SET to storage
      await valkeyClient.set(TEST_KEY, eventJson, 'EX', 86400);

      // 2. PUBLISH to channel (simulate, don't actually subscribe)
      const publishResult = await valkeyClient.publish('test:model-list-channel', eventJson);
      expect(publishResult).toBeGreaterThanOrEqual(0); // Returns number of subscribers

      // Verify storage worked
      const stored = await valkeyClient.get(TEST_KEY);
      expect(stored).toBe(eventJson);
    });
  });

  describe('Dual-read simulation', () => {
    it('should simulate admin dual-read pattern', async () => {
      // Simulate gateway storing data first
      const modelListEvent = {
        eventType: 'model-list-updated',
        timestamp: new Date().toISOString(),
        source: 'gateway-service',
        modelCount: 1,
        models: [{ id: 'model1', name: 'Test Model' }],
        configurationReceived: true
      };

      await valkeyClient.set(TEST_KEY, JSON.stringify(modelListEvent), 'EX', 86400);

      // Simulate admin reading on startup
      const storedModelList = await valkeyClient.get(TEST_KEY);

      expect(storedModelList).not.toBeNull();

      // Validate structure (like admin does)
      const parsed = JSON.parse(storedModelList!);
      expect(parsed.models).toBeDefined();
      expect(Array.isArray(parsed.models)).toBe(true);
      expect(parsed.modelCount).toBe(1);

      // This would trigger handleModelListEvent in actual code
      expect(parsed.eventType).toBe('model-list-updated');
      expect(parsed.source).toBe('gateway-service');
    });

    it('should handle corrupted JSON gracefully', async () => {
      // Store invalid JSON
      await valkeyClient.set(TEST_KEY, '{ invalid json }');

      const stored = await valkeyClient.get(TEST_KEY);

      expect(() => {
        JSON.parse(stored!);
      }).toThrow();

      // In actual code, admin logs warning and continues
    });

    it('should validate model list structure', async () => {
      // Missing models array
      const invalidEvent = {
        eventType: 'model-list-updated',
        timestamp: new Date().toISOString(),
        source: 'gateway-service',
        modelCount: 1
        // models missing
      };

      await valkeyClient.set(TEST_KEY, JSON.stringify(invalidEvent));

      const stored = await valkeyClient.get(TEST_KEY);
      const parsed = JSON.parse(stored!);

      // Admin should detect invalid structure
      expect(parsed.models).toBeUndefined();
      expect(Array.isArray(parsed.models)).toBe(false);
    });
  });
});
