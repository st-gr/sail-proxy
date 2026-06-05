/**
 * Anthropic API routes with unified authentication
 */
import express from 'express';
import * as anthropicController from '../controllers/anthropicController';
import * as countTokensController from '../controllers/countTokensController';
import unifiedTokenAuth, { createUnifiedTokenAuth } from '../middlewares/unifiedTokenAuth';
import rateLimiter from '../middlewares/rateLimiter';
import { unifiedAuthProxyService, serviceConfigurations } from '../services/unifiedAuthProxyService';
import { getCachedUnifiedAuthConfig } from '../config/unifiedAuthConfig';

const router: express.Router = express.Router();

// Create unified auth middleware using environment variables
const anthropicAuth = createUnifiedTokenAuth();

// Service-specific middleware for Anthropic
const anthropicServiceAuth = unifiedAuthProxyService.createServiceAuthMiddleware(serviceConfigurations.anthropic);
const anthropicRateLimit = unifiedAuthProxyService.createUnifiedRateLimitMiddleware(serviceConfigurations.anthropic);

// Token counting endpoint (must be defined BEFORE /messages to avoid prefix matching)
// Uses lighter auth - no rate limiting for this read-only endpoint
router.post('/messages/count_tokens',
  anthropicAuth,
  countTokensController.handleCountTokens
);

// Main messages endpoint with unified authentication
router.post('/messages',
  anthropicAuth,
  anthropicServiceAuth,
  anthropicRateLimit,
  rateLimiter,
  anthropicController.handleMessages
);

// Support for Claude API v1 completion endpoint (backward compatibility)
router.post('/complete',
  anthropicAuth,
  anthropicServiceAuth,
  anthropicRateLimit,
  rateLimiter,
  anthropicController.handleMessages
);

// Support for beta endpoints
router.post('/messages-beta',
  anthropicAuth,
  anthropicServiceAuth,
  anthropicRateLimit,
  rateLimiter,
  anthropicController.handleMessages
);

export default router;