import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

// Deliberately NOT mocking @sap/cds here: sap-capacity-service.test.ts (unit) mocks cds and
// spies over _lookupRate/_lookupPrice/_cacheFactors, so the real SELECT.from(...).where(...)
// temporal lookup never executes there. This suite exercises the un-mocked query against a
// real (in-memory sqlite) database to prove the temporal window selection and the
// `orderBy('dateFrom desc')` overlap tie-break actually behave as intended.
//
// The per-model GenAI rates are sourced from ModelCosts (the /v2 discovery data the gateway
// syncs; SAP Note 3437766 "GenAI tokens per 1,000 model tokens"), so this seeds ModelCosts,
// not a hand-maintained rate table. ModelCosts stores per-1,000-token figures and
// computeSapNative divides by 1,000, so an inputCost of 1000 == a per-token rate of 1. The
// CU factor is the maintained constant SAP_CU_FACTOR (not a per-row column).
const cds = require('@sap/cds');

import { computeSapNative, SAP_CU_FACTOR } from '../../src/services/sapCapacityService';

const MODELCOSTS = 'sap.llm.gateway.admin.ModelCosts';
const PRICES = 'sap.llm.gateway.admin.SapCapacityUnitPrice';

// per-token rate `r` is stored in ModelCosts as `r * 1000`.
const per1k = (rate: number) => rate * 1000;

describe('sapCapacityService: temporal rate/price selection (real sqlite, un-mocked)', () => {
  let db: any;

  beforeAll(async () => {
    cds.env.requires.db = {
      kind: 'sqlite',
      credentials: { url: ':memory:' }
    };
    db = await cds.connect.to('db');
    await cds.deploy(join(__dirname, '../../src/db/schema')).to(db);

    const { INSERT } = cds.ql;

    // --- Boundary case: two adjacent, non-overlapping rate windows for one model. ---
    await db.run(INSERT.into(MODELCOSTS).entries([
      {
        ID: uuidv4(), model: 'sap-temporal-rate-boundary',
        dateFrom: '2026-07-01T00:00:00.000Z', dateTo: '2026-07-29T23:59:59.999Z',
        inputCost: per1k(1), outputCost: per1k(1)
      },
      {
        ID: uuidv4(), model: 'sap-temporal-rate-boundary',
        dateFrom: '2026-07-30T00:00:00.000Z', dateTo: '2026-12-31T23:59:59.999Z',
        inputCost: per1k(2), outputCost: per1k(2)
      }
    ]));

    // --- Overlap case: two rate windows for one model that both cover a given instant;
    // the newer (later dateFrom) one must win via orderBy('dateFrom desc'). ---
    await db.run(INSERT.into(MODELCOSTS).entries([
      {
        ID: uuidv4(), model: 'sap-temporal-rate-overlap',
        dateFrom: '2026-01-01T00:00:00.000Z', dateTo: '2026-12-31T23:59:59.999Z',
        inputCost: per1k(5), outputCost: per1k(5)
      },
      {
        ID: uuidv4(), model: 'sap-temporal-rate-overlap',
        dateFrom: '2026-06-01T00:00:00.000Z', dateTo: '2026-12-31T23:59:59.999Z',
        inputCost: per1k(9), outputCost: per1k(9)
      }
    ]));

    // --- Price boundary case: two adjacent, non-overlapping price windows for one usageType. ---
    await db.run(INSERT.into(MODELCOSTS).entries({
      ID: uuidv4(), model: 'sap-temporal-price-boundary',
      dateFrom: '2020-01-01T00:00:00.000Z', dateTo: '2030-01-01T00:00:00.000Z',
      inputCost: per1k(1), outputCost: per1k(1)
    }));
    await db.run(INSERT.into(PRICES).entries([
      {
        ID: uuidv4(), usageType: 'non-productive',
        dateFrom: '2026-07-01T00:00:00.000Z', dateTo: '2026-07-29T23:59:59.999Z',
        pricePerCu: 10, currency: 'USD'
      },
      {
        ID: uuidv4(), usageType: 'non-productive',
        dateFrom: '2026-07-30T00:00:00.000Z', dateTo: '2026-12-31T23:59:59.999Z',
        pricePerCu: 20, currency: 'EUR'
      }
    ]));
  });

  it('selects the rate row valid up to the boundary instant', async () => {
    const r = await computeSapNative({
      model: 'sap-temporal-rate-boundary', provider: 'anthropic',
      inputTokens: 10, outputTokens: 0,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0, imageInputTokens: 0,
      at: new Date('2026-07-29T23:59:59.999Z'), productive: false
    });
    expect(r!.genAiTokens).toBeCloseTo(10, 6); // rate 1
  });

  it('selects the next rate row starting exactly at the boundary instant', async () => {
    const r = await computeSapNative({
      model: 'sap-temporal-rate-boundary', provider: 'anthropic',
      inputTokens: 10, outputTokens: 0,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0, imageInputTokens: 0,
      at: new Date('2026-07-30T00:00:00.000Z'), productive: false
    });
    expect(r!.genAiTokens).toBeCloseTo(20, 6); // rate 2
  });

  it('breaks ties between overlapping rate windows in favor of the later dateFrom', async () => {
    const r = await computeSapNative({
      model: 'sap-temporal-rate-overlap', provider: 'anthropic',
      inputTokens: 10, outputTokens: 0,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0, imageInputTokens: 0,
      at: new Date('2026-08-01T00:00:00.000Z'), productive: false
    });
    // Both windows cover 2026-08-01; orderBy('dateFrom desc') must pick the 2026-06-01 window
    // (rate 9), not the 2026-01-01 window (rate 5).
    expect(r!.genAiTokens).toBeCloseTo(90, 6);
  });

  it('selects the price row valid up to the boundary instant', async () => {
    const r = await computeSapNative({
      model: 'sap-temporal-price-boundary', provider: 'anthropic',
      inputTokens: 10, outputTokens: 0,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0, imageInputTokens: 0,
      at: new Date('2026-07-29T23:59:59.999Z'), productive: false
    });
    // genAiTokens=10, CU factor=SAP_CU_FACTOR, pricePerCu=10
    expect(r!.sapCost).toBeCloseTo(10 * SAP_CU_FACTOR * 10, 4);
    expect(r!.sapCostCurrency).toBe('USD');
  });

  it('selects the next price row starting exactly at the boundary instant', async () => {
    const r = await computeSapNative({
      model: 'sap-temporal-price-boundary', provider: 'anthropic',
      inputTokens: 10, outputTokens: 0,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0, imageInputTokens: 0,
      at: new Date('2026-07-30T00:00:00.000Z'), productive: false
    });
    // genAiTokens=10, CU factor=SAP_CU_FACTOR, pricePerCu=20
    expect(r!.sapCost).toBeCloseTo(10 * SAP_CU_FACTOR * 20, 4);
    expect(r!.sapCostCurrency).toBe('EUR');
  });
});
