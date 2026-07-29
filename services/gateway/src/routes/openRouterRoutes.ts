/**
 * OpenRouter API routes with unified authentication
 */
import express from 'express';
import * as openRouterController from '../controllers/openRouterController';
import { handleResponses } from '../controllers/responsesController';
import { createUnifiedTokenAuth } from '../middlewares/unifiedTokenAuth';
import rateLimiter from '../middlewares/rateLimiter';
import { unifiedAuthProxyService, serviceConfigurations } from '../services/unifiedAuthProxyService';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

const router: express.Router = express.Router();

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

// Other REST endpoints
router.get('/models/:author/:slug/endpoints', openRouterController.getModelEndpoints);
router.get('/generation', openRouterController.getGenerationStats);
router.get('/credits', openRouterController.getCredits);

export default router;