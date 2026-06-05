---
title: SAIL-PROXY User Guide - Chapter 5
author: st-gr
date: 2025-01-28
mainfont: Helvetica, Arial, sans-serif
fontsize: 18px
---

# SAIL-PROXY User Guide
*Multi-provider AI Gateway for SAP AI Core*
**Author:** *st-gr*

[<< Previous Chapter](chapter-4-claude-code.md) | [Content Table](README.md) | [Next Chapter >>](chapter-6-admin-cockpit.md)

---

## Using with GitHub Copilot

GitHub Copilot is GitHub's AI-powered code completion tool. SAIL-PROXY enables you to route GitHub Copilot Chat requests through SAP AI Core using a patching script that redirects the extension's OpenRouter API calls.

**Note**: This integration works with the GitHub Copilot Chat VS Code extension. The GitHub Copilot CLI does not support custom API endpoint configuration.

### Prerequisites

- **SAIL-PROXY installed and running**
- **Valid API key** created through SAIL-PROXY
- **GitHub Copilot Chat extension** installed in VS Code
- **GitHub Copilot license** (Individual, Business, or Enterprise)
- **Node.js** installed (for running the patch script)

### Understanding GitHub Copilot Capabilities

**GitHub Copilot Chat (VS Code Extension)**:
- Can be patched to use SAIL-PROXY (using `cli-tools/patch-copilot-chat.js`)
- Provides inline code suggestions and chat interface
- Supports custom model selection

**GitHub Copilot CLI**:
- Uses commands: `copilot` (interactive), `copilot -p "prompt"` (programmatic), `/model` (change model)
- **Does NOT support** custom API endpoint configuration
- **Does NOT have** `gh copilot suggest`, `gh copilot explain`, or `gh copilot config` commands
- Cannot be redirected to SAIL-PROXY

### Method 1: GitHub Copilot Chat IDE Integration

This method patches the GitHub Copilot Chat VS Code extension to route requests through SAIL-PROXY's OpenRouter-compatible endpoint.

#### Setup Steps

1. **Start SAIL-PROXY**:
```bash
# CLI users
sail-proxy run

# Docker users
docker-compose up -d

# Verify SAIL-PROXY is running
curl http://localhost:3000/health
```

2. **Install GitHub Copilot Chat extension in VS Code**:
   - Open VS Code
   - Install "GitHub Copilot" and "GitHub Copilot Chat" extensions
   - Sign in with your GitHub account that has Copilot access

3. **Run the patch script**:

**For Local Docker Deployments**:
```bash
# Navigate to SAIL-PROXY directory
cd /path/to/sail-proxy

# Run patch script with default URL (http://localhost:3000/openrouter/api/v1)
node cli-tools/patch-copilot-chat.js
```

**For Remote Server Deployments**:
```bash
# If SAIL-PROXY is deployed on a remote server, use the server's URL
node cli-tools/patch-copilot-chat.js --base_url=https://your-server.example.com/openrouter/api/v1
```

**For Kyma Deployments**:
```bash
# Use your actual Kyma domain (from the Kyma deployment output)
node cli-tools/patch-copilot-chat.js --base_url=https://your-subdomain.your-cluster-id.kyma.ondemand.com/gateway/openrouter/api/v1
```

**Important**: The `--base_url` parameter must match where SAIL-PROXY is actually deployed:
- **Local Docker**: `http://localhost:3000/openrouter/api/v1` (default)
- **Remote Server**: `https://your-server.example.com/openrouter/api/v1`
- **Kyma**: `https://your-kyma-domain/gateway/openrouter/api/v1`

The script will:
- Locate your VS Code Copilot Chat extension
- Create a backup of `extension.js` (as `extension.js.bak`)
- Patch the extension to redirect OpenRouter API calls to SAIL-PROXY
- Running the script again will toggle the patch (revert/apply)

4. **Restart VS Code** to load the patched extension.

5. **Configure GitHub Copilot Chat to use OpenRouter**:
   - Click the **GitHub Copilot icon** in the status bar (bottom of VS Code)
   - Click **"Open Chat"** in the popup menu
   - In the chat panel, click the **currently selected AI model** in the bottom right corner
   - Select **"Manage Models"** → **"Choose Your AI Provider"**
   - Select **"OpenRouter"** from the list of providers
   - Enter your **SAIL-PROXY API key** when prompted
   - Select your desired AI model from the list (e.g., `gpt-4o`, `claude-3-5-sonnet-20241022`)

