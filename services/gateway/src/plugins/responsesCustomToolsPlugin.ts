/**
 * Codex freeform custom-tool (`apply_patch`) support for the Responses route.
 *
 * Both SAP routes reject `tools[].type: "custom"` outright, so a codex turn with
 * apply_patch enabled — the default for every current model — dies with a 400 before
 * the model runs. This plugin rewrites the declaration into an ordinary function tool
 * on the way out and restores the `custom_tool_call` shape on the way back, which
 * Codex REQUIRES to dispatch the call.
 *
 * Both halves or neither: the namespace plugin's header documents the failure mode in
 * detail, and it applies unchanged here — a translation with no restoration fails
 * silently at the client instead of loudly at the API.
 *
 * The response side exists twice because after-plugins never run per SSE frame: the
 * after handler covers a non-streaming reply, and installCustomToolInterceptor covers
 * a live stream. Codex streams by default, so the interceptor carries the real traffic.
 *
 * @see customTools/adapter.ts - the pure transformations
 * @see responsesNamespaceToolsPlugin.ts - the template, including the layering notes
 * @see responsesCustomToolsPlugin.md - operator documentation
 */
import { Request, Response } from 'express';
import configService from '../services/configService';
import {
  translateCustomTools, translateCustomCallItems, restoreOutputItems, restoreCustomToolCall,
  FREEFORM_PARAM, CustomToolMode,
} from './customTools/adapter';
import {
  translateToolSearchTool, translateToolSearchOutputItems, hoistDiscoveredTools,
  restoreToolSearchCall, restoreToolSearchItems, ToolSearchMode,
} from './toolSearch/adapter';
// Reused rather than reimplemented: restoring the routing `namespace` on a call is exactly what
// the namespace plugin already does, and codex routes by (namespace, name) either way.
import { renestFunctionCall, renestOutputItems } from './namespaceTools/adapter';
import {
  TERMINAL_RESPONSE_TYPES, splitBlocks, parseFrame, sseBlock, rebuildBlockWithSubstitution,
} from '../utils/sseFraming';

interface Logger {
  error: (m: string, meta?: any) => void; warn: (m: string, meta?: any) => void;
  info: (m: string, meta?: any) => void; debug: (m: string, meta?: any) => void;
  trace: (m: string, meta?: any) => void;
}
interface PluginContext { req: Request; res: Response; utils: { logger: Logger }; upstreamResponse?: any }
interface PluginResult { stop: boolean }

/** Where the before handler leaves the translated tool names for the response side. */
const CUSTOM_NAMES_KEY = '__customToolNames';

/**
 * Set when a `tool_search` declaration was translated this request, so the response side knows
 * to restore its call. Kept separate from CUSTOM_NAMES_KEY because the two translations are
 * independent: a turn may carry either, both, or neither.
 */
const TOOL_SEARCH_KEY = '__toolSearchTranslated';

/**
 * `name -> namespace` for tools hoisted out of a tool_search_output this request. Their calls
 * need the namespace put back or codex's router refuses them as `unsupported call: <name>`.
 */
const HOISTED_NS_KEY = '__toolSearchHoistedNamespaces';

/** Guards against a second install if the before handler ever runs twice on one response. */
const INTERCEPTOR_FLAG = '__customToolsInterceptorInstalled';

