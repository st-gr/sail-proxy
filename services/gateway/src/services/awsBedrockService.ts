import axios, { AxiosResponse } from 'axios';
import { Request, Response } from 'express';
import modelService from './modelService';
import configService from './configService';
import { executeAfterPlugins, executeStreamPlugins } from './pluginExecutor';
import * as payloadLogger from '../utils/payloadLogger';
import * as sseWriter from '../utils/sseWriter';
import BedrockStreamParser, { OutputFormat } from '../utils/bedrockStreamParser';
import { getDefaultLogger, createSafePreview, createHeadersPreview } from '@libs/logger';
const logger = getDefaultLogger();
import rateLimitManager from './rateLimitManager';
import { emitUsageEvent, updateTokenCounts } from '../utils/usageTracker';
import { parseAnthropicBetaHeader, mergeBetaFeatures, filterBetaFeatures } from '../utils/betaFeatureFilter';
import * as betaFlagQuarantine from './betaFlagQuarantine';

// Type definitions
interface ModelDetails {
  id: string;
  executableId?: string;
  accessType?: string;
  deploymentUrl?: string;
  internal_id?: string;
  anthropic_version?: string;
  subpaths_native?: string[];
  subpaths_emulated?: string[];
  streamingSupported?: boolean;
  [key: string]: any;
}

interface ProcessBedrockRequestOptions {
  modelId: string;
  originalModelId: string;
  subpath: string;
  requestBody: any;
  headers: Record<string, string>;
  debugRequestId: string;
  req: Request;
  res: Response;
  hookConfig?: any;
  usageMetrics?: any; // Add usage metrics for tracking
  outputFormat?: OutputFormat; // Output format: 'anthropic' for Anthropic API format, 'bedrock' for native Bedrock format
}

interface NativeSubpathOptions {
  modelDetails: ModelDetails;
  modelId: string;
  subpath: string;
  requestBody: any;
  headers: Record<string, string>;
  debugRequestId: string;
  req: Request;
  res: Response;
  isStreaming: boolean;
  hookConfig?: any;
  usageMetrics?: any; // Add usage metrics for tracking
  originalModelId?: string; // Add original model ID for usage tracking
  outputFormat?: OutputFormat; // Output format: 'anthropic' for Anthropic API format, 'bedrock' for native Bedrock format
}

interface EmulatedSubpathOptions {
  modelDetails: ModelDetails;
  modelId: string;
  originalModelId: string;
  subpath: string;
  requestBody: any;
  headers: Record<string, string>;
  debugRequestId: string;
  req: Request;
  res: Response;
  isStreaming: boolean;
  hookConfig?: any;
  usageMetrics?: any; // Add usage metrics for tracking
}

// Unused interface
// interface SAPDestination {
//   resourcePath: string;
//   ai_api_base_url: string;
//   'AI-Resource-Group': string;
//   authorization: string;
// }

interface BedrockMessageContent {
  cache_control?: any;
  [key: string]: any;
}

interface BedrockMessage {
  content?: BedrockMessageContent[];
  [key: string]: any;
}

interface BedrockRequestBody {
  model?: string;
  stream?: boolean;
  anthropic_version?: string;
  system?: any[];
  messages?: BedrockMessage[] | any;
  [key: string]: any;
}

/**
 * Process AWS Bedrock requests with payload transformation and routing
 * @param options - Request processing options
 * @returns Response data for non-streaming requests
 */
export async function processBedrockRequest(options: ProcessBedrockRequestOptions): Promise<any> {
  const { modelId, originalModelId, subpath, requestBody, headers, debugRequestId, req, res, hookConfig } = options;
  
  logger.info('AwsBedrockService', `Processing ${subpath} for model ${modelId}`);
  
  // Check and apply rate limit delay BEFORE processing the request
  logger.debug('AwsBedrockService', `Checking rate limit for ${modelId}:${subpath}`);
  const delayApplied = await rateLimitManager.checkAndApplyDelay(modelId, subpath);
  if (delayApplied > 0) {
    logger.info('AwsBedrockService', `Applied rate limit delay of ${Math.ceil(delayApplied / 1000)}s for ${modelId}:${subpath}`);
  } else {
    logger.debug('AwsBedrockService', `No rate limit delay needed for ${modelId}:${subpath}`);
  }
  
  // Get model details to determine native vs emulated handling
  const modelDetails = await modelService.getModelDetails(modelId);
  if (!modelDetails) {
    throw new Error(`Model ${modelId} not found`);
  }

  // Filter models by executableId to ensure we only work with aws-bedrock models
  // Also handle deployed models which may not have executableId but have deploymentUrl
  if (modelDetails.executableId !== 'aws-bedrock' && !isDeployedModel(modelDetails)) {
    throw new Error(`Model ${modelId} is not an AWS Bedrock model`);
  }

  // Determine if this is a native or emulated subpath
  const isNativeSubpath = isSubpathNative(modelDetails, subpath);
  const isStreamingSubpath = subpath.includes('stream');
  const isInvokeSubpath = subpath.includes('invoke');
  
  logger.info('AwsBedrockService', `Subpath ${subpath} is ${isNativeSubpath ? 'native' : 'emulated'} for model ${modelId}`);

  const processedRequestBody = requestBody as BedrockRequestBody;
  if (processedRequestBody && typeof processedRequestBody === 'object') {
    if (processedRequestBody.model !== undefined) {
      delete processedRequestBody.model;
    }
    if (processedRequestBody.stream !== undefined) {
      delete processedRequestBody.stream;
    }
    if (processedRequestBody.anthropic_version === undefined && isInvokeSubpath) {
      processedRequestBody.anthropic_version = modelDetails.anthropic_version;
    }
    // Assemble anthropic_beta for invoke subpaths from all sources, then filter
    // through the configured allowlist (supported_beta_headers) and denylist
    // (excluded_beta_headers) so no unsupported flag can reach SAP AI Core —
    // including flags injected via inject_beta_features or supplied in the body.
    if (isInvokeSubpath) {
      const headerFeatures = parseAnthropicBetaHeader(options.headers['anthropic-beta']);
      // Header takes precedence over a body-supplied anthropic_beta (legacy behavior);
      // body flags are now filtered too instead of passing through untouched.
      const bodyFeatures = headerFeatures.length === 0 && Array.isArray(processedRequestBody.anthropic_beta)
        ? processedRequestBody.anthropic_beta.map(String)
        : [];
      const injectedFeatures = Array.isArray(modelDetails.inject_beta_features)
        ? modelDetails.inject_beta_features.map(String)
        : [];

      const candidates = mergeBetaFeatures(headerFeatures, bodyFeatures, injectedFeatures);
      const filterOptions = {
        supported: configService.getSupportedBetaHeaders(),
        // Config denylist plus flags quarantined at runtime after upstream
        // "invalid beta flag" 400s for this model (see betaFlagQuarantine).
        excluded: mergeBetaFeatures(
          configService.getExcludedBetaHeaders(),
          betaFlagQuarantine.getQuarantinedFlags(modelId)
        )
      };
      const betaFeatures = filterBetaFeatures(candidates, filterOptions);

      const dropped = candidates.filter(feature => !betaFeatures.includes(feature));
      if (dropped.length > 0) {
        logger.debug('AwsBedrockService', `Filtered ${dropped.length} unsupported beta feature(s): ${dropped.join(', ')}`);
      }
      if (injectedFeatures.length > 0) {
        logger.debug('AwsBedrockService', `Injected model-specific beta features: ${injectedFeatures.join(', ')}`);
      }

      if (betaFeatures.length > 0) {
        processedRequestBody.anthropic_beta = betaFeatures;
        logger.debug('AwsBedrockService', `Adding anthropic_beta features: ${betaFeatures.join(', ')}`);
      } else {
        delete processedRequestBody.anthropic_beta;
      }
    }
    if (isInvokeSubpath && isNativeSubpath) {
      // Check if model explicitly disables prompt caching - if so, filter out cache_control parameters
      const shouldFilterCacheControl = modelDetails.supports_prompt_caching === false;
      
      if (shouldFilterCacheControl) {
        logger.debug('AwsBedrockService', `Model ${modelId} has prompt caching disabled, filtering cache_control parameters`);
        
        if (Array.isArray(processedRequestBody.system)) {
          processedRequestBody.system = processedRequestBody.system.map(item => {
            if (item && typeof item === 'object' && 'cache_control' in item) {
              const { cache_control, ...rest } = item;
              return rest;
            }
            return item;
          });
        }
        if (processedRequestBody.messages) {
          if (Array.isArray(processedRequestBody.messages)) {
            processedRequestBody.messages = processedRequestBody.messages.map(msg => {
              if (msg && Array.isArray(msg.content)) {
                msg.content = msg.content.map((contentItem: any) => {
                  if (contentItem && typeof contentItem === 'object' && 'cache_control' in contentItem) {
                    const { cache_control, ...rest } = contentItem;
                    return rest;
                  }
                  return contentItem;
                });
              }
              return msg;
            });
          } else if (typeof processedRequestBody.messages === 'object' && !Array.isArray(processedRequestBody.messages)) {
            // If messages is an object but not an array, handle it as a single message
            logger.warn('AwsBedrockService', 'messages property is an object, not an array. Cannot apply map.');
            // You could transform it to an array or handle it differently here
          }
        }
      } else {
        logger.debug('AwsBedrockService', `Model ${modelId} allows prompt caching (default), preserving cache_control parameters`);
      }
    }
  }

  if (debugRequestId) {
    payloadLogger.savePayload(debugRequestId, '01_original_bedrock_request', {
      modelId: originalModelId,
      substitutedModelId: modelId,
      subpath,
      isNative: isNativeSubpath,
      isStreaming: isStreamingSubpath,
      requestBody: processedRequestBody
    }, req, res);
  }

  try {
    let result: any;
    if (isNativeSubpath) {
      // Handle native subpath - direct passthrough to SAP AI Core
      result = await handleNativeSubpath({
        modelDetails,
        modelId, // Add modelId to track for rate limiting
        subpath,
        requestBody: processedRequestBody,
        headers,
        debugRequestId,
        req,
        res,
        isStreaming: isStreamingSubpath,
        hookConfig,
        usageMetrics: options.usageMetrics,
        originalModelId: options.originalModelId,
        outputFormat: options.outputFormat
      });
    } else {
      // Handle emulated subpath - transform payload format
      result = await handleEmulatedSubpath({
        modelDetails,
        modelId, // Add modelId to track for rate limiting
        originalModelId,
        subpath,
        requestBody: processedRequestBody,
        headers,
        debugRequestId,
        req,
        res,
        isStreaming: isStreamingSubpath,
        hookConfig,
        usageMetrics: options.usageMetrics // Pass usage metrics for tracking
      });
    }
    
    // Record successful request (clears any rate limit for this endpoint)
    rateLimitManager.recordSuccess(modelId, subpath);
    
    return result;
  } catch (error: any) {
    // Check if this is a rate limit error and record it
    if (rateLimitManager.isRateLimitError(error)) {
      logger.warn('AwsBedrockService', `Rate limit detected for ${modelId}:${subpath}: ${error.message}`);
      await rateLimitManager.recordRateLimit(modelId, subpath, error);
    }
    
    throw error;
  }
}

