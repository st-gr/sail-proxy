import { Request, Response, NextFunction } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Use require for CommonJS modules to avoid import issues
import sapAIService from '../services/sapAIService';
import configService from '../services/configService';
import * as sseWriter from '../utils/sseWriter';
import anthropicService from '../services/anthropicService';
import anthropicResponseService from '../services/anthropicResponseService';
import modelService from '../services/modelService';
import * as payloadLogger from '../utils/payloadLogger';
import { executeBeforePlugins } from '../services/pluginExecutor';
import awsBedrockService from '../services/awsBedrockService';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();
import { createUsageMetrics, emitUsageEvent, updateTokenCounts } from '../utils/usageTracker';

// Type definitions
interface ExtendedRequest extends Request {
  body: AnthropicRequestBody;
  debugRequestId?: string;
  headers: Record<string, string | string[] | undefined>;
  capturedEvents?: any[]; // For plugin stream event capturing
}

interface AnthropicRequestBody {
  model: string;
  stream?: boolean;
  messages?: AnthropicMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  system?: string | AnthropicSystemMessage[];
  tools?: AnthropicTool[];
  tool_choice?: any;
  stop_sequences?: string[];
  [key: string]: any;
}

interface AnthropicMessage {
  role: string;
  content: string | AnthropicContent[];
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
  tool_use_id?: string;
  [key: string]: any;
}

interface AnthropicSystemMessage {
  type: string;
  text: string;
  cache_control?: any;
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: any;
}

interface ModelDetails {
  accessType?: string;
  [key: string]: any;
}

interface PluginResult {
  stop: boolean;
  [key: string]: any;
}

interface SAPPayload {
  config: {
    modules: {
      prompt_templating: {
        prompt: { template: any[]; [key: string]: any };
        model: { name: string; version?: string; params?: Record<string, any> };
      };
      [key: string]: any;
    };
    stream?: { enabled?: boolean; chunk_size?: number; delimiters?: string[] };
    [key: string]: any;
  };
  [key: string]: any;
}

interface ServiceState {
  openTextBlockAnthropicIndex: number | null;
  nextAnthropicBlockIndex: number;
  pendingTools: Record<string, any>;
  sapIndexToToolId: Record<string, string>;
}

interface StreamingIntervals {
  ping: NodeJS.Timeout | null;
}

type StreamingMode = 'native' | 'emulated' | 'non_streaming' | 'non_streaming_fallback';

interface StreamingRequestOptions {
  streamingMode: StreamingMode;
  modelForReportingInStream: string;
  mappedModel: string;
  sapPayload: SAPPayload;
  anthropicVersion: string;
  debugRequestId: string;
  req: ExtendedRequest;
  res: Response;
  hookConfig?: any;
  usageMetrics: any;
}

interface NonStreamingRequestOptions {
  streamingMode: StreamingMode;
  originalModelFromClient: string;
  mappedModel: string;
  sapPayload: SAPPayload;
  debugRequestId: string;
  req: ExtendedRequest;
  res: Response;
  next: NextFunction;
  hookConfig?: any;
}

