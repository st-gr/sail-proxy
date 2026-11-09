---
title: Architecture
description: Services, data flow and the request lifecycle.
---

# Architecture Overview

## High-Level System Architecture

SAIL-PROXY is a set of small services. The gateway accepts requests in the API formats of popular AI clients (OpenAI, Anthropic, AWS Bedrock, Google Gemini, OpenRouter and, through the Ollama service, Ollama), translates them to SAP AI Core's Orchestration API or to a model deployment, and translates the answers back. The admin service holds the API keys, users, configuration and usage data and serves the Admin Cockpit.

![Architecture overview and deployment options](/generated/deployment-options-light.svg){.light-only}
![Architecture overview and deployment options](/generated/deployment-options-dark.svg){.dark-only}

```
┌─────────────────┐    ┌──────────────────────────┐    ┌─────────────────┐
│   AI Clients    │    │       SAIL-PROXY         │    │   SAP AI Core   │
│                 │    │                          │    │                 │
│ • Claude Code   │────│ • nginx (Docker, Kyma)   │────│ • Orchestration │
│ • GitHub Copilot│    │ • Gateway                │    │ • Deployments   │
│ • Custom Apps   │    │ • Admin service/Cockpit  │    │ • OAuth2 token  │
│ • SDKs          │    │ • Ollama service (opt.)  │    │                 │
└─────────────────┘    │ • Valkey, PostgreSQL     │    └─────────────────┘
                       └──────────────────────────┘
```

The Docker Compose stack (`docker/docker-compose.yml`) runs these services:

| Service | Role |
|---------|------|
| `gateway` | The gateway (port 3000) |
| `gateway-migrate` | One-shot `file_search` database migration before the gateway starts |
| `admin` | The admin service and the cockpit apps (port 4004) |
| `ollama` | The Ollama-compatible adapter (profile `ollama`) |
| `valkey` | Cache and pub/sub (`valkey/valkey:8`) |
| `postgres` | Admin database and `file_search` vector store (`pgvector/pgvector:pg16-trixie`) |
| `dex`, `oauth2-proxy` | Cockpit login |
| `nginx` | Reverse proxy in front of everything (port 8080) |
| `minio` | S3-compatible blob storage for `file_search` (profile `minio`) |

The standalone CLI (`@st-gr/sail-proxy`) runs only the gateway, without the admin service; it keeps its data as files under `~/.sail-proxy`. The deployment options are compared in [Deployment options](/deploy/overview).

## Core Components

### Gateway Service (`services/gateway`)
**Purpose**: Main proxy and translation service (Express)
- **API Translation**: Converts between the OpenAI, Anthropic, Bedrock, Gemini and OpenRouter formats and SAP AI Core
- **Authentication**: API key and AWS SigV4 validation through the admin service, with a local cache
- **Request Routing**: Orchestration or direct model deployment, per model
- **Response Processing**: Format translation and streaming
- **Usage Tracking**: Usage and security events published to Valkey for the admin service
- **Plugins and tools**: Pseudonymization, hosted tools such as `file_search`, tool governance

### Admin Service (`services/admin`)
**Purpose**: Management and administration (SAP CAP)
- **User Management**: Users, roles, quota profiles
- **API Key Management**: Full lifecycle of API keys and AWS credentials
- **Configuration**: Gateway configuration versions, activation and rollback
- **Analytics**: Usage statistics, cost calculation and reporting
- **Security**: Security notifications and SIEM export
- **Admin Cockpit**: The shell and the UI5 apps under `services/admin/app/`

### Ollama Service (`services/ollama`)
**Purpose**: Ollama API compatibility layer (Express)
- **Protocol Translation**: Ollama API requests to OpenAI format, sent to the gateway (`MAIN_PROXY_URL`)
- **Model Mapping**: Ollama model names to gateway models
- **Streaming Support**: Ollama's newline-delimited JSON streaming

## Data Flow Architecture

### Request Processing Pipeline

A chat request on an OpenAI-shaped route passes these steps (`services/gateway/src/index.ts` and `routes/chatRoutes.ts`):

