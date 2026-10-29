/**
 * The SAP cache billing factors (providers.<key>.sap_cache_{read,write}_token_billing_factor) must
 * give the same SAP-native figures on both paths that write them: live capture
 * (usageEventProcessor -> computeSapNative, with the provider it resolved from the model's
 * ModelCosts row) and the nightly cost recalculation (one SQL UPDATE over the stored rows).
 *
 * The provider a usage row carries is the ModelCosts provider SAP publishes for the model
 * ("Anthropic", "OpenAI", "Google", "Amazon"), while the configuration keys are lower case
 * ("anthropic"). Both paths resolve the factor through the same case-insensitive lookup, so only
 * rows of a provider that configures a factor are scaled — never every row.
 *
 * Real sqlite (in-memory, deployed CDS schema) and the real computeSapNative; only the
 * api_config.json read is replaced, to configure factors other than 1.
 */
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

jest.mock('../../src/utils/apiConfigFile', () => ({
  ...jest.requireActual('../../src/utils/apiConfigFile'),
  readApiConfigBlock: () => ({
    platform: { billing: { productive: false } },
    providers: {
      anthropic: { sap_cache_read_token_billing_factor: 2, sap_cache_write_token_billing_factor: 3 }
    }
  })
}));

const cds = require('@sap/cds');

import { CostRecalculationService } from '../../src/services/costRecalculationService';
import { computeSapNative, getCacheBillingFactors } from '../../src/services/sapCapacityService';

const USAGE = 'sap.llm.gateway.admin.ApiKeyUsage';
const AWS_USAGE = 'sap.llm.gateway.admin.AwsCredentialUsage';
const MODEL_COSTS = 'sap.llm.gateway.admin.ModelCosts';
const PRICES = 'sap.llm.gateway.admin.SapCapacityUnitPrice';

// One model per family with a cache regime of its own (memory: sap-orchestration-cache-regime):
// Claude and Nova exclusive, OpenAI and Gemini inclusive. The regime is folded in the gateway
// before the usage event is written, so the stored token counts are what both paths price.
const MODELS = [
  { model: 'anthropic--claude-4.5-haiku', provider: 'Anthropic', factored: true },
  { model: 'gpt-4.1', provider: 'OpenAI', factored: false },
  { model: 'gemini-2.5-flash', provider: 'Google', factored: false },
  { model: 'amazon--nova-lite', provider: 'Amazon', factored: false }
];

const TOKENS = { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 2000, cacheCreationInputTokens: 400 };

describe('cache billing factors: live capture and the nightly recalculation agree', () => {
  let db: any;
  const validFrom = new Date().toISOString();

  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } };
    db = await cds.connect.to('db');
    await cds.deploy(join(__dirname, '../../src/db/schema')).to(db);

    const { INSERT } = cds.ql;
    for (const m of MODELS) {
      await db.run(INSERT.into(MODEL_COSTS).entries({
        ID: uuidv4(), model: m.model, provider: m.provider,
        dateFrom: '2020-01-01T00:00:00.000Z', dateTo: '2030-01-01T00:00:00.000Z',
        inputCost: 10, outputCost: 20, cacheReadInputCost: 5, cacheCreationInputCost: 15
      }));
    }
    await db.run(INSERT.into(PRICES).entries({
      ID: uuidv4(), usageType: 'non-productive',
      dateFrom: '2020-01-01T00:00:00.000Z', dateTo: '2030-01-01T00:00:00.000Z',
      pricePerCu: 3, currency: 'EUR'
    }));
  });

  it('resolves the factor of the row provider case-insensitively, 1 for providers without one', () => {
    expect(getCacheBillingFactors('anthropic')).toEqual({ read: 2, write: 3 });
    expect(getCacheBillingFactors('Anthropic')).toEqual({ read: 2, write: 3 });
    for (const p of ['OpenAI', 'Google', 'Amazon', 'unknown', '']) {
      expect(getCacheBillingFactors(p)).toEqual({ read: 1, write: 1 });
    }
  });

  it.each(MODELS)('$model ($provider): same SAP-native figures on both paths', async ({ model, provider, factored }) => {
    const { INSERT, SELECT } = cds.ql;
    const at = new Date(validFrom);

    // Live capture: computeSapNative with the provider the processor resolved (ModelCosts.provider).
    const live = await computeSapNative({ model, provider, ...TOKENS, imageInputTokens: 0, at, productive: false });
    expect(live).not.toBeNull();

    // genAi = 1000*0.01 + 500*0.02 + (2000*fr)*0.005 + (400*fw)*0.015
    const [fr, fw] = factored ? [2, 3] : [1, 1];
    const expected = 10 + 10 + 2000 * fr * 0.005 + 400 * fw * 0.015;
    expect(live!.genAiTokens).toBeCloseTo(expected, 6);

    // Nightly recalculation over the stored rows (zero costs, so both tables are selected).
    const apiId = uuidv4();
    const awsId = uuidv4();
    await db.run(INSERT.into(USAGE).entries({
      ID: apiId, model, provider, validFrom, ...TOKENS, imageInputTokens: 0, inputCost: 0, outputCost: 0, totalCost: 0
    }));
    await db.run(INSERT.into(AWS_USAGE).entries({
      ID: awsId, modelId: model, provider, validFrom, ...TOKENS, imageInputTokens: 0, inputCost: 0, outputCost: 0, totalCost: 0
    }));
    await new CostRecalculationService().runRecalculation();

    for (const row of [
      (await db.run(SELECT.from(USAGE).where({ ID: apiId })))[0],
      (await db.run(SELECT.from(AWS_USAGE).where({ ID: awsId })))[0]
    ]) {
      expect(row.genAiTokens).toBeCloseTo(live!.genAiTokens, 3);
      expect(row.capacityUnits).toBeCloseTo(live!.capacityUnits, 3);
      expect(row.sapCost).toBeCloseTo(live!.sapCost!, 3);
      expect(row.sapCostCurrency).toBe(live!.sapCostCurrency);
    }
  });

  // A row whose provider is unknown to the configuration, or missing, gets factor 1 even for an
  // Anthropic model: the factor follows the row's provider, as on live capture.
  it.each([null, 'unknown'])('a recalculated row with provider %p keeps factor 1', async (provider) => {
    const { INSERT, SELECT } = cds.ql;
    const model = 'anthropic--claude-4.5-haiku';
    const ID = uuidv4();
    await db.run(INSERT.into(USAGE).entries({
      ID, model, provider, validFrom, ...TOKENS, imageInputTokens: 0, inputCost: 0, outputCost: 0, totalCost: 0
    }));
    await new CostRecalculationService().runRecalculation();

    const row = (await db.run(SELECT.from(USAGE).where({ ID })))[0];
    expect(row.genAiTokens).toBeCloseTo(10 + 10 + 2000 * 0.005 + 400 * 0.015, 3);
  });
});
