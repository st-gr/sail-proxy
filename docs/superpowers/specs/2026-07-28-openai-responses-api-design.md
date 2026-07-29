# OpenAI Responses API route (`/openai/v1/responses`) — Design

**Status:** approved design, ready for implementation planning
**Scope:** Phase 1 — native passthrough for deployed GPT-5+ models. Orchestration emulation is a separate, later spec.

## Context

Codex CLI speaks the OpenAI **Responses** API (`POST /v1/responses`), not Chat Completions. The gateway exposes no such route today, so Codex cannot use it at all. We add `/openai/v1/responses` and forward to the model's SAP AI Core deployment, which already serves the Responses API natively.

### Verified against the live deployment (`gpt-5.4--deployed`)

Probed directly rather than assumed:

| Property | Finding |
|---|---|
| Endpoint | `{deploymentUrl}/responses` returns **200** (`/v1/responses` also works; we use `/responses`) |
| Response shape | Full Responses object: `output`, `usage`, `status`, `reasoning`, `store`, `instructions`, `tools`, `previous_response_id`, `content_filters` |
| `store: false` | Accepted — Codex sends this, so **no server-side state is needed** |
| `instructions` | Accepted |
| `reasoning: {effort, summary}` | Accepted |
| Responses-shaped flat `tools` | Accepted — returned a real `function_call` output item |
| `include: ["reasoning.encrypted_content"]` | Accepted |
| Streaming | `content-type: text/event-stream`; frames are bare `data: {json}` with the type **inside** the JSON (`"type":"response.created"`). **No `event:` lines, no `[DONE]` sentinel.** |
| Usage shape | `usage.input_tokens` / `usage.output_tokens` (not `prompt_tokens`/`completion_tokens`) |

### Validated against the Codex-tuned model (`gpt-5.3-codex--deployed`)

`gpt-5.3-codex` has since been deployed (SAP deployment `RUNNING`; the gateway surfaces `gpt-5.3-codex--deployed` after a model-cache refresh, since deployments are filtered to `RUNNING`). It behaves **identically** to `gpt-5.4--deployed` on every probe above — same acceptance of `store:false`/`instructions`/`reasoning`/flat `tools`/`include`, same `usage` shape (`input_tokens`, `output_tokens`, `total_tokens`), same streaming framing (no `event:` lines, no `[DONE]`). The built-in family heuristic accepts `gpt-5.3-codex` and still rejects `gpt-35-turbo`.

**Observed streaming event inventory** (this is the authoritative list for the unmask interceptor):

| Stream | Event types, in order |
|---|---|
| Text | `response.created`, `response.in_progress`, `response.output_item.added`, `response.content_part.added`, `response.output_text.delta`, `response.output_text.done`, `response.content_part.done`, `response.output_item.done`, `response.completed` |
| Tool call | `response.created`, `response.in_progress`, `response.output_item.added`, `response.function_call_arguments.delta`, `response.function_call_arguments.done`, `response.output_item.done`, `response.completed` |

Both delta events carry their payload in a `delta` string field. Tool-argument deltas arrive as JSON fragments (observed first fragment: `{\"`), i.e. a placeholder can be split mid-token across frames — exactly the case `StreamUnmaskBuffer` exists to handle.

### Key decisions

1. **Dedicated route + focused controller**, not an extension of `openaiController` (~1450 lines, already juggling orchestration + deployed + streaming emulation; this session found three stacked defects hiding in it).
2. **PII masking must work on this route.** Pseudonymization is force-enabled for the `openai` endpoint with `allow_user_bypass: false`, but the plugin only reads `messages`/`system`. A plain passthrough would silently bypass a security control the operator has explicitly locked.
3. **Passthrough first, emulation later.** Native passthrough preserves reasoning items, encrypted content, content filters, and exact SSE framing for free, and validates the route/auth/masking plumbing against a real Responses endpoint before any translation is written.

## Architecture

| Component | Path | Purpose |
|---|---|---|
| Route | `services/gateway/src/routes/responsesRoutes.ts` (new) | Mount at `/openai/v1/responses` + `/openai/api/v1/responses`, behind the existing auth → service-auth → rate-limit → rateLimiter chain (mirrors `embeddingRoutes.ts`) |
| Controller | `services/gateway/src/controllers/responsesController.ts` (new) | `handleResponses`: resolve target, forward, pass through (JSON or SSE) |
| Shared helper | `services/gateway/src/utils/deployedTarget.ts` (new) | Extracts deployment resolution currently inline in `openaiController`'s deployed branch: model lookup, provider check, path append, upstream model-name substitution. Both controllers use it so this session's fixes live in one place |
| Masking adapter | extend `services/gateway/src/plugins/pseudonymization/` | One place that reads/writes maskable text from either chat-shape or Responses-shape, plus Responses SSE delta types |

**Eligibility.** Resolved in this order:

1. `supports_responses_api` on the model (`model_list_changes.<model>`) — if present, it decides: `true` = eligible, `false` = ineligible.
2. Otherwise the same flag on the provider block, if present.
3. Otherwise the built-in heuristic: `--deployed` **and** provider `openai` **and** GPT-5+/o-series family.

