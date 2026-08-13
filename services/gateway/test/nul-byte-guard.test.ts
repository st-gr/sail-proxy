import request from 'supertest';
import express from 'express';
import { nulByteGuard } from '../src/middlewares/nulByteGuard';

// filesRoutes/vectorStoresRoutes transitively construct a SecureMetadataExchange
// singleton at *import* time (via unifiedTokenAuth -> unifiedApiKeyValidationService
// -> unifiedValidationCache -> libs/aws-token-validation), which throws unless a
// >=32-char key is already in the environment. test/setupTests.ts normally
// supplies VALIDATION_TOKEN_SECRET, but that runs as a Jest `beforeAll` hook,
// which fires only after this file's own top-level imports have already been
// evaluated — too late. Setting it here first, and requiring the routers via
// require() (so this line is guaranteed to execute before them, unlike a
// static `import` which TypeScript may reorder), avoids the load-time throw.
process.env.VALIDATION_TOKEN_SECRET = process.env.VALIDATION_TOKEN_SECRET || 'x'.repeat(32);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const filesRoutes = require('../src/routes/filesRoutes').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vectorStoresRoutes = require('../src/routes/vectorStoresRoutes').default;

// ---------------------------------------------------------------------------
// Function-level tests: call nulByteGuard(req, res, next) directly with a
// hand-built req. These validate the guard's own logic (hasNul, the body/
// query surface it scans, the response shape) but — as review caught — they
// cannot tell the difference between a guard that is actually mounted where
// Express populates req.params and one that isn't. See the "mounted through
// Express" describe block below for the test that actually exercises the
// production mount.
// ---------------------------------------------------------------------------
function run(req: any) {
  const res: any = { statusCode: 200, body: undefined,
    status(c: number) { this.statusCode = c; return this; },
    json(b: any) { this.body = b; return this; } };
  let nexted = false;
  nulByteGuard(req, res, () => { nexted = true; });
  return { res, nexted };
}

