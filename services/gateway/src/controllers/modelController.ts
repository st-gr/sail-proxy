import { Request, Response, NextFunction } from 'express';

import { getModels as getModelsService, getModelById as getModelByIdService, clearModelsCache as clearModelsCacheService } from '../services/modelService';

interface ModelRequest extends Request {
  query: {
    refresh?: string;
  };
}

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
    const models = await getModelsService(forceRefresh);
    res.json(models);
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