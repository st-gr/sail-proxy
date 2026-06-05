---
title: SAIL-PROXY User Guide - Chapter 1
author: st-gr
date: 2025-01-28
mainfont: Helvetica, Arial, sans-serif
fontsize: 18px
---

# SAIL-PROXY User Guide
*Multi-provider AI Gateway for SAP AI Core*
**Author:** *st-gr*

[Content Table](README.md) | [Next Chapter >>](chapter-2-features.md)

---

## Introduction

### What is SAIL-PROXY?

SAIL-PROXY is a multi-provider API gateway that bridges the gap between popular AI development tools and SAP AI Core Foundation Models. It enables applications built for OpenAI, Anthropic, AWS Bedrock, OpenRouter, or Ollama APIs to seamlessly work with SAP's enterprise AI infrastructure without code changes.

*Key Point: SAIL-PROXY is NOT a direct connection to AI providers. All requests are routed through SAP AI Core's Orchestration API or deployment endpoints, ensuring enterprise compliance and governance.*

### Why Use SAIL-PROXY?

**For Organizations:**
- **Enterprise Compliance**: All AI interactions go through SAP AI Core's governed infrastructure
- **Cost Control**: Centralized usage and performance monitoring
- **Security**: Enterprise-grade authentication, encryption, and audit trails
- **Multi-tenant**: Role-based access control with isolated API keys

**For Developers:**
- **Zero Code Changes**: Use existing OpenAI/Anthropic SDKs without modification
- **Tool Compatibility**: Works with Claude Code, GitHub Copilot, and other agentic coding, LLM clients and tools
- **Local Development**: Simple CLI installation for development environments (requires service key client credentials)
- **Production Ready**: Docker deployment with OAuth2 authentication

### Primary Use Cases

1. **AI-Powered Development**
   - Use Claude Code or GitHub Copilot with SAP AI Core models
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

### How It Works

```mermaid
graph LR
    A[AI Tool/Application] --> B[SAIL-PROXY Gateway]
    B --> C[SAP AI Core]
    C --> D[Foundation Models]
```

1. Your AI application sends requests using standard API formats (OpenAI, Anthropic, etc.)
2. SAIL-PROXY translates these requests to SAP AI Core's Orchestration API or direct deployment endpoints
3. SAP AI Core processes the request using governed foundation models
4. Responses are translated back to the original API format
5. Usage and security events are tracked for monitoring and compliance
6. A plugin system enables instrumentation and manipulation of requests and responses

### Getting Started

The quickest way to start using SAIL-PROXY is through the CLI tool:

```bash
npm install -g @st-gr/sail-proxy
sail-proxy run
```

For production deployments or team usage, consider the Docker setup with Admin Cockpit for centralized management.

**Next Steps:**
- [Explore Features](chapter-2-features.md) to understand SAIL-PROXY's capabilities
- [Install SAIL-PROXY](chapter-3-installation.md) for your use case
- Configure your favorite AI tools to use SAIL-PROXY

---

*Need help? Check the [FAQ](chapter-9-faq.md) or [Troubleshooting](chapter-8-troubleshooting.md) sections.*