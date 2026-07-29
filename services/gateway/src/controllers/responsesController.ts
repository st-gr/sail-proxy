/**
 * OpenAI Responses API (POST /openai/v1/responses).
 *
 * Deployed GPT-5+/o-series models serve the Responses API natively, so this
 * forwards the request essentially unchanged and passes the result back —
 * preserving reasoning items, encrypted content and the exact SSE framing the
 * client expects. Orchestration-served models are out of scope (phase 2).
 *
 * NOTE on ordering: before-plugins run BEFORE the outbound payload is built.
 * openaiController does the opposite and never rebuilds its payload, so
 * plugins there cannot affect the outbound body. Do not copy that.
 */
import { Request, Response, NextFunction } from 'express';
import axios, { AxiosResponse } from 'axios';
import modelService from '../services/modelService';
import configService from '../services/configService';
import { executeBeforePlugins, executeAfterPlugins } from '../services/pluginExecutor';
import * as payloadLogger from '../utils/payloadLogger';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();
import { createUsageMetrics, emitUsageEvent, updateTokenCounts } from '../utils/usageTracker';
import { resolveResponsesEligibility } from '../utils/responsesEligibility';
import { stripUnsupportedParams, applyParamRenames } from '../utils/unsupportedParamFilter';
import { readUpstreamErrorBody } from '../utils/upstreamErrorBody';
import { awaitResponsesStreamIdle, abortResponsesStreamContinuation } from '../utils/responsesStreamIdle';
// The single definition of the terminal Responses event types, shared with both res.write
// interceptors. It lived here as a third private copy — and independently drifting copies
// of exactly this set is what the extraction into sseFraming existed to stop.
import { TERMINAL_RESPONSE_TYPES } from '../utils/sseFraming';

function badRequest(res: Response, message: string, code = 'model_not_supported'): void {
  res.status(400).json({ error: { message, type: 'invalid_request_error', code } });
}

/**
 * Feed a Responses `usage` object into the usage metrics.
 *
 * Responses counts cached input INSIDE `input_tokens`, whereas the usage event
 * prices input and cache-read separately and ADDS them (admin
 * modelCostService: input*rate + cacheRead*cacheReadRate). So subtract the
 * cached part from the full-rate input rather than reporting it twice.
 */
function applyResponsesUsage(usageMetrics: any, usage: any): void {
  if (!usage) return;
  const cachedInput = usage.input_tokens_details?.cached_tokens || 0;
  const inputTokens = Math.max(0, (usage.input_tokens || 0) - cachedInput);
  updateTokenCounts(usageMetrics, inputTokens, usage.output_tokens || 0, 0, cachedInput);
}

/**
 * Pull `usage` off the last terminal frame of a captured SSE stream.
 *
 * Real frame shape (bare `data:` line, type inside the JSON):
 *   data: {"type":"response.completed","sequence_number":42,"response":{...,"usage":{...}}}
 *
 * Walk complete blocks from the end so the newest terminal frame wins.
 * Best-effort by contract: never throws, returns undefined when nothing parses.
 */
function extractStreamUsage(captured: string): any | undefined {
  const blocks = captured.split('\n\n');
  for (let i = blocks.length - 1; i >= 0; i--) {
    const line = blocks[i].split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    try {
      const frame = JSON.parse(line.slice('data: '.length));
      if (TERMINAL_RESPONSE_TYPES.has(frame?.type)) return frame.response?.usage;
    } catch { /* not a JSON frame — keep walking */ }
  }
  return undefined;
}

