import { Request, Response, NextFunction } from 'express';
import axios, { AxiosResponse } from 'axios';

// Use require for CommonJS modules to avoid import issues in mixed JS/TS environment
import sapAIService from '../services/sapAIService';
import * as sseWriter from '../utils/sseWriter';
import * as modelUtils from '../utils/modelUtils';
import modelService from '../services/modelService';
import * as imageUtils from '../utils/imageUtils';
import configService from '../services/configService';
import { sanitizeUpstreamErrorObject, errorTypeForStatus } from '../utils/upstreamErrorEnvelope';
import { deferStreamStart, DeferredStreamStart, failureFromError, isSubstantiveChunk, httpStatusOr } from '../utils/streamStart';
import { executeBeforePlugins, executeAfterPlugins } from '../services/pluginExecutor';
import * as payloadLogger from '../utils/payloadLogger';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();
import { createUsageMetrics, emitUsageEvent } from '../utils/usageTracker';
import { foldExclusiveUsage, foldOrchestrationUsageFor } from '../utils/usageFolding';
import { captureImageTokensAsync } from '../utils/imageTokenCapture';
import { enforceEntitlement } from '../utils/modelEntitlement';
import { resolveExternalTarget } from '../upstreams/externalTarget';
import { dispatchChat } from '../upstreams/chatDispatch';
import { recordInvokedTools, openaiChatAdapter } from '../toolGovernance';
import {
  isUnsupportedParam,
  stripUnsupportedParams,
  applyParamRenames,
  defaultParamRenames,
  OPENAI_COMPATIBLE_DEPLOYMENT_PROVIDERS,
} from '../utils/unsupportedParamFilter';
import type { SapV2CompletionRequest } from '../services/sapOrchestrationTypes';
import type { UsageMetrics } from '../types/usage';
import { validateChatRequest } from './openaiRequestValidation';
import { randomBytes } from 'crypto';
import { refuseIfForcedWithoutPlugin } from '../plugins/pseudonymization/forcedRun';
import { currentSapTarget } from '../sap/sapTarget';

export type Completion = { id: string; model: string; created: number };

export function newCompletion(model: string): Completion {
  const id = 'chatcmpl-' + randomBytes(18).toString('base64url'); // 24 url-safe chars
  return { id, model, created: Math.floor(Date.now() / 1000) };
}

export function inferFinishReason(opts: { upstream?: string | null; hasToolCalls: boolean }): 'tool_calls' | 'length' | 'stop' | null {
  if (opts.upstream) return opts.upstream as 'tool_calls' | 'length' | 'stop';
  if (opts.hasToolCalls) return 'tool_calls';
  return null;   // no upstream reason and no tool_calls → not finished (intermediate chunk)
}

/**
 * Every `image_url` reference across this request's messages, for imageTokenCapture.ts's
 * deferred token compute (Task 9): SAP orchestration never reports image tokens on this
 * route, unlike the native Responses path, so the gateway computes them itself off the hot
 * path. Called AFTER `transformRequestToSAPFormat`, so an Anthropic-model image it already
 * downloaded and inlined to a `data:` url is picked up here as one too — no second fetch
 * needed later. A non-Anthropic model's `image_url` is whatever the client sent, verbatim.
 */
