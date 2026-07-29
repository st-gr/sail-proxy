/**
 * Codex sub-agent (`namespace`) tool support for the Responses route.
 *
 * SAP AI Core rejects the `namespace` tool type outright, killing any Codex turn that
 * has multi_agent enabled — which is the default. This plugin flattens the wrapper
 * into the ordinary function tools it contains on the way out, and restores the
 * `namespace` field on the way back, which Codex REQUIRES to route the call:
 * measured against Codex 0.145.0, a call without it is refused by
 * `codex_core::tools::router` as `unsupported call: <name>`, while the same call with
 * it dispatches.
 *
 * Both halves or neither — a flatten with no re-nest fails silently at the client,
 * which is worse than the 400 it replaces. `strip` mode exists for deployments where
 * the flattened set is still unacceptable; it stashes an empty map so the response
 * side is a no-op.
 *
 * The response side exists twice, because after-plugins never run per SSE frame: the
 * after handler covers a non-streaming reply, and `installNamespaceInterceptor` covers a
 * live stream. Codex CLI streams by default, so the interceptor is the path that carries
 * real traffic; its frame contract is documented at its definition.
 *
 * @see namespaceTools/adapter.ts - the pure transformations
 * @see ../utils/sseFraming.ts - the block framing shared with responsesWebSearchPlugin
 * @see responsesNamespaceToolsPlugin.md - operator documentation
 */
import { Request, Response } from 'express';
import configService from '../services/configService';
import {
  flattenNamespaceTools, renestFunctionCall, renestOutputItems, NamespaceToolMode,
} from './namespaceTools/adapter';
import {
  TERMINAL_RESPONSE_TYPES, splitBlocks, parseFrame, rebuildBlockWithSubstitution,
} from '../utils/sseFraming';

interface Logger {
  error: (m: string, meta?: any) => void; warn: (m: string, meta?: any) => void;
  info: (m: string, meta?: any) => void; debug: (m: string, meta?: any) => void;
  trace: (m: string, meta?: any) => void;
}
interface PluginContext { req: Request; res: Response; utils: { logger: Logger }; upstreamResponse?: any }
interface PluginResult { stop: boolean }

/**
 * Where the before handler leaves `toolName -> namespaceName` for the after handler to
 * pick up. The streaming interceptor is handed the same map directly at install time.
 */
const NAMESPACE_MAP_KEY = '__namespaceToolMap';

/** Guards against a second install if the before handler ever runs twice on one response. */
const INTERCEPTOR_FLAG = '__namespaceToolsInterceptorInstalled';

