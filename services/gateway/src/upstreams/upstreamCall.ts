/**
 * Calling a connection's upstream and reporting its failures (spec 2026-10-23 §5.4).
 *
 * One retry, only for a connection reset before any response arrived: the provider has seen
 * nothing it could bill. Never once a response has started, and never for an HTTP status.
 *
 * Failures reach the client with the upstream's status and its error normalised to the route's
 * shape. Every credential value the adapter may have sent is replaced by [REDACTED] first, in the
 * client body, the log line and the payload log alike: OpenAI's 401 echoes the key it refused.
 */
import axios, { AxiosResponse } from 'axios';
import type { Request, Response } from 'express';
import { getDefaultLogger } from '@libs/logger';
import configService from '../services/configService';
import * as payloadLogger from '../utils/payloadLogger';
import { readUpstreamErrorBody } from '../utils/upstreamErrorBody';
import { normalizeUpstreamError } from '../utils/upstreamErrorEnvelope';
import type { ProviderAdapter, UpstreamRequest } from './types';
import type { ErrorShape } from './externalTarget';

const logger = getDefaultLogger();
const RETRY_DELAY_MS = 250;

const isResetBeforeResponse = (error: any): boolean => !error?.response && error?.code === 'ECONNRESET';

export async function callUpstream(request: UpstreamRequest, opts: { stream: boolean; signal?: AbortSignal }): Promise<AxiosResponse> {
  const send = () => axios.post(request.url, request.body, {
    headers: request.headers,
    responseType: opts.stream ? 'stream' : 'json',
    timeout: configService.getTimeout(opts.stream),
    signal: opts.signal,
    validateStatus: (status) => status < 400,
  });
  try {
    return await send();
  } catch (error) {
    if (!isResetBeforeResponse(error) || opts.signal?.aborted) throw error;
    logger.warn('upstreamCall', 'Connection reset before any response; retrying once');
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return send();
  }
}

export function redact(text: string, secrets: string[]): string {
  return [...secrets].filter((s) => typeof s === 'string' && s.length > 0)
    .sort((a, b) => b.length - a.length)
    .reduce((out, secret) => out.split(secret).join('[REDACTED]'), text);
}

/** A body of any kind with every secret redacted, kept as an object when it was one. */
function redactBody(body: any, secrets: string[]): any {
  if (body === undefined || body === null) return body;
  const text = redact(typeof body === 'string' ? body : JSON.stringify(body), secrets);
  if (typeof body === 'string') return text;
  try { return JSON.parse(text); } catch { return text; }
}

/** Sends the failure in the route's shape and returns the status sent. */
export async function sendUpstreamError(req: Request, res: Response, error: any, adapter: ProviderAdapter, shape: ErrorShape): Promise<number> {
  const secrets = adapter.secrets();
  const timedOut = !error?.response && (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT');
  const status: number = error?.response?.status ?? (timedOut ? 504 : 502);
  const body = error?.response ? redactBody(await readUpstreamErrorBody(error.response), secrets) : undefined;
  const fallback = redact(String(error?.message ?? 'upstream request failed'), secrets);
  logger.warn('upstreamCall', `Connection upstream failed with ${status}: ${fallback}`);
  const debugRequestId = (req as any).debugRequestId;
  if (debugRequestId) payloadLogger.savePayload(debugRequestId, '97_connection_upstream_error', { status, data: body }, req, res);

  const envelope = normalizeUpstreamError(body, status, fallback);
  if (res.headersSent) return status;
  if (shape === 'anthropic') {
    res.status(status).json({ type: 'error', error: { type: envelope.error.type, message: envelope.error.message } });
  } else if (shape === 'gemini') {
    res.status(status).json({ error: { code: status, message: envelope.error.message, status: 'UNKNOWN' } });
  } else {
    res.status(status).json(envelope);
  }
  return status;
}
