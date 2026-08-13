/**
 * The hosted-tool engine for the OpenAI Responses API.
 *
 * SAP AI Core deployments reject hosted tool types outright, and Codex CLI attaches one
 * (`web_search`) to every request with no way to disable it — so without this the
 * /openai/v1/responses route is unusable from Codex. The gateway rewrites each hosted
 * tool into a plain function tool the deployment accepts, runs the tool itself, and hands
 * the client back the hosted-tool shape it expects.
 *
 * Everything here is transport machinery, shared by every hosted tool. What each tool
 * actually IS — its wire shape, its arguments, how it runs, what item the client sees —
 * lives behind `HostedToolDescriptor` (see `descriptor.ts`) and is looked up per call in
 * `registry.ts`. This file was extracted verbatim from `responsesWebSearchPlugin.ts`,
 * which is now the shim that registers the `web_search` descriptor onto it.
 *
 *   before — rewrite every hosted tool into a function tool the deployment accepts, run
 *            each descriptor's prepare() (rejecting the whole request when one reports a
 *            caller error, which is the only moment such a thing can still be reported —
 *            see `rejectionStatusOf`), back-fill outputs for any calls left pending from
 *            the previous turn, and — on the streaming path — install the res.write
 *            interceptor that does everything below frame by frame.
 *   after  — run every hosted-tool function_call the model emitted, then POST the results
 *            straight back to the deployment (a "continuation" call) so the SAME turn
 *            produces the model's real answer, repeating until the model stops calling
 *            hosted tools or the configured cap is hit. Only when there is no upstream
 *            call context to continue with, or a continuation POST itself fails, does the
 *            handler fall back to handing the client a synthetic call item + message pair
 *            instead of the model's own answer.
 *
 * The streaming path (installHostedToolInterceptor, below) does the same thing against a
 * live SSE stream: it suppresses the function_call frames, holds the first call's terminal
 * frame, injects the hosted-tool call item, and splices a SECOND streaming deployment call
 * into the same response so the model's answer streams token by token — one
 * response.created and one response.completed for the client, output_index and
 * sequence_number shifted, usage summed. Its frame contract is documented there. That path
 * matters most: Codex CLI always streams.
 *
 * Both handlers REMOVE the model's function_call from what the client receives, so in the
 * normal flow (an upstream context is always stashed by responsesController) there is
 * nothing left for the client to replay and the before handler's pending back-fill does
 * not fire. The back-fill exists for the case where an unanswered function_call does reach
 * the next turn's input anyway — a client that replays it regardless, or a continuation
 * that never got attempted — because the deployment rejects such a turn as malformed.
 *
 * Codex CLI defaults `parallel_tool_calls` to true, so the model can emit more than one
 * hosted-tool call in a single turn — both the before handler's pending drain and the
 * after handler's continuation loop resolve every one of them, not just the first, for
 * exactly that reason: a turn POSTed with any function_call left unanswered by a
 * function_call_output is malformed and the deployment rejects it. The loop groups the
 * whole turn, not one tool: a round that called `web_search` twice and some other hosted
 * tool once produces ONE continuation POST carrying all three outputs.
 *
 * Ordering: there is ONE hook array per subpath and it is walked in order in both
 * directions, so pseudonymizationPlugin runs first on the request side (the pending
 * back-fill's arguments are already masked) but ALSO first on the response side — where it
 * unmasks the model's function_call arguments before this engine ever sees them, and runs
 * only ONCE, on the deployment's first response. The continuation loop below therefore has
 * to redo both halves of that job itself for every second-and-later deployment call it
 * makes: re-mask (`remaskResponsesItems`, built on the same primitive the descriptors get
 * as `ctx.remask`, scoped to the same text-bearing fields `unmaskResponsesOutput` covers)
 * the whole conversation it is about to POST, since the model's prior output in it has
 * already been unmasked; and unmask (`unmaskResponsesOutput`, the same helper
 * pseudonymizationPlugin itself calls) each continuation response before treating it as
 * the turn's new current state, since pseudonymizationPlugin will never see it. The
 * streaming path needs neither step: its res.write interceptor is installed after
 * pseudonymization's, so it reads every frame — arguments, model output, the whole
 * conversation it POSTs back — while they are still masked, and writes everything back out
 * THROUGH the unmasker.
 *
 * @see descriptor.ts - what a hosted tool has to implement
 * @see registry.ts - type / function-name lookup
 * @see ../responsesWebSearchPlugin.md - documentation
 */
import { Request, Response } from 'express';
import axios from 'axios';
import { normalizeInputToItems } from '../webSearch/continuation';
import { remaskText, remaskResponsesItems } from '../webSearch/queryMasking';
import { unmaskResponsesOutput } from '../../utils/responsesBodyAdapter';
import {
  TERMINAL_RESPONSE_TYPES, splitBlocks, parseFrame, sseBlock, rebuildBlockWithSubstitution,
} from '../../utils/sseFraming';
import {
  RESPONSES_STREAM_IDLE_HOOK,
  RESPONSES_STREAM_UPSTREAM_END_HOOK,
  RESPONSES_STREAM_ABORT_HOOK,
} from '../../utils/responsesStreamIdle';
import { unmaskText } from '../pseudonymization/unmasker';
import { noteExtraUsage, readCacheWriteTokens } from '../../utils/usageFolding';
import {
  HostedToolDescriptor, Logger, ParsedCall, RenderCallItemOpts, ToolExecCtx, ToolExecResult,
} from './descriptor';
import {
  descriptorForCall, descriptorForHostedTool, descriptorForReplayedCallItem, descriptorForType,
  isHostedToolCall,
} from './registry';
import { syntheticId } from './syntheticId';
import { getToolResult, putToolResult } from './resultCache';
import { buildReplayFunctionCall } from './replayTranslation';

interface PluginContext {
  req: Request;
  res: Response;
  utils: { logger: Logger };
  upstreamResponse?: any;
}

/**
 * `response` is part of the declared shape and is DEAD: `pluginExecutor` returns the
 * handler's object verbatim and all four controllers do `if (pluginResult?.stop) return;`
 * with the comment "Response already sent by plugin". The convention is that a stopping
 * plugin writes its own response — see `sendPrepareRejection`.
 */
interface PluginResult {
  stop: boolean;
  response?: any;
}

/**
 * Marks a request whose hosted tool(s) we rewrote, so the after handler knows to look.
 * The literal is part of the plugin's observable surface — three suites reference it by
 * name to drive the after handler directly — and must not be renamed.
 */
const REWROTE_FLAG = '__responsesWebSearchRewritten';

/** Where the before handler stashes each descriptor's `prepare()` result, by tool type. */
const PREPARED_FLAG = '__hostedToolPrepared';

/** Hard cap on pending calls drained per request, to guarantee termination. */
const MAX_PENDING_CALLS_PER_TURN = 4;

/** A resolved call's two client-facing items. `messageItem` is null for a tool with none. */
interface RenderedPair {
  callItem: any;
  messageItem: any | null;
}

/** How the render hooks are parameterised for this request. */
type RenderOptsFor = (d: HostedToolDescriptor) => RenderCallItemOpts;

/**
 * `include: ["web_search_call.results"]` and friends: a request may ask for the raw tool
 * results alongside the synthetic call item. Read per request, applied per descriptor.
 *
 * THE KEY IS NAMED AFTER THE OUTPUT ITEM, NOT AFTER THE TOOL. OpenAI's `include` enum
 * carries `web_search_call.results` / `file_search_call.results` — the `_call` suffix is
 * part of the token, because the field being included lives on the `<tool>_call` output
 * item. This once built the key as `` `${d.type}.results` ``, which is `file_search.results`
 * / `web_search.results`: tokens no client sends. The failure was silent and total — a
 * client sending exactly what OpenAI documents got a call item with no `results` field and
 * no way to tell that from not having asked. `renderOptsFor` is the only reader of
 * `req.body.include`, so nothing else rescued it.
 */
function renderOptsFor(req: any): RenderOptsFor {
  const include = req?.body?.include;
  const asked = Array.isArray(include) ? include : [];
  return (d: HostedToolDescriptor) => ({ includeResults: asked.includes(`${d.type}_call.results`) });
}

/**
 * The gateway's single source of caller identity: both auth paths populate `.email` on
 * `req.apiKeyInfo` (and on the `req.apiKey` spread of the same data). Undefined for an
 * AWS SigV4-authenticated request, which carries no email.
 */
function ownerEmailFrom(req: any): string | undefined {
  const email = req?.apiKeyInfo?.email ?? req?.apiKey?.email;
  return typeof email === 'string' && email.length > 0 ? email : undefined;
}

/**
 * The request's resolved `MaskingConfig`, as pseudonymizationPlugin stashed it, or
 * undefined when masking is off for this request. Handed to every descriptor on
 * `ToolExecCtx.maskingConfig`; see that field for why `replacementMap` is not enough.
 */
function maskingConfigFrom(req: any): any {
  return req?.__pseudonymization?.config;
}

/**
 * The HTTP status a `prepare()` failure asks this request to be REJECTED with, or
 * undefined for one it should merely degrade past.
 *
 * The rule is structural, not a list of error classes: an error that carries a numeric
 * HTTP `status` is describing something the CALLER got wrong and can fix (a store id that
 * is not theirs, a `max_num_results` out of range), so the request has to fail with it.
 * An error with no `status` — `new Error('file_search database is not configured')` when
 * the pool is null, a connection refused — is infrastructure: it is not the caller's
 * mistake, they cannot act on it, and one tool being unavailable must not take down a
 * request that may never call that tool. Those still degrade, exactly as before.
 *
 * Bounded to 4xx — the CLIENT-error range — so an unrelated field named `status` (a store
 * row's `'expired'`, a `0`) can never be mistaken for a response code, AND so a 5xx can
 * never be mistaken for something the caller got wrong.
 *
 * 5xx is excluded deliberately, not merely because nothing reaches it today. No
 * descriptor's `prepare()` throws one now, but axios sets a top-level numeric `status` on
 * its errors and axios is used throughout this stack: the first descriptor whose
 * `prepare()` validates against a remote service would, on that service's 503, have the
 * whole request REJECTED — contradicting the degrade rule stated above, which exists for
 * exactly this ("infrastructure, not the caller's mistake, they cannot act on it") — and
 * mislabelled `invalid_request_error` by the envelope below. A 5xx belongs on the degrade
 * path with the pool-is-null and connection-refused cases.
 */
function rejectionStatusOf(error: any): number | undefined {
  const status = error?.status;
  if (typeof status !== 'number' || !Number.isInteger(status)) return undefined;
  return status >= 400 && status <= 499 ? status : undefined;
}

/**
 * Answer the request with the OpenAI error envelope — the same `{ error: { message, type,
 * code } }` shape `filesController` and `vectorStoresController` emit for these very
 * errors, so a `file_search` mistake reads the same whether the caller hit the REST
 * surface or the tool.
 *
 * Returns whether the response was actually written. It writes the body ITSELF rather than
 * handing one back on `PluginResult.response`: that field is declared but never honoured —
 * `pluginExecutor` returns the handler's object verbatim and every controller does
 * `if (pluginResult?.stop) return;` with the comment "Response already sent by plugin". A
 * handler that returned `{ stop: true, response }` would produce a hung request with
 * nothing written at all.
 *
 * False (nothing sent) is treated by the caller as "cannot reject", and it degrades
 * instead: with the response already committed there is no status left to set, and
 * throwing would only be swallowed by pluginExecutor's per-plugin catch.
 */
function sendPrepareRejection(res: Response, status: number, error: any, log: Logger): boolean {
  const anyRes = res as any;
  if (!anyRes || typeof anyRes.status !== 'function' || anyRes.headersSent) return false;
  anyRes.status(status).json({
    error: {
      message: error?.message || 'The request could not be served.',
      type: 'invalid_request_error',
      // The error class's own wire code where it declares one (`vector_store_expired`,
      // `embedding_dimension_mismatch`), so the tool and the REST surface never drift.
      code: typeof error?.code === 'string' && error.code.length > 0
        ? error.code : 'invalid_request_error',
    },
  });
  log.warn(`Rejected the request with ${status}: ${error?.name || 'Error'}`);
  return true;
}

/**
 * A call that never ran, or ran and failed with nothing to show for it. `code` names WHY
 * when the engine knows — `cap_reached` for a call the per-tool budget refused. Left
 * undefined for a genuine failure, so each descriptor's renderOutput falls back to its own
 * `<tool>_unavailable`.
 */
function failedResult(call: ParsedCall, code?: string): ToolExecResult {
  return { call, status: 'failed', payload: null, ...(code ? { error: { code, message: '' } } : {}) };
}

/**
 * The `message` items this engine SYNTHESISED — a descriptor's `renderResultMessage` dump —
 * as opposed to the ones the model actually wrote.
 *
 * Only used to keep them out of `annotateItems` below. A dump carries the passages
 * VERBATIM, so a citation anchored in it would underline the tool's own output rather than
 * anything the model said, and it would appear on only one of the two frames that name the
 * item (the dump's own `output_item.done` blocks are written directly, never through the
 * annotating sites) — the exact inconsistency the wiring exists to avoid. A WeakSet keyed
 * on item identity rather than a marker field, because a marker would change the bytes.
 */
const synthesizedMessages = new WeakSet<any>();

/**
 * Both client-facing items for a result, in the shape the substitution paths want.
 *
 * `renderCallItem` is called BEFORE `renderResultMessage` and must stay that way: both mint
 * ids from `syntheticId`'s single shared counter, and the characterization suite normalises
 * ids positionally.
 *
 * SIDE EFFECT: also records the result in the hosted-tool result cache
 * (`cacheRenderedResult`), keyed on the callItem this same call mints. Safe to do
 * unconditionally — the cache write is itself a no-op for a failed result, which is what
 * every current failed-placeholder caller always passes — but that means a FUTURE caller
 * inherits the write silently too. If you add one, check whether that is what you want.
 */
function renderPair(
  req: any, d: HostedToolDescriptor, r: ToolExecResult, optsFor: RenderOptsFor, log: Logger,
): RenderedPair {
  const callItem = d.renderCallItem(r, optsFor(d));
  cacheRenderedResult(req, d, r, callItem, log);
  const messageItem = d.renderResultMessage(r);
  if (messageItem) synthesizedMessages.add(messageItem);
  return { callItem, messageItem };
}

