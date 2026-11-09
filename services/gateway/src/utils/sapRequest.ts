/**
 * A per-attempt timeout for SAP AI Core calls, and one retry for the calls that are safe to repeat.
 *
 * Why: from some network paths SAP accepted the connection, finished TLS and then sent nothing for
 * a minute (seen 2026-10-07 on ~46% of list calls from GitHub runners; the same calls answer in
 * 0.2-0.6 s otherwise). A list call without a timeout waited until the socket died. Every attempt
 * here is bounded by a wall-clock timer that aborts the request, whatever the HTTP client's own
 * timeout does once headers have arrived.
 *
 * What retries: only callers that pass `retry: true` - the deployment and model lists, the OAuth
 * token and embeddings (no side effects; an embedding is deterministic). Chat, the context writer,
 * vision and rerank never come through with `retry: true`. Only transport failures and gateway
 * answers retry (connection reset, timeout, 502/503/504), once, after 250-1000 ms of jitter, and
 * only when the time left before the caller's deadline still holds a full attempt. A failure after
 * the response arrived (`markResponseArrived`) never retries: SAP has answered, and for a billed
 * call has billed, that request.
 */
import { getDefaultLogger } from '@libs/logger';

const logger = getDefaultLogger();

/**
 * Per-attempt limits. Lists, token and a query embedding: 10 s, more than 15x their normal
 * latency, so a stall costs at most 10 s + jitter + 10 s instead of a minute or forever. A document
 * batch (up to 256 inputs / 250k estimated tokens) keeps the 30 s it always had.
 */
const DEFAULT_TIMING = {
  listAttemptMs: 10_000,
  tokenAttemptMs: 10_000,
  queryEmbeddingAttemptMs: 10_000,
  documentEmbeddingAttemptMs: 30_000,
  retryJitterMinMs: 250,
  retryJitterMaxMs: 1_000,
};

export type SapTiming = typeof DEFAULT_TIMING;

let timing: SapTiming = { ...DEFAULT_TIMING };

export function sapTiming(): Readonly<SapTiming> {
  return timing;
}

export function __setSapTimingForTests(overrides: Partial<SapTiming>): void {
  timing = { ...DEFAULT_TIMING, ...overrides };
}

export function __resetSapTimingForTests(): void {
  timing = { ...DEFAULT_TIMING };
}

/** What one attempt gets: its time limit (also for the HTTP client's own `timeout`) and a signal
 *  that aborts when the limit is reached. */
export interface SapAttempt {
  timeoutMs: number;
  signal: AbortSignal;
}

export interface SapRequestOptions {
  /** Names the call in logs, e.g. 'deployment list'. Never request or response content. */
  kind: string;
  attemptTimeoutMs: number;
  /** True only for calls that are safe to send twice. */
  retry: boolean;
  /** Absolute time (Date.now() scale) no attempt may run past. */
  deadline?: number;
}

const RESPONSE_ARRIVED = Symbol('sapResponseArrived');

/** Marks a failure that happened after SAP's response arrived, so it is never retried. */
export function markResponseArrived<E>(error: E): E {
  if (error && typeof error === 'object') {
    Object.defineProperty(error, RESPONSE_ARRIVED, { value: true });
  }
  return error;
}

const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED']);
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

export function isRetryableSapError(error: any): boolean {
  if (!error || error[RESPONSE_ARRIVED]) return false;
  const status = error.response?.status;
  if (typeof status === 'number') return RETRYABLE_STATUSES.has(status);
  return RETRYABLE_CODES.has(error.code);
}

function retryReason(error: any): string {
  const status = error?.response?.status;
  if (typeof status === 'number') return `HTTP ${status}`;
  if (error?.code === 'ETIMEDOUT' || error?.code === 'ECONNABORTED') return 'a timeout';
  return String(error?.code);
}

/** A retried error answer's body is never read; free its socket. */
function discardResponseBody(error: any): void {
  const data = error?.response?.data;
  if (data && typeof data.destroy === 'function') {
    data.on?.('error', () => undefined);
    data.destroy();
  }
}

function timeLeft(options: SapRequestOptions): number {
  return options.deadline === undefined ? Infinity : options.deadline - Date.now();
}

async function runAttempt<T>(
  options: SapRequestOptions, attempt: (a: SapAttempt) => Promise<T>,
): Promise<T> {
  const timeoutMs = Math.max(1, Math.min(options.attemptTimeoutMs, timeLeft(options)));
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await attempt({ timeoutMs, signal: controller.signal });
  } catch (error: any) {
    if (timedOut && !error?.[RESPONSE_ARRIVED]) {
      throw Object.assign(new Error(`${options.kind} timed out after ${timeoutMs} ms`), {
        code: 'ETIMEDOUT', cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Runs `attempt` under a time limit and, when `options.retry` allows it, once more. */
export async function sapRequest<T>(
  options: SapRequestOptions, attempt: (a: SapAttempt) => Promise<T>,
): Promise<T> {
  try {
    return await runAttempt(options, attempt);
  } catch (error: any) {
    if (!options.retry || !isRetryableSapError(error)) throw error;
    const { retryJitterMinMs, retryJitterMaxMs } = timing;
    const jitterMs = retryJitterMinMs + Math.random() * (retryJitterMaxMs - retryJitterMinMs);
    if (timeLeft(options) - jitterMs < options.attemptTimeoutMs) {
      logger.warn('SapRequest', `${options.kind}: not retrying after ${retryReason(error)}: `
        + 'the time left cannot hold another attempt');
      throw error;
    }
    logger.warn('SapRequest', `${options.kind}: retrying once after ${retryReason(error)}`);
    discardResponseBody(error);
    await new Promise((resolve) => { setTimeout(resolve, jitterMs); });
    return runAttempt(options, attempt);
  }
}
