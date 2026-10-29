---
title: pi coding agent
description: Launch pi against the gateway with the models fetched live.
---

# pi coding agent

[pi](https://pi.dev) is a minimal open-source terminal coding agent: `read`, `write`, `edit`, `bash`
and a few more tools, sessions, skills and extensions, and a `/model` picker. It reaches **every
chat model in the Model Library** through the gateway's Responses API (`/openai/v1/responses`) —
the same route Codex and opencode use — with tool calls, streaming and images.

## Prerequisites

- A running gateway (see [Quick start](/guide/quick-start)) and a gateway API key.
- pi installed (`npm install -g @mariozechner/pi-coding-agent`).

## Launch with the sail-proxy CLI

```bash
sail-proxy endpoint set local          # or a remote gateway URL with --key-env
sail-proxy pi                          # interactive
sail-proxy pi --model sail-proxy/anthropic--claude-4.5-haiku   # any chat model in the Model Library
sail-proxy pi -p "summarize this repo" # headless, one prompt
sail-proxy pi --dry-run                # preview what would run, change nothing
```

<TerminalFrame video="06-clients" name="pi" title="sail-proxy pi">pi with one provider for every model of the library.</TerminalFrame>

`sail-proxy pi` reads the gateway's model list (`GET /v1/models`), writes one provider named
`sail-proxy` with every chat model into `~/.pi/agent/models.json` (the previous file is backed up
beside it; any other provider there is left alone), hands pi the key in `SAILPROXY_KEY` for the
session and starts it. Unless you pass `--model` or `--provider`, pi starts with the launcher's
default deployed GPT model, or with the first listed model when that one is not in the list.
Everything after `pi` goes to pi unchanged.

Inside pi, `/model` lists every model the launcher wrote. Rerun `sail-proxy pi` after models or
deployments change to refresh that list. When the gateway does not answer, or on a dry run, the
launcher writes a short built-in list instead and says so.

## Manual configuration

Add a `sail-proxy` provider to `~/.pi/agent/models.json`, on the gateway's `/openai/v1` base URL
with the Responses API and the models you want to pick from:

```json
{
  "providers": {
    "sail-proxy": {
      "baseUrl": "http://localhost:3000/openai/v1",
      "api": "openai-responses",
      "apiKey": "SAILPROXY_KEY",
      "models": [
        { "id": "anthropic--claude-4.5-haiku", "name": "Claude 4.5 Haiku", "reasoning": true, "input": ["text", "image"], "contextWindow": 200000 },
        { "id": "gemini-3.5-flash", "name": "Gemini 3.5 Flash", "reasoning": true, "input": ["text", "image"], "contextWindow": 1000000 }
      ]
    }
  }
}
```

`apiKey` names an environment variable that pi reads at request time — export
`SAILPROXY_KEY=sk-demo-your-key` before starting pi — or holds the key itself. Model ids are the
ids the Model Library shows; take `contextWindow` from the model's context length there. Then:

```bash
pi --model sail-proxy/gemini-3.5-flash
pi --model sail-proxy/anthropic--claude-4.5-haiku -p "add error handling to this function"
```

On a Docker or Kyma deployment behind nginx, use `https://sail.example.com/gateway/openai/v1` as
`baseUrl`.

## Which models work

- **Every chat model** in the Model Library is reachable under the one `sail-proxy` provider —
  Claude, GPT, Gemini, Mistral and the rest.
- A **GPT model with a deployment** answers natively on the Responses API. **Every other model**
  is served through SAP orchestration, with tool calls, streaming and image input intact.
- pi's thinking levels reach the models the Model Library marks as reasoning-capable (the
  launcher writes those with `"reasoning": true`); other models answer without a thinking phase.
- Embedding, reranking and image-generation models are not listed: pi has no use for them.
- Where the Model Library carries list prices for a model, the launcher writes them into the
  model's `cost` entry, which pi's cost display uses.

## Usage and cost tracking

Requests from pi are tracked, entitled and billed like those on the gateway's other routes: the
same API keys, entitlement catalogs, quotas and cost accounting apply.

## Troubleshooting

- **pi does not know the model** (`/model` does not list it, or `--model` fails): the file was
  written before that model or deployment existed. Rerun `sail-proxy pi`, or add the model to
  `~/.pi/agent/models.json` yourself.
- **401 from the gateway** when running plain `pi`: `SAILPROXY_KEY` is not exported in that shell.
  Export it, or start pi through `sail-proxy pi`, which sets it for the session.
- **`Model <model> is not in your entitlement catalog "<catalog>"`**: the model exists, but your
  API key's entitlement catalog does not include it. Ask an administrator to add it.

Verified with pi 0.73.1.

For other problems, see [Troubleshooting](/guide/troubleshooting) and the [FAQ](/guide/faq).
