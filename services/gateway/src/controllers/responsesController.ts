/**
 * OpenAI Responses API (POST /openai/v1/responses).
 *
 * Deployed GPT-5+/o-series models serve the Responses API natively, so this
 * forwards the request essentially unchanged and passes the result back —
 * preserving reasoning items, encrypted content and the exact SSE framing the
 * client expects. Orchestration-served models are out of scope (phase 2).
 *
 * NOTE on ordering: before-plugins run BEFORE the outbound payload is built.
 * openaiController does the opposite and never rebuilds its payload, so
 * plugins there cannot affect the outbound body. Do not copy that.
 */
import { Request, Response, NextFunction } from 'express';
import axios, { AxiosResponse } from 'axios';
import modelService from '../services/modelService';
import configService from '../services/configService';
import { executeBeforePlugins, executeAfterPlugins } from '../services/pluginExecutor';
import * as payloadLogger from '../utils/payloadLogger';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();
import { createUsageMetrics, emitUsageEvent, updateTokenCounts } from '../utils/usageTracker';
import tokenCountService from '../services/tokenCountService';
import { foldInclusiveUsage, foldExclusiveUsage, readCacheWriteTokens } from '../utils/usageFolding';
import { resolveResponsesEligibility, deployedSiblingName, resolveResponsesRoute } from '../utils/responsesEligibility';
import { buildOrchestrationPayload, UnsupportedInputItemError } from '../responses/orchestrationBridge/requestTranslator';
import { translateOrchestrationResponse } from '../responses/orchestrationBridge/responseTranslator';
import { createResponsesStreamTranslator, createOrchestrationBlockTranslator } from '../responses/orchestrationBridge/streamTranslator';
import { applyCacheBreakpoints, mapCachedTokens } from '../responses/orchestrationBridge/cacheBreakpoints';
import { resolvePromptCachingSupport } from '../utils/promptCachingSupport';
import { explainReasoningEffort, reasoningWasEmitted } from '../utils/reasoningSupport';
import sapAIService from '../services/sapAIService';
import * as crypto from 'crypto';
import { stripUnsupportedParams, applyParamRenames } from '../utils/unsupportedParamFilter';
import { readUpstreamErrorBody } from '../utils/upstreamErrorBody';
import { normalizeUpstreamError } from '../utils/upstreamErrorEnvelope';
import { awaitResponsesStreamIdle, abortResponsesStreamContinuation } from '../utils/responsesStreamIdle';
// The single definition of the terminal Responses event types, shared with both res.write
// interceptors. It lived here as a third private copy — and independently drifting copies
// of exactly this set is what the extraction into sseFraming existed to stop.
import { TERMINAL_RESPONSE_TYPES } from '../utils/sseFraming';

function badRequest(res: Response, message: string, code = 'model_not_supported'): void {
  res.status(400).json({ error: { message, type: 'invalid_request_error', code } });
}

/**
 * Feed a Responses `usage` object into the usage metrics.
 *
 * Responses counts cached input INSIDE `input_tokens`, whereas the usage event
 * prices input and cache-read separately and ADDS them (admin
 * modelCostService: input*rate + cacheRead*cacheReadRate). So subtract the
 * cached part from the full-rate input rather than reporting it twice.
 *
 * The cache-WRITE count DOES exist on this path — the real Responses API
 * names it `cache_write_tokens`, measured both on real codex traffic and on
 * our own deployed path serving `/openai/v1/responses` (a captured SAP
 * gpt-5.3-codex response carried `input_tokens_details:
 * {"cache_write_tokens":0,"cached_tokens":0}` verbatim). Reading it was
 * previously hardcoded to 0 here — the actual defect this function's history
 * records — because the gateway looked for `cache_creation_tokens` instead
 * (an adapted-but-unmeasured name) or nothing at all. `readCacheWriteTokens`
 * reads the real name first and falls back to the legacy one for an upstream
 * or a replayed history that still sends it.
 */
function applyResponsesUsage(usageMetrics: any, usage: any): void {
  if (!usage) return;
  const cachedInput = usage.input_tokens_details?.cached_tokens || 0;
  const cacheWriteInput = readCacheWriteTokens(usage.input_tokens_details);
  foldInclusiveUsage(usageMetrics, usage.input_tokens || 0, usage.output_tokens || 0, cacheWriteInput, cachedInput);
}

/**
 * Pull `usage` off the last terminal frame of a captured SSE stream.
 *
 * Real frame shape (bare `data:` line, type inside the JSON):
 *   data: {"type":"response.completed","sequence_number":42,"response":{...,"usage":{...}}}
 *
 * Walk complete blocks from the end so the newest terminal frame wins.
 * Best-effort by contract: never throws, returns undefined when nothing parses.
 */
function extractStreamUsage(captured: string): any | undefined {
  const blocks = captured.split('\n\n');
  for (let i = blocks.length - 1; i >= 0; i--) {
    const line = blocks[i].split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    try {
      const frame = JSON.parse(line.slice('data: '.length));
      if (TERMINAL_RESPONSE_TYPES.has(frame?.type)) return frame.response?.usage;
    } catch { /* not a JSON frame — keep walking */ }
  }
  return undefined;
}

