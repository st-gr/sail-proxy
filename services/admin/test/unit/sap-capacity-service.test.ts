const whereCalls: any[][] = [];
jest.mock('@sap/cds', () => ({
  connect: { to: jest.fn() },
  ql: { SELECT: {
    one: { from: () => ({ where: () => ({ orderBy: () => null }) }) },
    from: () => ({ where: (...args: any[]) => { whereCalls.push(args); return { orderBy: () => ({ query: args[1] }) }; } }),
  } },
}));
import { computeSapNative, getCacheBillingFactors } from '../../src/services/sapCapacityService';

// Deterministic rates/price injected via a seam the service exposes for tests:
import * as svc from '../../src/services/sapCapacityService';

describe('_lookupRate resolves a manual price across the --deployed twin', () => {
  const cds = require('@sap/cds');
  const row = { inputCost: '0.0005', outputCost: '0.003', cacheReadInputCost: null, cacheCreationInputCost: null, imageOutputCost: '0.06', audioInputCost: '0.01954', audioOutputCost: '0.03901' };
  beforeEach(() => { jest.restoreAllMocks(); whereCalls.length = 0; });

  it('falls back from the deployment id to the bare model id', async () => {
    const run = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([row]);
    cds.connect.to.mockResolvedValue({ run });
    const rate = await (svc as any)._lookupRate('gemini-3.1-flash-image--deployed', new Date('2026-09-15'));
    expect(run).toHaveBeenCalledTimes(2);
    expect(whereCalls[0][1]).toBe('gemini-3.1-flash-image--deployed');
    expect(whereCalls[1][1]).toBe('gemini-3.1-flash-image');
    expect(rate.imageOutputGenAiRate).toBeCloseTo(0.06 / 1000, 12);
    expect(rate.outputGenAiRate).toBeCloseTo(0.003 / 1000, 12);
    expect(rate.audioInputGenAiRate).toBeCloseTo(0.01954 / 1000, 12);
    expect(rate.audioOutputGenAiRate).toBeCloseTo(0.03901 / 1000, 12);
  });
  it('falls back from the bare id to its --deployed twin', async () => {
    const run = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([row]);
    cds.connect.to.mockResolvedValue({ run });
    const rate = await (svc as any)._lookupRate('gemini-3.1-flash-image', new Date('2026-09-15'));
    expect(whereCalls.map((c) => c[1])).toEqual(['gemini-3.1-flash-image', 'gemini-3.1-flash-image--deployed']);
    expect(rate.inputGenAiRate).toBeCloseTo(0.0005 / 1000, 12);
  });
  it('returns null when neither id has a row', async () => {
    cds.connect.to.mockResolvedValue({ run: jest.fn().mockResolvedValue([]) });
    expect(await (svc as any)._lookupRate('nope--deployed', new Date('2026-09-15'))).toBeNull();
  });
});

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

  it('prices image output tokens at imageOutputGenAiRate and the remaining output at the output rate', async () => {
    jest.spyOn(svc as any, '_lookupRate').mockResolvedValue({ ...rate, outputGenAiRate: 1 / 15, imageOutputGenAiRate: 1 / 2 });
    const r = await computeSapNative({ model: 'm', provider: 'google', inputTokens: 0, outputTokens: 1296,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0, imageInputTokens: 0, imageOutputTokens: 1290, at: new Date('2026-09-15'), productive: false });
    // 6 text tokens / 15 + 1290 image tokens / 2 = 0.4 + 645
    expect(r!.genAiTokens).toBeCloseTo(645.4, 6);
  });
  it('falls back to the output rate for image tokens when no image rate is maintained', async () => {
    jest.spyOn(svc as any, '_lookupRate').mockResolvedValue({ ...rate, outputGenAiRate: 1 / 15, imageOutputGenAiRate: null });
    const r = await computeSapNative({ model: 'm', provider: 'google', inputTokens: 0, outputTokens: 1296,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0, imageInputTokens: 0, imageOutputTokens: 1290, at: new Date('2026-09-15'), productive: false });
    expect(r!.genAiTokens).toBeCloseTo(1296 / 15, 6);
  });

  it('prices audio tokens at the audio GenAI rates and the text shares at the text rates (SAP Note 3437766 figures)', async () => {
    jest.spyOn(svc as any, '_lookupRate').mockResolvedValue({ ...rate,
      inputGenAiRate: 0.00251 / 1000, outputGenAiRate: 0.00981 / 1000,
      audioInputGenAiRate: 0.01954 / 1000, audioOutputGenAiRate: 0.03901 / 1000, cacheReadGenAiRate: 0.00251 / 1000 });
    const r = await computeSapNative({ model: 'gpt-realtime--deployed', provider: 'openai', inputTokens: 100, outputTokens: 30,
      cacheReadInputTokens: 5, cacheCreationInputTokens: 0, imageInputTokens: 0, audioInputTokens: 55, audioOutputTokens: 20, at: new Date('2026-09-15'), productive: false });
    // (45×0.00251 + 55×0.01954 + 10×0.00981 + 20×0.03901 + 5×0.00251) / 1000
    expect(r!.genAiTokens).toBeCloseTo((45 * 0.00251 + 55 * 0.01954 + 10 * 0.00981 + 20 * 0.03901 + 5 * 0.00251) / 1000, 12);
  });
  it('falls back to the text rates for audio tokens when no audio rates are maintained', async () => {
    jest.spyOn(svc as any, '_lookupRate').mockResolvedValue({ ...rate, inputGenAiRate: 1 / 3, outputGenAiRate: 1 / 15, audioInputGenAiRate: null, audioOutputGenAiRate: null });
    const r = await computeSapNative({ model: 'm', provider: 'openai', inputTokens: 300, outputTokens: 150,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0, imageInputTokens: 0, audioInputTokens: 100, audioOutputTokens: 50, at: new Date('2026-09-15'), productive: false });
    expect(r!.genAiTokens).toBeCloseTo(300 / 3 + 150 / 15, 6);
  });
  it('clamps audio input to inputTokens and takes image and audio output off the text share together', async () => {
    jest.spyOn(svc as any, '_lookupRate').mockResolvedValue({ ...rate, inputGenAiRate: 1, outputGenAiRate: 1, imageOutputGenAiRate: 2, audioInputGenAiRate: 3, audioOutputGenAiRate: 4 });
    const r = await computeSapNative({ model: 'm', provider: 'openai', inputTokens: 10, outputTokens: 30,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0, imageInputTokens: 0, imageOutputTokens: 20, audioInputTokens: 50, audioOutputTokens: 20, at: new Date('2026-09-15'), productive: false });
    // input: 0 text + 10 audio×3 = 30; output: 0 text + 20 image×2 + 20 audio×4 = 120
    expect(r!.genAiTokens).toBeCloseTo(150, 6);
  });
});
