import { Request, Response, NextFunction, RequestParamHandler } from 'express';

const NUL = '\0';

/**
 * Postgres text values cannot contain NUL. Without this guard a hostile or
 * malformed id reaches the driver and throws 22021, which surfaces as an
 * unhandled 500 carrying a raw driver string. Confirmed live during Plan 1.
 *
 * Scope is deliberate: identifiers and cursors only. Document content and
 * free-text attributes are not scanned — they have their own sanitization
 * path and a legitimate reason to carry unusual bytes.
 */
function hasNul(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(NUL);
  if (Array.isArray(value)) return value.some(hasNul);
  return false;
}

function sendNulByteError(res: Response): void {
  res.status(400).json({
    error: {
      message: 'Identifiers must not contain NUL bytes.',
      type: 'invalid_request_error',
      param: null,
      code: 'invalid_identifier',
    },
  });
}

/**
 * Body/query surface guard — mounted with `app.use()` ahead of the /files
 * and /vector_stores routers. Covers req.query (pagination cursors) and the
 * body's file_ids/file_id/vector_store_ids fields.
 *
 * Does NOT reliably see req.params: Express only populates req.params once
 * a request has matched a route *inside* the sub-router, which happens
 * after any app.use()-level middleware mounted ahead of that router has
 * already run. The req.params scan below is therefore live only for
 * middleware mounted deeper (e.g. inside a router, after its own route
 * pattern matched) — see nulByteParamGuard for the id/file_id path, which
 * is what actually protects route params in production.
 */
export function nulByteGuard(req: Request, res: Response, next: NextFunction): void {
  const suspects: unknown[] = [
    ...Object.values(req.params ?? {}),
    ...Object.values(req.query ?? {}),
    (req.body as any)?.file_ids,
    (req.body as any)?.file_id,
    (req.body as any)?.vector_store_ids,
  ];

  if (suspects.some(hasNul)) {
    sendNulByteError(res);
    return;
  }
  next();
}

/**
 * Route-param guard, registered per router via `router.param('id', ...)` /
 * `router.param('file_id', ...)` (see filesRoutes.ts, vectorStoresRoutes.ts).
 *
 * `router.param` is the correct mount point for this: it fires for every
 * route on the router that declares the named param, so a route added
 * later automatically inherits the guard — unlike inserting this into each
 * route's own middleware chain, which silently stops protecting a param
 * the first time a new route forgets to list it.
 */
export const nulByteParamGuard: RequestParamHandler = (_req, res, next, value) => {
  if (hasNul(value)) {
    sendNulByteError(res);
    return;
  }
  next();
};
