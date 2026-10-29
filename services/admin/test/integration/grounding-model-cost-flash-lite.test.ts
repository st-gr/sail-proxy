/**
 * The cockpit's vision and context cost estimates (GET /api/grounding/model-cost) price
 * gemini-3.5-flash-lite from SAP's catalogue row in ModelCosts (source 'sap', SAP Cost Factors per 1K
 * tokens), under every id it is asked for: the bare id, its --deployed twin, and the exact id the
 * gateway records for context and vision usage (the configured model string, contextWriter.ts and
 * visionTranscriber.ts defaults). Real in-memory SQLite and the real computeSapNative: no mock between
 * the route and the price row.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import express from 'express';
import request from 'supertest';

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));
jest.mock('../../src/services/groundingGatewayClient', () => ({
  __esModule: true, callGateway: jest.fn(), streamToGateway: jest.fn(), streamFromGateway: jest.fn()
}));

import { seedSapCapacityUnitPrice } from '../../src/db/data/sap-capacity-unit-price-seed';

const cds = require('@sap/cds');
const router = require('../../src/srv/grounding-rest-api');

const MODEL_COSTS = 'sap.llm.gateway.admin.ModelCosts';
const FLASH_LITE = 'gemini-3.5-flash-lite';
const USER = { id: 'user@example.test', email: 'user@example.test', roles: ['user'], attr: {} };

/** The default model id the gateway records for `file_search/context` and `file_search/vision` usage. */
function gatewayDefaultModel(file: string): string {
  const source = readFileSync(join(__dirname, '../../../gateway/src/fileSearch', file), 'utf8');
  const match = /^\s*model: '([^']+)',$/m.exec(source);
  if (!match) throw new Error(`no default model in ${file}`);
  return match[1];
}

function app(): express.Application {
  const a = express();
  a.use((req: any, _res, next) => { req.user = USER; next(); });
  a.use('/api/grounding', router);
  return a;
}

const cost = (model: string) =>
  request(app()).get(`/api/grounding/model-cost?model=${encodeURIComponent(model)}&input_tokens=1000000&output_tokens=1000000`);

describe('GET /model-cost prices gemini-3.5-flash-lite from SAP\'s catalogue (real sqlite)', () => {
  let db: any;

  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } };
    db = await cds.connect.to('db');
    await cds.deploy(join(__dirname, '../../src/db/schema')).to(db);
    await seedSapCapacityUnitPrice(db);
  });

  beforeEach(async () => { await db.run(cds.ql.DELETE.from(MODEL_COSTS)); });

  async function sapRow(model: string): Promise<void> {
    // As the dev admin database holds it (catalogue figures, dateFrom 2026-09-07).
    await db.run(cds.ql.INSERT.into(MODEL_COSTS).entries([{
      ID: uuidv4(), model, dateFrom: new Date('2026-09-07T00:00:00.000Z'), dateTo: new Date('9999-12-31T00:00:00.000Z'),
      inputCost: '0.00039', outputCost: '0.00278', source: 'sap'
    }]));
  }

  it('the gateway records context and vision usage under the bare id', () => {
    expect(gatewayDefaultModel('contextWriter.ts')).toBe(FLASH_LITE);
    expect(gatewayDefaultModel('visionTranscriber.ts')).toBe(FLASH_LITE);
  });

  it.each([FLASH_LITE, `${FLASH_LITE}--deployed`])('prices %s from the bare model\'s SAP row', async (model) => {
    await sapRow(FLASH_LITE);
    const r = await cost(model);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ priced: true, currency: 'USD' });
    expect(r.body.capacity_units).toBeGreaterThan(0);
    expect(r.body.cost).toBeGreaterThan(0);
  });

  it('prices the bare id from a row kept under the --deployed twin', async () => {
    await sapRow(`${FLASH_LITE}--deployed`);
    expect((await cost(FLASH_LITE)).body).toMatchObject({ priced: true });
  });

  it('without a row the estimate says unpriced (what the cockpit shows as unknown)', async () => {
    expect((await cost(FLASH_LITE)).body).toEqual({ priced: false, capacity_units: null, cost: null, currency: null });
  });
});
