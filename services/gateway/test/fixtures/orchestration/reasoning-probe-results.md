# Reasoning on the orchestration route — probe results

Tasks 1 and 2 of the reasoning-parity plan. Probed 2026-08-12 against the live gateway via
`/openai/v1/responses`, using a temporary `thinking` / `output_config` passthrough in
`buildOrchestrationPayload` that was reverted immediately afterwards and never committed.

**Both probes overturned the plan's stated prior.** The prior came from secondary sources; the plan
said to treat it as a prior and measure. That was the right call — it was wrong in both directions.

## Task 1 — what SAP accepts is a three-way, GENERATION-SPLIT answer

| model | `thinking:{type:"enabled",budget_tokens:N}` | `thinking:{type:"adaptive"}` + `output_config.effort` |
|---|---|---|
| `anthropic--claude-4.8-opus` | **rejected** | **accepted** — all of minimal/low/medium/high/xhigh |
| `anthropic--claude-4.5-sonnet` | **accepted** | **rejected** |
| `gpt-5.5` (non-Anthropic) | **rejected** | — |

Verbatim errors:

```
4.8-opus + enabled:   400 - LLM Module: "thinking.type.enabled" is not supported for this model.
                      Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.
4.5-sonnet + adaptive: 400 - LLM Module: adaptive thinking is not supported on this model
gpt-5.5 + thinking:    400 - LLM Module: openai does not support parameters: ['thinking'], for model=gpt-5.5
```

The prior said budget-token thinking was the Anthropic shape and adaptive was rejected. That holds
for the 4.5 generation and is **exactly inverted** on 4.8 — whose error message helpfully names the
replacement. So a mapping cannot be provider-gated alone; it must be **generation-aware**, and the
newer shape (`output_config.effort`) maps almost one-to-one onto the `reasoning.effort` codex
already sends.

Not established: where the boundary sits between the two shapes. Only 4.8-opus and 4.5-sonnet were
probed; 4.6 and 4.7 are untested and must not be assumed to follow either neighbour.

## Task 2 — structured reasoning DOES come back

The prior said SAP does not pass structured thinking to clients. It does. The raw SAP response's
message carries `reasoning_content` beside `content`:

```
message keys: ['content', 'reasoning_content', 'role']
```

`reasoning_content` is a LIST of signed thinking blocks:

```json
{ "content": "So if all but 9 run away, that means 9 stay behind. He then buys twice that
              amount, which is 18 more, bringing the total to 27.",
  "signature": "EroCCnEIEBABGAIqQJz6rK5Y59WxJRsiz8WxwCjFfNs…" }
```

That is Anthropic's signed thinking block, passed through by SAP intact — real reasoning text plus
the signature Anthropic uses to validate a thinking block replayed on a later turn.

**The gateway discards it.** `responseTranslator.ts` emits only `message` and `function_call` items
and never reads `reasoning_content`, so nothing reaches the client.

## What this changes

The plan was written expecting "input half deliverable, output half not". **Both halves are
deliverable.** The output half is the more valuable one — it is the difference between a model that
reasons invisibly and one whose reasoning a client can display and replay.

Consequences for the implementation, none of them yet built:

- The effort mapping is generation-aware, not merely provider-aware. `utils/promptCachingSupport.ts`
  is still the right resolver pattern, but the axis is model generation as well as provider.
- A `reasoning` output item can be built from real captured fields rather than fabricated — which is
  what the bridge's `DROPPED_ITEM_TYPES` comment refused to do when no such data existed.
- The `signature` field matters for multi-turn: replaying a thinking block without it is what
  Anthropic rejects. Whether SAP requires it on the way back in is UNTESTED.
- Cost: on 4.5-sonnet with a 2048 budget, a trivial question produced `output_tokens: 57` against 3
  on 4.8-opus with adaptive — thinking tokens appear to be counted in completion tokens on at least
  one path. The reasoning turn above billed `completion_tokens: 132` for a 27-word answer plus its
  reasoning. Enabling this spends real money; the plan's requirement to record cost stands.

## Task 3 — the boundary is RAGGED, and acceptance does not mean it works

Seven models × three arms (baseline / `budget_tokens: 2048` / `adaptive` + `output_config.effort`),
39 successful orchestration turns. "produces reasoning" is read from `reasoning_content` in the raw
SAP response (`payload.final_result.choices[0].message`), not inferred from token counts.

