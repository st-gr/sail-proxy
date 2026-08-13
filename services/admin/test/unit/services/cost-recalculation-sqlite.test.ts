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
      inputCost REAL,
      outputCost REAL,
      cacheReadInputCost REAL,
      cacheCreationInputCost REAL,
      totalCost REAL
    );
    CREATE TABLE ${MODEL_COSTS_TABLE} (
      model TEXT,
      dateFrom TEXT,
      dateTo TEXT,
      inputCost REAL,
      outputCost REAL,
      cacheReadInputCost REAL,
      cacheCreationInputCost REAL
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

function insertPricing(db: any) {
  db.prepare(
    `INSERT INTO ${MODEL_COSTS_TABLE}
      (model, dateFrom, dateTo, inputCost, outputCost, cacheReadInputCost, cacheCreationInputCost)
     VALUES (@model, @dateFrom, @dateTo, @inputCost, @outputCost, @cacheReadInputCost, @cacheCreationInputCost)`
  ).run(PRICING);
}

function insertUsageRow(db: any, row: {
  id: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}) {
  db.prepare(
    `INSERT INTO ${USAGE_TABLE}
      (ID, model, validFrom, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens,
       inputCost, outputCost, cacheReadInputCost, cacheCreationInputCost, totalCost)
     VALUES (@id, @model, @validFrom, @inputTokens, @outputTokens, @cacheReadInputTokens, @cacheCreationInputTokens,
       @inputCost, @outputCost, @cacheReadInputCost, @cacheCreationInputCost, @totalCost)`
  ).run({
    id: row.id,
    model: PRICING.model,
    validFrom: new Date().toISOString(),
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadInputTokens: row.cacheReadInputTokens,
    cacheCreationInputTokens: row.cacheCreationInputTokens,
    // Deliberately stale/wrong cost columns from a prior (bad) pricing run —
    // recalculation must overwrite all of these, not just input/output.
    inputCost: 999,
    outputCost: 999,
    cacheReadInputCost: 999,
    cacheCreationInputCost: 999,
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
});
