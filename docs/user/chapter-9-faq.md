---
title: SAIL-PROXY User Guide - Chapter 9
author: st-gr
date: 2025-01-28
mainfont: Helvetica, Arial, sans-serif
fontsize: 18px
---

# SAIL-PROXY User Guide
*Multi-provider AI Gateway for SAP AI Core*
**Author:** *st-gr*

[<< Previous Chapter](chapter-8-troubleshooting.md) | [Content Table](README.md)

---

## FAQ

### General Questions

#### What is SAIL-PROXY?
SAIL-PROXY is a multi-provider AI gateway that enables applications built for OpenAI, Anthropic, AWS Bedrock, OpenRouter, or Ollama APIs to seamlessly work with SAP AI Core Foundation Models. It acts as a translation layer with enterprise-grade security, monitoring, and management capabilities.

#### Is SAIL-PROXY a direct connection to AI providers like OpenAI or Anthropic?
**No**. SAIL-PROXY routes all requests through SAP AI Core's Orchestration API. This ensures enterprise compliance, governance, and cost control while maintaining compatibility with popular AI development tools.

#### What's the difference between CLI and Docker deployments?
- **CLI**: Single-user tool ideal for individual developers. Simple installation via npm. No web interface.
- **Docker**: Multi-user enterprise deployment with Admin Cockpit, OAuth2 authentication, role-based access control, and comprehensive monitoring.

#### Can I use both CLI and Docker deployments simultaneously?
Yes, but they operate independently. CLI is typically used for development, while Docker is used for team/production environments. They can point to the same SAP AI Core instance but manage separate API keys and configurations.

### Installation & Setup

#### What are the minimum system requirements?
- **Node.js 20+** (for native ESM support)
- **SAP BTP Service Key** for AI Core access
- **Docker & Docker Compose** (for Docker deployment)
- **2GB RAM minimum** (4GB recommended for Docker deployment)

#### How do I get a SAP AI Core service key?
1. Access SAP BTP Cockpit
2. Navigate to your AI Core service instance
3. Go to Service Keys section
4. Create a new service key or use an existing one
5. Copy the JSON service key for configuration

#### Can I run SAIL-PROXY on Windows?
Yes. For CLI deployment, use Node.js on Windows. For Docker deployment, use Docker Desktop. For the best experience on Windows, consider using WSL2 (Windows Subsystem for Linux).

#### Do I need admin rights to install SAIL-PROXY?
- **CLI**: No admin rights needed if using npm prefix configuration
- **Docker**: Admin rights may be needed for Docker installation and port binding
- **Enterprise**: Contact your IT administrator for installation assistance

### Authentication & Security

#### How secure is SAIL-PROXY?
SAIL-PROXY implements the following security features:
- API keys encrypted at rest with AES-256
- All communication with SAP AI Core uses OAuth2 + TLS or JWT
- Comprehensive audit logging and security event tracking
- Role-based access control (Docker deployment)
- Optional IP restrictions and rate limiting (planned)

#### What happens to my data?
All requests and responses go through SAP AI Core, which follows SAP's data protection and privacy policies. SAIL-PROXY logs metadata (timestamps, token counts, response times) but does not store request/response content by default. Not a SaaS app.

#### How often should I rotate API keys?
**Recommended**: Every 90 days for production environments. For development, rotate when:
- Key is compromised
- Developer leaves the project
- Switching between environments
- Security policy requires it

#### Can I restrict API keys to specific IP addresses?
Yes, all deployment types support IP allowlisting:
```bash
# CLI: Set during key creation (future feature)
# Docker: Configure via Admin Cockpit
# Kyma: Configure during setup - creates AuthorizationPolicy in istio-system
IP Restrictions: 192.168.1.0/24, 10.0.0.100
```

**Note for Kyma deployments**: IP restrictions are enforced at the Istio ingress gateway level via AuthorizationPolicies in the `istio-system` namespace, providing network-level access control before requests reach your application.

### Usage & Integration

#### Which AI tools work with SAIL-PROXY?
SAIL-PROXY supports any tool that uses these API formats:
- **OpenAI API**: OpenAI SDK, ChatGPT plugins, most AI tools
- **Anthropic API**: Anthropic SDK, Claude-based applications
- **AWS Bedrock**: AWS CLI, Boto3, AWS SDKs
- **Ollama API**: Ollama client, Ollama-compatible tools
- **OpenRouter**: GitHub Copilot (with configuration), OpenRouter-compatible tools