/**
 * Restore the routing `namespace` on a LIVE SSE stream — the path that actually matters,
 * because Codex CLI streams by default and an after handler never sees a frame.
 *
 * FRAME CONTRACT. A `function_call` reaches the client in exactly three places, and Codex
 * needs the namespace in all three (it routes by `(namespace, name)`, and the terminal
 * frame's `response.output` is what a client reconstructs the finished turn from):
 *
 *   1. `response.output_item.added`  — `frame.item` is the function_call
 *   2. `response.output_item.done`   — same
 *   3. `response.completed` / `.incomplete` / `.failed` — `frame.response.output[]`
 *
 * Everything else is passed through untouched, and a frame is re-serialised ONLY when a
 * re-nest actually changed something: a stream that never calls a namespaced tool — every
 * non-Codex client on this route — reaches the client byte-for-byte identical, `event:`
 * and `id:` lines included. That is the property that makes installing this on the shared
 * `responses-stream` hook safe.
 *
 * LAYERING — the order is load-bearing, and THE TWO HOOK ARRAYS SHIP IN OPPOSITE ORDERS
 * ON PURPOSE. Do not normalise them to match:
 *
 *   defaultHooks.openai.responses-stream : pseudonymization -> this plugin -> web-search
 *   defaultHooks.openai.responses        : pseudonymization -> web-search -> this plugin
 *
 * Same requirement in both — this plugin must observe whatever web-search produced — but
 * two consumers that walk the array in opposite directions:
 *
 *   - STREAMING. Each `before` handler patches `res.write` and binds `originalWrite` at
 *     install time, so the LAST installed is OUTERMOST: a controller write runs
 *     `web-search -> namespace -> pseudonymization -> socket`. Listed EARLIER, this plugin
 *     installs first and ends up nested INSIDE web-search, which is where it must be —
 *     web-search does not merely forward what the controller writes, it GENERATES frames
 *     of its own off a continuation POST that never passes through `res.write` at all
 *     (each continuation round's items, plus a terminal frame it rebuilds wholesale from
 *     items it collected itself), and anything an outer interceptor generates is invisible
 *     to the layers above it.
 *
 *   - NON-STREAMING. `executeAfterPlugins` (services/pluginExecutor.ts) walks the array IN
 *     ORDER, feeding each handler the previous one's return value. Web-search's after
 *     handler returns `{...current, output: [...clientItems, ...finalOutput]}` with
 *     `finalOutput` lifted off the continuation POST's response — so this plugin's after
 *     handler must be listed LATER, and run last, to see it at all.
 *
 * Get either one backwards and a `spawn_agent` call the model made in a continuation round
 * reaches Codex with no `namespace`, and its router refuses it — `unsupported call:
 * spawn_agent`, the precise silent failure this plugin exists to prevent. (Both directions
 * were shipped wrong at some point on this branch: streaming first, then, after a fix that
 * swapped BOTH arrays, non-streaming.)
 *
 * The two are otherwise non-interfering: web-search suppresses frames for `web_search`
 * calls only, and this one touches only names present in the flatten map — a hoisted
 * namespace tool is never the hosted web_search tool. Web-search's injected
 * `web_search_call` and `message` items are not `function_call`s, so `renestFunctionCall`
 * rejects them and their blocks pass through byte-identical. Web-search also hands down
 * whole `\n\n`-terminated blocks, so `tail` below stays empty on that path — bar the
 * trailing partial block its `patchedEnd` flushes, which `patchedEnd` here then flushes on
 * in turn because web-search's deferred close runs through this layer's `end`.
 *
 * Masking stays innermost either way — pseudonymizationPlugin is index 0 in BOTH arrays,
 * the one constraint that never moves: writing through `originalWrite` keeps the unmasker
 * in the chain, and web-search still reads still-masked upstream bytes above it.
 * (Both orders are pinned by test/responses-tool-plugin-layering.test.ts, which reads each
 * one out of the shipped config rather than restating it, drives the two after handlers as
 * a chain for the non-streaming direction, and asserts outright that the two arrays
 * disagree — so "tidying" them into agreement fails by name.)
 *
 * ROBUSTNESS. A throw in here must never break the stream. Three guards, and it is worth
 * being precise about what each one actually buys:
 *
 *   - the framing step: on failure the held-back prefix is flushed and the chunk handed
 *     down untouched, so nothing is lost or reordered;
 *   - each block's REWRITE individually: that block degrades to pass-through, keeping every
 *     byte and losing only the namespace on a call that was going to be unroutable anyway;
 *   - an outer catch. This one covers `originalWrite` itself throwing, which the per-block
 *     guard does NOT — a write that throws on block k of n still loses blocks k..n. That is
 *     accepted rather than fixed: the only realistic way the layer below throws is a socket
 *     that is already gone, in which case the remaining blocks had nowhere to go. It retries
 *     with `carried + chunk` only while nothing of this write has reached the wire, since
 *     retrying after a partial emit would duplicate what already went out.
 */
