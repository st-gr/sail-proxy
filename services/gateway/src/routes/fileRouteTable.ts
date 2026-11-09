/**
 * The Files route table, declared ONCE and registered by both routers that
 * expose these endpoints — the same arrangement, and for the same reason, as
 * `vectorStoreRouteTable.ts`.
 *
 * The two callers apply authentication differently and cannot be merged:
 * `filesRoutes.ts` bakes the *openai* chain into every route, while
 * `openRouterRoutes.ts` applies its own chain once via a `router.use` above its
 * declarations. Nesting one inside the other would run two full auth chains per
 * request and consume two rate-limit slots.
 *
 * What that cost was a second, hand-maintained copy of the list. A route added
 * to one and forgotten in the other simply does not exist on that prefix, and
 * nothing fails — the identical hazard the vector-store table was extracted to
 * remove, left behind for Files at the time.
 */
import * as express from 'express';
import * as filesController from '../controllers/filesController';

interface FileRoute {
  method: 'get' | 'post' | 'delete';
  /** Relative to the caller's prefix. '' is the collection route. */
  path: string;
  handler: express.RequestHandler;
}

export const FILE_ROUTES: FileRoute[] = [
  { method: 'post', path: '', handler: filesController.uploadFile },
  { method: 'get', path: '', handler: filesController.listFiles },
  { method: 'get', path: '/:id', handler: filesController.retrieveFile },
  { method: 'delete', path: '/:id', handler: filesController.deleteFile },
  { method: 'get', path: '/:id/content', handler: filesController.downloadFileContent },
];

/**
 * Registers every Files route on `router` under `prefix`, with `guard` running
 * ahead of each handler.
 *
 * `guard` is per-route because that is how filesRoutes expresses its chain;
 * OpenRouter passes an empty array because its chain is already applied by a
 * `router.use` above. `router.param` guards stay with each router — they cover
 * routes this table does not declare.
 */
export function registerFileRoutes(
  router: express.Router,
  prefix: string,
  guard: express.RequestHandler[],
): void {
  for (const route of FILE_ROUTES) {
    // `prefix + ''` must not register the empty path — Express needs '/'.
    const fullPath = `${prefix}${route.path}` || '/';
    router[route.method](fullPath, ...guard, route.handler);
  }
}