/**
 * Check if a model is a deployed model
 * @param modelDetails - Model details from modelService
 * @returns True if deployed model, false otherwise
 */
function isDeployedModel(modelDetails: ModelDetails): boolean {
  return !!(modelDetails && (
    modelDetails.accessType === "deployment" ||
    (modelDetails.deploymentUrl && modelDetails.deploymentUrl.length > 0) ||
    (modelDetails.internal_id && modelDetails.internal_id.endsWith('--deployed'))
  ));
}

/**
 * Determine if a subpath is natively supported by the model
 * @param modelDetails - Model details from modelService
 * @param subpath - The requested subpath
 * @returns True if native, false if emulated
 */
function isSubpathNative(modelDetails: ModelDetails, subpath: string): boolean {
  // Check subpaths_native array from model configuration
  if (modelDetails.subpaths_native && Array.isArray(modelDetails.subpaths_native)) {
    return modelDetails.subpaths_native.includes(subpath);
  }
  
  // Default behavior: assume invoke/invoke-with-response-stream are native for aws-bedrock
  // and converse/converse-stream require emulation  
  const defaultNativeSubpaths = ['invoke', 'invoke-with-response-stream'];
  return defaultNativeSubpaths.includes(subpath);
}

/**
 * Handle native subpath - direct passthrough to SAP AI Core
 */
async function handleNativeSubpath(options: NativeSubpathOptions): Promise<any> {
  const { modelDetails, modelId, subpath, requestBody, headers, debugRequestId, req, res, isStreaming, hookConfig, outputFormat } = options;
  logger.info('AwsBedrockService', `Handling native subpath ${subpath}`);
  
  // For native subpaths, pass the request directly to SAP AI Core
  const authToken = await (modelService as any).getAuthToken();
  
  // Construct the SAP AI Core URL
  const baseUrl = modelDetails.deploymentUrl || constructDeploymentUrl(modelDetails);
  const targetUrl = constructTargetUrl(baseUrl, subpath, modelDetails);
  
  logger.info('AwsBedrockService', `Making native request to: ${targetUrl}`);
  
  if (debugRequestId) {
    payloadLogger.savePayload(debugRequestId, '02_native_request_to_sap', {
      url: targetUrl,
      payload: requestBody
    });
  }

  try {
    logger.info('AwsBedrockService', `Hook config for native request: ${JSON.stringify(hookConfig ? 'present' : 'missing')}`);
    if (isStreaming) {
      // Handle streaming native request
      return await handleNativeStreamingRequest({
        targetUrl,
        requestBody,
        authToken,
        headers,
        debugRequestId,
        req,
        res,
        modelDetails,
        modelId, // Add for rate limit tracking
        subpath, // Add for rate limit tracking
        hookConfig,
        usageMetrics: options.usageMetrics, // Pass usage metrics for tracking
        originalModelId: options.originalModelId, // Pass original model ID for tracking
        outputFormat // Pass output format for response formatting
      });
    } else {
      // Handle non-streaming native request
      const timeout = configService.getTimeout(false);
      const response: AxiosResponse = await axios.post(targetUrl, requestBody, {
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json',
          'AI-Resource-Group': process.env.SAP_AI_RESOURCE_GROUP || 'default'
        },
        timeout: timeout
      });

      if (debugRequestId) {
        payloadLogger.savePayload(debugRequestId, '03_native_response_from_sap', response.data, req, res);
      }
      
      // Execute any 'after' strategy plugins if applicable
      let finalResponse = response.data;
      if (hookConfig) {
        finalResponse = await executeAfterPlugins(req, res, response.data, hookConfig);
        
        if (debugRequestId) {
          payloadLogger.savePayload(debugRequestId, '04_after_plugin_modified_response', finalResponse, req, res);
        }
      }

      return finalResponse;
    }
  } catch (error: any) {
    logger.error('AwsBedrockService', `Error in native request: ${error.message}`);
    if (error.response) {
      logger.error('AwsBedrockService', `SAP AI Core error response: ${error.response.status}`, undefined, { data: error.response.data });
      if (debugRequestId) {
        payloadLogger.savePayload(debugRequestId, '03_native_error_from_sap', {
          status: error.response.status,
          data: error.response.data
        }, req, res);
      }
      const sentBetaFlags: string[] = Array.isArray(requestBody?.anthropic_beta)
        ? requestBody.anthropic_beta.map(String)
        : [];
      if (sentBetaFlags.length > 0
          && betaFlagQuarantine.isInvalidBetaFlagError(error.response.status, error.response.data)) {
        betaFlagQuarantine.recordBetaFlagRejection(modelId, error.response.data, sentBetaFlags);
      }
    }
    throw error;
  }
}

