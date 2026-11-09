/**
 * The vector-store route table, declared ONCE and registered by both routers
 * that expose these endpoints.
 *
 * Why a table and a registrar rather than one shared router: the two callers
 * apply authentication differently and cannot be merged.
 * `vectorStoresRoutes.ts` bakes the *openai* chain into every route, while
 * `openRouterRoutes.ts` applies its own chain once via a `router.use` above its
 * route declarations. Mounting one router inside the other would run two full
 * auth chains per request and consume two rate-limit slots — which is why the
 * OpenRouter side re-declared the paths in the first place.
 *
 * What that re-declaration cost was a second, hand-maintained copy of the route
 * list: 16 vector-store routes, and with the Files paths a 21-entry table that
 * had to be kept in step by hand. A route added to one and forgotten in the
 * other simply does not exist on that prefix, and nothing fails. Declaring the
 * paths here and registering them from both places removes that failure mode
 * without merging the auth chains.
 */
import * as express from 'express';
import * as vectorStoresController from '../controllers/vectorStoresController';

interface VectorStoreRoute {
  method: 'get' | 'post' | 'delete';
  /** Relative to the caller's prefix. '' is the collection route. */
  path: string;
  handler: express.RequestHandler;
}

export const VECTOR_STORE_ROUTES: VectorStoreRoute[] = [
  { method: 'post', path: '', handler: vectorStoresController.createVectorStore },
  { method: 'get', path: '', handler: vectorStoresController.listVectorStores },
  { method: 'get', path: '/:id', handler: vectorStoresController.retrieveVectorStore },
  { method: 'post', path: '/:id', handler: vectorStoresController.modifyVectorStore },
  { method: 'delete', path: '/:id', handler: vectorStoresController.deleteVectorStore },

  { method: 'post', path: '/:id/files', handler: vectorStoresController.createVectorStoreFile },
  { method: 'get', path: '/:id/files', handler: vectorStoresController.listVectorStoreFiles },
  { method: 'get', path: '/:id/files/:file_id', handler: vectorStoresController.retrieveVectorStoreFile },
  { method: 'post', path: '/:id/files/:file_id', handler: vectorStoresController.modifyVectorStoreFile },
  { method: 'delete', path: '/:id/files/:file_id', handler: vectorStoresController.deleteVectorStoreFile },
  {
    method: 'get',
    path: '/:id/files/:file_id/content',
    handler: vectorStoresController.downloadVectorStoreFileContent,
  },

  // `file_batches` is a distinct literal segment from `files`, so these never
  // compete with the routes above for a match regardless of registration order.
  { method: 'post', path: '/:id/file_batches', handler: vectorStoresController.createVectorStoreFileBatch },
  {
    method: 'get',
    path: '/:id/file_batches/:batch_id',
    handler: vectorStoresController.retrieveVectorStoreFileBatch,
  },
  {
    method: 'post',
    path: '/:id/file_batches/:batch_id/cancel',
    handler: vectorStoresController.cancelVectorStoreFileBatch,
  },
  {
    method: 'get',
    path: '/:id/file_batches/:batch_id/files',
    handler: vectorStoresController.listVectorStoreFileBatchFiles,
  },

  { method: 'post', path: '/:id/search', handler: vectorStoresController.searchVectorStore },
];

/**
 * Registers every vector-store route on `router` under `prefix`, with `guard`
 * running ahead of each handler.
 *
 * `guard` is per-route because that is how vectorStoresRoutes expresses its
 * chain; OpenRouter passes an empty array because its chain is already applied
 * by a `router.use` above. Neither caller registers `router.param` guards here
 * — those belong to each router, which is also where the NUL-byte param guard
 * has to live to cover routes this table does not declare.
 */
export function registerVectorStoreRoutes(
  router: express.Router,
  prefix: string,
  guard: express.RequestHandler[],
): void {
  for (const route of VECTOR_STORE_ROUTES) {
    // `prefix + ''` must not register the empty path — Express needs '/'.
    const fullPath = `${prefix}${route.path}` || '/';
    router[route.method](fullPath, ...guard, route.handler);
  }
}
