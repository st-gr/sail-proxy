---
title: API reference
description: The OpenAPI documents of the gateway, the admin service and the Ollama service, with every route's parameters, responses and what sail-proxy changes against the vendor APIs.
---

# API reference

sail-proxy describes its HTTP APIs in four OpenAPI documents:

- **Gateway**: every client route of the gateway. The vendor-compatible routes (OpenAI, Anthropic, Google Gemini, AWS Bedrock, OpenRouter) say what sail-proxy changes and link the vendor's own reference for the bodies; sail-proxy's own routes (SAP-RPT, models, health) have full schemas. [API endpoints](/reference/api-endpoints) lists the same routes as tables.
- **Admin OData**: the Admin Cockpit's OData service.
- **Admin REST**: the admin service's REST routes for the configuration status and Grounding.
- **Ollama**: the [Ollama-compatible service](/reference/ollama-api).

The Realtime API is a WebSocket, not an HTTP route, and is not in the documents: see [OpenAI Realtime API](/guide/clients/realtime).

## Live page

This page shows the documents only; requests cannot be sent from it. A running sail-proxy serves the same page with "Try it out" enabled. The gateway, Admin OData and Admin REST documents send requests to the sail-proxy that serves the page. The Ollama document sends them to `http://localhost:11434`, the address of an Ollama service you run yourself, and the browser may refuse that cross-origin call. In Docker the optional Ollama service publishes that port on the host, not at the page's address, and Kyma has no Ollama service.

- **Docker and Kyma**: `https://<your-domain>/admin/api/docs/`, after signing in to the Admin Cockpit. It shows all four documents; gateway requests take an API key you paste in, admin requests use your sign-in. A local development admin started with `cds serve` does not serve it.
- **Standalone CLI**: `http://127.0.0.1:<port>/docs/` (port `3000` by default) shows the gateway document, served only while the gateway listens on the local machine.

<ApiReference />
