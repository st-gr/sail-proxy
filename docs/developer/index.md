---
title: Developer guide
description: Set up, build, test and extend sail-proxy.
---

# Developer guide

- [Development setup](/developer/setup) — Node, pnpm, Valkey, the dev servers and local authentication.
- [Windows development setup](/developer/windows-setup) — WSL2 and native Windows notes for the dev environment.
- [Workspace layout](/developer/workspace-layout) — Packages, folders and conventions of the pnpm monorepo.
- [API reference](/reference/api) — The OpenAPI documents of the gateway, the admin service and the Ollama service, in Swagger UI.
- [Architecture](/developer/architecture) — Services, data flow and the request lifecycle.
- [Gateway service](/developer/gateway) — Routing, translation layers, streaming, configuration and usage tracking inside the gateway.
- [Running and testing the gateway](/developer/gateway-testing) — Unit, integration and live suites, and how to run the gateway locally.
- [Admin service (CAP)](/developer/admin-cockpit) — The CAP service behind the cockpit: model, services, database and tests.
- [UI5 application development](/developer/ui5-apps) — How the cockpit apps are built, tested and added to the shell.
- [Ollama service](/developer/ollama-service) — The Ollama-compatible adapter: design, endpoints and tests.
- [Docker images and build](/developer/docker-images) — How the gateway, admin and ollama images are built, tagged, pushed and debugged.
- [Testing strategy](/developer/testing-strategy) — Which suites exist, what each proves, and how CI runs them.
- [Debugging and troubleshooting (developer)](/developer/debugging) — Logging, log level resolution, tracing requests and common failure modes.
- [Setup scripts internals](/developer/setup-scripts) — The prompt session behind setup-docker and setup-kyma: replay, review, current values, secrets, billing and the golden tests.
- [Release procedure](/developer/release) — Version bump, npm publish, image push, sync and checks.
- [Plugin system](/developer/plugins) — Write, load and test gateway plugins: hooks, strategies, matchers and utilities.
- [Security implementation](/developer/security) — Key handling, encryption, SigV4 verification, pseudonymization and security events.
- [Pseudonymization security assessment](/developer/pseudonymization-assessment) — Threat model and assessment of the pseudonymization plugin.
- [Tool governance internals](/developer/tool-governance) — Policies, tool usage indexes and the governance pipeline in the gateway.
- [Model library and entitlements internals](/developer/model-library-entitlements) — Catalogue, cost factors, entitlements and quota evaluation.
- [Connections internals](/developer/connections) — External provider connections: registry, credentials, list prices, the gateway snapshot and opt-in entitlement.
- [The hosted file_search tool](/developer/file-search-tool) — Ingestion, chunking, indexing, retrieval, storage and verification.
- [Reranker teacher datasets](/developer/reranker-datasets) — How the reranker evaluation datasets are built and used.
- [Contributing](/developer/contributing) — How to ask, report, propose and submit changes, and the conventions every commit follows.
- [Attribution and trademarks](/developer/attribution) — Trademark attribution and third-party notices.
