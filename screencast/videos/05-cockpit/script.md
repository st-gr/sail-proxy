---
video: 05-cockpit
title: Cockpit deep dive
subtitle: API keys, usage analytics, entitlements and quotas, teams, tool governance, grounding, configuration, connections
kicker: sail-proxy · cockpit
target_seconds: 700
voice: marin
next: Clients
casts:
sections:
  - 1 | 00:05 | API keys | Create and rotate; admins disable and set the expiry; every user their own
  - 2 | 00:58 | Usage analytics | Tokens and cost by model, key and user; response time by provider and model
  - 3 | 02:19 | Entitlements and quotas | Who may use which model, and how much
  - 4 | 03:05 | Teams | A shared pool, a member profile, usage per team
  - 5 | 03:56 | Tool governance | Allow and deny lists for tools and MCP servers, per user, key or team
  - 6 | 04:52 | Grounding | Vector stores, files, the hosted file search, team shares
  - 7 | 06:05 | Configuration and operations | The gateway configuration, security notifications, settings
  - 8 | 08:16 | Connections | Your own provider accounts and SAP AI Core tenants, priced and switched in the cockpit
---

## Spoken script
[00:10] The Admin Cockpit is where a team runs sail-proxy day to day. We start with API keys. Every user sees their own keys; an administrator sees all of them with their owner.

[00:26] A key gets a name and its user's email; an administrator picks any user, everyone else gets their own. The owner can rotate it; only an administrator disables it or changes its expiry date, and without a date a key expires after ninety days. The list shows each key's active flag and expiry date, and the gateway refuses a disabled or expired key at once.

[01:01] Usage Analytics is the view you will open most; it opens on the current month. The overview has the key figures, the requests per provider, each model's response time against its cost, and a table per provider with tokens and errors.

[01:19] The Cost tab breaks the cost down: per model, the SAP billing per API key in capacity units, and the cost per user and per team.

[01:38] The Performance tab shows response times and error rates.

[01:50] The Models tab breaks the usage down by model.

[02:00] The figures come from the gateway's own records. The SAP Cost tile prices them with SAP's capacity-unit rates and the price you maintain here, so it can be reconciled with your SAP invoice.

[02:21] Entitlements and Quotas say who may use what. A quota profile sets requests per minute, and tokens and spend per day, week and month. The Standard team profile here allows sixty requests a minute and five dollars a day, and its assignments list the users it applies to. The gateway enforces it, and the cockpit shows how much of each limit is used.

[02:50] Users and Quotas lists every user with their status, their spend and their tokens this month.

[03:09] Teams group users. A team has a pool, one shared budget for the whole team, and can have a member profile: default limits for each member who has none of their own. A team can also carry an entitlement and a tool policy, and a team administrator manages its members.

[03:37] The members table shows each member's role, here one team administrator and two members. A new key follows its owner's primary team, and Usage Analytics can show the usage of a single team.

[04:03] Tool Governance holds the tool policies. The tool inventory lists every tool the clients sent through the gateway, who sent it, and how often it was allowed, monitored, stripped or rejected; here, the tools Claude Code declares.

[04:27] A policy allows or denies hosted tools, function tools and MCP servers by pattern. The developer policy here allows three named tools, denies one MCP tool, and only records what it would block.

[04:42] It applies to a user, a key or a team, and records, strips or refuses the denied tools; users without a policy get the Default policy.

[04:57] Grounding gives the gateway a hosted file search. A vector store holds files; the files are chunked and embedded, and a client calls the file search tool like any other tool. A store can be shared with a team.

[05:15] The Team handbook store here has three documents. Test Retrieval runs a question against the store and shows the passages an agent would receive, ranked by score, with the file each comes from.

[05:42] The Files view lists every file with its size and the stores it is in; a store's own Files tab shows each file's status.

[06:07] Configuration Management holds the gateway's configuration as versions: providers, model substitutions, streaming emulation. The active version is read-only; to change it you duplicate it, edit the copy and activate that, and the gateway picks it up without a redeploy.

[06:33] The Observability tab starts with pseudonymization: names, email addresses, phone numbers and the other categories, each with its own switch, are replaced with placeholders before a request leaves for the model, and restored in the answer.

[06:50] Below it is the SIEM export: security, audit and, if you opt in, usage events go to a webhook, OpenTelemetry, Datadog, Azure Sentinel, Google Cloud Pub/Sub or S3. Logging, rate-limit handling and hooks are configured in the same place.

[07:09] Security Notifications record failed authentications with keys and credentials, rate-limit hits, rotations and other security events.

[07:25] Settings holds each user's theme and language.

[07:29] The theme is light, dark or the system default; the dark theme applies at once, without a reload.

[07:44] The cockpit speaks seven languages: English, German, Spanish, French, Italian, Dutch and Portuguese.

[07:53] Here it is in German.

[08:25] Connections bring your own provider accounts next to SAP AI Core: Azure OpenAI, the OpenAI API, the Anthropic API and AWS Bedrock. The list shows each connection with its provider, the last test result and how many models it publishes.

[08:40] A connection's page holds only the settings its provider needs: here the Azure endpoint and the authentication mode. The credential is stored encrypted and never shown again, only a masked hint.

[08:59] Test Connection makes the gateway call the provider with the stored credential and reports whether it works.

[09:09] Add Model opens a picker filled from the provider's own model list; for Azure, those are your deployments.

[09:29] A model gets a list price per thousand tokens in the installation's currency, and only a priced model can be published. Published, it appears in the gateway's model list as the model name, two dashes and the connection, for the users entitled to it; the default catalog never grants it.

[09:45] Requests to it pass the same plugins as SAP traffic, so pseudonymization and tool policies still apply, and spend quotas and team pools count its cost.

[09:56] Usage Analytics shows the Connections cost beside the SAP cost, and the Cost tab breaks it down per connection.

[10:24] SAP AI Core tenants are connections too: upload a service key, test it and activate it, and every gateway switches to that tenant without a restart.

[10:55] SAP cost is reported per tenant.

## On-screen cues
- 00:10 API Keys list
- 00:26 the Create page, then the active flag and expiry date in the list
- 01:01 Usage Analytics overview scrolled down, the Cost tab scrolled down, Performance, Models
- 02:00 SAP Capacity Unit Prices
- 02:21 Entitlements & Quotas, quota profiles, the Standard team profile
- 02:50 Users & Quotas
- 03:09 Teams, the team's page with pool, member profile, scrolled down to the members
- 04:03 Tool Governance, the Tool Inventory, the developer policy
- 04:57 Vector Stores
- 05:15 the store's Test Retrieval tab with a question and its ranked passages, Files
- 06:07 Configuration Management, the active configuration, Providers, Observability with Pseudonymization and the SIEM sinks
- 07:09 Security Notifications
- 07:25 the Settings dialog, the dark theme, the cockpit in German
- 08:25 Connections list, the Azure connection (endpoint, credential hint, status, models), Test Connection, Add Model with the deployments, the published model with its list price
- 09:56 Usage Analytics: Connections cost, spend by connection
- 10:24 the SAP AI Core tenant B connection, Activate, SAP cost per tenant

## Recap and next
Keys per user, usage with SAP cost, quotas and entitlements, teams with a shared pool, tool policies, grounding, versioned configuration and your own provider connections: that is the cockpit. The clients video connects Claude Code, Codex, Copilot, Gemini CLI, pi and Open WebUI to all of this.

## Pronunciation
sail-proxy: sail proxy
MCP: M C P
