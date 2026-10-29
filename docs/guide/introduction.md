---
title: Introduction
description: What sail-proxy is, who it is for and how a request flows through it.
---

# Introduction

## What is sail-proxy?

sail-proxy is a multi-provider API gateway between AI development tools and SAP AI Core foundation models. Applications built for the OpenAI, Anthropic, Google Gemini, AWS Bedrock, OpenRouter or Ollama APIs work with SAP's enterprise AI infrastructure without code changes.

*Key point: sail-proxy is not a direct connection to AI providers. All requests are routed through SAP AI Core's Orchestration API or deployment endpoints, ensuring enterprise compliance and governance.*

## Why use sail-proxy?

**For Organizations:**
- **Enterprise Compliance**: All AI interactions go through SAP AI Core's governed infrastructure
- **Cost Control**: Centralized usage and performance monitoring
- **Security**: single sign-on for the cockpit, per-user API keys, security notifications and audit fields
- **Multi-tenant**: Role-based access control with isolated API keys

**For Developers:**
- **Zero Code Changes**: Use existing OpenAI/Anthropic SDKs without modification
- **Tool Compatibility**: works with [Claude Code](/guide/clients/claude-code), [Codex](/guide/clients/codex), [opencode](/guide/clients/opencode), [GitHub Copilot](/guide/clients/github-copilot), [Gemini CLI](/guide/clients/gemini), [pi](/guide/clients/pi), [Open WebUI](/guide/clients/open-webui), [AnythingLLM](/guide/clients/anythingllm) and [other clients](/guide/clients/other-clients)
- **Local Development**: Simple CLI installation for development environments (requires service key client credentials)
- **Production Ready**: Docker and SAP BTP Kyma deployments with OAuth2 single sign-on and the Admin Cockpit

## Primary Use Cases

1. **AI-Powered Development**
   - Use [Claude Code](/guide/clients/claude-code) or [GitHub Copilot](/guide/clients/github-copilot) with SAP AI Core models
   - Integrate AI assistance into your development workflow
   - Access enterprise models through familiar interfaces

2. **Application Integration**
   - Add AI capabilities to existing applications
   - Use standard OpenAI/Anthropic SDKs with SAP models
   - Maintain compatibility while leveraging enterprise AI

3. **Proof of Concepts**
   - Quick setup for testing AI integration scenarios
   - Evaluate SAP AI Core capabilities with minimal setup
   - Prototype AI features using familiar development tools

## How It Works

AI tool or application → sail-proxy gateway → SAP AI Core → foundation models

1. Your AI application sends requests using standard API formats (OpenAI, Anthropic, etc.)
2. sail-proxy translates these requests to SAP AI Core's Orchestration API or direct deployment endpoints
3. SAP AI Core processes the request using governed foundation models
4. Responses are translated back to the original API format
5. Usage and security events are tracked for monitoring and compliance
6. A plugin system enables instrumentation and manipulation of requests and responses

## Deployment options

- **npm CLI** (`@st-gr/sail-proxy`): a standalone gateway on your machine, without the Admin Cockpit.
- **Docker Compose** (`docker/docker-compose.yml`): gateway, Admin Cockpit, nginx, oauth2-proxy and Dex, PostgreSQL and Valkey.
- **SAP BTP Kyma** (`kyma/`): the same services on a Kyma cluster.

## Next steps

- [Quick start](/guide/quick-start): a first call with the CLI or Docker
- [Features](/guide/features): everything the gateway and the cockpit do
- Need help? See the [FAQ](/guide/faq) or [Troubleshooting](/guide/troubleshooting).