| model | `type:"enabled"` + budget | `type:"adaptive"` + effort | produces `reasoning_content` |
|---|---|---|---|
| `anthropic--claude-4.8-opus` | rejected | accepted, all 5 efforts | **yes**, when it chooses to think |
| `anthropic--claude-4.7-opus` | rejected | accepted, all 5 efforts | **NO — never, at any effort** |
| `anthropic--claude-4.6-opus` | **accepted** | **accepted**, all 5 efforts | yes, from either shape |
| `anthropic--claude-4.6-sonnet` | **accepted** | **accepted**, all 5 efforts | yes, from either shape |
| `anthropic--claude-4.5-opus` | accepted | rejected | yes |
| `anthropic--claude-4.5-sonnet` | accepted | rejected | yes |
| `anthropic--claude-4.5-haiku` | accepted | rejected | yes |
| `gpt-5.5` | rejected | — | no |

There is no clean generation cut. There are four regimes:

- **4.5** — old shape only.
- **4.6** — a transition generation that takes BOTH shapes and thinks under either.
- **4.7** — new shape only, and it does nothing. See below.
- **4.8** — new shape only, and it works.

### 4.7-opus accepts adaptive and is inert

Every 4.7 adaptive arm returned no `reasoning_content` — trivial question and hard question alike,
at minimal, medium and xhigh. Against a genuine logic puzzle at `effort: "xhigh"` it produced 378
completion tokens of answer and still no thinking block, where 4.8 on the identical request produced
608 tokens **with** one. Since 4.7 also rejects `budget_tokens`, **4.7-opus has no working thinking
shape on this route** — accepted-but-silent one way, 400 the other.

A silent acceptance is worse than a rejection: a resolver that trusts the 200 will ship a feature
that reports success and delivers nothing. Any "supported" table must be keyed on observed
`reasoning_content`, not on HTTP status.

### `effort` is accepted everywhere it is accepted at all, but barely moves anything

On 4.6-opus the five efforts gave completion tokens 133 / 133 / 216 / 133 / 212 for
minimal / low / medium / high / xhigh; on 4.6-sonnet, 87 / 87 / 90 / 87 / 87. Non-monotonic, within
run-to-run noise. Effort is a valid enum, not a measured dial — do not promise callers it scales
thinking depth.

### Adaptive is genuinely adaptive

On 4.8, the trivial "17 + 25" question returned **no** `reasoning_content` at any of the five
efforts (completion = 3 each), while the harder question returned one at every effort. Budget-token
thinking, by contrast, produced a block even on the trivial question. So on the adaptive shape a
`reasoning` output item will be **absent on many ordinary turns with thinking fully enabled** — the
translator must treat absence as the normal case, never as an error.

### Correction to Task 1

Task 1 recorded 4.8 + adaptive as accepted, which held, but its sample was the trivial prompt; it did
not establish that thinking actually engaged. It does, on hard prompts. Read the earlier
`completion_tokens: 3` rows as "did not think", not as "thought cheaply".

### Method note for Task 3

Model names must be confirmed to resolve before a rejection means anything. `api_config.json` lists
4.5/4.6/4.7 only with the `--deployed` suffix; the running config comes from the admin DB and serves
all seven bare orchestration names (`GET /openai/v1/models`). Every model here passed a baseline
no-`thinking` turn first, so each 400 is attributable to the shape and not to an unknown model.

## Thinking versus the sampling parameters — and where those limits actually come from

Found while reviewing the effort resolver: it would emit `thinking` beside whatever `temperature` /
`top_p` the client sent, a combination nobody had tried. 34 probes across four models.

### The gateway imposes none of this

Searched before probing, because "we must have hardcoded these values at some point" is the natural
first suspicion and it is wrong:

- `git log -S"top_p" -- services/gateway/src` returns four commits, none introducing a fixed value.
- The **only** literal `top_p: 0.95` in the tree is `modelUtils.getDefaultParameters` — which is
  **dead code**: exported, mocked by two tests, called from nowhere in `src`. It is a coincidence,
  and a convincing-looking one; do not read it as the origin.