interface UsageInfo {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// Removed unused interface TransformedEvent

interface LogEvent {
  provider: string;
  origModel: string;
  mappedModel: string;
  streaming: string;
  status: number;
  latency_ms: number;
  reqId: string;
  ts?: string;
}

/**
 * Handle Anthropic Messages API
 */
export const handleMessages = async (req: ExtendedRequest, res: Response, next: NextFunction): Promise<void> => {
  const originalModelFromClient = req.body.model;
  const clientRequestedStream = req.body.stream === true;
  
  // Initialize usage tracking
  const usageMetrics = createUsageMetrics();
  
  // Generate debugRequestId if not already set
  if (!req.debugRequestId) {
    req.debugRequestId = `anth-${crypto.randomBytes(8).toString('hex')}-${Date.now()}`;
    logger.debug('AnthropicController', `Generated new debugRequestId for Anthropic request: ${req.debugRequestId}`);
  }
  
  const debugRequestId = req.debugRequestId;

  logger.debug('AnthropicController', `DEBUG_MODE: ${process.env.DEBUG}, Controller Debug Request ID: ${debugRequestId}`);

  // Log the original request for debugging (enhanced with headers and HTTP method)
  if (debugRequestId) {
    payloadLogger.savePayload(debugRequestId, '00_original_anthropic_request', req.body, req);
  }

  let substitutedModelName: string = originalModelFromClient; // Default to original if substitution fails
  
  try {
    substitutedModelName = configService.getSubstitutedModel('anthropic', originalModelFromClient);
    logger.info('AnthropicController', `Model: ${originalModelFromClient}${substitutedModelName !== originalModelFromClient ? ` → ${substitutedModelName} (substituted)` : ''}`);

    // Determine subPath for hook config
    const subPath = clientRequestedStream ? 'invoke-with-response-stream' : 'invoke';

    // Get plugin hook configuration for this model+subpath
    (req as any).__endpoint = 'anthropic';
    const hookConfig = configService.getHookConfig(substitutedModelName, subPath, 'anthropic');

    // Execute any 'before' strategy plugins
    if (hookConfig) {
      logger.info('AnthropicController', `Executing before plugins for model ${substitutedModelName}, subpath ${subPath}`);
      const pluginResult: PluginResult = await executeBeforePlugins(req, res, hookConfig);
      
      // If plugin returns { stop: true }, short-circuit the request
      if (pluginResult.stop) {
        logger.info('AnthropicController', `Plugin short-circuited request for ${substitutedModelName}/${subPath}`);
        return; // Response already sent by plugin
      }
    }

    const modelDetails: ModelDetails | null = await modelService.getModelDetails(substitutedModelName);
    if (!modelDetails) {
      res.status(400).json({ error: `Model ${substitutedModelName} not found` });
      return;
    }
    const isDeployedModel = modelDetails && (
      modelDetails.accessType === "deployment" ||
      (substitutedModelName && substitutedModelName.endsWith('--deployed'))
    );

    if (isDeployedModel) {
      logger.info('AnthropicController', `Handling request for deployed model: ${substitutedModelName} (original: ${originalModelFromClient}), DebugID: ${debugRequestId}`);
      
      // Initialize usage metrics for deployed model tracking
      const usageMetrics = createUsageMetrics();
      
      // Determine the appropriate subpath based on the request
      const subPath = clientRequestedStream ? 'invoke-with-response-stream' : 'invoke';

      // Get plugin hook configuration for this model+subpath
      (req as any).__endpoint = 'anthropic';
      const hookConfig = configService.getHookConfig(substitutedModelName, subPath, 'anthropic');
      
      try {
        // Use awsBedrockService to handle deployed models
        // Pass outputFormat: 'anthropic' to ensure response format matches Anthropic API
        const result = await awsBedrockService.processBedrockRequest({
          modelId: substitutedModelName,
          originalModelId: originalModelFromClient,
          subpath: subPath,
          requestBody: req.body,
          headers: req.headers as Record<string, string>,
          debugRequestId,
          req,
          res,
          hookConfig,
          usageMetrics, // Pass usage metrics for tracking
          outputFormat: 'anthropic' // Use Anthropic-compatible response format
        });
        
        // For non-streaming requests, return the result
        if (!clientRequestedStream && result) {
          logger.info('AnthropicController', `Returning non-streaming response for deployed model ${substitutedModelName}.`);
          
          // Extract token counts from result for usage tracking (including cache tokens)
          if (result.usage) {
            const inputTokens = result.usage.input_tokens || 0;
            const outputTokens = result.usage.output_tokens || 0;
            const cacheCreationTokens = result.usage.cache_creation_input_tokens || 0;
            const cacheReadTokens = result.usage.cache_read_input_tokens || 0;
            
            logger.debug('AnthropicController', 'Deployed model token extraction', {
              requestId: debugRequestId,
              inputTokens,
              outputTokens,
              cacheCreationTokens,
              cacheReadTokens
            });
            
            updateTokenCounts(usageMetrics, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens);
          }
          
          // Emit usage event for successful deployed model request
          const modelIdForUsageEvent = configService.getSubstitutedModel('anthropic', originalModelFromClient);
          emitUsageEvent(req, usageMetrics, modelIdForUsageEvent, 200);
          
          res.json(result);
          return;
        }
        
        // For streaming requests, the response is handled by awsBedrockService
        // Usage tracking for streaming is handled within the awsBedrockService
        return;
        
      } catch (deployedCallError: any) {
        logger.error('AnthropicController', `Error during deployed model call for ${debugRequestId}: ${deployedCallError.message}`);
        
        // Emit usage event for deployed model error case
        const statusCode = deployedCallError.status || 500;
        const modelIdForUsageEvent = configService.getSubstitutedModel('anthropic', originalModelFromClient);
        emitUsageEvent(req, usageMetrics, modelIdForUsageEvent, statusCode);
        
        if (clientRequestedStream && !res.headersSent) {
          // For streaming requests, send SSE error
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
        }
        
        if (clientRequestedStream && !res.writableEnded) {
          try {
            const errorPayload = { 
              type: 'error', 
              error: { 
                message: deployedCallError.message || 'Deployed model processing failed', 
                type: 'api_error', 
                code: deployedCallError.status || 500 
              }
            };
            sseWriter.writeEventStream(res, 'error', JSON.stringify(errorPayload));
            sseWriter.writeDone(res);
          } catch (sseError: any) {
            logger.error('AnthropicController', `Error writing SSE error: ${sseError.message}`);
          }
          return;
        }
        
        // For non-streaming requests or if response headers haven't been sent
        if (!res.headersSent) {
          res.status(deployedCallError.status || 500).json({
            error: {
              type: 'api_error',
              message: deployedCallError.message || 'Deployed model processing failed'
            }
          });
          return;
        }
      }
    } else {
      // --- NON-DEPLOYED (FOUNDATION/ORCHESTRATION) MODEL HANDLING ---
      let sapPayload: SAPPayload = await anthropicService.transformRequestToSAPFormat(req.body as any, debugRequestId);

      if (debugRequestId) {
        payloadLogger.savePayload(debugRequestId, '02_transformed_sap_request', sapPayload, req);
      }

      // mappedModel is the model name that will be sent to SAP AI Core (after substitution)
      const mappedModel: string = sapPayload.config.modules.prompt_templating.model.name;
      let streamingMode: StreamingMode = 'native'; // Default for foundation models if stream is true
      const anthropicVersion: string = (req.headers['anthropic-version'] as string) || configService.getAnthropicBedrockVersion() || '2023-06-01';

      if (clientRequestedStream) {
        const modelSupportsStreaming: boolean = modelService.modelSupportsStreaming(mappedModel);
        const shouldEmulateStreaming: boolean = configService.shouldEmulateStreaming('anthropic', mappedModel);

        if (!modelSupportsStreaming && !shouldEmulateStreaming) {
          logger.warn('AnthropicController', `Client requested stream, but model ${mappedModel} does not support native streaming and emulation is not configured. Falling back to non-streaming.`);
          streamingMode = 'non_streaming_fallback';
          delete sapPayload.config.stream;
        } else if (shouldEmulateStreaming) {
          logger.info('AnthropicController', `Client requested stream. Using emulated streaming for model ${mappedModel}.`);
          streamingMode = 'emulated';
          delete sapPayload.config.stream;
        } else {
          logger.info('AnthropicController', `Client requested stream. Using native streaming for model ${mappedModel}.`);
          streamingMode = 'native';
          sapPayload.config.stream = { enabled: true };
        }
      } else {
        streamingMode = 'non_streaming';
        delete sapPayload.config.stream;
      }
      
      const modelForReportingInStream: string = substitutedModelName;

      if (clientRequestedStream && (streamingMode === 'native' || streamingMode === 'emulated')) {
        logger.info('AnthropicController', `Handling Anthropic streaming request (actual mode: ${streamingMode}) for ${modelForReportingInStream} -> ${mappedModel}`);
        
        // Initialize usage tracking for streaming
        const usageMetrics = createUsageMetrics();
        
        await handleStreamingRequest({
          streamingMode,
          modelForReportingInStream,
          mappedModel,
          sapPayload,
          anthropicVersion,
          debugRequestId,
          req,
          res,
          hookConfig,
          usageMetrics
        });
      } else {
        logger.info('AnthropicController', `Handling Anthropic non-streaming request for ${originalModelFromClient} (SAP model: ${mappedModel}, mode: ${streamingMode})`);
        
        await handleNonStreamingRequest({
          streamingMode,
          originalModelFromClient,
          mappedModel,
          sapPayload,
          debugRequestId,
          req,
          res,
          next,
          hookConfig
        });
      }
    }
    
  } catch (err: any) {
    logger.error('AnthropicController', `Top-level error in handleMessages for ${debugRequestId || 'N/A'}: ${err.message}`, err);
    if (debugRequestId) {
      payloadLogger.savePayload(debugRequestId, '99_controller_error', {
        message: err.message, stack: err.stack, status: err.status || 500, details: err.details
      }, req, res);
    }
    if (!res.headersSent) {
      const errorToSend = err;
      if (!errorToSend.status) {
        errorToSend.status = 500;
      }
      next(errorToSend);
    } else {
      logger.error('AnthropicController', 'Error after headers sent, cannot use next(err). Ending response if possible.');
      if (!res.writableEnded) {
        res.end();
      }
    }
  }
};

/**
 * Handle non-streaming requests
 */
async function handleNonStreamingRequest(options: NonStreamingRequestOptions): Promise<void> {
  const { 
    originalModelFromClient, 
    mappedModel, 
    sapPayload, 
    debugRequestId, 
    req, 
    res, 
    next 
  } = options;

  // Initialize usage tracking
  const usageMetrics = createUsageMetrics();

  try {
    const requestStartTimeNonStreaming = Date.now();
    const responseData = await sapAIService.completeChat(sapPayload as any);
    const latencyMsNonStreaming = Date.now() - requestStartTimeNonStreaming;

    // Determine the content format type from the original request
    let originalRequestContentFormatType = 'string';
    if (req?.body?.messages && req.body.messages.length > 0 && req.body.messages[0] && Array.isArray(req.body.messages[0].content)) {
      originalRequestContentFormatType = 'array';
    }

    // Transform SAP response to Anthropic format
    const anthropicResponse = await anthropicResponseService.transformSAPResponseToAnthropic(
      responseData, 
      false, 
      originalModelFromClient, 
      originalRequestContentFormatType, 
      latencyMsNonStreaming
    );

    // Track usage if available
    if (anthropicResponse && typeof anthropicResponse === 'object' && 'usage' in anthropicResponse) {
      const usage = (anthropicResponse as any).usage;
      logger.info('UsageTrackingService', 'Non-streaming token extraction from Anthropic response', {
        requestId: debugRequestId,
        hasUsage: !!usage,
        usage: usage,
        usageType: typeof usage
      });
      
      if (usage && typeof usage === 'object') {
        const inputTokens = usage.input_tokens || 0;
        const outputTokens = usage.output_tokens || 0;
        const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
        const cacheReadTokens = usage.cache_read_input_tokens || 0;
        
        logger.info('UsageTrackingService', 'Extracted token counts from usage object', {
          requestId: debugRequestId,
          inputTokens: inputTokens,
          outputTokens: outputTokens,
          cacheCreationTokens: cacheCreationTokens,
          cacheReadTokens: cacheReadTokens,
          inputTokensType: typeof inputTokens,
          outputTokensType: typeof outputTokens
        });
        
        updateTokenCounts(usageMetrics, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens);
      }
    } else {
      logger.warn('UsageTrackingService', 'No usage data found in Anthropic response', {
        requestId: debugRequestId,
        hasResponse: !!anthropicResponse,
        responseType: typeof anthropicResponse,
        hasUsageProperty: anthropicResponse && typeof anthropicResponse === 'object' && 'usage' in anthropicResponse
      });
    }

    if (debugRequestId) {
      payloadLogger.savePayload(debugRequestId, '04_transformed_client_response', anthropicResponse, req, res);
    }

    logger.info('AnthropicController', `Non-streaming request completed for ${originalModelFromClient} → ${mappedModel}. Latency: ${latencyMsNonStreaming}ms`);
    logStructuredEvent({
      provider: 'anthropic',
      origModel: originalModelFromClient,
      mappedModel,
      streaming: 'none',
      status: 200,
      latency_ms: latencyMsNonStreaming,
      reqId: debugRequestId
    });

    // Emit usage event (fire-and-forget)
    const modelIdForUsageEvent = configService.getSubstitutedModel('anthropic', originalModelFromClient);
    emitUsageEvent(req, usageMetrics, modelIdForUsageEvent, 200);

    res.json(anthropicResponse);
  } catch (error: any) {
    logger.error('AnthropicController', `Error in non-streaming request: ${error.message}`, error);
    
    // Emit usage event for error case
    const statusCode = error.response?.status || error.status || 500;
    const modelIdForUsageEvent = configService.getSubstitutedModel('anthropic', originalModelFromClient);
    emitUsageEvent(req, usageMetrics, modelIdForUsageEvent, statusCode);
    
    const enhancedError = new Error(`Non-streaming request failed for ${originalModelFromClient}: ${error.message}`) as any;
    enhancedError.status = statusCode;
    enhancedError.details = error.response?.data || error.details;
    next(enhancedError);
  }
}

// Interface for native streaming parameters
interface NativeStreamingOptions {
  mappedModel: string;
  modelForReportingInStream: string;
  sapPayload: SAPPayload;
  anthropicVersion: string;
  debugRequestId: string;
  requestStartTimeStream: number;
  intervals: StreamingIntervals;
  abortController: AbortController;
  messageId: string;
  res: Response;
  req: ExtendedRequest;
  serviceState: ServiceState;
  contentBlockStarted: boolean;
  lastContentBlockIndex: number;
  shouldLogEvents: boolean;
  clientNativeStreamLog: string[];
  hookConfig?: any;
  usageMetrics: any;
  cleanup: () => void;
}

// Interface for emulated streaming parameters
interface EmulatedStreamingOptions {
  mappedModel: string;
  modelForReportingInStream: string;
  sapPayload: SAPPayload;
  anthropicVersion: string;
  debugRequestId: string;
  requestStartTimeStream: number;
  intervals: StreamingIntervals;
  abortController: AbortController;
  messageId: string;
  res: Response;
  req: ExtendedRequest;
  usageMetrics: any;
  cleanup: () => void;
}

/**
 * Handle streaming requests (both native and emulated)
 */
async function handleStreamingRequest(options: StreamingRequestOptions): Promise<void> {
  const { 
    streamingMode, 
    modelForReportingInStream, 
    mappedModel, 
    sapPayload, 
    anthropicVersion, 
    debugRequestId, 
    req, 
    res, 
    hookConfig,
    usageMetrics 
  } = options;

  // Setup streaming response headers
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const messageId = `msg_${Date.now().toString(36)}_${Math.random().toString(36).substring(2,7)}`;
  const abortController = new AbortController();
  const intervals: StreamingIntervals = { ping: null };
  
  // Cleanup function for intervals
  const cleanup = (): void => {
    if (intervals.ping) clearInterval(intervals.ping);
    intervals.ping = null;
  };
  
  // Handle client and connection aborts
  req.on('aborted', () => {
    logger.info('AnthropicController', 'Client aborted the request (req aborted event).');
    if (!abortController.signal.aborted) abortController.abort('Client aborted request');
    cleanup();
  });
  
  req.on('close', () => {
    if (!res.writableEnded && !abortController.signal.aborted) {
      logger.info('AnthropicController', 'Client closed connection before response completed.');
      abortController.abort('Client closed connection');
      cleanup();
    }
  });

  res.on('close', () => { 
    if (!res.writableEnded && !abortController.signal.aborted) {
      logger.info('AnthropicController', 'Response stream closed prematurely.');
      abortController.abort('Response stream closed');
      cleanup();
    }
  });
  
  const requestStartTimeStream = Date.now();
  
  // Setup logging for native streaming
  let clientNativeStreamLog: string[] = []; 
  const shouldLogEvents = !!debugRequestId && streamingMode === 'native';

  // Initialize service state for tracking 
  let serviceState: ServiceState = {
    openTextBlockAnthropicIndex: null,
    nextAnthropicBlockIndex: 0,
    pendingTools: {},
    sapIndexToToolId: {},
  };

  // Send initial message_start event
  // Note: Token counts will be properly reported in message_delta with stop_reason
  const messageStartEvent = {
    type: 'message_start',
    message: {
      id: messageId, 
      type: 'message', 
      role: 'assistant', 
      model: modelForReportingInStream, 
      content: [],
      stop_reason: null, 
      stop_sequence: null,
      usage: { 
        input_tokens: 0, 
        output_tokens: 0,
        cache_creation_input_tokens: 0, 
        cache_read_input_tokens: 0 
      }
    }
  };
  const messageStartEventStr = JSON.stringify(messageStartEvent);
  sseWriter.writeEventStream(res, 'message_start', messageStartEventStr);
  
  if (shouldLogEvents) {
    clientNativeStreamLog.push(`event: message_start\ndata: ${messageStartEventStr}\n`);
  }
    
  let contentBlockStarted = false;
  let lastContentBlockIndex = -1;

  if (streamingMode === 'emulated') {
    // Handle emulated streaming
    await handleEmulatedStreaming({
      mappedModel,
      modelForReportingInStream,
      sapPayload,
      anthropicVersion,
      debugRequestId,
      requestStartTimeStream,
      intervals,
      abortController,
      messageId,
      res,
      req,
      usageMetrics,
      cleanup
    });
  } else if (streamingMode === 'native') {
    // Handle native streaming
    await handleNativeStreaming({
      mappedModel,
      modelForReportingInStream,
      sapPayload,
      anthropicVersion,
      debugRequestId,
      requestStartTimeStream,
      intervals,
      abortController,
      messageId,
      res,
      req,
      serviceState,
      contentBlockStarted,
      lastContentBlockIndex,
      shouldLogEvents,
      clientNativeStreamLog,
      hookConfig,
      usageMetrics,
      cleanup
    });
  }
}

/**
 * Helper function to log structured events
 */
function logStructuredEvent(event: LogEvent): void {
  const eventWithTs = { ...event, ts: new Date().toISOString() };
  if (!eventWithTs.reqId) eventWithTs.reqId = `req_${Date.now().toString(36)}`;
  logger.info('AnthropicController', JSON.stringify(eventWithTs));
}

/**
 * Save SSE stream data directly to a text file
 */
function saveSSEStreamToFile(requestId: string, sseEvents: string[]): void {
  if (!requestId || !payloadLogger.isPayloadLoggingEnabled()) {
    return;
  }

  try {
    const logDir = path.join(__dirname, '..', 'logs', 'payloads');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
      logger.info('AnthropicController', `SSE_STREAM_LOG: Created log directory: ${logDir}`);
    }

    const safeRequestId = String(requestId).replace(/[^a-zA-Z0-9_-]/g, '');
    const timestamp = new Date().toISOString().replace(/[.:]/g, '-');
    const filename = `${timestamp}_${safeRequestId}_04_client_native_stream_response.txt`;
    const filePath = path.join(logDir, filename);

    const wireFormatContent = sseEvents.join('\n');

    fs.writeFileSync(filePath, wireFormatContent, 'utf8');
    logger.info('AnthropicController', `SSE_STREAM_LOG: Saved SSE stream to ${filename}`);

    payloadLogger.savePayload(requestId, '04_client_native_stream_response', 
      { note: `SSE stream saved as ${filename}. View the .txt file for the complete stream.` });
  } catch (error: any) {
    logger.error('AnthropicController', `SSE_STREAM_LOG: Error saving SSE stream for request ${requestId}: ${error.message}`, error);
  }
}

