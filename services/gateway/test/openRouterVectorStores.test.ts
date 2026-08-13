/**
 * Task 3: the vector-store surface on the OpenRouter prefix, and the NUL-byte
 * guard that has to come with it.
 *
 * Two defects are pinned here, and they are two halves of one thing:
 *
 *   1. `/openrouter/api/v1` served `/files` and `/responses` but NOT
 *      `/vector_stores`. An OpenRouter client could upload a file and invoke
 *      the `file_search` tool, but could not create the vector store that
 *      tool needs. Self-contradictory, not merely partial.
 *
 *   2. The app-level `nulByteGuard` in src/index.ts was mounted on the four
 *      `/openai/...` prefixes only. `/openrouter/api/v1/files` therefore had
 *      unguarded NUL bytes in `?after`/`?before` and in body identifier
 *      fields — only `:id` was guarded, via `router.param` inside
 *      openRouterRoutes.ts. Adding the mount without extending the guard
 *      would have inherited that gap and widened it to vector stores.
 *
 * Why supertest and a real Express dispatch, never a unit call:
 *
 *   The first version of this guard shipped INERT. It was mounted where
 *   Express had not yet populated `req.params`, and six unit tests passed
 *   anyway because they hand-built the request object. A direct call to
 *   `nulByteGuard(req, res, next)` proves nothing about a mount. Every case
 *   below goes through a real Express app running the real
 *   `openRouterRoutes` module.
 *
 * Why the guard mount list is READ OUT OF src/index.ts rather than repeated:
 *
 *   src/index.ts cannot be imported from a test — it calls `app.listen()` and
 *   runs migrations at module load. A test that hard-codes the prefix list
 *   would stay green after the prefix was deleted from index.ts, i.e. it
 *   would pin nothing. So the array literal passed to `app.use(..., nulByteGuard)`
 *   is parsed out of the source and used to mount the guard here. Delete
 *   `/openrouter/api/v1/files` and `/openrouter/api/v1/vector_stores` from
 *   that list in index.ts and the NUL cases below go red, while the
 *   clean-request cases stay green.
 *
 * NB: never write a literal NUL byte into this file — cli-tools/check-nul-bytes.js
 * rejects every C0 byte except tab/LF/CR at commit time. `%00` below is
 * percent-encoded ASCII (exactly what a hostile client sends, decoded to a
 * real NUL by Express), and body cases use String.fromCharCode(0).
 */

// openRouterRoutes transitively constructs singletons at *import* time that
// throw without a >=32-char secret in the environment. setupTests.ts supplies
// one from a `beforeAll` hook, which fires only after this file's top-level
// imports have been evaluated — too late. Set it here and require() lazily.
process.env.VALIDATION_TOKEN_SECRET = process.env.VALIDATION_TOKEN_SECRET || 'x'.repeat(32);

import { readFileSync } from 'fs';
import * as path from 'path';
import request from 'supertest';
import express from 'express';
import { nulByteGuard } from '../src/middlewares/nulByteGuard';

const NUL = String.fromCharCode(0);

type Handler = (req: any, res: any, next: any) => void;

/** Records which controller handler actually ran, so a case can assert the
 *  guard short-circuited BEFORE the controller rather than alongside it. */
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
 * A Proxy rather than an explicit list so this file does not need updating
 * when a controller gains an export — what is under test is the router's
 * route table and the guard mount, not the controller surface.
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

// Auth is neutralised for the same reason as in nul-byte-guard-routers.test.ts:
// openRouterRoutes applies auth via `router.use(...)`, so an unauthenticated
// request is rejected with 401 before any route (or its param guard) is
// reached — clean and malicious would both come back 401 and neither the
// mount nor the guard would be observable. The router module itself, its route
// table and its `router.param` registrations are the real thing.
jest.mock('../src/middlewares/unifiedTokenAuth', () => ({
  __esModule: true,
  createUnifiedTokenAuth: () => mockPassThrough,
  default: mockPassThrough,
}));