- The V1→V2 orchestration migration (`e2e560d`) touched `modelUtils.ts` in exactly one place: a
  comment about `stream`. It changed no sampling behaviour.
- No path injects a default `temperature` or `top_p`. Both are forwarded only when the client sent
  them (`openaiController.ts:922-933`, `requestTranslator.ts:292-294`).

Every limit below is enforced upstream, in SAP's LLM module, and every rejection is a 400 relayed
from there. Three separate mechanisms, which is why they look inconsistent:

| # | limit | applies | source |
|---|---|---|---|
| 1 | `temperature` must be exactly 1; `top_p` unsupported at ANY value | 4.7-opus, 4.8-opus — **with or without thinking** | litellm model-level (`litellm.UnsupportedParamsError`) |
| 2 | `temperature` must be exactly 1; `top_p` must be `>= 0.95` | 4.5, 4.6 — **only when thinking is on** | Anthropic extended thinking (error links docs.claude.com) |
| 3 | `temperature` and `top_p` cannot BOTH be set | 4.5, 4.6 — **with or without thinking** | SAP/Anthropic harmonization |

### Measured

```
### A. no thinking — today's baseline
4.5-sonnet  temperature 0.2          PASS      4.6-opus  temperature 0.2       PASS
4.5-sonnet  top_p 0.9                PASS      4.6-opus  top_p 0.9             PASS
4.5-sonnet  temperature 0.2+top_p 0.9  FAIL — `temperature` and `top_p` cannot both be specified for this model.
4.7-opus    temperature 0.2          FAIL — claude-opus-4-7 does not support temperature=0.2. Only temperature=1 is supported.
4.7-opus    top_p 0.9                FAIL — claude-opus-4-7 does not support top_p=0.9.
4.8-opus    temperature 0.2          FAIL — claude-opus-4-8 does not support temperature=0.2. Only temperature=1 is supported.

### B. with thinking — the boundary is exact
4.5-sonnet + budget:  temperature 1 PASS | 0.999 FAIL | 0.9 FAIL | 0 FAIL
4.5-sonnet + budget:  top_p 1 PASS | 0.95 PASS | 0.949 FAIL | 0.9 FAIL
4.6-opus + adaptive:  temperature 1 PASS | 0.999 FAIL ;  top_p 1 PASS | 0.95 PASS | 0.949 FAIL
4.5-sonnet + budget:  temperature 1 AND top_p 0.95 together → FAIL (limit 3, not a thinking limit)
4.8-opus + adaptive:  temperature 1 PASS ; top_p 0.95 FAIL ; top_p 1 FAIL   (limit 1, not a thinking limit)
```

`temperature: 0.999` failing is what makes limit 2 an equality test, not a range.

### Why this is a defect and not a curiosity

Rows A1/A2/A4/A5 succeed on the gateway **today**. A resolver that enables thinking whenever the
client sends an effort turns each of them into a 400 — the "strictly additive" violation the feature
is required not to commit. Hence: **the client's sampling parameters win and thinking is suppressed**
when `temperature != 1` or `top_p < 0.95`. Dropping or rewriting the client's sampling values to make
room for thinking was rejected — silently changing generation behaviour to enable something the
caller never asked for is the worse trade.

The rule cannot over-suppress: every model that thinks requires exactly `temperature: 1` and
`top_p >= 0.95`, so there is no value it refuses that would have worked. It can still let through two
requests that fail anyway (4.8 + any `top_p`; both params set at once) — both are limits 1 and 3,
which 400 identically without thinking, so neither is a regression this feature introduces.

### Blast radius

Across **1,923 captured client requests**, real traffic sends a sampling parameter **six times**: six
`original_anthropic_request` with `temperature: 1` — the one value compatible with thinking, on a
route that has no reasoning feature. Every other row in the capture corpus (`temperature` 0.2/0.9/
0.999/0/9.5, `top_p` 0.9/0.949/0.95/1) is a probe from this investigation. No real client has ever
sent `top_p` or `top_k` to this gateway. Codex sends neither.

`top_k` is not a concern for this route for a structural reason rather than a measured one: the
bridge forwards exactly four params (`max_tokens`, `temperature`, `top_p`, `tool_choice`) and
`top_k` is not among them, so it cannot reach a thinking request. It IS forwarded on the chat path
(`modelUtils.ts:59-61`, Anthropic branch) and its interaction with thinking there is untested.

