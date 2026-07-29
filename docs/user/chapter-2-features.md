---
title: SAIL-PROXY User Guide - Chapter 2
author: st-gr
date: 2025-01-28
mainfont: Helvetica, Arial, sans-serif
fontsize: 18px
---

# SAIL-PROXY User Guide
*Multi-provider AI Gateway for SAP AI Core*
**Author:** *st-gr*

[<< Previous Chapter](chapter-1-introduction.md) | [Content Table](README.md) | [Next Chapter >>](chapter-3-installation.md)

---

## Features

### Multi-Provider API Compatibility

SAIL-PROXY supports multiple AI API formats, allowing you to use existing tools and code without modification:

#### OpenAI API Format
- **Endpoints**: `/openai/v1/chat/completions`, `/v1/models`
- **Compatible with**: OpenAI SDK, ChatGPT plugins, most AI tools
- **Example**:
```bash
curl -X POST http://localhost:3000/openai/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5-mini",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

#### OpenAI Responses API

- **Endpoint**: `/openai/v1/responses` (also mounted at `/openrouter/api/v1/responses`)
- **Models**: deployed GPT-5+ / o-series only (e.g. `gpt-5.3-codex--deployed`). Other models return HTTP 400 `model_not_supported` — use `/openai/v1/chat/completions` for those.
- **Supported**: streaming, function tools, `reasoning`, `instructions`, `store: false`.
- **Hosted web search**: a hosted `{"type":"web_search"}` tool is emulated gateway-side through Perplexity `sonar-pro`. The gateway runs the search itself and then calls the model again with the results, so the turn ends with the model's OWN answer written from what the search found: the client receives a `web_search_call` item recording the search, followed by the assistant's message. Streaming works the same way — the second call's frames are spliced into the same SSE stream, so the client still sees exactly one `response.created` and one `response.completed`. The number of searches per request is capped by `api_config.web_search.max_searches_per_request` (default 3, clamped to 1–10). Only when no follow-up call is possible (the cap is exhausted, or the call itself fails) does the gateway fall back to delivering the formatted results as the assistant's message.
- **Client**: Codex CLI (see below)
- **Upgrading a distributed install**: an admin-activated configuration *replaces* the shipped `api_config.json` wholesale, so a configuration activated before this endpoint existed has no `responses` / `responses-stream` hook keys under `defaultHooks.openai`. Because pseudonymization is force-enabled for the `openai` endpoint, the route then refuses requests with HTTP 503 `pseudonymization_hook_missing` rather than sending unmasked data upstream. Activate a configuration containing those keys before using the route.

```bash
curl -X POST http://localhost:3000/openai/v1/responses \
  -H "Content-Type: application/json" -H "Authorization: Bearer $API_KEY" \
  -d '{"model":"gpt-5.3-codex--deployed","input":"Say OK","max_output_tokens":30,"store":false}'
```

##### Using Codex CLI

Codex CLI speaks the Responses API natively. Create or edit `~/.codex/config.toml`:

```toml
model = "gpt-5.3-codex--deployed"
model_provider = "sailproxy"

