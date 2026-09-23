/**
 * Bidirectional WebSocket relay between the client (accepted by the gateway) and the upstream
 * (SAP AI Core's realtime deployment). Frames pass through unchanged — text and binary, in order.
 * The upstream observer hook runs AFTER a frame has been forwarded, so metering never delays
 * audio; the client hook runs BEFORE forwarding and may replace, drop or follow the frame; an
 * error in it forwards the original.
 *
 * Close propagation (spec §3, §4): client close → upstream closed with 1000; upstream close →
 * client closed with the same code/reason (1005/1006 mapped by propagatedClose); an error on
 * either side ends the other with 1011 upstream_error (upstream error) or 1000 (client error).
 *
 * Backpressure: a peer that stops reading would otherwise let the gateway buffer a whole session's
 * audio in memory (a realtime session may run for an hour). Once a destination's send buffer passes
 * the high-water mark the source is paused — no frame is dropped or reordered, they stay in the
 * source's TCP receive buffer — and resumed again from the send callback once the destination's
 * buffer is back under the low-water mark.
 */
import WebSocket, { RawData } from 'ws';
import { CLOSE_INTERNAL_ERROR, CLOSE_NORMAL, REASON_UPSTREAM_ERROR, propagatedClose } from './closeCodes';

/** Buffered bytes on a destination above which its source stops being read. */
export const RELAY_HIGH_WATER_BYTES = 8 * 1024 * 1024;
/** Buffered bytes on a destination at or below which its source is read again. */
export const RELAY_LOW_WATER_BYTES = 1 * 1024 * 1024;

/** What the client hook decided: nothing (forward as is), a replacement, or a drop with a reply. */
export type ClientFrameVerdict =
  | void
  | { forward: RawData | string; thenUpstream?: string }
  | { drop: true; reply?: string };

export interface RelayHooks {
  /** Called after an upstream frame was forwarded to the client. */
  onUpstreamFrame?(data: RawData, isBinary: boolean): void;
  /** Called before a client frame is forwarded upstream; may transform it. Never awaited; a throw forwards the original. */
  onClientFrame?(data: RawData, isBinary: boolean): ClientFrameVerdict;
  onClosed?(side: 'client' | 'upstream', code: number, reason: string): void;
  /**
   * `side` is the side that stopped (`paused: true`) or resumed being read: `'client'` when the
   * client stops sending because the upstream is slow, `'upstream'` when the upstream stops being
   * read because the client is slow.
   */
  onBackpressure?(side: 'client' | 'upstream', paused: boolean): void;
}

export interface RelayHandle {
  /** Ends the session from the gateway's side: both sockets closed with the given code and reason. */
  close(code: number, reason: string): void;
  /** A gateway-originated text frame to the upstream, queued behind anything already forwarded. */
  sendUpstream(text: string): void;
  /** A gateway-originated text frame to the client. */
  sendClient(text: string): void;
}

function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    try { ws.close(code, reason); } catch { ws.terminate(); }
  }
}

/**
 * One direction of the relay, with its own `paused` flag. The high-water check runs after the
 * frame has been handed to `dest.send` (never before — the frame is always forwarded first).
 */
function forwarder(
  source: WebSocket,
  dest: WebSocket,
  side: 'client' | 'upstream',
  hooks: RelayHooks,
): (data: RawData | string, isBinary: boolean) => void {
  let paused = false;
  return (data, isBinary) => {
    if (dest.readyState !== WebSocket.OPEN) return;
    dest.send(data, { binary: isBinary }, () => {
      if (!paused || dest.bufferedAmount > RELAY_LOW_WATER_BYTES) return;
      paused = false;
      source.resume();
      hooks.onBackpressure?.(side, false);
    });
    if (paused || dest.bufferedAmount <= RELAY_HIGH_WATER_BYTES) return;
    paused = true;
    source.pause();
    hooks.onBackpressure?.(side, true);
  };
}

export function relay(client: WebSocket, upstream: WebSocket, hooks: RelayHooks = {}): RelayHandle {
  let ending = false;
  // A socket paused for backpressure reads nothing — including the close handshake's reply, which
  // would leave a closing session hanging on ws's 30 s close timeout (and block a shutdown).
  const resumeBoth = () => { client.resume(); upstream.resume(); };
  const endWith = (target: WebSocket, code: number, reason: string) => {
    if (ending) return;
    ending = true;
    resumeBoth();
    closeQuietly(target, code, reason);
  };

  const toUpstream = forwarder(client, upstream, 'client', hooks);
  const toClient = forwarder(upstream, client, 'upstream', hooks);

  client.on('message', (data, isBinary) => {
    let verdict: ClientFrameVerdict;
    try { verdict = hooks.onClientFrame?.(data, isBinary); } catch { verdict = undefined; }
    if (verdict && 'drop' in verdict) {
      if (verdict.reply !== undefined) toClient(verdict.reply, false);
      return;
    }
    if (verdict && 'forward' in verdict) {
      toUpstream(verdict.forward, typeof verdict.forward === 'string' ? false : isBinary);
      if (verdict.thenUpstream !== undefined) toUpstream(verdict.thenUpstream, false);
      return;
    }
    toUpstream(data, isBinary);
  });
  upstream.on('message', (data, isBinary) => {
    toClient(data, isBinary);
    hooks.onUpstreamFrame?.(data, isBinary);
  });

  client.on('close', (code, reason) => {
    hooks.onClosed?.('client', code, reason.toString());
    endWith(upstream, CLOSE_NORMAL, '');
  });
  upstream.on('close', (code, reason) => {
    hooks.onClosed?.('upstream', code, reason.toString());
    const mapped = propagatedClose(code, reason);
    endWith(client, mapped.code, mapped.reason);
  });
  client.on('error', () => endWith(upstream, CLOSE_NORMAL, ''));
  upstream.on('error', () => endWith(client, CLOSE_INTERNAL_ERROR, REASON_UPSTREAM_ERROR));

  return {
    close(code, reason) {
      if (ending) return;
      ending = true;
      resumeBoth();
      closeQuietly(client, code, reason);
      closeQuietly(upstream, code, reason);
    },
    sendUpstream(text) { toUpstream(text, false); },
    sendClient(text) { toClient(text, false); },
  };
}
