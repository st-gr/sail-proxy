/**
 * Deferred start of a streamed response, and what an upstream failure looks like
 * before and after that start.
 *
 * WHY THE START IS DEFERRED. A streamed reply commits its HTTP status with the
 * first byte. The streaming routes used to send `200 text/event-stream` (and the
 * protocol's preamble: Anthropic's `message_start`, OpenAI's role chunk) before
 * SAP had answered at all, so a request SAP rejected outright — measured
 * 2026-10-13: HTTP 200 from SAP, a templating chunk with an empty delta at
 * +3.2 s, then `{error:{code:400, message:"400 - LLM Module: prompt is too long:
 * 600024 tokens > 200000 maximum"}}` at +4.2 s — could only reach the client as
 * an in-stream event under a 200. The real APIs answer such a request with its
 * HTTP status and a JSON error body, and clients act on that: Claude Code
 * auto-compacts on a 400 "prompt is too long", but treats a 200 stream that
 * carries no content as a broken stream and retries without streaming.
 *
 * So a route holds its status line until the upstream delivers something worth
 * streaming, and answers a failure that arrives first with the real status.
 *
 * WHY THERE IS A DEADLINE. Holding the status line means holding every byte, and
 * the proxies in front of the gateway close a connection that is idle too long.
 * The tightest one in the shipped topologies is nginx's default 60 s
 * `proxy_read_timeout` on the Kyma configmap-mode `gw.conf` (no explicit value
 * on its `location /`); the Docker/Kyma nginx template uses
 * REQUEST_TIMEOUT_SECONDS (900 s default), the Istio DestinationRule's
 * connection-pool `idleTimeout` is 300 s, and the streaming VirtualService /
 * EnvoyFilter disable route and stream idle timeouts (86400 s / 0 s). A slow
 * first token (a long prompt, a thinking model) must therefore start the stream
 * well inside 60 s. 10 s does: it is 2.4x the measured time SAP took to reject a
 * 600k-token prompt (4.2 s, upload included), so rejections of very large
 * prompts still come back as real HTTP errors, and it leaves 50 s of margin to
 * the tightest proxy. After the start, keepalives follow every 5 s — the cadence
 * the Anthropic route always used for its `ping` events.
 */

import { truncateUpstreamMessage } from './upstreamErrorEnvelope';

/** How long a route may hold its status line waiting for the first upstream content. */
export const STREAM_START_DEADLINE_MS = 10_000;

/** Keepalive cadence once the stream has started (the Anthropic route's ping interval). */
export const STREAM_KEEPALIVE_INTERVAL_MS = 5_000;

export interface DeferredStreamStart {
  /** True once the status line and the protocol preamble have been written. */
  readonly started: boolean;
  /** Start now (idempotent): first upstream content, or the deadline. */
  start(): void;
  /** Cancel the deadline and the keepalives. Safe to call repeatedly. */
  stop(): void;
}

export interface DeferredStreamStartOptions {
  /** Write the status line, headers and preamble. Called at most once. */
  onStart: () => void;
  /** Write one keepalive. When given, it runs every `intervalMs` after the start. */
  onKeepalive?: () => void;
  /** False once the response is finished or the client is gone: timers then stop. */
  isOpen: () => boolean;
  deadlineMs?: number;
  intervalMs?: number;
}

export function deferStreamStart(opts: DeferredStreamStartOptions): DeferredStreamStart {
  const deadlineMs = opts.deadlineMs ?? STREAM_START_DEADLINE_MS;
  const intervalMs = opts.intervalMs ?? STREAM_KEEPALIVE_INTERVAL_MS;
  let started = false;
  let stopped = false;
  let deadline: NodeJS.Timeout | null = null;
  let keepalive: NodeJS.Timeout | null = null;

  const stop = (): void => {
    stopped = true;
    if (deadline) clearTimeout(deadline);
    if (keepalive) clearInterval(keepalive);
    deadline = null;
    keepalive = null;
  };

  const start = (): void => {
    if (started || stopped) return;
    started = true;
    if (deadline) clearTimeout(deadline);
    deadline = null;
    opts.onStart();
    if (opts.onKeepalive) {
      keepalive = setInterval(() => {
        if (!opts.isOpen()) { stop(); return; }
        opts.onKeepalive!();
      }, intervalMs);
    }
  };

  deadline = setTimeout(() => {
    deadline = null;
    if (!opts.isOpen()) { stop(); return; }
    start();
    // The deadline fired because nothing arrived: say so at once rather than one
    // interval later, so the first bytes after the preamble are not delayed.
    if (opts.onKeepalive && opts.isOpen()) opts.onKeepalive();
  }, deadlineMs);

  return {
    get started() { return started; },
    start,
    stop,
  };
}