1. **Body parsing**: JSON and URL-encoded bodies up to the configured maximum request size; for Bedrock and SigV4 requests the raw body is kept for signature verification.
2. **HTTP logging**: `morgan` writes each request to the shared logger.
3. **Request context**: a request id (`gateway-<timestamp>-<random>`) and the client IP are attached to the logger context.
4. **CORS**: the CORS headers are set; `OPTIONS` requests end here.
5. **Route**: the request reaches the router mounted for its path (for example `/openai/v1/chat/completions`).
6. **Authentication**: the unified token middleware validates the API key (or AWS SigV4 signature) against the cache, and on a miss against the admin service's validation service.
7. **Service authorization**: the key must be allowed for the API family.
8. **Tool governance**: tool policies are applied to the tools in the request.
9. **Quota enforcement**: the user's quota is checked.
10. **Model substitution**: `providers.<name>.substitute_models` renames apply.
11. **Controller**: plugins run on the request, the request is translated and sent to SAP AI Core, the answer (or stream) is translated back, and plugins run on the response.
12. **Usage**: a usage event is published on the Valkey channel `usage-events`; the admin service subscribes, calculates the cost and stores it.
13. **Errors**: the global error handler turns exceptions into the client's error format.

### Authentication Flow

1. **Token Extraction**: `Authorization: Bearer`, `x-api-key`, `x-goog-api-key` or the AWS SigV4 `Authorization` header
2. **Validation**: cached result, or `POST /odata/v4/validation/validateUnifiedAuthByToken` on the admin service
3. **Permission Check**: the key's permissions for the requested API family
4. **Quota**: the user's quota profile
5. **Audit**: failed attempts become security events

In standalone mode (`GATEWAY_STANDALONE=true`, the npm CLI) the gateway validates keys locally. The details are on the [Gateway service](/developer/gateway) page.

### Model Request Translation

**OpenAI to SAP AI Core** (orchestration):
```typescript
// Input: OpenAI format
{
  "model": "gpt-5-mini",
  "messages": [{"role": "user", "content": "Hello"}],
  "stream": true
}

// Output: SAP AI Core Orchestration API v2, sent to
// POST {SAP_AI_CORE_URL}/v2/inference/deployments/{orchestrationDeploymentId}/v2/completion
{
  "config": {
    "modules": {
      "prompt_templating": {
        "model": { "name": "gpt-5-mini", "params": { /* … */ } },
        "prompt": { "template": [ /* translated messages */ ] }
      }
    },
    "stream": { "enabled": true }
  }
}
```

## Component Communication

### Internal Service Communication

- **Gateway → Admin**: HTTP calls for key validation (`ADMIN_SERVICE_URL`) and to fetch the active configuration
- **Gateway → Valkey → Admin**: usage and security events over pub/sub
- **Admin → Valkey → Gateway**: cache invalidation when keys, users or configuration change
- **Ollama → Gateway**: HTTP, like any other client
- **Admin → Database**: SQLite (local development) or PostgreSQL (Docker, Kyma)

### External Integrations

**SAP AI Core Integration**: OAuth2 client credentials (`AUTH_URL`, `CLIENT_ID`, `CLIENT_SECRET`). `getAuthToken()` in `services/gateway/src/services/modelService.ts` caches the token and requests a new one when less than 60 seconds of validity remain.

**Valkey Integration**: the services use the `iovalkey` client; the gateway publishes usage events on the `usage-events` channel, and the admin service's usage event processor subscribes to it.

## Technology Stack

### Backend Services

**Runtime Environment**:
- **Node.js 20+**
- **TypeScript**
- **Express**: gateway and Ollama service
- **SAP CAP**: admin service

**Database Layer**:
- **PostgreSQL**: admin database in Docker and Kyma; `file_search` vector store (pgvector)
- **SQLite**: admin database in local development
- **Valkey**: caching and pub/sub messaging