/**
 * Every Responses SSE event whose bare `delta` string field carries text the
 * MODEL generated — as opposed to metadata, progress, or non-text bytes.
 * Deriving output tokens from only `response.output_text.delta` would
 * undercount any turn that used a mechanism other than plain assistant
 * prose; this set is what a mid-stream abort's local estimate walks.
 *
 * Re-derived from evidence, not copied from the pseudonymization plugin's
 * per-type buffer list (`src/plugins/pseudonymization/index.ts`,
 * `RESPONSES_DELTA_TYPE_BY_KEY_PREFIX`) — that list exists to unmask
 * placeholders mid-stream, a different job, and its membership does not
 * double as proof a type actually reaches this endpoint. Two independent
 * captures of THIS endpoint's real traffic
 * (`test/fixtures/codex-custom-tools/{responses-api-compliance-capture.json,
 * gpt-5.6-sol-custom-tool-capture.json}`, `server_frame_type_counts`) are the
 * only `.delta`-suffixed event types this repo has actually observed here:
 *
 *   - `response.output_text.delta`         — 1569 + 109 occurrences. Plain
 *     assistant prose. Included.
 *   - `response.custom_tool_call_input.delta` — 1018 + 381 occurrences, MORE
 *     frequent than several types previously assumed safe to omit. This is
 *     codex's freeform custom-tool mechanism (`custom_tool_call` output
 *     items) streaming its input text token-by-token — model-generated
 *     content, not metadata. Included; omitting it was the exact
 *     "undercounts a turn that called a tool" failure this set exists to
 *     avoid, just for THIS mechanism instead of the standard one below.
 *
 * Neither capture happens to contain a standard (non-custom) function tool
 * call, a reasoning summary, or a refusal, so none of the remaining three
 * entries has fixture evidence from this repo. They are kept anyway, each
 * for the same reason the reviewer gave for `function_call_arguments.delta`
 * specifically — confirmed against OpenAI's public Responses API streaming
 * event reference (developers.openai.com/api/reference/resources/responses/
 * streaming-events) rather than re-assumed from the pseudonymization list:
 *
 *   - `response.function_call_arguments.delta` — the STANDARD function-tool
 *     mechanism (as opposed to codex's custom-tool one above); its `delta`
 *     is partial JSON arguments the model generated. Documented public-API
 *     shape; coexists with custom tools across model/client generations.
 *   - `response.reasoning_summary_text.delta` — `delta` is reasoning-summary
 *     text the model generated (opt-in via `include`). Documented; the
 *     orchestration BRIDGE omits reasoning entirely (see
 *     RESPONSES-API-COMPLIANCE.md, "Items we do not currently produce"), but
 *     this set is read on the NATIVE pass-through path (`forwardStream`),
 *     which forwards a deployment's own request/response unchanged and so
 *     can carry a client's `include` request straight through.
 *   - `response.refusal.delta` — `delta` is refusal-message text the model
 *     generated, on the dedicated refusal channel rather than
 *     `output_text.delta`. Documented; carries real generated content.
 *
 * Excluded on the same public-API reference, also unobserved in either
 * capture, but NOT added here — each a plausible follow-up, not silently
 * folded into this fix: `response.reasoning_text.delta` (a newer sibling of
 * the reasoning-summary event), `response.mcp_call_arguments.delta` (MCP's
 * analogue of `function_call_arguments.delta`), and
 * `response.code_interpreter_call_code.delta` (generated code). Genuinely
 * NOT text and correctly excluded: `response.audio.delta` (raw base64 audio
 * bytes — running these through a text tokenizer would produce a number with
 * no relation to actual audio-token billing).
 */
const TEXT_DELTA_EVENT_TYPES = new Set([
  'response.output_text.delta',
  'response.custom_tool_call_input.delta',
  'response.function_call_arguments.delta',
  'response.reasoning_summary_text.delta',
  'response.refusal.delta',
]);

/**
 * Concatenate every text-bearing delta out of a captured (possibly
 * mid-frame-truncated) SSE stream, in stream order. Used to derive a local
 * output-token estimate when the client disconnects before the terminal
 * frame — and therefore before `extractStreamUsage` has anything to read —
 * arrives. Best-effort by contract: never throws, returns '' on anything
 * that does not parse.
 */
function extractStreamedText(captured: string): string {
  const blocks = captured.split('\n\n');
  let text = '';
  for (const block of blocks) {
    const line = block.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    try {
      const frame = JSON.parse(line.slice('data: '.length));
      if (TEXT_DELTA_EVENT_TYPES.has(frame?.type) && typeof frame.delta === 'string') {
        text += frame.delta;
      }
    } catch { /* not a JSON frame — keep walking */ }
  }
  return text;
}

/** A single input item's `content` → plain text, appended onto `out`. Lenient: an
 * item shape this does not recognise is skipped, never thrown on — unlike
 * `requestTranslator.ts`'s `textBlocks`, which throws by design so an
 * unsupported item never silently loses content bound for the model. This
 * function only ever feeds a local BILLING ESTIMATE, so the equivalent
 * failure mode (undercounting on an unrecognised item) is the one the
 * caller already accepts as this path's baseline.
 */
function collectInputText(content: any, out: string[]): void {
  if (typeof content === 'string') { out.push(content); return; }
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (part && typeof part.text === 'string') out.push(part.text);
  }
}

/**
 * Responses `input` (+ optional `instructions`) → a flat text blob, for local
 * token estimation only. Deliberately not a `{messages}` shape keyed by role:
 * `getTokenCount` classifies `assistant`-role messages as OUTPUT, and a
 * multi-turn `input` array can legitimately contain prior assistant turns —
 * those are prompt cost, not this turn's generation, so everything here is
 * folded into a single synthetic `user` message by the caller.
 */
function extractResponsesInputText(body: any): string {
  const out: string[] = [];
  if (typeof body?.instructions === 'string') out.push(body.instructions);

  const input = body?.input;
  if (typeof input === 'string') {
    out.push(input);
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      collectInputText(item.content, out);
      if (item.type === 'function_call' && typeof item.arguments === 'string') out.push(item.arguments);
      if (item.type === 'function_call_output') {
        out.push(typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''));
      }
    }
  }
  return out.join('\n');
}

/**
 * Fallback for the mid-stream-abort billing hole (measured in
 * `test/fixtures/codex-custom-tools/RESPONSES-API-COMPLIANCE.md`, "Mid-stream
 * abort against OUR gateway"): usage on this route lives only on the terminal
 * `response.completed` frame, which a disconnected client never receives —
 * so a cancelled turn that streamed real content was billed zero tokens.
 *
 * Strictly a fallback. If `usageMetrics` already carries any real number —
 * always true on the `reason === 'end'` path, which folds
 * `extractStreamUsage`'s provider-reported usage before this could ever run
 * — this is a no-op, so a provider figure is never overwritten by an
 * estimate. Tokenizing never throws into the settlement path: any failure
 * degrades to the pre-existing zero-token behaviour, same as before this
 * fallback existed, and the usage event still fires (the caller emits it
 * either way).
 *
 * Marks the derived numbers with `usageEstimated: true` so a downstream
 * consumer — the admin cost pipeline included — can tell a locally-counted
 * row from a provider-reported one; see `UsageEvent.usageEstimated`.
 */
