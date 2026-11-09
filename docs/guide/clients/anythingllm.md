---
title: AnythingLLM
description: Connect AnythingLLM to the gateway as a Generic OpenAI provider.
---

# AnythingLLM

[AnythingLLM](https://github.com/Mintplex-Labs/anything-llm) is an open-source chat front end with document chat (RAG), web search and MCP. It connects to the gateway as a **Generic OpenAI** provider. Each AnythingLLM workspace names one model, so create a workspace per model you want to use.

## Connection settings

In AnythingLLM's LLM preferences, choose **Generic OpenAI** and set:

- **Base URL**: `<gateway>/openai/v1`, for example `http://localhost:3000/openai/v1`.
- **API Key**: a gateway API key.
- **Model**: a model id from `GET /v1/models`, for example `gpt-5-mini`.
- **Token context window** and **Max Tokens**: the model's context length and output limit as the Model Library shows them.

## Local test with Docker

Run AnythingLLM in a container next to a gateway on the host (port 3000). On Windows with PowerShell:

```powershell
$env:STORAGE_LOCATION="$HOME\Documents\anythingllm"; `
If(!(Test-Path $env:STORAGE_LOCATION)) {New-Item $env:STORAGE_LOCATION -ItemType Directory}; `
If(!(Test-Path "$env:STORAGE_LOCATION\.env")) {New-Item "$env:STORAGE_LOCATION\.env" -ItemType File}; `
docker run -d -p 3001:3001 `
--cap-add SYS_ADMIN `
-v "$env:STORAGE_LOCATION`:/app/server/storage" `
-v "$env:STORAGE_LOCATION\.env:/app/server/.env" `
-e STORAGE_DIR="/app/server/storage" `
mintplexlabs/anythingllm;
```

Open `http://localhost:3001` and configure the Generic OpenAI provider. Inside the container, `localhost` is the container itself, so the base URL must name the host:

- Docker Desktop: `http://host.docker.internal:3000/openai/v1`
- Rancher Desktop: `http://host.rancher-desktop.internal:3000/openai/v1`
- Other runtimes: the host's IP address, or `--add-host=host.docker.internal:host-gateway` on the `docker run` line (Linux).
