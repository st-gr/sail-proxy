/**
 * OpenAI Responses API routes with unified authentication
 */
import * as express from 'express';
import * as responsesController from '../controllers/responsesController';
import { createUnifiedTokenAuth } from '../middlewares/unifiedTokenAuth';
import rateLimiter from '../middlewares/rateLimiter';
import { unifiedAuthProxyService, serviceConfigurations } from '../services/unifiedAuthProxyService';

const router: express.Router = express.Router();

const responsesAuth = createUnifiedTokenAuth();
const responsesServiceAuth = unifiedAuthProxyService.createServiceAuthMiddleware(serviceConfigurations.openai);
const responsesRateLimit = unifiedAuthProxyService.createUnifiedRateLimitMiddleware(serviceConfigurations.openai);

router.post('/', responsesAuth, responsesServiceAuth, responsesRateLimit, rateLimiter, responsesController.handleResponses);

export default router;
