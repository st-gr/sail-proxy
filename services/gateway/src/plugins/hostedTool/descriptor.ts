/**
 * The contract a hosted OpenAI tool implements so `hostedTool/engine.ts` can emulate it
 * on the `/openai/v1/responses` route.
 *
 * SAP AI Core deployments reject hosted tool types outright, so the gateway rewrites each
 * one into a plain function tool the deployment accepts, runs the tool itself, and hands
 * the client back the hosted-tool response shape it expects. Everything about HOW that is
 * done — suppressing the model's `function_call` frames, injecting the synthetic call
 * item, POSTing the continuation, summing usage, shifting `output_index` — is transport
 * machinery and lives in the engine. Everything that is specific to ONE tool lives behind
 * this interface.
 *
 * Nothing here does I/O or reaches for the request: a descriptor is handed exactly the
 * request-scoped values it is allowed to see, via `PrepareCtx` / `ToolExecCtx`.
 *
 * @see engine.ts - the transport machinery that drives these
 * @see registry.ts - where descriptors are looked up by tool type / function name
 * @see ../webSearch/descriptor.ts - the first implementation
 */

/**
 * Structurally identical to `webSearch/searchExecutor`'s `Logger`, redeclared here so
 * nothing under `hostedTool/` has to import from a specific tool's directory.
 */
export interface Logger {
  error: (message: string, meta?: any) => void;
  warn: (message: string, meta?: any) => void;
  info: (message: string, meta?: any) => void;
  debug: (message: string, meta?: any) => void;
  trace: (message: string, meta?: any) => void;
}

/** One `function_call` the model emitted, with its arguments parsed by its descriptor. */
export interface ParsedCall {
  callId: string;
  /** The raw JSON `arguments` string, exactly as the model produced it. */
  rawArguments: string;
  /** Parsed function arguments. Shape is descriptor-specific. */
  args: any;
}

/**
 * The outcome of one call. A tool that could not be served still returns a result — the
 * turn has to complete either way, and a `function_call` POSTed back without a matching
 * `function_call_output` is the malformed shape the deployment rejects outright.
 *
 * `status` is separate from `error` on purpose: a call that never ran still has its
 * client-facing item read `failed`. `error.code` is optional and, when present, names
 * WHY the call did not run: a call blocked by a tool's per-request budget passes
 * `'cap_reached'`. Calls that failed for other reasons pass no code, so each
 * descriptor's renderOutput falls back to its own generic `<tool>_unavailable`.
 */
export interface ToolExecResult {
  call: ParsedCall;
  status: 'completed' | 'failed';
  /** Descriptor-specific payload; the render* methods below interpret it. */
  payload: any;
  /** Set when the call was attempted and failed. */
  error?: { message: string; code: string };
}

export interface PrepareCtx {
  ownerEmail: string | undefined;
  logger: Logger;
}

export interface ToolExecCtx {
  ownerEmail: string | undefined;
  /** Live pseudonymization ReplacementMap, or undefined when masking is off. */
  replacementMap: any;
  /**
   * The request's RESOLVED `MaskingConfig` — the very object pseudonymizationPlugin masked
   * the request body with — or undefined when masking is off for this request.
   *
   * Distinct from `remask`, and not a duplicate of it. `remask` replays the pairs the
   * REQUEST BODY already minted; it can only recognise a value the caller sent. A tool that
   * introduces text of its OWN (a `file_search` chunk read out of the gateway's corpus,
   * which was never in the request body) has to run DETECTION over it again, and detection
   * needs the category list — including `custom_entities`, the caller-supplied regex tier
   * that exists nowhere but in this config. Without it a caller who declared `EMP-\d{6}`
   * sensitive got it masked in their prompt and raw in every retrieved passage.
   *
   * Typed `any` for the same reason `replacementMap` is: nothing under `hostedTool/` should
   * have to import from a specific plugin's directory. The real type is
   * `pseudonymization/types`'s `MaskingConfig`.
   */
  maskingConfig: any;
  isStreaming: boolean;
  /** Whatever prepare() returned for this request. */
  prepared: unknown;
  /**
   * Re-mask text that is about to leave the process.
   *
   * The engine binds this per transport, and the two transports deliberately disagree.
   * On the NON-STREAMING path pseudonymizationPlugin has already unmasked the model's
   * `function_call` arguments in place, so anything derived from them (a search query,
   * most of all) carries raw PII and must be re-masked before it reaches a third party.
   * On the STREAMING path the interceptor is installed BEHIND pseudonymization's own
   * res.write interceptor and therefore reads every value while it is still masked — so
   * the engine binds the identity function there, and re-masking would only corrupt
   * masked-looking substrings inside the tool's own results.
   *
   * A descriptor must call this on any text it sends off-box, and must NOT call it on the
   * text it puts into client-facing items: the client is owed the unmasked value.
   *
   * @see ../webSearch/queryMasking.ts - the primitive and the full rationale
   */
  remask(text: string): string;
  logger: Logger;
}

