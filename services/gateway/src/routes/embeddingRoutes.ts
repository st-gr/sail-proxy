/**
 * Embedding routes with unified authentication
 */
import * as express from 'express';
import * as embeddingController from '../controllers/embeddingController';
import { createUnifiedTokenAuth } from '../middlewares/unifiedTokenAuth';
import rateLimiter from '../middlewares/rateLimiter';
import { unifiedAuthProxyService, serviceConfigurations } from '../services/unifiedAuthProxyService';

const router: express.Router = express.Router();

// Create unified auth middleware using environment variables
const embeddingAuth = createUnifiedTokenAuth();

// Service-specific middleware for embeddings
const embeddingServiceAuth = unifiedAuthProxyService.createServiceAuthMiddleware(serviceConfigurations.openai);
const embeddingRateLimit = unifiedAuthProxyService.createUnifiedRateLimitMiddleware(serviceConfigurations.openai);

// Ensure all requests include valid authentication and pass rate limiting
router.post('/', embeddingAuth, embeddingServiceAuth, embeddingRateLimit, rateLimiter, embeddingController.handleEmbedding);

export default router;