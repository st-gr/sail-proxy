/**
 * The three transports behind `/google` (spec section 5.7).
 *
 * `googleController.ts` decides WHICH model serves a request and owns
 * everything shared by all of them — entitlement, hooks, error shaping. This
 * file only moves bytes: a native Gemini deployment (`axios` straight at SAP's
 * inference proxy), the orchestration chat bridge (`sapAIService` plus the
 * three translators in src/google/orchestrationBridge), and embeddings.
 *
 * Every path meters and emits its own usage event, because only the transport
 * knows what the upstream reported; the controller emits one only when the
 * request FAILED before or during a transport (see `failGemini` there).
 */
import axios, { AxiosResponse } from 'axios';
import { Request, Response } from 'express';
import { getDefaultLogger } from '@libs/logger';
import configService from '../services/configService';
import sapAIService from '../services/sapAIService';
import { executeAfterPlugins } from '../services/pluginExecutor';
import { emitUsageEvent, updateTokenCounts } from '../utils/usageTracker';
import { splitBlocks, sseBlock } from '../utils/sseFraming';
import { foldNativeGeminiUsage, foldOrchestrationUsage, onClientClose, openSseStream, pluginFrame } from './googleWire';
import {
  GeminiMethod, estimateEmbedTokens, geminiError, geminiUrl, usageFromSse,
} from '../services/googleGeminiService';
import { joinPartTexts } from '../google/orchestrationBridge/geminiParts';
import { geminiToOrchestrationPayload } from '../google/orchestrationBridge/requestTranslator';
import { orchestrationToGeminiResponse } from '../google/orchestrationBridge/responseTranslator';
import { createGeminiStreamTranslator } from '../google/orchestrationBridge/streamTranslator';
// Type-only, so the controller ↔ dispatch pair has no runtime import cycle.
import type { GeminiRoute } from './googleController';

const logger = getDefaultLogger();

export interface GeminiDispatchContext {
  req: Request;
  res: Response;
  method: GeminiMethod;
  /** `req.body` with the plugin-only `model` field already removed. */
  body: any;
  route: GeminiRoute;
  usage: any;
  hookConfig: any;
  /** AI Core bearer token + resource group; async because the token is fetched. */
  headersForSap: () => Promise<Record<string, string>>;
  /** The accounted model id — a deployment id natively, the orchestration name otherwise. */
  modelName: string;
}

/** A native Gemini deployment: `generateContent` blocking, `streamGenerateContent` piped. */
export async function dispatchNative(ctx: GeminiDispatchContext): Promise<void> {
  const { req, res, method, body, usage, hookConfig, modelName } = ctx;
  const { deployment } = ctx.route as Extract<GeminiRoute, { kind: 'native' }>;
  const url = geminiUrl(deployment.deploymentUrl, deployment.baseModel, method);
  const headers = await ctx.headersForSap();

  if (method === 'streamGenerateContent') {
    await pipeNativeStream(ctx, url, headers);
    return;
  }

  const upstream: AxiosResponse = await axios.post(url, body, { headers, timeout: configService.getTimeout(false) });
  foldNativeGeminiUsage(usage, upstream.data?.usageMetadata);

  let finalBody = upstream.data;
  if (hookConfig) finalBody = await executeAfterPlugins(req, res, finalBody, hookConfig);

  emitUsageEvent(req, usage, modelName, upstream.status);
  res.status(upstream.status).json(finalBody);
}

/**
 * SAP's SSE bytes, passed through unchanged.
 *
 * Frames are NOT re-serialized: the client gets exactly what the Gemini model
 * produced. Plugins still see this stream — the pseudonymization before-handler
 * patches `res.write` (`installSseUnmaskInterceptor`), which is the same
 * mechanism the Anthropic and Bedrock native streams rely on.
 *
 * The re-framing buffer exists only for METERING: `usageMetadata` rides on the
 * last frame, and a frame routinely straddles two TCP chunks, so usage is read
 * off complete blocks rather than off raw chunk boundaries.
 */
async function pipeNativeStream(ctx: GeminiDispatchContext, url: string, headers: Record<string, string>): Promise<void> {
  const { req, res, body, usage, modelName } = ctx;
  const upstream: AxiosResponse = await axios.post(url, body, {
    headers, responseType: 'stream', timeout: configService.getTimeout(true),
  });

  openSseStream(res);
  onClientClose(res, () => { if (upstream.data?.destroy) upstream.data.destroy(); });

  let usageMetadata: any = null;
  let pending = '';
  upstream.data.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    pending += text;
    const { blocks, tail } = splitBlocks(pending);
    pending = tail;
    for (const block of blocks) usageMetadata = usageFromSse(block, usageMetadata);
    if (!res.writableEnded) res.write(text);
  });

  await new Promise<void>((resolve) => {
    let settled = false;
    // Single settlement point: the upstream Readable can terminate through 'end',
    // 'error' or a standalone 'close' (the client disconnected and the handler
    // above destroyed it — neither 'end' nor 'error' fires then). Without the
    // guard the disconnect case would never resolve and its usage event would be
    // dropped for the whole request.
    const finish = (status: number, error?: any): void => {
      if (settled) return;
      settled = true;
      if (error) {
        logger.error('googleController', `Gemini stream failed for ${modelName}: ${error?.message || error}`);
        if (!res.writableEnded) {
          try { res.write(sseBlock(geminiError(status, error?.message || 'stream error'))); } catch { /* best effort */ }
        }
      }
      foldNativeGeminiUsage(usage, usageMetadata);
      emitUsageEvent(req, usage, modelName, status);
      if (!res.writableEnded) res.end();
      resolve();
    };
    upstream.data.on('end', () => finish(200));
    upstream.data.on('error', (error: any) => finish(502, error));
    // 499: the client hung up. The tokens burned so far were still spent.
    upstream.data.on('close', () => finish(499));
  });
}