export interface RenderCallItemOpts {
  /** True when the request carried include: ["<type>_call.results"] — OpenAI's token is
   *  named after the output item, not after the tool. See engine.ts's `renderOptsFor`. */
  includeResults: boolean;
}

/**
 * What `annotateMessage` needs beyond the results themselves.
 *
 * `replacementMap` is the live pseudonymization map when the message item's text is still
 * MASKED, and undefined when it is already unmasked. The two transports genuinely disagree
 * and the engine decides per site, so a descriptor must never guess:
 *
 *   streaming     — the interceptor sits BEHIND pseudonymization's own res.write, so every
 *                   frame it reads is still masked. The map is supplied; a descriptor that
 *                   computes offsets must unmask a COPY of the text and index into that.
 *   non-streaming — pseudonymizationPlugin's after handler (index 0) already unmasked the
 *                   deployment's first response, and the engine's own
 *                   `unmaskResponsesOutput` unmasked every continuation round. Undefined.
 */
export interface AnnotateMessageCtx {
  /** Live pseudonymization ReplacementMap when `item`'s text is masked, else undefined. */
  replacementMap: any;
}

export interface HostedToolDescriptor {
  /** The hosted tool `type` a client sends, e.g. `web_search`. */
  type: string;
  /** The function name the rewritten tool carries, and hence the model calls back with. */
  functionName: string;

  /**
   * Whether to stream `response.<type>_call.{in_progress,searching,completed}` between
   * the call item's `output_item.added` and `.done`.
   *
   * OPT-IN, and deliberately not defaulted on. It is set for `file_search`, where the
   * exact frame sequence was captured from a real OpenAI turn on 2026-08-06. OpenAI
   * streams `response.web_search_call.*` too, but nobody here has captured one — and
   * `test/responses-websearch-characterization.test.ts` pins web_search's frame bytes
   * precisely so that behaviour is not changed on an assumption. Capture it first, then
   * flip this and update that characterization in the same commit.
   */
  emitsCallLifecycleFrames?: boolean;

  /** The flat function tool the deployment accepts in place of the hosted one. */
  rewriteTool(hosted: any): any;

  /**
   * Per-request setup, run once by the before handler for each hosted tool present.
   * Whatever it returns is handed back to every `execute` for this request as
   * `ctx.prepared`.
   *
   * THROWING IS HOW A CALLER'S MISTAKE GETS REPORTED, and the engine reads the error to
   * decide which of the two it is (see `hostedToolBeforeHandler`):
   *
   *   - an error carrying a numeric HTTP `status` (400/409/...) is the CALLER's to fix —
   *     a store id that does not exist, a `max_num_results` out of range. The engine
   *     answers the request with that status and an OpenAI error envelope built from the
   *     error's `message` and, if it has one, its `code`, and the turn never opens.
   *   - an error WITHOUT a `status` is infrastructure — a database that is not
   *     configured, a connection refused. The engine logs it and carries on with
   *     `ctx.prepared === undefined`, so one tool's outage does not take down a request
   *     that may not even call it.
   *
   * This distinction is load-bearing for a retrieval tool: `prepare()` is the LAST moment
   * a caller can be told anything. Once the SSE stream is open a typo'd `vector_store_id`
   * and an empty corpus are the same observation — "no passages found" — forever.
   */
  prepare(hosted: any, ctx: PrepareCtx): Promise<unknown>;

  /** Parse the model's raw `arguments` string. Never throws: bad JSON yields empty args. */
  parseCall(callId: string, rawArguments: string): ParsedCall;

  /**
   * Run the call. Should not throw — return a `failed` result instead, so the turn stays
   * well-formed. The engine catches anyway.
   */
  execute(call: ParsedCall, ctx: ToolExecCtx): Promise<ToolExecResult>;

  /** The `function_call_output` item the continuation POST carries back to the model. */
  renderOutput(r: ToolExecResult): any;

  /** The synthetic hosted-tool call item the client sees in place of the function_call. */
  renderCallItem(r: ToolExecResult, opts: RenderCallItemOpts): any;

