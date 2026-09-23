/**
 * upsertLibrarySnapshot writes one LibraryModels row per /v1/models entry (UPSERT) and marks
 * rows not in the payload absent — never deletes. Both entry points (Valkey event, timer pull)
 * must call it BEFORE updatePricingDatabase so a pricing failure cannot hide the snapshot.
 */
export {};

const mockRun = jest.fn();
const upsertCalls: any[] = [];
const updateCalls: any[] = [];
jest.mock('@sap/cds', () => {
  const chain = (rec: any[]) => {
    const c: any = {}; ['set', 'where', 'entries', 'columns', 'from', 'into'].forEach(k => { c[k] = jest.fn((...a: any[]) => { rec.push([k, ...a]); return c; }); }); return c;
  };
  return {
    connect: { to: jest.fn(() => Promise.resolve({ run: mockRun })) },
    ql: {
      SELECT: { from: jest.fn(() => chain([])) },
      INSERT: { into: jest.fn(() => chain([])) },
      UPSERT: { into: jest.fn((t: string) => { const c = chain(upsertCalls); upsertCalls.push(['into', t]); return c; }) },
      UPDATE: jest.fn((t: string) => { const c = chain(updateCalls); updateCalls.push(['table', t]); return c; })
    }
  };
});
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() })
}));
jest.mock('axios');

import axios from 'axios';
import sample from '../../fixtures/v1-models-sample.json';
import { modelCostService } from '../../../src/services/modelCostService';

const NOW = new Date('2026-09-05T12:00:00Z');

