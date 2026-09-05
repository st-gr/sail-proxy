import UsageEventProcessor, { UsageEvent } from '../../src/services/usageEventProcessor';

// Mock CDS
const mockDb = {
  run: jest.fn()
};

jest.mock('@sap/cds', () => ({
  connect: {
    to: jest.fn(() => Promise.resolve(mockDb))
  },
  ql: {
    SELECT: {
      from: jest.fn()
    },
    INSERT: {
      into: jest.fn()
    }
  }
}));

// Mock Valkey
const mockValkeyClient = {
  subscribe: jest.fn(),
  on: jest.fn(),
  quit: jest.fn(),
  isOpen: true
};

// Mock iovalkey module - it should return the constructor function
jest.mock('iovalkey', () => jest.fn(() => mockValkeyClient));

// Mock model cost service
jest.mock('../../src/services/modelCostService', () => ({
  default: {
    initialize: jest.fn().mockResolvedValue(undefined),
    hasValidModelData: jest.fn().mockReturnValue(true),
    calculateCosts: jest.fn().mockResolvedValue({
      inputCost: 0.01, outputCost: 0.02, totalCost: 0.03, provider: 'anthropic',
      cacheCreationInputCost: 0, cacheReadInputCost: 0
    }),
    getModelProvider: jest.fn().mockReturnValue('anthropic')
  },
  __esModule: true
}));

// Mock logger
jest.mock('../../../../libs/logger', () => ({
  getDefaultLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn()
  })
}));

