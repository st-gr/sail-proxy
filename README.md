# SAP AI Core LLM Proxy - Multi-Provider API Gateway

[![](https://img.shields.io/badge/YouTube-%2523FF0000?style=social&logo=YouTube&logoColor=red&labelColor=white&color=white)](https://www.youtube.com/channel/UCt0ji51UVF7cRjHLmanP_vg)
[![CI Pipeline](https://github.com/st-gr/sail-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/st-gr/sail-proxy/actions/workflows/ci.yml) [![License: AGPL 3.0](https://img.shields.io/badge/License-AGPL_3.0-blue.svg)](LICENSE) [![No AI Training](https://img.shields.io/badge/NO%20AI%20TRAINING-🚫-red)](#no-ai-training)
> Courtesy note: Made with agentic coding tools. Please do not use for AI training — help preserve diversity and avoid model collapse.

<a href="README.md#sap-ai-core-multi-provider-api-gateway">
<!--
Logo in docs/assets
-->
<img src="docs/assets/sail-proxy-logo.svg" align="right" width="360"
     alt="sail-proxy - a SAP AI Core LLM proxy">
</a>

<!--
Don't let the text wrap too narrowly to the left of the above image.
The `div` reduces the vertical height. The `picture` prevents autolinking.
-->
<div><picture><img src="docs/assets/bumper.png" alt=""></picture></div>

This project provides a unified API gateway that lets applications use familiar API formats (OpenAI, Anthropic, AWS Bedrock, OpenRouter, Ollama, etc.) while routing all requests through **SAP AI Core Foundation Models**.

Instead of maintaining multiple provider-specific integrations, this gateway standardizes incoming requests, converts them into SAP AI Core’s orchestration API, and forwards them securely to deployed foundation models.


## TL;DR

Keep your **SAP AI Core service** key secret 🔐, have users create their own API keys 🗝 , use AI Apps 💻 like agentic coding, see token usage 📈 per key (application), user, model, provider and cost 💰.


## Highlights

- 🔄 Leverage client apps that require OpenAI/Anthropic/Ollama/Bedrock/OpenRouter formats 
- 🎯 Route all model calls through SAP AI Core Foundation Models with plugin support
- 🧩 Exposes SAP AI Core deployed models for bare-metal API calls
- 🔒 SAP privacy guarantees - No direct connections to external model providers
- 🛡  Enterprise-grade security (multi-user key management), auditing, and cost control

## Architecture Overview and Deployment Options

<a href="docs/assets/sail-proxy-deployment-options.drawio.png">
<!--
The original draw.io file can be found here: docs/assets/sail-proxy-deployment-options.drawio
-->
<img src="docs/assets/sail-proxy-deployment-options.svg" 
     alt="Architecture Overview and Deployment Options">
</a>

**Key Point**: This gateway does __not__ connect directly to OpenAI, Anthropic, AWS Bedrock, or other AI providers. Instead, it translates various API formats and routes everything through SAP AI Core's unified orchestration layer or direct to the endpoint of a deployed foundation model.

## Features

- **OpenAI Compatibility**: Translates OpenAI API format requests to SAP AI Core's orchestration API.
  - **Chat Completions**: Full support for conversational AI with streaming and tool use
  - **Embeddings**: Generate text embeddings using SAP AI Core embedding models
- **Anthropic Compatibility**: Translates Anthropic Messages API format requests to SAP AI Core's orchestration API.
- **AWS Bedrock Compatibility**: Provides Bedrock-style API endpoints that route to SAP AI Core foundation models. Supports AWS SigV4 authentication or API Key authentication.
- **Ollama API Compatibility**: Supports all major Ollama endpoints via local running adapter (see services/ollama folder).
- **OpenRouter API Compatibility**: Supports key OpenRouter API endpoints for compatibility with tools like GitHub Copilot.
- **Model Substitution**: Runtime configurable model name substitution to map client model names to SAP AI Core deployed models.
- **Streaming Support**: Native streaming when supported by SAP AI Core, with configurable emulation for non-streaming models.
- **Tool Use Support**: Full support for OpenAI function tools and Anthropic tools, leveraging SAP AI Core's orchestration capabilities.
- **Plugin System**: Dynamic plugin loading from the `/plugins` directory with ability to intercept and modify requests and responses. For comprehensive development guide, see [Plugin System Documentation](docs/developer/chapter-13-plugin-system.md).
- **Unified Authentication**: Token-based authentication system with support for both API keys and AWS SigV4 credentials.

## API Endpoints

| Provider    | Endpoint                                                   | Description                                         |
|-------------|------------------------------------------------------------|-----------------------------------------------------|
| OpenAI      | `/openai/api/v1/chat/completions`                          | OpenAI chat completions API → SAP AI Core          |
| OpenAI      | `/openai/v1/chat/completions`                              | OpenAI chat completions API alias → SAP AI Core    |
| OpenAI      | `/openai/api/v1/embeddings`                                | OpenAI embeddings API → SAP AI Core                |
| OpenAI      | `/openai/v1/embeddings`                                    | OpenAI embeddings API alias → SAP AI Core          |
| Anthropic   | `/anthropic/v1/messages`                                   | Anthropic messages API → SAP AI Core               |
| Anthropic   | `/anthropic/v1/messages/count_tokens`                      | Count tokens for Anthropic Messages API requests   |
| AWS Bedrock | `/aws-bedrock/model/{modelId}/invoke`                      | AWS Bedrock InvokeModel API → SAP AI Core          |
| AWS Bedrock | `/aws-bedrock/model/{modelId}/invoke-with-response-stream` | AWS Bedrock InvokeModelWithResponseStream → SAP AI Core |
| AWS Bedrock | `/aws-bedrock/model/{modelId}/converse`                    | AWS Bedrock Converse API → SAP AI Core             |
| AWS Bedrock | `/aws-bedrock/model/{modelId}/converse-stream`             | AWS Bedrock ConverseStream API → SAP AI Core       |
| OpenRouter  | `/openrouter/api/v1/chat/completions`                      | OpenRouter chat completions API → SAP AI Core      |
| OpenRouter  | `/openrouter/api/v1/models`                                | OpenRouter models list from SAP AI Core            |
| Ollama      | `see ./services/ollama/README.md`                          | All Ollama endpoints → SAP AI Core (via adapter)   |
| Common      | `/v1/models`                                               | List available SAP AI Core foundation models       |
| Admin *)    | `/api/admin/api-keys`                                      | API key management for unified authentication      |
| Admin *)    | `/aws/api-keys`                                            | AWS-style credentials management (for SigV4 auth)  |
| Admin *)    | `/api/admin/api-config`                                    | API configuration management                        |

*) The Admin `api-keys` endpoints on the gateway are only functional when running in standalone mode (e.g., using `sail-proxy run` via npm). For multi-user deployments, use the UI5/Fiori Admin dashboard, which provides a more user-friendly interface along with its integrated OData services for managing API keys and more.

## Prerequisites

