/**
 * OpenRouter API Controller
 * Handles requests for OpenRouter API endpoints
 */
import { Request, Response, NextFunction } from 'express';
import * as openaiController from './openaiController';
import crypto from 'crypto';

// Import TypeScript modules
import configService from '../services/configService';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();
import * as payloadLogger from '../utils/payloadLogger';
import openRouterService from '../services/openRouterService';

interface OpenRouterRequest extends Request {
  body: {
    model: string;
    max_tokens?: number;
    [key: string]: any;
  };
  debugRequestId?: string;
  openRouterRequest?: boolean;
}

interface ModelMapping {
  provider: string;
  max_tokens?: number;
}

interface OpenRouterConfig {
  model_mappings?: ModelMapping[];
}

/**
 * Handle chat completions by forwarding to OpenAI controller
 * The OpenRouter API is compatible with the OpenAI API, so we can reuse the OpenAI controller
 */
export const handleChatCompletions = async (req: OpenRouterRequest, res: Response, next: NextFunction): Promise<any> => {
  logger.info('OpenRouterController', 'Forwarding chat completion request to OpenAI controller');
  
  // Store original model for usage tracking
  const originalModel = req.body.model;
  
  // Ensure a debugRequestId exists and log the original request payload
  if (!req.debugRequestId) {
    // Generate a unique ID for this request to enable payload logging
    req.debugRequestId = `or-${crypto.randomBytes(8).toString('hex')}-${Date.now()}`;
    logger.info('OpenRouterController', `Generated new debugRequestId for OpenRouter request: ${req.debugRequestId}`);
    
    // Log the original incoming request body
    payloadLogger.savePayload(req.debugRequestId, '00_original_openrouter_request', req.body, req);
  }
  
  // Add a flag to indicate this is an OpenRouter request for usage tracking
  (req as any).isOpenRouterRequest = true;
  (req as any).originalOpenRouterModel = originalModel;
  
  // Add openrouter-specific request handling if needed
  if (req.body.model && !req.body.model.includes('/')) {
    logger.warn('OpenRouterController', `Model '${req.body.model}' doesn't include provider prefix. OpenRouter requires provider prefix.`);
  }
  
  // Process model name - remove provider prefix if present
  let provider: string | undefined;
  let modelName: string | undefined;
  let mappedModel: string | undefined;
  
  if (req.body.model && req.body.model.includes('/')) {
    const originalModel = req.body.model;
    [provider, modelName] = originalModel.split('/');
    
    // If max_tokens is not provided, check for a default in the config for the provider
    if (req.body.max_tokens === undefined) {
      const openRouterConfig = configService.get('openrouter') as OpenRouterConfig;
      if (openRouterConfig && openRouterConfig.model_mappings) {
        const providerMapping = openRouterConfig.model_mappings.find(
          m => provider && m.provider.toLowerCase() === provider.toLowerCase()
        );
        if (providerMapping && providerMapping.max_tokens) {
          req.body.max_tokens = providerMapping.max_tokens;
          logger.info('OpenRouterController', `Setting default max_tokens=${providerMapping.max_tokens} for provider '${provider}'`);
        }
      }
    }
    
    // Map provider-specific model names to the format expected by the system
    mappedModel = modelName || req.body.model;
    
    // Handle special mapping cases
    if (provider?.toLowerCase() === 'anthropic') {
      // Log the original model for debugging
      logger.debug('OpenRouterController', `Processing Anthropic model: ${modelName}`);
      
      // Handle case where model already has the prefix 
      if (modelName?.startsWith('anthropic--')) {
        mappedModel = modelName;
        logger.debug('OpenRouterController', `Model already has anthropic-- prefix: ${modelName}`);
      } else if (modelName?.startsWith('claude-3.5-sonnet') || modelName === 'claude-3-5-sonnet-20241022') {
        // Specific handling for Claude 3.5 Sonnet variants
        mappedModel = `anthropic--claude-3.5-sonnet`;
        logger.debug('OpenRouterController', `Mapping Claude 3.5 Sonnet to: ${mappedModel}`);
      } else if (modelName && modelName.startsWith('claude-') && (modelName.includes('claude-3') || modelName.includes('claude-4'))) {
        // For other newer claude models that need the prefix
        mappedModel = `anthropic--${modelName}`;
        logger.debug('OpenRouterController', `Adding anthropic-- prefix to Claude model: ${mappedModel}`);
      } else {
        // For other anthropic models, keep as-is
        mappedModel = modelName || req.body.model;
        logger.debug('OpenRouterController', `Keeping Anthropic model name as-is: ${mappedModel}`);
      }
    } else if (provider && provider.toLowerCase() === 'openai') {
      // For OpenAI models, typically no prefix needed
      mappedModel = modelName || req.body.model;
      logger.debug('OpenRouterController', `OpenAI model mapped to: ${mappedModel}`);
    } else if (provider && provider.toLowerCase() === 'google') {
      // For Google models, remove the provider prefix to match pricing cache
      mappedModel = modelName || req.body.model;
      logger.debug('OpenRouterController', `Google model mapped to: ${mappedModel}`);
    }
    
    // Clean up any potential double prefixes (like anthropic--anthropic--)
    if (mappedModel?.startsWith('anthropic--anthropic--')) {
      mappedModel = mappedModel.replace('anthropic--anthropic--', 'anthropic--');
      logger.debug('OpenRouterController', `Fixed double prefix in model name: ${mappedModel}`);
    }
    
    req.body.model = mappedModel || req.body.model;
    logger.info('OpenRouterController', `Converting model name from '${originalModel}' to '${req.body.model}'`);
    
    // Apply model substitution from config
    const substitutedModel = configService.getSubstitutedModel('openrouter', req.body.model);
    if (substitutedModel !== req.body.model) {
      logger.info('OpenRouterController', `Substituting model from '${req.body.model}' to '${substitutedModel}'`);
      req.body.model = substitutedModel;
    }
    
    // Update the model name for usage tracking to match pricing cache
    (req as any).originalOpenRouterModel = req.body.model;
  }

  // Set a request flag to identify OpenRouter requests
  req.openRouterRequest = true;
  
  // Usage tracking is now handled by the OpenAI controller using request flags

  // Forward request to OpenAI controller with proper error handling
  try {
    // Let OpenAI controller handle the complete request-response cycle
    await openaiController.handleChatCompletion(req as any, res, (err: any) => {
      if (err) {
        next(err);
      }
    });
    // OpenAI controller has already sent the response, nothing more to do
    return;
  } catch (error: any) {
    logger.error('OpenRouterController', `Error in chat completions: ${error.message}`);
    
    if (!res.headersSent) {
      return res.status(500).json({
        error: {
          message: 'Error processing chat completion',
          type: 'server_error'
        }
      });
    } else {
      logger.debug('OpenRouterController', 'Error occurred after response was already sent');
    }
  }
};

