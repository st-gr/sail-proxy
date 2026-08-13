/**
 * Whether/how to carry a Responses client's `reasoning.effort` through the
 * orchestration bridge, and in which of SAP's two thinking shapes.
 *
 * Only `body.reasoning.effort`, a string, triggers this at all. A present
 * `reasoning` object with no `effort` key (`{summary:'auto'}` — 90 of 90+148+158
 * real requests surveyed) is inert, same as `reasoning` being absent entirely
 * (148 requests): both must produce neither `thinking` nor `output_config`,
 * never a zero-budget or `{type:'disabled'}` stand-in.
 *
 * Two shapes exist upstream and they are NOT interchangeable per model:
 *   - `{thinking:{type:'adaptive'}, output_config:{effort}}` — the newer shape,
 *     effort passed straight through.
 *   - `{thinking:{type:'enabled', budget_tokens:N}}` — the older shape, no
 *     `output_config`; effort is translated to a token count (see
 *     EFFORT_TO_BUDGET_TOKENS below).
 * Sending the wrong shape to a model 400s (verbatim, from the live gateway):
 *
 *   "thinking.type.enabled" is not supported for this model. Use
 *   "thinking.type.adaptive" and "output_config.effort" to control thinking
 *   behavior.
 *   adaptive thinking is not supported on this model
 *   openai does not support parameters: ['thinking'], for model=gpt-5.5
 *
 * MODEL_REASONING_SUPPORT is an EXPLICIT table keyed on the exact model name —
 * deliberately not a version/family rule. The boundary measured live is ragged
 * (4.6 accepts both shapes, 4.7 accepts neither in a way that does anything —
 * see below), so any prefix/comparison heuristic is wrong for at least one
 * model. A name absent from the table gets nothing: absent means unmeasured,
 * not permitted — a new model must be added here after being probed, not
 * inferred from its neighbours.
 *
 * `anthropic--claude-4.7-opus` is deliberately ABSENT despite `adaptive`
 * returning HTTP 200 with all five efforts accepted: measured live, it never
 * produced `reasoning_content` (read from the raw SAP response, not HTTP
 * status) at any effort — including a hard logic puzzle at `xhigh`, where it
 * emitted 378 completion tokens of answer and no thinking block, while
 * 4.8-opus on the identical request produced 608 tokens WITH one. It also
 * rejects the budget shape, so it has no working shape at all; sending it
 * `adaptive` would buy a false positive (a 200 that silently thinks nothing).
 *
 * `anthropic--claude-4.6-opus` / `-sonnet` accept BOTH shapes and this table
 * picks `adaptive` for both: it is the shape the newer models keep, and it
 * maps directly onto `reasoning.effort` with no invented number in between.
 */
const MODEL_REASONING_SUPPORT: Readonly<Record<string, 'adaptive' | 'budget'>> = {
  'anthropic--claude-4.8-opus': 'adaptive',
  'anthropic--claude-4.6-opus': 'adaptive',
  'anthropic--claude-4.6-sonnet': 'adaptive',
  'anthropic--claude-4.5-opus': 'budget',
  'anthropic--claude-4.5-sonnet': 'budget',
  'anthropic--claude-4.5-haiku': 'budget',
};

/** The only effort values SAP accepts. All five are accepted on every adaptive model. */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

const VALID_EFFORTS: ReadonlySet<string> = new Set<ReasoningEffort>([
  'minimal', 'low', 'medium', 'high', 'xhigh',
]);

