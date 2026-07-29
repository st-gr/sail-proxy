/**
 * Responses API web-search plugin.
 *
 * SAP AI Core deployments reject the hosted `web_search` tool outright, and
 * Codex CLI attaches one to every request with no way to disable it — so
 * without this plugin the /openai/v1/responses route is unusable from Codex.
 *
 * Strategy mirrors webSearchPlugin (the Anthropic equivalent):
 *   before — rewrite the hosted tool into a plain function tool the deployment
 *            accepts, back-fill results for any searches left pending from the
 *            previous turn, and — on the streaming path — install the res.write
 *            interceptor that does everything below frame by frame.
 *   after  — run every web_search function_call the model emitted, then POST the
 *            results straight back to the deployment (a "continuation" call) so
 *            the SAME turn produces the model's real answer, repeating until the
 *            model stops calling web_search or the configured cap is hit. Only
 *            when there is no upstream call context to continue with, or a
 *            continuation POST itself fails, does the handler fall back to
 *            handing the client a synthetic web_search_call + message pair
 *            instead of the model's own answer.
 *
 * The streaming path (installResponsesWebSearchInterceptor, below) does the same thing
 * against a live SSE stream: it suppresses the function_call frames, holds the first
 * call's terminal frame, injects the web_search_call, and splices a SECOND streaming
 * deployment call into the same response so the model's answer streams token by token —
 * one response.created and one response.completed for the client, output_index and
 * sequence_number shifted, usage summed. Its frame contract is documented there. That
 * path matters most: Codex CLI always streams.
 *
 * Both handlers REMOVE the model's function_call from what the client receives, so
 * in the normal flow (an upstream context is always stashed by responsesController)
 * there is nothing left for the client to replay and the before handler's pending
 * back-fill does not fire. The back-fill exists for the case where an unanswered
 * web_search function_call does reach the next turn's input anyway — a client that
 * replays it regardless, or a continuation that never got attempted — because the
 * deployment rejects such a turn as malformed.
 *
 * Codex CLI defaults `parallel_tool_calls` to true, so the model can emit more than
 * one web_search call in a single turn — both the before handler's pending-search
 * drain and the after handler's continuation loop resolve every one of them, not
 * just the first, for exactly that reason: a turn POSTed with any function_call left
 * unanswered by a function_call_output is malformed and the deployment rejects it.
 *
 * Ordering: there is ONE hook array per subpath and it is walked in order in both
 * directions, so pseudonymizationPlugin runs first on the request side (the pending
 * back-fill's query is already masked) but ALSO first on the response side — where it
 * unmasks the model's function_call arguments before this plugin ever sees them, and
 * runs only ONCE, on the deployment's first response. The continuation loop below
 * therefore has to redo both halves of that job itself for every second-and-later
 * deployment call it makes: re-mask (`remaskResponsesItems`, built on the same primitive
 * as `remaskSearchQuery`, scoped to the same text-bearing fields `unmaskResponsesOutput`
 * covers) the whole conversation it is about to POST, since the model's
 * prior output in it has already been unmasked; and unmask (`unmaskResponsesOutput`,
 * the same helper pseudonymizationPlugin itself calls) each continuation response
 * before treating it as the turn's new current state, since pseudonymizationPlugin
 * will never see it. The streaming path needs neither step: its res.write interceptor is
 * installed after pseudonymization's, so it reads every frame — query, model output, the
 * whole conversation it POSTs back — while they are still masked, and writes everything
 * back out THROUGH the unmasker.
 *
 * @see api_config.json - defaultHooks.openai.responses / responses-stream
 * @see responsesWebSearchPlugin.md - documentation
 */
import { Request, Response } from 'express';
import axios from 'axios';
import { executeWebSearch, Logger, SearchResult } from './webSearch/searchExecutor';
import { remaskSearchQuery, remaskResponsesItems } from './webSearch/queryMasking';
import { normalizeInputToItems, buildFunctionCallOutput } from './webSearch/continuation';
import { unmaskResponsesOutput } from '../utils/responsesBodyAdapter';
import {
  TERMINAL_RESPONSE_TYPES, splitBlocks, parseFrame, sseBlock, rebuildBlockWithSubstitution,
} from '../utils/sseFraming';
import {
  RESPONSES_STREAM_IDLE_HOOK,
  RESPONSES_STREAM_UPSTREAM_END_HOOK,
  RESPONSES_STREAM_ABORT_HOOK,
} from '../utils/responsesStreamIdle';
import { unmaskText } from './pseudonymization/unmasker';
import configService from '../services/configService';
import {
  hasResponsesWebSearchTool,
  transformResponsesWebSearchTool,
  findPendingResponsesSearch,
  appendFunctionCallOutput,
  isWebSearchFunctionCall,
  parseQueryFromArguments,
  buildWebSearchCallItem,
  buildSearchMessageItem,
} from './webSearch/responsesAdapter';

interface PluginContext {
  req: Request;
  res: Response;
  utils: { logger: Logger };
  upstreamResponse?: any;
}

interface PluginResult {
  stop: boolean;
  response?: any;
}

/** Marks a request whose hosted tool we rewrote, so the after handler knows to look. */
const REWROTE_FLAG = '__responsesWebSearchRewritten';

/** Hard cap on pending searches drained per request, to guarantee termination. */
const MAX_PENDING_SEARCHES_PER_TURN = 4;