/**
 * Record a rendered call item's results under its id, so a later turn that replays the item
 * can be given back the model's own tool use in the shape its tool list uses. Best-effort:
 * a cache failure must never affect the turn being rendered — enforced by the try/catch
 * around the whole body, not merely by `putToolResult`'s own internal one, because a
 * descriptor's `cachePayloadFrom` hook runs BEFORE `putToolResult` is ever entered and is not
 * this function's code to trust.
 *
 * Skips a `failed` result on purpose — every render site that hands this a failure is a
 * placeholder for a call that never produced anything (the cap was exhausted, the call
 * threw, the item was stranded mid-stream), and there is nothing worth replaying back. That
 * guard is also what makes it safe to route EVERY `renderPair` call through this
 * unconditionally: whichever of `renderPair`'s callers builds a failed placeholder always
 * constructs a `failedResult` before calling it, so it no-ops here rather than needing its
 * own opt-out — deliberately not counted by name here, since that count lives with the
 * callers themselves and would only go stale if repeated in this comment too.
 */
function cacheRenderedResult(
  req: any, descriptor: HostedToolDescriptor, r: ToolExecResult, callItem: any, log: Logger,
): void {
  try {
    if (!callItem?.id || r.status === 'failed') return;
    putToolResult(callItem.id, {
      toolType: descriptor.type,
      ownerEmail: ownerEmailFrom(req) || '',
      payload: descriptor.cachePayloadFrom ? descriptor.cachePayloadFrom(r.payload) : r.payload,
      status: 'completed',
      query: typeof r.call?.args?.query === 'string' ? r.call.args.query : '',
    });
  } catch (error: any) {
    // A descriptor's cachePayloadFrom is not this function's code, and this cache is an
    // optimisation for a LATER turn — a miss just re-executes the query. Letting a throwing
    // hook escape from here would corrupt the turn being rendered right now, which is a far
    // worse outcome than losing this one replay entry.
    log.error(`responsesWebSearchPlugin: failed to cache the ${descriptor.type} result for replay: ${error.message}`);
  }
}

/**
 * The text of an assistant `message` this engine may annotate, or undefined for anything
 * else — a `reasoning` item, a tool call, a message with no text part, and every result
 * dump the engine synthesised itself.
 */
function annotatableText(item: any): string | undefined {
  if (!item || item.type !== 'message' || synthesizedMessages.has(item)) return undefined;
  const text = item?.content?.[0]?.text;
  return typeof text === 'string' && text.length > 0 ? text : undefined;
}

/** Every result one descriptor has produced this request, in call order. */
type ResultsByDescriptor = Map<HostedToolDescriptor, ToolExecResult[]>;

/** Where `resultsFor` stashes the request's annotation accumulator. */
const RESULTS_FLAG = '__hostedToolResultsForAnnotation';

/**
 * The request's annotation accumulator, created on first use.
 *
 * ON THE REQUEST RATHER THAN IN A CLOSURE, because THREE separate scopes contribute to it
 * and two of them cannot see each other: the before handler's pending drain, the streaming
 * interceptor, and the after handler. The drain is why this matters rather than being
 * tidiness. It runs hosted-tool calls out of a REPLAYED conversation BEFORE any deployment
 * call is made, so on that shape — the one Codex CLI produces, and the one the three drain
 * tests in responses-websearch-plugin.test.ts pin — the model's very FIRST response is
 * already the message citing those results. An accumulator scoped to the interceptor (which
 * is installed just before the drain runs, and would then see an empty map for the whole
 * turn) or to the after handler yields zero citations for exactly that shape.
 */
function resultsFor(req: any): ResultsByDescriptor {
  const existing = req?.[RESULTS_FLAG] as ResultsByDescriptor | undefined;
  if (existing) return existing;
  const created: ResultsByDescriptor = new Map();
  if (req) req[RESULTS_FLAG] = created;
  return created;
}

/**
 * Record a result for later annotation. Kept ONLY for descriptors that implement
 * `annotateMessage`: retaining a whole request's search hits for a tool that will never
 * look at them again is memory nobody asked for.
 */
function noteResultForAnnotation(
  into: ResultsByDescriptor, d: HostedToolDescriptor, r: ToolExecResult,
): void {
  if (!d.annotateMessage) return;
  const existing = into.get(d);
  if (existing) existing.push(r);
  else into.set(d, [r]);
}

/**
 * Offer one client-facing item to every descriptor that has results and an
 * `annotateMessage` hook, chaining so a turn that called two tools can carry both kinds of
 * citation on the same message.
 *
 * THE TEXT CHECK COVERS ONE OF THE TWO WAYS TO BREAK THE CONTRACT, AND ONLY ONE. It catches
 * a descriptor that returns a REWRITTEN COPY with different text. It does NOT catch one that
 * mutates the item IN PLACE and returns it: `next === current` short-circuits above, before
 * the comparison, and there is nothing left to compare against anyway. That is deliberate —
 * an in-place rewrite cannot be undone here, and every caller below hands this function an
 * item some other code path still holds a reference to.
 *
 * So the guard is a convenience, NOT the guarantee. What actually pins "annotations only,
 * never the text" is the suite: `filesearch-citations-wiring.test.ts` asserts on the bytes
 * handed down to the unmasker and on the body of the next continuation POST, and both catch
 * the in-place variant that this check waves through. Neither leak audit catches it either —
 * both scan for MASKED_* residue reaching the CLIENT, which is the opposite direction, and
 * both are log-only.
 *
 * Returns the item unchanged (by identity, so callers can keep a raw block byte-for-byte)
 * whenever nothing was added.
 */
function annotateItem(
  item: any, resultsByDescriptor: ResultsByDescriptor, replacementMap: any, log: Logger,
): any {
  const text = annotatableText(item);
  if (text === undefined) return item;

  let current = item;
  for (const [descriptor, results] of resultsByDescriptor) {
    if (!descriptor.annotateMessage || results.length === 0) continue;
    let next: any;
    try {
      next = descriptor.annotateMessage(current, results, { replacementMap });
    } catch (error: any) {
      // A message the client can read is worth more than the citations on it.
      log.error(`responsesWebSearchPlugin: the ${descriptor.type} descriptor failed to annotate an assistant message: ${error.message}`);
      continue;
    }
    if (!next || next === current) continue;
    if (annotatableText(next) !== text) {
      log.error(`responsesWebSearchPlugin: the ${descriptor.type} descriptor's annotateMessage changed the message text; discarding its annotations`);
      continue;
    }
    current = next;
  }
  return current;
}

/**
 * `annotateItem` over a whole client-facing output array, returning the SAME array by
 * identity when nothing changed — which is every turn of every tool that does not implement
 * the hook.
 */
function annotateItems(
  items: any[], resultsByDescriptor: ResultsByDescriptor, replacementMap: any, log: Logger,
): any[] {
  if (!Array.isArray(items) || resultsByDescriptor.size === 0) return items;
  let changed = false;
  const annotated = items.map((item) => {
    const next = annotateItem(item, resultsByDescriptor, replacementMap, log);
    if (next !== item) changed = true;
    return next;
  });
  return changed ? annotated : items;
}

/**
 * `annotateItems` over a whole non-streaming response, preserving the response's identity
 * when nothing changed — the non-streaming counterpart of the streaming `annotateTerminal`.
 *
 * `replacementMap` is always undefined here: on this transport pseudonymizationPlugin's
 * after handler (index 0) has already unmasked the deployment's first response, and the
 * engine's own `unmaskResponsesOutput` unmasked every continuation round, so the offsets are
 * simply indices into what a descriptor was handed.
 */
function annotateResponse(response: any, resultsByDescriptor: ResultsByDescriptor, log: Logger): any {
  const output = response?.output;
  if (!Array.isArray(output)) return response;
  const annotated = annotateItems(output, resultsByDescriptor, undefined, log);
  return annotated === output ? response : { ...response, output: annotated };
}

/** Push a pair into an output array, skipping a message a descriptor declined to render. */
function pushPair(into: any[], pair: RenderedPair): void {
  into.push(pair.callItem);
  if (pair.messageItem) into.push(pair.messageItem);
}

/** The parsed call an output item stands for, per its own descriptor. */
function parseItemCall(d: HostedToolDescriptor, item: any): ParsedCall {
  return d.parseCall(
    typeof item?.call_id === 'string' ? item.call_id : '',
    typeof item?.arguments === 'string' ? item.arguments : '',
  );
}

/**
 * Replace every hosted-tool function_call in `output` with its resolved call item +
 * message pair, preserving the position — and hence the ordering relative to every other
 * item (a `reasoning` item that preceded the call in the model's own output keeps
 * preceding it here) — of everything else. A call with no entry in `pairsByCallId` (the
 * cap didn't leave budget to run it this batch, or the caller genuinely has no result for
 * it — see the outer catch below) still gets a pair, built as a failure placeholder: every
 * path that can return output to the client goes through this function specifically so a
 * raw function_call can never survive — it has no output_item events of its own to leak by.
 */
function replaceHostedToolCalls(
  req: any,
  output: any[],
  pairsByCallId: Map<string, RenderedPair>,
  optsFor: RenderOptsFor,
  log: Logger,
): any[] {
  const result: any[] = [];
  for (const item of output || []) {
    const descriptor = descriptorForCall(item);
    if (!descriptor) { result.push(item); continue; }

    const pair = typeof item.call_id === 'string' ? pairsByCallId.get(item.call_id) : undefined;
    if (pair) {
      pushPair(result, pair);
      continue;
    }
    pushPair(result, renderPair(req, descriptor, failedResult(parseItemCall(descriptor, item)), optsFor, log));
  }
  return result;
}

/**
 * The same items as the CLIENT receives them, for a round whose calls a continuation call
 * is going to answer: every hosted-tool function_call replaced by just the resolved call
 * item, everything else — a `reasoning` item and its `encrypted_content`, a `message` the
 * model wrote before calling the tool — passed through in its original position.
 *
 * The counterpart of `replaceHostedToolCalls`, and the difference is only the result
 * `message`: here the continuation that follows carries the model's own answer, so dumping
 * the raw results in front of it would be a second, redundant assistant message; on every
 * path that STOPS, that dump is the client's only view of what the tool produced and
 * `replaceHostedToolCalls` emits it. Shared by both transports — the streaming interceptor
 * builds its `clientItems` with this, and the non-streaming loop must too, or the two paths
 * hand the client different `response.output` arrays for the same turn.
 */
function clientVisibleItems(
  req: any,
  output: any[],
  pairsByCallId: Map<string, RenderedPair>,
  optsFor: RenderOptsFor,
  log: Logger,
): any[] {
  return (output || []).map((item) => {
    const descriptor = descriptorForCall(item);
    if (!descriptor) return item;
    const pair = typeof item.call_id === 'string' ? pairsByCallId.get(item.call_id) : undefined;
    if (pair) return pair.callItem;
    return renderPair(req, descriptor, failedResult(parseItemCall(descriptor, item)), optsFor, log).callItem;
  });
}

const INTERCEPTOR_FLAG = '__responsesWebSearchInterceptorInstalled';

/**
 * A pending item in stream order: a raw pass-through block, a terminal frame held for
 * substitution at flush time, or a placeholder marking where a suppressed call's injected
 * blocks belong once it resolves. Everything held while any call is in flight lives in one
 * ordered queue so replay preserves arrival order across all three kinds — see the
 * interleaving note on `flushIfIdle` below.
 */
type QueueItem =
  | { kind: 'raw'; block: string }
  | { kind: 'terminal'; frame: any; rawBlock: string }
  | { kind: 'call'; index: number };

/**
 * Suppress the raw function_call frames for a hosted tool, run the call, and splice a
 * SECOND streaming deployment call — the continuation — into the live stream so the model
 * writes the real answer from the results.
 *
 * res.write is synchronous but the call is not, so once a suppressed item completes every
 * later write is queued and flushed after the injection. res.end is deferred the same way,
 * or the stream would close before the results land.
 *
 * Codex defaults `parallel_tool_calls` to true, so more than one hosted-tool item can be
 * in flight in the same response, and reasoning/other tool-call items routinely interleave
 * with them. `pendingCalls` counts the outstanding calls; every write that arrives while
 * it's above zero — including a placeholder marking exactly where a call's injected blocks
 * belong — is appended, in arrival order, to one `queue`. Only once the counter drains to
 * zero does `flushIfIdle` replay `queue` in order, splicing each call's buffered blocks in
 * at its placeholder's position. That reproduces the upstream interleaving regardless of
 * which tool call wins the race, and guarantees a call still in flight when a sibling
 * finishes never gets its frames dropped into an already-flushed (or already-ended) stream.
 *
 * FRAME CONTRACT, once a continuation is possible (`req.__responsesUpstream` is stashed
 * and the cap has budget left):
 *
 *  1. The hosted tool's own function_call frames stay suppressed — as before.
 *  2. The first call's terminal frame (`response.completed` / `.incomplete` / `.failed`)
 *     is HELD, not written: it is not the client's final frame any more.
 *  3. Only `response.output_item.added` + `.done` for the synthetic call item are injected
 *     at the suppressed index — NOT the formatted-result `message` that the
 *     pre-continuation behavior ended the turn with. That message survives only as the
 *     fallback (below), where it is still the client's only way to see the results.
 *  4. The continuation call is opened with `stream: true`. From its frames,
 *     `response.created` and `response.in_progress` are dropped (the client already got
 *     one of each), `output_index` is shifted past everything already sent, and the rest
 *     pass through.
 *  5. The continuation's terminal frame becomes the client's, with `response.output`
 *     prefixed by every item earlier calls already streamed (each synthetic call item in
 *     place of the function_call it replaced) and `usage` summed across every call.
 *  6. A hosted-tool call in the continuation's own output repeats the whole cycle,
 *     bounded by each descriptor's `maxCallsPerRequest()`.
 *
 * FALLBACK. With no upstream context, no budget left, or a continuation POST that fails,
 * the client would otherwise be left with a call item and no answer at all — so the
 * pre-continuation `message` blocks carrying the formatted results are emitted after the
 * fact and the held terminal is written with the old in-place substitution. Requests that
 * never reach a deployment call (no `__responsesUpstream`) therefore behave exactly as
 * they did before this splice existed.
 *
 * MASKING. Unlike the after handler, this interceptor needs no re-masking: it is installed
 * AFTER pseudonymizationPlugin's own res.write interceptor, so it reads frames upstream of
 * the unmasker — every value it sees (the arguments, the model's items, the conversation
 * it POSTs back) is still masked, exactly as the deployment produced it. Descriptors run
 * from here are therefore handed the IDENTITY remasker. Symmetrically, everything written
 * goes out through `originalWrite`, i.e. through the unmasker, so the continuation's answer
 * reaches the client unmasked without this code touching the replacement map at all.
 * Re-masking here would be worse than useless: it would rewrite masked-looking substrings
 * inside the tool results themselves.
 *
 * LAYERING. This is the OUTERMOST of the Responses interceptors — the `responses-stream`
 * array is pseudonymizationPlugin, then responsesNamespaceToolsPlugin, then this one — and
 * it has to be, because the frames this interceptor generates ITSELF (a continuation
 * round's items, and the final terminal it rebuilds wholesale) never pass through
 * `res.write` and are therefore invisible to anything installed above it. Every
 * `originalWrite` below consequently runs through the namespace layer, which restores the
 * routing `namespace` on any sub-agent call a continuation round produces, and only then
 * through the unmasker.
 *
 * The `responses` (non-streaming) array deliberately lists those two the OTHER way round.
 * Write interceptors nest inside-out, but after-handlers chain in array order — so on that
 * path the namespace plugin has to run LAST, after this engine's after handler has finished
 * its continuation loop and replaced `output`. The two arrays are meant to disagree; making
 * them match reintroduces one of the two bugs. See responsesNamespaceToolsPlugin.md.
 */
