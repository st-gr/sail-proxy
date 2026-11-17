---
video: 05-cockpit
title: Cockpit deep dive
subtitle: API keys, usage analytics, entitlements and quotas, teams, tool governance, grounding, configuration and logs, connections
kicker: sail-proxy · cockpit
target_seconds: 800
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
  - 7 | 06:06 | Configuration and operations | The gateway configuration, logs and payload traces, security notifications, settings
  - 8 | 10:00 | Connections | Your own provider accounts and SAP AI Core tenants, priced and switched in the cockpit
---

## Spoken script
[00:10] The Admin Cockpit is where a team runs sail-proxy day to day. We start with API keys. Every user sees their own keys; an administrator sees all of them with their owner.

[00:27] A key gets a name and its user's email; an administrator picks any user, everyone else gets their own. The owner can rotate it; only an administrator disables it or changes its expiry date, and without a date a key expires after ninety days. The list shows each key's active flag and expiry date, and the gateway refuses a disabled or expired key at once.

[01:01] Usage Analytics is the view you will open most; it opens on the current month. The overview has the key figures, the requests per provider, each model's response time against its cost, and a table per provider with tokens and errors.

[01:20] The Cost tab breaks the cost down: per model, the SAP billing per API key in capacity units, and the cost per user and per team.

[01:42] The Performance tab shows response times and error rates.

[01:56] The Models tab breaks the usage down by model.

[02:07] The figures come from the gateway's own records. The SAP Cost tile prices them with SAP's capacity-unit rates and the price you maintain here, so it can be reconciled with your SAP invoice.

[02:21] Entitlements and Quotas say who may use what. A quota profile sets requests per minute, and tokens and spend per day, week and month. The Standard team profile here allows sixty requests a minute and five dollars a day, and its assignments list the users it applies to. The gateway enforces it, and the cockpit shows how much of each limit is used.

[02:53] Users and Quotas lists every user with their status, their spend and their tokens this month.

[03:09] Teams group users. A team has a pool, one shared budget for the whole team, and can have a member profile: default limits for each member who has none of their own. A team can also carry an entitlement and a tool policy, and a team administrator manages its members.

[03:42] The members table shows each member's role, here one team administrator and two members. A new key follows its owner's primary team, and Usage Analytics can show the usage of a single team.

[04:03] Tool Governance holds the tool policies. The tool inventory lists every tool the clients sent through the gateway, who sent it, and how often it was allowed, monitored, stripped or rejected; here, the tools Claude Code declares.

[04:30] A policy allows or denies hosted tools, function tools and MCP servers by pattern. The developer policy here allows three named tools, denies one MCP tool, and only records what it would block.

[04:47] It applies to a user, a key or a team, and records, strips or refuses the denied tools; users without a policy get the Default policy.

[04:57] Grounding gives the gateway a hosted file search. A vector store holds files; the files are chunked and embedded, and a client calls the file search tool like any other tool. A store can be shared with a team.

[05:17] The Team handbook store here has three documents. Test Retrieval runs a question against the store and shows the passages an agent would receive, ranked by score, with the file each comes from.

[05:47] The Files view lists every file with its size and the stores it is in; a store's own Files tab shows each file's status.

[06:14] Configuration Management keeps the gateway's configuration as versions. After an upgrade, a bar says when the shipped defaults hold entries your configuration lacks.

[06:27] Compare with defaults lists those entries, such as new provider headers, hooks and the logging settings. The ones you pick go into a new configuration, which you activate yourself; settings that only differ are yours and are not listed.

[06:47] The active version holds the providers, model substitutions and streaming emulation. It is read-only: you duplicate it, edit the copy and activate that, without a redeploy.

[06:58] Pseudonymization has one global switch, off as shipped. Only while it is on do the endpoint and model settings enforce masking, and the form names the ones it overrules. Each category keeps its own switch.

[07:14] Below it is the SIEM export: security, audit and, if you opt in, usage events go to a webhook, OpenTelemetry, Datadog, Azure Sentinel, Google Cloud Pub/Sub or S3.

[07:30] Logs shows the gateway's own log in the cockpit: live, newest last, stored for forty-eight hours.

[07:41] Search finds a text in the message, the component and the request ID, and a request ID links to its trace.

[07:50] Switches and levels decide what is stored and how much the gateway writes: the default level, and a level for a single component, for fifteen minutes up to a day, without a new configuration version.

[08:05] With payload capture on, every request leaves a light trace: route, model, key, user, status and tokens.

[08:15] A masked request keeps the prompt as the model received it, with placeholders instead of the names. An unmasked prompt is stored encrypted, and opening it is recorded in the audit trail.

[08:30] Raw capture is for finding out what exactly happened: for the keys and users you name, and for up to four hours, it keeps every stage of a request, unmasked and encrypted. Every view and download is recorded under your name.

[08:53] Security Notifications record failed authentications with keys and credentials, rate-limit hits, rotations and other security events.

[09:08] Settings holds each user's theme and language.

[09:12] The theme is light, dark or the system default; the dark theme applies at once, without a reload.

[09:31] The cockpit speaks seven languages: English, German, Spanish, French, Italian, Dutch and Portuguese.

[09:40] Here it is in German.

[10:09] Connections bring your own provider accounts next to SAP AI Core: Azure OpenAI, the OpenAI API, the Anthropic API and AWS Bedrock. The list shows each connection with its provider, the last test result and how many models it publishes.

[10:25] A connection's page holds only the settings its provider needs: here the Azure endpoint and the authentication mode. The credential is stored encrypted and never shown again, only a masked hint.

[10:47] Test Connection makes the gateway call the provider with the stored credential and reports whether it works.

[10:57] Add Model opens a picker filled from the provider's own model list; for Azure, those are your deployments.

[11:20] A model gets a list price per thousand tokens in the installation's currency, and only a priced model can be published. Published, it appears in the gateway's model list as the model name, two dashes and the connection, for the users entitled to it; the default catalog never grants it.

[11:39] Requests to it pass the same plugins as SAP traffic, so pseudonymization and tool policies still apply, and spend quotas and team pools count its cost.

[11:51] Usage Analytics shows the Connections cost beside the SAP cost, and the Cost tab breaks it down per connection.

[12:20] SAP AI Core tenants are connections too: upload a service key, test it and activate it, and every gateway switches to that tenant without a restart.

[12:52] SAP cost is reported per tenant.

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
- 06:14 Configuration Management, the defaults bar, Compare with defaults, the active configuration, Providers, Observability with the global pseudonymization switch and the SIEM sinks
- 07:30 Logs: the gateway log searched, Switches and levels, Payload traces with a masked request and a raw capture's stages
- 08:53 Security Notifications
- 09:08 the Settings dialog, the dark theme, the cockpit in German
- 10:09 Connections list, the Azure connection (endpoint, credential hint, status, models), Test Connection, Add Model with the deployments, the published model with its list price
- 11:40 Usage Analytics: Connections cost, spend by connection
- 12:08 the SAP AI Core tenant B connection, Activate, SAP cost per tenant

## Recap and next
Keys per user, usage with SAP cost, quotas and entitlements, teams with a shared pool, tool policies, grounding, versioned configuration with logs and payload traces, and your own provider connections: that is the cockpit. The clients video connects Claude Code, Codex, Copilot, Gemini CLI, pi and Open WebUI to all of this.

## Pronunciation
sail-proxy: sail proxy
MCP: M C P
