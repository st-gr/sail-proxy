/**
 * What the stored log may say about an upstream's refusal.
 *
 * The gateway's stored log - read by every administrator - carries THAT an upstream refused, its
 * status, its machine-readable classification (`type`, `status` or `code` when that is a short
 * identifier such as `invalid_request_error` or `RESOURCE_EXHAUSTED`, never free text) and the
 * upstream's own short error message (the `message` of its error body or of an in-stream error
 * event), cut to UPSTREAM_MESSAGE_LIMIT characters: it can quote a few words of a request, as the
 * console does. Never the rest of an upstream body, never a JSON dump, never a stream chunk. The
 * client and the console get the whole message. `upstreamErrorText` is the one place that builds it.
 *
 * An Error whose message IS such text is marked with `logText` (not enumerable, so no response
 * body or JSON dump changes). The logger hands `logText` to its sinks; the log shipper stores it
 * in place of the error's message, also where the message was interpolated into the log line.
 */

/** The most of an upstream's own error message the stored log holds. */
export const UPSTREAM_MESSAGE_LIMIT = 300;

// A short identifier from a fixed vocabulary: no spaces, no sentence.
const CLASSIFICATION = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

/** The upstream's classification of a refusal, from its error body, when it gives one. */
export function upstreamErrorKind(body: any): string | undefined {
  let parsed = body;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return undefined; }
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const inner = parsed.error && typeof parsed.error === 'object' ? parsed.error : parsed;
  const candidates = [inner.type, inner.status, inner.code, parsed.__type, typeof parsed.error === 'string' ? parsed.error : undefined];
  return candidates.find((v): v is string => typeof v === 'string' && CLASSIFICATION.test(v));
}

/** "status 400, INVALID_ARGUMENT" - the part of a log line that may name an upstream refusal. */
export function upstreamRefusal(status: number | undefined, kind?: string): string {
  return [status !== undefined ? `status ${status}` : undefined, kind].filter(Boolean).join(', ') || 'no status';
}

/** An upstream's message cut to UPSTREAM_MESSAGE_LIMIT characters, with an ellipsis when cut; undefined for no text. */
export function shortUpstreamMessage(message: unknown): string | undefined {
  if (typeof message !== 'string') return undefined;
  const text = message.trim();
  if (!text) return undefined;
  if (text.length <= UPSTREAM_MESSAGE_LIMIT) return text;
  let cut = text.slice(0, UPSTREAM_MESSAGE_LIMIT);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * "upstream error (status 400, INVALID_ARGUMENT): <message cut to 300>" - what a stored log line says
 * of an upstream refusal. `message` must be the upstream error's message field, not its body.
 */
export function upstreamErrorText(status: number | undefined, kind?: string, message?: unknown): string {
  const short = shortUpstreamMessage(message);
  return `upstream error (${upstreamRefusal(status, kind)})${short ? `: ${short}` : ''}`;
}

/**
 * Marks `error`, whose message is an upstream's own text, with what the stored log may say instead.
 * `message` is the upstream's message field when the error's message adds words of the gateway's own.
 */
export function markUpstreamText<T>(error: T, status: number | undefined, kind?: string, message?: string): T {
  if (error && typeof error === 'object') {
    Object.defineProperty(error, 'logText', {
      value: upstreamErrorText(status, kind, message ?? (error as any).message), enumerable: false, configurable: true, writable: true,
    });
  }
  return error;
}

/** An error's text for a log line: its message, or for an error carrying upstream text, the mark (with the message cut). */
export function loggableErrorText(error: any): string {
  if (error && typeof error.logText === 'string') return error.logText;
  return String(error?.message ?? error);
}

/** The metadata that keeps a marked error's upstream text on the console; undefined for any other error. */
export function upstreamTextMeta(error: any): { upstreamMessage: string } | undefined {
  return error && typeof error.logText === 'string' ? { upstreamMessage: String(error.message) } : undefined;
}

/**
 * An upstream body as metadata: plain values (string, number, plain object or array) as they are;
 * anything else - a stream that was not read, an HTTP client's error object, whose JSON form
 * carries the request headers - as a short placeholder. Metadata is printed as JSON.
 */
export function loggableBody(body: unknown): unknown {
  if (body === null || body === undefined || typeof body !== 'object') return body;
  if (Array.isArray(body)) return body;
  const proto = Object.getPrototypeOf(body);
  if (proto === Object.prototype || proto === null) return body;
  return `[${(body as any).constructor?.name || 'object'} not read]`;
}