export function installHostedToolInterceptor(req: Request, res: Response, pluginLogger: Logger): void {
  if ((res as any)[INTERCEPTOR_FLAG]) return;
  if (typeof (res as any).write !== 'function' || typeof (res as any).end !== 'function') return;
  (res as any)[INTERCEPTOR_FLAG] = true;

  const originalWrite = (res as any).write.bind(res);
  const originalEnd = (res as any).end.bind(res);

  const optsFor = renderOptsFor(req);
  const ownerEmail = ownerEmailFrom(req);

  /**
   * The context a descriptor runs in on this path. `remask` is the identity function — see
   * the MASKING note above — and that asymmetry with the after handler is deliberate.
   */
  const execCtx = (d: HostedToolDescriptor): ToolExecCtx => ({
    ownerEmail,
    replacementMap: (req as any).__pseudonymizationMap,
    maskingConfig: maskingConfigFrom(req),
    isStreaming: true,
    prepared: ((req as any)[PREPARED_FLAG] as Map<string, unknown> | undefined)?.get(d.type),
    remask: (text: string) => text,
    logger: pluginLogger,
  });

  let tail = '';                                    // partial block held across writes
  let queue: QueueItem[] = [];                      // items held while any call is in flight
  let pendingCalls = 0;                             // count of runCall invocations not yet settled
  let endPending = false;
  let endArgs: any[] = [];

  const suppressed = new Map<number, { descriptor: HostedToolDescriptor; callId: string; args: string }>();
  const pendingBlocksByIndex = new Map<number, string[]>();

  /**
   * Every result this request produced, per descriptor, for `annotateMessage`.
   *
   * Not part of the per-round state below (`roundResolved` is cleared at the top of every
   * continuation round, and the message that cites round one's passages arrives in round
   * two) and not owned by this closure either: the before handler's pending drain writes
   * into the same map, and on that shape it does so AFTER this interceptor is installed but
   * BEFORE the first frame arrives. See `resultsFor`.
   */
  const resultsByDescriptor = resultsFor(req);

  /**
   * The map to hand `annotateMessage` on this transport. ALWAYS the live one: this
   * interceptor is installed behind pseudonymization's own res.write, so every message it
   * sees is still masked and a descriptor computing offsets has to unmask a copy first.
   * Read lazily — pseudonymizationPlugin stashes it on the request before this handler runs,
   * but a masking-off request never stashes one at all.
   */
  const annotationMap = (): any => (req as any).__pseudonymizationMap;

  // Populated as each call resolves (independent of the others still in flight) so a later
  // response.completed/.incomplete/.failed can substitute the real result for that call_id
  // instead of re-running the tool.
  const completedByCallId = new Map<string, RenderedPair>();

  // ---------------------------------------------------------------- continuation state
  /** One call resolved in the round currently being assembled. */
  interface ResolvedCall {
    index: number;                    // client-facing output_index of the suppressed call
    descriptor: HostedToolDescriptor;
    callId: string;
    result: ToolExecResult;
    messageItem: any | null;          // the fallback result dump, emitted only if we stop here
    dumped: boolean;                  // true once the results reached the client some way
  }

  let continuationRunning = false;    // a continuation call is open (or being opened)
  let continuationFinished = false;   // the loop is over; the client's terminal frame is written
  let upstreamEnded = false;          // the FIRST call's stream is over (responsesController said so)
  let clientGone = false;             // the client disconnected; nothing more is worth paying for
  let activeContinuationStream: any = null;
  let droppedTerminal = false;        // at least one terminal frame was swallowed by a continuation
  let heldTerminal: { frame: any; rawBlock: string } | null = null;
  /** Calls actually run this request, per descriptor type: the cap is per tool, not per turn. */
  const callsRunByType = new Map<string, number>();
  let capReached = false;
  let indexOffset = 0;                // added to the current continuation's output_index values
  let sequenceOffset = 0;             // ditto for sequence_number, so it stays monotonic
  let maxIndexSeen = -1;              // highest client-facing output_index emitted so far
  let maxSequenceSeen = -1;
  let sawUsage = false;
  const accumulatedUsage = { input_tokens: 0, output_tokens: 0 };
  // Cache breakdown, summed per round the same way as accumulatedUsage's own two fields
  // (defect 5, streaming counterpart of the non-streaming merge below) — `noteUsage` is the
  // single producer for both. `output_tokens_details` has never been observed on this route;
  // it is summed and carried only if some round actually has one.
  // `cache_write_tokens` is the real Responses API field name (measured on real codex
  // traffic and on our own deployed path — see readCacheWriteTokens in usageFolding.ts);
  // this object is spread verbatim into the CLIENT-VISIBLE `input_tokens_details` below,
  // so the key here is the wire name, not the legacy internal one.
  const accumulatedUsageDetails = { cached_tokens: 0, cache_write_tokens: 0 };
  let sawOutputTokensDetails = false;
  let accumulatedReasoningTokens = 0;
  const countedUsageFrames = new WeakSet<any>();
  const clientItems: any[] = [];      // items already streamed, in order, as the client saw them
  let history: any[] | null = null;   // the conversation carried into the next continuation
  let roundItemsByIndex = new Map<number, any>();   // this round's output_item.done items
  let roundResolved: ResolvedCall[] = [];
  // The calls of the most recently COMMITTED round: their result dumps were withheld
  // because the continuation just opened was going to make them redundant. Kept past the
  // commit that clears `roundResolved`, for the one case where that bet loses completely.
  let withheldDumps: ResolvedCall[] = [];
  let roundCalls: Array<{ index: number; descriptor: HostedToolDescriptor; callId: string; args: string }> = [];
  let roundTerminal: { frame: any; rawBlock: string } | null = null;
  const idleWaiters: Array<() => void> = [];

  const upstreamCtx = (): any => (req as any).__responsesUpstream;
  const isBusy = (): boolean => pendingCalls > 0 || continuationRunning;
  /** Whether a (further) continuation call is possible at all right now. */
  const canContinue = (): boolean => {
    const upstream = upstreamCtx();
    return !!(upstream && upstream.url) && !capReached && !continuationFinished && !clientGone;
  };

  /** Resolve everyone waiting on the idle hook, once nothing is outstanding. */
  const notifyIdle = (): void => {
    if (isBusy()) return;
    const waiters = idleWaiters.splice(0, idleWaiters.length);
    for (const waiter of waiters) {
      try { waiter(); } catch { /* a waiter must never break the flush */ }
    }
  };

  // responsesController's forwardStream folds usage and closes the socket on the FIRST
  // call's 'end' event — which lands while the continuation is still open. This is how it
  // learns to wait; see utils/responsesStreamIdle.ts.
  (res as any)[RESPONSES_STREAM_IDLE_HOOK] = (): Promise<void> => (
    isBusy() ? new Promise<void>(resolve => { idleWaiters.push(resolve); }) : Promise.resolve()
  );

  /**
   * "The first call's stream is over." Called by the controller immediately BEFORE it
   * awaits the idle hook, and load-bearing for a stream that ends without a terminal
   * frame: the continuation then has neither a held terminal nor a deferred res.end to
   * key on, so without this the hook reports idle, usage is folded (at zero), the event
   * is emitted, and only the res.end that follows starts the continuation — whose tokens
   * are then billed to nobody. Signalling it here means the continuation is already
   * running the first time the hook is read.
   */
  (res as any)[RESPONSES_STREAM_UPSTREAM_END_HOOK] = (): void => {
    upstreamEnded = true;
    maybeStartContinuation();
  };

  /**
   * "The client is gone." Called from responsesController's req 'close' handler, the same
   * signal it uses to destroy the first upstream stream. Codex aborts turns routinely, and
   * an abandoned request must not go on to OPEN a fresh deployment call — nor keep one
   * open — for a response nobody will read.
   */
  (res as any)[RESPONSES_STREAM_ABORT_HOOK] = (): void => {
    if (clientGone) return;
    clientGone = true;
    if (activeContinuationStream) {
      pluginLogger.warn('responsesWebSearchPlugin: the client disconnected; abandoning the hosted-tool continuation');
      try { activeContinuationStream.destroy?.(); } catch { /* already gone */ }
    }
  };

  const noteIndex = (index: number): void => { if (index > maxIndexSeen) maxIndexSeen = index; };
  const noteSequence = (n: number): void => { if (n > maxSequenceSeen) maxSequenceSeen = n; };

  /**
   * Fold a terminal frame's usage into the running totals. `bill` is false for the FIRST
   * call only: responsesController already reads that one off the captured raw stream, so
   * adding it to `__responsesExtraUsage` too would bill it twice. `accumulatedUsage`, by
   * contrast, is what the CLIENT sees on the final frame and must span every call.
   * De-duplicated by frame identity because a flush that throws leaves the queue — and
   * hence the terminal item — retained for a later replay.
   */
  const noteUsage = (frame: any, bill: boolean): void => {
    const usage = frame?.response?.usage;
    if (!usage || typeof frame !== 'object' || countedUsageFrames.has(frame)) return;
    countedUsageFrames.add(frame);
    sawUsage = true;
    accumulatedUsage.input_tokens += usage.input_tokens || 0;
    accumulatedUsage.output_tokens += usage.output_tokens || 0;
    accumulatedUsageDetails.cached_tokens += usage.input_tokens_details?.cached_tokens ?? 0;
    accumulatedUsageDetails.cache_write_tokens += readCacheWriteTokens(usage.input_tokens_details);
    if (usage.output_tokens_details) {
      sawOutputTokensDetails = true;
      accumulatedReasoningTokens += usage.output_tokens_details.reasoning_tokens ?? 0;
    }
    if (!bill) return;
    noteExtraUsage(req, usage);
  };

  /** The stand-in pair for a call that produced no usable result. */
  const failedPlaceholder = (d: HostedToolDescriptor, call: ParsedCall): RenderedPair =>
    renderPair(req, d, failedResult(call), optsFor, pluginLogger);

  /**
   * Resolve an item whose `.added` we suppressed but whose `.done` never arrived — a
   * `response.incomplete` from hitting max_output_tokens mid-call, or an upstream
   * truncation. Suppression already swallowed its frames, so letting the raw function_call
   * survive inside the terminal frame's `response.output` would leave Codex with a hosted
   * tool call that has no output_item events at all: exactly the failure this interceptor
   * exists to prevent. Substitute the failed placeholder and remember it, so a
   * re-substitution of the same frame stays stable.
   *
   * A suppressed entry with no call_id (upstream omitted it on `.added` and no `.done` ever
   * supplied the fallback) is matched too — it can only have come from a swallowed item,
   * and leaving it stranded is the very leak being closed here.
   */
  const resolveStranded = (item: any): RenderedPair | undefined => {
    if (suppressed.size === 0) return undefined;
    const callId = typeof item.call_id === 'string' ? item.call_id : undefined;

    let stranded: [number, { descriptor: HostedToolDescriptor; callId: string; args: string }] | undefined;
    for (const candidate of suppressed.entries()) {
      if (candidate[1].callId === callId || !candidate[1].callId) { stranded = candidate; break; }
    }
    if (!stranded) return undefined;

    suppressed.delete(stranded[0]);
    const descriptor = stranded[1].descriptor;
    const placeholder = failedPlaceholder(
      descriptor,
      descriptor.parseCall(callId || '', stranded[1].args || (typeof item.arguments === 'string' ? item.arguments : '')),
    );
    if (callId) completedByCallId.set(callId, placeholder);
    pluginLogger.warn(`responsesWebSearchPlugin: hosted-tool item at output_index ${stranded[0]} never completed; substituting a failed call item`);
    return placeholder;
  };

  /**
   * `annotateItems` over a terminal frame's `response.output`, preserving frame identity
   * when nothing changed so `rebuildBlockWithSubstitution` can still return the raw block
   * byte for byte.
   */
  const annotateTerminal = (frame: any): any => {
    const output = frame?.response?.output;
    if (!Array.isArray(output)) return frame;
    const annotated = annotateItems(output, resultsByDescriptor, annotationMap(), pluginLogger);
    return annotated === output ? frame : { ...frame, response: { ...frame.response, output: annotated } };
  };

  /** Replace any hosted-tool function_call in a terminal frame's response.output. */
  const substituteOutput = (frame: any): any => {
    const resp = frame.response;
    if (!resp || !Array.isArray(resp.output)) return frame;

    let changed = false;
    const newOutput: any[] = [];
    for (const item of resp.output) {
      const found = isHostedToolCall(item)
        ? (typeof item.call_id === 'string' ? completedByCallId.get(item.call_id) : undefined)
          ?? resolveStranded(item)
        : undefined;
      if (found) {
        changed = true;
        pushPair(newOutput, found);
      } else {
        newOutput.push(item);
      }
    }
    return changed ? { ...frame, response: { ...resp, output: newOutput } } : frame;
  };

  /**
   * The frames announcing the synthetic hosted-tool call item at the suppressed index.
   *
   * The three `<tool>.{in_progress,searching,completed}` frames between `added` and
   * `done` mirror what OpenAI actually streams — captured 2026-08-06 from a real
   * `file_search` turn:
   *
   *   seq 2  output_index 0  response.output_item.added        item.type=file_search_call
   *   seq 3  output_index 0  response.file_search_call.in_progress
   *   seq 4  output_index 0  response.file_search_call.searching
   *   seq 5  output_index 0  response.file_search_call.completed
   *   seq 6  output_index 0  response.output_item.done         item.type=file_search_call
   *
   * The event name is built from the descriptor's own `type`, so `web_search` yields
   * `response.web_search_call.*` — OpenAI streams those too, and hardcoding
   * `file_search` here would have been wrong for the other descriptor.
   *
   * We emit all three back-to-back rather than at the real moments they describe: by the
   * time this runs the tool has already executed (the engine resolves every pending call
   * before writing anything). A client driving a progress indicator off these still sees
   * the correct lifecycle and terminal state; it just sees the transitions arrive
   * together. Emitting them at the true moments would mean writing frames before the
   * continuation's outcome is known, which the engine's one-continuation design does not
   * allow. Recorded in docs/notes/openai-parity-capture-2026-08-06.md.
   */
  const callItemBlocks = (index: number, callItem: any, descriptor: HostedToolDescriptor): string[] => [
    sseBlock({ type: 'response.output_item.added', output_index: index, item: callItem }),
    ...(descriptor.emitsCallLifecycleFrames ? [
      sseBlock({ type: `response.${descriptor.type}_call.in_progress`, output_index: index, item_id: callItem?.id }),
      sseBlock({ type: `response.${descriptor.type}_call.searching`, output_index: index, item_id: callItem?.id }),
      sseBlock({ type: `response.${descriptor.type}_call.completed`, output_index: index, item_id: callItem?.id }),
    ] : []),
    sseBlock({ type: 'response.output_item.done', output_index: index, item: callItem }),
  ];

  /**
   * The formatted-result `message` frames — the whole turn's answer before the
   * continuation existed, and still the fallback whenever no continuation can deliver a
   * real one. Emitted at the same output_index as the call item they follow, for the
   * reason given at the injection site below.
   */
  const resultMessageBlocks = (index: number, messageItem: any): string[] => {
    const text = messageItem.content[0].text;
    return [
      sseBlock({ type: 'response.output_item.added', output_index: index, item: { ...messageItem, content: [] } }),
      sseBlock({
        type: 'response.content_part.added', output_index: index, content_index: 0,
        item_id: messageItem.id, part: { type: 'output_text', text: '', annotations: [] },
      }),
      sseBlock({
        type: 'response.output_text.delta', output_index: index, content_index: 0,
        item_id: messageItem.id, delta: text,
      }),
      sseBlock({
        type: 'response.output_text.done', output_index: index, content_index: 0,
        item_id: messageItem.id, text,
      }),
      sseBlock({
        type: 'response.content_part.done', output_index: index, content_index: 0,
        item_id: messageItem.id, part: messageItem.content[0],
      }),
      sseBlock({ type: 'response.output_item.done', output_index: index, item: messageItem }),
    ];
  };

  /**
   * Whether this terminal frame belongs to the client or is about to be swallowed by a
   * continuation. Only a `response.completed` is continued: `.incomplete` (the model ran
   * out of output tokens mid-call) and `.failed` describe a turn that never finished, and
   * POSTing it back would ask the deployment to continue from a truncated function_call.
   */
  const willBeContinued = (frame: any): boolean => (
    canContinue() && frame?.type === 'response.completed' && roundResolved.length > 0
  );

  /**
   * Emit or, while any call or continuation is outstanding, queue a raw block.
   *
   * The non-empty-queue half of the guard is what keeps replay in order after a flush that
   * threw: `flushIfIdle`'s catch deliberately RETAINS whatever it had not yet replayed, and
   * by then `isBusy()` can already be false — so writing the next block straight through
   * would put it on the wire ahead of blocks that arrived before it. Narrow (a torn socket
   * is the only way to get there) and self-limiting, but ordering is the one thing this
   * queue exists to guarantee.
   */
  const emitRaw = (block: string): void => {
    if (isBusy() || queue.length > 0) queue.push({ kind: 'raw', block });
    else originalWrite(block);
  };

  /**
   * Write a terminal frame the client is keeping, and close the turn.
   *
   * Closing it here is load-bearing, not bookkeeping. `maybeStartContinuation` also fires
   * on a deferred res.end, so without this a terminal that `willBeContinued` rejected —
   * `.incomplete`, which is exactly what a deployment sends when max_output_tokens is hit
   * mid-turn, and Codex sets max_output_tokens on every request — was written to the
   * client and THEN continued by the res.end that followed: frames after the client's
   * terminal frame (a protocol violation) and a deployment call billed to nobody.
   *
   * The withheld result dump goes out first for the same reason: `runCall` buffered only
   * the call item because a continuation looked likely, so this is the last chance to give
   * the client what the tool produced — and `substituteOutput` is about to name that
   * message item in `response.output`, where it would otherwise be an item with no events.
   */
  const writeClosingTerminal = (frame: any, rawBlock: string): void => {
    emitPendingDumps();
    continuationFinished = true;
    // ANNOTATION SITE 3b, the counterpart of site 3 for every terminal frame NO continuation
    // took over — the pending-drain shape above all, where `roundResolved` is empty so
    // `maybeStartContinuation` never fires and `writeFinalTerminal` is never reached at all.
    // Verified by test, not assumed: without this the drain shape's terminal frame carries
    // the citing message with an empty annotation list while its own output_item.done
    // carries the citations.
    originalWrite(rebuildBlockWithSubstitution(rawBlock, frame, annotateTerminal(substituteOutput(frame))));
  };

  /** Emit, hold for the continuation, or queue a terminal frame. */
  const emitTerminal = (frame: any, rawBlock: string): void => {
    if (isBusy()) {
      queue.push({ kind: 'terminal', frame, rawBlock });
      return;
    }
    if (willBeContinued(frame)) {
      heldTerminal = { frame, rawBlock };
      noteUsage(frame, false);
      maybeStartContinuation();
      return;
    }
    writeClosingTerminal(frame, rawBlock);
  };

  /**
   * A terminal frame that will CLOSE the turn is already sitting in the queue, so the
   * result dumps withheld while a continuation still looked likely are going to be needed
   * after all — and they belong WITH their own call item pair rather than in one lump
   * after every pair, which is what emitting them at terminal-write time produces once two
   * parallel calls are involved. Fold each into its own index's buffered blocks before the
   * replay starts. An index whose blocks were already flushed by an earlier pass has
   * nothing left to fold into; `emitPendingDumps` still covers it.
   */
  const inlineDumpsForClosingTurn = (): void => {
    if (!queue.some(item => item.kind === 'terminal' && !willBeContinued(item.frame))) return;
    for (const entry of roundResolved) {
      if (entry.dumped || !entry.messageItem) continue;
      const blocks = pendingBlocksByIndex.get(entry.index);
      if (!blocks) continue;
      entry.dumped = true;
      blocks.push(...resultMessageBlocks(entry.index, entry.messageItem));
    }
  };

  /**
   * Once no call is outstanding, replay the queue in arrival order, splicing each call
   * placeholder's buffered blocks in at the position it occupies. Guarded end to end: a
   * write throwing partway through (e.g. a torn-down socket) must not escape into runCall's
   * `finally` — `runCall` is invoked as a bare `void` call, so an escaping throw here would
   * both surface as an unhandled rejection and permanently strand pendingCalls's decrement
   * from ever reaching a flush, hanging the request to the streaming timeout with nothing
   * logged. On that path `queue` is deliberately left un-cleared — whatever wasn't yet
   * replayed stays queued for the next flush attempt instead of silently vanishing — but a
   * deferred res.end still gets a best-effort attempt, since a torn-down socket usually
   * means nothing further will actually be delivered either way.
   */
  const flushIfIdle = (): void => {
    if (isBusy()) return;

    try {
      inlineDumpsForClosingTurn();
      const pendingQueue = queue;
      for (const item of pendingQueue) {
        if (item.kind === 'raw') {
          originalWrite(item.block);
        } else if (item.kind === 'terminal') {
          // Held, not written, when a continuation is about to take over the turn: the
          // client's terminal frame is the LAST call's, not this one's.
          if (willBeContinued(item.frame)) {
            heldTerminal = { frame: item.frame, rawBlock: item.rawBlock };
            noteUsage(item.frame, false);
            continue;
          }
          writeClosingTerminal(item.frame, item.rawBlock);
        } else {
          const blocks = pendingBlocksByIndex.get(item.index);
          // Dropped only once they are actually on the wire: a write that throws
          // partway leaves the whole queue retained for a later attempt, and blocks
          // discarded up front would have nothing left to replay from.
          if (blocks) for (const block of blocks) originalWrite(block);
          pendingBlocksByIndex.delete(item.index);
        }
      }
      queue = [];

      if (pendingBlocksByIndex.size > 0) {
        // Every buffered call should have a matching placeholder consumed above; a
        // leftover here means one didn't, which is a bug elsewhere in this interceptor
        // rather than expected behavior — log it instead of silently dropping the data.
        pluginLogger.error(`responsesWebSearchPlugin: ${pendingBlocksByIndex.size} buffered tool result(s) had no queue placeholder`);
        pendingBlocksByIndex.clear();
      }

      // The turn is not over: the held terminal frame is about to be replaced by the
      // continuation's. Leave a deferred res.end deferred — the continuation is still
      // writing into this stream.
      if (maybeStartContinuation()) return;

      if (endPending) {
        endPending = false;
        originalEnd(...endArgs);
      }
    } catch (error: any) {
      pluginLogger.error(`responsesWebSearchPlugin: flush failed: ${error.message}`);
      if (endPending) {
        endPending = false;
        try { originalEnd(...endArgs); } catch { /* socket already gone; nothing more to do */ }
      }
    } finally {
      notifyIdle();
    }
  };

  /**
   * Run one hosted-tool call and build both shapes of injected frames for it. Shared by the
   * first call (which runs eagerly, as each item completes, to keep the stream moving) and
   * by every continuation round (which runs once its stream has ended, since a continuation
   * needs the WHOLE turn — every parallel call answered — before it can be POSTed at all).
   *
   * Enforces the cap of the call's OWN descriptor: a request that has exhausted its
   * web_search budget may still have file_search budget left. A call that finds no budget
   * left is answered with an empty, `failed` result rather than skipped, so it still gets a
   * function_call_output and client-facing items; `capReached` then blocks any further
   * continuation for the whole turn — POSTing a turn with an unanswerable call in it is the
   * malformed shape parallel calls risk, regardless of which tool ran out of budget.
   */
  const performCall = async (
    index: number, descriptor: HostedToolDescriptor, call: ParsedCall,
  ): Promise<{ callItem: any; messageItem: any | null; entry: ResolvedCall }> => {
    const maxCalls = descriptor.maxCallsPerRequest();
    const alreadyRun = callsRunByType.get(descriptor.type) || 0;
    let result: ToolExecResult;

    if (alreadyRun >= maxCalls) {
      capReached = true;
      result = failedResult(call, 'cap_reached');
      pluginLogger.warn(`responsesWebSearchPlugin: reached the ${descriptor.type} cap of ${maxCalls} for this request; not running the call at output_index ${index}`);
    } else {
      callsRunByType.set(descriptor.type, alreadyRun + 1);
      try {
        result = await descriptor.execute(call, execCtx(descriptor));
      } catch (error: any) {
        // A descriptor is supposed to return a failed result rather than throw; if it does
        // throw anyway the turn still owes this call a function_call_output.
        pluginLogger.error(`responsesWebSearchPlugin: the ${descriptor.type} call at output_index ${index} threw: ${error.message}`);
        result = failedResult(call);
      }
    }

    // Recorded BEFORE the items are built: if that build throws, the continuation still
    // has a function_call_output for this call and the turn it POSTs stays well-formed.
    const entry: ResolvedCall = {
      index, descriptor, callId: call.callId, result, messageItem: null, dumped: false,
    };
    roundResolved.push(entry);
    // Request-scoped, unlike `roundResolved`: the model's answer to THIS call arrives in
    // the next round, and every round after that may still refer back to it.
    noteResultForAnnotation(resultsByDescriptor, descriptor, result);

    // Same reasoning for the placeholder: if the build below throws, this is what a later
    // response.completed/.incomplete/.failed finds for this call_id — otherwise the client
    // would see the raw function_call pass through into the final output even though its
    // own output_item.added/.done were already suppressed, leaving an item with no
    // matching events. The second `.set` overwrites it once the real items exist.
    completedByCallId.set(call.callId, failedPlaceholder(descriptor, call));

    const callItem = descriptor.renderCallItem(result, optsFor(descriptor));
    cacheRenderedResult(req, descriptor, result, callItem, pluginLogger);
    const messageItem = descriptor.renderResultMessage(result);
    if (messageItem) synthesizedMessages.add(messageItem);
    entry.messageItem = messageItem;
    completedByCallId.set(call.callId, { callItem, messageItem });

    return { callItem, messageItem, entry };
  };

  const runCall = async (index: number, descriptor: HostedToolDescriptor, call: ParsedCall): Promise<void> => {
    try {
      const { callItem, messageItem, entry } = await performCall(index, descriptor, call);

      // The injected items intentionally keep the suppressed function_call's own
      // output_index rather than being renumbered onto fresh indices — renumbering
      // every subsequent upstream index is riskier than this trade-off. Whether
      // Codex actually needs distinct indices per injected item will be settled by
      // the live acceptance gate.
      if (canContinue()) {
        // The continuation will write the real answer; the result dump would be a second,
        // redundant assistant message in front of it. Held back in `entry` in case the
        // continuation never happens after all (see emitPendingDumps).
        pendingBlocksByIndex.set(index, callItemBlocks(index, callItem, descriptor));
      } else {
        entry.dumped = true;
        pendingBlocksByIndex.set(index, [
          ...callItemBlocks(index, callItem, descriptor),
          ...(messageItem ? resultMessageBlocks(index, messageItem) : []),
        ]);
      }
    } catch (error: any) {
      // Covers failures in building/buffering the injected frames themselves
      // (as opposed to the tool call, which has its own inner try/catch above) —
      // e.g. a torn-down socket. Nothing is buffered for this index (the queued
      // placeholder splices in nothing), but the counter still has to drain so
      // sibling calls and a deferred res.end are never stuck waiting on a call
      // that will never finish.
      pluginLogger.error(`responsesWebSearchPlugin: failed to build injected frames for output_index ${index}: ${error.message}`);
    } finally {
      pendingCalls -= 1;
      flushIfIdle();
    }
  };

  // ------------------------------------------------------------------ continuation call

  /**
   * The items a finished call produced. The terminal frame's `response.output` is the
   * authoritative list — it carries fields the per-item frames may not, a `reasoning`
   * item's `encrypted_content` above all — but a deployment that sends an empty one (or
   * a run that ended with no terminal frame at all) still has to yield a well-formed
   * turn, so the `output_item.done` items collected during the stream stand in.
   */
  const roundOutputItems = (frame: any): any[] => {
    const output = frame?.response?.output;
    if (Array.isArray(output) && output.length > 0) return output;
    return [...roundItemsByIndex.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]);
  };

  /**
   * The same items as the CLIENT saw them: every hosted-tool function_call replaced by the
   * synthetic call item whose frames were injected in its place. A raw function_call in the
   * final `response.output` is precisely the leak this interceptor exists to prevent — it
   * would be an item with no output_item events at all. Shared with the non-streaming
   * continuation loop, which owes the client the same array.
   */
  const roundClientItems = (items: any[]): any[] => clientVisibleItems(req, items, completedByCallId, optsFor, pluginLogger);

  /**
   * Emit the formatted-result message for every call of the current round that has not
   * otherwise reached the client. Called only when the turn stops here: the results are
   * then the client's ONLY view of what the tool produced.
   */
  const emitPendingDumps = (): void => {
    for (const entry of roundResolved) {
      if (entry.dumped || !entry.messageItem) continue;
      entry.dumped = true;
      for (const block of resultMessageBlocks(entry.index, entry.messageItem)) originalWrite(block);
    }
  };

  /**
   * Hand over the dumps a committed continuation was expected to make unnecessary, after
   * that continuation turned out to deliver nothing at all — not one output item and no
   * terminal frame of its own. `emitPendingDumps` cannot do this: committing marks the
   * entries dumped and the round that follows replaces `roundResolved` outright, so by the
   * time the failure is visible those calls are no longer "the current round". Without this
   * the client is left with a call item and a synthesized, empty terminal — strictly worse
   * than the result dump this feature replaced. Each message is spliced into `clientItems`
   * directly behind the call item it belongs to, so the terminal frame names it and it is
   * never an item with no output_item events.
   */
  const deliverWithheldDumps = (): void => {
    const withheld = withheldDumps;
    withheldDumps = [];
    for (const entry of withheld) {
      if (!entry.messageItem) continue;
      for (const block of resultMessageBlocks(entry.index, entry.messageItem)) originalWrite(block);
      const pair = completedByCallId.get(entry.callId);
      const at = pair ? clientItems.indexOf(pair.callItem) : -1;
      if (at >= 0) clientItems.splice(at + 1, 0, entry.messageItem);
      else clientItems.push(entry.messageItem);
    }
  };

  /**
   * Write the client's single terminal frame: the last call's, with every earlier call's
   * items prefixed onto `response.output` (so the array lines up with the output_index
   * values already streamed) and usage summed across every call.
   *
   * `continued` says how this last call's own hosted-tool calls were answered, and hence
   * what has to stand in their place: by the model, in a further call (just the call item),
   * or by the result dump this turn fell back to (the call item AND the `message` carrying
   * the results, exactly as the terminal substitution produces on the pre-continuation
   * path).
   */
  const writeFinalTerminal = (continued: boolean): void => {
    let synthesized = false;
    if (!heldTerminal && droppedTerminal) {
      // A continuation swallowed a terminal frame and then produced none of its own
      // (a stream that died mid-flight). Leaving the client with no terminal frame at all
      // would hang it until its own timeout, so stand one in.
      const frame = { type: 'response.completed', response: { id: syntheticId('resp'), status: 'completed', output: [] } };
      heldTerminal = { frame, rawBlock: sseBlock(frame) };
      synthesized = true;
      pluginLogger.warn('responsesWebSearchPlugin: the continuation produced no terminal frame; synthesizing response.completed');
    }
    if (!heldTerminal) return;

    const { frame, rawBlock } = heldTerminal;
    heldTerminal = null;

    const response = frame.response || {};
    const roundOutput = roundOutputItems(frame);
    // The continuation delivered NOTHING — no terminal frame and not a single item. The
    // withheld result dumps are all the client is ever going to get for this turn, so
    // terminating with an empty response is not the only cost of stopping here. A
    // continuation that did stream items before dying keeps its partial answer instead:
    // the dump would then be a redundant second message in front of it.
    if (synthesized && roundOutput.length === 0) deliverWithheldDumps();
    // ANNOTATION SITE 3 of SIX — 1, 1b, 2, 2b, 3, 3b. The design named three; the
    // pending-drain shape and the non-continued terminal needed three more. See
    // chapter-16's table for the full list.
    //
    // This frame rebuilds `response.output` wholesale from items
    // that never passed through site 2 (the terminal's own array is the deployment's, and
    // `clientItems` holds the originals collected at commit time), so a client that reads
    // only the terminal frame — a perfectly ordinary way to consume this stream — would
    // otherwise see no citations at all. The items are replaced, never mutated: the same
    // objects are what `history` carries into a continuation POST.
    const output = annotateItems([
      ...clientItems,
      ...(continued ? roundClientItems(roundOutput) : replaceHostedToolCalls(req, roundOutput, completedByCallId, optsFor, pluginLogger)),
    ], resultsByDescriptor, annotationMap(), pluginLogger);
    const finalFrame: any = { ...frame, response: { ...response, output } };
    if (sawUsage) {
      // Same treatment as the non-streaming path's merge (defect 5): sum the cache
      // breakdown across rounds instead of carrying the last frame's, and recompute
      // `total_tokens` from the summed input/output rather than passing the last frame's
      // through, so the merged object satisfies the same input-is-inclusive identity a
      // single-round object does.
      finalFrame.response.usage = {
        ...(response.usage || {}),
        input_tokens: accumulatedUsage.input_tokens,
        output_tokens: accumulatedUsage.output_tokens,
        input_tokens_details: { ...accumulatedUsageDetails },
        total_tokens: accumulatedUsage.input_tokens + accumulatedUsage.output_tokens,
      };
      if (sawOutputTokensDetails) {
        finalFrame.response.usage.output_tokens_details = { reasoning_tokens: accumulatedReasoningTokens };
      }
    }
    originalWrite(rebuildBlockWithSubstitution(rawBlock, frame, finalFrame));
  };

  /** The turn stops here: hand the client the results it would otherwise never see. */
  const stopWithoutContinuing = (): void => {
    emitPendingDumps();
    writeFinalTerminal(false);
  };

  /** Apply this round's index/sequence offsets, without mutating the parsed frame. */
  const shiftFrame = (frame: any, clientIndex: number | null): any => {
    const shiftIndex = clientIndex !== null && clientIndex !== frame.output_index;
    const shiftSequence = typeof frame.sequence_number === 'number' && sequenceOffset !== 0;
    if (!shiftIndex && !shiftSequence) return frame;
    const shifted = { ...frame };
    if (shiftIndex) shifted.output_index = clientIndex;
    if (shiftSequence) shifted.sequence_number = frame.sequence_number + sequenceOffset;
    return shifted;
  };

  /**
   * One SSE block from a continuation stream. Mirrors patchedWrite's frame handling —
   * suppression, argument accumulation, item collection — with the frames the client has
   * already been given (`response.created` / `.in_progress`) dropped and every index
   * shifted past what earlier calls already used.
   */
  const processContinuationBlock = (rawBlock: string): void => {
    const frame = parseFrame(rawBlock);
    if (!frame) { originalWrite(rawBlock); return; }        // comment / keep-alive: pass through
    if (frame.type === 'response.created' || frame.type === 'response.in_progress') return;

    const index = typeof frame.output_index === 'number' ? frame.output_index + indexOffset : null;
    const shifted = shiftFrame(frame, index);

    if (typeof shifted.sequence_number === 'number') noteSequence(shifted.sequence_number);

    if (TERMINAL_RESPONSE_TYPES.has(frame.type)) {
      roundTerminal = { frame: shifted, rawBlock };
      noteUsage(shifted, true);
      return;
    }

    if (index === null) { originalWrite(rebuildBlockWithSubstitution(rawBlock, frame, shifted)); return; }
    noteIndex(index);

    const addedDescriptor = frame.type === 'response.output_item.added'
      ? descriptorForCall(frame.item)
      : undefined;
    if (addedDescriptor) {
      suppressed.set(index, {
        descriptor: addedDescriptor, callId: frame.item.call_id, args: frame.item.arguments || '',
      });
      return;                                              // suppressed
    }

    const tracked = suppressed.get(index);
    if (tracked) {
      if (frame.type === 'response.function_call_arguments.delta') {
        tracked.args += frame.delta ?? '';
      } else if (frame.type === 'response.function_call_arguments.done') {
        if (typeof frame.arguments === 'string') tracked.args = frame.arguments;
      } else if (frame.type === 'response.output_item.done') {
        if (frame.item && typeof frame.item.arguments === 'string') tracked.args = frame.item.arguments;
        if (!tracked.callId && frame.item && typeof frame.item.call_id === 'string') tracked.callId = frame.item.call_id;
        suppressed.delete(index);
        if (frame.item) roundItemsByIndex.set(index, frame.item);
        roundCalls.push({ index, descriptor: tracked.descriptor, callId: tracked.callId, args: tracked.args });
      }
      return;                                              // every frame of a suppressed item
    }

    if (frame.type === 'response.output_item.done' && frame.item) {
      // The ORIGINAL item, deliberately: this is what `history` POSTs back to the
      // deployment, and it must stay masked and un-annotated.
      roundItemsByIndex.set(index, frame.item);

      // ANNOTATION SITE 2 of SIX (1, 1b, 2, 2b, 3, 3b — see site 3's note and
      // chapter-16's table). This frame carries the item's COMPLETE `content[0].text`,
      // which is what makes annotating without buffering possible at all — the deltas
      // before it never know the whole message. Only the annotated COPY goes on the wire.
      const annotated = annotateItem(frame.item, resultsByDescriptor, annotationMap(), pluginLogger);
      if (annotated !== frame.item) {
        originalWrite(rebuildBlockWithSubstitution(rawBlock, frame, { ...shifted, item: annotated }));
        return;
      }
    }
    originalWrite(rebuildBlockWithSubstitution(rawBlock, frame, shifted));
  };

  /**
   * Drain one continuation stream, resolving when it ends, errors, closes or stalls past
   * the configured timeout. Never rejects: whatever arrived is what the round produced,
   * and the caller decides what to do with a round that has no terminal frame.
   */
  const readContinuationStream = async (stream: any, timeoutMs: number): Promise<void> => {
    // The REPLY-side twin of `buildContinuationPayload`. An upstream that needed its own
    // request shape needs its own response shape too: orchestration answers with
    // `data: {"final_result":{"choices":[{"delta":…}]}}`, which carries no `type` and no
    // `output_index`, so feeding it to `processContinuationBlock` below would pass every
    // chunk through `originalWrite` verbatim and write chat deltas into the client's
    // Responses stream. When present, this translates each raw block into Responses frames
    // BEFORE the engine's own frame pipeline sees them; absent, the stream is already
    // Responses-shaped and reaches that pipeline untouched, exactly as before.
    const blockTranslator = typeof upstreamCtx()?.createContinuationStreamTranslator === 'function'
      ? upstreamCtx().createContinuationStreamTranslator()
      : null;
    const feed = (rawBlock: string): void => {
      if (!blockTranslator) { processContinuationBlock(rawBlock); return; }
      for (const translated of blockTranslator.onBlock(rawBlock)) processContinuationBlock(translated);
    };

    indexOffset = maxIndexSeen + 1;
    sequenceOffset = maxSequenceSeen + 1;
    roundItemsByIndex = new Map();
    roundResolved = [];
    roundCalls = [];
    roundTerminal = null;

    // The abort may have landed while the POST that produced this stream was still in
    // flight — a window in which nothing was registered as active for it to destroy. This
    // is the only place that catches that ordering; without it the body is read to
    // completion for a client that is already gone.
    if (clientGone) {
      try { stream?.destroy?.(); } catch { /* already gone */ }
      return;
    }

    let pending = '';
    activeContinuationStream = stream;
    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const done = (): void => {
        if (settled) return;
        settled = true;
        activeContinuationStream = null;
        if (timer) clearTimeout(timer);
        resolve();
      };

      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          pluginLogger.error(`responsesWebSearchPlugin: the continuation stream stalled after ${timeoutMs}ms; abandoning it`);
          try { stream?.destroy?.(); } catch { /* already gone */ }
          done();
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }

      stream.on('data', (chunk: any) => {
        try {
          pending += chunk?.toString?.('utf8') ?? String(chunk);
          const { blocks, tail: rest } = splitBlocks(pending);
          pending = rest;
          for (const block of blocks) feed(block);
        } catch (error: any) {
          pluginLogger.error(`responsesWebSearchPlugin: failed to process a continuation frame: ${error.message}`);
        }
      });
      stream.on('end', done);
      stream.on('close', done);
      stream.on('error', (error: any) => {
        pluginLogger.error(`responsesWebSearchPlugin: the continuation stream errored: ${error?.message || error}`);
        done();
      });
    });

    // A translated stream has no terminal frame of its own — orchestration closes with
    // `[DONE]`, not with `response.completed` — so the round would otherwise end with
    // `roundTerminal` null and its text item never closed. `finish()` supplies the closing
    // frames; it is safe on a stream that produced nothing, and MUST run before this
    // returns, because the caller reads `roundTerminal` and `roundCalls` immediately after.
    if (blockTranslator) {
      try {
        for (const translated of blockTranslator.finish()) processContinuationBlock(translated);
      } catch (error: any) {
        pluginLogger.error(`responsesWebSearchPlugin: failed to close a translated continuation round: ${error.message}`);
      }
    }
  };

  /**
   * The continuation loop. Each pass POSTs the whole conversation so far back to the same
   * deployment with `stream: true`, splices the reply into the client's stream, and — if
   * that reply asks for more tool calls — runs them and goes round again.
   *
   * Deliberately serial: a continuation may only be POSTed once EVERY hosted-tool call of
   * the round it continues has a function_call_output, or the deployment rejects the turn.
   *
   * Bounded by ONE wall-clock deadline for the whole loop, not just by the round cap.
   * responsesController allows the entire splice a single `getTimeout(true)` idle budget —
   * the same value it stashes here as `timeoutMs` — while the loop's own ceiling is
   * `max_searches_per_request` rounds of (a tool call + a per-stream watchdog), tens of
   * minutes at the default cap. When the controller's budget expired first it emitted usage
   * counting only the rounds finished by then and called `res.end()`, which this
   * interceptor defers while it is busy: the client was left holding a stalled-but-open SSE
   * socket for the remaining difference, and the later rounds' tokens landed in an
   * accumulator nobody would read again. Sharing one clock makes the two agree instead of
   * race. A context with no timeout (never the case from responsesController) simply keeps
   * the pre-existing round-cap-only bound.
   */
  const runContinuationLoop = async (): Promise<void> => {
    try {
      // Read here rather than at install time: the before handler's pending drain appends
      // to req.body.input after the interceptor is installed.
      if (history === null) history = normalizeInputToItems(req.body?.input);

      const budgetMs = upstreamCtx()?.timeoutMs || 0;
      const deadlineAt = budgetMs > 0 ? Date.now() + budgetMs : 0;

      for (;;) {
        const upstream = upstreamCtx();
        if (deadlineAt && Date.now() >= deadlineAt) {
          pluginLogger.warn(`responsesWebSearchPlugin: the hosted-tool continuation exceeded its ${budgetMs}ms budget; closing the turn with what it has`);
          stopWithoutContinuing();
          return;
        }
        const finishedRound = heldTerminal;
        const roundOutput = roundOutputItems(finishedRound?.frame);

        // Accumulated, never re-derived from req.body.input: a later round would
        // otherwise drop everything an earlier one contributed and the model would
        // re-enter with no memory of having already called the tool.
        history = [
          ...history,
          ...roundOutput,
          ...roundResolved.map(entry => entry.descriptor.renderOutput(entry.result)),
        ];

        let response: any;
        try {
          // `upstream.payload` is stashed by reference — spread rather than mutate, or the
          // next round would inherit this round's input. `stream: true` is already on the
          // Responses-shaped payload (this loop only runs on a streaming turn); an
          // orchestration body has its own `config.stream.enabled` set by the builder and
          // no top-level `stream` key to spread onto — see continuationBody's docstring.
          response = await axios.post(
            upstream.url,
            continuationBody(upstream, history),
            { headers: upstream.headers, timeout: upstream.timeoutMs, responseType: 'stream' },
          );
        } catch (error: any) {
          pluginLogger.error(`Hosted-tool continuation stream failed: ${error.message}`);
          stopWithoutContinuing();
          return;
        }

        // Committed: the round just finished is now part of what the client has seen, its
        // terminal frame is swallowed, and its calls are answered by the model rather
        // than by a result dump. Those withheld dumps are remembered, and nothing else, in
        // case the call just opened delivers nothing at all — see deliverWithheldDumps.
        for (const item of roundClientItems(roundOutput)) clientItems.push(item);
        withheldDumps = roundResolved.filter(entry => !entry.dumped && !!entry.messageItem);
        for (const entry of roundResolved) entry.dumped = true;
        if (finishedRound) droppedTerminal = true;
        heldTerminal = null;

        await readContinuationStream(response.data, upstream.timeoutMs);

        // The client hung up mid-stream (its stream was destroyed by the abort hook).
        // Writing a terminal frame into a dead socket, let alone running another tool call
        // and paying for another deployment call, buys nothing — leave the close to the
        // deferred res.end this returns into.
        if (clientGone) return;

        if (roundCalls.length === 0) {                     // the model answered: done
          heldTerminal = roundTerminal;
          writeFinalTerminal(true);
          return;
        }

        // Every call of this round first — the cap may only be reached partway through,
        // and whether the results need a dump depends on the round as a whole. Sequential
        // on purpose: `performCall` increments the per-descriptor count as it goes, and
        // the resolution order is what the continuation's function_call_output order is
        // built from.
        const resolved: Array<{ index: number; callItem: any; messageItem: any | null; entry: ResolvedCall; descriptor: HostedToolDescriptor }> = [];
        for (const call of roundCalls) {
          const parsed = call.descriptor.parseCall(call.callId, call.args);
          const { callItem, messageItem, entry } = await performCall(call.index, call.descriptor, parsed);
          resolved.push({ index: call.index, callItem, messageItem, entry, descriptor: call.descriptor });
        }

        const continuable = canContinue() && roundTerminal?.frame?.type === 'response.completed';
        for (const item of resolved) {
          for (const block of callItemBlocks(item.index, item.callItem, item.descriptor)) originalWrite(block);
          if (continuable) continue;
          item.entry.dumped = true;
          if (!item.messageItem) continue;
          for (const block of resultMessageBlocks(item.index, item.messageItem)) originalWrite(block);
        }

        heldTerminal = roundTerminal;
        if (!continuable) { writeFinalTerminal(false); return; }
      }
    } catch (error: any) {
      pluginLogger.error(`responsesWebSearchPlugin: the hosted-tool continuation failed: ${error.message}`);
      try { stopWithoutContinuing(); } catch { /* socket already gone */ }
    } finally {
      continuationRunning = false;
      continuationFinished = true;
      // Drains anything queued behind the continuation and honours a deferred res.end.
      flushIfIdle();
    }
  };

  /**
   * Start the continuation once the first call is genuinely over: no tool call outstanding,
   * and one of the three signals that the turn is finished — its terminal frame in hand,
   * the controller reporting the upstream stream ended, or a res.end already deferred.
   * All three are needed: a stream can end without a terminal frame, and whichever signal
   * arrives first has to be the one that starts the call, or the tokens it spends land
   * after the usage event has already been emitted. Returns whether it took over the turn.
   */
  function maybeStartContinuation(): boolean {
    if (continuationRunning || continuationFinished) return false;
    if (pendingCalls > 0) return false;
    if (!canContinue() || roundResolved.length === 0) return false;
    if (!heldTerminal && !endPending && !upstreamEnded) return false;
    continuationRunning = true;
    void runContinuationLoop();
    return true;
  }

  (res as any).write = function patchedWrite(chunk: any, ..._rest: any[]): boolean {
    try {
      tail += chunk?.toString?.('utf8') ?? String(chunk);
      const { blocks, tail: newTail } = splitBlocks(tail);
      tail = newTail;

      for (const block of blocks) {
        const frame = parseFrame(block);

        if (frame && typeof frame.sequence_number === 'number') noteSequence(frame.sequence_number);

        if (frame && TERMINAL_RESPONSE_TYPES.has(frame.type)) {
          emitTerminal(frame, block);
          continue;
        }

        if (!frame || typeof frame.output_index !== 'number') { emitRaw(block); continue; }

        const index = frame.output_index;
        // Every index the client is given, injected call-item frames included —
        // the continuation's own indices are shifted past the highest of them.
        noteIndex(index);

        const addedDescriptor = frame.type === 'response.output_item.added'
          ? descriptorForCall(frame.item)
          : undefined;
        if (addedDescriptor) {
          suppressed.set(index, {
            descriptor: addedDescriptor, callId: frame.item.call_id, args: frame.item.arguments || '',
          });
          continue;                                    // suppressed
        }

        const tracked = suppressed.get(index);
        if (!tracked) {
          if (frame.type === 'response.output_item.done' && frame.item) {
            // Collected for the continuation's `input`: what the model produced this turn
            // has to be carried forward, reasoning items above all. The ORIGINAL, always.
            roundItemsByIndex.set(index, frame.item);

            // ANNOTATION SITE 2b. Its whole reason for existing is the PENDING-DRAIN shape,
            // where the tools ran in the before handler and this first response is already
            // the citing message — there is no continuation stream for site 2 to read. On
            // every other shape `resultsByDescriptor` is still empty when a first-round
            // message finishes (its calls resolve after it), `annotateItem` returns the same
            // object, and `emitRaw(block)` below writes the untouched raw bytes.
            const annotated = annotateItem(frame.item, resultsByDescriptor, annotationMap(), pluginLogger);
            if (annotated !== frame.item) {
              emitRaw(rebuildBlockWithSubstitution(block, frame, { ...frame, item: annotated }));
              continue;
            }
          }
          emitRaw(block);
          continue;
        }

        if (frame.type === 'response.function_call_arguments.delta') {
          tracked.args += frame.delta ?? '';
          continue;
        }
        if (frame.type === 'response.function_call_arguments.done') {
          if (typeof frame.arguments === 'string') tracked.args = frame.arguments;
          continue;
        }
        if (frame.type === 'response.output_item.done') {
          if (frame.item && typeof frame.item.arguments === 'string') tracked.args = frame.item.arguments;
          // Defensive: OpenAI always sends call_id on `.added`, but without it
          // completedByCallId would be keyed `undefined`, substituteOutput would miss,
          // and the raw function_call would leak into response.completed. The `.done`
          // frame carries the same item, so take the id from there when it is missing.
          if (!tracked.callId && frame.item && typeof frame.item.call_id === 'string') {
            tracked.callId = frame.item.call_id;
          }
          suppressed.delete(index);
          // The raw function_call is suppressed for the CLIENT but must be carried into
          // the continuation's input, or its function_call_output has nothing to pair with
          // and the deployment rejects the turn as malformed.
          if (frame.item) roundItemsByIndex.set(index, frame.item);
          pendingCalls += 1;
          // Mark this index's position in the stream now, synchronously, so items
          // that arrive later (e.g. a reasoning item at a different output_index, or a
          // sibling hosted-tool call) replay in the same relative order they arrived in —
          // not grouped by which call happens to resolve, or finish building, first.
          queue.push({ kind: 'call', index });
          void runCall(index, tracked.descriptor, tracked.descriptor.parseCall(tracked.callId, tracked.args));
          continue;
        }
        continue;                                      // any other frame for this item
      }
      return true;
    } catch (error: any) {
      // Deliberately does not fall back to writing the raw chunk: some of it may
      // already have been emitted above (duplicating those bytes), and a chunk
      // that carried a suppressed hosted-tool frame would reach Codex raw — the
      // exact failure this interceptor exists to prevent. Best effort is to drop
      // this chunk and keep the stream alive for whatever arrives next.
      pluginLogger.error(`responsesWebSearchPlugin interceptor error: ${error.message}`);
      return true;
    }
  };

  (res as any).end = function patchedEnd(...args: any[]): any {
    if (tail) {
      const finalTail = tail;
      tail = '';
      // Incomplete final block: best-effort pass-through, guarded — a throwing write
      // here (torn-down socket) must not stop the stream from being closed below.
      try { emitRaw(finalTail); } catch (error: any) {
        pluginLogger.error(`responsesWebSearchPlugin: failed to emit the trailing partial block: ${error.message}`);
      }
    }

    // Deferred unconditionally, and honoured by flushIfIdle below (or by whichever
    // later flush finds nothing outstanding). "The upstream stream is over" is not the
    // same as "the response is over" any more: the continuation writes into this same
    // stream. A stream that ends WITHOUT a terminal frame still owes the client an
    // answer, and this is what tells maybeStartContinuation the turn is finished — the
    // held terminal frame it usually keys on never arrived.
    endPending = true;
    endArgs = args;

    if (isBusy()) {
      maybeStartContinuation();
      return res;
    }
    // Drains anything a previously FAILED flush deliberately retained, and closes the
    // stream. Without this, a flush that threw with no deferred end pending left its
    // queue behind and the socket was closed on top of it — the whole response body
    // silently dropped with a clean stream close.
    flushIfIdle();
    return res;
  };
}

