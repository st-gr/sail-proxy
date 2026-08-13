/**
 * OpenAI-compatible file_search vector-store routes, with unified
 * authentication — mirrors services/gateway/src/routes/filesRoutes.ts.
 */
import * as express from 'express';
import * as vectorStoresController from '../controllers/vectorStoresController';
import { createUnifiedTokenAuth } from '../middlewares/unifiedTokenAuth';
import rateLimiter from '../middlewares/rateLimiter';
import { unifiedAuthProxyService, serviceConfigurations } from '../services/unifiedAuthProxyService';
import { nulByteParamGuard } from '../middlewares/nulByteGuard';
import { registerVectorStoreRoutes } from './vectorStoreRouteTable';

const router: express.Router = express.Router();

// router.param fires for every route below that declares :id / :file_id /
// :batch_id — unlike a per-route guard, it cannot be silently skipped by a
// route added later. See src/middlewares/nulByteGuard.ts for why this is
// needed at all: an unguarded id carrying a NUL reaches Postgres as raw text
// and throws 22021, surfacing as an unhandled 500 with a raw driver message.
router.param('id', nulByteParamGuard);
router.param('file_id', nulByteParamGuard);
router.param('batch_id', nulByteParamGuard);

const vectorStoresAuth = createUnifiedTokenAuth();
const vectorStoresServiceAuth = unifiedAuthProxyService.createServiceAuthMiddleware(serviceConfigurations.openai);
const vectorStoresRateLimit = unifiedAuthProxyService.createUnifiedRateLimitMiddleware(serviceConfigurations.openai);

const guard = [vectorStoresAuth, vectorStoresServiceAuth, vectorStoresRateLimit, rateLimiter];

// Declared in src/routes/vectorStoreRouteTable.ts and registered from there,
// because openRouterRoutes.ts must expose the identical set under its own
// prefix and cannot mount this router (it would run two auth chains per
// request). See that file for the full reasoning.
registerVectorStoreRoutes(router, '', guard);

export default router;
