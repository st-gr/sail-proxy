import { Request, Response, NextFunction } from 'express';

import { getModels as getModelsService, getModelById as getModelByIdService, clearModelsCache as clearModelsCacheService } from '../services/modelService';
import { entitlementFromRequest, filterModels, isModelEntitled } from '../utils/modelEntitlement';

interface ModelRequest extends Request {
  query: {
    refresh?: string;
    include?: string;
  };
}

/** `?include=unroutable` — the one value the models list understands. */
const INCLUDE_UNROUTABLE = 'unroutable';

interface ModelByIdRequest extends Request {
  params: {
    model_id: string;
  };
  query: {
    refresh?: string;
  };
}

/**
 * Get all available models
 */
export const getModels = async (req: ModelRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    // Check for cache bypass in query string
    const forceRefresh = req.query.refresh === 'true';
    // Without ?include=unroutable this is the list it has always been: the models a request can
    // actually be routed to. With it, the foundation models SAP AI Core publishes that this
    // gateway cannot route come too, each marked routable:false — the admin's Model Library lists
    // them so an administrator can see what SAP AI Core offers.
    const includeUnroutable = req.query.include === INCLUDE_UNROUTABLE;
    const models = await getModelsService(forceRefresh, { includeUnroutable });
    const block = entitlementFromRequest(req);
    if (!block) {
      res.json(models);
      return;
    }
    res.json({ ...models, data: filterModels(block, models.data || []) });
  } catch (err) {
    next(err);
  }
};

/**
 * Get a specific model by ID
 */
export const getModelById = async (req: ModelByIdRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const modelId = req.params.model_id;
    // Check for cache bypass in query string
    const forceRefresh = req.query.refresh === 'true';
    const block = entitlementFromRequest(req);
    if (block && !isModelEntitled(block, modelId)) {
      res.status(404).json({ error: { message: `Model ${modelId} not found`, type: 'model_not_found_error', param: 'model' } });
      return;
    }
    const model = await getModelByIdService(modelId, forceRefresh);
    res.json(model);
  } catch (err) {
    next(err);
  }
};

/**
 * Clear the models cache
 */
export const clearModelsCache = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    clearModelsCacheService();
    res.json({ success: true, message: 'Models cache cleared' });
  } catch (err) {
    next(err);
  }
};