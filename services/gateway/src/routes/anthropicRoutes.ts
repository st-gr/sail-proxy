/**
 * Anthropic API routes with unified authentication
 */
import express from 'express';
import * as anthropicController from '../controllers/anthropicController';
import * as countTokensController from '../controllers/countTokensController';
import * as modelController from '../controllers/modelController';
import { nulByteParamGuard } from '../middlewares/nulByteGuard';
import unifiedTokenAuth, { createUnifiedTokenAuth } from '../middlewares/unifiedTokenAuth';
import quotaEnforcement from '../middlewares/quotaEnforcement';
import { unifiedAuthProxyService, serviceConfigurations } from '../services/unifiedAuthProxyService';
import { getCachedUnifiedAuthConfig } from '../config/unifiedAuthConfig';
import { toolGovernance, anthropicAdapter } from '../toolGovernance';

const router: express.Router = express.Router();

// Create unified auth middleware using environment variables
const anthropicAuth = createUnifiedTokenAuth();

// Service-specific middleware for Anthropic
const anthropicServiceAuth = unifiedAuthProxyService.createServiceAuthMiddleware(serviceConfigurations.anthropic);

// Token counting endpoint (must be defined BEFORE /messages to avoid prefix matching)
// Uses lighter auth - no rate limiting for this read-only endpoint
router.post('/messages/count_tokens',
  anthropicAuth,
  countTokensController.handleCountTokens
);

// Models list and lookup in Anthropic's format (n8n's credential test and model dropdown, the SDK's models.list())
router.param('model_id', nulByteParamGuard);
router.get('/models', anthropicAuth, modelController.getAnthropicModels);
router.get('/models/:model_id', anthropicAuth, modelController.getAnthropicModelById);

// Main messages endpoint with unified authentication
router.post('/messages',
  anthropicAuth,
  anthropicServiceAuth,
  toolGovernance(anthropicAdapter),
  quotaEnforcement,
  anthropicController.handleMessages
);

// Support for Claude API v1 completion endpoint (backward compatibility)
router.post('/complete',
  anthropicAuth,
  anthropicServiceAuth,
  toolGovernance(anthropicAdapter),
  quotaEnforcement,
  anthropicController.handleMessages
);

// Support for beta endpoints
router.post('/messages-beta',
  anthropicAuth,
  anthropicServiceAuth,
  toolGovernance(anthropicAdapter),
  quotaEnforcement,
  anthropicController.handleMessages
);

export default router;