6. **Verify the integration**:
   - Open a code file in VS Code
   - Use GitHub Copilot Chat (`Ctrl+Shift+I` or `Cmd+Shift+I`)
   - Ask a question or request code assistance
   - Your requests should now route through SAIL-PROXY to SAP AI Core
   - Check SAIL-PROXY logs to confirm requests are being received:
     ```bash
     sail-proxy logs --follow | grep "openrouter"
     ```

**Note**: GitHub Copilot Agent Mode may have limitations with certain OpenRouter models if they do not explicitly announce tool support via the OpenRouter API, even if the underlying model natively supports function calling.

#### How the Patch Works

The patch script (`cli-tools/patch-copilot-chat.js`):
- Replaces `https://openrouter.ai/api/v1` with your SAIL-PROXY OpenRouter endpoint
- Creates automatic backups before modifying files
- Can be reverted by running the script again
- Works cross-platform (Windows, macOS, Linux, WSL)

**Warning**: Patching VS Code extensions is at your own risk. The patch modifies the Copilot Chat extension files. Updates to the GitHub Copilot Chat extension will require re-applying the patch.

### Method 2: Ollama Endpoint (No Patching Required)

GitHub Copilot Chat natively supports Ollama as a provider, and SAIL-PROXY includes an Ollama compatibility server. This method works **without patching** the extension.

#### Important Limitations

Based on testing, the Ollama provider has significant limitations:
- **No Agent Mode support** - Agentic features don't work with Ollama provider
- **Rendering issues** - Chat responses sometimes render incorrectly
- **Limited functionality** - These issues led to implementing the OpenRouter patching approach (Method 1)

**Recommendation**: Use Method 1 (OpenRouter with patching) for the best GitHub Copilot experience. Only use Ollama if you cannot patch the extension.

#### Setup Steps (Ollama)

1. **Start SAIL-PROXY with Ollama service**:

**npm package users**:
```bash
sail-proxy run
sail-proxy ollama start  # Starts Ollama service on port 11434
```

**Docker users**:
```bash
# Ollama service is included and starts automatically
docker-compose up -d
```

2. **Configure GitHub Copilot Chat to use Ollama**:
   - Click the **GitHub Copilot icon** in the status bar
   - Click **"Open Chat"**
   - Click the **model selector** in the bottom right
   - Select **"Manage Models"** → **"Choose Your AI Provider"**
   - Select **"Ollama"** from the list
   - The default URL `http://localhost:11434` should work automatically
   - Select a model from the list (e.g., `gpt-4o`, `claude-3-5-sonnet-20241022`)

3. **Test the integration**:
   - Use GitHub Copilot Chat for basic questions
   - Note: Agent mode and some advanced features will not work

### Available Models

Configure which SAP AI Core models to use through SAIL-PROXY:

```bash
# List available models
curl http://localhost:3000/openrouter/api/v1/models \
  -H "Authorization: Bearer your-sail-proxy-api-key"

# Common models accessible:
# - gpt-4o (GPT-4 Omni via SAP AI Core)
# - gpt-4 (GPT-4 via SAP AI Core)
# - claude-3-5-sonnet-20241022 (Claude Sonnet)
# - gemini-2.0-flash-exp (Google Gemini)
```

### Advanced Configuration

#### GitHub Copilot Chat Features

Once patched, you can use all standard GitHub Copilot Chat features:

**Inline Chat**:
- Select code and press `Ctrl+I` (or `Cmd+I` on Mac)
- Ask Copilot to explain, refactor, or fix the code
- Requests route through SAIL-PROXY to SAP AI Core

**Chat Panel**:
- Open with `Ctrl+Shift+I` (or `Cmd+Shift+I` on Mac)
- Ask general coding questions
- Get code suggestions and explanations

**Slash Commands** (in Copilot Chat):
- `/explain` - Explain selected code
- `/fix` - Suggest fixes for problems
- `/tests` - Generate unit tests
- `/help` - Show available commands

### Monitoring and Usage

