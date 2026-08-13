# Notes — a `file_search` tool for the Responses API

> **SUPERSEDED, 2026-08-05.** These are pre-implementation notes from before the
> feature existed. The corpus question was answered (pgvector in the admin Postgres),
> the tool shipped, and the design that replaced these notes is
> `docs/superpowers/specs/2026-08-04-file-search-tool-design.md`. Kept for the
> reasoning about *why* it was deferred from phase 2, which is still accurate.

**Status:** notes only. Not a spec, not approved, nothing scheduled.
**Written:** 2026-07-29, at the close of the three-phase Responses API effort.

These notes exist so that whoever picks `file_search` up does not have to re-derive why it was excluded, or re-litigate the decisions that phase 2 and 3 already settled.

## Why it was excluded from phase 2

`file_search` was on the phase-2 candidate list alongside `web_search` and was dropped deliberately. The reason is simple and still true: **the OpenAI `file_search` tool searches vector stores, and this gateway has no vector store.**

`web_search` was tractable because a search provider already existed in the landscape — Perplexity `sonar-pro`, reachable through SAP AI Core, already integrated for the Anthropic `webSearchPlugin`. Emulating it meant wiring a tool shape to a backend that was already there. `file_search` has no equivalent: there is nothing to search, so the work is not "emulate a tool" but "build and populate a retrieval corpus", which is its own subsystem with its own ingestion, storage and lifecycle concerns.

There was also no demand: Codex CLI does not send `file_search`, so unlike `web_search` — which Codex attaches to *every* request and which therefore blocked the route entirely — nothing was broken by its absence.

## The corpus question, which decides everything else

Three options were sketched during phase-2 design. Whichever is chosen determines the shape of the whole feature, so it should be settled before any implementation planning.

**A local document folder on the gateway host.** Indexed with the existing `/openai/v1/embeddings` endpoint (which already proxies to SAP embedding models) and searched in process. Self-contained, no new infrastructure. Weaknesses: the corpus is per-host, so it does not survive a container restart or work across replicas, and it must be indexed out of band. Realistically a single-tenant or demo answer.

**SAP HANA Cloud vector engine.** The most "real" answer and the one that fits the SAP landscape — persistent, shared across replicas, queryable. Costs a database dependency, an ingestion path, credential handling and a migration story. Large enough to deserve its own spec; probably its own multi-phase effort.

**Strip the tool.** Silently drop `file_search` entries so a client that sends one is not rejected upstream. Cheap safety net, but the tool then returns nothing — a client relying on it gets silence rather than an error, which is arguably worse than the 400. Only defensible as a stopgap.

The `web_search` emulation is not evidence that A or B is easy; it is evidence that the *tool-shape plumbing* is now well understood. The plumbing is the small part.

## What phases 2-4 already built that a `file_search` effort would reuse

Substantial. The hosted-tool emulation pattern is now proven end to end, twice, and generalises:

- **The plugin shape.** `responsesWebSearchPlugin.ts` — a before handler that rewrites the hosted tool into a plain function tool the deployment accepts, and an after handler that replaces the model's `function_call` with the synthetic hosted-tool items the client expects. `file_search` differs only in the tool schema and the result item type (`file_search_call` rather than `web_search_call`).
- **The continuation loop.** Phase 3's mechanism — extend the conversation with the `function_call` and a `function_call_output`, call the deployment again so the model answers from the results, bounded by a configurable cap. This is transport-agnostic and would apply unchanged. Do not rebuild it: the streaming and non-streaming paths now produce identical client-visible output, which took two fix rounds and a whole-branch review to achieve.
- **The masking contract.** `queryMasking.ts` gives `remaskText` / `remaskResponsesItems`, scoped to text-bearing fields only. A `file_search` query is user text and must be re-masked before it leaves the process, exactly as the web-search query is. Note the phase-3 finding that on the **streaming** path re-masking is unnecessary and actively harmful, because the interceptor reads bytes that are still masked — that asymmetry is documented in `queryMasking.ts` and applies identically to any second hosted tool.
- **The hook gating invariant.** Every tool-plugin hook entry is gated on the same `header:contentTypeJson` rule as its sibling masking entry, so a tool can never run with masking off. `responses-hooks-config.test.ts` enforces this structurally across all hook arrays via a `TOOL_PLUGIN_IDS` set — add a `file_search` plugin's id to that set when you add the plugin, or it ships unguarded.
- **A second worked example of the whole pattern.** Phase 4 (`responsesNamespaceToolsPlugin`) solved a different SAP tool-type rejection — Codex's `namespace` sub-agent wrapper — with the same two-phase plugin shape. Read it alongside the web-search one: it is much smaller, so the pattern is easier to see, and it demonstrates the request-side/response-side symmetry without the continuation loop obscuring it.
- **The hook-array ordering asymmetry, which will bite a third tool plugin.** Write interceptors nest inside-out while after-handlers chain in array order, so `responses` and `responses-stream` list the same two tool plugins in *opposite* orders. A `file_search` plugin with both halves will face the same question, and the answer depends on whether it generates frames of its own on the streaming path. `responsesNamespaceToolsPlugin.md` has the reasoning and `responses-tool-plugin-layering.test.ts` encodes it.

## Things that would be genuinely new

- **Ingestion and freshness.** Nothing in the current design has a notion of a corpus that changes.
- **Access control.** A shared corpus raises "who may search what", which the gateway has no model for today. `web_search` sidestepped this entirely by searching the public internet.
- **Citations.** `file_search` results cite documents, not URLs. The `url_citation` annotation shape used by the web-search message items does not fit; the Responses API has its own file-citation annotation type.
- **PII in the corpus.** Documents may themselves contain PII. Masking currently protects the *request*; a retrieval corpus introduces a second source of sensitive text flowing to the model, and the existing pseudonymization map is per-request and content-derived — it has no notion of masking retrieved content consistently.

That last point is the one I would think hardest about before committing to a design. It is the difference between "another tool" and "a new class of data flowing through the gateway".

## Suggested first step, if this is picked up

Do not start with the plugin. Start by answering the corpus question with a concrete use case — whose documents, how they get indexed, who may read them — and only then write a spec. The tool-shape work is a known quantity and will take far less effort than the retrieval design.

## References

- `docs/superpowers/specs/2026-07-28-responses-hosted-tools-design.md` — where `file_search` was scoped out, with the three corpus options
- `docs/superpowers/specs/2026-07-28-responses-websearch-continuation-design.md` — the continuation design a `file_search` tool would reuse
- `services/gateway/src/plugins/responsesWebSearchPlugin.md` — the shipped emulation, including the masking asymmetry note