## Thinking versus forced tool choice

Raised by review as an untested risk, then measured. It is real, and it is the same shape as the
sampling conflict — a request that succeeds today 400s once thinking is added.

| `tool_choice` | + thinking, 4.5-sonnet (budget) | + thinking, 4.6-opus (adaptive) | + thinking, 4.8-opus (adaptive) |
|---|---|---|---|
| `'required'` | **400** | **400** | PASS |
| `'auto'` | PASS | PASS | PASS |
| `'none'` | PASS | PASS | PASS |
| `{type:'function', name:'get_weather'}` | PASS | PASS | PASS |
| absent | PASS | PASS | PASS |

```
Thinking may not be enabled when tool_choice forces tool use.
```

Control: `4.5-sonnet` with `tool_choice: 'required'` and **no** thinking returns a `function_call`.

Only the literal string `'required'` conflicts. The object form names a specific tool and also forces
tool use in Anthropic's terms, yet passes — so this is a check on the value SAP receives, not on the
semantics, and the resolver must compare the exact string rather than reasoning about intent.

**The resolver suppresses on `'required'` for every model, 4.8-opus included, even though 4.8 accepts
it.** That is a deliberate trade of one capability for uniformity: two passing measurements are not a
boundary, and this table has already proved ragged once (4.6 takes both thinking shapes, 4.7 takes one
and acts on neither). 4.5-opus, 4.5-haiku and 4.6-sonnet are untested here. Anyone minded to carve out
the 4.8 exception later should re-measure the other four first.

Not a live concern on hosted-tool continuations: `engine.ts:1825-1830` already relaxes `'required'`
to `'auto'` before `responsesController.ts:451-453` rebuilds the body, so continuations legitimately
keep their thinking.

## Adaptive thinking truncates answers on a small `max_output_tokens`

Also raised by review as unverified, also confirmed. Three runs per cell — completion is
sampling-dependent near the boundary, so a single run proves nothing. Same hard prompt throughout;
TRUNC is `status: "incomplete"` with `incomplete_details: {reason: "max_output_tokens"}`.

| `max_output_tokens` | model | control (no thinking) | + adaptive `xhigh` |
|---|---|---|---|
| 576 | 4.8-opus | OK, OK, OK | **TRUNC, TRUNC, TRUNC** |
| 576 | 4.6-opus | OK, OK, OK | **TRUNC, TRUNC, TRUNC** |
| 640 | 4.8-opus | OK, OK, OK | OK, OK, OK |
| 640 | 4.6-opus | OK, OK, OK | **TRUNC, TRUNC, TRUNC** |
| 768 | 4.6-opus | OK, OK, OK | **TRUNC**, OK, OK |
| 896 | both | OK, OK, OK | OK, OK, OK |

This is the third strictly-additive violation and the only one that does not announce itself: no 400,
just a shorter answer and an `incomplete` status the caller may not inspect. It exists because thinking
tokens bill inside `completion_tokens`, so they come out of the same allowance as the answer.

At `max_output_tokens: 512` both control and adaptive truncate — 512 is simply too small for the
prompt — but thinking still costs answer content within it: 817 characters against the control's 1547.
Degradation without a status change.

Hence both shapes refuse below `max_output_tokens: 2048`: the budget shape because Anthropic requires
`max_tokens > budget_tokens` outright (`` `max_tokens` must be greater than `thinking.budget_tokens` ``,
measured), the adaptive shape because of the table above. 2048 sits clear of the measured boundary —
896 completed 3/3 on both models, 768 did not.

An **absent** `max_output_tokens` still gets thinking. Absent means the model's own default, which is
large; it is not a small explicit value and must not be treated as one.

## Multi-turn tool use with thinking on — the last additive risk, now closed

The whole-branch review's top follow-up, and the gap the earlier probes left open: every measurement
above was a single turn, while the traffic that carries `reasoning.effort` is multi-turn tool use —
of 173 effort-carrying requests, 71 replay `function_call` items and 53 replay `reasoning` items.

The concern was concrete. Anthropic requires a thinking block to be echoed back on the assistant turn
that carried the `tool_use` when thinking is enabled, and this bridge cannot do that: it DROPS
`reasoning` input items, and rebuilds the assistant turn as `{role:'assistant', content:'',
tool_calls:[…]}` with no thinking block. If SAP relayed that requirement, every codex tool round after
the first would 400.