/**
 * Chunk text into smaller pieces for emulated streaming
 */
function chunkText(text: string, size: number): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  let currentChunk = '';
  const words = text.split(/(\s+)/);
  for (const word of words) {
    if (currentChunk.length + word.length > size && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = word.trimStart(); 
    } else {
      currentChunk += word;
    }
  }
  if (currentChunk.length > 0) chunks.push(currentChunk);
  return chunks;
}

/**
 * Implement emulated streaming - converts a full response to chunked SSE events
 */
async function handleEmulatedStreaming(options: EmulatedStreamingOptions): Promise<void> {
  const {
    mappedModel,
    modelForReportingInStream,
    sapPayload,
    anthropicVersion,
    debugRequestId,
    requestStartTimeStream,
    intervals,
    abortController,
    res,
    req,
    cleanup
  } = options;

  try {
    // Set up ping intervals for keeping the connection alive
    intervals.ping = setInterval(() => {
      if (!res.writableEnded && !abortController.signal.aborted) {
        sseWriter.writeEventStream(res, 'ping', JSON.stringify({ type: 'ping' }));
      } else {
        cleanup();
      }
    }, 5000);

    // Make a standard non-streaming request to SAP AI Core
    logger.info('AnthropicController', `Using emulated streaming for ${modelForReportingInStream} (SAP model: ${mappedModel}) - making non-streaming request to SAP AI Core.`);
    const responseData = await sapAIService.completeChat(sapPayload as any);
    const latencyMsEmulationData = Date.now() - requestStartTimeStream;
    
    logger.info('AnthropicController', `Emulated streaming: received full SAP response in ${latencyMsEmulationData}ms, now chunking to client.`);

    // Check if the client has disconnected during the request
    if (abortController.signal.aborted) {
      logger.info('AnthropicController', 'Emulated stream aborted before response chunking.');
      cleanup();
      if (!res.writableEnded) res.end();
      return;
    }

    // Extract text content and metadata from the SAP response
    let fullText = '';
    let sapStopReason = 'end_turn';
    const usageInfo: UsageInfo = { input_tokens: 0, output_tokens: 0 };

    // Parse the response object structure
    if (responseData.final_result) {
      if (responseData.final_result.choices && responseData.final_result.choices.length > 0) {
        const choice = responseData.final_result.choices[0];
        if (choice.message && choice.message.content) fullText = choice.message.content;
        if (choice.finish_reason) sapStopReason = choice.finish_reason;
      }
      if (responseData.final_result.usage) {
        usageInfo.input_tokens = responseData.final_result.usage.prompt_tokens || 0;
        usageInfo.output_tokens = responseData.final_result.usage.completion_tokens || 0;
        usageInfo.cache_creation_input_tokens = responseData.final_result.usage.cache_creation_input_tokens || 0;
        usageInfo.cache_read_input_tokens = responseData.final_result.usage.cache_read_input_tokens || 0;
      }
    }
    
    // Split the full text into chunks for streaming simulation
    const chunks = chunkText(fullText, 80); 
    
    // Send content block start event if not already sent
    sseWriter.writeEventStream(res, 'content_block_start', JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' }
    }));
    
    // Send each chunk with a small delay to simulate streaming
    for (let i = 0; i < chunks.length; i++) {
      if (abortController.signal.aborted) break;
      
      // Send the chunk as a delta event
      sseWriter.writeEventStream(res, 'content_block_delta', JSON.stringify({
        type: 'content_block_delta', 
        index: 0, 
        delta: { type: 'text_delta', text: chunks[i] }
      }));
      
      // Add a small delay between chunks unless it's the last chunk
      if (i < chunks.length - 1) await new Promise(resolve => setTimeout(resolve, 20));
    }

    // Handle abort during chunking
    if (abortController.signal.aborted) {
      logger.info('AnthropicController', 'Emulated stream aborted during chunking.');
      cleanup();
      if (!res.writableEnded) res.end();
      return;
    }

    // Send content block stop event
    sseWriter.writeEventStream(res, 'content_block_stop', JSON.stringify({ 
      type: 'content_block_stop', 
      index: 0 
    }));
    
    // Map SAP stop reason to Anthropic format
    let anthropicStopReason = "end_turn";
    if (sapStopReason === "length") anthropicStopReason = "max_tokens";
    else if (sapStopReason === "stop_sequences") anthropicStopReason = "stop_sequence";
    else if (sapStopReason === "tool_calls" || sapStopReason === "tool_use") anthropicStopReason = "tool_use";
    else if (sapStopReason === "stop") anthropicStopReason = "end_turn";
    else anthropicStopReason = sapStopReason;

    // Send message delta with stop reason and usage info
    sseWriter.writeEventStream(res, 'message_delta', JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: anthropicStopReason, stop_sequence: null },
      usage: usageInfo 
    }));
    
    // Send message stop event
    sseWriter.writeEventStream(res, 'message_stop', JSON.stringify({ type: 'message_stop' }));
    
    // For older API versions, send [DONE] marker
    if (anthropicVersion < '2023-06-01') {
      sseWriter.writeDone(res);
    } else {
      // For newer versions, just end the response
      if (!res.writableEnded) res.end();
    }
    
    // Track usage for emulated streaming completion
    updateTokenCounts(
      options.usageMetrics, 
      usageInfo.input_tokens, 
      usageInfo.output_tokens,
      usageInfo.cache_creation_input_tokens,
      usageInfo.cache_read_input_tokens
    );
    emitUsageEvent(req, options.usageMetrics, modelForReportingInStream, 200);
    
    // Clean up resources
    cleanup();
    
    // Log completion and metrics
    const totalEmulationLatency = Date.now() - requestStartTimeStream;
    logger.info('AnthropicController', `Emulated streaming completed for ${modelForReportingInStream} → ${mappedModel}. Total Latency: ${totalEmulationLatency}ms`);
    
    logStructuredEvent({ 
      provider: 'anthropic', 
      origModel: modelForReportingInStream, 
      mappedModel, 
      streaming: 'emulated', 
      status: 200, 
      latency_ms: totalEmulationLatency, 
      reqId: debugRequestId 
    });

  } catch (error: any) {
    logger.error('AnthropicController', 'Error in emulated streaming:', error);
    
    // Track usage for emulated streaming error (no token data available)
    emitUsageEvent(req, options.usageMetrics, modelForReportingInStream, error.status || 500);
    
    if (!res.writableEnded) {
      const errorEvent = { 
        type: 'error', 
        error: { 
          message: error.message || 'Emulated stream failed', 
          type: 'internal_error' 
        }
      };
      
      // Send error event
      sseWriter.writeEventStream(res, 'error', JSON.stringify(errorEvent));
      
      // For older API versions, send [DONE] marker
      if (anthropicVersion < '2023-06-01') {
        sseWriter.writeDone(res);
      } else {
        // For newer versions, just end the response
        if (!res.writableEnded) res.end();
      }
    }
    
    // Clean up resources
    cleanup();
    
    if (!res.writableEnded) res.end();
  }
}

