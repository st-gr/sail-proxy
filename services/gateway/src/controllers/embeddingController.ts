import { Request, Response, NextFunction } from 'express';
import { EmbeddingRequest, EmbeddingResponse, SAPEmbeddingRequest, SAPEmbeddingResponse } from '@libs/types/api';
import sapAIService from '../services/sapAIService';
import modelService from '../services/modelService';
import { getDefaultLogger } from '@libs/logger';
import { createUsageMetrics, emitUsageEvent, updateTokenCounts } from '../utils/usageTracker';
import { enforceEntitlement } from '../utils/modelEntitlement';
import { resolveExternalTarget } from '../upstreams/externalTarget';
import { dispatchEmbeddings } from '../upstreams/embeddingsDispatch';
import { EMBED_BATCH_SIZE } from '../fileSearch/embedder';

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

    if (!enforceEntitlement(req, res, model)) return;

    // A Connection model goes to its connection, never to SAP (spec 2026-10-23 §5.3).
    const external = await resolveExternalTarget(req, res, model, 'openai', 'openai');
    if (external.kind === 'handled') return;
    if (external.kind === 'external') return dispatchEmbeddings(req, res, external.target, createUsageMetrics(), model);

    // SAP's embeddings input.text takes a string or an array of strings and returns one
    // index-tagged vector per element. Token-id inputs (number[] / number[][]) cannot be sent.
    const isTextInput = typeof input === 'string' ||
      (Array.isArray(input) && input.length > 0 && input.every(item => typeof item === 'string'));
    if (!isTextInput) {
      res.status(400).json({
        error: {
          message: 'input must be a string or a non-empty array of strings; token arrays are not supported',
          type: 'invalid_request_error',
          code: 'invalid_input'
        }
      });
      return;
    }
    if (Array.isArray(input) && input.length > EMBED_BATCH_SIZE) {
      res.status(400).json({
        error: {
          message: `input has ${input.length} elements; at most ${EMBED_BATCH_SIZE} are accepted per request`,
          type: 'invalid_request_error',
          code: 'invalid_input'
        }
      });
      return;
    }
    const textInput: string | string[] = input;

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
      // An upstream 4xx (e.g. SAP's 300000-token request limit) can never succeed on retry: pass it on.
      if (typeof error.status === 'number' && error.status >= 400 && error.status < 500) {
        res.status(error.status).json({
          error: {
            message: error.message,
            type: 'invalid_request_error',
            code: 'embedding_request_rejected'
          }
        });
        return;
      }
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