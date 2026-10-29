---
title: API endpoints
description: Every HTTP and WebSocket route the gateway serves, with its method, the upstream that answers it and the credential it takes.
---

# API endpoints

Paths are relative to the gateway root: `http://localhost:3000` for the standalone CLI and for direct access to the Docker gateway, `https://<your-domain>/gateway` behind the nginx of a Docker or Kyma deployment (for example `https://sail.example.com/gateway`). The Ollama-compatible endpoints are served by a separate service; see [Ollama API](/reference/ollama-api).

"Orchestration" means the request goes through SAP AI Core's orchestration service. "Deployment" means it goes straight to a model deployment in your resource group (the `--deployed` models of the Model Library).

The [API reference](/reference/api) shows the same routes with their parameters and responses. The Realtime API is a WebSocket, not an HTTP route, and is not in the tables: it is served at `/openai/v1/realtime` and `/v1/realtime` ([OpenAI Realtime API](/guide/clients/realtime)). The Files, Uploads and Vector Stores routes need the file search database ([File storage](/deploy/file-storage)).

<!-- generated:endpoints:start -->

## OpenAI

| Method | Path | Upstream |
|---|---|---|
| `POST` | `/openai/v1/chat/completions`<br>also `/openai/api/v1/chat/completions` | Orchestration; a --deployed OpenAI or Perplexity model goes to its deployment |
| `POST` | `/openai/v1/embeddings`<br>also `/openai/api/v1/embeddings` | Orchestration embeddings |
| `POST` | `/openai/v1/responses`<br>also `/openai/api/v1/responses` | Deployment for a deployed GPT-5 or later or o-series model; orchestration for other models |
| `POST` | `/openai/v1/images/generations`<br>also `/openai/api/v1/images/generations` | Deployed Gemini image model (JSON body) |
| `POST` | `/openai/v1/images/edits`<br>also `/openai/api/v1/images/edits` | Deployed Gemini image model (multipart body) |
| `POST`, `GET` | `/openai/v1/files`<br>also `/openai/api/v1/files`, `/openrouter/api/v1/files` | Gateway file store for the file_search tool |
| `GET`, `DELETE` | `/openai/v1/files/{id}`<br>also `/openai/api/v1/files/{id}`, `/openrouter/api/v1/files/{id}` | Gateway file store for the file_search tool |
| `GET` | `/openai/v1/files/{id}/content`<br>also `/openai/api/v1/files/{id}/content`, `/openrouter/api/v1/files/{id}/content` | Gateway file store for the file_search tool |
| `POST` | `/openai/v1/uploads`<br>also `/openai/api/v1/uploads`, `/openrouter/api/v1/uploads` | Gateway file store for the file_search tool |
| `POST` | `/openai/v1/uploads/{id}/parts`<br>also `/openai/api/v1/uploads/{id}/parts`, `/openrouter/api/v1/uploads/{id}/parts` | Gateway file store for the file_search tool |
| `POST` | `/openai/v1/uploads/{id}/complete`<br>also `/openai/api/v1/uploads/{id}/complete`, `/openrouter/api/v1/uploads/{id}/complete` | Gateway file store for the file_search tool |
| `POST` | `/openai/v1/uploads/{id}/cancel`<br>also `/openai/api/v1/uploads/{id}/cancel`, `/openrouter/api/v1/uploads/{id}/cancel` | Gateway file store for the file_search tool |
| `POST`, `GET` | `/openai/v1/vector_stores`<br>also `/openai/api/v1/vector_stores`, `/openrouter/api/v1/vector_stores` | Gateway file store for the file_search tool |
| `GET`, `POST`, `DELETE` | `/openai/v1/vector_stores/{id}`<br>also `/openai/api/v1/vector_stores/{id}`, `/openrouter/api/v1/vector_stores/{id}` | Gateway file store for the file_search tool |
| `POST`, `GET` | `/openai/v1/vector_stores/{id}/files`<br>also `/openai/api/v1/vector_stores/{id}/files`, `/openrouter/api/v1/vector_stores/{id}/files` | Gateway file store for the file_search tool |
| `GET`, `POST`, `DELETE` | `/openai/v1/vector_stores/{id}/files/{file_id}`<br>also `/openai/api/v1/vector_stores/{id}/files/{file_id}`, `/openrouter/api/v1/vector_stores/{id}/files/{file_id}` | Gateway file store for the file_search tool |
| `GET` | `/openai/v1/vector_stores/{id}/files/{file_id}/content`<br>also `/openai/api/v1/vector_stores/{id}/files/{file_id}/content`, `/openrouter/api/v1/vector_stores/{id}/files/{file_id}/content` | Gateway file store for the file_search tool |
| `POST` | `/openai/v1/vector_stores/{id}/file_batches`<br>also `/openai/api/v1/vector_stores/{id}/file_batches`, `/openrouter/api/v1/vector_stores/{id}/file_batches` | Gateway file store for the file_search tool |
| `GET` | `/openai/v1/vector_stores/{id}/file_batches/{batch_id}`<br>also `/openai/api/v1/vector_stores/{id}/file_batches/{batch_id}`, `/openrouter/api/v1/vector_stores/{id}/file_batches/{batch_id}` | Gateway file store for the file_search tool |
| `POST` | `/openai/v1/vector_stores/{id}/file_batches/{batch_id}/cancel`<br>also `/openai/api/v1/vector_stores/{id}/file_batches/{batch_id}/cancel`, `/openrouter/api/v1/vector_stores/{id}/file_batches/{batch_id}/cancel` | Gateway file store for the file_search tool |
| `GET` | `/openai/v1/vector_stores/{id}/file_batches/{batch_id}/files`<br>also `/openai/api/v1/vector_stores/{id}/file_batches/{batch_id}/files`, `/openrouter/api/v1/vector_stores/{id}/file_batches/{batch_id}/files` | Gateway file store for the file_search tool |
| `POST` | `/openai/v1/vector_stores/{id}/search`<br>also `/openai/api/v1/vector_stores/{id}/search`, `/openrouter/api/v1/vector_stores/{id}/search` | Gateway file store for the file_search tool |

