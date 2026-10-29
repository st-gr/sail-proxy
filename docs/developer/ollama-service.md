---
title: Ollama service
description: "The Ollama-compatible adapter: design, endpoints and tests."
---

# Ollama Service

The Ollama service (`services/ollama`) provides Ollama API compatibility while routing requests through the Gateway to SAP AI Core, so tools built for Ollama can use sail-proxy. This page describes how the service is built and tested; the endpoints, the request and response mappings, the configuration and the limitations are listed in [Ollama API](/reference/ollama-api).

## Service Overview

**Key Features**:
- Ollama API on port 11434 (`OLLAMA_PORT`), bound to `localhost` by default (`OLLAMA_HOST`)
- Request transformation from Ollama format to OpenAI format, and back
- Routing through the Gateway (`MAIN_PROXY_URL`, default `http://localhost:3000`) with the service's own gateway API key (`MAIN_PROXY_API_KEY`, sent as `x-api-key`)
- Chat, generate, embeddings and model listing, plus OpenAI-compatible `/v1` routes
- Plain JavaScript (CommonJS) with Express, `helmet`, `cors`, `morgan` and `axios`; no build step

## Architecture

**Request Flow**:
```
Ollama Client → Ollama Service (11434) → Gateway Service (3000) → SAP AI Core
```

**Module Layout**:

| File | Role |
|------|------|
| `index.js` | Express app: `helmet`, CORS for any origin, `morgan` logging, JSON bodies up to 50 MB, `GET /health`, `GET /`, the routers, the error and 404 handlers, `app.listen(OLLAMA_PORT, OLLAMA_HOST)` |
| `routes/ollamaRoutes.js` | The Ollama API under `/api`: `chat`, `generate`, `embed`, `tags`, `ps`, `show`, `version`, and the model lifecycle and blob routes |
| `routes/openaiRoutes.js` | OpenAI-compatible routes under `/v1`: `chat/completions`, `models`, `embeddings` |
| `controllers/ollamaController.js` | Thin handlers: choose streaming or non-streaming, set the response headers, shape errors; answer the lifecycle and blob routes with 501 |
| `services/ollamaAdapter.js` | The transformations and the calls to the gateway |
| `services/shared.js` | The `axios` client for the gateway (`callMainProxy`, `callMainProxyStreaming`), with `REQUEST_TIMEOUT` (default 120000 ms) for non-streaming calls and no timeout for streams |

**Protocol Translation** (`transformGenerateRequest`):
```typescript
// Ollama format (POST /api/generate)
{
  "model": "gpt-5-mini",
  "prompt": "Why is the sky blue?",
  "system": "Answer in one sentence.",
  "stream": true
}

// Translated to OpenAI format (POST /openai/v1/chat/completions on the gateway)
{
  "model": "gpt-5-mini",
  "messages": [
    {"role": "system", "content": "Answer in one sentence."},
    {"role": "user", "content": "Why is the sky blue?"}
  ],
  "stream": true
}
```

## Format Transformations

**Requests** (`ollamaAdapter.js`):
- `transformChatRequest` maps `/api/chat`: `messages` and `tools` pass through; `options.temperature`, `top_p`, `num_predict` (to `max_tokens`), `stop`, `presence_penalty`, `frequency_penalty` and `seed` become OpenAI parameters; `format: "json"` becomes `response_format: {type: "json_object"}` and a schema object becomes `json_schema`; streaming is the default when `stream` is absent.
- `transformGenerateRequest` maps `/api/generate` to a chat request: `system` becomes a system message, `prompt` the user message, `images` become `image_url` data-URI parts of that message, and a `suffix` becomes an extra system instruction. An empty prompt is answered locally as a model load and never sent to the model.

**Responses**:
- `transformNonStreamingChatResponse` and `transformNonStreamingGenerateResponse` build the Ollama object from `choices[0]`: the message (with `tool_calls`), `done_reason` from `finish_reason`, `prompt_eval_count` and `eval_count` from the usage. Durations are `0`; the gateway does not report them.
- `transformStreamingChatResponse` and `transformStreamingGenerateResponse` turn each OpenAI SSE chunk into one newline-delimited JSON object, and emit a final object with `done: true`.
- `listModels` turns the gateway's `/v1/models` list into Ollama tags: name and model are the gateway model id, `digest` is derived from the name (`generateModelDigest`), and the `details` fields the gateway does not know get Ollama-style defaults. `mapCapabilitiesToOllama` maps the gateway's capabilities to Ollama's `completion` and `vision`.

