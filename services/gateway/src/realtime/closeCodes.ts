/**
 * WebSocket close codes the realtime relay sends itself, and the mapping applied when a close
 * received on one side is propagated to the other (RFC 6455 §7.4).
 */
export const CLOSE_NORMAL = 1000;
export const CLOSE_GOING_AWAY = 1001;       // server_shutdown
export const CLOSE_POLICY_VIOLATION = 1008; // quota_exceeded, unauthorized
export const CLOSE_INTERNAL_ERROR = 1011;   // upstream_error

export const REASON_QUOTA_EXCEEDED = 'quota_exceeded';
export const REASON_UNAUTHORIZED = 'unauthorized';
export const REASON_UPSTREAM_ERROR = 'upstream_error';
export const REASON_SERVER_SHUTDOWN = 'server_shutdown';

const REASON_MAX_BYTES = 123;

/** The codes an endpoint may put on the wire: 1000-1014 except 1004-1006, and the 3000-4999 ranges. */
export function isSendableCloseCode(code: number): boolean {
  if (code === CLOSE_NORMAL || (code >= 3000 && code <= 4999)) return true;
  return code >= 1001 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006;
}

/**
 * 1005 (no status received) and 1006 (abnormal closure) are reported locally but must never be
 * sent — `ws` throws on them — so they become 1000 and 1011; every other unsendable code becomes
 * 1011 too. The reason is cut to the protocol's 123-byte limit on a character boundary.
 */
export function propagatedClose(code: number, reason: string | Buffer): { code: number; reason: string } {
  let text = Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason ?? '');
  while (Buffer.byteLength(text) > REASON_MAX_BYTES) text = text.slice(0, -1);
  if (code === 1005) return { code: CLOSE_NORMAL, reason: text };
  if (code === 1006) return { code: CLOSE_INTERNAL_ERROR, reason: text || REASON_UPSTREAM_ERROR };
  return { code: isSendableCloseCode(code) ? code : CLOSE_INTERNAL_ERROR, reason: text };
}