/**
 * Implement native streaming with real-time SSE transformation
 */
async function handleNativeStreaming(options: NativeStreamingOptions): Promise<void> {
  const {
    mappedModel,
    modelForReportingInStream,
    sapPayload,
    anthropicVersion,
    debugRequestId,
    requestStartTimeStream,
    intervals,
    abortController,
    res,
    req,
    serviceState,
    shouldLogEvents,
    clientNativeStreamLog,
    hookConfig,
    cleanup
  } = options;
  
  let contentBlockStarted = false;
  let lastContentBlockIndex = -1;

  try {
    // Set up ping intervals for keeping the connection alive
    intervals.ping = setInterval(() => {
      if (!res.writableEnded && !abortController.signal.aborted) {
        const pingEvent = { type: 'ping' };
        const pingEventStr = JSON.stringify(pingEvent);
        sseWriter.writeEventStream(res, 'ping', pingEventStr);
        
        // Log ping events if enabled
        if (shouldLogEvents) {
          clientNativeStreamLog.push(`event: ping\ndata: ${pingEventStr}\n`);
        }
      } else {
        cleanup();
      }
    }, 5000);
    
    // Accumulators for token counts and stop reason
    let accumulatedOutputTokens = 0;
    let finalStopReason: string | null = null;
    let finalInputTokens = 0;
    let finalCacheCreationTokens = 0;
    let finalCacheReadTokens = 0;

    // Stream the chat completion from SAP AI Core
    await sapAIService.streamChatCompletion(sapPayload as any, async (chunk: any) => {
      // Skip if request aborted
      if (abortController.signal.aborted) return;
      
      // Transform chunk from SAP format to Anthropic format
      const transformed = await anthropicResponseService.transformSAPChunkToAnthropic(
        chunk, 
        serviceState
      );
      
      if (transformed) {
        // Update service state if provided
        if (transformed.state) {
          Object.assign(serviceState, transformed.state);
        }
        
        // Process events (single event or array)
        if (transformed.event) {
          const events = Array.isArray(transformed.event) ? transformed.event : [transformed.event];
          
          for (const event of events) {
            // Skip empty text delta events if not part of sequence
            if (event.type === 'content_block_delta' && 
                event.delta && 
                event.delta.type === 'text_delta' &&
                event.delta.text === "" &&
                !transformed.finishReason && !transformed.usage) {
              continue;
            }
            
            // Debug logging for JSON deltas
            if (event.type === 'content_block_delta' && 
                event.delta?.type === 'input_json_delta') {
              logger.debug('AnthropicController', `Emitting input_json_delta for Anthropic index ${(event as any).index} with content: '${event.delta.partial_json}'`);
            }
            
            // Send the event to the client
            const eventStr = JSON.stringify(event);
            sseWriter.writeEventStream(res, event.type, eventStr);
          
            // Log the event if debug is enabled
            if (shouldLogEvents) {
              clientNativeStreamLog.push(`event: ${event.type}\ndata: ${eventStr}\n`);
            }
          
            // Track content block state to ensure proper closing
            if (event.type === 'content_block_start') {
              contentBlockStarted = true;
              lastContentBlockIndex = Math.max(lastContentBlockIndex, (event as any).index);
            } else if (event.type === 'content_block_stop') {
              if ((event as any).index === lastContentBlockIndex) {
                 contentBlockStarted = false;
              }
            }
          }
        }
        
        // Track token usage
        if (transformed.usage) {
          const usage = transformed.usage as any;
          if (usage?.completion_tokens !== undefined) {
            accumulatedOutputTokens = usage.completion_tokens;
          }
          if (usage?.prompt_tokens !== undefined) {
            finalInputTokens = usage.prompt_tokens;
          }
          if (usage?.input_tokens !== undefined) {
            finalInputTokens = usage.input_tokens;
          }
          if (usage?.output_tokens !== undefined) {
            accumulatedOutputTokens = usage.output_tokens;
          }
          if (usage?.cache_creation_input_tokens !== undefined) {
            finalCacheCreationTokens = usage.cache_creation_input_tokens;
          }
          if (usage?.cache_read_input_tokens !== undefined) {
            finalCacheReadTokens = usage.cache_read_input_tokens;
          }
        }
        
        // Track stop reason
        if (transformed.finishReason) {
          finalStopReason = transformed.finishReason;
        }
      }
    }, abortController.signal, req as any, hookConfig)
    .then(() => {
      // Skip if the stream was aborted
      if (abortController.signal.aborted) {
        logger.info('AnthropicController', 'Native Stream: Stream processing aborted before completion.');
        cleanup();
        if (!res.writableEnded) res.end();
        return;
      }
      
      const latencyMsNative = Date.now() - requestStartTimeStream;
      
      // Ensure any open content blocks are closed properly
      if (contentBlockStarted) {
        const contentBlockStopEvent = { 
          type: 'content_block_stop', 
          index: lastContentBlockIndex
        };
        const contentBlockStopEventStr = JSON.stringify(contentBlockStopEvent);
        sseWriter.writeEventStream(res, 'content_block_stop', contentBlockStopEventStr);
        
        // Log the event if enabled
        if (shouldLogEvents) {
          clientNativeStreamLog.push(`event: content_block_stop\ndata: ${contentBlockStopEventStr}\n`);
        }
      }
      
      // Use the tracked stop reason, default to end_turn
      const anthropicStopReason = finalStopReason || "end_turn";

      // Send message delta with final metadata
      const messageDeltaEvent = {
        type: "message_delta",
        delta: {
          stop_reason: anthropicStopReason,
          stop_sequence: anthropicStopReason === "stop_sequence" ? "stop_sequence_placeholder" : null,
        },
        usage: { 
          output_tokens: accumulatedOutputTokens,
        } as any
      };
      
      // Add input tokens if available
      if (finalInputTokens > 0) {
        messageDeltaEvent.usage.input_tokens = finalInputTokens;
      }
      
      // Add cache tokens if available
      if (finalCacheCreationTokens > 0) {
        messageDeltaEvent.usage.cache_creation_input_tokens = finalCacheCreationTokens;
      }
      if (finalCacheReadTokens > 0) {
        messageDeltaEvent.usage.cache_read_input_tokens = finalCacheReadTokens;
      }
      
      // Send message delta event
      const messageDeltaEventStr = JSON.stringify(messageDeltaEvent);
      sseWriter.writeEventStream(res, 'message_delta', messageDeltaEventStr);
      
      // Log the message delta event if enabled
      if (shouldLogEvents) {
        clientNativeStreamLog.push(`event: message_delta\ndata: ${messageDeltaEventStr}\n`);
      }
      
      // Send message stop event
      const messageStopEvent = { type: 'message_stop' };
      const messageStopEventStr = JSON.stringify(messageStopEvent);
      sseWriter.writeEventStream(res, 'message_stop', messageStopEventStr);
      
      // Log the message stop event if enabled
      if (shouldLogEvents) {
        clientNativeStreamLog.push(`event: message_stop\ndata: ${messageStopEventStr}\n`);
      }
      
      // Determine if we should send a [DONE] marker based on API version
      const shouldSendDoneMarker = anthropicVersion < '2023-06-01';
      
      // Log the [DONE] marker if enabled and needed
      if (shouldLogEvents && shouldSendDoneMarker) {
        clientNativeStreamLog.push(`data: [DONE]\n`);
      }
      
      // Save the SSE stream to file if logging is enabled
      if (shouldLogEvents) {
        saveSSEStreamToFile(debugRequestId, clientNativeStreamLog);
      }
      
      // Send [DONE] marker or just end the response based on API version
      if (shouldSendDoneMarker) {
        sseWriter.writeDone(res);
      } else if (!res.writableEnded) {
        res.end();
      }
      
      // Clean up resources
      cleanup();
      
      // Track usage for streaming completion
      updateTokenCounts(
        options.usageMetrics, 
        finalInputTokens, 
        accumulatedOutputTokens,
        finalCacheCreationTokens,
        finalCacheReadTokens
      );
      emitUsageEvent(req, options.usageMetrics, modelForReportingInStream, 200);
      
      // Log completion and metrics
      logger.info('AnthropicController', `Native streaming completed for ${modelForReportingInStream} → ${mappedModel}. Latency: ${latencyMsNative}ms. Stop: ${anthropicStopReason}, OutTokens: ${accumulatedOutputTokens}, InTokens: ${finalInputTokens}, CacheCreate: ${finalCacheCreationTokens}, CacheRead: ${finalCacheReadTokens}`);
      
      logStructuredEvent({ 
        provider: 'anthropic', 
        origModel: modelForReportingInStream, 
        mappedModel, 
        streaming: 'native', 
        status: 200, 
        latency_ms: latencyMsNative, 
        reqId: debugRequestId 
      });
    })
    .catch(async (err: any) => {
      logger.error('AnthropicController', `Native Stream: Error during streaming: ${err.message}`, err);
      
      // Handle aborted streams separately from real errors
      if (abortController.signal.aborted && (err.message?.includes('abort') || err.message === 'canceled')) {
         logger.info('AnthropicController', 'Native Stream: Stream aborted, error caught post-abort.');
      } else if (!res.writableEnded) {
        try {
          // Create and send error event
          const errorPayload = { 
            type: 'error', 
            error: { 
              message: err.message || 'Native stream failed', 
              type: 'internal_error', 
              code: err.status || 500 
            }
          };
          const errorPayloadStr = JSON.stringify(errorPayload);
          sseWriter.writeEventStream(res, 'error', errorPayloadStr);
          
          // Log the error event if enabled
          if (shouldLogEvents) {
            clientNativeStreamLog.push(`event: error\ndata: ${errorPayloadStr}\n`);
            
            // Determine if we should send a [DONE] marker
            const shouldSendDoneMarker = anthropicVersion < '2023-06-01';
            
            // Log the [DONE] marker if needed
            if (shouldSendDoneMarker) {
              clientNativeStreamLog.push(`data: [DONE]\n`);
            }
            
            // Save the SSE stream to file even in error case
            saveSSEStreamToFile(debugRequestId, clientNativeStreamLog);
          }
          
          // Send [DONE] marker or just end the response based on API version
          if (anthropicVersion < '2023-06-01') {
            sseWriter.writeDone(res);
          } else if (!res.writableEnded) {
            res.end();
          }
        } catch (e: any) { 
          logger.error('AnthropicController', `Native Stream: Error sending error event: ${e.message}`); 
        }
      }
      
      // Track usage for streaming error
      updateTokenCounts(
        options.usageMetrics, 
        finalInputTokens, 
        accumulatedOutputTokens,
        finalCacheCreationTokens,
        finalCacheReadTokens
      );
      emitUsageEvent(req, options.usageMetrics, modelForReportingInStream, err.status || 500);
      
      // Clean up resources
      cleanup();
      
      // Ensure response is ended
      if (!res.writableEnded) res.end();
    });
  } catch (error: any) {
    logger.error('AnthropicController', `Error setting up native streaming: ${error.message}`, error);
    
    // Track usage for setup error (no tokens, just the error)
    emitUsageEvent(req, options.usageMetrics, modelForReportingInStream, error.status || 500);
    
    if (!res.writableEnded) {
      const errorEvent = { 
        type: 'error', 
        error: { 
          message: error.message || 'Native streaming setup failed', 
          type: 'internal_error' 
        }
      };
      
      // Send error event
      sseWriter.writeEventStream(res, 'error', JSON.stringify(errorEvent));
      
      // Send [DONE] marker or just end based on API version
      if (anthropicVersion < '2023-06-01') {
        sseWriter.writeDone(res);
      } else {
        res.end();
      }
    }
    
    // Clean up resources
    cleanup();
  }
}

// Helper functions
function getStreamingEmulationConfig(modelId: string) {
  return configService.shouldEmulateStreaming('anthropic', modelId);
}

export {
  getStreamingEmulationConfig
};

export default {
  handleMessages
};