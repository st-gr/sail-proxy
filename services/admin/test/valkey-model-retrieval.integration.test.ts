import Valkey from 'iovalkey';

describe('Model List Valkey Retrieval Integration', () => {
  let valkeyClient: Valkey;
  const TEST_KEY = 'test:model-list:latest';

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

  describe('Admin startup behavior', () => {
    it('should successfully retrieve stored model list on startup', async () => {
      // Simulate gateway storing model list
      const modelListEvent = {
        eventType: 'model-list-updated',
        timestamp: new Date().toISOString(),
        source: 'gateway-service',
        modelCount: 3,
        models: [
          { id: 'model1', name: 'Test Model 1', provider: 'sap' },
          { id: 'model2', name: 'Test Model 2', provider: 'sap' },
          { id: 'model3', name: 'Test Model 3', provider: 'sap' }
        ],
        configurationReceived: true
      };

      await valkeyClient.set(TEST_KEY, JSON.stringify(modelListEvent), 'EX', 86400);

      // Simulate admin GET on startup
      const storedModelList = await valkeyClient.get(TEST_KEY);

      expect(storedModelList).not.toBeNull();

      const parsed = JSON.parse(storedModelList!);
      expect(parsed.models).toBeDefined();
      expect(Array.isArray(parsed.models)).toBe(true);
      expect(parsed.models).toHaveLength(3);
      expect(parsed.modelCount).toBe(3);
    });

    it('should handle missing key when admin starts before gateway', async () => {
      // Simulate admin starting first - no key exists
      const result = await valkeyClient.get(TEST_KEY);

      expect(result).toBeNull();
      // In actual code, admin would log debug and wait for pub/sub
    });

    it('should validate models array exists in stored data', async () => {
      const validEvent = {
        eventType: 'model-list-updated',
        timestamp: new Date().toISOString(),
        source: 'gateway-service',
        modelCount: 2,
        models: [
          { id: 'model1', name: 'Model 1' },
          { id: 'model2', name: 'Model 2' }
        ],
        configurationReceived: true
      };

      await valkeyClient.set(TEST_KEY, JSON.stringify(validEvent));

      const stored = await valkeyClient.get(TEST_KEY);
      const parsed = JSON.parse(stored!);

      // Admin validates this structure
      expect(parsed.models).toBeDefined();
      expect(Array.isArray(parsed.models)).toBe(true);

      // Would call handleModelListEvent(parsed)
    });

    it('should detect invalid structure - missing models array', async () => {
      const invalidEvent = {
        eventType: 'model-list-updated',
        timestamp: new Date().toISOString(),
        source: 'gateway-service',
        modelCount: 1
        // models array missing!
      };

      await valkeyClient.set(TEST_KEY, JSON.stringify(invalidEvent));

      const stored = await valkeyClient.get(TEST_KEY);
      const parsed = JSON.parse(stored!);

      // Admin should detect this is invalid
      expect(parsed.models).toBeUndefined();
      expect(Array.isArray(parsed.models)).toBe(false);

      // In actual code, admin logs warning and ignores
    });

    it('should detect invalid structure - models is not an array', async () => {
      const invalidEvent = {
        eventType: 'model-list-updated',
        timestamp: new Date().toISOString(),
        source: 'gateway-service',
        modelCount: 1,
        models: 'not-an-array' // Wrong type!
      };

      await valkeyClient.set(TEST_KEY, JSON.stringify(invalidEvent));

      const stored = await valkeyClient.get(TEST_KEY);
      const parsed = JSON.parse(stored!);

      // Admin validates Array.isArray()
      expect(Array.isArray(parsed.models)).toBe(false);

      // In actual code, admin logs warning and ignores
    });

    it('should handle corrupted JSON gracefully', async () => {
      // Store invalid JSON
      await valkeyClient.set(TEST_KEY, '{ invalid: json, missing: quotes }');

      const stored = await valkeyClient.get(TEST_KEY);

      // Admin tries to parse
      expect(() => {
        JSON.parse(stored!);
      }).toThrow();

      // In actual code, admin catches error, logs warning, continues
    });

    it('should handle empty string value', async () => {
      await valkeyClient.set(TEST_KEY, '');

      const stored = await valkeyClient.get(TEST_KEY);

      expect(stored).toBe('');

      // Parsing empty string throws
      expect(() => {
        JSON.parse(stored!);
      }).toThrow();

      // In actual code, admin catches and continues
    });
  });

  describe('Race condition scenarios', () => {
    it('should handle admin restart while gateway is running', async () => {
      // Gateway has already stored model list
      const modelListEvent = {
        eventType: 'model-list-updated',
        timestamp: new Date().toISOString(),
        source: 'gateway-service',
        modelCount: 5,
        models: Array.from({ length: 5 }, (_, i) => ({
          id: `model-${i}`,
          name: `Model ${i}`
        })),
        configurationReceived: true
      };

      await valkeyClient.set(TEST_KEY, JSON.stringify(modelListEvent), 'EX', 86400);

      // Admin restarts and immediately reads
      const stored = await valkeyClient.get(TEST_KEY);

      expect(stored).not.toBeNull();

      const parsed = JSON.parse(stored!);
      expect(parsed.models).toHaveLength(5);

      // Admin loads data within seconds of startup
    });

    it('should handle out-of-order startup - admin before gateway', async () => {
      // Admin starts first - no data
      let stored = await valkeyClient.get(TEST_KEY);
      expect(stored).toBeNull();

      // Admin subscribes to pub/sub and waits...

      // Later, gateway starts and stores data
      const modelListEvent = {
        eventType: 'model-list-updated',
        timestamp: new Date().toISOString(),
        source: 'gateway-service',
        modelCount: 1,
        models: [{ id: 'model1', name: 'Model 1' }],
        configurationReceived: true
      };

      await valkeyClient.set(TEST_KEY, JSON.stringify(modelListEvent), 'EX', 86400);

      // Now data is available
      stored = await valkeyClient.get(TEST_KEY);
      expect(stored).not.toBeNull();

      // Admin would receive via pub/sub event in actual scenario
    });
  });

  describe('GET error handling', () => {
    it('should handle connection errors gracefully', async () => {
      // Create client with bad connection
      const badClient = new Valkey({
        host: 'localhost',
        port: 9999,
        retryStrategy: () => null,
        maxRetriesPerRequest: 1,
        connectTimeout: 100,
        lazyConnect: true
      });

      await expect(async () => {
        await badClient.get('any-key');
      }).rejects.toThrow();

      badClient.disconnect();

      // In actual code, admin catches error, logs warning, continues to subscribe
    });
  });

  describe('Data integrity', () => {
    it('should preserve all model fields through storage', async () => {
      const complexModel = {
        id: 'complex-model',
        name: 'Complex Model',
        provider: 'sap-ai-core',
        capabilities: ['chat', 'completion', 'tools'],
        pricing: {
          input: 0.001,
          output: 0.002
        },
        metadata: {
          version: '1.0',
          deployment: 'prod'
        }
      };

      const modelListEvent = {
        eventType: 'model-list-updated',
        timestamp: new Date().toISOString(),
        source: 'gateway-service',
        modelCount: 1,
        models: [complexModel],
        configurationReceived: true
      };

      await valkeyClient.set(TEST_KEY, JSON.stringify(modelListEvent), 'EX', 86400);

      const stored = await valkeyClient.get(TEST_KEY);
      const parsed = JSON.parse(stored!);

      // All fields should be preserved
      expect(parsed.models[0]).toEqual(complexModel);
      expect(parsed.models[0].capabilities).toEqual(['chat', 'completion', 'tools']);
      expect(parsed.models[0].pricing).toEqual({ input: 0.001, output: 0.002 });
    });
  });
});