#### Can I use SAIL-PROXY with my existing code?
Yes! Simply change the base URL and API key:
```javascript
// Before: Direct OpenAI
const client = new OpenAI({
  apiKey: 'sk-your-openai-key',
  baseURL: 'https://api.openai.com/v1'
});

// After: Through SAIL-PROXY
const client = new OpenAI({
  apiKey: 'your-sail-proxy-key',
  baseURL: 'http://localhost:3000/openai/v1'
});
```

#### What models are available through SAIL-PROXY?
Available models depend on your SAP AI Core configuration. Common models include:
- gpt-5, gpt-4.1, gpt-4o
- Claude 4 Sonnet, Claude 4 Opus, Claude 3 Haiku
- AWS Bedrock models (Amazon: Nova Premier, etc.)
- Google Models (Google: Gemini 2.5 Pro, etc.)

Check availability: `curl -H "Authorization: Bearer your-key" http://localhost:3000/v1/models`

#### Does SAIL-PROXY support streaming?
Yes! SAIL-PROXY supports:
- **Native streaming** for models that support it
- **Streaming emulation** for batch models (simulates streaming)
- **Server-Sent Events (SSE)** format compatibility

### Performance & Costs

#### How fast is SAIL-PROXY compared to direct API calls?
SAIL-PROXY adds minimal latency (typically <100ms) for:
- Request translation and routing
- Authentication and authorization
- Logging and monitoring

Total response time depends mainly on SAP AI Core and the selected model.

#### Does SAIL-PROXY cache responses?
Yes, when enabled:
- **Configurable caching** with plugin
- **TTL-based expiration** (default: 5 minutes)
- **Cache invalidation** for dynamic content
- **Per-model caching policies**

#### How much does SAIL-PROXY cost to run?
SAIL-PROXY itself is open source. Costs include:
- **SAP AI Core usage**: Based on token consumption
- **Infrastructure**: Server costs for Docker deployment
- **Optional services**: Redis, PostgreSQL for production setup

The main cost driver is SAP AI Core token usage, not SAIL-PROXY operation.

#### Can I monitor usage and costs?
Yes:
- **CLI**: Basic logging with token counts
- **Docker**: Comprehensive analytics dashboard with cost tracking, usage trends, and budget alerts
- **Integration**: Export data to external monitoring systems via event bus

### Technical Questions

#### What happens if SAP AI Core is unavailable?
SAIL-PROXY will return appropriate error messages:
```json
{
  "error": {
    "message": "Service temporarily unavailable",
    "type": "service_error",
    "code": "upstream_unavailable"
  }
}
```

Consider implementing retry logic in your applications.

#### Can I customize request/response processing?
Yes, through the plugin system:
- **Request hooks**: Modify requests before sending to SAP AI Core
- **Response hooks**: Transform responses before returning to client
- **Streaming hooks**: Real-time stream processing
- **Error hooks**: Custom error handling

#### Does SAIL-PROXY support multiple SAP AI Core instances?
Currently, each SAIL-PROXY instance connects to one SAP AI Core instance. For multiple instances:
- Deploy separate SAIL-PROXY instances
- Use different API keys/ports
- Consider load balancing for high availability
- This is a roadmap item candidate

#### What databases does SAIL-PROXY support?
- **Development**: SQLite (default for CLI and development Docker)
- **Production**: PostgreSQL (recommended for Docker deployment)
- **Future**: SAP HANA XSA support planned, maybe HANA Cloud

### Deployment & Operations

#### Can I run SAIL-PROXY in production?
Yes! The Docker deployment is production-ready with:
- OAuth2 enterprise authentication
- PostgreSQL database
- SSL/HTTPS support
- Health checks and monitoring
- Horizontal scaling capabilities

#### How do I upgrade SAIL-PROXY?
**CLI**:
```bash
npm update -g @st-gr/sail-proxy
```

**Docker**:
```bash
docker-compose pull  # Get latest images
docker-compose up -d  # Restart with new images
```

#### Does SAIL-PROXY support high availability?
Yes:
- **Stateless gateway**: Multiple instances behind load balancer
- **Database clustering**: PostgreSQL master/replica setup
- **Cache clustering**: Redis cluster for distributed caching
- **Health checks**: Built-in endpoints for monitoring

#### Can I integrate SAIL-PROXY with my monitoring system?
Yes:
- **Health endpoints**: `/health`, `/metrics`
- **Structured logging**: JSON format with correlation IDs
- **Webhooks**: Real-time notifications for events

### Admin & Management

#### Who becomes the first administrator in Docker deployment?
Whoever has the admin role becomes an Administrator. This user can then manage keys, credentials for other users and see unrestricted security events and usage statistics.

#### Can I bulk import users?
No, maybe a roadmap item in future

