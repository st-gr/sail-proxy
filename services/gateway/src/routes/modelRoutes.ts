import express from 'express';
import * as modelController from '../controllers/modelController';
import { createUnifiedTokenAuth } from '../middlewares/unifiedTokenAuth';

const router: express.Router = express.Router();

// Create unified auth middleware using environment variables
const modelAuth = createUnifiedTokenAuth();

// Apply unified authentication middleware to all routes
router.use(modelAuth);

// GET /v1/models - List all models
router.get('/', modelController.getModels);

// GET /v1/models/:model_id - Get specific model
router.get('/:model_id', modelController.getModelById);

// POST /v1/models/cache/clear - Clear models cache (admin route)
router.post('/cache/clear', modelController.clearModelsCache);

export default router;