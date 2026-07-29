# Responses Namespace Tools Plugin

## Overview

The `responsesNamespaceToolsPlugin` makes Codex CLI's sub-agent feature (`multi_agent`) work on the `/openai/v1/responses` route when the deployment sits behind SAP AI Core. It flattens Codex's `namespace` tool wrapper into the ordinary function tools it contains before the request reaches the deployment, then restores the `namespace` field on each affected `function_call` in the response so Codex can route it back to the sub-agent it belongs to.

It is the Responses-route sibling of [`responsesWebSearchPlugin`](./responsesWebSearchPlugin.md): both exist because SAP AI Core rejects a tool `type` that Codex CLI sends unconditionally, and both fix it by rewriting the request into a shape the deployment accepts and repairing the response so the client still sees the feature it asked for. This plugin's request/response shaping lives in [`namespaceTools/adapter.ts`](./namespaceTools/adapter.ts), which contains all the pure transformations — the plugin itself is orchestration: read config, call the adapter, stash/read the map, log, never throw.

## Problem Statement

Codex CLI's sub-agent feature declares its tools inside a `namespace` wrapper:

```json
{
  "type": "namespace",
  "name": "multi_agent_v1",
  "tools": [
    { "type": "function", "name": "spawn_agent", "parameters": { ... } },
    { "type": "function", "name": "close_agent", "parameters": { ... } }
  ]
}
```

`namespace` is a documented Responses feature, but SAP AI Core does not implement it and rejects the whole request:

```
The following tools are not allowed for model '<model>': namespace
```

Multi-agent is enabled by default in Codex CLI, so this 400 kills the turn before the model ever runs. The workaround this plugin replaced was telling users to run `--disable multi_agent`, i.e. to switch the feature off entirely — an option, not a fix. That advice is gone from the user documentation as of the streaming half landing; nothing is left for a user to configure.

## Why the response side has to exist too — measured, not assumed

The obvious fix is to hoist the nested tools to the top level and drop the wrapper. That alone would be worse than the 400 it replaces. Replying to Codex CLI 0.145.0 with a call for the real tool `close_agent`:

- **without** a `namespace` field on the reply → `codex_core::tools::router: error=unsupported call: close_agent` — the router never found the tool.
- **with** `namespace: "multi_agent_v1"` on the reply → the tool executed (it failed only on deliberately bad arguments supplied in the test).

Codex routes namespaced tools by the pair `(namespace, name)`, never by name alone. A flatten with no re-nest ships a deployment that *accepts* the request and lets the model call the tool, but Codex silently refuses to dispatch the call — no error surfaces to the deployment, the turn just stalls from the user's point of view. That is strictly worse than the 400 it replaces, which at least fails loudly. So this plugin implements both halves, and neither half is optional:

