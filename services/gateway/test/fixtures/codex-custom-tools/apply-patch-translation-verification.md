# apply_patch custom→function translation — live verification

Task 9 of `docs/superpowers/plans/2026-08-11-custom-tool-translation.md`, run 2026-08-11 against the
running gateway with codex CLI 0.147.0. Every number below is measured, not estimated.

## What was broken before

Both routes rejected `tools[].type: "custom"` outright, so a codex turn with apply_patch enabled —
the default for every current model — died before the model ran:

| | `custom` tool declaration | replayed `custom_tool_call` history |
|---|---|---|
| deployed (`gpt-5.3-codex`) | `The following tool is not allowed for model 'gpt-5.3-codex': custom.` | accepted natively, `status=completed` |
| orchestration (`anthropic--claude-4.8-opus`) | `400 - Request Body: 'custom' is not one of ['function'] - 'config.modules.prompt_templating.prompt.tools[4].type'` | `Unsupported Responses input item type: custom_tool_call` |

The trailing JSON pointer names the offending entry's INDEX and varies with where the custom tool
sits in the client's tools array; `tools[4]` was specific to that capture.

## Result

Both routes now complete real apply_patch work through codex.

**Orchestration (`gpt-5.5`).** Codex sent 11 tools; 15 all-`function` tools reached orchestration:

```
client  -> {'function': 8, 'custom': 1, 'namespace': 1, 'web_search': 1}
upstream-> {'function': 15}
```

`custom` → 1 function, `namespace` → 5 flat functions, `web_search` → 1 function, 8 already
functions. Codex applied the patch and `patchme.py` on disk gained its docstring.

**Deployed (`gpt-5.3-codex`).** Two consecutive apply_patch turns in one session; `deployed.py`
carries both edits (`def multiply(a: float, b: float):` plus the docstring). The second turn is the
one that matters — it is the replay path.

**Replay.** Later turns carry the converted history and are accepted:

```
turn: {'function_call': 2, 'function_call_output': 2, 'custom_tool_call': 1, 'custom_tool_call_output': 1}
```

On orchestration this was a hard 400 before this work.

## The open question from the plan, answered

The plan and the interceptor header flagged as UNPROVEN whether codex would accept a single
resynthesised `custom_tool_call_input.delta` instead of a token-by-token stream. The live run
answers something stronger: **on the orchestration route codex receives no `custom_tool_call_input.*`
frames at all** — the bridge's `streamTranslator` emits `output_item.added` then `output_item.done`
with complete `arguments` and never emits `function_call_arguments.*` — and codex dispatched the call
anyway. It routes from the finished item, not from the input frames. The pre-declared chunking
fallback was not needed and was not used.

## Two defects only this test could find

Both were invisible to 2233 passing unit tests.

**1. Models double-wrap the payload, intermittently.** `anthropic--claude-4.8-opus` sometimes put a
complete JSON envelope inside the `input` string:

```
arguments = {"input": "{\"input\": \"*** Begin Patch\\n*** Add File: hi.txt\\n+hello\\n*** End Patch\"}"}
```

The client then received `{"input": "..."}` where the raw patch belonged, and the patch would not
apply. Incidence: `gpt-5.5` ok, `anthropic--claude-4.6-sonnet` ok, `gpt-5.3-codex` ok,
`anthropic--claude-4.8-opus` **2 of 4 runs wrong**. Fixed by a bounded, conservative unwrap in
`extractFreeformInput` (unwrap only an object with exactly one key named `input` holding a string,
capped at 2 extra levels) plus a description that can no longer be read as "encode the payload as
JSON". After the fix: **6 of 6 runs clean** on the model that had failed.

**2. The feature worked exactly once per conversation on the deployed route.** The first turn applied
its patch; the next turn died:

```
{"error":{"code":"invalid_value","message":"Invalid 'input[8].id': 'ctco_019ff2c9-c862-77f1-8ccd-21401a4e93fa'. Expected an ID that begins with 'fc'.","param":"input[8].id","type":"invalid_request_error"}}
```

Codex's item ids carry type-specific prefixes (`ctc_` for a call, `ctco_` for its output). The
translator preserved `id` verbatim while rewriting `type`, so upstream validated the prefix against
the new type and refused. Fixed by dropping `id` on both conversions — `call_id` carries the pairing,
the item `id` is optional on an input item, and minting a synthetic `fc_` id would fabricate an
identifier the client never issued.

## Masking survives the round trip

A patch carrying `dana.reyes@example.com` was driven through the deployed route. Occurrences per
capture stage:

| stage | real address | `MASKED_EMAIL` |
|---|---|---|
| `00_original_responses_request` (client → gateway) | 1, then 2 | 0 |
| `02_responses_request_to_deployment` (gateway → provider) | **0** | 1, then 2 |

The address never reached the provider. The count rising 1 → 2 on the replay turn is the load-bearing
detail: the replayed `custom_tool_call.input` was masked too, which is the coverage Task 4 added to
`extractResponsesInputTexts` — before it, a patch body went upstream in the clear. Codex's TUI
displayed the real address and the file on disk kept it.

## Not covered here

- ~~`tool_search` remains untranslated and suppressed client-side via `model_catalog_json`. Both
  routes reject it equally, so they stay at parity with each other, below codex's full tool
  surface.~~ **Superseded.** `tool_search` was translated later the same day; see
  [`tool-search-capture.md`](./tool-search-capture.md). Left struck through rather than deleted
  because this file is a point-in-time record of what the apply_patch run verified.
- The lark grammar is a soft constraint in the description, not grammar-constrained decoding. A
  malformed patch is still possible; codex's parser rejects it and the model retries.
- `strip` mode was not exercised live.