- [Enable the AI Core service in SAP BTP](https://help.sap.com/docs/sap-ai-core/sap-ai-core-service-guide/initial-setup) - tested with CloudFoundry deployments.
- Create and download a service key JSON for SAP AI Core on your BTP subaccount.
- Ensure an [orchestration deployment is available in the SAP Generative AI Hub](https://help.sap.com/docs/sap-ai-core/sap-ai-core-service-guide/create-deployment-for-orchestration).
  - Use the [`DeploymentApi`](https://github.com/SAP/ai-sdk-js/blob/main/packages/ai-api/README.md#create-a-deployment) from `@sap-ai-sdk/ai-api` [to create a deployment](https://help.sap.com/docs/sap-ai-core/sap-ai-core-service-guide/create-deployment-for-orchestration).
    Alternatively, you can also create deployments using the [SAP AI Launchpad](https://help.sap.com/docs/sap-ai-core/generative-ai-hub/activate-generative-ai-hub-for-sap-ai-launchpad?locale=en-US&q=launchpad).
	There is also the script `sail-model-deploy.js` in the `/cli-tools` folder that provides a fast and easy way to list and deploy foundation models on SAP AI Core in case you operate without SAP AI Launchpad to save costs.
  - Once the deployment is complete, you can access the orchestration service via the `deploymentUrl`.
- If you plan on using the **docker** or **Kyma** deployment options, developing or contributing to the repo: Git clone the repo and configure the project with **Node.js v20 or higher** and **native ESM** support, for __development__ you also would then need to have a running instance of `ValKey` as well as `pnpm` installed.

## Installation and Running

As shown in the Architecture Overview and deployment options diagram, there are three pre-built deployment options. All three have in common that you have created and downloaded the BTP service key of your SAP AI Core (Extended Plan) instance as a JSON file.

1.  **npm package:**
    This fastest option is intended for feasibility evals of the proxy or for a single user. It is also the only deployment option that comes with an Ollama adapter, which will allow client apps that expect an Ollama API endpoint to work with SAP AI Core.
    The npm package does not include the admin service, which would enable managing keys, analyzing inference costs per user/key, and configuring the gateway service via integrated Fiori and UI5 apps.
    You need to have node 20+ and npm installed. Open your favorite terminal app.

    Use the incantation:
    ```bash
    npm install -g @st-gr/sail-proxy
    ```
    After a successful installation you can execute sail-proxy which will lead you through the installation process:
    ```bash
    sail-proxy
    ```
    Please refer to the integrated `help` command option or the [README.md](npm-dist/sail-proxy/README.md) file of the npm package distribution.

2.  **docker-compose:**
    The docker-compose orchestration requires a docker runtime, e. g. SUSE Rancher Desktop on Windows or Colima on OSX or docker.io on Linux and is meant to run on-premise. It is intended for multi-user use and serves the gateway as well as the admin service which persists its data on a postgres DB.
    You also need nodejs - use the node version manager nvm or the like. A LTS Node 20+ version was used to test this.

    Open a terminal app, change the directory to the desired folder and git clone the repo and change the directory to the repo folder:
    ```bash
    git clone https://github.com/st-gr/sail-proxy.git
    cd sail-proxy
    ```

    There are four Identity Providers supported. 
    - [GitHub OAuth app](docker/configs/providers/github/SETUP.md)
    - [Okta](docker/configs/providers/okta/SETUP.md)
    - [LDAP](docker/configs/providers/ldap/SETUP.md)
    - local (for dev purposes only)

    Read the documentation [README.md](docker/README.md) and corresponding provider documentation, e. g. for GitHub read [SETUP.md](docker/configs/providers/github/SETUP.md).
    OAuth, SAML, LDAP configurations can be difficult at times. If you just want to evaluate then choose the local IdP option which has fixed usernames and passwords.

    Change the directory to the docker subfolder, then run the setup and follow the instructions:
    ```bash
    cd docker
    node setup-docker.js
    ```

    Pull the pre-built Docker images from the registry, then start the services:
    ```bash
    docker-compose pull
    docker-compose up -d
    ```

    If that succeeded, you can check the logs with:
    ```bash
    docker-compose logs
    # press CTRL+C to return to the shell
    ```
    Provided all microservies launched, you can access the admin ui via browser http://localhost:8080/admin/app/shell/
    Logon via IdP or preset local user accounts for `admin` and `user@example.com`, see [README.md](docker/README.md) for details.
    You can now create an **API Key** and test it with your client application. The `docker-compose logs -f gateway` should inform about the gateway endpoints that can be used. You must configure those endpoints as **baseURL** in your LLM client app.

    #### Docker Image Modes

    The Docker deployment supports two modes for managing container images:

    **Registry Mode** (Recommended for End Users - Default)
    - Pulls pre-built multi-arch images per default from the projects container registry (e.g., ghcr.io)
    - Faster startup times (no build step - just download)
    - No build tools or dependencies required
    - Consistent, pre-tested images
    - Core image support for Apple Silicon
    - **Use the commands above**: `docker-compose pull` then `docker-compose up -d`

    **Local Build Mode** (For Developers)
    - Builds images locally on your machine
    - Allows immediate testing of code changes
    - Requires build tools and dependencies installed
    - Takes 10-15 minutes to build all images, and up to 2.5 hours for multi-arch images

    **For Developers - Building Images Locally:**

    If you need to build from source instead of using pre-built images:
    ```bash
    # Switch to local build mode (creates docker-compose.override.yml)
    pnpm docker:use-local

    # Build and start services
    cd docker
    docker-compose up -d --build
    ```

    To switch back to using registry images:
    ```bash
    pnpm docker:use-registry
    ```

    **For Maintainers - Publishing Images to Registry:**

    ```bash
    # Build images with proper tags
    pnpm docker:build
    # or: node docker/scripts/build-and-tag.js

    # Build without cache
    pnpm docker:build:no-cache

    # Push images to container registry (requires docker login)
    docker login ghcr.io
    pnpm docker:push
    # or: node docker/scripts/push-images.js

    # Pull images from registry
    pnpm docker:pull
    # or: node docker/scripts/pull-images.js
    ```

    For multi-arch builds execute `node docker/build-and-tag-multiarch.js` on a machine with buildx multi arch build support.

    **Configuration:**

    Image settings are managed via `docker/.env.docker`:
    ```bash
    DOCKER_REGISTRY=ghcr.io           # Container registry
    DOCKER_ORGANIZATION=st-gr         # Your organization/username
    DOCKER_TAG=0.9.0                  # Version (from package.json)
    ```

    This file is automatically generated by `setup-docker.js` but can be manually edited if needed.

    **Registry-Only Mode:**

    For strict registry-only mode (prevents any local builds):
    ```bash
    cd docker
    docker-compose -f docker-compose.yml -f docker-compose.registry.yml up -d
    ```

3.  **BTP Kyma:**
    The Kyma deployment option is based on the docker deployment, but requires more configuration to run. Please read the [README.md](kyma/docs/README.md) file. In addition to NodeJS, you need to have kubectl installed and configured ([setup guide](kyma/docs/PREREQUISITES.md)).
    Your BTP subaccount needs to have the Kyma runtime enabled. You need access to the Kyma dashboard as the API Server Address is needed, specifically the cluster id, e. g. API Server Address: https://api.a-053c2af.kyma.ondemand.com, 
    you would need the `a-053c2af` substring.

    The same IdP configuration applies as for the docker deployment.

    The simplest deployment is to expose the Kyma pods to the internet, but with an IP whitelist filter. Determine your external IP with websites like `ifconfig.me`. If you know the subnet range (CIDR) of your network, the better, 
    otherwise, you can provide multiple single IP's (/32) for test purposes. 
    **Note:** It is best not to expose the Pods to the internet and use the SAP Cloud Connector to tunnel to your deployment.

    Clone the repo as described in the docker deployment and change the directory to the repo folder. Then change to the kyma subfolder and execute the kyma setup. If you choose to it will also run the deploy script.
    The setup script outputs your **baseURL** of the Kyma deployment.

    ```bash
    cd kyma
    node scripts/setup-kyma.js
    ```
    You can list the running pods using a command like this, provided you chose the default namespace `sail-proxy`:
    ```bash
    kubectl get pods -n sail-proxy
    ```
    You can output the logs of one pod from the previous list of pods, e. g. gateway service pod
    ```bash
    kubectl logs gateway-4932af366e-z174d -n sail-proxy
    ```


4.  **local setup:**
    After cloning the repository and ensuring all prerequisites are met, follow these steps to get the proxy and admin service as well as ValKey running:
    1.  **Check if SAP AI Core is accessible:**
        Use the model deploy tool to access the API to validate that .env files are present and properly configured:
        ```bash
        node cli-tools/sail-model-deploy.js --models
        ```
        If the output is a list of models then the SAP AI Core API access works, otherwise a setup tool needs to be executed, e. g. `node docker/setup-docker.js`

    2.  **Install dependencies:**
        Start an instance of ValKey - with docker installed run:
        ```bash
        docker run -d --name valkey --restart unless-stopped -p 127.0.0.1:6379:6379 valkey/valkey:8
        ```
        Be sure to remember to stop and remove the ValKey container once you no longer need it.

        Open your terminal in the project root and run - this takes a while:
        ```bash
        pnpm install --recursive
        ```

    3. **Build gateway and admin services:**
       ```bash
       # from the project root
       
       # Build the gateway service
       pnpm run build:gateway
       
       # Reset the admin DB (optional, e. g. after db schema changes)
       pnpm --filter admin run db:reset
       
       # Build the admin service
       pnpm run build:admin
       ```


    4.  **Run the admin service, followed by gateway service:**
        When run locally, the admin service uses mocked authentication and a SQLite DB:
        ```bash
        pnpm run dev:ts:mock
        ```

        Wait about 30 seconds for the admin service to start, then you can start the gateway server in two modes:

        *   **Production mode:**
            ```bash
            pnpm start
            ```

        *   **Development mode (with hot-reloading):**
            Read [services/admin/README.md](services/admin/README.md) file under PostgreSQL vs SQLite Configuration. The development mode requires you to comment out the PostgreSQL config in services/admin/.env and add SQLite configuration.

            ```bash
            pnpm run dev
            ```

    5.  **Create an API Key:**
        Navigate your browser to http://localhost:4004/shell/index.html (for user and password refer to "Available Test Users") create and copy an API key to the clipboard.

    6.  **Test inference with CURL:**
        ```bash
        curl -X POST http://localhost:3000/openai/api/v1/chat/completions \
          -H "Authorization: Bearer YOUR_API_KEY" \
          -H "Content-Type: application/json" \
          -d '{
            "model": "gpt-5-mini",
            "messages": [{"role": "user", "content": "Hello!"}]
          }'
        ```

## Local Development Authentication

For local development of the **Admin Service**, the system provides built-in authentication that works without requiring Docker, Dex, or oauth2-proxy dependencies.

### Admin Service Local Authentication

When running the admin service locally (`DEPLOY_TARGET=development` or unset), the system uses CAP's mocked authentication with predefined test users:

```bash
# Start admin service locally
cd services/admin
pnpm run dev
```

**Available Test Users:**
- **admin@test.com** - Full admin access (roles: admin, user, gateway)
  - HTTP Basic Auth: `admin@test.com:admin`
- **user@test.com** - Standard user access (roles: user)
  - HTTP Basic Auth: `user@test.com:user`
- **other@test.com** - Standard user access (roles: user)
  - HTTP Basic Auth: `other@test.com:user`


### Usage Examples

**Browser Access:**
- Navigate to `http://localhost:4004`
- Use any of the test users above for login

**API Testing (cURL):**
```bash
# Admin access
curl -u "admin@test.com:admin" http://localhost:4004/api/admin/api-keys

# User access  
curl -u "user@test.com:user" http://localhost:4004/api/admin/api-keys
```

**API Testing (Bruno/Postman):**
- Set Authorization to "Basic Auth"
- Username: `admin@test.com`, Password: `admin`

### Development vs Docker Deployment

| Mode | Authentication | Requirements | Use Case |
|------|---------------|--------------|-----------|
| **Local Development** | CAP Mocked Auth | None | Quick development, API testing |
| **Docker Deployment** | oauth2-proxy + Dex | Docker, postgres, dex | Production-like testing, multi-user scenarios |

**To switch to Docker mode:**
```bash
# Use Docker Compose for full oauth2-proxy + Dex setup
pnpm run docker:up
# Access via http://localhost:8080 with demo users
```

For Docker deployment details, see the [docker/README.md](docker/README.md) and authentication configuration in `docker/docker-compose.yml`.

## Authentication

This proxy supports different authentication mechanisms depending on the endpoint.

### Automated OAuth Token Management

The proxy automatically handles SAP AI Core authentication using OAuth 2.0 client credentials flow with caching based on credentials from the BTP service key:

- **Automatic token refresh**: Tokens are refreshed automatically before expiry (60-second buffer)
- **Intelligent caching**: Prevents unnecessary token requests - tokens are only fetched when expired
- **Zero configuration**: Just provide `AUTH_URL`, `CLIENT_ID`, and `CLIENT_SECRET` in your environment
- **Error handling**: Comprehensive error handling with structured error responses

## OpenAI, Anthropic and OpenRouter Endpoints
These endpoints require an API key provided in one of the following ways:
- `Authorization: Bearer <api-key>` header (OpenAI style)
- `x-api-key: <api-key>` header (Alternative style)

In standalone mode API keys can be created and managed through the `/api/admin/api-keys` endpoints (see "API Key Management" section), otherwise via the admin service UI or OData endpoints.

## AWS Bedrock Endpoints (`/aws-bedrock/...`)
The AWS Bedrock endpoints support **dual authentication** and route to SAP AI Core foundation models (not directly to AWS Bedrock):

1.  **AWS Signature Version 4 (SigV4)**:
    *   This is the standard authentication method for AWS services.
    *   Use an AWS-style Access Key ID and Secret Access Key. The proxy will validate the SigV4 signature.
    *   Credentials specifically for this proxy can be generated via its `/aws/api-keys` endpoint (see "AWS Credentials Management" section).
2.  **API Key**:
    *   As a fallback or alternative, you can use an API key with the `x-api-key: <api-key>` header.
    *   These are the same API keys used for OpenAI/Anthropic endpoints, managed via `/api/admin/api-keys`.

If a valid SigV4 Authorization header is present, it will be used. Otherwise, the proxy will look for an `x-api-key`.

## API Key Management

All endpoints require authentication using either:
- `Authorization: Bearer <api-key>` header (OpenAI style)
- `x-api-key: <api-key>` header (AWS/Anthropic style)

API keys can be created and managed through the `/api/admin/api-keys` endpoints only in standalone mode of the gateway:

| Endpoint                              | Method | Description                      |
|----------------------------------|-------|------------------------------|
| `/api/admin/api-keys`                 | POST   | Create a new API key             |
| `/api/admin/api-keys`                 | GET    | List all API keys                |
| `/api/admin/api-keys/:id`             | GET    | Get a specific API key           |
| `/api/admin/api-keys/:id`             | PATCH  | Update a specific API key        |
| `/api/admin/api-keys/:key/revoke`     | PATCH  | Revoke a specific API key        |
| `/api/admin/api-keys/revoke-by-email` | POST   | Revoke all API keys for an email |

Example: Setting a specific API key

```bash
curl -X PATCH http://localhost:3000/api/admin/api-keys/12345-uuid \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-admin-api-key" \
  -d '{
    "key": "sk-your-custom-key-value",
    "isActive": true
  }'
```
This is useful if your client app doesn't let you change the API key. Then you can just set it to what it expects.

## AWS Credentials Management (for SigV4)

For using AWS SigV4 authentication with this proxy's Bedrock-style endpoints, you can generate AWS-style credentials. These credentials are for authenticating *to this proxy* (which routes to SAP AI Core), not directly to AWS Bedrock.

| Endpoint                      | Method | Description                                     |
|---------------------------|-------|-------------------------------------------|
| `/aws/api-keys`               | POST   | Create new AWS-style Access Key ID & Secret Key |
| `/aws/api-keys`               | GET    | List all generated AWS Access Key IDs           |
| `/aws/api-keys/{accessKeyId}` | DELETE | Revoke a specific AWS Access Key ID             |

**Example: Creating AWS-style credentials**
```bash
curl -X POST http://localhost:3000/aws/api-keys \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-admin-api-key" \ # This admin endpoint is protected by a standard API key
  -d '{
    "userId": "my-bedrock-user"
  }'
```
Response:
```json
{
  "AWS_ACCESS_KEY_ID": "AKIA...",
  "AWS_SECRET_ACCESS_KEY": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```
**Note:** Store the `AWS_SECRET_ACCESS_KEY` securely as it is only shown once.

## Configuration

### Model Configuration (`model_list_changes`)

The `model_list_changes` section in `api_config.json` allows you to customize model behavior and properties beyond their defaults. This is where you configure model-specific settings, enable/disable features, and attach plugins to specific models.

```json
{
  "api_config": {
    "model_list_changes": {
      "anthropic--claude-3-haiku--deployed": {
        "streamingSupported": true,
        "subpaths_native": ["invoke", "invoke-with-response-stream", "converse", "converse-stream"],
        "subpaths_emulated": [],
        "supports_prompt_caching": true,
        "anthropic_version": "bedrock-2023-05-31",
        "hooks": {
          "invoke-with-response-stream": [
            {
              "request": {
                "match": ["size:1k-3k", "header:x-app=cli"],
                "callback": { "id": "mockWhimsicalGerundVerb", "strategy": "before" }
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
```

**Common configuration properties:**
- **`streamingSupported`**: Override whether the model supports streaming responses
- **`subpaths_native`**: Define which API endpoints the model natively supports
- **`subpaths_emulated`**: Specify endpoints that should be emulated for this model
- **`supports_prompt_caching`**: Enable/disable prompt caching support for cost optimization
- **`anthropic_version`**: Set the Anthropic API version for Bedrock models
- **`hooks`**: Attach plugins to specific model endpoints for custom behavior
- **`cachePricing`**: Configure cache token pricing for accurate cost calculation (see Cache Token Pricing section below)

**When to use `model_list_changes`:**
- Force streaming on/off for specific models
- Configure prompt caching to reduce costs
- Add custom plugins for request/response processing
- Override default model capabilities
- Set provider-specific parameters like `anthropic_version`

### Cache Token Pricing

SAP AI Core supports token caching (since December 2025), but cache token prices are not exposed in the SAP AI Core API response. The `cachePricing` configuration in `api_config.json` can be used to define representative cache token pricing per model based on SAP OSS Note 3437766.

Note: The actual production prices are materially lower than the values shown here.

```json
{
  "api_config": {
    "model_list_changes": {
      "anthropic--claude-4-sonnet--deployed": {
        "cachePricing": {
          "cacheReadInputCostPer1K": "0.00060",
          "cacheCreationInputCostPer1K": "0.00762"
        }
      }
    }
  }
}
```

**Cache pricing fields:**
- **`cacheReadInputCostPer1K`**: Cost per 1,000 cache read tokens
- **`cacheCreationInputCostPer1K`**: Cost per 1,000 cache creation/write tokens

**Pre-configured models with cache pricing:**
| Model | Cache Read (per 1K) | Cache Creation (per 1K) |
|-------|---------------------|-------------------------|
| `anthropic--claude-4-sonnet--deployed` | 0.00060 | 0.00762 |
| `anthropic--claude-4-opus--deployed` | 0.00297 | 0.03708 |
| `anthropic--claude-4.5-sonnet--deployed` | 0.00060 | 0.00762 |
| `anthropic--claude-4.5-haiku--deployed` | 0.00024 | 0.00297 |

**Tiered cache pricing (e.g., Gemini 2.5 Pro):** Some models have tiered pricing where rates differ based on total input token count. For these models, cache pricing can be included in the `complexCost` JSON structure. The figures below are likewise obfuscated, and the actual rates are significantly lower.

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
**Fallback behavior:** If cache pricing is not defined for a model, the system falls back to 100% of the regular input token cost for both cache read and cache creation tokens.

### Model Substitution

You can configure model substitutions using the `/api/admin/api-config` endpoint. This allows you to map model names from the client to different model names used by SAP AI Core.

Example configuration:

```json
{
  "api_config": {
    "openai": {
      "substitute_models": [
        { "from": "GPT-4", "to": "o1" },
        { "from": "GPT-3.5", "to": "GPT-4" }
      ],
      "emulate_streaming_for_models": []
    },
    "anthropic": {
      "substitute_models": [
        { "from": "claude-3-5-haiku-20241022", "to": "anthropic--claude-3-haiku" },
        { "from": "claude-3-7-sonnet-20250219", "to": "anthropic--claude-3.7-sonnet" }
      ],
      "emulate_streaming_for_models": ["anthropic--claude-3.7-sonnet"]
    }
  }
}
```

Please note that Claude Code uses the above model names that need to be substituted so that Claude Code can make use of SAP AI Core Foundation models. Sonnet 4 and Opus 4 obviously have different model names (see services/admin/api_config.json). You must deploy the Claude models that your Claude code version uses, e. g. Claude Sonnet 4.5 to get the best user experience. You can use the `sail-model-deploy.js` script in the `/cli-tools` folder to deploy or use the SAP AI Launchpad.

### Excluded Beta Headers

When using Claude Code or other Anthropic clients, they may send beta feature flags in the `anthropic-beta` header that SAP AI Core doesn't yet support. The `excluded_beta_headers` configuration filters these unsupported flags:

```json
{
  "api_config": {
    "anthropic": {
      "excluded_beta_headers": [
        "prompt-caching-scope-2026-01-05"
      ]
    }
  }
}
```

**Purpose:** Prevents "invalid beta flag" errors from SAP AI Core by removing unsupported beta headers from incoming requests before forwarding them.

**Default:** The default configuration includes `prompt-caching-scope-2026-01-05` which is sent by Claude Code 2.1.30+ but not yet supported by SAP AI Core.

### Model Capability Validation

The gateway automatically validates that models are used with appropriate endpoints based on their capabilities:

**Chat Endpoints** (`/openai/api/v1/chat/completions`, `/anthropic/v1/messages`):
- Reject embedding-only models with clear error messages
- Example error: `"Model text-embedding-3-large is designed for embeddings and cannot be used for chat completions. Use the embeddings endpoint instead."`

**Embedding Endpoints** (`/openai/api/v1/embeddings`):
- Reject models that don't support embeddings
- Example error: `"Model gpt-4 does not support embeddings"`

**Model Discovery**:
- All models (including embedding models) are visible in `/v1/models` endpoint
- Capability validation occurs at request time, not during model listing
- This approach provides better user experience with helpful error messages directing users to the correct endpoint

### Streaming Emulation

For models that don't support streaming natively, you can configure streaming emulation using the `emulate_streaming_for_models` configuration. When enabled, the API will:

1. Make a non-streaming request to SAP AI Core
2. Chunk the response and stream it back to the client
3. Add SSE ping events every 250ms

This capability is meant for client apps that require streamed response to work.

## Example Usage

### OpenAI Chat Completions

```bash
curl -X POST http://localhost:3000/openai/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "gpt-4o",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello, how are you?"}
    ],
    "max_tokens": 100,
    "temperature": 0.7,
    "stream": true
  }'
```

### OpenAI Embeddings

Generate text embeddings using SAP AI Core embedding models:

```bash
curl -X POST http://localhost:3000/openai/api/v1/embeddings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "input": "Hello, this is a sample text for embedding generation!",
    "model": "text-embedding-3-large",
    "encoding_format": "float"
  }'
```

**Supported embedding models:**
- `text-embedding-3-large` - High-dimensional, high-quality embeddings
- `text-embedding-3-small` - Smaller, cost-effective embeddings
- `gemini-embedding` - Google's Gemini embedding model
- `nvidia--llama-3.2-nv-embedqa-1b` - NVIDIA's LLaMA-based embedding model
- `amazon--titan-embed-text` - Embedding model from Amazon

**Features:**
- **OpenAI-compatible API**: Full compatibility with OpenAI's embeddings API format
- **Model validation**: Automatic validation that ensures only embedding-capable models are used
- **Usage tracking**: Comprehensive token usage tracking for cost monitoring
- **Array input support**: Process single strings or arrays of text (first element only due to SAP limitation)
- **SAP AI Core integration**: Uses SAP AI Core's v2 orchestration endpoint for embeddings
- **NVIDIA model support**: Automatic detection and handling of NVIDIA-specific parameters (adds `type: "query"` for NVIDIA models)

**Response format:**
```json
{
  "object": "list",
  "data": [
    {
      "object": "embedding", 
      "index": 0,
      "embedding": [
        -0.002355793,
        0.021651842,
        -0.023071093,
        ...
      ]
    }
  ],
  "model": "text-embedding-3-large",
  "usage": {
    "prompt_tokens": 12,
    "total_tokens": 12
  }
}
```

### Anthropic Messages

```bash
curl -X POST http://localhost:3000/anthropic/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -d '{
    "model": "claude-3-5-haiku-20241022",
    "messages": [
      {"role": "user", "content": "Hello, how are you?"}
    ],
    "system": "You are a helpful assistant.",
    "max_tokens": 100,
    "temperature": 0.7,
    "stream": true
  }'
```

### Anthropic Count Tokens

Count tokens for an Anthropic Messages API request without making an actual inference call. This endpoint performs local tokenization using the `gpt-tokenizer` library, providing fast token estimates without external API calls.

```bash
curl -X POST http://localhost:3000/anthropic/v1/messages/count_tokens \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "Hello, how are you?"}
    ],
    "system": "You are a helpful assistant."
  }'
```

**Response format:**
```json
{
  "input_tokens": 42
}
```

**Features:**
- **Local tokenization**: No external API calls required
- **Model-aware counting**: Uses appropriate tokenizer based on model family (cl100k_base for Claude, o200k_base for Grok)
- **Tool support**: Includes token overhead for tool definitions (+346 tokens for Claude, +480 for Grok)
- **MCP tool optimization**: Skips tool overhead for MCP tools when `anthropic-beta: claude-code*` header is present
- **Full message format support**: Handles string content, array content, images, tool_use, tool_result, and thinking blocks
- **Accuracy multipliers**: Applies model-specific multipliers (1.15x for Claude, 1.03x for Grok) for better estimates

**Use cases:**
- Pre-flight token budget validation before inference calls
- Cost estimation for batched requests
- Context window management in long conversations
- Client-side token tracking without API roundtrips

### AWS Bedrock

#### Using API Key (`x-api-key`)
This example uses the Bedrock `invoke` endpoint for an Anthropic model, authenticating with an API key.
```bash
curl -X POST http://localhost:3000/aws-bedrock/model/anthropic.claude-3-haiku-20240307-v1:0/invoke \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -d '{
    "anthropic_version": "bedrock-2023-05-31",
    "max_tokens": 100,
    "messages": [
      {"role": "user", "content": "Hello from Bedrock via API Key!"}
    ]
  }'
```

#### Using AWS SigV4 Credentials

**1. With `claude` code (for Anthropic models on Bedrock):**
   First, generate AWS-style credentials using the proxy's `/aws/api-keys` endpoint (see "AWS Credentials Management" section). Then, configure `claude` code cli using environment variables:
   ```bash
   # Set these with credentials obtained from the proxy's /aws/api-keys endpoint
   export CLAUDE_CODE_USE_BEDROCK=1
   export AWS_ACCESS_KEY_ID='AKIA...' # Your Access Key ID from the proxy
   export AWS_SECRET_ACCESS_KEY='xxxx...' # Your Secret Access Key from the proxy
   export ANTHROPIC_BEDROCK_BASE_URL='http://localhost:3000/aws-bedrock' # Proxy's Bedrock endpoint

   # Now you can use claude code cli
   claude "Hello from Bedrock via claude-cli and SigV4!"
   ```

   If you see this error in the Claude code console output:
   `API Error (429 {"error":{"message":"Request failed with status code 429","type":"api_error","code":429}}) · Retrying in 1 seconds… (attempt 1/10)`

   Then this has to do with AWS Bedrock rate limits. 
   See [Cannot use AWS Bedrock with Claude Code. Getting API Error (429 Too many tokens)](https://github.com/anthropics/claude-code/issues/1466)

**2. With AWS CLI (for general Bedrock models):**
   This demonstrates using the AWS CLI with the proxy. The `--endpoint-url` parameter is crucial.
   ```bash
   # Set these with credentials obtained from the proxy's /aws/api-keys endpoint
   export AWS_ACCESS_KEY_ID='AKIA...' # Your Access Key ID from the proxy
   export AWS_SECRET_ACCESS_KEY='xxxx...' # Your Secret Access Key from the proxy
   export AWS_DEFAULT_REGION='us-east-1' # Region for CLI, proxy might not use it

   aws bedrock-runtime invoke-model \
     --endpoint-url http://localhost:3000/aws-bedrock \
     --model-id anthropic.claude-3-haiku-20240307-v1:0 \
     --body '{"anthropic_version":"bedrock-2023-05-31","max_tokens":100,"messages":[{"role":"user","content":"Hello from Bedrock via AWS CLI!"}]}' \
     output.json && cat output.json
   ```
   **Note on AWS CLI `--endpoint-url`:** The AWS CLI automatically appends paths like `/model/{modelId}/invoke`. Provide the base path `http://localhost:3000/aws-bedrock`.

### OpenRouter
The OpenRouter and Ollama endpoints were added in an attempt to support GitHub Copilot in VS Code. Read more about that in the VS Code GitHub Copilot use case description below.

```bash
curl http://localhost:3000/openrouter/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "anthropic/anthropic--claude-3.5-sonnet",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```


### Configuring API Settings

```bash
curl -X PATCH http://localhost:3000/api/admin/api-config \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -d '{
    "api_config": {
      "anthropic": {
        "substitute_models": [
          { "from": "claude-3-sonnet-20240229", "to": "claude-3-7-sonnet-20250219" }
        ],
        "emulate_streaming_for_models": ["anthropic--claude-3.7-sonnet"]
      }
    }
  }'
```

## Plugin System

The API server supports a centralized plugin system that dynamically loads JavaScript modules to intercept and modify requests and responses. **All plugin matching logic is centralized in `api_config.json`**.

### How to Write Your Own Plugin

1. Create a JavaScript/TypeScript file in the `/plugins` directory (e.g., `/plugins/myPlugin.js`).
2. Your plugin must export an array of rule objects with **empty match arrays**:

```js
module.exports = [
  {
    id: "myUniquePluginId",              // Unique identifier
    match: [],                         // MUST be empty - matching now in api_config.json
    strategy: "before",                // "before", "after", "stream", or "error"
    handler: async ({ req, res, upstreamResponse, utils }) => {
      // Plugin logic
      // For "before" strategy, return { stop: true/false, response? }
      // For "after" strategy, modify and return upstreamResponse
      // For "stream" strategy, return { chunk, capturedEvents? }
    }
  }
];
```

3. Configure your plugin in `api_config.json` under the model's hooks section:

```json
{
  "model_list_changes": {
    "your-model-name": {
      "hooks": {
        "invoke-with-response-stream": [
          {
            "request": {
              "match": [
                "size:1k-3k",
                "header:x-app=cli",
                "url-regex:.*bedrock.*"
              ],
              "callback": {
                "id": "myUniquePluginId"
              }
            }
          }
        ]
      }
    }
  }
}
```

### Plugin Strategies

- **before**: Executes before the upstream LLM call. Can short-circuit the request by returning `{ stop: true, response }`, or let it continue by returning `{ stop: false }`.
- **after**: Executes after the upstream LLM call. Receives the upstream response and must return a potentially modified response.
- **stream**: Executes on each streaming chunk. Should return `{ chunk, capturedEvents? }` to modify the chunk or capture events for caching.
- **error**: Executes when an error occurs. Receives the error and can transform it before it's sent to the client.

### Matching Features

The centralized configuration supports:
- **url-regex**: Match requests by URL pattern (e.g., `"url-regex:.*bedrock.*"`)
- **Hook arrays**: Configure multiple hooks per operation for sequential execution
- **Per-operation hooks**: Different hooks for `invoke`, `invoke-with-response-stream`, `converse`, etc.

### Utilities Available to Plugins

Plugins have access to a `utils` object with the following helpers:

- **sseWriter**: Helper function to write Server-Sent Events (SSE) for streaming responses
  ```js
  // Example usage in a "before" plugin
  await utils.sseWriter(res, [
    { event: "message_start", data: { /* ... */ } },
    { event: "content_block_delta", data: { text: "Hello" } },
    { event: "message_stop", data: {} }
  ]);
  ```

## Environment Variables

### Required for SAP AI Core Authentication
- `AUTH_URL` - SAP OAuth token URL
- `CLIENT_ID` - SAP OAuth client ID  
- `CLIENT_SECRET` - SAP OAuth client secret

### SAP AI Core Configuration
- `SAP_AI_CORE_URL` - SAP AI Core API URL (e.g., `https://api.ai.prod.us-east-1.aws.ml.hana.ondemand.com`)
- `SAP_AI_RESOURCE_GROUP` - AI Resource Group (default: 'default')

### Application Settings  
- `PORT` - Port to run the server on (default: 3000)
- `CONFIG_FILE_PATH` - Path to store the API configuration (default: './api_config.json')
- `DEBUG` - Set to `true` for verbose logging (e.g., `DEBUG=true`) that also activates a hard coded AWS API Key, see claude code example.

### Gateway Operation Mode
- `GATEWAY_STANDALONE` - Set to `true` to force standalone mode, disabling all distributed services (Valkey, admin service) regardless of other configuration. Useful for local development or testing without dependencies. (default: `false`)

### Example Plugin: mockWhimsicalGerundVerb

The repo includes an example plugin called `mockWhimsicalGerundVerb` that demonstrates both "before" and "after" strategies:

- When configured with `strategy: "before"`, it returns a streaming SSE response with a single whimsical gerund verb chosen at random, completely bypassing the actual LLM call.
- When configured with `strategy: "after"`, it appends a whimsical prefix to the LLM's response.

**Example Configuration in `api_config.json`:**

```json
{
  "model_list_changes": {
    "your-model-id": {
      "hooks": {
        "invoke-with-response-stream": [
          {
            "request": {
              "match": [
                "size:1k-3k",
                "header:x-app=cli", 
                "payload:maxTokens512",
                "payload:temperature1",
                "system:whimsicalPrompt"
              ],
              "callback": {
                "id": "mockWhimsicalGerundVerb"
              }
            }
          }
        ]
      }
    }
  }
}
```

For comprehensive plugin development guide, see [Plugin System Documentation](docs/developer/chapter-13-plugin-system.md).

## Use cases

### Anthropic Claude Code
Use the Amazon Bedrock Runtime API proxy to route Claude Code requests to SAP AI Core models. Since some models (like Haiku 3.5 or Opus 4.1) were previously unavailable, substitution rules were needed (e.g., replacing Haiku 3.5 with Haiku 3). Now that Haiku 4.5, Sonnet 4.5, and Opus 4.5 are available, deploy these directly for full compatibility and avoid using the SAP AI Core Harmonized API.

**Note:** `claude` code cli has a signature quirk where it uses `host: localhost` (without port) in AWS SigV4 signature calculations instead of the standard `host: localhost:3000`. The proxy automatically handles this client variation.

If the environment variable DEBUG=true then the following static AWS credentials are usable (defined in .env file):

```bash
`$ CLAUDE_CODE_USE_BEDROCK=1 AWS_ACCESS_KEY_ID='AKIAIOSFODNN7EXAMPLE' AWS_SECRET_ACCESS_KEY='wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' ANTHROPIC_BEDROCK_BASE_URL='http://localhost:3000/aws-bedrock' claude
```

You can also create your own aws api key using the `/aws/api-keys` endpoint:
POST
```json
{
  "userId": "me@home.org"
}
```

You can also use claude code with the Anthropic endpoint as long as you leverage deployed models (SAP AI Core Orchestration did not support tool use for Anthropic models mid 2025). You also need to deactivate telemetry with an environment variable, otherwise you see API timeout errors which originate from failed POST `https://statsig.anthropic.com` requests.

```bash
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 ANTHROPIC_BASE_URL=http://localhost:3000/anthropic claude
```

If you don't specify an API key as above, then claude code sends the official Anthropic API key as configured in ~/.claude.json, key "primaryApiKey". You can retrieve their key and then overwrite an existing API key with a PATCH http://localhost:3000/api/admin/api-keys/{{id}} request.

Look at Anthropic docs for more information [llm-gateway](https://docs.anthropic.com/en/docs/claude-code/llm-gateway) and how to pass via environment variable `ANTHROPIC_AUTH_TOKEN` or set your own key.

#### 💸 Cost Consideration

**Warning:** SAP AI Core Orchestration lacked support for prompt caching (nor did it support tool calling for Anthropic models). When using Claude models, this was leading to substantial costs and our natural environment (energy = air pollution and heat, water consumption, etc.) as:
- Each request reprocesses the entire prompt template
- Large prompt templates can consume thousands of tokens per request
- Without caching, identical prompts are charged at full token rates repeatedly
In mid December 2025 SAP introduced prompt caching. At the time of writing (January 2026) it is unclear if this really works as advertised.

**AWS Bedrock prompt caching:** If you deploy the model directly, you should, in theory, be able utilize the `cache_control` parameter in your API payload to enable caching. The API responses even indicate, e. g. that input_cache was hit with X tokens. This would reduce the costs significantly, but SAP used to charge the tokens at full rate irrespective of the fact that AWS discounted cached tokens up to 90%. There is a model property in `api_config.json` where you can specify if a model supports prompt caching `"supports_prompt_caching"`. If false then `cache_control` blocks in your payload will be removed. If set to __true__ or __undefined__ then no filtering of `cache_control` elements will take place.

### OpenAI Codex CLI (outdated, worked with older Codex versions prior June 2025)
You can also use the OpenAI Codex CLI to interact with SAP AI Core via your OpenRouter provider. First, create or edit your CLI config file at `~/.codex/config.json`, for example:
```json
{
  "model": "o4-mini",
  "approvalMode": "suggest",
  "fullAutoErrorMode": "ask-user",
  "notify": true,
  "provider": "openrouter",
  "providers": {
    "openrouter": {
      "name": "OpenRouter",
      "baseURL": "http://localhost:3000/openai/v1",
      "envKey": "OPENROUTER_API_KEY"
    }
  },
  "history": { "maxSize": 1000, "saveHistory": true, "sensitivePatterns": [] }
}
```

Then set your environment variables and invoke the CLI:
```bash
OPENAI_API_KEY=your_api_key_from_api_keys_endpoint \
OPENROUTER_API_KEY=your_api_key_from_api_keys_endpoint \
DEBUG=false \
codex --model o4-mini
```
Or export and run:
```bash
export OPENAI_API_KEY=your_api_key_from_api_keys_endpoint
export OPENROUTER_API_KEY=your_api_key_from_api_keys_endpoint
export DEBUG=false
codex --model o4-mini
```

**Note:** Even if you only want to use OpenRouter you will have to define both the OPENAI and OPENROUTER API key, which are identical when using this proxy.

### VS Code with GitHub Copilot

Microsoft open sourced GitHub Copilot and also enabled BYOK (Bring Your Own Key) in Chat via the `Manage Models...` in the chat model dropdown menu. The following providers are "supported": 
- Anthropic
- Azure
- Gemini
- Groq
- OpenAI
- Ollama
- OpenRouter

Except for Ollama none of the providers base URL was configurable in GitHub Copilot (mid June 2025). If SAP AI Core would be in the provider list then you wouldn't read this now as I wouldn't have created this LLM proxy. Since SAP AI Core Orchestration exposes many LLM across multiple providers in a secure way (no model training takes place on your inference requests) we emulate Ollama and OpenRouter. Ollama only via localhost, see `./services/ollama`. Tests with the Ollama provider were not satisfactory as no Agent mode is supported with Ollama and other quirks like wrong rendered chat responses surfaced. This then led to the implemenation of the OpenRouter endpoint support. However we can't configure the base URL of the OpenRouter provider. As a work around the `node ./cli-tools/patch-copilot-chat.js` patch script is provided that you can use at your own risk. Theoretically, but untested you could also patch the endpoints of the other supported providers, e. g. Anthropic, and OpenAI.

There are a bunch of quirks since this VS Code functionality is in 'preview':
- you still need(ed?) a Copilot subscription on top of your own providers subscription to be able to use your own API Key
- no Agentic mode for Ollama (also no Agentic mode for models without SAP AI Core Orchestration tools use capabilities, e. g. Claude Sonnet 3.5)
- you need to configure a new model twice to make it available = enter the `Manage Models...` for your provider and confirm two times
- for OpenRouter sometimes newly added API keys are ignored and the old key is sent to the proxy. If debug logs are enabled, then the failed GitHub Copilot API key is printed in the console and you can then set it see _Example: Setting a specific API key_`_.
- the model sometimes can't see the file you have opened in the editor. Starting a new prompt and explicitly dragging the file into the prompt field sometimes helps.
- Ask mode seems to work best followed by Edit (sometimes doesn't) and Agent mode only for the OpenAI models, e. g. GPT-4.1 and up.
- GitHub Copilot via OpenRouter does not send the max_token hyperparameter. Anthropic models accessed via SAP AI Core Orchestration require the client to send the max_token property. This is configurable in `api_config.json` as otherwise you get an error.
- Some models like Claude Haiku 3 can't process multiple user prompts in a row as they need to alternate between `assistant` and `user`. Either switch the model or implement a plugin that merges subsequent user prompts into one for it to work.

Once the above quirks are fixed then BYOK becomes a real option with VS Code GitHub Copilot.

### mintplexlabs/anythingllm
[Anything-LLM](https://github.com/Mintplex-Labs/anything-llm) is an open-source chat frontend and beyond that you can easily integrate with this LLM Proxy. For each model you can create a separate workspace and configure the LLM name there. Valid LLM names can be found in the `GET /v1/models` response.

The following example was tested on Windows 11 with the LLM proxy started with `pnpm run dev` and listening on `localhost:3000` and SUSE Rancher Desktop.

E. g. dowload the docker image `docker pull intplexlabs/anythingllm` and run the container:
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

Navigate to `http://localhost:3001` and enjoy RAG, WebSearch, MCP and more.

Configure LLM as Generic OpenAI 
http://host.rancher-desktop.internal:3000/openai/api/v1
Since we are running anythingllm from within a SUSE Rancher Docker container guest and our LLM proxy on the host we need to refer to the host via `host.rancher-desktop.internal`. Other docker runtimes might need networking setup, etc.

Here is the LLM config that I used:
Model: gpt-4o
Token context window: 128000
Max Tokens: 4096

### Any other LLM client
You can use **any LLM chat client** that allows you to configure a **custom base URL** and **API key** for one of the supported provider-compatible endpoints. If the client supports these two settings, it should work out of the box with this gateway.

Some tools, especially those built specifically for platforms like **OpenRouter**, ship with **hard-coded base URLs** and offer no way to override them. In those cases, you still have options:

* Fork or clone an open-source AI client,
* Add or expose a configuration option for the base URL,
* Use an agentic coding tool to accelerate the modification if needed.

Once the client can point to your gateway URL, it will behave like a fully supported LLM front-end. Proprietary clients will likely close this loophole to get more telemetry data to mine from its customers.


## Ollama Compatibility Server

This project includes an **Ollama Compatibility Server** (`services/ollama`) that provides full Ollama API compatibility, allowing tools that expect the Ollama API format to work with some SAP AI Core foundation models.
**Note:** The `st-gr/sail-proxy` npm package includes the Ollama service and automatically configures and launches it for you.

### Purpose

The Ollama server acts as an adapter layer that:
- **Translates API formats**: Converts between Ollama's request/response formats and OpenAI API formats
- **Exposes SAP AI Core models**: Makes all SAP AI Core foundation models available through the standard Ollama API
- **Enables tool compatibility**: Allows tools like GitHub Copilot, Continue.dev, and other Ollama-compatible applications to work with enterprise SAP AI infrastructure
- **Handles capabilities mapping**: Automatically maps model capabilities (completion, vision) from SAP AI Core to Ollama format

### Supported Ollama Endpoints

| Endpoint               | Method | Description                                      |
|---------------------|-------|--------------------------------------------|
| `/api/tags`            | GET    | List available models (with capabilities)        |
| `/api/show`            | POST   | Show detailed model information                  |
| `/api/chat`            | POST   | Chat completions (streaming and non-streaming)   |
| `/api/generate`        | POST   | Text generation (streaming and non-streaming)    |
| `/api/embeddings`      | POST   | Generate embeddings (if supported by main proxy) |
| `/api/ps`              | GET    | List running models                              |
| `/api/version`         | GET    | Get server version information                   |
| `/v1/chat/completions` | POST   | OpenAI-compatible chat endpoint (passthrough)    |
| `/v1/models`           | GET    | OpenAI-compatible models endpoint (passthrough)  |

### Quick Start

1. **Navigate to the services/ollama directory**:
   ```bash
   cd services/ollama
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure environment** (copy and edit `.env` file):
   ```bash
   cp .env.example .env
   # Edit .env with your main proxy URL and API key
   ```

4. **Start the Ollama server**:
   ```bash
   pnpm start
   # or use the enhanced startup script:
   ./start.bat  # Windows (auto-fetches API key)
   ```

The Ollama server will start on port **11434** (standard Ollama port) and connect to your main SAP AI Core proxy.

### Configuration

Key environment variables in `services/ollama/.env`:

```properties
# Ollama server settings
OLLAMA_PORT=11434
OLLAMA_HOST=localhost

# Main proxy configuration  
MAIN_PROXY_URL=http://localhost:3000
MAIN_PROXY_API_KEY=sk-your-api-key-here

# Optional settings
DEBUG=true
REQUEST_TIMEOUT=30000
```

### Usage Examples

Once running, you can use any Ollama-compatible tool:

**List models**:
```bash
curl http://localhost:11434/api/tags
```

**Chat with a model**:
```bash
curl http://localhost:11434/api/chat -d '{
  "model": "gpt-4o-mini",
  "messages": [
    {"role": "user", "content": "Hello from Ollama API!"}
  ]
}'
```

**Use with GitHub Copilot or other tools**:
Configure your IDE or tool to use `http://localhost:11434` as the Ollama server endpoint.

### Integration Benefits

- **Zero code changes**: Existing Ollama-compatible applications work immediately
- **Enterprise security**: All requests flow through your authenticated SAP AI Core proxy
- **Model variety**: Access to GPT, Claude, Gemini, and other models through a single Ollama interface
- **Streaming support**: Full streaming compatibility for real-time responses
- **Capability detection**: Automatic detection of model capabilities (text, vision, etc.)

### Testing

The services/ollama service includes comprehensive tests:

```bash
cd services/ollama
npm test  # Run all tests
npm run test:basic     # Basic functionality 
npm run test:openai    # OpenAI compatibility
npm run test:edge      # Edge cases
```

## Support

For issues and feature requests use an [Issue template](https://github.com/st-gr/sail-proxy/.github/ISSUE_TEMPLATE) and log an issue [GitHub issue](https://github.com/st-gr/sail-proxy/issues).

## Inception

The entire codebase was built with an agentic (a.k.a. "vibe") coding approach, which is far more effort than the relaxed name suggests 😉. Tools like Claude Code and VS Studio GitHub Copilot leveraging foremost Claude Sonnet 3.7, later Sonnet 4, and Google Gemini 2.5 Pro. 

## Previous work

There are way better architected and implemented LLM proxies or gateways out there, e. g. a non-exhaustive list:
- LiteLLM
- Portkey
- Eden AI
- TrueFoundry LLM Gateway
- OpenRouter
- ...

Some are commercial. To my knowledge none of them support SAP AI Core Orchestration or deployments and multi-user cost control for SAP AI Core.

## Buy me a coffee ☕

Help support maintaining this repo.

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/L3L11KQN5D)

## Disclaimer

This project is neither developed by nor endorsed by SAP SE.
SAP® and SAP AI Core® are registered trademarks of SAP SE in Germany and in several other countries.
This is not a product of the Stanford Artificial Intelligence Laboratory (SAIL).

## Trademark Attribution Statement

SAP®, SAP AI Core®, SAP BTP®, SAP Generative AI Hub™, SAP AI Launchpad™, and SAP HANA®
are registered trademarks or trademarks of SAP SE (or its affiliates) in Germany and other countries.

OpenAI®, ChatGPT®, GPT-5™, GPT-4®, GPT-4o™, GPT-3.5™, and Codex™
are trademarks or registered trademarks of OpenAI OpCo, LLC.

Anthropic®, Claude™, Claude 3™, Claude Sonnet™, Claude Haiku™, and Claude Code™
are trademarks or registered trademarks of Anthropic PBC.

Amazon Web Services®, AWS®, Amazon Bedrock®, AWS Bedrock™, AWS CLI™,
and AWS Signature Version 4 (SigV4)™ are trademarks of Amazon.com, Inc.
or its affiliates in the United States and/or other countries.

Node.js® is a registered trademark of the OpenJS Foundation.

Ollama™ is a trademark of Infra Technologies, Inc.

OpenRouter™ is a trademark of its respective owner.

Google®, Gemini™, and related marks are trademarks of Google LLC.

Microsoft®, Azure®, Windows®, Visual Studio Code®, GitHub®,
and GitHub Copilot™ are trademarks of Microsoft Corporation
or its affiliates in the United States and/or other countries.

SUSE®, Rancher®, and Rancher Desktop™ are trademarks or registered trademarks
of SUSE LLC and/or Rancher Labs, Inc.

Docker™ is a trademark of Docker, Inc.

Kubernetes® is a registered trademark of The Linux Foundation.

Linux® is the registered trademark of Linus Torvalds.

All other product names, logos, and brands are the property of their
respective owners. Use of these names, logos, and brands does not imply endorsement.

## In Memory

This repository is dedicated to my father, Heinz, who recently passed away.  
May he rest in peace.

## License

This project is licensed under the GNU AGPLv3 License - see the LICENSE file for details.
