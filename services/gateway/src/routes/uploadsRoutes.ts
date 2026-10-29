/**
 * OpenAI-compatible Uploads routes (file_search), with the Files routes' chain — mirrors
 * src/routes/filesRoutes.ts.
 */
import * as express from 'express';
import { createUnifiedTokenAuth } from '../middlewares/unifiedTokenAuth';
import quotaEnforcement from '../middlewares/quotaEnforcement';
import { unifiedAuthProxyService, serviceConfigurations } from '../services/unifiedAuthProxyService';
import { nulByteParamGuard } from '../middlewares/nulByteGuard';
import { registerUploadRoutes } from './uploadRouteTable';

const router: express.Router = express.Router();

// See filesRoutes.ts: router.param covers every route below that declares :id.
router.param('id', nulByteParamGuard);

const uploadsAuth = createUnifiedTokenAuth();
const uploadsServiceAuth = unifiedAuthProxyService.createServiceAuthMiddleware(serviceConfigurations.openai);

const guard = [uploadsAuth, uploadsServiceAuth, quotaEnforcement];

registerUploadRoutes(router, '', guard);

export default router;
