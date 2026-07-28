import { Request, Response, NextFunction } from 'express';
import axios, { AxiosResponse } from 'axios';

// Use require for CommonJS modules to avoid import issues in mixed JS/TS environment
import sapAIService from '../services/sapAIService';
import * as sseWriter from '../utils/sseWriter';
import * as modelUtils from '../utils/modelUtils';
import modelService from '../services/modelService';
import * as imageUtils from '../utils/imageUtils';
import configService from '../services/configService';
import { executeBeforePlugins, executeAfterPlugins } from '../services/pluginExecutor';
import * as payloadLogger from '../utils/payloadLogger';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();
import { createUsageMetrics, emitUsageEvent, updateTokenCounts } from '../utils/usageTracker';
import {
  isUnsupportedParam,
  stripUnsupportedParams,
  applyParamRenames,
  defaultParamRenames,
  OPENAI_COMPATIBLE_DEPLOYMENT_PROVIDERS,
} from '../utils/unsupportedParamFilter';
import type { SapV2CompletionRequest } from '../services/sapOrchestrationTypes';

// Type definitions
interface OpenAIRequest extends Request {
  body: OpenAIRequestBody;
  debugRequestId?: string;
  useEmulatedStreaming?: boolean;
  emulatedStreaming?: boolean;
  query: {
    beta?: string;
    [key: string]: any;
  };
}

