import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

// Use require for CommonJS modules
import awsBedrockService from '../services/awsBedrockService';
import configService from '../services/configService';
import { sanitizeUpstreamErrorObject, unwrapUpstreamError } from '../utils/upstreamErrorEnvelope';
import modelService from '../services/modelService';
import { executeBeforePlugins, executeAfterPlugins } from '../services/pluginExecutor';
import { PSEUDONYMIZATION_HOOK_MISSING_CODE, recordRouteEndpoint, refuseIfForcedWithoutPlugin } from '../plugins/pseudonymization/forcedRun';
import { PSEUDONYMIZATION_FAILED_CODE } from '../plugins/pseudonymization/failClosed';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();
import { createUsageMetrics, emitUsageEvent, updateTokenCounts } from '../utils/usageTracker';
import { isPayloadLoggingEnabled } from '../utils/payloadLogger';
import { enforceEntitlement } from '../utils/modelEntitlement';
import { resolveExternalTarget } from '../upstreams/externalTarget';
import { recordInvokedTools, bedrockAdapter, tapStreamedTools } from '../toolGovernance';
import { installBedrockEventStream } from '../utils/bedrockEventStream';
import { converseToAnthropicRequest, anthropicToConverseResponse, anthropicMessageToStreamEvents, bedrockErrorOf } from '../utils/bedrockConverse';
import * as sseWriter from '../utils/sseWriter';
import { isDeployedModel } from '../utils/deployedModel';
import { handleMessages } from './anthropicController';

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

/** Refusals that keep the gateway's error format on the orchestration path. */
const PSEUDONYMIZATION_REFUSAL_CODES = new Set([PSEUDONYMIZATION_HOOK_MISSING_CODE, PSEUDONYMIZATION_FAILED_CODE]);

/**
 * Serve a Bedrock request for a model without a deployment through the /anthropic flow: an invoke
 * body is an Anthropic Messages request already, a Converse body is translated. Answers go back in
 * Bedrock's shape — streams through the event-stream encoder installed before, a converse answer
 * translated here, errors as `{ message }` with `x-amzn-ErrorType`. The two pseudonymization
 * refusals keep the gateway's error format (type and code), as on every other route.
 */
async function serveThroughOrchestration(req: BedrockRequest, res: Response, next: NextFunction, subpath: string,
  model: string, modelDetails: ModelDetails): Promise<void> {
  const stream = subpath.endsWith('-stream');
  const converse = subpath.startsWith('converse');
  const isClaude = String(modelDetails.owned_by || modelDetails.provider || '').toLowerCase() === 'anthropic' || model.includes('claude');
  if (!converse && !isClaude) {
    const error = bedrockErrorOf(400, { message: `${model} has no deployment, and invoke takes the model's native request format; use converse or converse-stream` });
    res.status(400).setHeader('x-amzn-ErrorType', error.type);
    res.json(error.body);
    return;
  }
  logger.info('AwsBedrockController', `${model} has no deployment: serving ${subpath} through orchestration`);
  const started = Date.now();
  const json = res.json.bind(res);
  res.json = ((body: any) => {
    if (res.statusCode >= 400 && PSEUDONYMIZATION_REFUSAL_CODES.has(body?.error?.code)) return json(body);
    if (res.statusCode >= 400) {
      const error = bedrockErrorOf(res.statusCode, body);
      if (!res.headersSent) res.setHeader('x-amzn-ErrorType', error.type);
      return json(error.body);
    }
    if (stream) {
      // A model with neither native nor emulated streaming is answered in one piece; a stream
      // client still gets stream events, which the encoder frames.
      res.setHeader('Content-Type', 'text/event-stream');
      for (const [event, data] of anthropicMessageToStreamEvents(body)) sseWriter.writeEventStream(res, event, JSON.stringify(data));
      res.end();
      return res;
    }
    return json(converse ? anthropicToConverseResponse(body, Date.now() - started) : body);
  }) as typeof res.json;
  if (converse) {
    req.body = converseToAnthropicRequest(req.body, model, stream);
  } else {
    const { anthropic_version: _version, ...body } = req.body || {};
    req.body = { ...body, model, stream };
  }
  await handleMessages(req as any, res, next);
}

/**
 * Handle AWS Bedrock requests for all model operations
 */
