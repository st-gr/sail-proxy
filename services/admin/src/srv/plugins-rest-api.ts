/**
 * /api/plugins - the cockpit's Plugins app (spec 2026-11-04 §7). Admin only: a caller without a
 * signed-in identity gets 401, a signed-in user without the admin role 403, on every route.
 *
 *   GET    /                         the installed plugins, the built-ins, the gateways' status
 *   POST   /                         upload a package (body application/zip, at most 20 MB)
 *   POST   /:id/enable               { version }
 *   POST   /:id/disable              Content-Type: application/json (any body)
 *   POST   /:id/suggested-hooks      Content-Type: application/json (any body)
 *   POST   /suggested-hooks          { ids }  one configuration with the hooks of them all
 *   GET    /settings-schemas         ?lang=  the enabled plugins' settings schemas for the config form
 *   DELETE /:id/versions/:version
 *
 * The logic is in services/pluginOperations.ts; this file is the HTTP around it.
 */
import express from 'express';
import { getDefaultLogger } from '@libs/logger';
import { PLUGIN_PACKAGE_LIMITS } from '@libs/plugin-package';
import { adminOf } from './admin-caller';
import { listPlugins } from '../services/pluginListing';
import { disablePlugin, enablePlugin, removeVersion, uploadPackage } from '../services/pluginOperations';
import type { Actor, OperationResult } from '../services/pluginOperations';
import { listSettingsSchemas } from '../services/pluginSettingsSchemas';
import { addSuggestedHooks, addSuggestedHooksFor } from '../services/pluginSuggestedHooks';

const logger = getDefaultLogger();
const router: express.Router = express.Router();

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,64}$/;

// Docker and Kyma mount this router before any body parser; local dev may have a JSON parser in
// front, which leaves application/zip alone. The raw parser only takes that one type.
const rawZip = express.raw({ type: 'application/zip', limit: PLUGIN_PACKAGE_LIMITS.maxCompressedBytes });
const jsonBody = express.json({ limit: '10kb' });

function send(res: express.Response, result: OperationResult): void {
  res.status(result.status).json(result.body);
}

/** Wrap a handler: admin check first, then the action; an unexpected failure is a logged 500. */
function admin(handler: (req: express.Request, actor: Actor) => Promise<OperationResult>): express.RequestHandler {
  return async (req, res) => {
    const actor = adminOf(req, res);
    if (!actor) return;
    try {
      send(res, await handler(req, actor));
    } catch (error) {
      logger.error('PluginsRestApi', `${req.method} ${req.path} failed: ${(error as Error)?.message}`, error instanceof Error ? error : new Error(String(error)));
      res.status(500).json({ error: 'plugins_failed', message: 'The request could not be completed.' });
    }
  };
}

const badId = (req: express.Request): OperationResult | null =>
  !ID_PATTERN.test(req.params.id) || (req.params.version !== undefined && !VERSION_PATTERN.test(req.params.version))
    ? { status: 400, body: { error: 'invalid_id', message: 'The id or version is not valid.' } }
    : null;

// The role check runs in every handler, but the body parsers run first: the admin check must also come before
// a 20 MB body is read, so each parsing route is guarded once more ahead of its parser.
const guarded = (parser: express.RequestHandler): express.RequestHandler => (req, res, next) => {
  if (adminOf(req, res)) parser(req, res, next);
};

router.get('/', admin(async () => ({ status: 200, body: await listPlugins() })));

// Before any /:id route; an id of the same name is refused at upload as well.
router.get('/settings-schemas', admin(async (req) => listSettingsSchemas(req.query.lang)));

router.post('/', guarded(rawZip), admin((req, actor) =>
  uploadPackage(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), actor)));

router.post('/:id/enable', guarded(jsonBody), admin(async (req, actor) =>
  badId(req) ?? enablePlugin(req.params.id, req.body?.version, actor)));

// A POST with no body is a CORS simple request a foreign page can send with the admin's cookie; requiring
// a JSON content type forces a preflight, which the admin does not grant.
router.post('/:id/disable', admin(async (req, actor) =>
  badId(req) ?? (req.is('application/json')
    ? disablePlugin(req.params.id, actor)
    : { status: 415, body: { error: 'unsupported_media_type', message: 'Send Content-Type: application/json.' } })));

// Creates a stored configuration: the same cross-site guard as disable.
router.post('/:id/suggested-hooks', admin(async (req, actor) =>
  badId(req) ?? (req.is('application/json')
    ? addSuggestedHooks(req.params.id, actor)
    : { status: 415, body: { error: 'unsupported_media_type', message: 'Send Content-Type: application/json.' } })));

const MAX_IDS = 50;
const idsOf = (body: unknown): string[] | null => {
  const ids = (body as { ids?: unknown } | undefined)?.ids;
  return Array.isArray(ids) && ids.length > 0 && ids.length <= MAX_IDS && new Set(ids).size === ids.length
    && ids.every((id) => typeof id === 'string' && ID_PATTERN.test(id)) ? ids as string[] : null;
};

// Parsing only a JSON type leaves a form post without ids, so the type check answers first: the same guard.
router.post('/suggested-hooks', guarded(jsonBody), admin(async (req, actor) => {
  if (!req.is('application/json')) return { status: 415, body: { error: 'unsupported_media_type', message: 'Send Content-Type: application/json.' } };
  const ids = idsOf(req.body);
  return ids ? addSuggestedHooksFor(ids, actor) : { status: 400, body: { error: 'invalid_id', message: `Send "ids": 1 to ${MAX_IDS} distinct plugin ids.` } };
}));

router.delete('/:id/versions/:version', admin(async (req, actor) => badId(req) ?? removeVersion(req.params.id, req.params.version, actor)));

// A body over the limit: express answers entity.too.large; the library's name for it is TOO_LARGE.
router.use((error: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (error?.type === 'entity.too.large') {
    res.status(413).json({ error: 'TOO_LARGE', message: 'package exceeds 20 MB compressed' });
  } else if (error?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'invalid_json', message: 'The request body is not valid JSON.' });
  } else {
    next(error);
  }
});

module.exports = router;