describe('upsertLibrarySnapshot', () => {
  beforeEach(() => { mockRun.mockReset(); upsertCalls.length = 0; updateCalls.length = 0; });

  it('upserts every model and marks the rest absent', async () => {
    mockRun.mockResolvedValue(1);
    const result = await modelCostService.upsertLibrarySnapshot((sample as any).data, NOW);
    expect(result.upserted).toBe((sample as any).data.length);
    expect(result.deployments).toBe(2);
    const entries = upsertCalls.filter(c => c[0] === 'entries').flatMap(c => c[1]);
    expect(entries.map((e: any) => e.modelId).sort()).toEqual((sample as any).data.map((m: any) => m.id).sort());
    expect(entries.every((e: any) => e.lastSeenAt === NOW && e.absent === false)).toBe(true);
    // absence pass: UPDATE LibraryModels SET absent=true WHERE lastSeenAt < NOW (or IS NULL)
    const absentUpdate = updateCalls.find(c => c[0] === 'table' && c[1] === 'sap.llm.gateway.admin.LibraryModels');
    expect(absentUpdate).toBeDefined();
    const setCall = updateCalls.find(c => c[0] === 'set');
    expect(setCall[1]).toEqual({ absent: true });
  });

  it('does nothing on an empty payload (a failed pull must not mark everything absent)', async () => {
    const result = await modelCostService.upsertLibrarySnapshot([], NOW);
    expect(result).toEqual({ upserted: 0, absent: 0, deployments: 0 });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('does nothing on an all-malformed non-empty payload (no usable id in any entry)', async () => {
    const result = await modelCostService.upsertLibrarySnapshot([{ foo: 1 }, { id: 42 }] as any, NOW);
    expect(result).toEqual({ upserted: 0, absent: 0, deployments: 0 });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('marks rows absent whose lastSeenAt predates this run OR was never stamped (IS NULL)', async () => {
    mockRun.mockResolvedValue(1);
    await modelCostService.upsertLibrarySnapshot((sample as any).data, NOW);
    const whereCall = updateCalls.find(c => c[0] === 'where');
    expect(whereCall[1]).toEqual([
      { ref: ['lastSeenAt'] }, '<', { val: NOW }, 'or', { ref: ['lastSeenAt'] }, 'is', 'null'
    ]);
  });
});

describe('entry points call upsertLibrarySnapshot before updatePricingDatabase', () => {
  const order: string[] = [];
  beforeEach(() => {
    order.length = 0;
    jest.spyOn(modelCostService, 'upsertLibrarySnapshot').mockImplementation(async () => { order.push('snapshot'); return { upserted: 1, absent: 0, deployments: 0 }; });
    jest.spyOn(modelCostService as any, 'updatePricingDatabase').mockImplementation(async () => { order.push('pricing'); });
  });
  afterEach(() => jest.restoreAllMocks());

  it('processModelListFromEvent', async () => {
    (modelCostService as any).useValkeyEvents = true;
    await modelCostService.processModelListFromEvent({ models: (sample as any).data, source: 'test' });
    expect(order).toEqual(['snapshot', 'pricing']);
  });

  it('refreshFromGateway pulls /v1/models with the service key and returns counts', async () => {
    jest.spyOn(modelCostService as any, 'getServiceApiKey').mockResolvedValue('sk-test');
    (axios.get as jest.Mock).mockResolvedValue({ data: sample });
    const r = await modelCostService.refreshFromGateway();
    expect(order).toEqual(['snapshot', 'pricing']);
    // include=unroutable (M): the snapshot lists the models the gateway cannot route as well
    expect(axios.get).toHaveBeenCalledWith(expect.stringMatching(/\/v1\/models\?include=unroutable$/), expect.objectContaining({ headers: expect.objectContaining({ 'X-API-Key': 'sk-test' }) }));
    expect(r).toEqual({ models: (sample as any).data.length, deployments: 0, absent: 0 });
  });
});

// The snapshot is a display feature; pricing is what the usage processor bills from. A schema
// drift or an over-long column in LibraryModels must not stop ModelCosts being updated.
describe('a failing snapshot never takes pricing down', () => {
  const order: string[] = [];
  beforeEach(() => {
    order.length = 0;
    jest.spyOn(modelCostService, 'upsertLibrarySnapshot').mockImplementation(async () => { order.push('snapshot'); throw new Error('LibraryModels is gone'); });
    jest.spyOn(modelCostService as any, 'updatePricingDatabase').mockImplementation(async () => { order.push('pricing'); });
  });
  afterEach(() => jest.restoreAllMocks());

  it('processModelListFromEvent still prices', async () => {
    (modelCostService as any).useValkeyEvents = true;
    await modelCostService.processModelListFromEvent({ models: (sample as any).data, source: 'test' });
    expect(order).toEqual(['snapshot', 'pricing']);
  });

  it('refreshFromGateway still prices and reports zero snapshot counts', async () => {
    jest.spyOn(modelCostService as any, 'getServiceApiKey').mockResolvedValue('sk-test');
    (axios.get as jest.Mock).mockResolvedValue({ data: sample });
    const r = await modelCostService.refreshFromGateway();
    expect(order).toEqual(['snapshot', 'pricing']);
    expect(r).toEqual({ models: (sample as any).data.length, deployments: 0, absent: 0 });
  });

  it('refreshPricingData still prices', async () => {
    jest.spyOn(modelCostService as any, 'getServiceApiKey').mockResolvedValue('sk-test');
    (axios.get as jest.Mock).mockResolvedValue({ data: sample });
    (modelCostService as any).lastFetch = 0;
    await (modelCostService as any).refreshPricingData(true);   // force: skip the Valkey/cooldown guards
    expect(order).toEqual(['snapshot', 'pricing']);
  });
});

// Three entry points can snapshot at once - the boot timer, the Valkey model-list event and the
// refresh action. Each statement is its own transaction, and on PostgreSQL one run's UPSERT and
// another run's mark-absent sweep lock the same rows in different orders: one of them deadlocks
// ("deadlock detected" at container start). Runs are serialized per process, and each run writes
// its rows in modelId order so that separate replicas lock in the same order too.
describe('concurrent snapshots', () => {
  afterEach(() => jest.restoreAllMocks());

  it('runs one snapshot at a time, in call order, even when one fails', async () => {
    const events: string[] = [];
    let n = 0;
    jest.spyOn(modelCostService, 'upsertLibrarySnapshot').mockImplementation(async () => {
      const id = ++n;
      events.push(`start ${id}`);
      await new Promise((r) => setTimeout(r, 20));
      events.push(`end ${id}`);
      if (id === 1) throw new Error('first run fails');
      return { upserted: 1, absent: 0, deployments: 0 };
    });
    const trySnapshot = (modelCostService as any).trySnapshot.bind(modelCostService);
    const results = await Promise.all([trySnapshot([{ id: 'a' }]), trySnapshot([{ id: 'b' }]), trySnapshot([{ id: 'c' }])]);
    expect(events).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
    expect(results[0]).toEqual({ upserted: 0, absent: 0, deployments: 0 });   // the failure stays contained
    expect(results[2]).toEqual({ upserted: 1, absent: 0, deployments: 0 });
  });

  it('writes rows in modelId order', async () => {
    mockRun.mockReset(); upsertCalls.length = 0; updateCalls.length = 0;
    mockRun.mockResolvedValue(1);
    const shuffled = [...(sample as any).data].reverse();
    await modelCostService.upsertLibrarySnapshot(shuffled, NOW);
    const ids = upsertCalls.filter(c => c[0] === 'entries').flatMap(c => c[1]).map((e: any) => e.modelId);
    expect(ids).toEqual([...ids].sort());
  });
});