/**
 * Restore custom-tool frames on a LIVE SSE stream — the path that actually matters,
 * because Codex CLI streams by default and an after handler never sees a frame.
 *
 * FRAME CONTRACT. A translated call reaches the client as five frame kinds, and the
 * streaming shape differs from the non-streaming one in a way the after handler never
 * has to deal with:
 *
 *   | Upstream frame                                 | Sent to Codex as                          |
 *   |-------------------------------------------------|--------------------------------------------|
 *   | response.output_item.added (function_call item) | same frame, item -> custom_tool_call, input: '' |
 *   | response.function_call_arguments.delta           | suppressed, text buffered                  |
 *   | response.function_call_arguments.done             | custom_tool_call_input.delta then .done (whole payload) |
 *   | response.output_item.done                         | same frame, item rewritten via restoreCustomToolCall |
 *   | response.completed / .incomplete / .failed        | response.output[] rewritten via restoreOutputItems |
 *
 * ROUTE DIVERGENCE. The table above describes the DEPLOYED route, where upstream
 * genuinely streams arguments. The orchestration bridge
 * (`../responses/orchestrationBridge/streamTranslator.ts`) never emits
 * `function_call_arguments.*` at all: for every tool call it emits exactly
 * `response.output_item.added` immediately followed by `response.output_item.done`,
 * both already carrying the complete `arguments`. On that route the client receives
 * ZERO `response.custom_tool_call_input.delta`/`.done` frames — the payload reaches
 * Codex only inside `output_item.done`'s `item.input`. This is why the
 * `output_item.done` branch below tests `buffered`'s leftover text for EMPTINESS
 * rather than mere presence: on orchestration, `buffered` is always still populated by
 * the time `output_item.done` lands (set to `''` at `output_item.added`, never cleared
 * because no delta/done frame ever arrives), and that is the NORMAL shape for that
 * route, not upstream misbehaving — treating presence alone as proof of an out-of-order
 * frame warned on every single orchestration call. TASK 9 WATCH ITEM: whether Codex is
 * satisfied by `item.input` alone, with no `custom_tool_call_input` frames at all, is
 * unproven — see `responsesCustomToolsPlugin.md`'s Streaming section.
 *
 * Only frames whose `output_index` belongs to a translated call (registered at
 * `output_item.added`, released once the call is done) are touched; everything else
 * passes through byte-for-byte — the property that makes installing this on the shared
 * `responses-stream` hook safe.
 *
 * WHY DELTAS ARE BUFFERED RATHER THAN TRANSLATED ONE-FOR-ONE. `function_call_arguments.
 * delta` carries fragments of a JSON STRING (`{"input":"*** Beg`), while
 * `custom_tool_call_input.delta` carries raw text. Converting incrementally means
 * unescaping a JSON string split at arbitrary byte boundaries — including a `\uXXXX`
 * escape straddling two frames. Buffering to the `.done` frame (or to end-of-stream, see
 * below) and emitting the payload once is exact. The cost is that the patch appears in
 * the TUI all at once rather than token-by-token. If live testing shows Codex needs
 * incremental deltas, the pre-declared fallback is to chunk the already-buffered payload
 * into several synthetic `custom_tool_call_input.delta` frames — it needs no new parsing,
 * only a different split of text that has already been decoded.
 *
 * END-OF-STREAM FLUSH. A cancelled turn can stop with no terminal frame at all
 * (test/fixtures/codex-custom-tools/RESPONSES-API-COMPLIANCE.md documents this). The
 * delta frames were suppressed on the promise that `.done` would resynthesise them —
 * if `.done` never arrives, that promise is broken and the client is left with
 * `output_item.added` (input: '') and nothing else, ever, for that call. `patchedEnd`
 * flushes every call still in `buffered` with a NON-EMPTY accumulated string through the
 * SAME synthesis the `.done` branch uses (`synthesizeInputFrames` below), so a cut-off
 * stream still delivers whatever text arrived before the cut, with a warn logged per
 * call; a call registered right at the cut with nothing ever streamed for it has nothing
 * worth sending and is skipped. `output_item.done`, by contrast, DISCARDS rather than
 * flushes: on the DEPLOYED route it only ever follows `function_call_arguments.done`
 * (which already flushed and cleared `buffered`), so a NON-EMPTY leftover there means
 * upstream sent frames out of order — but on ORCHESTRATION (see ROUTE DIVERGENCE above)
 * `buffered` is ALWAYS still populated here, with an EMPTY string, which is that
 * route's normal shape rather than disorder. Either way the item's own `input` already
 * came from `restoreCustomToolCall` acting on `item.arguments`,
 * independent of anything buffered, and emitting synthesised `custom_tool_call_input.*`
 * frames AFTER the client has already received `output_item.done` for that item would
 * put them out of order at the client — worse than the discarded buffer this guards
 * against. Either way `buffered` (and the paired `itemIds`) must not outlive the call,
 * so this path clears both defensively too. Separately, the trailing-tail write below
 * needs a per-block termination check, not a blanket "always append `\n\n`":
 * `finalTail` itself (see `splitBlocks` in `../utils/sseFraming`) is by construction
 * never `\n\n`-terminated, and pass-through / `rebuildBlockWithSubstitution` output
 * preserves that — but when the tail IS a `function_call_arguments.done`, `rewriteBlock`
 * returns `sseBlock`-built frames that already end `\n\n`. The `endsWith('\n\n')` guard on
 * the write below is therefore load-bearing, not defensive: it is what makes both shapes
 * land correctly terminated. Getting this right matters because the buffered-arguments
 * flush below may now write MORE blocks right after the tail — an unterminated tail
 * block would run straight into them with no separator, corrupting the frame boundary on
 * the wire (this is exactly the coincidence case
 * `test/responses-custom-tools-stream.test.ts` covers). `installNamespaceInterceptor`,
 * the template this imitates, does NOT do this — its own trailing-tail write is
 * unconditionally unterminated, which is safe there only because nothing is ever written
 * after it in that interceptor. The two siblings intentionally diverge on this one
 * point; it is not an inconsistency to "fix" by matching them up.
 *
 * KNOWN GAPS (accepted, not fixed here):
 *   - the two synthesised frames carry no `sequence_number`/`obfuscation` fields, and
 *     suppressing the delta frames additionally punches gaps into the sequence numbers
 *     of the frames that DO survive. Neither field is currently known to be required by
 *     Codex's stream consumer; revisit if that changes.
 *   - the `emitted === 0` retry in `patchedWrite` below re-sends `carried + chunkStr`
 *     verbatim after an `originalWrite` throw, which is safe for the template this is
 *     copied from (stateless re-nesting) but not perfectly safe here: by the time the
 *     retry fires, `rewriteBlock` has already folded any suppressed delta into
 *     `buffered` for every block processed so far in this write. If an EARLIER block in
 *     the same chunk had already reached `.done` and been flushed before a LATER block's
 *     `originalWrite` throws, the retry resends the raw (unsuppressed) delta frames for
 *     the earlier call verbatim, duplicating the text the client already received via
 *     the synthesised frames. Accepted because the only realistic trigger for this path
 *     is a socket that is already gone, in which case nothing reaches the client either
 *     way.
 *   - a genuinely truncated tail — a stream cut off mid-JSON, not merely mid-block — is
 *     now promoted from a dropped fragment to a complete, terminated, but MALFORMED
 *     frame: previously an unterminated, unparseable fragment was simply invisible to a
 *     conformant SSE parser at EOF (no trailing blank line, so no event ever fires),
 *     whereas now it is `\n\n`-terminated and reaches the parser as a genuine (if
 *     broken) event. Behaviour is otherwise unchanged — `parseFrame` already failed to
 *     parse it and `rewriteBlock` already passed it through as-is — only its shape on
 *     the wire changed, from silently absent to present-but-invalid. Accepted; revisit
 *     if a client is observed choking on it.
 *   - `patchedEnd` below ignores any `chunk` argument passed to `res.end(chunk)` — it
 *     forwards `args` (a would-be chunk included) straight to `originalEnd` unprocessed,
 *     whereas pseudonymizationPlugin's own `patchedEnd` (`pseudonymization/index.ts`)
 *     explicitly rewrites a chunk argument before forwarding. The asymmetry is
 *     unreachable only by convention — nothing on this route calls `res.end(chunk)` with
 *     real content — not by any guarantee this interceptor enforces itself.
 *
 * ROBUSTNESS. A throw in here must never break the stream — the same three guards as
 * responsesNamespaceToolsPlugin's `installNamespaceInterceptor` (the template this
 * imitates): framing failures flush what was held and hand the chunk down untouched,
 * each block's rewrite degrades to pass-through individually, and an outer catch retries
 * with `carried + chunk` only while nothing of this write has reached the wire yet.
 */
