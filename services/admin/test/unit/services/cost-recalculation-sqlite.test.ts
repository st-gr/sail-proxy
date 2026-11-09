/**
 * Cost Recalculation Service - SQLite arithmetic tests (RED/GREEN TDD)
 *
 * Unlike cost-recalculation.test.ts (which mocks `db.run` and only asserts on
 * SQL text), these tests execute the SQLite-variant UPDATE built by
 * `buildUpdateSQL` against a real in-memory SQLite engine (the same
 * better-sqlite3 binary @cap-js/sqlite uses at runtime) so a wrong formula —
 * not just a missing SQL fragment — fails the test.
 */

import { CostRecalculationService } from '../../../src/services/costRecalculationService';

// Resolve better-sqlite3 the same way @cap-js/sqlite (an existing dependency) does;
// it is not a direct dependency of this package, only a transitive one.
const Database = require(
  require.resolve('better-sqlite3', { paths: [require.resolve('@cap-js/sqlite/package.json')] })
);

const USAGE_TABLE = 'sap_llm_gateway_admin_ApiKeyUsage';
const MODEL_COSTS_TABLE = 'sap_llm_gateway_admin_ModelCosts';
// Referenced (but left empty) by the SAP-native columns' correlated subqueries added in
// buildUpdateSQL — see cost-recalculation-sap-native.test.ts for the populated-fixture coverage
// of the SAP-native formula; these tables just need to exist for the generated SQL to run here.
const SAP_RATES_TABLE = 'sap_llm_gateway_admin_SapCapacityRates';
const SAP_PRICE_TABLE = 'sap_llm_gateway_admin_SapCapacityUnitPrice';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ${USAGE_TABLE} (
      ID TEXT PRIMARY KEY,
      model TEXT,
      validFrom TEXT,
      inputTokens INTEGER,
      outputTokens INTEGER,
      cacheReadInputTokens INTEGER,
      cacheCreationInputTokens INTEGER,
      imageInputTokens INTEGER,
      imageOutputTokens INTEGER,
      audioInputTokens INTEGER,
      audioOutputTokens INTEGER,
      inputCost REAL,
      outputCost REAL,
      cacheReadInputCost REAL,
      cacheCreationInputCost REAL,
      imageOutputCost REAL,
      audioInputCost REAL,
      audioOutputCost REAL,
      totalCost REAL,
      genAiTokens REAL,
      capacityUnits REAL,
      sapCost REAL,
      sapCostCurrency TEXT
    );
    CREATE TABLE ${MODEL_COSTS_TABLE} (
      model TEXT,
      dateFrom TEXT,
      dateTo TEXT,
      inputCost REAL,
      outputCost REAL,
      cacheReadInputCost REAL,
      cacheCreationInputCost REAL,
      imageOutputCost REAL,
      audioInputCost REAL,
      audioOutputCost REAL
    );
    CREATE TABLE ${SAP_RATES_TABLE} (
      model TEXT,
      dateFrom TEXT,
      dateTo TEXT,
      inputGenAiRate REAL,
      outputGenAiRate REAL,
      cacheReadGenAiRate REAL,
      cacheWriteGenAiRate REAL,
      imageGenAiRate REAL,
      cuFactor REAL
    );
    CREATE TABLE ${SAP_PRICE_TABLE} (
      usageType TEXT,
      dateFrom TEXT,
      dateTo TEXT,
      pricePerCu REAL,
      currency TEXT
    );
  `);
  return db;
}

// Real per-1K-token pricing (Claude 3.5 Sonnet-shaped) so the fixture is realistic.
const PRICING = {
  model: 'claude-cache-test',
  dateFrom: '2000-01-01T00:00:00.000Z',
  dateTo: '2100-01-01T00:00:00.000Z',
  inputCost: 0.003,
  outputCost: 0.015,
  cacheReadInputCost: 0.0003,
  cacheCreationInputCost: 0.00375
};

// `overrides` lets a case seed a different model/pricing row (e.g. imageOutputCost) without
// disturbing the PRICING default used by the pre-existing cache-arithmetic cases below.
function insertPricing(db: any, overrides: Partial<Omit<typeof PRICING, 'cacheReadInputCost' | 'cacheCreationInputCost'> & {
  cacheReadInputCost: number | null;
  cacheCreationInputCost: number | null;
  imageOutputCost: number | null;
  audioInputCost: number | null;
  audioOutputCost: number | null;
}> = {}) {
  const row = { imageOutputCost: null, audioInputCost: null, audioOutputCost: null, ...PRICING, ...overrides };
  db.prepare(
    `INSERT INTO ${MODEL_COSTS_TABLE}
      (model, dateFrom, dateTo, inputCost, outputCost, cacheReadInputCost, cacheCreationInputCost, imageOutputCost, audioInputCost, audioOutputCost)
     VALUES (@model, @dateFrom, @dateTo, @inputCost, @outputCost, @cacheReadInputCost, @cacheCreationInputCost, @imageOutputCost, @audioInputCost, @audioOutputCost)`
  ).run(row);
}

function insertUsageRow(db: any, row: {
  id: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  imageOutputTokens?: number;
  audioInputTokens?: number;
  audioOutputTokens?: number;
}) {
  db.prepare(
    `INSERT INTO ${USAGE_TABLE}
      (ID, model, validFrom, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, imageOutputTokens, audioInputTokens, audioOutputTokens,
       inputCost, outputCost, cacheReadInputCost, cacheCreationInputCost, imageOutputCost, audioInputCost, audioOutputCost, totalCost)
     VALUES (@id, @model, @validFrom, @inputTokens, @outputTokens, @cacheReadInputTokens, @cacheCreationInputTokens, @imageOutputTokens, @audioInputTokens, @audioOutputTokens,
       @inputCost, @outputCost, @cacheReadInputCost, @cacheCreationInputCost, @imageOutputCost, @audioInputCost, @audioOutputCost, @totalCost)`
  ).run({
    id: row.id,
    model: row.model ?? PRICING.model,
    validFrom: new Date().toISOString(),
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadInputTokens: row.cacheReadInputTokens,
    cacheCreationInputTokens: row.cacheCreationInputTokens,
    imageOutputTokens: row.imageOutputTokens ?? 0,
    audioInputTokens: row.audioInputTokens ?? 0,
    audioOutputTokens: row.audioOutputTokens ?? 0,
    // Deliberately stale/wrong cost columns from a prior (bad) pricing run —
    // recalculation must overwrite all of these, not just input/output.
    inputCost: 999,
    outputCost: 999,
    cacheReadInputCost: 999,
    cacheCreationInputCost: 999,
    imageOutputCost: 999,
    audioInputCost: 999,
    audioOutputCost: 999,
    totalCost: 999
  });
}

function runRecalc(db: any, joinCondition = 'u.model = mc.model') {
  const service = new CostRecalculationService();
  // buildUpdateSQL is private; reach in to get the exact production SQL string.
  const sql: string = (service as any).buildUpdateSQL(USAGE_TABLE, joinCondition, false);
  const cutoffISO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(sql).run(cutoffISO);
}

function expectedTotalCost(tokens: {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}): number {
  const total =
    (tokens.inputTokens / 1000) * PRICING.inputCost +
    (tokens.outputTokens / 1000) * PRICING.outputCost +
    (tokens.cacheReadInputTokens / 1000) * PRICING.cacheReadInputCost +
    (tokens.cacheCreationInputTokens / 1000) * PRICING.cacheCreationInputCost;
  return Number(total.toFixed(6));
}

describe('CostRecalculationService — SQLite arithmetic (real engine)', () => {
  it('includes cacheRead and cacheCreation cost in totalCost for a row with cache activity', () => {
    const db = makeDb();
    insertPricing(db);
    const tokens = {
      inputTokens: 14,
      outputTokens: 200,
      cacheReadInputTokens: 29004,
      cacheCreationInputTokens: 0
    };
    insertUsageRow(db, { id: 'row-1', ...tokens });

    const result = runRecalc(db);
    expect(result.changes).toBe(1);

    const row = db.prepare(
      `SELECT inputCost, outputCost, cacheReadInputCost, cacheCreationInputCost, totalCost FROM ${USAGE_TABLE} WHERE ID = ?`
    ).get('row-1');

    // Cache cost columns must actually be recomputed, not left at their stale value.
    expect(row.cacheReadInputCost).not.toBe(999);
    expect(row.cacheReadInputCost).toBeCloseTo((tokens.cacheReadInputTokens / 1000) * PRICING.cacheReadInputCost, 6);
    expect(row.cacheCreationInputCost).toBeCloseTo(0, 6);

    // totalCost must equal input + output + cacheRead + cacheCreation, not just input + output.
    expect(row.totalCost).toBeCloseTo(expectedTotalCost(tokens), 6);
    // Sanity: with 29004 cached tokens the cache contribution dwarfs input+output —
    // if totalCost only summed input+output it would be orders of magnitude smaller.
    expect(row.totalCost).toBeGreaterThan(row.inputCost + row.outputCost);
  });

  it('does not skip a fully-cached row (inputTokens <= 1, large cacheRead) under the recalculation gate', () => {
    const db = makeDb();
    insertPricing(db);
    const tokens = {
      inputTokens: 1,
      outputTokens: 50,
      cacheReadInputTokens: 29004,
      cacheCreationInputTokens: 0
    };
    insertUsageRow(db, { id: 'row-fully-cached', ...tokens });

    const result = runRecalc(db);
    expect(result.changes).toBe(1);

    const row = db.prepare(
      `SELECT totalCost FROM ${USAGE_TABLE} WHERE ID = ?`
    ).get('row-fully-cached');

    expect(row.totalCost).toBeCloseTo(expectedTotalCost(tokens), 6);
  });

  it('still skips a row with no input, output, or cache activity (inputTokens <= 1 and no cache tokens)', () => {
    const db = makeDb();
    insertPricing(db);
    const tokens = {
      inputTokens: 1,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0
    };
    insertUsageRow(db, { id: 'row-empty', ...tokens });

    const result = runRecalc(db);
    expect(result.changes).toBe(0);

    const row = db.prepare(
      `SELECT totalCost FROM ${USAGE_TABLE} WHERE ID = ?`
    ).get('row-empty');
    // Left untouched by the gate — still the stale sentinel value.
    expect(row.totalCost).toBe(999);
  });

  it('prices image output tokens at ModelCosts.imageOutputCost and the text share at outputCost', () => {
    const db = makeDb();
    insertPricing(db, { model: 'gemini-3.1-flash-image--deployed', inputCost: 0.0005, outputCost: 0.003, imageOutputCost: 0.06 });
    insertUsageRow(db, {
      id: 'row-image',
      model: 'gemini-3.1-flash-image--deployed',
      inputTokens: 17,
      outputTokens: 1296,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      imageOutputTokens: 1290
    });

    const result = runRecalc(db);
    expect(result.changes).toBe(1);

    const row = db.prepare(
      `SELECT outputCost, imageOutputCost, totalCost FROM ${USAGE_TABLE} WHERE ID = ?`
    ).get('row-image');
    expect(row.outputCost).toBeCloseTo((6 / 1000) * 0.003, 6);
    expect(row.imageOutputCost).toBeCloseTo((1290 / 1000) * 0.06, 6);
    // Precision 5, not 6: totalCost is ROUND()ed from the raw (unrounded) components in one SQL
    // expression, while this assertion sums the already-rounded outputCost/imageOutputCost — the
    // same rounding-boundary ripple documented in model-cost-image-output.test.ts for the
    // identical (17, 0.0005) inputCost term, which lands exactly on a tie-break boundary.
    expect(row.totalCost).toBeCloseTo((17 / 1000) * 0.0005 + row.outputCost + row.imageOutputCost, 5);
  });

  it('admits an image-only row (no input, no cache tokens) under the recalculation gate', () => {
    // A generation is one short prompt and ~1290 image tokens, so the pre-existing
    // input/cache activity gate skipped the row entirely and a rate entered later repriced
    // nothing. (The SQLite variant has no drift clause at all — only this activity gate plus
    // the ModelCosts EXISTS — so the eligibility disjunct is the whole fix here.)
    const db = makeDb();
    insertPricing(db, { model: 'gemini-3.1-flash-image--deployed', inputCost: 0.0005, outputCost: 0.003, imageOutputCost: 0.06 });
    insertUsageRow(db, {
      id: 'row-image-only',
      model: 'gemini-3.1-flash-image--deployed',
      inputTokens: 1,
      outputTokens: 1290,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      imageOutputTokens: 1290
    });

    const result = runRecalc(db);
    expect(result.changes).toBe(1);

    const row = db.prepare(
      `SELECT outputCost, imageOutputCost FROM ${USAGE_TABLE} WHERE ID = ?`
    ).get('row-image-only');
    expect(row.imageOutputCost).toBeCloseTo((1290 / 1000) * 0.06, 6);
    expect(row.outputCost).toBeCloseTo(0, 6);
  });

  it('falls back to outputCost for image tokens when imageOutputCost is null', () => {
    const db = makeDb();
    insertPricing(db, { model: 'm-image-fallback', inputCost: 0.001, outputCost: 0.003, imageOutputCost: null });
    insertUsageRow(db, {
      id: 'row-image-fallback',
      model: 'm-image-fallback',
      inputTokens: 2,
      outputTokens: 1296,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      imageOutputTokens: 1290
    });

    const result = runRecalc(db);
    expect(result.changes).toBe(1);

    const row = db.prepare(
      `SELECT outputCost, imageOutputCost FROM ${USAGE_TABLE} WHERE ID = ?`
    ).get('row-image-fallback');
    expect(row.imageOutputCost).toBeCloseTo((1290 / 1000) * 0.003, 6);
    expect(row.outputCost).toBeCloseTo((6 / 1000) * 0.003, 6);
  });

  it('prices audio tokens at ModelCosts.audioInputCost/audioOutputCost and the text shares at the text rates', () => {
    const db = makeDb();
    insertPricing(db, { model: 'gpt-realtime--deployed', inputCost: 0.00251, outputCost: 0.00981, cacheReadInputCost: null, cacheCreationInputCost: null, audioInputCost: 0.01954, audioOutputCost: 0.03901 });
    insertUsageRow(db, {
      id: 'row-audio',
      model: 'gpt-realtime--deployed',
      inputTokens: 95,
      outputTokens: 30,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 0,
      audioInputTokens: 55,
      audioOutputTokens: 20
    });

    const result = runRecalc(db);
    expect(result.changes).toBe(1);

    const row = db.prepare(
      `SELECT inputCost, audioInputCost, outputCost, audioOutputCost, totalCost FROM ${USAGE_TABLE} WHERE ID = ?`
    ).get('row-audio');
    // 95 inputTokens + 55 audioInputTokens seeded above 95 already inclusive of the audio share —
    // clamp keeps audio at 55 (<= inputTokens), text share = 95 - 55 = 40.
    expect(row.inputCost).toBeCloseTo((40 / 1000) * 0.00251, 6);
    expect(row.audioInputCost).toBeCloseTo((55 / 1000) * 0.01954, 6);
    expect(row.outputCost).toBeCloseTo((10 / 1000) * 0.00981, 6);
    expect(row.audioOutputCost).toBeCloseTo((20 / 1000) * 0.03901, 6);
    expect(row.totalCost).toBeCloseTo(row.inputCost + row.audioInputCost + row.outputCost + row.audioOutputCost + (5 / 1000) * 0.00251, 5);
  });

  it('falls back to the text rates for audio tokens when the audio rates are null', () => {
    const db = makeDb();
    insertPricing(db, { model: 'm', inputCost: 0.002, outputCost: 0.003, audioInputCost: null, audioOutputCost: null });
    insertUsageRow(db, {
      id: 'row-audio-fallback',
      model: 'm',
      inputTokens: 100,
      outputTokens: 30,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      audioInputTokens: 55,
      audioOutputTokens: 20
    });

    const result = runRecalc(db);
    expect(result.changes).toBe(1);

    const row = db.prepare(
      `SELECT inputCost, audioInputCost, outputCost, audioOutputCost FROM ${USAGE_TABLE} WHERE ID = ?`
    ).get('row-audio-fallback');
    expect(row.inputCost + row.audioInputCost).toBeCloseTo((100 / 1000) * 0.002, 6);
    expect(row.outputCost + row.audioOutputCost).toBeCloseTo((30 / 1000) * 0.003, 6);
  });

  it('treats null audio columns on pre-migration rows as zero', () => {
    const db = makeDb();
    insertPricing(db, { model: 'm', inputCost: 0.002, outputCost: 0.003 });
    insertUsageRow(db, {
      id: 'row-pre-migration',
      model: 'm',
      inputTokens: 100,
      outputTokens: 30,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0
    });
    db.prepare(`UPDATE ${USAGE_TABLE} SET audioInputTokens = NULL, audioOutputTokens = NULL WHERE ID = ?`).run('row-pre-migration');

    const result = runRecalc(db);
    expect(result.changes).toBe(1);

    const row = db.prepare(
      `SELECT inputCost, audioInputCost, outputCost, audioOutputCost FROM ${USAGE_TABLE} WHERE ID = ?`
    ).get('row-pre-migration');
    expect(row.inputCost).toBeCloseTo((100 / 1000) * 0.002, 6);
    expect(row.audioInputCost).toBe(0);
    expect(row.outputCost).toBeCloseTo((30 / 1000) * 0.003, 6);
    expect(row.audioOutputCost).toBe(0);
  });
});