/**
 * Handle emulated subpath - transform between Anthropic and Bedrock formats
 */
async function handleEmulatedSubpath(options: EmulatedSubpathOptions): Promise<any> {
  const { modelDetails, modelId, originalModelId, subpath, requestBody, headers, debugRequestId, req, res, isStreaming, hookConfig } = options;
  logger.info('AwsBedrockService', `Handling emulated subpath ${subpath}`);
  
  let transformedPayload: any;
  let targetSubpath: string;
  
  if (subpath === 'invoke' || subpath === 'invoke-with-response-stream') {
    // Transform from Anthropic Messages API to Bedrock Converse API
    transformedPayload = transformAnthropicToBedrockConverse(requestBody, originalModelId);
    targetSubpath = isStreaming ? 'converse-stream' : 'converse';
  } else {
    // For converse subpaths, assume we're already in the right format
    transformedPayload = requestBody;
    targetSubpath = subpath;
  }

  if (debugRequestId) {
    payloadLogger.savePayload(debugRequestId, '02_transformed_payload', {
      originalSubpath: subpath,
      targetSubpath,
      originalPayload: requestBody,
      transformedPayload
    });
  }

  // Now make the request using the transformed payload
  const authToken = await (modelService as any).getAuthToken();
  const baseUrl = modelDetails.deploymentUrl || constructDeploymentUrl(modelDetails);
  const targetUrl = constructTargetUrl(baseUrl, targetSubpath, modelDetails);
  
  try {
    logger.info('AwsBedrockService', `Hook config for emulated request: ${JSON.stringify(hookConfig ? 'present' : 'missing')}`);

    if (isStreaming) {
      // Handle streaming emulated request with response transformation
      return await handleEmulatedStreamingRequest({
        targetUrl,
        requestBody: transformedPayload,
        authToken,
        headers,
        debugRequestId,
        req,
        res,
        originalSubpath: subpath,
        originalModelId,
        modelId, // Add for rate limit tracking
        subpath, // Add for rate limit tracking
        modelDetails, // Add missing required property
        hookConfig,
        usageMetrics: options.usageMetrics // Pass usage metrics for tracking
      });
    } else {
      // Handle non-streaming emulated request
      const timeout = configService.getTimeout(false);
      const response: AxiosResponse = await axios.post(targetUrl, transformedPayload, {
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json',
          'AI-Resource-Group': process.env.SAP_AI_RESOURCE_GROUP || 'default'
        },
        timeout: timeout
      });

      if (debugRequestId) {
        payloadLogger.savePayload(debugRequestId, '03_emulated_response_from_sap', response.data, req, res);
      }

      // Transform the response back to the expected format
      const transformedResponse = transformBedrockToAnthropicResponse(response.data, subpath, originalModelId);
      
      if (debugRequestId) {
        payloadLogger.savePayload(debugRequestId, '04_final_transformed_response', transformedResponse, req, res);
      }
      
      // Execute any 'after' strategy plugins if applicable
      let finalResponse = transformedResponse;
      if (hookConfig) {
        finalResponse = await executeAfterPlugins(req, res, transformedResponse, hookConfig);
        
        if (debugRequestId) {
          payloadLogger.savePayload(debugRequestId, '05_after_plugin_modified_response', finalResponse, req, res);
        }
      }

      return finalResponse;
    }
  } catch (error: any) {
    logger.error('AwsBedrockService', `Error in emulated request: ${error.message}`, error, {
      code: error.code,
      isTimeout: error.isAxiosError && error.code === 'ECONNABORTED'
    });
    if (error.response) {
      logger.error('AwsBedrockService', `SAP AI Core error response: ${error.response.status}`, undefined, { data: error.response.data });
      if (debugRequestId) {
        payloadLogger.savePayload(debugRequestId, '03_emulated_error_from_sap', {
          status: error.response.status,
          data: error.response.data
        }, req, res);
      }
      // Converse payloads carry no anthropic_beta today — this hook is defense-in-depth should the transform ever forward beta flags.
      const sentBetaFlags: string[] = Array.isArray(requestBody?.anthropic_beta)
        ? requestBody.anthropic_beta.map(String)
        : [];
      if (sentBetaFlags.length > 0
          && betaFlagQuarantine.isInvalidBetaFlagError(error.response.status, error.response.data)) {
        betaFlagQuarantine.recordBetaFlagRejection(modelId, error.response.data, sentBetaFlags);
      }
    }
    throw error;
  }
}

// Additional type definitions for transformation functions
interface AnthropicRequest {
  system?: string | any[];
  messages?: AnthropicMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number; 
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  [key: string]: any;
}

interface AnthropicMessage {
  role: string;
  content: string | AnthropicContent[];
  [key: string]: any;
}

interface AnthropicContent {
  type: string;
  text?: string;
  source?: {
    media_type?: string;
    data?: string;
  };
  id?: string;
  name?: string;
  input?: any;
  content?: any;
  tool_use_id?: string;
  [key: string]: any;
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: any;
}

interface BedrockRequest {
  modelId: string;
  messages: BedrockConversationMessage[];
  inferenceConfig: BedrockInferenceConfig;
  system?: BedrockSystemMessage[];
  toolConfig?: BedrockToolConfig;
  [key: string]: any;
}

interface BedrockConversationMessage {
  role: string;
  content: BedrockContentBlock[];
}

interface BedrockContentBlock {
  text?: string;
  image?: {
    format: string;
    source: {
      bytes: string;
    };
  };
  toolUse?: {
    toolUseId: string;
    name: string;
    input: any;
  };
  toolResult?: {
    toolUseId: string;
    content: BedrockContentBlock[];
  };
}

interface BedrockSystemMessage {
  text: string;
}

interface BedrockInferenceConfig {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
}

interface BedrockToolConfig {
  tools: BedrockToolSpec[];
}

interface BedrockToolSpec {
  toolSpec: {
    name: string;
    description: string;
    inputSchema: {
      json: any;
    };
  };
}

interface BedrockResponse {
  output?: {
    message?: {
      content?: BedrockContentBlock[];
    };
  };
  stopReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  responseMetadata?: {
    requestId?: string;
  };
}

/**
 * Transform Anthropic Messages API request to Bedrock Converse API format
 */
