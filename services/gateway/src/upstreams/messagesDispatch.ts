/**
 * /anthropic/v1/messages served by a Connection (B2a).
 *
 * Like chatDispatch: the hook plugins run first and the outbound body is built from `req.body`
 * afterwards, so masking reaches the provider. Streams are native: every upstream event is written
 * with `res.write` as one whole `event: <type>\ndata: <json>\n\n` block (the masking plugin
 * intercepts those writes to unmask), with `message.model` set back to the id the client asked for.
 *
 * Anthropic counts `input_tokens` exclusive of cache read/creation, so usage is folded as reported.
 * How the provider's stream is decoded sits behind `AnthropicEventSource`, so a provider type that
 * does not speak Anthropic SSE can bring its own decoder.
 */
import { StringDecoder } from 'string_decoder';
import type { Request, Response } from 'express';
import { getDefaultLogger } from '@libs/logger';
import configService from '../services/configService';
import { executeBeforePlugins, executeAfterPlugins } from '../services/pluginExecutor';
import { refuseIfForcedWithoutPlugin } from '../plugins/pseudonymization/forcedRun';
import { requestDeclaresWebSearchTool } from '../plugins/webSearch/webSearchTool';
import * as payloadLogger from '../utils/payloadLogger';
import { emitUsageEvent } from '../utils/usageTracker';
import { foldExclusiveUsage } from '../utils/usageFolding';
import { parseFrame, splitBlocks } from '../utils/sseFraming';
import { EventStreamDecoder, EventStreamError } from '../utils/eventStreamDecoder';
import { recordInvokedTools, anthropicAdapter } from '../toolGovernance';
import { sendRefusal, type ExternalTarget } from './externalTarget';
import { callUpstream, sendUpstreamError } from './upstreamCall';
import type { UpstreamRequest } from './types';

const logger = getDefaultLogger();

/** Decodes a provider stream into Anthropic events; `flush` handles whatever the stream left unterminated. */
export type AnthropicEventSource = (stream: NodeJS.ReadableStream, onEvent: (event: any) => void) => { flush(): void };

/** Anthropic SSE: blocks of `event:`/`data:` lines separated by a blank line. */
export const sseEventSource: AnthropicEventSource = (stream, onEvent) => {
  let pending = '';
  const decoder = new StringDecoder('utf8');
  const emit = (block: string) => {
    const frame = parseFrame(block);
    if (frame && typeof frame === 'object') onEvent(frame);
  };
  stream.on('data', (chunk: Buffer) => {
    const { blocks, tail } = splitBlocks(pending + decoder.write(chunk));
    pending = tail;
    for (const block of blocks) emit(block);
  });
  return {
    flush() {
      pending += decoder.end();
      if (pending.trim()) emit(`${pending}\n\n`);
      pending = '';
    },
  };
};

const BROKEN_STREAM_EVENT = { type: 'error', error: { type: 'api_error', message: 'The connection upstream stream ended unexpectedly' } };
const OVERLOADED_EXCEPTIONS = new Set(['throttlingException', 'serviceUnavailableException']);

/**
 * Bedrock's binary event stream: `chunk` messages carry `{"bytes": <base64 Anthropic event>}`. An
 * exception or error message becomes a terminal `error` event naming the exception type only (its payload can
 * echo request data); a corrupt stream becomes the broken-stream error and the upstream is dropped.
 */
export const eventStreamEventSource: AnthropicEventSource = (stream, onEvent) => {
  const decoder = new EventStreamDecoder();
  let dead = false;
  const fail = (event: unknown) => {
    dead = true;
    onEvent(event);
    (stream as any).destroy?.();
  };
  stream.on('data', (chunk: Buffer) => {
    if (dead) return;
    let messages;
    try {
      messages = decoder.push(chunk);
    } catch (error) {
      if (!(error instanceof EventStreamError)) throw error;
      fail(BROKEN_STREAM_EVENT);
      return;
    }
    for (const { headers, payload } of messages) {
      const messageType = headers[':message-type'];
      if (messageType === 'exception' || messageType === 'error') {
        const type = (messageType === 'exception' ? headers[':exception-type'] : headers[':error-code']) || 'unknown';
        fail({ type: 'error', error: { type: OVERLOADED_EXCEPTIONS.has(type) ? 'overloaded_error' : 'api_error', message: type } });
        return;
      }
      if (headers[':event-type'] !== 'chunk') continue;
      try {
        const event = JSON.parse(Buffer.from(JSON.parse(payload.toString('utf8')).bytes, 'base64').toString('utf8'));
        if (event && typeof event === 'object') onEvent(event);
      } catch {
        fail(BROKEN_STREAM_EVENT);
        return;
      }
    }
  });
  return {
    flush() {
      // A clean end inside a message is a truncated stream.
      if (!dead && decoder.pending > 0) fail(BROKEN_STREAM_EVENT);
    },
  };
};

const eventSourceFor = (target: ExternalTarget): AnthropicEventSource =>
  target.connection.providerType === 'bedrock' ? eventStreamEventSource : sseEventSource;

const eventBlock = (event: any): string => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

interface SeenUsage { input?: number; output?: number; cacheCreation?: number; cacheRead?: number }

/** Later usage objects (message_delta) override the fields they carry. */
function mergeUsage(seen: SeenUsage, usage: any): void {
  if (!usage) return;
  if (typeof usage.input_tokens === 'number') seen.input = usage.input_tokens;
  if (typeof usage.output_tokens === 'number') seen.output = usage.output_tokens;
  if (typeof usage.cache_creation_input_tokens === 'number') seen.cacheCreation = usage.cache_creation_input_tokens;
  if (typeof usage.cache_read_input_tokens === 'number') seen.cacheRead = usage.cache_read_input_tokens;
}

