---
title: Deployment options
description: The three ways to run sail-proxy (standalone CLI, Docker Compose, SAP BTP Kyma) and what each one includes.
---

# Deployment options

sail-proxy comes in three deployment options. All three need the service key of your SAP AI Core instance (Extended plan), downloaded from your SAP BTP subaccount as a JSON file, and an orchestration deployment in SAP AI Core.

![Architecture overview and deployment options](/generated/deployment-options-light.svg){.light-only}
![Architecture overview and deployment options](/generated/deployment-options-dark.svg){.dark-only}

The gateway does not connect to OpenAI, Anthropic, AWS Bedrock or other AI providers directly. It translates their API formats and routes every request through SAP AI Core: through the orchestration service, or straight to the deployment of a foundation model.

## Compare the options

| | [Standalone CLI](/deploy/cli) | [Docker Compose](/deploy/docker) | [SAP BTP Kyma](/deploy/kyma) |
|---|---|---|---|
| **For** | One person: evaluation, a developer machine | A team, on your own hosts | A team, on an SAP BTP Kyma cluster |
| **Installs with** | `npm install -g @st-gr/sail-proxy` | `docker/setup-docker.js`, then Docker Compose | `kyma/scripts/setup-kyma.js` and `deploy-kyma.js` |
| **Admin Cockpit** | No | Yes | Yes |
| **API keys** | Created with `sail-proxy apikey create`, stored in a file | Created by each user in the cockpit | Created by each user in the cockpit |
| **Cockpit sign-in** | None | oauth2-proxy and Dex: local accounts, GitHub, LDAP/Active Directory or Okta (SAML) | The same, behind the Kyma ingress |
| **Database** | None; keys and settings are files in the configuration directory | PostgreSQL (with pgvector) and Valkey | PostgreSQL (with pgvector) and Valkey, in the namespace |
| **HTTPS** | No (local HTTP) | Add TLS in front of nginx yourself | Terminated at the Kyma ingress |
| **Ollama API** | Yes (`sail-proxy ollama start`) | Yes, with the `ollama` Compose profile | No |
| **Usage analytics, quotas, tool policies** | No | Yes | Yes |
| **Scanned PDFs (OCR), vision transcription, `.doc` files in file search** | No | Yes | Yes |

The standalone CLI runs the gateway alone. Docker and Kyma run the same set of services: the gateway, the admin service with the Admin Cockpit, nginx in front of both, oauth2-proxy and Dex for single sign-on, PostgreSQL and Valkey.

## Choosing

- **Try it, or use it alone**: the [standalone CLI](/deploy/cli) is the fastest start and needs only Node.js 20 or later. It has no cockpit: whoever runs it manages its keys.
- **Run it for a team**: [Docker Compose](/deploy/docker) adds the Admin Cockpit with per-user keys, usage and cost analytics, quotas and single sign-on.
- **Run it on SAP BTP**: the [Kyma deployment](/deploy/kyma) runs the Docker services on a Kyma cluster, with an IP allowlist at the Istio ingress or access through the SAP Cloud Connector only.

Running the services from a source checkout is for development and is described in the Developer section.

## Operating a deployment

- [Authentication providers](/deploy/authentication): signing in to the cockpit on Docker and Kyma.
- [File storage for file_search](/deploy/file-storage): keeping uploaded file contents in the database or in S3.
- [Database migration](/deploy/database-migration): backup, restore and reset of the Kyma database with `kyma-db-manager.js`.
- [Backup, restore and upgrade](/deploy/backup-and-upgrade): what to back up for each option, and the steps for an upgrade.