function installCustomToolInterceptor(
  res: Response, names: Set<string>, hasToolSearch: boolean,
  hoistedNs: Record<string, string>, pluginLogger: Logger
): void {
  if ((res as any)[INTERCEPTOR_FLAG]) return;
  if (typeof (res as any).write !== 'function' || typeof (res as any).end !== 'function') return;
  (res as any)[INTERCEPTOR_FLAG] = true;

  const originalWrite = (res as any).write.bind(res);
  const originalEnd = (res as any).end.bind(res);

  let tail = '';                                  // partial block held across writes
  let restored = 0;                               // for the one summary log at end
  const tracked = new Set<number>();              // output_index values we own
  const buffered = new Map<number, string>();     // output_index -> accumulated arguments, cleared once flushed
  const itemIds = new Map<number, string | undefined>(); // output_index -> item id, for the end-of-stream flush

  /**
   * output_index values belonging to a translated `tool_search` call. Deliberately a SEPARATE
   * set from `tracked`, because the two need opposite delta handling.
   *
   * A custom tool's argument deltas are buffered and RESYNTHESISED as
   * custom_tool_call_input frames, because the client expects to watch the payload stream in.
   * A tool_search call gets no such treatment: the captured protocol emits only
   * output_item.added then output_item.done, with NO argument-delta frames of any kind
   * (tool-search-capture.md). So its deltas are suppressed and simply dropped — the complete
   * arguments arrive inside output_item.done, which is where the restore reads them. Nothing
   * is buffered, so nothing needs flushing at end of stream.
   */
  const searchTracked = new Set<number>();

  /**
   * Extract the freeform payload from raw (possibly incomplete, if the stream was cut
   * off mid-argument) JSON arguments text, and build the two custom_tool_call_input
   * frames the client sees in place of the suppressed delta stream. Shared by the
   * normal `.done` branch and the end-of-stream flush in `patchedEnd`, so a cut-off
   * stream reaches the client through the exact same synthesis rather than a
   * special-cased shape.
   */
  const synthesizeInputFrames = (raw: string, itemId: string | undefined, idx: number): string[] => {
    let text = raw;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.[FREEFORM_PARAM] === 'string') text = parsed[FREEFORM_PARAM];
    } catch { /* a model that ignored the JSON instruction, or a stream cut off mid-argument: pass the raw text through */ }
    const common = { item_id: itemId, output_index: idx };
    return [
      sseBlock({ type: 'response.custom_tool_call_input.delta', ...common, delta: text }),
      sseBlock({ type: 'response.custom_tool_call_input.done', ...common, input: text }),
    ];
  };

  /** Blocks to emit for one incoming block. Empty means the frame is suppressed. */
  const rewriteBlock = (block: string): string[] => {
    const frame = parseFrame(block);
    if (!frame) return [block];                   // comment, keep-alive, unparseable

    const idx: number = frame.output_index ?? 0;

    if (frame.type === 'response.output_item.added') {
      if (hasToolSearch && restoreToolSearchCall(frame.item)) {
        searchTracked.add(idx);
        restored += 1;
        return [rebuildBlockWithSubstitution(block, frame, { ...frame })];
      }
      // A call to a tool hoisted out of a tool_search_output: give it back its namespace.
      if (renestFunctionCall(frame.item, hoistedNs)) {
        restored += 1;
        return [rebuildBlockWithSubstitution(block, frame, { ...frame })];
      }
      if (!restoreCustomToolCall(frame.item, names)) return [block];
      tracked.add(idx);
      buffered.set(idx, '');
      itemIds.set(idx, frame.item?.id);
      // The item is streamed before its payload exists; `input` starts empty and the
      // custom_tool_call_input frames below fill it.
      frame.item.input = '';
      restored += 1;
      return [rebuildBlockWithSubstitution(block, frame, { ...frame })];
    }

    if (frame.type === 'response.function_call_arguments.delta') {
      // Dropped outright for tool_search: the real protocol has no argument-delta frame, and
      // the complete arguments arrive in output_item.done.
      if (searchTracked.has(idx)) return [];
      if (!tracked.has(idx)) return [block];
      if (typeof frame.delta === 'string') buffered.set(idx, (buffered.get(idx) ?? '') + frame.delta);
      return [];                                  // suppressed; re-emitted at .done
    }

    if (frame.type === 'response.function_call_arguments.done') {
      // Same reasoning as the delta above: no such frame exists in the tool_search protocol,
      // so it is dropped rather than translated into anything.
      if (searchTracked.has(idx)) return [];
      if (!tracked.has(idx)) return [block];
      const raw = typeof frame.arguments === 'string' ? frame.arguments : (buffered.get(idx) ?? '');
      const itemId = frame.item_id ?? itemIds.get(idx);
      buffered.delete(idx);
      itemIds.delete(idx);
      return synthesizeInputFrames(raw, itemId, idx);
    }

    if (frame.type === 'response.output_item.done') {
      if (searchTracked.has(idx) || hasToolSearch) {
        // The complete arguments live on this item, so this is where a tool_search call is
        // finally shaped for the client. Guarded by searchTracked OR hasToolSearch so a
        // stream whose `.added` frame was never seen still restores correctly.
        if (restoreToolSearchCall(frame.item)) {
          searchTracked.delete(idx);
          restored += 1;
          return [rebuildBlockWithSubstitution(block, frame, { ...frame })];
        }
      }
      if (renestFunctionCall(frame.item, hoistedNs)) {
        restored += 1;
        return [rebuildBlockWithSubstitution(block, frame, { ...frame })];
      }
      if (!restoreCustomToolCall(frame.item, names)) return [block];
      tracked.delete(idx);
      // On the DEPLOYED route this only ever follows function_call_arguments.done
      // (which already flushed and cleared `buffered`), so a NON-EMPTY leftover here
      // means upstream genuinely sent frames out of order — see the END-OF-STREAM
      // FLUSH note above for why this discards rather than flushes either way, and
      // warn, since real streamed text is being thrown away. On the ORCHESTRATION
      // route (see the ROUTE DIVERGENCE note above), by contrast, `buffered` is ALWAYS
      // still present here — set to '' at output_item.added and never touched, because
      // that route never sends a function_call_arguments.* frame to clear it — and that
      // is the route's NORMAL shape, not an anomaly. Testing emptiness rather than mere
      // presence is what tells the two cases apart; presence alone warned on every
      // single orchestration call.
      const leftover = buffered.get(idx);
      if (leftover) {
        pluginLogger.warn(`responsesCustomToolsPlugin: output_item.done for output_index ${idx} `
          + `arrived before function_call_arguments.done; discarding ${leftover.length} buffered char(s)`);
      }
      buffered.delete(idx);
      itemIds.delete(idx);
      restored += 1;
      return [rebuildBlockWithSubstitution(block, frame, { ...frame })];
    }

    if (TERMINAL_RESPONSE_TYPES.has(frame.type)) {
      // A client reconstructs the finished turn from this frame's `response.output`, so both
      // translations have to be undone here too, not only on the per-item frames.
      const n = restoreOutputItems(frame.response?.output, names)
        + (hasToolSearch ? restoreToolSearchItems(frame.response?.output) : 0)
        + renestOutputItems(frame.response?.output, hoistedNs);
      if (n === 0) return [block];
      restored += n;
      return [rebuildBlockWithSubstitution(block, frame, { ...frame })];
    }

    return [block];
  };

  (res as any).write = function patchedWrite(chunk: any, ...rest: any[]): boolean {
    const carried = tail;
    let chunkStr = '';
    let blocks: string[];
    try {
      chunkStr = chunk?.toString?.('utf8') ?? String(chunk);
      const split = splitBlocks(carried + chunkStr);
      tail = split.tail;
      blocks = split.blocks;
    } catch (error: any) {
      pluginLogger.error(`responsesCustomToolsPlugin: failed to frame a stream chunk: ${error.message}`);
      tail = '';
      if (carried) { try { originalWrite(carried); } catch { /* socket already gone */ } }
      return originalWrite(chunk, ...rest);
    }

    // Everything held back, or every block suppressed: a write callback must still fire,
    // because the layer below (pseudonymization) maintains the same invariant.
    const out: string[] = [];
    for (const block of blocks) {
      try {
        out.push(...rewriteBlock(block));
      } catch (error: any) {
        pluginLogger.error(`responsesCustomToolsPlugin: failed to rewrite a stream frame: ${error.message}`);
        out.push(block);                          // degrade to pass-through for THIS block
      }
    }

    if (out.length === 0) {
      const cb = rest[rest.length - 1];
      if (typeof cb === 'function') { try { cb(); } catch { /* never break the stream */ } }
      return true;
    }

    let emitted = 0;
    try {
      for (let i = 0; i < out.length; i += 1) {
        originalWrite(out[i], ...(i === out.length - 1 ? rest : []));
        emitted += 1;
      }
      return true;
    } catch (error: any) {
      pluginLogger.error(`responsesCustomToolsPlugin interceptor error: ${error.message}`, { stack: error.stack });
      if (emitted === 0) {
        tail = '';
        try { return originalWrite(carried + chunkStr, ...rest); } catch { /* socket already gone */ }
      }
      return true;
    }
  };

  (res as any).end = function patchedEnd(...args: any[]): any {
    if (tail) {
      const finalTail = tail;
      tail = '';
      let out: string[] = [finalTail];
      try { out = rewriteBlock(finalTail); } catch (error: any) {
        pluginLogger.error(`responsesCustomToolsPlugin: failed to rewrite the trailing partial block: ${error.message}`);
      }
      for (const block of out) {
        // See the END-OF-STREAM FLUSH note above: `block` already ends `\n\n` only when
        // rewriteBlock synthesised it via sseBlock (the function_call_arguments.done
        // case) — pass-through and rebuilt output preserve finalTail's own lack of a
        // terminator. This per-block check is what lands both shapes correctly
        // terminated, which matters once the buffered-arguments flush below may write
        // more blocks right after this one.
        const terminated = block.endsWith('\n\n') ? block : `${block}\n\n`;
        try { originalWrite(terminated); } catch (error: any) {
          pluginLogger.error(`responsesCustomToolsPlugin: failed to emit the trailing partial block: ${error.message}`);
        }
      }
    }

    // See the END-OF-STREAM FLUSH note on installCustomToolInterceptor: a call whose
    // function_call_arguments.done never arrived (e.g. the client cancelled the turn)
    // would otherwise vanish — the client saw output_item.added with input: '' and
    // nothing further. Flush it now through the same synthesis the .done branch uses.
    // A call still tracked but with nothing ever buffered (registered right at the cut,
    // before any delta arrived) has nothing worth sending — skip it rather than emit an
    // empty pair of frames.
    for (const [idx, raw] of buffered) {
      if (raw.length === 0) continue;
      pluginLogger.warn(`responsesCustomToolsPlugin: stream ended before function_call_arguments.done for `
        + `output_index ${idx}; flushing ${raw.length} buffered char(s)`);
      try {
        for (const out of synthesizeInputFrames(raw, itemIds.get(idx), idx)) originalWrite(out);
        restored += 1;
      } catch (error: any) {
        pluginLogger.error(`responsesCustomToolsPlugin: failed to flush buffered arguments for output_index ${idx} `
          + `at stream end: ${error.message}`);
      }
    }
    buffered.clear();
    itemIds.clear();

    if (restored > 0) {
      pluginLogger.info(`Restored ${restored} custom-tool frame(s) so the client can dispatch the call(s)`);
    }
    return originalEnd(...args);
  };
}