async function estimateAbortedUsage(
  usageMetrics: any, captured: string, req: Request, requestedModel: string,
): Promise<void> {
  if (usageMetrics.inputTokens || usageMetrics.outputTokens) return;

  try {
    const outputText = extractStreamedText(captured);
    const inputText = extractResponsesInputText(req.body);

    const messages: any[] = [];
    if (inputText) messages.push({ role: 'user', content: inputText });
    if (outputText) messages.push({ role: 'assistant', content: outputText });
    if (messages.length === 0) return;

    const counts = await tokenCountService.getTokenCount({ model: requestedModel, messages }, requestedModel);
    updateTokenCounts(usageMetrics, counts.input, counts.output, 0, 0);
    usageMetrics.usageEstimated = true;
  } catch (error) {
    // Best-effort by contract — see docstring. Leave usageMetrics untouched
    // (today's zero-token behaviour) rather than lose the usage event.
    logger.warn('responsesController', `Local usage estimate failed for ${requestedModel}: ${(error as any)?.message || error}`);
  }
}

/**
 * Fold a RAW SAP orchestration usage object into the request's usage metrics.
 *
 * This function is reached exclusively from `dispatchOrchestration`, so what it
 * receives is always the raw `/v2/completion` envelope's `usage` — never the
 * client-visible object the translators emit (those normalize the OTHER way;
 * see `translateUsage` in `responseTranslator.ts`). That means the
 * client-visible object never feeds billing THROUGH THIS FUNCTION — but it is
 * not true of the request as a whole: the hosted-tool engine's continuation
 * loop reaches the translated (client-convention, inclusive) usage directly
 * off each continuation round's response and folds it onto
 * `req.__responsesExtraUsage` via `noteExtraUsage` (`usageFolding.ts`), which
 * IS part of billing. So the whole picture, read across both call sites: this
 * function's own fold is exclusive-regime (SAP's raw counting), the
 * accumulator normalizes inclusive per continuation round, and the
 * `response.usage` object handed back to the client is inclusive display —
 * three different regimes, on the same request, each correct for its own
 * consumer.
 *
 * WHICH REGIME THAT ENVELOPE IS IN — an era split, because the answer changed
 * when the payload changed, and the old numbers are still on record elsewhere:
 *
 * - OLD (the 15903/16303 era, pre-de-duplication). A live capture against
 *   `/openai/v1/responses`, anthropic--claude-4.8-opus, caching on, read
 *   INCLUSIVE on both turns:
 *     run 1  prompt_tokens 16303   cache_creation_tokens 16292   cached_tokens 0
 *     run 2  prompt_tokens 16303   cache_creation_tokens 0       cached_tokens 16292
 *   16292 + 11 = 16303 either way, so this function subtracted both cache
 *   categories out of the full-rate input via `foldInclusiveUsage`. Arm A0 of
 *   test/fixtures/orchestration/bridge-cache-probe-result.md reproduces that
 *   shape exactly (15903 = 15892 + 11; different absolute numbers, same
 *   arithmetic, because the probe used a shorter filler prefix).
 *   That reading was an ARTIFACT, not an endpoint property. The bridge was
 *   putting the same system message into `prompt.template` AND
 *   `messages_history` and marking only the history copy, so the wire carried
 *   one marked and one unmarked copy of the same text.
 * - NEW (current). With the duplicate removed — arm A2 of the same fixture,
 *   the payload `requestTranslator.ts`/`cacheBreakpoints.ts` now build —
 *   `prompt_tokens` is FLAT at 14 across the write and the read turn while the
 *   cache field goes 0 -> 17692. EXCLUSIVE: the cached prefix is never inside
 *   `prompt_tokens`, exactly like Task 1's `/openai/v1/chat/completions`
 *   capture (14 flat, cached_tokens 0 -> 29004/32004) always was. Arm A1
 *   (marking both copies instead of removing one) is exclusive too, but caches
 *   both copies — 0 -> 34181, ~2x the write cost — which is why the fix is
 *   de-duplication.
 *
 * So this folds with `foldExclusiveUsage`: `prompt_tokens` is full-rate input
 * as-is, and the two cache counters are separate line items ADDED alongside it,
 * with NO subtraction. Subtracting here on today's payload would compute
 * `max(0, 14 - 17692) = 0` and erase every full-rate token the turn actually
 * consumed. The regime is named at the call site, not inferred from the shape
 * of the object — see `usageFolding.ts` for why that distinction is load-bearing.
 */
function recordOrchestrationUsage(usageMetrics: any, usage: any): void {
  if (!usage) return;
  const details = usage.prompt_tokens_details || {};
  const { cachedTokens } = mapCachedTokens(usage);   // cache READ, exclusive of prompt_tokens
  foldExclusiveUsage(
    usageMetrics,
    usage.prompt_tokens ?? 0,
    usage.completion_tokens ?? 0,
    // Cache WRITE. Priced separately by admin's cost SQL, and — like the read
    // count — reported by SAP alongside `prompt_tokens`, not inside it.
    details.cache_creation_tokens ?? 0,
    cachedTokens,
  );
}

