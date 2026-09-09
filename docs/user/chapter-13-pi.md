---
title: SAIL-PROXY User Guide - Chapter 13
author: st-gr
date: 2026-09-08
mainfont: Helvetica, Arial, sans-serif
fontsize: 18px
---

# SAIL-PROXY User Guide
*Multi-provider AI Gateway for SAP AI Core*
**Author:** *st-gr*

[<< Previous Chapter](chapter-12-google-gemini.md) | [Content Table](README.md)

---

## Using with pi

[pi](https://pi.dev) is a minimal open-source terminal coding agent: `read`, `write`, `edit`, `bash`
and a few more tools, sessions, skills and extensions, and a `/model` picker. SAIL-PROXY connects
it to **every chat model in the Model Library** through the gateway's Responses API — the same route
Codex and opencode use — so pi drives SAP AI Core the way it would drive any OpenAI-compatible
provider, with tool calls, streaming and images.

### Prerequisites

- **SAIL-PROXY installed and running** (see [Installation](chapter-3-installation.md)).
- A **gateway API key** (see [Admin Cockpit](chapter-8-admin-cockpit.md)).
- **pi** installed (`npm install -g @mariozechner/pi-coding-agent`).

### Quick start: launch with the SAIL-PROXY CLI (recommended)

```bash
sail-proxy endpoint set local          # or a remote gateway URL + --key-env
sail-proxy pi                          # interactive, GPT-5.6 Sol
sail-proxy pi --model sail-proxy/anthropic--claude-4.5-sonnet   # any model in the Model Library
sail-proxy pi -p "summarize this repo" # headless, one prompt
sail-proxy pi --dry-run                # preview what would run, change nothing
```

`sail-proxy pi` reads the Model Library, writes one provider named `sail-proxy` into
`~/.pi/agent/models.json` (the previous file is backed up beside it; any other provider you have
there is left alone), hands pi the key for the session and starts it with `gpt-5.6-sol` unless you
pass `--model` or `--provider`. Everything after `pi` goes to pi unchanged. Inside pi, `/model`
(Ctrl+L) lists every model the launcher found; rerun `sail-proxy pi` after deployments change to
refresh that list.

### Manual configuration (`~/.pi/agent/models.json`)

Add a `sail-proxy` provider on the gateway's `/openai/v1` base URL with the Responses API and the
models you want to pick from:

```json
{
  "providers": {
    "sail-proxy": {
      "baseUrl": "http://localhost:3000/openai/v1",
      "api": "openai-responses",
      "apiKey": "SAILPROXY_KEY",
      "models": [
        { "id": "gpt-5.6-sol", "name": "GPT-5.6 Sol", "reasoning": true, "input": ["text", "image"], "contextWindow": 1050000 },
        { "id": "anthropic--claude-4.5-sonnet", "name": "Claude 4.5 Sonnet", "input": ["text", "image"], "contextWindow": 200000 },
        { "id": "gemini-3.5-flash", "name": "Gemini 3.5 Flash", "reasoning": true, "input": ["text", "image"], "contextWindow": 1000000 }
      ]
    }
  }
}
```

`apiKey` names an environment variable that pi reads at request time — export
`SAILPROXY_KEY=<your gateway key>` before starting pi — or put the key itself there. Model ids are
the ids the Model Library shows. Then:

```bash
pi --model sail-proxy/gpt-5.6-sol
pi --model sail-proxy/anthropic--claude-4.5-sonnet -p "add error handling to this function"
```

pi reloads the file whenever you open `/model`, so edits take effect without a restart.

### Which models work

- **Every chat model** in the [Model Library](chapter-8-admin-cockpit.md#model-library-and-entitlements--quotas)
  is reachable under the one `sail-proxy` provider — Claude, GPT, Gemini, Mistral and the rest.
- A **GPT model with a deployment** (for example `gpt-5.6-sol`) answers natively on the Responses
  API. **Every other model** is served through the platform, the same routing the gateway's other
  endpoints use, with tool calls, streaming and image input intact.
- pi's `--thinking` levels reach the models the Model Library marks as reasoning-capable (the
  launcher writes those with `"reasoning": true`); other models answer without a thinking phase.
- Embedding, reranking and image-generation models are not listed — pi has no use for them.

### Usage and cost tracking

Requests from pi are tracked, entitled and billed exactly like the gateway's other routes — the
same API keys, entitlement catalogs, quotas and cost accounting apply. See
[Manage Access & Monitor Usage with Admin Cockpit](chapter-8-admin-cockpit.md). pi's own cost
column uses the list prices the Model Library carries for a model, where it carries any.

### Troubleshooting

- **pi does not know the model** (`/model` does not list it, or `--model` fails) — the file was
  written before that model or deployment existed. Rerun `sail-proxy pi`, or add the model to
  `~/.pi/agent/models.json` yourself.
- **401 from the gateway** when running plain `pi` — `SAILPROXY_KEY` is not exported in that shell.
  Export it, or start pi through `sail-proxy pi`, which sets it for the session.
- **`Model <model> is not in your entitlement catalog "<catalog>"`** — the model exists, but your
  API key's entitlement catalog doesn't include it. Ask an administrator to add it (see
  [Entitlements & Quotas](chapter-8-admin-cockpit.md#model-library-and-entitlements--quotas)).

Verified with pi 0.73.1.

---

*For general troubleshooting, see the [Troubleshooting guide](chapter-10-troubleshooting.md) or the [FAQ](chapter-11-faq.md).*
