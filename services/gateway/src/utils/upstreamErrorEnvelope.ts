/**
 * Normalise an upstream error body into the OpenAI error envelope.
 *
 * OpenAI — and every SDK written against it — reads `error.message`, where
 * `error` is an OBJECT:
 *
 *   { "error": { "message": "...", "type": "invalid_request_error", "code": null } }
 *
 * SAP AI Core does not use that shape. Captured verbatim from a deployment
 * rejecting a tool it does not allow (2026-08-06):
 *
 *   { "error": "BadRequest", "message": "The following tools are not allowed …" }
 *
 * `error` is a STRING there, so `error.message` is `undefined` and a client sees
 * nothing useful — codex-cli printed the raw JSON instead of the reason. The
 * chat-completions path already normalises via `middlewares/errorHandler.ts`;
 * the Responses path returned the upstream body verbatim, which is what this
 * closes.
 *
 * Bodies that already carry an object `error` are passed through untouched: an
 * OpenAI-compatible upstream has richer information (`param`, `code`) than we
 * could reconstruct, and rewriting it would lose that.
 */

/** Longest raw upstream text promoted into `message` before truncation. */
const MAX_MESSAGE_CHARS = 2000;

/**
 * OpenAI's `type` is a coarse class, not a per-error label — it is derived from
 * the status, so the same mapping reproduces it without inventing values.
 */
export function errorTypeForStatus(status: number): string {
  if (status === 401 || status === 403) return 'authentication_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 400 && status < 500) return 'invalid_request_error';
  return 'api_error';
}

function truncate(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
}

export interface NormalisedUpstreamError {
  error: {
    message: string;
    type: string;
    code: string | number | null;
    /** The upstream body, verbatim, whenever it was reshaped. Never set on passthrough. */
    details?: any;
  };
}

/**
 * @param body     drained upstream body (object, string, or undefined)
 * @param status   HTTP status being returned to the client
 * @param fallback message to use when the body carries none (typically the axios error)
 */
export function normalizeUpstreamError(body: any, status: number, fallback: string): NormalisedUpstreamError {
  const type = errorTypeForStatus(status);

  // Already the OpenAI envelope — hand it back exactly as received.
  if (body && typeof body === 'object' && typeof body.error === 'object' && body.error !== null) {
    return body as NormalisedUpstreamError;
  }

  if (body && typeof body === 'object') {
    // SAP AI Core: `error` is a label string and `message` carries the detail.
    // Either may be absent, so fall back through both before the axios message.
    const label = typeof body.error === 'string' && body.error ? body.error : null;
    const message = typeof body.message === 'string' && body.message
      ? body.message
      : (label || fallback);
    return {
      error: {
        message: truncate(message),
        type,
        // The upstream label verbatim — not snake_cased. Transforming an
        // unenumerated set of labels would be guesswork; passing it through
        // keeps it accurate and greppable against upstream logs.
        code: label,
        details: body,
      },
    };
  }

  if (typeof body === 'string' && body.trim()) {
    // Non-JSON upstream body (an HTML error page, a proxy's plain text).
    return { error: { message: truncate(body), type, code: null, details: { raw: truncate(body) } } };
  }

  return { error: { message: fallback, type, code: null } };
}