/**
 * Serve a Responses request through SAP orchestration.
 *
 * The deployed path forwards a Responses body to a deployment that speaks the
 * Responses API natively. Orchestration does not: it speaks OpenAI chat shape,
 * so the request is translated on the way out and the reply on the way back.
 *
 * Kept out of `handleResponses` because that function is already long and every
 * line of it below the plugin block belongs to the native path. Most errors are
 * left to propagate: `handleResponses`'s own catch reads `error.status` as a
 * fallback for `error.response?.status`, specifically so `sapAIService`'s
 * `CustomError` (`.status`/`.details`, no `.response`) is reported exactly like
 * an axios error from the native path — same status code, same envelope shape,
 * same debug payload. The one exception is `UnsupportedInputItemError`, handled
 * locally below — it is neither shape (no `.response`, no `.status`), so it
 * would otherwise fall through the outer catch's `|| 500` default and lose the
 * item type, when it is really a 400 the client caused by sending an input item
 * shape this bridge does not translate.
 *
 * SSE headers are set lazily, inside the streaming branch's `onChunk` callback,
 * on the first block actually written — not up front before
 * `streamChatCompletion` is even called. The native path's `forwardStream` only
 * commits headers once `axios.post` has resolved with a live upstream stream;
 * setting them earlier here would mean a call that fails before its first chunk
 * (bad deployment id, auth failure) still reaches the outer catch with the SSE
 * headers already committed, so `res.json`'s JSON error body would go out
 * mislabelled `text/event-stream`.
 *
 * The streaming branch runs the SAME continuation lifecycle as `forwardStream`,
 * in the same order — usage fold, `awaitResponsesStreamIdle`,
 * `__responsesExtraUsage` fold, usage event, `res.end()`, plus
 * `abortResponsesStreamContinuation` on a client disconnect. It is not
 * bookkeeping: the hosted-tool engine opens its continuation calls AFTER the
 * first stream ends, so a branch that folds and closes immediately emits the
 * usage event before the continuation exists (billing it to nobody) and leaves
 * an abandoned request's loop running and paying. `forwardStream`'s own
 * comments carry the full derivation; this branch deliberately mirrors them
 * rather than restating them.
 */
/**
 * Log what the reasoning resolver decided, when the client asked for thinking.
 *
 * Only fires when the request carried a `reasoning.effort`, so a route that
 * never uses the feature stays silent. A decline is logged at `info` because
 * it is the case someone will be trying to explain — "I set effort and nothing
 * happened" is otherwise indistinguishable from the resolver not running at
 * all, since both look identical in the stage-02 capture.
 *
 * The resolver's inputs are read back off the BUILT payload rather than off
 * `req.body`, so they are by construction the same values the translator
 * resolved against — a second normalisation here could drift from the first
 * and explain a decision that never happened.
 */
function logReasoningDecision(body: any, modelName: string, payload: any): void {
  const effort = body?.reasoning?.effort;
  if (typeof effort !== 'string') return;

  const params = payload?.config?.modules?.prompt_templating?.model?.params ?? {};
  const decision = explainReasoningEffort({
    modelName,
    effort,
    maxTokens: params.max_tokens,
    temperature: params.temperature,
    topP: params.top_p,
    toolChoice: params.tool_choice,
  });

  if (reasoningWasEmitted(decision)) {
    logger.debug('responsesController',
      `reasoning.effort=${effort} -> ${decision} thinking for ${modelName}`);
    return;
  }
  logger.info('responsesController',
    `reasoning.effort=${effort} requested but NO thinking sent for ${modelName} [reason=${decision}]`);
}