export const handleResponses = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
  const requestedModel = (req.body || {}).model;
  const usageMetrics = createUsageMetrics();
  const debugRequestId = (req as any).debugRequestId;
  const isStreaming = (req.body || {}).stream === true;

  if (!requestedModel) {
    badRequest(res, 'Missing required parameter: model', 'invalid_request_error');
    return;
  }

  try {
    if (debugRequestId) {
      payloadLogger.savePayload(debugRequestId, '00_original_responses_request', req.body, req);
    }

    const modelDetails: any = await modelService.getModelDetails(requestedModel);
    const provider = (modelDetails?.provider || modelDetails?.owned_by || '').toLowerCase();
    const isDeployed = !!modelDetails?.deploymentUrl;

    const eligible = !!modelDetails && resolveResponsesEligibility({
      modelName: requestedModel,
      provider,
      isDeployed,
      modelFlag: configService.getSupportsResponsesApi(undefined, requestedModel),
      providerFlag: configService.getSupportsResponsesApi(provider, undefined),
    });

    if (!eligible) {
      logger.warn('responsesController', `Model ${requestedModel} is not eligible for the Responses API (provider=${provider}, deployed=${isDeployed})`);
      badRequest(res,
        `Model ${requestedModel} does not support the Responses API. It requires a deployed GPT-5+ or o-series model, e.g. gpt-5.3-codex--deployed. Use /openai/v1/chat/completions for other models.`);
      return;
    }

    // resolveResponsesEligibility short-circuits on the config flags BEFORE the
    // isDeployed check (by design), so `supports_responses_api: true` on a model
    // that has no deployment lands here. Without this guard the URL becomes
    // "undefined/responses" and the caller gets an opaque 500.
    if (!modelDetails.deploymentUrl) {
      logger.warn('responsesController', `Model ${requestedModel} is flagged for the Responses API but has no deployment URL`);
      badRequest(res,
        `Model ${requestedModel} has no deployment and cannot serve the Responses API. It requires a deployed GPT-5+ or o-series model, e.g. gpt-5.3-codex--deployed.`);
      return;
    }

    // Plugins first, so masking reaches the outbound body.
    (req as any).__endpoint = 'openai';
    const subPath = isStreaming ? 'responses-stream' : 'responses';
    const hookConfig = configService.getHookConfig(requestedModel, subPath, 'openai');

    // Fail closed. In distributed mode the admin-supplied configuration REPLACES
    // the shipped file config wholesale (configService :380/:755 — no merge), so
    // a configuration activated before this route existed has no `responses` /
    // `responses-stream` keys under defaultHooks.openai. Masking would then be
    // silently skipped on the one endpoint the operator locked with
    // allow_user_bypass:false. Scoped to this route only: nothing else changes.
    if (!hookConfig && configService.isPseudonymizationForced('openai')) {
      const message = 'Pseudonymization is force-enabled for the openai endpoint but no plugin hook is configured for '
        + '`responses` / `responses-stream`. Activate a configuration that includes these keys under '
        + '`defaultHooks.openai` before using this route.';
      logger.error('responsesController', `${message} (model=${requestedModel}, subPath=${subPath})`);
      res.status(503).json({ error: { message, type: 'api_error', code: 'pseudonymization_hook_missing' } });
      return;
    }

    if (hookConfig) {
      const pluginResult: any = await executeBeforePlugins(req, res, hookConfig);
      if (pluginResult?.stop) return;
    }

    const payload: any = { ...req.body };
    if (modelDetails.model) payload.model = modelDetails.model;   // deployment rejects the --deployed alias

    const dropped = stripUnsupportedParams(payload, configService.getUnsupportedParams(provider, requestedModel));
    if (dropped.length > 0) {
      logger.warn('responsesController', `Dropped unsupported parameter(s) for ${requestedModel}: ${dropped.join(', ')}`);
    }
    applyParamRenames(payload, configService.getParamRenames(provider, requestedModel));

    const url = `${modelDetails.deploymentUrl}/responses`;
    if (debugRequestId) {
      payloadLogger.savePayload(debugRequestId, '02_responses_request_to_deployment', { url, payload }, req);
    }

    const authToken = await (modelService as any).getAuthToken();
    const headers = {
      Authorization: `Bearer ${authToken}`,
      'AI-Resource-Group': process.env.SAP_AI_RESOURCE_GROUP || 'default',
      'Content-Type': 'application/json',
    };

    // The web-search plugin continues the turn with a second deployment call after it
    // runs a search; it needs exactly what we resolved here. `payload` is the OUTBOUND
    // body — alias swapped, unsupported params stripped, renames applied — so a
    // continuation inherits every transformation this call had.
    (req as any).__responsesUpstream = {
      url,
      headers,
      timeoutMs: configService.getTimeout(isStreaming),
      payload,
    };
    // The plugin accumulates onto this (e.g. `__responsesExtraUsage.input_tokens += n`)
    // rather than assigning a fresh object, so it must exist before the after-plugin
    // chain runs. Left undefined, a `+=` on a missing property throws inside the
    // plugin, gets swallowed by pluginExecutor's per-plugin catch, and the
    // continuation's tokens vanish silently.
    (req as any).__responsesExtraUsage = { input_tokens: 0, output_tokens: 0 };

    if (isStreaming) {
      await forwardStream(req, res, url, payload, headers, usageMetrics, requestedModel, debugRequestId);
      return;
    }

    const upstream: AxiosResponse = await axios.post(url, payload, {
      headers,
      timeout: configService.getTimeout(false),
    });

    if (debugRequestId) {
      payloadLogger.savePayload(debugRequestId, '03_responses_response_from_deployment', upstream.data, req, res);
    }

    applyResponsesUsage(usageMetrics, upstream.data?.usage);

    let finalBody = upstream.data;
    if (hookConfig) finalBody = await executeAfterPlugins(req, res, upstream.data, hookConfig);

    // The web-search continuation plugin accumulates its extra deployment call's
    // usage here while executeAfterPlugins runs above, so the fold — and the usage
    // event it feeds — must happen after that call, not before it.
    const extra = (req as any).__responsesExtraUsage;
    if (extra && (extra.input_tokens || extra.output_tokens)) {
      updateTokenCounts(usageMetrics, extra.input_tokens || 0, extra.output_tokens || 0);
    }

    emitUsageEvent(req, usageMetrics, requestedModel, upstream.status);

    res.status(upstream.status).json(finalBody);
  } catch (error: any) {
    const status = error.response?.status || 500;
    // Streaming uses responseType:'stream', so on an error status axios hands back
    // error.response.data as a live IncomingMessage — circular. Passing it as
    // logger metadata throws inside JSON.stringify BEFORE the payload log, the
    // usage event and res.json run; Express 4 does not catch async rejections, so
    // the client would hang with zero bytes written. Drain it to a plain value
    // first (never throws, returns non-stream bodies unchanged).
    const errBody = await readUpstreamErrorBody(error.response);
    // 4th parameter: the 3rd is Error-typed and silently drops plain objects.
    logger.error('responsesController', `Responses request failed for ${requestedModel}: ${error.message}`, undefined, {
      status, data: errBody,
    });
    if (debugRequestId && error.response) {
      payloadLogger.savePayload(debugRequestId, '97_responses_error_from_deployment',
        { status, data: errBody }, req, res);
    }
    emitUsageEvent(req, usageMetrics, requestedModel, status);

    if (res.headersSent || res.writableEnded) {
      // Mid-stream: cannot change status. Emit a Responses-shaped failure frame.
      try {
        res.write(`data: ${JSON.stringify({ type: 'response.failed', response: { status: 'failed', error: { message: error.message } } })}\n\n`);
      } catch { /* best effort */ }
      res.end();
      return;
    }
    res.status(status).json(errBody || {
      error: { message: error.message, type: 'api_error', code: status },
    });
  }
};

