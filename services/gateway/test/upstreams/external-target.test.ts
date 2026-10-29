/**
 * resolveExternalTarget (spec 2026-10-23 §5.1, §5.4): the one decision every inference route makes
 * about a model id. Not a connection model: carry on to SAP untouched. Otherwise refuse in the
 * route's own error shape (not entitled, wrong route, connection unavailable, unpriced), or hand
 * over the connection, its model and its adapter. Entitlement is re-checked here against the same
 * registry view the dispatch uses, because the controller's own check may have run before a
 * refresh published the model.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), trace: jest.fn() }) }));
jest.mock('../../src/services/securityEventEmitter', () => ({ __esModule: true, default: { emitModelNotEntitled: jest.fn(async () => undefined) } }));

import { connectionRegistry } from '../../src/connections/connectionRegistry';
import type { Connection } from '../../src/connections/types';
import { resolveExternalTarget, ErrorShape } from '../../src/upstreams/externalTarget';
import { enforceEntitlement } from '../../src/utils/modelEntitlement';
import type { ModelFamily } from '../../src/connections/types';

const conn = (over: Partial<Connection> = {}, modelOver: Record<string, unknown> = {}): Connection => ({
  id: 'c-oa', name: 'oa', providerType: 'openai', isActive: true,
  settings: { baseUrl: 'https://api.openai.com/v1' }, credentials: { secret: 'sk-secret-123' },
  models: [{ modelId: 'gpt-4o-mini--oa', upstreamModel: 'gpt-4o-mini', displayName: null, family: 'openai', capabilities: ['chat'], priced: true, ...modelOver } as any],
  ...over,
});

const LIST = { catalogId: 'c1', catalogName: 'Overflow', mode: 'list', include: ['gpt-4o-mini--oa', 'claude-x--an'] };
const ALL = { catalogId: 'd', catalogName: 'Default', mode: 'all' };

let lastReq: any;
function app(served: ModelFamily | null, shape: ErrorShape, entitlement: unknown = LIST, checkFirst = false) {
  const a = express();
  a.use(express.json());
  a.post('/', async (req: any, res) => {
    req.apiKeyInfo = { entitlement };
    lastReq = req;
    if (checkFirst && !enforceEntitlement(req, res, req.body.model)) return;
    const r = await resolveExternalTarget(req, res, req.body.model, served, shape);
    if (r.kind === 'handled') return;
    res.json(r.kind === 'sap' ? { kind: 'sap' } : { kind: 'external', connection: r.target.connection.name, upstream: r.target.model.upstreamModel });
  });
  return a;
}
const backend = (connections: Connection[]) => connectionRegistry.setBackend({ fetch: async () => connections });

beforeEach(() => { connectionRegistry.setShadowed([]); backend([conn()]); });

describe('resolveExternalTarget', () => {
  it('an id the registry does not know is sap, and nothing is sent', async () => {
    const r = await request(app('openai', 'openai')).post('/').send({ model: 'gpt-4o' });
    expect(r.body).toEqual({ kind: 'sap' });
    expect(lastReq.__externalUsage).toBeUndefined();
  });

  it('a served, entitled, priced model is external', async () => {
    const r = await request(app('openai', 'openai')).post('/').send({ model: 'gpt-4o-mini--oa' });
    expect(r.body).toEqual({ kind: 'external', connection: 'oa', upstream: 'gpt-4o-mini' });
  });

  it('re-check: a default-catalog caller is refused even when the model was published after the first check', async () => {
    // A fresh backend: nothing loaded yet, so the controller's own check sees no connection model and
    // the default catalog grants the id; the first load happens inside the resolver.
    backend([conn()]);
    const r = await request(app('openai', 'openai', ALL, true)).post('/').send({ model: 'gpt-4o-mini--oa' });
    expect(r.status).toBe(403);
    expect(r.body.error.type).toBe('model_not_entitled');
  });

  it('a refused entitlement answers in the route shape, with the security event', async () => {
    const gemini = await request(app(null, 'gemini', ALL)).post('/').send({ model: 'gpt-4o-mini--oa' });
    expect(gemini.status).toBe(403);
    expect(gemini.body.error).toMatchObject({ code: 403, status: 'PERMISSION_DENIED' });
    const openai = await request(app('openai', 'openai', ALL)).post('/').send({ model: 'gpt-4o-mini--oa' });
    expect(openai.body.error.type).toBe('model_not_entitled');
    const securityEventEmitter = (await import('../../src/services/securityEventEmitter')).default as any;
    expect(securityEventEmitter.emitModelNotEntitled).toHaveBeenCalled();
  });

  it('a model published a moment ago (marker received) is resolved on the very next request, never sent to SAP', async () => {
    let connections: Connection[] = [];
    // A real round trip to the admin takes time; a stub answering in the same tick would hide the race.
    connectionRegistry.setBackend({ fetch: async () => { await new Promise((r) => setTimeout(r, 30)); return connections; } });
    await connectionRegistry.ensureFresh();
    connections = [conn()];
    connectionRegistry.markStale();
    const r = await request(app('openai', 'openai')).post('/').send({ model: 'gpt-4o-mini--oa' });
    expect(r.body).toEqual({ kind: 'external', connection: 'oa', upstream: 'gpt-4o-mini' });
  });

  it('family mismatch is 400 model_route_mismatch in the route shape', async () => {
    const anthropic = await request(app('claude', 'anthropic')).post('/').send({ model: 'gpt-4o-mini--oa' });
    expect(anthropic.status).toBe(400);
    expect(anthropic.body.type).toBe('error');
    expect(anthropic.body.error.type).toBe('invalid_request_error');
    expect(anthropic.body.error.message).toContain('/openai/v1/chat/completions');

    const gemini = await request(app(null, 'gemini')).post('/').send({ model: 'gpt-4o-mini--oa' });
    expect(gemini.status).toBe(400);
    expect(gemini.body.error).toMatchObject({ code: 400, status: 'INVALID_ARGUMENT' });

    const openai = await request(app(null, 'openai')).post('/').send({ model: 'gpt-4o-mini--oa' });
    expect(openai.status).toBe(400);
    expect(openai.body.error).toMatchObject({ type: 'invalid_request_error', code: 'model_route_mismatch' });
  });

  it('a claude model on an openai route names the Anthropic route', async () => {
    backend([conn({ providerType: 'sap-ai-core', name: 'an' }, { modelId: 'claude-x--an', upstreamModel: 'claude-x', family: 'claude' })]);
    const r = await request(app('openai', 'openai')).post('/').send({ model: 'claude-x--an' });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('/anthropic/v1/messages');
  });

  it('inactive, credential-less, sap-ai-core-type are 503 connection_unavailable; unpriced is 409 model_unpriced', async () => {
    const cases: Array<[Connection, number, string]> = [
      [conn({ isActive: false }), 503, 'connection_unavailable'],
      [conn({ credentials: null }), 503, 'connection_unavailable'],
      [conn({}, { priced: false }), 409, 'model_unpriced'],
    ];
    for (const [c, status, code] of cases) {
      backend([c]);
      const r = await request(app('openai', 'openai')).post('/').send({ model: 'gpt-4o-mini--oa' });
      expect([r.status, r.body.error.code]).toEqual([status, code]);
    }
    backend([conn({ providerType: 'sap-ai-core', name: 'an' }, { modelId: 'claude-x--an', upstreamModel: 'claude-x', family: 'claude' })]);
    const b2 = await request(app('claude', 'anthropic')).post('/').send({ model: 'claude-x--an' });
    expect(b2.status).toBe(503);
    expect(b2.body.error.type).toBe('api_error');
    expect(b2.body.error.message).toContain('connection_unavailable');
  });

  it('external sets req.__externalUsage without any credential in it', async () => {
    await request(app('openai', 'openai')).post('/').send({ model: 'gpt-4o-mini--oa' });
    expect(lastReq.__externalUsage).toEqual({ provider: 'openai', connectionId: 'c-oa', upstreamModel: 'gpt-4o-mini' });
    expect(JSON.stringify(lastReq.__externalUsage)).not.toContain('sk-secret-123');
  });

  it('no refusal body carries the credential', async () => {
    backend([conn({ isActive: false })]);
    const r = await request(app('openai', 'openai')).post('/').send({ model: 'gpt-4o-mini--oa' });
    expect(JSON.stringify(r.body)).not.toContain('sk-secret-123');
  });
});
