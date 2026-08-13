# Token-accounting audit (2026-08-07)

## Why this audit exists

Two billing bugs with opposite signs were discovered in one week, both in the same arithmetic. The first subtracted cached tokens where the accounting was exclusive; the next did not subtract where it was inclusive. The sweep of every route's usage accounting was requested by the user and is captured here. Separately, the user ruled that prompt caching should default ON for Anthropic models.

## Measured constants (load-bearing in tests and comments)

**Endpoint: `/openai/v1/chat/completions` orchestration** (2026-08-07, 4.8-opus)

| Metric | Run 1 | Run 2 | Regime |
|---|---|---|---|
| `prompt_tokens` | 14 | 14 | exclusive |
| `cached_tokens` | 0 | 29004 | EXCLUSIVE |

**Endpoint: `/openai/v1/responses` bridge** (2026-08-07, 4.8-opus and 4.6-sonnet control)

| Metric | Run 1 (4.8-opus) | Run 2 (4.8-opus) | Control (4.6-sonnet) | Regime |
|---|---|---|---|---|
| `prompt_tokens` | 16303 | 16303 | 25237 | inclusive? |
| `cache_creation_tokens` | 16292 | 0 | 0 | (write/read split) |
| `cached_tokens` | 0 | 16292 | 0 | (write/read split) |

The control ran on model 4.6-sonnet, not 4.8-opus, so the inclusive verdict sits on a tokenizer confound. Probe T1 resolves this by testing all arms on a single model.

**Endpoint: `gpt-5-mini` non-supporting model** (2026-08-07)

Sent `cache_control: true` to SAP, received 200 HTTP with `cached_tokens: 0`. SAP silently ignores unsupported cache breakpoints rather than rejecting them.

## Verified defect inventory

All file:line confirmed (`services/gateway/src` unless noted).

| # | Path/Route | File:Line | Symptom | Direction | Counting regime | Status |
|---|---|---|---|---|---|---|
| 1 | Responses native | engine.ts:726-738, responsesController.ts:2179-2187; folded 2-arg at 374,395,589,734 | `__responsesExtraUsage` carries only input/output; `noteUsage` and non-streaming loop drop `cached_tokens` → continuation rounds bill cache reads at FULL RATE | over-bill | native (n/a) | open — T4b |
| 1c | Responses bridge | responseTranslator.ts:90-99, streamTranslator.ts:77-85 | Bridge translators emit `cached_tokens` but drop `cache_creation_tokens` → cache-write continuation rounds also full-rate | over-bill | inclusive | open — T4a |
| 2 | Chat orchestration | openaiController.ts:263,604,626,745,773 | `prompt_tokens_details` never read → cache reads never billed. Path is exclusive; the line item is simply missing. Client JSON forwards SAP usage verbatim | under-record | exclusive | open — T5 |
| 3 | Bedrock Converse | awsBedrockService.ts:656-670, :891-895, :1100,:1587,:1608 | `BedrockResponse.usage` type and `transformBedrockToAnthropicResponse` never capture cache fields; raw streaming folds never read `cacheReadInputTokenCount`/`cacheWriteInputTokenCount` | under-record | n/a | open — T6,T7 |
| 4 | Anthropic web_search | anthropicWebSearchStream.ts (0 usage hits); emitted at awsBedrockService.ts:1118 before finalize() at :1181 | Continuation turn NEVER billed; usage event fires before `finalize()` — fix is lifecycle reorder, not callback | under-bill | n/a | open — T8 |
| 5 | Engine client-visible merged | engine.ts:2227 | Input/output summed across rounds, but spread carries LAST round's `total_tokens` + `input_tokens_details` — USER RULED: fix by summing details + recomputing total | client-visible | n/a | open — T10 |
| 6 | Admin cost recalc | costRecalculationService.ts:122-155 (SQLite), :115,154 (both gates) | SQLite branch recomputes `totalCost` from input+output only while cache-cost columns stay populated — actively corrupts totalCost invariant. Both branches gate on `inputTokens > 1`, excluding exactly the fully-cached turns. Postgres drift predicate watches only `inputCost` | corruption | n/a | open — T9 |
| 7 | Bridge request | requestTranslator.ts:172-187 vs openaiController.ts:1072-1073 | Bridge sends system message TWICE: same object in `template` AND in `messages_history` (chat path keeps disjoint). `applyCacheBreakpoints` deep clone marks only history copy. Independent cost suspect AND leading hypothesis for inclusive/exclusive contradiction | over-bill? | inclusive? | pending probe T1 — fix task T2b (conditional) |
| 8 | Chat streaming | openaiController.ts:547 | `streamTokenCounts.inputTokens += …` per usage-bearing chunk — provider repeating usage double-counts | over-bill? | exclusive | pending probe T2 — fix task TBD |

