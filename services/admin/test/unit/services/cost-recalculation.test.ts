/**
 * Cost Recalculation Service - Unit Tests (RED/GREEN TDD)
 *
 * Tests the daily cost recalculation service that corrects usage records
 * with incorrect pricing by joining against the ModelCosts table.
 */

// Mock CDS
const mockDb = {
  run: jest.fn(),
  options: { credentials: { kind: 'postgres' } }
};

jest.mock('@sap/cds', () => ({
  connect: {
    to: jest.fn(() => Promise.resolve(mockDb))
  }
}));

// Mock logger
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn()
};

jest.mock('../../../../../libs/logger', () => ({
  getDefaultLogger: () => mockLogger
}));

import { CostRecalculationService } from '../../../src/services/costRecalculationService';

describe('CostRecalculationService', () => {
  let service: CostRecalculationService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    service = new CostRecalculationService();
  });

  afterEach(async () => {
    await service.shutdown();
    jest.useRealTimers();
  });

  describe('initialization', () => {
    it('should initialize without error', async () => {
      await expect(service.initialize()).resolves.not.toThrow();
    });

    it('should schedule recalculation after startup delay', async () => {
      await service.initialize();

      // Should not run immediately
      expect(mockDb.run).not.toHaveBeenCalled();

      // Advance past startup delay (5 minutes)
      jest.advanceTimersByTime(5 * 60 * 1000);

      // Allow async operations to settle
      await Promise.resolve();
      await Promise.resolve();

      expect(mockDb.run).toHaveBeenCalled();
    });
  });

  describe('runRecalculation', () => {
    beforeEach(() => {
      mockDb.run.mockResolvedValue({ rowCount: 3 });
    });

    it('should execute UPDATE on ApiKeyUsage joining ModelCosts', async () => {
      await service.runRecalculation();

      const calls = mockDb.run.mock.calls;
      const apiKeyCall = calls.find((c: any[]) =>
        typeof c[0] === 'string' && c[0].includes('ApiKeyUsage') && c[0].includes('UPDATE')
      );

      expect(apiKeyCall).toBeDefined();
      expect(apiKeyCall[0]).toContain('sap_llm_gateway_admin_ApiKeyUsage');
      expect(apiKeyCall[0]).toContain('sap_llm_gateway_admin_ModelCosts');
      expect(apiKeyCall[0]).toContain('u.model = mc.model');
    });

    it('should execute UPDATE on AwsCredentialUsage using modelId column', async () => {
      await service.runRecalculation();

      const calls = mockDb.run.mock.calls;
      const awsCall = calls.find((c: any[]) =>
        typeof c[0] === 'string' && c[0].includes('AwsCredentialUsage') && c[0].includes('UPDATE')
      );

      expect(awsCall).toBeDefined();
      expect(awsCall[0]).toContain('sap_llm_gateway_admin_AwsCredentialUsage');
      expect(awsCall[0]).toContain('u.modelId = mc.model');
    });

    it('should use 30-day lookback window', async () => {
      await service.runRecalculation();

      const calls = mockDb.run.mock.calls;
      const apiKeyCall = calls.find((c: any[]) =>
        typeof c[0] === 'string' && c[0].includes('ApiKeyUsage')
      );

      // The parameter should be a date ~30 days ago
      const param = apiKeyCall[1][0];
      const paramDate = new Date(param);
      const now = new Date();
      const daysDiff = (now.getTime() - paramDate.getTime()) / (1000 * 60 * 60 * 24);

      expect(daysDiff).toBeGreaterThanOrEqual(29);
      expect(daysDiff).toBeLessThanOrEqual(31);
    });

    it('should only update records with >5% rate deviation', async () => {
      await service.runRecalculation();

      const calls = mockDb.run.mock.calls;
      const apiKeyCall = calls.find((c: any[]) =>
        typeof c[0] === 'string' && c[0].includes('ApiKeyUsage')
      );

      expect(apiKeyCall[0]).toContain('0.05');
    });

    it('should skip records with inputTokens <= 1', async () => {
      await service.runRecalculation();

      const calls = mockDb.run.mock.calls;
      const apiKeyCall = calls.find((c: any[]) =>
        typeof c[0] === 'string' && c[0].includes('ApiKeyUsage')
      );

      expect(apiKeyCall[0]).toContain('inputTokens > 1');
    });

    it('should COALESCE null cache pricing to inputCost', async () => {
      await service.runRecalculation();

      const calls = mockDb.run.mock.calls;
      const apiKeyCall = calls.find((c: any[]) =>
        typeof c[0] === 'string' && c[0].includes('ApiKeyUsage')
      );

      // Should use COALESCE for both cacheReadInputCost and cacheCreationInputCost
      expect(apiKeyCall[0]).toContain('COALESCE(mc.cacheReadInputCost');
      expect(apiKeyCall[0]).toContain('COALESCE(mc.cacheCreationInputCost');
      // Fallback should be mc.inputCost
      expect(apiKeyCall[0]).toContain('mc.inputCost)');
    });

    it('should log results with record counts', async () => {
      mockDb.run.mockResolvedValue({ rowCount: 5 });

      await service.runRecalculation();

      expect(mockLogger.info).toHaveBeenCalledWith(
        'CostRecalculation',
        expect.stringContaining('complete'),
        expect.any(Object)
      );
    });

    it('should return record counts', async () => {
      mockDb.run
        .mockResolvedValueOnce({ rowCount: 7 })   // ApiKeyUsage
        .mockResolvedValueOnce({ rowCount: 3 });   // AwsCredentialUsage

      const result = await service.runRecalculation();

      expect(result.apiKeyRecords).toBe(7);
      expect(result.awsRecords).toBe(3);
    });
  });

  describe('concurrency', () => {
    it('should prevent concurrent execution (mutex)', async () => {
      mockDb.run.mockImplementation(() => new Promise(resolve =>
        setTimeout(() => resolve({ rowCount: 1 }), 100)
      ));

      jest.useRealTimers();

      // Start two recalculations simultaneously
      const first = service.runRecalculation();
      const second = service.runRecalculation();

      await Promise.all([first, second]);

      // Should only have run once (2 SQL calls: ApiKey + AWS)
      expect(mockDb.run).toHaveBeenCalledTimes(2);
    });
  });

  describe('error handling', () => {
    it('should handle database errors gracefully', async () => {
      const testError = new Error('connection timeout');
      mockDb.run.mockRejectedValue(testError);

      await expect(service.runRecalculation()).resolves.not.toThrow();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'CostRecalculation',
        expect.stringContaining('connection timeout'),
        testError
      );
    });
  });

  describe('shutdown', () => {
    it('should clear interval on shutdown', async () => {
      await service.initialize();
      await service.shutdown();

      // Advance time - should NOT trigger recalculation after shutdown
      jest.advanceTimersByTime(30 * 60 * 60 * 1000);
      await Promise.resolve();

      expect(mockDb.run).not.toHaveBeenCalled();
    });
  });
});
