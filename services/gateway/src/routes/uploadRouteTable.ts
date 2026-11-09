/**
 * The Uploads API route table (OpenAI's `/uploads`), declared once and registered by the two
 * OpenAI-compatible routers — `uploadsRoutes.ts` (the openai prefixes, auth chain per route) and
 * `openRouterRoutes.ts` (under its router-wide chain) — for the reason `fileRouteTable.ts` gives.
 * The cockpit's grounding router (`groundingRoutes.ts`) re-registers the Files handlers but
 * deliberately has no uploads mount: the cockpit uploads whole files only.
 */
import * as express from 'express';
import * as uploadsController from '../controllers/uploadsController';

interface UploadRoute {
  method: 'post';
  /** Relative to the caller's prefix. '' is the collection route. */
  path: string;
  handler: express.RequestHandler;
}

export const UPLOAD_ROUTES: UploadRoute[] = [
  { method: 'post', path: '', handler: uploadsController.createUpload },
  { method: 'post', path: '/:id/parts', handler: uploadsController.addPart },
  { method: 'post', path: '/:id/complete', handler: uploadsController.completeUpload },
  { method: 'post', path: '/:id/cancel', handler: uploadsController.cancelUpload },
];

/** Registers every Uploads route on `router` under `prefix`, `guard` ahead of each handler. */
export function registerUploadRoutes(
  router: express.Router,
  prefix: string,
  guard: express.RequestHandler[],
): void {
  for (const route of UPLOAD_ROUTES) {
    const fullPath = `${prefix}${route.path}` || '/';
    router[route.method](fullPath, ...guard, route.handler);
  }
}