async function dispatchOrchestration(ctx: {
  req: Request; res: Response; modelDetails: any; effectiveModel: string;
  isStreaming: boolean; hookConfig: any; usageMetrics: any; debugRequestId?: string;
}): Promise<void> {
  const { req, res, modelDetails, effectiveModel, isStreaming, hookConfig, usageMetrics, debugRequestId } = ctx;
  const responseId = `resp_${crypto.randomBytes(12).toString('hex')}`;

  // The orchestration model name, not the client's alias.
  const modelName = modelDetails.model || effectiveModel;

  // Resolved ONCE per request and shared with buildContinuationPayload below —
  // a first turn that caches while its continuations don't is a silent
  // per-round cache miss for what is, semantically, one verdict. Anthropic
  // models default ON now; only a config-flagged exception turns this off. The
  // asymmetry behind that default (a live gpt-5-mini/SAP probe: HTTP 200,
  // cached_tokens 0 — a wrong `true` is a free no-op, a wrong `false` costs
  // every turn) is documented in full in promptCachingSupport.ts.
  const cachingProvider = (modelDetails?.provider || modelDetails?.owned_by || '').toLowerCase();
  const promptCachingEnabled = resolvePromptCachingSupport({
    provider: cachingProvider,
    modelFlag: configService.getSupportsPromptCaching(undefined, effectiveModel),
    providerFlag: configService.getSupportsPromptCaching(cachingProvider, undefined),
  });

  let payload: any;
  try {
    payload = buildOrchestrationPayload(req.body, { modelName, stream: isStreaming });
  } catch (err) {
    if (err instanceof UnsupportedInputItemError) {
      badRequest(res, `Unsupported Responses input item type: ${err.itemType}`, 'unsupported_input_item');
      return;
    }
    throw err;
  }
  payload = applyCacheBreakpoints(payload, { enabled: promptCachingEnabled });
  logReasoningDecision(req.body, modelName, payload);

  if (debugRequestId) {
    payloadLogger.savePayload(debugRequestId, '02_responses_request_to_orchestration', payload, req);
  }

  // Same accumulator the native path creates, for the same reason: a plugin does
  // `+=` onto it during the after-chain and would throw on a missing property.
  (req as any).__responsesExtraUsage = { input_tokens: 0, output_tokens: 0 };

  // Mirrors the native path's own __responsesUpstream stash below, so the hosted-tool
  // engine's continuation loop (before-plugins already installed its interceptor) can
  // POST a second orchestration turn itself. The engine posts continuations directly —
  // it cannot go through callSAPAIOrchestration/streamChatCompletion, which own their
  // own axios call and response handling — so it needs the endpoint, and a builder that
  // reproduces buildOrchestrationPayload + applyCacheBreakpoints, since `input: history`
  // (the Responses shape the engine falls back to) is not a shape orchestration accepts.
  const endpoint = await sapAIService.getOrchestrationEndpoint();
  (req as any).__responsesUpstream = {
    url: endpoint.url,
    headers: endpoint.headers,
    timeoutMs: configService.getTimeout(isStreaming),
    payload,
    // The client's own tool_choice, for the engine to relax. `payload` below buries it
    // inside config.modules.prompt_templating.model.params, which is not a shape the
    // engine should have to know — see continuationBody's docstring.
    toolChoice: req.body?.tool_choice,
    // The engine posts continuations itself; orchestration needs its own body
    // shape, and `input` would be rejected outright.
    //
    // `opts.toolChoice` is the engine's relaxed verdict: a `required` (or a choice naming
    // a hosted tool) means "call a tool THIS turn", and a continuation is a new turn, so
    // forwarding it verbatim forces another call every round until the cap stops it. The
    // engine decides, this rebuilds around the decision. Not passing it through is how the
    // orchestration branch bypassed relaxForcedToolChoice entirely.
    buildContinuationPayload: (history: any[], opts?: { toolChoice?: any }) => {
      const body: any = { ...req.body, input: history };
      if (opts) body.tool_choice = opts.toolChoice;
      const next = buildOrchestrationPayload(body, { modelName, stream: isStreaming });
      // Reuses promptCachingEnabled resolved once above — same verdict as the
      // first turn, not a fresh resolution per continuation.
      return applyCacheBreakpoints(next, { enabled: promptCachingEnabled });
    },
    // The two REPLY-side twins of the builder above. A continuation POSTed to
    // orchestration comes back in orchestration's own shape, not the Responses
    // shape the engine's frame pipeline and continuation loop both assume — so
    // the same translators this dispatch already uses for the FIRST turn are
    // handed over for every continuation turn too. Without them the engine wrote
    // raw chat deltas into the client's Responses stream and, non-streaming,
    // replaced the translated response object with `{choices:[…]}` while billing
    // the round zero. A native (deployed) upstream supplies neither, and the
    // engine then behaves exactly as it did before these existed.
    //
    // A FRESH response id per continuation turn, deliberately: each is its own
    // upstream response. The engine rebuilds the client's single terminal frame
    // from the round it kept, so only that round's id can reach the client, and
    // reusing the first turn's id would claim two upstream calls were one.
    translateContinuationResponse: (envelope: any) => translateOrchestrationResponse(envelope, {
      model: effectiveModel,
      responseId: `resp_${crypto.randomBytes(12).toString('hex')}`,
    }),
    createContinuationStreamTranslator: () => createOrchestrationBlockTranslator({
      model: effectiveModel,
      responseId: `resp_${crypto.randomBytes(12).toString('hex')}`,
    }),
  };

  if (isStreaming) {
    const translator = createResponsesStreamTranslator({ model: effectiveModel, responseId });
    let lastUsage: any = null;
    // Committed on the first block actually written, not before the upstream
    // call — see this function's docstring for why.
    let headersCommitted = false;
    const writeBlocks = (blocks: string[]): void => {
      if (blocks.length === 0) return;
      if (!headersCommitted) {
        headersCommitted = true;
        if (!res.headersSent) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
        }
      }
      for (const block of blocks) res.write(block);
    };

    // Client-disconnect handling, the same belt-and-braces pair `forwardStream` uses and
    // for the same reason: the hosted-tool engine owns a continuation loop this function
    // knows nothing about, and an abandoned request must not go on opening — or keep
    // open — further orchestration calls that nobody will read and nobody is billed for.
    // `writableEnded` on the res listener is load-bearing: res 'close' fires on normal
    // completion too, so without it every ordinary turn would cancel its own continuation.
    // (forwardStream's own note applies here as well: the req listener is the one that
    // measurably never fires, and is kept only because it is correct in principle.)
    if (typeof (req as any).on === 'function') {
      req.on('close', () => { abortResponsesStreamContinuation(res); });
    }
    if (typeof (res as any).on === 'function') {
      res.on('close', () => {
        if (res.writableEnded) return;
        abortResponsesStreamContinuation(res);
      });
    }

    // NO hookConfig, deliberately — the fifth argument is left undefined.
    //
    // `streamChatCompletion` uses it to run `executeStreamPlugins` on the raw upstream
    // buffer and `executeAfterPlugins` on EVERY PARSED CHUNK. Every plugin the real
    // `responses-stream` config lists (pseudonymization, responsesNamespaceTools,
    // responsesWebSearch, responsesFileSearch) registers an `after` handler written
    // against a Responses RESPONSE OBJECT; handing each of them an orchestration chunk
    // (`{final_result:{choices:[{delta}]}}`) is a shape none of them expects, on a route
    // that has never had after-plugins at all — the native `forwardStream` deliberately
    // runs none, and says so.
    //
    // It is also redundant. This branch's client-facing bytes are the TRANSLATED Responses
    // frames written through `res.write`, and the before-plugin chain has already patched
    // `res.write`: pseudonymization's SSE unmask interceptor, the namespace layer and the
    // hosted-tool interceptor all sit on it. So plugins do see this stream — they see it
    // once, already translated, which is the only shape they can act on correctly.
    await sapAIService.streamChatCompletion(payload as any, (chunk: any) => {
      const body = chunk?.final_result ?? chunk;
      if (body?.usage) lastUsage = body.usage;
      writeBlocks(translator.onChunk(chunk));
    }, undefined, req as any, undefined);

    writeBlocks(translator.finish());

    // From here on, step for step with `forwardStream`'s completion block — read its
    // comments for why each step is load-bearing. In short: the upstream stream ending is
    // NOT the end of the response when the hosted-tool engine is splicing a continuation
    // into it, because that second call is opened after this point. Folding usage, emitting
    // the event and closing the socket without waiting billed zero continuation tokens and
    // cut the splice off mid-write. This branch runs no after-plugin chain either, so the
    // idle hook is the only place the engine can be waited on. Absent an interceptor every
    // one of these returns immediately and the path behaves as it did before.
    recordOrchestrationUsage(usageMetrics, lastUsage);

    await awaitResponsesStreamIdle(res, configService.getTimeout(true), () => {
      logger.warn('responsesController', `Hosted-tool continuation did not finish in time for ${effectiveModel}; closing the stream`);
    });

    // The continuation rounds accumulate their own tokens here while the wait above runs,
    // so this fold must happen after it, not before. `__responsesExtraUsage` was allocated
    // at the top of this function for exactly this and was never read on this path.
    const extra = (req as any).__responsesExtraUsage;
    if (extra && (extra.input_tokens || extra.output_tokens || extra.cache_creation_tokens || extra.cache_read_tokens)) {
      updateTokenCounts(usageMetrics, extra.input_tokens || 0, extra.output_tokens || 0, extra.cache_creation_tokens || 0, extra.cache_read_tokens || 0);
    }

    emitUsageEvent(req, usageMetrics, effectiveModel, 200);
    if (!res.writableEnded) res.end();
    return;
  }

  const envelope = await sapAIService.callSAPAIOrchestration(payload as any, debugRequestId);
  if (debugRequestId) {
    payloadLogger.savePayload(debugRequestId, '03_responses_response_from_orchestration', envelope, req, res);
  }

  const body = envelope?.final_result ?? envelope ?? {};
  recordOrchestrationUsage(usageMetrics, body?.usage);

  let finalBody: any = translateOrchestrationResponse(envelope, { model: effectiveModel, responseId });
  if (hookConfig) finalBody = await executeAfterPlugins(req, res, finalBody, hookConfig);

  const extra = (req as any).__responsesExtraUsage;
  if (extra && (extra.input_tokens || extra.output_tokens || extra.cache_creation_tokens || extra.cache_read_tokens)) {
    updateTokenCounts(usageMetrics, extra.input_tokens || 0, extra.output_tokens || 0, extra.cache_creation_tokens || 0, extra.cache_read_tokens || 0);
  }

  emitUsageEvent(req, usageMetrics, effectiveModel, 200);
  res.status(200).json(finalBody);
}