**It does not.** Probed against the SHIPPED resolver — no passthrough, `reasoning.effort` carried by
the merged code, so this exercises the real path a client will take.

| history | 4.8-opus | 4.6-opus |
|---|---|---|
| bare user + tools | completed | completed |
| + `function_call` / `function_call_output` replayed | completed | completed |
| two tool rounds replayed (7 items) | completed | completed |
| two rounds + a replayed `reasoning` item | completed | completed |
| all of the above, **streaming** | completed | completed |

Controls with no `reasoning.effort` sent no `thinking` key at all — the resolver is genuinely inert
without one.

Verified on the wire, not from status codes: every effort-carrying turn above went out with
`params.thinking = {"type":"adaptive"}` and `params.output_config.effort = "medium"`, and the raw
responses carried `reasoning_content` on the multi-turn histories. So thinking was enabled, the model
did think, and the thinking-less assistant history was accepted anyway.

One row deserves reading correctly: the two-item `user,assistant,tool` continuation came back with no
`reasoning_content` on either model. That is adaptive declining to think on an easy continuation — the
documented behaviour above — not a failure of the tool path. Its siblings with longer histories did
produce reasoning.

**Streaming works too**, which nothing had established: all measurements before this were
non-streaming, while 173 of 173 effort-carrying requests are `stream: true`.

## Streamed `reasoning_content` — the shape Task 5 needs

Captured incidentally above, from `sap_response_streaming` chunks:

```json
"delta": { "role": "assistant", "content": "",
           "reasoning_content": [{ "content": " user is asking which", "signature": "" }] }
```

The reasoning text arrives INCREMENTALLY across many deltas, each with an **empty** `signature`, and
then exactly one terminal delta carries the complete signature (408–564 chars across three captures).
Reassembled, the text matches the non-streaming block.

Two consequences for the output half:

- A streaming translator must accumulate `reasoning_content[].content` across deltas rather than
  treating any single one as the block — and must not mistake the empty `signature` on the text
  deltas for "unsigned".
- The signature is available on the streaming path, so a `reasoning` item emitted from a stream can
  carry it. Whether SAP accepts one replayed back is still UNTESTED — that remains Task 6.

`streamTranslator.ts` reads only `delta.content` and `delta.tool_calls`, so it ignores all of this
today: turning thinking on cannot malform frames, it simply discards the reasoning.

## The budget shape with NO `max_output_tokens` — SAP's default ceiling is 64000

The resolver originally refused the budget shape whenever `max_output_tokens` was absent, reasoning
that there was no ceiling to clamp `budget_tokens` against and Anthropic requires
`max_tokens > budget_tokens`. Safe, but it made the branch **dead for the only traffic that uses the
feature**: all 173 requests carrying `reasoning.effort` send no `max_output_tokens`, so all three
budget-shape models — 4.5-opus, 4.5-sonnet, 4.5-haiku — emitted nothing.

Measured with no `max_output_tokens` sent, on all three:

| `budget_tokens` | 4.5-sonnet | 4.5-opus | 4.5-haiku |
|---|---|---|---|
| 1024 / 2048 / 8192 / 16384 / 32768 | completed | completed | completed |
| 65536 | **400** | **400** | **400** |

```
`max_tokens` must be greater than `thinking.budget_tokens`.
```

None truncated at any working budget. A binary search on the failing edge puts SAP's default at
**64000** — highest passing 63488, lowest failing 64512, identical on 4.5-sonnet and 4.5-haiku.

So the mapped budget now goes out **unclamped** when `max_output_tokens` is absent. The largest of
them (32768 for `xhigh`) is barely half the default ceiling, and the halving clamp exists to protect
an answer allowance the *client* chose — when there is none, there is nothing to protect. The clamp
still applies whenever the client does send `max_output_tokens`.

Verified on the wire after the change: all three models now send
`{"type":"enabled","budget_tokens":8192}` for `effort: "medium"` with no `max_output_tokens`, where
they previously sent nothing.

## Declines are logged with their reason

