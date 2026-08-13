/**
 * OpenRouter API routes with unified authentication
 */
import express from 'express';
import * as openRouterController from '../controllers/openRouterController';
import { handleResponses } from '../controllers/responsesController';
import { registerVectorStoreRoutes } from './vectorStoreRouteTable';
import { registerFileRoutes } from './fileRouteTable';
import { createUnifiedTokenAuth } from '../middlewares/unifiedTokenAuth';
import rateLimiter from '../middlewares/rateLimiter';
import { unifiedAuthProxyService, serviceConfigurations } from '../services/unifiedAuthProxyService';
import { nulByteParamGuard } from '../middlewares/nulByteGuard';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

const router: express.Router = express.Router();

// router.param fires for every route below that declares these params,
// regardless of where this router is mounted — unlike an app.use() at a static
// path, which runs before Express has populated req.params at all. :id reaches
// Postgres via filesController and vectorStoresController, as do :file_id and
// :batch_id; :author / :slug are forwarded into the upstream OpenRouter URL,
// where a NUL is equally illegitimate. See src/middlewares/nulByteGuard.ts for
// why this is needed.
router.param('id', nulByteParamGuard);
router.param('file_id', nulByteParamGuard);
router.param('batch_id', nulByteParamGuard);
router.param('author', nulByteParamGuard);
router.param('slug', nulByteParamGuard);

// Create unified auth middleware using environment variables
const openRouterAuth = createUnifiedTokenAuth();

// Service-specific middleware for OpenRouter
const openRouterServiceAuth = unifiedAuthProxyService.createServiceAuthMiddleware(serviceConfigurations.openrouter);
const openRouterRateLimit = unifiedAuthProxyService.createUnifiedRateLimitMiddleware(serviceConfigurations.openrouter);

// Apply unified authentication and rate limiting to all routes
router.use(openRouterAuth, openRouterServiceAuth, openRouterRateLimit, rateLimiter);

// Log all requests to OpenRouter routes
router.use((req, _res, next) => {
  logger.info('OpenRouterRoutes', `Received ${req.method} request to ${req.originalUrl}`);
  next();
});

// Core endpoints
router.post('/chat/completions', openRouterController.handleChatCompletions);
router.post('/completions', openRouterController.handleCompletions);
router.post('/responses', handleResponses);
router.get('/models', openRouterController.listModels);

// Files (file_search)
// Registered from the SAME table src/routes/filesRoutes.ts registers, so the
// two prefixes cannot drift. Empty guard: this router's auth/rate-limit chain
// is already applied by the router.use above.
registerFileRoutes(router, '/files', []);

// Vector stores (file_search).
//
// Registered from the SAME table src/routes/vectorStoresRoutes.ts registers,
// so the two prefixes cannot drift. This router still cannot simply mount that
// one: it applies the OpenRouter auth/rate-limit chain once via the
// `router.use(...)` at the top, whereas vectorStoresRoutes bakes the *openai*
// chain into every one of its own routes, and nesting them would run two full
// auth chains per request and consume two rate-limit slots. Hence an empty
// guard array here — the chain above already covers these paths.
//
// The Files paths above are still a hand-maintained second copy; only the
// vector-store table has been unified.
//
// Without these an OpenRouter client can upload a file and invoke the
// `file_search` tool but cannot create the vector store that tool needs.
registerVectorStoreRoutes(router, '/vector_stores', []);

// Other REST endpoints
router.get('/models/:author/:slug/endpoints', openRouterController.getModelEndpoints);
router.get('/generation', openRouterController.getGenerationStats);
router.get('/credits', openRouterController.getCredits);

export default router;