#### Track GitHub Copilot Usage Through SAIL-PROXY

**CLI Monitoring**:
```bash
# Monitor GitHub Copilot requests in real-time
sail-proxy logs --follow | grep "openrouter"

# Check usage statistics
sail-proxy logs --tail 1000 | grep -c "openrouter"

# Monitor specific model usage
sail-proxy logs --follow | grep "gpt-4o"
```

**Admin Dashboard** (Docker deployment):
![GitHub Copilot Usage Analytics](/docs/assets/usage-dashboard-claude-code.png)

The Admin Dashboard provides insights into your GitHub Copilot usage:
- **Request Volume**: Track Copilot usage patterns over time
- **Model Distribution**: See which AI models Copilot uses most
- **Cost Analysis**: Monitor token usage and associated costs
- **Performance Metrics**: Response times and success rates

### Troubleshooting

#### Common Issues

**Patch Not Working**:
```bash
# Verify the extension is installed
ls ~/.vscode/extensions/ | grep copilot-chat

# Check for backup file
ls ~/.vscode/extensions/github.copilot-chat-*/dist/extension.js.bak

# Revert patch and try again
node cli-tools/patch-copilot-chat.js  # Reverts if already applied
node cli-tools/patch-copilot-chat.js  # Applies fresh patch
```

**VS Code Not Loading Patched Extension**:
```bash
# Fully restart VS Code (not just reload window)
# On macOS/Linux:
killall "Code"

# On Windows:
taskkill /F /IM Code.exe

# Then restart VS Code
```

**SAIL-PROXY Connection Issues**:
```bash
# Verify SAIL-PROXY is running
curl http://localhost:3000/health

# Check OpenRouter endpoint
curl http://localhost:3000/openrouter/api/v1/models

# Test with your API key
curl -H "Authorization: Bearer your-sail-proxy-api-key" \
     http://localhost:3000/openrouter/api/v1/models
```

**Extension Updates Reset Patch**:
- GitHub Copilot Chat extension updates will overwrite the patch
- Re-run the patch script after any extension updates:
  ```bash
  node cli-tools/patch-copilot-chat.js
  ```

#### Performance Optimization

**Reduce Latency**:
- Use faster models (gpt-4o-mini) for simple completions
- Deploy SAIL-PROXY closer to your development environment
- Monitor network latency between VS Code and SAIL-PROXY

**Manage API Limits**:
- Set appropriate rate limits per API key in SAIL-PROXY
- Monitor usage through the Admin Dashboard
- Configure quotas to prevent unexpected costs

### Limitations and Considerations

#### Current Limitations

- **Patch Maintenance**: GitHub Copilot Chat extension updates will reset the patch
- **CLI Not Supported**: GitHub Copilot CLI cannot be configured to use SAIL-PROXY
- **Extension-Only**: Only works with VS Code GitHub Copilot Chat extension
- **Manual Patching**: Requires running the patch script for each extension update

#### Security Considerations

- **Code Privacy**: All code suggestions route through SAIL-PROXY to SAP AI Core, ensuring enterprise governance
- **API Key Security**: Protect your SAIL-PROXY API keys like any sensitive credentials
- **Network Security**: Use HTTPS for Kyma deployments and consider VPN for production environments
- **Patch Verification**: Backup files are created automatically before patching

#### Best Practices

**Development Workflow**:
- **Test integration** with simple queries before complex tasks
- **Monitor usage** through SAIL-PROXY Admin Dashboard
- **Keep backup files** created by the patch script
- **Re-patch after updates** to the GitHub Copilot Chat extension

**Team Management** (Docker/Kyma deployment):
- **Create separate API keys** for different team members or projects
- **Set usage quotas** in SAIL-PROXY to manage costs
- **Monitor security events** for unusual access patterns
- **Document the patching process** for team members

**Reverting the Patch**:
```bash
# Run the patch script again to revert
node cli-tools/patch-copilot-chat.js

# Or manually restore from backup
cp ~/.vscode/extensions/github.copilot-chat-*/dist/extension.js.bak \
   ~/.vscode/extensions/github.copilot-chat-*/dist/extension.js
```

---

*Next: Learn about [managing access and monitoring usage](chapter-6-admin-cockpit.md) with the Admin Cockpit.*