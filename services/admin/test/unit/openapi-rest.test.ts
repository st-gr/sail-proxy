/**
 * openapi/admin-rest.yaml describes the admin's REST routers (config-rest-api.ts, grounding-rest-api.ts, plugins-rest-api.ts).
 *
 * Coverage: the mounts are read from src/index.ts, the Docker and Kyma start that mounts the routers
 * at /api (admin-service.ts's extra mounts run only under a local `cds serve`, which nginx never
 * fronts), plus the API reference page mounted at /api/docs (a static subtree, counted as the one
 * route `GET /docs`), every route the routers serve under them is listed, and each one must be in the document
 * or in internal-routes.json (`adminRest`), both directions. Paths are relative to the `/api` mount,
 * which is the document's server (`/admin/api` behind nginx).
 *
 * Contract: the answers the grounding router gives itself (sign-in, identity and id refusals, the
 * unreachable gateway, the team check, the upload content type, /model-cost) and the gateway answers
 * it passes through are checked against the status and schema the document gives them. The gateway is
 * mocked as in srv/grounding-rest-api.test.ts; the passed-through bodies have the shapes the
 * gateway's grounding controllers build.
 */
import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import request from 'supertest';
import Ajv2020 from 'ajv/dist/2020';
import { compareRoutes, documentedRoutes, listExpressRoutes, loadOpenApi, toOpenApiPath } from '@sap-llm-gateway/test-utils';
import type { RouteKey } from '@sap-llm-gateway/test-utils';

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));
jest.mock('../../src/srv/notification-stream', () => ({ notificationStreamService: { handleConnection: jest.fn() } }));
const callGateway = jest.fn();
jest.mock('../../src/services/groundingGatewayClient', () => ({
  __esModule: true,
  callGateway: (...a: any[]) => callGateway(...a),
  streamToGateway: jest.fn(),
  streamFromGateway: jest.fn(),
  getMaxFileBytes: jest.fn()
}));
const membershipsOf = jest.fn();
const getTeam = jest.fn();
jest.mock('../../src/services/teamLookups', () => ({
  __esModule: true,
  membershipsOf: (...a: any[]) => membershipsOf(...a),
  getTeam: (...a: any[]) => getTeam(...a)
}));
const computeSapNative = jest.fn();
jest.mock('../../src/services/sapCapacityService', () => ({
  __esModule: true,
  computeSapNative: (...a: any[]) => computeSapNative(...a),
  isProductive: () => true
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const configRestApi = require('../../src/srv/config-rest-api');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const groundingRestApi = require('../../src/srv/grounding-rest-api');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pluginsRestApi = require('../../src/srv/plugins-rest-api');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const versionRestApi = require('../../src/srv/version-rest-api');

const ADMIN_ROOT = path.resolve(__dirname, '../..');
const DOC_FILE = path.resolve(ADMIN_ROOT, '../../openapi/admin-rest.yaml');
const INTERNAL_FILE = path.resolve(ADMIN_ROOT, '../../openapi/internal-routes.json');
const MOUNT_FILE = 'src/index.ts';
const ROUTERS: Record<string, express.Router> = { configRestApi, groundingRestApi, pluginsRestApi, versionRestApi };
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'];

interface Mount { prefix: string; router: string }

/** The `/api...` mounts of the two routers and the app-level `/api/...` routes, read from the source that registers them. */
function mountsInSource(): { mounts: Mount[]; appRoutes: RouteKey[] } {
  const mounts: Mount[] = [];
  const appRoutes: RouteKey[] = [];
  const source = fs.readFileSync(path.join(ADMIN_ROOT, MOUNT_FILE), 'utf8');
  for (const m of source.matchAll(/app\.use\('\/api((?:\/[^']*)?)',\s*\(?(configRestApi|groundingRestApi|pluginsRestApi|versionRestApi)\b/g)) {
    mounts.push({ prefix: m[1], router: m[2] });
  }
  for (const m of source.matchAll(/app\.(get|post|put|delete|patch)\('\/api(\/[^']*)'/g)) {
    appRoutes.push({ method: m[1], path: toOpenApiPath(m[2]) });
  }
  // The API reference page (src/srv/api-docs.ts) is a static subtree, not a router of routes.
  for (const m of source.matchAll(/app\.use\('\/api(\/docs)',\s*createApiDocsRouter\b/g)) {
    appRoutes.push({ method: 'get', path: m[1] });
  }
  return { mounts, appRoutes };
}

function servedRoutes(): RouteKey[] {
  const { mounts, appRoutes } = mountsInSource();
  const all = [...appRoutes, ...mounts.flatMap((m) => listExpressRoutes(ROUTERS[m.router], m.prefix))];
  return [...new Map(all.map((k) => [`${k.method} ${k.path}`, k])).values()];
}

const internal: Array<{ method: string; path: string; reason: string }> = JSON.parse(fs.readFileSync(INTERNAL_FILE, 'utf8')).adminRest;

let doc: Awaited<ReturnType<typeof loadOpenApi>>;
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });

beforeAll(async () => {
  doc = await loadOpenApi(DOC_FILE);
  ajv.addSchema({ $id: 'admin-rest.yaml', components: doc.components });
});

function operations(): Array<{ path: string; method: string; op: any }> {
  return Object.entries(doc.paths ?? {}).flatMap(([p, item]) =>
    HTTP_METHODS.filter((m) => (item as any)?.[m]).map((m) => ({ path: p, method: m, op: (item as any)[m] })));
}

describe('admin REST OpenAPI document: shape', () => {
  it('is OpenAPI 3.1, served under /admin/api, signed in with the oauth2-proxy cookie', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.servers?.[0]?.url).toBe('/admin/api');
    expect(doc.components?.securitySchemes?.cockpitSession).toMatchObject({ type: 'apiKey', in: 'cookie', name: '_oauth2_proxy' });
    expect(doc.security).toEqual([{ cockpitSession: [] }]);
  });

  it('every operation has a tag, operationId, summary, description, x-sail-upstream and a JSON success schema', () => {
    const ids = new Set<string>();
    for (const { path: p, method, op } of operations()) {
      const where = `${method.toUpperCase()} ${p}`;
      expect({ where, tags: op.tags?.length > 0 }).toEqual({ where, tags: true });
      expect({ where, id: typeof op.operationId }).toEqual({ where, id: 'string' });
      expect({ where, duplicate: ids.has(op.operationId) }).toEqual({ where, duplicate: false });
      ids.add(op.operationId);
      expect({ where, summary: typeof op.summary, description: typeof op.description, upstream: typeof op['x-sail-upstream'] })
        .toEqual({ where, summary: 'string', description: 'string', upstream: 'string' });
      const ok = op.responses?.['200'];
      expect({ where, ok: !!ok?.content }).toEqual({ where, ok: true });
    }
  });

  it('every grounding operation that calls the gateway documents the 401 and 502 the admin answers itself', () => {
    const forwarded = operations().filter((o) => o.path.startsWith('/grounding/') && o.path !== '/grounding/model-cost');
    expect(forwarded.length).toBeGreaterThan(50);
    expect((doc.paths?.['/grounding/model-cost'] as any).get.responses['401']).toBeDefined();
    for (const { path: p, method, op } of forwarded) {
      expect({ route: `${method} ${p}`, codes: ['401', '502'].filter((c) => op.responses?.[c]) })
        .toEqual({ route: `${method} ${p}`, codes: ['401', '502'] });
    }
  });
});