The Files, Uploads and Vector Stores routes need the file search database; without it they answer `503 file_search_unavailable`.

## Anthropic

| Method | Path | Upstream |
|---|---|---|
| `POST` | `/anthropic/v1/messages` | Orchestration; a --deployed Anthropic model goes to its deployment |
| `POST` | `/anthropic/v1/messages/count_tokens` | Counted in the gateway, no upstream call |
| `GET` | `/anthropic/v1/models` | The Claude models the key may use, in Anthropic's list format |
| `GET` | `/anthropic/v1/models/{model_id}` | One of the Claude models the key may use |
| `POST` | `/anthropic/v1/complete` | Same handler as /anthropic/v1/messages; takes a Messages request body |
| `POST` | `/anthropic/v1/messages-beta` | Same handler as /anthropic/v1/messages |

## Google Gemini

| Method | Path | Upstream |
|---|---|---|
| `POST` | `/google/v1beta/models/{modelAndMethod}`<br>also `/google/v1/models/{modelAndMethod}` | Deployed Gemini model, or orchestration; :embedContent goes to an embedding model |

`{modelAndMethod}` is `<model>:generateContent`, `<model>:streamGenerateContent` or `<model>:embedContent`. Any other path or method under `/google` (for example `:countTokens`) answers `404` in the Gemini error format.

## AWS Bedrock

| Method | Path | Upstream |
|---|---|---|
| `POST` | `/aws-bedrock/model/{modelId}/{subpath}` | Deployment for a --deployed model, orchestration otherwise |

`{subpath}` is `invoke`, `invoke-with-response-stream`, `converse` or `converse-stream`; any other answers `400` with the list of valid ones.

A model without a deployment is served through orchestration on all four subpaths, with one exception: `invoke` and `invoke-with-response-stream` take the model's native request body, which the gateway translates only for Claude models. For other models, such as Amazon Nova, use `converse` or `converse-stream`; `invoke` answers `400`.

The two streamed subpaths answer in AWS's binary event stream (`application/vnd.amazon.eventstream`), as Bedrock does: `invoke-with-response-stream` sends each model event as a `chunk` with base64 `bytes`, and `converse-stream` sends Converse events. An error after the stream has started arrives as an exception message.

## OpenRouter

