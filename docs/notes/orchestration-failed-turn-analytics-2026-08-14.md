# Failed turns and the usage analytics, measured 2026-08-14

Whether the analytics distinguish a failed turn from a successful one came up while
reviewing the orchestration stream-error fix. They do, and one path was not feeding them.
That path is fixed now; this note records what was measured, so the next person does not
re-derive it, and so the reasoning survives if the code moves again.

## The analytics do distinguish failures

`ApiKeyUsage.statusCode` is a persisted column
(`services/admin/src/db/schema/api-keys.cds:92`), and six queries in
`services/admin/src/srv/admin-service.ts` — lines 2167, 2186, 2204, 2397, 2428, 2459 —
compute error rate from it:

```sql
count(case when statusCode >= 400 then 1 end) as errorCount
```

It is populated in practice. The deployed table, at the time of writing, held 652 non-200
rows out of 191,044:

```
200 → 190,392   400 → 398   500 → 212   429 → 19   503 → 12   404 → 10   504 → 1
```

So the pipeline works end to end, and any path that records 200 for a failure is losing
information the rest of the system is equipped to use.

## Which path was losing it

Both orchestration failure modes were exercised against a running gateway rather than read
off the code, because the two differ in a way the source does not make obvious:

| path | HTTP returned | usage recorded as |
|---|---|---|
| orchestration, non-streaming | **400** | real status, via the catch at `responsesController.ts:856` |
| orchestration, streaming | 200 | was a hardcoded 200 — **fixed**, see below |
| native / deployed, streaming | 200 | real status, via the same catch |

Only the orchestration streaming branch was wrong. It now reads
`translator.failureStatus() ?? 200` (`responsesController.ts:610`), where `failureStatus()`
returns the upstream code for a failed turn, 502 when the upstream error carried no usable
numeric code, and null when the turn succeeded.

`emitUsageEvent(..., 200)` at `:631` looks like the same bug and is not: non-streaming
failures leave through the catch block and never reach it. Anyone auditing hardcoded-200
call sites by grep will find it and should leave it alone.

The HTTP 200 on a failed stream is not fixable and was never the target. SSE headers are
flushed before the failure is known — only the recorded status changed.

Tokens are deliberately kept on a failed turn: the turn burned them, SAP charges for them,
and the native path already accounted for them the same way. A failed turn therefore shows
up in both `errorCount` and cost.

## Two things that only showed up under review

Worth recording because neither is visible from the changed lines alone.

**Not every terminal-frame consumer reads `response.output`.** The plugins that renest or
restore output items key on `TERMINAL_RESPONSE_TYPES` and act on `frame.response.output`,
which is empty on a failure frame — so they are unaffected. `pseudonymization/index.ts:852`
is the exception: it flushes retained unmask buffers on `response.completed` *specifically*.
On a failed turn that flush never runs, so a retained trailing fragment is dropped. It is
truncation of an already-failed turn, not a leak — the `res.end` path (`index.ts:995-999`)
still tracks the remainder for the leak audit — and it was accepted rather than fixed.

**A late stream error could have inverted the fix.** `stream.on('error')` stays attached
after `streamChatCompletion` resolves, so an error arriving during
`awaitResponsesStreamIdle` would have set the failure *after* `finish()` had already emitted
`response.completed` — recording 502 for a turn that actually succeeded. The translator now
latches at `finish()` and ignores anything after it.

## Reproducing a mid-stream orchestration failure

A reliable trigger, at the time of writing: any `gpt-5.6` model plus `tool_choice`, which
SAP AI Core Orchestration rejects with

```
400 - LLM Module: openai does not support parameters: ['tool_choice'], for model=gpt-5.6-sol
```

while accepting it for gpt-5.4, gpt-5.5 and the Anthropic models on the same deployment.
That asymmetry is the subject of a support incident; if it is ever fixed, this reproduction
stops working and another mid-stream failure has to be induced instead.

Note the model must have **no direct deployment**, or the Responses route swaps it to its
`--deployed` sibling (`responsesController.ts:672` and the block that follows) and never
reaches the bridge. `gpt-5.6-luna` and `gpt-5.6-terra` had none; `gpt-5.6-sol` acquired one
on 2026-08-14 and stopped being usable for this.

Against a gateway running the fix, that request yields
`response.created → response.in_progress → response.failed`, the failure frame carrying the
upstream message and a zero-filled usage block, and the usage row records 400 rather than
200.

## Related

The stream-error propagation that surfaced all of this — a failed orchestration turn used
to end silently, and clients read the empty stream as an empty success — is
`projectStreamError` and the `response.failed` frame in
`services/gateway/src/responses/orchestrationBridge/streamTranslator.ts`. The design
document is at `docs/superpowers/specs/2026-08-14-orchestration-failed-turn-analytics-design.md`,
untracked by the policy in `docs/superpowers/README.md`.
