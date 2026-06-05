/**
 * Chat completion routes (generic) with unified authentication
 */
import * as express from 'express';
import * as openaiController from '../controllers/openaiController';
import { createUnifiedTokenAuth } from '../middlewares/unifiedTokenAuth';
import rateLimiter from '../middlewares/rateLimiter';
import { unifiedAuthProxyService, serviceConfigurations } from '../services/unifiedAuthProxyService';

const router: express.Router = express.Router();

// Create unified auth middleware using environment variables
const chatAuth = createUnifiedTokenAuth();

// Service-specific middleware for OpenAI chat
const chatServiceAuth = unifiedAuthProxyService.createServiceAuthMiddleware(serviceConfigurations.openai);
const chatRateLimit = unifiedAuthProxyService.createUnifiedRateLimitMiddleware(serviceConfigurations.openai);

// Ensure all requests include valid authentication and pass rate limiting
router.post('/', chatAuth, chatServiceAuth, chatRateLimit, rateLimiter, openaiController.handleChatCompletion);

export default router;