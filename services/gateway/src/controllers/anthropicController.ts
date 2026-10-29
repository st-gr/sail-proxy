import { Request, Response, NextFunction } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Use require for CommonJS modules to avoid import issues
import sapAIService from '../services/sapAIService';
import configService from '../services/configService';
import * as sseWriter from '../utils/sseWriter';
import anthropicService from '../services/anthropicService';
import anthropicResponseService, { mapSapFinishReasonToAnthropic, mapSapCacheUsageToAnthropic, mapSapCacheCreationToAnthropic, AnthropicCacheCreation } from '../services/anthropicResponseService';
import modelService from '../services/modelService';
import * as payloadLogger from '../utils/payloadLogger';
import { executeBeforePlugins } from '../services/pluginExecutor';
import { refuseIfForcedWithoutPlugin } from '../plugins/pseudonymization/forcedRun';
import awsBedrockService from '../services/awsBedrockService';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();
import { createUsageMetrics, emitUsageEvent, updateTokenCounts } from '../utils/usageTracker';
import { fullRatePromptTokens } from '../utils/usageFolding';
import { captureImageTokensAsync } from '../utils/imageTokenCapture';
import { enforceEntitlement } from '../utils/modelEntitlement';
import { resolveExternalTarget } from '../upstreams/externalTarget';
import { dispatchMessages } from '../upstreams/messagesDispatch';
import { recordInvokedTools, anthropicAdapter } from '../toolGovernance';
import { deferStreamStart, DeferredStreamStart, StreamFailure, chunkError, failureFromChunk, failureFromError, httpStatusOr } from '../utils/streamStart';
import { anthropicErrorBody, sendAnthropicHttpError } from '../utils/anthropicErrors';

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
  cache_creation?: AnthropicCacheCreation;
}

/** No cache write: the TTL split Anthropic reports on every usage object. */
const NO_CACHE_CREATION: AnthropicCacheCreation = { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 };

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
 * Every image the request carries, as a ref imageTokenCapture.ts can size: an Anthropic image
 * block is `{type:'image', source:{type:'base64', media_type, data}}` or `{...source:{type:'url',
 * url}}`. The base64 shape is turned into a `data:` URL (the form imageTokenCapture already
 * decodes); a url source passes through as a remote URL. Anthropic never reports image tokens in
 * its usage, so - like /openai and /responses - the gateway computes them from the request here.
 */
export function collectAnthropicImageRefs(messages: any): string[] {
  const refs: string[] = [];
  if (!Array.isArray(messages)) return refs;
  for (const message of messages) {
    const content = message && message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== 'image' || !block.source) continue;
      const src = block.source;
      if (src.type === 'base64' && typeof src.data === 'string') {
        refs.push(`data:${src.media_type || 'image/png'};base64,${src.data}`);
      } else if (src.type === 'url' && typeof src.url === 'string') {
        refs.push(src.url);
      }
    }
  }
  return refs;
}

/**
 * Handle Anthropic Messages API
 */