/**
 * Handle model listing
 */
export const listModels = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  logger.info('OpenRouterController', 'Handling model listing request');
  logger.debug('OpenRouterController', `Request headers: ${JSON.stringify(req.headers)}`);
  
  try {
    // Forward to the service that will handle OpenRouter model format
    // Use the imported openRouterService
    logger.info('OpenRouterController', 'Calling openRouterService.getModels()');
    const models = await openRouterService.getModels();
    logger.debug('OpenRouterController', `Models response: ${JSON.stringify(models).substring(0, 100)}...`);
    res.json(models);
  } catch (error: any) {
    logger.error('OpenRouterController', `Error listing models: ${error.message}`);
    next(error);
  }
};

interface ModelEndpointsRequest extends Request {
  params: {
    author: string;
    slug: string;
  };
}

/**
 * Handle model endpoints (provider-specific SKUs)
 */
export const getModelEndpoints = async (req: ModelEndpointsRequest, res: Response, next: NextFunction): Promise<void> => {
  const { author, slug } = req.params;
  logger.info('OpenRouterController', `Handling model endpoints request for ${author}/${slug}`);
  
  try {
    // Use the imported openRouterService
    const endpoints = await openRouterService.getModelEndpoints(author, slug);
    res.json(endpoints);
  } catch (error: any) {
    logger.error('OpenRouterController', `Error getting model endpoints: ${error.message}`);
    next(error);
  }
};

/**
 * Handle legacy completions (non-chat API)
 */
export const handleCompletions = async (req: OpenRouterRequest, res: Response, next: NextFunction): Promise<any> => {
  logger.info('OpenRouterController', 'Handling legacy completions request');
  
  // OpenRouter allows both /completions and /chat/completions to work the same way
  return handleChatCompletions(req, res, next);
};

/**
 * Handle generation stats request
 */
export const getGenerationStats = (_req: Request, res: Response): void => {
  logger.info('OpenRouterController', 'Handling generation stats request');
  
  // Not implemented - return placeholder response
  res.json({
    status: 'not_implemented',
    message: 'Generation stats endpoint is not implemented in this proxy service'
  });
};

/**
 * Handle credits request
 */
export const getCredits = (_req: Request, res: Response): void => {
  logger.info('OpenRouterController', 'Handling credits request');
  
  // Not implemented - return placeholder response
  res.json({
    status: 'not_implemented',
    message: 'Credits endpoint is not implemented in this proxy service',
    object: 'credit_summary',
    credits: null
  });
};