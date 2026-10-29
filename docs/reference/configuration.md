---
title: Gateway configuration reference
description: The keys of the gateway configuration (api_config.json) for model overrides, cache pricing, model substitution, beta flags, unsupported parameters, web search, parameter renames and streaming emulation.
---

# Gateway configuration reference

The gateway configuration is a JSON document with one root key, `api_config`, and six sections below it: `providers`, `models`, `capabilities`, `hooks`, `platform` and `observability`. The standalone CLI keeps it in `api_config.json` (`CONFIG_FILE_PATH`); with an admin service it is stored there and edited in the Admin Cockpit under [Gateway configuration](/guide/cockpit/configuration). On the standalone CLI the [`/api/admin/api-config`](/reference/api-endpoints#administration) endpoint reads and changes it.

This page covers the keys clients notice most. Every provider key is described on the developer guide's gateway page, and the cockpit's form shows the help text of each key.

## Model overrides

`api_config.models.overrides` holds per-model settings, keyed by the model name as SAP AI Core knows it (for example `anthropic--claude-4.5-haiku--deployed`). An excerpt of the shipped entry for that model:

```json
{
  "api_config": {
    "models": {
      "overrides": {
        "anthropic--claude-4.5-haiku--deployed": {
          "streamingSupported": true,
          "subpaths_native": ["invoke", "invoke-with-response-stream", "converse", "converse-stream"],
          "subpaths_emulated": [],
          "anthropic_version": "bedrock-2023-05-31",
          "cachePricing": {
            "cacheReadInputCostPer1K": "0.00008",
            "cacheCreationInputCostPer1K": "0.00099"
          },
          "hooks": {
            "invoke-with-response-stream": [
              {
                "request": {
                  "match": ["header:x-app=cli"],
                  "callback": { "id": "removeEmptyAssistantMessages" }
                }
              }
            ]
          }
        },
        "amazon--titan-text-express": {
          "streamingSupported": false
        }
      }
    }
  }
}
```

| Key | Type | Meaning |
|---|---|---|
| `streamingSupported` | boolean | Whether the model streams. An explicit value wins; otherwise a `subpaths_native` entry ending in `-stream` means `true` |
| `subpaths_native` | array | The Bedrock subpaths the model serves natively (`invoke`, `invoke-with-response-stream`, `converse`, `converse-stream`). While present, every subpath missing from it is emulated. Absent means `invoke` and `invoke-with-response-stream` |
| `subpaths_emulated` | array | Declarative list of emulated subpaths; routing follows `subpaths_native` |
| `supports_prompt_caching` | boolean | Whether the model receives Anthropic `cache_control` breakpoints. Order: this flag, then the provider's flag, then `true` for Anthropic models and `false` for all others. Set `false` to opt a model out |
| `anthropic_version` | string | The `anthropic_version` put into a Bedrock `invoke` body that carries none. Shipped value `bedrock-2023-05-31` |
| `inject_beta_features` | array | Anthropic beta flags added to the model's Bedrock `invoke` requests, then filtered like every other flag ([Beta flag filtering](#beta-flag-filtering)) |
| `hooks` | object | Plugins armed for this model, keyed by subpath. A subpath listed here replaces the default hooks for that subpath |
| `cachePricing` | object | Cache token prices ([Cache token pricing](#cache-token-pricing)) |
| `unsupported_params` | array | Parameters removed before forwarding ([Unsupported provider parameters](#unsupported-provider-parameters)) |
| `param_renames` | object | Parameter renames for deployments ([Parameter renames](#parameter-renames-for-deployed-models)) |
| `supports_responses_api` | boolean | Whether the model may be served on `/openai/v1/responses`. Absent leaves the built-in rule: deployed GPT-5 and later, and the o-series |
| `contextLength` | integer | Context window in tokens, used only when SAP AI Core reports none |
| `pseudonymization` | object | Per-model pseudonymization settings |

## Cache token pricing

SAP AI Core supports prompt caching but does not return cache token prices. `cachePricing` sets them per model, as decimal strings per 1,000 tokens:

```json
{
  "api_config": {
    "models": {
      "overrides": {
        "anthropic--claude-4.5-sonnet--deployed": {
          "cachePricing": {
            "cacheReadInputCostPer1K": "0.00020",
            "cacheCreationInputCostPer1K": "0.00254"
          }
        }
      }
    }
  }
}
```

| Key | Meaning |
|---|---|
| `cacheReadInputCostPer1K` | Cost per 1,000 cache read tokens |
| `cacheCreationInputCostPer1K` | Cost per 1,000 cache creation (write) tokens |

The shipped configuration carries these values; they are illustrative figures, not your contract prices, so set your own:

| Model | Cache read (per 1K) | Cache creation (per 1K) |
|---|---|---|
| `anthropic--claude-4-sonnet--deployed` | 0.00020 | 0.00254 |
| `anthropic--claude-4-opus--deployed` | 0.00099 | 0.01236 |
| `anthropic--claude-4.5-haiku--deployed` | 0.00008 | 0.00099 |
| `anthropic--claude-4.5-sonnet--deployed` | 0.00020 | 0.00254 |
| `anthropic--claude-4.6-sonnet--deployed` | 0.00020 | 0.00254 |
| `anthropic--claude-4.5-opus--deployed` | 0.00037 | 0.00459 |
| `anthropic--claude-4.6-opus--deployed` | 0.00037 | 0.00459 |
| `anthropic--claude-4.7-opus--deployed` | 0.00037 | 0.00459 |
| `anthropic--claude-4.8-opus--deployed` | 0.00037 | 0.00459 |

**Tiered prices.** For a model whose rates depend on the prompt size, the cache rates go into the tiers of its `complexCost` pricing in the [Model Library](/guide/cockpit/model-library), next to `inputCost`. The tier is chosen from `tierDescription`. Illustrative figures:

```json
[
  {
    "inputCost": "0.00261",
    "cacheReadInputCost": "0.00027",
    "tier": "1",
    "tierDescription": "Less than or equals to 200k tokens per request"
  },
  {
    "inputCost": "0.00501",
    "cacheReadInputCost": "0.00051",
    "tier": "2",
    "tierDescription": "Greater than 200k tokens per request"
  }
]
```

A model without cache rates prices cache read and cache creation tokens at 100% of its regular input rate.

## Model substitution

`substitute_models` under a provider renames the model a client asks for before the request is forwarded:

```json
{
  "api_config": {
    "providers": {
      "anthropic": {
        "substitute_models": [
          { "from": "claude-sonnet-4-5-20250929", "to": "anthropic--claude-4.5-sonnet--deployed" },
          { "from": "claude-haiku-4-5-20251001", "to": "anthropic--claude-4.5-haiku--deployed" }
        ],
        "emulate_streaming_for_models": ["anthropic--claude-4-opus"]
      }
    }
  }
}
```

- `from` matches the requested model name exactly, case included. The first matching entry wins, and renames do not chain.
- Responses and the recorded usage name the model the request was forwarded to.
- Every `to` model must be available in your SAP AI Core resource group.

The shipped configuration maps Claude Code's model names (`anthropic` provider) and the Bedrock model ids (`aws-bedrock` provider) to the SAP AI Core Claude deployments; [Claude Code](/guide/clients/claude-code#models) lists the Claude Code names.

## Beta flag filtering

Anthropic clients such as Claude Code send beta feature flags in the `anthropic-beta` header. SAP AI Core rejects the whole request with `400 invalid beta flag` when a flag is unknown to its Anthropic deployments. Two keys under `api_config.providers.anthropic` filter the flags; they are read only from that provider:

```json
{
  "api_config": {
    "providers": {
      "anthropic": {
        "supported_beta_headers": [
          "claude-code-20250219",
          "context-1m-2025-08-07",
          "interleaved-thinking-2025-05-14",
          "context-management-2025-06-27",
          "effort-2025-11-24",
          "mid-conversation-system-2026-04-07",
          "afk-mode-2026-01-31",
          "fine-grained-tool-streaming-2025-05-14"
        ],
        "excluded_beta_headers": [
          "prompt-caching-scope-2026-01-05",
          "redact-thinking-2026-02-12",
          "thinking-token-count-2026-05-13",
          "structured-outputs-2025-12-15",
          "fallback-credit-2026-06-01"
        ]
      }
    }
  }
}
```

- **`supported_beta_headers`** (allowlist): while it is non-empty, only these flags are forwarded, including flags from a model's `inject_beta_features` or from the request body. Empty or absent means no allowlist: every flag goes through.
- **`excluded_beta_headers`** (denylist): always applied on top of the allowlist. A flag in both lists is dropped.

The values above are the shipped ones. When SAP AI Core starts accepting a new flag, add it to `supported_beta_headers`.

## Unsupported provider parameters

SAP AI Core rejects the whole request when it carries a parameter the provider does not accept, for example:

```
400 - LLM Module: perplexity does not support parameters: ['tools'], for model=sonar
```

Some clients send `tools` or `response_format` with every request. `unsupported_params` lists parameters the gateway removes before forwarding:

```json
{
  "api_config": {
    "providers": {
      "perplexity": {
        "unsupported_params": ["tools", "tool_choice", "response_format"]
      }
    },
    "models": {
      "overrides": {
        "sonar": { "unsupported_params": ["tools", "tool_choice"] }
      }
    }
  }
}
```

- **Provider level**: keyed by the model's provider (`owned_by`, lower case). `perplexity` covers `sonar`, `sonar-pro` and later Perplexity models. The shipped configuration sets the provider list above.
- **Model level**: a list under `models.overrides.<model>` replaces the provider list for that model. `[]` removes nothing for that model.
- Absent at both levels, nothing is removed.

Removed parameters are logged at `WARN` with the provider, model and parameter names. This applies to orchestration and to `--deployed` models.

## Web search

SAP AI Core deployments do not run hosted web search tools such as `{"type": "web_search"}` on `/openai/v1/responses`, which Codex CLI sends. The gateway turns the hosted tool into a function tool the deployment accepts, runs the search itself through Perplexity `sonar-pro`, and calls the model again with the results, so the turn ends with the model's own answer. When streaming, the second call's events are spliced into the same stream: the client sees one `response.created` and one `response.completed`.

Every search adds a model call, so the number of searches per request is capped:

```json
{
  "api_config": {
    "capabilities": {
      "web_search": {
        "max_searches_per_request": 3
      }
    }
  }
}
```

- Default `3`, valid `1` to `10`. A missing, non-integer or out-of-range value falls back to `3`.
- Reaching the cap does not fail the request: the results of the searches that ran are returned as a formatted message instead of a further model pass.
- The tokens of the follow-up calls are included in the request's usage event and in the `usage` of the response.

## Parameter renames for deployed models

Requests to `--deployed` models go straight to the deployment, without SAP orchestration's parameter normalisation. The GPT-5 family and later and the o-series reject `max_tokens` and require `max_completion_tokens`. The gateway renames it by model name, for OpenAI deployments:

| Model | Parameter sent |
|---|---|
| Names starting with `gpt-5` through `gpt-9` (followed by `.`, `-` or the end of the name) or `o1` through `o9`, for example `gpt-5-nano` and `o1` | `max_completion_tokens` |
| All other names, for example `gpt-35-turbo` | `max_tokens` (unchanged) |

`param_renames` overrides or extends these defaults, for example for a future `gpt-10`:

```json
{
  "api_config": {
    "models": {
      "overrides": {
        "some-model--deployed": {
          "param_renames": { "max_tokens": "max_completion_tokens" }
        }
      }
    }
  }
}
```

- A model-level map replaces the provider-level map, and configuration wins over the built-in default per key. Map a key to itself to switch a default off.
- The source key is always removed, so both names are never sent. A value the client supplied under the destination name wins.
- When a deployment answers `unsupported_parameter … Use 'X' instead`, add the mapping here.

**Deployed-model routing.** `--deployed` OpenAI and Perplexity models are served on the `/openai` and `/openrouter` routes: the gateway appends `/chat/completions` to the deployment URL and sends the model name the deployment expects, because a deployment rejects the `--deployed` alias. Anthropic deployments use a Bedrock-style contract and are served on the `/anthropic` and `/aws-bedrock` routes.

## Model capability validation

The chat completions endpoint (`/openai/v1/chat/completions`) refuses embedding models:

```
Model text-embedding-3-large is designed for embeddings and cannot be used for chat completions. Use the embeddings endpoint instead.
```

The embeddings endpoint (`/openai/v1/embeddings`) answers `400` for a model without the embedding capability:

```
Model gpt-5-nano does not support embeddings
```

`/v1/models` lists every model, embedding models included; the capability is checked when a request arrives.

## Streaming emulation

For a model that cannot stream, `emulate_streaming_for_models` under a provider makes the gateway stream anyway: it sends a non-streaming request to SAP AI Core and replays the complete answer to the client as a stream of chunks. The list matches the model name sent upstream, exactly or without its `provider--` prefix. If the answer takes long, the gateway keeps the connection open with keep-alive events until it starts the stream. Use it for clients that only work with streamed responses.