/**
 * The payload for a CONTINUATION call, with a `tool_choice` that forces a hosted
 * tool relaxed to `'auto'`.
 *
 * `tool_choice: 'required'` means "call a tool this turn". The continuation is a
 * new turn, so carrying it forward means the model MUST call again — and again,
 * until a cap stops it. Observed live 2026-08-07: a `file_search` request with
 * `tool_choice: 'required'` returned three `file_search_call` items and NO
 * message. The client asked to be sure a search happened and got no answer.
 *
 * The requirement has already been satisfied by the call whose result this
 * continuation is carrying, which is why relaxing it is not ignoring the
 * client's instruction — it is recognising the instruction as met. An object
 * choice naming one of OUR hosted tools (`{type: 'file_search'}`) loops for the
 * identical reason and is relaxed identically.
 *
 * VERIFIED AGAINST REAL OPENAI, 2026-08-07, rather than argued. `gpt-4o-mini`
 * with a `file_search` tool returned the SAME output shape for all three of
 * `tool_choice: "required"`, `{"type":"file_search"}` and `"auto"`:
 *
 *     ['file_search_call', 'message']
 *
 * One call, then an answer. So `required` binds the turn AS THE CLIENT SEES IT,
 * not each round-trip — which for OpenAI is not even a distinction, because
 * their hosted tools run inside one generation. We emulate that turn with
 * several deployment calls, and relaxing here is what makes our emulation carry
 * their semantics instead of the emulation's own accidental ones.
 *
 * Everything else is left exactly as sent: `'none'`, `'auto'`, and an object
 * naming a CLIENT function tool. That last one cannot loop here — a client
 * function call is not a hosted-tool call, so the continuation loop's own
 * `calls.length === 0` guard ends the turn on it.
 */
