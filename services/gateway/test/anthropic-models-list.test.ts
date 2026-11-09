/**
 * GET /anthropic/v1/models and /anthropic/v1/models/:model_id in Anthropic's format. n8n's Anthropic
 * credential test and its model dropdown call the list (they got 404), and so does the Anthropic
 * SDK's `models.list()`. Only Claude models are listed — the ones an Anthropic client is built for —
 * and the caller's entitlement filters them as on /openai/v1/models.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));
const getModels = jest.fn<any>();
jest.mock('../src/services/modelService', () => ({
  getModels: (...a: any[]) => getModels(...a),
  getModelById: jest.fn(),
  clearModelsCache: jest.fn()
}));

import * as controller from '../src/controllers/modelController';

const LIST = { object: 'list', data: [
  { id: 'gpt-5-mini', object: 'model', created: 1760000000, owned_by: 'openai' },
  { id: 'anthropic--claude-4.5-haiku', object: 'model', created: 1760000000, owned_by: 'anthropic' },
  { id: 'anthropic--claude-4.5-sonnet--deployed', object: 'model', created: 1760000100, owned_by: 'anthropic' },
] };
function res() {
  const r: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  return r;
}

describe('GET /anthropic/v1/models', () => {
  beforeEach(() => { getModels.mockResolvedValue(LIST); });

  it('lists the Claude models in Anthropic\'s format', async () => {
    const r = res();
    await controller.getAnthropicModels({ query: {} } as any, r, jest.fn());
    expect(r.json).toHaveBeenCalledWith({
      data: [
        { type: 'model', id: 'anthropic--claude-4.5-haiku', display_name: 'anthropic--claude-4.5-haiku', created_at: '2025-10-09T08:53:20.000Z' },
        { type: 'model', id: 'anthropic--claude-4.5-sonnet--deployed', display_name: 'anthropic--claude-4.5-sonnet--deployed', created_at: '2025-10-09T08:55:00.000Z' },
      ],
      has_more: false,
      first_id: 'anthropic--claude-4.5-haiku',
      last_id: 'anthropic--claude-4.5-sonnet--deployed',
    });
  });

  it('applies the caller\'s entitlement', async () => {
    const r = res();
    const req = { query: {}, unifiedAuth: { data: { entitlement: { catalogId: 'c', catalogName: 'T', mode: 'list', include: ['anthropic--claude-4.5-haiku'] } } } };
    await controller.getAnthropicModels(req as any, r, jest.fn());
    expect(r.json.mock.calls[0][0].data.map((m: any) => m.id)).toEqual(['anthropic--claude-4.5-haiku']);
  });

  it('an empty list has null first and last ids', async () => {
    getModels.mockResolvedValue({ object: 'list', data: [] });
    const r = res();
    await controller.getAnthropicModels({ query: {} } as any, r, jest.fn());
    expect(r.json).toHaveBeenCalledWith({ data: [], has_more: false, first_id: null, last_id: null });
  });
});

describe('GET /anthropic/v1/models/:model_id', () => {
  beforeEach(() => { getModels.mockResolvedValue(LIST); });

  it('returns one Claude model', async () => {
    const r = res();
    await controller.getAnthropicModelById({ params: { model_id: 'anthropic--claude-4.5-haiku' }, query: {} } as any, r, jest.fn());
    expect(r.json).toHaveBeenCalledWith({ type: 'model', id: 'anthropic--claude-4.5-haiku', display_name: 'anthropic--claude-4.5-haiku', created_at: '2025-10-09T08:53:20.000Z' });
  });

  it('a model it does not list answers 404 in Anthropic\'s error format', async () => {
    const r = res();
    await controller.getAnthropicModelById({ params: { model_id: 'gpt-5-mini' }, query: {} } as any, r, jest.fn());
    expect(r.status).toHaveBeenCalledWith(404);
    expect(r.json).toHaveBeenCalledWith({ type: 'error', error: { type: 'not_found_error', message: 'model: gpt-5-mini' } });
  });
});
