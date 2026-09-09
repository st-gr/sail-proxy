/**
 * Chat completion routes (generic) with unified authentication
 */
import * as express from 'express';
import * as openaiController from '../controllers/openaiController';
import { createUnifiedTokenAuth } from '../middlewares/unifiedTokenAuth';
import quotaEnforcement from '../middlewares/quotaEnforcement';
import { unifiedAuthProxyService, serviceConfigurations } from '../services/unifiedAuthProxyService';

const router: express.Router = express.Router();

// Create unified auth middleware using environment variables
const chatAuth = createUnifiedTokenAuth();

// Service-specific middleware for OpenAI chat
const chatServiceAuth = unifiedAuthProxyService.createServiceAuthMiddleware(serviceConfigurations.openai);

// Ensure all requests include valid authentication and pass quota enforcement
router.post('/', chatAuth, chatServiceAuth, quotaEnforcement, openaiController.handleChatCompletion);

export default router;