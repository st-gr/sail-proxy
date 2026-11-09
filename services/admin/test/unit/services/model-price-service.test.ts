/**
 * Manual prices live in the temporal ModelCosts table as rows with source='manual'. setManualPrice
 * closes the current row and inserts the manual one; revertToSapPrice closes the manual row and
 * reinstates the snapshot's SAP price. capacityUnitsPerMillion is the Cost tab's headline number.
 * The captured SAP figure pins the unit: Claude 4.5 Haiku input 0.00079/1K with cuFactor 1.90385
 * shows as 1.50404 on SAP's page (2026-09-05), i.e. the displayed value is per 1M tokens.
 */
export {};

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() })
}));

import { setManualPrice, revertToSapPrice, capacityUnitsPerMillion, PRICE_SOURCE_MANUAL, PRICE_SOURCE_SAP } from '../../../src/services/modelPriceService';

const NOW = new Date('2026-09-05T12:00:00Z');
const OPEN = new Date('9999-12-31T00:00:00.000Z');

function fakeDb(selectResults: any[][]) {
  const runs: any[] = [];
  let i = 0;
  return {
    runs,
    run: jest.fn(async (q: any) => {
      runs.push(q);
      const kind = q?.SELECT ? 'select' : q?.INSERT ? 'insert' : q?.UPDATE ? 'update' : 'other';
      if (kind === 'select') return selectResults[i++] ?? [];
      return 1;
    })
  };
}

describe('capacityUnitsPerMillion', () => {
  it('reproduces SAP\'s displayed figure for the captured pair', () => {
    expect(capacityUnitsPerMillion('0.00079', 1.90385)).toBe('1.50404');
  });
  it('returns null for a missing cost', () => {
    expect(capacityUnitsPerMillion(null, 1.90385)).toBeNull();
  });
});

describe('setManualPrice', () => {
  it('closes the current row and inserts a manual row', async () => {
    const db = fakeDb([[{ ID: 'cur', model: 'm1', inputCost: '0.001', outputCost: '0.002', dateTo: OPEN, source: PRICE_SOURCE_SAP, provider: 'Anthropic', version: '1' }]]);
    const row = await setManualPrice(db as any, { modelId: 'm1', inputCost: '0.005', outputCost: '0.01', cacheReadInputCost: null, cacheCreationInputCost: null, actor: 'admin@test.com' }, NOW);
    const update = db.runs.find(q => q.UPDATE);
    expect(update.UPDATE.data).toEqual({ dateTo: NOW });
    const insert = db.runs.find(q => q.INSERT);
    const inserted = insert.INSERT.entries[0];
    expect(inserted).toEqual(expect.objectContaining({ model: 'm1', source: PRICE_SOURCE_MANUAL, inputCost: '0.005', outputCost: '0.01', dateFrom: NOW, dateTo: OPEN, provider: 'Anthropic', createdBy: 'admin@test.com' }));
    expect(row.source).toBe(PRICE_SOURCE_MANUAL);
  });

  it('rejects a negative or non-numeric price', async () => {
    const db = fakeDb([[]]);
    await expect(setManualPrice(db as any, { modelId: 'm1', inputCost: '-1', outputCost: '0', actor: 'a' }, NOW)).rejects.toThrow(/inputCost/);
    await expect(setManualPrice(db as any, { modelId: 'm1', inputCost: 'abc', outputCost: '0', actor: 'a' }, NOW)).rejects.toThrow(/inputCost/);
  });
});

describe('revertToSapPrice', () => {
  it('closes the manual row and inserts a sap row from the snapshot', async () => {
    const db = fakeDb([
      [{ ID: 'man', model: 'm1', source: PRICE_SOURCE_MANUAL, dateTo: OPEN, provider: 'Anthropic', version: '1' }],
      [{ modelId: 'm1', sapInputCost: '0.00079', sapOutputCost: '0.00367', sapCacheReadCost: '0.00008', sapCacheCreationCost: '0.00099', provider: 'Anthropic', latestVersion: '1', displayName: 'Claude 4.5 Haiku' }]
    ]);
    const row = await revertToSapPrice(db as any, 'm1', 'admin@test.com', NOW);
    expect(row).toEqual(expect.objectContaining({ source: PRICE_SOURCE_SAP, inputCost: '0.00079', outputCost: '0.00367', cacheReadInputCost: '0.00008' }));
  });

  it('is a no-op when the current row is already sap', async () => {
    const db = fakeDb([[{ ID: 'cur', model: 'm1', source: PRICE_SOURCE_SAP, dateTo: OPEN }]]);
    const row = await revertToSapPrice(db as any, 'm1', 'admin@test.com', NOW);
    expect(row.ID).toBe('cur');
    expect(db.runs.some(q => q.INSERT)).toBe(false);
  });

  it('throws when the snapshot has no SAP price to revert to', async () => {
    const db = fakeDb([[{ ID: 'man', model: 'm1', source: PRICE_SOURCE_MANUAL, dateTo: OPEN }], [{ modelId: 'm1', sapInputCost: null, sapOutputCost: null }]]);
    await expect(revertToSapPrice(db as any, 'm1', 'a', NOW)).rejects.toThrow(/no SAP price/);
  });

  it('rejects a half-populated SAP price instead of inventing a zero', async () => {
    const db = fakeDb([[{ ID: 'man', model: 'm1', source: PRICE_SOURCE_MANUAL, dateTo: OPEN }], [{ modelId: 'm1', sapInputCost: '0.001', sapOutputCost: null }]]);
    await expect(revertToSapPrice(db as any, 'm1', 'a', NOW)).rejects.toThrow(/no SAP price/);
    expect(db.runs.some(q => q.INSERT)).toBe(false);
  });
});