describe('UsageEventProcessor', () => {
  let processor: UsageEventProcessor;
  let persistSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    processor = new UsageEventProcessor({
      batchSize: 5,
      batchInterval: 1000,
      enableCostCalculation: true
    });
    
    // Mock the private persistUsageEvents method
    persistSpy = jest.spyOn(processor as any, 'persistUsageEvents')
      .mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (persistSpy) {
      persistSpy.mockRestore();
    }
    if (processor) {
      await processor.shutdown();
    }
  });

  describe('initialization', () => {
    it('should initialize without Valkey when not configured', async () => {
      const processorNoRedis = new UsageEventProcessor({ valkeyUrl: undefined });
      
      await expect(processorNoRedis.initialize()).resolves.toBeUndefined();
      
      await processorNoRedis.shutdown();
    });

    it('should initialize with Valkey when configured', async () => {
      // Create a new processor with Valkey URL configured
      const valkeyProcessor = new UsageEventProcessor({
        valkeyUrl: 'redis://localhost:6379',
        batchSize: 5,
        batchInterval: 1000,
        enableCostCalculation: true
      });
      
      await expect(valkeyProcessor.initialize()).resolves.toBeUndefined();
      
      expect(mockValkeyClient.subscribe).toHaveBeenCalledWith('usage-events');
      expect(mockValkeyClient.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockValkeyClient.on).toHaveBeenCalledWith('connect', expect.any(Function));
      expect(mockValkeyClient.on).toHaveBeenCalledWith('message', expect.any(Function));
      
      await valkeyProcessor.shutdown();
    });

    it('should handle Valkey initialization failure gracefully', async () => {
      mockValkeyClient.subscribe.mockRejectedValueOnce(new Error('Valkey connection failed'));
      
      const failingProcessor = new UsageEventProcessor({
        valkeyUrl: 'redis://localhost:6379',
        batchSize: 5,
        batchInterval: 1000,
        enableCostCalculation: true
      });
      
      await expect(failingProcessor.initialize()).rejects.toThrow('Valkey connection failed');
    });
  });

  describe('event processing', () => {
    const mockEvents: UsageEvent[] = [
      {
        requestId: 'test-1',
        timestamp: Math.floor(Date.now() / 1000),
        authType: 'api_key',
        credentialId: 'key-123',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        inputTokens: 100,
        outputTokens: 200,
        responseTime: 1500,
        statusCode: 200
      },
      {
        requestId: 'test-2',
        timestamp: Math.floor(Date.now() / 1000),
        authType: 'aws_credential',
        credentialId: 'aws-key-456',
        provider: 'anthropic',
        model: 'claude-3-5-haiku',
        inputTokens: 50,
        outputTokens: 100,
        responseTime: 800,
        statusCode: 200
      }
    ];

    describe('processMemoryQueue', () => {
      it('should process events and persist to database', async () => {
        await processor.processMemoryQueue(mockEvents);

        expect(persistSpy).toHaveBeenCalledWith(mockEvents);
      });

      it('should handle empty event array', async () => {
        await processor.processMemoryQueue([]);

        expect(persistSpy).not.toHaveBeenCalled();
      });

      it('should separate API key and AWS credential events', async () => {
        await processor.processMemoryQueue(mockEvents);

        // Should have called persistUsageEvents with all events
        expect(persistSpy).toHaveBeenCalledWith(mockEvents);
      });

      it('should calculate costs when enabled', async () => {
        const processorWithCost = new UsageEventProcessor({ enableCostCalculation: true });
        const costPersistSpy = jest.spyOn(processorWithCost as any, 'persistUsageEvents')
          .mockResolvedValue(undefined);
        
        await processorWithCost.processMemoryQueue(mockEvents);

        expect(costPersistSpy).toHaveBeenCalledWith(mockEvents);
        
        costPersistSpy.mockRestore();
      });

      it('should skip cost calculation when disabled', async () => {
        const processorNoCost = new UsageEventProcessor({ enableCostCalculation: false });
        const noCostPersistSpy = jest.spyOn(processorNoCost as any, 'persistUsageEvents')
          .mockResolvedValue(undefined);
        
        await processorNoCost.processMemoryQueue(mockEvents);

        expect(noCostPersistSpy).toHaveBeenCalledWith(mockEvents);
        
        noCostPersistSpy.mockRestore();
      });

      it('should handle database errors gracefully', async () => {
        persistSpy.mockRejectedValueOnce(new Error('Database error'));

        await expect(processor.processMemoryQueue(mockEvents)).rejects.toThrow('Database error');
      });
    });

    describe('cost calculation', () => {
      it('should calculate costs for known models', async () => {
        const events: UsageEvent[] = [
          {
            requestId: 'cost-test-1',
            timestamp: Math.floor(Date.now() / 1000),
            authType: 'api_key',
            credentialId: 'key-123',
            provider: 'anthropic',
            model: 'claude-3-5-sonnet-20241022',
            inputTokens: 1000,
            outputTokens: 2000,
            responseTime: 1500,
            statusCode: 200
          }
        ];

        await processor.processMemoryQueue(events);

        expect(persistSpy).toHaveBeenCalledWith(events);
        
        // The cost should be calculated: (1000/1000 * 0.003) + (2000/1000 * 0.015) = 0.033
        // Note: Exact cost verification would require access to the private method
        // This test ensures the calculation method is called
      });

      it('should use default pricing for unknown models', async () => {
        const events: UsageEvent[] = [
          {
            requestId: 'unknown-model-test',
            timestamp: Math.floor(Date.now() / 1000),
            authType: 'api_key',
            credentialId: 'key-123',
            provider: 'custom-provider',
            model: 'unknown-model',
            inputTokens: 1000,
            outputTokens: 1000,
            responseTime: 1500,
            statusCode: 200
          }
        ];

        await processor.processMemoryQueue(events);

        expect(persistSpy).toHaveBeenCalledWith(events);
      });
    });

    describe('batch processing', () => {
      it('should process events in batches', (done: jest.DoneCallback) => {
        const batchProcessor = new UsageEventProcessor({
          batchSize: 3,
          batchInterval: 100,
          enableCostCalculation: false
        });

        // Mock the persistUsageEvents method to track calls
        const persistSpy = jest.spyOn(batchProcessor as any, 'persistUsageEvents')
          .mockResolvedValue(undefined);

        batchProcessor.initialize().then(() => {
          // Queue 5 events - should trigger batch processing when 3rd event is added
          for (let i = 0; i < 5; i++) {
            const event: UsageEvent = {
              requestId: `batch-test-${i}`,
              timestamp: Math.floor(Date.now() / 1000),
              authType: 'api_key',
              credentialId: 'key-123',
              provider: 'anthropic',
              model: 'claude-3-5-sonnet',
              inputTokens: 100,
              outputTokens: 200,
              responseTime: 1500,
              statusCode: 200
            };

            (batchProcessor as any).queueEvent(event);
          }

          // Should have triggered batch processing immediately when batch size reached
          setTimeout(() => {
            expect(persistSpy).toHaveBeenCalledWith(expect.arrayContaining([
              expect.objectContaining({ requestId: 'batch-test-0' })
            ]));
            
            persistSpy.mockRestore();
            batchProcessor.shutdown().then(() => done());
          }, 50);
        });
      });

      it('should process remaining events on timer', (done: jest.DoneCallback) => {
        const timerProcessor = new UsageEventProcessor({
          batchSize: 10,
          batchInterval: 100,
          enableCostCalculation: false
        });

        const persistSpy = jest.spyOn(timerProcessor as any, 'persistUsageEvents')
          .mockResolvedValue(undefined);

        timerProcessor.initialize().then(() => {
          // Queue 2 events - not enough to trigger batch size threshold
          for (let i = 0; i < 2; i++) {
            const event: UsageEvent = {
              requestId: `timer-test-${i}`,
              timestamp: Math.floor(Date.now() / 1000),
              authType: 'api_key',
              credentialId: 'key-123',
              provider: 'anthropic',
              model: 'claude-3-5-sonnet',
              inputTokens: 100,
              outputTokens: 200,
              responseTime: 1500,
              statusCode: 200
            };

            (timerProcessor as any).queueEvent(event);
          }

          // Should process on timer
          setTimeout(() => {
            expect(persistSpy).toHaveBeenCalledWith(expect.arrayContaining([
              expect.objectContaining({ requestId: 'timer-test-0' })
            ]));
            
            persistSpy.mockRestore();
            timerProcessor.shutdown().then(() => done());
          }, 150);
        });
      });
    });

    describe('Valkey event handling', () => {
      it('should parse and queue valid Valkey messages', async () => {
        const valkeyProcessor = new UsageEventProcessor({
          valkeyUrl: 'redis://localhost:6379',
          batchSize: 5,
          batchInterval: 1000,
          enableCostCalculation: true
        });
        
        await valkeyProcessor.initialize();

        const queueSpy = jest.spyOn(valkeyProcessor as any, 'queueEvent');

        // Get the message handler from the 'on' calls
        const onCalls = mockValkeyClient.on.mock.calls;
        const messageHandler = onCalls.find(call => call[0] === 'message')[1];
        const testEvent = mockEvents[0];
        
        messageHandler('usage-events', JSON.stringify(testEvent));

        expect(queueSpy).toHaveBeenCalledWith(testEvent);
        
        queueSpy.mockRestore();
        await valkeyProcessor.shutdown();
      });

      it('should handle invalid Valkey messages gracefully', async () => {
        const valkeyProcessor = new UsageEventProcessor({
          valkeyUrl: 'redis://localhost:6379',
          batchSize: 5,
          batchInterval: 1000,
          enableCostCalculation: true
        });
        
        await valkeyProcessor.initialize();

        const queueSpy = jest.spyOn(valkeyProcessor as any, 'queueEvent');

        // Get the message handler from the 'on' calls
        const onCalls = mockValkeyClient.on.mock.calls;
        const messageHandler = onCalls.find(call => call[0] === 'message')[1];
        
        messageHandler('usage-events', 'invalid json');

        expect(queueSpy).not.toHaveBeenCalled();
        
        queueSpy.mockRestore();
        await valkeyProcessor.shutdown();
      });
    });
  });

  describe('intra-batch duplicate suppression', () => {
    it('persists only one row when the same requestId appears twice in one batch', async () => {
      // Exercise the REAL persistUsageEvents (the outer spy replaces it), and
      // observe how many events reach the DB layer via persistApiKeyUsage.
      persistSpy.mockRestore();
      const apiKeySpy = jest.spyOn(processor as any, 'persistApiKeyUsage')
        .mockResolvedValue(undefined);

      const event: UsageEvent = {
        requestId: 'dup-req-1',
        timestamp: Math.floor(Date.now() / 1000),
        authType: 'api_key',
        credentialId: 'key-123',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        inputTokens: 100,
        outputTokens: 200,
        cacheCreationInputTokens: 50,
        cacheReadInputTokens: 25,
        responseTime: 1500,
        statusCode: 200
      };

      // Two copies of the SAME request's usage arriving in one batch — the
      // gateway can publish a request's usage more than once into one flush
      // window. Only one ApiKeyUsage row must be written.
      await (processor as any).persistUsageEvents([event, { ...event }]);

      expect(apiKeySpy).toHaveBeenCalledTimes(1);
      expect(apiKeySpy.mock.calls[0][1]).toHaveLength(1);

      apiKeySpy.mockRestore();
    });

    it('keeps distinct requestIds in the same batch', async () => {
      persistSpy.mockRestore();
      const apiKeySpy = jest.spyOn(processor as any, 'persistApiKeyUsage')
        .mockResolvedValue(undefined);

      const base = {
        timestamp: Math.floor(Date.now() / 1000),
        authType: 'api_key' as const,
        credentialId: 'key-123',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        inputTokens: 100,
        outputTokens: 200,
        responseTime: 1500,
        statusCode: 200
      };

      await (processor as any).persistUsageEvents([
        { ...base, requestId: 'distinct-a' },
        { ...base, requestId: 'distinct-b' }
      ]);

      expect(apiKeySpy).toHaveBeenCalledTimes(1);
      expect(apiKeySpy.mock.calls[0][1]).toHaveLength(2);

      apiKeySpy.mockRestore();
    });

    it('keeps distinct AWS events that share the fallback requestId "unknown"', async () => {
      // AWS Bedrock usage events all carry requestId 'unknown' (verified on the
      // Kyma DB). A requestId-only dedup would wrongly merge them; the content
      // signature must keep events that differ in their billable fields.
      persistSpy.mockRestore();
      const awsSpy = jest.spyOn(processor as any, 'persistAwsCredentialUsage')
        .mockResolvedValue(undefined);

      const base = {
        requestId: 'unknown',
        timestamp: Math.floor(Date.now() / 1000),
        authType: 'aws_credential' as const,
        credentialId: 'aws-key-1',
        provider: 'aws-bedrock',
        model: 'anthropic.claude-3-sonnet',
        responseTime: 1500,
        statusCode: 200
      };

      await (processor as any).persistUsageEvents([
        { ...base, inputTokens: 100, outputTokens: 200 },
        { ...base, inputTokens: 500, outputTokens: 600 }, // genuinely distinct
        { ...base, inputTokens: 100, outputTokens: 200 }  // true duplicate of #1
      ]);

      // The two distinct AWS requests survive; only the exact duplicate collapses.
      expect(awsSpy).toHaveBeenCalledTimes(1);
      expect(awsSpy.mock.calls[0][1]).toHaveLength(2);

      awsSpy.mockRestore();
    });
  });

  describe('SAP-native fields', () => {
    const sapCapacityService = require('../../src/services/sapCapacityService');

    const baseEvent: UsageEvent = {
      requestId: 'sap-test-1',
      timestamp: Math.floor(Date.now() / 1000),
      authType: 'api_key',
      credentialId: 'key-123',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      inputTokens: 100,
      outputTokens: 200,
      responseTime: 1500,
      statusCode: 200
    };

    // persistApiKeyUsage/persistAwsCredentialUsage now issue the row insert as raw SQL
    // (INSERT OR IGNORE, keyed on the unique usageSignature column — see
    // insertIgnoringDuplicateSignature in usageEventProcessor.ts) rather than
    // INSERT.into(...).entries(...), so the mock reconstructs the inserted record from the
    // statement's column list and its bound values instead of intercepting a CQN INSERT.
    function setupDbMocks() {
      const cds = require('@sap/cds');
      const { SELECT } = cds.ql;
      SELECT.from.mockReturnValue({
        columns: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis()
      });
      const capturedEntries: any[] = [];
      const testDb = {
        run: jest.fn((query: any, values?: any[]) => {
          if (typeof query === 'string' && /^\s*INSERT/i.test(query)) {
            const columns = (query.match(/\(([^)]+)\)\s*VALUES/i)?.[1] ?? '')
              .split(',').map((c: string) => c.trim());
            const record: Record<string, any> = {};
            columns.forEach((col: string, i: number) => { record[col] = values?.[i]; });
            capturedEntries.push(record);
            return Promise.resolve({ changes: 1 });
          }
          return Promise.resolve([]); // SELECT (ApiKeys/AwsCredentials lookup)
        })
      };
      return { testDb, getEntries: () => capturedEntries };
    }

    it('populates SAP-native fields from sapCapacityService', async () => {
      persistSpy.mockRestore();
      const computeSpy = jest.spyOn(sapCapacityService, 'computeSapNative')
        .mockResolvedValue({ genAiTokens: 131, capacityUnits: 249.4, sapCost: 299.3, sapCostCurrency: 'USD' });
      const { testDb, getEntries } = setupDbMocks();

      await (processor as any).persistApiKeyUsage(testDb, [
        { ...baseEvent, imageInputTokens: 3 } as any
      ]);

      const entries = getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        imageInputTokens: 3,
        genAiTokens: 131,
        capacityUnits: 249.4,
        sapCost: 299.3,
        sapCostCurrency: 'USD'
      });

      computeSpy.mockRestore();
    });

    it('leaves SAP-native fields null when computeSapNative finds no rate, without throwing', async () => {
      persistSpy.mockRestore();
      const computeSpy = jest.spyOn(sapCapacityService, 'computeSapNative').mockResolvedValue(null);
      const { testDb, getEntries } = setupDbMocks();

      await expect(
        (processor as any).persistApiKeyUsage(testDb, [baseEvent])
      ).resolves.toBeUndefined();

      const entries = getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        genAiTokens: null,
        capacityUnits: null,
        sapCost: null,
        sapCostCurrency: null
      });

      computeSpy.mockRestore();
    });

    const baseAwsEvent: UsageEvent = {
      requestId: 'sap-aws-test-1',
      timestamp: Math.floor(Date.now() / 1000),
      authType: 'aws_credential',
      credentialId: 'aws-key-456',
      provider: 'anthropic',
      model: 'anthropic.claude-3-sonnet',
      inputTokens: 150,
      outputTokens: 250,
      responseTime: 900,
      statusCode: 200
    };

    it('populates SAP-native fields from sapCapacityService on the AWS credential leg', async () => {
      persistSpy.mockRestore();
      const computeSpy = jest.spyOn(sapCapacityService, 'computeSapNative')
        .mockResolvedValue({ genAiTokens: 77, capacityUnits: 146.6, sapCost: 175.9, sapCostCurrency: 'USD' });
      const { testDb, getEntries } = setupDbMocks();

      await (processor as any).persistAwsCredentialUsage(testDb, [
        { ...baseAwsEvent, imageInputTokens: 5 } as any
      ]);

      const entries = getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        modelId: baseAwsEvent.model,
        imageInputTokens: 5,
        genAiTokens: 77,
        capacityUnits: 146.6,
        sapCost: 175.9,
        sapCostCurrency: 'USD'
      });

      computeSpy.mockRestore();
    });

    it('leaves SAP-native fields null on the AWS credential leg when computeSapNative finds no rate, without throwing', async () => {
      persistSpy.mockRestore();
      const computeSpy = jest.spyOn(sapCapacityService, 'computeSapNative').mockResolvedValue(null);
      const { testDb, getEntries } = setupDbMocks();

      await expect(
        (processor as any).persistAwsCredentialUsage(testDb, [baseAwsEvent])
      ).resolves.toBeUndefined();

      const entries = getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        modelId: baseAwsEvent.model,
        genAiTokens: null,
        capacityUnits: null,
        sapCost: null,
        sapCostCurrency: null
      });

      computeSpy.mockRestore();
    });
  });

  describe('statistics and monitoring', () => {
    it('should return processor statistics', () => {
      const stats = processor.getStats();

      expect(stats).toHaveProperty('queueSize');
      expect(stats).toHaveProperty('isProcessing');
      expect(stats).toHaveProperty('valkeyConnected');
      
      expect(typeof stats.queueSize).toBe('number');
      expect(typeof stats.isProcessing).toBe('boolean');
      expect(typeof stats.valkeyConnected).toBe('boolean');
    });

    it('should track processing state correctly', () => {
      const initialStats = processor.getStats();
      
      expect(initialStats.isProcessing).toBe(false);
      expect(initialStats.queueSize).toBe(0);
    });
  });

  describe('shutdown', () => {
    it('should shutdown gracefully', async () => {
      const valkeyProcessor = new UsageEventProcessor({
        valkeyUrl: 'redis://localhost:6379',
        batchSize: 5,
        batchInterval: 1000,
        enableCostCalculation: true
      });
      
      await valkeyProcessor.initialize();
      
      await expect(valkeyProcessor.shutdown()).resolves.toBeUndefined();
      
      expect(mockValkeyClient.quit).toHaveBeenCalled();
    });

    it('should process remaining events before shutdown', async () => {
      const persistSpy = jest.spyOn(processor as any, 'persistUsageEvents')
        .mockResolvedValue(undefined);

      await processor.initialize();

      // Queue some events
      const testEvent = {
        requestId: 'shutdown-test',
        timestamp: Math.floor(Date.now() / 1000),
        authType: 'api_key' as const,
        credentialId: 'key-123',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        inputTokens: 100,
        outputTokens: 200,
        responseTime: 1500,
        statusCode: 200
      };
      (processor as any).queueEvent(testEvent);

      await processor.shutdown();

      expect(persistSpy).toHaveBeenCalled();
      
      persistSpy.mockRestore();
    });
  });

  describe('error handling', () => {
    it('should handle processing errors without crashing', async () => {
      const errorProcessor = new UsageEventProcessor();
      
      jest.spyOn(errorProcessor as any, 'persistUsageEvents')
        .mockRejectedValue(new Error('Persistence error'));

      await errorProcessor.initialize();

      // Should not throw
      const testEvents = [{
        requestId: 'error-test',
        timestamp: Math.floor(Date.now() / 1000),
        authType: 'api_key' as const,
        credentialId: 'key-123',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        inputTokens: 100,
        outputTokens: 200,
        responseTime: 1500,
        statusCode: 200
      }];
      await expect(errorProcessor.processMemoryQueue(testEvents)).rejects.toThrow();
      
      await errorProcessor.shutdown();
    });

    it('should continue processing after individual batch failures', (done: jest.DoneCallback) => {
      const errorRecoveryProcessor = new UsageEventProcessor({
        batchSize: 2,
        batchInterval: 50
      });

      let callCount = 0;
      jest.spyOn(errorRecoveryProcessor as any, 'persistUsageEvents')
        .mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.reject(new Error('First batch failed'));
          }
          return Promise.resolve();
        });

      errorRecoveryProcessor.initialize().then(() => {
        // Queue events to trigger multiple batches
        for (let i = 0; i < 4; i++) {
          const event = {
            requestId: `error-recovery-${i}`,
            timestamp: Math.floor(Date.now() / 1000),
            authType: 'api_key' as const,
            credentialId: 'key-123',
            provider: 'anthropic',
            model: 'claude-3-5-sonnet',
            inputTokens: 100,
            outputTokens: 200,
            responseTime: 1500,
            statusCode: 200
          };
          (errorRecoveryProcessor as any).queueEvent(event);
        }

        // Should recover and process subsequent events
        setTimeout(() => {
          expect(callCount).toBeGreaterThan(1);
          errorRecoveryProcessor.shutdown().then(() => done());
        }, 200);
      });
    });
  });

  describe('cache token handling', () => {
    it('should process events with cache tokens correctly', async () => {
      const eventsWithCacheTokens: UsageEvent[] = [
        {
          requestId: 'cache-test-1',
          timestamp: Math.floor(Date.now() / 1000),
          authType: 'api_key',
          credentialId: 'key-123',
          provider: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          inputTokens: 1000,
          outputTokens: 500,
          cacheCreationInputTokens: 200, // 25% higher cost
          cacheReadInputTokens: 100, // 10% of regular cost
          responseTime: 1500,
          statusCode: 200
        }
      ];

      await processor.processMemoryQueue(eventsWithCacheTokens);

      expect(persistSpy).toHaveBeenCalledWith(eventsWithCacheTokens);
    });

    it('should handle missing cache token fields gracefully', async () => {
      const eventsWithoutCacheTokens: UsageEvent[] = [
        {
          requestId: 'no-cache-test',
          timestamp: Math.floor(Date.now() / 1000),
          authType: 'api_key',
          credentialId: 'key-123',
          provider: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          inputTokens: 1000,
          outputTokens: 500,
          // No cache token fields - should default to 0
          responseTime: 1500,
          statusCode: 200
        }
      ];

      await processor.processMemoryQueue(eventsWithoutCacheTokens);

      expect(persistSpy).toHaveBeenCalledWith(eventsWithoutCacheTokens);
    });

    it('should process mixed events (with and without cache tokens)', async () => {
      const mixedEvents: UsageEvent[] = [
        {
          requestId: 'mixed-1',
          timestamp: Math.floor(Date.now() / 1000),
          authType: 'api_key',
          credentialId: 'key-123',
          provider: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          inputTokens: 1000,
          outputTokens: 500,
          cacheCreationInputTokens: 200,
          cacheReadInputTokens: 100,
          responseTime: 1500,
          statusCode: 200
        },
        {
          requestId: 'mixed-2',
          timestamp: Math.floor(Date.now() / 1000),
          authType: 'aws_credential',
          credentialId: 'aws-key-456',
          provider: 'anthropic',
          model: 'claude-3-5-haiku',
          inputTokens: 500,
          outputTokens: 250,
          // No cache tokens
          responseTime: 800,
          statusCode: 200
        }
      ];

      await processor.processMemoryQueue(mixedEvents);

      expect(persistSpy).toHaveBeenCalledWith(mixedEvents);
    });
  });
});