export const handleResponses = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
  const requestedModel = (req.body || {}).model;
  const usageMetrics = createUsageMetrics();
  const debugRequestId = (req as any).debugRequestId;
  const isStreaming = (req.body || {}).stream === true;
  // Declared outside the try because the catch logs and bills against it.
  let effectiveModel: string = requestedModel;

  if (!requestedModel) {
    badRequest(res, 'Missing required parameter: model', 'invalid_request_error');
    return;
  }

  try {
    if (debugRequestId) {
      payloadLogger.savePayload(debugRequestId, '00_original_responses_request', req.body, req);
    }

    let modelDetails: any = await modelService.getModelDetails(requestedModel);

    // This route is served only by a DIRECT deployment, and the gateway lists
    // every deployment twice: the foundation entry `X` (orchestration, no
    // deploymentUrl) and `X--deployed`. The `--deployed` suffix is our own
    // decoration, so a client that carries its own table of OpenAI model names
    // sends the bare `X` — codex-cli warns "Model metadata for
    // `gpt-5.3-codex--deployed` not found" for exactly that reason.
    //
    // The swap is conditional on the sibling actually being able to serve this
    // route natively (deployed AND eligible), not just deployed. `X` may have a
    // `--deployed` twin that exists only because it's deployed on some OTHER
    // route (e.g. anthropic--claude-4.8-opus--deployed, a chat-completions
    // deployment) — adopting that sibling here would turn a request orchestration
    // COULD serve into a refusal, because the swap runs before routing ever sees
    // the bare, undeployed entry that resolveResponsesRoute would otherwise send
    // to the bridge. Confined to the Responses path — /chat/completions still
    // routes `X` through orchestration regardless, which is the whole point of
    // the two entries.
    const sibling = modelDetails?.deploymentUrl ? null : deployedSiblingName(requestedModel);
    if (sibling) {
      const siblingDetails: any = await modelService.getModelDetails(sibling);
      if (siblingDetails?.deploymentUrl) {
        const siblingProvider = (siblingDetails.provider || siblingDetails.owned_by || '').toLowerCase();
        const siblingCanServeNatively = resolveResponsesEligibility({
          modelName: sibling,
          provider: siblingProvider,
          isDeployed: true,
          modelFlag: configService.getSupportsResponsesApi(undefined, sibling),
          providerFlag: configService.getSupportsResponsesApi(siblingProvider, undefined),
        });
        if (siblingCanServeNatively) {
          logger.info('responsesController', `Resolved ${requestedModel} to its deployment ${sibling} for the Responses API`);
          modelDetails = siblingDetails;
          effectiveModel = sibling;
        } else {
          logger.info('responsesController', `${requestedModel}'s deployment ${sibling} cannot serve the Responses API; leaving it on the orchestration bridge`);
        }
      }
    }

    const provider = (modelDetails?.provider || modelDetails?.owned_by || '').toLowerCase();
    const isDeployed = !!modelDetails?.deploymentUrl;

    // Which path serves this model. `native` reproduces the pre-bridge behaviour
    // exactly — a deployment that speaks the Responses API is forwarded to
    // unchanged. `orchestration` is the new branch: a catalogue model that
    // cannot serve natively now goes through the bridge instead of a 400.
    const route = resolveResponsesRoute({
      modelName: effectiveModel,
      provider,
      isDeployed,
      existsInCatalogue: !!modelDetails,
      modelFlag: configService.getSupportsResponsesApi(undefined, effectiveModel),
      providerFlag: configService.getSupportsResponsesApi(provider, undefined),
    });

    if (route === 'refuse') {
      logger.warn('responsesController', `Model ${requestedModel} is not eligible for the Responses API (provider=${provider}, deployed=${isDeployed})`);
      badRequest(res,
        `Model ${requestedModel} does not support the Responses API. It requires a deployed GPT-5+ or o-series model, e.g. gpt-5.3-codex--deployed. Use /openai/v1/chat/completions for other models.`);
      return;
    }

    // `supports_responses_api: true` on a model with no deployment used to reach
    // the native path and build the URL "undefined/responses". resolveResponsesRoute
    // sends that case to the bridge instead, so this guard now only fires if a
    // future change routes a deploymentless model natively.
    if (route === 'native' && !modelDetails.deploymentUrl) {
      logger.warn('responsesController', `Model ${requestedModel} is flagged for the Responses API but has no deployment URL`);
      badRequest(res,
        `Model ${requestedModel} has no deployment and cannot serve the Responses API. It requires a deployed GPT-5+ or o-series model, e.g. gpt-5.3-codex--deployed.`);
      return;
    }

    // Plugins first, so masking reaches the outbound body.
    (req as any).__endpoint = 'openai';
    // Read by responsesImagePlugin so it normalises remote `input_image` urls only for the
    // orchestration bridge -- the deployed (native) route already accepts them and must not
    // be touched by that plugin.
    (req as any).__responsesRoute = route;
    const subPath = isStreaming ? 'responses-stream' : 'responses';
    const hookConfig = configService.getHookConfig(effectiveModel, subPath, 'openai');

    // Fail closed. In distributed mode the admin-supplied configuration REPLACES
    // the shipped file config wholesale (configService :380/:755 — no merge), so
    // a configuration activated before this route existed has no `responses` /
    // `responses-stream` keys under defaultHooks.openai. Masking would then be
    // silently skipped on the one endpoint the operator locked with
    // allow_user_bypass:false. Scoped to this route only: nothing else changes.
    if (!hookConfig && configService.isPseudonymizationForced('openai')) {
      const message = 'Pseudonymization is force-enabled for the openai endpoint but no plugin hook is configured for '
        + '`responses` / `responses-stream`. Activate a configuration that includes these keys under '
        + '`defaultHooks.openai` before using this route.';
      logger.error('responsesController', `${message} (model=${requestedModel}, subPath=${subPath})`);
      res.status(503).json({ error: { message, type: 'api_error', code: 'pseudonymization_hook_missing' } });
      return;
    }

    if (hookConfig) {
      const pluginResult: any = await executeBeforePlugins(req, res, hookConfig);
      if (pluginResult?.stop) return;
    }

    if (route === 'orchestration') {
      await dispatchOrchestration({
        req, res, modelDetails, effectiveModel, isStreaming, hookConfig, usageMetrics, debugRequestId,
      });
      return;
    }

    const payload: any = { ...req.body };
    if (modelDetails.model) payload.model = modelDetails.model;   // deployment rejects the --deployed alias

    const dropped = stripUnsupportedParams(payload, configService.getUnsupportedParams(provider, effectiveModel));
    if (dropped.length > 0) {
      logger.warn('responsesController', `Dropped unsupported parameter(s) for ${effectiveModel}: ${dropped.join(', ')}`);
    }
    applyParamRenames(payload, configService.getParamRenames(provider, effectiveModel));

    const url = `${modelDetails.deploymentUrl}/responses`;
    if (debugRequestId) {
      payloadLogger.savePayload(debugRequestId, '02_responses_request_to_deployment', { url, payload }, req);
    }

    const authToken = await (modelService as any).getAuthToken();
    const headers = {
      Authorization: `Bearer ${authToken}`,
      'AI-Resource-Group': process.env.SAP_AI_RESOURCE_GROUP || 'default',
      'Content-Type': 'application/json',
    };

    // The web-search plugin continues the turn with a second deployment call after it
    // runs a search; it needs exactly what we resolved here. `payload` is the OUTBOUND
    // body — alias swapped, unsupported params stripped, renames applied — so a
    // continuation inherits every transformation this call had.
    (req as any).__responsesUpstream = {
      url,
      headers,
      timeoutMs: configService.getTimeout(isStreaming),
      payload,
    };
    // The plugin accumulates onto this (e.g. `__responsesExtraUsage.input_tokens += n`)
    // rather than assigning a fresh object, so it must exist before the after-plugin
    // chain runs. Left undefined, a `+=` on a missing property throws inside the
    // plugin, gets swallowed by pluginExecutor's per-plugin catch, and the
    // continuation's tokens vanish silently.
    (req as any).__responsesExtraUsage = { input_tokens: 0, output_tokens: 0 };

    if (isStreaming) {
      await forwardStream(req, res, url, payload, headers, usageMetrics, effectiveModel, debugRequestId);
      return;
    }

    const upstream: AxiosResponse = await axios.post(url, payload, {
      headers,
      timeout: configService.getTimeout(false),
    });

    if (debugRequestId) {
      payloadLogger.savePayload(debugRequestId, '03_responses_response_from_deployment', upstream.data, req, res);
    }

    applyResponsesUsage(usageMetrics, upstream.data?.usage);

    let finalBody = upstream.data;
    if (hookConfig) finalBody = await executeAfterPlugins(req, res, upstream.data, hookConfig);

    // The web-search continuation plugin accumulates its extra deployment call's
    // usage here while executeAfterPlugins runs above, so the fold — and the usage
    // event it feeds — must happen after that call, not before it.
    const extra = (req as any).__responsesExtraUsage;
    if (extra && (extra.input_tokens || extra.output_tokens || extra.cache_creation_tokens || extra.cache_read_tokens)) {
      updateTokenCounts(usageMetrics, extra.input_tokens || 0, extra.output_tokens || 0, extra.cache_creation_tokens || 0, extra.cache_read_tokens || 0);
    }

    emitUsageEvent(req, usageMetrics, effectiveModel, upstream.status);

    res.status(upstream.status).json(finalBody);
  } catch (error: any) {
    // Two upstream shapes reach here: axios errors from the native path carry
    // `.response.status`/`.response.data`; sapAIService's CustomError from the
    // orchestration path carries `.status`/`.details` and no `.response` at all.
    // Falling back to `.status` is what makes the two paths report failures
    // identically, per dispatchOrchestration's docstring above.
    const status = error.response?.status || error.status || 500;
    // Streaming uses responseType:'stream', so on an error status axios hands back
    // error.response.data as a live IncomingMessage — circular. Passing it as
    // logger metadata throws inside JSON.stringify BEFORE the payload log, the
    // usage event and res.json run; Express 4 does not catch async rejections, so
    // the client would hang with zero bytes written. Drain it to a plain value
    // first (never throws, returns non-stream bodies unchanged). sapAIService's
    // CustomError has no `.response` to drain — its already-plain `.details` is
    // the equivalent body.
    const errBody = error.response ? await readUpstreamErrorBody(error.response) : error.details;
    // 4th parameter: the 3rd is Error-typed and silently drops plain objects.
    logger.error('responsesController', `Responses request failed for ${effectiveModel}: ${error.message}`, undefined, {
      status, data: errBody,
    });
    if (debugRequestId && (error.response || error.details)) {
      payloadLogger.savePayload(debugRequestId, '97_responses_error_from_deployment',
        { status, data: errBody }, req, res);
    }
    emitUsageEvent(req, usageMetrics, effectiveModel, status);

    // Upstream shapes differ (SAP AI Core returns `error` as a STRING); clients
    // read `error.message` off an OBJECT. Normalise before anything reaches them.
    const envelope = normalizeUpstreamError(errBody, status, error.message);

    if (res.headersSent || res.writableEnded) {
      // Mid-stream: cannot change status. Emit a Responses-shaped failure frame.
      // Carry the normalised message rather than axios's "Request failed with
      // status code 400", which names no cause.
      try {
        res.write(`data: ${JSON.stringify({ type: 'response.failed', response: { status: 'failed', error: envelope.error } })}\n\n`);
      } catch { /* best effort */ }
      res.end();
      return;
    }
    res.status(status).json(envelope);
  }
};

