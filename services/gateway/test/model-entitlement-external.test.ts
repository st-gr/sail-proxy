/**
 * Connection models are opt-in (spec 2026-10-23 §4.3): a default-catalog caller (mode 'all')
 * neither sees nor gets one, however it is named or reached - substitution included. A catalog
 * listing it grants it; no block at all (admins, standalone) stays unrestricted. The rule lives in
 * the gateway, not in the admin's exclusion list, because the entitlement block is cached for up
 * to an hour and a model published meanwhile would otherwise slip through.
 */
import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { startFakeSapServer, FakeSapServer } from './fakeSapServer';

const EXTERNAL = 'gpt-4o-mini--oa';
const quietLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, trace: () => undefined };
const ALL = { catalogId: 'def', catalogName: 'Default', mode: 'all' as const };
const LIST = { catalogId: 'ovf', catalogName: 'Overflow', mode: 'list' as const, include: [EXTERNAL, 'gpt-4o'] };

let server: FakeSapServer;
beforeAll(async () => { server = await startFakeSapServer(); });
afterAll(async () => { await server.close(); });

const connection = {
  id: 'c-oa', name: 'oa', providerType: 'openai', settings: {}, credentials: { secret: 'sk-secret' },
  models: [{ modelId: EXTERNAL, upstreamModel: 'gpt-4o-mini', displayName: null, family: 'openai', capabilities: ['chat'], priced: true }],
};

/** Fresh modules: the real entitlement, controller and model service; a registry holding one published model; a failing SAP. */
function load(shadowed: string[] = []) {
  jest.resetModules();
  process.env.AUTH_URL = `${server.url}/oauth/token`;
  process.env.CLIENT_ID = 'id';
  process.env.CLIENT_SECRET = 'secret';
  jest.doMock('@libs/logger', () => ({ getDefaultLogger: () => quietLogger }));
  const registry = {
    refreshInBackground: jest.fn(async () => undefined),
    ensureFresh: jest.fn(async () => undefined),
    publishedModels: () => connection.models.map((model) => ({ connection, model })),
    setShadowed: jest.fn(),
    isExternalModelId: (id: string) => id === EXTERNAL && !shadowed.includes(id),
  };
  jest.doMock('../src/connections/connectionRegistry', () => ({ connectionRegistry: registry }));
  jest.doMock('../src/services/securityEventEmitter', () => ({ __esModule: true, default: { emit: jest.fn(), emitEvent: jest.fn(), emitSecurityEvent: jest.fn() } }));
  const getSubstitutedModel = jest.fn((_p: string, m: string) => m);
  jest.doMock('../src/services/configService', () => ({
    __esModule: true,
    getTrustForwardedFor: () => false,
    default: { getSAPAICoreConfig: () => ({ url: server.url }), getModelListChanges: () => ({}), getSubstitutedModel },
  }));
  require('../src/utils/sapRequest').__setSapTimingForTests({ listAttemptMs: 250, tokenAttemptMs: 250, retryJitterMinMs: 5, retryJitterMaxMs: 10 });
  return {
    ent: require('../src/utils/modelEntitlement'),
    controller: require('../src/controllers/modelController'),
    substitution: require('../src/middlewares/modelSubstitution'),
    getSubstitutedModel,
  };
}

const res = () => { const r: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }; return r; };
const reqWith = (entitlement: unknown, extra: Record<string, unknown> = {}) => ({ query: {}, headers: {}, params: {}, apiKeyInfo: { entitlement }, ...extra }) as any;

beforeEach(() => {
  server.script([{ kind: 'json', body: { access_token: 'tok', expires_in: 3600 } }, { kind: 'status', status: 500, body: { error: 'down' } }]);
});

describe('isModelEntitled and connection models', () => {
  it('mode all: an external id is not entitled, an SAP id still is', () => {
    const { ent } = load();
    expect(ent.isModelEntitled(ALL, EXTERNAL)).toBe(false);
    expect(ent.isModelEntitled(ALL, 'gpt-4o')).toBe(true);
  });

  it('mode all still honours the exclusions for SAP ids', () => {
    const { ent } = load();
    expect(ent.isModelEntitled({ ...ALL, exclude: ['gpt-4o'] }, 'gpt-4o')).toBe(false);
  });

  it('mode list naming the external id: entitled', () => {
    const { ent } = load();
    expect(ent.isModelEntitled(LIST, EXTERNAL)).toBe(true);
  });

  it('no block: entitled', () => {
    const { ent } = load();
    expect(ent.isModelEntitled(null, EXTERNAL)).toBe(true);
  });

  it('a shadowed id is treated as the SAP model it collides with', () => {
    const { ent } = load([EXTERNAL]);
    expect(ent.isModelEntitled(ALL, EXTERNAL)).toBe(true);
  });
});

describe('/v1/models with the SAP list failing (the sub-project A done-when)', () => {
  it('a default-catalog key does not see the connection model', async () => {
    const { controller } = load();
    const r = res();
    await controller.getModels(reqWith(ALL), r, jest.fn());
    expect(r.json.mock.calls[0][0].data.map((m: any) => m.id)).toEqual([]);
  });

  it('a key whose catalog lists it sees it', async () => {
    const { controller } = load();
    const r = res();
    await controller.getModels(reqWith(LIST), r, jest.fn());
    expect(r.json.mock.calls[0][0].data.map((m: any) => m.id)).toEqual([EXTERNAL]);
  });

  it('GET /v1/models/:id of the connection model for a default-catalog key → 404', async () => {
    const { controller } = load();
    const r = res();
    await controller.getModelById(reqWith(ALL, { params: { model_id: EXTERNAL } }), r, jest.fn());
    expect(r.status).toHaveBeenCalledWith(404);
  });
});

describe('substitution cannot bypass the opt-in', () => {
  it('a default-catalog key renamed onto a connection model gets 403', () => {
    const { ent, substitution, getSubstitutedModel } = load();
    getSubstitutedModel.mockImplementation((_p: string, m: string) => (m === 'gpt-4o' ? EXTERNAL : m));
    const req = reqWith(ALL, { body: { model: 'gpt-4o' } });
    const next = jest.fn();
    substitution.substituteOpenAICompatibleModel(req, res(), next);
    expect(next).toHaveBeenCalled();
    expect(req.body.model).toBe(EXTERNAL);
    const r = res();
    expect(ent.enforceEntitlement(req, r, req.body.model)).toBe(false);
    expect(r.status).toHaveBeenCalledWith(403);
  });
});
