/**
 * calculateCosts prices realtime audio tokens at the manual audio rates and never charges the
 * same tokens at the text rates too (spec §3: textIn = inputTokens − audioInputTokens,
 * textOut = outputTokens − imageOutputTokens − audioOutputTokens).
 */
jest.mock('@sap/cds', () => ({ connect: { to: jest.fn() }, ql: {} }));
jest.mock('../../../../../libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));
import modelCostService from '../../../src/services/modelCostService';

describe('calculateCosts with audio tokens', () => {
  const at = new Date('2026-09-15T00:00:00Z');
  // SAP Note 3437766, gpt-realtime, per 1,000 model tokens
  const rates = { inputCost: 0.00251, outputCost: 0.00981, audioInputCost: 0.01954, audioOutputCost: 0.03901, provider: 'OpenAI' };

  it('splits both directions into text at the text rates and audio at the audio rates', async () => {
    jest.spyOn(modelCostService, 'getModelPricing').mockResolvedValue(rates as any);
    // input 100 (55 audio), output 30 (20 audio), cached 5
    const c = await modelCostService.calculateCosts('gpt-realtime--deployed', 100, 30, at, 0, 5, 0, 55, 20);
    // Precision 6, not 9: calculateCosts rounds every cost field to 6 decimal places
    // (Number(x.toFixed(6)), matching the Decimal(10,6) column) before returning it, and these
    // small per-request amounts (fractions of a cent) carry real precision past the 6th decimal
    // — the same pre-existing characteristic documented in model-cost-image-output.test.ts.
    expect(c.inputCost).toBeCloseTo((45 / 1000) * 0.00251, 6);
    expect(c.audioInputCost).toBeCloseTo((55 / 1000) * 0.01954, 6);
    expect(c.outputCost).toBeCloseTo((10 / 1000) * 0.00981, 6);
    expect(c.audioOutputCost).toBeCloseTo((20 / 1000) * 0.03901, 6);
    expect(c.cacheReadInputCost).toBeCloseTo((5 / 1000) * 0.00251, 6);
    expect(c.totalCost).toBeCloseTo(c.inputCost + c.audioInputCost + c.outputCost + c.audioOutputCost + c.cacheReadInputCost!, 9);
  });
  it('falls back to the text rates for audio tokens when no audio rates are maintained', async () => {
    jest.spyOn(modelCostService, 'getModelPricing').mockResolvedValue({ inputCost: 0.00251, outputCost: 0.00981, provider: 'OpenAI' } as any);
    const c = await modelCostService.calculateCosts('m', 100, 30, at, 0, 0, 0, 55, 20);
    // Same 6-decimal rounding as above: each summand is independently rounded before the sum.
    expect(c.inputCost + c.audioInputCost).toBeCloseTo((100 / 1000) * 0.00251, 6);
    expect(c.outputCost + c.audioOutputCost).toBeCloseTo((30 / 1000) * 0.00981, 6);
  });
  it('subtracts image and audio output from the text share together and clamps at zero', async () => {
    jest.spyOn(modelCostService, 'getModelPricing').mockResolvedValue({ ...rates, imageOutputCost: 0.06 } as any);
    const c = await modelCostService.calculateCosts('m', 0, 30, at, 0, 0, 20, 0, 20);
    expect(c.outputCost).toBe(0);
    expect(c.imageOutputCost).toBeCloseTo((20 / 1000) * 0.06, 9);
    expect(c.audioOutputCost).toBeCloseTo((20 / 1000) * 0.03901, 6);
  });
  it('is unchanged for requests without audio tokens', async () => {
    jest.spyOn(modelCostService, 'getModelPricing').mockResolvedValue({ inputCost: 0.001, outputCost: 0.002, provider: 'OpenAI' } as any);
    const c = await modelCostService.calculateCosts('m', 1000, 1000, at);
    expect(c.inputCost).toBeCloseTo(0.001, 9);
    expect(c.outputCost).toBeCloseTo(0.002, 9);
    expect(c.audioInputCost).toBe(0);
    expect(c.audioOutputCost).toBe(0);
    expect(c.totalCost).toBeCloseTo(0.003, 9);
  });
});