/** Pipe the upstream SSE bytes straight through; res.write is patched by the masking plugin. */
async function forwardStream(
  req: Request, res: Response, url: string, payload: any,
  headers: Record<string, string>, usageMetrics: any, requestedModel: string,
  debugRequestId?: string,
): Promise<void> {
  const upstream: AxiosResponse = await axios.post(url, payload, {
    headers, responseType: 'stream', timeout: configService.getTimeout(true),
  });

  if (!res.headersSent) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
  }

  let captured = '';
  upstream.data.on('data', (chunk: Buffer) => {
    const s = chunk.toString('utf8');
    captured += s;
    res.write(s);
  });

  // Measured on Node 20 + Express 4 (bodyParser.json): `req` is destroyed within ~5ms of
  // route entry, on EVERY request, before forwardStream is even reached — so a listener
  // registered here never fires, in the normal case or a genuine disconnect. Kept because
  // it is harmless and correct in principle, but it is not what detects a disconnect.
  // (The dead upstream.data.destroy() inside it predates the web-search work.) Registering
  // it at route top instead would be worse: there it fires within ~1ms on every request
  // and would cancel everything.
  req.on('close', () => {
    if (upstream.data?.destroy) upstream.data.destroy();
    abortResponsesStreamContinuation(res);
  });

  // This is the signal that actually fires — the belt-and-braces pattern openaiController
  // and anthropicController already use, which this controller was the outlier for
  // omitting. `writableEnded` is load-bearing: res 'close' fires on normal completion too,
  // so without the guard every ordinary turn would cancel its own continuation.
  if (typeof (res as any).on === 'function') {
    res.on('close', () => {
      if (res.writableEnded) return;
      if (upstream.data?.destroy) upstream.data.destroy();
      // The web-search plugin owns a SECOND stream this function knows nothing about, and
      // without this would go on to open a further deployment call — paid for, billed to
      // nobody — for a request the client has already abandoned.
      abortResponsesStreamContinuation(res);
    });
  }

  await new Promise<void>((resolve) => {
    let settled = false;

    // Single settlement point: the upstream Readable can reach termination via
    // 'end' (normal completion), 'error' (upstream failure) or 'close' (destroyed
    // — either after 'end'/'error' fired, or standalone when the client
    // disconnects and req.on('close') above calls upstream.data.destroy() with
    // no error, which emits 'close' but neither 'end' nor 'error'). Without this
    // guard the client-disconnect case never resolves the promise, leaking the
    // handler and silently dropping the usage event for the whole request.
    // Synchronous entry point: claims the single settlement slot in the same tick the
    // event fires (two events can arrive back to back), then hands off to the async
    // completion below.
    const finish = (reason: 'end' | 'error' | 'close', error?: any): void => {
      if (settled) return;
      settled = true;
      void complete(reason, error);
    };

    async function complete(reason: 'end' | 'error' | 'close', error?: any): Promise<void> {
      let statusCode = 200;

      if (reason === 'end') {
        // Usage lives on the final response.completed frame. `captured` holds the FIRST
        // deployment call's raw bytes only, which is exactly right: a continuation's
        // tokens arrive through __responsesExtraUsage instead.
        try {
          applyResponsesUsage(usageMetrics, extractStreamUsage(captured));
        } catch { /* usage is best-effort */ }

        // The upstream stream ending is NOT the end of the response when the web-search
        // plugin is splicing a continuation call into it: that second call is opened
        // after this event, so folding (and closing the socket) here without waiting
        // billed zero continuation tokens and cut the splice off mid-write. forwardStream
        // never runs the after-plugin chain either, so this is the only place the plugin
        // can be waited on. Absent an interceptor this returns immediately.
        await awaitResponsesStreamIdle(res, configService.getTimeout(true), () => {
          logger.warn('responsesController', `Web-search continuation did not finish in time for ${requestedModel}; closing the stream`);
        });

        // Same fold as the non-streaming path: the web-search continuation plugin
        // accumulates its extra deployment call's usage onto the request here.
        const extra = (req as any).__responsesExtraUsage;
        if (extra && (extra.input_tokens || extra.output_tokens || extra.cache_creation_tokens || extra.cache_read_tokens)) {
          updateTokenCounts(usageMetrics, extra.input_tokens || 0, extra.output_tokens || 0, extra.cache_creation_tokens || 0, extra.cache_read_tokens || 0);
        }
      } else if (reason === 'error') {
        statusCode = 500;
        // 4th parameter: the 3rd is Error-typed and silently drops plain objects.
        logger.error('responsesController', `Responses stream failed for ${requestedModel}: ${error?.message || error}`, undefined, {
          error: error?.message || error,
        });
        if (!res.writableEnded) {
          try {
            res.write(`data: ${JSON.stringify({ type: 'response.failed', response: { status: 'failed', error: { message: error?.message || 'stream error' } } })}\n\n`);
          } catch { /* best effort */ }
        }
      } else {
        // Client disconnected mid-stream. Still account for tokens received so
        // far — previously this path never resolved, so the usage event for a
        // cancelled stream was silently dropped.
        statusCode = 499;
        // The terminal frame that would normally carry usage never arrives on
        // this path (the upstream was destroyed) — derive a local estimate
        // from what was actually streamed instead of billing zero tokens for
        // a turn that really generated content.
        await estimateAbortedUsage(usageMetrics, captured, req, requestedModel);
      }

      emitUsageEvent(req, usageMetrics, requestedModel, statusCode);
      if (debugRequestId) {
        payloadLogger.savePayload(debugRequestId,
          reason === 'error' ? '97_responses_stream_error_from_deployment' : '03_responses_stream_from_deployment',
          { totalLength: captured.length, rawResponse: captured.slice(0, 200000) }, req, res);
      }
      if (!res.writableEnded) res.end();
      resolve();
    }

    upstream.data.on('end', () => finish('end'));
    upstream.data.on('error', (error: any) => finish('error', error));
    upstream.data.on('close', () => finish('close'));
  });
}
