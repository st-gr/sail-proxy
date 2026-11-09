---
title: opencode
description: Configure opencode to use the gateway's OpenAI-compatible endpoint.
---

# opencode

[opencode](https://github.com/sst/opencode) is an open-source terminal coding agent. It reaches SAP AI Core through the gateway's OpenAI-compatible `/openai/v1` base URL, using the Responses API (`/openai/v1/responses`), the same route Codex uses.

## Prerequisites

- A running gateway (see [Quick start](/guide/quick-start)) and a gateway API key.
- opencode installed (`npm i -g opencode-ai`, or see the opencode install docs).

## Launch with the sail-proxy CLI

The standalone `sail-proxy` CLI configures and starts opencode against the gateway:

```bash
sail-proxy endpoint set local          # or a remote gateway URL with --key-env
sail-proxy opencode                    # starts opencode against the gateway
```

`sail-proxy opencode` writes one `provider.sail-proxy` block into `~/.config/opencode/opencode.json`, with the gateway URL, the API key and the launcher's default deployed GPT model, and leaves any other provider untouched. The previous file is backed up beside it. The launcher prints the `-m sail-proxy/<model>` value to use; everything after `opencode` is passed to opencode unchanged, so a non-interactive run looks like this:

```bash
sail-proxy opencode run -m sail-proxy/<model> "summarize this repo"
```

## Manual configuration

Add a `sail-proxy` provider to `~/.config/opencode/opencode.json`. Use the `@ai-sdk/openai` package, which drives the Responses API, and the gateway's `/openai/v1` base URL:

```json
{
  "provider": {
    "sail-proxy": {
      "npm": "@ai-sdk/openai",
      "options": { "baseURL": "http://localhost:3000/openai/v1", "apiKey": "sk-demo-your-key" },
      "models": { "gpt-5-mini": {} }
    }
  }
}
```

Then select the model with `-m sail-proxy/<model>`:

```bash
opencode run -m sail-proxy/gpt-5-mini "add error handling to this function"
```

On a Docker or Kyma deployment behind nginx, use `https://sail.example.com/gateway/openai/v1` as `baseURL`.

Use `@ai-sdk/openai`, not `@ai-sdk/openai-compatible`. The compatible package drives Chat Completions, which routes through SAP orchestration streaming and fails for opencode's agent requests; the launcher uses `@ai-sdk/openai` for that reason.

## Troubleshooting

- **`502` on every gateway call**: if your shell sets `http_proxy` or `https_proxy`, set `NO_PROXY=localhost,127.0.0.1` so calls to the local gateway skip that proxy.
- **Model not found**: check that the model is listed under the provider's `models` and that the gateway lists it (`GET /openai/v1/models`).
- **401 from the gateway**: opencode sends `apiKey` as the `Authorization: Bearer` token; it must be a gateway API key, not an upstream provider key.

For other problems, see [Troubleshooting](/guide/troubleshooting) and the [FAQ](/guide/faq).