**OpenAI routes**: `handleOpenAIChat` converts the OpenAI request to an Ollama request, runs it through the same adapter and converts the Ollama result back (`convertOllamaToOpenAIChunk`, `convertOllamaToOpenAIResponse`), so both APIs share one code path. A failure before the first chunk is answered as a JSON error rather than as an SSE frame.

## Error Handling

Every handler answers errors in one shape, with a handler-specific `code` (`chat_error`, `generate_error`, `embeddings_error`, `models_error`, …):

```json
{
  "error": {
    "message": "Error description",
    "type": "api_error",
    "code": "chat_error"
  }
}
```

An unreachable gateway is reported as `Cannot connect to main proxy at <MAIN_PROXY_URL>. Is it running?`; unknown paths get 404 `endpoint_not_found`; the model lifecycle routes (`create`, `pull`, `push`, `delete`, `copy`) and the blob routes answer 501.

## Logging

The service logs every request with `morgan('combined')` and writes the transformed requests and the gateway calls to the console. `DEBUG=true` additionally prints the gateway URL and key configuration at startup (`shared.js`).

## Performance Considerations

- **Double hop**: every request crosses the Ollama service and the gateway before it reaches SAP AI Core; both hops are local in the standard setups.
- **Streaming**: streamed answers are converted chunk by chunk and are not buffered; streaming requests to the gateway have no client-side timeout.
- **Payloads**: JSON bodies up to 50 MB are accepted, for images.

## Development and Testing

### Local Development

**Start Ollama service**:
```bash
# From project root
pnpm run dev:ollama

# From service directory (nodemon index.js)
cd services/ollama
pnpm run dev

# Service available at http://localhost:11434
```

The service reads `services/ollama/.env` (template `services/ollama/.env.sample`). Set `MAIN_PROXY_API_KEY` to a gateway API key. In Docker Compose the `ollama` service (profile `ollama`) overrides `OLLAMA_HOST=0.0.0.0` and `MAIN_PROXY_URL=http://gateway:3000`.

### Tests

```bash
pnpm test:ollama                  # from the project root

cd services/ollama
pnpm test                         # all suites
pnpm test:unit                    # test/unit
pnpm test:integration             # test/integration
pnpm test:coverage
```

- `test/unit/` covers the adapter transformations, the empty-prompt model load, the OpenAI stand-in response, the request timeout and the splitting of streamed chunks.
- `test/integration/` sends requests to a running Ollama service (`OLLAMA_BASE_URL`, else `getOllamaServiceUrl()` from `libs/test-utils`, default `http://localhost:11434`), which in turn needs a running gateway; the model names come from `liveModels` (see [Running and testing the gateway](/developer/gateway-testing#live-call-model-table)).

### Testing with Ollama CLI

```bash
# Point the Ollama CLI at the service
export OLLAMA_HOST=http://localhost:11434

# Model listing
ollama list

# Chat
ollama run gpt-5-mini "Hello, how are you?"
```

### API Testing

```bash
curl http://localhost:11434/health
curl http://localhost:11434/api/tags

curl -X POST http://localhost:11434/api/chat \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-5-mini", "messages": [{"role": "user", "content": "Hello!"}], "stream": false}'

curl -X POST http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-5-mini", "messages": [{"role": "user", "content": "Hello!"}]}'
```

More examples are in [Ollama API](/reference/ollama-api#examples).

## Security Model

The service checks no credential of its own and allows requests from any origin; every request reaches the gateway with the service's API key, and usage is recorded against that key. It binds to `localhost` by default. The Docker Compose `ollama` service binds `0.0.0.0` inside the container and publishes port `11434` on the host, so expose it only where every caller may use that key.

## Contributing

1. Add or change a transformation in `services/ollamaAdapter.js`, keeping the controller thin.
2. Add a unit test under `test/unit/` for the transformation.
3. Run `pnpm test:unit`, and the integration suites against a running service and gateway.
4. Update [Ollama API](/reference/ollama-api) when an endpoint or a mapping changes.