function relaxForcedToolChoice(payload: any): any {
  const choice = payload?.tool_choice;
  const forcesHostedTool = choice === 'required'
    || (!!choice && typeof choice === 'object' && !!descriptorForType(choice.type));
  if (!forcesHostedTool) return payload;
  return { ...payload, tool_choice: 'auto' };
}

/**
 * The body for a continuation POST.
 *
 * The Responses shape carries the conversation in `input`. Orchestration wants
 * `messages_history` inside a module envelope, and would reject `input`
 * outright — so an upstream that is not Responses-shaped supplies its own
 * builder. Absent one, this is exactly the pre-bridge behaviour.
 *
 * RELAXATION IS DECIDED HERE ON BOTH PATHS, and handed to the builder as a
 * value. It is the engine's rule, not the wire format's: it exists because we
 * emulate one hosted-tool turn with several round-trips, and it needs
 * `descriptorForType` to recognise a choice naming a hosted tool. The builder
 * owns only the SHAPE. Reading it off `upstream.payload` would not work for a
 * builder-supplied upstream either — an orchestration payload buries
 * `tool_choice` inside `config.modules.prompt_templating.model.params`, where
 * this function has no business looking — so the controller stashes the
 * client's own `tool_choice` alongside the builder as `upstream.toolChoice`.
 * Without this an orchestration turn re-forced `required` every round and burnt
 * to the cap, which is the exact live failure relaxForcedToolChoice was
 * introduced to fix.
 */