/** Every non-Gemini model (and every undeployed Gemini one) through SAP orchestration. */
export async function dispatchBridge(ctx: GeminiDispatchContext): Promise<void> {
  const { req, res, body, usage, hookConfig, modelName, method } = ctx;
  const stream = method === 'streamGenerateContent';
  const payload = geminiToOrchestrationPayload(body, { modelName, stream });

  if (stream) {
    await bridgeStream(ctx, payload);
    return;
  }

  const envelope = await sapAIService.completeChat(payload as any, (req as any).debugRequestId);
  foldOrchestrationUsage(usage, (envelope?.final_result ?? envelope ?? {})?.usage);

  let finalBody = orchestrationToGeminiResponse(envelope, { modelName });
  if (hookConfig) finalBody = await executeAfterPlugins(req, res, finalBody, hookConfig);

  emitUsageEvent(req, usage, modelName, 200);
  res.status(200).json(finalBody);
}

async function bridgeStream(ctx: GeminiDispatchContext, payload: any): Promise<void> {
  const { req, res, usage, hookConfig, modelName } = ctx;
  const translator = createGeminiStreamTranslator({ modelName });
  const abort = new AbortController();
  let abandoned = false;

  openSseStream(res);
  onClientClose(res, () => { abandoned = true; abort.abort(); });

  // `streamChatCompletion` does NOT await its callback, so an async write would
  // reorder frames. Writes are chained here instead and the chain is awaited once
  // the upstream is done — the callback itself stays synchronous. The chain never
  // rejects: a write that fails (the client is gone) must not surface as an
  // unhandled rejection while the upstream is still delivering chunks.
  let writes: Promise<void> = Promise.resolve();
  const enqueue = (blocks: string[]): void => {
    if (blocks.length === 0) return;
    writes = writes.then(async () => {
      for (const block of blocks) {
        if (res.writableEnded) return;
        res.write(hookConfig ? await pluginFrame(req, res, hookConfig, block) : block);
      }
    }).catch((error: any) => {
      logger.error('googleController', `Writing a Gemini stream frame failed for ${modelName}: ${error?.message || error}`);
    });
  };

  let status = 200;
  try {
    await sapAIService.streamChatCompletion(payload, (chunk: any) => { enqueue(translator.onChunk(chunk)); },
      abort.signal, req as any, undefined);
    enqueue(translator.finish());
    await writes;
  } catch (error: any) {
    await writes;
    status = error?.status || error?.response?.status || 502;
    logger.error('googleController', `Orchestration stream failed for ${modelName}: ${error?.message || error}`);
    if (!res.writableEnded) {
      try { res.write(sseBlock(geminiError(status, error?.message || 'orchestration stream failed'))); } catch { /* best effort */ }
    }
  }

  // The translator's `usage()` is authoritative — it is what SAP reported, not
  // what the frames happened to carry.
  foldOrchestrationUsage(usage, translator.usage());
  emitUsageEvent(req, usage, modelName, abandoned ? 499 : status);
  if (!res.writableEnded) res.end();
}

/**
 * `embedContent`, through orchestration when the model has the scenario (exact
 * usage) and on a Google embedding deployment otherwise (estimated usage — the
 * one place SAP reports none; spec section 3's ruling).
 *
 * Gemini's `embedContent` carries exactly ONE content, so its text parts are
 * joined with newlines into the single string orchestration takes.
 */
export async function dispatchEmbeddings(ctx: GeminiDispatchContext): Promise<void> {
  const { req, res, body, usage, hookConfig, modelName, route } = ctx;

  if (route.kind === 'embeddings-native') {
    const url = geminiUrl(route.deployment.deploymentUrl, route.deployment.baseModel, 'embedContent');
    const headers = await ctx.headersForSap();
    const upstream: AxiosResponse = await axios.post(url, body, { headers, timeout: configService.getTimeout(false) });

    updateTokenCounts(usage, estimateEmbedTokens(body), 0, 0, 0);
    let finalBody = upstream.data;
    if (hookConfig) finalBody = await executeAfterPlugins(req, res, finalBody, hookConfig);

    emitUsageEvent(req, usage, modelName, upstream.status);
    res.status(upstream.status).json(finalBody);
    return;
  }

  const content = body?.content ?? (Array.isArray(body?.contents) ? body.contents[0] : body?.contents);
  const sapRequest = {
    config: { modules: { embeddings: { model: { name: modelName } } } },
    input: { text: joinPartTexts(content?.parts) },
  };
  const response = await sapAIService.createEmbedding(sapRequest, modelName);
  const result = response?.final_result ?? {};

  updateTokenCounts(usage, result?.usage?.prompt_tokens ?? 0, 0, 0, 0);
  let finalBody: any = { embedding: { values: result?.data?.[0]?.embedding ?? [] } };
  if (hookConfig) finalBody = await executeAfterPlugins(req, res, finalBody, hookConfig);

  emitUsageEvent(req, usage, modelName, 200);
  res.status(200).json(finalBody);
}