/** An upstream failure, reduced to what a client may be shown. */
export interface StreamFailure {
  status: number;
  message: string;
}

/** The error a sapAIService stream chunk carries, if it carries one. */
export function chunkError(chunk: any): any {
  return chunk?.error ?? chunk?.final_result?.error;
}

/**
 * `code` as an HTTP error status (400–599), or undefined. Every status that reaches
 * `res.status()` from an upstream goes through this: Node throws
 * ERR_HTTP_INVALID_STATUS_CODE on anything else, and inside a promise chain that is an
 * unhandled rejection and a client left hanging.
 */
export function httpStatusOf(code: unknown): number | undefined {
  const n = typeof code === 'number' ? code : (typeof code === 'string' && /^\d+$/.test(code) ? Number(code) : NaN);
  return Number.isInteger(n) && n >= 400 && n <= 599 ? n : undefined;
}

/** `code` as an HTTP error status, else `fallback` (itself checked), else 500. */
export function httpStatusOr(code: unknown, fallback: unknown = 500): number {
  return httpStatusOf(code) ?? httpStatusOf(fallback) ?? 500;
}

/**
 * A failure chunk from `sapAIService.streamChatCompletion`: SAP's own in-stream
 * error `{error:{code, message, location, request_id, intermediate_results}}`, or
 * the gateway's transport error `{error: true, message, status?}`. Only `code` and
 * `message` are read — `intermediate_results` carries the templated prompt and
 * must never reach a client (utils/upstreamErrorEnvelope.ts).
 */
export function failureFromChunk(chunk: any, fallbackStatus = 500): StreamFailure {
  const raw = chunkError(chunk);
  const inner = raw && typeof raw === 'object' ? raw : undefined;
  const status = httpStatusOf(inner?.code) ?? httpStatusOr(chunk?.status, fallbackStatus);
  const message = (typeof inner?.message === 'string' && inner.message)
    || (typeof raw === 'string' && raw)
    || (typeof chunk?.message === 'string' && chunk.message)
    || 'upstream stream failed';
  return { status, message: truncateUpstreamMessage(message) };
}

function messageOfBody(body: any): string | undefined {
  let parsed = body;
  if (typeof body === 'string') {
    try { parsed = JSON.parse(body); } catch { return undefined; }
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const inner = parsed.error && typeof parsed.error === 'object' ? parsed.error : parsed;
  if (typeof inner.message === 'string' && inner.message) return inner.message;
  if (typeof parsed.message === 'string' && parsed.message) return parsed.message;
  return undefined;
}

/**
 * A thrown upstream failure: sapAIService's CustomError (`status`, `details` — for a
 * stream, `details.body` is SAP's drained body as a string; for a blocking call,
 * `details` is SAP's parsed body) or a bare axios error. SAP's message is preferred
 * over the wrapper's "SAP AI Core streaming failed: Request failed with status code
 * 400", which names no cause.
 */
export function failureFromError(err: any, fallbackStatus = 500): StreamFailure {
  const status = httpStatusOf(err?.response?.status) ?? httpStatusOr(err?.status, fallbackStatus);
  const message = messageOfBody(err?.details?.body)
    ?? messageOfBody(err?.details)
    ?? messageOfBody(err?.response?.data)
    ?? (typeof err?.message === 'string' && err.message ? err.message : 'upstream request failed');
  // Same cap as normalizeUpstreamError: an upstream body can be an arbitrarily long page.
  return { status, message: truncateUpstreamMessage(message) };
}

/**
 * Whether a SAP orchestration stream chunk carries anything a client must see:
 * text, a tool call, reasoning, a finish reason or usage. SAP's first chunk — the
 * templating result with an empty `delta.content` — does not, so it must not
 * commit the status line ahead of a failure that follows it.
 */
export function isSubstantiveChunk(chunk: any): boolean {
  // sapAIService delivers the envelope wrapped in `final_result`; the bridges' translators
  // accept it bare too, so this does as well.
  const body = chunk?.final_result ?? chunk;
  if (!body || typeof body !== 'object') return false;
  if (body.usage) return true;
  const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
  if (!choice) return false;
  if (choice.finish_reason) return true;
  const delta = choice.delta;
  if (!delta || typeof delta !== 'object') return false;
  return Object.entries(delta).some(([key, value]) => {
    if (key === 'role') return false;
    if (value === null || value === undefined || value === '') return false;
    if (Array.isArray(value) && value.length === 0) return false;
    return true;
  });
}
