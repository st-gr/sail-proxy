/**
 * Run Anthropic's `web_search` server tool on the STREAMING path.
 *
 * webSearchPlugin's after-handler rebuilds the response content, but it runs on
 * the assembled non-streaming object — by the time it fires on
 * `invoke-with-response-stream`, the bytes are already on their way to the
 * client. So the search never executed there and the rewritten `tool_use` block
 * reached the client verbatim: 14 frames against api.anthropic.com's 76, no
 * result block, no answer, and no search count. Claude Code always streams.
 *
 * This is the same shape `plugins/hostedTool/engine.ts` uses for
 * /openai/v1/responses: patch `res.write`, withhold the tool-call frames, run
 * the tool, splice the real blocks in, POST a continuation so the model writes
 * its answer, and report the continuation's own usage back to the caller
 * through the injected `onUsage` callback — this module stays tracker-agnostic
 * (it never imports usageTracker, exactly like its injected `Logger`), and the
 * caller folds each round additively into the request's usage metrics and
 * owns emitting the event, once, after `finalize()` resolves. It is a separate
 * module rather than an edit inside the 1785-line service because it owns a
 * state machine and is only testable on its own.
 *
 * Two rules govern everything below.
 *
 * RAW PASSTHROUGH. A block the interception does not act on is written back
 * byte for byte, never re-serialized from its parsed frame. `sseWriter.writePing`
 * emits a bare `: ping` SSE comment with no `data:` line at all, and
 * `sseWriter.writeDone` emits `data: [DONE]`; a re-serializing interceptor drops
 * the first (killing the keepalive) and mangles the second. `hostedTool/engine.ts`
 * takes the same care with its `emitRaw`.
 *
 * ONE MESSAGE. Everything the client sees is a single Anthropic message, however
 * many upstream turns it took to produce. Exactly one `message_start`, one
 * `message_delta`, one `message_stop` reach it: the continuation's own
 * `message_start`/`message_stop` are dropped, and only the last `message_delta`
 * survives, carrying `usage.server_tool_use` — the field, and the only field,
 * Claude Code reads to render "N searches executed".
 */
import { Response } from 'express';
import axios from 'axios';
import { createWebSearchInterceptor, PendingSearch } from './anthropicStreamInterceptor';
import { serverToolUseFrames, webSearchResultFrames, serverToolUseId } from './anthropicStreamFrames';
import { executeWebSearch, Logger, SearchResult } from './searchExecutor';
import {
  isWebSearchTool,
  WEB_SEARCH_TOOL_NAME,
  buildWebSearchToolResultContent,
} from './webSearchTool';

/**
 * One continuation round's own token usage, in Anthropic's wire field names —
 * EXCLUSIVE regime: `input_tokens` counts only full-rate tokens, with the
 * cache categories reported as separate line items never folded into it, the
 * same as the first turn's own accounting. Never a running total across
 * rounds — `onUsage` fires once per round with THAT round's numbers, so a
 * caller folding several rounds does so additively, never by replacing a
 * previous value.
 */
export interface ContinuationUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface WebSearchStreamOptions {
  res: Response;
  /** The deployment URL the first turn was POSTed to; the continuation reuses it. */
  targetUrl: string;
  authToken: string;
  /** The upstream payload of the first turn. Cloned, never mutated. */
  requestBody: any;
  timeoutMs: number;
  logger: Logger;
  /**
   * Total searches this request may run, across every continuation round.
   * Bounds a model that keeps calling web_search after every answer; the caller
   * passes `configService.getWebSearchMaxSearches()`, the same cap the Responses
   * hosted-tool path honours.
   */
  maxSearches?: number;
  /**
   * Called once per continuation round — never for the first turn, which the
   * caller already records before this module ever runs — with that round's
   * usage parsed from its own `message_start`/`message_delta` frames. Optional:
   * a caller that omits it (module-level tests, mainly) simply is not told.
   */
  onUsage?: (usage: ContinuationUsage) => void;
}

export interface WebSearchStreamHandle {
  /** Call once the upstream stream has ended. Resolves when the client stream is complete. */
  finalize(): Promise<void>;
}

const DEFAULT_MAX_SEARCHES = 5;

