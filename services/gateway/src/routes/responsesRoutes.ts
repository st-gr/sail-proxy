/**
 * OpenAI Responses API routes with unified authentication
 */
import * as express from 'express';
import * as responsesController from '../controllers/responsesController';
import { createUnifiedTokenAuth } from '../middlewares/unifiedTokenAuth';
import quotaEnforcement from '../middlewares/quotaEnforcement';
import { unifiedAuthProxyService, serviceConfigurations } from '../services/unifiedAuthProxyService';

const router: express.Router = express.Router();

const responsesAuth = createUnifiedTokenAuth();
const responsesServiceAuth = unifiedAuthProxyService.createServiceAuthMiddleware(serviceConfigurations.openai);

router.post('/', responsesAuth, responsesServiceAuth, quotaEnforcement, responsesController.handleResponses);

export default router;