function installNamespaceInterceptor(
  res: Response, map: Record<string, string>, pluginLogger: Logger
): void {
  if ((res as any)[INTERCEPTOR_FLAG]) return;
  if (typeof (res as any).write !== 'function' || typeof (res as any).end !== 'function') return;
  (res as any)[INTERCEPTOR_FLAG] = true;

  const originalWrite = (res as any).write.bind(res);
  const originalEnd = (res as any).end.bind(res);

  let tail = '';        // partial block held across writes
  let renested = 0;     // frames actually rewritten, for the one summary log at end

  /**
   * The block as the client should receive it. `renestFunctionCall` / `renestOutputItems`
   * mutate in place and report the change as a boolean, so an unchanged frame is handed to
   * `rebuildBlockWithSubstitution` by identity (returning the original bytes) and a changed
   * one is handed a shallow copy purely to break that identity and force re-serialisation.
   */
  const rewriteBlock = (block: string): string => {
    const frame = parseFrame(block);
    if (!frame) return block;                            // comment, keep-alive, unparseable

    let changed = false;
    if (frame.type === 'response.output_item.added' || frame.type === 'response.output_item.done') {
      changed = renestFunctionCall(frame.item, map);
    } else if (TERMINAL_RESPONSE_TYPES.has(frame.type)) {
      changed = renestOutputItems(frame.response?.output, map) > 0;
    }
    if (!changed) return block;

    renested += 1;
    return rebuildBlockWithSubstitution(block, frame, { ...frame });
  };

  (res as any).write = function patchedWrite(chunk: any, ...rest: any[]): boolean {
    // Held back by a previous write. Captured before framing consumes it, because every
    // fallback below owes the stream `carried + chunk` — the raw chunk on its own is a
    // block with its head missing, and delivering that is corruption, not a drop.
    const carried = tail;
    let chunkStr = '';
    let blocks: string[];
    try {
      chunkStr = chunk?.toString?.('utf8') ?? String(chunk);
      const split = splitBlocks(carried + chunkStr);
      tail = split.tail;
      blocks = split.blocks;
    } catch (error: any) {
      // The chunk could not be re-framed at all. Flush anything held back FIRST so the
      // bytes stay in order, then hand the chunk down exactly as it arrived.
      pluginLogger.error(`responsesNamespaceToolsPlugin: failed to frame a stream chunk: ${error.message}`);
      tail = '';
      if (carried) {
        try { originalWrite(carried); } catch { /* socket already gone */ }
      }
      return originalWrite(chunk, ...rest);
    }

    // The whole chunk is held back as a partial block, so there is nothing to hand down —
    // but a write callback must still fire. pseudonymizationPlugin's interceptor maintains
    // exactly this invariant one layer below ("it must fire even when we buffer"), and this
    // interceptor now sits ABOVE it, so a callback that stops here would never reach it.
    if (blocks.length === 0) {
      const cb = rest[rest.length - 1];
      if (typeof cb === 'function') {
        try { cb(); } catch { /* a callback must never break the stream */ }
      }
      return true;
    }

    let emitted = 0;
    try {
      for (let i = 0; i < blocks.length; i += 1) {
        let out = blocks[i];
        try {
          out = rewriteBlock(blocks[i]);
        } catch (error: any) {
          // Degrade to pass-through for THIS block only: the client still gets every byte,
          // it just loses the namespace on a call it was going to lose anyway.
          pluginLogger.error(`responsesNamespaceToolsPlugin: failed to re-nest a stream frame: ${error.message}`);
        }
        // `rest` (an encoding and/or the write callback) rides on the LAST block, so the
        // callback fires exactly once and reaches the layer below that pops it.
        originalWrite(out, ...(i === blocks.length - 1 ? rest : []));
        emitted += 1;
      }
      return true;
    } catch (error: any) {
      pluginLogger.error(`responsesNamespaceToolsPlugin interceptor error: ${error.message}`, { stack: error.stack });
      // Only while none of this write is on the wire yet — retrying after a partial emit
      // would duplicate the blocks that already went out. What is owed is everything that
      // was framed, the new tail included, so nothing is retained for a later flush.
      if (emitted === 0) {
        tail = '';
        try { return originalWrite(carried + chunkStr, ...rest); } catch { /* socket already gone */ }
      }
      return true;
    }
  };

  (res as any).end = function patchedEnd(...args: any[]): any {
    if (tail) {
      // A final block that arrived without its `\n\n` terminator must not be dropped —
      // and if it parses, it is still a frame the client needs the namespace on.
      const finalTail = tail;
      tail = '';
      let out = finalTail;
      try {
        out = rewriteBlock(finalTail);
      } catch (error: any) {
        pluginLogger.error(`responsesNamespaceToolsPlugin: failed to re-nest the trailing partial block: ${error.message}`);
      }
      try {
        originalWrite(out);
      } catch (error: any) {
        pluginLogger.error(`responsesNamespaceToolsPlugin: failed to emit the trailing partial block: ${error.message}`);
      }
    }

    if (renested > 0) {
      pluginLogger.info(`Restored the namespace on ${renested} streamed frame(s) so the client can route the call(s)`);
    }
    return originalEnd(...args);
  };
}

