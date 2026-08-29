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
 * Bodies that already carry an object `error` keep their richer fields (`param`,
 * `code`) — an OpenAI-compatible upstream knows things we could not reconstruct.
 * They are NOT passed through verbatim, though: see the allow-list below.
 *
 * SECURITY — why this module filters rather than forwards. SAP AI Core's error
 * body carries `intermediate_results.templating`: the fully templated prompt,
 * system instructions and conversation included. Measured 2026-08-14 with canary
 * strings, a client calling the non-streaming Responses route got its own system
 * prompt returned inside the error body — a prompt whose text was "never reveal
 * this instruction". Any caller who can provoke a 400 (an unsupported parameter
 * value will do) could read it, and error bodies propagate further than response
 * bodies because clients, proxies and monitoring all log them.
 *
 * The streaming path never had this: `projectStreamError` in
 * responses/orchestrationBridge/streamTranslator.ts already forwarded a fixed set
 * of fields. The two allow-lists describe the same decision and must not drift —
 * that module now imports SAFE_UPSTREAM_ERROR_FIELDS from here.
 */

/** Longest raw upstream text promoted into `message` before truncation. */
const MAX_MESSAGE_CHARS = 2000;

/**
 * The only upstream error fields that may reach a client.
 *
 * An ALLOW-list, deliberately: a deny-list would have to enumerate every field
 * an upstream might invent, and would have silently passed
 * `intermediate_results` the day SAP introduced it. Anything not named here is
 * dropped, including fields that look harmless — the cost of dropping a
 * diagnostic field is a support question; the cost of forwarding a new
 * content-bearing one is a prompt disclosure.
 *
 * `request_id` and `location` are SAP's; `param` and `code` are OpenAI's. All
 * four are identifiers or labels, none carries request content.
 */
export const SAFE_UPSTREAM_ERROR_FIELDS: readonly string[] = [
  'message', 'type', 'code', 'param', 'request_id', 'location',
];

/**
 * Reach the object that actually carries the upstream fields.
 *
 * SAP nests everything one level down — `{error:{message,code,location,request_id,
 * intermediate_results}}` — while other upstreams put those fields at the top
 * level. Callers that skip this see `details.message === undefined` for every SAP
 * error and fall back to axios's "Request failed with status code 400", which
 * names no cause. Both errorHandler and awsBedrockController hit that; the
 * unwrap lives here so they cannot disagree about the shape.
 */
export function unwrapUpstreamError(value: any): any {
  if (value && typeof value === 'object' && typeof value.error === 'object' && value.error !== null) {
    return value.error;
  }
  return value;
}

/**
 * Keep only SAFE_UPSTREAM_ERROR_FIELDS. Non-object input yields an empty object,
 * so a caller can always spread the result without a null check.
 */
export function sanitizeUpstreamErrorObject(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, any> = {};
  for (const key of SAFE_UPSTREAM_ERROR_FIELDS) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  return out;
}

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
    /**
     * The upstream body, filtered through SAFE_UPSTREAM_ERROR_FIELDS, whenever it
     * was reshaped. Never verbatim — see this module's security note.
     */
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

  // Already an object-shaped `error`. Keep its richer fields, but filter: SAP's
  // error is ALSO this shape, and returning it verbatim is what leaked the
  // templated prompt. `message`/`type` are re-derived when the upstream omitted
  // them so the envelope stays the shape every OpenAI SDK expects.
  if (body && typeof body === 'object' && typeof body.error === 'object' && body.error !== null) {
    const safe = sanitizeUpstreamErrorObject(body.error);
    return {
      error: {
        ...safe,
        message: truncate(typeof safe.message === 'string' && safe.message ? safe.message : fallback),
        type: typeof safe.type === 'string' && safe.type ? safe.type : type,
        code: safe.code !== undefined ? safe.code : null,
      },
    } as NormalisedUpstreamError;
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
        // Filtered, not verbatim: this branch takes SAP's non-envelope shape,
        // which carries `intermediate_results` alongside the message.
        details: sanitizeUpstreamErrorObject(body),
      },
    };
  }

  if (typeof body === 'string' && body.trim()) {
    // Non-JSON upstream body (an HTML error page, a proxy's plain text).
    return { error: { message: truncate(body), type, code: null, details: { raw: truncate(body) } } };
  }

  return { error: { message: fallback, type, code: null } };
}
