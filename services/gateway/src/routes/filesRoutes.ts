/**
 * OpenAI-compatible file_search Files routes, with unified authentication —
 * mirrors services/gateway/src/routes/responsesRoutes.ts.
 */
import * as express from 'express';
import * as filesController from '../controllers/filesController';
import { createUnifiedTokenAuth } from '../middlewares/unifiedTokenAuth';
import rateLimiter from '../middlewares/rateLimiter';
import { unifiedAuthProxyService, serviceConfigurations } from '../services/unifiedAuthProxyService';
import { nulByteParamGuard } from '../middlewares/nulByteGuard';
import { registerFileRoutes } from './fileRouteTable';

const router: express.Router = express.Router();

// router.param fires for every route below that declares :id — unlike a
// per-route guard, it cannot be silently skipped by a route added later.
// See src/middlewares/nulByteGuard.ts for why this is needed at all.
router.param('id', nulByteParamGuard);

const filesAuth = createUnifiedTokenAuth();
const filesServiceAuth = unifiedAuthProxyService.createServiceAuthMiddleware(serviceConfigurations.openai);
const filesRateLimit = unifiedAuthProxyService.createUnifiedRateLimitMiddleware(serviceConfigurations.openai);

const guard = [filesAuth, filesServiceAuth, filesRateLimit, rateLimiter];

// Declared in src/routes/fileRouteTable.ts and registered from there, because
// openRouterRoutes.ts must expose the identical set under its own prefix and
// cannot mount this router (it would run two auth chains per request).
registerFileRoutes(router, '', guard);

export default router;