function transformAnthropicToBedrockConverse(anthropicRequest: AnthropicRequest, originalModelId: string): BedrockRequest {
  const bedrockRequest: BedrockRequest = {
    modelId: originalModelId,
    messages: [],
    inferenceConfig: {}
  };

  // Transform system message
  if (anthropicRequest.system) {
    if (typeof anthropicRequest.system === 'string') {
      bedrockRequest.system = [{ text: anthropicRequest.system }];
    } else if (Array.isArray(anthropicRequest.system)) {
      bedrockRequest.system = anthropicRequest.system.map(item => {
        if (typeof item === 'string') {
          return { text: item };
        } else if (item.type === 'text') {
          return { text: item.text };
        }
        return item;
      });
    }
  }

  // Transform messages
  if (anthropicRequest.messages && Array.isArray(anthropicRequest.messages)) {
    bedrockRequest.messages = anthropicRequest.messages.map(msg => {
      const bedrockMsg: BedrockConversationMessage = {
        role: msg.role,
        content: []
      };
      
      if (typeof msg.content === 'string') {
        bedrockMsg.content = [{ text: msg.content || '' }];
      } else if (Array.isArray(msg.content)) {
        bedrockMsg.content = msg.content.map(item => {
          if (typeof item === 'string') {
            return { text: item };
          } else if (item.type === 'text') {
            return { text: item.text || '' };
          } else if (item.type === 'image') {
            return {
              image: {
                format: item.source?.media_type?.split('/')[1] || 'png',
                source: {
                  bytes: item.source?.data || ''
                }
              }
            };
          } else if (item.type === 'tool_use') {
            return {
              toolUse: {
                toolUseId: item.id || '',
                name: item.name || '',
                input: item.input
              }
            };
          } else if (item.type === 'tool_result') {
            // Transform tool_result format to Bedrock's toolResult format
            let toolResultContent: BedrockContentBlock[] = [];
            
            if (typeof item.content === 'string') {
              // Simple string content
              toolResultContent = [{ text: item.content }];
            } else if (Array.isArray(item.content)) {
              // Array content - extract text from nested structures
              toolResultContent = item.content.map(contentItem => {
                if (typeof contentItem === 'string') {
                  return { text: contentItem };
                } else if (contentItem && typeof contentItem === 'object') {
                  // Handle nested structures like { text: [{ text: "actual content", type: "text" }] }
                  if (Array.isArray(contentItem.text)) {
                    // Extract the actual text from deeply nested structure
                    const actualText = contentItem.text
                      .map((nested: any) => nested.text || nested)
                      .join(' ');
                    return { text: actualText };
                  } else if (contentItem.text) {
                    return { text: contentItem.text };
                  } else if (contentItem.type === 'text' && contentItem.text) {
                    return { text: contentItem.text };
                  } else {
                    // Fallback: convert object to string
                    return { text: JSON.stringify(contentItem) };
                  }
                }
                return { text: String(contentItem) };
              }).filter(item => item.text); // Remove empty items
            } else if (item.content && typeof item.content === 'object') {
              // Single object content
              if (item.content.text) {
                toolResultContent = [{ text: item.content.text }];
              } else {
                toolResultContent = [{ text: JSON.stringify(item.content) }];
              }
            } else {
              // Fallback for any other type
              toolResultContent = [{ text: String(item.content || "") }];
            }
            
            // Ensure we have at least one content item
            if (toolResultContent.length === 0) {
              toolResultContent = [{ text: "" }];
            }
            
            return {
              toolResult: {
                toolUseId: item.tool_use_id || '',
                content: toolResultContent
              }
            };
          }
          
          // Log warning for unhandled content types
          logger.warn('AwsBedrockService', `Unhandled content type in message: ${JSON.stringify(item)}`);
          
          // If we can't map it properly, return a minimal valid block to avoid errors
          return { text: "" };
        });
        
        // If content array is empty after mapping, add a minimum valid content block
        if (bedrockMsg.content.length === 0) {
          bedrockMsg.content = [{ text: "" }];
        }
      } else {
        // For undefined or null content, provide a default
        bedrockMsg.content = [{ text: "" }];
      }

      return bedrockMsg;
    });
  }

  // Transform inference parameters
  if (anthropicRequest.max_tokens !== undefined) {
    bedrockRequest.inferenceConfig.maxTokens = anthropicRequest.max_tokens;
  }
  if (anthropicRequest.temperature !== undefined) {
    bedrockRequest.inferenceConfig.temperature = anthropicRequest.temperature;
  }
  if (anthropicRequest.top_p !== undefined) {
    bedrockRequest.inferenceConfig.topP = anthropicRequest.top_p;
  }
  if (anthropicRequest.top_k !== undefined) {
    bedrockRequest.inferenceConfig.topK = anthropicRequest.top_k;
  }
  if (anthropicRequest.stop_sequences && anthropicRequest.stop_sequences.length > 0) {
    bedrockRequest.inferenceConfig.stopSequences = anthropicRequest.stop_sequences;
  }

  // Transform tools
  if (anthropicRequest.tools && Array.isArray(anthropicRequest.tools)) {
    bedrockRequest.toolConfig = {
      tools: anthropicRequest.tools.map(tool => ({
        toolSpec: {
          name: tool.name,
          description: tool.description,
          inputSchema: {
            json: tool.input_schema
          }
        }
      }))
    };
  }

  return bedrockRequest;
}

/**
 * Transform Bedrock response back to Anthropic format
 */
function transformBedrockToAnthropicResponse(bedrockResponse: BedrockResponse, originalSubpath: string, originalModelId: string): any {
  if (originalSubpath === 'invoke' || originalSubpath === 'invoke-with-response-stream') {
    // Transform Bedrock Converse response to Anthropic format
    const anthropicResponse = {
      content: [] as any[],
      id: bedrockResponse.responseMetadata?.requestId || `msg_${Date.now()}`,
      model: originalModelId,
      role: 'assistant',
      stop_reason: null as string | null,
      stop_sequence: null as string | null,
      type: 'message',
      usage: {} as any
    };

    // Transform content
    if (bedrockResponse.output && bedrockResponse.output.message && bedrockResponse.output.message.content) {
      anthropicResponse.content = bedrockResponse.output.message.content.map(item => {
        if (item.text) {
          return {
            text: item.text,
            type: 'text'
          };
        } else if (item.toolUse) {
          return {
            id: item.toolUse.toolUseId.replace(/^tooluse_/, 'toolu_bdrk_'),
            input: item.toolUse.input,
            name: item.toolUse.name,
            type: 'tool_use'
          };
        }
        return item;
      });
    }

    // Transform stop reason
    if (bedrockResponse.stopReason) {
      const stopReasonMap: Record<string, string> = {
        'end_turn': 'end_turn',
        'tool_use': 'tool_use',
        'max_tokens': 'max_tokens',
        'stop_sequence': 'stop_sequence'
      };
      anthropicResponse.stop_reason = stopReasonMap[bedrockResponse.stopReason] || bedrockResponse.stopReason;
    }

    // Transform usage
    if (bedrockResponse.usage) {
      anthropicResponse.usage = {
        input_tokens: bedrockResponse.usage.inputTokens || 0,
        output_tokens: bedrockResponse.usage.outputTokens || 0
      };
    }

    return anthropicResponse;
  }

  // For other subpaths, return as-is
  return bedrockResponse;
}

// Additional interface definitions for streaming functions
interface StreamingRequestOptions {
  targetUrl: string;
  requestBody: any;
  authToken: string;
  headers: Record<string, string>;
  debugRequestId: string;
  req: Request;
  res: Response;
  modelDetails: ModelDetails;
  modelId: string;
  subpath: string;
  hookConfig?: any;
  usageMetrics?: any; // Add usage metrics for tracking
  originalModelId?: string; // Add original model ID for usage tracking
  outputFormat?: OutputFormat; // Output format: 'anthropic' for Anthropic API format, 'bedrock' for native Bedrock format
}

interface EmulatedStreamingRequestOptions extends StreamingRequestOptions {
  originalSubpath: string;
  // originalModelId is inherited from StreamingRequestOptions
}

/**
 * Handle native streaming requests
 */