An empty result was previously indistinguishable from the resolver never running — the stage-02
capture looks identical either way. `explainReasoningEffort` shares its guards with the resolver by
construction (both are thin wrappers over one `decide`), so a reason cannot drift from the decision
it explains. Verified live, one request per path:

```
INFO [responsesController] reasoning.effort=medium requested but NO thinking sent for gpt-5.5 [reason=model-not-supported]
INFO [responsesController] reasoning.effort=medium requested but NO thinking sent for anthropic--claude-4.7-opus [reason=model-not-supported]
INFO [responsesController] reasoning.effort=medium requested but NO thinking sent for anthropic--claude-4.5-sonnet [reason=incompatible-sampling]
INFO [responsesController] reasoning.effort=medium requested but NO thinking sent for anthropic--claude-4.5-sonnet [reason=forced-tool-choice]
INFO [responsesController] reasoning.effort=medium requested but NO thinking sent for anthropic--claude-4.8-opus [reason=max-tokens-too-small]
DEBUG [responsesController] reasoning.effort=medium -> budget thinking for anthropic--claude-4.5-sonnet
```

Declines log at `info` because "I set an effort and nothing happened" is the case someone will be
trying to explain; emissions log at `debug`. A request with no `reasoning.effort` logs nothing at all.

## The `reasoning` output item — what shape, and why not the deployed one

The deployed route's reasoning item, captured verbatim from its own SSE:

```json
{"type":"response.output_item.added","output_index":0,
 "item":{"id":"rs_…","type":"reasoning","content":[],"encrypted_content":"gAAAAA…(908)","summary":[]}}
```

Across 40 deployed stream captures: `content` and `summary` are **always empty**, every reasoning
token lives inside the opaque `encrypted_content` blob (908–1272 chars, and it grows between the
`added` and `done` frames), and there are **zero** `response.reasoning_summary*` frames of any kind.
Codex replays those items back — 635 of them in the corpus, always
`['encrypted_content','id','summary','type']`.

That blob is OpenAI's own envelope format and cannot be manufactured, so copying the deployed shape
byte for byte would mean emitting an item that carries **nothing**. Orchestration, meanwhile, hands us
what the deployed route never exposes: the reasoning in plaintext.

So the shape is:

```json
{"type":"reasoning","id":"rs_…","summary":[{"type":"summary_text","text":"Let me work through this…"}],"content":[]}
```

The Anthropic `signature` is **not** carried. It is a replay-validation token, a different thing from
OpenAI's opaque blob; putting it in `encrypted_content` would misrepresent the field, and a client
replaying it would hand us back something we drop on input anyway.

### Verified live, both shapes, streaming and not

`anthropic--claude-4.6-opus` (adaptive) and `anthropic--claude-4.5-sonnet` (budget), `effort: medium`:

```
items=['reasoning', 'message']          content=[]   encrypted_content_present=False
summary[0].text: 284–402 chars of real plaintext reasoning
frame order: reasoning added(0), reasoning done(0), message added(1), message done(1)
```

That frame order is itself a fix. The first implementation held the reasoning item open until the
turn ended, producing `added(0), added(1), done(0), done(1)` — an interleaving no real server emits,
and one that every unit assertion passed happily under. The deployed capture settles it: reasoning
closes before the message opens. Thinking always precedes the answer, so the first text delta is the
moment reasoning is known to be over.

Two consequences worth keeping:

- The message is no longer always `output_index: 0`. When the model thinks it moves to 1, and every
  later frame for that message (`content_part`, `output_text.delta`, `done`) must agree — they are
  driven off one variable for that reason.
- A reasoning item that opened must always close, even if its text trims to empty: `added` has
  already committed index 0 and shifted the message to 1, so dropping it would leave the client with
  an item that never closed and a hole at index 0. An empty `summary` is the honest close.

## Task 7 — real codex against a thinking model

codex-cli 0.147.0, `CODEX_HOME` scratch config, `--model anthropic--claude-4.6-opus`, against the
running gateway. A catalogue entry was added for the model so codex sends `reasoning.effort` rather
than falling back to default metadata.

**The pipeline works, end to end.** Two turns, one of them a tool loop:

- codex sent `reasoning: {effort: "medium"}` and `include: ["reasoning.encrypted_content"]`
- the gateway sent `thinking: {"type":"adaptive"}` + `output_config.effort: "medium"` upstream
- SAP streamed 200 `reasoning_content` deltas
- codex read a file through `shell`, got the result back, and answered — the tool round trip is
  unaffected by thinking being on
