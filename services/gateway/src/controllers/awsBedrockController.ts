import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

// Use require for CommonJS modules
import awsBedrockService from '../services/awsBedrockService';
import configService from '../services/configService';
import modelService from '../services/modelService';
import { executeBeforePlugins, executeAfterPlugins } from '../services/pluginExecutor';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();
import { createUsageMetrics, emitUsageEvent, updateTokenCounts } from '../utils/usageTracker';
import { isPayloadLoggingEnabled } from '../utils/payloadLogger';

interface BedrockRequest extends Request {
  params: {
    modelId: string;
    subpath: string;
  };
  body: {
    model?: string;
    messages?: any[];
    stream?: boolean;
    [key: string]: any;
  };
  debugRequestId?: string;
}

interface ModelDetails {
  executableId?: string;
  [key: string]: any;
}

interface PluginResult {
  stop: boolean;
  [key: string]: any;
}

/**
 * Handle AWS Bedrock requests for all model operations
 */
export const handleBedrockRequest = async (req: BedrockRequest, res: Response, _next: NextFunction): Promise<void> => {
  // Generate a debug request ID whenever payload logging can occur — via the
  // legacy DEBUG env or the dynamic config switch (hot-reloadable per request).
  const payloadLoggingActive = process.env.DEBUG === 'true' || isPayloadLoggingEnabled();
  const debugRequestId = payloadLoggingActive ? (req.debugRequestId || uuidv4()) : undefined;
  req.debugRequestId = debugRequestId;
  logger.info('AwsBedrockController', `Processing request for model: ${req.params.modelId}, subpath: ${req.params.subpath}, Debug ID: ${debugRequestId}`);

  // Initialize usage tracking
  const usageMetrics = createUsageMetrics();

  try {
    const { modelId, subpath } = req.params;
    const originalModelFromClient = modelId;

    // Validate subpath
    const validSubpaths = ['invoke', 'invoke-with-response-stream', 'converse', 'converse-stream'];
    if (!validSubpaths.includes(subpath)) {
      res.status(400).json({
        error: {
          message: `Invalid subpath: ${subpath}. Valid subpaths are: ${validSubpaths.join(', ')}`,
          type: 'invalid_request_error',
          param: 'subpath'
        }
      });
      return;
    }

    // Get substituted model name
    const substitutedModelName = configService.getSubstitutedModel('aws-bedrock', originalModelFromClient);
    logger.info('AwsBedrockController', `Model: ${originalModelFromClient}${substitutedModelName !== originalModelFromClient ? ` → ${substitutedModelName} (substituted)` : ''}`);

    // Get model details and validate it's an AWS Bedrock model
    const modelDetails: ModelDetails | null = await modelService.getModelDetails(substitutedModelName);
    if (!modelDetails) {
      res.status(404).json({
        error: {
          message: `Model ${substitutedModelName} not found`,
          type: 'model_not_found_error',
          param: 'model'
        }
      });
      return;
    }

    // Validate it's an AWS Bedrock model by checking executableId
    if (modelDetails.executableId !== 'aws-bedrock') {
      res.status(400).json({
        error: {
          message: `Model ${substitutedModelName} is not an AWS Bedrock model (executableId: ${modelDetails.executableId || 'undefined'})`,
          type: 'invalid_request_error',
          param: 'model'
        }
      });
      return;
    }

    // Determine if streaming is requested
    const isStreamingSubpath = subpath.includes('stream');
    
    // Set appropriate response headers
    if (isStreamingSubpath) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Cache-Control');
    } else {
      res.setHeader('Content-Type', 'application/json');
    }

    // Get any hook configuration for this model+subpath
    (req as any).__endpoint = 'aws-bedrock';
    const hookConfig = configService.getHookConfig(substitutedModelName, subpath, 'aws-bedrock');
    
    // Execute any 'before' strategy plugins
    if (hookConfig) {
      const pluginResult: PluginResult = await executeBeforePlugins(req, res, hookConfig);
      
      // If plugin returns { stop: true }, short-circuit the request
      if (pluginResult.stop) {
        logger.info('AwsBedrockController', `Plugin short-circuited request for ${substitutedModelName}/${subpath}`);
        return; // Response already sent by plugin
      }
    }
    
    // Process the request through the service
    const result = await awsBedrockService.processBedrockRequest({
      modelId: substitutedModelName,
      originalModelId: originalModelFromClient,
      subpath,
      requestBody: req.body,
      headers: req.headers as Record<string, string>,
      debugRequestId: debugRequestId || '',
      req,
      res,
      hookConfig, // Pass hook config for 'after' strategy execution
      usageMetrics // Pass usage metrics for tracking
    });

    // Extract usage information from result for tracking
    if (result && typeof result === 'object' && result.usage) {
      if (result.usage.inputTokens !== undefined && result.usage.outputTokens !== undefined) {
        // AWS Bedrock format
        updateTokenCounts(usageMetrics, result.usage.inputTokens || 0, result.usage.outputTokens || 0);
      } else if (result.usage.input_tokens !== undefined && result.usage.output_tokens !== undefined) {
        // Anthropic-transformed format
        updateTokenCounts(usageMetrics, result.usage.input_tokens || 0, result.usage.output_tokens || 0);
      }
    }

    // Emit usage event only for non-streaming requests
    // Streaming requests emit usage events from within the streaming handler
    if (!isStreamingSubpath) {
      // Determine provider based on request endpoint
      let provider = 'aws-bedrock'; // Default provider
      const requestPath = req.originalUrl || req.path || req.url || '';
      
      if (requestPath.includes('/anthropic/')) {
        provider = 'anthropic';
      } else if (requestPath.includes('/openai/')) {
        provider = 'openai';  
      }
      
      emitUsageEvent(req, usageMetrics, substitutedModelName, 200);
    }

    // Execute 'after' plugins AFTER getting the result
    if (hookConfig) {
      logger.info('AwsBedrockController', 'Executing after plugins');
      const afterResult = await executeAfterPlugins(req, res, result, hookConfig);
      
      // Handle non-streaming responses
      if (!isStreamingSubpath) {
        res.json(afterResult || result);
      }
    } else {
      // Handle non-streaming responses (no after plugins)
      if (!isStreamingSubpath) {
        res.json(result);
      }
    }
    // Streaming responses are handled directly by the service

  } catch (error: any) {
    logger.error('AwsBedrockController', 'Error processing request:', error, {
      code: error.code,
      isTimeout: error.isAxiosError && error.code === 'ECONNABORTED'
    });
    
    // Determine appropriate status code
    let statusCode = 500;
    if (error.status) {
      statusCode = error.status;
    } else if (error.message?.includes('not found')) {
      statusCode = 404;
    } else if (error.message?.includes('invalid') || error.message?.includes('unsupported')) {
      statusCode = 400;
    }

    // Emit usage event for error case
    // Determine provider based on request endpoint
    let provider = 'aws-bedrock'; // Default provider
    const requestPath = req.originalUrl || req.path || req.url || '';
    if (requestPath.includes('/anthropic/')) {
      provider = 'anthropic';
    } else if (requestPath.includes('/openai/')) {
      provider = 'openai';
    }
    
    // Use substituted model name for consistency with ModelCosts table
    const substitutedModelForError = configService.getSubstitutedModel('aws-bedrock', req.params.modelId);
    emitUsageEvent(req, usageMetrics, substitutedModelForError, statusCode);
    
    // Check if response has already been sent (streaming case)
    if (res.headersSent) {
      logger.error('AwsBedrockController', 'Error occurred after response headers sent - cannot send error response');
      return;
    }

    res.status(statusCode).json({
      error: {
        message: error.message || 'Internal server error',
        type: error.type || 'api_error',
        code: statusCode,
        details: process.env.DEBUG === 'true' ? error.details : undefined
      }
    });
  }
};