/**
 * Effort → `budget_tokens`, for models stuck on the older `enabled` shape.
 *
 * MEASURED, and the honest summary is "weak and saturating". 4.5-sonnet, same
 * prompt, 3 runs per effort, median characters of reasoning returned:
 *
 *   minimal 1024 -> 1261    low 4096 -> 1438    medium 8192 -> 1630
 *   high 16384 -> 1631      xhigh 32768 -> 1679
 *
 * Monotonic, so unlike `effort` on the ADAPTIVE shape this is not inert — but
 * the whole range buys +33% reasoning for a 32x budget increase, and it is flat
 * from `medium` up. The cause is visible in the numbers: 1261 characters is
 * roughly 315 tokens, so even `minimal`'s 1024 cap never binds. The model picks
 * its own depth; the budget nudges it and otherwise sits far above what is used.
 *
 * So these five numbers are defensible but their SPREAD is largely decorative.
 * Do not present this map to callers as a depth dial, and do not tune it
 * expecting proportional results. What IS measured is that every value here is
 * accepted (1024 through 32768, all three budget-shape models, with and without
 * `max_tokens`), and that 65536 is not — SAP's default ceiling is 64000.
 *
 * Separately, effort on the ADAPTIVE shape is genuinely inert: 4.6-opus gave
 * 846/979/977 reasoning chars for minimal/medium/xhigh, flat after the first
 * step, and an earlier sweep produced non-monotonic completion counts inside
 * run-to-run noise. A valid enum, not a dial.
 */
const EFFORT_TO_BUDGET_TOKENS: Readonly<Record<ReasoningEffort, number>> = {
  minimal: 1024,
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
};

/**
 * Anthropic's documented floor for `budget_tokens` on the `enabled` shape.
 *
 * NOT MEASURED, and now the only unmeasured constant in this file — the sweep
 * that settled EFFORT_TO_BUDGET_TOKENS above never probed BELOW 1024, so
 * nothing here establishes what SAP does with a smaller budget. Taken from
 * Anthropic's documentation, not from a probe. It is also unreachable in
 * practice: the halving reserve refuses before a budget this small can be
 * emitted, so a wrong value here would not change a single request today.
 */
const MIN_BUDGET_TOKENS = 1024;

/**
 * Both shapes refuse below this `max_tokens`. Thinking tokens bill inside
 * `completion_tokens`, so a small `max_tokens` leaves too little room for the
 * answer once thinking is added on top of it -- measured live
 * (test/fixtures/orchestration/reasoning-probe-results.md, "Adaptive thinking
 * truncates answers on a small `max_output_tokens`"), three runs per cell,
 * control (no thinking) vs. adaptive `xhigh` on the same hard prompt:
 *
 *   max_output_tokens=576   4.8-opus   control=[OK,OK,OK]   adaptive=[TRUNC,TRUNC,TRUNC]
 *   max_output_tokens=576   4.6-opus   control=[OK,OK,OK]   adaptive=[TRUNC,TRUNC,TRUNC]
 *   max_output_tokens=640   4.8-opus   control=[OK,OK,OK]   adaptive=[OK,OK,OK]
 *   max_output_tokens=640   4.6-opus   control=[OK,OK,OK]   adaptive=[TRUNC,TRUNC,TRUNC]
 *   max_output_tokens=768   4.6-opus   control=[OK,OK,OK]   adaptive=[TRUNC,OK,OK]
 *   max_output_tokens=896   both       control=[OK,OK,OK]   adaptive=[OK,OK,OK]
 *
 * TRUNC is `status: "incomplete"` with `incomplete_details: {reason:
 * "max_output_tokens"}` -- a request that completes today comes back
 * truncated once adaptive thinking is on, below this boundary.
 *
 * Read by the ADAPTIVE branch only. The budget branch arrives at the same
 * 2048 threshold EMERGENTLY, from `floor(maxTokens/2) < MIN_BUDGET_TOKENS`,
 * without reading this constant -- so changing the reserve from half to
 * anything else silently decouples the two. The 2047/2048 budget tests pin
 * that boundary, so the divergence would fail the suite rather than ship.
 *
 * 2048 is roughly 2.3x the measured adaptive boundary (896 completed 3/3 on
 * both models, 768 did not). It was chosen for symmetry with the budget
 * branch, not derived from the adaptive data, and is therefore conservative:
 * `max_output_tokens: 1500` gets no thinking though it would likely have
 * worked. Do not mistake this number for a measured one.
 *
 * An ABSENT `maxTokens` refuses on NEITHER shape: absent means SAP's own
 * ceiling (measured at 64000), not a small explicit value. Both branches now
 * agree on that, and both agreements are measured -- see the budget branch
 * below for the probe that settled it.
 */