This is the *pattern-default + config-override* shape already shipped for `param_renames`, so a newly deployed GPT-5+ model works with no config while an exception stays fixable without a code change. The family regex is shared with `defaultParamRenames`, including its `gpt-35-turbo` guard (Azure's GPT-3.5, which must not match). Perplexity and Anthropic deployments are excluded — their deployments do not expose `/responses`.

**Untouched:** `openaiController`'s orchestration path, the Anthropic route, `webSearchPlugin`.

## Data flow

1. Auth/rate-limit middleware; assign `debugRequestId`; payload-log `00_original_responses_request`.
2. Resolve the deployed target. Ineligible → fail fast (see Errors).
3. **Run before-plugins, then build the outbound payload — in that order.** `openaiController` builds its payload *before* plugins run and never rebuilds it, so a plugin cannot affect its outbound body. We do not inherit that bug.
4. Outbound body = `{...req.body}` with `model` swapped to the upstream name (`gpt-5.4`, not `gpt-5.4--deployed` — the deployment rejects our alias). `unsupported_params` / `param_renames` still apply so config keeps working; Responses natively uses `max_output_tokens`, so no rename is needed on the happy path.
5. POST `{deploymentUrl}/responses` with the SAP bearer token + `AI-Resource-Group`; payload-log `02_responses_request_to_deployment`; timeout from `configService.getTimeout(isStreaming)`.
6. **Non-streaming:** after-plugins unmask `output`, then pass the JSON through unchanged. Usage: map `input_tokens`/`output_tokens` → `updateTokenCounts`, emit usage event.
7. **Streaming:** set SSE headers, pipe bytes through; usage from the final `response.completed` frame.

### Masking adapter

**Request side.** `instructions` (string) and `input` — either a plain string or an item array: `message` items with `content:[{type:'input_text',text}]`, plus `function_call.arguments` and `function_call_output.output`. The adapter walks these exactly as the current code walks `messages`/`system`. `propagateMaskedValues` extends to the same nodes so one secret still maps to one token everywhere. The "treat tokens as opaque" copy-note appends to `instructions` rather than `system`.

**Response side.** Unmask `output` items: `message.content[].output_text`, `function_call.arguments`, `reasoning.summary`.

**Streaming unmask.** The existing `res.write` interceptor already re-frames on `\n\n` and handles bare `data: {json}` frames — exactly what these deployments emit. It needs the two observed delta types added, each buffered through `StreamUnmaskBuffer` (both put their payload in a `delta` string field):

- `response.output_text.delta` — assistant text
- `response.function_call_arguments.delta` — tool arguments, arriving as JSON fragments that can split a placeholder mid-token

Flush points: `response.output_text.done` / `response.function_call_arguments.done`, with `response.output_item.done` and `response.completed` as backstops. The safety-net unmask still catches whole tokens in any frame shape.

**Config addition.** Plugin hooks resolve by subpath, so the route needs its own (`responses` / `responses-stream`) with `pseudonymizationPlugin` wired under `defaultHooks.openai` — otherwise masking silently does not run. Applies to all three synced `api_config.json` copies via `cli-tools/sync-api-config.js`.

## Error handling

- **Ineligible model** → 400, OpenAI error shape (`type: invalid_request_error`, `code: model_not_supported`), message naming what *is* supported (e.g. "requires a deployed GPT-5+ model such as `gpt-5.4--deployed`"). Codex surfaces this text, so it must be actionable — not a bare 404 like the deployed-model bug produced.
- **Upstream failure, non-streaming** → pass status and body through; log `error.response.data` in the logger's **4th (metadata)** parameter, never the 3rd (that slot is `Error`-typed and silently drops plain objects — this is what hid SAP error bodies previously); persist `97_responses_error_from_deployment`.
- **Upstream failure mid-stream** → headers already sent: emit a `response.failed` SSE frame and end, **flushing pseudonymization buffers on that path** so retained fragments are not stranded (the mask-leak class fixed earlier).
- **Client disconnect** → destroy the upstream stream, as the native streaming handler does.
- Residue-audit counter reused so any leak on this route is visible.

## Testing

**Pure units:** body adapter (string `input`, item arrays, `function_call`/`function_call_output`, `instructions`); eligibility resolution (family default, config override, Perplexity/Anthropic excluded); usage mapping.

**Payload construction:** outbound body carries the upstream model name, masked `input`, copy-note in `instructions`.

**Masking:** round-trip through the existing plugin harness; SSE unmask through the interceptor harness that caught the URL leak, with a placeholder split across `response.output_text.delta` frames.

**Error paths:** ineligible model; upstream 4xx passthrough shape.

**Acceptance gate — live, not unit tests.** `gpt-5.3-codex--deployed` is already deployed and validated (see Context). Run curl probes through the gateway route (non-streaming, streaming, tools, reasoning); then point **Codex CLI itself** at the gateway and complete a real task, checking payload logs to confirm secrets go out masked and come back unmasked. No unit test can prove Codex compatibility — only running Codex can.

## Out of scope (later)

Orchestration emulation for non-deployed models (own spec), stateful `previous_response_id` / `store: true`, background mode, built-in tools (`web_search`, `file_search`), and an `/openrouter/api/v1/responses` mount.