async function handleNativeStreamingRequest(options: StreamingRequestOptions): Promise<void> {
  const { targetUrl, requestBody, authToken, debugRequestId, req, res, modelId, hookConfig, outputFormat } = options;
  logger.info('AwsBedrockService', 'Starting native streaming request');
  logger.debug('AwsBedrockService', `Native streaming options: hasUsageMetrics=${!!(options as any).usageMetrics}, originalModelId=${(options as any).originalModelId}`);
  
  // Ensure proper headers are set for SSE
  if (!res.headersSent) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering
  }
  
  // Determine if we should use the stream parser
  // For 'invoke-with-response-stream' we use the parser for better handling
  // For other streaming endpoints, we pass through directly
  const useStreamParser = targetUrl.includes('invoke-with-response-stream');
  
  // Initialize response capture for payload logging
  let capturedResponseChunks: string[] = [];
  
  try {
    logger.info('AwsBedrockService', `Making native streaming request to: ${targetUrl}`);
    
    // Build request headers
    const requestHeaders = {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      'AI-Resource-Group': process.env.SAP_AI_RESOURCE_GROUP || 'default'
    };
    
    // Debug logging for authentication issues
    if (process.env.DEBUG === 'true') {
      logger.debug('AwsBedrockService', 'DEBUG - Request headers: ' + createHeadersPreview(requestHeaders));
      logger.debug('AwsBedrockService', 'DEBUG - Request payload: ' + createSafePreview(requestBody, 500));
    }
    
    const timeout = configService.getTimeout(true);
    const response: AxiosResponse = await axios.post(targetUrl, requestBody, {
      headers: requestHeaders,
      responseType: 'stream',
      timeout: timeout
    });
    
    logger.info('AwsBedrockService', 'Got native streaming response, processing chunks');
    
    // Send an initial ping to ensure connection is established and start events flowing
    // Track if we've seen any data
    let hasReceivedData = false;
    
    // Only initiate ping for useStreamParser mode, not for direct passthrough
    if (useStreamParser) {
      logger.info('AwsBedrockService', 'Initializing ping mechanism for stream parser mode');
      sseWriter.writePing(res);
      
      // Setup periodic ping to keep the connection alive
      const pingInterval = setInterval(() => {
        if (!res.writableEnded) {
          logger.trace('AwsBedrockService', 'Sending periodic ping to maintain native connection');
          sseWriter.writePing(res);
        } else {
          clearInterval(pingInterval);
        }
      }, 15000); // Send ping every 15 seconds
      
      // Clear interval when connection ends
      req.on('close', () => {
        clearInterval(pingInterval);
      });
    } else {
      logger.info('AwsBedrockService', 'Skipping ping mechanism for direct passthrough mode');
    }

    if (useStreamParser) {
      // Use stream parser for invoke-with-response-stream endpoints
      logger.info('AwsBedrockService', `Using stream parser for native request with outputFormat: ${outputFormat || 'bedrock'}`);
      const streamParser = new BedrockStreamParser(modelId, 'invoke-with-response-stream', outputFormat || 'bedrock');
      
      response.data.on('data', async (chunk: Buffer) => {
        if (!res.writableEnded) {
          try {
            const chunkStr = chunk.toString();
            logger.debug('AwsBedrockService', `Processing chunk: ${chunkStr.substring(0, 100)}...`);
            
            // Capture chunk for payload logging
            if (debugRequestId) {
              capturedResponseChunks.push(chunkStr);
            }
            
            // CRITICAL: Execute stream plugins for EACH chunk
            if (hookConfig) {
              try {
                logger.debug('AwsBedrockService', `Executing stream plugins for chunk`);
                await executeStreamPlugins(req, res, chunk, hookConfig);
                
                // DEBUG: Check if events were captured
                if ((req as any).capturedEvents && (req as any).capturedEvents.length > 0) {
                  logger.debug('AwsBedrockService', `After stream plugin: ${(req as any).capturedEvents.length} events captured`);
                } else {
                  logger.debug('AwsBedrockService', `After stream plugin: NO events captured yet`);
                }
              } catch (error: any) {
                logger.error('AwsBedrockService', `Error in stream plugin execution: ${error.message}`);
              }
            } else {
              logger.warn('AwsBedrockService', `No hook config available for stream plugins`);
            }
            
            // Extract usage data from chunk before processing (for usage tracking)
            if (options.usageMetrics && chunkStr.includes('amazon-bedrock-invocationMetrics')) {
              try {
                // Extract the data content from the SSE format
                const dataMatch = chunkStr.match(/data: (.*?)(?:\n\n|\n$|$)/s);
                if (dataMatch && dataMatch[1]) {
                  const jsonData = JSON.parse(dataMatch[1].trim());
                  
                  // Check for message_stop with amazon-bedrock-invocationMetrics
                  if (jsonData.type === 'message_stop' && jsonData['amazon-bedrock-invocationMetrics']) {
                    const metrics = jsonData['amazon-bedrock-invocationMetrics'];
                    logger.debug('AwsBedrockService', `Native streaming - extracted usage metrics: ${JSON.stringify(metrics)}`);
                    
                    if (metrics) {
                      const inputTokens = metrics.inputTokenCount || 0;
                      const outputTokens = metrics.outputTokenCount || 0;
                      updateTokenCounts(options.usageMetrics, inputTokens, outputTokens);
                      
                      // Determine provider based on request endpoint
                      const originalModelId = options.originalModelId || options.modelId;
                      let provider = 'aws-bedrock'; // Default provider
                      
                      // Check if original request came through Anthropic endpoint
                      const requestPath = options.req.originalUrl || options.req.path || options.req.url || '';
                      
                      if (requestPath.includes('/anthropic/')) {
                        provider = 'anthropic';
                      } else if (requestPath.includes('/openai/')) {
                        provider = 'openai';
                      }
                      // Otherwise keep default 'aws-bedrock'
                      
                      // Only emit usage event once when final metrics are available
                      if (!options.usageMetrics.eventEmitted) {
                        emitUsageEvent(options.req, options.usageMetrics, options.modelId, 200);
                        options.usageMetrics.eventEmitted = true;
                      }
                      logger.info('AwsBedrockService', `Usage tracked for deployed model native streaming: ${inputTokens} input tokens, ${outputTokens} output tokens, provider: ${provider}`);
                    }
                  }
                }
              } catch (parseError: any) {
                logger.debug('AwsBedrockService', `Could not extract usage from chunk: ${parseError.message}`);
              }
            }
            
            // Process the chunk
            streamParser.processChunk(chunk, res);
            hasReceivedData = true;  // Mark that we received data
            
          } catch (error: any) {
            logger.error('AwsBedrockService', 'Error processing native stream chunk:', error);
          }
        }
      });
    } else {
      // For other streaming endpoints, pipe directly
      logger.info('AwsBedrockService', 'Using direct passthrough for native streaming request');
      response.data.on('data', async (chunk: Buffer) => {
        if (!res.writableEnded) {
          // Add minimal delay to prevent race condition (mimics logging overhead)
          await new Promise(resolve => setImmediate(resolve));
          
          const chunkStr = chunk.toString();
          logger.trace('AwsBedrockService', `Native direct passthrough chunk (${chunkStr.length} bytes): ${chunkStr.substring(0, 200)}${chunkStr.length > 200 ? '...' : ''}`);
          
          // Capture chunk for payload logging
          if (debugRequestId) {
            capturedResponseChunks.push(chunkStr);
          }
          
          // Execute stream plugins
          let processedChunk: Buffer = chunk;
          if (hookConfig) {
            processedChunk = await executeStreamPlugins(req, res, chunk, hookConfig);
          }
          
          hasReceivedData = true;
          res.write(processedChunk);
        }
      });
    }

    response.data.on('end', async () => {
      logger.debug('AwsBedrockService', `Native stream ended, hasReceivedData: ${hasReceivedData}`);
      
      // Log the complete streaming response if we have debug request ID
      if (debugRequestId && capturedResponseChunks.length > 0) {
        const completeResponse = capturedResponseChunks.join('');
        payloadLogger.savePayload(debugRequestId, '03_native_streaming_response_from_sap', {
          type: 'streaming',
          totalChunks: capturedResponseChunks.length,
          totalLength: completeResponse.length,
          rawResponse: completeResponse
        });
      }
      
      // CRITICAL: Execute after plugins with captured data
      if (hookConfig) {
        try {
          // The stream plugins should have populated req.capturedEvents
          if ((req as any).capturedEvents && Array.isArray((req as any).capturedEvents)) {
            logger.info('AwsBedrockService', `Executing after plugins with ${(req as any).capturedEvents.length} captured events`);
            await executeAfterPlugins(req, res, { events: (req as any).capturedEvents }, hookConfig);
          } else {
            // No captured events - this could be expected if no caching plugins matched the request
            logger.debug('AwsBedrockService', 'No captured events found - plugins may not have matched request criteria or no streaming capture was needed');
            // Still try to execute after plugins, they might not need events
            await executeAfterPlugins(req, res, { message: 'Stream completed without captured events' }, hookConfig);
          }
        } catch (error: any) {
          logger.error('AwsBedrockService', `Error executing after plugins: ${error.message}`);
        }
      }
      
      // If we received no data, write a simple response to prevent empty response
      if (!hasReceivedData && !res.writableEnded) {
        logger.warn('AwsBedrockService', 'No data received in native stream, sending fallback response');
        
        if (useStreamParser) {
          // Create a message_start event
          const messageId = `msg_bdrk_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
          sseWriter.writeEventStream(res, 'message_start', JSON.stringify({
            type: 'message_start',
            message: {
              id: messageId,
              type: 'message',
              role: 'assistant',
              model: modelId,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 }
            }
          }));
          
          // Emit content block start
          sseWriter.writeEventStream(res, 'content_block_start', JSON.stringify({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' }
          }));
          
          // Emit some text
          sseWriter.writeEventStream(res, 'content_block_delta', JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: "I'm Claude, an AI assistant by Anthropic. How can I help you today?" }
          }));
          
          // End the content block
          sseWriter.writeEventStream(res, 'content_block_stop', JSON.stringify({
            type: 'content_block_stop',
            index: 0
          }));
          
          // Emit message_stop
          sseWriter.writeEventStream(res, 'message_stop', JSON.stringify({
            type: 'message_stop',
            'amazon-bedrock-invocationMetrics': { 
              inputTokenCount: 10,
              outputTokenCount: 15,
              invocationLatency: 500,
              firstByteLatency: 200
            }
          }));
        } else {
          // For direct passthrough, just send simple data
          res.write('data: {"type": "text", "content": "I\'m an AI assistant. How can I help you today?"}\n\n');
        }
      }
      
      if (!res.writableEnded) {
        res.end();
      }
      logger.info('AwsBedrockService', 'Native streaming completed');
    });

    response.data.on('error', (error: any) => {
      logger.error('AwsBedrockService', 'Native streaming error:', error);
      if (!res.writableEnded) {
        sseWriter.writeError(res, error);
      }
    });

    // Handle client disconnection
    req.on('close', () => {
      logger.debug('AwsBedrockService', 'Client disconnected from native stream');
      if (response.data.destroy) {
        response.data.destroy();
      }
    });
  } catch (error: any) {
    logger.error('AwsBedrockService', 'Error in native streaming:', error, {
      code: error.code,
      isTimeout: error.isAxiosError && error.code === 'ECONNABORTED'
    });
    
    // Enhanced error logging for auth issues
    if (error.response && error.response.status === 401) {
      logger.error('AwsBedrockService', `Authentication failed (401) for request to: ${targetUrl}`);
      logger.error('AwsBedrockService', 'Error details:', undefined, { data: error.response.data });
      
      // Log auth details if DEBUG is enabled
      if (process.env.DEBUG === 'true') {
        logger.debug('AwsBedrockService', 'DEBUG - Auth token used:', { token: authToken });
        logger.debug('AwsBedrockService', 'DEBUG - Response headers: ' + createHeadersPreview(error.response.headers));
      }
    }

    if (error.response) {
      const sentBetaFlags: string[] = Array.isArray(requestBody?.anthropic_beta)
        ? requestBody.anthropic_beta.map(String)
        : [];
      if (sentBetaFlags.length > 0
          && betaFlagQuarantine.isInvalidBetaFlagError(error.response.status, error.response.data)) {
        betaFlagQuarantine.recordBetaFlagRejection(modelId, error.response.data, sentBetaFlags);
      }
    }

    if (!res.writableEnded) {
      sseWriter.writeError(res, error);
    }
  }
}

/**
 * Handle emulated streaming requests with response transformation
 */
async function handleEmulatedStreamingRequest(options: EmulatedStreamingRequestOptions): Promise<void> {
  const { targetUrl, requestBody, authToken, debugRequestId, req, res, originalSubpath, originalModelId, modelId, subpath, hookConfig } = options;
  logger.info('AwsBedrockService', `Starting emulated streaming request for original subpath: ${originalSubpath}`);
  
  // Initialize response capture for payload logging
  let capturedResponseChunks: string[] = [];
  
  try {
    // Set SSE headers
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
    }
    
    // Make the request to Bedrock
    logger.info('AwsBedrockService', `Making emulated request to: ${targetUrl}`);
    
    // Build request headers
    const requestHeaders = {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      'AI-Resource-Group': process.env.SAP_AI_RESOURCE_GROUP || 'default',
    };
    
    // Debug logging for authentication issues
    if (process.env.DEBUG === 'true') {
      logger.debug('AwsBedrockService', 'DEBUG - Request headers: ' + createHeadersPreview(requestHeaders));
      logger.debug('AwsBedrockService', 'DEBUG - Request payload: ' + createSafePreview(requestBody, 500));
    }
    
    const timeout = configService.getTimeout(true);
    const bedrockResponse: AxiosResponse = await axios.post(targetUrl, requestBody, {
      headers: requestHeaders,
      responseType: 'stream',
      timeout: timeout 
    });

    logger.info('AwsBedrockService', 'Got streaming response, processing chunks');
    
    // Record success when stream starts successfully
    rateLimitManager.recordSuccess(modelId, subpath);
    
    // State tracking
    let hasReceivedData = false;
    let messageId = `msg_bdrk_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
    let hasEmittedMessageStart = false;
    let contentBlocks = new Map<number, { type: string; emitted: boolean }>(); // To track content blocks by index
    
    // Process stream chunks
    bedrockResponse.data.on('data', async (chunk: Buffer) => {
      if (res.writableEnded) return;
      
      try {
        // Execute stream plugins BEFORE processing the chunk
        let processedChunk: Buffer = chunk;
        if (hookConfig) {
          processedChunk = await executeStreamPlugins(req, res, chunk, hookConfig);
        }
        
        const chunkStr = processedChunk.toString();
        logger.trace('AwsBedrockService', `Received chunk (${chunkStr.length} bytes): ${chunkStr.substring(0, 200)}${chunkStr.length > 200 ? '...' : ''}`);
        
        // Capture chunk for payload logging
        if (debugRequestId) {
          capturedResponseChunks.push(chunkStr);
        }
        
        if (chunkStr.trim().length === 0) return;
        
        hasReceivedData = true;
        
        // Extract the data content from the SSE format
        const dataMatch = chunkStr.match(/data: (.*?)(?:\n\n|\n$|$)/s);
        if (!dataMatch || !dataMatch[1]) return;
        
        const dataContent = dataMatch[1].trim();
        
        // Parse the JS object using Function instead of eval for slightly better security
        try {
          // Convert single-quoted JS object to actual JS object 
          // This avoids the complexities of JSON parsing with single quotes
          const jsonData = Function(`"use strict"; return (${dataContent})`)();
          
          // Transform based on event type
          if (jsonData.messageStart) {
            if (!hasEmittedMessageStart) {
              sseWriter.writeEventStream(res, 'message_start', JSON.stringify({
                type: 'message_start',
                message: {
                  id: messageId,
                  type: 'message',
                  role: jsonData.messageStart.role || 'assistant',
                  model: originalModelId,
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: {input_tokens: 0, output_tokens: 0}
                }
              }));
              hasEmittedMessageStart = true;
            }
          }
          else if (jsonData.contentBlockStart) {
            const blockIndex = jsonData.contentBlockIndex ?? jsonData.contentBlockStart.contentBlockIndex;
            
            // Determine the block type
            const isToolUse = jsonData.contentBlockStart.start?.toolUse !== undefined;
            let contentBlock = {
              type: 'content_block_start',
              index: blockIndex,
              content_block: isToolUse 
                ? {
                    type: 'tool_use',
                    id: `toolu_bdrk_${jsonData.contentBlockStart.start.toolUse.toolUseId.replace('tooluse_', '')}`,
                    name: jsonData.contentBlockStart.start.toolUse.name,
                    input: {}
                  }
                : {
                    type: 'text',
                    text: ''
                  }
            };
            
            contentBlocks.set(blockIndex, {
              type: isToolUse ? 'tool_use' : 'text',
              emitted: true
            });
            
            sseWriter.writeEventStream(res, 'content_block_start', JSON.stringify(contentBlock));
          }
          else if (jsonData.contentBlockDelta) {
            const blockIndex = jsonData.contentBlockIndex ?? jsonData.contentBlockDelta.contentBlockIndex;
            
            // Auto-create content block if we didn't see a start event
            if (!contentBlocks.has(blockIndex)) {
              const isToolUse = jsonData.contentBlockDelta.delta?.toolUse !== undefined;
              const contentBlockType = isToolUse ? 'tool_use' : 'text';
              
              // Emit an implicit content block start
              const contentBlock = {
                type: 'content_block_start',
                index: blockIndex,
                content_block: contentBlockType === 'tool_use' 
                  ? {
                      type: 'tool_use',
                      id: `toolu_bdrk_${Date.now().toString(36)}_auto`,
                      name: 'auto_detected_tool',
                      input: {}
                    }
                  : {
                      type: 'text',
                      text: ''
                    }
              };
              
              contentBlocks.set(blockIndex, {
                type: contentBlockType,
                emitted: true
              });
              
              sseWriter.writeEventStream(res, 'content_block_start', JSON.stringify(contentBlock));
            }
            
            const delta = jsonData.contentBlockDelta.delta;
            
            // Handle text deltas
            if (delta.text !== undefined) {
              sseWriter.writeEventStream(res, 'content_block_delta', JSON.stringify({
                type: 'content_block_delta',
                index: blockIndex,
                delta: {
                  type: 'text_delta',
                  text: delta.text
                }
              }));
            } 
            // Handle tool use input deltas
            else if (delta.toolUse?.input !== undefined) {
              sseWriter.writeEventStream(res, 'content_block_delta', JSON.stringify({
                type: 'content_block_delta',
                index: blockIndex,
                delta: {
                  type: 'input_json_delta',
                  partial_json: delta.toolUse.input
                }
              }));
            }
            // Handle partial_json (might be present in some models)
            else if (delta.partial_json) {
              sseWriter.writeEventStream(res, 'content_block_delta', JSON.stringify({
                type: 'content_block_delta',
                index: blockIndex,
                delta: {
                  type: 'input_json_delta',
                  partial_json: delta.partial_json
                }
              }));
            }
          }
          else if (jsonData.contentBlockStop) {
            const blockIndex = jsonData.contentBlockIndex ?? jsonData.contentBlockStop.contentBlockIndex;
            
            sseWriter.writeEventStream(res, 'content_block_stop', JSON.stringify({
              type: 'content_block_stop',
              index: blockIndex
            }));
          }
          else if (jsonData.messageStop) {
            sseWriter.writeEventStream(res, 'message_delta', JSON.stringify({
              type: 'message_delta',
              delta: {
                stop_reason: jsonData.messageStop.stopReason,
                stop_sequence: null
              },
              usage: {}
            }));
          }
          else if (jsonData.metadata) {
            logger.debug('AwsBedrockService', `Processing metadata block: ${JSON.stringify(jsonData.metadata)}`);
            // Send usage information
            if (jsonData.metadata.usage) {
              sseWriter.writeEventStream(res, 'message_delta', JSON.stringify({
                type: 'message_delta',
                delta: {},
                usage: {
                  output_tokens: jsonData.metadata.usage.outputTokens || 0
                }
              }));
            }
            
            // Send final message_stop
            sseWriter.writeEventStream(res, 'message_stop', JSON.stringify({
              type: 'message_stop',
              'amazon-bedrock-invocationMetrics': {
                inputTokenCount: jsonData.metadata.usage?.inputTokens || 0,
                outputTokenCount: jsonData.metadata.usage?.outputTokens || 0,
                invocationLatency: jsonData.metadata.metrics?.latencyMs || 0,
                firstByteLatency: jsonData.metadata.metrics?.firstByteLatency || 0
              }
            }));
            
            // Track usage for streaming completion (if usage metrics provided)
            logger.debug('AwsBedrockService', `Checking usage tracking: hasUsageMetrics=${!!options.usageMetrics}, hasUsageData=${!!jsonData.metadata.usage}`);
            if (options.usageMetrics && jsonData.metadata.usage) {
              const inputTokens = jsonData.metadata.usage.inputTokens || 0;
              const outputTokens = jsonData.metadata.usage.outputTokens || 0;
              updateTokenCounts(options.usageMetrics, inputTokens, outputTokens);
              // Only emit usage event once when final metrics are available
              if (!options.usageMetrics.eventEmitted) {
                emitUsageEvent(options.req, options.usageMetrics, options.modelId, 200);
                options.usageMetrics.eventEmitted = true;
              }
              logger.info('AwsBedrockService', `Usage tracked for deployed model streaming: ${inputTokens} input tokens, ${outputTokens} output tokens`);
            } else {
              logger.warn('AwsBedrockService', `Usage tracking skipped - usageMetrics: ${!!options.usageMetrics}, metadataUsage: ${!!jsonData.metadata?.usage}`);
            }
          }
          // NEW: Handle message_stop with amazon-bedrock-invocationMetrics (current format)
          else if (jsonData.type === 'message_stop' && jsonData['amazon-bedrock-invocationMetrics']) {
            logger.debug('AwsBedrockService', `Processing message_stop with invocation metrics: ${JSON.stringify(jsonData['amazon-bedrock-invocationMetrics'])}`);
            
            // Track usage for streaming completion (if usage metrics provided)
            const metrics = jsonData['amazon-bedrock-invocationMetrics'];
            logger.debug('AwsBedrockService', `Checking usage tracking: hasUsageMetrics=${!!options.usageMetrics}, hasMetrics=${!!metrics}`);
            if (options.usageMetrics && metrics) {
              const inputTokens = metrics.inputTokenCount || 0;
              const outputTokens = metrics.outputTokenCount || 0;
              updateTokenCounts(options.usageMetrics, inputTokens, outputTokens);
              // Only emit usage event once when final metrics are available
              if (!options.usageMetrics.eventEmitted) {
                emitUsageEvent(options.req, options.usageMetrics, options.modelId, 200);
                options.usageMetrics.eventEmitted = true;
              }
              logger.info('AwsBedrockService', `Usage tracked for deployed model streaming: ${inputTokens} input tokens, ${outputTokens} output tokens`);
            } else {
              logger.warn('AwsBedrockService', `Usage tracking skipped - usageMetrics: ${!!options.usageMetrics}, invocationMetrics: ${!!metrics}`);
            }
          }
        } catch (parseError: any) {
          console.error(`[AwsBedrockService] Error parsing data chunk:`, parseError, dataContent);
        }
      } catch (error: any) {
        console.error(`[AwsBedrockService] Error processing stream chunk:`, error);
        if (!res.writableEnded) {
          sseWriter.writeError(res, error);
        }
      }
    });

    // Handle stream end
    bedrockResponse.data.on('end', async () => {
      logger.debug('AwsBedrockService', `Stream ended, hasReceivedData: ${hasReceivedData}`);
      
      // Log the complete streaming response if we have debug request ID
      if (debugRequestId && capturedResponseChunks.length > 0) {
        const completeResponse = capturedResponseChunks.join('');
        payloadLogger.savePayload(debugRequestId, '03_emulated_streaming_response_from_sap', {
          type: 'streaming',
          originalSubpath,
          targetSubpath: subpath,
          totalChunks: capturedResponseChunks.length,
          totalLength: completeResponse.length,
          rawResponse: completeResponse
        });
      }
      
      // After stream ends, execute after plugins for cached data
      if (hookConfig && (req as any).capturedEvents && Array.isArray((req as any).capturedEvents)) {
        try {
          await executeAfterPlugins(req, res, { events: (req as any).capturedEvents }, hookConfig);
        } catch (error: any) {
          logger.error('AwsBedrockService', `Error executing after plugins for cached events: ${error.message}`);
        }
      }
      
      // If we received no data, write a simple response to prevent empty response
      if (!hasReceivedData && !res.writableEnded) {
        logger.warn('AwsBedrockService', 'No data received in stream, sending fallback response');
        
        // Create a message_start event
        sseWriter.writeEventStream(res, 'message_start', JSON.stringify({
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model: originalModelId,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
          }
        }));
        
        // Emit content block with fallback text
        sseWriter.writeEventStream(res, 'content_block_start', JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' }
        }));
        
        sseWriter.writeEventStream(res, 'content_block_delta', JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: "I'm Claude, an AI assistant by Anthropic. How can I help you today?" }
        }));
        
        sseWriter.writeEventStream(res, 'content_block_stop', JSON.stringify({
          type: 'content_block_stop',
          index: 0
        }));
        
        sseWriter.writeEventStream(res, 'message_stop', JSON.stringify({
          type: 'message_stop',
          'amazon-bedrock-invocationMetrics': { 
            inputTokenCount: 10,
            outputTokenCount: 15,
            invocationLatency: 500,
            firstByteLatency: 200
          }
        }));
      }
      
      if (!res.writableEnded) {
        res.end();
      }
      logger.info('AwsBedrockService', `Emulated streaming completed for ${originalModelId}`);
    });

    // Handle stream errors
    bedrockResponse.data.on('error', (error: any) => {
      logger.error('AwsBedrockService', 'Emulated streaming error:', error);
      if (!res.writableEnded) {
        sseWriter.writeError(res, error);
      }
    });

    // Handle client disconnection
    req.on('close', () => {
      logger.debug('AwsBedrockService', `Client disconnected from emulated stream for ${originalModelId}`);
      if (bedrockResponse.data.destroy) {
        bedrockResponse.data.destroy();
      }
    });
  } catch (error: any) {
    logger.error('AwsBedrockService', 'Error establishing emulated stream:', error, {
      code: error.code,
      isTimeout: error.isAxiosError && error.code === 'ECONNABORTED'
    });

    // Enhanced error logging for auth issues
    if (error.response && error.response.status === 401) {
      logger.error('AwsBedrockService', `Authentication failed (401) for request to: ${targetUrl}`);
      logger.error('AwsBedrockService', 'Error details:', undefined, { data: error.response.data });

      // Log auth details if DEBUG is enabled
      if (process.env.DEBUG === 'true') {
        logger.debug('AwsBedrockService', 'DEBUG - Auth token used:', { token: authToken });
        logger.debug('AwsBedrockService', 'DEBUG - Response headers: ' + createHeadersPreview(error.response.headers));
      }
    }

    if (error.response) {
      // Converse payloads carry no anthropic_beta today — this hook is defense-in-depth should the transform ever forward beta flags.
      const sentBetaFlags: string[] = Array.isArray(requestBody?.anthropic_beta)
        ? requestBody.anthropic_beta.map(String)
        : [];
      if (sentBetaFlags.length > 0
          && betaFlagQuarantine.isInvalidBetaFlagError(error.response.status, error.response.data)) {
        betaFlagQuarantine.recordBetaFlagRejection(modelId, error.response.data, sentBetaFlags);
      }
    }

    if (!res.writableEnded) {
      const message = error.response?.data?.message || error.message || "Failed to establish stream";
      const status = error.response?.status || 500;
      const errToSend = new Error(message) as any;
      errToSend.status = status;
      sseWriter.writeError(res, errToSend);
    }
  }
}

