import * as express from 'express';
import * as apiKeyController from '../controllers/apiKeyController';
import { gatewayStandaloneOnlyAuth } from '../middlewares/gatewayServiceAuth';

const router: express.Router = express.Router();

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