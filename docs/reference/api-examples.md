---
title: API examples
description: Copy-paste curl and AWS CLI examples for chat completions, embeddings, Anthropic messages and token counting, AWS Bedrock, OpenRouter and the configuration API.
---

# API examples

The examples call a gateway on `http://localhost:3000` (the standalone CLI, or the Docker gateway directly). Behind the nginx of a Docker or Kyma deployment, replace it with `https://<your-domain>/gateway`. Set your gateway API key once:

```bash
export SAIL_PROXY_KEY=sk-demo-replace-with-your-key
```

The model names are examples; use any model your deployment offers (`curl -H "Authorization: Bearer $SAIL_PROXY_KEY" http://localhost:3000/v1/models` lists them). Every route is listed under [API endpoints](/reference/api-endpoints). The client pages of the Guide have examples for the [Gemini API](/guide/clients/gemini), the [Realtime API](/guide/clients/realtime) and [tabular prediction](/guide/clients/tabular-prediction).

## OpenAI chat completions

```bash
curl -X POST http://localhost:3000/openai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SAIL_PROXY_KEY" \
  -d '{
    "model": "gemini-3.5-flash-lite",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello, how are you?"}
    ],
    "max_tokens": 100,
    "temperature": 0.7,
    "stream": true
  }'
```

## OpenAI embeddings

```bash
curl -X POST http://localhost:3000/openai/v1/embeddings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SAIL_PROXY_KEY" \
  -d '{
    "input": "Hello, this is a sample text for embedding generation!",
    "model": "text-embedding-3-small",
    "encoding_format": "float"
  }'
```

Response:

```json
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "index": 0,
      "embedding": [-0.002355793, 0.021651842, -0.023071093]
    }
  ],
  "model": "text-embedding-3-small",
  "usage": {
    "prompt_tokens": 12,
    "total_tokens": 12
  }
}
```

(The embedding vector is shortened here.)

- `input` and `model` are required; a missing one answers `400`.
- The model must have the embedding capability, otherwise the answer is `400 model_not_supported`. `/v1/models` shows each model's capabilities.
- `input` is a string or an array of strings; every element is embedded and each result carries the position of its text in `index`. Token arrays and an empty array answer `400 invalid_input`.
- For NVIDIA embedding models the gateway adds `type: "query"` to the request.
- Embeddings go through SAP AI Core orchestration, and every call is recorded with its tokens.

## Anthropic messages

```bash
curl -X POST http://localhost:3000/anthropic/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: $SAIL_PROXY_KEY" \
  -d '{
    "model": "claude-sonnet-4-5-20250929",
    "messages": [
      {"role": "user", "content": "Hello, how are you?"}
    ],
    "system": "You are a helpful assistant.",
    "max_tokens": 100,
    "stream": true
  }'
```

The shipped configuration maps `claude-sonnet-4-5-20250929` to `anthropic--claude-4.5-sonnet--deployed` ([Model substitution](/reference/configuration#model-substitution)), so that deployment must exist in your resource group.

## Anthropic count tokens

Counts the input tokens of a Messages request without calling a model:

```bash
curl -X POST http://localhost:3000/anthropic/v1/messages/count_tokens \
  -H "Content-Type: application/json" \
  -H "x-api-key: $SAIL_PROXY_KEY" \
  -d '{
    "model": "claude-sonnet-4-5-20250929",
    "messages": [
      {"role": "user", "content": "Hello, how are you?"}
    ],
    "system": "You are a helpful assistant."
  }'
```

Response:

```json
{
  "input_tokens": 42
}
```

The count is an estimate made in the gateway with the `gpt-tokenizer` library:

- `model` is required. The name is substituted as for `/messages`.
- Claude models (`claude…` or `anthropic--…` after substitution) are counted with `cl100k_base`, Grok models with `o200k_base`; other models default to `o200k_base`.
- Tool definitions add 346 tokens for Claude and 480 for Grok. The overhead is skipped when the `anthropic-beta` header starts with `claude-code` and a tool name starts with `mcp__`.
- The count is then multiplied by 1.15 for Claude and 1.03 for Grok.
- String and array content, images, `tool_use`, `tool_result` and thinking blocks are counted.

## AWS Bedrock with an API key

```bash
curl -X POST http://localhost:3000/aws-bedrock/model/us.anthropic.claude-haiku-4-5-20251001-v1:0/invoke \
  -H "Content-Type: application/json" \
  -H "x-api-key: $SAIL_PROXY_KEY" \
  -d '{
    "anthropic_version": "bedrock-2023-05-31",
    "max_tokens": 100,
    "messages": [
      {"role": "user", "content": "Hello from Bedrock via API key!"}
    ]
  }'
```

The shipped configuration maps the Bedrock model id `us.anthropic.claude-haiku-4-5-20251001-v1:0` to `anthropic--claude-4.5-haiku--deployed`.

## AWS Bedrock with SigV4

SigV4 requests are signed with AWS-style credentials the gateway issues: in the Admin Cockpit under [AWS credentials](/guide/cockpit/aws-credentials), or on the standalone CLI with `POST /aws/api-keys` ([API authentication](/reference/authentication#aws-credentials-standalone)). For Claude Code's Bedrock mode, see [Claude Code](/guide/clients/claude-code#the-aws-bedrock-route).

With the AWS CLI:

```bash
export AWS_ACCESS_KEY_ID='<access key id from the gateway>'
export AWS_SECRET_ACCESS_KEY='<secret access key from the gateway>'
export AWS_DEFAULT_REGION='us-east-1'

aws bedrock-runtime invoke-model \
  --endpoint-url http://localhost:3000/aws-bedrock \
  --model-id us.anthropic.claude-haiku-4-5-20251001-v1:0 \
  --content-type application/json \
  --accept application/json \
  --cli-binary-format raw-in-base64-out \
  --body '{"anthropic_version":"bedrock-2023-05-31","max_tokens":100,"messages":[{"role":"user","content":"Hello from Bedrock via AWS CLI!"}]}' \
  output.json && cat output.json
```

- `--endpoint-url` is the base path; the AWS CLI appends `/model/{modelId}/invoke` itself.
- The gateway verifies the signature over the JSON body, so the request must be sent as `application/json`.
- `--cli-binary-format raw-in-base64-out` lets AWS CLI version 2 take the body as plain JSON.

## OpenRouter

```bash
curl http://localhost:3000/openrouter/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SAIL_PROXY_KEY" \
  -d '{
    "model": "anthropic/anthropic--claude-4.5-haiku",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

OpenRouter model names carry a provider prefix (`anthropic/…`); the gateway removes it and forwards the rest. Without `max_tokens`, a provider default from the configuration applies (`4096` for `anthropic` in the shipped configuration).

## Changing the configuration

On the standalone CLI, `PATCH /api/admin/api-config` merges a partial configuration into the current one. This raises the [web search cap](/reference/configuration#web-search):

```bash
curl -X PATCH http://localhost:3000/api/admin/api-config \
  -H "Content-Type: application/json" \
  -d '{
    "api_config": {
      "capabilities": {
        "web_search": { "max_searches_per_request": 5 }
      }
    }
  }'
```

Objects are merged key by key, but an array replaces the current array as a whole: to add one entry to `substitute_models`, send the complete list. `GET /api/admin/api-config` returns the current configuration.

The standalone gateway checks no credential on this endpoint. With an admin service, change the configuration in the Admin Cockpit ([Gateway configuration](/guide/cockpit/configuration)). The keys are described in the [Gateway configuration reference](/reference/configuration).
