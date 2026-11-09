/**
 * calculateCosts prices generated-image tokens at the manual image rate and never charges the
 * same tokens at the text output rate too (spec §3 rule: text output = outputTokens − imageOutputTokens).
 */
jest.mock('@sap/cds', () => ({ connect: { to: jest.fn() }, ql: {} }));
jest.mock('../../../../../libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));
import modelCostService from '../../../src/services/modelCostService';

// Every case below installs its own spy; restoring between them keeps the getModelPricing
// resolution cases (which need the real method) independent of the calculateCosts cases.
afterEach(() => { jest.restoreAllMocks(); });

describe('getModelPricing across the --deployed twin', () => {
  const at = new Date('2026-09-15T00:00:00Z');
  it('falls back from the deployment id to the bare model, where a manual rate may have been entered', async () => {
    // Usage is accounted against `<model>--deployed`, but the Model Library price dialog may
    // have been used on either entry — they are one model, so a rate on the bare id has to
    // price the deployment's rows too (the existing fallback only went bare -> --deployed).
    const bareRow = { inputCost: 0.0005, outputCost: 0.003, imageOutputCost: 0.06, provider: 'Google' };
    const spy = jest.spyOn(modelCostService as any, 'getCachedPricing')
      .mockImplementation(async (id: unknown) => (id === 'gemini-3.1-flash-image' ? bareRow : null));

    await expect(modelCostService.getModelPricing('gemini-3.1-flash-image--deployed', at)).resolves.toEqual(bareRow);
    expect(spy).toHaveBeenCalledWith('gemini-3.1-flash-image', at);
  });
  it('still prefers a rate on the deployment id itself', async () => {
    const deployedRow = { inputCost: 0.001, outputCost: 0.004, imageOutputCost: 0.09, provider: 'Google' };
    jest.spyOn(modelCostService as any, 'getCachedPricing')
      .mockImplementation(async (id: unknown) => (id === 'gemini-3.1-flash-image--deployed' ? deployedRow : { inputCost: 9, outputCost: 9 }));

    await expect(modelCostService.getModelPricing('gemini-3.1-flash-image--deployed', at)).resolves.toEqual(deployedRow);
  });
});

describe('calculateCosts with image output tokens', () => {
  const at = new Date('2026-09-15T00:00:00Z');
  it('splits output into text at the output rate and images at imageOutputCost', async () => {
    jest.spyOn(modelCostService, 'getModelPricing').mockResolvedValue({ inputCost: 0.0005, outputCost: 0.003, imageOutputCost: 0.06, provider: 'Google' } as any);
    const c = await modelCostService.calculateCosts('gemini-3.1-flash-image--deployed', 17, 1296, at, 0, 0, 1290);
    expect(c.outputCost).toBeCloseTo((6 / 1000) * 0.003, 9);
    expect(c.imageOutputCost).toBeCloseTo((1290 / 1000) * 0.06, 9);
    // toBeCloseTo(9) is tighter than the return value's guaranteed precision: calculateCosts
    // rounds every cost field to 6 decimal places (Number(x.toFixed(6)), matching the
    // Decimal(10,6) column), and (17/1000)*0.0005 lands exactly on that rounding's tie-break
    // boundary (0.0000085 -> 0.000009), an unrelated pre-existing characteristic of the
    // (unchanged) inputCost formula — not of the new image-cost split under test here.
    expect(c.inputCost).toBeCloseTo((17 / 1000) * 0.0005, 5);
    // Same rounding-boundary ripple as above: totalCost is computed from the raw (unrounded)
    // components and rounded once (existing architecture, avoids compounding per-field rounding
    // error), so it can differ from the sum of the already-rounded fields by up to ~1e-6 here.
    expect(c.totalCost).toBeCloseTo(c.inputCost + c.outputCost + c.imageOutputCost!, 5);
  });
  it('falls back to the output rate for image tokens when no image rate is maintained', async () => {
    jest.spyOn(modelCostService, 'getModelPricing').mockResolvedValue({ inputCost: 0.0005, outputCost: 0.003, provider: 'Google' } as any);
    const c = await modelCostService.calculateCosts('m', 0, 1296, at, 0, 0, 1290);
    expect(c.outputCost).toBeCloseTo((6 / 1000) * 0.003, 9);
    expect(c.imageOutputCost).toBeCloseTo((1290 / 1000) * 0.003, 9);
  });
  it('is unchanged for requests without image tokens', async () => {
    jest.spyOn(modelCostService, 'getModelPricing').mockResolvedValue({ inputCost: 0.001, outputCost: 0.002, provider: 'OpenAI' } as any);
    const c = await modelCostService.calculateCosts('m', 1000, 1000, at);
    expect(c.outputCost).toBeCloseTo(0.002, 9);
    expect(c.imageOutputCost).toBe(0);
    expect(c.totalCost).toBeCloseTo(0.003, 9);
  });
});
