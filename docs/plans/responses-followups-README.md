# Responses API follow-ups — plan index

Follow-up work left behind by the four-phase Responses API effort (2026-07-28/29):

| Phase | Delivered |
|---|---|
| 1 | `POST /openai/v1/responses` — native passthrough to deployed GPT-5+/o-series models, with PII masking extended to the Responses body shape and its streaming deltas |
| 2 | Hosted `web_search` emulated as a gateway plugin (Perplexity `sonar-pro`), plus the `/openrouter/api/v1/responses` mount |
| 3 | The model now answers *from* the search results (a second deployment call, streaming and non-streaming), and `Content-Type` matching compares media types so charset-suffixed clients are no longer excluded from masking |
| 4 | Codex's `namespace` sub-agent wrapper is flattened outbound and the routing namespace restored inbound, so `multi_agent` works with no Codex flag |

Everything below was found during those phases, judged non-blocking, and deliberately deferred with a ruling recorded at the time. Each item states the evidence that established it, so none of this needs re-deriving.

Nothing here is a regression introduced by that work. Items 01 and 02 are **pre-existing production defects** the effort surfaced; 03 is a bounded residual of phase 3; 04 is cosmetic.

## Items

### 01 — The web-search system prompt never ships in the Docker image
Outcome: the operator-editable `webSearchPlugin.system-prompt.txt` is actually used in production, instead of silently falling back to the inline copy.
Brief: `responses-followups-01-websearch-prompt-packaging.md` · **Highest real-world impact of these four.**

### 02 — `openaiController` never maps `cached_tokens`
Outcome: chat-completions traffic bills cached input at the cached rate rather than the full rate.
Brief: `responses-followups-02-openai-cached-tokens.md`

### 03 — The continuation loop's deadline is checked only per round
Outcome: a stalled web-search continuation closes its socket near the idle budget rather than up to ~11 minutes past it.
Brief: `responses-followups-03-continuation-deadline.md`

### 04 — Small cleanups
Outcome: six cosmetic/documentation inaccuracies corrected; no behavior change.
Brief: `responses-followups-04-cleanups.md`

## Related

- `docs/notes/file-search-responses-api.md` — design notes for a future `file_search` tool, deliberately excluded from phase 2 because the gateway has no vector store.
- Specs: `docs/superpowers/specs/2026-07-28-openai-responses-api-design.md`, `…-responses-hosted-tools-design.md`, `…-responses-websearch-continuation-design.md`