export const handleMessages = async (req: ExtendedRequest, res: Response, next: NextFunction): Promise<void> => {
  const originalModelFromClient = req.body.model;
  const clientRequestedStream = req.body.stream === true;
  // Collect image refs up front so every usage-emit path can fold image tokens (Anthropic does
  // not report them). Off-hot-path: the compute runs in captureImageTokensAsync, not here.
  (req as any).__imageRefs = collectAnthropicImageRefs(req.body?.messages);

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

    // Ahead of the before-plugins chain on purpose: a refused request must not have its payload
    // run through the pseudonymization NER, which would write the caller's entities to the
    // shared Valkey cache for a request we are about to 403.
    if (!enforceEntitlement(req, res, substitutedModelName)) return;

    // A Connection model is never sent to SAP: it is served by its connection.
    const external = await resolveExternalTarget(req, res, substitutedModelName, 'claude', 'anthropic');
    if (external.kind === 'handled') return;
    if (external.kind === 'external') {
      await dispatchMessages(req, res, external.target, usageMetrics, originalModelFromClient);
      return;
    }

    // Determine subPath for hook config
    const subPath = clientRequestedStream ? 'invoke-with-response-stream' : 'invoke';

    // Get plugin hook configuration for this model+subpath
    (req as any).__endpoint = 'anthropic';
    const hookConfig = configService.getHookConfig(substitutedModelName, subPath, 'anthropic');

    // Fail closed: with pseudonymization forced and no hook chain that runs the plugin, the
    // request would reach the upstream unmasked. The before-chain below runs for the deployed
    // branch too, so this one check covers both.
    if (refuseIfForcedWithoutPlugin(req, res, hookConfig, {
      endpoint: 'anthropic', subPaths: [subPath], servedModel: substitutedModelName, component: 'AnthropicController',
    })) return;

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
      // Anthropic answers an unknown model with 404 not_found_error and "model: <name>".
      sendAnthropicHttpError(res, { status: 404, message: `model: ${originalModelFromClient}` });
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
          
          // Emit usage event for successful deployed model request. Fold image tokens first
          // (captureImageTokensAsync schedules off the hot path, so res.json below is not delayed;
          // only the already-fire-and-forget emit waits, via emitFinal).
          const modelIdForUsageEvent = configService.getSubstitutedModel('anthropic', originalModelFromClient);
          const imageRefs = (req as any).__imageRefs;
          const emitFinal = () => emitUsageEvent(req, usageMetrics, modelIdForUsageEvent, 200);
          if (imageRefs && imageRefs.length) captureImageTokensAsync(req, usageMetrics, imageRefs, emitFinal); else emitFinal();

          res.json(result);
          return;
        }
        
        // For streaming requests, the response is handled by awsBedrockService
        // Usage tracking for streaming is handled within the awsBedrockService
        return;
        
      } catch (deployedCallError: any) {
        logger.error('AnthropicController', `Error during deployed model call for ${debugRequestId}: ${deployedCallError.message}`);
        
        // Emit usage event for deployed model error case
        const statusCode = httpStatusOr(deployedCallError.status ?? deployedCallError.response?.status);
        const modelIdForUsageEvent = configService.getSubstitutedModel('anthropic', originalModelFromClient);
        emitUsageEvent(req, usageMetrics, modelIdForUsageEvent, statusCode);
        
        if (clientRequestedStream) {
          // Anthropic's shape on both sides of the stream start: the real status and a JSON
          // body while nothing was sent, else one `error` event and the end of the stream.
          const failure = { status: statusCode, message: deployedCallError.message || 'Deployed model processing failed' };
          if (!res.headersSent) {
            sendAnthropicHttpError(res, failure);
          } else if (!res.writableEnded) {
            try {
              sseWriter.writeEventStream(res, 'error', JSON.stringify(anthropicErrorBody(failure)));
            } catch (sseError: any) {
              logger.error('AnthropicController', `Error writing SSE error: ${sseError.message}`);
            }
            res.end();
          }
          return;
        }
        
        // For non-streaming requests or if response headers haven't been sent
        if (!res.headersSent) {
          sendAnthropicHttpError(res, { status: statusCode, message: deployedCallError.message || 'Deployed model processing failed' });
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
      // Anthropic's error shape, not the gateway-wide OpenAI-style one: Claude Code reads
      // error.type and the message (e.g. "prompt is too long") off this body.
      sendAnthropicHttpError(res, failureFromError(err));
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
    res
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
      latencyMsNonStreaming,
      mappedModel
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
        // Anthropic's EXCLUSIVE counts — the transform already took the cache out of an
        // inclusive (e.g. OpenAI-family) prompt_tokens (mapSapCacheUsageToAnthropic).
        const inputTokens = usage.input_tokens || usage.inputTokens || 0;
        const outputTokens = usage.output_tokens || usage.outputTokens || 0;
        const cacheCreationTokens = usage.cache_creation_input_tokens || usage.cacheWriteInputTokens || 0;
        const cacheReadTokens = usage.cache_read_input_tokens || usage.cacheReadInputTokens || 0;

        logger.info('UsageTrackingService', 'Extracted token counts from usage object', {
          requestId: debugRequestId,
          inputTokens: inputTokens,
          outputTokens: outputTokens,
          cacheCreationTokens: cacheCreationTokens,
          cacheReadTokens: cacheReadTokens,
          inputTokensType: typeof inputTokens,
          outputTokensType: typeof outputTokens
        });
        
        recordInvokedTools(req, anthropicAdapter.invokedTools(anthropicResponse));
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

    // Emit usage event (fire-and-forget), folding image tokens first (off the hot path).
    const modelIdForUsageEvent = configService.getSubstitutedModel('anthropic', originalModelFromClient);
    const imageRefs = (req as any).__imageRefs;
    const emitFinal = () => emitUsageEvent(req, usageMetrics, modelIdForUsageEvent, 200);
    if (imageRefs && imageRefs.length) captureImageTokensAsync(req, usageMetrics, imageRefs, emitFinal); else emitFinal();

    res.json(anthropicResponse);
  } catch (error: any) {
    logger.error('AnthropicController', `Error in non-streaming request: ${error.message}`, error);
    
    // Emit usage event for error case
    const failure = failureFromError(error);
    const modelIdForUsageEvent = configService.getSubstitutedModel('anthropic', originalModelFromClient);
    emitUsageEvent(req, usageMetrics, modelIdForUsageEvent, failure.status);

    // Anthropic's shape and SAP's own message (prefix dropped): Claude Code retries a failed
    // stream without streaming, and must find "prompt is too long" here to compact.
    if (!res.headersSent) sendAnthropicHttpError(res, failure);
    else if (!res.writableEnded) res.end();
  }
}