- token accounting is intact: `total=10,927 input=9,186 (+8,863 cached) output=1,741`

**Codex ingests our reasoning item.** Proof, not inference — on the turn after the tool call it
REPLAYED the item back to us, carrying our own text:

```
replayed reasoning item keys=['encrypted_content', 'id', 'summary', 'type']
summary=[{"type":"summary_text","text":"The user wants me to read `ledger.py` and analyze a bug in
          its running-balance logic when a refund is the very first entry."}]
```

(It adds an `encrypted_content` key of its own; we never emit one. The bridge drops replayed
`reasoning` items on input, which is measured safe — see the multi-turn section above.)

### But codex does NOT display it, and the reason is now known

No thinking section appears in the TUI, with `model_reasoning_summary = "auto"` and
`hide_agent_reasoning = false` set and codex demonstrably requesting summaries
(`reasoning: {"effort":"medium","summary":"auto"}` on the wire).

The cause is not the item shape — it is the FRAMES. The codex binary carries these event variants:

```
reasoning_summary_delta   reasoning_summary_done   reasoning_summary_part_added   reasoning_content_delta
```

i.e. it renders reasoning from the incremental Responses frames
(`response.reasoning_summary_part.added`, `response.reasoning_summary_text.delta` / `.done`), not
from the completed item. Our stream translator emits only `response.output_item.added` and
`response.output_item.done` for the reasoning item, so codex has the content but nothing to render
as it arrives.

This was established from the client binary rather than by capturing a real OpenAI session; no
mitmproxy run was needed. Our own deployed-route captures could not have answered it — every
reasoning item there has an EMPTY summary, because that path returns only the opaque blob.

### The summary delta frames were then implemented — and codex still does not draw them

The stream now emits the full documented sequence, verified on the wire:

```
response.output_item.added            (reasoning item, output_index 0)
response.reasoning_summary_part.added (summary_index 0, part {type:summary_text, text:""})
response.reasoning_summary_text.delta ×76
response.reasoning_summary_text.done  (full text)
response.reasoning_summary_part.done
response.output_item.done             (reasoning item)
response.output_item.added            (message, output_index 1) …
```

**codex 0.147.0 renders none of it**, sampled every 2s throughout a turn as well as after — the TUI
shows only `Working (Ns)`. Three things were tried and ruled out:

1. the item shape — codex demonstrably ingests it and replays our own `summary_text` back;
2. the missing frames — now emitted, correct types and fields, confirmed on the wire;
3. client config — `model_reasoning_summary = "auto"`, `hide_agent_reasoning = false`, and
   `default_reasoning_summary: "auto"` in the model catalogue entry.

The likeliest explanation, from the binary itself: **this build has no surface for displaying
reasoning**. It carries the parse-side event variants (`reasoning_summary_delta`,
`reasoning_summary_done`, `reasoning_summary_part_added`) but no display label — no "Thinking" or
"Thought" string exists anywhere in it, while the reasoning strings that DO exist are all about
choosing an effort level ("Select Reasoning Level for", "More reasoning", "Advanced Reasoning").
Every model in its shipped catalogue declares `default_reasoning_summary: "none"`, and our own 40
deployed-route captures — real OpenAI, through SAP — contain `summary: []` and zero
`reasoning_summary` frames. So no positive control exists locally: nothing here has ever made codex
display reasoning.

### Positive control: codex does not display reasoning against REAL OpenAI either

The one gap above — "no positive control exists locally" — has since been closed. codex 0.147.0 was
driven against **`api.openai.com` directly**, `gpt-5.5`, through a proxy, with a real API key:

```
› A snail climbs a 12 metre wall … On which day does it reach the top. Reason carefully.
• The snail reaches the top on day 10.
  Reasoning:
  - Each full day-night cycle gains 3 - 2 = 1 metre.
  …
```

That `Reasoning:` is INSIDE the answer bullet — the model writing a heading in its own prose, not a
TUI section. There is no thinking display against real OpenAI either, sampled repeatedly during the
turn. Incidentally confirmed on the wire: codex talks to `api.openai.com/v1/responses` over a
**WebSocket** (HTTP 101 upgrade), not the SSE transport it uses against a custom `base_url`.

