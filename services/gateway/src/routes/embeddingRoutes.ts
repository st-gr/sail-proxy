/**
 * Embedding routes with unified authentication
 */
import * as express from 'express';
import * as embeddingController from '../controllers/embeddingController';
import { createUnifiedTokenAuth } from '../middlewares/unifiedTokenAuth';
import quotaEnforcement from '../middlewares/quotaEnforcement';
import { unifiedAuthProxyService, serviceConfigurations } from '../services/unifiedAuthProxyService';

const router: express.Router = express.Router();

// Create unified auth middleware using environment variables
const embeddingAuth = createUnifiedTokenAuth();

// Service-specific middleware for embeddings
const embeddingServiceAuth = unifiedAuthProxyService.createServiceAuthMiddleware(serviceConfigurations.openai);

// Ensure all requests include valid authentication and pass quota enforcement
router.post('/', embeddingAuth, embeddingServiceAuth, quotaEnforcement, embeddingController.handleEmbedding);

export default router;