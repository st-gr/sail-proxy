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
    const notFound = () => res.status(404).json({ error: { message: `Model ${modelId} not found`, type: 'model_not_found_error', param: 'model' } });
    if (block && !isModelEntitled(block, modelId)) {
      notFound();
      return;
    }
    // null = the list does not contain the id (a list that cannot be fetched throws instead).
    const model = await getModelByIdService(modelId, forceRefresh);
    if (!model) {
      notFound();
      return;
    }
    res.json(model);
  } catch (err) {
    next(err);
  }
};

/** A gateway model as an entry of Anthropic's models list. */
function anthropicModel(model: any): { type: 'model'; id: string; display_name: string; created_at: string } {
  return { type: 'model', id: model.id, display_name: model.id, created_at: new Date((model.created || 0) * 1000).toISOString() };
}

// A Connection model says its family; the name and owner tests would catch an Anthropic connection's
// non-Claude model or a lookalike name on an OpenAI-family connection.
const isClaude = (model: any): boolean =>
  model?.accessType === 'external'
    ? model.family === 'claude'
    : String(model?.owned_by || '').toLowerCase() === 'anthropic' || String(model?.id || '').includes('claude');

/** The Claude models the caller may use. */
async function entitledClaudeModels(req: Request): Promise<any[]> {
  const models = await getModelsService(false);
  const block = entitlementFromRequest(req);
  const data = block ? filterModels(block, models.data || []) : models.data || [];
  return data.filter(isClaude);
}

/**
 * GET /anthropic/v1/models — the Claude models in Anthropic's list format (n8n's Anthropic
 * credential test and model dropdown, the Anthropic SDK's models.list()). One page holds them all.
 */
export const getAnthropicModels = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = (await entitledClaudeModels(req)).map(anthropicModel);
    res.json({ data, has_more: false, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null });
  } catch (err) {
    next(err);
  }
};

/** GET /anthropic/v1/models/:model_id — one Claude model, or Anthropic's not_found_error. */
export const getAnthropicModelById = async (req: ModelByIdRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const model = (await entitledClaudeModels(req)).find((m) => m.id === req.params.model_id);
    if (!model) {
      res.status(404).json({ type: 'error', error: { type: 'not_found_error', message: `model: ${req.params.model_id}` } });
      return;
    }
    res.json(anthropicModel(model));
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