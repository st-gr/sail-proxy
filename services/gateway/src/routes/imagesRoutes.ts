/**
 * OpenAI Images API routes (generations, edits) with unified authentication —
 * the chain every LLM route mounts (see responsesRoutes.ts / filesRoutes.ts).
 */
import * as express from 'express';
import * as imagesController from '../controllers/imagesController';
import { createUnifiedTokenAuth } from '../middlewares/unifiedTokenAuth';
import quotaEnforcement from '../middlewares/quotaEnforcement';
import { unifiedAuthProxyService, serviceConfigurations } from '../services/unifiedAuthProxyService';

const router: express.Router = express.Router();

const imagesAuth = createUnifiedTokenAuth();
const imagesServiceAuth = unifiedAuthProxyService.createServiceAuthMiddleware(serviceConfigurations.openai);
const guard = [imagesAuth, imagesServiceAuth, quotaEnforcement];

router.post('/generations', ...guard, imagesController.generateImage);
router.post('/edits', ...guard, imagesController.editImage);

export default router;