const MIN_MAX_TOKENS_FOR_THINKING = 2048;

export interface ReasoningEffortInput {
  /** The orchestration model name, e.g. `anthropic--claude-4.8-opus`. */
  modelName: string;
  /** `body.reasoning?.effort`. Any value other than the five known ones is treated as unknown. */
  effort?: string;
  /**
   * `params.max_tokens` as already resolved by the caller (from the client's
   * `max_output_tokens`) — used only by the budget-shape branch, to keep
   * `budget_tokens` under it. This function does not read the request body
   * itself; the caller resolves `max_tokens` first and passes the result in.
   */
  maxTokens?: number;
  /**
   * `params.temperature` as already resolved by the caller. Present and not
   * exactly `1` suppresses thinking entirely — see the comment on
   * `hasIncompatibleSampling` below.
   */
  temperature?: number;
  /**
   * `params.top_p` as already resolved by the caller. Present and below
   * `0.95` suppresses thinking entirely — see `hasIncompatibleSampling`.
   */
  topP?: number;
  /**
   * `params.tool_choice` as already resolved by the caller. The exact string
   * `'required'` suppresses thinking entirely — see `isForcedToolChoice`.
   * Any other value (`'auto'`, `'none'`, the `{type:'function',name}` object
   * form, or absent) imposes no constraint.
   */
  toolChoice?: unknown;
}

export interface ReasoningEffortParams {
  thinking?: { type: 'adaptive' } | { type: 'enabled'; budget_tokens: number };
  output_config?: { effort: ReasoningEffort };
}

const NOTHING: ReasoningEffortParams = Object.freeze({});

/**
 * What the resolver did, and why. The two positive values mean a thinking key
 * was emitted; every other value means nothing was, for the named reason.
 */
export type ReasoningDecision =
  | 'adaptive'
  | 'budget'
  | 'no-effort'
  | 'unknown-effort'
  | 'incompatible-sampling'
  | 'forced-tool-choice'
  | 'model-not-supported'
  | 'max-tokens-too-small'
  | 'max-tokens-not-an-integer';

/** Whether a decision means a thinking key went out. */
export function reasoningWasEmitted(decision: ReasoningDecision): boolean {
  return decision === 'adaptive' || decision === 'budget';
}

/**
 * Whether the request's sampling params rule thinking out entirely, on BOTH
 * shapes. Measured live, not guessed (verbatim SAP 400s):
 *
 *   4.5-sonnet, temperature:0.2 + budget   -> "temperature" may only be set
 *     to 1 when thinking is enabled.
 *   4.5-sonnet, top_p:0.9      + budget   -> "top_p" must be greater than or
 *     equal to 0.95 or unset when thinking is enabled.
 *   4.6-opus,   temperature:0.2 + adaptive -> "temperature" may only be set
 *     to 1 when thinking is enabled or in adaptive mode.
 *
 * The control that makes this a real defect risk, not a curiosity: the SAME
 * requests without thinking succeed today (200). So a client sending
 * `temperature: 0.2` with `reasoning.effort` set works today and would 400
 * after this feature ships, unless thinking backs off first — this feature is
 * additive, and a request that works now must still work after it.
 *
 * The rule this function encodes: the CLIENT's sampling parameters win, and
 * thinking is suppressed rather than silently dropping or rewriting
 * temperature/top_p to make room for it — changing sampling behaviour to
 * enable a feature the caller did not ask for is worse than not enabling it.
 * Measured compatible values: `temperature: 1` and `top_p: 0.95` both got a
 * live 200 with thinking on. Absent values impose no constraint.
 */
function hasIncompatibleSampling(temperature?: number, topP?: number): boolean {
  if (typeof temperature === 'number' && temperature !== 1) return true;
  if (typeof topP === 'number' && topP < 0.95) return true;
  return false;
}