interface OpenAIRequestBody {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  top_p?: number;
  stop?: string | string[];
  top_k?: number;
  stream_options?: any;
  [key: string]: any;
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenAIMessageContent[];
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface OpenAIMessageContent {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: {
    url: string;
    detail?: string;
  } | string;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface ModelDetails {
  id?: string;
  owned_by?: string;
  provider?: string;
  deploymentUrl?: string;
  [key: string]: any;
}

// V2 wire payload — see services/sapOrchestrationTypes.ts.
// `messages_history` is OpenAIMessage[] in this codebase (the OpenAI controller
// uses the same shape as the API messages), which is structurally compatible
// with V2's ChatMessages.
type SAPPayload = SapV2CompletionRequest & {
  messages_history: OpenAIMessage[];
};



interface StreamChunk {
  error?: boolean;
  canceled?: boolean;
  message?: string;
  status?: number;
  details?: any;
  done?: boolean;
  chunkNumber?: number;
  nonStreamingResponse?: any;
  useEmulatedStreaming?: boolean;
  [key: string]: any;
}

interface PluginResult {
  stop: boolean;
  response?: any;
}

interface HookConfig {
  request?: {
    match: any;
    callback: {
      id: string;
    };
  };
}

/**
 * Handle OpenAI chat completion requests
 */
export const handleChatCompletion = async (req: OpenAIRequest, res: Response, next: NextFunction): Promise<void> => {
  // Debug log
  logger.info('openaiController', `handleChatCompletion called with model=${req.body.model}, stream=${req.body.stream}`);
  const requestStartTime = Date.now();
  const debugRequestId = req.debugRequestId;
  const originalModelFromRequest = req.body.model;

  // Initialize usage tracking
  const usageMetrics = createUsageMetrics();

  // --- BEGIN DEPLOYED MODEL HANDLING ---
  if (originalModelFromRequest && originalModelFromRequest.endsWith('--deployed')) {
    try {
      logger.info('openaiController', `Handling request for deployed model: ${originalModelFromRequest}`);
      const modelDetails = await modelService.getModelDetails(originalModelFromRequest);

      if (!modelDetails || !modelDetails.deploymentUrl) {
        logger.error('openaiController', `Deployment details (especially deploymentUrl) not found for ${originalModelFromRequest}`);
        return next(new Error(`Deployment details not found for ${originalModelFromRequest}`));
      }

      // Check if deployed model is embedding-only
      if (modelDetails?.versions) {
        const isEmbeddingOnly = modelDetails.versions.every((version: any) => {
          const capabilities = version.capabilities || [];
          return capabilities.includes('embedding') && 
                 !capabilities.some((cap: string) => 
                   cap.includes('text-generation') || 
                   cap.includes('chat') || 
                   cap.includes('completion')
                 );
        });
        
        if (isEmbeddingOnly) {
          logger.error('openaiController', `Deployed model ${originalModelFromRequest} is embedding-only and cannot be used for chat completions`);
          res.status(400).json({
            error: {
              message: `Model ${originalModelFromRequest} is designed for embeddings and cannot be used for chat completions. Use the embeddings endpoint instead.`,
              type: 'invalid_request_error',
              code: 'model_not_supported'
            }
          });
          return;
        }
      }

      const deployedModelProvider = modelDetails.provider?.toLowerCase() || modelDetails.owned_by?.toLowerCase();
      logger.info('openaiController', `Deployed model ${originalModelFromRequest} - Provider: ${deployedModelProvider}, Deployment URL: ${modelDetails.deploymentUrl}`);

      let finalDeploymentUrl = modelDetails.deploymentUrl;
      // Providers whose SAP AI Core deployments expose an OpenAI-compatible
      // /chat/completions endpoint. Posting to the bare deployment URL 404s, so
      // the path must be appended (webSearchPlugin does the same for Perplexity).
      // Anthropic deployments use a different (Bedrock-style) contract and are
      // intentionally NOT handled on this route.
      if (OPENAI_COMPATIBLE_DEPLOYMENT_PROVIDERS.includes(deployedModelProvider)) {
        if (!finalDeploymentUrl.endsWith('/chat/completions')) {
          finalDeploymentUrl = `${finalDeploymentUrl}/chat/completions`;
        }

        // api-version is Azure-OpenAI specific; Perplexity deployments reject it.
        if (deployedModelProvider === 'openai') {
          const apiVersion = configService.getOpenAIDeploymentApiVersion();
          if (apiVersion) {
            // Append api-version query parameter
            finalDeploymentUrl = `${finalDeploymentUrl}?api-version=${apiVersion}`;
          }
        }
        logger.info('openaiController', `Constructed final URL for deployed ${deployedModelProvider} model: ${finalDeploymentUrl}`);
      }

      let deploymentPayload = { ...req.body };
      const clientRequestedStream = deploymentPayload.stream === true;
      delete deploymentPayload.stream; // Direct call to deploymentUrl is non-streaming

      // The deployment knows only its upstream model name, not our `--deployed`
      // alias (Perplexity rejects it: "Model 'sonar--deployed' is not allowed,
      // supported model: sonar."). Send the real name for OpenAI-compatible
      // deployments; Anthropic deployments are not served on this route.
      if (OPENAI_COMPATIBLE_DEPLOYMENT_PROVIDERS.includes(deployedModelProvider) && modelDetails.model) {
        if (modelDetails.model !== deploymentPayload.model) {
          logger.info('openaiController',
            `Deployed model ${originalModelFromRequest} -> upstream model name '${modelDetails.model}'`);
        }
        deploymentPayload.model = modelDetails.model;
      }

      // This branch forwards the raw client body, so strip parameters the
      // provider rejects (same guard as the orchestration path below).
      const deployedDropped = stripUnsupportedParams(
        deploymentPayload,
        configService.getUnsupportedParams(deployedModelProvider, originalModelFromRequest)
      );
      if (deployedDropped.length > 0) {
        logger.warn('openaiController',
          `Dropped ${deployedDropped.length} parameter(s) not supported by provider '${deployedModelProvider}' for deployed model ${originalModelFromRequest}: ${deployedDropped.join(', ')}`);
      }

      // Rename params this deployment expects under a different name (e.g.
      // gpt-5.x requires max_completion_tokens instead of max_tokens).
      // Built-in renames by model family (e.g. gpt-5+ / o-series need
      // max_completion_tokens); config overrides per key.
      const deployedRenamed = applyParamRenames(deploymentPayload, {
        ...defaultParamRenames(deployedModelProvider, originalModelFromRequest),
        ...configService.getParamRenames(deployedModelProvider, originalModelFromRequest),
      });
      if (deployedRenamed.length > 0) {
        logger.info('openaiController',
          `Renamed parameter(s) for deployed model ${originalModelFromRequest}: ${deployedRenamed.join(', ')}`);
      }

      if (debugRequestId) {
        payloadLogger.savePayload(debugRequestId, '01a_deployed_request_payload_to_url_openai', deploymentPayload, req);
      }

      const authToken = await modelService.getAuthToken();
      logger.info('openaiController', `Calling deployment URL: ${finalDeploymentUrl} for model ${originalModelFromRequest}`);

      const aiResourceGroup = process.env.SAP_AI_RESOURCE_GROUP || 'default';
      const deploymentResponse: AxiosResponse = await axios.post(finalDeploymentUrl, deploymentPayload, {
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'AI-Resource-Group': aiResourceGroup,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });

      const latencyMs = Date.now() - requestStartTime;
      logger.info('openaiController', `Response from deployment URL for ${originalModelFromRequest} (status ${deploymentResponse.status}) received in ${latencyMs}ms.`);

      if (debugRequestId) {
        payloadLogger.savePayload(debugRequestId, '03a_deployed_response_from_url_openai', deploymentResponse.data, req, res);
      }

      // Track usage from deployment response
      if (deploymentResponse.data && deploymentResponse.data.usage) {
        updateTokenCounts(
          usageMetrics,
          deploymentResponse.data.usage.prompt_tokens || 0,
          deploymentResponse.data.usage.completion_tokens || 0
        );
      }

      // Response Handling. OpenAI-compatible deployments (incl. Perplexity)
      // already return an OpenAI-shaped chat.completion, so pass it straight
      // through. Other providers (Anthropic) need a transformation that this
      // route does not implement — they fall through to the error below.
      if (OPENAI_COMPATIBLE_DEPLOYMENT_PROVIDERS.includes(deployedModelProvider)) {
        // Determine provider name based on request source
        const providerName = (req as any).isOpenRouterRequest ? 'openrouter' : 'openai';
        const modelName = (req as any).isOpenRouterRequest ? (req as any).originalOpenRouterModel || originalModelFromRequest : originalModelFromRequest;
        
        // Emit usage event for successful deployed model request
        emitUsageEvent(req, usageMetrics, modelName, deploymentResponse.status);
        
        if (clientRequestedStream && configService.shouldEmulateStreaming('openai', originalModelFromRequest)) {
          logger.warn('openaiController', `Client requested stream and emulation is configured for deployed model ${originalModelFromRequest}. Using full response-to-stream emulation.`);
          emulateOpenAIStreamFromFullResponse(res, deploymentResponse.data, originalModelFromRequest);
        } else {
          res.json(deploymentResponse.data); // Send as is (non-streaming)
        }
      } else {
        // Deployed model's provider does NOT match "openai"
        logger.error('openaiController', `Provider mismatch for deployed model ${originalModelFromRequest}. Deployed provider: ${deployedModelProvider}, Route: openai. Cross-provider transformation of deployed model response not yet implemented.`);
        
        // Determine provider name based on request source
        const providerName = (req as any).isOpenRouterRequest ? 'openrouter' : 'openai';
        const modelName = (req as any).isOpenRouterRequest ? (req as any).originalOpenRouterModel || originalModelFromRequest : originalModelFromRequest;
        
        // Emit usage event for error case
        emitUsageEvent(req, usageMetrics, modelName, 400);
        
        return next(new Error(`Provider mismatch: Deployed model is ${deployedModelProvider}. Transformation to OpenAI format from this provider's direct response is not yet supported.`));
      }
      return; // Deployed model request handled

    } catch (error: any) {
      logger.error('openaiController', `Error handling deployed model ${originalModelFromRequest}:`, error.response?.data || error.message);
      
      // Determine provider name based on request source
      const providerName = (req as any).isOpenRouterRequest ? 'openrouter' : 'openai';
      const modelName = (req as any).isOpenRouterRequest ? (req as any).originalOpenRouterModel || originalModelFromRequest : originalModelFromRequest;
      
      // Emit usage event for deployed model error case
      const statusCode = error.response?.status || 500;
      emitUsageEvent(req, usageMetrics, modelName, statusCode);
      
      const enhancedError = new Error(`Failed to process deployed model ${originalModelFromRequest}: ${error.message}`) as any;
      enhancedError.status = statusCode;
      enhancedError.details = error.response?.data;
      return next(enhancedError);
    }
  }
  // --- END DEPLOYED MODEL HANDLING ---

  // Existing logic for non-deployed models follows...

  try {
    const { stream } = req.body;
    // Check for beta flag in query parameters
    const isBeta = req.query.beta === 'true';
    logger.info('openaiController', `Request received with stream=${stream}${isBeta ? ', beta=true' : ''}`);
    
    // Validate that the model is not embedding-only
    try {
      const modelDetails = await modelService.getModelDetails(originalModelFromRequest);
      if (modelDetails?.versions) {
        const isEmbeddingOnly = modelDetails.versions.every((version: any) => {
          const capabilities = version.capabilities || [];
          return capabilities.includes('embedding') && 
                 !capabilities.some((cap: string) => 
                   cap.includes('text-generation') || 
                   cap.includes('chat') || 
                   cap.includes('completion')
                 );
        });
        
        if (isEmbeddingOnly) {
          logger.error('openaiController', `Model ${originalModelFromRequest} is embedding-only and cannot be used for chat completions`);
          res.status(400).json({
            error: {
              message: `Model ${originalModelFromRequest} is designed for embeddings and cannot be used for chat completions. Use the embeddings endpoint instead.`,
              type: 'invalid_request_error',
              code: 'model_not_supported'
            }
          });
          return;
        }
      }
    } catch (modelValidationError: any) {
      // If model validation fails, log but continue (model might not exist yet)
      logger.warn('openaiController', `Could not validate model ${originalModelFromRequest}: ${modelValidationError.message}`);
    }
    
    // Transform the incoming OpenAI API request to SAP AI Core orchestration format.
    // Note that this is now an async call
    const payload = await transformRequestToSAPFormat(req.body);

    // Determine subPath for hook config
    const subPath = req.body.stream === true ? 'invoke-with-response-stream' : 'invoke';
    
    // Get hook configuration for this model+subpath
    (req as any).__endpoint = 'openai';
    const hookConfig: HookConfig = configService.getHookConfig(req.body.model, subPath, 'openai');
    
    // Execute any 'before' strategy plugins
    if (hookConfig) {
      logger.info('openaiController', `Executing before plugins for model ${req.body.model}, subpath ${subPath}`);
      const pluginResult: PluginResult = await executeBeforePlugins(req, res, hookConfig);
      
      // If plugin returns { stop: true }, short-circuit the request
      if (pluginResult.stop) {
        logger.info('openaiController', `Plugin short-circuited request for ${req.body.model}/${subPath}`);
        return; // Response already sent by plugin
      }
    }
    
    // Check if model supports streaming when stream=true is requested
    if (req.body.stream === true) {
      // First check if we should emulate streaming
      const shouldEmulateStreaming = configService.shouldEmulateStreaming('openai', req.body.model);
      
      if (shouldEmulateStreaming) {
        logger.info('openaiController', `Stream requested for model ${req.body.model} - streaming emulation is enabled in config`);
        req.useEmulatedStreaming = true;
        logger.debug('openaiController', `Set req.useEmulatedStreaming = ${req.useEmulatedStreaming}`);
        // Store the fact we're using emulated streaming in the request object for use in the if(stream) branch
        req.emulatedStreaming = true;
        // Keep stream=true in request but set payload to non-streaming (we'll fetch full response to emulate)
        delete payload.config.stream;
        // Also remove stream_options from model.params since we're not actually streaming
        const mp = payload.config.modules.prompt_templating.model.params;
        if (mp && mp.stream_options) delete mp.stream_options;
      } else {
        // Only check native streaming support if we're not emulating streaming
        const modelSupportsStreaming = modelService.modelSupportsStreaming(req.body.model);

        if (!modelSupportsStreaming) {
          logger.info('openaiController', `Stream requested but model ${req.body.model} does not support streaming - using non-streaming mode`);
          // Override the stream setting in the request
          req.body.stream = false;
          // Also update the payload streaming property
          delete payload.config.stream;
          // Also remove stream_options from model.params since we're not actually streaming
          const mp = payload.config.modules.prompt_templating.model.params;
          if (mp && mp.stream_options) delete mp.stream_options;
        } else {
          logger.info('openaiController', `Using native streaming mode for model ${req.body.model}`);
        }
      }
    }

    if (req.body.stream) {
      logger.info('openaiController', 'Handling streaming request');
      
      // Skip setting headers for emulated streaming - we'll let the emulator handle it
      if (!req.emulatedStreaming) {
        // Set headers for Server-Sent Events (SSE)
        res.set({
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        res.flushHeaders();

        // Create a unique ID for this completion
        const completionId = `chatcmpl-${Date.now()}`;
        const model = req.body.model || 'gpt-35-turbo-16k';
        const createdTimestamp = Math.floor(Date.now() / 1000);

        // Send initial message with role
        logger.debug('openaiController', 'Sending initial role message');
        const initialChunk = {
          id: completionId,
          object: 'chat.completion.chunk',
          created: createdTimestamp,
          model: model,
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant'
              },
              finish_reason: null
            }
          ]
        };
        sseWriter.writeChunk(res, JSON.stringify(initialChunk));
      } else {
        logger.debug('openaiController', 'Skipping initial headers and chunk for emulated streaming');
      }

      // Use the modern AbortController for cancellation
      const abortController = new AbortController();

      // Listen for client disconnect (abort) and cancel the SAP request
      req.on('aborted', () => {
        logger.info('openaiController', 'Client aborted the request (req aborted event).');
        abortController.abort('Client aborted request');
      });

      req.on('close', () => {
        if (!res.writableEnded) {
          logger.info('openaiController', 'Client closed connection before response completed.');
          abortController.abort('Client closed connection');
        }
      });
      
      // Also monitor response close events
      res.on('close', () => {
        if (!res.writableEnded) {
          logger.info('openaiController', 'Response closed before completion.');
          abortController.abort('Response closed before completion');
        }
      });

      // Pass the client request object to allow direct checking of connection status
      logger.info('openaiController', 'Calling SAP AI Core streaming service');
      let chunkCounter = 0; // Initialize chunk counter
      let emulatedStreamingData: any = null; // Store emulated streaming data
      let streamTokenCounts = { inputTokens: 0, outputTokens: 0 }; // Track streaming token usage
      
      // For emulated streaming, we need to handle the Promise differently
      const streamingPromise = sapAIService.streamChatCompletion(payload, (chunk: StreamChunk) => {
        // Check if we received a non-streaming response with emulation flag
        if (chunk && chunk.nonStreamingResponse && chunk.useEmulatedStreaming) {
          logger.debug('openaiController', 'Received non-streaming response with emulation flag, processing asynchronously');
          
          // Store the emulated streaming data for later processing
          emulatedStreamingData = {
            skipNormalProcessing: true,
            nonStreamingResponse: chunk.nonStreamingResponse,
            modelName: req.body.model
          };
          return; // Return void
        }
        
        // Log the raw chunk from SAP AI Core for deep debugging
        logger.trace('openaiController', `Raw chunk from SAP AI Core:`, { chunk });
        
        // Log the chunk with its counter
        logger.debug('openaiController', `Processing chunk #${chunk.chunkNumber || ++chunkCounter} from SAP AI Core`);
        
        // Handle error chunks
        if (chunk.error) {
          // For cancellations, don't log as errors and don't send error response to client
          if (chunk.canceled) {
            logger.info('openaiController', `Request canceled by client: ${chunk.message}`);
            return; // Just return without sending error to client
          }
          
          logger.error('openaiController', `Error chunk received: ${chunk.message}`);
          const errorPayload = {
            message: chunk.message,
            type: 'sap_ai_core_error',
            code: chunk.status || 500,
            details: chunk.details
          };
          logger.trace('openaiController', 'Writing error chunk to client:', { errorPayload });
          sseWriter.writeError(res, errorPayload);
          return;
        }
        
        // Handle done marker
        if (chunk.done) {
          logger.debug('openaiController', 'Received [DONE] marker');
          sseWriter.writeDone(res);
          return;
        }
        
        try {
          // Process normal chunk data
          const transformedResponse = transformSAPResponseToOpenAI(chunk, true);
          logger.trace('openaiController', 'Writing transformed data chunk to client:', { transformedResponse });
          sseWriter.writeChunk(res, JSON.stringify(transformedResponse));
          
          // Extract token usage from streaming chunks
          if (transformedResponse && transformedResponse.usage) {
            logger.debug('openaiController', 'Found usage data in transformed response:', transformedResponse.usage);
            if (transformedResponse.usage.prompt_tokens) {
              streamTokenCounts.inputTokens += transformedResponse.usage.prompt_tokens;
            }
            if (transformedResponse.usage.completion_tokens) {
              streamTokenCounts.outputTokens += transformedResponse.usage.completion_tokens;
            }
            logger.debug('openaiController', 'Updated streaming token counts:', streamTokenCounts);
          } else {
            logger.debug('openaiController', 'No usage data in transformed response');
          }
        } catch (error: any) {
          logger.error('openaiController', 'Error transforming chunk:', error);
          sseWriter.writeError(res, {
            message: `Error processing chunk: ${error.message}`,
            type: 'processing_error'
          });
        }
        return;
      }, abortController.signal, req as any, hookConfig);
      
      // Process the promise result
      streamingPromise
        .then((result: any) => {
          logger.debug('openaiController', `streamChatCompletion Promise resolved with result type: ${result ? typeof result : 'undefined'}`);
          
          // Check if we have stored emulated streaming data
          if (emulatedStreamingData && emulatedStreamingData.skipNormalProcessing && emulatedStreamingData.nonStreamingResponse) {
            logger.debug('openaiController', 'Processing deferred emulation in promise chain');
            try {
              // Now we can safely emulate the streaming response
              return new Promise(resolve => {
                // Let the emulation complete before resolving
                emulateOpenAIStreamFromFullResponse(res, emulatedStreamingData.nonStreamingResponse, emulatedStreamingData.modelName, () => {
                  logger.debug('openaiController', 'Emulation complete callback received');
                  resolve({ emulationHandled: true });
                });
              });
            } catch (error: any) {
              logger.error('openaiController', 'Error in deferred emulation:', error);
              throw error; // Let the error handler deal with it
            }
          }
          
          return result; // Pass through any other result
        })
        .then((result: any) => {
          // If emulation was handled, skip sending [DONE]
          if (result && result.emulationHandled) {
            logger.debug('openaiController', 'Emulated streaming was handled, skipping [DONE]');
            
            // For emulated streaming, usage tracking is handled by the emulation function
            // but we may need to emit usage event here if not already done
            const providerName = (req as any).isOpenRouterRequest ? 'openrouter' : 'openai';
            const modelName = (req as any).isOpenRouterRequest ? (req as any).originalOpenRouterModel || originalModelFromRequest : originalModelFromRequest;
            
            // Check if emulated streaming data had token usage that we should track
            if (emulatedStreamingData && emulatedStreamingData.nonStreamingResponse && emulatedStreamingData.nonStreamingResponse.usage) {
              const usage = emulatedStreamingData.nonStreamingResponse.usage;
              updateTokenCounts(
                usageMetrics,
                usage.prompt_tokens || 0,
                usage.completion_tokens || 0
              );
              logger.debug('openaiController', 'Updated usage metrics with emulated streaming tokens:', usage);
            }
            
            // Emit usage event for successful emulated streaming request
            emitUsageEvent(req, usageMetrics, modelName, 200);
            return;
          }
          
          // Regular streaming completion
          if (!res.writableEnded) {
            logger.info('openaiController', 'Stream completed successfully, sending [DONE]');
            sseWriter.writeDone(res);
          }
          
          // Update usage metrics with streaming token counts (regardless of response state)
          logger.debug('openaiController', 'Final streaming token counts before usage tracking:', streamTokenCounts);
          if (streamTokenCounts.inputTokens > 0 || streamTokenCounts.outputTokens > 0) {
            updateTokenCounts(
              usageMetrics,
              streamTokenCounts.inputTokens,
              streamTokenCounts.outputTokens
            );
            logger.info('openaiController', 'Updated usage metrics with streaming tokens:', {
              inputTokens: streamTokenCounts.inputTokens,
              outputTokens: streamTokenCounts.outputTokens
            });
          } else {
            logger.warn('openaiController', 'No streaming token counts to track, will emit usage event with zero tokens');
          }
          
          // Determine provider name based on request source
          const providerName = (req as any).isOpenRouterRequest ? 'openrouter' : 'openai';
          const modelName = (req as any).isOpenRouterRequest ? (req as any).originalOpenRouterModel || originalModelFromRequest : originalModelFromRequest;
          
          // Emit usage event for successful streaming request (regardless of response state)
          logger.info('openaiController', `Emitting usage event for streaming request: provider=${providerName}, model=${modelName}`);
          emitUsageEvent(req, usageMetrics, modelName, 200);
        })
        .catch(async (err: any) => {
          // Handle client cancellation errors differently
          if (err.message === 'canceled' || err.message?.includes('abort') ||
              err.code === 'ERR_CANCELED' || err.canceled) {
            logger.info('openaiController', 'Stream ended due to client disconnection');
            return;
          }

          // Check if this is a streaming not supported error
          if (err.streamingNotSupported) {
            logger.warn('openaiController', 'Detected streaming not supported error, forcing cache refresh and sending non-streaming request');

            // Mark model as non-streaming in the cache
            modelService.markModelAsNonStreaming(req.body.model);

            if (!res.writableEnded) {
              // Check if we should emulate streaming instead of failing
              const shouldEmulateStreaming = configService.shouldEmulateStreaming('openai', req.body.model);
              
              if (shouldEmulateStreaming) {
                logger.info('openaiController', `Streaming failed but emulation is configured for model ${req.body.model}. Using full response emulation.`);
                
                // Update request to non-streaming (but keep req.useEmulatedStreaming flag for later)
                req.useEmulatedStreaming = true;
                req.body.stream = true; // Keep this true since we're still sending streaming response to client
                delete payload.config.stream;
                
                try {
                  const responseData = await sapAIService.completeChat(payload);
                  logger.info('openaiController', 'Non-streaming response received, emulating stream to client');
                  emulateOpenAIStreamFromFullResponse(res, responseData, req.body.model);
                  return; // Already handled via emulation
                } catch (retryError: any) {
                  if (!res.writableEnded) {
                    logger.error('openaiController', `Error in streaming emulation retry: ${retryError.message}`);
                    sseWriter.writeError(res, {
                      message: `Error in emulation: ${retryError.message}`,
                      type: 'processing_error'
                    });
                    sseWriter.writeDone(res);
                    
                    // Ensure response is ended properly
                    if (!res.writableEnded) {
                      res.end();
                    }
                  }
                  return; // Already sent error in SSE format
                }
              } else {
                // No emulation configured, fall back to non-streaming response
                logger.info('openaiController', 'Retrying as non-streaming request');

                // Update request to non-streaming
                req.body.stream = false;
                delete payload.config.stream;

                try {
                  const responseData = await sapAIService.completeChat(payload);
                  logger.info('openaiController', 'Non-streaming response received, sending via JSON');
                  if (!res.writableEnded) {
                    const transformedResponse = transformSAPResponseToOpenAI(responseData, false);
                    return res.json(transformedResponse);
                  }
                } catch (retryError: any) {
                  logger.error('openaiController', `Error in non-streaming retry: ${retryError.message}`);
                  if (!res.writableEnded) {
                    if (!res.headersSent) {
                      return next(retryError);
                    } else {
                      logger.warn('openaiController', 'Headers already sent, ending response');
                      return res.end();
                    }
                  }
                }
              }
            }
          }

          // Enhanced error handling for real (non-cancellation) streaming errors
          logger.error('openaiController', `Error in streaming: ${err.message}`);

          // build a proper error payload
          const errorPayload = {
            error: {
              message: err.details?.message || err.message,
              type: 'sap_ai_core_error',
              code: err.details?.status || err.status || 500,
              ...(process.env.DEBUG === 'true' ? { details: err.details } : {})
            }
          };

          // Track usage for streaming error case
          const providerName = (req as any).isOpenRouterRequest ? 'openrouter' : 'openai';
          const modelName = (req as any).isOpenRouterRequest ? (req as any).originalOpenRouterModel || originalModelFromRequest : originalModelFromRequest;
          const statusCode = err.details?.status || err.status || 500;
          
          // Update metrics with any tokens collected during streaming before error
          if (streamTokenCounts.inputTokens > 0 || streamTokenCounts.outputTokens > 0) {
            updateTokenCounts(
              usageMetrics,
              streamTokenCounts.inputTokens,
              streamTokenCounts.outputTokens
            );
          }
          
          // Emit usage event for streaming error
          emitUsageEvent(req, usageMetrics, modelName, statusCode);

          // Only send error to client if connection is still open
          if (!res.writableEnded) {
            sseWriter.writeError(res, errorPayload);
            // End the response after sending the error
            if (!res.writableEnded) {
              res.end();
            }
          }
        });
    } else {
      // Non-streaming request: wait for complete response
      logger.info('openaiController', 'Handling non-streaming request');
      try {
        const responseData = await sapAIService.completeChat(payload, debugRequestId);
        let transformedResponse = transformSAPResponseToOpenAI(responseData, false);
        
        // Track usage from transformed response
        if (transformedResponse && transformedResponse.usage) {
          updateTokenCounts(
            usageMetrics,
            transformedResponse.usage.prompt_tokens || 0,
            transformedResponse.usage.completion_tokens || 0
          );
        }
        
        // Execute any 'after' strategy plugins for non-streaming response
        if (hookConfig) {
          logger.info('openaiController', `Executing after plugins for non-streaming model ${req.body.model}`);
          transformedResponse = await executeAfterPlugins(req, res, transformedResponse, hookConfig);
          
          if (debugRequestId && transformedResponse) {
            payloadLogger.savePayload(debugRequestId, '05_after_plugin_modified_response', transformedResponse, req, res);
          }
        }
        
        // Determine provider name based on request source
        const providerName = (req as any).isOpenRouterRequest ? 'openrouter' : 'openai';
        const modelName = (req as any).isOpenRouterRequest ? (req as any).originalOpenRouterModel || originalModelFromRequest : originalModelFromRequest;
        
        // Emit usage event for successful non-streaming request
        emitUsageEvent(req, usageMetrics, modelName, 200);
        
        res.json(transformedResponse);
      } catch (error: any) {
        // Determine provider name based on request source
        const providerName = (req as any).isOpenRouterRequest ? 'openrouter' : 'openai';
        const modelName = (req as any).isOpenRouterRequest ? (req as any).originalOpenRouterModel || originalModelFromRequest : originalModelFromRequest;
        
        // Emit usage event for error case
        const statusCode = error.status || error.response?.status || 500;
        emitUsageEvent(req, usageMetrics, modelName, statusCode);
        
        // Pass the error to the error handler middleware with all details intact
        next(error);
      }
    }
  } catch (err: any) {
    logger.error('openaiController', 'Error in handleChatCompletion:', err);
    
    // Determine provider name based on request source
    const providerName = (req as any).isOpenRouterRequest ? 'openrouter' : 'openai';
    const modelName = (req as any).isOpenRouterRequest ? (req as any).originalOpenRouterModel || originalModelFromRequest : originalModelFromRequest;
    
    // Emit usage event for top-level error case
    const statusCode = err.status || err.response?.status || 500;
    emitUsageEvent(req, usageMetrics, modelName, statusCode);
    
    if (!res.headersSent) {
      next(err);
    } else {
      logger.warn('openaiController', 'Headers already sent in top-level catch, ending response');
      if (!res.writableEnded) {
        res.end();
      }
    }
  }
};

export async function transformRequestToSAPFormat(openAIReq: OpenAIRequestBody): Promise<SAPPayload> {
  // Convert the OpenAI API request (e.g. model, messages, parameters)
  // into the SAP AI Core orchestration JSON payload.
  
  // Log the incoming request - only log the full request in debug mode
  if (process.env.DEBUG === 'true') {
    logger.debug('openaiController', 'transformRequestToSAPFormat - OpenAI request:', { request: openAIReq });
  } else {
    // In production, just log a summary
    logger.info('openaiController', `OpenAI request: model=${openAIReq.model}, messages=${openAIReq.messages.length}, max_tokens=${openAIReq.max_tokens}, stream=${openAIReq.stream}`);
  }
  
  const modelName = openAIReq.model || "gpt-35-turbo-16k";
  
  // Add debug logging for model name
  logger.info('openaiController', `Processing request for model: ${modelName}`);
  
  let modelDetails: ModelDetails | null = null;
  let provider = 'unknown';

  try {
    modelDetails = await modelService.getModelDetails(modelName);
    if (modelDetails && modelDetails.owned_by) {
      provider = modelDetails.owned_by.toLowerCase();
      logger.info('openaiController', `Model ${modelName} provider determined as: ${provider}`);
    }
  } catch (error: any) {
    logger.error('openaiController', `Error fetching model details for ${modelName}: ${error.message}`);
  }
  logger.debug('openaiController', `Determined provider: '${provider}' for model: '${modelName}' via modelService.`);
  
  let isAnthropicModel = provider === 'anthropic';
  if (isAnthropicModel) {
    logger.info('openaiController', `Model ${modelName} is an Anthropic model based on provider '${provider}', will process images if present`);
  }
  
  // Map OpenAI parameters to provider-specific parameters
  // IMPORTANT: Do not include stream in model_params
  const paramsToMap: Record<string, any> = {};
  if (openAIReq.max_tokens !== undefined) {
    paramsToMap.max_tokens = openAIReq.max_tokens;
  }
  if (openAIReq.temperature !== undefined) {
    paramsToMap.temperature = openAIReq.temperature;
  }
  if (openAIReq.frequency_penalty !== undefined) {
    paramsToMap.frequency_penalty = openAIReq.frequency_penalty;
  }
  if (openAIReq.presence_penalty !== undefined) {
    paramsToMap.presence_penalty = openAIReq.presence_penalty;
  }
  if (openAIReq.top_p !== undefined) {
    paramsToMap.top_p = openAIReq.top_p;
  }
  if (openAIReq.stop !== undefined) { // Ensure 'stop' is also handled conditionally
    paramsToMap.stop = openAIReq.stop;
  }
  if (openAIReq.top_k !== undefined) {
    paramsToMap.top_k = openAIReq.top_k;
  }

  const modelParams = modelUtils.mapModelParameters(
    paramsToMap,
    provider
  );

  // Remove max_tokens, temperature, frequency_penalty, and presence_penalty for OpenAI gpt-5 models
  if (provider === 'openai' && modelDetails?.id?.toLowerCase().startsWith('gpt-5')) {
    const removedParams = [];
    
    if (modelParams.max_tokens !== undefined) {
      removedParams.push('max_tokens');
      delete modelParams.max_tokens;
    }
    if (modelParams.temperature !== undefined) {
      removedParams.push('temperature');
      delete modelParams.temperature;
    }
    if (modelParams.frequency_penalty !== undefined) {
      removedParams.push('frequency_penalty');
      delete modelParams.frequency_penalty;
    }
    if (modelParams.presence_penalty !== undefined) {
      removedParams.push('presence_penalty');
      delete modelParams.presence_penalty;
    }
    
    if (removedParams.length > 0) {
      logger.debug('openaiController', 
        `Removed parameters [${removedParams.join(', ')}] for GPT-5 model: ${modelName}`
      );
    }
  }

  // Specific handling for OpenAI 'o' series models regarding temperature
  if (provider === 'openai') {
    logger.debug('openaiController', `Provider is 'openai' for ${modelName}. Checking for 'o' series parameter removal/renaming.`);
    // The modelDetails should already be fetched. We re-check its properties here.
    if (modelDetails && modelDetails.id && modelDetails.id.toLowerCase().startsWith('o')) {
      logger.debug('openaiController', `Condition for 'o' series specific parameter handling MET for ${modelName}: modelDetails.id=${modelDetails.id}, provider=${provider}`);
      
      // Rename max_tokens to max_completion_tokens
      if (modelParams.max_tokens !== undefined) {
        logger.debug('openaiController', `Renaming max_tokens to max_completion_tokens for OpenAI 'o' series model: ${modelName}`);
        (modelParams as any).max_completion_tokens = modelParams.max_tokens;
        delete modelParams.max_tokens;
      }

      if (modelParams.temperature !== undefined) {
        logger.debug('openaiController', `Removing temperature parameter for OpenAI 'o' series model: ${modelName}`);
        delete modelParams.temperature;
      }
      if (modelParams.presence_penalty !== undefined) {
        logger.debug('openaiController', `Removing presence_penalty parameter for OpenAI 'o' series model: ${modelName}`);
        delete modelParams.presence_penalty;
      }
      if (modelParams.frequency_penalty !== undefined) {
        logger.debug('openaiController', `Removing frequency_penalty parameter for OpenAI 'o' series model: ${modelName}`);
        delete modelParams.frequency_penalty;
      }
    } else {
      logger.debug('openaiController', `Condition for 'o' series specific parameter handling NOT MET for OpenAI model ${modelName}. Details:`);
      if (!modelDetails) logger.debug('openaiController', '- modelDetails is null or undefined (should have been fetched)');
      else if (!modelDetails.id) logger.debug('openaiController', '- modelDetails.id is missing');
      else if (!modelDetails.id.toLowerCase().startsWith('o')) logger.debug('openaiController', `- modelDetails.id ('${modelDetails.id}') does not start with 'o'`);
    }
  } else {
    logger.debug('openaiController', `Provider is '${provider}', not 'openai'. Skipping 'o' series temperature check for ${modelName}.`);
  }
  
  // Process messages for Anthropic models with image URLs
  if (isAnthropicModel) {
    // Process all messages to convert image URLs to data URLs
    for (let i = 0; i < openAIReq.messages.length; i++) {
      const message = openAIReq.messages[i];
      
      // Check if message has content array with image URLs
      if (message && Array.isArray(message.content)) {
        for (let j = 0; j < message.content.length; j++) {
          const contentItem = message.content[j];
          
          // Find image_url items
          if (contentItem && contentItem.type === 'image_url') {
            logger.info('openaiController', 'Found image_url in message, converting to data URL for Anthropic');
            
            // Get the URL from the content item
            let imageUrl: string | undefined;
            if (contentItem && typeof contentItem.image_url === 'string') {
              imageUrl = contentItem.image_url;
            } else if (contentItem && contentItem.image_url && typeof contentItem.image_url === 'object' && contentItem.image_url.url) {
              imageUrl = contentItem.image_url.url;
            }
            
            // If we have a valid URL, download and convert to data URL
            if (imageUrl && typeof imageUrl === 'string') {
              // Only process if imageUrl starts with a protocol (e.g., http://, https://, ftp://, etc.)
              if (/^[a-zA-Z]+:\/\//.test(imageUrl)) {
                try {
                  // Download and encode the image
                  const base64Image = await imageUtils.downloadAndEncodeImage(imageUrl);
                  const mediaType = imageUtils.getMediaTypeFromUrl(imageUrl);
                  
                  // Create a data URL instead of using Anthropic's format
                  // Keep the same structure as OpenAI format but with data URL
                  if (message && message.content) {
                    message.content[j] = {
                      type: "image_url",
                      image_url: {
                        url: `data:${mediaType};base64,${base64Image}`
                      }
                    };
                  }

                  logger.info('openaiController', 'Successfully converted external URL to data URL for Anthropic model');
                } catch (error: any) {
                  logger.error('openaiController', `Error processing image: ${error.message}`);
                  // Keep the original image URL if processing fails
                }
              }
            }
          }
        }
      }
    }
  }
  
  // Prepare the messages for SAP AI Core
  // Extract the latest user message from the messages array
  const latestUserMessage = openAIReq.messages[openAIReq.messages.length - 1];
  if (!latestUserMessage) {
    throw new Error('No messages provided in request');
  }
  const previousMessages = openAIReq.messages.length > 1 ? openAIReq.messages.slice(0, -1) : [];

  // Prepare a modified version of the latest message for the V2 prompt_templating module.
  // The prompt template requires a specific format.
  let templateMessage: OpenAIMessage;

  if (isAnthropicModel && Array.isArray(latestUserMessage.content)) {
    // For Anthropic models with array content, we need to format differently for SAP AI Core
    // Convert array content to a plain text string for prompt_templating
    let textContent = '';
    
    // Extract any text parts from the content array
    latestUserMessage.content.forEach(item => {
      if (item.type === 'text' && item.text) {
        textContent += item.text + ' ';
      } else if (item.type === 'image_url') {
        textContent += '[Image attached] ';
      }
    });
    
    // Create a simplified template message with just text content
    templateMessage = {
      role: latestUserMessage.role,
      content: textContent.trim()
    };
    
    // For messages_history, keep the original format with image content
    logger.info('openaiController', 'Using special Anthropic image format for model input');
  } else {
    // For other models or simple content, use the original message
    templateMessage = latestUserMessage;
  }

  // Create the SAP AI Core payload (V2 wire shape)
  const payload: SAPPayload = {
    config: {
      modules: {
        prompt_templating: {
          prompt: {
            template: []
          },
          model: {
            name: modelName,
            version: 'latest',
            params: modelParams
          }
        }
      }
    },
    placeholder_values: {},
    messages_history: []
  };

  // For Anthropic models with images, handle differently
  if (isAnthropicModel && Array.isArray(latestUserMessage.content)) {
    logger.info('openaiController', 'Using special handling for Anthropic model with images');

    // Instead of trying to use custom placeholder_values, put the message with images directly in the messages_history
    payload.messages_history = [...previousMessages, latestUserMessage];

    // Look for a system message in the previous messages
    const systemMessage = previousMessages.find(msg => msg.role === 'system');

    // Use the user's system prompt if available, otherwise use a default
    payload.config.modules.prompt_templating.prompt.template = [{
      role: "system",
      content: systemMessage ? systemMessage.content : "You are a helpful assistant."
    }];
  } else {
    // Normal handling for text-only messages
    payload.config.modules.prompt_templating.prompt.template = [templateMessage];
    payload.messages_history = previousMessages;
  }

  // Parameters this provider/model does not accept. SAP AI Core's LLM module
  // rejects the whole request otherwise (e.g. HTTP 400 "perplexity does not
  // support parameters: ['tools'], for model=sonar"), so drop them instead of
  // letting a client that always sends `tools`/`response_format` fail outright.
  const unsupportedParams = configService.getUnsupportedParams(provider, modelName);
  const droppedParams: string[] = [];

  // Handle tools and tool_choice if present.
  // V2: tools live on prompt; tool_choice is OpenAI-style under model.params.
  if (openAIReq.tools && openAIReq.tools.length > 0) {
    if (isUnsupportedParam('tools', unsupportedParams)) {
      droppedParams.push('tools');
    } else {
      logger.info('openaiController', 'Tools found in request, adding to SAP AI Core payload');

      payload.config.modules.prompt_templating.prompt.tools = openAIReq.tools;
    }

    if (openAIReq.tool_choice) {
      if (isUnsupportedParam('tool_choice', unsupportedParams) || isUnsupportedParam('tools', unsupportedParams)) {
        droppedParams.push('tool_choice');
      } else {
        payload.config.modules.prompt_templating.model.params!.tool_choice = openAIReq.tool_choice;
      }
    }
  }

  // Handle response_format if present (V2: lives on prompt).
  if (openAIReq.response_format) {
    if (isUnsupportedParam('response_format', unsupportedParams)) {
      droppedParams.push('response_format');
    } else {
      logger.info('openaiController', 'Response format found in request, adding to SAP AI Core payload');

      payload.config.modules.prompt_templating.prompt.response_format = openAIReq.response_format;
    }
  }

  if (droppedParams.length > 0) {
    logger.warn('openaiController',
      `Dropped ${droppedParams.length} parameter(s) not supported by provider '${provider}' for model ${modelName}: ${droppedParams.join(', ')}`);
  }

  // V2 streaming: config.stream is a structured object { enabled, chunk_size, delimiters? }.
  // Token-usage reporting (model.params.stream_options.include_usage) is set ONLY for
  // OpenAI and Mistral due to a bug in the Harmonization API (OSS 830780/2025).
  if (openAIReq.stream) {
    payload.config.stream = {
      enabled: true,
      chunk_size: 200 // Larger chunk size for better context
    };

    const mp = payload.config.modules.prompt_templating.model.params!;
    const shouldIncludeUsage = (provider === 'openai' || provider === 'mistral ai');

    if (shouldIncludeUsage) {
      if (!mp.stream_options) mp.stream_options = {};
      mp.stream_options.include_usage = true;
      logger.debug(
        'openaiController',
        `include_usage enabled for provider='${provider}' model='${modelName}'`
      );
    } else {
      // Defensive: ensure we do NOT send include_usage for providers that don’t need it
      if (mp.stream_options?.include_usage !== undefined) {
        delete mp.stream_options.include_usage;
      }
      // Drop empty stream_options object to avoid accidental flags
      if (mp.stream_options && Object.keys(mp.stream_options).length === 0) {
        delete mp.stream_options;
      }
      logger.debug(
        'openaiController',
        `include_usage omitted for provider='${provider}' model='${modelName}'`
      );
    }
  }

  logger.debug('openaiController', 'transformRequestToSAPFormat - SAP AI Core payload:', { payload });
  
  return payload;
}

/**
 * Transform SAP AI Core response to OpenAI format
 * @param {Object} sapResponse - Response from SAP AI Core
 * @param {boolean} isStreaming - Whether this is a streaming response
 * @returns {Object} - OpenAI-compatible response
 */
function transformSAPResponseToOpenAI(sapResponse: any, isStreaming: boolean): any {
  logger.debug('openaiController', 'Transforming SAP response to OpenAI format:', { responsePreview: sapResponse });
  
  let assistantContent = '';
  let usage = null;
  let finishReason = null;
  let toolCalls = null;
  
  // Handle streaming chunks
  if (isStreaming && sapResponse.final_result && 
      sapResponse.final_result.choices && 
      sapResponse.final_result.choices.length > 0) {
    
    const choice = sapResponse.final_result.choices[0];
    
    // Extract content from delta if available
    if (choice.delta && choice.delta.content) {
      assistantContent = choice.delta.content;
    }
    
    // Extract tool_calls from delta if available
    if (choice.delta && choice.delta.tool_calls) {
      toolCalls = choice.delta.tool_calls;
    }
    
    // Extract finish reason if available
    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
    }
    
    // Extract usage if available
    if (sapResponse.final_result.usage) {
      usage = sapResponse.final_result.usage;
    }
    
    // Create OpenAI-compatible streaming response
    const deltaObject: any = { content: assistantContent };
    if (toolCalls) {
      deltaObject.tool_calls = toolCalls;
    }
    
    return {
      id: sapResponse.final_result.id || `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: sapResponse.final_result.created || Math.floor(Date.now() / 1000),
      model: sapResponse.final_result.model || 'gpt-4',
      choices: [
        {
          index: choice.index || 0,
          delta: deltaObject,
          finish_reason: finishReason
        }
      ],
      usage: usage
    };
  }
  
  // Handle non-streaming responses or fallback
  if (typeof sapResponse === 'object') {
    // Try to extract content from various possible locations
    if (sapResponse.final_result && sapResponse.final_result.choices) {
      const choice = sapResponse.final_result.choices[0];
      if (choice && choice.message) {
        // Extract content if available
        if (choice.message.content !== undefined) {
          assistantContent = choice.message.content;
        }
        
        // Extract tool_calls if available
        if (choice.message.tool_calls) {
          toolCalls = choice.message.tool_calls;
        }
      }
      if (choice && choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
      
      // Extract usage if available
      if (sapResponse.final_result.usage) {
        usage = sapResponse.final_result.usage;
      }
    } else if (sapResponse.intermediate_results && sapResponse.intermediate_results.llm) {
      // Extract from intermediate_results.llm format
      const llmResult = sapResponse.intermediate_results.llm;
      if (llmResult.choices && llmResult.choices[0]) {
        const choice = llmResult.choices[0];
        if (choice.message) {
          // Extract content if available
          if (choice.message.content !== undefined) {
            assistantContent = choice.message.content;
          }
          
          // Extract tool_calls if available
          if (choice.message.tool_calls) {
            toolCalls = choice.message.tool_calls;
          }
        }
        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }
      
      // Try to extract usage from intermediate_results.llm
      if (llmResult.usage) {
        usage = llmResult.usage;
      }
    } else {
      // Try other possible formats
      try {
        const parsedResponse = sapResponse;
        if (parsedResponse.response) {
          assistantContent = parsedResponse.response;
        } else if (parsedResponse.content) {
          assistantContent = parsedResponse.content;
        }
        
        // Try to extract tool_calls from other formats
        if (parsedResponse.tool_calls) {
          toolCalls = parsedResponse.tool_calls;
        }
      } catch (e) {
        // If extraction fails, use the string representation
        assistantContent = JSON.stringify(sapResponse);
      }
    }
    
    // Extract usage if available and not already extracted
    if (!usage) {
      if (sapResponse.usage) {
        usage = sapResponse.usage;
      }
    }
  }
  
  // Create the OpenAI-compatible response
  const messageObject: any = {
    role: 'assistant',
    content: assistantContent
  };
  
  // Add tool_calls to the message if present
  if (toolCalls) {
    messageObject.tool_calls = toolCalls;
  }
  
  const openAIResponse = {
    id: sapResponse.final_result?.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: sapResponse.final_result?.created || Math.floor(Date.now() / 1000),
    model: sapResponse.final_result?.model || 'gpt-4',
    choices: [
      {
        index: 0,
        message: messageObject,
        finish_reason: finishReason || 'stop'
      }
    ],
    usage: usage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };
  
  return openAIResponse;
}


function emulateOpenAIStreamFromFullResponse(res: Response, responseData: any, modelName: string, completionCallback?: () => void): void {
  logger.info('openaiController', `Starting OpenAI stream emulation for model: ${modelName}`);
  
  // Set SSE headers if not already set
  if (!res.headersSent) {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.flushHeaders();
  }

  // Check if response is already ended
  if (res.writableEnded) {
    logger.warn('openaiController', 'Response already ended, cannot emulate streaming');
    if (completionCallback) completionCallback();
    return;
  }

  // Extract content from various possible response formats
  let fullContent = '';
  let extractedUsage: any = null;
  let extractedFinishReason = 'stop';

  // Try OpenAI format first
  if (responseData.choices && responseData.choices.length > 0) {
    const choice = responseData.choices[0];
    if (choice.message && choice.message.content) {
      fullContent = choice.message.content;
    }
    if (choice.finish_reason) {
      extractedFinishReason = choice.finish_reason;
    }
    if (responseData.usage) {
      extractedUsage = responseData.usage;
    }
  }
  // Try SAP final_result format
  else if (responseData.final_result && responseData.final_result.choices && responseData.final_result.choices.length > 0) {
    const choice = responseData.final_result.choices[0];
    if (choice.message && choice.message.content) {
      fullContent = choice.message.content;
    }
    if (choice.finish_reason) {
      extractedFinishReason = choice.finish_reason;
    }
    if (responseData.final_result.usage) {
      extractedUsage = {
        prompt_tokens: responseData.final_result.usage.prompt_tokens || 0,
        completion_tokens: responseData.final_result.usage.completion_tokens || 0,
        total_tokens: responseData.final_result.usage.total_tokens || 0
      };
    }
  }
  // Try SAP intermediate_results.llm format
  else if (responseData.intermediate_results && responseData.intermediate_results.llm && responseData.intermediate_results.llm.choices && responseData.intermediate_results.llm.choices.length > 0) {
    const choice = responseData.intermediate_results.llm.choices[0];
    if (choice.message && choice.message.content) {
      fullContent = choice.message.content;
    }
    if (choice.finish_reason) {
      extractedFinishReason = choice.finish_reason;
    }
    if (responseData.intermediate_results.llm.usage) {
      extractedUsage = {
        prompt_tokens: responseData.intermediate_results.llm.usage.prompt_tokens || 0,
        completion_tokens: responseData.intermediate_results.llm.usage.completion_tokens || 0,
        total_tokens: responseData.intermediate_results.llm.usage.total_tokens || 0
      };
    }
  }
  // Fallback content extraction
  else {
    fullContent = responseData.content || responseData.text || responseData.message || 'No content available';
    logger.warn('openaiController', `Using fallback content extraction for emulation: ${fullContent.substring(0, 100)}...`);
  }

  // Generate response metadata
  const completionId = `chatcmpl-${Date.now()}`;
  const timestamp = Math.floor(Date.now() / 1000);

  // Send initial message_start chunk
  const initialChunk = {
    id: completionId,
    object: 'chat.completion.chunk',
    created: timestamp,
    model: modelName,
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant'
        },
        finish_reason: null
      }
    ]
  };

  logger.debug('openaiController', 'Sending initial chunk for emulated stream');
  sseWriter.writeChunk(res, JSON.stringify(initialChunk));

  // Break content into chunks and send them
  const chunks = chunkText(fullContent);
  logger.debug('openaiController', `Sending ${chunks.length} content chunks for emulated stream`);

  let chunkIndex = 0;
  const sendNextChunk = () => {
    // Check if response is still writable
    if (res.writableEnded) {
      logger.debug('openaiController', 'Response ended during chunk sending');
      if (completionCallback) completionCallback();
      return;
    }

    if (chunkIndex < chunks.length) {
      const contentChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created: timestamp,
        model: modelName,
        choices: [
          {
            index: 0,
            delta: {
              content: chunks[chunkIndex]
            },
            finish_reason: null
          }
        ]
      };

      sseWriter.writeChunk(res, JSON.stringify(contentChunk));
      chunkIndex++;

      // Schedule next chunk
      setTimeout(sendNextChunk, 30);
    } else {
      // Send final chunk with usage and finish_reason
      const finalChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created: timestamp,
        model: modelName,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: extractedFinishReason
          }
        ]
      };

      // Add usage info if available
      if (extractedUsage) {
        (finalChunk as any).usage = extractedUsage;
      }

      sseWriter.writeChunk(res, JSON.stringify(finalChunk));
      
      // Send [DONE] marker
      sseWriter.writeDone(res);
      
      logger.info('openaiController', `Completed emulated streaming for model: ${modelName}`);
      
      // Call completion callback if provided
      if (completionCallback) {
        completionCallback();
      }
    }
  };

  // Start sending chunks
  sendNextChunk();
}

function chunkText(text: string, averageChunkSize: number = 15): string[] {
  if (!text || text.length === 0) {
    return [''];
  }

  // For very short text, return as single chunk
  if (text.length <= averageChunkSize) {
    return [text];
  }

  const chunks: string[] = [];
  let currentChunk = '';
  let i = 0;

  while (i < text.length) {
    // Add characters to current chunk
    currentChunk += text[i];
    i++;

    // Check if we should break the chunk
    if (currentChunk.length >= averageChunkSize) {
      // Look for a good break point (space, punctuation)
      let breakPoint = currentChunk.length;
      
      // Look backwards for a space or punctuation
      for (let j = currentChunk.length - 1; j >= Math.max(0, currentChunk.length - 5); j--) {
        if (currentChunk[j] && /[\\s.,!?;:]/.test(currentChunk[j]!)) {
          breakPoint = j + 1;
          break;
        }
      }

      // Split the chunk
      chunks.push(currentChunk.substring(0, breakPoint));
      currentChunk = currentChunk.substring(breakPoint);
    }
  }

  // Add any remaining content
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  // Ensure we have at least 2 chunks for proper streaming effect
  if (chunks.length === 1 && chunks[0] && chunks[0].length > 2) {
    const midPoint = Math.floor(chunks[0].length / 2);
    const firstHalf = chunks[0].substring(0, midPoint);
    const secondHalf = chunks[0].substring(midPoint);
    return [firstHalf, secondHalf];
  }

  return chunks.filter(chunk => chunk.length > 0);
}


export default {
  handleChatCompletion
};
