import express from 'express';
import * as awsBedrockController from '../controllers/awsBedrockController';
import { createUnifiedTokenAuth } from '../middlewares/unifiedTokenAuth';
import rateLimiter from '../middlewares/rateLimiter';
import { unifiedAuthProxyService, serviceConfigurations } from '../services/unifiedAuthProxyService';

const router: express.Router = express.Router();

// Create unified auth middleware using environment variables
const bedrockAuth = createUnifiedTokenAuth();

// Service-specific middleware for Bedrock
const bedrockServiceAuth = unifiedAuthProxyService.createServiceAuthMiddleware(serviceConfigurations.bedrock);
const bedrockRateLimit = unifiedAuthProxyService.createUnifiedRateLimitMiddleware(serviceConfigurations.bedrock);

// Conditional authentication middleware - use unified auth only if not AWS authenticated
const conditionalUnifiedAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if ((req as any).isAwsAuthenticated) {
    // Skip unified authentication if AWS SigV4 authentication was successful
    return next();
  }
  // Otherwise, use unified authentication
  return bedrockAuth(req, res, next);
};

// Apply conditional authentication and rate limiting middleware to all routes
router.use(conditionalUnifiedAuth, bedrockServiceAuth, bedrockRateLimit, rateLimiter);

/**
 * AWS Bedrock API routes
 * Handles requests for specific Bedrock models and operations
 * 
 * Supported endpoints:
 * POST /model/{modelId}/invoke
 * POST /model/{modelId}/invoke-with-response-stream
 * POST /model/{modelId}/converse
 * POST /model/{modelId}/converse-stream
 */

// Dynamic route to handle all Bedrock model operations
router.post('/model/:modelId/:subpath', awsBedrockController.handleBedrockRequest);

export default router;