/** Terminal frames must not reach the client until the continuation has run. */
const TERMINAL = new Set(['message_delta', 'message_stop']);

/**
 * The tool_result for a `web_search` call the cap refused to run. It exists so
 * the model still gets a turn in which to ANSWER: every tool_use needs a
 * tool_result, and a refused call that is simply dropped ends the turn with
 * searches and no reply. Phrased as an instruction rather than an error because
 * upstream this is an ordinary function tool, and the useful outcome is a written
 * answer from the results already gathered.
 *
 * BELT AND BRACES, NOT THE MECHANISM. Live replay: handed exactly this text, the
 * model asked for a fourth search anyway. Prose does not constrain a model that
 * can still see the tool — `stripWebSearchTool` is what actually stops it.
 */
const CAP_REACHED_TOOL_RESULT =
  'The web search budget for this request is exhausted. No further searches can be run. '
  + 'Answer the question now using the search results you have already been given.';

/**
 * Take `web_search` off the table for the continuation that has to ANSWER.
 *
 * The cap stops us RUNNING searches; it did nothing to stop the model ASKING.
 * The continuation body spreads the original request, whose `tools` still
 * declares web_search, so live the model spent its answering turn requesting a
 * fourth search — refused, turn ended, and the client got three searches and no
 * text for the second round running. Asking a model in prose not to use a tool
 * sitting in front of it is a suggestion; removing the tool is a constraint.
 *
 * Only web_search goes. A real Claude Code request carries many tools and the
 * model may legitimately need them in the same turn, so the rest are left alone.
 *
 * NOT `tool_choice: {"type":"none"}`. That would need the SAP Bedrock passthrough
 * to honour it, and we have no capture proving it does — a unit test cannot
 * produce one, since the deployment is exactly what a unit test mocks away.
 * Stripping the tool needs no cooperation from the deployment at all. (A forced
 * `tool_choice` carried into a continuation has already caused a loop elsewhere
 * in this project; the Responses hosted-tool path relaxes it for that reason.)
 *
 * @param body mutated in place — must be a fresh shallow copy, never the caller's request
 */
function stripWebSearchTool(body: any): void {
  if (!Array.isArray(body.tools)) return;
  const kept = body.tools.filter((tool: any) => !isWebSearchTool(tool));
  if (kept.length === body.tools.length) return;

  if (kept.length === 0) {
    // An empty `tools: []` is not the same request as one that declares no tools,
    // and some validators reject it. Omit the key.
    delete body.tools;
  } else {
    body.tools = kept;
  }

  // A tool_choice naming the tool we just removed is a 400, and one demanding
  // some tool when none is left is unanswerable. Dropping the key falls back to
  // `auto`, which is what an answering turn wants anyway.
  const choice = body.tool_choice;
  if (choice && (kept.length === 0 || choice.name === WEB_SEARCH_TOOL_NAME || choice.type === 'any')) {
    delete body.tool_choice;
  }
}

function sseBlock(frame: any): string {
  return `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`;
}

interface ParsedBlock {
  /** The block exactly as it arrived, minus its terminating blank line. */
  raw: string;
  /** Its `data:` payload parsed as JSON, or null for comments and non-JSON blocks. */
  frame: any | null;
}

/** Split SSE text into blocks, tolerating a trailing partial one. */
function parseBlocks(text: string): { blocks: ParsedBlock[]; rest: string } {
  const parts = text.split('\n\n');
  const rest = parts.pop() ?? '';
  const blocks: ParsedBlock[] = [];
  for (const raw of parts) {
    const line = raw.split('\n').find((l) => l.startsWith('data: '));
    let frame: any = null;
    if (line) {
      try { frame = JSON.parse(line.slice(6)); } catch { frame = null; }
    }
    blocks.push({ raw, frame });
  }
  return { blocks, rest };
}

function toText(chunk: any): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk && typeof chunk.toString === 'function') return chunk.toString('utf8');
  return String(chunk);
}

