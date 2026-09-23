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

    it('should not skip fully-cached rows (inputTokens <= 1 with cache activity)', async () => {
      await service.runRecalculation();

      const calls = mockDb.run.mock.calls;
      const apiKeyCall = calls.find((c: any[]) =>
        typeof c[0] === 'string' && c[0].includes('ApiKeyUsage')
      );

      // The gate must also admit rows driven entirely by cache tokens.
      expect(apiKeyCall[0]).toContain(
        '(u.inputTokens > 1 OR COALESCE(u.cacheReadInputTokens, 0) > 0 OR COALESCE(u.cacheCreationInputTokens, 0) > 0)'
      );
    });

    it('should trigger recalculation on cache-price drift even when input pricing is unchanged', async () => {
      await service.runRecalculation();

      const calls = mockDb.run.mock.calls;
      const apiKeyCall = calls.find((c: any[]) =>
        typeof c[0] === 'string' && c[0].includes('ApiKeyUsage')
      );

      // The drift predicate must compare cacheReadInputCost and cacheCreationInputCost
      // against current pricing, not just inputCost — otherwise a cache-only price
      // change never triggers a recalc.
      expect(apiKeyCall[0]).toContain('u.cacheReadInputCost::numeric / GREATEST(COALESCE(u.cacheReadInputTokens, 0), 1) * 1000');
      expect(apiKeyCall[0]).toContain('u.cacheCreationInputCost::numeric / GREATEST(COALESCE(u.cacheCreationInputTokens, 0), 1) * 1000');
      expect(apiKeyCall[0]).toContain('u.cacheReadInputCost IS NULL');
      expect(apiKeyCall[0]).toContain('u.cacheCreationInputCost IS NULL');
    });

    it('should price generated-image output tokens with imageOutputTokens and imageOutputCost', async () => {
      await service.runRecalculation();

      const calls = mockDb.run.mock.calls;
      const apiKeyCall = calls.find((c: any[]) =>
        typeof c[0] === 'string' && c[0].includes('ApiKeyUsage')
      );

      expect(apiKeyCall[0]).toContain('imageOutputTokens');
      expect(apiKeyCall[0]).toContain('imageOutputCost');
    });

    it('should admit and reprice an image row whose stored image cost drifted from the rate', async () => {
      await service.runRecalculation();

      const calls = mockDb.run.mock.calls;
      const apiKeyCall = calls.find((c: any[]) =>
        typeof c[0] === 'string' && c[0].includes('ApiKeyUsage')
      );

      // An image row can carry no input and no cache tokens at all (one short prompt, 1290
      // image tokens), and its rate is the manual imageOutputCost, which neither the input nor
      // the cache drift terms look at. Both halves of the gate therefore need an image
      // disjunct, or entering the rate later reprices nothing.
      const where = apiKeyCall[0].slice(apiKeyCall[0].indexOf('WHERE'));
      expect(where).toContain('imageOutputTokens');
      // Eligibility: the row is selected on image tokens alone.
      expect(where).toContain(
        '((u.inputTokens > 1 OR COALESCE(u.cacheReadInputTokens, 0) > 0 OR COALESCE(u.cacheCreationInputTokens, 0) > 0) OR COALESCE(u.imageOutputTokens, 0)::numeric > 0)'
      );
      // Drift: stored imageOutputCost vs the per-1K image rate (imageOutputCost, else outputCost).
      expect(where).toContain('u.imageOutputCost IS NULL');
      expect(where).toContain('u.imageOutputCost::numeric / GREATEST(COALESCE(u.imageOutputTokens, 0), 1) * 1000');
      expect(where).toContain('COALESCE(mc.imageOutputCost, mc.outputCost)::numeric, 0.000001) > 0.05');
    });

    it('should price realtime audio tokens with audioInputTokens/audioOutputTokens and both audio costs', async () => {
      await service.runRecalculation();
      const apiKeyCall = mockDb.run.mock.calls.find((c: any[]) => typeof c[0] === 'string' && c[0].includes('sap_llm_gateway_admin_ApiKeyUsage') && c[0].includes('UPDATE'));
      for (const s of ['audioInputTokens', 'audioOutputTokens', 'audioInputCost = ROUND', 'audioOutputCost = ROUND']) expect(apiKeyCall[0]).toContain(s);
      const where = apiKeyCall[0].slice(apiKeyCall[0].indexOf('WHERE'));
      expect(where).toContain('u.audioInputCost IS NULL');
      expect(where).toContain('u.audioOutputCost IS NULL');
    });

    it('should only evaluate the input drift term when the text share is positive', async () => {
      await service.runRecalculation();

      const calls = mockDb.run.mock.calls;
      const apiKeyCall = calls.find((c: any[]) =>
        typeof c[0] === 'string' && c[0].includes('ApiKeyUsage') && c[0].includes('UPDATE')
      );

      // A realtime row whose input is all audio (audioInputTokens = inputTokens, so textIn = 0
      // and inputCost = 0) must not re-drift forever: |0 - inputRate| / inputRate is always 1,
      // which would always exceed 0.05. Gating the term on textIn > 0 keeps such rows out of
      // this disjunct; they stay repriceable through the audio disjuncts instead.
      const where = apiKeyCall[0].slice(apiKeyCall[0].indexOf('WHERE'));
      const guardIdx = where.indexOf(
        'GREATEST(u.inputTokens::numeric - LEAST(COALESCE(u.audioInputTokens, 0)::numeric, u.inputTokens::numeric), 0) > 0 AND ('
      );
      expect(guardIdx).toBeGreaterThan(-1);
      const guardedClause = where.slice(guardIdx, guardIdx + 600);
      expect(guardedClause).toContain('u.inputCost::numeric / GREATEST(');
      expect(guardedClause).toContain('- mc.inputCost::numeric');
      expect(guardedClause).toContain('> 0.05');
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
