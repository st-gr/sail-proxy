---
title: SAIL-PROXY User Guide - Chapter 5
author: st-gr
date: 2026-08-30
mainfont: Helvetica, Arial, sans-serif
fontsize: 18px
---

# SAIL-PROXY User Guide
*Multi-provider AI Gateway for SAP AI Core*
**Author:** *st-gr*

[<< Previous Chapter](chapter-4-claude-code.md) | [Content Table](README.md) | [Next Chapter >>](chapter-6-opencode.md)

---

## Using with Codex

[Codex CLI](https://github.com/openai/codex) is OpenAI's terminal coding agent. SAIL-PROXY runs it against your SAP AI Core deployed GPT-5+/o-series models through the OpenAI **Responses API**, and executes Codex's hosted `web_search` tool gateway-side so search queries stay within your SAP tenant boundary.

### Prerequisites

- **SAIL-PROXY installed and running** (see [Installation](chapter-3-installation.md)).
- A **gateway API key** (create one via the CLI or Admin Cockpit — see [Admin Cockpit](chapter-8-admin-cockpit.md)).
- **Codex CLI** installed (`npm i -g @openai/codex`, or your usual channel).
- A **deployed GPT-5+ or o-series model** in SAP AI Core (the Responses route requires a deployed model, e.g. `gpt-5.6-sol`). Use `cli-tools/sail-model-deploy.js` or SAP AI Launchpad to deploy one.

### Quick start: launch with the SAIL-PROXY CLI (recommended)

The standalone `sail-proxy` CLI can configure and launch Codex against the gateway with no manual editing:

```bash
# point the launcher at your gateway once (local bundled gateway, or a remote URL)
sail-proxy endpoint set local
# or: sail-proxy endpoint set https://gateway.example --key-env SAILPROXY_KEY

# launch Codex against it (web_search set up automatically)
sail-proxy codex "refactor this module and add tests"
```

`sail-proxy codex` passes the provider settings to Codex as command-line overrides (it writes nothing into your `~/.codex/config.toml`) and prepares Codex's `web_search` so it routes through the gateway. See the launcher's developer notes for details.

### Manual configuration (`~/.codex/config.toml`)

If you prefer to configure Codex yourself, point it at the gateway's `/openai/v1` base and use the Responses wire API:

```toml
model = "gpt-5.6-sol"          # a deployed GPT-5+/o-series slug; see "Model selection"
model_provider = "sail-proxy"
web_search = "live"            # enable Codex's hosted web_search tool (routed through the gateway)

[model_providers.sail-proxy]
name = "sail-proxy"
base_url = "http://localhost:3000/openai/v1"   # your gateway's OpenAI base URL
env_key = "OPENAI_API_KEY"     # the env var holding your gateway API key
wire_api = "responses"
```

Then export your gateway key and run Codex:

```bash
export OPENAI_API_KEY="<your-gateway-api-key>"
codex "explain what this service does"
```

### Model selection

Use a **deployed** GPT-5+/o-series model. You can pass the **bare** slug (e.g. `gpt-5.6-sol`) — the gateway's `/openai/v1/responses` route automatically resolves it to its deployed twin (`gpt-5.6-sol--deployed`), so Codex still sees a name it recognizes while inference runs on the deployed model.

> **Note:** Codex may print `warning: Model metadata for '…' not found. Defaulting to fallback metadata`. That is expected — the name is a gateway alias Codex has no built-in catalog entry for — and does not affect the session.

### Web search

Codex attaches a hosted `web_search` tool to its requests. SAIL-PROXY **emulates it gateway-side**: it runs the search itself through **Perplexity `sonar-pro` on a SAP AI Core deployment**, then calls the model again with the results, so the turn ends with the model's own answer written from what the search found. Because the search runs on a SAP AI Core deployment, **the query stays inside your SAP tenant boundary**, and it is **pseudonymized (re-masked) before it is dispatched** to the search provider — the model and client see the real query, the search provider sees the masked one. Streaming works the same way (see [Features → Hosted web search](chapter-2-features.md) for the mechanism).

To make Codex emit the hosted tool (rather than fall back to its own standalone search), the launcher sets this up for you; for a manual setup, `web_search = "live"` plus a model catalog that marks the model web-search-capable is required. See the developer notes for the one-time catalog step.

### Sub-agents

Codex's `multi_agent` feature sends a `namespace`-typed tool that SAP deployments reject. The gateway handles this transparently — it flattens the wrapper into ordinary function tools on the way out and restores the routing on tool calls on the way back, on both streaming and non-streaming paths — so sub-agents work with no Codex flag and nothing to configure. See [Features](chapter-2-features.md) for details.

### Older Codex versions

Releases prior to mid-2025 spoke Chat Completions and were configured through `~/.codex/config.json` with a `providers` block pointing at `/openai/v1`. That still works against the chat-completions route, but the Responses route above is the supported path.

### Troubleshooting

- **`Model … not found` / a 400 from the gateway** — the model must be a **deployed** GPT-5+/o-series model. Bare foundation-only names are rejected on the Responses route by design.
- **`502` on every gateway call** — if your shell has `http_proxy`/`https_proxy` set (e.g. for a debugging proxy), add `NO_PROXY=localhost,127.0.0.1` so calls to the local gateway are not routed through it.
- **Codex refuses to run outside a trusted directory** — use `--skip-git-repo-check`, or add a `[projects."…"] trust_level = "trusted"` entry to `~/.codex/config.toml`.

---

*Next: Learn how to [integrate with opencode](chapter-6-opencode.md).*
