/**
 * Regression suite for the NUL-byte path-param guard across EVERY router that
 * declares a path param — not just filesRoutes/vectorStoresRoutes, which were
 * the only two covered when the guard first shipped.
 *
 * Why supertest and not a direct call to the guard:
 *
 *   The first version of this guard shipped inert. It was mounted with
 *   `app.use(staticPath, guard)` and scanned `req.params` — but a mount path
 *   with no `:param` segment runs before Express has populated `req.params`
 *   at all, so the scan was dead code in production. Six unit tests passed
 *   anyway because they hand-built `req = { params: { file_id: '...' } }`,
 *   a shape Express never produces at that mount point.
 *
 *   A unit call on the guard therefore proves nothing here. Every case below
 *   drives a REAL router module through supertest, mounted the way
 *   src/index.ts mounts it, and asserts that the malicious status DIFFERS
 *   from the clean-request baseline. Two failure modes both fall out of that:
 *   a guard that is never reached (malicious == clean == 200) and a guard
 *   that rejects everything (clean == malicious == 400).
 *
 * Why the controllers and auth middlewares are mocked:
 *
 *   `router.param` callbacks fire when Express dispatches to the matched
 *   ROUTE layer, which is after any router-level `router.use(...)` middleware
 *   has already run. Most of these routers apply auth via `router.use(...)`,
 *   so an unauthenticated request is rejected with 401/403 before the param
 *   guard is ever consulted — clean and malicious would both come back 401
 *   and the test would be unable to see the guard at all. Neutralising auth
 *   is what makes the guard observable; the routers themselves, their route
 *   tables and their `router.param` registrations are the real modules.
 *
 *   (That ordering is fine in production: the defect being closed is a NUL
 *   reaching Postgres from inside a controller, and controllers only run
 *   after auth. See the report for the full note.)
 *
 * NB: never write a literal NUL byte into this file — cli-tools/check-nul-bytes.js
 * rejects it at commit time. `%00` below is percent-encoded ASCII, which is
 * exactly what a hostile client sends; Express decodes it to a real NUL when
 * it populates req.params.
 */

// Several routers transitively construct singletons at *import* time that throw
// without a >=32-char secret in the environment. setupTests.ts supplies one from
// a `beforeAll` hook, which fires only after this file's top-level imports have
// been evaluated — too late. Set it here and require() the routers lazily.
process.env.VALIDATION_TOKEN_SECRET = process.env.VALIDATION_TOKEN_SECRET || 'x'.repeat(32);

import request from 'supertest';
import express from 'express';

type Handler = (req: any, res: any, next: any) => void;

/** Records which controller handler actually ran, so a case can assert the
 *  guard short-circuited BEFORE the controller (not merely alongside it). */
const mockControllerCalls: string[] = [];

const mockPassThrough: Handler = (_req, _res, next) => next();

function mockSentinelHandler(name: string): Handler {
  return (_req, res) => {
    mockControllerCalls.push(name);
    res.status(200).json({ ok: true, handler: name });
  };
}

/**
 * Stands in for a controller module: every named export is a 200 sentinel.
 * A Proxy rather than an explicit list so this file does not have to be
 * updated every time a controller gains an export — the point under test is
 * the router's param registration, not the controller surface.
 */
function mockControllerModule(moduleName: string): any {
  return new Proxy(
    { __esModule: true } as any,
    {
      get(target, prop) {
        if (typeof prop === 'symbol') return (target as any)[prop];
        if (prop === '__esModule') return true;
        if (prop === 'default') return undefined;
        return mockSentinelHandler(`${moduleName}.${String(prop)}`);
      },
    },
  );
}

jest.mock('../src/middlewares/unifiedTokenAuth', () => ({
  __esModule: true,
  createUnifiedTokenAuth: () => mockPassThrough,
  default: mockPassThrough,
}));

jest.mock('../src/middlewares/rateLimiter', () => ({
  __esModule: true,
  default: mockPassThrough,
}));

