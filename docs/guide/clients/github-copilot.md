---
title: GitHub Copilot
description: Use GitHub Copilot in VS Code through the Ollama-compatible and OpenRouter endpoints.
---

# GitHub Copilot

GitHub Copilot Chat in VS Code lets you bring your own model provider ("Manage Models" in the chat model picker). Of the providers it offers, only Ollama has a configurable base URL, so the gateway can be reached two ways:

- **OpenRouter provider**, after redirecting the extension's OpenRouter URL to the gateway's `/openrouter/api/v1` endpoint with a patch script. Supports agent mode.
- **Ollama provider**, pointed at the gateway's Ollama-compatible service. No patch, but no agent mode.

This works with the GitHub Copilot Chat VS Code extension only. The GitHub Copilot CLI has no setting for a custom API endpoint and cannot be redirected to the gateway.

## Prerequisites

- A running gateway (see [Quick start](/guide/quick-start)) and a gateway API key.
- The GitHub Copilot Chat extension in VS Code, signed in with a GitHub account that has a Copilot license. Copilot requires its own license even when you bring your own model provider.
- Node.js and a checkout of the sail-proxy repository, for the patch script.

## OpenRouter provider (patched)

`cli-tools/patch-copilot-chat.js` replaces `https://openrouter.ai/api/v1` in the Copilot Chat extension with the gateway's OpenRouter endpoint.

1. Check that the gateway answers:

   ```bash
   curl http://localhost:3000/health
   ```

2. From the repository checkout, run the patch script. Without arguments it uses `http://localhost:3000/openrouter/api/v1`; pass `--base_url` for any other gateway:

   ```bash
   node cli-tools/patch-copilot-chat.js
   node cli-tools/patch-copilot-chat.js --base_url=https://sail.example.com/gateway/openrouter/api/v1
   ```

   The script finds `dist/extension.js` of the `github.copilot-chat-*` extension under `~/.vscode/extensions` or `~/.vscode-insiders/extensions` (and the Windows profile from WSL), saves an unpatched copy as `extension.js.bak` the first time, and applies the patch.

3. Restart VS Code so the patched extension loads.

4. In the Copilot Chat panel, open the model picker, choose **Manage Models**, select **OpenRouter**, enter your gateway API key and pick the models to use. The list comes from the gateway's `/openrouter/api/v1/models`.

5. Send a chat message. With the standalone CLI, `sail-proxy logs gateway --follow` shows the requests arriving on `/openrouter/api/v1`.

Patching the extension is at your own risk. An update of the Copilot Chat extension replaces the patched file; run the script again after each update.

### Reverting the patch

Running the script again with the same `--base_url` reverts the patch. You can also restore the backup:

```bash
cp ~/.vscode/extensions/github.copilot-chat-*/dist/extension.js.bak \
   ~/.vscode/extensions/github.copilot-chat-*/dist/extension.js
```

## Ollama provider (no patch)

The gateway ships an Ollama-compatible service on port 11434 that translates Ollama requests for the gateway. Copilot Chat's Ollama provider uses `http://localhost:11434` by default, so it finds the service without configuration.

1. Start the Ollama service:
   - **Standalone CLI**: `sail-proxy ollama start` (or answer yes to the Ollama autostart question of the CLI setup, `OLLAMA_AUTOSTART=true`, so `sail-proxy run` starts it).
   - **Docker**: the `ollama` service of the Docker Compose stack is optional (profile `ollama`); start it with `docker compose -f docker/docker-compose.yml --profile ollama up -d`, and it publishes port 11434 on the host.

2. In the Copilot Chat panel, open the model picker, choose **Manage Models**, select **Ollama** and pick a model from the list.

The Ollama service supports `POST /api/chat`, `POST /api/generate`, `POST /api/embed`, `GET /api/tags`, `GET /api/ps`, `POST /api/show` and `GET /api/version`, plus the OpenAI-style `POST /v1/chat/completions`, `GET /v1/models` and `POST /v1/embeddings`. Model management (`/api/create`, `/api/pull`, `/api/push`) answers `501`.

With the Ollama provider, Copilot offers no agent mode, and chat responses sometimes render incorrectly. Use the OpenRouter provider when you need agent mode.

## Known limitations

- **Agent mode** works through the OpenRouter provider, best with OpenAI models. Copilot may not offer tools for a model whose OpenRouter listing does not announce tool support. Ask mode is the most reliable; Edit mode works most of the time.
- **`max_tokens`**: Copilot does not send `max_tokens` through the OpenRouter provider, but Anthropic models on SAP AI Core require it. The gateway fills it from `api_config.providers.openrouter.model_mappings` (4096 for the `anthropic` prefix in the shipped configuration).
- **New models** sometimes need to be confirmed twice in **Manage Models** before they appear in the picker.
- **Changed API key**: the OpenRouter provider sometimes keeps sending the previous key after you enter a new one.
- **Open files**: the model does not always see the file open in the editor. Drag the file into the chat input to attach it.

## Troubleshooting

**The patch does not take effect.** Check that the extension and the backup exist, then fully quit VS Code (not just reload the window) and start it again:

```bash
ls ~/.vscode/extensions/ | grep copilot-chat
ls ~/.vscode/extensions/github.copilot-chat-*/dist/extension.js.bak
```

If the script reports `Neither the original nor the patched string found`, the extension was patched with a different `--base_url`; restore the backup and patch again.

**The gateway rejects requests.** Test the OpenRouter endpoint with your key:

```bash
curl http://localhost:3000/openrouter/api/v1/models \
  -H "Authorization: Bearer sk-demo-your-key"
```

For other problems, see [Troubleshooting](/guide/troubleshooting) and the [FAQ](/guide/faq).