describe('admin REST OpenAPI document: coverage', () => {
  it('finds the router mounts and the app-level routes in the source', () => {
    const { mounts, appRoutes } = mountsInSource();
    expect([...new Set(mounts.map((m) => `${m.router} ${m.prefix}`))].sort())
      .toEqual(['configRestApi ', 'groundingRestApi /grounding', 'pluginsRestApi /plugins', 'versionRestApi /version']);
    expect(appRoutes).toEqual([{ method: 'get', path: '/health' }, { method: 'get', path: '/docs' }]);
  });

  it('every served route is documented or listed as internal, and every listed route is served', () => {
    const result = compareRoutes(servedRoutes(), documentedRoutes(doc), internal);
    expect(result).toEqual({ undocumented: [], stale: [] });
  });

  it('no route is both documented and internal, and every internal entry says why', () => {
    const documented = new Set(documentedRoutes(doc).map((k) => `${k.method} ${k.path}`));
    for (const entry of internal) {
      expect({ entry: `${entry.method} ${entry.path}`, documented: documented.has(`${entry.method} ${entry.path}`) })
        .toEqual({ entry: `${entry.method} ${entry.path}`, documented: false });
      expect(entry.reason.length).toBeGreaterThan(40);
    }
  });
});

// ---------------------------------------------------------------------------
// Contract checks for the grounding router
// ---------------------------------------------------------------------------

function appAs(user: any): express.Application {
  const app = express();
  app.use((req: any, _res, next) => { if (user) req.user = user; next(); });
  app.use('/api/grounding', groundingRestApi);
  return app;
}
const USER = { id: 'user@example.com', email: 'user@example.com', roles: ['user'], attr: {} };
const ADMIN = { id: 'admin@example.com', email: 'admin@example.com', roles: ['admin', 'user'], attr: {} };