jest.mock('../src/middlewares/gatewayServiceAuth', () => ({
  __esModule: true,
  gatewayStandaloneOnlyAuth: mockPassThrough,
  gatewayStandaloneOrServiceKeyAuth: mockPassThrough,
  addGatewayServiceAuthContext: mockPassThrough,
}));

jest.mock('../src/services/unifiedAuthProxyService', () => ({
  __esModule: true,
  unifiedAuthProxyService: {
    createServiceAuthMiddleware: () => mockPassThrough,
    createUnifiedRateLimitMiddleware: () => mockPassThrough,
  },
  serviceConfigurations: { openai: {}, openrouter: {}, bedrock: {}, anthropic: {} },
}));

jest.mock('../src/controllers/filesController', () => mockControllerModule('filesController'));
jest.mock('../src/controllers/vectorStoresController', () => mockControllerModule('vectorStoresController'));
jest.mock('../src/controllers/apiKeyController', () => mockControllerModule('apiKeyController'));
jest.mock('../src/controllers/awsApiKeysController', () => mockControllerModule('awsApiKeysController'));
jest.mock('../src/controllers/modelController', () => mockControllerModule('modelController'));
jest.mock('../src/controllers/awsBedrockController', () => mockControllerModule('awsBedrockController'));
jest.mock('../src/controllers/openRouterController', () => mockControllerModule('openRouterController'));
jest.mock('../src/controllers/responsesController', () => mockControllerModule('responsesController'));

type Method = 'get' | 'post' | 'patch' | 'delete';

interface Case {
  /** Router module the param lives on. */
  router: string;
  /** The `:param` name whose router.param registration this case pins down. */
  param: string;
  method: Method;
  /** Request path carrying %00 inside the param under test. */
  malicious: string;
}

/**
 * One case per (router, path param) pair in src/routes/. Derived from:
 *   grep -rn "router\.(get|post|patch|put|delete)\(\s*['\"][^'\"]*:" src/routes/
 * If a new router or param is added without a router.param registration, add
 * a case here — the malicious case will fail until the guard is registered.
 */
const CASES: Case[] = [
  // Already guarded before this change — kept as regression cover.
  { router: 'filesRoutes', param: 'id', method: 'get', malicious: '/openai/api/v1/files/file-abc%00def' },
  { router: 'vectorStoresRoutes', param: 'id', method: 'get', malicious: '/openai/api/v1/vector_stores/vs_abc%00def' },
  { router: 'vectorStoresRoutes', param: 'file_id', method: 'get', malicious: '/openai/api/v1/vector_stores/vs_1/files/file_abc%00def' },
  // `:batch_id` reaches Postgres as raw text inside the file-batch handlers'
  // queries, exactly as `:id` and `:file_id` do — an unguarded NUL there throws
  // 22021 and surfaces as a 500 carrying the driver's message. The router's
  // `router.param('batch_id', ...)` registration is pinned statically in
  // batchesController.test.ts; THIS is the end-to-end drive through a real
  // Express dispatch, the only thing that can show the guard is actually
  // REACHED. See this file's header for why that distinction matters: the
  // first version of this guard shipped inert with six unit tests green.
  { router: 'vectorStoresRoutes', param: 'batch_id', method: 'post', malicious: '/openai/api/v1/vector_stores/vs_1/file_batches/vsfb_abc%00def/cancel' },

  // Newly guarded.
  { router: 'modelRoutes', param: 'model_id', method: 'get', malicious: '/v1/models/gpt%004o' },
  { router: 'apiKeyRoutes', param: 'key', method: 'patch', malicious: '/api/admin/api-keys/key-abc%00def/revoke' },
  { router: 'apiKeyRoutes', param: 'id', method: 'get', malicious: '/api/admin/api-keys/id-abc%00def' },
  { router: 'awsCredentialsRoutes', param: 'accessKeyId', method: 'delete', malicious: '/aws/api-keys/AKIA%00EXAMPLE' },
  { router: 'awsBedrockRoutes', param: 'modelId', method: 'post', malicious: '/aws-bedrock/model/anthropic.claude%00v2/invoke' },
  { router: 'awsBedrockRoutes', param: 'subpath', method: 'post', malicious: '/aws-bedrock/model/anthropic.claude-v2/invo%00ke' },
  { router: 'openRouterRoutes', param: 'id', method: 'get', malicious: '/openrouter/api/v1/files/file-abc%00def' },
  { router: 'openRouterRoutes', param: 'author', method: 'get', malicious: '/openrouter/api/v1/models/anthro%00pic/claude-3/endpoints' },
  { router: 'openRouterRoutes', param: 'slug', method: 'get', malicious: '/openrouter/api/v1/models/anthropic/claude%003/endpoints' },
];

