// Pins that BOTH routers actually register the shared vector-store route
// table, and that each keeps the auth shape it is responsible for.
//
// Why this file exists: before the table was extracted, the 16 vector-store
// routes were declared twice by hand — once in vectorStoresRoutes.ts with the
// openai auth chain baked into every route, once in openRouterRoutes.ts under
// a router-wide chain. A route added to one and forgotten in the other simply
// did not exist on that prefix and nothing failed.
//
// Extracting the table makes that drift impossible by construction, but only
// for as long as both routers keep going through the registrar. Deleting an
// entry from the table used to fail exactly one test, on the OpenRouter side:
// openRouterVectorStores.test.ts pins every OpenRouter path, while nothing
// pinned the openai router's route set at all — its suite exercises the
// controller directly, not the router. This file closes that half, so the
// table has a test on each side of it.
process.env.VALIDATION_TOKEN_SECRET = process.env.VALIDATION_TOKEN_SECRET || 'x'.repeat(32);

import { VECTOR_STORE_ROUTES } from '../src/routes/vectorStoreRouteTable';
import { FILE_ROUTES } from '../src/routes/fileRouteTable';

/** The (method, path) pairs an Express router has actually registered. */
function registeredRoutes(router: any): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  for (const layer of router.stack ?? []) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      out.push({ method, path: layer.route.path });
    }
  }
  return out;
}

/** How many handlers run for a given route, the last of which is the controller. */
function handlerCount(router: any, method: string, path: string): number {
  for (const layer of router.stack ?? []) {
    if (layer.route?.path === path && layer.route.methods[method]) {
      return layer.route.stack.length;
    }
  }
  throw new Error(`route not registered: ${method.toUpperCase()} ${path}`);
}

describe('the shared vector-store route table', () => {
  // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
  const vectorStoresRoutes = require('../src/routes/vectorStoresRoutes').default;
  // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
  const openRouterRoutes = require('../src/routes/openRouterRoutes').default;

  const sortKey = (r: { method: string; path: string }): string => `${r.method} ${r.path}`;

  // Written out rather than derived from VECTOR_STORE_ROUTES. Deriving both
  // sides of the comparison from the table would make these tests tautological:
  // deleting an entry would change the expectation with the code and stay
  // green, which is exactly the drift they exist to catch.
  const EXPECTED_PATHS = [
    'post ',
    'get ',
    'get /:id',
    'post /:id',
    'delete /:id',
    'post /:id/files',
    'get /:id/files',
    'get /:id/files/:file_id',
    'post /:id/files/:file_id',
    'delete /:id/files/:file_id',
    'get /:id/files/:file_id/content',
    'post /:id/file_batches',
    'get /:id/file_batches/:batch_id',
    'post /:id/file_batches/:batch_id/cancel',
    'get /:id/file_batches/:batch_id/files',
    'post /:id/search',
  ];

  it('declares exactly the sixteen routes both prefixes are expected to serve', () => {
    expect(VECTOR_STORE_ROUTES.map((r) => `${r.method} ${r.path}`).sort())
      .toEqual([...EXPECTED_PATHS].sort());
  });

  it('is registered in full on the openai router, at the router root', () => {
    const expected = EXPECTED_PATHS.map((r) => r.replace(/^(\w+) (.*)$/, (_m, m, p) => `${m} ${p || '/'}`)).sort();
    const actual = registeredRoutes(vectorStoresRoutes).map(sortKey).sort();

    expect(actual).toEqual(expected);
  });

  it('is registered in full on the OpenRouter router, under /vector_stores', () => {
    const expected = EXPECTED_PATHS
      .map((r) => r.replace(/^(\w+) (.*)$/, (_m, m, p) => `${m} /vector_stores${p}`)).sort();
    const actual = registeredRoutes(openRouterRoutes)
      .filter((r) => r.path.startsWith('/vector_stores'))
      .map(sortKey).sort();

    expect(actual).toEqual(expected);
  });

  it('keeps each router\'s auth shape: per-route chain on openai, router-wide on OpenRouter', () => {
    // vectorStoresRoutes passes a four-middleware guard per route (unified token
    // auth, service auth, unified rate limit, rateLimiter) plus the controller.
    // openRouterRoutes passes none, because its chain is applied by a
    // router.use above — the reason the two cannot share one router. If these
    // ever converge, the registrar is being called with the wrong guard and one
    // prefix is either unauthenticated or double-charged for rate limiting.
    expect(handlerCount(vectorStoresRoutes, 'post', '/:id/search')).toBe(5);
    expect(handlerCount(openRouterRoutes, 'post', '/vector_stores/:id/search')).toBe(1);
  });
});

// The Files routes had the identical duplication and were left behind when the
// vector-store table was extracted. Same pins, same reasons.
describe('the shared Files route table', () => {
  // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
  const filesRoutes = require('../src/routes/filesRoutes').default;
  // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
  const openRouterRoutes = require('../src/routes/openRouterRoutes').default;

  const sortKey = (r: { method: string; path: string }): string => `${r.method} ${r.path}`;

  // Written out, not derived from FILE_ROUTES — deriving both sides of the
  // comparison would make a deleted entry change the expectation with the code.
  const EXPECTED = ['post ', 'get ', 'get /:id', 'delete /:id', 'get /:id/content'];

  it('declares exactly the five routes both prefixes serve', () => {
    expect(FILE_ROUTES.map((r) => `${r.method} ${r.path}`).sort()).toEqual([...EXPECTED].sort());
  });

  it('is registered in full on the openai router, at the router root', () => {
    const expected = EXPECTED.map((r) => r.replace(/^(\w+) (.*)$/, (_m, m, p) => `${m} ${p || '/'}`)).sort();
    expect(registeredRoutes(filesRoutes).map(sortKey).sort()).toEqual(expected);
  });

  it('is registered in full on the OpenRouter router, under /files', () => {
    const expected = EXPECTED.map((r) => r.replace(/^(\w+) (.*)$/, (_m, m, p) => `${m} /files${p}`)).sort();
    const actual = registeredRoutes(openRouterRoutes)
      .filter((r) => r.path === '/files' || r.path.startsWith('/files/'))
      .map(sortKey).sort();
    expect(actual).toEqual(expected);
  });

  it('keeps each router\'s auth shape', () => {
    expect(handlerCount(filesRoutes, 'get', '/:id')).toBe(5);        // 4 guards + controller
    expect(handlerCount(openRouterRoutes, 'get', '/files/:id')).toBe(1);
  });
});
