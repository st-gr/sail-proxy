# SAIL-PROXY Documentation

![SAIL-PROXY Logo](assets/sail-proxy-logo-640x457.png)

## SAIL-PROXY - A SAP AI Core LLM Proxy

Welcome to the SAIL-PROXY documentation! This comprehensive guide is organized into two main sections to serve different audiences effectively.

## 📚 Documentation Structure

### [User Guide](user/README.md)
**For:** End users, administrators, and anyone looking to use SAIL-PROXY with their AI tools

The User Guide covers everything you need to know to get started with SAIL-PROXY:
- **Installation and setup** instructions for various deployment scenarios
- **Integration guides** for popular AI development tools (Claude Code, GitHub Copilot)
- **Admin Cockpit** usage for managing API keys and monitoring usage
- **Troubleshooting** common issues and FAQs
- **Features overview** and practical use cases

**Start here if you want to:**
- Set up SAIL-PROXY for your organization
- Connect your AI development tools to SAP AI Core
- Manage API access and monitor usage
- Troubleshoot connection or configuration issues

### [Developer Guide](developer/README.md)
**For:** Software developers, contributors, and technical staff maintaining SAIL-PROXY

The Developer Guide provides in-depth technical documentation:
- **Development environment** setup and prerequisites
- **Architecture details** including microservices design and API flows
- **Testing strategies** and quality assurance procedures
- **Docker deployment** and production considerations
- **Kyma deployment** for SAP BTP Kyma Runtime environments
- **Contributing guidelines** and coding standards
- **Debugging techniques** and performance optimization

**Start here if you want to:**
- Contribute to the SAIL-PROXY codebase
- Understand the technical architecture
- Set up a development environment
- Deploy SAIL-PROXY in production (Docker or Kyma)
- Extend or customize the gateway functionality

## 🚀 Quick Links

- [Development Conventions and Guidelines](Guidelines.md) - Coding standards and contribution guidelines
- [User Guide - Introduction](user/chapter-1-introduction.md) - Get started quickly
- [Developer Guide - Architecture](developer/chapter-2-architecture.md) - Technical deep dive
- [Docker Deployment](developer/chapter-7-docker-deployment.md) - Production deployment guide
- [Kyma Deployment Guide](../kyma/docs/README.md) - SAP BTP Kyma Runtime deployment
- [Kyma Prerequisites](../kyma/docs/PREREQUISITES.md) - kubectl, krew & oidc-login setup

## 📖 About SAIL-PROXY

SAIL-PROXY is a multi-provider AI gateway that bridges popular AI APIs (OpenAI, Anthropic, AWS Bedrock, etc.) with SAP AI Core's enterprise infrastructure. It provides:

- **Unified API** compatible with existing AI tools and libraries
- **Enterprise security** with comprehensive access control
- **Usage analytics** and monitoring capabilities
- **Multi-provider support** for flexibility and vendor independence
- **Multiple deployment options** including Docker Compose and SAP BTP Kyma Runtime
- **Support for Ollama clients** via Ollama service

## 🤝 Contributing

We welcome contributions! Please review our [Development Guidelines](Guidelines.md) before submitting pull requests. All commits must follow the [Conventional Commits](https://www.conventionalcommits.org/) specification to enable automated release management.

## 📝 License

See the [LICENSE](../LICENSE) file in the root of the repository for licensing information.

---

*Choose your path: [User Guide](user/README.md) for usage documentation or [Developer Guide](developer/README.md) for technical documentation.*