/**
 * Whether `tool_choice` forces tool use in a way thinking cannot coexist
 * with. Measured live, not guessed (verbatim SAP 400, identical wording on
 * both models probed):
 *
 *   4.5-sonnet, tool_choice:'required' + budget   -> LLM Module: Thinking
 *     may not be enabled when tool_choice forces tool use.
 *   4.6-opus,   tool_choice:'required' + adaptive -> same message.
 *
 * Applied to EVERY model, including 4.8-opus which accepts it. That was a
 * deliberately broad rule adopted from two measurements; all six models have
 * since been probed and FIVE of six 400 (4.5-opus, 4.5-haiku, 4.6-sonnet,
 * 4.5-sonnet, 4.6-opus), each against a passing no-thinking control. 4.8-opus
 * is the lone exception, so the uniform rule costs one model its thinking on
 * forced-tool turns and protects the other five.
 *
 * The control, same shape as the sampling conflict above: the identical
 * request without thinking succeeds today (200), so this is a real
 * additive-break risk, not a curiosity.
 *
 * The full matrix measured: `'auto'`, `'none'`, the `{type:'function',name}`
 * object form, and absent all pass WITH thinking on every model probed.
 * Only the exact string `'required'` conflicts — and even then, only on
 * 4.5-sonnet and 4.6-opus; 4.6-sonnet, 4.5-opus and 4.5-haiku were not
 * probed with `'required'`, and 4.8-opus was probed and PASSED.
 *
 * This suppresses on `'required'` for EVERY model anyway, 4.8-opus included.
 * Two data points (one 400, one 200) is not enough to carve out a per-model
 * exception on a boundary this table has already proven ragged once (4.6
 * accepts both thinking shapes, 4.7 accepts one and acts on neither) —
 * asymmetric cost, uniform rule: 4.8 loses thinking only on forced-tool
 * turns, which is a strictly smaller risk than shipping a per-model
 * carve-out on two measurements and hitting the next silent 400 on one of
 * the three untested models.
 */
function isForcedToolChoice(toolChoice: unknown): boolean {
  return toolChoice === 'required';
}

/**
 * Resolves `reasoning.effort` into the `params` fragment `buildOrchestrationPayload`
 * spreads in — or `{}` when nothing should be sent. `{}` is the uniform "emit
 * nothing" value for every reason this can decline (unmapped model, unknown
 * effort, incompatible sampling params, budget clamped below the floor,
 * `max_tokens` missing): the caller spreads the result either way and never
 * branches on why it was empty.
 *
 * Never throws. This is additive: a request that works today must still work
 * after this returns nothing for it.
 */
export function resolveReasoningEffort(input: ReasoningEffortInput): ReasoningEffortParams {
  return decide(input).params;
}

/**
 * Why `resolveReasoningEffort` decided what it did — for logging only.
 *
 * Exists because an empty result is otherwise indistinguishable from the
 * resolver never having run: a caller can see that no `thinking` key reached
 * the payload, but not whether that was an unmapped model, a sampling
 * conflict, or a forced tool choice. Every other capability gate on this
 * route announces its verdict; this one was silent.
 *
 * Shares its guards with `resolveReasoningEffort` by construction — both are
 * thin wrappers over `decide` — so a reason can never drift from the decision
 * it explains. Pure, like everything else here.
 */
export function explainReasoningEffort(input: ReasoningEffortInput): ReasoningDecision {
  return decide(input).decision;
}