function foldSeenUsage(usageMetrics: any, seen: SeenUsage): void {
  foldExclusiveUsage(usageMetrics, seen.input || 0, seen.output || 0, seen.cacheCreation || 0, seen.cacheRead || 0);
}

export async function dispatchMessages(req: Request, res: Response, target: ExternalTarget, usageMetrics: any, clientModel: string): Promise<void> {
  // The provider's server-side web search is not the gateway's emulation, which runs on the SAP path.
  if (requestDeclaresWebSearchTool(req.body)) {
    sendRefusal(res, 'anthropic', 400, 'web_search_not_supported', 'web_search is not supported for models served by a connection.');
    return;
  }
  const stream = req.body?.stream === true;
  (req as any).__endpoint = 'anthropic';
  const subPath = stream ? 'invoke-with-response-stream' : 'invoke';
  // Usage, pricing and hooks are keyed by the served Connection model id (its `--<name>` suffix
  // names the connection); the client's own id (possibly substituted) is only what it sees back.
  const servedModel = target.model.modelId;
  const hookConfig = configService.getHookConfig(servedModel, subPath, 'anthropic');
  // Connection traffic leaves the SAP tenant: forced masking must not be skipped here either.
  if (refuseIfForcedWithoutPlugin(req, res, hookConfig, {
    endpoint: 'anthropic', subPaths: [subPath], servedModel, component: 'messagesDispatch',
  })) return;
  if (hookConfig) {
    const pluginResult = await executeBeforePlugins(req, res, hookConfig);
    if (pluginResult.stop) return;
  }

  let upstreamRequest: UpstreamRequest;
  try {
    upstreamRequest = await target.adapter.buildRequest('messages', req.body, target.model.upstreamModel, req.headers);
  } catch (error) {
    emitUsageEvent(req, usageMetrics, servedModel, await sendUpstreamError(req, res, error, target.adapter, 'anthropic'));
    return;
  }
  const debugRequestId = (req as any).debugRequestId;
  if (debugRequestId) {
    payloadLogger.savePayload(debugRequestId, '02_connection_messages_request', { url: upstreamRequest.url, body: upstreamRequest.body }, req);
  }

  if (stream) {
    await streamMessages(req, res, target, upstreamRequest, usageMetrics, clientModel, servedModel);
    return;
  }

  try {
    const upstream = await callUpstream(upstreamRequest, { stream: false });
    let body = upstream.data;
    if (body && typeof body === 'object') body = { ...body, model: clientModel };
    recordInvokedTools(req, anthropicAdapter.invokedTools(body));
    if (hookConfig) body = await executeAfterPlugins(req, res, body, hookConfig);
    const seen: SeenUsage = {};
    mergeUsage(seen, upstream.data?.usage);
    foldSeenUsage(usageMetrics, seen);
    emitUsageEvent(req, usageMetrics, servedModel, upstream.status);
    res.status(upstream.status).json(body);
  } catch (error) {
    emitUsageEvent(req, usageMetrics, servedModel, await sendUpstreamError(req, res, error, target.adapter, 'anthropic'));
  }
}

async function streamMessages(req: Request, res: Response, target: ExternalTarget, upstreamRequest: UpstreamRequest,
  usageMetrics: any, clientModel: string, servedModel: string): Promise<void> {
  const abort = new AbortController();
  let finished = false;
  let emitted = false;
  let sawError = false;
  const seen: SeenUsage = {};
  const emitOnce = (status: number) => {
    if (emitted) return;
    emitted = true;
    foldSeenUsage(usageMetrics, seen);
    emitUsageEvent(req, usageMetrics, servedModel, status);
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
    const status = await sendUpstreamError(req, res, error, target.adapter, 'anthropic');
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

  const onEvent = (event: any) => {
    if (finished || typeof event.type !== 'string') return;
    if (event.type === 'error') sawError = true;
    if (event.type === 'message_start' && event.message && typeof event.message === 'object') {
      mergeUsage(seen, event.message.usage);
      event.message.model = clientModel;
    } else if (event.type === 'message_delta') {
      mergeUsage(seen, event.usage);
    } else if (event.type === 'message_stop' && event['amazon-bedrock-invocationMetrics'] !== undefined) {
      // Bedrock's own tally: never shown to the client, used only when the events carried no usage.
      const metrics = event['amazon-bedrock-invocationMetrics'];
      delete event['amazon-bedrock-invocationMetrics'];
      if (seen.input === undefined && seen.output === undefined && metrics && typeof metrics === 'object') {
        mergeUsage(seen, {
          input_tokens: metrics.inputTokenCount, output_tokens: metrics.outputTokenCount,
          cache_read_input_tokens: metrics.cacheReadInputTokenCount, cache_creation_input_tokens: metrics.cacheWriteInputTokenCount,
        });
      }
    }
    recordInvokedTools(req, anthropicAdapter.invokedToolsFromChunk(event));
    res.write(eventBlock(event));
  };
  const source = eventSourceFor(target)(upstream.data, onEvent);
  const finish = (status: number) => {
    if (finished) return;
    finished = true;
    emitOnce(status);
    res.end();
  };

  await new Promise<void>((resolve) => {
    let ended = false;
    upstream.data.on('end', () => {
      ended = true;
      source.flush();
      finish(sawError ? 502 : 200);
      resolve();
    });
    const failed = () => {
      if (ended || finished) { resolve(); return; }
      logger.warn('messagesDispatch', `Connection stream for ${clientModel} broke off`);
      source.flush();
      if (!sawError) res.write(eventBlock(BROKEN_STREAM_EVENT));
      finish(502);
      resolve();
    };
    upstream.data.on('error', failed);
    upstream.data.on('close', failed);
  });
}