export const handleBedrockRequest = async (req: BedrockRequest, res: Response, _next: NextFunction): Promise<void> => {
  // Always carry a unique request id on req itself, matching every other
  // controller (anthropicController.ts, openRouterController.ts): usageTracker
  // reads this for the emitted usage event's requestId, so clobbering it here
  // whenever payload logging was off used to make every Bedrock event fall
  // back to the literal 'unknown'.
  //
  // awsBedrockService, unlike the other controllers' services, uses the id it
  // is HANDED (not req.debugRequestId) as a truthiness switch for more than
  // payload-log gating: it also buffers every streamed chunk into
  // capturedResponseChunks whenever that id is truthy, unconditionally on
  // whether payload logging is enabled. So the id passed to the service below
  // must stay gated on payloadLoggingActive, or every Bedrock streaming
  // response gets buffered in memory even with logging off (the production
  // default).
  const payloadLoggingActive = process.env.DEBUG === 'true' || isPayloadLoggingEnabled();
  const debugRequestId = req.debugRequestId || uuidv4();
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

    if (!enforceEntitlement(req, res, substitutedModelName)) return;

    // This route serves no Connection model (spec 2026-10-23 §5.3): refused, never sent to SAP.
    if ((await resolveExternalTarget(req, res, substitutedModelName, null, 'openai')).kind !== 'sap') return;

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
      // Bedrock streams are AWS event stream frames, not SSE. Installed first, so the
      // before-plugins, the tool tap and the service write and observe SSE above it.
      installBedrockEventStream(res, subpath);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Cache-Control');
    } else {
      res.setHeader('Content-Type', 'application/json');
    }

    // A model without a deployment has no inference URL of its own; SAP serves it through
    // orchestration, which the /anthropic flow speaks. It runs that flow's plugins and books the usage.
    if (!isDeployedModel(modelDetails)) {
      // The /anthropic flow sets its own endpoint; a force on aws-bedrock still applies to it.
      recordRouteEndpoint(req, 'aws-bedrock');
      await serveThroughOrchestration(req, res, _next, subpath, substitutedModelName, modelDetails);
      return;
    }

    // Get any hook configuration for this model+subpath
    (req as any).__endpoint = 'aws-bedrock';
    const hookConfig = configService.getHookConfig(substitutedModelName, subpath, 'aws-bedrock');

    // Fail closed: with pseudonymization forced and no hook chain that runs the plugin, the
    // request would reach the deployment unmasked.
    if (refuseIfForcedWithoutPlugin(req, res, hookConfig, {
      endpoint: 'aws-bedrock', subPaths: [subpath], servedModel: substitutedModelName, component: 'AwsBedrockController',
    })) return;
    
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
    if (isStreamingSubpath) tapStreamedTools(req, res, bedrockAdapter);
    const result = await awsBedrockService.processBedrockRequest({
      modelId: substitutedModelName,
      originalModelId: originalModelFromClient,
      subpath,
      requestBody: req.body,
      headers: req.headers as Record<string, string>,
      debugRequestId: payloadLoggingActive ? debugRequestId : '',
      req,
      res,
      hookConfig, // Pass hook config for 'after' strategy execution
      usageMetrics // Pass usage metrics for tracking
    });

    // Extract usage information from result for tracking
    if (result && typeof result === 'object' && result.usage) {
      if (result.usage.inputTokens !== undefined && result.usage.outputTokens !== undefined) {
        // AWS Bedrock format
        // Cache field names per AWS Bedrock Converse API docs, unconfirmed by capture — see task-T6 report.
        updateTokenCounts(usageMetrics, result.usage.inputTokens || 0, result.usage.outputTokens || 0,
          result.usage.cacheWriteInputTokens || 0, result.usage.cacheReadInputTokens || 0);
      } else if (result.usage.input_tokens !== undefined && result.usage.output_tokens !== undefined) {
        // Anthropic-transformed format
        updateTokenCounts(usageMetrics, result.usage.input_tokens || 0, result.usage.output_tokens || 0,
          result.usage.cache_creation_input_tokens || 0, result.usage.cache_read_input_tokens || 0);
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
      
      recordInvokedTools(req, bedrockAdapter.invokedTools(result));
      emitUsageEvent(req, usageMetrics, substitutedModelName, 200);
    }

    // Execute 'after' plugins AFTER getting the result. A stream's after-plugins run in the
    // service once the stream has ended, with the captured events; here the stream is still
    // running and there is no result to hand them.
    if (hookConfig && !isStreamingSubpath) {
      logger.info('AwsBedrockController', 'Executing after plugins');
      const afterResult = await executeAfterPlugins(req, res, result, hookConfig);
      res.json(afterResult || result);
    } else if (!isStreamingSubpath) {
      // Handle non-streaming responses (no after plugins)
      res.json(result);
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

    // SAP nests the real reason under `error`, so `error.message` here is axios's
    // "Request failed with status code 400" — a status restated, naming no cause.
    // Unwrap first and prefer the upstream's own message; a caller debugging a
    // rejected parameter needs "temperature: range: 0..1", not the status again.
    // Two shapes arrive here. sapAIService-style callers attach `.details`; the
    // native bedrock path rethrows the raw axios error (awsBedrockService.ts:455),
    // which carries the upstream body on `response.data` and no `.details` at all.
    // Reading only the first is why this used to report the status back as the
    // reason even when SAP had explained itself.
    const upstream = sanitizeUpstreamErrorObject(
      unwrapUpstreamError(error.details ?? error.response?.data),
    );

    res.status(statusCode).json({
      error: {
        message: upstream.message || error.message || 'Internal server error',
        type: error.type || 'api_error',
        code: statusCode,
        ...(upstream.request_id ? { request_id: upstream.request_id } : {}),
        ...(upstream.location ? { location: upstream.location } : {}),
        // Filtered even behind the DEBUG gate: an operator turning DEBUG on to
        // diagnose a 400 should not thereby start returning templated prompts to
        // callers. See utils/upstreamErrorEnvelope.ts.
        details: process.env.DEBUG === 'true' ? upstream : undefined
      }
    });
  }
};