jest.mock('../src/middlewares/rateLimiter', () => ({
  __esModule: true,
  default: mockPassThrough,
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
jest.mock('../src/controllers/openRouterController', () => mockControllerModule('openRouterController'));
jest.mock('../src/controllers/responsesController', () => mockControllerModule('responsesController'));

const INDEX_PATH = path.join(__dirname, '..', 'src', 'index.ts');

/**
 * Extracts the array literal passed to `app.use([...], nulByteGuard)` in
 * src/index.ts. Throws loudly rather than returning a default: a silent
 * fallback here would turn "the prefix was deleted" into a green run, which
 * is precisely the failure mode this file exists to prevent.
 */
function readGuardMountPaths(): string[] {
  const source = readFileSync(INDEX_PATH, 'utf8');
  const call = source.match(/app\.use\(\s*(\[[\s\S]*?\])\s*,\s*nulByteGuard\s*,?\s*\)/);
  if (!call) {
    throw new Error(
      `Could not find an \`app.use([...], nulByteGuard)\` call in ${INDEX_PATH}. ` +
      'The app-level NUL-byte guard mount is what this suite pins; if the mount ' +
      'was restructured, update this parser rather than deleting the tests.',
    );
  }
  const paths = Array.from(call[1].matchAll(/['"]([^'"]+)['"]/g)).map((m) => m[1]);
  if (paths.length === 0) {
    throw new Error(`The nulByteGuard mount list in ${INDEX_PATH} is empty.`);
  }
  return paths;
}

describe('OpenRouter vector stores + NUL-byte guard, driven through real Express', () => {
  let app: express.Express;
  let guardMountPaths: string[];
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
    guardMountPaths = readGuardMountPaths();

    /* eslint-disable @typescript-eslint/no-var-requires */
    const openRouterRoutes = require('../src/routes/openRouterRoutes').default;
    /* eslint-enable @typescript-eslint/no-var-requires */

    app = express();
    // Mirrors src/index.ts: body parsing, then the app-level guard, then the
    // routers. The guard's mount list comes from index.ts itself (above).
    app.use(express.json());
    app.use(guardMountPaths, nulByteGuard);
    app.use('/openrouter/api/v1', openRouterRoutes);
    server = app.listen(0, () => done());
  });

  afterAll((done) => { server.close(() => done()); });

  beforeEach(() => {
    mockControllerCalls.length = 0;
  });

  // -------------------------------------------------------------------------
  // 1. The mount. Removing the OpenRouter vector-store routes from
  //    openRouterRoutes.ts turns every one of these into a 404.
  // -------------------------------------------------------------------------
  describe('the vector-store surface exists on the OpenRouter prefix', () => {
    it('serves the vector-store surface on the OpenRouter prefix', async () => {
      const res = await request(server).post('/openrouter/api/v1/vector_stores').send({ name: 's' });

      expect(res.status).not.toBe(404);
      expect(res.status).toBe(200);
      expect(mockControllerCalls).toEqual(['vectorStoresController.createVectorStore']);
    });

    const SURFACE: Array<{ method: 'get' | 'post' | 'delete'; url: string; handler: string }> = [
      { method: 'post', url: '/openrouter/api/v1/vector_stores', handler: 'createVectorStore' },
      { method: 'get', url: '/openrouter/api/v1/vector_stores', handler: 'listVectorStores' },
      { method: 'get', url: '/openrouter/api/v1/vector_stores/vs_1', handler: 'retrieveVectorStore' },
      { method: 'post', url: '/openrouter/api/v1/vector_stores/vs_1', handler: 'modifyVectorStore' },
      { method: 'delete', url: '/openrouter/api/v1/vector_stores/vs_1', handler: 'deleteVectorStore' },
      { method: 'post', url: '/openrouter/api/v1/vector_stores/vs_1/files', handler: 'createVectorStoreFile' },
      { method: 'get', url: '/openrouter/api/v1/vector_stores/vs_1/files', handler: 'listVectorStoreFiles' },
      { method: 'get', url: '/openrouter/api/v1/vector_stores/vs_1/files/file_1', handler: 'retrieveVectorStoreFile' },
      { method: 'post', url: '/openrouter/api/v1/vector_stores/vs_1/files/file_1', handler: 'modifyVectorStoreFile' },
      { method: 'delete', url: '/openrouter/api/v1/vector_stores/vs_1/files/file_1', handler: 'deleteVectorStoreFile' },
      { method: 'get', url: '/openrouter/api/v1/vector_stores/vs_1/files/file_1/content', handler: 'downloadVectorStoreFileContent' },
      { method: 'post', url: '/openrouter/api/v1/vector_stores/vs_1/file_batches', handler: 'createVectorStoreFileBatch' },
      { method: 'get', url: '/openrouter/api/v1/vector_stores/vs_1/file_batches/vsfb_1', handler: 'retrieveVectorStoreFileBatch' },
      { method: 'post', url: '/openrouter/api/v1/vector_stores/vs_1/file_batches/vsfb_1/cancel', handler: 'cancelVectorStoreFileBatch' },
      { method: 'get', url: '/openrouter/api/v1/vector_stores/vs_1/file_batches/vsfb_1/files', handler: 'listVectorStoreFileBatchFiles' },
      { method: 'post', url: '/openrouter/api/v1/vector_stores/vs_1/search', handler: 'searchVectorStore' },
    ];

    it.each(SURFACE)(
      'routes $method $url to vectorStoresController.$handler',
      async ({ method, url, handler }) => {
        const res = await request(server)[method](url);

        expect({ url, status: res.status }).toEqual({ url, status: 200 });
        expect(mockControllerCalls).toEqual([`vectorStoresController.${handler}`]);
      },
    );

    it('still serves the pre-existing OpenRouter Files surface', async () => {
      const res = await request(server).get('/openrouter/api/v1/files');

      expect(res.status).toBe(200);
      expect(mockControllerCalls).toEqual(['filesController.listFiles']);
    });
  });

  // -------------------------------------------------------------------------
  // 2. The guard. Removing '/openrouter/api/v1/files' and
  //    '/openrouter/api/v1/vector_stores' from the nulByteGuard mount list in
  //    src/index.ts turns these red, while the clean-request cases below stay
  //    green — that pairing is what proves the guard is reached and selective.
  // -------------------------------------------------------------------------
  describe('NUL bytes on the OpenRouter prefix are rejected with 400', () => {
    it('lists EVERY guarded prefix in the app-level nulByteGuard mount in src/index.ts', () => {
      // Exact equality, not arrayContaining. The /openrouter entries were the
      // only ones this file pinned, and nothing else in the tree pinned the
      // /openai ones: nul-byte-guard.test.ts and nul-byte-guard-routers.test.ts
      // both carry a "mirrors src/index.ts" comment and then hard-code their own
      // mounts, so deleting the /openai prefixes from that array left the whole
      // suite green. A set comparison is what makes this file the single place
      // that fails when the mount list changes.
      expect([...guardMountPaths].sort()).toEqual([
        '/openai/api/v1/files',
        '/openai/api/v1/vector_stores',
        '/openai/v1/files',
        '/openai/v1/vector_stores',
        '/openrouter/api/v1/files',
        '/openrouter/api/v1/vector_stores',
      ]);
    });

    it('rejects a NUL in an OpenRouter query cursor, matching the /openai prefixes', async () => {
      const res = await request(server).get('/openrouter/api/v1/files?after=abc%00def');

      expect(res.status).toBe(400);
      expect(res.body.error.type).toBe('invalid_request_error');
      expect(res.body.error.code).toBe('invalid_identifier');
      expect(mockControllerCalls).toEqual([]);
    });

    it('rejects a NUL in an OpenRouter vector-store query cursor', async () => {
      const res = await request(server).get('/openrouter/api/v1/vector_stores?before=vs%00cursor');

      expect(res.status).toBe(400);
      expect(res.body.error.type).toBe('invalid_request_error');
      expect(mockControllerCalls).toEqual([]);
    });

    it('rejects a NUL in an OpenRouter request body field', async () => {
      const res = await request(server)
        .post('/openrouter/api/v1/vector_stores')
        .send({ name: 'ok', file_ids: [`file-bad${NUL}id`] });

      expect(res.status).toBe(400);
      expect(res.body.error.type).toBe('invalid_request_error');
      expect(mockControllerCalls).toEqual([]);
    });

    it('rejects a NUL in a body file_id on the OpenRouter vector-store files route', async () => {
      const res = await request(server)
        .post('/openrouter/api/v1/vector_stores/vs_1/files')
        .send({ file_id: `file-bad${NUL}id` });

      expect(res.status).toBe(400);
      expect(mockControllerCalls).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 3. router.param coverage for the newly mounted vector-store path params.
  //    These come from openRouterRoutes.ts's own router.param registrations,
  //    not from the app-level guard — the app-level guard cannot see
  //    req.params at a static mount path (see nulByteGuard.ts).
  // -------------------------------------------------------------------------
  describe('NUL bytes in OpenRouter vector-store path params are rejected with 400', () => {
    const PARAM_CASES: Array<{ param: string; method: 'get' | 'post'; url: string }> = [
      { param: 'id', method: 'get', url: '/openrouter/api/v1/vector_stores/vs_abc%00def' },
      { param: 'file_id', method: 'get', url: '/openrouter/api/v1/vector_stores/vs_1/files/file_abc%00def' },
      { param: 'batch_id', method: 'post', url: '/openrouter/api/v1/vector_stores/vs_1/file_batches/vsfb_abc%00def/cancel' },
    ];

    it.each(PARAM_CASES)('rejects a NUL in :$param before the controller runs', async ({ method, url }) => {
      const res = await request(server)[method](url);

      expect(res.status).toBe(400);
      expect(res.body.error.type).toBe('invalid_request_error');
      expect(res.body.error.code).toBe('invalid_identifier');
      expect(mockControllerCalls).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 4. The clean-request cases. Without these, a guard that 400s EVERY request
  //    would pass every assertion above and look correct.
  // -------------------------------------------------------------------------
  describe('clean OpenRouter requests are not rejected', () => {
    it('serves a clean OpenRouter request — the guard is not rejecting everything', async () => {
      const res = await request(server).get('/openrouter/api/v1/files?after=file-abc');

      expect(res.status).not.toBe(400);
      expect(res.status).toBe(200);
      expect(mockControllerCalls).toEqual(['filesController.listFiles']);
    });

    it('serves a clean OpenRouter vector-store create with a file_ids array', async () => {
      const res = await request(server)
        .post('/openrouter/api/v1/vector_stores')
        .send({ name: 'ok', file_ids: ['file-a', 'file-b'] });

      expect(res.status).not.toBe(400);
      expect(res.status).toBe(200);
      expect(mockControllerCalls).toEqual(['vectorStoresController.createVectorStore']);
    });

    it('serves clean OpenRouter vector-store path params', async () => {
      const res = await request(server).get('/openrouter/api/v1/vector_stores/vs_1/files/file_1');

      expect(res.status).not.toBe(400);
      expect(res.status).toBe(200);
    });

    it('does not reject the literal two-character sequence backslash-zero', async () => {
      const res = await request(server).get('/openrouter/api/v1/vector_stores/vs%5C0-legit');

      expect(res.status).not.toBe(400);
      expect(res.status).toBe(200);
    });

    it('malicious and clean statuses differ on every guarded OpenRouter surface', async () => {
      const pairs = [
        { name: 'files query cursor', malicious: '/openrouter/api/v1/files?after=abc%00def', clean: '/openrouter/api/v1/files?after=abcdef' },
        { name: 'vector_stores query cursor', malicious: '/openrouter/api/v1/vector_stores?before=vs%00cursor', clean: '/openrouter/api/v1/vector_stores?before=vscursor' },
        { name: 'vector_stores :id', malicious: '/openrouter/api/v1/vector_stores/vs_abc%00def', clean: '/openrouter/api/v1/vector_stores/vs_abcdef' },
      ];

      for (const p of pairs) {
        const malicious = await request(server).get(p.malicious);
        const clean = await request(server).get(p.clean);

        expect({ case: p.name, malicious: malicious.status, clean: clean.status }).toEqual({
          case: p.name,
          malicious: 400,
          clean: 200,
        });
      }
    });
  });
});