## Pipeline verified clean

Event pipeline downstream of `updateTokenCounts`/`emitUsageEvent` is verified clean end to end: event → Valkey → usageEventProcessor → `modelCostService.calculateCosts` → CDS columns → dashboard SQL. All four token categories (`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`) carried without drops.

## Deferred, logged not fixed

**openaiController.ts:1382-1403** — Emulated streaming rebuilds usage for the client-visible JSON and strips `prompt_tokens_details` from the response body. Out of scope for billing audit (client-facing only; the server-side metrics are correct). Logged as a known divergence from native OpenAI.

## Resolution (closed 2026-08-07, T11)

Every row above is closed below with its fix commit(s) and the evidence that
closes it. Full commit map and per-task detail:
`.superpowers/sdd/2026-08-07-usage-accounting-audit/progress.md` and the
`task-T*-report.md` files beside it. Live evidence is from T11's three arms
(`task-T11-report.md`), run against the nodemon gateway at commit `aa91c97`.

**Row 1 — Responses native, `__responsesExtraUsage` drops the cache split.**
CLOSED. Fix: `0aa1e66` (T4b) — `noteExtraUsage` (`utils/usageFolding.ts`) now
folds the PER-ROUND full-rate remainder `max(0, raw − read − creation)` and
accumulates `cache_creation_tokens` / `cache_read_tokens` separately; every fold
site widened to 4 categories. Evidence: LIVE, T11 Arm 2 — a continuation round
that read a 12,937-token prefix billed `inputTokens 7189` (= the two rounds'
full-rate parts) with the 12,937 in `cacheReadInputTokens`. The old 2-arg fold
would have billed ≈20,251, a 2.8× over-bill on that one request. Plus
`test/responses-native-usage-fold.test.ts` and the discriminating two-round test
in `usage-folding.test.ts` (per-round vs sum-then-clamp actually separated —
the brief's original numbers could not tell them apart).

**Row 1c — bridge translators drop `cache_creation_tokens`.** CLOSED. Fix:
`eac44fd` + `f12d72a` (T2b+) — `responseTranslator.translateUsage` (shared with
`streamTranslator`) emits BOTH `cached_tokens` and `cache_creation_tokens` in
`input_tokens_details` and normalizes the client object to OpenAI-INCLUSIVE
(`input_tokens = prompt + cached + creation`) with `total_tokens` recomputed.
Evidence: LIVE, T11 Arm 1 — client `input_tokens` 11718 = 14 + 0 + 11704,
`cache_creation_tokens` 11704 present, `total_tokens` 11722 recomputed (SAP's
own exclusive total was 18).

**Row 2 — chat orchestration never reads `prompt_tokens_details`.** CLOSED.
Fix: `49073e2` + `13da828` (T5) — the four orchestration-branch sites in
`openaiController.ts` now fold with `foldExclusiveUsage` including the cache
split. Evidence: T5's suite (+5 tests, mutations isolated by name) plus T2's
live captures establishing the exclusive regime. NOTE, deliberate and
unresolved: the DEPLOYED-model branch (`openaiController.ts:262-274`,
`OPENAI_COMPATIBLE_DEPLOYMENT_PROVIDERS` = openai|perplexity) was reverted to a
NO-SPLIT fold in `13da828` — real OpenAI `cached_tokens` is INCLUSIVE, so
splitting there would double-count. It under-records cache reads on that branch
IF that branch ever serves cached traffic. Carried as an open item below.
Also carried from T2: `cache_creation_tokens` is not reported on the SAP
STREAMING chat path, so cache writes are unbillable there — provider-side.

**Row 3 — Bedrock Converse cache fields never captured.** CLOSED. Fix:
`0f867b4` (T6/T7) — `BedrockResponse.usage` widened,
`transformBedrockToAnthropicResponse` captures the cache fields, and all three
raw streaming fold sites go through one helper, `foldRawBedrockStreamUsage`,
which normalizes both raw shapes with tolerant `?? 0` reads.
Evidence: LIVE, T11 Arm 3 — a fresh 2026-08-07 capture on
`/anthropic/v1/messages` shows the `amazon-bedrock-invocationMetrics` envelope
carrying `inputTokenCount` / `outputTokenCount` / `cacheReadInputTokenCount` /
`cacheWriteInputTokenCount`, with `cacheWriteInputTokenCount: 12869` folded
through to the event. Those four spellings are now confirmed by two independent
captures (2026-07-22 and 2026-08-07).
REMAINS UNCONFIRMED: the **Converse** shapes — `metadata.usage.inputTokens` /
`outputTokens` / `cacheReadInputTokens` / `cacheWriteInputTokens` — carry
AWS-docs names with no capture behind them, because no Converse traffic exists
locally (all local traffic is the SAP native Anthropic passthrough route). The
code comments say so at the site. `bedrockStreamParser.ts` uses a DIFFERENT
spelling for the same Converse fields; T6/7 flagged the disagreement and left it
untouched, and T11 could not resolve it either — no Converse traffic to measure.
Carried as an open item.

**Row 4 — Anthropic web_search continuation never billed; event fired before
`finalize()`.** CLOSED. Fix: `a6682fd` + `56779b6` (T8) — `anthropicWebSearchStream`
gained an `onUsage` callback folded with `foldExclusiveUsage`
(`awsBedrockService.ts:1088-1096`); the first-turn emit is suppressed while a
web_search stream is active (`:1210`) and the single emit is deferred until
after `await finalize()` (`:1285-1288`).
Evidence: LIVE, T11 Arm 3 — one event, containing the continuation's 3,261
full-rate input, 170 output and 12,869 cache-read tokens alongside turn 1's
382/67/12,869-write. Pre-fix that event would have read 382/67/12869/0 and lost
the entire continuation. Channel event count for the requestId: exactly 1.

**Row 5 — engine client-visible merged usage spreads the last round's details.**
CLOSED. Fix: `db37f2f` (T10), per the user's ruling (sum details + recompute
total), at BOTH sites — the non-streaming merge (`hostedTool/engine.ts:~2266`)
and the streaming terminal-frame merge in `installHostedToolInterceptor`
(`~:1253`), the second found during implementation and the one codex actually
streams through. Evidence: LIVE, T11 Arm 2 — the client's single
`response.completed` frame carried summed `cached_tokens` 12937 +
`cache_creation_tokens` 125 across rounds with `total_tokens` 20368 recomputed,
and `input_tokens` 20251 closes exactly against the billed event
(7189 + 12937 + 125).