/**
 * What every streaming mode shares: the deferred start (status line + message_start,
 * then pings), the single place an upstream failure is delivered, and the SSE log.
 *
 * Nothing is written before the upstream delivers content or the start deadline passes
 * (utils/streamStart.ts), so a failure that arrives first is answered the way Anthropic
 * answers it — the HTTP status and a JSON error body — rather than as an in-stream event
 * under a 200 (the "prompt is too long" case Claude Code must see to auto-compact).
 */
interface StreamingContext {
  stream: DeferredStreamStart;
  abortController: AbortController;
  requestStartTimeStream: number;
  shouldLogEvents: boolean;
  clientNativeStreamLog: string[];
  /** Write one SSE event and, for native streams, log it. */
  writeEvent: (event: string, dataStr: string) => void;
  /**
   * Deliver an upstream failure: before the start, its HTTP status and Anthropic's JSON
   * body; after it, one `error` event and the end of the stream — never a message_delta
   * or message_stop after it, which a client reads as a normal (empty) completion.
   */
  deliverFailure: (failure: StreamFailure) => void;
  cleanup: () => void;
}

// Interface for native streaming parameters
interface NativeStreamingOptions extends StreamingContext {
  mappedModel: string;
  modelForReportingInStream: string;
  sapPayload: SAPPayload;
  anthropicVersion: string;
  debugRequestId: string;
  res: Response;
  req: ExtendedRequest;
  serviceState: ServiceState;
  hookConfig?: any;
  usageMetrics: any;
}

// Interface for emulated streaming parameters
interface EmulatedStreamingOptions extends StreamingContext {
  mappedModel: string;
  modelForReportingInStream: string;
  sapPayload: SAPPayload;
  anthropicVersion: string;
  debugRequestId: string;
  res: Response;
  req: ExtendedRequest;
  usageMetrics: any;
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

  const messageId = `msg_${Date.now().toString(36)}_${Math.random().toString(36).substring(2,7)}`;
  const abortController = new AbortController();

