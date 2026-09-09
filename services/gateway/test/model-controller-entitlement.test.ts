/**
 * /v1/models and /v1/models/:id are filtered by the caller's entitlement block; a model outside
 * it 404s exactly as if it did not exist. No block (standalone) = today's behaviour.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));
const getModels = jest.fn<any>();
const getModelById = jest.fn<any>();
jest.mock('../src/services/modelService', () => ({
  getModels: (...a: any[]) => getModels(...a),
  getModelById: (...a: any[]) => getModelById(...a),
  clearModelsCache: jest.fn()
}));

import * as controller from '../src/controllers/modelController';

const LIST = { object: 'list', data: [{ id: 'a', object: 'model' }, { id: 'b', object: 'model' }, { id: 'b--deployed', object: 'model' }] };

function res() {
  const r: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  return r;
}

describe('modelController with entitlement', () => {
  beforeEach(() => { getModels.mockResolvedValue(LIST); getModelById.mockImplementation(async (id: string) => LIST.data.find(m => m.id === id) || null); });

  it('no block: full list', async () => {
    const r = res();
    await controller.getModels({ query: {} } as any, r, jest.fn());
    expect(r.json).toHaveBeenCalledWith(LIST);
  });

  it('list block: only included ids, object stays a list', async () => {
    const r = res();
    await controller.getModels({ query: {}, unifiedAuth: { data: { entitlement: { catalogId: 'c', catalogName: 'T', mode: 'list', include: ['b'] } } } } as any, r, jest.fn());
    expect(r.json).toHaveBeenCalledWith({ object: 'list', data: [{ id: 'b', object: 'model' }] });
  });

  it('exclusion block: by id returns 404 for an excluded model and the model otherwise', async () => {
    const block = { catalogId: 'd', catalogName: 'Default', mode: 'all', exclude: ['a'] };
    const r1 = res();
    await controller.getModelById({ params: { model_id: 'a' }, query: {}, apiKeyInfo: { entitlement: block } } as any, r1, jest.fn());
    expect(r1.status).toHaveBeenCalledWith(404);
    expect(r1.json).toHaveBeenCalledWith({ error: { message: 'Model a not found', type: 'model_not_found_error', param: 'model' } });
    const r2 = res();
    await controller.getModelById({ params: { model_id: 'b' }, query: {}, apiKeyInfo: { entitlement: block } } as any, r2, jest.fn());
    expect(r2.json).toHaveBeenCalledWith({ id: 'b', object: 'model' });
  });
});
