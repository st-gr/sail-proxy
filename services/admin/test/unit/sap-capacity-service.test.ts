jest.mock('@sap/cds', () => ({ connect: { to: jest.fn() }, ql: { SELECT: { one: { from: () => ({ where: () => ({ orderBy: () => null }) }) } } } }));
import { computeSapNative, getCacheBillingFactors } from '../../src/services/sapCapacityService';

// Deterministic rates/price injected via a seam the service exposes for tests:
import * as svc from '../../src/services/sapCapacityService';

describe('sapCapacityService', () => {
  const rate = { inputGenAiRate: 1/3, outputGenAiRate: 1/15, cacheReadGenAiRate: 1/30, cacheWriteGenAiRate: 1/3, imageGenAiRate: 1/3, cuFactor: 1.90385 };
  const price = { pricePerCu: 1.20, currency: 'USD' };

  beforeEach(() => {
    jest.spyOn(svc as any, '_lookupRate').mockResolvedValue(rate);
    jest.spyOn(svc as any, '_lookupPrice').mockResolvedValue(price);
    jest.spyOn(svc as any, '_cacheFactors').mockReturnValue({ read: 1, write: 1 });
  });

  it('computes genAiTokens, capacityUnits and cost with factor 1.0', async () => {
    const r = await computeSapNative({ model: 'm', provider: 'anthropic', inputTokens: 300, outputTokens: 150,
      cacheReadInputTokens: 300, cacheCreationInputTokens: 30, imageInputTokens: 3, at: new Date('2026-08-01'), productive: false });
    // genAi = 300/3 + 150/15 + 300/30 + 30/3 + 3/3 = 100+10+10+10+1 = 131
    expect(r!.genAiTokens).toBeCloseTo(131, 6);
    expect(r!.capacityUnits).toBeCloseTo(131 * 1.90385, 6);
    expect(r!.sapCost).toBeCloseTo(131 * 1.90385 * 1.20, 6);
    expect(r!.sapCostCurrency).toBe('USD');
  });

  it('applies the cache-read calibration factor', async () => {
    jest.spyOn(svc as any, '_cacheFactors').mockReturnValue({ read: 2, write: 1 });
    const r = await computeSapNative({ model: 'm', provider: 'anthropic', inputTokens: 0, outputTokens: 0,
      cacheReadInputTokens: 300, cacheCreationInputTokens: 0, imageInputTokens: 0, at: new Date('2026-08-01'), productive: false });
    // (300*2)/30 = 20 GenAI tokens
    expect(r!.genAiTokens).toBeCloseTo(20, 6);
  });

  it('returns null when no rate row exists', async () => {
    jest.spyOn(svc as any, '_lookupRate').mockResolvedValue(null);
    const r = await computeSapNative({ model: 'x', provider: 'anthropic', inputTokens: 10, outputTokens: 0,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0, imageInputTokens: 0, at: new Date(), productive: false });
    expect(r).toBeNull();
  });

  it('leaves cost null when a rate exists but no price row', async () => {
    jest.spyOn(svc as any, '_lookupPrice').mockResolvedValue(null);
    const r = await computeSapNative({ model: 'm', provider: 'anthropic', inputTokens: 30, outputTokens: 0,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0, imageInputTokens: 0, at: new Date(), productive: false });
    expect(r!.genAiTokens).toBeCloseTo(10, 6);
    expect(r!.sapCost).toBeNull();
    expect(r!.sapCostCurrency).toBeNull();
  });

  it('includes imageInputTokens * imageGenAiRate in genAiTokens', async () => {
    const r = await computeSapNative({ model: 'm', provider: 'anthropic', inputTokens: 0, outputTokens: 0,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0, imageInputTokens: 100, at: new Date('2026-08-01'), productive: false });
    // genAi = 100 * imageGenAiRate (1/3) = 33.33...
    expect(r!.genAiTokens).toBeCloseTo(100 * rate.imageGenAiRate, 6);
  });

  it('reads calibration factors from api_config, default 1.0', () => {
    expect(getCacheBillingFactors('does-not-exist')).toEqual({ read: 1, write: 1 });
  });

  it('treats a legitimate zero cacheReadGenAiRate as zero, not a null fallback to inputGenAiRate', async () => {
    jest.spyOn(svc as any, '_lookupRate').mockResolvedValue({ ...rate, cacheReadGenAiRate: 0 });
    const r = await computeSapNative({ model: 'm', provider: 'anthropic', inputTokens: 0, outputTokens: 0,
      cacheReadInputTokens: 300, cacheCreationInputTokens: 0, imageInputTokens: 0, at: new Date('2026-08-01'), productive: false });
    // cacheReadGenAiRate is genuinely 0 -> cache-read contribution must be 0, NOT 300 * inputGenAiRate (1/3) = 100.
    expect(r!.genAiTokens).toBeCloseTo(0, 6);
  });
});
