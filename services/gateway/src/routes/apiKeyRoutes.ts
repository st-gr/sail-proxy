import * as express from 'express';
import * as apiKeyController from '../controllers/apiKeyController';
import { gatewayStandaloneOnlyAuth } from '../middlewares/gatewayServiceAuth';
import { nulByteParamGuard } from '../middlewares/nulByteGuard';

const router: express.Router = express.Router();

// router.param fires for every route below that declares :key / :id, regardless
// of where this router is mounted — unlike an app.use() at a static path, which
// runs before Express has populated req.params at all. See
// src/middlewares/nulByteGuard.ts for why this is needed.
router.param('key', nulByteParamGuard);
router.param('id', nulByteParamGuard);

// Apply standalone-only authentication middleware
router.use(gatewayStandaloneOnlyAuth);

// These endpoints are now protected by standalone-only authentication
router.post('/', apiKeyController.createApiKey);
router.patch('/:key/revoke', apiKeyController.revokeApiKey);
router.get('/', apiKeyController.listApiKeys);
router.post('/revoke-by-email', apiKeyController.revokeApiKeysByEmail);
router.get('/:id', apiKeyController.getApiKeyById);
router.patch('/:id', apiKeyController.setApiKey);

export default router;