[model_providers.sailproxy]
name = "sail-proxy"
base_url = "http://localhost:3000/openai/v1"
env_key = "SAILPROXY_API_KEY"
wire_api = "responses"
requires_openai_auth = false
```

Then export your key and run:

```bash
export SAILPROXY_API_KEY=your_api_key_from_api_keys_endpoint
codex
```

The `--deployed` suffix matters: this route serves direct SAP AI Core deployments only. Orchestration-served models (`gpt-5.4`, `gpt-5.3-codex`, …) and Anthropic deployments are rejected with an HTTP 400 naming what is supported — use `/openai/v1/chat/completions` for those.

Codex warns `Model metadata for 'gpt-5.3-codex--deployed' not found` and falls back to generic metadata. That is expected — the name is a gateway alias Codex has no built-in entry for — and does not affect the session.

Reasoning items, encrypted reasoning content, tool calls and native SSE framing pass through unchanged. PII masking covers the whole Responses body — `instructions`, `input` items, tool-call arguments and tool output — as well as the streaming deltas coming back.

**Sub-agents:** Codex's `multi_agent` feature sends a `namespace`-typed tool that SAP deployments reject outright. The gateway handles this for you: it flattens the `namespace` wrapper into the ordinary function tools it contains on the way out, and restores the routing namespace on the model's tool calls on the way back — on both the streaming and non-streaming paths — so sub-agents work with no Codex flag and nothing to configure. Operators who would rather not offer the sub-agent tools at all can set `namespace_tools.mode = "strip"` in `api_config.json`, which drops them instead; Codex then falls back to its own no-sub-agent behavior.

Verified end to end against Codex CLI **0.145.0 and 0.146.0** — both send the same `multi_agent_v1` wrapper, and on both a spawned sub-agent runs to completion through the gateway with no flag. Nothing here is pinned to that wrapper's name: the gateway flattens whichever namespace it is handed and restores that same name on the way back, so a future Codex release that renames the group or changes the tools inside it needs no change on this side.

**Older Codex versions:** releases prior to mid-2025 spoke Chat Completions and were configured through `~/.codex/config.json` with a `providers` block pointing at `/openai/v1`. That still works against the chat-completions route, but the Responses route above is the supported path.

#### Anthropic API Format
- **Endpoints**: `/anthropic/v1/messages`, `/anthropic/v1/messages/count_tokens`
- **Compatible with**: Anthropic SDK, Claude applications, Claude Code
- **Token Counting**: Local token estimation without API calls for pre-flight validation
- **Example**:
```bash
curl -X POST http://localhost:3000/anthropic/v1/messages \
  -H "x-api-key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

#### AWS Bedrock Format
- **Endpoints**: `/aws-bedrock/model/{modelId}/invoke`
- **Authentication**: AWS SigV4 or API keys
- **Compatible with**: AWS CLI, Boto3, AWS SDKs

#### OpenRouter Format
- **Endpoints**: `/openrouter/api/v1/chat/completions`
- **Special feature**: GitHub Copilot compatibility (with patching)
- **Use case**: Connecting tools that expect OpenRouter's extended model list

#### Ollama Compatibility
- **Service**: Optional Ollama service on port 11434
- **Endpoints**: `/api/chat`, `/api/generate`, `/api/tags`, OpenAI compatible endpoints `/v1/chat/completions`, `/v1/models`
- **Use case**: Local development with Ollama-compatible tools, e. g. GitHub Co-Pilot in VS Code has limited Ollama support.

### Authentication & Security

#### API Key Management
- **Simple Setup**: Create and manage API keys through CLI or Admin UI
- **Secure Storage**: Keys are encrypted at rest with AES-256
- **Rate Limiting**: Configurable per-key request limits (planned)
- **IP Restrictions**: Optional IP allowlists for enhanced security (planned)

#### AWS Credentials Support
- **SigV4 Authentication**: Full AWS Signature Version 4 implementation
- **Credential Management**: Secure storage of AWS access keys
- **Region Support**: Multi-region AWS compatibility
- **IAM Integration**: Works with existing AWS IAM policies

#### Enterprise Authentication (Docker deployment)
- **OAuth2 Integration**: GitHub, Okta, LDAP/Active Directory
- **Single Sign-On**: Enterprise SSO with role-based access
- **Session Management**: Secure session handling

### Model Management

#### Dynamic Model Mapping
Configure model name substitutions to use familiar names:
```json
{
  "model_substitutions": {
    "gpt-4o-some-external-name": "gpt-4o",
    "claude-3-5-sonnet-20241022": "anthropic--claude-3-5-sonnet"
  }
}
```

#### Streaming Support
- **Native Streaming**: Real-time response streaming for compatible models including abort controller
- **Streaming Emulation**: Simulated streaming for non-streaming models such as IBM Granite
- **Tool Use**: Full support for OpenAI functions and Anthropic tools

#### Model Discovery
- **Unified Endpoint**: `/v1/models` lists available models across all providers
- **Provider-Specific**: Each API format returns appropriate model lists
- **Real-time Updates**: Model availability reflects SAP AI Core configuration