  /**
   * The query inside a hosted call item the CLIENT replayed back to us. The shapes differ
   * per tool (web_search carries `action.query`; file_search carries `queries[]`), which is
   * why this lives on the descriptor rather than in the engine. Returns '' for anything
   * malformed — a replayed item that yields no query is simply not replayable, and the
   * caller drops it rather than guessing.
   */
  replayQueryFrom?(item: any): string;

  /**
   * The UNMASKED subset of a result payload worth caching. Masking is a presentation step,
   * not a storage format: anything a descriptor derives for one request's audience (
   * file_search's `maskedResults`) is dropped here, so the cache holds only what the tool
   * actually retrieved.
   */
  cachePayloadFrom?(payload: unknown): unknown;

  /**
   * A cached unmasked payload, made presentable to THIS request's model. `renderOutput` may
   * emit request-scoped material (file_search masks document text through the request's own
   * ReplacementMap, whose placeholders are per-request under anonymization), so the masking
   * is redone here, inside the plugin that knows what is request-scoped about it.
   */
  rehydratePayload?(cachedPayload: unknown, ctx: ToolExecCtx): unknown;

  /**
   * The assistant `message` that dumps the results to the client, used ONLY on the paths
   * where no continuation can deliver the model's own answer. `null` for a tool that has
   * nothing readable to show — the engine then emits the call item alone.
   */
  renderResultMessage(r: ToolExecResult): any | null;

  /**
   * OPTIONAL. Attach this tool's own annotations — `file_citation` for `file_search`,
   * `url_citation` for a `web_search` that one day wants them on the model's real message
   * rather than only on its fallback dump — to a client-facing assistant `message`.
   *
   * OMITTING IT IS THE NO-OP, and that is the point: the engine leaves every message
   * exactly as it found it, byte for byte, for a descriptor that does not implement this.
   * `web_search` does not, and its frames are unchanged by this hook existing.
   *
   * THE ONE RULE: return a NEW item that differs ONLY by added annotations, and NEVER
   * touch the message's text — neither by substituting it on the copy nor by mutating
   * `item` in place. The two break different things, and both matter:
   *
   *   a rewritten COPY  -> on the streaming path this engine is the OUTERMOST Responses
   *                        interceptor, so what it returns is written into a frame that has
   *                        yet to pass through the namespace layer and pseudonymization's
   *                        `res.write`. Unmasked bytes reach a pipeline whose remaining
   *                        stages assume masked ones.
   *   an IN-PLACE edit  -> `item` is the object the engine keeps for `history`, which is
   *                        what the next continuation POST sends back to the deployment.
   *                        The unmasked text leaves the tenant. (The annotated COPY never
   *                        enters `history`; only a mutation of the original does.)
   *
   * Annotations are integers and a file id; nothing downstream rewrites them, so offsets
   * computed against the UNMASKED text land correctly on the wire while the frame stays
   * masked. The engine rejects a returned copy whose text changed — it CANNOT detect the
   * in-place variant, so this rule is enforced by the suite, not by a runtime check.
   *
   * TAKES `ToolExecResult[]`, NOT the hits themselves, deliberately. `payload` is `any`, so
   * an engine that dug the hits out itself would be the one call site where handing over
   * the wrong list (the deployment-bound masked rendering instead of the raw one) compiles
   * silently and yields zero annotations for precisely the documents that contained an
   * entity. Keeping `payload` on the descriptor's side of the boundary means the narrowing
   * accessor that knows the right field is the only thing that ever reads it.
   *
   * `results` is every result THIS descriptor produced for the whole request, in call
   * order, across every continuation round — a message in round three may well cite a
   * passage retrieved in round one.
   *
   * ONE KNOWN ORDERING DIVERGENCE FROM OPENAI, on the streaming path, and it is not
   * fixable without buffering the whole answer. OpenAI interleaves its annotation events
   * with the text deltas, BEFORE `response.output_text.done`. This engine only learns the
   * message's complete text at `response.output_item.done`, so the annotations ride on
   * that frame and on `response.completed` — the two frames clients actually read the
   * annotation list off. `response.output_text.annotation.added` does not exist anywhere
   * in this codebase and is not emitted. Document it in chapter 16, do not "fix" it by
   * withholding deltas: that would trade a cosmetic ordering difference for a visible
   * latency regression on every turn.
   */
  annotateMessage?(item: any, results: ToolExecResult[], ctx: AnnotateMessageCtx): any;

  /** How many calls of this tool one request may run. Read per turn, never cached. */
  maxCallsPerRequest(): number;
}