let syntheticCounter = 0;
function syntheticId(prefix: string): string {
  syntheticCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${syntheticCounter.toString(36)}`;
}

/**
 * Replace every `web_search` function_call in `output` with its resolved
 * web_search_call + message pair, preserving the position — and hence the ordering
 * relative to every other item (a `reasoning` item that preceded the call in the
 * model's own output keeps preceding it here) — of everything else. A call with no
 * entry in `pairsByCallId` (the cap didn't leave budget to search it this batch, or
 * the caller genuinely has no result for it — see the outer catch below) still gets a
 * pair, built as an empty-results failure placeholder: every path that can return
 * output to the client goes through this function specifically so a raw function_call
 * can never survive — it has no output_item events of its own to leak by.
 */
function replaceWebSearchCalls(
  output: any[],
  pairsByCallId: Map<string, { callItem: any; messageItem: any }>
): any[] {
  const result: any[] = [];
  for (const item of output || []) {
    if (!isWebSearchFunctionCall(item)) { result.push(item); continue; }

    const pair = typeof item.call_id === 'string' ? pairsByCallId.get(item.call_id) : undefined;
    if (pair) {
      result.push(pair.callItem, pair.messageItem);
      continue;
    }
    const query = parseQueryFromArguments(item.arguments);
    result.push(
      buildWebSearchCallItem(query, syntheticId('ws'), 'failed'),
      buildSearchMessageItem([], query, syntheticId('msg'))
    );
  }
  return result;
}

/**
 * The same items as the CLIENT receives them, for a round whose searches a continuation
 * call is going to answer: every `web_search` function_call replaced by just the resolved
 * `web_search_call`, everything else — a `reasoning` item and its `encrypted_content`, a
 * `message` the model wrote before searching — passed through in its original position.
 *
 * The counterpart of `replaceWebSearchCalls`, and the difference is only the result
 * `message`: here the continuation that follows carries the model's own answer, so
 * dumping the raw results in front of it would be a second, redundant assistant message;
 * on every path that STOPS, that dump is the client's only view of what the search found
 * and `replaceWebSearchCalls` emits it. Shared by both transports — the streaming
 * interceptor builds its `clientItems` with this, and the non-streaming loop must too, or
 * the two paths hand the client different `response.output` arrays for the same turn.
 */
function clientVisibleItems(
  output: any[],
  pairsByCallId: Map<string, { callItem: any; messageItem: any }>
): any[] {
  return (output || []).map((item) => {
    if (!isWebSearchFunctionCall(item)) return item;
    const pair = typeof item.call_id === 'string' ? pairsByCallId.get(item.call_id) : undefined;
    if (pair) return pair.callItem;
    return buildWebSearchCallItem(parseQueryFromArguments(item.arguments), syntheticId('ws'), 'failed');
  });
}

const INTERCEPTOR_FLAG = '__responsesWebSearchInterceptorInstalled';

/**
 * A pending item in stream order: a raw pass-through block, a terminal frame held for
 * substitution at flush time, or a placeholder marking where a suppressed search's
 * injected blocks belong once it resolves. Everything held while any search is in
 * flight lives in one ordered queue so replay preserves arrival order across all three
 * kinds — see the interleaving note on `flushIfIdle` below.
 */
type QueueItem =
  | { kind: 'raw'; block: string }
  | { kind: 'terminal'; frame: any; rawBlock: string }
  | { kind: 'search'; index: number };

/**
 * Suppress the raw function_call frames for a hosted web_search, run the search, and
 * splice a SECOND streaming deployment call — the continuation — into the live stream so
 * the model writes the real answer from the results.
 *
 * res.write is synchronous but the search is not, so once a suppressed item
 * completes every later write is queued and flushed after the injection. res.end
 * is deferred the same way, or the stream would close before the results land.
 *
 * Codex defaults `parallel_tool_calls` to true, so more than one web_search item can be
 * in flight in the same response, and reasoning/other tool-call items routinely
 * interleave with them. `pendingSearches` counts the outstanding searches; every write
 * that arrives while it's above zero — including a placeholder marking exactly where a
 * search's injected blocks belong — is appended, in arrival order, to one `queue`. Only
 * once the counter drains to zero does `flushIfIdle` replay `queue` in order, splicing
 * each search's buffered blocks in at its placeholder's position. That reproduces the
 * upstream interleaving regardless of which Perplexity call wins the race, and
 * guarantees a search still in flight when a sibling finishes never gets its frames
 * dropped into an already-flushed (or already-ended) stream.
 *
 * FRAME CONTRACT, once a continuation is possible (`req.__responsesUpstream` is stashed
 * and the search cap has budget left):
 *
 *  1. The `web_search` function_call's own frames stay suppressed — as before.
 *  2. The first call's terminal frame (`response.completed` / `.incomplete` / `.failed`)
 *     is HELD, not written: it is not the client's final frame any more.
 *  3. Only `response.output_item.added` + `.done` for the synthetic `web_search_call` are
 *     injected at the suppressed index — NOT the formatted-result `message` that the
 *     pre-continuation behavior ended the turn with. That message survives only as the
 *     fallback (below), where it is still the client's only way to see the results.
 *  4. The continuation call is opened with `stream: true`. From its frames,
 *     `response.created` and `response.in_progress` are dropped (the client already got
 *     one of each), `output_index` is shifted past everything already sent, and the rest
 *     pass through.
 *  5. The continuation's terminal frame becomes the client's, with `response.output`
 *     prefixed by every item earlier calls already streamed (each `web_search_call` in
 *     place of the function_call it replaced) and `usage` summed across every call.
 *  6. A `web_search` call in the continuation's own output repeats the whole cycle,
 *     bounded by `configService.getWebSearchMaxSearches()`.
 *
 * FALLBACK. With no upstream context, no budget left, or a continuation POST that fails,
 * the client would otherwise be left with a `web_search_call` and no answer at all — so
 * the pre-continuation `message` blocks carrying the formatted results are emitted after
 * the fact and the held terminal is written with the old in-place substitution. Requests
 * that never reach a deployment call (no `__responsesUpstream`) therefore behave exactly
 * as they did before this splice existed.
 *
 * MASKING. Unlike the after handler, this interceptor needs no re-masking: it is
 * installed AFTER pseudonymizationPlugin's own res.write interceptor, so it reads frames
 * upstream of the unmasker — every value it sees (the query, the model's items, the
 * conversation it POSTs back) is still masked, exactly as the deployment produced it.
 * Symmetrically, everything it writes goes out through `originalWrite`, i.e. through the
 * unmasker, so the continuation's answer reaches the client unmasked without this code
 * touching the replacement map at all. Re-masking here would be worse than useless: it
 * would rewrite masked-looking substrings inside the search results themselves.
 *
 * LAYERING. This is the OUTERMOST of the Responses interceptors — the `responses-stream`
 * array is pseudonymizationPlugin, then responsesNamespaceToolsPlugin, then this one — and
 * it has to be, because the frames this interceptor generates ITSELF (a continuation round's
 * items, and the final terminal it rebuilds wholesale) never pass through `res.write` and
 * are therefore invisible to anything installed above it. Every `originalWrite` below
 * consequently runs through the namespace layer, which restores the routing `namespace`
 * on any sub-agent call a continuation round produces, and only then through the unmasker.
 *
 * The `responses` (non-streaming) array deliberately lists those two the OTHER way round.
 * Write interceptors nest inside-out, but after-handlers chain in array order — so on that
 * path the namespace plugin has to run LAST, after this plugin's after handler has finished
 * its continuation loop and replaced `output`. The two arrays are meant to disagree; making
 * them match reintroduces one of the two bugs. See responsesNamespaceToolsPlugin.md.
 */
function installResponsesWebSearchInterceptor(req: Request, res: Response, pluginLogger: Logger): void {
  if ((res as any)[INTERCEPTOR_FLAG]) return;
  if (typeof (res as any).write !== 'function' || typeof (res as any).end !== 'function') return;
  (res as any)[INTERCEPTOR_FLAG] = true;

  const originalWrite = (res as any).write.bind(res);
  const originalEnd = (res as any).end.bind(res);

  let tail = '';                                    // partial block held across writes
  let queue: QueueItem[] = [];                      // items held while any search is in flight
  let pendingSearches = 0;                          // count of runSearch calls not yet settled
  let endPending = false;
  let endArgs: any[] = [];

  const suppressed = new Map<number, { callId: string; args: string }>();
  const pendingBlocksByIndex = new Map<number, string[]>();

  // Populated as each search resolves (independent of the others still in
  // flight) so a later response.completed/.incomplete/.failed can substitute
  // the real result for that call_id instead of re-running the search.
  const completedByCallId = new Map<string, { callItem: any; messageItem: any }>();

  // ---------------------------------------------------------------- continuation state
  /** One search resolved in the round currently being assembled. */
  interface ResolvedSearch {
    index: number;                    // client-facing output_index of the suppressed call
    callId: string;
    query: string;
    results: SearchResult[];
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
  let searchesRun = 0;
  let capReached = false;
  let indexOffset = 0;                // added to the current continuation's output_index values
  let sequenceOffset = 0;             // ditto for sequence_number, so it stays monotonic
  let maxIndexSeen = -1;              // highest client-facing output_index emitted so far
  let maxSequenceSeen = -1;
  let sawUsage = false;
  const accumulatedUsage = { input_tokens: 0, output_tokens: 0 };
  const countedUsageFrames = new WeakSet<any>();
  const clientItems: any[] = [];      // items already streamed, in order, as the client saw them
  let history: any[] | null = null;   // the conversation carried into the next continuation
  let roundItemsByIndex = new Map<number, any>();   // this round's output_item.done items
  let roundResolved: ResolvedSearch[] = [];
  // The searches of the most recently COMMITTED round: their result dumps were withheld
  // because the continuation just opened was going to make them redundant. Kept past the
  // commit that clears `roundResolved`, for the one case where that bet loses completely.
  let withheldDumps: ResolvedSearch[] = [];
  let roundCalls: Array<{ index: number; callId: string; args: string }> = [];
  let roundTerminal: { frame: any; rawBlock: string } | null = null;
  const idleWaiters: Array<() => void> = [];

  const upstreamCtx = (): any => (req as any).__responsesUpstream;
  const isBusy = (): boolean => pendingSearches > 0 || continuationRunning;
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
      pluginLogger.warn('responsesWebSearchPlugin: the client disconnected; abandoning the web-search continuation');
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
    if (!bill) return;
    const acc = (req as any).__responsesExtraUsage || { input_tokens: 0, output_tokens: 0 };
    acc.input_tokens += usage.input_tokens || 0;
    acc.output_tokens += usage.output_tokens || 0;
    (req as any).__responsesExtraUsage = acc;
  };

  /** The stand-in pair for a search that produced no usable result. */
  const failedPlaceholder = (query: string): { callItem: any; messageItem: any } => ({
    callItem: buildWebSearchCallItem(query, syntheticId('ws'), 'failed'),
    messageItem: buildSearchMessageItem([], query, syntheticId('msg')),
  });

  /**
   * Resolve an item whose `.added` we suppressed but whose `.done` never arrived — a
   * `response.incomplete` from hitting max_output_tokens mid-call, or an upstream
   * truncation. Suppression already swallowed its frames, so letting the raw
   * function_call survive inside the terminal frame's `response.output` would leave
   * Codex with a `web_search` call that has no output_item events at all: exactly the
   * failure this interceptor exists to prevent. Substitute the failed placeholder and
   * remember it, so a re-substitution of the same frame stays stable.
   *
   * A suppressed entry with no call_id (upstream omitted it on `.added` and no `.done`
   * ever supplied the fallback) is matched too — it can only have come from a swallowed
   * item, and leaving it stranded is the very leak being closed here.
   */
  const resolveStranded = (item: any): { callItem: any; messageItem: any } | undefined => {
    if (suppressed.size === 0) return undefined;
    const callId = typeof item.call_id === 'string' ? item.call_id : undefined;

    let stranded: [number, { callId: string; args: string }] | undefined;
    for (const candidate of suppressed.entries()) {
      if (candidate[1].callId === callId || !candidate[1].callId) { stranded = candidate; break; }
    }
    if (!stranded) return undefined;

    suppressed.delete(stranded[0]);
    const placeholder = failedPlaceholder(parseQueryFromArguments(stranded[1].args || item.arguments));
    if (callId) completedByCallId.set(callId, placeholder);
    pluginLogger.warn(`responsesWebSearchPlugin: web_search item at output_index ${stranded[0]} never completed; substituting a failed web_search_call`);
    return placeholder;
  };

  /** Replace any web_search function_call in a terminal frame's response.output. */
  const substituteOutput = (frame: any): any => {
    const resp = frame.response;
    if (!resp || !Array.isArray(resp.output)) return frame;

    let changed = false;
    const newOutput: any[] = [];
    for (const item of resp.output) {
      const found = isWebSearchFunctionCall(item)
        ? (typeof item.call_id === 'string' ? completedByCallId.get(item.call_id) : undefined)
          ?? resolveStranded(item)
        : undefined;
      if (found) {
        changed = true;
        newOutput.push(found.callItem, found.messageItem);
      } else {
        newOutput.push(item);
      }
    }
    return changed ? { ...frame, response: { ...resp, output: newOutput } } : frame;
  };

  /** The two frames announcing the synthetic web_search_call at the suppressed index. */
  const searchCallBlocks = (index: number, callItem: any): string[] => [
    sseBlock({ type: 'response.output_item.added', output_index: index, item: callItem }),
    sseBlock({ type: 'response.output_item.done', output_index: index, item: callItem }),
  ];

  /**
   * The formatted-result `message` frames — the whole turn's answer before the
   * continuation existed, and still the fallback whenever no continuation can deliver a
   * real one. Emitted at the same output_index as the web_search_call they follow, for
   * the reason given at the injection site below.
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
   * Emit or, while any search or continuation is outstanding, queue a raw block.
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
   * The withheld result dump goes out first for the same reason: `runSearch` buffered only
   * the web_search_call because a continuation looked likely, so this is the last chance to
   * give the client what the search found — and `substituteOutput` is about to name that
   * message item in `response.output`, where it would otherwise be an item with no events.
   */
  const writeClosingTerminal = (frame: any, rawBlock: string): void => {
    emitPendingDumps();
    continuationFinished = true;
    originalWrite(rebuildBlockWithSubstitution(rawBlock, frame, substituteOutput(frame)));
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
   * after all — and they belong WITH their own web_search_call pair rather than in one
   * lump after every pair, which is what emitting them at terminal-write time produces
   * once two parallel searches are involved. Fold each into its own index's buffered
   * blocks before the replay starts. An index whose blocks were already flushed by an
   * earlier pass has nothing left to fold into; `emitPendingDumps` still covers it.
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
   * Once no search is outstanding, replay the queue in arrival order, splicing each
   * search placeholder's buffered blocks in at the position it occupies. Guarded end to
   * end: a write throwing partway through (e.g. a torn-down socket) must not escape into
   * runSearch's `finally` — `runSearch` is invoked as a bare `void` call, so an escaping
   * throw here would both surface as an unhandled rejection and permanently strand
   * pendingSearches's decrement from ever reaching a flush, hanging the request to the
   * streaming timeout with nothing logged. On that path `queue` is deliberately left
   * un-cleared — whatever wasn't yet replayed stays queued for the next flush attempt
   * instead of silently vanishing — but a deferred res.end still gets a best-effort
   * attempt, since a torn-down socket usually means nothing further will actually be
   * delivered either way.
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
        // Every buffered search should have a matching placeholder consumed above; a
        // leftover here means one didn't, which is a bug elsewhere in this interceptor
        // rather than expected behavior — log it instead of silently dropping the data.
        pluginLogger.error(`responsesWebSearchPlugin: ${pendingBlocksByIndex.size} buffered search result(s) had no queue placeholder`);
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
   * Run one search and build both shapes of injected frames for it. Shared by the first
   * call (which searches eagerly, as each item completes, to keep the stream moving) and
   * by every continuation round (which searches once its stream has ended, since a
   * continuation needs the WHOLE turn — every parallel call answered — before it can be
   * POSTed at all).
   *
   * Enforces the per-request cap. A call that finds no budget left is answered with an
   * empty, `failed` result rather than skipped, so it still gets a function_call_output
   * and client-facing items; `capReached` then blocks any further continuation, exactly
   * as the after handler's `overflow` branch does — POSTing a turn with an unanswerable
   * call in it is the malformed shape parallel calls risk.
   */
  const performSearch = async (
    index: number, query: string, callId: string,
  ): Promise<{ callItem: any; messageItem: any; entry: ResolvedSearch }> => {
    let results: SearchResult[] = [];
    let status: 'completed' | 'failed' = 'completed';
    const maxSearches = configService.getWebSearchMaxSearches();

    if (searchesRun >= maxSearches) {
      capReached = true;
      status = 'failed';
      pluginLogger.warn(`responsesWebSearchPlugin: reached the web-search cap of ${maxSearches} for this request; not running the search at output_index ${index}`);
    } else {
      searchesRun += 1;
      try {
        results = await executeWebSearch(query, pluginLogger);
      } catch (error: any) {
        status = 'failed';
        pluginLogger.error(`Web search failed mid-stream for "${query}": ${error.message}`);
      }
    }

    // Recorded BEFORE the items are built: if that build throws, the continuation still
    // has a function_call_output for this call and the turn it POSTs stays well-formed.
    const entry: ResolvedSearch = { index, callId, query, results, messageItem: null, dumped: false };
    roundResolved.push(entry);

    // Same reasoning for the placeholder: if the build below throws, this is what a later
    // response.completed/.incomplete/.failed finds for this call_id — otherwise the client
    // would see the raw function_call pass through into the final output even though its
    // own output_item.added/.done were already suppressed, leaving an item with no
    // matching events. The second `.set` overwrites it once the real items exist.
    completedByCallId.set(callId, failedPlaceholder(query));

    const callItem = buildWebSearchCallItem(query, syntheticId('ws'), status);
    const messageItem = buildSearchMessageItem(results, query, syntheticId('msg'));
    entry.messageItem = messageItem;
    completedByCallId.set(callId, { callItem, messageItem });

    return { callItem, messageItem, entry };
  };

  const runSearch = async (index: number, query: string, callId: string): Promise<void> => {
    try {
      const { callItem, messageItem, entry } = await performSearch(index, query, callId);

      // The injected items intentionally keep the suppressed function_call's own
      // output_index rather than being renumbered onto fresh indices — renumbering
      // every subsequent upstream index is riskier than this trade-off. Whether
      // Codex actually needs distinct indices per injected item will be settled by
      // the live acceptance gate.
      if (canContinue()) {
        // The continuation will write the real answer; the result dump would be a second,
        // redundant assistant message in front of it. Held back in `entry` in case the
        // continuation never happens after all (see emitPendingDumps).
        pendingBlocksByIndex.set(index, searchCallBlocks(index, callItem));
      } else {
        entry.dumped = true;
        pendingBlocksByIndex.set(index, [
          ...searchCallBlocks(index, callItem),
          ...resultMessageBlocks(index, messageItem),
        ]);
      }
    } catch (error: any) {
      // Covers failures in building/buffering the injected frames themselves
      // (as opposed to the search call, which has its own inner try/catch above) —
      // e.g. a torn-down socket. Nothing is buffered for this index (the queued
      // placeholder splices in nothing), but the counter still has to drain so
      // sibling searches and a deferred res.end are never stuck waiting on a search
      // that will never finish.
      pluginLogger.error(`responsesWebSearchPlugin: failed to build injected frames for output_index ${index}: ${error.message}`);
    } finally {
      pendingSearches -= 1;
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
   * The same items as the CLIENT saw them: every `web_search` function_call replaced by
   * the synthetic `web_search_call` whose frames were injected in its place. A raw
   * function_call in the final `response.output` is precisely the leak this interceptor
   * exists to prevent — it would be an item with no output_item events at all. Shared with
   * the non-streaming continuation loop, which owes the client the same array.
   */
  const roundClientItems = (items: any[]): any[] => clientVisibleItems(items, completedByCallId);

  /**
   * Emit the formatted-result message for every search of the current round that has not
   * otherwise reached the client. Called only when the turn stops here: the results are
   * then the client's ONLY view of what the search found.
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
   * time the failure is visible those searches are no longer "the current round". Without
   * this the client is left with a web_search_call and a synthesized, empty terminal —
   * strictly worse than the result dump this feature replaced. Each message is spliced
   * into `clientItems` directly behind the web_search_call it belongs to, so the terminal
   * frame names it and it is never an item with no output_item events.
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
   * `continued` says how this last call's own `web_search` calls were answered, and hence
   * what has to stand in their place: by the model, in a further call (just the
   * `web_search_call`), or by the result dump this turn fell back to (the
   * `web_search_call` AND the `message` carrying the results, exactly as the terminal
   * substitution produces on the pre-continuation path).
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
    const output = [
      ...clientItems,
      ...(continued ? roundClientItems(roundOutput) : replaceWebSearchCalls(roundOutput, completedByCallId)),
    ];
    const finalFrame: any = { ...frame, response: { ...response, output } };
    if (sawUsage) {
      finalFrame.response.usage = {
        ...(response.usage || {}),
        input_tokens: accumulatedUsage.input_tokens,
        output_tokens: accumulatedUsage.output_tokens,
      };
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

    if (frame.type === 'response.output_item.added' && isWebSearchFunctionCall(frame.item)) {
      suppressed.set(index, { callId: frame.item.call_id, args: frame.item.arguments || '' });
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
        roundCalls.push({ index, callId: tracked.callId, args: tracked.args });
      }
      return;                                              // every frame of a suppressed item
    }

    if (frame.type === 'response.output_item.done' && frame.item) roundItemsByIndex.set(index, frame.item);
    originalWrite(rebuildBlockWithSubstitution(rawBlock, frame, shifted));
  };

  /**
   * Drain one continuation stream, resolving when it ends, errors, closes or stalls past
   * the configured timeout. Never rejects: whatever arrived is what the round produced,
   * and the caller decides what to do with a round that has no terminal frame.
   */
  const readContinuationStream = async (stream: any, timeoutMs: number): Promise<void> => {
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
          for (const block of blocks) processContinuationBlock(block);
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
  };

  /**
   * The continuation loop. Each pass POSTs the whole conversation so far back to the same
   * deployment with `stream: true`, splices the reply into the client's stream, and — if
   * that reply asks for more searches — runs them and goes round again.
   *
   * Deliberately serial: a continuation may only be POSTed once EVERY web_search call of
   * the round it continues has a function_call_output, or the deployment rejects the turn.
   *
   * Bounded by ONE wall-clock deadline for the whole loop, not just by the round cap.
   * responsesController allows the entire splice a single `getTimeout(true)` idle budget —
   * the same value it stashes here as `timeoutMs` — while the loop's own ceiling is
   * `max_searches_per_request` rounds of (a search + a per-stream watchdog), tens of
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
      // Read here rather than at install time: the before handler's pending-search drain
      // appends to req.body.input after the interceptor is installed.
      if (history === null) history = normalizeInputToItems(req.body?.input);

      const budgetMs = upstreamCtx()?.timeoutMs || 0;
      const deadlineAt = budgetMs > 0 ? Date.now() + budgetMs : 0;

      for (;;) {
        const upstream = upstreamCtx();
        if (deadlineAt && Date.now() >= deadlineAt) {
          pluginLogger.warn(`responsesWebSearchPlugin: the web-search continuation exceeded its ${budgetMs}ms budget; closing the turn with what it has`);
          stopWithoutContinuing();
          return;
        }
        const finishedRound = heldTerminal;
        const roundOutput = roundOutputItems(finishedRound?.frame);

        // Accumulated, never re-derived from req.body.input: a later round would
        // otherwise drop everything an earlier one contributed and the model would
        // re-enter with no memory of having already searched.
        history = [
          ...history,
          ...roundOutput,
          ...roundResolved.map(entry => buildFunctionCallOutput(entry.callId, entry.results)),
        ];

        let response: any;
        try {
          // `upstream.payload` is stashed by reference — spread rather than mutate, or the
          // next round would inherit this round's input.
          response = await axios.post(
            upstream.url,
            { ...upstream.payload, input: history, stream: true },
            { headers: upstream.headers, timeout: upstream.timeoutMs, responseType: 'stream' },
          );
        } catch (error: any) {
          pluginLogger.error(`Web-search continuation stream failed: ${error.message}`);
          stopWithoutContinuing();
          return;
        }

        // Committed: the round just finished is now part of what the client has seen, its
        // terminal frame is swallowed, and its searches are answered by the model rather
        // than by a result dump. Those withheld dumps are remembered, and nothing else, in
        // case the call just opened delivers nothing at all — see deliverWithheldDumps.
        for (const item of roundClientItems(roundOutput)) clientItems.push(item);
        withheldDumps = roundResolved.filter(entry => !entry.dumped && !!entry.messageItem);
        for (const entry of roundResolved) entry.dumped = true;
        if (finishedRound) droppedTerminal = true;
        heldTerminal = null;

        await readContinuationStream(response.data, upstream.timeoutMs);

        // The client hung up mid-stream (its stream was destroyed by the abort hook).
        // Writing a terminal frame into a dead socket, let alone searching and paying for
        // another deployment call, buys nothing — leave the close to the deferred res.end
        // this returns into.
        if (clientGone) return;

        if (roundCalls.length === 0) {                     // the model answered: done
          heldTerminal = roundTerminal;
          writeFinalTerminal(true);
          return;
        }

        // Every search of this round first — the cap may only be reached partway through,
        // and whether the results need a dump depends on the round as a whole.
        const searched: Array<{ index: number; callItem: any; messageItem: any; entry: ResolvedSearch }> = [];
        for (const call of roundCalls) {
          const { callItem, messageItem, entry } = await performSearch(call.index, parseQueryFromArguments(call.args), call.callId);
          searched.push({ index: call.index, callItem, messageItem, entry });
        }

        const continuable = canContinue() && roundTerminal?.frame?.type === 'response.completed';
        for (const item of searched) {
          for (const block of searchCallBlocks(item.index, item.callItem)) originalWrite(block);
          if (continuable) continue;
          item.entry.dumped = true;
          for (const block of resultMessageBlocks(item.index, item.messageItem)) originalWrite(block);
        }

        heldTerminal = roundTerminal;
        if (!continuable) { writeFinalTerminal(false); return; }
      }
    } catch (error: any) {
      pluginLogger.error(`responsesWebSearchPlugin: the web-search continuation failed: ${error.message}`);
      try { stopWithoutContinuing(); } catch { /* socket already gone */ }
    } finally {
      continuationRunning = false;
      continuationFinished = true;
      // Drains anything queued behind the continuation and honours a deferred res.end.
      flushIfIdle();
    }
  };

  /**
   * Start the continuation once the first call is genuinely over: no search outstanding,
   * and one of the three signals that the turn is finished — its terminal frame in hand,
   * the controller reporting the upstream stream ended, or a res.end already deferred.
   * All three are needed: a stream can end without a terminal frame, and whichever signal
   * arrives first has to be the one that starts the call, or the tokens it spends land
   * after the usage event has already been emitted. Returns whether it took over the turn.
   */
  function maybeStartContinuation(): boolean {
    if (continuationRunning || continuationFinished) return false;
    if (pendingSearches > 0) return false;
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
        // Every index the client is given, injected web_search_call frames included —
        // the continuation's own indices are shifted past the highest of them.
        noteIndex(index);

        if (frame.type === 'response.output_item.added' && isWebSearchFunctionCall(frame.item)) {
          suppressed.set(index, { callId: frame.item.call_id, args: frame.item.arguments || '' });
          continue;                                    // suppressed
        }

        const tracked = suppressed.get(index);
        if (!tracked) {
          // Collected for the continuation's `input`: what the model produced this turn
          // has to be carried forward, reasoning items above all.
          if (frame.type === 'response.output_item.done' && frame.item) roundItemsByIndex.set(index, frame.item);
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
          pendingSearches += 1;
          // Mark this index's position in the stream now, synchronously, so items
          // that arrive later (e.g. a reasoning item at a different output_index, or a
          // sibling web_search) replay in the same relative order they arrived in —
          // not grouped by which search happens to resolve, or finish building, first.
          queue.push({ kind: 'search', index });
          void runSearch(index, parseQueryFromArguments(tracked.args), tracked.callId);
          continue;
        }
        continue;                                      // any other frame for this item
      }
      return true;
    } catch (error: any) {
      // Deliberately does not fall back to writing the raw chunk: some of it may
      // already have been emitted above (duplicating those bytes), and a chunk
      // that carried a suppressed web_search frame would reach Codex raw — the
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

async function beforeHandler({ req, res, utils }: PluginContext): Promise<PluginResult> {
  const pluginLogger = utils.logger;

  try {
    const body: any = req.body;
    if (!body) return { stop: false };

    if (!hasResponsesWebSearchTool(body.tools)) {
      return { stop: false };
    }

    transformResponsesWebSearchTool(body);
    (req as any)[REWROTE_FLAG] = true;
    pluginLogger.info('Rewrote hosted web_search tool into a function tool');

    if (body.stream === true) {
      installResponsesWebSearchInterceptor(req, res, pluginLogger);
    }

    // Drain every pending search left from the previous turn. Codex CLI
    // defaults parallel_tool_calls to true, so more than one may be pending;
    // findPendingResponsesSearch only returns the most recent unsatisfied one,
    // so we loop until none remain, bounded to guarantee termination.
    //
    // Each call is caught individually: a Perplexity failure on one pending
    // call must not leave a LATER pending call (or this one) without a
    // function_call_output, or the whole turn is malformed and the deployment
    // rejects it outright. On failure we still append an empty-results output
    // so the turn stays well-formed and the model can tell the user the
    // search was unavailable, instead of every follow-up turn hard-failing
    // for the duration of a Perplexity outage.
    for (let i = 0; i < MAX_PENDING_SEARCHES_PER_TURN; i++) {
      const pending = findPendingResponsesSearch(body.input);
      if (!pending) break;

      pluginLogger.info(`Executing pending web_search ${pending.callId}: "${pending.query}"`);
      let results: SearchResult[] = [];
      try {
        results = await executeWebSearch(pending.query, pluginLogger);
        pluginLogger.info(`Injected ${results.length} search results as function_call_output for ${pending.callId}`);
      } catch (error: any) {
        pluginLogger.error(`Pending web_search ${pending.callId} failed for "${pending.query}": ${error.message}`, { stack: error.stack });
      }
      appendFunctionCallOutput(body, pending.callId, results);

      if (i === MAX_PENDING_SEARCHES_PER_TURN - 1) {
        const stillPending = findPendingResponsesSearch(body.input);
        if (stillPending) {
          pluginLogger.warn(`Hit the ${MAX_PENDING_SEARCHES_PER_TURN}-search drain cap with a pending search still unresolved`);
        }
      }
    }

    return { stop: false };
  } catch (error: any) {
    pluginLogger.error(`Error in responsesWebSearchPlugin beforeHandler: ${error.message}`, { stack: error.stack });
    return { stop: false };
  }
}

async function afterHandler({ req, upstreamResponse, utils }: PluginContext): Promise<any> {
  const pluginLogger = utils.logger;

  try {
    // Only handle responses to requests whose hosted tool WE rewrote. Without
    // this guard, any client sending its own function tool literally named
    // `web_search` (matched by the `tools:hasWebSearch` hook regex, but not a
    // hosted tool per hasResponsesWebSearchTool) would have its function_call
    // silently swallowed and replaced with an unsolicited Perplexity result.
    if (!(req as any)[REWROTE_FLAG]) return upstreamResponse;

    const output = upstreamResponse?.output;
    if (!Array.isArray(output)) return upstreamResponse;
    if (!output.some(isWebSearchFunctionCall)) return upstreamResponse;

    const maxSearches = configService.getWebSearchMaxSearches();
    const upstream = (req as any).__responsesUpstream;
    const pseudonymizationMap = (req as any).__pseudonymizationMap;

    let current = upstreamResponse;
    // Everything the client has already been "given" by the rounds a continuation
    // committed to, in order, exactly as the streaming interceptor accumulates it: each
    // round's WHOLE output — reasoning items and their encrypted_content, a message the
    // model wrote before searching, every other tool call — with only the web_search
    // function_calls swapped for their resolved web_search_call. Accumulating just the
    // web_search_call items instead (and prepending them to the LAST round's output)
    // discarded every intermediate round's output entirely and hoisted the searches ahead
    // of the reasoning that produced them: the route runs `store: false`, so clients
    // replay `output` into the next turn's `input`, and dropping reasoning items there
    // breaks chain-of-thought continuity across turns — the very property this design
    // preserves inside a continuation.
    const clientItems: any[] = [];
    // The full conversation carried forward to each continuation POST: the original
    // input, plus every turn's output and its function_call_output(s), accumulated —
    // NOT re-derived from req.body.input each iteration, or a later iteration would
    // silently drop everything an earlier one contributed (its own reasoning, its
    // function_call, and its results) and the model would re-enter with no memory of
    // having already searched.
    let history: any[] = normalizeInputToItems(req.body?.input);
    let searches = 0;
    let didContinue = false;
    let sawUsage = !!current?.usage;
    let usageInput = current?.usage?.input_tokens || 0;
    let usageOutput = current?.usage?.output_tokens || 0;

    while (searches < maxSearches) {
      // Codex defaults parallel_tool_calls to true, so a single turn can carry more
      // than one web_search call — resolve all of them this iteration, not just the
      // first, or the ones left behind would never receive a function_call_output and
      // the next continuation POST would be a malformed turn the deployment rejects.
      const calls = (current?.output || []).filter(isWebSearchFunctionCall);
      if (calls.length === 0) break;

      const budget = maxSearches - searches;
      const batch = calls.slice(0, budget);
      // The cap didn't leave enough room to answer every call in this batch: POSTing a
      // continuation with some of them still unanswered is exactly the malformed-turn
      // shape parallel calls risk, so this batch cannot be continued at all — whatever
      // we did resolve gets shown to the client (in place, via replaceWebSearchCalls
      // below) and the loop ends here, same as having no upstream context.
      const overflow = calls.length > batch.length;

      const resolved: Array<{ callId: string; query: string; results: SearchResult[]; status: 'completed' | 'failed' }> = [];
      for (const call of batch) {
        // `call.arguments` has already been UNMASKED in place — by pseudonymizationPlugin
        // for the very first response, or by this loop's own unmaskResponsesOutput call
        // (below) for every response after that — so re-mask before the query leaves the
        // process. The client-facing items below deliberately keep the unmasked `query`;
        // only Perplexity sees `searchQuery`.
        const query = parseQueryFromArguments(call.arguments);
        const searchQuery = remaskSearchQuery(req, query);
        if (searchQuery !== query) {
          pluginLogger.info('Re-masked the web_search query before dispatching it to the search provider');
        }

        let results: SearchResult[] = [];
        let status: 'completed' | 'failed' = 'completed';
        try {
          results = await executeWebSearch(searchQuery, pluginLogger);
        } catch (error: any) {
          status = 'failed';
          pluginLogger.error(`Web search failed for "${searchQuery}": ${error.message}`);
        }
        searches += 1;
        resolved.push({ callId: call.call_id, query, results, status });
      }

      const pairsByCallId = new Map(resolved.map(r => [r.callId, {
        callItem: buildWebSearchCallItem(r.query, syntheticId('ws'), r.status),
        messageItem: buildSearchMessageItem(r.results, r.query, syntheticId('msg')),
      }]));

      // No upstream context, or the cap didn't leave room to answer every call in this
      // batch: this batch cannot be continued at all. Splice in place — same as a
      // continuation POST failure below — so an item that preceded the call (a
      // `reasoning` item, most commonly) still precedes it in what the client sees.
      if (!upstream || !upstream.url || overflow) {
        current = { ...current, output: replaceWebSearchCalls(current.output || [], pairsByCallId) };
        break;
      }

      history = [
        ...history,
        ...(current.output || []),
        ...resolved.map(r => buildFunctionCallOutput(r.callId, r.results)),
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
          { ...upstream.payload, input: remaskResponsesItems(history, req) },
          { headers: upstream.headers, timeout: upstream.timeoutMs }
        );
        next = resp.data;
      } catch (error: any) {
        pluginLogger.error(`Web-search continuation call failed: ${error.message}`);
        // The search(es) themselves already succeeded or failed independently of this —
        // pairsByCallId's status, set above from the search outcome, is left exactly as
        // it was. Splice in place, same as the no-upstream/overflow fallback above: the
        // continuation never happened, so there is no model answer to prepend these
        // ahead of, and an item that preceded the call keeps preceding it here too.
        current = { ...current, output: replaceWebSearchCalls(current.output || [], pairsByCallId) };
        break;
      }

      // Committed: only now — once the continuation POST has actually succeeded — is this
      // round part of what the client has been given, and its searches answered by the
      // model rather than by a result dump. The whole round goes in, in place, so an item
      // that preceded the call still precedes it; the model's own (real) answer arrives in
      // a later round and is appended after all of this. A failed attempt is handled
      // entirely above, via the in-place splice, so it never reaches here.
      for (const item of clientVisibleItems(current.output || [], pairsByCallId)) clientItems.push(item);

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
        const acc = (req as any).__responsesExtraUsage || { input_tokens: 0, output_tokens: 0 };
        acc.input_tokens += u.input_tokens || 0;
        acc.output_tokens += u.output_tokens || 0;
        (req as any).__responsesExtraUsage = acc;
      }
      didContinue = true;
      current = next;
    }

    if (searches >= maxSearches && (current?.output || []).some(isWebSearchFunctionCall)) {
      pluginLogger.warn(`Reached the web-search cap of ${maxSearches} for this request; stopping the continuation loop`);
    }

    // Defensive final sweep: every path above already strips web_search function_calls
    // from `current.output` before breaking (or never introduced any, on the natural
    // "the model stopped calling web_search" exit) — this is a second guarantee of the
    // same invariant, not the only one, in case a future path above forgets to.
    const finalOutput = (current?.output || []).filter((i: any) => !isWebSearchFunctionCall(i));
    const merged: any = { ...current, output: [...clientItems, ...finalOutput] };
    // The client-visible `usage` field otherwise reflects only the LAST continuation
    // call — every prior search-and-continuation round's tokens would silently vanish
    // from the response body the client actually sees (separate from
    // __responsesExtraUsage, which responsesController folds into its own billing
    // metrics and already accumulates correctly across iterations).
    if (didContinue && sawUsage) {
      merged.usage = { ...(current?.usage || {}), input_tokens: usageInput, output_tokens: usageOutput };
    }
    return merged;
  } catch (error: any) {
    pluginLogger.error(`Error in responsesWebSearchPlugin afterHandler: ${error.message}`, { stack: error.stack });
    // Whatever failed above, a raw web_search function_call must still never reach the
    // client: its output_item events were already suppressed/replaced upstream of here
    // in the streaming case, or simply have no client-side meaning without the pairing
    // this handler exists to build. Represent every one of them as a failed placeholder
    // rather than silently dropping the response's only content.
    const out = upstreamResponse?.output;
    if (!Array.isArray(out) || !out.some(isWebSearchFunctionCall)) return upstreamResponse;
    return { ...upstreamResponse, output: replaceWebSearchCalls(out, new Map()) };
  }
}

const pluginRules = [
  { id: 'responsesWebSearchPlugin', match: [], strategy: 'before', handler: beforeHandler },
  { id: 'responsesWebSearchPlugin', match: [], strategy: 'after', handler: afterHandler },
];

export = pluginRules;
