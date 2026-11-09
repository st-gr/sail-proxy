/**
 * Usage from a Connection model (spec 2026-10-23 §6.1, "until C lands"): the gateway marks the
 * event origin external. The admin records it with its connection and upstream model and leaves
 * every cost column null: the existing pricing would otherwise read the connection's list-price
 * row as an SAP GenAI rate and write it into the SAP-labelled columns. The nightly recalculation
 * leaves such rows alone for the same reason. Tokens still count (token quotas include them).
 * Real in-memory SQLite, like usage-event-processor-on-behalf-of.test.ts.
 */
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

const cds = require('@sap/cds');

import UsageEventProcessor, { UsageEvent } from '../../src/services/usageEventProcessor';
import * as counters from '../../src/services/usageCounters';
import { BUCKETS } from '../../src/services/usageCounters';
import * as quota from '../../src/services/userQuotaService';
import { modelCostService } from '../../src/services/modelCostService';
import * as sapNative from '../../src/services/sapCapacityService';
import { costRecalculationService } from '../../src/services/costRecalculationService';

const KEYS = 'sap.llm.gateway.admin.ApiKeys';
const KEY_USAGE = 'sap.llm.gateway.admin.ApiKeyUsage';
const AWS_CREDS = 'sap.llm.gateway.admin.AwsCredentials';
const AWS_USAGE = 'sap.llm.gateway.admin.AwsCredentialUsage';
const COSTS = 'sap.llm.gateway.admin.ModelCosts';
const T = Math.floor(Date.now() / 1000);
const COST_COLUMNS = ['inputCost', 'outputCost', 'cacheCreationInputCost', 'cacheReadInputCost', 'totalCost', 'genAiTokens', 'capacityUnits', 'sapCost', 'sapCostCurrency'];

