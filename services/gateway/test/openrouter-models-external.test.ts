/**
 * The OpenRouter facade's model lists (/models, /models/:author/:slug/endpoints) and Connection
 * models (spec 2026-10-23 §4.3): an external model is listed only for a caller whose catalog
 * grants it, as on /v1/models. SAP entries are listed exactly as before.
 */
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@libs/logger', () => ({ ...(jest.requireActual('@libs/logger') as object), getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));
jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModels: async () => ({ object: 'list', data: [
      { id: 'anthropic--claude-4.5-sonnet', object: 'model', owned_by: 'anthropic', created: 0 },
      { id: 'gpt-4o-mini--oa', object: 'model', owned_by: 'openai', accessType: 'external', family: 'openai', created: 0 },
    ] }),
  },
  getModels: jest.fn(), getModelById: jest.fn(), getModelDetails: jest.fn(), clearModelsCache: jest.fn(),
}));
jest.mock('../src/connections/connectionRegistry', () => ({ connectionRegistry: { isExternalModelId: (id: string) => id === 'gpt-4o-mini--oa' } }));

import { listModels, getModelEndpoints } from '../src/controllers/openRouterController';

const ALL = { catalogId: 'def', catalogName: 'Default', mode: 'all' };
const LIST = { catalogId: 'ovf', catalogName: 'Overflow', mode: 'list', include: ['gpt-4o-mini--oa', 'anthropic--claude-4.5-sonnet'] };
const req = (entitlement: unknown, params: Record<string, string> = {}) => ({ headers: {}, query: {}, params, apiKeyInfo: { entitlement } }) as any;
const ids = (body: any) => JSON.stringify(body);

async function list(entitlement: unknown): Promise<string> {
  let body: any;
  const next = jest.fn();
  await listModels(req(entitlement), { json: (b: any) => { body = b; } } as any, next);
  expect(next).not.toHaveBeenCalled();
  return ids(body);
}

describe('OpenRouter model lists and connection models', () => {
  it('a default-catalog key does not see the connection model, and still sees the SAP one', async () => {
    const body = await list(ALL);
    expect(body).not.toContain('gpt-4o-mini--oa');
    expect(body).toContain('claude-4.5-sonnet');
  });

  it('a key whose catalog lists it sees it', async () => {
    expect(await list(LIST)).toContain('gpt-4o-mini--oa');
  });

  it('the endpoints of the connection model are 404 for a default-catalog key and found for a listing one', async () => {
    const run = async (entitlement: unknown) => {
      const next = jest.fn();
      const json = jest.fn();
      await getModelEndpoints(req(entitlement, { author: 'openai', slug: 'gpt-4o-mini--oa' }), { json } as any, next);
      return { next, json };
    };
    const hidden = await run(ALL);
    expect(hidden.json).not.toHaveBeenCalled();
    expect((hidden.next.mock.calls[0][0] as any).status).toBe(404);
    const shown = await run(LIST);
    expect(shown.next).not.toHaveBeenCalled();
    expect(shown.json).toHaveBeenCalled();
  });

  it('no block (admin, standalone) sees it', async () => {
    expect(await list(undefined)).toContain('gpt-4o-mini--oa');
  });
});
