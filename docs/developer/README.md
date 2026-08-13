---
title: SAIL-PROXY Developer Guide
author: st-gr
date: 2025-01-28
mainfont: Helvetica, Arial, sans-serif
fontsize: 18px
---

# SAIL-PROXY Developer Guide
*Multi-provider AI Gateway for SAP AI Core - Developer Documentation*
**Author:** *st-gr*

![SAIL-PROXY Architecture](/docs/assets/sail-proxy-architecture.png)

## Abstract

This developer guide provides comprehensive technical documentation for SAIL-PROXY, including development setup, architecture details, testing procedures, and deployment strategies. SAIL-PROXY is a TypeScript-based monorepo implementing a multi-provider AI gateway that translates between popular AI API formats and SAP AI Core's Orchestration API.

The system uses a microservices architecture with separate gateway, admin, and optional Ollama services, all built with modern technologies including Node.js 20+, TypeScript, Jest testing framework, and pnpm workspace management.

## Content

1. [Development Setup](chapter-1-dev-setup.md)
2. [Architecture Overview](chapter-2-architecture.md)
3. [Gateway Service](chapter-3-gateway.md)
4. [Running & Testing the Gateway](chapter-4-gateway-testing.md)
5. [Admin Cockpit (CAP)](chapter-5-admin-cockpit.md)
6. [Ollama Service](chapter-6-ollama.md)
7. [Docker & Deployment](chapter-7-docker-deployment.md)
8. [Workspace Layout](chapter-8-workspace-layout.md)
9. [Testing Strategy](chapter-9-testing-strategy.md)
10. [Security Implementation](chapter-10-security.md)
11. [Debugging & Troubleshooting](chapter-11-debugging.md)
12. [UI5 Application Development](chapter-12-ui5-app-development.md)
13. [Plugin System Development](chapter-13-plugin-system.md)
14. [Release & Deployment](chapter-14-release.md)
15. [Reranker Teacher Datasets](chapter-15-reranker-datasets.md)
16. [The hosted `file_search` tool](chapter-16-file-search-tool.md)

---

*For user documentation and end-user guides, see [User Guide](/docs/user/README.md)*