function continuationBody(upstream: any, history: any[]): any {
  if (typeof upstream?.buildContinuationPayload === 'function') {
    return upstream.buildContinuationPayload(history, {
      toolChoice: relaxForcedToolChoice({ tool_choice: upstream.toolChoice }).tool_choice,
    });
  }
  return { ...relaxForcedToolChoice(upstream.payload), input: history };
}

// ------------------------------------------------------------------------ before handler

/** Rewrite every hosted tool in `body.tools`, returning the descriptors that matched. */
function rewriteHostedTools(body: any): Array<{ descriptor: HostedToolDescriptor; hosted: any }> {
  const rewritten: Array<{ descriptor: HostedToolDescriptor; hosted: any }> = [];
  if (!body || !Array.isArray(body.tools)) return rewritten;

  body.tools = body.tools.map((tool: any) => {
    const descriptor = descriptorForHostedTool(tool);
    if (!descriptor) return tool;
    rewritten.push({ descriptor, hosted: tool });
    return descriptor.rewriteTool(tool);
  });

  // An empty `tools` array is removed rather than forwarded: some deployments reject
  // `"tools": []`.
  if (body.tools.length === 0) delete body.tools;
  return rewritten;
}

/**
 * A hosted-tool call from the previous turn whose output was never supplied. The client
 * replays the whole conversation (store: false), so this is how the model gets to reason
 * over tool results without a second deployment call inside one request.
 *
 * Back-to-front, most recent unsatisfied call first, exactly as before.
 */
function findPendingHostedToolCall(input: any): { descriptor: HostedToolDescriptor; item: any } | null {
  if (!Array.isArray(input)) return null;

  const satisfied = new Set<string>();
  for (const item of input) {
    if (item && item.type === 'function_call_output' && typeof item.call_id === 'string') {
      satisfied.add(item.call_id);
    }
  }

  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    const descriptor = descriptorForCall(item);
    if (!descriptor) continue;
    if (typeof item.call_id !== 'string' || satisfied.has(item.call_id)) continue;
    return { descriptor, item };
  }
  return null;
}

