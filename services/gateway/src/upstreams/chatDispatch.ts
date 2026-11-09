/**
 * /openai/v1/chat/completions served by a Connection (spec 2026-10-23 §5.1, §5.3).
 *
 * The hook plugins run first, with the same hook keys as the SAP path, and the outbound body is
 * built from `req.body` afterwards: whatever the plugins changed (masking) is what the provider
 * sees. Streams are native: each upstream frame is written with `res.write`, which the masking
 * plugin intercepts to unmask, with its `model` set back to the id the client asked for.
 *
 * The provider is always asked for usage on a stream (`stream_options.include_usage`), because the
 * gateway bills from it. The usage-only chunk (`choices: []`) reaches the client only when the
 * client asked for it itself; some SDKs break on a chunk without choices.
 */
import { StringDecoder } from 'string_decoder';
import type { Request, Response } from 'express';
import { getDefaultLogger } from '@libs/logger';
import configService from '../services/configService';
import { executeBeforePlugins, executeAfterPlugins } from '../services/pluginExecutor';
import { refuseIfForcedWithoutPlugin } from '../pluginSupport/pseudonymization/forcedRun';
import * as payloadLogger from '../utils/payloadLogger';
import { emitUsageEvent } from '../utils/usageTracker';
import { foldInclusiveUsage } from '../utils/usageFolding';
import { parseFrame, splitBlocks, sseBlock } from '../utils/sseFraming';
import { recordInvokedTools, openaiChatAdapter } from '../toolGovernance';
import type { ExternalTarget } from './externalTarget';
import { callUpstream, sendUpstreamError } from './upstreamCall';
import type { UpstreamRequest } from './types';

const logger = getDefaultLogger();
const DONE_BLOCK = 'data: [DONE]\n\n';

/** OpenAI and Azure count cached tokens inside prompt_tokens. */
function foldChatUsage(usageMetrics: any, usage: any): void {
  if (!usage) return;
  foldInclusiveUsage(usageMetrics, usage.prompt_tokens || 0, usage.completion_tokens || 0, 0, usage.prompt_tokens_details?.cached_tokens || 0);
}

export async function dispatchChat(req: Request, res: Response, target: ExternalTarget, usageMetrics: any, clientModel: string): Promise<void> {
  const stream = req.body?.stream === true;
  (req as any).__endpoint = 'openai';
  const subPath = stream ? 'invoke-with-response-stream' : 'invoke';
  const hookConfig = configService.getHookConfig(req.body.model, subPath, 'openai');
  // Connection traffic leaves the SAP tenant: forced masking must not be skipped here either.
  if (refuseIfForcedWithoutPlugin(req, res, hookConfig, {
    endpoint: 'openai', subPaths: [subPath], servedModel: clientModel, component: 'chatDispatch',
  })) return;
  if (hookConfig) {
    const pluginResult = await executeBeforePlugins(req, res, hookConfig);
    if (pluginResult.stop) return;
  }

  const outbound = stream
    ? { ...req.body, stream_options: { ...(req.body.stream_options || {}), include_usage: true } }
    : req.body;
  let upstreamRequest: UpstreamRequest;
  try {
    upstreamRequest = await target.adapter.buildRequest('chat', outbound, target.model.upstreamModel);
  } catch (error) {
    emitUsageEvent(req, usageMetrics, clientModel, await sendUpstreamError(req, res, error, target.adapter, 'openai'));
    return;
  }
  const debugRequestId = (req as any).debugRequestId;
  if (debugRequestId) {
    payloadLogger.savePayload(debugRequestId, '02_connection_chat_request', { url: upstreamRequest.url, body: upstreamRequest.body }, req);
  }

  if (stream) {
    await streamChat(req, res, target, upstreamRequest, usageMetrics, clientModel);
    return;
  }

  try {
    const upstream = await callUpstream(upstreamRequest, { stream: false });
    let body = upstream.data;
    if (body && typeof body === 'object') body = { ...body, model: clientModel };
    recordInvokedTools(req, openaiChatAdapter.invokedTools(body));
    if (hookConfig) body = await executeAfterPlugins(req, res, body, hookConfig);
    foldChatUsage(usageMetrics, upstream.data?.usage);
    emitUsageEvent(req, usageMetrics, clientModel, upstream.status);
    res.status(upstream.status).json(body);
  } catch (error) {
    emitUsageEvent(req, usageMetrics, clientModel, await sendUpstreamError(req, res, error, target.adapter, 'openai'));
  }
}

async function streamChat(req: Request, res: Response, target: ExternalTarget, upstreamRequest: UpstreamRequest,
  usageMetrics: any, clientModel: string): Promise<void> {
  const clientWantsUsage = req.body?.stream_options?.include_usage === true;
  const abort = new AbortController();
  let finished = false;
  let emitted = false;
  let usage: any;
  const emitOnce = (status: number) => {
    if (emitted) return;
    emitted = true;
    foldChatUsage(usageMetrics, usage);
    emitUsageEvent(req, usageMetrics, clientModel, status);
  };
  // The client went away: stop the provider generating (and billing) for nobody.
  res.on('close', () => {
    if (finished) return;
    finished = true;
    abort.abort();
    emitOnce(499);
  });

  let upstream;
  try {
    upstream = await callUpstream(upstreamRequest, { stream: true, signal: abort.signal });
  } catch (error) {
    if (abort.signal.aborted) return;
    const status = await sendUpstreamError(req, res, error, target.adapter, 'openai');
    finished = true;
    emitOnce(status);
    return;
  }
  if (finished) { upstream.data.destroy?.(); return; }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let pending = '';
  const decoder = new StringDecoder('utf8');
  let sawDone = false;
  const writeBlock = (block: string) => {
    const frame = parseFrame(block);
    if (frame === null) {
      if (block.includes('data: [DONE]')) sawDone = true;
      res.write(block);
      return;
    }
    if (frame.usage) usage = frame.usage;
    if (frame.usage && Array.isArray(frame.choices) && frame.choices.length === 0 && !clientWantsUsage) return;
    // Asked for usage, OpenAI puts `usage: null` on every other chunk too; not the client's ask.
    if (frame.usage === null && !clientWantsUsage) delete frame.usage;
    if (frame.model !== undefined) frame.model = clientModel;
    recordInvokedTools(req, openaiChatAdapter.invokedToolsFromChunk(frame));
    res.write(sseBlock(frame));
  };
  const finish = (status: number) => {
    if (finished) return;
    finished = true;
    pending += decoder.end();
    if (pending.trim()) writeBlock(`${pending}\n\n`);
    pending = '';
    emitOnce(status);
    res.end();
  };

  await new Promise<void>((resolve) => {
    let ended = false;
    upstream.data.on('data', (chunk: Buffer) => {
      if (finished) return;
      const { blocks, tail } = splitBlocks(pending + decoder.write(chunk));
      pending = tail;
      for (const block of blocks) writeBlock(block);
    });
    upstream.data.on('end', () => {
      ended = true;
      finish(200);
      resolve();
    });
    const failed = () => {
      if (ended || finished) { resolve(); return; }
      logger.warn('chatDispatch', `Connection stream for ${clientModel} broke off`);
      if (!sawDone) {
        res.write(sseBlock({ error: { message: 'The connection upstream stream ended unexpectedly', type: 'api_error', code: 'upstream_stream_error' } }));
        res.write(DONE_BLOCK);
      }
      finish(502);
      resolve();
    };
    upstream.data.on('error', failed);
    upstream.data.on('close', failed);
  });
}
