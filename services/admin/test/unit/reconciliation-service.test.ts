/**
 * reconciliationService.reconcile (Task 13): administrator-facing invoice reconciliation +
 * calibration back-out.
 *
 * Sums the per-request SAP-native fields (capacityUnits, sapCost per sapCostCurrency,
 * genAiTokens, cacheReadInputTokens, cacheCreationInputTokens) on ApiKeyUsage over a
 * [from,to] window keyed on validFrom, then — given the operator-entered SAP invoice line
 * items — computes the implied calibration factors as SUGGESTIONS only:
 *   impliedCuFactor         = invoice.capacityUnits / invoice.genAiTokens
 *   impliedCacheReadFactor  = invoice.cacheReadInputTokens / capturedCacheReadInputTokens
 *   impliedCacheWriteFactor = invoice.cacheWriteInputTokens / capturedCacheWriteInputTokens
 * reconcile() never writes these back — the operator sets sap_cache_*_token_billing_factor
 * in api_config.json after the SAP inquiry (spec Sec11.3).
 *
 * Hourly-provisioning line items (Baseline CU, Infer-S Node Hour, Grounding, Observability)
 * have no representation on ApiKeyUsage at all — it is exclusively per-request, usage-driven
 * accounting — so there is nothing to filter out; the exclusion falls out of what the table
 * contains, not extra logic here (spec Sec3.4).
 */
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

const cds = require('@sap/cds');

import { reconcile } from '../../src/services/reconciliationService';

const USAGE = 'sap.llm.gateway.admin.ApiKeyUsage';
const VALID_TO_SENTINEL = '9999-12-31T23:59:59.999Z';

describe('reconciliationService.reconcile (real sqlite, un-mocked)', () => {
  let db: any;

  const from = new Date('2026-01-01T00:00:00.000Z');
  const to = new Date('2026-01-31T23:59:59.999Z');

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

    // Row 1: USD, inside the reconciliation window.
    await db.run(INSERT.into(USAGE).entries({
      ID: uuidv4(),
      provider: 'anthropic',
      model: 'reconcile-model',
      validFrom: '2026-01-10T00:00:00.000Z',
      validTo: VALID_TO_SENTINEL,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 100,
      inputCost: 0,
      outputCost: 0,
      totalCost: 0,
      genAiTokens: 20,
      capacityUnits: 10,
      sapCost: 30,
      sapCostCurrency: 'USD'
    }));

    // Row 2: EUR, inside the reconciliation window.
    await db.run(INSERT.into(USAGE).entries({
      ID: uuidv4(),
      provider: 'anthropic',
      model: 'reconcile-model',
      validFrom: '2026-01-15T00:00:00.000Z',
      validTo: VALID_TO_SENTINEL,
      inputTokens: 2000,
      outputTokens: 1000,
      cacheReadInputTokens: 200,
      cacheCreationInputTokens: 50,
      inputCost: 0,
      outputCost: 0,
      totalCost: 0,
      genAiTokens: 40,
      capacityUnits: 25,
      sapCost: 60,
      sapCostCurrency: 'EUR'
    }));

    // Row 3: outside the window — must be excluded from every sum below.
    await db.run(INSERT.into(USAGE).entries({
      ID: uuidv4(),
      provider: 'anthropic',
      model: 'reconcile-model',
      validFrom: '2025-12-01T00:00:00.000Z',
      validTo: VALID_TO_SENTINEL,
      inputTokens: 5000,
      outputTokens: 5000,
      cacheReadInputTokens: 5000,
      cacheCreationInputTokens: 5000,
      inputCost: 0,
      outputCost: 0,
      totalCost: 0,
      genAiTokens: 999,
      capacityUnits: 999,
      sapCost: 999,
      sapCostCurrency: 'USD'
    }));
  });

  it('sums capacityUnits and per-currency sapCost, and captures cache/genAi tokens, over the window', async () => {
    const result = await reconcile({ from, to });

    expect(result.capacityUnits).toBeCloseTo(35, 6); // 10 + 25, row 3 excluded
    expect(result.sapCostByCurrency.USD).toBeCloseTo(30, 6); // row 3's 999 excluded
    expect(result.sapCostByCurrency.EUR).toBeCloseTo(60, 6);
    expect(result.capturedGenAiTokens).toBeCloseTo(60, 4); // 20 + 40
    expect(result.capturedCacheReadInputTokens).toBe(500); // 300 + 200
    expect(result.capturedCacheWriteInputTokens).toBe(150); // 100 + 50 (cacheCreationInputTokens)
  });

  it('computes implied CU/cache factors from invoice figures against captured totals', async () => {
    const result = await reconcile({
      from,
      to,
      invoice: {
        genAiTokens: 60,
        capacityUnits: 42,
        cacheReadInputTokens: 550,
        cacheWriteInputTokens: 165
      }
    });

    expect(result.impliedCuFactor).toBeCloseTo(42 / 60, 6);
    expect(result.impliedCacheReadFactor).toBeCloseTo(550 / 500, 6);
    expect(result.impliedCacheWriteFactor).toBeCloseTo(165 / 150, 6);
  });

  it('returns null implied factors when invoice figures are absent', async () => {
    const withEmptyInvoice = await reconcile({ from, to, invoice: {} });
    expect(withEmptyInvoice.impliedCuFactor).toBeNull();
    expect(withEmptyInvoice.impliedCacheReadFactor).toBeNull();
    expect(withEmptyInvoice.impliedCacheWriteFactor).toBeNull();

    const noInvoiceAtAll = await reconcile({ from, to });
    expect(noInvoiceAtAll.impliedCuFactor).toBeNull();
    expect(noInvoiceAtAll.impliedCacheReadFactor).toBeNull();
    expect(noInvoiceAtAll.impliedCacheWriteFactor).toBeNull();
  });

  it('returns null impliedCuFactor when invoice.genAiTokens is zero (denominator)', async () => {
    const result = await reconcile({
      from,
      to,
      invoice: { capacityUnits: 42, genAiTokens: 0 }
    });
    expect(result.impliedCuFactor).toBeNull();
  });

  it('returns null impliedCacheReadFactor when the captured denominator is zero (no usage in window)', async () => {
    const emptyFrom = new Date('2030-01-01T00:00:00.000Z');
    const emptyTo = new Date('2030-01-31T00:00:00.000Z');

    const result = await reconcile({
      from: emptyFrom,
      to: emptyTo,
      invoice: { cacheReadInputTokens: 100 }
    });

    expect(result.capturedCacheReadInputTokens).toBe(0);
    expect(result.impliedCacheReadFactor).toBeNull();
  });
});