**Row 6 — admin cost recalc corrupts `totalCost`; both gates exclude fully-cached
turns.** CLOSED. Fix: `8340b4a` (T9) — the SQLite branch's `totalCost` now
includes both cache-cost terms; both branches' `inputTokens > 1` gate replaced;
the Postgres drift predicate widened past `inputCost` (and treats NULL cache-cost
columns as needing recalc). Evidence: the admin suite's own tests — T9 added 5
(+1 suite), including a `better-sqlite3` in-memory test that executes the real
generated SQL, and three mutations isolated by name (`totalCost` 0.000753 vs
0.009454; old gate 0 rows vs 1; old predicate fails both new Postgres tests).
T11 re-ran them: `cost-recalculation.test.ts` + `cost-recalculation-sqlite.test.ts`,
18/18 passing. NOT live-verifiable from the gateway — this is a different service
with no gateway-observable output; closed on its suite.

**Row 7 — bridge sends the system message twice.** CLOSED. Probe: `5916829`
(T1) established the duplication was also the cause of the bridge's apparent
INCLUSIVE regime (arm A0 15903 = 15892 + 11 inclusive; arm A2, de-duplicated,
14 flat with cache 0→17692 exclusive; arm A1, both copies marked, exclusive but
~2× the write cost). Fix: `eac44fd` (T2b+) — `requestTranslator` keeps template
and `messages_history` disjoint, `cacheBreakpoints` marks the TEMPLATE copy, and
`recordOrchestrationUsage` flipped to `foldExclusiveUsage` in the SAME commit so
the `max(0, 14 − cache) = 0` window never existed live.
Evidence: LIVE, T11 Arms 1 and 2 — 1 marked system copy in `prompt.template`,
0 in `messages_history`, exactly 1 `cache_control` marker on the wire, on both
the non-streaming and the streaming call.

