---
title: Codex CLI
description: Configure OpenAI Codex CLI to talk to SAP AI Core through the gateway.
---

# Codex CLI

[Codex CLI](https://github.com/openai/codex) is OpenAI's terminal coding agent. It speaks the OpenAI **Responses API**, which the gateway serves at `/openai/v1/responses`. Reasoning items, tool calls and native SSE framing pass through unchanged, PII masking covers the whole Responses body in both directions, and Codex's hosted `web_search` tool and its sub-agents work through the gateway.

## Prerequisites

- A running gateway (see [Quick start](/guide/quick-start)) and a gateway API key.
- Codex CLI installed (`npm i -g @openai/codex`, or your usual channel).
- A model in the Model Library. A GPT-5 or later, or o-series, model with its own SAP AI Core deployment is served natively (deploy one with `cli-tools/sail-model-deploy.js` or SAP AI Launchpad); other catalogue models go through SAP orchestration.

## Launch with the sail-proxy CLI

The standalone `sail-proxy` CLI configures and starts Codex against the gateway:

```bash
sail-proxy endpoint set local
# or: sail-proxy endpoint set https://sail.example.com/gateway --key-env SAILPROXY_KEY

sail-proxy codex "refactor this module and add tests"
```

<TerminalFrame video="06-clients" name="codex" title="sail-proxy codex">Codex with the gateway as its provider, through command-line overrides.</TerminalFrame>

`sail-proxy codex` passes the provider settings to Codex as `-c` command-line overrides — provider `sail-proxy`, base URL `<gateway>/openai/v1`, `wire_api = "responses"`, the key in `SAILPROXY_KEY` and the launcher's default deployed GPT model — and writes nothing into `~/.codex/config.toml`. It also sets up Codex's `web_search` (see [Web search](#web-search)); add `--no-web-search` to skip that, or `--dry-run` to see what would run.

## Manual configuration

Point Codex at the gateway's `/openai/v1` base URL with the Responses wire API in `~/.codex/config.toml`:

```toml
model = "gpt-5-mini"
model_provider = "sail-proxy"

[model_providers.sail-proxy]
name = "sail-proxy"
base_url = "http://localhost:3000/openai/v1"
env_key = "SAILPROXY_KEY"
wire_api = "responses"
```

Then export the key and run Codex:

```bash
export SAILPROXY_KEY="sk-demo-your-key"
codex "explain what this service does"
```

On a Docker or Kyma deployment behind nginx, use `https://sail.example.com/gateway/openai/v1` as `base_url`.

## Model selection

Use the bare model name (for example `gpt-5-mini`) or its `--deployed` id. The Responses route resolves the bare name to its `--deployed` twin when that deployment can serve the Responses API, so Codex keeps a name it recognizes while inference runs on the deployment. A model with no Responses-capable deployment goes through SAP orchestration instead.

Codex may print `warning: Model metadata for '…' not found. Defaulting to fallback metadata`. That is expected: a gateway model name has no entry in Codex's built-in catalogue, and the session is not affected.

## Web search

Codex attaches a hosted `web_search` tool to its requests. SAP AI Core deployments reject hosted tools, so the gateway runs the search itself through Perplexity `sonar-pro` on SAP AI Core (a `sonar-pro` deployment when one exists, otherwise SAP orchestration), then calls the model again with the results. The search goes out under your SAP AI Core tenant, not from the user's machine, and carries only the query. The turn ends with the model's own answer: Codex receives a `web_search_call` item for the search, followed by the assistant's message. The query is pseudonymized before it is sent to the search model; Codex sees the real query. The number of searches per request is capped by `api_config.capabilities.web_search.max_searches_per_request` (default 3).

Codex emits the hosted tool only when web search is on and its model catalogue marks the model as able to use it. The launcher handles both: it copies `~/.codex/models_cache.json`, sets `use_responses_lite` to `false` on the model's entry, and passes `web_search=live` and `model_catalog_json=<copy>`. When `~/.codex/models_cache.json` does not exist yet, the launcher skips web search and prints how to seed the catalogue: one run against OpenAI itself, for example:

```bash
OPENAI_API_KEY=<openai-key> codex -c model_provider=openai -c model=<model> "hi"
```

For a manual setup, do the same by hand: copy the catalogue, set `"use_responses_lite": false` on the entry of your model, and add to `~/.codex/config.toml`:

```toml
web_search = "live"
model_catalog_json = "/path/to/your/catalog-copy.json"
```

## Sub-agents

Codex's `multi_agent` feature sends a `namespace`-typed tool that SAP deployments reject. The gateway flattens the `namespace` wrapper into the ordinary function tools it contains on the way out, and restores the routing namespace on the model's tool calls on the way back, on both the streaming and non-streaming paths. Sub-agents work with no Codex flag and nothing to configure.

Administrators who would rather not offer the sub-agent tools can set `api_config.capabilities.namespace_tools.mode` to `"strip"` (the default is `"flatten"`); the gateway then drops them and Codex falls back to working without sub-agents.

This was verified end to end against Codex CLI 0.145.0 and 0.146.0, which both send the same `multi_agent_v1` wrapper. The gateway is not tied to that name: it flattens whichever namespace it receives and restores the same name on the way back.

## Older Codex versions

Releases before mid-2025 spoke Chat Completions and were configured through `~/.codex/config.json` with a `providers` block pointing at `/openai/v1`. That still works against the chat completions route; the Responses route above is the supported path.

## Troubleshooting

- **HTTP 400 `model_not_supported`**: the model is not in the Model Library, or it is a deployment that cannot serve the Responses API (for example an Anthropic `--deployed` model). Use a model from the Model Library; for a deployment, use a GPT-5 or later, or o-series, one.
- **`502` on every gateway call**: if your shell sets `http_proxy` or `https_proxy`, add `NO_PROXY=localhost,127.0.0.1` so calls to the local gateway skip that proxy.
- **Codex refuses to run outside a trusted directory**: pass `--skip-git-repo-check`, or add a `[projects."<path>"]` entry with `trust_level = "trusted"` to `~/.codex/config.toml`.

For other problems, see [Troubleshooting](/guide/troubleshooting) and the [FAQ](/guide/faq).
