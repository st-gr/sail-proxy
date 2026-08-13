# Responses Custom Tools Plugin

## Overview

The `responsesCustomToolsPlugin` makes the two Codex CLI tool types that neither SAP route
accepts work on the `/openai/v1/responses` route:

- **`custom`** — Codex's freeform `apply_patch`. Rewritten into an ordinary `function` tool on
  the way out, with the `custom_tool_call` / `custom_tool_call_output` shapes restored on the way
  back, which Codex REQUIRES to dispatch the call.
- **`tool_search`** — Codex's deferred-tool discovery. Rewritten the same way, with
  `tool_search_call` / `tool_search_output` restored. See
  [`toolSearch/adapter.ts`](./toolSearch/adapter.ts) and the
  [`tool_search` section](#tool_search) below, which also covers the discovered-tool hoist.

The two translations are independent: a turn may carry either, both, or neither, and each has its
own mode knob. They share this plugin's handlers and its streaming interceptor rather than
spawning a third copy of the same skeleton.

It is the third tool-shape translation on this route, after `responsesNamespaceToolsPlugin`
(flattens Codex's `namespace` sub-agent wrapper) and `responsesWebSearchPlugin` (rewrites the
hosted `web_search` tool). All three exist for the same reason: Codex CLI sends a tool `type`
unconditionally that at least one SAP route rejects, and the fix is to rewrite the request into
a shape the deployment accepts and repair the response so the client still sees the feature it
asked for. This plugin's request/response shaping lives in
[`customTools/adapter.ts`](./customTools/adapter.ts), which contains all the pure
transformations — the plugin itself is orchestration: read config, call the adapter, stash/read
the translated names, log, never throw. `responsesNamespaceToolsPlugin.ts` is the template both
files imitate, down to variable and function names.

## Problem statement

Codex CLI declares `apply_patch` as a freeform tool, not a JSON-Schema function:

```json
{
  "type": "custom",
  "name": "apply_patch",
  "description": "The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
  "format": { "type": "grammar", "syntax": "lark", "definition": "start: begin_patch hunk+ end_patch\n..." }
}
```

`apply_patch` is enabled by default for every current Codex model, so this is not an opt-in
feature the way `namespace` sub-agents are — a turn without a working translation loses its
primary file-editing tool. Both SAP routes reject the `custom` type outright, and they reject it
with different wording (measured 2026-08-11):

- **deployed** (`gpt-5.3-codex`): `The following tool is not allowed for model 'gpt-5.3-codex': custom.`
- **orchestration** (`anthropic--claude-4.8-opus`): `400 - Request Body: 'custom' is not one of ['function'] - 'config.modules.prompt_templating.prompt.tools[4].type'`

The trailing JSON pointer (`tools[4].type`) names the INDEX of the offending entry in the
client's `tools` array for that specific capture, not a constant — it moves with wherever the
`custom` tool sits in the list the client sent. The stable, capture-independent part of the
message is `'custom' is not one of ['function']`, which is the form `customTools/adapter.ts`'s
header comment quotes, deliberately shortened to the part that doesn't vary by request.

Codex replays the whole conversation each turn (`store: false`, no `previous_response_id`), so
once the model has called `apply_patch` once, every following request in that session also
carries `custom_tool_call` and `custom_tool_call_output` items in `input` — and the two routes
diverge again on those, measured the same day:

| | `custom` tool declaration | replayed `custom_tool_call` history items |
|---|---|---|
| deployed (`gpt-5.3-codex`) | rejected: `The following tool is not allowed for model 'gpt-5.3-codex': custom.` | **accepted natively**, `status=completed` |
| orchestration (`anthropic--claude-4.8-opus`) | rejected: `400 - Request Body: 'custom' is not one of ['function'] - 'config.modules.prompt_templating.prompt.tools[4].type'` | rejected: `Unsupported Responses input item type: custom_tool_call` |

**That asymmetry is the thing most likely to trip up a future reader.** The deployed route
already understands `custom_tool_call` items natively — it only objects to the tool
*declaration*. Orchestration objects to both. After this plugin translates the declaration to
`function`, a replayed `custom_tool_call` no longer matches what was declared even on the
deployed route (the tool is now `function`-shaped, so history has to agree), which is why
`translateCustomCallItems` runs unconditionally on **both** routes rather than being gated to
orchestration alone — see [Modes](#modes) below.

## Why the response side has to exist too

The reasoning is the one `namespaceTools/adapter.ts` documents at length, and it applies here
unchanged rather than being independently re-measured: Codex's tool router dispatches a call by
the shape it was declared under. Translating the declaration to `function` without translating
the reply back to `custom_tool_call` would produce a deployment that accepts the request and
lets the model call `apply_patch`, but hands Codex a `function_call` for a tool it registered as
`custom` — which fails at the client, silently from the API's point of view, instead of loudly
with the 400 it replaces. Both halves are required, and neither is optional:

1. **Before** (request): translate the `custom` tool declaration to `function`, and translate
   any replayed `custom_tool_call` / `custom_tool_call_output` history items to their
   `function_call` / `function_call_output` equivalents. Remember which tool names were
   translated this turn.
2. **After** (response): for every `function_call` item the model made to one of those
   translated names, put the `custom_tool_call` shape back before the client sees it. This half
   exists **twice**, for the same reason it does in the namespace plugin: after-plugins never
   run per SSE frame, so the after handler covers a non-streaming reply and a `res.write`
   interceptor installed by the before handler covers a live stream. Codex CLI streams by
   default, so the interceptor is the one that carries real traffic — see
   [Streaming](#streaming).

## Modes

`configService.getCustomToolMode()` (`api_config.json` → `custom_tools.mode`) selects one of two
behaviors for the tool **declaration**. Absent config resolves to the default, `translate`, so
an install whose `api_config.json` predates this key gets the working behavior rather than the
400.

- **`translate`** (default) — rewrite the `custom` tool to `function`, restore
  `custom_tool_call` on the way back. This is what makes `apply_patch` work at all.
- **`strip`** — remove the `custom` tool declaration entirely rather than translating it. An
  operator picks this when even the translated (function-shaped) tool is unacceptable for a
  deployment. The cost is real: without `apply_patch`, the model falls back to editing files
  through shell commands (`exec_command` with a heredoc) instead. That still works, but it is
  clumsier and burns more tokens on a large edit than a single structured patch call would.

**The mode only governs the declaration.** Replayed `custom_tool_call` / `custom_tool_call_output`
history items are translated **unconditionally**, in both modes — `translateCustomCallItems` runs
before `translateCustomTools` is even consulted, and its result is checked independently
(`beforeHandler` returns early only if *neither* the declaration changed *nor* any history item
was converted). This matters across a mode flip mid-session: a turn can carry replayed
`custom_tool_call` items from when `apply_patch` was still declared, while the current turn
declares no custom tool at all (`strip`, or the model simply stopped calling it) — orchestration
400s on the unconverted item type either way, so history conversion cannot be conditioned on
whether the current turn's declaration changed.

## What is lost

A `custom` tool's `format` constrains **decoding itself** to a grammar — here, the Lark grammar
for `apply_patch`'s patch syntax. JSON Schema, which is all a `function` tool's `parameters` can
express, has no equivalent: it can describe the shape of a JSON value, not a constraint on
freeform text decoding.

The translated tool carries the grammar into its `description` instead (see
`rewriteDescription` in the adapter), as a **soft** constraint. This is a real degradation, not
a relabeling of the same guarantee: the model can still emit a patch that does not match the
grammar. Nothing on the gateway or the deployment enforces it. When that happens, Codex's own
`apply_patch` parser rejects the malformed patch on the client side and the model retries with
the parser's error as feedback — the same recovery path a human editing a bad patch by hand
would get, but not the hard guarantee grammar-constrained decoding gives. The alternative to
accepting this is no `apply_patch` at all (`strip` mode, or the 400 this plugin replaces), so it
is accepted rather than fixed.

## `tool_search`

<a id="tool_search"></a>

Codex 0.147.0 sends 11 tools for `gpt-5.5`: 9 `function`, 1 `custom` (`apply_patch`), and 1
`tool_search`. Both non-function types are now translated by this plugin.

**This section previously said `tool_search` was out of scope and that translating it would need
"gateway-side tool-registry state carried across turns". That was wrong, and a capture disproved
it.** The declaration carries `execution: "client"`: Codex holds the deferred-tool registry and
runs the search locally. There is no server-side state to keep. Shapes are recorded in
[`tool-search-capture.md`](../../test/fixtures/codex-custom-tools/tool-search-capture.md),
captured from real Codex against `api.openai.com`.

Two details decide the implementation, and both run opposite to the `custom` case:

- A `tool_search_call` carries `arguments` as a JSON **object**; a `function_call` carries a JSON
  **string**. The translation converts in both directions.
- The real protocol emits **no argument-delta frames at all** — only `output_item.added` then
  `output_item.done`, arguments complete. So the interceptor SUPPRESSES `function_call_arguments.*`
  for these calls rather than resynthesising them, which is the inverse of what `custom` needs.

Both routes reject the type outright, measured:

```
deployed      The following tools are not allowed for model 'gpt-5.3-codex': custom and tool_search.
orchestration 400 - Request Body: 'tool_search' is not one of ['function']
              - 'config.modules.prompt_templating.prompt.tools[0].type'
```

### The discovered-tool hoist, and why it exists

Discovery alone is not useful: the model learns tool names it cannot call. Codex keeps deferred
MCP tools exposed **only when the provider `base_url` is `api.openai.com`**. That was isolated by
changing one line of an otherwise-working config:

```
- base_url = "https://api.openai.com/v1"
+ base_url = "http://localhost:3000/openai/v1"
```

and nothing else — same catalogue, same provider style, same MCP server, same HTTP+SSE transport.
Against OpenAI the discovered tools appear in Codex's own `tools[]`; against this gateway they
never do, on any turn. With `tool_mode: null` there is no code-mode context to reach a deferred
tool through either, so the tool is unreachable. This is a client-side limitation
(openai/codex#36382 describes the same mechanism); nothing the gateway returns can influence it,
because Codex decides before any response arrives.

The hoist is the one available lever. On a replayed `tool_search_output` the gateway:

1. lifts the discovered tools into the request's own `tools` array;
2. flattens their `namespace` wrappers itself — `responsesNamespaceToolsPlugin` runs EARLIER in
   both hook arrays, so its flatten has already happened and anything added later would reach the
   bridge still wrapped;
3. re-nests the `namespace` on the way back (reusing `renestFunctionCall`), so Codex's router can
   dispatch by `(namespace, name)`.

Verified live: Codex discovered three MCP tools through this gateway and called two of them, with
the wire showing 14 tools in from the client and 17 out to the upstream.

**It is switchable, because it works around someone else's bug.** Set
`tool_search.hoist_discovered_tools` to `false` once Codex stops gating exposure on the host, and
the gateway stops touching the tools array. Leaving it on afterwards is harmless rather than
damaging: any name the client already declares is skipped, so a client that starts sending its own
discovered tools gets no duplicates. The switch exists so the workaround is retired deliberately
rather than silently outliving the bug.

### Configuration

| Key | Values | Default | Effect |
|---|---|---|---|
| `custom_tools.mode` | `translate` \| `strip` | `translate` | `strip` removes `apply_patch`; the model falls back to editing files through shell commands |
| `tool_search.mode` | `translate` \| `strip` | `translate` | `strip` removes `tool_search`; the model cannot discover deferred tools at all |
| `tool_search.hoist_discovered_tools` | boolean | `true` | `false` disables the hoist above, leaving discovered tools uncallable on this gateway |

Only an explicit `false` disables the hoist — absent or malformed values leave it on, since a
wrong `true` costs nothing and a wrong `false` silently breaks discovered tools. Note the running
gateway reads config from the admin service, so changing any of these requires an admin publish;
the shipped defaults apply until then.

Setting `supports_search_tool: false` in the CLIENT's `model_catalog_json` is a different lever
with the opposite trade: Codex then registers MCP tools as directly callable and never sends
`tool_search` at all. Discoverable-but-uncallable versus callable-but-undiscoverable is a
client-side choice; the hoist is what makes both work at once.

## Request/response flow

### Before handler

1. Read the mode from `configService.getCustomToolMode()` — already validated and clamped by
   that layer; this plugin does not re-validate it.
2. Call `translateCustomCallItems(req.body)` — history is translated **before** the
   declaration and **unconditionally**, regardless of mode; see [Modes](#modes) for why this
   cannot be gated on the current turn's declaration.
3. Call `translateCustomTools(req.body, mode)`. If neither it nor step 2 changed anything,
   return `{ stop: false }` and do nothing else.
4. Log what was translated or dropped, and how many history items were converted.
5. If no tool names were translated this turn (`strip` mode, or no `custom` tool present),
   return `{ stop: false }` — there is nothing to restore on the response side, because a call
   to a name never declared as `custom` this turn was never going to arrive as `function_call`
   from a tool the client thinks is `custom`.
6. Otherwise stash the translated names at `req.__customToolNames`.
7. If the request is streaming (`req.body.stream === true`), install the `res.write`
   interceptor described under [Streaming](#streaming) — the after handler below only ever sees
   a non-streaming body.
8. Any exception is caught, logged, and swallowed — `{ stop: false }` either way. A bug in this
   plugin must never be the reason a Responses request fails; the worst acceptable outcome is
   `apply_patch` not working, not the whole route going down.

### After handler

1. Read `req.__customToolNames`. If it's missing or empty, return `upstreamResponse` unchanged.
2. Otherwise call `restoreOutputItems(upstreamResponse.output, names)`, which mutates matching
   `function_call` items into `custom_tool_call` shape in place and returns how many it touched.
3. Log the count if non-zero.
4. Same swallow-and-return-through behavior as the before handler on any exception, and on a
   malformed `upstreamResponse` — the response passes through unchanged rather than the request
   failing.

## Hook wiring

Both `defaultHooks.openai.responses` and `.responses-stream` in `api_config.json` carry an entry
for this plugin, gated the same way `responsesNamespaceToolsPlugin`'s entry is:

```json
{
  "request": {
    "callback": { "id": "responsesCustomToolsPlugin" },
    "match": ["header:contentTypeJson"]
  }
}
```

Like `responsesNamespaceToolsPlugin`, this entry carries no tool-specific narrowing match: the
adapter's own `translateCustomTools` and `translateCustomCallItems` already no-op instantly on
any request with nothing to translate, so a match condition would not save meaningful work.

Its position in the two arrays differs, on purpose, for exactly the reason
`responsesNamespaceToolsPlugin.md`'s [Layering](./responsesNamespaceToolsPlugin.md#layering)
section explains for that plugin — do not read this section without that one:

| Hook array | Shipped order |
|---|---|
| `responses` (after-handler chain, in order) | `pseudonymizationPlugin` → `responsesWebSearchPlugin` → `responsesFileSearchPlugin` → `responsesNamespaceToolsPlugin` → **`responsesCustomToolsPlugin`** |
| `responses-stream` (interceptor install order, last-installed-outermost) | `pseudonymizationPlugin` → `responsesNamespaceToolsPlugin` → **`responsesCustomToolsPlugin`** → `responsesWebSearchPlugin` → `responsesFileSearchPlugin` |

This plugin sits **last** on `responses`, after namespace's re-nesting has already run over the
final merged `output` — non-streaming replies from a continuation round (web-search or
file-search) have to be visible to this plugin's restoration, and namespace's re-nest has to
happen before custom-tool restoration touches the same items. On `responses-stream` it sits
**between** namespace and web-search in installation order — namespace installs first, then this
plugin, then web-search — which means, since the last interceptor installed ends up outermost:
this plugin's `rewriteBlock` runs *before* namespace's on every block (its `originalWrite` is
namespace's already-patched write), and *after* web-search's, so it does observe any
`custom_tool_call` shape appearing in a frame web-search generates on a continuation round. The
two touch disjoint `output_index` values in practice (a hoisted namespace tool and a translated
custom tool are never the same call), so their relative order to each other has no observed
functional consequence — what the test and this document both pin is only that this plugin is
outer than pseudonymization (so it always observes unmasked text — masking stays innermost
regardless of which tool plugins run) and inner than web-search (so it sees what web-search
generates).

Both directions are pinned, whole and by name, in
[`test/responses-tool-plugin-layering.test.ts`](../../test/responses-tool-plugin-layering.test.ts).
Reordering either array fails that suite.

The three `api_config.json` copies (`services/gateway`, `services/admin`,
`npm-dist/sail-proxy/src/templates/api_config.template.json`) are kept md5-identical via
`node cli-tools/sync-api-config.js`, run from the repo root after editing only the
`services/gateway` copy.

## Streaming

Codex CLI streams by default, so the streaming path is the one that matters — and after-plugins
never run per SSE frame. The before handler installs a `res.write` interceptor of its own
whenever `req.body.stream === true` and at least one tool name was translated this turn. In
`strip` mode, or on a turn with no `custom` tool at all, no names are translated and no
interceptor is installed.

The full frame contract — which of the five upstream frame kinds a translated call passes
through as, how `function_call_arguments.delta` fragments are buffered rather than translated
one-for-one, the end-of-stream flush for a cancelled turn, and the accepted known gaps — is
documented as a block comment directly above `installCustomToolInterceptor` in
[`responsesCustomToolsPlugin.ts`](./responsesCustomToolsPlugin.ts). That comment is the
authoritative version; what follows here is the summary an operator needs without reading the
implementation.

**In short:** a translated call's arguments arrive from upstream as a JSON string
(`{"input":"*** Begin Patch..."}`) split across `function_call_arguments.delta` frames. Those
deltas are suppressed and accumulated rather than translated frame-by-frame, because
`custom_tool_call_input.delta` carries raw (unescaped) text and unescaping a JSON string split
at an arbitrary byte boundary — including a `\uXXXX` escape straddling two frames — cannot be
done correctly one fragment at a time. The accumulated text is resynthesised into exactly **one**
`custom_tool_call_input.delta` followed by one `.done` at the point the upstream
`function_call_arguments.done` frame arrives (or, for a stream that ends without one, at
end-of-stream — see the ts comment's END-OF-STREAM FLUSH section). The visible cost is that the
patch appears in the TUI all at once rather than token-by-token.

**Route divergence.** All of the above describes the **deployed** route, where upstream
genuinely streams `function_call_arguments.delta`/`.done` frames. The **orchestration**
bridge (`../responses/orchestrationBridge/streamTranslator.ts`) does not stream tool-call
arguments at all: for every tool call it emits exactly `response.output_item.added`
immediately followed by `response.output_item.done`, both already carrying the complete
`arguments`. On the orchestration route the client receives **zero**
`response.custom_tool_call_input.delta`/`.done` frames for any call — the payload reaches
Codex only inside `output_item.done`'s `item.input`, restored the same way the
non-streaming `afterHandler` restores it. This is also why the interceptor's
`output_item.done` handling has to test the buffered text for *emptiness* rather than
mere *presence*: on orchestration a tracked call's buffer is always still there when
`output_item.done` arrives (nothing ever clears it), and that is the route's normal
shape, not upstream misbehaving.

**Task 9 watch item.** Whether Codex is satisfied by `item.input` alone on the
orchestration route — with no `custom_tool_call_input` frames of any kind — is unproven,
and is arguably a bigger departure from what real OpenAI ever sends than the
single-resynthesised-delta question below is for the deployed route. Both are open
questions Task 9 needs to answer against a live session; this document does not assume
either works.

**This is unverified.** Whether Codex's client actually accepts a single non-incremental
`custom_tool_call_input.delta` in place of the token-by-token stream it would see from real
OpenAI has not been tested against a live Codex session — Task 9 (live verification) has not run
as of this writing. The plugin header pre-declares a fallback for exactly this case: if Codex
renders nothing for the patch, chunk the already-buffered payload into several synthetic
`custom_tool_call_input.delta` frames instead of one. That needs no new parsing, only a
different split of text that has already been decoded — see the `WHY DELTAS ARE BUFFERED...`
section of the ts file's header comment for the full reasoning, and
[`docs/superpowers/plans/2026-08-11-custom-tool-translation.md`](../../../../docs/superpowers/plans/2026-08-11-custom-tool-translation.md)
Task 9 for the verification plan itself. Until that runs, treat the single-delta resynthesis as
a design choice awaiting confirmation, not as a proven-working behavior.

## Masking

`apply_patch`'s payload — the whole patch, including any file contents it touches — is masked
like any other request text. `custom_tool_call.input` and the content-part text inside an
array-shaped `custom_tool_call_output.output` are both covered by the masking coverage in
`responsesBodyAdapter.ts`, and the two synthesised `response.custom_tool_call_input.*` stream
events are unmasked on the way out by `pseudonymization/index.ts`, the same way
`response.output_text.delta`/`.done` already are. Whether this survives a live round trip end to
end (a plausible secret in an edited file's contents reaching the TUI unmasked as the real
value, and the outbound request carrying only the placeholder) is one of the things Task 9 is
meant to confirm; it has not been confirmed live as of this writing.

## Verification status

**Task 9 (live verification against a running Codex CLI session) has not run.** Everything above
that is not a direct reading of the shipped code — in particular whether Codex accepts the
resynthesised single delta, and whether masking survives the full round trip — is a design
decision backed by unit tests and the reasoning `namespaceTools/adapter.ts` established for the
sibling plugin, not a confirmed live behavior. Do not read this document as proof the feature
works end to end against real Codex traffic; read it as what the code does and why, with the
open question named rather than assumed away.