#### How do I backup SAIL-PROXY data?
**CLI**: Configuration and keys are stored locally
**Docker**:
```bash
# Database backup (actual user and pw differ, see .env)
docker-compose exec postgres pg_dump -U postgres sail_proxy > backup.sql

# Configuration backup
cp -r config/ backup/config/
```

#### What's the difference between Docker and Kyma deployments?
- **Docker**: Runs on local infrastructure with Docker Compose. Uses localhost URLs and basic reverse proxy.
- **Kyma**: Runs on SAP BTP Kyma Runtime with Istio service mesh. Requires strict hostname validation for security and uses enterprise-grade ingress gateways.

**IP Restrictions**: In Kyma deployments, IP allowlists are implemented as Istio AuthorizationPolicies in the `istio-system` namespace, which control access at the ingress gateway level. This is different from Docker deployments where IP restrictions are handled at the application level.

#### Why do I get ECONNRESET errors with Kyma deployments?
**Common cause**: Using incorrect hostnames or custom Host headers. Kyma uses Istio Gateway which validates hostnames strictly for security.

**❌ Wrong**:
```bash
curl --header 'host: localhost' 'https://your-kyma-domain.com/...'
export ANTHROPIC_BASE_URL="http://localhost:3000/anthropic"  # Docker URL for Kyma
```

**✅ Correct**:
```bash
curl 'https://your-subdomain.your-cluster-id.kyma.ondemand.com/gateway/...'  # No custom host header
export ANTHROPIC_BASE_URL="https://your-subdomain.your-cluster-id.kyma.ondemand.com/gateway/anthropic"
```

#### Can I use the same API client code for both Docker and Kyma?
Yes, but the base URL must be configured differently:
- **Docker**: `http://localhost:3000` or `http://localhost:8080`
- **Kyma**: `https://your-subdomain.your-cluster-id.kyma.ondemand.com/gateway`

Use environment variables to switch between deployments:
```bash
# Docker
export ANTHROPIC_BASE_URL="http://localhost:3000/anthropic"

# Kyma  
export ANTHROPIC_BASE_URL="https://your-kyma-domain.com/gateway/anthropic"
```

#### How do I find my Kyma domain after deployment?
```bash
# Check APIRule status
kubectl get apirule -n sail-proxy

# Get full domain from deployment output
node kyma/scripts/deploy-kyma.js  # Shows domain during deployment
```

#### Can I customize the Admin Cockpit UI?
Limited customization is available:
- Logo and branding changes
- Custom CSS themes
- Additional menu items via configuration
- Full customization requires modifying the CAP application

### Integration Specific

#### Why isn't GitHub Copilot working perfectly with SAIL-PROXY?
GitHub Copilot integration is experimental because:
- Copilot expects specific model formats and behaviors
- Some IDE extensions have hardcoded endpoints
- Streaming and tool use may have compatibility issues

Consider using Ollama-compatible alternatives like Continue.dev or Aider.

#### Can I use SAIL-PROXY with LangChain or similar frameworks?
Yes! SAIL-PROXY works with any framework that supports OpenAI or Anthropic APIs:
```python
# LangChain example
from langchain.llms import OpenAI

llm = OpenAI(
    openai_api_key="your-sail-proxy-key",
    openai_api_base="http://localhost:3000/openai/v1"
)
```

#### Does SAIL-PROXY work with function calling/tools?
Yes, SAIL-PROXY supports:
- **OpenAI function calling**: Full compatibility
- **Anthropic tools**: Complete tool use support
- **Custom tools**: Pass-through to SAP AI Core capabilities

### Troubleshooting

#### Why do I get "Model not found" errors?
1. Check available models: `sail-proxy models list`
2. Verify model name matches SAP AI Core availability
3. Check model substitution configuration
4. Ensure API key has permissions for the model

#### SAIL-PROXY is slow. How can I optimize performance?
LLM inference is a shared resource. At peek hours inference can get really slow with models that are in high demand.
1. **Enable caching** in configuration
2. **Use faster models** for simple tasks (e.g., Claude 3 Haiku)
3. **Deploy closer** to your applications
4. **Check network latency** to SAP AI Core
5. **Monitor resource usage** (CPU, memory, network)

#### What should I do if I suspect a security issue?
1. **Immediate**: Revoke potentially compromised API keys
2. **Investigation**: Check security events in Admin Cockpit
3. **Reporting**: Contact your security team and SAIL-PROXY administrators
4. **Prevention**: Rotate keys, review access patterns, update security policies

---

*For additional support, consult the [Troubleshooting guide](chapter-8-troubleshooting.md) or contact your system administrator.*