describe('nulByteGuard — called directly (function-level)', () => {
  it('rejects a NUL byte in a path param with 400, not 500', () => {
    const { res, nexted } = run({ params: { file_id: 'file-abc\0def' }, query: {}, body: {} });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.type).toBe('invalid_request_error');
  });

  it('rejects a NUL byte inside a file_ids array element', () => {
    const { res, nexted } = run({ params: {}, query: {}, body: { file_ids: ['file-ok', 'file-\0'] } });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(400);
  });

  it('rejects a NUL byte in a pagination cursor', () => {
    const { res, nexted } = run({ params: {}, query: { after: 'vs_\0cursor' }, body: {} });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(400);
  });

  it('does NOT reject the literal two-character sequence backslash-zero', () => {
    const { res, nexted } = run({ params: { file_id: 'file-\\0-legit' }, query: {}, body: {} });
    expect(nexted).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it('passes clean requests through untouched', () => {
    const { nexted } = run({ params: { file_id: 'file-abc' }, query: { after: 'vs_1' }, body: {} });
    expect(nexted).toBe(true);
  });

  it('does not scan large free-text body fields', () => {
    // A document's own content may legitimately contain odd bytes; the guard
    // covers identifiers and cursors only, not arbitrary payload text.
    const { nexted } = run({ params: {}, query: {},
      body: { attributes: { note: 'text with \0 inside' } } });
    expect(nexted).toBe(true);
  });

  it('does not crash on an absent params/query/body and treats them as clean', () => {
    const { nexted } = run({});
    expect(nexted).toBe(true);
  });

  it('does not crash on array- or string-typed bodies (multipart / raw passthrough shapes)', () => {
    expect(() => run({ params: {}, query: {}, body: ['not', 'an', 'object'] })).not.toThrow();
    expect(() => run({ params: {}, query: {}, body: 'raw string body' })).not.toThrow();
    expect(() => run({ params: {}, query: {}, body: undefined })).not.toThrow();
  });

  it('does not false-positive on an array-valued query param (repeated query key)', () => {
    const { nexted } = run({ params: {}, query: { id: ['file-a', 'file-b'] }, body: {} });
    expect(nexted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mounted-through-Express tests: this is the regression test for the defect
// review caught. Mounting nulByteGuard with app.use() ahead of a router that
// matches on a static path (no :params in the mount pattern itself, e.g.
// '/openai/api/v1/files') runs BEFORE Express populates req.params — params
// are only populated once a request matches a route *inside* the sub-router.
// So a guard relying on req.params at that mount point is dead code in
// production, even though it passes every function-level test above, which
// hand-builds req.params instead of letting Express populate it.
//
// The actual param protection lives in router.param('id'|'file_id',
// nulByteParamGuard) registered directly on filesRoutes.ts /
// vectorStoresRoutes.ts — router.param fires for every route on that router
// declaring the param, before that route's own middleware chain (including
// auth) runs, and — critically for this test — it fires regardless of how
// the router itself was mounted.
// ---------------------------------------------------------------------------
describe('nulByteGuard — mounted through Express (router.param covers req.params)', () => {
  let app: express.Express;
  // ONE listening server for the whole file, and every request below goes
  // through it.
  //
  // Passing the app instead of the server — supertest's other form — stands up
  // an EPHEMERAL server per call and tears it down when the response
  // completes. Under `forceExit: true`
  // plus parallel workers competing for cores, that teardown races the response
  // still being written, and the client reads a truncated or already-closed
  // socket. It surfaces as `Parse Error: Expected HTTP/, RTSP/ or ICE/` (the
  // parser hitting a non-response) or `socket hang up`, on a passing assertion,
  // intermittently — measured at roughly 4% of full-suite runs under load
  // across five suites that all shared this shape.
  let server: import('http').Server;

  beforeAll((done) => {
    app = express();
    app.use(express.json());
    // Mirrors src/index.ts's mount: the app.use-level guard covers the
    // body/query surface; router.param (registered inside the route files)
    // covers path params. Both are exercised here exactly as in production.
    app.use(
      ['/openai/api/v1/files', '/openai/api/v1/vector_stores'],
      nulByteGuard,
    );
    app.use('/openai/api/v1/files', filesRoutes);
    app.use('/openai/api/v1/vector_stores', vectorStoresRoutes);
    server = app.listen(0, () => done());
  });

  afterAll((done) => { server.close(() => done()); });

  // Unauthenticated in this bare test app, so a request that gets past the
  // NUL guard hits the router's own auth middleware next and is rejected
  // with 401. That 401 is the "reached the router" baseline throughout this
  // block — a guard that swallowed everything (rejecting the clean request
  // too) or a guard that was never mounted (letting the NUL byte through to
  // auth, which would also 401 it) would both fail these exact-status
  // assertions.
  const AUTH_BASELINE_STATUS = 401;

  it('rejects a NUL byte in a Files :id param with 400 — not the clean-request baseline', async () => {
    const clean = await request(server).get('/openai/api/v1/files/file-abc');
    const malicious = await request(server).get('/openai/api/v1/files/file-abc%00def');

    expect(clean.status).toBe(AUTH_BASELINE_STATUS);
    expect(malicious.status).toBe(400);
    expect(malicious.body.error.type).toBe('invalid_request_error');
  });

  it('rejects a NUL byte in a Vector Stores :id param with 400', async () => {
    const clean = await request(server).get('/openai/api/v1/vector_stores/vs_abc');
    const malicious = await request(server).get('/openai/api/v1/vector_stores/vs_abc%00def');

    expect(clean.status).toBe(AUTH_BASELINE_STATUS);
    expect(malicious.status).toBe(400);
    expect(malicious.body.error.type).toBe('invalid_request_error');
  });

  it('rejects a NUL byte in :file_id on a route carrying both :id and :file_id', async () => {
    const clean = await request(server).get('/openai/api/v1/vector_stores/vs_1/files/file_abc');
    const malicious = await request(server).get('/openai/api/v1/vector_stores/vs_1/files/file_abc%00');

    expect(clean.status).toBe(AUTH_BASELINE_STATUS);
    expect(malicious.status).toBe(400);
    expect(malicious.body.error.type).toBe('invalid_request_error');
  });

  it('lets a clean request reach the router — a guard that rejects everything fails this', async () => {
    const res = await request(server).get('/openai/api/v1/files/file-abc');
    expect(res.status).toBe(AUTH_BASELINE_STATUS);
  });
});