async function beforeHandler({ req, res, utils }: PluginContext): Promise<PluginResult> {
  const pluginLogger = utils.logger;
  try {
    const mode: CustomToolMode = configService.getCustomToolMode();

    // History is translated FIRST and unconditionally. A turn may replay
    // custom_tool_call items while declaring no custom tool at all (the model
    // stopped calling it), and orchestration 400s on the item type either way.
    const convertedItems = translateCustomCallItems(req.body);

    // tool_search is translated on the same unconditional footing, and for the same reason: a
    // replayed tool_search_output is a hard 400 on orchestration whether or not this turn still
    // declares the tool.
    const searchMode: ToolSearchMode = configService.getToolSearchMode();
    // Hoist FIRST: the conversion below rewrites the item and drops its `tools` array, so
    // anything not lifted out by then is lost.
    // Switchable: this is a workaround for codex gating deferred-tool exposure on the provider
    // host. When that is fixed upstream, set tool_search.hoist_discovered_tools=false to retire it.
    const hoist = configService.getToolSearchHoistDiscoveredTools()
      ? hoistDiscoveredTools(req.body)
      : { hoisted: [] as string[], map: {} as Record<string, string> };
    const convertedSearchItems = translateToolSearchOutputItems(req.body);
    const searchResult = translateToolSearchTool(req.body, searchMode);

    const result = translateCustomTools(req.body, mode);
    if (!result.changed && convertedItems === 0
        && !searchResult.changed && convertedSearchItems === 0) {
      return { stop: false };
    }

    if (result.changed) {
      pluginLogger.info(mode === 'strip'
        ? `Dropped Codex custom tool(s) [mode=strip]: removed [${result.dropped.join(', ')}]`
        : `Translated Codex custom tool(s) to function tools [mode=${mode}]: [${result.names.join(', ')}]`);
    }
    if (convertedItems > 0) {
      pluginLogger.info(`Translated ${convertedItems} replayed custom-tool history item(s) to function items`);
    }
    if (searchResult.changed) {
      pluginLogger.info(searchResult.dropped
        ? `Dropped the Codex tool_search tool [mode=${searchMode}]`
        : `Translated the Codex tool_search tool to a function tool [mode=${searchMode}]`);
    }
    if (convertedSearchItems > 0) {
      pluginLogger.info(`Translated ${convertedSearchItems} replayed tool_search_output item(s) to function items`);
    }
    if (hoist.hoisted.length > 0) {
      pluginLogger.info(`Hoisted ${hoist.hoisted.length} discovered tool(s) into the request so the `
        + `model can call them: [${hoist.hoisted.join(', ')}]`);
    }

    const names = new Set(result.names);
    if (names.size > 0) (req as any)[CUSTOM_NAMES_KEY] = names;
    if (searchResult.translated) (req as any)[TOOL_SEARCH_KEY] = true;
    if (hoist.hoisted.length > 0) (req as any)[HOISTED_NS_KEY] = hoist.map;

    // Either translation on its own is reason enough to install the interceptor; a turn can
    // carry tool_search without any custom tool.
    if (names.size === 0 && !searchResult.translated && hoist.hoisted.length === 0) {
      return { stop: false };
    }

    if ((req.body as any)?.stream === true) {
      // Installed here because an after handler never sees an SSE frame.
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      installCustomToolInterceptor(res, names, searchResult.translated, hoist.map, pluginLogger);
    }
    return { stop: false };
  } catch (error: any) {
    pluginLogger.error(`Error in responsesCustomToolsPlugin beforeHandler: ${error.message}`, { stack: error.stack });
    return { stop: false };
  }
}

