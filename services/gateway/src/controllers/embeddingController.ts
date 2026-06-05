import { Request, Response, NextFunction } from 'express';
import { EmbeddingRequest, EmbeddingResponse, SAPEmbeddingRequest, SAPEmbeddingResponse } from '@libs/types/api';
import sapAIService from '../services/sapAIService';
import modelService from '../services/modelService';
import { getDefaultLogger } from '@libs/logger';
import { createUsageMetrics, emitUsageEvent, updateTokenCounts } from '../utils/usageTracker';

const logger = getDefaultLogger();

interface EmbeddingRequestExtended extends Request {
  body: EmbeddingRequest;
  debugRequestId?: string;
}

/**
 * Handle embedding requests
 */
export const handleEmbedding = async (req: EmbeddingRequestExtended, res: Response, next: NextFunction): Promise<void> => {
  try {
    const startTime = Date.now();
    const { input, model, encoding_format = 'float', dimensions, user } = req.body;

    // Validate request
    if (!input || !model) {
      res.status(400).json({
        error: {
          message: 'Missing required fields: input and model are required',
          type: 'invalid_request_error',
          code: 'missing_required_fields'
        }
      });
      return;
    }

    // Handle array input - for now, we'll process the first input only (SAP AI Core v2 limitation)
    const textInput = Array.isArray(input) ? input[0] : input;
    
    if (Array.isArray(input) && input.length > 1) {
      logger.warn('EmbeddingController', `Multiple inputs provided but only first one will be processed. Model: ${model}`);
    }

    // Get model details to determine if it supports embeddings
    let modelDetail;
    try {
      modelDetail = await modelService.getModelById(model);
    } catch (error) {
      logger.error('EmbeddingController', `Model ${model} not found`);
      res.status(404).json({
        error: {
          message: `Model ${model} not found`,
          type: 'invalid_request_error',
          code: 'model_not_found'
        }
      });
      return;
    }

    // Check if model supports embedding
    const supportsEmbedding = modelDetail?.versions && modelDetail.versions.some((version: any) => {
      const capabilities = version.capabilities || [];
      return capabilities.includes('embedding');
    });

    if (!supportsEmbedding) {
      logger.error('EmbeddingController', `Model ${model} does not support embeddings`);
      res.status(400).json({
        error: {
          message: `Model ${model} does not support embeddings`,
          type: 'invalid_request_error',
          code: 'model_not_supported'
        }
      });
      return;
    }

    // Transform to SAP AI Core format
    const baseModelName = model.endsWith('--deployed') ? model.replace('--deployed', '') : model;
    const isNvidiaModel = baseModelName.toLowerCase().includes('nvidia');
    
    if (isNvidiaModel) {
      logger.debug('EmbeddingController', `Detected NVIDIA model ${baseModelName}, adding type: "query" parameter`);
    }
    
    const sapRequest: SAPEmbeddingRequest = {
      config: {
        modules: {
          embeddings: {
            model: {
              name: baseModelName
            }
          }
        }
      },
      input: {
        text: textInput,
        ...(isNvidiaModel && { type: "query" }) // Add type: "query" for NVIDIA models
      }
    };

    // Create usage metrics
    const usageMetrics = createUsageMetrics();

    let sapResponse: SAPEmbeddingResponse;
    
    try {
      // Call SAP AI Core embedding service
      sapResponse = await sapAIService.createEmbedding(sapRequest, model);
    } catch (error: any) {
      logger.error('EmbeddingController', `SAP AI Core embedding error: ${error.message}`);
      res.status(500).json({
        error: {
          message: 'Failed to generate embedding',
          type: 'api_error',
          code: 'embedding_generation_failed'
        }
      });
      return;
    }

    // Transform response to OpenAI format
    const openaiResponse: EmbeddingResponse = {
      object: 'list',
      data: sapResponse.final_result.data.map(item => ({
        object: 'embedding' as const,
        embedding: item.embedding,
        index: item.index
      })),
      model: model,
      usage: {
        prompt_tokens: sapResponse.final_result.usage.prompt_tokens,
        total_tokens: sapResponse.final_result.usage.total_tokens
      }
    };

    // Update usage metrics with token counts
    updateTokenCounts(
      usageMetrics,
      sapResponse.final_result.usage.prompt_tokens, // inputTokens
      0, // outputTokens (embeddings don't have output tokens)
      0, // cacheCreationInputTokens
      0  // cacheReadInputTokens
    );

    // Emit usage event
    emitUsageEvent(req, usageMetrics, model, 200);

    // Send response
    res.json(openaiResponse);

  } catch (error: any) {
    logger.error('EmbeddingController', `Unhandled error: ${error.message}`);
    next(error);
  }
};