So this is settled: **codex 0.147.0 has no reasoning-display surface for any backend.** Our frames
were never the problem, and nothing about the item shape or the gateway needs to change.

**The frames are kept.** They match the documented Responses API, cost one frame per delta on a
stream already carrying one per token, and the reasoning is genuinely delivered — any client that
does render summaries, including a later codex, will show it.

## What reasoning costs — measured, not estimated

The requirement the plan would not land without. Same prompt throughout, 3 runs per cell, medians,
through the shipped path.

| model | shape | out ON | out OFF | delta | answer chars ON | answer chars OFF |
|---|---|---|---|---|---|---|
| 4.5-sonnet | budget | **894** | 392 | **+128%** | 1189 | 1214 |
| 4.6-opus | adaptive | **789** | 484 | **+63%** | 1226 | 1509 |
| 4.8-opus | adaptive | **686** | 693 | **−1%** | 1599 | 1666 |

Three things worth reading off this:

- **The budget shape roughly doubles output tokens.** That is the real price, and it is paid in
  `completion_tokens`, which is where thinking bills.
- **4.8-opus is nearly free** — because adaptive genuinely declined to think on this prompt
  (102 reasoning chars against 4.6's 848). Adaptive spends only where it judges it worthwhile, so
  its cost is workload-dependent in a way the budget shape's is not.
- **The visible answer gets SHORTER when reasoning is on**, on every model (1509→1226 on 4.6-opus).
  So the extra tokens are not extra answer — callers pay more and read less.

Input tokens are unchanged on the adaptive models and rise by ~30 on the budget shape
(118 → 148 on 4.5-sonnet), consistently across runs.

## Does `budget_tokens` actually buy reasoning? Weakly, and it saturates

4.5-sonnet, budget shape, same prompt, 3 runs per effort, median reasoning characters returned:

| effort | budget_tokens | reasoning chars |
|---|---|---|
| minimal | 1,024 | 1,261 |
| low | 4,096 | 1,438 |
| medium | 8,192 | 1,630 |
| high | 16,384 | 1,631 |
| xhigh | 32,768 | 1,679 |

Monotonic, so the mapping is **not** inert the way `effort` is on the adaptive shape — but the whole
range buys **+33% reasoning for a 32× budget increase**, and it is flat from `medium` upward.

The reason is visible in the numbers: 1,261 characters is roughly 315 tokens, so **even `minimal`'s
1,024-token cap is never binding**. The model picks its own depth; the budget only weakly nudges it
and mostly sits far above what gets used. The five rows are therefore defensible but the spread is
largely decorative — do not present the table to callers as a depth dial.

For contrast, the adaptive shape on 4.6-opus over the same sweep: 846 / 979 / 977 chars for
minimal / medium / xhigh — flat after the first step, matching the earlier finding that `effort`
there is a valid enum rather than a measured dial.

## `tool_choice: 'required'` — the uniform rule, now on six models not two

The resolver suppresses thinking on `'required'` for every model, a deliberately broad rule adopted
from two measurements. The remaining four were then probed:

| model | shape | control (no thinking) | + thinking |
|---|---|---|---|
| 4.5-opus | budget | PASS | **400** |
| 4.5-haiku | budget | PASS | **400** |
| 4.6-sonnet | adaptive | PASS | **400** |
| 4.5-sonnet | budget | PASS | **400** |
| 4.6-opus | adaptive | PASS | **400** |
| 4.8-opus | adaptive | PASS | **PASS** |

```
Thinking may not be enabled when tool_choice forces tool use.
```

**Five of six 400; 4.8-opus is the lone exception.** The uniform rule is the right call — it costs
one model its thinking on forced-tool turns and protects the other five. A per-model carve-out for
4.8 would buy little and is now measured to be the minority case, not the pattern.

## Method note

The `thinking` parameter cannot be probed through the chat path — `openaiController` forwards only
`max_tokens` to orchestration (verified: `model params sent: ['max_tokens']`). The bridge forwards
only `max_tokens`, `temperature`, `top_p`, `tool_choice`. A temporary passthrough was therefore
required, and was reverted before any commit; `git status` confirmed clean and the gateway
re-verified serving normally afterwards.