| Method | Path | Upstream |
|---|---|---|
| `POST` | `/openrouter/api/v1/chat/completions` | As /openai/v1/chat/completions |
| `POST` | `/openrouter/api/v1/completions` | Handled like chat completions |
| `POST` | `/openrouter/api/v1/responses` | As /openai/v1/responses |
| `GET` | `/openrouter/api/v1/models` | Model list in OpenRouter format |
| `GET` | `/openrouter/api/v1/models/{author}/{slug}/endpoints` | Model list from SAP AI Core, in OpenRouter's endpoints format |
| `GET` | `/openrouter/api/v1/generation` | None: the gateway answers a status not_implemented placeholder |
| `GET` | `/openrouter/api/v1/credits` | None: the gateway answers a status not_implemented placeholder |

## SAP-RPT

| Method | Path | Upstream |
|---|---|---|
| `POST` | `/sap/v1/rpt/{model}/predict` | Deployed SAP-RPT model, JSON rows |
| `POST` | `/sap/v1/rpt/{model}/predict-parquet` | Deployed SAP-RPT model, Parquet file |

## Models and health

| Method | Path | Upstream |
|---|---|---|
| `GET` | `/v1/models`<br>also `/openai/v1/models` | Model list from SAP AI Core |
| `GET` | `/v1/models/{model_id}`<br>also `/openai/v1/models/{model_id}` | One model of the model list from SAP AI Core |
| `POST` | `/v1/models/cache/clear`<br>also `/openai/v1/models/cache/clear` | The gateway's in-memory model cache, no upstream call |
| `GET` | `/health` | The gateway |
| `GET` | `/` | The gateway |

## Administration

