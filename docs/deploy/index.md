---
title: Deploy
description: Installing and operating sail-proxy as a standalone CLI, on Docker Compose or on SAP BTP Kyma.
---

# Deploy

[Deployment options](/deploy/overview) compares the three ways to run sail-proxy:

- [Standalone CLI](/deploy/cli) — the gateway alone on your machine, installed from npm, for one person.
- [Docker Compose](/deploy/docker) — the gateway with the Admin Cockpit, single sign-on, PostgreSQL and Valkey on your own hosts, for a team.
- [SAP BTP Kyma](/deploy/kyma) — the same services on a Kyma cluster, public behind an IP allowlist or internal-only through the Cloud Connector ([prerequisites](/deploy/kyma-prerequisites)).

Operating a deployment:

- [Authentication providers](/deploy/authentication) — signing in to the cockpit with local accounts, GitHub, LDAP or Okta, and how groups become roles.
- [File storage for file_search](/deploy/file-storage) — uploaded file contents in the database or in S3.
- [Database migration](/deploy/database-migration) — backup, restore and reset of the Kyma database.
- [Backup, restore and upgrade](/deploy/backup-and-upgrade) — what to back up for each option, and how to upgrade.
