/**
 * Errors in the shape Anthropic's Messages API uses, before and during a stream.
 *
 * Anthropic answers a request it rejects up front with the HTTP status and
 *
 *   {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: …"}}
 *
 * and a failure after streaming began as ONE `event: error` with that same body,
 * after which the stream ends — no `message_delta`, no `message_stop`. `error.type`
 * is a string from a fixed table keyed by status (docs.anthropic.com, "Errors").
 * Clients branch on it and on the message: Claude Code auto-compacts on
 * "prompt is too long", retries `overloaded_error`, and reads a 200 stream that
 * ends normally with no content as a broken stream.
 */
import { Response } from 'express';
import { StreamFailure, httpStatusOr } from './streamStart';

/** Anthropic's documented status → `error.type` table, with the nearest type for the rest. */
export function anthropicErrorType(status: number): string {
  switch (status) {
    case 400: return 'invalid_request_error';
    case 401: return 'authentication_error';
    case 402: return 'billing_error';
    case 403: return 'permission_error';
    case 404: return 'not_found_error';
    case 413: return 'request_too_large';
    case 429: return 'rate_limit_error';
    case 504: return 'timeout_error';
    // 529 is Anthropic's own "overloaded"; SAP signals the same condition with 503.
    case 503:
    case 529: return 'overloaded_error';
    default:
      return status >= 400 && status < 500 ? 'invalid_request_error' : 'api_error';
  }
}

/**
 * SAP prefixes a module's error with its status and module name — "400 - LLM Module:
 * prompt is too long: 600024 tokens > 200000 maximum". The prefix is dropped so the
 * message reads as Anthropic's does (a client matching "prompt is too long" at the
 * start of the message must find it there); the rest is kept verbatim. A message
 * that is nothing but the prefix is left as it is.
 */
export function anthropicErrorMessage(message: string): string {
  const stripped = message.replace(/^\d{3} - [A-Za-z][A-Za-z ]{0,40} Module: /, '');
  return stripped.trim() ? stripped : message;
}

export function anthropicErrorBody(failure: StreamFailure): { type: 'error'; error: { type: string; message: string } } {
  return {
    type: 'error',
    error: { type: anthropicErrorType(httpStatusOr(failure.status)), message: anthropicErrorMessage(failure.message) },
  };
}

/**
 * Answer a request that failed before its stream started: the real status and the
 * JSON body. Content-Type is set explicitly because a route may already have set
 * `text/event-stream` (unsent) — `res.json` keeps an existing Content-Type.
 */
export function sendAnthropicHttpError(res: Response, failure: StreamFailure): void {
  res.status(httpStatusOr(failure.status));
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.json(anthropicErrorBody(failure));
}
