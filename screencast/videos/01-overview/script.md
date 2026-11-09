---
video: 01-overview
title: Overview
subtitle: What sail-proxy does, the architecture, a tour of the cockpit, one call, its usage row and its cost
kicker: sail-proxy
target_seconds: 360
voice: marin
next: Deploy with the CLI
casts: call
sections:
  - 1 | 00:05 | What sail-proxy does | One gateway between your tools and SAP AI Core
  - 2 | 01:27 | The architecture | Three ways to run it, the same gateway in each
  - 3 | 01:59 | A tour of the cockpit | Keys, usage, models, quotas, tool governance, grounding
  - 4 | 04:04 | One call, its usage and its cost | An OpenAI-style request, accounted for per key
  - 5 | 05:12 | Where to go next | Quick start, deployment, clients
---

## Spoken script
[00:08] sail-proxy is the LLM gateway for SAP AI Core, made for the tools your teams already use. Claude Code, Codex, GitHub Copilot, Gemini CLI, Open WebUI, and any client that speaks the OpenAI, Anthropic, Bedrock or Ollama API reach the models of your SAP AI Core instance through one gateway. The service key stays on the server, and every user gets a key of their own.

[00:38] It is open source, and the enterprise features come with it: single sign-on with your own identity provider, deployment on Kubernetes and SAP BTP Kyma, quotas, tool governance, and usage and cost per key, user and team.

[00:57] And it goes beyond the harmonized orchestration API. Models you deploy are served through their native APIs, so realtime voice with GPT Realtime, image generation with Nano Banana, and table predictions with SAP RPT-1 work through the same gateway.

[01:29] There are three ways to run it. The standalone CLI from npm, for one developer on a laptop. Docker Compose, for a team on one host, with the Admin Cockpit and single sign-on. And SAP BTP Kyma, the same services on your cluster, for the company.

[01:50] In every case the gateway is the same program: it translates, signs, forwards and records each request.

[02:03] The Admin Cockpit is a Fiori application. Users sign in and manage their own API keys; admins see everyone's.

[02:21] Usage Analytics shows requests, tokens, cost and response times for the current month, by provider, model, key and user.

[02:38] The Model Library lists what your instance serves and its cost factors. A model that needs a deployment is deployed straight from here, without a detour through SAP AI Launchpad.

[03:05] Entitlements and quotas say who may use what, and how much.

[03:27] Tool Governance starts with the tool inventory: every tool your clients send through the gateway.

[03:42] A tool policy then allows or denies tools and MCP servers by pattern.

[03:52] Grounding adds a hosted file search over your own documents.

[04:08] One request shows the whole loop. An OpenAI-style chat completion with a user's key goes to the gateway, the gateway answers in the OpenAI format.

[04:41] A moment later the call is in Usage Analytics. The Cost tab shows what it cost: per model, as SAP billing per key in capacity units turned into money, and per user and team.

[05:15] From here, the quick start gets you a first call in ten minutes, the deployment chapter compares the three options, and the clients chapter has one page per tool.

## On-screen cues
- 00:08 the documentation home page, hero and feature chips, then the paths at the bottom
- 01:29 the deployment overview page with the diagram
- 02:03 cockpit home, then API Keys
- 02:21 Usage Analytics, scrolled down
- 02:38 Model Library, Gemini 3 Pro Image, the Deploy confirmation (cancelled)
- 03:05 Entitlements & Quotas
- 03:27 Tool Governance, the Tool Inventory, the developer policy
- 03:52 Vector Stores
- 04:08 terminal: the curl call
- 04:41 Usage Analytics with the new row, the Cost tab scrolled down
- 05:15 quick start, deployment overview, clients

## Recap and next
sail-proxy puts one gateway between your tools and SAP AI Core, with a key per user and the usage in a cockpit. The next video installs it from npm in under three minutes.

## Pronunciation
sail-proxy: sail proxy
RPT-1: R P T one
Kyma (also inside setup-kyma and deploy-kyma): KEE-mah, two syllables, the first like "key", the second like "mah", so "SAP Kyma" is "SAP KEE-mah", never spelled out letter by letter