These routes are for operating the gateway, not for clients. [API authentication](/reference/authentication#administration-endpoints) says where each of them is served and who may call it.

| Method | Path | Upstream |
|---|---|---|
| `GET`, `PATCH`, `PUT` | `/api/admin/api-config` | Gateway configuration (api_config.json) |
| `GET` | `/api/admin/api-config/deployment-status` | Gateway configuration (api_config.json) |
| `DELETE`, `GET` | `/api/admin/api-config/rate-limits` | Gateway configuration (api_config.json) |
| `POST` | `/api/admin/api-config/reset` | Gateway configuration (api_config.json) |
| `GET`, `POST` | `/api/admin/api-keys` | Gateway API key store |
| `POST` | `/api/admin/api-keys/revoke-by-email` | Gateway API key store |
| `GET`, `PATCH` | `/api/admin/api-keys/{id}` | Gateway API key store |
| `PATCH` | `/api/admin/api-keys/{key}/revoke` | Gateway API key store |
| `GET` | `/api/admin/connections/{id}/models` | The Connection's provider (Azure OpenAI, OpenAI) |
| `POST` | `/api/admin/connections/{id}/test` | The Connection's provider (Azure OpenAI, OpenAI) |
| `GET`, `POST` | `/api/admin/deployments` | SAP AI Core deployments API |
| `GET` | `/api/admin/deployments/{id}` | SAP AI Core deployments API |
| `GET` | `/api/admin/grounding/admin/blob-storage` | Gateway file store for the file_search tool |
| `POST` | `/api/admin/grounding/admin/blob-storage/migrate` | Gateway file store for the file_search tool |
| `POST` | `/api/admin/grounding/admin/blob-storage/test` | Gateway file store for the file_search tool |
| `GET` | `/api/admin/grounding/admin/failed` | Gateway file store for the file_search tool |
| `GET` | `/api/admin/grounding/admin/files` | Gateway file store for the file_search tool |
| `DELETE` | `/api/admin/grounding/admin/files/{id}` | Gateway file store for the file_search tool |
| `GET` | `/api/admin/grounding/admin/jobs` | Gateway file store for the file_search tool |
| `GET` | `/api/admin/grounding/admin/jobs/{job_id}` | Gateway file store for the file_search tool |
| `POST` | `/api/admin/grounding/admin/jobs/{job_id}/cancel` | Gateway file store for the file_search tool |
| `GET` | `/api/admin/grounding/admin/jobs/{job_id}/failures` | Gateway file store for the file_search tool |
| `POST` | `/api/admin/grounding/admin/jobs/{job_id}/retry` | Gateway file store for the file_search tool |
| `GET` | `/api/admin/grounding/admin/overview` | Gateway file store for the file_search tool |
| `POST` | `/api/admin/grounding/admin/reembed-outdated` | Gateway file store for the file_search tool |
| `GET` | `/api/admin/grounding/admin/reembed-outdated/estimate` | Gateway file store for the file_search tool |
| `GET` | `/api/admin/grounding/admin/storage` | Gateway file store for the file_search tool |
| `GET` | `/api/admin/grounding/admin/stores` | Gateway file store for the file_search tool |
| `DELETE` | `/api/admin/grounding/admin/stores/{id}` | Gateway file store for the file_search tool |
| `POST` | `/api/admin/grounding/admin/stores/{id}/chunking` | Gateway file store for the file_search tool |
| `GET` | `/api/admin/grounding/admin/stores/{id}/chunking/estimate` | Gateway file store for the file_search tool |
| `POST` | `/api/admin/grounding/admin/stores/{id}/files/{file_id}/retry` | Gateway file store for the file_search tool |
| `POST` | `/api/admin/grounding/admin/stores/{id}/reembed` | Gateway file store for the file_search tool |
| `GET` | `/api/admin/grounding/admin/stores/{id}/reembed/estimate` | Gateway file store for the file_search tool |
| `POST` | `/api/admin/grounding/admin/stores/{id}/reextract` | Gateway file store for the file_search tool |
| `GET` | `/api/admin/grounding/admin/stores/{id}/reextract/estimate` | Gateway file store for the file_search tool |
| `POST` | `/api/admin/grounding/admin/stores/{id}/share` | Gateway file store for the file_search tool |
| `POST` | `/api/admin/grounding/admin/stores/{id}/unshare` | Gateway file store for the file_search tool |
| `DELETE` | `/api/admin/grounding/admin/teams/{teamId}/shares` | Gateway file store for the file_search tool |
| `GET` | `/api/admin/grounding/file-attachments` | Gateway file store for the file_search tool |
| `GET`, `POST` | `/api/admin/grounding/files` | Gateway file store for the file_search tool |
| `DELETE`, `GET` | `/api/admin/grounding/files/{id}` | Gateway file store for the file_search tool |
| `GET` | `/api/admin/grounding/files/{id}/content` | Gateway file store for the file_search tool |
| `GET` | `/api/admin/grounding/jobs` | Gateway file store for the file_search tool |
| `GET` | `/api/admin/grounding/jobs/{job_id}` | Gateway file store for the file_search tool |
| `POST` | `/api/admin/grounding/jobs/{job_id}/cancel` | Gateway file store for the file_search tool |
| `GET` | `/api/admin/grounding/jobs/{job_id}/failures` | Gateway file store for the file_search tool |
| `POST` | `/api/admin/grounding/jobs/{job_id}/retry` | Gateway file store for the file_search tool |
| `GET` | `/api/admin/grounding/status` | Gateway file store for the file_search tool |
| `GET` | `/api/admin/grounding/storage` | Gateway file store for the file_search tool |
| `GET`, `POST` | `/api/admin/grounding/stores` | Gateway file store for the file_search tool |
| `DELETE`, `GET`, `POST` | `/api/admin/grounding/stores/{id}` | Gateway file store for the file_search tool |
| `POST` | `/api/admin/grounding/stores/{id}/chunking` | Gateway file store for the file_search tool |
| `GET` | `/api/admin/grounding/stores/{id}/chunking/estimate` | Gateway file store for the file_search tool |
| `POST` | `/api/admin/grounding/stores/{id}/file_batches` | Gateway file store for the file_search tool |
| `GET` | `/api/admin/grounding/stores/{id}/file_batches/{batch_id}` | Gateway file store for the file_search tool |
| `POST` | `/api/admin/grounding/stores/{id}/file_batches/{batch_id}/cancel` | Gateway file store for the file_search tool |
| `GET` | `/api/admin/grounding/stores/{id}/file_batches/{batch_id}/files` | Gateway file store for the file_search tool |
| `GET`, `POST` | `/api/admin/grounding/stores/{id}/files` | Gateway file store for the file_search tool |
| `DELETE`, `GET`, `POST` | `/api/admin/grounding/stores/{id}/files/{file_id}` | Gateway file store for the file_search tool |
| `GET` | `/api/admin/grounding/stores/{id}/files/{file_id}/content` | Gateway file store for the file_search tool |
| `POST` | `/api/admin/grounding/stores/{id}/files/{file_id}/retry` | Gateway file store for the file_search tool |
| `POST` | `/api/admin/grounding/stores/{id}/reembed` | Gateway file store for the file_search tool |
| `GET` | `/api/admin/grounding/stores/{id}/reembed/estimate` | Gateway file store for the file_search tool |
| `POST` | `/api/admin/grounding/stores/{id}/reextract` | Gateway file store for the file_search tool |
| `GET` | `/api/admin/grounding/stores/{id}/reextract/estimate` | Gateway file store for the file_search tool |
| `POST` | `/api/admin/grounding/stores/{id}/search` | Gateway file store for the file_search tool |
| `POST` | `/api/admin/grounding/stores/{id}/share-team` | Gateway file store for the file_search tool |
| `POST` | `/api/admin/grounding/stores/{id}/unshare-team` | Gateway file store for the file_search tool |
| `GET`, `POST` | `/aws/api-keys` | Gateway AWS credential store |
| `PATCH` | `/aws/api-keys/set-keys` | Gateway AWS credential store |
| `DELETE` | `/aws/api-keys/{accessKeyId}` | Gateway AWS credential store |

## Credentials per route

Header names, precedence and the SigV4 rules are on [API authentication](/reference/authentication); the administration routes have [their own rules](/reference/authentication#administration-endpoints).

- **Gateway API key or AWS SigV4 signature (gateway-issued AWS credentials):** `POST /openai/v1/chat/completions`, `POST /openai/v1/embeddings`, `POST /openai/v1/responses`, `POST /openai/v1/images/generations`, `POST /anthropic/v1/messages`, `POST /anthropic/v1/messages/count_tokens`, `GET /anthropic/v1/models`, `GET /anthropic/v1/models/{model_id}`, `POST /anthropic/v1/complete`, `POST /anthropic/v1/messages-beta`, `POST /google/v1beta/models/{modelAndMethod}`, `POST /aws-bedrock/model/{modelId}/{subpath}`, `POST /openrouter/api/v1/chat/completions`, `POST /openrouter/api/v1/completions`, `POST /openrouter/api/v1/responses`, `GET /openrouter/api/v1/models`, `GET /openrouter/api/v1/models/{author}/{slug}/endpoints`, `GET /openrouter/api/v1/generation`, `GET /openrouter/api/v1/credits`, `POST /sap/v1/rpt/{model}/predict`, `GET /v1/models`, `GET /v1/models/{model_id}`, `POST /v1/models/cache/clear`
- **Gateway API key (a multipart body cannot be SigV4-signed):** `POST /openai/v1/images/edits`, `POST /sap/v1/rpt/{model}/predict-parquet`
- **Gateway API key of a user (files belong to the key's e-mail; an AWS SigV4 signature carries no owner and is refused); a multipart body cannot be SigV4-signed:** `POST /openai/v1/files`, `POST /openai/v1/uploads/{id}/parts`
- **Gateway API key of a user (files belong to the key's e-mail; an AWS SigV4 signature carries no owner and is refused):** `GET /openai/v1/files`, `GET /openai/v1/files/{id}`, `DELETE /openai/v1/files/{id}`, `GET /openai/v1/files/{id}/content`, `POST /openai/v1/uploads`, `POST /openai/v1/uploads/{id}/complete`, `POST /openai/v1/uploads/{id}/cancel`, `POST /openai/v1/vector_stores`, `GET /openai/v1/vector_stores`, `GET /openai/v1/vector_stores/{id}`, `POST /openai/v1/vector_stores/{id}`, `DELETE /openai/v1/vector_stores/{id}`, `POST /openai/v1/vector_stores/{id}/files`, `GET /openai/v1/vector_stores/{id}/files`, `GET /openai/v1/vector_stores/{id}/files/{file_id}`, `POST /openai/v1/vector_stores/{id}/files/{file_id}`, `DELETE /openai/v1/vector_stores/{id}/files/{file_id}`, `GET /openai/v1/vector_stores/{id}/files/{file_id}/content`, `POST /openai/v1/vector_stores/{id}/file_batches`, `GET /openai/v1/vector_stores/{id}/file_batches/{batch_id}`, `POST /openai/v1/vector_stores/{id}/file_batches/{batch_id}/cancel`, `GET /openai/v1/vector_stores/{id}/file_batches/{batch_id}/files`, `POST /openai/v1/vector_stores/{id}/search`
- **None:** `GET /health`, `GET /`

<!-- generated:endpoints:end -->