/** The non-streaming response side. */
async function afterHandler({ req, upstreamResponse, utils }: PluginContext): Promise<any> {
  const pluginLogger = utils.logger;
  try {
    const names: Set<string> | undefined = (req as any)[CUSTOM_NAMES_KEY];
    const hasToolSearch = (req as any)[TOOL_SEARCH_KEY] === true;
    const hoistedNs: Record<string, string> = (req as any)[HOISTED_NS_KEY] || {};
    const hasHoist = Object.keys(hoistedNs).length > 0;
    if ((!names || names.size === 0) && !hasToolSearch && !hasHoist) return upstreamResponse;

    const n = names && names.size > 0 ? restoreOutputItems(upstreamResponse?.output, names) : 0;
    if (n > 0) pluginLogger.info(`Restored ${n} custom_tool_call shape(s) so the client can dispatch them`);

    const s = hasToolSearch ? restoreToolSearchItems(upstreamResponse?.output) : 0;
    if (s > 0) pluginLogger.info(`Restored ${s} tool_search_call shape(s) so the client can dispatch them`);

    const r = hasHoist ? renestOutputItems(upstreamResponse?.output, hoistedNs) : 0;
    if (r > 0) pluginLogger.info(`Re-nested ${r} hoisted-tool call(s) so the client can route them`);
    return upstreamResponse;
  } catch (error: any) {
    pluginLogger.error(`Error in responsesCustomToolsPlugin afterHandler: ${error.message}`, { stack: error.stack });
    return upstreamResponse;
  }
}

const pluginRules = [
  { id: 'responsesCustomToolsPlugin', match: [], strategy: 'before', handler: beforeHandler },
  { id: 'responsesCustomToolsPlugin', match: [], strategy: 'after', handler: afterHandler },
];

export = pluginRules;
