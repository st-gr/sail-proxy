---
title: SAIL-PROXY User Guide - Chapter 6
author: st-gr
date: 2026-08-30
mainfont: Helvetica, Arial, sans-serif
fontsize: 18px
---

# SAIL-PROXY User Guide
*Multi-provider AI Gateway for SAP AI Core*
**Author:** *st-gr*

[<< Previous Chapter](chapter-5-codex.md) | [Content Table](README.md) | [Next Chapter >>](chapter-7-github-copilot.md)

---

## Using with opencode

[opencode](https://github.com/sst/opencode) is an open-source terminal AI coding agent. SAIL-PROXY connects it to your SAP AI Core models through the OpenAI-compatible `/openai/v1` endpoint, so opencode drives SAP AI Core the same way it would any OpenAI provider.

### Prerequisites

- **SAIL-PROXY installed and running** (see [Installation](chapter-3-installation.md)).
- A **gateway API key** (see [Admin Cockpit](chapter-8-admin-cockpit.md)).
- **opencode** installed (`npm i -g opencode-ai`, or see the opencode install docs).

### Quick start: launch with the SAIL-PROXY CLI (recommended)

The standalone `sail-proxy` CLI can configure and launch opencode against the gateway with no manual editing:

```bash
sail-proxy endpoint set local          # or a remote gateway URL + --key-env
sail-proxy opencode                     # launches opencode against the gateway
# non-interactive:
sail-proxy opencode run -m sail-proxy/gpt-5.6-sol "summarize this repo"
```

`sail-proxy opencode` writes a namespaced `provider.sail-proxy` block into `~/.config/opencode/opencode.json` (leaving any other providers untouched) and launches opencode.

### Manual configuration (`~/.config/opencode/opencode.json`)

Add a `sail-proxy` provider pointing at the gateway's `/openai/v1` base URL. Two providers work — pick one:

**Responses API (`@ai-sdk/openai`) — recommended for deployed GPT-5+/o-series models:**

```json
{
  "provider": {
    "sail-proxy": {
      "npm": "@ai-sdk/openai",
      "options": { "baseURL": "http://localhost:3000/openai/v1", "apiKey": "<gateway-key>" },
      "models": { "gpt-5.6-sol": {} }
    }
  }
}
```

**Chat Completions (`@ai-sdk/openai-compatible`) — works with orchestration-routed models:**

```json
{
  "provider": {
    "sail-proxy": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://localhost:3000/openai/v1", "apiKey": "<gateway-key>" },
      "models": { "gpt-5-mini": {} }
    }
  }
}
```

Then select the model with `-m sail-proxy/<model>`:

```bash
opencode run -m sail-proxy/gpt-5.6-sol "add error handling to this function"
```

### Which provider to use

- **`@ai-sdk/openai`** drives the **Responses API** (`/openai/v1/responses`), which serves deployed GPT-5+/o-series models — the same route Codex uses. This is the launcher's default.
- **`@ai-sdk/openai-compatible`** drives **Chat Completions** (`/openai/v1/chat/completions`), which routes bare model names through SAP AI Core orchestration. Both paths complete tool-rich agent turns against the gateway.

### Troubleshooting

- **`502` on every gateway call** — if your shell exports `http_proxy`/`https_proxy`, set `NO_PROXY=localhost,127.0.0.1` so local-gateway calls are not routed through the proxy.
- **Model not found / `NotFoundError`** — confirm the model is listed under the provider's `models` and that the gateway lists it (the model picker populates from `/openai/v1/models`). For deployed-only models, use the `@ai-sdk/openai` (Responses) provider.
- **The gateway key** — opencode sends it as the `Authorization: Bearer` token; use a valid gateway API key, not an upstream provider key.

---

*Next: Learn how to [integrate with GitHub Copilot](chapter-7-github-copilot.md).*
