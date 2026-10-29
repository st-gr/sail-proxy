---
title: Ollama API
description: The endpoints, request mapping, configuration and limits of the Ollama-compatible service that forwards Ollama requests to the gateway.
---

# Ollama API

The Ollama-compatible service (`services/ollama`) lets clients built for the Ollama API, such as [GitHub Copilot](/guide/clients/github-copilot)'s Ollama provider, use the gateway. It is a separate process on port `11434`, the standard Ollama port. It translates each Ollama request into an OpenAI request, sends it to the gateway with its own gateway API key, and translates the answer back.

- **Standalone CLI**: `sail-proxy ollama start`, or `OLLAMA_AUTOSTART=true` to start it with `sail-proxy run` ([Standalone CLI](/deploy/cli#ollama-service)). The CLI creates and maintains its API key.
- **Docker**: the optional `ollama` service of the Compose stack, started with `docker compose -f docker/docker-compose.yml --profile ollama up -d`; it then publishes port 11434 on the host ([Docker Compose](/deploy/docker)).

The [API reference](/reference/api) has the same endpoints as an OpenAPI document (select Ollama).

## Endpoints

| Method | Path | Behaviour |
|---|---|---|
| `POST` | `/api/chat` | Chat, streamed by default; `"stream": false` for one response. Forwarded to the gateway's `/openai/v1/chat/completions` |
| `POST` | `/api/generate` | Text generation, streamed by default. Turned into a chat request (`system`, `prompt`, `images`). An empty `prompt` is answered as a model load (`done_reason: "load"`) without a model call |
| `POST` | `/api/embed` | Embeddings, forwarded to the gateway's `/openai/v1/embeddings` |
| `GET` | `/api/tags` | The gateway's models (`/v1/models`) in Ollama format |
| `POST` | `/api/show` | One model's details and capabilities; `model` is required |
| `GET` | `/api/ps` | Always an empty list: no models are loaded locally |
| `GET` | `/api/version` | Version information |
| `POST` | `/v1/chat/completions` | OpenAI-style chat, mapped through the Ollama chat path |
| `GET` | `/v1/models` | OpenAI-style model list |
| `POST` | `/v1/embeddings` | OpenAI-style embeddings |
| `GET` | `/health` | Health check |
| `GET` | `/` | Service information |

Model management is not available; these answer `501`:

| Method | Path |
|---|---|
| `POST` | `/api/create`, `/api/pull`, `/api/push`, `/api/copy` |
| `DELETE` | `/api/delete` |
| `POST` | `/api/blobs/{digest}` |

`HEAD /api/blobs/{digest}` answers `404`. Any other path answers `404`. That includes `/api/embeddings`, the older Ollama embeddings path: use `/api/embed`.

## Examples

List the models:

```bash
curl http://localhost:11434/api/tags
```

Chat, streamed:

```bash
curl http://localhost:11434/api/chat -d '{
  "model": "gemini-3.5-flash-lite",
  "messages": [
    {"role": "user", "content": "Why is the sky blue?"}
  ]
}'
```

Chat, one response:

```bash
curl http://localhost:11434/api/chat -d '{
  "model": "gemini-3.5-flash-lite",
  "messages": [
    {"role": "user", "content": "Explain quantum computing in one paragraph."}
  ],
  "stream": false
}'
```

Generation with JSON output:

```bash
curl http://localhost:11434/api/generate -d '{
  "model": "gemini-3.5-flash-lite",
  "prompt": "List 3 colors in JSON format",
  "format": "json",
  "stream": false
}'
```

Structured output with a JSON schema:

```bash
curl http://localhost:11434/api/chat -d '{
  "model": "gemini-3.5-flash-lite",
  "messages": [{"role": "user", "content": "Give me a person with age and name"}],
  "format": {
    "type": "object",
    "properties": {
      "name": {"type": "string"},
      "age": {"type": "integer"}
    },
    "required": ["name", "age"]
  },
  "stream": false
}'
```

Embeddings:

```bash
curl http://localhost:11434/api/embed -d '{
  "model": "text-embedding-3-small",
  "input": "The quick brown fox jumps over the lazy dog"
}'
```

An image, base64-encoded, with `/api/generate`:

```bash
curl http://localhost:11434/api/generate -d '{
  "model": "gemini-3.8-flash",
  "prompt": "What is in this image?",
  "images": ["<base64-encoded JPEG>"],
  "stream": false
}'
```

Images are sent to the model as `data:image/jpeg;base64,…`.

## Request and response formats

A chat request:

```json
{
  "model": "gemini-3.5-flash-lite",
  "messages": [
    {"role": "user", "content": "Hello"}
  ],
  "stream": true,
  "options": {
    "temperature": 0.7,
    "top_p": 0.9,
    "num_predict": 100,
    "stop": ["stop_word"],
    "seed": 42
  },
  "format": "json"
}
```

A non-streamed chat response:

```json
{
  "model": "gemini-3.5-flash-lite",
  "created_at": "2026-01-01T12:00:00.000Z",
  "message": {
    "role": "assistant",
    "content": "Hello! How can I help you today?",
    "tool_calls": null
  },
  "done_reason": "stop",
  "done": true,
  "total_duration": 0,
  "load_duration": 0,
  "prompt_eval_count": 26,
  "prompt_eval_duration": 0,
  "eval_count": 298,
  "eval_duration": 0
}
```

A streamed response is a sequence of such JSON objects, one per line; the last one has `"done": true`.

### Ollama to OpenAI

| Ollama | OpenAI | Notes |
|---|---|---|
| `options.temperature` | `temperature` | |
| `options.top_p` | `top_p` | |
| `options.top_k` | `top_k` | Passed on as is |
| `options.num_predict` | `max_tokens` | |
| `options.stop` | `stop` | Always sent as an array |
| `options.seed` | `seed` | |
| `options.presence_penalty`, `options.frequency_penalty` | same names | |
| `format: "json"` | `response_format: {"type": "json_object"}` | JSON mode |
| `format: {schema}` | `response_format: {"type": "json_schema", …}` | Structured output |
| `tools` | `tools` | |
| `images` on `/api/generate` | `image_url` content parts | |

### OpenAI to Ollama

| OpenAI | Ollama |
|---|---|
| `choices[0].message` | `message` |
| `choices[0].finish_reason` | `done_reason` |
| `usage.prompt_tokens` | `prompt_eval_count` |
| `usage.completion_tokens` | `eval_count` |
| stream chunks | one JSON object per line |

## Configuration

The service reads `services/ollama/.env` (template: `services/ollama/.env.sample`):

| Variable | Default | Description |
|---|---|---|
| `OLLAMA_PORT` | `11434` | Port the service listens on |
| `OLLAMA_HOST` | `localhost` | Host the service binds to |
| `MAIN_PROXY_URL` | `http://localhost:3000` | Gateway root |
| `MAIN_PROXY_API_KEY` | | Gateway API key the service sends as `x-api-key` |
| `OPENAI_API_KEY` | | Used instead when `MAIN_PROXY_API_KEY` is not set, by every route including `/api/show` |
| `DEBUG` | unset | Verbose logging |
| `REQUEST_TIMEOUT` | `120000` | Timeout of non-streamed requests to the gateway, in milliseconds; streamed requests have none |

## Limitations

- **No client authentication.** The service checks no credential and allows requests from any origin; every request reaches the gateway with the service's own API key, and usage is recorded against that key. Expose port `11434` only where every caller may use that key.
- **No model management.** Models are the gateway's; create, pull, push, copy, delete and blob operations answer `501` (blob checks `404`).
- **No timing data.** Duration fields (`total_duration`, `eval_duration` and the others) are always `0`, and the final streamed object carries zero token counts.
- **Images on `/api/generate` only.** An `images` field on a `/api/chat` message is passed on unchanged and is not turned into image content.
- **`keep_alive` has no effect.**
- **Gateway failures are passed on, not hidden.** A gateway refusal (`400` for a request it rejects, such as an over-long embeddings input, `401`, `403`, `404` or `429`) is answered with the gateway's own status and message. A gateway that cannot be reached, times out or fails with a `5xx` is answered `502`; this includes `/api/tags` and `/v1/models`, which never list a model the gateway does not have. Errors are `{"error": {"message", "type", "code"}}`.
- **Always name a model.** Without `model`, the service falls back to `gpt-3.5-turbo` (chat) or `text-embedding-ada-002` (embeddings), which a gateway usually does not offer.
