---
title: Other clients
description: Connect any LLM client that takes a custom base URL and API key.
---

# Other clients

Any LLM client that lets you set a **custom base URL** and an **API key** for one of the API families the gateway speaks works with it. Pick the base URL of the family the client is built for and use a gateway API key.

## Base URLs

The gateway root is `http://localhost:3000` for the standalone CLI and for direct access to the Docker gateway, and `https://<your-domain>/gateway` behind the nginx of a Docker or Kyma deployment (for example `http://localhost:8080/gateway` or `https://sail.example.com/gateway`).

| API family | Base URL | Main endpoints below it |
|---|---|---|
| OpenAI | `<root>/openai/v1` | `/models`, `/chat/completions`, `/responses`, `/embeddings`, `/images`, `/files`, `/vector_stores`, `/realtime` |
| Anthropic | `<root>/anthropic` | `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models` |
| Google Gemini | `<root>/google` | `/v1beta/models/<model>:generateContent` (and `:streamGenerateContent`, `:embedContent`) |
| AWS Bedrock | `<root>/aws-bedrock` | `/model/<model>/invoke`, `/invoke-with-response-stream`, `/converse`, `/converse-stream` |
| OpenRouter | `<root>/openrouter/api/v1` | `/models`, `/chat/completions`, `/completions`, `/responses` |
| Ollama | `http://localhost:11434` (separate service) | `/api/chat`, `/api/generate`, `/api/embed`, `/api/tags` |
| SAP-RPT | `<root>/sap/v1/rpt` | `/<model>/predict`, `/<model>/predict-parquet` |

Most clients send the key as `Authorization: Bearer <key>`; the gateway also accepts it in an `x-api-key` header (and Gemini clients' `x-goog-api-key`). The AWS Bedrock route also accepts AWS SigV4 signatures made with gateway-issued AWS credentials (see [Claude Code](/guide/clients/claude-code#the-aws-bedrock-route)).

The OpenAI endpoints except `/models` and `/realtime` are also mounted under `<root>/openai/api/v1` for clients that expect that path. The [endpoint reference](/reference/api-endpoints) lists every route.

## Clients with a fixed base URL

Some clients, especially those built for one platform such as OpenRouter, hard-code the provider's base URL and offer no setting to change it. For an open-source client, you can fork it and add a base URL setting; once it points at the gateway it works like any other supported client. [GitHub Copilot](/guide/clients/github-copilot) shows a patch-based variant of this.
