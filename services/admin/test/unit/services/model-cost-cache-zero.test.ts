/**
 * C7 (whole-solution review, usage/billing audit): `getCachedPricing`
 * (modelCostService.ts:246-256) read a manual cache price with `||`/truthiness
 * instead of a null/undefined check:
 *   cacheReadInputCost: cacheReadInputCostValue ? parseFloat(cacheReadInputCostValue) : undefined
 * A price of exactly 0 is falsy, so it fell through to `undefined`, and the
 * caller (`calculateCosts`, :925-926) then falls back to the FULL input rate
 * whenever the cache price is `undefined` — silently over-billing every
 * request against a model priced at 0 for cache reads/writes.
 *
 * SQLite (`better-sqlite3`, `@cap-js/sqlite`) returns a NUMERIC(10,6) 0 as the
 * JS number `0` — falsy. Postgres (`node-postgres`) returns it as the string
 * `"0.000000"` — truthy — which is why this reproduced only on SQLite (local
 * dev, CI, npm standalone), not on docker/kyma Postgres.
 */
jest.mock('@sap/cds', () => ({ connect: { to: jest.fn() }, ql: {} }));
jest.mock('../../../../../libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));

import modelCostService from '../../../src/services/modelCostService';

const cds = require('@sap/cds');

function mockDb(row: Record<string, any>, kind: 'sqlite' | 'postgres' = 'sqlite') {
  (cds.connect.to as jest.Mock).mockResolvedValue({
    options: { credentials: { kind } },
    run: jest.fn().mockResolvedValue([row])
  });
}

describe('getCachedPricing honours a manual cache price of 0 (C7)', () => {
  const at = new Date('2026-09-15T00:00:00Z');

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps cacheReadInputCost/cacheCreationInputCost at 0 when SQLite returns the number 0', async () => {
    mockDb({
      inputCost: 0.003, outputCost: 0.015,
      cacheReadInputCost: 0, cacheCreationInputCost: 0,
      provider: 'anthropic'
    }, 'sqlite');

    const pricing = await (modelCostService as any).getCachedPricing('claude-3-5-sonnet', at);

    expect(pricing.cacheReadInputCost).toBe(0);
    expect(pricing.cacheCreationInputCost).toBe(0);
  });

  it('keeps them at 0 when Postgres returns the decimal string "0.000000"', async () => {
    mockDb({
      inputCost: '0.003000', outputCost: '0.015000',
      cacheReadInputCost: '0.000000', cacheCreationInputCost: '0.000000',
      provider: 'anthropic'
    }, 'postgres');

    const pricing = await (modelCostService as any).getCachedPricing('claude-3-5-sonnet', at);

    expect(pricing.cacheReadInputCost).toBe(0);
    expect(pricing.cacheCreationInputCost).toBe(0);
  });

  it('still falls back to undefined (-> input rate in calculateCosts) when the price is null', async () => {
    mockDb({
      inputCost: 0.003, outputCost: 0.015,
      cacheReadInputCost: null, cacheCreationInputCost: null,
      provider: 'anthropic'
    }, 'sqlite');

    const pricing = await (modelCostService as any).getCachedPricing('claude-3-5-sonnet', at);

    expect(pricing.cacheReadInputCost).toBeUndefined();
    expect(pricing.cacheCreationInputCost).toBeUndefined();
  });

  it('end-to-end: calculateCosts bills 0 for cache tokens, not the input rate, when the DB returns the SQLite shape', async () => {
    // No getModelPricing spy here — this must actually reach getCachedPricing
    // (via the real getModelPricing) through the mocked db.run, so it fails
    // without the fix rather than only exercising the already-correct
    // calculateCosts fallback check.
    mockDb({
      inputCost: 0.003, outputCost: 0.015,
      cacheReadInputCost: 0, cacheCreationInputCost: 0,
      provider: 'anthropic'
    }, 'sqlite');

    const c = await modelCostService.calculateCosts('claude-3-5-sonnet', 1000, 0, at, 1000, 1000);

    expect(c.cacheReadInputCost).toBe(0);
    expect(c.cacheCreationInputCost).toBe(0);
  });
});