  // Setup logging for native streaming
  const clientNativeStreamLog: string[] = [];
  const shouldLogEvents = !!debugRequestId && streamingMode === 'native';

  const writeEvent = (event: string, dataStr: string): void => {
    sseWriter.writeEventStream(res, event, dataStr);
    if (shouldLogEvents) {
      clientNativeStreamLog.push(`event: ${event}\ndata: ${dataStr}\n`);
    }
  };

  // Sent once the stream starts. Token counts are reported in message_delta with stop_reason.
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
        cache_read_input_tokens: 0,
        cache_creation: { ...NO_CACHE_CREATION },
      }
    }
  };

  const stream = deferStreamStart({
    onStart: () => {
      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      writeEvent('message_start', JSON.stringify(messageStartEvent));
    },
    onKeepalive: () => writeEvent('ping', JSON.stringify({ type: 'ping' })),
    isOpen: () => !res.writableEnded && !abortController.signal.aborted,
  });

  const cleanup = (): void => {
    stream.stop();
  };

  const deliverFailure = (failure: StreamFailure): void => {
    cleanup();
    if (res.writableEnded) return;
    const body = anthropicErrorBody(failure);
    if (!stream.started && !res.headersSent) {
      if (shouldLogEvents) {
        clientNativeStreamLog.push(`HTTP ${failure.status}\n${JSON.stringify(body)}\n`);
      }
      sendAnthropicHttpError(res, failure);
      return;
    }
    writeEvent('error', JSON.stringify(body));
    res.end();
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

  const context: StreamingContext = {
    stream,
    abortController,
    requestStartTimeStream: Date.now(),
    shouldLogEvents,
    clientNativeStreamLog,
    writeEvent,
    deliverFailure,
    cleanup,
  };

  if (streamingMode === 'emulated') {
    // Handle emulated streaming
    await handleEmulatedStreaming({
      ...context,
      mappedModel,
      modelForReportingInStream,
      sapPayload,
      anthropicVersion,
      debugRequestId,
      res,
      req,
      usageMetrics,
    });
  } else if (streamingMode === 'native') {
    // Handle native streaming
    await handleNativeStreaming({
      ...context,
      mappedModel,
      modelForReportingInStream,
      sapPayload,
      anthropicVersion,
      debugRequestId,
      res,
      req,
      serviceState: {
        openTextBlockAnthropicIndex: null,
        nextAnthropicBlockIndex: 0,
        pendingTools: {},
        sapIndexToToolId: {},
      },
      hookConfig,
      usageMetrics,
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
    stream,
    abortController,
    res,
    req,
    deliverFailure,
    cleanup
  } = options;

  try {
    // Make a standard non-streaming request to SAP AI Core. Nothing has been written yet:
    // the stream starts with the response, or with pings once the start deadline passes.
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

    stream.start();

    // Extract text content and metadata from the SAP response
    let fullText = '';
    let sapStopReason = 'end_turn';
    const usageInfo: UsageInfo = {
      input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: { ...NO_CACHE_CREATION },
    };

    // Parse the response object structure
    if (responseData.final_result) {
      if (responseData.final_result.choices && responseData.final_result.choices.length > 0) {
        const choice = responseData.final_result.choices[0];
        if (choice.message && choice.message.content) fullText = choice.message.content;
        if (choice.finish_reason) sapStopReason = choice.finish_reason;
      }
      if (responseData.final_result.usage) {
        const cache = mapSapCacheUsageToAnthropic(responseData.final_result.usage);
        // Anthropic's input_tokens excludes the cache; SAP's prompt_tokens does only for exclusive
        // families (Claude, Nova).
        usageInfo.input_tokens = fullRatePromptTokens(
          mappedModel,
          responseData.final_result.usage.prompt_tokens || 0,
          cache.cache_creation_input_tokens,
          cache.cache_read_input_tokens,
        );
        usageInfo.output_tokens = responseData.final_result.usage.completion_tokens || 0;
        Object.assign(usageInfo, cache, { cache_creation: mapSapCacheCreationToAnthropic(responseData.final_result.usage) });
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
    const anthropicStopReason = mapSapFinishReasonToAnthropic(sapStopReason);

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
    recordInvokedTools(req, anthropicAdapter.invokedTools(responseData.final_result));
    updateTokenCounts(
      options.usageMetrics,
      usageInfo.input_tokens,
      usageInfo.output_tokens,
      usageInfo.cache_creation_input_tokens,
      usageInfo.cache_read_input_tokens
    );
    const imageRefsEmu = (req as any).__imageRefs;
    const emitFinalEmu = () => emitUsageEvent(req, options.usageMetrics, modelForReportingInStream, 200);
    if (imageRefsEmu && imageRefsEmu.length) captureImageTokensAsync(req, options.usageMetrics, imageRefsEmu, emitFinalEmu); else emitFinalEmu();

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
    const failure = failureFromError(error);

    // Track usage for emulated streaming error (no token data available)
    emitUsageEvent(req, options.usageMetrics, modelForReportingInStream, failure.status);

    deliverFailure(failure);
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
    stream,
    abortController,
    res,
    req,
    serviceState,
    shouldLogEvents,
    clientNativeStreamLog,
    writeEvent,
    deliverFailure,
    hookConfig,
    cleanup
  } = options;

  let contentBlockStarted = false;
  let lastContentBlockIndex = -1;

  // Accumulators for token counts and stop reason
  let accumulatedOutputTokens = 0;
  let finalStopReason: string | null = null;
  let finalInputTokens = 0;
  let finalCacheCreationTokens = 0;
  let finalCacheReadTokens = 0;
  let finalCacheCreation: AnthropicCacheCreation = { ...NO_CACHE_CREATION };

  // The first upstream failure, once delivered. Nothing is written after it.
  let failure = null as StreamFailure | null;
  // Set once the closing events are being written: a transport error sapAIService reports
  // after the stream resolved must not append an error to a finished message.
  let finished = false;

  const handleChunk = async (chunk: any): Promise<void> => {
    // Skip if request aborted, or the turn already ended
    if (abortController.signal.aborted || failure || finished) return;

    // SAP's in-stream error (`{error:{code,message,…}}`) or the gateway's own transport
    // error (`{error:true,message}`). SAP answers HTTP 200 and sends its rejection as a
    // chunk, so this is also how "prompt is too long" arrives.
    if (chunkError(chunk)) {
      failure = failureFromChunk(chunk);
      logger.error('AnthropicController', `Native Stream: upstream error (status ${failure.status}): ${failure.message}`);
      deliverFailure(failure);
      return;
    }

    // Transform chunk from SAP format to Anthropic format
    const transformed = await anthropicResponseService.transformSAPChunkToAnthropic(
      chunk,
      serviceState,
      mappedModel
    );
    if (abortController.signal.aborted || failure) return;

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

          // The first content starts the stream (status line + message_start).
          stream.start();

          // Send the event to the client (and log it if debug is enabled)
          writeEvent(event.type, JSON.stringify(event));
          recordInvokedTools(req, anthropicAdapter.invokedToolsFromChunk(event));

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
        if (usage?.cache_creation) {
          finalCacheCreation = usage.cache_creation;
        }
      }

      // Track stop reason
      if (transformed.finishReason) {
        finalStopReason = transformed.finishReason;
      }
    }
  };

  // streamChatCompletion does not await its callback, so chunks are handled one after
  // another here — events keep upstream order, and the completion below runs only after
  // the last chunk was written.
  let chunkWork: Promise<void> = Promise.resolve();
  const onChunk = (chunk: any): Promise<void> => {
    chunkWork = chunkWork.then(() => handleChunk(chunk)).catch((handlerError: any) => {
      logger.error('AnthropicController', `Native Stream: Error handling a chunk: ${handlerError?.message}`, handlerError);
    });
    return chunkWork;
  };

  const trackUsage = (): void => {
    updateTokenCounts(
      options.usageMetrics,
      finalInputTokens,
      accumulatedOutputTokens,
      finalCacheCreationTokens,
      finalCacheReadTokens
    );
  };

  try {
    // Stream the chat completion from SAP AI Core
    await sapAIService.streamChatCompletion(sapPayload as any, onChunk, abortController.signal, req as any, hookConfig);
    await chunkWork;
  } catch (err: any) {
    await chunkWork;
    logger.error('AnthropicController', `Native Stream: Error during streaming: ${err.message}`, err);

    // Handle aborted streams separately from real errors
    if (abortController.signal.aborted && (err.message?.includes('abort') || err.message === 'canceled')) {
      logger.info('AnthropicController', 'Native Stream: Stream aborted, error caught post-abort.');
    } else if (!failure) {
      failure = failureFromError(err);
      deliverFailure(failure);
    }
    if (shouldLogEvents) saveSSEStreamToFile(debugRequestId, clientNativeStreamLog);

    // Track usage for streaming error
    trackUsage();
    emitUsageEvent(req, options.usageMetrics, modelForReportingInStream, failure?.status || err.status || 500);

    // Clean up resources
    cleanup();

    // Ensure response is ended
    if (!res.writableEnded) res.end();
    return;
  }

  // Skip if the stream was aborted
  if (abortController.signal.aborted) {
    logger.info('AnthropicController', 'Native Stream: Stream processing aborted before completion.');
    cleanup();
    if (!res.writableEnded) res.end();
    return;
  }

  // The upstream reported an error and the stream promise still resolved (SAP sends
  // its errors as chunks). The failure was delivered; the turn ends there.
  if (failure) {
    const delivered: StreamFailure = failure;
    if (shouldLogEvents) saveSSEStreamToFile(debugRequestId, clientNativeStreamLog);
    trackUsage();
    emitUsageEvent(req, options.usageMetrics, modelForReportingInStream, delivered.status);
    cleanup();
    if (!res.writableEnded) res.end();
    logStructuredEvent({
      provider: 'anthropic',
      origModel: modelForReportingInStream,
      mappedModel,
      streaming: 'native',
      status: delivered.status,
      latency_ms: Date.now() - requestStartTimeStream,
      reqId: debugRequestId
    });
    return;
  }

  finished = true;
  const latencyMsNative = Date.now() - requestStartTimeStream;

  // An upstream that ended without any content still gets a well-formed message.
  stream.start();

  // Ensure any open content blocks are closed properly
  if (contentBlockStarted) {
    const contentBlockStopEvent = {
      type: 'content_block_stop',
      index: lastContentBlockIndex
    };
    writeEvent('content_block_stop', JSON.stringify(contentBlockStopEvent));
  }

  // Use the tracked stop reason, mapped to Anthropic's vocabulary (tool_calls → tool_use), default to end_turn
  const anthropicStopReason = mapSapFinishReasonToAnthropic(finalStopReason);

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

  // Cache counts and the TTL split go out on every message_delta, 0 when nothing was cached
  // (Anthropic's own shape).
  messageDeltaEvent.usage.cache_creation_input_tokens = finalCacheCreationTokens;
  messageDeltaEvent.usage.cache_read_input_tokens = finalCacheReadTokens;
  messageDeltaEvent.usage.cache_creation = finalCacheCreation;

  // Send message delta event
  writeEvent('message_delta', JSON.stringify(messageDeltaEvent));

  // Send message stop event
  writeEvent('message_stop', JSON.stringify({ type: 'message_stop' }));

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
  trackUsage();
  const imageRefsNative = (req as any).__imageRefs;
  const emitFinalNative = () => emitUsageEvent(req, options.usageMetrics, modelForReportingInStream, 200);
  if (imageRefsNative && imageRefsNative.length) captureImageTokensAsync(req, options.usageMetrics, imageRefsNative, emitFinalNative); else emitFinalNative();

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