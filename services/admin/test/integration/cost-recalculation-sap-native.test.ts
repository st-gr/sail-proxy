/**
 * costRecalculationService — SAP-native CU/cost retroactive recompute (real sqlite, un-mocked).
 *
 * buildUpdateSQL's SQLite variant is exercised here against the real (deployed) CDS schema in an
 * in-memory sqlite database, via the same @cap-js/sqlite engine used in production. The
 * PostgreSQL variant added alongside it uses the same formula and the same CASE-based
 * matching-price guard; it is structurally symmetric with the SQLite variant covered here and is
 * exercised by the CI PostgreSQL job, not locally testable without a live PG instance.
 *
 * Row eligibility for the whole UPDATE (dollar columns AND the SAP-native columns) is governed by
 * the pre-existing ModelCosts-match gate — a row without a ModelCosts entry never enters the
 * result set. The per-model GenAI rates are themselves sourced from ModelCosts (the /v2 discovery
 * data; SAP Note 3437766 "GenAI tokens per 1,000 model tokens", divided by 1,000), and the CU
 * factor is the maintained constant. So genAiTokens/capacityUnits fill in for every eligible row;
 * only the priced sapCost/sapCostCurrency additionally require a matching SapCapacityUnitPrice row,
 * and stay untouched (never forced to NULL) when no price exists.
 */
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

const cds = require('@sap/cds');

import { CostRecalculationService } from '../../src/services/costRecalculationService';
import { SAP_CU_FACTOR, isProductive } from '../../src/services/sapCapacityService';

// The recalc prices with the usage type isProductive() resolves to (from platform.billing.productive
// in api_config.json), so seed the matching price row rather than a hardcoded one.
const PRICED_USAGE_TYPE = isProductive() ? 'productive' : 'non-productive';

const USAGE = 'sap.llm.gateway.admin.ApiKeyUsage';
const MODEL_COSTS = 'sap.llm.gateway.admin.ModelCosts';
const PRICES = 'sap.llm.gateway.admin.SapCapacityUnitPrice';

describe('costRecalculationService: SAP-native CU/cost recompute (real sqlite, un-mocked)', () => {
  let db: any;

  beforeAll(async () => {
    cds.env.requires.db = {
      kind: 'sqlite',
      credentials: { url: ':memory:' }
    };
    db = await cds.connect.to('db');
    await cds.deploy(join(__dirname, '../../src/db/schema')).to(db);
  });

  it('fills genAiTokens/capacityUnits/sapCost/sapCostCurrency from ModelCosts + a matching price', async () => {
    const { INSERT, SELECT } = cds.ql;

    const usageId = uuidv4();
    const validFrom = new Date().toISOString();
    const model = 'sap-native-recalc-model';

    // ModelCosts carries both the dollar-estimate cost AND the GenAI conversion rate
    // (per 1,000 model tokens; computeSapNative/recalc divide by 1,000). inputCost 10 =>
    // per-token GenAI rate 0.01, etc.
    await db.run(INSERT.into(MODEL_COSTS).entries({
      ID: uuidv4(),
      model,
      dateFrom: '2020-01-01T00:00:00.000Z',
      dateTo: '2030-01-01T00:00:00.000Z',
      inputCost: 10,
      outputCost: 20,
      cacheReadInputCost: 5,
      cacheCreationInputCost: 15
    }));

    await db.run(INSERT.into(PRICES).entries({
      ID: uuidv4(),
      usageType: PRICED_USAGE_TYPE,
      dateFrom: '2020-01-01T00:00:00.000Z',
      dateTo: '2030-01-01T00:00:00.000Z',
      pricePerCu: 3,
      currency: 'EUR'
    }));

    await db.run(INSERT.into(USAGE).entries({
      ID: usageId,
      model,
      provider: 'anthropic',
      validFrom,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 200,
      cacheCreationInputTokens: 100,
      imageInputTokens: 0,
      inputCost: 0,
      outputCost: 0,
      totalCost: 0
    }));

    const service = new CostRecalculationService();
    await service.runRecalculation();

    const rows = await db.run(SELECT.from(USAGE).where({ ID: usageId }));
    const row = rows[0];

    // genAiTokens = 1000*0.01 + 500*0.02 + (200*1)*0.005 + (100*1)*0.015 + 0
    //             = 10 + 10 + 1 + 1.5 = 22.5
    expect(row.genAiTokens).toBeCloseTo(22.5, 4);
    // capacityUnits = genAiTokens * SAP_CU_FACTOR
    expect(row.capacityUnits).toBeCloseTo(22.5 * SAP_CU_FACTOR, 4);
    // sapCost = capacityUnits * pricePerCu (3)
    expect(row.sapCost).toBeCloseTo(22.5 * SAP_CU_FACTOR * 3, 4);
    expect(row.sapCostCurrency).toBe('EUR');
  });

  it('fills genAiTokens/capacityUnits from ModelCosts but leaves sapCost null when no price row exists', async () => {
    const { INSERT, SELECT, DELETE } = cds.ql;

    // The suite shares one in-memory DB (beforeAll), and the previous test inserted a
    // non-productive price row; clear prices so this case genuinely has none to match.
    await db.run(DELETE.from(PRICES));

    const usageId = uuidv4();
    const model = 'sap-native-recalc-model-no-price';

    await db.run(INSERT.into(MODEL_COSTS).entries({
      ID: uuidv4(),
      model,
      dateFrom: '2020-01-01T00:00:00.000Z',
      dateTo: '2030-01-01T00:00:00.000Z',
      inputCost: 10,
      outputCost: 20
    }));

    await db.run(INSERT.into(USAGE).entries({
      ID: usageId,
      model,
      provider: 'anthropic',
      validFrom: new Date().toISOString(),
      inputTokens: 10,
      outputTokens: 5,
      inputCost: 0,
      outputCost: 0,
      totalCost: 0
    }));

    const service = new CostRecalculationService();
    await service.runRecalculation();

    const rows = await db.run(SELECT.from(USAGE).where({ ID: usageId }));
    const row = rows[0];

    // Rates come from ModelCosts, so the token/CU counts fill in: 10*0.01 + 5*0.02 = 0.2
    expect(row.genAiTokens).toBeCloseTo(0.2, 4);
    expect(row.capacityUnits).toBeCloseTo(0.2 * SAP_CU_FACTOR, 4);
    // ...but the priced amount needs a SapCapacityUnitPrice row, which is absent here.
    expect(row.sapCost).toBeNull();
    expect(row.sapCostCurrency).toBeNull();
  });
});