**Authentication & Security**:
- **JWT**: service-to-service tokens and the cockpit login (oauth2-proxy and an OIDC provider)
- **OAuth2**: SAP AI Core authentication
- **bcrypt**: password hashing
- **AES-256**: encryption of secrets at rest (AWS secrets, metadata, cached secrets)

### Frontend (Admin Cockpit)

**UI Framework**:
- **SAP Fiori Elements** and freestyle **SAPUI5** apps in a shell
- **OData V4**: API protocol for data access

### DevOps & Infrastructure

**Package Management**:
- **pnpm workspaces**: monorepo organization (see [Workspace layout](/developer/workspace-layout))

**Build & Testing**:
- **Jest**: unit and integration tests
- **TypeScript compiler**: build and type checking
- **ui5-test-runner** and OPA5: cockpit UI journeys
- **ESLint**: CAP recommended rules

**Containerization**:
- **Docker** with multi-stage builds, **Docker Compose**, and SAP BTP Kyma

## Configuration Management

### Configuration Sources

1. **Active configuration**: the gateway configuration activated in the Admin Cockpit, fetched by the gateway from the admin service
2. **Configuration file**: `api_config.json` (`CONFIG_FILE_PATH`), used when the admin service is not reachable and in standalone mode
3. **Environment variables**: `.env` files and the process environment
4. **Defaults**: values in source code

### Model Configuration

The configuration has the top-level sections `providers`, `models`, `capabilities`, `hooks`, `platform` and `observability`. Model renames live in `providers.<name>.substitute_models`, per-model settings in `models.overrides`. Every key is described in the [Gateway configuration reference](/reference/configuration).

## Plugin Architecture

Plugins are loaded by `services/gateway/src/services/pluginLoader.ts` and run by `pluginExecutor.ts`. A plugin rule has an `id`, a `strategy` (`before`, `after`, `stream` or `error`) and a list of matchers. The matchers are defined under `hooks.definitions` in the configuration (types `header`, `json-path`, `json-path-regex` and `url-regex`) and attached to providers under `hooks.defaults`:

```json
{
  "hooks": {
    "definitions": {
      "header:contentTypeJson": { "type": "header", "name": "content-type", "equals": "application/json" }
    },
    "defaults": {
      "anthropic": {
        "invoke": [
          { "request": { "callback": { "id": "pseudonymizationPlugin" }, "match": ["header:contentTypeJson"] } }
        ]
      }
    }
  }
}
```

The plugin system page of this section describes how to write plugins.

## Security Architecture

### Multi-Layer Security Model

**Authentication Layers**:
1. **API Key Authentication**: Bearer tokens and the `x-api-key` header
2. **AWS SigV4**: full signature validation for AWS Bedrock requests
3. **OIDC login**: oauth2-proxy with Dex or another provider for the Admin Cockpit
4. **JWT Service Tokens**: gateway-to-admin calls

**Authorization**: CAP roles (`admin`, `user`, `gateway`) in the admin service; per-key permissions, tool policies and quotas in the gateway.

### Cryptographic Keys

Three 256-bit keys are generated at setup: `VALIDATION_TOKEN_SECRET` (signs validation tokens), `METADATA_ENCRYPTION_KEY` (encrypts metadata exchanged between the services) and `AWS_SECRET_ENCRYPTION_KEY` (encrypts stored AWS secrets). They are described in [Environment variables](/reference/environment-variables).

## Scalability Design

**Stateless Gateway Design**:
- Validation results, quota state and rate-limit state are shared through Valkey when distributed caching is on
- Configuration comes from the admin service

**Caching Strategy**:
- **L1 Cache**: in-memory validation cache in each gateway
- **L2 Cache**: Valkey shared by the gateway instances

## Monitoring & Observability

**Health Check Endpoints**: the gateway answers `GET /health`; the admin service in Docker answers `GET /api/health` without authentication.

**Request Correlation**: each gateway request gets a request id in the logger context; the same id is used for its usage event.

**Logging**: the shared logger (`libs/logger`) with log levels set per environment; the debugging page of this section covers log level resolution.
