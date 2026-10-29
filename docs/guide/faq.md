---
title: FAQ
description: Short answers to the questions that come up when adopting sail-proxy.
---

# FAQ

## General questions

### What is sail-proxy?
sail-proxy is a multi-provider AI gateway: applications built for the OpenAI, Anthropic, Google Gemini, AWS Bedrock, OpenRouter or Ollama APIs work with SAP AI Core foundation models through it. It translates between the API formats and adds keys, usage tracking, quotas and governance.

### Is sail-proxy a direct connection to AI providers like OpenAI or Anthropic?
**No**. sail-proxy routes every request through SAP AI Core, either its Orchestration API or a model's own deployment endpoint. Compliance, governance and cost control stay with SAP AI Core while the clients keep their usual APIs.

### What's the difference between the CLI and the Docker deployment?
- **CLI**: a single-user gateway on your machine, installed with npm. No web interface, no roles.
- **Docker**: a multi-user deployment with the Admin Cockpit, single sign-on, the admin and user roles, usage analytics and quotas. The Kyma deployment runs the same services on SAP BTP.

### Can I use the CLI and Docker deployments at the same time?
Yes, but they are independent. Both can use the same SAP AI Core instance; each has its own API keys and configuration.

## Installation and setup

### What do I need?
- **Node.js 20 or later**
- **A service key** of your SAP AI Core instance (Extended plan) and an orchestration deployment
- **Docker with Docker Compose** for the Docker deployment; `kubectl` and a Kyma runtime for Kyma

### How do I get a SAP AI Core service key?
1. Open the SAP BTP cockpit.
2. Go to your SAP AI Core service instance.
3. Open its service keys.
4. Create a service key or use an existing one.
5. Download or copy the JSON; the setup asks for it.

### Can I run sail-proxy on Windows?
Yes. The CLI runs with Node.js on Windows; the Docker deployment runs with Docker Desktop or Rancher Desktop. With Rancher Desktop, run `docker compose` from a Windows shell rather than WSL2 (see [Troubleshooting](/guide/troubleshooting)).

### Do I need admin rights to install sail-proxy?
- **CLI**: no, if npm installs global packages into your home directory (`npm config set prefix ~/.npm-global`).
- **Docker**: installing Docker itself may need them.

## Authentication and security

### How is sail-proxy secured?
- API keys per user; each key can carry its own rate limits, and each user quotas.
- Stored AWS secret access keys are encrypted (AES-256); validation results cached in Valkey are encrypted with a key derived from the credential.
- The gateway authenticates to SAP AI Core with OAuth2 client credentials over TLS.
- Single sign-on and the admin and user roles in the Admin Cockpit (Docker and Kyma).
- Security events (failed authentication, rate limit and quota violations, entitlement refusals) and audit fields on every record.
- PII masking (pseudonymization) of outgoing requests, and tool governance.

### What happens to my data?
Requests and responses go to SAP AI Core, which applies SAP's data protection and privacy policies. sail-proxy records usage metadata (time, model, token counts, cost) but not request or response content, unless an operator enables payload logging (`PAYLOAD_LOGGING_ENABLED`). Files uploaded for file search are stored by the gateway until you delete them or they expire. sail-proxy is self-hosted, not a SaaS.

### How often should I rotate API keys?
A common policy is every 90 days in production. Rotate a key at once when:
- it may be compromised
- a developer leaves the project
- your security policy requires it

### Can I restrict access to specific IP addresses?
- **Kyma**: yes. The setup creates an IP allowlist as an Istio AuthorizationPolicy in the `istio-system` namespace, enforced at the ingress gateway before requests reach the application.
- **Docker** and **CLI**: API keys cannot be bound to IP addresses; restrict access with your network or firewall.

### Why does my request get 429 although my key's limit is not reached?
An administrator can also set a requests-per-minute limit on your user account, on top of any
limit on the key or credential itself. A request has to stay under both, so it can be refused for
the user-level limit even while the key still has room. Check your consumption on the Admin
Cockpit's home page — the response body's `scope` field says `user` when this is the one that was
hit.

## Usage and integration