function decide(input: ReasoningEffortInput): { params: ReasoningEffortParams; decision: ReasoningDecision } {
  if (typeof input.effort !== 'string') return { params: NOTHING, decision: 'no-effort' };
  if (!VALID_EFFORTS.has(input.effort)) return { params: NOTHING, decision: 'unknown-effort' };
  const effort = input.effort as ReasoningEffort;

  if (hasIncompatibleSampling(input.temperature, input.topP)) {
    return { params: NOTHING, decision: 'incompatible-sampling' };
  }
  if (isForcedToolChoice(input.toolChoice)) {
    return { params: NOTHING, decision: 'forced-tool-choice' };
  }

  const support = MODEL_REASONING_SUPPORT[input.modelName];
  // Explicit equality against the two known values, not `!== undefined` --
  // a lookup by an inherited key name (e.g. `constructor`, `toString`) would
  // otherwise resolve to a function/string rather than `undefined` and fall
  // through into the budget branch for a model that was never measured.
  if (support !== 'adaptive' && support !== 'budget') {
    return { params: NOTHING, decision: 'model-not-supported' };
  }

  if (support === 'adaptive') {
    // Refusal only -- the adaptive shape takes no budget and needs no clamp,
    // unlike the budget branch below. See MIN_MAX_TOKENS_FOR_THINKING for the
    // measured truncation this guards against. `!== undefined` (not a
    // truthiness or `Number.isInteger` check) so only an explicit small
    // number suppresses; an absent maxTokens passes straight through.
    if (input.maxTokens !== undefined && input.maxTokens < MIN_MAX_TOKENS_FOR_THINKING) {
      return { params: NOTHING, decision: 'max-tokens-too-small' };
    }
    return {
      params: { thinking: { type: 'adaptive' }, output_config: { effort } },
      decision: 'adaptive',
    };
  }

  // support === 'budget': budget_tokens must leave the answer enough room,
  // and stay at/above the 1024 floor. With no integral max_tokens to clamp
  // against, there is nothing safe to send. `Number.isInteger` (not
  // `typeof === 'number'`) rules out both NaN, which would skip the clamp
  // and emit the unclamped mapped value, and fractional token counts.
  //
  // The reserve is HALF of max_tokens, not "max_tokens minus a fixed
  // amount": an earlier version of this clamp reserved a flat 1024 for the
  // answer, which on `max_output_tokens: 4096` + `xhigh` sent
  // `budget_tokens: 3072` -- leaving only 1024 of the client's 4096-token
  // budget for the actual answer. Thinking tokens bill inside completion
  // tokens on this path, so a turn that finished today could come back
  // truncated (`incomplete: {reason: 'max_output_tokens'}`) after this
  // feature shipped. Halving instead means the answer never loses more than
  // half its budget to thinking. The 1024 floor is unchanged and still
  // applied after halving, so the emit-nothing threshold stays
  // max_tokens < 2048.
  //
  // An ABSENT max_tokens is NOT a refusal, because SAP supplies its own
  // ceiling. This branch used to refuse, on the reasoning that there was
  // nothing safe to clamp against -- which made it dead code for the traffic
  // that actually uses the feature: across the payload-log corpus, all 173
  // requests carrying `reasoning.effort` set no `max_output_tokens`, so all
  // three budget-shape models emitted nothing.
  //
  // Measured, no max_output_tokens sent, on 4.5-sonnet / 4.5-opus / 4.5-haiku:
  // every mapped budget from 1024 through 32768 completed on all three, none
  // truncated. 65536 failed with "`max_tokens` must be greater than
  // `thinking.budget_tokens`", and a binary search puts SAP's default ceiling
  // at 64000 (highest passing 63488, lowest failing 64512, both models).
  //
  // So the mapped budget goes out unclamped here: the largest of them (32768
  // for xhigh) is barely half the default ceiling, and there is no
  // client-supplied answer allowance to protect -- the halving below exists
  // to stop thinking eating a budget the CLIENT chose, and there is none.
  if (input.maxTokens === undefined) {
    return {
      params: { thinking: { type: 'enabled', budget_tokens: EFFORT_TO_BUDGET_TOKENS[effort] } },
      decision: 'budget',
    };
  }

  if (!Number.isInteger(input.maxTokens)) {
    return { params: NOTHING, decision: 'max-tokens-not-an-integer' };
  }
  const budgetTokens = Math.min(
    EFFORT_TO_BUDGET_TOKENS[effort],
    Math.floor(input.maxTokens / 2),
  );
  if (budgetTokens < MIN_BUDGET_TOKENS) {
    return { params: NOTHING, decision: 'max-tokens-too-small' };
  }

  return {
    params: { thinking: { type: 'enabled', budget_tokens: budgetTokens } },
    decision: 'budget',
  };
}