### Usage Tracking & Analytics

#### Comprehensive Monitoring
- **Request Tracking**: All API calls logged with metadata
- **Token Counting**: Input/output token usage per request
- **Pre-flight Token Estimation**: `/anthropic/v1/messages/count_tokens` endpoint for local token counting before inference
- **Cost Analysis**: Usage-based cost tracking and reporting
- **Performance Metrics**: Response times and success rates
- **Payload logging**: Can be enabled via environment variable

#### Security Events
- **Authentication Failures**: Failed login attempts and invalid keys
- **Suspicious Activity**: Rate limit violations, unusual patterns (planned)
- **Audit Trail**: Complete record of administrative actions (via last changed)
- **Real-time Alerts**: Immediate notification of security events

### Plugin System

#### Extensible Architecture
- **Request Hooks**: Modify requests before sending to SAP AI Core or deployment endpoint
- **Response Hooks**: Transform responses before returning to client
- **Streaming Hooks**: Real-time stream processing
- **Error Hooks**: Custom error handling and logging

#### Example Plugin Use Cases
- **Content Filtering**: Remove sensitive data from requests/responses
- **Custom Logging**: Enhanced logging for compliance requirements
- **Response Enhancement**: Add metadata or formatting to responses
- **Integration Hooks**: Connect to external systems for monitoring
- **Cache**: Models served through third-party providers can perform slower compared to provider endpoints. The cache hits are held back until the initial request is served = no endless timeout messages, see plugin awsBedrockResponseCache.ts
- **Enable beta features**: E. g. 1-million context window of Claude Sonnet 4

### Admin Cockpit (Docker deployment only)

![Admin Cockpit Dashboard](/docs/assets/admin-dashboard.png)

#### Web-based Management
- **API Key Management**: Create, revoke, and configure API keys
- **AWS Credential Management**: Secure storage and configuration, rotate keys and manage mock AWS credentials
- **Configuration Editor**: Real-time gateway configuration updates. Gateway gets informed via event bus about new config and reboots itself with the updated config
- **User Role Management**: Assign roles and permissions (planned)

#### Analytics Dashboard
- **Usage Charts**: Visual representation of API usage over time
- **Cost Tracking**: Monitor usage costs by user, model, or time period
- **Security Dashboard**: View security events and threat indicators
- **Performance Monitoring**: Track response times and error rates
- **Data Export**: Via .csv or ValKey event bus hook

### Integration Examples

#### Claude Code Integration
```bash
# Set environment variable
export ANTHROPIC_API_KEY="your-sail-proxy-api-key"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export ANTHROPIC_BASE_URL="http://localhost:3000/anthropic"

# Claude Code will now use SAIL-PROXY
claude --model claude-sonnet-4-20250514
```

#### GitHub Copilot Integration (via OpenRouter endpoint)
```bash
# Configure GitHub Copilot to use SAIL-PROXY
Either via Ollama adapter or OpenRouter patch, see node ./cli-tools/patch-copilot-chat.js
```

#### Custom Application Integration
```javascript
// OpenAI SDK example
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'your-sail-proxy-api-key',
  baseURL: 'http://localhost:3000/openai/v1'
});

const response = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello from SAP AI Core!' }]
});
```

### Performance & Scalability

#### Caching
- **Distributed Caching**: Redis/Valkey for response caching
- **Configurable TTL**: Set cache duration per model/endpoint
- **Cache Invalidation**: Automatic cache cleanup and refresh

#### High Availability
- **Stateless Design**: Horizontal scaling with load balancers
- **Database Clustering**: PostgreSQL clustering support
- **Service Redundancy**: Multiple gateway instances for reliability

#### Monitoring Integration
- **Health Checks**: Built-in health endpoints for monitoring
- **Metrics Export**: Via hook in ValKey events
- **Logging**: Structured JSON logging with multiple levels

---

*Ready to get started? [Install SAIL-PROXY](chapter-3-installation.md) for your environment.*