### Which AI tools work with sail-proxy?
Any tool that speaks one of these API formats:
- **OpenAI API**: the OpenAI SDKs, Codex, opencode, Open WebUI, AnythingLLM and most AI tools
- **Anthropic API**: the Anthropic SDKs, Claude Code
- **Google Gemini API**: Gemini CLI, the `@google/genai` SDK
- **AWS Bedrock**: AWS CLI, Boto3, AWS SDKs
- **Ollama API**: Ollama clients and Ollama-compatible tools (through the Ollama adapter)
- **OpenRouter**: GitHub Copilot (with configuration) and OpenRouter-compatible tools

### Can I use sail-proxy with my existing code?
Yes. Change the base URL and the API key:
```javascript
// Before: OpenAI directly
const client = new OpenAI({
  apiKey: 'sk-your-openai-key',
  baseURL: 'https://api.openai.com/v1'
});

// After: through sail-proxy
const client = new OpenAI({
  apiKey: 'sk-demo-your-sail-proxy-key',
  baseURL: 'http://localhost:3000/openai/v1'
});
```

### What models are available?
That depends on your SAP AI Core instance and, in the Docker and Kyma deployments, on the entitlement catalog an administrator assigned to you. SAP AI Core offers models of the OpenAI GPT, Anthropic Claude, Google Gemini, Amazon Nova, Mistral and other families.

List what your key can use: `curl -H "Authorization: Bearer sk-demo-your-key" http://localhost:3000/v1/models`

### Does sail-proxy support streaming?
Yes:
- **Native streaming** for models that support it
- **Streaming emulation** for models listed in a provider's `emulate_streaming_for_models`
- **Server-Sent Events (SSE)** in the format each API expects

## Performance and costs

### How much latency does sail-proxy add?
The gateway translates the request, checks the key and records usage. Total response time depends mainly on SAP AI Core and the selected model.

### Does sail-proxy cache responses?
Only through the `awsBedrockResponseCache` plugin: it keeps slow responses in an in-memory LRU cache (one hour by default), so a repeated request is answered from the cache instead of running into a timeout.

### How much does sail-proxy cost to run?
sail-proxy itself is open source. Costs come from:
- **SAP AI Core usage**: based on token consumption
- **Infrastructure**: the hosts for the Docker deployment or the Kyma runtime

The main cost driver is SAP AI Core usage.

### Can I monitor usage and costs?
Yes:
- **CLI**: the gateway log, with token counts
- **Docker and Kyma**: the Admin Cockpit's usage analytics with SAP cost per user, key and model, and quotas per user
- **Integration**: usage and security events can be forwarded to a SIEM or other system (webhook, Datadog, Azure Sentinel, OpenTelemetry, Google Cloud Pub/Sub, S3)

## Technical questions

### What happens if SAP AI Core is unavailable?
The gateway returns an error to the client (typically `500`, or `504` when the call times out). Use retry logic in your applications.

### Can I customize request and response processing?
Yes, through the plugin system:
- **Request hooks** (`before`): change requests before they go to SAP AI Core
- **Response hooks** (`after`): transform responses before they return to the client
- **Streaming hooks** (`stream`): process the stream as it arrives
- **Error hooks** (`error`): custom error handling

### Can one sail-proxy installation use several SAP AI Core instances?
No. Each installation connects to one SAP AI Core instance; run one installation per instance.

### Which databases does sail-proxy use?
The Admin Cockpit's service stores its data in PostgreSQL in the Docker and Kyma deployments, and in SQLite for local development. The CLI keeps its keys and settings in files under `~/.sail-proxy` (on Windows `%APPDATA%\sail-proxy`).

## Deployment and operations

### Can I run sail-proxy in production?
Yes, with the Docker or Kyma deployment:
- single sign-on through oauth2-proxy and Dex
- PostgreSQL
- HTTPS through the Kyma ingress (on Docker, add TLS in front of nginx yourself)
- health endpoints (`/health`)