export function installWebSearchStreamInterception(
  opts: WebSearchStreamOptions,
): WebSearchStreamHandle {
  const { res, logger } = opts;
  const maxSearches = typeof opts.maxSearches === 'number' && opts.maxSearches > 0
    ? opts.maxSearches
    : DEFAULT_MAX_SEARCHES;
  const interceptor = createWebSearchInterceptor();
  const originalWrite = res.write.bind(res) as (chunk: any) => boolean;

  /** Bytes of an SSE block split across chunk boundaries. */
  let carry = '';
  /**
   * Completed web_search calls awaiting execution. A QUEUE, not a slot: a turn
   * can contain parallel web_search blocks, and `takePending()` dequeues one per
   * call, so it is drained in a loop after every observed frame.
   */
  const pendingCalls: PendingSearch[] = [];
  /**
   * The next free CLIENT-visible block index.
   *
   * Upstream indices cannot be echoed. A held web_search block consumes an
   * upstream index the client never sees, so upstream `tool_use@0` followed by
   * `text@1` would hand the client a first block at index 1 with a hole at 0 —
   * and api.anthropic.com always numbers contiguously from 0, so a client that
   * index-assigns into a content array gets a gap. Every block the client is
   * given, forwarded or synthesized, takes the next number from this counter.
   */
  let nextIndex = 0;
  let searchesRun = 0;
  /**
   * Whether ANY frame was withheld from the client this request — which is not
   * the same as "a search is pending".
   *
   * The interceptor holds every frame of a web_search block as it arrives, then
   * yields a pending call only if the accumulated input parses to a non-empty
   * query. Three reachable ways it holds and yields nothing: the stream is
   * truncated mid-input; the model emits `{"query":""}`; and
   * `bedrockStreamParser` assigns `partial_json: delta.toolUse.input` verbatim,
   * so a non-string input accumulates as the literal "[object Object]".
   *
   * Keying the decision on `pendingCalls` instead let the first turn's
   * `message_delta` — `stop_reason: "tool_use"` — and its `message_stop` through
   * while the `tool_use` block itself had been withheld: the client is told to
   * answer a tool call it cannot see, and waits forever. Whatever we withhold,
   * WE owe the ending for.
   */
  let heldAnything = false;
  /**
   * The most recent `message_delta` withheld from the client. The last one wins:
   * it carries the stop_reason and token counts of the turn that actually
   * answered, and it is the frame `usage.server_tool_use` is attached to.
   */
  let lastMessageDelta: any = null;
  let restored = false;

  /** Whether the client is still there to be written to. */
  function clientGone(): boolean {
    return Boolean((res as any).writableEnded || (res as any).destroyed);
  }

  /**
   * Every write this module makes goes through here.
   *
   * The interception holds the stream open for SECONDS — a Perplexity search plus
   * a SAP continuation — and the handler's `response.data.on('error')` stays live
   * throughout, wired to `sseWriter.writeError`, which calls `res.end()`. Writing
   * to a ServerResponse after `end()` makes it emit `'error'`; there is no
   * `uncaughtException` handler anywhere in `src/`, so that unhandled emit takes
   * the whole process down and every other in-flight request with it. A client
   * that simply disconnects mid-search does the same thing by a different route.
   *
   * Returning early rather than throwing is deliberate: by the time the client is
   * gone there is nothing useful left to do, and the caller's job is to stop, not
   * to handle an error.
   */
  function safeWrite(text: string): boolean {
    if (clientGone()) return false;
    return originalWrite(text);
  }

  function writeRaw(block: ParsedBlock): void {
    safeWrite(`${block.raw}\n\n`);
  }

  function drainPending(source: { takePending(): PendingSearch | null }): void {
    for (let taken = source.takePending(); taken; taken = source.takePending()) {
      pendingCalls.push(taken);
    }
  }

  /**
   * Upstream-index → client-index translation for ONE upstream turn. Each turn
   * needs its own: a continuation restarts its block indices at 0, and those are
   * different blocks from the first turn's index 0.
   *
   * A `content_block_start` claims the next client index; the block's later
   * delta/stop frames look up what it claimed. Returns null for a frame with no
   * index (message_start, ping) and for a block whose start was never seen, and
   * the caller then leaves the frame alone.
   */
  function createIndexMapper(): (frame: any) => number | null {
    const assigned = new Map<number, number>();
    return (frame: any): number | null => {
      if (typeof frame?.index !== 'number') return null;
      if (frame.type === 'content_block_start') {
        const clientIndex = nextIndex++;
        assigned.set(frame.index, clientIndex);
        return clientIndex;
      }
      const existing = assigned.get(frame.index);
      return existing === undefined ? null : existing;
    };
  }

  /**
   * Forward a block, renumbered if the client's index for it differs from
   * upstream's. When it does not differ — the common case, where nothing has been
   * withheld yet — the original bytes go out untouched rather than being rebuilt
   * from the parsed frame.
   */
  function writeMapped(block: ParsedBlock, clientIndex: number | null): void {
    if (clientIndex === null || clientIndex === block.frame.index) { writeRaw(block); return; }
    safeWrite(sseBlock({ ...block.frame, index: clientIndex }));
  }

  const firstTurnIndex = createIndexMapper();

  (res as any).write = function patchedWrite(chunk: any, ..._rest: any[]): boolean {
    const parsed = parseBlocks(carry + toText(chunk));
    carry = parsed.rest;

    for (const block of parsed.blocks) {
      // Comments (`: ping`), `data: [DONE]`, anything that is not a JSON frame:
      // nothing here has an opinion about it, so it goes out unchanged.
      if (!block.frame) { writeRaw(block); continue; }

      const verdict = interceptor.observe(block.frame);
      drainPending(interceptor);

      if (verdict === 'hold') { heldAnything = true; continue; }

      // A terminal frame ends the CLIENT's turn. If anything was withheld the
      // turn is not over — the model still has to answer, or at minimum be given
      // a coherent ending — so hold it and let finalize() decide. Without this
      // the client sees message_stop before the answer and closes the stream.
      if (TERMINAL.has(block.frame.type) && heldAnything) {
        if (block.frame.type === 'message_delta') lastMessageDelta = block.frame;
        continue;
      }

      writeMapped(block, firstTurnIndex(block.frame));
    }
    return true;
  };

  /** Emit the two golden blocks for one executed search. */
  function emitSearchBlocks(toolUseId: string, query: string, results: SearchResult[]): void {
    const useIndex = nextIndex++;
    const resultIndex = nextIndex++;
    for (const f of serverToolUseFrames(toolUseId, query, useIndex)) safeWrite(sseBlock(f));
    for (const f of webSearchResultFrames(toolUseId, results, resultIndex)) safeWrite(sseBlock(f));
  }

  /**
   * POST one continuation turn and forward it to the client as a continuation of
   * the SAME message: its blocks renumbered onto the client's own contiguous
   * sequence, message_start/message_stop dropped, message_delta withheld, and any
   * further web_search call it makes intercepted by its own interceptor rather
   * than leaked raw.
   */
  async function streamContinuation(body: any): Promise<void> {
    const roundIndex = createIndexMapper();
    const roundInterceptor = createWebSearchInterceptor();
    let contCarry = '';
    /**
     * THIS round's own message_start/message_delta, kept apart from the
     * shared `lastMessageDelta` above (which is the CLIENT-facing frame and
     * survives across rounds — reusing it here would double-report a round
     * whose own continuation produced nothing, or misattribute a later
     * round's message_delta to this one).
     */
    let roundMessageStart: any = null;
    let roundMessageDelta: any = null;

    let response: any;
    try {
      response = await axios.post(opts.targetUrl, body, {
        headers: {
          Authorization: `Bearer ${opts.authToken}`,
          'Content-Type': 'application/json',
          'AI-Resource-Group': process.env.SAP_AI_RESOURCE_GROUP || 'default',
        },
        responseType: 'stream',
        timeout: opts.timeoutMs,
      });
    } catch (error: any) {
      // finalize() still owes the client a message_delta and a message_stop; it
      // emits them whatever happened here, so a failed continuation costs the
      // answer, not the connection.
      logger.error(`web_search continuation request failed: ${error.message}`);
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => { if (!settled) { settled = true; resolve(); } };

      response.data.on('data', (chunk: Buffer) => {
        const parsed = parseBlocks(contCarry + toText(chunk));
        contCarry = parsed.rest;

        for (const block of parsed.blocks) {
          if (!block.frame) { writeRaw(block); continue; }

          const verdict = roundInterceptor.observe(block.frame);
          drainPending(roundInterceptor);
          if (verdict === 'hold') continue;

          // The client is already inside a message: a second message_start would
          // be a protocol error, and message_stop is finalize()'s to emit. Both
          // are still read for usage before being dropped — SAP's own capture
          // shows `message_delta.usage` repeating message_start's input/cache
          // fields alongside the turn's final output_tokens, so message_delta
          // is preferred below and message_start is only the fallback for a
          // round that never got one (e.g. a stream cut short).
          if (block.frame.type === 'message_start') { roundMessageStart = block.frame; continue; }
          if (block.frame.type === 'message_stop') continue;
          if (block.frame.type === 'message_delta') { lastMessageDelta = block.frame; roundMessageDelta = block.frame; continue; }

          writeMapped(block, roundIndex(block.frame));
        }
      });
      response.data.on('end', finish);
      response.data.on('error', (err: any) => {
        logger.error(`web_search continuation stream failed: ${err.message}`);
        finish();
      });
    });

    if (opts.onUsage && (roundMessageDelta || roundMessageStart)) {
      const deltaUsage = roundMessageDelta?.usage || {};
      const startUsage = roundMessageStart?.message?.usage || {};
      opts.onUsage({
        input_tokens: deltaUsage.input_tokens ?? startUsage.input_tokens ?? 0,
        output_tokens: deltaUsage.output_tokens ?? startUsage.output_tokens ?? 0,
        cache_creation_input_tokens: deltaUsage.cache_creation_input_tokens ?? startUsage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: deltaUsage.cache_read_input_tokens ?? startUsage.cache_read_input_tokens ?? 0,
      });
    }
  }

  /**
   * Run every pending search, then the continuation that answers it, then any
   * search that continuation asks for, until the model stops asking or the cap
   * is hit.
   *
   * Stopping the SEARCHING is not the same as ending the TURN. An earlier version
   * hit the cap, dropped the outstanding calls and broke out of the loop; live
   * against the real deployment that produced 20 frames of three server_tool_use
   * and three web_search_tool_result blocks, ZERO text blocks, and a tidy
   * `stop_reason: "end_turn"` — the user asked a question, got three searches, and
   * no answer. A call we refuse to run still has to be ANSWERED, so the model gets
   * its turn to write a reply from the results it already has.
   */
  async function runRounds(): Promise<void> {
    const messages: any[] = Array.isArray(opts.requestBody?.messages)
      ? [...opts.requestBody.messages]
      : [];

    while (pendingCalls.length > 0) {
      // Nobody left to answer. Stop before spending a Perplexity search and a SAP
      // continuation — seconds of work and real money — writing to a socket that
      // has already closed.
      if (clientGone()) {
        logger.info(`Client disconnected; abandoning ${pendingCalls.length} pending web_search call(s)`);
        pendingCalls.length = 0;
        return;
      }

      // One upstream turn's worth of calls. Everything the model asked for is
      // answered in a single assistant/user pair, whether or not we ran it: a
      // tool_use with no matching tool_result is a 400 from the deployment.
      const turnCalls = pendingCalls.splice(0);
      const budget = Math.max(0, maxSearches - searchesRun);
      const affordable = turnCalls.slice(0, budget);
      const refused = turnCalls.slice(budget);

      const toolUseBlocks: any[] = [];
      const toolResultBlocks: any[] = [];

      for (const call of affordable) {
        let results: SearchResult[] = [];
        try {
          results = await executeWebSearch(call.query, logger);
        } catch (error: any) {
          // A failed search must not strand the client mid-stream. Emit an empty
          // result block so the shape stays valid, and let the model answer
          // without sources rather than hanging.
          logger.error(`web_search failed for "${call.query}": ${error.message}`);
          results = [];
        }
        searchesRun += 1;

        emitSearchBlocks(serverToolUseId(), call.query, results);

        // The continuation turn: the assistant's tool call, then its result, so
        // the model can answer. The deployment has no server tools, so this is
        // an ordinary tool_use / tool_result exchange, and `call.toolUseId` must
        // be the id the MODEL minted — the srvtoolu_ id above is the client's
        // view of the same call and means nothing upstream.
        toolUseBlocks.push({
          type: 'tool_use', id: call.toolUseId, name: WEB_SEARCH_TOOL_NAME, input: { query: call.query },
        });
        toolResultBlocks.push({
          type: 'tool_result', tool_use_id: call.toolUseId, content: buildWebSearchToolResultContent(results),
        });
      }

      for (const call of refused) {
        // Answered but not run. No client-facing block is emitted for it: the
        // client is never told a search it cannot see was declined, and
        // Anthropic's own shape for this (a web_search_tool_result whose content
        // is an error object with error_code "max_uses_exceeded") is DOCUMENTED
        // BUT NOT CAPTURED by us, so synthesizing it would be guessing at a wire
        // shape. Upstream this is an ordinary function tool anyway, so it gets an
        // ordinary tool_result — prose the model can act on, not an error code it
        // would have to recognise.
        toolUseBlocks.push({
          type: 'tool_use', id: call.toolUseId, name: WEB_SEARCH_TOOL_NAME, input: { query: call.query },
        });
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: call.toolUseId,
          content: CAP_REACHED_TOOL_RESULT,
        });
      }

      if (refused.length > 0) {
        logger.warn(`web_search cap of ${maxSearches} reached; ${refused.length} call(s) refused, asking the model to answer with what it has`);
      }

      messages.push({ role: 'assistant', content: toolUseBlocks });
      messages.push({ role: 'user', content: toolResultBlocks });

      const continuationBody: any = { ...opts.requestBody, messages };
      if (refused.length > 0) {
        // This is the answering turn. The tool it has already overspent must not
        // be on the menu, or it just asks again — which is what live did.
        stripWebSearchTool(continuationBody);
      }
      await streamContinuation(continuationBody);

      if (refused.length > 0) {
        // That continuation was the one asked to ANSWER. Whatever it asks for
        // next cannot be granted — the budget is already spent — and granting it
        // a further round would be an unbounded loop, so the turn ends here with
        // whatever text it produced.
        if (pendingCalls.length > 0) {
          logger.warn(`web_search cap of ${maxSearches} reached; ignoring ${pendingCalls.length} call(s) from the final continuation`);
          pendingCalls.length = 0;
        }
        return;
      }
    }
  }

  return {
    async finalize(): Promise<void> {
      // Whether we withheld anything — NOT whether a search is pending. A turn
      // whose web_search block was held but yielded no runnable query (truncated
      // input, empty query, non-string partial_json) still had its tool_use block
      // taken away from the client, so it still needs an ending from us. Keying
      // this on `pendingCalls` let the original `stop_reason: "tool_use"` through
      // and told the client to answer a call it had never been shown.
      const intercepted = heldAnything;
      try {
        if (!intercepted) {
          // Nothing was withheld. A trailing partial block is upstream's own
          // bytes and belongs to the client.
          if (carry.length > 0) { safeWrite(carry); carry = ''; }
          return;
        }
        if (carry.length > 0) {
          logger.debug(`Dropping ${carry.length} trailing byte(s) of an incomplete SSE block`);
          carry = '';
        }

        try {
          await runRounds();
        } catch (error: any) {
          logger.error(`web_search streaming interception failed: ${error.message}`);
        }

        const delta = lastMessageDelta || {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 0 },
        };
        delta.type = 'message_delta';
        // The client was never shown a tool_use block, so it has nothing to
        // answer: `tool_use` here — from a capped or failed round — would leave
        // it waiting for a tool call it cannot see.
        if (delta.delta && delta.delta.stop_reason === 'tool_use') delta.delta.stop_reason = 'end_turn';
        delta.usage = {
          ...(delta.usage || {}),
          server_tool_use: { web_search_requests: searchesRun, web_fetch_requests: 0 },
        };
        safeWrite(sseBlock(delta));
        safeWrite(sseBlock({ type: 'message_stop' }));
      } finally {
        if (!restored) {
          (res as any).write = originalWrite;
          restored = true;
        }
      }
    },
  };
}
