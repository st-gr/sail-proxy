/**
 * The handshake between responsesController's streaming path and the web-search
 * interceptor it cannot see.
 *
 * `forwardStream` treats the upstream stream's `'end'` event as "the response is over":
 * it folds usage, emits the usage event and closes the socket, all synchronously in that
 * tick. That is wrong as soon as responsesWebSearchPlugin is in play — the plugin's
 * res.write interceptor holds the terminal frame back, runs a search, and makes a SECOND
 * streaming deployment call whose frames are spliced into the same response. All of that
 * happens AFTER upstream `'end'`, so a synchronous fold bills only the first call's
 * tokens (the continuation's `__responsesExtraUsage` is still zero when it is read) and a
 * synchronous `res.end()` would try to close the socket out from under the splice. Note
 * that `forwardStream` never runs the after-plugin chain either, so there is no other
 * point where the plugin could report those tokens back.
 *
 * The interceptor therefore publishes three nullary functions on `res`, driven from the
 * two events the controller already has:
 *
 *   - `RESPONSES_STREAM_UPSTREAM_END_HOOK` — "the first call's stream is over." Signalled
 *     BEFORE the wait below, because it is one of the three things that tell the
 *     interceptor the turn is finished and a continuation may start. A stream that ends
 *     without a terminal frame has neither of the other two, so without this the idle hook
 *     reports idle, usage is folded at zero, the event is emitted — and only the res.end
 *     that follows starts the continuation, whose tokens are then billed to nobody.
 *   - `RESPONSES_STREAM_IDLE_HOOK` — "tell me when nothing is outstanding."
 *   - `RESPONSES_STREAM_ABORT_HOOK` — "the client is gone", from the same req 'close'
 *     handler that destroys the first upstream stream. Codex aborts turns routinely, and
 *     an abandoned request must neither open a fresh deployment call nor keep one open.
 *
 * Requests with no interceptor installed — every non-web-search stream, every other
 * endpoint — have none of these hooks, every helper here returns immediately, and the path
 * behaves exactly as it did before.
 *
 * `timeoutMs` bounds THIS wait only, so a stalled continuation degrades to a truncated
 * response rather than a request that hangs until the client gives up. It is NOT the
 * ceiling on the continuation itself: `res.end` is deferred by the interceptor's own
 * patched `end`, so a continuation abandoned here can still be running afterwards. Its
 * real ceiling is the interceptor's own — at worst `max_searches_per_request` rounds of
 * (axios timeout + per-stream watchdog) — which is why that watchdog, and the abort hook
 * above, are the first line of defence and this timer only the last.
 *
 * @see plugins/responsesWebSearchPlugin.ts - installResponsesWebSearchInterceptor
 * @see controllers/responsesController.ts - forwardStream
 */

/** Property name under which the interceptor publishes its idle hook on `res`. */
export const RESPONSES_STREAM_IDLE_HOOK = '__responsesWebSearchIdle';

/** Ditto, for "the first deployment call's stream has ended". */
export const RESPONSES_STREAM_UPSTREAM_END_HOOK = '__responsesWebSearchUpstreamEnded';

/** Ditto, for "the client disconnected; stop spending on this request". */
export const RESPONSES_STREAM_ABORT_HOOK = '__responsesWebSearchAbort';

function callHook(res: any, key: string): void {
  const hook = res && (res as any)[key];
  if (typeof hook !== 'function') return;
  try { hook(); } catch { /* a hook must never break the path that closes the response */ }
}

/**
 * Tell the interceptor the client has disconnected. Safe to call more than once, and on a
 * response that never had an interceptor.
 */
export function abortResponsesStreamContinuation(res: any): void {
  callHook(res, RESPONSES_STREAM_ABORT_HOOK);
}

/**
 * Report that the first deployment call's stream has ended, then resolve once no
 * web-search continuation is outstanding on this response — or after `timeoutMs`,
 * whichever comes first. Never rejects: the caller is on the path that closes the
 * response, and an exception there would strand the request.
 */
export async function awaitResponsesStreamIdle(
  res: any,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<void> {
  // Before the idle hook is read, never after: this is what can make it non-idle.
  callHook(res, RESPONSES_STREAM_UPSTREAM_END_HOOK);

  const hook = res && (res as any)[RESPONSES_STREAM_IDLE_HOOK];
  if (typeof hook !== 'function') return;

  try {
    const idle = hook();
    if (!idle || typeof idle.then !== 'function') return;

    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      idle,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => { onTimeout?.(); resolve(); }, Math.max(0, timeoutMs));
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
    if (timer) clearTimeout(timer);
  } catch { /* best effort: never block closing the response */ }
}