**Row 8 — chat streaming `+=` per usage-bearing chunk may double-count.**
CLOSED as NOT A DEFECT TODAY. Probe: `47a331a`..`f9a369e` (T2, 3 rounds) —
usage arrives on the FINAL chunk only (1 of 2 raw chunks carried it,
corroborated by an independent historical log), so the `+=` adds once. The `+=`
was kept per the plan's own design gate. RESIDUAL RISK, logged not fixed: a
longer stream repeating usage across chunks would double-count, and no capture
of such a stream exists. Unchanged by T11 — none of its three arms exercises
streaming `/openai/v1/chat/completions`.

### Findings added by the audit that are NOT defects in this code

- **SAP streaming omits cache-write counts.** Measured by T2 on
  `/openai/v1/chat/completions` and again by T11 Arm 2 on the streaming
  `/openai/v1/responses` bridge, where a ~12,937-token cache write went entirely
  unreported. T11 also FALSIFIED the stronger form of T2's statement: round 2 of
  that same streaming request DID report `cache_creation_tokens: 125`, so the
  field is not categorically absent and the governing rule is unknown. Direction
  is under-record. The gateway transcribes provider-reported usage; nothing to
  fix here.
- **SAP's streaming `cached_tokens` can exceed any possible tokenization of the
  cached block** (T2 round 3: 43008 tokens from an exactly-31,000-char block =
  1.39 tokens/char, characterwise impossible for English BPE). Cause unknown,
  recorded as a provider-side reporting observation.
- **Client-visible usage on the Anthropic web_search path is not merged across
  rounds** (found by T11 Arm 3). `message_start.usage` carries turn 1
  (input 382, creation 12869) and the surviving `message_delta.usage` carries
  turn 2 (input 3261, read 12869, output 170); neither frame carries the
  request's totals. Same defect class as row 5, on a path T10 did not cover
  (`anthropicWebSearchStream.ts:586-599`). BILLING IS UNAFFECTED — the usage
  event is correct and complete. The module header states the one-message design
  deliberately and asserts `usage.server_tool_use` is the only field Claude Code
  reads off that delta; whether that is true of every client is the open
  question. Not fixed (T11 ships zero production diff) — raised for triage.

### Open items carried forward to the final review

1. **Deployed-branch capture gap.** No capture exists of a cached response from
   the OpenAI/Perplexity direct-deployment branch
   (`openaiController.ts:262-274`). Its fold is deliberately no-split with an
   unverified-regime comment; it under-records cache reads if that branch ever
   serves cached traffic. Needs one real capture to resolve.
2. **`stripCacheControlScope` per-model hook gap.** The plugin is registered
   per-model via static `hooks` lists in `api_config.json` and is ALREADY
   missing on **5 of 11** Anthropic models. Pre-existing, not widened by B2/B3,
   and off both paths those tasks touched (separate mechanism, direct-Anthropic
   client-scope path). Follow-up owed.
3. **Provider-`unknown` catalog drift.** `cachingProvider` derives
   `provider || owned_by`, and `modelService` falls back to `'unknown'`
   (`:347,:357` `baseModel.provider || 'unknown'`; `:370,:380` a literal
   `'unknown'` for running deployments missing from the catalog). None of the 11
   pruned entries carries a `provider` key — identity is catalog-merge only. The
   B3 fix makes the Bedrock strip require an EXPLICIT config `false`, so drift
   there is now a cache MISS (safe, observable) rather than a silent strip of
   Claude Code's own `cache_control`. The drift itself is not fixed.
4. **B4 live-default probe BLOCKED.** Verifying that prompt caching engages via
   the new DEFAULT tier requires the pruned config to be PUBLISHED from the
   admin service; the live gateway serves the admin-published config, in which
   every registered Anthropic model still carries an explicit
   `supports_prompt_caching: true`. Until then the default tier is unreachable
   live. T11's arms deliberately do not depend on it — they verify the
   workstream-A code fixes, which nodemon hot-reloads — and every T11 number
   above was measured with caching on via the explicit model flag.
