/**
 * SAP-native CU/cost analytics (Task 11): the SAP-native fields added by Tasks 3/5/6
 * (imageInputTokens, genAiTokens, capacityUnits, sapCost, sapCostCurrency) surfaced beside the
 * existing dollar-estimate aggregates on ApiKeyUsageStats.
 *
 * capacityUnits/genAiTokens/imageInputTokens are currency-neutral and always sum across an
 * apiKey's rows, so they stay on ApiKeyUsageStats. sapCost is priced in a currency, so it must
 * never be summed across different currencies for the same apiKey - it is exposed instead via
 * the companion view ApiKeyUsageSapCostStats, grouped by (apiKey, sapCostCurrency). See the doc
 * comments on both views in src/db/schema/api-keys.cds for the full grain/distortion rationale.
 */
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

const cds = require('@sap/cds');

const USAGE = 'sap.llm.gateway.admin.ApiKeyUsage';
const STATS = 'sap.llm.gateway.admin.ApiKeyUsageStats';
const SAP_COST_STATS = 'sap.llm.gateway.admin.ApiKeyUsageSapCostStats';

describe('ApiKeyUsageStats / ApiKeyUsageSapCostStats: SAP-native CU/cost aggregates (real sqlite, un-mocked)', () => {
  let db: any;
  let apiKeyId: string;

  beforeAll(async () => {
    cds.env.requires.db = {
      kind: 'sqlite',
      credentials: { url: ':memory:' }
    };
    db = await cds.connect.to('db');
    await cds.deploy(join(__dirname, '../../src/db/schema')).to(db);
  });

  beforeAll(async () => {
    const { INSERT } = cds.ql;
    apiKeyId = uuidv4();

    // Two rows for the SAME apiKey, in two DIFFERENT sapCostCurrency values. validTo must be set
    // to the "still current" sentinel (as usageEventProcessor.ts does on every real insert) -
    // ApiKeyUsageStats/ApiKeyUsageSapCostStats select from ApiKeyUsage, a temporal entity, so the
    // compiler bakes a `validTo > session_context('$valid.from')` predicate into both views; a
    // NULL validTo never satisfies that comparison and the row is silently excluded from both.
    const validTo = '9999-12-31T23:59:59.999Z';

    await db.run(INSERT.into(USAGE).entries({
      ID: uuidv4(),
      apiKey_ID: apiKeyId,
      provider: 'anthropic',
      model: 'sap-native-analytics-model',
      validFrom: new Date().toISOString(),
      validTo,
      inputTokens: 100,
      outputTokens: 50,
      inputCost: 0.01,
      outputCost: 0.02,
      totalCost: 0.03,
      imageInputTokens: 2,
      imageOutputTokens: 1290,
      audioInputTokens: 55,
      audioOutputTokens: 20,
      genAiTokens: 10,
      capacityUnits: 5,
      sapCost: 15,
      sapCostCurrency: 'USD'
    }));

    await db.run(INSERT.into(USAGE).entries({
      ID: uuidv4(),
      apiKey_ID: apiKeyId,
      provider: 'anthropic',
      model: 'sap-native-analytics-model',
      validFrom: new Date().toISOString(),
      validTo,
      inputTokens: 200,
      outputTokens: 75,
      inputCost: 0.02,
      outputCost: 0.03,
      totalCost: 0.05,
      imageInputTokens: 3,
      imageOutputTokens: 1120,
      audioInputTokens: 45,
      audioOutputTokens: 30,
      genAiTokens: 20,
      capacityUnits: 7,
      sapCost: 25,
      sapCostCurrency: 'EUR'
    }));
  });

  it('sums the currency-neutral SAP-native columns across all rows for the apiKey', async () => {
    const { SELECT } = cds.ql;
    const rows = await db.run(SELECT.from(STATS).where({ apiKey_ID: apiKeyId }));

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.totalImageInputTokens).toBe(5); // 2 + 3
    expect(row.totalImageOutputTokens).toBe(2410); // 1290 + 1120
    expect(row.totalAudioInputTokens).toBe(100); // 55 + 45
    expect(row.totalAudioOutputTokens).toBe(50); // 20 + 30
    expect(Number(row.totalGenAiTokens)).toBeCloseTo(30, 4); // 10 + 20
    expect(Number(row.totalCapacityUnits)).toBeCloseTo(12, 6); // 5 + 7
    // Still correct alongside the pre-existing dollar aggregates
    expect(Number(row.totalCost)).toBeCloseTo(0.08, 6); // 0.03 + 0.05
    expect(row.totalRequests).toBe(2);
  });

  it('does NOT sum sapCost across different currencies - splits by sapCostCurrency instead', async () => {
    const { SELECT } = cds.ql;
    const rows = await db.run(
      SELECT.from(SAP_COST_STATS).where({ apiKey_ID: apiKeyId }).orderBy('sapCostCurrency')
    );

    expect(rows).toHaveLength(2);

    const eurRow = rows.find((r: any) => r.sapCostCurrency === 'EUR');
    const usdRow = rows.find((r: any) => r.sapCostCurrency === 'USD');

    expect(eurRow).toBeDefined();
    expect(usdRow).toBeDefined();
    expect(Number(eurRow.totalSapCost)).toBeCloseTo(25, 6);
    expect(Number(usdRow.totalSapCost)).toBeCloseTo(15, 6);

    // Critically: no row anywhere carries the wrong, currency-blind sum of 40.
    const wronglyCombined = rows.find((r: any) => Number(r.totalSapCost) === 40);
    expect(wronglyCombined).toBeUndefined();
  });

  it('totalImageOutputTokens is 0 for an apiKey without image rows', async () => {
    const { SELECT, INSERT } = cds.ql;
    const keyWithoutImages = uuidv4();
    const validTo = '9999-12-31T23:59:59.999Z';

    await db.run(INSERT.into(USAGE).entries({
      ID: uuidv4(),
      apiKey_ID: keyWithoutImages,
      provider: 'anthropic',
      model: 'text-only-model',
      validFrom: new Date().toISOString(),
      validTo,
      inputTokens: 50,
      outputTokens: 25,
      inputCost: 0.005,
      outputCost: 0.01,
      totalCost: 0.015,
      // imageInputTokens, imageOutputTokens, audioInputTokens and audioOutputTokens left null/undefined
      genAiTokens: 5,
      capacityUnits: 2,
      sapCost: 5,
      sapCostCurrency: 'USD'
    }));

    const rows = await db.run(SELECT.from(STATS).where({ apiKey_ID: keyWithoutImages }));

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.totalImageInputTokens).toBe(0);
    expect(row.totalImageOutputTokens).toBe(0);
    expect(row.totalAudioInputTokens).toBe(0);
    expect(row.totalAudioOutputTokens).toBe(0);
  });
});
