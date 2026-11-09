# compaction / compaction_trigger — orchestration bridge parity

Verification for the bridge change that drops `compaction` and `compaction_trigger`
instead of throwing (`requestTranslator.ts`, `DROPPED_ITEM_TYPES`). Run 2026-08-11.

## What was measured

**Before the change**, same body to both routes — a `message`, a `compaction_trigger`,
and a replayed `compaction`:

| Route | Result |
|---|---|
| deployed `gpt-5.3-codex` | **200**; `compaction_trigger` alone also returned a `compaction` output item |
| orchestration `anthropic--claude-4.8-opus` | **400** `Unsupported Responses input item type: compaction_trigger`, and `…: compaction` |

**After the change**, same probe:

| Route | Result |
|---|---|
| orchestration `anthropic--claude-4.8-opus` | `status=completed`, answered `ok` |
| orchestration `gpt-5.5` | `status=completed`, answered `ok` |

Unit coverage is in `test/orchestration-request-translator.test.ts`, using the field sets
captured in `responses-api-compliance-capture.json` verbatim — `{"type":"compaction_trigger"}`
is the entire item, and `compaction` carries `id` (`cmp_` prefix), `encrypted_content`, and
`internal_chat_message_metadata_passthrough.turn_id`. The three behavioural tests were
confirmed to fail against the pre-change code by temporarily restoring
`if (type === 'reasoning') continue;` — 3 failed, 20 passed. A fourth test pins that an
unknown type (`compaction_call`, `tool_search_call`) still throws, so the drop list cannot
quietly become a swallow-everything.

Full gate after the change: **184 suites, 2245 tests, 0 failures**.

## What was NOT proven, and this matters

**Codex against this gateway never sends these items**, so the end-to-end path is
unexercised by a real client.

A full live session was driven on `gpt-5.5` through the orchestration route: two turns,
`/compact`, then two further turns. Codex reported *"Context compacted"* and every
subsequent turn succeeded — but the payload captures show why that proves nothing about
this change:

```
post-/compact turns: compaction=0 compaction_trigger=0 msgs=5,7,6,8,8
```

Codex compacted **client-side** — it summarised locally and replayed ordinary `message`
items, growing the message count rather than sending a `compaction_trigger`. Across the
whole payload-log corpus, the only requests containing a compaction item are deliberate
`curl` probes. No `codex-tui` request has ever carried one.

The reason appears to be protocol scope: the capture that established these shapes
(`responses-api-compliance-capture.json`) was taken against
`chatgpt.com/backend-api/codex/responses`, ChatGPT's own backend, over WebSocket. Server-side
compaction looks to be a feature of that backend rather than of the `responses` wire API this
gateway serves. That is inference from where the shapes were observed, not a measurement of
codex's branching logic.

**So this change is defensive parity, not a fix for an actively-firing bug.** It closes a real
divergence — the deployed route accepts both types and the bridge rejected them — and it costs
nothing. But the claim that a `/compact` currently bricks an orchestration session is **not**
supported for codex against this gateway: codex does not use the server-side protocol here.
The claim does hold for any client that does send these items, which the ChatGPT-backend
capture proves exist in real traffic.

## Behaviour after the change

The items are dropped, not honoured. SAP orchestration has no compaction mechanism, so a
client that sends `compaction_trigger` on this route gets a normal completion and **no**
compacted context — the conversation simply continues at full length. No `compaction` output
item is produced. That degradation is deliberate and was the ruling: dropping costs the model
its compaction, whereas throwing cost the caller the rest of the session, since a `compaction`
item once in the client's history is replayed on every later turn.