/** Pipe the upstream SSE bytes straight through; res.write is patched by the masking plugin. */
async function forwardStream(
  req: Request, res: Response, url: string, payload: any,
  headers: Record<string, string>, usageMetrics: any, requestedModel: string,
  debugRequestId?: string,
): Promise<void> {
  const upstream: AxiosResponse = await axios.post(url, payload, {
    headers, responseType: 'stream', timeout: configService.getTimeout(true),
  });

  if (!res.headersSent) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
  }

  let captured = '';
  upstream.data.on('data', (chunk: Buffer) => {
    const s = chunk.toString('utf8');
    captured += s;
    res.write(s);
  });

  // Measured on Node 20 + Express 4 (bodyParser.json): `req` is destroyed within ~5ms of
  // route entry, on EVERY request, before forwardStream is even reached — so a listener
  // registered here never fires, in the normal case or a genuine disconnect. Kept because
  // it is harmless and correct in principle, but it is not what detects a disconnect.
  // (The dead upstream.data.destroy() inside it predates the web-search work.) Registering
  // it at route top instead would be worse: there it fires within ~1ms on every request
  // and would cancel everything.
  req.on('close', () => {
    if (upstream.data?.destroy) upstream.data.destroy();
    abortResponsesStreamContinuation(res);
  });

  // This is the signal that actually fires — the belt-and-braces pattern openaiController
  // and anthropicController already use, which this controller was the outlier for
  // omitting. `writableEnded` is load-bearing: res 'close' fires on normal completion too,
  // so without the guard every ordinary turn would cancel its own continuation.
  if (typeof (res as any).on === 'function') {
    res.on('close', () => {
      if (res.writableEnded) return;
      if (upstream.data?.destroy) upstream.data.destroy();
      // The web-search plugin owns a SECOND stream this function knows nothing about, and
      // without this would go on to open a further deployment call — paid for, billed to
      // nobody — for a request the client has already abandoned.
      abortResponsesStreamContinuation(res);
    });
  }

  await new Promise<void>((resolve) => {
    let settled = false;

    // Single settlement point: the upstream Readable can reach termination via
    // 'end' (normal completion), 'error' (upstream failure) or 'close' (destroyed
    // — either after 'end'/'error' fired, or standalone when the client
    // disconnects and req.on('close') above calls upstream.data.destroy() with
    // no error, which emits 'close' but neither 'end' nor 'error'). Without this
    // guard the client-disconnect case never resolves the promise, leaking the
    // handler and silently dropping the usage event for the whole request.
    // Synchronous entry point: claims the single settlement slot in the same tick the
    // event fires (two events can arrive back to back), then hands off to the async
    // completion below.
    const finish = (reason: 'end' | 'error' | 'close', error?: any): void => {
      if (settled) return;
      settled = true;
      void complete(reason, error);
    };

    async function complete(reason: 'end' | 'error' | 'close', error?: any): Promise<void> {
      let statusCode = 200;

      if (reason === 'end') {
        // Usage lives on the final response.completed frame. `captured` holds the FIRST
        // deployment call's raw bytes only, which is exactly right: a continuation's
        // tokens arrive through __responsesExtraUsage instead.
        try {
          applyResponsesUsage(usageMetrics, extractStreamUsage(captured));
        } catch { /* usage is best-effort */ }

        // The upstream stream ending is NOT the end of the response when the web-search
        // plugin is splicing a continuation call into it: that second call is opened
        // after this event, so folding (and closing the socket) here without waiting
        // billed zero continuation tokens and cut the splice off mid-write. forwardStream
        // never runs the after-plugin chain either, so this is the only place the plugin
        // can be waited on. Absent an interceptor this returns immediately.
        await awaitResponsesStreamIdle(res, configService.getTimeout(true), () => {
          logger.warn('responsesController', `Web-search continuation did not finish in time for ${requestedModel}; closing the stream`);
        });

        // Same fold as the non-streaming path: the web-search continuation plugin
        // accumulates its extra deployment call's usage onto the request here.
        const extra = (req as any).__responsesExtraUsage;
        if (extra && (extra.input_tokens || extra.output_tokens)) {
          updateTokenCounts(usageMetrics, extra.input_tokens || 0, extra.output_tokens || 0);
        }
      } else if (reason === 'error') {
        statusCode = 500;
        // 4th parameter: the 3rd is Error-typed and silently drops plain objects.
        logger.error('responsesController', `Responses stream failed for ${requestedModel}: ${error?.message || error}`, undefined, {
          error: error?.message || error,
        });
        if (!res.writableEnded) {
          try {
            res.write(`data: ${JSON.stringify({ type: 'response.failed', response: { status: 'failed', error: { message: error?.message || 'stream error' } } })}\n\n`);
          } catch { /* best effort */ }
        }
      } else {
        // Client disconnected mid-stream. Still account for tokens received so
        // far — previously this path never resolved, so the usage event for a
        // cancelled stream was silently dropped.
        statusCode = 499;
      }

      emitUsageEvent(req, usageMetrics, requestedModel, statusCode);
      if (debugRequestId) {
        payloadLogger.savePayload(debugRequestId,
          reason === 'error' ? '97_responses_stream_error_from_deployment' : '03_responses_stream_from_deployment',
          { totalLength: captured.length, rawResponse: captured.slice(0, 200000) }, req, res);
      }
      if (!res.writableEnded) res.end();
      resolve();
    }

    upstream.data.on('end', () => finish('end'));
    upstream.data.on('error', (error: any) => finish('error', error));
    upstream.data.on('close', () => finish('close'));
  });
}