/** The JSON schema the document gives `method path` for `status`; fails when the status is not documented. */
function documentedSchema(p: string, method: string, status: number): object {
  const op = (doc.paths?.[p] as any)?.[method];
  if (!op) throw new Error(`${method.toUpperCase()} ${p} is not documented`);
  let response = op.responses?.[String(status)];
  if (response?.$ref) response = (doc.components?.responses as any)?.[response.$ref.split('/').pop()];
  if (!response) throw new Error(`${method.toUpperCase()} ${p} does not document a ${status} response`);
  const schema = response.content?.['application/json']?.schema;
  if (!schema) throw new Error(`${method.toUpperCase()} ${p} ${status} has no application/json schema`);
  return JSON.parse(JSON.stringify(schema).replace(/"#\/components\//g, '"admin-rest.yaml#/components/'));
}

function expectMatches(p: string, method: string, res: request.Response): void {
  const validate = ajv.compile(documentedSchema(p, method, res.status));
  const ok = validate(res.body);
  expect({ status: res.status, errors: ok ? null : validate.errors }).toEqual({ status: res.status, errors: null });
}

function gatewayAnswers(status: number, data: unknown): void {
  callGateway.mockResolvedValue({ status, headers: {}, data });
}

const JOB = {
  id: 'job_example1', kind: 'file_batch', store_id: 'vs_example1', store_name: 'Handbooks', batch_id: 'vsfb_example1',
  state: 'completed', total: 2, done: 2, failed: 0, cancelled: 0, in_progress: 0, embedding_tokens: 1840,
  target_chunking: null, reextract: false, context_input_tokens: 0, context_cached_tokens: 0, context_output_tokens: 0,
  context_failed_chunks: 0, ocr_pages: 0, ocr_skipped_pages: 0, vision_pages: 0, vision_skipped_pages: 0, error: null,
  created_at: '2026-10-20T09:00:00.000Z', started_at: '2026-10-20T09:00:01.000Z', finished_at: '2026-10-20T09:00:30.000Z',
  started_by: 'user@example.com'
};
const STORE = {
  id: 'vs_example1', object: 'vector_store', created_at: 1760950800, name: 'Handbooks', usage_bytes: 52000,
  file_counts: { in_progress: 0, completed: 2, failed: 0, cancelled: 0, total: 2 }, status: 'completed',
  expires_after: null, expires_at: null, last_active_at: 1760950800, metadata: {},
  is_shared: false, owned: true, owner_email: 'user@example.com', embedding_model: 'text-embedding-3-small', embedding_dim: 1536,
  active_generation: 1, embedding_state: 'current', reembed_job_id: null,
  chunking: { type: 'structure', max_tokens: 800, overlap_tokens: 0, contextual: false }, team_ids: []
};

beforeEach(() => {
  membershipsOf.mockReset(); membershipsOf.mockResolvedValue([]);
  getTeam.mockReset(); getTeam.mockResolvedValue({ ID: 't1' });
  callGateway.mockReset(); gatewayAnswers(200, {});
  computeSapNative.mockReset();
});

describe('grounding contract: the answers the admin gives itself', () => {
  it('401 authentication_required without a signed-in user', async () => {
    expectMatches('/grounding/status', 'get', await request(appAs(null)).get('/api/grounding/status'));
    expectMatches('/grounding/model-cost', 'get', await request(appAs(null)).get('/api/grounding/model-cost?model=m'));
  });

  it('400 unsupported_identity for a sign-in e-mail that cannot travel in a header', async () => {
    const r = await request(appAs({ id: 'jürgen@example.com', roles: ['user'] })).get('/api/grounding/files');
    expect(r.body.error).toBe('unsupported_identity');
    expectMatches('/grounding/files', 'get', r);
  });

  it('400 invalid_id for a path parameter that is not a plain token', async () => {
    const r = await request(appAs(USER)).get('/api/grounding/files/' + encodeURIComponent('../x'));
    expect(r.body.error).toBe('invalid_id');
    expectMatches('/grounding/files/{id}', 'get', r);
  });

  it('502 gateway_unreachable when the gateway call throws, and when the client reports it', async () => {
    callGateway.mockRejectedValue(new Error('boom'));
    expectMatches('/grounding/status', 'get', await request(appAs(USER)).get('/api/grounding/status'));
    gatewayAnswers(502, { error: 'gateway_unreachable', message: 'The gateway could not be reached.' });
    expectMatches('/grounding/stores', 'get', await request(appAs(USER)).get('/api/grounding/stores'));
  });

  it('404 team_not_found when sharing with a team that does not exist', async () => {
    getTeam.mockResolvedValue(null);
    const r = await request(appAs(USER)).post('/api/grounding/stores/vs_1/share-team').send({ teamId: 'nope' });
    expect(r.status).toBe(404);
    expectMatches('/grounding/stores/{id}/share-team', 'post', r);
  });

  it('400 invalid_content_type for an upload that is not multipart/form-data', async () => {
    const r = await request(appAs(USER)).post('/api/grounding/files').send({ file: 'x' });
    expect(r.body.error).toBe('invalid_content_type');
    expectMatches('/grounding/files', 'post', r);
  });

  it('GET /model-cost: priced, unpriced, without a capacity unit price, refused and failed', async () => {
    const url = '/api/grounding/model-cost?model=gemini-example&input_tokens=125000&output_tokens=4096';
    computeSapNative.mockResolvedValue({ genAiTokens: 10, capacityUnits: 19.0385, sapCost: 1.42, sapCostCurrency: 'EUR' });
    expectMatches('/grounding/model-cost', 'get', await request(appAs(USER)).get(url));
    computeSapNative.mockResolvedValue(null);
    expectMatches('/grounding/model-cost', 'get', await request(appAs(USER)).get(url));
    computeSapNative.mockResolvedValue({ genAiTokens: 1, capacityUnits: 2, sapCost: null, sapCostCurrency: null });
    expectMatches('/grounding/model-cost', 'get', await request(appAs(USER)).get(url));
    expectMatches('/grounding/model-cost', 'get', await request(appAs(USER)).get('/api/grounding/model-cost?model=a%20b'));
    computeSapNative.mockRejectedValue(new Error('db down'));
    const failed = await request(appAs(USER)).get(url);
    expect(failed.status).toBe(500);
    expectMatches('/grounding/model-cost', 'get', failed);
  });
});

describe('grounding contract: gateway answers passed through', () => {
  it('the gateway\'s error envelope (409 file_in_use, 403 grounding_admin_required, 404 not found, 503 unavailable)', async () => {
    gatewayAnswers(409, { error: { message: 'File file-a is used by a vector store you do not own, so it cannot be deleted.', type: 'invalid_request_error', code: 'file_in_use' } });
    expectMatches('/grounding/files/{id}', 'delete', await request(appAs(USER)).delete('/api/grounding/files/file-a'));
    gatewayAnswers(403, { error: { message: 'This operation requires a grounding administrator.', type: 'permission_error', code: 'grounding_admin_required' } });
    expectMatches('/grounding/admin/overview', 'get', await request(appAs(USER)).get('/api/grounding/admin/overview'));
    gatewayAnswers(404, { error: { message: 'No such vector store: vs_1', type: 'invalid_request_error', code: 'vector_store_not_found' } });
    expectMatches('/grounding/stores/{id}/reembed', 'post', await request(appAs(USER)).post('/api/grounding/stores/vs_1/reembed'));
    gatewayAnswers(503, { error: { message: 'file_search is unavailable: it is switched off in the configuration.', type: 'file_search_unavailable', code: 'file_search_unavailable' } });
    expectMatches('/grounding/files', 'get', await request(appAs(USER)).get('/api/grounding/files'));
  });

  it('a quota refusal (429) on a route that starts paid work', async () => {
    gatewayAnswers(429, { error: {
      type: 'quota_exceeded', code: 'quota_exceeded', message: 'Your usage quota for this day is used up.',
      scope: 'user', dimension: 'tokens', window: 'day', limit: 100000, used: 100000.5, resets_at: '2026-10-25T00:00:00.000Z'
    } });
    expectMatches('/grounding/stores/{id}/search', 'post', await request(appAs(USER)).post('/api/grounding/stores/vs_1/search').send({ query: 'q' }));
  });

  it('GET /status, /stores, /storage, /jobs/{job_id} and /admin/overview with the gateway\'s bodies', async () => {
    gatewayAnswers(200, {
      available: true, reason: null, embeddingModel: 'text-embedding-3-small', embeddingDimensions: 1536, blobBackend: 'db',
      limits: { maxFileBytes: 33554432, maxFilesPerStore: 10000 },
      chunking: { type: 'structure', max_tokens: 800, overlap_tokens: 0, contextual: false },
      vision: { available: true, model: 'gemini-example-flash-lite', unmaskedWarning: false }
    });
    expectMatches('/grounding/status', 'get', await request(appAs(USER)).get('/api/grounding/status'));
    gatewayAnswers(200, { object: 'list', data: [STORE], has_more: false, first_id: STORE.id, last_id: STORE.id });
    expectMatches('/grounding/stores', 'get', await request(appAs(USER)).get('/api/grounding/stores'));
    gatewayAnswers(200, { owner_email: 'user@example.com', file_count: 2, logical_bytes: 52000 });
    expectMatches('/grounding/storage', 'get', await request(appAs(USER)).get('/api/grounding/storage'));
    gatewayAnswers(200, JOB);
    expectMatches('/grounding/jobs/{job_id}', 'get', await request(appAs(USER)).get('/api/grounding/jobs/job_example1'));
    gatewayAnswers(200, { stores: 3, files: 7, logical_bytes: 90000, physical_bytes: 80000, savings_bytes: 10000, failed_ingestions: 1, outdated_stores: 0 });
    expectMatches('/grounding/admin/overview', 'get', await request(appAs(ADMIN)).get('/api/grounding/admin/overview'));
  });
});

describe('configuration contract: the answers of /api-config', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cds = require('@sap/cds');
  const CONFIG_ADMIN = { id: 'admin@example.com', email: 'admin@example.com', roles: ['admin'], attr: {} };
  // The shapes config-service.ts returns: configData already parsed, timestamps as strings.
  const adminService = {
    send: jest.fn(async (event: string): Promise<any> => {
      switch (event) {
        case 'getActiveConfiguration':
          return { success: true, data: { id: 'cfg-3', name: 'Config 3', version: '2026.10.201530', configData: { api_config: { providers: {} } }, checksum: 'abcdef0123456789', deployedAt: '2026-10-20T15:30:00.000Z', deployedBy: 'admin@example.com' } };
        case 'createConfiguration':
          return { success: true, configId: 'cfg-4', version: '2026.10.251200', checksum: 'fedcba9876543210', warnings: ['No fallback model'] };
        case 'activateConfiguration':
          return { success: true, version: '2026.10.251200', checksum: 'fedcba9876543210', activatedAt: '2026-10-25T12:00:00.000Z' };
        case 'rollbackConfiguration':
          return { success: true, rolledBackFrom: '2026.10.251200', rolledBackTo: '2026.10.201530', reason: 'Manual rollback via REST API', rolledBackAt: new Date('2026-10-25T12:05:00.000Z') };
      }
      throw new Error(`unexpected event ${event}`);
    })
  };
  let original: unknown;
  beforeAll(() => { original = cds.services.AdminService; cds.services.AdminService = adminService; });
  afterAll(() => { if (original === undefined) delete cds.services.AdminService; else cds.services.AdminService = original; });

  // No express.json() here: the router parses its own bodies, as behind Docker's index.ts.
  function configApp(): express.Application {
    const app = express();
    app.use((req: any, _res, next) => { req.user = CONFIG_ADMIN; next(); });
    app.use('/api', configRestApi);
    return app;
  }

  it('GET /api-config answers the active configuration', async () => {
    const res = await request(configApp()).get('/api/api-config');
    expect(res.status).toBe(200);
    expectMatches('/api-config', 'get', res);
    expect(res.headers['x-config-version']).toBe('2026.10.201530');
  });

  it('PUT /api-config answers the activated version, and 400 for a missing or invalid configuration', async () => {
    const ok = await request(configApp()).put('/api/api-config').send({ api_config: { providers: {} } });
    expect(ok.status).toBe(200);
    expectMatches('/api-config', 'put', ok);
    const missing = await request(configApp()).put('/api/api-config').send({});
    expect(missing.status).toBe(400);
    expectMatches('/api-config', 'put', missing);
    adminService.send.mockResolvedValueOnce({ success: false, errors: ['api_config.providers is required'], warnings: [] });
    const invalid = await request(configApp()).put('/api/api-config').send({ api_config: {} });
    expect(invalid.status).toBe(400);
    expectMatches('/api-config', 'put', invalid);
  });

  it('POST /api-config/rollback answers the versions, with or without a body, and 400 when there is nothing to roll back', async () => {
    const withBody = await request(configApp()).post('/api/api-config/rollback').send({ reason: 'bad change' });
    expect(withBody.status).toBe(200);
    expectMatches('/api-config/rollback', 'post', withBody);
    expectMatches('/api-config/rollback', 'post', await request(configApp()).post('/api/api-config/rollback'));
    adminService.send.mockResolvedValueOnce({ success: false, error: 'No previous configuration available for rollback' });
    const nothing = await request(configApp()).post('/api/api-config/rollback');
    expect(nothing.status).toBe(400);
    expectMatches('/api-config/rollback', 'post', nothing);
  });
});