function clean(c: Case): string {
  return c.malicious.replace('%00', '');
}

function send(target: import('http').Server, method: Method, path: string) {
  return request(target)[method](path);
}

describe('NUL-byte path-param guard — every router, driven through Express', () => {
  let app: express.Express;
  // ONE listening server for the whole file; every request below goes through
  // it. Passing the app to supertest instead stands up an EPHEMERAL server per
  // call and tears it down when the response completes — under `forceExit: true`
  // plus workers competing for cores, that teardown races the response still
  // being written and the client reads a closed socket. It surfaces as
  // `Parse Error: Expected HTTP/, RTSP/ or ICE/` or `socket hang up` on a
  // passing assertion, intermittently: ~4% of full-suite runs under load,
  // across five suites that all shared this shape.
  let server: import('http').Server;

  beforeAll((done) => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const filesRoutes = require('../src/routes/filesRoutes').default;
    const vectorStoresRoutes = require('../src/routes/vectorStoresRoutes').default;
    const modelRoutes = require('../src/routes/modelRoutes').default;
    const apiKeyRoutes = require('../src/routes/apiKeyRoutes').default;
    const awsCredentialsRoutes = require('../src/routes/awsCredentialsRoutes').default;
    const awsBedrockRoutes = require('../src/routes/awsBedrockRoutes').default;
    const openRouterRoutes = require('../src/routes/openRouterRoutes').default;
    /* eslint-enable @typescript-eslint/no-var-requires */

    app = express();
    app.use(express.json());

    // Mount paths mirror src/index.ts exactly.
    app.use('/v1/models', modelRoutes);
    app.use('/openai/api/v1/files', filesRoutes);
    app.use('/openai/api/v1/vector_stores', vectorStoresRoutes);
    app.use('/aws-bedrock', awsBedrockRoutes);
    app.use('/aws/api-keys', awsCredentialsRoutes);
    app.use('/api/admin/api-keys', apiKeyRoutes);
    app.use('/openrouter/api/v1', openRouterRoutes);
    server = app.listen(0, () => done());
  });

  afterAll((done) => { server.close(() => done()); });

  beforeEach(() => {
    mockControllerCalls.length = 0;
  });

  it.each(CASES)(
    '$router rejects a NUL in :$param with 400 before the controller runs',
    async (c) => {
      const res = await send(server, c.method, c.malicious);

      expect(res.status).toBe(400);
      expect(res.body.error.type).toBe('invalid_request_error');
      expect(res.body.error.code).toBe('invalid_identifier');
      // The guard must short-circuit: no controller may have seen the NUL.
      expect(mockControllerCalls).toEqual([]);
    },
  );

  it.each(CASES)(
    '$router still serves a clean :$param — a guard that rejects everything fails this',
    async (c) => {
      const res = await send(server, c.method, clean(c));

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(mockControllerCalls).toHaveLength(1);
    },
  );

  it('malicious and clean statuses differ for every case — the guard is actually reached', async () => {
    for (const c of CASES) {
      const maliciousRes = await send(server, c.method, c.malicious);
      const cleanRes = await send(server, c.method, clean(c));

      expect({ case: `${c.router}:${c.param}`, differ: maliciousRes.status !== cleanRes.status }).toEqual({
        case: `${c.router}:${c.param}`,
        differ: true,
      });
    }
  });

  it('does not reject the literal two-character sequence backslash-zero', async () => {
    const res = await request(server).get('/v1/models/gpt-4o%5C0-legit');
    expect(res.status).toBe(200);
  });
});