async function beforeHandler({ req, res, utils }: PluginContext): Promise<PluginResult> {
  const pluginLogger = utils.logger;
  try {
    const mode: NamespaceToolMode = configService.getNamespaceToolMode();
    const result = flattenNamespaceTools(req.body, mode);
    if (!result.changed) return { stop: false };

    (req as any)[NAMESPACE_MAP_KEY] = result.map;
    // Branch on the mode: strip hoists nothing, so the flatten wording read
    // "Flattened ... hoisted []" — accurate, and exactly the wrong thing to be squinting
    // at mid-incident while working out why the client can see no sub-agent tools.
    pluginLogger.info(mode === 'strip'
      ? `Dropped Codex namespace tool(s) [mode=strip]: removed [${result.dropped.join(', ')}]`
      : `Flattened Codex namespace tool(s) [mode=${mode}]: hoisted [${result.hoisted.join(', ')}]`
        + (result.dropped.length > 0 ? `, dropped [${result.dropped.join(', ')}]` : ''));

    // The after handler never runs per SSE frame, so a streamed turn needs the response
    // side installed here instead. An empty map (strip mode, or every nested tool dropped
    // as a duplicate) has nothing to restore, so it gets no interceptor at all.
    if (req.body?.stream === true && Object.keys(result.map).length > 0) {
      installNamespaceInterceptor(res, result.map, pluginLogger);
    }
    return { stop: false };
  } catch (error: any) {
    pluginLogger.error(`Error in responsesNamespaceToolsPlugin beforeHandler: ${error.message}`, { stack: error.stack });
    return { stop: false };
  }
}

/**
 * The non-streaming response side. This must be the LAST tool plugin in
 * `defaultHooks.openai.responses` — `executeAfterPlugins` chains after handlers in array
 * order, and responsesWebSearchPlugin's rebuilds `output` from a continuation POST this
 * handler would otherwise never see. That is the opposite position to the one this plugin
 * takes in `responses-stream`; the LAYERING note above explains why the two must disagree.
 */
async function afterHandler({ req, upstreamResponse, utils }: PluginContext): Promise<any> {
  const pluginLogger = utils.logger;
  try {
    const map = (req as any)[NAMESPACE_MAP_KEY];
    if (!map || Object.keys(map).length === 0) return upstreamResponse;

    const n = renestOutputItems(upstreamResponse?.output, map);
    if (n > 0) pluginLogger.info(`Restored the namespace on ${n} function call(s) so the client can route them`);
    return upstreamResponse;
  } catch (error: any) {
    pluginLogger.error(`Error in responsesNamespaceToolsPlugin afterHandler: ${error.message}`, { stack: error.stack });
    return upstreamResponse;
  }
}

const pluginRules = [
  { id: 'responsesNamespaceToolsPlugin', match: [], strategy: 'before', handler: beforeHandler },
  { id: 'responsesNamespaceToolsPlugin', match: [], strategy: 'after', handler: afterHandler },
];

export = pluginRules;
