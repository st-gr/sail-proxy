# SAP AI Core Local LLM Proxy (sail-proxy)
[![GitHub](https://img.shields.io/badge/github-st%E2%80%93gr%2fsail%E2%80%93proxy-blue?logo=github)](https://github.com/st-gr/sail-proxy)

A command-line tool to run a local proxy for SAP AI Core Foundation Models, enabling applications that use OpenAI, Anthropic, AWS Bedrock, or Ollama API formats to seamlessly access SAP's enterprise AI infrastructure.

## Features

- 🚀 **Easy Setup**: Simple npm install and interactive configuration with SAP BTP service key parsing
- 🔄 **Multi-Provider Support**: OpenAI, Anthropic, AWS Bedrock, OpenRouter, and Ollama API compatibility
- 🔑 **Automatic Authentication**: Auto-generates API keys for secure access with persistence
- 💾 **Credential Persistence**: API keys and AWS credentials automatically saved and restored across gateway restarts
- 🌐 **Ollama Integration**: Full Ollama service with automatic startup and 38+ models
- 📊 **Comprehensive Logging**: Real-time log monitoring with rotation and filtering
- 🔄 **Auto-Update**: Built-in update notifications and easy updates
- ⚙️ **Smart Configuration**: Advanced config management with api_config.json integration
- 🛡️ **Security**: Automatic security key generation and validation

## Prerequisites

- [Enable the AI Core service in SAP BTP](https://help.sap.com/docs/sap-ai-core/sap-ai-core-service-guide/initial-setup).
- **Node.js v20 or higher** and **native ESM** support.
- Ensure an [orchestration deployment is available in the SAP Generative AI Hub](https://help.sap.com/docs/sap-ai-core/sap-ai-core-service-guide/create-deployment-for-orchestration).
  - Use the [`DeploymentApi`](https://github.com/SAP/ai-sdk-js/blob/main/packages/ai-api/README.md#create-a-deployment) from `@sap-ai-sdk/ai-api` [to create a deployment](https://help.sap.com/docs/sap-ai-core/sap-ai-core-service-guide/create-deployment-for-orchestration).
    Alternatively, you can also create deployments using the [SAP AI Launchpad](https://help.sap.com/docs/sap-ai-core/generative-ai-hub/activate-generative-ai-hub-for-sap-ai-launchpad?locale=en-US&q=launchpad).
        There is also the script `sail-model-deploy.js` in the `/cli-tools` folder that provides a fast and easy way to list and deploy foundation models on SAP AI Core in case you operate without SAP AI Launchpad to save costs.
  - Once the deployment is complete, you can access the orchestration service via the `deploymentUrl`.
- Create and download a service key for SAP AI Core on your BTP subaccount (you'll be guided through this during setup).

## Installation

```bash
npm install -g @st-gr/sail-proxy
```

## Quick Start

1. **Initial Setup**
   ```bash
   sail-proxy
   ```
   On first run, you'll be guided through an interactive setup to configure your SAP BTP AI Core service key.

2. **Create an API Key**
   ```bash
   sail-proxy apikey create "my-app"
   ```

3. **Test the Proxy**
   ```bash
   curl -X POST http://localhost:3000/openai/api/v1/chat/completions \
     -H "Authorization: Bearer YOUR_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{
       "model": "gpt-5-mini",
       "messages": [{"role": "user", "content": "Hello!"}]
     }'
   ```

## Commands

### Server Management

- `sail-proxy run` - Start the gateway server (auto-starts Ollama if enabled)
- `sail-proxy stop` - Stop the gateway server (auto-stops Ollama if auto-started)
- `sail-proxy status` - Show server status, health, and API routes

### Configuration Management

- `sail-proxy config` - Interactive configuration with advanced guidance
- `sail-proxy config show` - Display current configuration and api_config.json info
- `sail-proxy config get <key>` - Get a specific configuration value
- `sail-proxy config set <key> <value>` - Set a configuration value
- `sail-proxy config reset` - Reset configuration and run setup again

### API Key Management

- `sail-proxy apikey create [name]` - Create a new API key (automatically persisted)
- `sail-proxy apikey list` - List all API keys (masked for security)
- `sail-proxy apikey revoke <key>` - Revoke an API key (removes from persistent storage)
- `sail-proxy apikey set <id> <key>` - Set a custom API key value

**Note**: API keys are automatically persisted to `~/.sail-proxy/apikeys.json` and restored when the gateway starts. This ensures your API keys survive gateway restarts in standalone mode.

### AWS Credentials (for Bedrock emulation)

- `sail-proxy awscred create <userId>` - Create AWS-style credentials (automatically persisted)
- `sail-proxy awscred list` - List all AWS credentials
- `sail-proxy awscred revoke <accessKeyId>` - Revoke AWS credentials (removes from persistent storage)

**Note**: AWS credentials are automatically persisted to `~/.sail-proxy/aws-credentials.json` and restored when the gateway starts. This ensures your AWS credentials survive gateway restarts in standalone mode.

### Models

- `sail-proxy models list` - List 38+ available models with rich details
- `sail-proxy models list --json` - List models in JSON format
- Uses unauthenticated OpenRouter endpoint for reliable access

### Ollama Service

- `sail-proxy ollama start` - Start Ollama service (auto-configures API keys)
- `sail-proxy ollama stop` - Stop Ollama service
- `sail-proxy ollama status` - Show detailed Ollama status with version info
- Automatic API key management and port synchronization

### Logging System

- `sail-proxy logs [service]` - View logs for gateway, ollama, or all services
- `sail-proxy logs --follow` - Follow logs in real-time (like tail -f)
- `sail-proxy logs --tail <n>` - Show last N lines
- `sail-proxy logs --since <time>` - Show logs since specific time
- `sail-proxy logs --clear` - Clear all log files

### Updates

- `sail-proxy update` - Check for and install updates from npm registry
- Manual check: `npm outdated -g @st-gr/sail-proxy`
- Manual update: `npm update -g @st-gr/sail-proxy`

## Configuration

Configuration files are stored in:
- Linux/macOS: `~/.sail-proxy/`
- Windows: `%APPDATA%/sail-proxy/`

### Persistent Storage Files

- `apikeys.json` - Persisted API keys (automatically restored on startup)
- `aws-credentials.json` - Persisted AWS credentials (automatically restored on startup)
- `.env` - Main configuration and SAP BTP service key settings
- `api_config.json` - Advanced gateway configuration
- `ollama.env` - Ollama service configuration

### Environment Variables

The `.env` file contains automatically parsed values from your SAP BTP service key:
- `SAP_AI_CORE_URL` - SAP AI Core API endpoint (auto-extracted)
- `SAP_AI_RESOURCE_GROUP` - Resource group (default: "default")  
- `SAP_AI_REGION` - SAP AI region (auto-parsed, e.g., "prod.us-east-1")
- `AUTH_URL` - OAuth token endpoint (auto-appends /oauth/token)
- `CLIENT_ID` - OAuth client ID (from service key)
- `CLIENT_SECRET` - OAuth client secret (from service key)
- `PORT` - Server port (default: 3000, configurable during setup)
- `GATEWAY_STANDALONE` - Enables standalone mode (auto-set to true)
- `OLLAMA_AUTOSTART` - Auto-start Ollama service (configurable during setup)
- `VALIDATION_TOKEN_SECRET` - Auto-generated security key
- `METADATA_ENCRYPTION_KEY` - Auto-generated security key

### Advanced Configuration

The `api_config.json` file contains advanced gateway settings:
- **Model substitutions** - Map client model names to SAP AI Core models
- **Streaming emulation** - Enable streaming for non-streaming models  
- **Plugin hooks** - Intercept and modify requests/responses
- **Logging levels** - Fine-tune component-specific logging
- **Rate limiting** - Configure request rate limits and delays
- **Caching settings** - AWS Bedrock response caching configuration

## API Endpoints

The proxy provides the following API endpoints:

| Provider | Endpoint | Description |
|----------|----------|-------------|
| OpenAI | `/openai/api/v1/chat/completions` | OpenAI chat completions API |
| OpenAI | `/openai/v1/chat/completions` | OpenAI chat completions alias |
| OpenAI | `/openai/api/v1/embeddings` | OpenAI embeddings API → SAP AI Core |
| OpenAI | `/openai/v1/embeddings` | OpenAI embeddings alias |
| OpenAI | `/openai/api/v1/responses` | OpenAI Responses API (deployed GPT-5+ models) |
| OpenAI | `/openai/v1/responses` | OpenAI Responses alias |
| Anthropic | `/anthropic/v1/messages` | Anthropic messages API |
| AWS Bedrock | `/aws-bedrock/model/{modelId}/invoke` | Bedrock invoke API |
| AWS Bedrock | `/aws-bedrock/model/{modelId}/invoke-with-response-stream` | Bedrock streaming API |
| AWS Bedrock | `/aws-bedrock/model/{modelId}/converse` | Bedrock converse API |
| AWS Bedrock | `/aws-bedrock/model/{modelId}/converse-stream` | Bedrock converse streaming |
| OpenRouter | `/openrouter/api/v1/chat/completions` | OpenRouter chat API |
| OpenRouter | `/openrouter/api/v1/responses` | OpenAI Responses alias under the OpenRouter prefix |
| OpenRouter | `/openrouter/api/v1/models` | OpenRouter models (unauthenticated) |
| Ollama | `http://localhost:11434/api/*` | Full Ollama API compatibility |
| Common | `/v1/models` | List available models (authenticated) |
| Admin | `/api/admin/api-keys` | API key management |
| Admin | `/aws/api-keys` | AWS credentials management |

### Codex CLI

The Responses routes serve **deployed** GPT-5+/o-series models (e.g. `gpt-5.3-codex--deployed`), which is what Codex CLI speaks. Point it at the gateway with `wire_api = "responses"` and `base_url = "http://localhost:3000/openai/v1"`.

Two tool types that SAP AI Core rejects are handled for you, so no Codex flags are needed:

- **Hosted `web_search`** is emulated gateway-side through Perplexity `sonar-pro`; the model then answers from the results.
- **Sub-agent tools** (`multi_agent`) arrive wrapped in a `namespace` entry SAP refuses — the gateway flattens it outbound and restores the routing namespace on the way back.

Verified against Codex CLI 0.145.0 and 0.146.0. See the project's `docs/user/chapter-2-features.md` for the full `config.toml`.

## Usage Examples

### With OpenAI SDK

```javascript
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: 'sk-your-generated-api-key',  // Get with: sail-proxy apikey create
  baseURL: 'http://localhost:3000/openai/v1'  // Default port 3000
});

const completion = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello!" }]
});
```

### With Anthropic SDK

```javascript
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: 'sk-your-generated-api-key',  // Same API key as OpenAI
  baseURL: 'http://localhost:3000/anthropic'
});

const message = await anthropic.messages.create({
  model: 'claude-sonnet-4-5-20250929',  // Automatically mapped to SAP AI Core
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello!' }]
});
```

### With AWS SDK (Bedrock)

First create AWS credentials:
```bash
sail-proxy awscred create "my-user"
```

Then use with AWS SDK:
```bash
export AWS_ACCESS_KEY_ID='AKIA...'  # From sail-proxy awscred create
export AWS_SECRET_ACCESS_KEY='...'  # From sail-proxy awscred create

aws bedrock-runtime invoke-model \
  --endpoint-url http://localhost:3000/aws-bedrock \
  --model-id anthropic.claude-3-haiku-20240307-v1:0 \
  --body '{"anthropic_version":"bedrock-2023-05-31","max_tokens":1024,"messages":[{"role":"user","content":"Hello!"}]}' \
  output.json
```

## Troubleshooting

### Server won't start
- Check if port is already in use: `sail-proxy status`
- Try a different port: `sail-proxy config set PORT 3001`
- Check logs: `sail-proxy logs gateway --tail 20`
- Verify configuration: `sail-proxy config show`

### Authentication errors
- Verify your service key: `sail-proxy config reset`
- Check API key validity: `sail-proxy apikey list`
- Test models endpoint: `sail-proxy models list`
- Check network connectivity to SAP AI Core

### Models not showing  
- Wait for initial model loading (can take 30+ seconds)
- Check gateway health: `sail-proxy status`
- View real-time logs: `sail-proxy logs gateway --follow`
- Restart services: `sail-proxy stop && sail-proxy run`

### Ollama timeouts
- API keys are auto-generated - no manual setup needed
- Check Ollama logs: `sail-proxy logs ollama --tail 20`
- Verify port synchronization: `sail-proxy config show`
- Restart with debug: Set `DEBUG=true` in `~/.sail-proxy/.env`

### Configuration issues
- Reset configuration: `sail-proxy config reset`
- Check advanced settings: Edit `~/.sail-proxy/api_config.json`
- View current settings: `sail-proxy config show`
- Update specific values: `sail-proxy config set <key> <value>`

## Support

For issues and feature requests use an [Issue template](https://github.com/st-gr/sail-proxy/.github/ISSUE_TEMPLATE) and log an issue [GitHub issue](https://github.com/st-gr/sail-proxy/issues).

## License

GNU AGPLv3 - see LICENSE for details

## Disclaimer

This project is neither developed by nor endorsed by SAP SE nor is it a product of the Stanford Artificial Intelligence Laboratory (SAIL).