export async function hostedToolBeforeHandler({ req, res, utils }: PluginContext): Promise<PluginResult> {
  const pluginLogger = utils.logger;

  try {
    const body: any = req.body;
    if (!body) return { stop: false };

    if (!Array.isArray(body.tools) || !body.tools.some((t: any) => descriptorForHostedTool(t))) {
      return { stop: false };
    }

    const rewritten = rewriteHostedTools(body);
    (req as any)[REWROTE_FLAG] = true;
    for (const { descriptor } of rewritten) {
      pluginLogger.info(`Rewrote hosted ${descriptor.type} tool into a function tool`);
    }

    const ownerEmail = ownerEmailFrom(req);
    const prepared = new Map<string, unknown>();
    for (const { descriptor, hosted } of rewritten) {
      try {
        prepared.set(descriptor.type, await descriptor.prepare(hosted, { ownerEmail, logger: pluginLogger }));
      } catch (error: any) {
        const status = rejectionStatusOf(error);

        // THE CALLER'S MISTAKE, and this is the last moment it can be reported. For a
        // retrieval tool `prepare()` is the ONLY honest point in the flow: once the SSE
        // stream is open a typo'd `vector_store_id` is indistinguishable from an empty
        // corpus — both are "no passages found" — so an error swallowed here is never
        // surfaced at all, in any form, ever. Fail the request instead.
        //
        // `res.json` FIRST, then `{ stop: true }`. `PluginResult.response` is declared but
        // no controller reads it (`if (pluginResult?.stop) return;` — "Response already
        // sent by plugin"), so stopping without writing hangs the request.
        if (status !== undefined && sendPrepareRejection(res, status, error, pluginLogger)) {
          pluginLogger.error(`Rejecting the request: the hosted ${descriptor.type} tool could not be prepared: ${error.message}`);
          return { stop: true };
        }

        // INFRASTRUCTURE, or a response already committed elsewhere. One tool failing to
        // set itself up must not take the request down with it: the rewritten function
        // tool is already in `body.tools` and its execute() will decide what an unprepared
        // call means. (For file_search that decision is "refuse to search" — never a
        // fallback to unvalidated ids off the request body.)
        pluginLogger.error(`Failed to prepare the hosted ${descriptor.type} tool: ${error.message}`, { stack: error.stack });
      }
    }
    (req as any)[PREPARED_FLAG] = prepared;

    // Installed AFTER the prepare loop, deliberately. This monkey-patches `res.write` and
    // `res.end` with SSE-block-parsing versions, and a rejection written above would then
    // be pushed through them — a JSON error body fed to a frame splitter. Nothing between
    // the rewrite and here touches `res`, so the move costs nothing: the first write of the
    // turn is the deployment's first frame, which responsesController only starts producing
    // once this handler has returned.
    if (body.stream === true) {
      installHostedToolInterceptor(req, res, pluginLogger);
    }

    // Replayed hosted call items -> the function_call/function_call_output pair the model's
    // rewritten tool list uses. A cache hit restores the model's own prior tool use verbatim.
    // A miss used to leave the call unsatisfied so the drain below re-executed the recorded
    // query; measured live on 2026-08-11, that cost a real conversation its whole turn: four
    // replayed web_search_call items missed the cache, the drain re-ran three of them and hit
    // web_search's per-request cap of 3 on the fourth, and the model emitted no new tool call
    // that turn because history replay had already spent the entire budget. A miss now pairs
    // with a `not_retained` output instead, so replayed history never competes with the
    // model's own new work for the cap. Either way no `<type>_call` item reaches the
    // deployment, which has no tool of that type.
    if (Array.isArray(body.input)) {
      const owner = ownerEmail || '';
      const rewritten: any[] = [];
      for (const item of body.input) {
        const descriptor = descriptorForReplayedCallItem(item);
        if (!descriptor) { rewritten.push(item); continue; }

        const query = descriptor.replayQueryFrom?.(item) ?? '';
        if (!query) {
          pluginLogger.warn(`Dropping a replayed ${item.type} item with no recoverable query`);
          continue;
        }
        // No usable id means neither a cache key nor a valid call_id: guarded the same way
        // as the no-query case above, or an orphaned function_call (call_id: undefined) is
        // forwarded to the deployment, which the drain's `typeof call_id !== 'string'` check
        // then skips forever.
        if (typeof item.id !== 'string' || item.id.length === 0) {
          pluginLogger.warn(`Dropping a replayed ${item.type} item with no usable id`);
          continue;
        }

        rewritten.push(buildReplayFunctionCall(descriptor, item, query));

        const cached = getToolResult(item.id, owner);
        if (!cached || !descriptor.rehydratePayload) {
          rewritten.push(descriptor.renderOutput({
            call: descriptor.parseCall(item.id, JSON.stringify({ query })),
            status: 'failed',
            payload: null,
            error: { code: 'not_retained', message: '' },
          }));
          continue;
        }
        const payload = descriptor.rehydratePayload(cached.payload, {
          ownerEmail: owner,
          replacementMap: (req as any).__pseudonymizationMap,
          maskingConfig: maskingConfigFrom(req),
          isStreaming: body.stream === true,
          prepared: prepared.get(descriptor.type),
          remask: (text: string) => text,
          logger: pluginLogger,
        });
        rewritten.push(descriptor.renderOutput({
          call: descriptor.parseCall(item.id, JSON.stringify({ query })),
          status: 'completed',
          payload,
        }));
      }
      body.input = rewritten;
    }

    // Drain every pending call left from the previous turn. Codex CLI defaults
    // parallel_tool_calls to true, so more than one may be pending; findPendingHostedToolCall
    // only returns the most recent unsatisfied one, so we loop until none remain, bounded to
    // guarantee termination.
    //
    // Each call is caught individually: one tool failing must not leave a LATER pending
    // call (or this one) without a function_call_output, or the whole turn is malformed and
    // the deployment rejects it outright. On failure we still append an empty output so the
    // turn stays well-formed and the model can tell the user the tool was unavailable,
    // instead of every follow-up turn hard-failing for the duration of an outage.
    //
    // No re-masking here, deliberately: pseudonymizationPlugin runs FIRST on the request
    // side, so `body.input` — and hence these arguments — are already masked.
    //
    // CAPPED PER TOOL TYPE, THE SAME WAY performCall (above) CAPS A TURN'S OWN CALLS. Only
    // calls genuinely pending from the model's own tool use this turn reach this loop —
    // replayed history does not: the rewrite immediately above now resolves every replayed
    // item, hit or miss, into a paired function_call/function_call_output before this runs, so
    // it never leaves one unsatisfied for the drain to pick up. `MAX_PENDING_CALLS_PER_TURN`
    // still bounds how many pending calls this loop will even LOOK at; `callsRunByType` bounds,
    // within that, how many it will actually EXECUTE, so a turn can never run more live calls
    // of one tool type than `descriptor.maxCallsPerRequest()` allows anywhere else in this
    // engine. A call that finds no budget left is answered with a failed placeholder rather
    // than skipped — same reasoning as `performCall`'s own comment: skipping would leave it
    // unsatisfied, and an unanswered `function_call` is the malformed shape the deployment
    // rejects outright.
    const callsRunByType = new Map<string, number>();
    for (let i = 0; i < MAX_PENDING_CALLS_PER_TURN; i++) {
      const pending = findPendingHostedToolCall(body.input);
      if (!pending) break;

      const { descriptor, item } = pending;
      const call = descriptor.parseCall(item.call_id, typeof item.arguments === 'string' ? item.arguments : '');

      const maxCalls = descriptor.maxCallsPerRequest();
      const alreadyRun = callsRunByType.get(descriptor.type) || 0;

      let result: ToolExecResult;
      if (alreadyRun >= maxCalls) {
        result = failedResult(call, 'cap_reached');
        pluginLogger.warn(`Pending ${descriptor.functionName} call ${call.callId} left unexecuted: the ${descriptor.type} tool already reached its per-request cap of ${maxCalls}`);
      } else {
        callsRunByType.set(descriptor.type, alreadyRun + 1);
        pluginLogger.info(`Executing pending ${descriptor.functionName} call ${call.callId}`);
        try {
          result = await descriptor.execute(call, {
            ownerEmail,
            replacementMap: (req as any).__pseudonymizationMap,
            maskingConfig: maskingConfigFrom(req),
            isStreaming: body.stream === true,
            prepared: prepared.get(descriptor.type),
            remask: (text: string) => text,
            logger: pluginLogger,
          });
        } catch (error: any) {
          pluginLogger.error(`Pending ${descriptor.functionName} call ${call.callId} threw: ${error.message}`, { stack: error.stack });
          result = failedResult(call);
        }
      }
      if (result.status === 'failed') {
        pluginLogger.warn(`Pending ${descriptor.functionName} call ${call.callId} could not be served; appending a failed function_call_output so the turn stays well-formed`);
      }
      // THIS SHAPE IS THE ONE WHERE THE CITING MESSAGE IS THE MODEL'S FIRST RESPONSE, not
      // a continuation's: the call was answered here, before the deployment was asked
      // anything. Without this the whole turn annotates nothing at all.
      noteResultForAnnotation(resultsFor(req), descriptor, result);
      if (Array.isArray(body.input)) body.input.push(descriptor.renderOutput(result));
    }

    // Anything STILL pending once the loop above hits MAX_PENDING_CALLS_PER_TURN must still
    // get an output — never executed, only resolved as a failed placeholder — or the turn
    // reaches the deployment with an orphaned `function_call` and no output to pair it with,
    // which is the malformed shape the comment above already says gets rejected outright.
    // Bounded by `body.input.length` rather than looped unconditionally: each pass resolves
    // exactly one pending call (its output is pushed before the next findPendingHostedToolCall
    // scan), so the array's own length is a hard, structural bound on how many times this can
    // run — it is not a magic number chosen to "be big enough".
    for (let i = 0; i < body.input.length; i++) {
      const pending = findPendingHostedToolCall(body.input);
      if (!pending) break;

      const { descriptor, item } = pending;
      const call = descriptor.parseCall(item.call_id, typeof item.arguments === 'string' ? item.arguments : '');
      pluginLogger.warn(`Hit the ${MAX_PENDING_CALLS_PER_TURN}-call drain cap with ${descriptor.functionName} call ${call.callId} still pending; appending a failed function_call_output so the turn stays well-formed`);

      const result = failedResult(call);
      noteResultForAnnotation(resultsFor(req), descriptor, result);
      if (Array.isArray(body.input)) body.input.push(descriptor.renderOutput(result));
    }

    return { stop: false };
  } catch (error: any) {
    pluginLogger.error(`Error in responsesWebSearchPlugin beforeHandler: ${error.message}`, { stack: error.stack });
    return { stop: false };
  }
}

// ------------------------------------------------------------------------- after handler