describe('UsageEventProcessor: external (connection) usage is recorded unpriced', () => {
  let db: any;
  let publishSpy: jest.SpyInstance;
  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } };
    db = await cds.connect.to('db');
    await cds.deploy(join(__dirname, '../../src/db/schema')).to(db);
    jest.spyOn(modelCostService as any, 'refreshPricingData').mockRejectedValue(new Error('no gateway in tests'));
  });
  beforeEach(async () => {
    const { DELETE, INSERT } = cds.ql;
    for (const t of [BUCKETS, counters.TEAM_BUCKETS, KEY_USAGE, KEYS, COSTS, AWS_USAGE, 'sap.llm.gateway.admin.Users']) await db.run(DELETE.from(t));
    await db.run(INSERT.into(KEYS).entries([{ ID: 'k1', key: 'sk-k1', name: 'overflow key', email: 'owner@test.com', isActive: true, usageCount: 0 }]));
    // The connection model's list price (sub-project A): the row the SAP pricing must not read.
    await db.run(INSERT.into(COSTS).entries([
      { model: 'gpt-4o-mini--oa', dateFrom: '2026-01-01T00:00:00.000Z', dateTo: '9999-12-31T00:00:00.000Z', inputCost: 0.15, outputCost: 0.6, pricingKind: 'list_price', currency: 'USD' },
      { model: 'gpt-4o', dateFrom: '2026-01-01T00:00:00.000Z', dateTo: '9999-12-31T00:00:00.000Z', inputCost: 2.5, outputCost: 10, pricingKind: 'sap_genai' },
    ]));
    publishSpy = jest.spyOn(quota, 'publishMany').mockResolvedValue(undefined as any);
  });
  afterEach(() => { publishSpy.mockRestore(); jest.restoreAllMocks(); jest.spyOn(modelCostService as any, 'refreshPricingData').mockRejectedValue(new Error('no gateway in tests')); });

  const persist = (events: UsageEvent[]) => (new UsageEventProcessor({ enableCostCalculation: true }) as any).persistUsageEvents(events);
  const external = (o: Partial<UsageEvent> = {}): UsageEvent => ({
    requestId: uuidv4(), timestamp: T, authType: 'api_key', credentialId: 'k1', provider: 'openai', model: 'gpt-4o-mini--oa',
    inputTokens: 60, outputTokens: 7, cacheReadInputTokens: 40, responseTime: 10, statusCode: 200, endpoint: '/openai/v1/chat/completions',
    connectionId: 'c-oa', upstreamModel: 'gpt-4o-mini', origin: 'external', ...o,
  } as UsageEvent);

  it('an external event becomes a row with origin, connection, upstream model and null costs', async () => {
    const calculateCosts = jest.spyOn(modelCostService, 'calculateCosts');
    const computeSapNative = jest.spyOn(sapNative, 'computeSapNative');
    await persist([external()]);
    const [row] = await db.run(cds.ql.SELECT.from(KEY_USAGE));
    expect(row).toMatchObject({ origin: 'external', connection: 'oa', upstreamModel: 'gpt-4o-mini', provider: 'openai', model: 'gpt-4o-mini--oa', inputTokens: 60, outputTokens: 7, cacheReadInputTokens: 40 });
    for (const c of COST_COLUMNS) expect([c, row[c]]).toEqual([c, null]);
    expect(calculateCosts).not.toHaveBeenCalled();
    expect(computeSapNative).not.toHaveBeenCalled();
  });

  it('an SAP event is unchanged: priced, origin sap', async () => {
    await persist([external({ model: 'gpt-4o', provider: 'unknown', connectionId: undefined, upstreamModel: undefined, origin: undefined })]);
    const [row] = await db.run(cds.ql.SELECT.from(KEY_USAGE));
    expect(row.origin).toBe('sap');
    expect(row.connection).toBeNull();
    expect(Number(row.totalCost)).toBeGreaterThan(0);
  });

  it('an external event under an AWS credential is recorded unpriced too', async () => {
    await db.run(cds.ql.INSERT.into(AWS_CREDS).entries([{ ID: 'aws1', name: 'aws', email: 'aws@test.com', accessKeyId: 'AKIAEXAMPLE', isActive: true }])).catch(() => undefined);
    await persist([external({ authType: 'aws_credential', credentialId: 'aws1' })]);
    const rows = await db.run(cds.ql.SELECT.from(AWS_USAGE));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ origin: 'external', connection: 'oa', upstreamModel: 'gpt-4o-mini' });
    expect(rows[0].totalCost).toBeNull();
  });

  it('cost recalculation leaves external rows alone', async () => {
    await persist([external(), external({ model: 'gpt-4o', provider: 'unknown', connectionId: undefined, upstreamModel: undefined, origin: undefined })]);
    // Blank the SAP row's cost so the run has something to re-derive: proves it ran.
    await db.run(cds.ql.UPDATE(KEY_USAGE).set({ totalCost: null, inputCost: null }).where({ model: 'gpt-4o' }));
    await costRecalculationService.runRecalculation();
    const rows = await db.run(cds.ql.SELECT.from(KEY_USAGE));
    const ext = rows.find((r: any) => r.model === 'gpt-4o-mini--oa');
    const sap = rows.find((r: any) => r.model === 'gpt-4o');
    expect(Number(sap.totalCost)).toBeGreaterThan(0);
    for (const c of COST_COLUMNS) expect([c, ext[c]]).toEqual([c, null]);
  });

  it('the daily bucket counts the external tokens and no cost', async () => {
    await persist([external()]);
    const [bucket] = await db.run(cds.ql.SELECT.from(BUCKETS));
    expect(Number(bucket.requests)).toBe(1);
    expect(Number(bucket.sapCost)).toBe(0);
  });

  it('an external row carries listCost in the price currency and keeps every SAP column null', async () => {
    await db.run(cds.ql.UPDATE(COSTS).set({ currency: 'EUR' }).where({ model: 'gpt-4o-mini--oa' }));
    await persist([external({ inputTokens: 1000, outputTokens: 1000, cacheReadInputTokens: 0 })]);
    const [row] = await db.run(cds.ql.SELECT.from(KEY_USAGE));
    expect(Number(row.listCost)).toBeCloseTo(0.75, 6);
    expect(row.listCostCurrency).toBe('EUR');
    expect(Boolean(row.pricingMissing)).toBe(false);
    for (const c of ['sapCost', 'totalCost', 'capacityUnits']) expect([c, row[c]]).toEqual([c, null]);
  });

  it('an external row under an AWS credential carries listCost too', async () => {
    await db.run(cds.ql.INSERT.into(AWS_CREDS).entries([{ ID: 'aws1', name: 'aws', email: 'aws@test.com', accessKeyId: 'AKIAEXAMPLE', isActive: true }])).catch(() => undefined);
    await persist([external({ authType: 'aws_credential', credentialId: 'aws1', inputTokens: 1000, outputTokens: 1000, cacheReadInputTokens: 0 })]);
    const [row] = await db.run(cds.ql.SELECT.from(AWS_USAGE));
    expect(Number(row.listCost)).toBeCloseTo(0.75, 6);
    expect(row.listCostCurrency).toBe('USD');
    expect(Boolean(row.pricingMissing)).toBe(false);
  });

  it('an external row with no price in force is recorded with pricingMissing', async () => {
    await persist([external({ model: 'unpriced--oa' })]);
    const [row] = await db.run(cds.ql.SELECT.from(KEY_USAGE));
    expect(row.listCost).toBeNull();
    expect(row.listCostCurrency).toBeNull();
    expect(Boolean(row.pricingMissing)).toBe(true);
    expect(row).toMatchObject({ inputTokens: 60, outputTokens: 7, cacheReadInputTokens: 40 });
  });

  it('a SAP row writes no list-cost columns', async () => {
    await persist([external({ model: 'gpt-4o', provider: 'unknown', connectionId: undefined, upstreamModel: undefined, origin: undefined })]);
    const [row] = await db.run(cds.ql.SELECT.from(KEY_USAGE));
    for (const c of ['listCost', 'listCostCurrency', 'pricingMissing']) expect([c, row[c]]).toEqual([c, null]);
  });

  describe('without SAP model data', () => {
    const sap = () => external({ model: 'gpt-4o', provider: 'unknown', connectionId: undefined, upstreamModel: undefined, origin: undefined });
    const hasData = (v: boolean) => jest.spyOn(modelCostService, 'hasValidModelData').mockReturnValue(v);

    it('without SAP model data the batch persists external events and keeps SAP events queued', async () => {
      const flag = hasData(false);
      const p = new UsageEventProcessor({ enableCostCalculation: true }) as any;
      const s = sap();
      p.batchBuffer = [s, external()];
      await p.processBatch();
      const rows = await db.run(cds.ql.SELECT.from(KEY_USAGE));
      expect(rows).toHaveLength(1);
      expect(rows[0].origin).toBe('external');
      expect(p.batchBuffer).toEqual([s]);
      flag.mockReturnValue(true);
      await p.processBatch();
      expect(await db.run(cds.ql.SELECT.from(KEY_USAGE))).toHaveLength(2);
      expect(p.batchBuffer).toHaveLength(0);
    });

    it('processMemoryQueue without SAP model data persists external events and does not drop SAP ones', async () => {
      const flag = hasData(false);
      const p = new UsageEventProcessor({ enableCostCalculation: true }) as any;
      const s = sap();
      await p.processMemoryQueue([s, external()]);
      const rows = await db.run(cds.ql.SELECT.from(KEY_USAGE));
      expect(rows).toHaveLength(1);
      expect(rows[0].origin).toBe('external');
      expect(p.batchBuffer).toEqual([s]);
      flag.mockReturnValue(true);
      await p.processBatch();
      expect(await db.run(cds.ql.SELECT.from(KEY_USAGE))).toHaveLength(2);
    });
  });
  const bucketsOf = async (table: string, order: string[]) => (await db.run(cds.ql.SELECT.from(table).orderBy(...order)))
    .map(({ updatedAt, ...r }: any) => ({ ...r, day: counters.dayOf(r.day), requests: Number(r.requests), tokens: Number(r.tokens), sapCost: Number(r.sapCost), externalCost: Number(r.externalCost) }));

  it('rebuild from the rows equals the incremental buckets, external rows included', async () => {
    await db.run(cds.ql.INSERT.into('sap.llm.gateway.admin.Teams').entries([{ ID: 't-ext', name: 'Ext' }]));
    const at = new Date(T * 1000);
    await persist([
      external({ inputTokens: 1000, outputTokens: 1000, cacheReadInputTokens: 0, teamId: 't-ext' }),
      external({ inputTokens: 2000, outputTokens: 0, cacheReadInputTokens: 0, teamId: 't-ext' }),
      external({ model: 'gpt-4o', provider: 'unknown', connectionId: undefined, upstreamModel: undefined, origin: undefined, teamId: 't-ext' })
    ]);
    const userBefore = await bucketsOf(BUCKETS, ['email', 'day', 'currency']);
    const teamBefore = await bucketsOf(counters.TEAM_BUCKETS, ['teamId', 'day', 'currency']);
    expect(userBefore.reduce((n: number, b: any) => n + b.externalCost, 0)).toBeCloseTo(0.75 + 0.3, 6);
    expect(teamBefore.reduce((n: number, b: any) => n + b.externalCost, 0)).toBeCloseTo(0.75 + 0.3, 6);
    await counters.rebuild(db, { now: at });
    expect(await bucketsOf(BUCKETS, ['email', 'day', 'currency'])).toEqual(userBefore);
    expect(await bucketsOf(counters.TEAM_BUCKETS, ['teamId', 'day', 'currency'])).toEqual(teamBefore);
  });
});
