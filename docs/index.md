---
layout: home
title: SAIL-PROXY
titleTemplate: SAP AI Core LLM gateway
hero:
  name: SAIL-PROXY
  text: The SAP AI Core LLM gateway for the tools you already use
  tagline: Claude Code, Codex, Copilot, Gemini CLI and any OpenAI, Anthropic, Bedrock or Ollama client talk to SAP AI Core through one gateway. Keep the service key secret, give every user their own key, and see usage and cost per key, user, model and provider.
  image:
    light: /generated/deployment-options-light.svg
    dark: /generated/deployment-options-dark.svg
    alt: Architecture overview and deployment options
  actions:
    - theme: brand
      text: Get started
      link: /guide/quick-start
    - theme: alt
      text: Deploy
      link: /deploy/overview
    - theme: alt
      text: View on GitHub
      link: https://github.com/st-gr/sail-proxy
features:
  - title: Drop-in API compatibility
    details: OpenAI, Anthropic, Bedrock, OpenRouter and Ollama formats, streaming and tool use included.
    link: /reference/api-endpoints
  - title: Keys per user, one secret
    details: The SAP service key stays on the server. Users create and rotate their own keys in the cockpit.
    link: /guide/cockpit/api-keys
  - title: Usage and cost
    details: Tokens and cost per key, user, model and provider, with quotas and entitlements.
    link: /guide/cockpit/usage-analytics
  - title: Governance
    details: Tool and MCP allow lists, security notifications, audit trail, pseudonymization.
    link: /guide/cockpit/tool-governance
  - title: Grounding and file search
    details: A hosted file_search tool with chunking, reranking and S3 or database storage.
    link: /guide/cockpit/grounding
  - title: CLI, Docker or Kyma
    details: One npm install on a laptop, Compose on a host, or SAP BTP Kyma for the company.
    link: /deploy/overview
---

## Pick your path

| | Standalone CLI | Docker Compose | SAP BTP Kyma |
|---|---|---|---|
| For | one developer | a team on one host | the company |
| Cockpit | no | yes | yes |
| Sign-in | API keys | Dex, GitHub or OIDC | your identity provider |
| Start | [CLI](/deploy/cli) | [Docker](/deploy/docker) | [Kyma](/deploy/kyma) |

## Works with

[Claude Code](/guide/clients/claude-code) · [Codex CLI](/guide/clients/codex) · [opencode](/guide/clients/opencode) · [GitHub Copilot](/guide/clients/github-copilot) · [Gemini CLI](/guide/clients/gemini) · [pi](/guide/clients/pi) · [Open WebUI](/guide/clients/open-webui) · [AnythingLLM](/guide/clients/anythingllm) · [any other client](/guide/clients/other-clients)