export async function hostedToolAfterHandler({ req, upstreamResponse, utils }: PluginContext): Promise<any> {
  const pluginLogger = utils.logger;
  const optsFor = renderOptsFor(req);

  try {
    // Only handle responses to requests whose hosted tool WE rewrote. Without this guard,
    // any client sending its own function tool literally named `web_search` (matched by the
    // `tools:hasWebSearch` hook regex, but not a hosted tool) would have its function_call
    // silently swallowed and replaced with an unsolicited result.
    if (!(req as any)[REWROTE_FLAG]) return upstreamResponse;

    const output = upstreamResponse?.output;
    if (!Array.isArray(output)) return upstreamResponse;
    if (!output.some(isHostedToolCall)) {
      // ANNOTATION SITE 1b. Nothing to resolve — but the before handler's PENDING DRAIN may
      // already have run this request's tools out of a replayed conversation, in which case
      // this response IS the model's answer to them and is the only thing there will ever be
      // to annotate. `annotateResponse` returns `upstreamResponse` itself when the request
      // accumulated no annotatable results, so every other turn keeps this early return
      // exactly as it was.
      return annotateResponse(upstreamResponse, resultsFor(req), pluginLogger);
    }

    const upstream = (req as any).__responsesUpstream;
    const pseudonymizationMap = (req as any).__pseudonymizationMap;
    const ownerEmail = ownerEmailFrom(req);
    const preparedByType = (req as any)[PREPARED_FLAG] as Map<string, unknown> | undefined;

    /**
     * The context a descriptor runs in on this path. `remask` is real here: this handler
     * runs AFTER pseudonymizationPlugin has unmasked the model's `function_call` arguments
     * in place, so anything derived from them carries raw PII and must be re-masked before
     * it reaches a third party.
     */
    const execCtx = (d: HostedToolDescriptor): ToolExecCtx => ({
      ownerEmail,
      replacementMap: pseudonymizationMap,
      maskingConfig: maskingConfigFrom(req),
      isStreaming: false,
      prepared: preparedByType?.get(d.type),
      remask: (text: string) => remaskText(req, text),
      logger: pluginLogger,
    });

    // One cap per descriptor, each read once and memoised: two tools called in the same
    // turn get independent budgets, and a request that has exhausted one may still spend
    // the other. Primed here, before anything runs, so a config lookup that throws fails
    // the whole handler into its outer catch rather than half-way through a batch.
    const capsByType = new Map<string, number>();
    const capFor = (d: HostedToolDescriptor): number => {
      const known = capsByType.get(d.type);
      if (known !== undefined) return known;
      const cap = d.maxCallsPerRequest();
      capsByType.set(d.type, cap);
      return cap;
    };
    for (const item of output) {
      const descriptor = descriptorForCall(item);
      if (descriptor) capFor(descriptor);
    }

    let current = upstreamResponse;
    // Everything the client has already been "given" by the rounds a continuation
    // committed to, in order, exactly as the streaming interceptor accumulates it: each
    // round's WHOLE output — reasoning items and their encrypted_content, a message the
    // model wrote before calling the tool, every other tool call — with only the
    // hosted-tool function_calls swapped for their resolved call item. Accumulating just
    // the call items instead (and prepending them to the LAST round's output) discarded
    // every intermediate round's output entirely and hoisted the calls ahead of the
    // reasoning that produced them: the route runs `store: false`, so clients replay
    // `output` into the next turn's `input`, and dropping reasoning items there breaks
    // chain-of-thought continuity across turns — the very property this design preserves
    // inside a continuation.
    const clientItems: any[] = [];
    /**
     * Every result this request produced, per descriptor, for `annotateMessage` at the end.
     * Not local on purpose, twice over: `resolved` lives inside the loop below and does not
     * survive the iteration, and the before handler's pending drain may already have run
     * this request's tools before any deployment call was made at all.
     */
    const resultsByDescriptor = resultsFor(req);
    // The full conversation carried forward to each continuation POST: the original input,
    // plus every turn's output and its function_call_output(s), accumulated — NOT
    // re-derived from req.body.input each iteration, or a later iteration would silently
    // drop everything an earlier one contributed (its own reasoning, its function_call, and
    // its results) and the model would re-enter with no memory of having already called.
    let history: any[] = normalizeInputToItems(req.body?.input);
    /** Calls actually run this request, per descriptor type. */
    const callsRunByType = new Map<string, number>();
    let didContinue = false;
    let sawUsage = !!current?.usage;
    let usageInput = current?.usage?.input_tokens || 0;
    let usageOutput = current?.usage?.output_tokens || 0;
    // Per-round cache breakdown, summed the same way as input/output above (defect 5):
    // a round with no `input_tokens_details` at all — or a partial one — contributes 0 to
    // each field rather than throwing or being skipped wholesale.
    let usageCachedTokens = current?.usage?.input_tokens_details?.cached_tokens ?? 0;
    // cache_write_tokens is the real Responses API field name; readCacheWriteTokens falls
    // back to the legacy cache_creation_tokens name for an upstream (or replayed history)
    // that still sends it.
    let usageCacheWriteTokens = readCacheWriteTokens(current?.usage?.input_tokens_details);
    // `output_tokens_details` (e.g. `reasoning_tokens`) has never been observed on this
    // route — neither the bridge's `translateUsage` nor the native SAP Responses shape emits
    // it — but the same round carries the same treatment IF a future upstream ever adds it:
    // summed like the input details, and included in the merged object only if at least one
    // round actually had it, so this never fabricates a field no round carries.
    let sawOutputTokensDetails = !!current?.usage?.output_tokens_details;
    let usageReasoningTokens = current?.usage?.output_tokens_details?.reasoning_tokens ?? 0;

    for (;;) {
      // Codex defaults parallel_tool_calls to true, so a single turn can carry more than
      // one hosted-tool call — and, with more than one tool registered, calls belonging to
      // DIFFERENT tools. Resolve all of them this iteration, not just the first, or the
      // ones left behind would never receive a function_call_output and the next
      // continuation POST would be a malformed turn the deployment rejects.
      const calls: any[] = (current?.output || []).filter(isHostedToolCall);
      if (calls.length === 0) break;

      // Group the whole TURN, not one tool: walk the calls in the order the model emitted
      // them and admit each only while its OWN descriptor still has budget. With a single
      // descriptor registered this is exactly the `calls.slice(0, cap - run)` it replaces —
      // the calls are in order, so admitting the first `cap - run` of them is the same set.
      const takenByType = new Map<string, number>();
      const batch: Array<{ item: any; descriptor: HostedToolDescriptor }> = [];
      // Every call `continue`d past here failed ONLY this admission check — the tool's own
      // budget, nothing else — so it is the one place in this loop that actually KNOWS a
      // stranded call is a cap situation rather than some other kind of breakage. Captured
      // here rather than left for `replaceHostedToolCalls`'s own fallback to guess at: that
      // function is also reached from the outer catch (below) with an EMPTY pairsByCallId
      // after an arbitrary exception, where nothing about the cap is knowable at all — the
      // two must not collapse onto the same generic code. See fix round 3's report.
      const strandedByCap: Array<{ item: any; descriptor: HostedToolDescriptor }> = [];
      for (const item of calls) {
        const descriptor = descriptorForCall(item) as HostedToolDescriptor;
        const used = (callsRunByType.get(descriptor.type) || 0) + (takenByType.get(descriptor.type) || 0);
        if (used >= capFor(descriptor)) { strandedByCap.push({ item, descriptor }); continue; }
        takenByType.set(descriptor.type, (takenByType.get(descriptor.type) || 0) + 1);
        batch.push({ item, descriptor });
      }
      // Not one call left that any cap can cover. Stop WITHOUT touching this round's
      // output, so the defensive sweep below drops the stranded calls — the loop guard
      // `while (searches < maxSearches)` this replaces did exactly that, and falling into
      // the in-place splice below instead would hand the client a failed call item + result
      // dump for a call the old code silently dropped.
      if (batch.length === 0) break;

      // At least one call in this batch is over its own tool's cap: POSTing a continuation
      // with it still unanswered is exactly the malformed-turn shape parallel calls risk,
      // so this batch cannot be continued at all — whatever we did resolve gets shown to
      // the client (in place, via replaceHostedToolCalls below) and the loop ends here,
      // same as having no upstream context.
      const overflow = calls.length > batch.length;

      // Resolved sequentially, matching the pre-extraction loop — but do NOT read that as
      // "the ordering and the counts depend on it", because they do not, and a later change
      // here deserves to know which invariant is actually load-bearing.
      //
      // What holds the ordering up is that `resolved` is appended in `batch` order, i.e.
      // the order the model emitted the calls in, and that is the order their
      // function_call_output items reach the model (pinned for this transport by the
      // characterization suite). What holds the counts up is that `callsRunByType` is
      // incremented BEFORE the await, so it lands the same way under any interleaving —
      // and this round's admission was decided above, so nothing here feeds back into it.
      // A `Promise.all` over `batch` preserves both and would be semantics-preserving.
      //
      // It stays serial because that is the conservative choice against the behaviour the
      // suites were pinned to, and because it bounds concurrent load on whatever a
      // descriptor calls out to (a search provider, an embedding API) when one turn fires
      // several parallel calls at once.
      const resolved: Array<{ descriptor: HostedToolDescriptor; result: ToolExecResult }> = [];
      for (const { item, descriptor } of batch) {
        const call = parseItemCall(descriptor, item);
        callsRunByType.set(descriptor.type, (callsRunByType.get(descriptor.type) || 0) + 1);

        let result: ToolExecResult;
        try {
          result = await descriptor.execute(call, execCtx(descriptor));
        } catch (error: any) {
          // A descriptor is supposed to return a failed result rather than throw; if it
          // does throw anyway the turn still owes this call a function_call_output.
          pluginLogger.error(`The ${descriptor.type} call ${call.callId} threw: ${error.message}`);
          result = failedResult(call);
        }
        resolved.push({ descriptor, result });
        noteResultForAnnotation(resultsByDescriptor, descriptor, result);
      }

      const pairsByCallId = new Map<string, RenderedPair>(
        resolved.map(r => [r.result.call.callId, renderPair(req, r.descriptor, r.result, optsFor, pluginLogger)] as const)
      );
      // Empty whenever `overflow` is false (batch === calls, nothing was excluded), so this
      // is a no-op on every round this loop actually continues past — only the spliced-in-place
      // rounds below ever have a stranded-by-cap entry to add.
      for (const { item, descriptor } of strandedByCap) {
        const strandedCall = parseItemCall(descriptor, item);
        pairsByCallId.set(
          strandedCall.callId,
          renderPair(req, descriptor, failedResult(strandedCall, 'cap_reached'), optsFor, pluginLogger),
        );
      }

      // No upstream context, or the cap didn't leave room to answer every call in this
      // batch: this batch cannot be continued at all. Splice in place — same as a
      // continuation POST failure below — so an item that preceded the call (a `reasoning`
      // item, most commonly) still precedes it in what the client sees.
      if (!upstream || !upstream.url || overflow) {
        current = { ...current, output: replaceHostedToolCalls(req, current.output || [], pairsByCallId, optsFor, pluginLogger) };
        break;
      }

      history = [
        ...history,
        ...(current.output || []),
        ...resolved.map(r => r.descriptor.renderOutput(r.result)),
      ];

      let next: any;
      try {
        const resp = await axios.post(
          upstream.url,
          // The conversation being carried forward may hold unmasked PII — the model's
          // own prior output was unmasked (by pseudonymization for turn 1, or by us for
          // every turn after) precisely so the CLIENT sees it unmasked. The deployment
          // must not see that — re-mask the whole thing right before it leaves the process.
          // Scoped to the same text-bearing fields unmaskResponsesOutput touches (NOT a
          // blind deep walk): a short masked original landing inside an opaque field like
          // `encrypted_content`, `id`, or `call_id` would corrupt a deployment-signed blob
          // or break the function_call/function_call_output pairing.
          continuationBody(upstream, remaskResponsesItems(history, req)),
          { headers: upstream.headers, timeout: upstream.timeoutMs }
        );
        // The REPLY-side twin of `buildContinuationPayload`, for the same reason: an
        // upstream that needed its own request shape answers in its own response shape.
        // An orchestration envelope has no `output` (so the loop below would see no
        // further calls and stop), no `usage.input_tokens` (so the round would bill
        // zero), and would replace the translated Responses object outright — making
        // the client's final body `{choices:[…]}`. Absent the hook the reply is already
        // Responses-shaped and is taken as-is, exactly as before.
        next = typeof upstream.translateContinuationResponse === 'function'
          ? upstream.translateContinuationResponse(resp.data)
          : resp.data;
      } catch (error: any) {
        pluginLogger.error(`Hosted-tool continuation call failed: ${error.message}`);
        // The tool calls themselves already succeeded or failed independently of this —
        // pairsByCallId's status, set above from the call outcome, is left exactly as it
        // was. Splice in place, same as the no-upstream/overflow fallback above: the
        // continuation never happened, so there is no model answer to prepend these ahead
        // of, and an item that preceded the call keeps preceding it here too.
        current = { ...current, output: replaceHostedToolCalls(req, current.output || [], pairsByCallId, optsFor, pluginLogger) };
        break;
      }

      // Committed: only now — once the continuation POST has actually succeeded — is this
      // round part of what the client has been given, and its calls answered by the model
      // rather than by a result dump. The whole round goes in, in place, so an item that
      // preceded the call still precedes it; the model's own (real) answer arrives in a
      // later round and is appended after all of this. A failed attempt is handled entirely
      // above, via the in-place splice, so it never reaches here.
      for (const item of clientVisibleItems(req, current.output || [], pairsByCallId, optsFor, pluginLogger)) clientItems.push(item);

      // pseudonymizationPlugin already ran on the response side and will never see this
      // second (or third, ...) deployment call — unmask it ourselves, the same way, before
      // the client-facing output is built from it.
      if (pseudonymizationMap) {
        unmaskResponsesOutput(next, (s: string) => unmaskText(s, pseudonymizationMap));
      }

      const u = next?.usage;
      if (u) {
        sawUsage = true;
        usageInput += u.input_tokens || 0;
        usageOutput += u.output_tokens || 0;
        usageCachedTokens += u.input_tokens_details?.cached_tokens ?? 0;
        usageCacheWriteTokens += readCacheWriteTokens(u.input_tokens_details);
        if (u.output_tokens_details) {
          sawOutputTokensDetails = true;
          usageReasoningTokens += u.output_tokens_details.reasoning_tokens ?? 0;
        }
        noteExtraUsage(req, u);
      }
      didContinue = true;
      current = next;
    }

    // A hosted-tool call surviving in `current.output` at this point can only be one the
    // loop refused to run, i.e. one whose tool is out of budget. Name the tool: with more
    // than one registered, "the cap" is ambiguous.
    const stranded: any[] = (current?.output || []).filter(isHostedToolCall);
    for (const descriptor of new Set(stranded.map(i => descriptorForCall(i) as HostedToolDescriptor))) {
      if ((callsRunByType.get(descriptor.type) || 0) >= capFor(descriptor)) {
        pluginLogger.warn(`Reached the ${descriptor.type} cap of ${capFor(descriptor)} for this request; stopping the continuation loop`);
      }
    }

    // Defensive final sweep: every path above already strips hosted-tool function_calls
    // from `current.output` before breaking (or never introduced any, on the natural
    // "the model stopped calling the tool" exit) — this is a second guarantee of the same
    // invariant, not the only one, in case a future path above forgets to.
    const finalOutput = (current?.output || []).filter((i: any) => !isHostedToolCall(i));
    // ANNOTATION SITE 1 of SIX (1, 1b, 2, 2b, 3, 3b — see site 3's note and chapter-16's
    // table). NOT the only one this transport has, as this comment used to claim: site 1b,
    // the early return above when the response carries no hosted-tool call, is the
    // non-streaming path's pending-drain counterpart and annotates turns this line never
    // sees. Here, `clientItems` plus
    // `finalOutput` IS the complete client-facing list. `replacementMap` is undefined
    // because the text here is already unmasked — pseudonymizationPlugin's after handler
    // (index 0) did the first round, `unmaskResponsesOutput` above did every one after —
    // so a descriptor's offsets are simply indices into what it was handed.
    const merged: any = {
      ...current,
      output: annotateItems([...clientItems, ...finalOutput], resultsByDescriptor, undefined, pluginLogger),
    };
    // The client-visible `usage` field otherwise reflects only the LAST continuation
    // call — every prior round's tokens would silently vanish from the response body the
    // client actually sees (separate from __responsesExtraUsage, which responsesController
    // folds into its own billing metrics and already accumulates correctly across
    // iterations).
    if (didContinue && sawUsage) {
      // Sum the cache breakdown across rounds too (defect 5) — carrying the LAST round's
      // `input_tokens_details` alongside SUMMED `input_tokens`/`output_tokens` produced a
      // client-visible object that contradicted itself (e.g. a summed `input_tokens` next to
      // a `cached_tokens` that only covered the final round). `total_tokens` is recomputed
      // from the summed input/output rather than carried, mirroring the identity the bridge's
      // own `translateUsage` establishes for a single round on this same route: `input_tokens`
      // is OpenAI-inclusive (already counts cache) and `total_tokens = input_tokens +
      // output_tokens`. `output_tokens_details` is included only if some round actually had
      // one — no round on this route has ever been observed to carry it, so today this is a
      // no-op, but a future round that does gets summed the same way instead of last-round-spread.
      merged.usage = {
        ...(current?.usage || {}),
        input_tokens: usageInput,
        output_tokens: usageOutput,
        input_tokens_details: { cached_tokens: usageCachedTokens, cache_write_tokens: usageCacheWriteTokens },
        total_tokens: usageInput + usageOutput,
      };
      if (sawOutputTokensDetails) {
        merged.usage.output_tokens_details = { reasoning_tokens: usageReasoningTokens };
      }
    }
    return merged;
  } catch (error: any) {
    pluginLogger.error(`Error in responsesWebSearchPlugin afterHandler: ${error.message}`, { stack: error.stack });
    // Whatever failed above, a raw hosted-tool function_call must still never reach the
    // client: its output_item events were already suppressed/replaced upstream of here in
    // the streaming case, or simply have no client-side meaning without the pairing this
    // handler exists to build. Represent every one of them as a failed placeholder rather
    // than silently dropping the response's only content.
    const out = upstreamResponse?.output;
    if (!Array.isArray(out) || !out.some(isHostedToolCall)) return upstreamResponse;
    return { ...upstreamResponse, output: replaceHostedToolCalls(req, out, new Map(), optsFor, pluginLogger) };
  }
}
