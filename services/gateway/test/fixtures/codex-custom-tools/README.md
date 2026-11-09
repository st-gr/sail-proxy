# Codex custom-tool capture — what the newest model actually sends

`gpt-5.6-sol-custom-tool-capture.json` holds shapes taken **verbatim from real traffic**:
codex CLI 0.147.0 talking to `chatgpt.com/backend-api/codex/responses`, intercepted with
mitmproxy, driven by one turn that asked it to add a docstring to a file. Nothing here is
synthesised, and no field name in it was guessed — the same rule the `orchestration/` fixtures
follow.

The turn succeeded: the file was edited. 568 WebSocket frames, 7 `response.create` from the
client, the rest server events.

## The finding that matters

**The newest model does not use `apply_patch` as a tool at all. It uses code mode.**

Codex offers `gpt-5.6-sol` two `namespace` tools — `functions` and `collaboration` — and inside
`functions` there is exactly one `custom` tool, named **`exec`**, described as:

> "Run JavaScript code to orchestrate/compose tool calls. Evaluates the provided JavaScript code
> in a fresh V8 isolate as an async module. All nested tools are available on the global `tools`
> object, for example `await tools.exec_command(...)`."

The model then emits JavaScript as the tool input:

```js
const r = await tools.exec_command({"cmd":"sed -n '1,160p' greet.py", "workdir":"…"})
```

and for the edit itself:

```js
const patch = "*** Begin Patch\n*** Update File: greet.py\n@@\n def greet(name):\n+    \"\"\"…\"\"\"\n…"
```

So the patch grammar still exists, but it travels **inside a JavaScript string**, passed to a
nested tool, rather than as a top-level `custom apply_patch` tool with a Lark grammar. That older
shape is what codex 0.146.1 sends to our gateway (captured separately in `logs/payloads`), which
means **the tool protocol differs by codex/model generation** — a gateway translation built only
against the 0.146 shape would not serve 0.147+.

## The transport differs too

0.147.0 talks **WebSocket** (`GET /backend-api/codex/responses` → HTTP 101), not HTTP+SSE. The
item types are Responses-API items either way, but a gateway that only speaks SSE is not
interchangeable with what this client expects from its own backend.

## Shapes captured (all in the JSON)

| Key | What it is |
|---|---|
| `client_tool_declaration` | the `additional_tools` input item: two `namespace` tools, `exec` nested inside `functions` |
| `response_create_keys` | every top-level key of the client's `response.create` frame |
| `server_output_item_added` | `custom_tool_call` item at `status: "in_progress"` — note `id` prefix `ctc_`, plus `call_id`, `name`, `metadata` |
| `server_output_item_done` | the same item `completed`, with the full `input` string |
| `server_input_delta` | `response.custom_tool_call_input.delta` — `delta`, `item_id`, `output_index`, `sequence_number`, `obfuscation` |
| `server_input_done` | `response.custom_tool_call_input.done` — the assembled `input` |
| `client_custom_tool_call_output` | what the client sends back: `id` prefixed `ctco_`, matching `call_id`, and **`output` as an ARRAY of `{type: "input_text", text}` parts** — not a plain string |
| `server_frame_type_counts` | every server frame type and its count in the turn |

The `output`-is-an-array detail is the one most likely to be got wrong from intuition: a
`function_call_output` carries a string, but a `custom_tool_call_output` carries content parts.

## Why this was captured against real OpenAI

Every model on this gateway rejects the `custom` and `tool_search` tool types (see
`../codex-reasoning/effort-evidence.md` for the per-model probe), so a successful custom-tool
round-trip cannot occur here and its return-path shapes cannot be learned from our own traffic.
Real OpenAI traffic is the only place they exist.

## Also confirmed

Codex fetches its model catalogue from `chatgpt.com/backend-api/codex/models?client_version=…`,
**not** from the configured provider's `/models`. The response carries the same eight slugs as
the local cache, and `gpt-5.3-codex` is not among them — so a gateway-served model can never be
made known to codex by anything the gateway serves. A local `model_catalog_json` is the only
mechanism.