/**
 * Construct the target URL for API calls
 * @param baseUrl - The base deployment URL
 * @param subpath - The API subpath (invoke, converse, etc.)
 * @param modelDetails - Model details from modelService
 * @returns The complete target URL
 */
function constructTargetUrl(baseUrl: string, subpath: string, _modelDetails: ModelDetails): string {
  // Simply append the subpath to the base URL - no hard-coded logic
  // The subpath handling should be determined by the model configuration
  return `${baseUrl}/${subpath}`;
}

/**
 * Construct deployment URL from model details
 * @param modelDetails - Model details from modelService
 * @returns The deployment URL
 */
function constructDeploymentUrl(modelDetails: ModelDetails): string {
  // This would typically use SAP AI Core URL construction
  // For now, return the deploymentUrl if available
  if (modelDetails.deploymentUrl) {
    return modelDetails.deploymentUrl;
  }
  
  // Fallback construction - this would need to be adapted based on SAP AI Core structure
  const baseUrl = configService.getSAPAICoreConfig().url || 'https://api.ai.us-east-1.aws.ml.hana.ondemand.com';
  return `${baseUrl}/v2/inference/deployments/${modelDetails.configurationId}`;
}

// Stream handler for awsBedrockResponseCache plugin
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function streamHandler({ req, chunk, logger: pluginLogger }: {
  req: Request;
  res: Response;
  chunk: Buffer;
  logger: any;
}): Promise<Buffer> {
  pluginLogger.info(`awsBedrockResponseCache`, `StreamHandler called with chunk size: ${chunk ? chunk.length : 'undefined'}`);
  
  if (!chunk) {
    pluginLogger.warn(`awsBedrockResponseCache`, `StreamHandler received empty chunk`);
    return chunk;
  }
  
  // Initialize captured events if not present
  if (!(req as any).capturedEvents) {
    (req as any).capturedEvents = [];
    pluginLogger.info(`awsBedrockResponseCache`, `Initialized capturedEvents array`);
  }
  
  try {
    const chunkStr = chunk.toString();
    pluginLogger.debug(`awsBedrockResponseCache`, `Processing chunk: ${chunkStr.substring(0, 100)}...`);
    
    // Parse the chunk to extract events
    const eventLines = chunkStr.split('\n').filter(line => line.startsWith('data: '));
    
    for (const eventLine of eventLines) {
      try {
        const eventData = eventLine.substring(6); // Remove 'data: ' prefix
        if (eventData.trim() && eventData !== '[DONE]') {
          pluginLogger.debug(`awsBedrockResponseCache`, `Captured event data: ${eventData.substring(0, 50)}...`);
          (req as any).capturedEvents.push({
            type: 'data',
            data: eventData,
            timestamp: Date.now()
          });
        }
      } catch (parseError: any) {
        pluginLogger.warn(`awsBedrockResponseCache`, `Error parsing event line: ${parseError.message}`);
      }
    }
    
    pluginLogger.debug(`awsBedrockResponseCache`, `Total captured events so far: ${(req as any).capturedEvents.length}`);
    
  } catch (error: any) {
    pluginLogger.error(`awsBedrockResponseCache`, `Error in streamHandler: ${error.message}`);
  }
  
  // Return the original chunk unchanged
  return chunk;
}

class AwsBedrockService {
  async processBedrockRequest(options: ProcessBedrockRequestOptions): Promise<any> {
    return processBedrockRequest(options);
  }
}

export default new AwsBedrockService();