1. **Before** (request): flatten the `namespace` wrapper into plain function tools, and remember which namespace each hoisted tool came from.
2. **After** (response): for every `function_call` the model made to one of those hoisted tools, put the `namespace` field back before the client sees it. This half exists **twice**, because after-plugins never run per SSE frame: the after handler covers a non-streaming reply, and a `res.write` interceptor installed by the before handler covers a live stream. Codex CLI streams by default, so the interceptor — see [Streaming](#streaming) — is the one that carries real traffic.

## Modes

`configService.getNamespaceToolMode()` (`api_config.json` → `namespace_tools.mode`) selects one of two behaviors. Absent config resolves to the default, `flatten`, so an install whose `api_config.json` predates this key gets the working behavior rather than the 400.

- **`flatten`** (default) — hoist the nested tools to the top level, stash the `toolName -> namespaceName` map, restore `namespace` on the way back. This is what makes Codex's multi-agent feature actually work.
- **`strip`** — remove the `namespace` wrapper and its nested tools entirely, keeping only the top-level function tools that were already there. An operator picks this when the flattened tool set is itself unacceptable for a deployment — e.g. a policy that disallows `spawn_agent`/`close_agent`-shaped tools regardless of how they're wrapped — and would rather Codex fall back to its own no-sub-agent behavior than have the gateway offer them. In `strip` mode the stashed map is always empty, which makes the after handler's re-nesting step a guaranteed no-op: there is nothing to restore because nothing was hoisted.

A nested tool whose name collides with an existing top-level tool is dropped rather than hoisted (a duplicate tool name is itself a request the deployment would reject), and is deliberately absent from the map — any call to it is left alone rather than being tagged with a namespace it was never declared under.

## Request/response flow

### Before handler

1. Read the mode from `configService.getNamespaceToolMode()` — already validated and clamped by that layer; this plugin does not re-validate it.
2. Call `flattenNamespaceTools(req.body, mode)`. If it reports no change (no `namespace` tool present, or a malformed body), return `{ stop: false }` and do nothing else — this is the common case and it must be free of side effects.
3. Otherwise stash the returned map at `req.__namespaceToolMap` and log what was hoisted/dropped.
4. If the request is streaming (`req.body.stream === true`) and the map is non-empty, install the `res.write` interceptor described under [Streaming](#streaming) — the response side of a streamed turn, since the after handler below only ever sees a non-streaming body.
5. Any exception is caught, logged, and swallowed — `{ stop: false }` either way. A bug in this plugin must never be the reason a Responses request fails; the worst acceptable outcome is the namespace feature not working, not the whole route going down.

### After handler

1. Read `req.__namespaceToolMap`. If it's missing or empty (no flatten happened, or `strip` mode), return `upstreamResponse` unchanged — this is also the common case.
2. Otherwise call `renestOutputItems(upstreamResponse.output, map)`, which mutates matching `function_call` items in place and returns how many it touched. A namespace the model set itself is never overwritten.
3. Log the count if non-zero.
4. Same swallow-and-return-through behavior as the before handler on any exception, and on a malformed `upstreamResponse` (`undefined`/`null`/non-array `output`) — the response passes through byte-identical rather than the request failing.

## Hook wiring

Both `defaultHooks.openai.responses` and `.responses-stream` in `api_config.json` carry a third entry alongside `pseudonymizationPlugin` (index 0, never reordered) and `responsesWebSearchPlugin`:

```json
{
  "request": {
    "callback": { "id": "responsesNamespaceToolsPlugin" },
    "match": ["header:contentTypeJson"]
  }
}
```

The `header:contentTypeJson` gate isn't optional dressing: it is the same convention `pseudonymizationPlugin` and `responsesWebSearchPlugin` follow, on the theory that a tool plugin should never run on a request pseudonymization itself would skip — running this plugin against a non-JSON body makes no sense either. `responses-hooks-config.test.ts` enforces it directly: its per-entry match-superset check is keyed off a `TOOL_PLUGIN_IDS` set that includes `responsesNamespaceToolsPlugin` alongside the two web-search plugin ids, so an entry for this plugin whose `match` drops below `pseudonymizationPlugin`'s fails that suite by name. (The `tools:hasWebSearch` narrowing check in the same test is scoped to `WEB_SEARCH_PLUGIN_IDS` only and does not apply here — see the note below on why this plugin carries no equivalent narrowing match.)

Unlike `responsesWebSearchPlugin`, this entry carries no `tools:hasWebSearch`-style narrowing match: the adapter's own `flattenNamespaceTools` already no-ops instantly (and side-effect-free) on any request without a `namespace` tool, so there's nothing a match condition would save by filtering earlier — every Responses request pays one cheap `Array.some` check.

Its **position within each array differs between the two subpaths, on purpose** — see [Layering](#layering) below. Do not normalise the two arrays to match each other.

The three `api_config.json` copies (`services/gateway`, `services/admin`, `npm-dist/sail-proxy/src/templates/api_config.template.json`) are kept md5-identical via `node cli-tools/sync-api-config.js`, run from the repo root after editing only the `services/gateway` copy.

## Streaming

Codex CLI streams by default, so the streaming path is the one that matters — and after-plugins never run per SSE frame. The before handler therefore installs a `res.write` interceptor of its own whenever `req.body.stream === true` **and** the flatten produced a non-empty map, the same shape `responsesWebSearchPlugin` uses for its own streaming case. In `strip` mode (or when every nested tool was dropped as a duplicate) the map is empty, there is nothing to restore, and no interceptor is installed at all.

### Frame contract

A `function_call` reaches the client in exactly three places, and Codex needs the namespace in all three:

1. `response.output_item.added` — `frame.item` is the `function_call`
2. `response.output_item.done` — same
3. the terminal frame (`response.completed` / `.incomplete` / `.failed`) — `frame.response.output[]` carries the finished items, and it is what a client reconstructs the completed turn from

Everything else passes through untouched. A frame is re-serialised **only** when a re-nest actually changed something, so a stream that never calls a namespaced tool — i.e. every non-Codex client sharing the `responses-stream` hook — reaches the client byte-for-byte identical, `event:` and `id:` lines included. That property is what makes installing this on a shared hook safe.

The interceptor holds a partial `tail` across writes, because SSE block boundaries have nothing to do with `res.write` boundaries, and `res.end` flushes a non-empty tail before closing so a final block that arrived without its `\n\n` terminator is neither dropped nor left un-repaired.

### Layering

**The two Responses hook arrays ship in opposite orders, deliberately.** That is the most surprising thing about this plugin and the thing most likely to be "tidied" into a regression, so it comes first:

| Hook array | Shipped order | Consumed by | Direction |
|---|---|---|---|
| `defaultHooks.openai.responses-stream` | `pseudonymizationPlugin` → **this plugin** → `responsesWebSearchPlugin` | the `res.write` interceptors the `before` handlers install | inside-out — the **last installed is outermost** |
| `defaultHooks.openai.responses` | `pseudonymizationPlugin` → `responsesWebSearchPlugin` → **this plugin** | the after-handler chain in [`services/pluginExecutor.ts`](../services/pluginExecutor.ts) | in order — each handler receives the previous one's result |

Both arrays encode the *same* requirement — this plugin must observe whatever web-search produced — and they land on inverted positions because inside-out nesting and in-order chaining are opposites. Making them agree reintroduces one of the two bugs, whichever way they are made to agree. `pseudonymizationPlugin` stays at index 0 in both; only the two tool plugins swap.

#### Streaming — `responses-stream`, namespace *before* web-search

Each interceptor binds its `originalWrite` at install time, so the one installed *last* ends up outermost: a controller write runs `web-search → namespace → pseudonymization → socket`. This plugin is listed earlier so it installs first and therefore ends up nested *inside* web-search.

This interceptor must sit **beneath** the web-search one. The web-search interceptor does not merely forward what the controller writes — it *generates* frames of its own, parsed off a continuation POST that never passes through `res.write` at all: each continuation round's items, plus a final terminal frame it rebuilds wholesale from items it collected itself. Anything an outer interceptor generates is invisible to the layers above it. With this plugin on top (the order this branch originally shipped), a `spawn_agent` call the model made in a continuation round therefore reached Codex with **no `namespace`**, and `codex_core::tools::router` refused it — `unsupported call: spawn_agent`, the precise silent failure this plugin exists to prevent. Ordered beneath web-search, every byte web-search emits is re-nested on the way past.

The two are otherwise non-interfering, and each of those properties was checked rather than assumed:

- the web-search interceptor suppresses frames for `web_search` calls only, and this one touches only names present in the flatten map — and a hoisted namespace tool is never the hosted `web_search` tool;
- web-search's injected `web_search_call` and `message` items are not `function_call`s, so `renestFunctionCall` rejects them on `item.type` and their blocks come back byte-identical;
- web-search hands down whole `\n\n`-terminated blocks, so this interceptor's `tail` stays empty on that path — except for the one trailing partial block web-search's `patchedEnd` flushes, which this interceptor's `patchedEnd` then flushes on in turn, because web-search's deferred close runs through this layer's `end`;
- masking stays innermost regardless: writing through `originalWrite` keeps the unmasker in the chain, and web-search still reads still-masked upstream bytes above it, so its "no re-masking needed" reasoning is unchanged.

#### Non-streaming — `responses`, namespace *after* web-search

`executeAfterPlugins` walks the hook array **in order**, handing each handler the previous one's return value. Web-search's after handler runs a continuation loop and returns `{...current, output: [...clientItems, ...finalOutput]}`, where `finalOutput` is lifted straight off the continuation POST's response — content no earlier handler in the chain ever saw. So on this route the namespace handler has to run **last**.

Listing this plugin first here (which is what happens if the two arrays are made to match the streaming one) means a `spawn_agent` the model emits in a continuation round reaches the client with **no `namespace`** — the same `unsupported call: spawn_agent` failure as above, relocated to the non-streaming route. Reachability is low today, because Codex CLI always streams, and the failure is silent, which is exactly why it is pinned by a test rather than left to inspection.

[`test/responses-tool-plugin-layering.test.ts`](../../test/responses-tool-plugin-layering.test.ts) pins **both** directions by behavior, reading each order out of the shipped `api_config.json` rather than restating it: it installs both interceptors on one `res` for the streaming order, chains both after handlers over a response whose continuation round emits a namespaced `function_call` for the non-streaming order, and asserts outright that the two arrays disagree. Reordering either one fails the suite.

### Write callbacks

`res.write(chunk, cb)` is forwarded on the **last** block only, so the callback fires exactly once and reaches the layer below — `pseudonymizationPlugin`'s interceptor deliberately pops it, on the rule that it must fire even when a chunk is buffered, and this interceptor now sits above it. When the whole chunk is held back as a partial block there is nothing to hand down, so the callback is invoked here directly rather than swallowed. Nothing on the Responses route passes a callback today; the invariant is maintained because another plugin maintains it on purpose.

### Robustness

A throw inside a patched `res.write` must never break the stream. Three guards, and it is worth being precise about what each one buys:

- **the framing step** — on failure the held-back prefix is flushed first and the chunk is handed down untouched, so nothing is lost or reordered;
- **each block's rewrite, individually** — that block degrades to pass-through, keeping every byte and losing only the namespace on a call that was going to be unroutable anyway;
- **an outer catch** — this is what covers `originalWrite` itself throwing, which the per-block guard does *not*: a write that throws on block *k* of *n* still loses blocks *k..n*. That is accepted rather than fixed, because the only realistic way the layer below throws is a socket that is already gone, in which case the remaining blocks had nowhere to go either. It retries only while nothing of the write has reached the wire, and retries with `carried + chunk` — never the raw chunk alone, which after framing has already consumed the held-back prefix would be a block with its head missing. That is corruption rather than a drop, and `responses-namespace-tools-stream.test.ts` pins it: every attempted downstream write must start with `data: `.

## Shared SSE framing

The block-framing machinery — `splitBlocks`, `parseFrame`, `sseBlock`, `rebuildBlockWithSubstitution` and the `TERMINAL_RESPONSE_TYPES` set — lives in [`utils/sseFraming.ts`](../utils/sseFraming.ts) and is shared with `responsesWebSearchPlugin`, which is where it was first written and privately revised across three phases. It was extracted rather than copied when this interceptor became its second consumer: two independently-drifting copies of `rebuildBlockWithSubstitution`'s byte-identical-on-no-change guarantee is exactly the kind of subtle divergence that would show up as a corrupted stream for one plugin and not the other.

Note the one convention the shared helper imposes: it decides "unchanged" by object identity (`substitutedFrame === originalFrame`). The namespace adapter mutates items in place and reports the change as a boolean, so a changed frame is handed a shallow copy purely to break that identity and force re-serialisation.