function collectChatImageRefs(messages: OpenAIMessage[] | undefined): string[] {
  const refs: string[] = [];
  if (!Array.isArray(messages)) return refs;
  for (const message of messages) {
    if (!message || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!part || part.type !== 'image_url') continue;
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (typeof url === 'string') refs.push(url);
    }
  }
  return refs;
}

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
  // true on sapAIService's own error chunks; SAP's in-stream error event carries an object.
  error?: boolean | { code?: number | string; message?: string };
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
  const validationError = validateChatRequest(req.body);
  if (validationError) {
    res.status(400).json(validationError);
    return;
  }

  const completion = newCompletion(req.body.model);
  // Client's opt-in for a final usage chunk on streaming responses (OpenAI's
  // stream_options.include_usage contract). Kept separate from the SAP-side
  // include_usage enablement in transformRequestToSAPFormat, which stays on
  // unconditionally for supported providers so internal accounting always has
  // usage to read, regardless of what the client asked for.
  const clientWantsUsage = req.body?.stream_options?.include_usage === true;

  // Debug log
  logger.info('openaiController', `handleChatCompletion called with model=${req.body.model}, stream=${req.body.stream}`);
  const requestStartTime = Date.now();
  const debugRequestId = req.debugRequestId;
  const originalModelFromRequest = req.body.model;

  // Initialize usage tracking
  const usageMetrics = createUsageMetrics();

  // A Connection model goes to its connection, never to SAP (spec 2026-10-23 §5.1).
  const external = await resolveExternalTarget(req, res, originalModelFromRequest, 'openai', 'openai');
  if (external.kind === 'handled') return;
  if (external.kind === 'external') return dispatchChat(req, res, external.target, usageMetrics, originalModelFromRequest);

  // --- BEGIN DEPLOYED MODEL HANDLING ---
  if (originalModelFromRequest && originalModelFromRequest.endsWith('--deployed')) {
    if (!enforceEntitlement(req, res, originalModelFromRequest)) return;

    // This branch bypasses transformRequestToSAPFormat (and the ref collection that
    // follows it, below, for the non-deployed path) entirely -- a SAP-hosted vision
    // deployment (e.g. gpt-4o--deployed) still needs its image_url refs collected for
    // imageTokenCapture.ts, so it's done here instead. Every path through this block
    // returns before reaching the non-deployed section's own collectChatImageRefs call,
    // so this never runs twice for the same request.
    (req as any).__imageRefs = collectChatImageRefs(req.body.messages);
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

      // Only providers whose SAP AI Core deployments expose an OpenAI-compatible
      // /chat/completions endpoint are served here. Anthropic deployments use a
      // different (Bedrock-style) contract and are served by the /anthropic route,
      // so refuse anything else before the deployment is called.
      if (!OPENAI_COMPATIBLE_DEPLOYMENT_PROVIDERS.includes(deployedModelProvider)) {
        logger.warn('openaiController', `Deployed model ${originalModelFromRequest} has provider '${deployedModelProvider}', which this route does not serve`);
        const hint = deployedModelProvider === 'anthropic'
          ? 'Use the Anthropic Messages endpoint (/anthropic/v1/messages) instead.'
          : 'Chat completions serve only OpenAI and Perplexity deployments.';
        const deploymentKind = deployedModelProvider && deployedModelProvider !== 'unknown'
          ? `a ${deployedModelProvider} deployment`
          : 'a non-OpenAI-compatible deployment';
        res.status(400).json({
          error: {
            message: `Model ${originalModelFromRequest} is ${deploymentKind} and cannot be used for chat completions on this endpoint. ${hint}`,
            type: 'invalid_request_error',
            code: 'model_not_supported'
          }
        });
        return;
      }

      // Posting to the bare deployment URL 404s, so the path must be appended
      // (webSearchPlugin does the same for Perplexity).
      let finalDeploymentUrl = modelDetails.deploymentUrl;
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

      // Plugins run on the client body BEFORE it is copied into the deployment payload,
      // so masking (pseudonymization) reaches the deployment. They run after the
      // entitlement and provider refusals above: a refused request is never masked.
      // The deployment is always called non-streaming (below), so the streaming subpath
      // only selects the hook set; the answer is unmasked once, on the full body.
      const clientRequestedStream = req.body.stream === true;
      const subPath = clientRequestedStream ? 'invoke-with-response-stream' : 'invoke';
      (req as any).__endpoint = 'openai';
      // Keyed on the `--deployed` id: per-model hook overrides for deployed models are
      // keyed that way; getHookConfig falls back to hooks.defaults.openai.
      const hookConfig: HookConfig = configService.getHookConfig(originalModelFromRequest, subPath, 'openai');

      // Fail closed, as the Responses route does: with pseudonymization forced for this
      // request (route or model) and a hook chain that would not run the plugin, the request
      // would reach the deployment unmasked.
      if (refuseIfForcedWithoutPlugin(req, res, hookConfig, {
        endpoint: 'openai', subPaths: [subPath], servedModel: originalModelFromRequest, component: 'openaiController',
      })) return;

      if (hookConfig) {
        logger.info('openaiController', `Executing before plugins for deployed model ${originalModelFromRequest}, subpath ${subPath}`);
        const pluginResult: PluginResult = await executeBeforePlugins(req, res, hookConfig);
        if (pluginResult.stop) {
          logger.info('openaiController', `Plugin short-circuited request for ${originalModelFromRequest}/${subPath}`);
          return; // Response already sent by plugin
        }
      }

      let deploymentPayload = { ...req.body };
      delete deploymentPayload.stream; // Direct call to deploymentUrl is non-streaming

      // The deployment knows only its upstream model name, not our `--deployed`
      // alias (Perplexity rejects it: "Model 'sonar--deployed' is not allowed,
      // supported model: sonar."). Send the real name.
      if (modelDetails.model) {
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

      const aiResourceGroup = currentSapTarget().resourceGroup;
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

      // Track usage from deployment response. UNLIKE the five SAP-orchestration
      // fold sites elsewhere in this file, this branch's producer is a real
      // OpenAI-compatible endpoint (finalDeploymentUrl, restricted to
      // OPENAI_COMPATIBLE_DEPLOYMENT_PROVIDERS above), not SAP. Per OpenAI's
      // documented contract, `prompt_tokens_details.cached_tokens` is INCLUSIVE
      // (a subset already counted inside prompt_tokens) — as SAP orchestration also
      // measured for gpt-4.1-nano (the other sites fold per model family,
      // foldOrchestrationUsageFor). No live capture of a
      // deployed-model cached response exists to confirm this branch actually
      // follows that contract, so cache tokens are deliberately NOT split here
      // pending one. Splitting with the exclusive fold (as if cache rode along
      // as a separate line item) would double-count against prompt_tokens.
      if (deploymentResponse.data && deploymentResponse.data.usage) {
        const deployedUsage = deploymentResponse.data.usage;
        foldExclusiveUsage(
          usageMetrics,
          deployedUsage.prompt_tokens || 0,
          deployedUsage.completion_tokens || 0,
          0,
          0,
        );
      }

      // Response Handling. OpenAI-compatible deployments (incl. Perplexity)
      // already return an OpenAI-shaped chat.completion, so it is passed through
      // after the after-plugins (which unmask it) have run. Both the JSON answer and
      // the emulated stream are written from this one unmasked body.
      let clientBody = deploymentResponse.data;
      if (hookConfig) {
        clientBody = await executeAfterPlugins(req, res, clientBody, hookConfig);
      }

      const modelName = (req as any).isOpenRouterRequest ? (req as any).originalOpenRouterModel || originalModelFromRequest : originalModelFromRequest;

      // Emit usage event for successful deployed model request. This deployment is a
      // real SAP-hosted vision-capable endpoint (e.g. gpt-4o--deployed) that never
      // reports image tokens back any more than orchestration does, so the same
      // off-hot-path compute applies here: captureImageTokensAsync only schedules the
      // compute and returns immediately, so the client write below (res.json /
      // emulateOpenAIStreamFromFullResponse) is never delayed by it -- only the
      // already-fire-and-forget emit is sequenced to wait, via onComplete.
      const imageRefs = (req as any).__imageRefs;
      const emitFinal = () => emitUsageEvent(req, usageMetrics, modelName, deploymentResponse.status);
      if (imageRefs?.length) captureImageTokensAsync(req, usageMetrics, imageRefs, emitFinal); else emitFinal();

      if (clientRequestedStream && configService.shouldEmulateStreaming('openai', originalModelFromRequest)) {
        logger.warn('openaiController', `Client requested stream and emulation is configured for deployed model ${originalModelFromRequest}. Using full response-to-stream emulation.`);
        emulateOpenAIStreamFromFullResponse(res, clientBody, completion, undefined, clientWantsUsage);
      } else {
        res.json(clientBody); // Non-streaming
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
    
    if (!enforceEntitlement(req, res, originalModelFromRequest)) return;

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
    (req as any).__imageRefs = collectChatImageRefs(req.body.messages);
    // The model SAP is asked for, which decides how its usage counts cached tokens
    // (cacheRegimeFor in usageFolding.ts). Not the stream chunks' own `model`: SAP
    // labels some of them "gpt-4" whatever the model (cache-probe-result.md).
    const sapModelName = payload.config.modules.prompt_templating.model.name;

    // Determine subPath for hook config
    const subPath = req.body.stream === true ? 'invoke-with-response-stream' : 'invoke';
    
    // Get hook configuration for this model+subpath
    (req as any).__endpoint = 'openai';
    const hookConfig: HookConfig = configService.getHookConfig(req.body.model, subPath, 'openai');

    // Fail closed: with pseudonymization forced and no hook chain that runs the plugin, the
    // request would reach SAP unmasked.
    if (refuseIfForcedWithoutPlugin(req, res, hookConfig, { endpoint: 'openai', subPaths: [subPath], component: 'openaiController' })) return;
    
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
      
      // Use the modern AbortController for cancellation
      const abortController = new AbortController();

      // The SSE headers and the initial role chunk wait for the upstream's first content
      // (or the start deadline) — utils/streamStart.ts. SAP answers HTTP 200 and sends a
      // rejection ("prompt is too long", an unknown model) as an in-stream chunk after its
      // templating chunk, so committing the 200 up front left a failure no way to reach the
      // client but an error frame under a 200. Chunks without content (that templating
      // chunk's empty delta) are held and written, in order, once the stream starts.
      // Skipped for emulated streaming - the emulator writes its own headers and preamble.
      let streamStart: DeferredStreamStart | null = null;
      const heldChunks: string[] = [];
      if (!req.emulatedStreaming) {
        streamStart = deferStreamStart({
          onStart: () => {
            // Set headers for Server-Sent Events (SSE)
            res.set({
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive'
            });
            res.flushHeaders();

            // Send initial message with role
            logger.debug('openaiController', 'Sending initial role message');
            const initialChunk = {
              id: completion.id,
              object: 'chat.completion.chunk',
              created: completion.created,
              model: completion.model,
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
            for (const held of heldChunks.splice(0)) sseWriter.writeChunk(res, held);
          },
          isOpen: () => !res.writableEnded && !abortController.signal.aborted,
        });
      } else {
        logger.debug('openaiController', 'Skipping initial headers and chunk for emulated streaming');
      }

      // A failure the client must see: its HTTP status and OpenAI's JSON error body while
      // nothing was sent, else one error frame that ends the stream (no [DONE] after it).
      // OpenAI's error object always carries `param` (null when no parameter is at fault).
      const sendStreamError = (status: number, error: Record<string, any>): void => {
        streamStart?.stop();
        if (res.writableEnded) return;
        const body = { error: { ...error, param: null } };
        if (!res.headersSent) {
          res.status(httpStatusOr(status)).json(body);
          return;
        }
        sseWriter.writeError(res, body);
      };

      // Listen for client disconnect (abort) and cancel the SAP request
      req.on('aborted', () => {
        logger.info('openaiController', 'Client aborted the request (req aborted event).');
        abortController.abort('Client aborted request');
      });

      // A hang-up is `res` 'close' with the response unfinished. Not `req` 'close': on Node 20 the
      // request emits it once its body is consumed, which is not a disconnect (see onClientClose
      // in googleWire.ts).
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
      // Track streaming token usage: the raw SAP counts are accumulated here and folded
      // once at the end by foldOrchestrationUsageFor (src/utils/usageFolding.ts), which
      // picks the regime from sapModelName. Claude is EXCLUSIVE — measured live on
      // POST /openai/v1/chat/completions, 2026-08-07
      // (test/fixtures/orchestration/cache-probe-result.md): prompt_tokens stayed
      // flat at 14 across two identical calls while prompt_tokens_details.cached_tokens
      // went 0 -> 29004. Amazon Nova is EXCLUSIVE too (probe of 2026-09-30: prompt_tokens
      // 7 with cache_creation_tokens 9811, then 7 with cached_tokens 9811). OpenAI-family
      // and Gemini models are INCLUSIVE (probe of 2026-09-30: gpt-4.1-nano prompt_tokens
      // 1978 flat, cached_tokens 0 -> 1792), so the cache is subtracted there, and a usage
      // whose prompt is smaller than its cache is folded exclusive whatever the name
      // (cacheRegimeForUsage). Usage arrives on the FINAL streamed chunk only (measured: 1 of
      // several chunks per response), so this accumulator's `+=` is not a double-count
      // today; cache_creation_tokens was absent on T2's streaming captures but T11
      // observed it once on a streaming round of the same backend
      // (bridge-cache-probe-result.md, T11 section) — governing rule unknown, which is
      // why the field is read tolerantly below rather than assumed absent.
      let streamTokenCounts = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      }; // Track streaming token usage
      // Most complete usage object seen on the SAP source chunk, held for the
      // spec-compliant final usage chunk emitted to opted-in clients (see
      // clientWantsUsage below) right before [DONE].
      let lastUsage: any = null;
      // Status of the first error chunk the stream delivered, or null if none did.
      let streamErrorStatus: number | null = null;
      // Set when sapAIService reports the client connection gone (a canceled chunk). The
      // client-already-aborted path sends one without this controller's abort signal firing.
      let clientCanceled = false;

      // For emulated streaming, we need to handle the Promise differently
      const streamingPromise = sapAIService.streamChatCompletion(payload, (chunk: StreamChunk) => {
        // Check if we received a non-streaming response with emulation flag
        if (chunk && chunk.nonStreamingResponse && chunk.useEmulatedStreaming) {
          logger.debug('openaiController', 'Received non-streaming response with emulation flag, processing asynchronously');
          
          // Store the emulated streaming data for later processing
          emulatedStreamingData = {
            skipNormalProcessing: true,
            nonStreamingResponse: chunk.nonStreamingResponse,
          };
          return; // Return void
        }
        
        // Log the raw chunk from SAP AI Core for deep debugging
        logger.trace('openaiController', `Raw chunk from SAP AI Core:`, { chunk });
        
        // Log the chunk with its counter
        logger.debug('openaiController', `Processing chunk #${chunk.chunkNumber || ++chunkCounter} from SAP AI Core`);
        
        // A client cancel is neither an error nor data: never transform or write it. The
        // request is billed as a 499 once the stream settles.
        if (chunk.canceled) {
          logger.info('openaiController', `Request canceled by client: ${chunk.message}`);
          clientCanceled = true;
          return;
        }

        // Handle error chunks
        if (chunk.error) {
          // sapAIService's own error chunks are { error: true, message, status }; SAP's in-stream
          // error event arrives as { error: { code, message } } (as anthropicResponseService reads
          // it). A numeric HTTP-like code there is the status.
          const sapError = typeof chunk.error === 'object' ? chunk.error : undefined;
          const sapErrorCode = Number(sapError?.code);
          const errorMessage = chunk.message || sapError?.message;
          // Checked: it reaches res.status() when nothing was streamed yet.
          const errorStatus = httpStatusOr(chunk.status,
            Number.isInteger(sapErrorCode) && sapErrorCode >= 400 && sapErrorCode <= 599 ? sapErrorCode : 500);
          logger.error('openaiController', `Error chunk received: ${errorMessage}`);
          // sapAIService resolves the stream promise after an error chunk, so remember the
          // failure for the completion handler: this request is billed as failed, not as a 200.
          if (streamErrorStatus === null) streamErrorStatus = errorStatus;
          // OpenAI's error vocabulary for `type`; `details` (the raw upstream body) is never
          // forwarded.
          const errorPayload = {
            message: errorMessage,
            type: errorTypeForStatus(errorStatus),
            code: errorStatus,
          };
          logger.trace('openaiController', 'Writing error chunk to client:', { errorPayload });
          sendStreamError(errorStatus, errorPayload);
          return;
        }
        
        // Handle done marker
        if (chunk.done) {
          logger.debug('openaiController', 'Received [DONE] marker');
          streamStart?.start();
          if (clientWantsUsage && lastUsage) {
            sseWriter.writeChunk(res, JSON.stringify(usageChunk(completion, lastUsage)));
          }
          sseWriter.writeDone(res);
          return;
        }

        try {
          // Process normal chunk data
          const transformedResponse = transformSAPResponseToOpenAI(chunk, true, completion);
          recordInvokedTools(req, openaiChatAdapter.invokedToolsFromChunk(transformedResponse));
          logger.trace('openaiController', 'Writing transformed data chunk to client:', { transformedResponse });
          if (streamStart && !streamStart.started && !isSubstantiveChunk(chunk)) {
            heldChunks.push(JSON.stringify(transformedResponse));
          } else {
            streamStart?.start();
            sseWriter.writeChunk(res, JSON.stringify(transformedResponse));
          }

          // Extract token usage for internal accounting from the SAP source chunk
          // itself, NOT from transformedResponse — content/delta chunks no longer
          // carry usage to the client (see transformSAPResponseToOpenAI), but SAP
          // still returns it upstream (transformRequestToSAPFormat's include_usage
          // is unconditional), so accounting reads it straight from the source.
          const chunkUsage = chunk?.final_result?.usage;
          if (chunkUsage) {
            logger.debug('openaiController', 'Found usage data on SAP source chunk:', chunkUsage);
            if (chunkUsage.prompt_tokens) {
              streamTokenCounts.inputTokens += chunkUsage.prompt_tokens;
            }
            if (chunkUsage.completion_tokens) {
              streamTokenCounts.outputTokens += chunkUsage.completion_tokens;
            }
            if (chunkUsage.prompt_tokens_details?.cached_tokens) {
              streamTokenCounts.cacheReadInputTokens += chunkUsage.prompt_tokens_details.cached_tokens;
            }
            if (chunkUsage.prompt_tokens_details?.cache_creation_tokens) {
              streamTokenCounts.cacheCreationInputTokens += chunkUsage.prompt_tokens_details.cache_creation_tokens;
            }
            lastUsage = chunkUsage; // most complete usage seen, held for the final usage chunk
            logger.debug('openaiController', 'Updated streaming token counts:', streamTokenCounts);
          } else {
            logger.debug('openaiController', 'No usage data on SAP source chunk');
          }
        } catch (error: any) {
          logger.error('openaiController', 'Error transforming chunk:', error);
          sendStreamError(500, {
            message: `Error processing chunk: ${error.message}`,
            type: 'processing_error',
            code: null
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
                emulateOpenAIStreamFromFullResponse(res, emulatedStreamingData.nonStreamingResponse, completion, () => {
                  logger.debug('openaiController', 'Emulation complete callback received');
                  resolve({ emulationHandled: true });
                }, clientWantsUsage);
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
            
            // The emulator only replays the response; the request is billed here, once the
            // replay has finished (or the client went away).
            const modelName = (req as any).isOpenRouterRequest ? (req as any).originalOpenRouterModel || originalModelFromRequest : originalModelFromRequest;

            // nonStreamingResponse is the raw SAP orchestration body (usage under final_result,
            // not top level), so it is read the way the non-streaming path reads it: through
            // transformSAPResponseToOpenAI. SAP orchestration never reports image tokens, so
            // billSapCompletion computes them off the hot path (imageTokenCapture.ts).
            // The client already has the full answer, so a transform that throws here must not
            // turn this into a failed request in .catch: bill the 200 once with the usage read
            // straight off the raw body (or none).
            let transformed: any;
            try {
              transformed = transformSAPResponseToOpenAI(emulatedStreamingData.nonStreamingResponse, false, completion);
            } catch (transformError: any) {
              logger.error('openaiController', `Could not transform the emulated response for billing: ${transformError?.message}`);
              const raw = emulatedStreamingData.nonStreamingResponse;
              transformed = { usage: raw?.final_result?.usage ?? raw?.intermediate_results?.llm?.usage ?? raw?.usage };
            }
            billSapCompletion(req, usageMetrics, transformed, modelName, sapModelName);
            return;
          }
          
          // Regular streaming completion. An upstream that ended without content still
          // gets the role chunk and [DONE].
          if (!res.writableEnded && !abortController.signal.aborted) streamStart?.start();
          streamStart?.stop();
          if (!res.writableEnded) {
            if (clientWantsUsage && lastUsage) {
              sseWriter.writeChunk(res, JSON.stringify(usageChunk(completion, lastUsage)));
            }
            logger.info('openaiController', 'Stream completed successfully, sending [DONE]');
            sseWriter.writeDone(res);
          }
          
          // Update usage metrics with streaming token counts (regardless of response state)
          logger.debug('openaiController', 'Final streaming token counts before usage tracking:', streamTokenCounts);
          if (streamTokenCounts.inputTokens > 0 || streamTokenCounts.outputTokens > 0) {
            foldOrchestrationUsageFor(
              sapModelName,
              usageMetrics,
              streamTokenCounts.inputTokens,
              streamTokenCounts.outputTokens,
              streamTokenCounts.cacheCreationInputTokens,
              streamTokenCounts.cacheReadInputTokens,
            );
            logger.info('openaiController', 'Updated usage metrics with streaming tokens:', {
              inputTokens: streamTokenCounts.inputTokens,
              outputTokens: streamTokenCounts.outputTokens,
              cacheReadInputTokens: streamTokenCounts.cacheReadInputTokens,
              cacheCreationInputTokens: streamTokenCounts.cacheCreationInputTokens
            });
          } else {
            logger.warn('openaiController', 'No streaming token counts to track, will emit usage event with zero tokens');
          }
          
          // Determine provider name based on request source
          const providerName = (req as any).isOpenRouterRequest ? 'openrouter' : 'openai';
          const modelName = (req as any).isOpenRouterRequest ? (req as any).originalOpenRouterModel || originalModelFromRequest : originalModelFromRequest;
          
          // Emit usage event for the streaming request (regardless of response state): 200, or
          // the error chunk's status when the stream ended in one, or 499 when the client hung
          // up, with whatever tokens arrived.
          // Same off-hot-path image-token compute as the emulated-streaming branch above.
          const finalStatus = streamErrorStatus ?? (clientCanceled || abortController.signal.aborted ? 499 : 200);
          logger.info('openaiController', `Emitting usage event for streaming request: provider=${providerName}, model=${modelName}, status=${finalStatus}`);
          const imageRefs = (req as any).__imageRefs;
          const emitFinal = () => emitUsageEvent(req, usageMetrics, modelName, finalStatus);
          if (imageRefs?.length) captureImageTokensAsync(req, usageMetrics, imageRefs, emitFinal); else emitFinal();
        })
        .catch(async (err: any) => {
          // A client hang-up is billed as a 499 with the tokens seen so far (as the Responses
          // and Google routes do), with no error frame. sapAIService wraps axios's CanceledError
          // ("SAP AI Core streaming failed: canceled", status 500), so the cancel is read from
          // this controller's own abort signal or the wrapped original error. (Not from a message
          // merely containing "abort": an upstream ECONNABORTED is a failure, not a client cancel.)
          if (clientCanceled || abortController.signal.aborted ||
              err?.message === 'canceled' || err?.code === 'ERR_CANCELED' || err?.canceled ||
              err?.originalError?.code === 'ERR_CANCELED') {
            logger.info('openaiController', 'Stream ended due to client disconnection');
            streamStart?.stop();
            if (streamTokenCounts.inputTokens > 0 || streamTokenCounts.outputTokens > 0) {
              foldOrchestrationUsageFor(
                sapModelName,
                usageMetrics,
                streamTokenCounts.inputTokens,
                streamTokenCounts.outputTokens,
                streamTokenCounts.cacheCreationInputTokens,
                streamTokenCounts.cacheReadInputTokens,
              );
            }
            const modelName = (req as any).isOpenRouterRequest ? (req as any).originalOpenRouterModel || originalModelFromRequest : originalModelFromRequest;
            const imageRefs = (req as any).__imageRefs;
            const emitCanceled = () => emitUsageEvent(req, usageMetrics, modelName, 499);
            if (imageRefs?.length) captureImageTokensAsync(req, usageMetrics, imageRefs, emitCanceled); else emitCanceled();
            return;
          }

          // Check if this is a streaming not supported error
          if (err.streamingNotSupported) {
            logger.warn('openaiController', 'Detected streaming not supported error, forcing cache refresh and sending non-streaming request');
            // The fallbacks below answer a stream:true client in SSE: start the stream they
            // continue (headers + role chunk), as it always was by this point.
            if (!res.writableEnded) streamStart?.start();
            streamStart?.stop();

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
                
                const modelName = (req as any).isOpenRouterRequest ? (req as any).originalOpenRouterModel || originalModelFromRequest : originalModelFromRequest;
                let billed = false;
                try {
                  const responseData = await sapAIService.completeChat(payload);
                  logger.info('openaiController', 'Non-streaming response received, emulating stream to client');

                  // Bill the retried completion exactly once, as the non-streaming path does,
                  // before the replay: the upstream call has completed whatever the replay does.
                  billSapCompletion(req, usageMetrics, transformSAPResponseToOpenAI(responseData, false, completion), modelName, sapModelName);
                  billed = true;

                  emulateOpenAIStreamFromFullResponse(res, responseData, completion, undefined, clientWantsUsage);
                  return; // Already handled via emulation
                } catch (retryError: any) {
                  // A failed retry is a failed upstream request and gets its error event, like
                  // every other failure path here; a replay that throws after billing does not.
                  if (!billed) {
                    emitUsageEvent(req, usageMetrics, modelName, retryError.status || retryError.response?.status || 500);
                  }
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

                const modelName = (req as any).isOpenRouterRequest ? (req as any).originalOpenRouterModel || originalModelFromRequest : originalModelFromRequest;
                let billed = false;
                try {
                  const responseData = await sapAIService.completeChat(payload);
                  logger.info('openaiController', 'Non-streaming response received, sending fallback to client');
                  // Bill the retried completion exactly once, same as a normal non-streaming
                  // request (B9): the upstream call above already succeeded regardless of how,
                  // or whether, its result reaches the client below, so billing depends on
                  // neither res.headersSent nor res.writableEnded.
                  const transformedResponse = transformSAPResponseToOpenAI(responseData, false, completion);
                  logger.info('openaiController', `Emitting usage event for non-streaming fallback: model=${modelName}`);
                  billSapCompletion(req, usageMetrics, transformedResponse, modelName, sapModelName);
                  billed = true;

                  if (res.writableEnded) {
                    return; // Client gone: billed, nothing left to deliver
                  }

                  if (res.headersSent) {
                    // The SSE preamble (role chunk) was already flushed before the
                    // streaming attempt failed (B9): res.json() would throw
                    // ERR_HTTP_HEADERS_SENT here, leaving the client with the role
                    // chunk and a silent EOF. Deliver the retried response as SSE
                    // chunks instead, reusing the same full-response emulator the
                    // sibling branch above uses.
                    logger.warn('openaiController', 'Headers already sent, emitting fallback response as SSE chunks');
                    emulateOpenAIStreamFromFullResponse(res, responseData, completion, undefined, clientWantsUsage);
                    return;
                  }

                  return res.json(transformedResponse);
                } catch (retryError: any) {
                  logger.error('openaiController', `Error in non-streaming retry: ${retryError.message}`);
                  // A failed retry is a failed upstream request and gets its error event, like
                  // every other failure path here; a delivery that throws after billing does not.
                  if (!billed) {
                    emitUsageEvent(req, usageMetrics, modelName, retryError.status || retryError.response?.status || 500);
                  }
                  if (!res.writableEnded) {
                    if (!res.headersSent) {
                      return next(retryError);
                    } else {
                      logger.warn('openaiController', 'Headers already sent, sending SSE error frame');
                      sseWriter.writeError(res, {
                        message: `Error in non-streaming retry: ${retryError.message}`,
                        type: 'processing_error'
                      });
                      sseWriter.writeDone(res);

                      // Ensure response is ended properly
                      if (!res.writableEnded) {
                        res.end();
                      }
                    }
                  }
                  // Always return: falling through would add the generic streaming-error
                  // event below as a second event for this request.
                  return;
                }
              }
            }
          }

          // Enhanced error handling for real (non-cancellation) streaming errors
          logger.error('openaiController', `Error in streaming: ${err.message}`);

          // build a proper error payload: SAP's own message where its body carries one (not
          // axios's "Request failed with status code 400"), OpenAI's vocabulary for `type`.
          // Checked: it reaches res.status() when nothing was streamed yet.
          const statusCode = httpStatusOr(err.details?.status, httpStatusOr(err.status, 500));
          const errorPayload = {
            error: {
              message: failureFromError(err).message,
              type: errorTypeForStatus(statusCode),
              code: statusCode,
              // Filtered even behind the DEBUG gate, like awsBedrockController: SAP's
              // error body carries intermediate_results.templating, and turning DEBUG
              // on to diagnose a streaming failure must not start writing templated
              // prompts into the client's stream. See utils/upstreamErrorEnvelope.ts.
              ...(process.env.DEBUG === 'true'
                ? { details: sanitizeUpstreamErrorObject(err.details) }
                : {})
            }
          };

          // Track usage for streaming error case
          const providerName = (req as any).isOpenRouterRequest ? 'openrouter' : 'openai';
          const modelName = (req as any).isOpenRouterRequest ? (req as any).originalOpenRouterModel || originalModelFromRequest : originalModelFromRequest;
          
          // Update metrics with any tokens collected during streaming before error
          if (streamTokenCounts.inputTokens > 0 || streamTokenCounts.outputTokens > 0) {
            foldOrchestrationUsageFor(
              sapModelName,
              usageMetrics,
              streamTokenCounts.inputTokens,
              streamTokenCounts.outputTokens,
              streamTokenCounts.cacheCreationInputTokens,
              streamTokenCounts.cacheReadInputTokens,
            );
          }
          
          // Emit usage event for streaming error
          emitUsageEvent(req, usageMetrics, modelName, statusCode);

          // Before the stream started: the HTTP status and the JSON body. After: one error
          // frame, which ends the response.
          sendStreamError(statusCode, errorPayload.error);
          if (!res.writableEnded) res.end();
        });
    } else {
      // Non-streaming request: wait for complete response
      logger.info('openaiController', 'Handling non-streaming request');
      try {
        const responseData = await sapAIService.completeChat(payload, debugRequestId);
        let transformedResponse = transformSAPResponseToOpenAI(responseData, false, completion);
        recordInvokedTools(req, openaiChatAdapter.invokedTools(transformedResponse));

        // Track usage from transformed response
        if (transformedResponse && transformedResponse.usage) {
          foldOrchestrationUsageFor(
            sapModelName,
            usageMetrics,
            transformedResponse.usage.prompt_tokens || 0,
            transformedResponse.usage.completion_tokens || 0,
            transformedResponse.usage.prompt_tokens_details?.cache_creation_tokens ?? 0,
            transformedResponse.usage.prompt_tokens_details?.cached_tokens ?? 0,
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
        
        // Emit usage event for successful non-streaming request. Same off-hot-path
        // image-token compute as the streaming branches above: `captureImageTokensAsync`
        // only schedules the compute and returns immediately, so `res.json` below is
        // never delayed by it — only the (already fire-and-forget) emit is sequenced
        // to wait, via `onComplete`.
        const imageRefs = (req as any).__imageRefs;
        const emitFinal = () => emitUsageEvent(req, usageMetrics, modelName, 200);
        if (imageRefs?.length) captureImageTokensAsync(req, usageMetrics, imageRefs, emitFinal); else emitFinal();

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
  
  const modelName = openAIReq.model || "gpt-5-mini";
  
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

  // Remove temperature, frequency_penalty, and presence_penalty for OpenAI gpt-5 models.
  // max_tokens is NOT dropped here: a live spike (2026-08-29) against the dev
  // gateway confirmed SAP's orchestration endpoint honors it directly (200,
  // completion capped, finish_reason "length"), matching applyParamRenames'
  // doc-comment that orchestration normalizes this param itself. It is renamed
  // to max_completion_tokens (mirroring the deployed path) rather than sent
  // as-is, to match the OpenAI Chat Completions contract gpt-5 expects.
  if (provider === 'openai' && modelDetails?.id?.toLowerCase().startsWith('gpt-5')) {
    const removedParams = [];

    const renamedParams = applyParamRenames(modelParams, defaultParamRenames('openai', modelDetails?.id));
    if (renamedParams.length > 0) {
      logger.info('openaiController',
        `Renamed param(s) for gpt-5 orchestration ${modelDetails?.id}: ${renamedParams.join(', ')}`);
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

  // The latest message, used as the prompt template in the non-Anthropic branch
  // below. There used to be a flattening pass here that turned array content
  // into a string for Anthropic models; it was dead code — its only reader is
  // the `else` branch below, and the flattening ran only in the `if` branch,
  // which discards it. `prompt_templating` never required string content, and
  // block content already reaches SAP intact via messages_history.
  const templateMessage: OpenAIMessage = latestUserMessage;

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

    // Use the user's system prompt if available, otherwise use a default. The message object
    // itself, never a copy of its content: this payload is built before the plugins run, and
    // pseudonymization masks the message objects in place.
    payload.config.modules.prompt_templating.prompt.template = [
      systemMessage ?? { role: "system", content: "You are a helpful assistant." }
    ];
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
export function transformSAPResponseToOpenAI(sapResponse: any, isStreaming: boolean, completion: Completion): any {
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
      id: completion.id,
      object: 'chat.completion.chunk',
      created: sapResponse.final_result.created || completion.created,
      model: completion.model,
      choices: [
        {
          index: choice.index || 0,
          delta: deltaObject,
          finish_reason: choice.finish_reason ?? null
        }
      ]
      // No `usage` here: per OpenAI's contract, content/delta chunks never carry
      // usage. A spec-shaped final usage chunk (see usageChunk()) is emitted
      // separately, only when the client opted in via stream_options.include_usage.
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
    id: completion.id,
    object: 'chat.completion',
    created: sapResponse.final_result?.created || completion.created,
    model: completion.model,
    choices: [
      {
        index: 0,
        message: messageObject,
        finish_reason: inferFinishReason({ upstream: finishReason, hasToolCalls: !!toolCalls }) ?? 'stop'
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

/**
 * Build the spec-compliant final usage chunk for a streaming response
 * (OpenAI's stream_options.include_usage contract): empty `choices`, usage only.
 * Sent once, immediately before [DONE], only when the client opted in.
 */
export function usageChunk(completion: Completion, usage: any) {
  return {
    id: completion.id,
    object: 'chat.completion.chunk',
    created: completion.created,
    model: completion.model,
    choices: [],
    usage,
  };
}

/**
 * Bill one completed SAP orchestration response that is answered from a full (non-streaming)
 * body: record the tools it called, fold its usage (regime by `sapModelName`,
 * foldOrchestrationUsageFor), and emit the 200 usage event once, after the off-hot-path
 * image-token compute. `transformed` is the transformSAPResponseToOpenAI(..., false, ...)
 * result. Used by the emulated-stream and streaming-fallback sites; the plain non-streaming
 * path does the same steps around its after-plugins instead.
 */
function billSapCompletion(req: any, usageMetrics: UsageMetrics, transformed: any, modelName: string, sapModelName: string): void {
  recordInvokedTools(req, openaiChatAdapter.invokedTools(transformed));
  if (transformed && transformed.usage) {
    foldOrchestrationUsageFor(
      sapModelName,
      usageMetrics,
      transformed.usage.prompt_tokens || 0,
      transformed.usage.completion_tokens || 0,
      transformed.usage.prompt_tokens_details?.cache_creation_tokens ?? 0,
      transformed.usage.prompt_tokens_details?.cached_tokens ?? 0,
    );
  }
  const imageRefs = req.__imageRefs;
  const emitFinal = () => emitUsageEvent(req, usageMetrics, modelName, 200);
  if (imageRefs?.length) captureImageTokensAsync(req, usageMetrics, imageRefs, emitFinal); else emitFinal();
}

function emulateOpenAIStreamFromFullResponse(res: Response, responseData: any, completion: Completion, completionCallback?: () => void, clientWantsUsage: boolean = false): void {
  logger.info('openaiController', `Starting OpenAI stream emulation for model: ${completion.model}`);
  
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
    // Nothing found stays an empty completion, as transformSAPResponseToOpenAI answers the same
    // body on the non-streaming path: never invented assistant text.
    // Any of these may be an object (e.g. a `message` shaped { content }): take its string
    // content/text if it has one, otherwise nothing.
    const candidate = responseData.content || responseData.text || responseData.message;
    fullContent = typeof candidate === 'string' ? candidate
      : typeof candidate?.content === 'string' ? candidate.content
      : typeof candidate?.text === 'string' ? candidate.text
      : '';
    logger.warn('openaiController', `Using fallback content extraction for emulation: ${fullContent.substring(0, 100)}...`);
  }

  // Send initial message_start chunk
  const initialChunk = {
    id: completion.id,
    object: 'chat.completion.chunk',
    created: completion.created,
    model: completion.model,
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
        id: completion.id,
        object: 'chat.completion.chunk',
        created: completion.created,
        model: completion.model,
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
      // Send final chunk with finish_reason. Per OpenAI's contract, content/delta
      // chunks (this one included) never carry usage — a spec-shaped final usage
      // chunk (choices: []) follows separately, only when the client opted in.
      const finalChunk = {
        id: completion.id,
        object: 'chat.completion.chunk',
        created: completion.created,
        model: completion.model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: extractedFinishReason
          }
        ]
      };

      sseWriter.writeChunk(res, JSON.stringify(finalChunk));

      // Emit the spec-compliant final usage chunk only when the client opted in
      // via stream_options.include_usage.
      if (clientWantsUsage && extractedUsage) {
        sseWriter.writeChunk(res, JSON.stringify(usageChunk(completion, extractedUsage)));
      }

      // Send [DONE] marker
      sseWriter.writeDone(res);
      
      logger.info('openaiController', `Completed emulated streaming for model: ${completion.model}`);
      
      // Call completion callback if provided
      if (completionCallback) {
        completionCallback();
      }
    }
  };

  // Start sending chunks
  sendNextChunk();
}

export function chunkText(text: string, averageChunkSize: number = 15): string[] {
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
        if (currentChunk[j] && /[\s.,!?;:]/.test(currentChunk[j]!)) {
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
