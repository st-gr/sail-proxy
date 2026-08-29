/**
 * In-memory accumulation of a STREAMED response, so a usage SIEM event can carry the
 * response half for the traffic that is actually streamed.
 *
 * Content shipping (services/siemUsageEvent.ts) captures the response at the one instant it
 * exists as a complete string — the pseudonymization after handler, just before unmasking.
 * A streamed response never has that instant, so until now a SIEM opted into content got a
 * masked prompt and nothing else for most of its traffic.
 *
 * WHY THIS IS A PLAIN ARRAY AND NOT VALKEY
 * ----------------------------------------
 * The obvious place to accumulate chunks is the Valkey stream the finished event is already
 * published to. It is the wrong place: one round trip per chunk is one network hop per token
 * on the inference path, which is exactly the cost this feature must not have. Valkey is the
 * right boundary for the HANDOFF — one publish after the stream has completed, consumed by a
 * different process — and that is unchanged. The accumulation is a JavaScript array on the
 * request, the same shape LiteLLM uses (`self.chunks.append(...)` on its stream handler,
 * assembled once at completion with `stream_chunk_builder`).
 *
 * WHAT THE PER-CHUNK PATH COSTS
 * -----------------------------
 * `appendStreamContent` on a request with no capture is one property read and one comparison.
 * With a capture it is two comparisons, one `Array.prototype.push` and one integer add. There
 * is no masking, no serialization, no `Buffer.byteLength` and no I/O per chunk — the cap below
 * is counted in UTF-16 code units precisely so it costs nothing to maintain. Assembly, the
 * byte-exact cap and the publish all happen after `res` has emitted `finish`, i.e. after the
 * last byte has reached the client.
 *
 * WHEN NOTHING IS ALLOCATED
 * -------------------------
 * A capture is installed only when `resolveContentGates` says some enabled sink will actually
 * receive content (see `beginStreamContentCapture` in siemUsageEvent.ts). A gateway with no
 * content sink — the shipped default — allocates nothing extra per request and never reaches
 * the array at all.
 *
 * THE UNHAPPY PATHS
 * -----------------
 * `res` emits `finish` when the response completed and `close` in every case, aborted or not.
 * A capture that sees `close` while still open releases its buffer and marks the request
 * `__siemStreamIncomplete`; it publishes NO response text, because a truncated-by-accident
 * half response presented as a whole one is worse than no response at all. What the event
 * carries instead is the prompt and `content.omitted: 'stream-incomplete'`, so a reader can
 * tell "this stream did not finish" from "this request had no response".
 */

import { Request, Response } from 'express';

/** Where a capture lives. Read on the per-chunk path, so it is a plain own property. */
const CAPTURE_KEY = '__siemStreamCapture';

/**
 * Which per-chunk site is feeding a capture. The first site to append owns the capture for
 * the rest of the stream.
 *
 * Both sites can see the same stream: `after-chain` is the plugin chain's per-chunk after
 * handler, `sse-wire` is the res.write interceptor further downstream. The after handler has
 * already unmasked by the time the same text reaches the wire, so accepting both would
 * append the text twice AND append it in its unmasked form. Locking to the first source
 * keeps exactly one, masked, copy.
 */
export type CaptureSource = 'after-chain' | 'sse-wire';

export class StreamContentCapture {
  private chunks: string[] = [];
  private units = 0;
  private full = false;
  private source: CaptureSource | undefined;
  private state: 'open' | 'complete' | 'aborted' = 'open';
  private readonly settledPromise: Promise<void>;
  private settle: () => void = () => { /* replaced in the constructor */ };

  /**
   * `maxUnits` is `siem.content_max_bytes` used as a cap on UTF-16 code units. A UTF-8
   * encoding is never shorter in bytes than the string is in code units for the characters
   * that matter here, so exceeding the cap in units guarantees exceeding it in bytes —
   * which is what makes `capBytes` in siemUsageEvent.ts the authority on the exact cut
   * while this stays an O(1) memory bound.
   */
  constructor(private readonly req: Request, private readonly maxUnits: number) {
    this.settledPromise = new Promise<void>(resolve => { this.settle = resolve; });
  }

  /** The whole per-chunk cost of this feature. Nothing here allocates beyond the push. */
  append(source: CaptureSource, text: string): void {
    if (this.state !== 'open' || this.full || !text) return;
    if (this.source === undefined) {
      this.source = source;
    } else if (this.source !== source) {
      return;
    }
    this.chunks.push(text);
    this.units += text.length;
    // The chunk that crosses the cap is retained whole and is the last one retained, so
    // what is assembled is always strictly longer than the cap and capBytes cuts it.
    if (this.units > this.maxUnits) this.full = true;
  }

  /**
   * End of stream. Assembles once, hands the text to the same request property the
   * non-streaming path writes, and releases the array.
   *
   * An existing value is never overwritten: on a non-streaming response the after handler
   * has already stashed the real thing, and this must not replace it with whatever the
   * wire happened to carry.
   */
  complete(): void {
    if (this.state !== 'open') return;
    this.state = 'complete';
    if (this.chunks.length > 0 && typeof (this.req as any).__siemMaskedResponse !== 'string') {
      (this.req as any).__siemMaskedResponse = this.chunks.join('');
      (this.req as any).__siemMaskedResponseTruncated = this.full;
    }
    this.release();
  }

  /** Errored, aborted, or closed without finishing. Releases the buffer, publishes nothing. */
  abort(): void {
    if (this.state !== 'open') return;
    this.state = 'aborted';
    (this.req as any).__siemStreamIncomplete = true;
    this.release();
  }

  /**
   * Resolves once the stream has reached one of its two terminal states. Awaited by
   * `emitSiemUsageEvent`, which is dispatched with `void` from the usage tracker and so is
   * already off the response path — the await orders the emission after the last byte
   * rather than delaying anything the caller can observe.
   */
  settled(): Promise<void> {
    return this.settledPromise;
  }

  /** Test/diagnostic view. Not used on the request path. */
  get status(): 'open' | 'complete' | 'aborted' {
    return this.state;
  }

  private release(): void {
    this.chunks = [];
    this.units = 0;
    this.settle();
  }
}

/**
 * Attaches a capture to the request and wires it to the response's lifecycle.
 *
 * `finish` fires when the response completed; `close` fires in every case, so an aborted
 * stream that never finished settles there instead. `abort` after `complete` is a no-op, so
 * the ordinary ordering (finish, then close) still ends up complete.
 */
export function installStreamCapture(
  req: Request,
  res: Response,
  maxUnits: number,
): StreamContentCapture | undefined {
  const existing = (req as any)[CAPTURE_KEY] as StreamContentCapture | undefined;
  if (existing) return existing;
  if (!res || typeof (res as any).on !== 'function') return undefined;

  const capture = new StreamContentCapture(req, maxUnits);
  (req as any)[CAPTURE_KEY] = capture;
  res.on('finish', () => capture.complete());
  res.on('close', () => capture.abort());
  res.on('error', () => capture.abort());
  return capture;
}

export function getStreamCapture(req: Request): StreamContentCapture | undefined {
  return (req as any)[CAPTURE_KEY];
}

/**
 * The per-chunk entry point. Called from the sites that already hold the masked delta text,
 * so nothing is parsed or re-read to feed it.
 */
export function appendStreamContent(req: Request, source: CaptureSource, text: string): void {
  const capture = (req as any)[CAPTURE_KEY] as StreamContentCapture | undefined;
  if (capture !== undefined) capture.append(source, text);
}