### How do I upgrade sail-proxy?
On the CLI, run `sail-proxy update`. Docker needs the new version set in `DOCKER_TAG` before the images are pulled, and Kyma upgrades with `setup-kyma.js` and `deploy-kyma.js`; [Upgrade](/deploy/backup-and-upgrade#upgrade) has the steps for each deployment.

### Can I integrate sail-proxy with my monitoring system?
Yes:
- **Health endpoint**: `GET /health` on the gateway
- **Logs**: per-component log levels (`LOG_LEVEL`, `api_config.platform.logging`)
- **Events**: usage and security events forwarded to a SIEM or a webhook

## Admin and management

### Who is the administrator in a Docker deployment?
Everyone whose identity-provider group maps to the admin role (see [Roles](/guide/roles)). An administrator manages keys and credentials of all users and sees all security events and usage statistics.

### Can I bulk import users?
No. A user appears in the cockpit the first time they sign in or use a key.

### How do I back up sail-proxy data?
Back up the database, the configuration with its keys, and the S3 bucket if file search uses one. [Backup, restore and upgrade](/deploy/backup-and-upgrade#docker-compose) has the commands for Docker, the standalone CLI and Kyma.

### What's the difference between the Docker and Kyma deployments?
- **Docker**: runs on your own hosts with Docker Compose, nginx in front.
- **Kyma**: runs on SAP BTP Kyma with the Istio service mesh, which checks host names strictly at its ingress gateway.

On Kyma, IP allowlists are Istio AuthorizationPolicies in the `istio-system` namespace, enforced at the ingress gateway. The Docker deployment has no IP allowlist of its own.

### Why do I get ECONNRESET errors with a Kyma deployment?
Usually because of a wrong host name or a custom `Host` header: the Istio gateway rejects them.

**Wrong**:
```bash
curl --header 'host: localhost' 'https://sail.example.com/...'
export ANTHROPIC_BASE_URL="http://localhost:3000/anthropic"  # a local URL for Kyma
```

**Correct**:
```bash
curl 'https://sail.example.com/gateway/...'  # no custom Host header
export ANTHROPIC_BASE_URL="https://sail.example.com/gateway/anthropic"
```

### Can I use the same client code for Docker and Kyma?
Yes; only the base URL differs:
- **Docker**: `http://localhost:3000` (gateway) or `http://localhost:8080/gateway` (through nginx)
- **Kyma**: `https://sail.example.com/gateway`

```bash
# Docker
export ANTHROPIC_BASE_URL="http://localhost:3000/anthropic"

# Kyma
export ANTHROPIC_BASE_URL="https://sail.example.com/gateway/anthropic"
```

### How do I find my Kyma domain after deployment?
```bash
kubectl get virtualservice sail-proxy-streaming -n sail-proxy
```
The host is listed under `HOSTS`. The deploy script (`kyma/scripts/deploy-kyma.js`) also prints the gateway and Admin Cockpit URLs at the end.

### Can I customize the Admin Cockpit?
Each user can pick a Light, Dark or System theme and a language in the cockpit's settings. Anything beyond that means changing the cockpit's source.

## Integration specific

### How does GitHub Copilot connect?
GitHub Copilot connects through the Ollama adapter or through the OpenRouter endpoint with the patch in `cli-tools/patch-copilot-chat.js`. Copilot expects specific model formats and behaviour, so not every model and feature works through it.

### Can I use sail-proxy with LangChain or similar frameworks?
Yes, with any framework that supports the OpenAI or Anthropic APIs:
```python
# LangChain example
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="gpt-5-mini",
    api_key="sk-demo-your-sail-proxy-key",
    base_url="http://localhost:3000/openai/v1",
)
```

### Does sail-proxy support function calling and tools?
Yes:
- **OpenAI function calling**
- **Anthropic tool use**
- **Hosted tools**: web search and file search on the Responses API

## Troubleshooting

### Why do I get "Model not found" errors?
1. List the models your key can use: `curl -H "Authorization: Bearer $API_KEY" http://localhost:3000/v1/models` (CLI: `sail-proxy models list`).
2. Check that the model name matches a model available in SAP AI Core.
3. Check the model renames (**Substitute Models**) in the configuration.
4. Check that the model is in your entitlement catalog.

### sail-proxy is slow. How can I speed it up?
Model inference is a shared resource; models in high demand can be slow at peak hours.
1. **Use faster models** for simple tasks (for example `claude-haiku-4-5-20251001`).
2. **Run the gateway close** to your applications.
3. **Check network latency** to SAP AI Core.
4. **Monitor resource usage** (CPU, memory, network).

### What should I do if I suspect a security issue?
1. **Immediately**: revoke the API keys that may be compromised.
2. **Investigate**: check the [security notifications](/guide/cockpit/security-notifications) in the Admin Cockpit.
3. **Report**: contact your security team and your sail-proxy administrators.
4. **Prevent**: rotate keys, review access patterns and tool policies.

For more, see [Troubleshooting](/guide/troubleshooting).
