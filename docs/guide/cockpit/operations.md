---
title: Operations and audit trail
description: Admin service actions, where backups happen, and the audit trail.
---

# Operations and audit trail

Besides the applications, the cockpit's admin service offers a few operational actions, and it keeps an audit trail of what operators do. Backups and restores happen outside the cockpit.

## Operational Actions

The admin service exposes these actions through its OData API; the cockpit has no page for them:

- **Health** (`health`): service status, including the database, the cache and credential validation.
- **Cache statistics** (`getCacheStats`): current cache metrics.
- **Cache invalidation** (`invalidateCache`, `clearCachePattern`): invalidate the cached validation of one credential, or clear cache entries by key pattern. Administrators only.
- **Security events** (`getSecurityEvents`): query recorded security events in a time range. Administrators only.
- **Usage statistics** (`getUsageStatistics`): the aggregate usage figures behind [Usage analytics](/guide/cockpit/usage-analytics).

## Backups and Restores

The cockpit has no backup or restore function. Back up the database of the deployment with the
database's own tools. On Kyma, `cli-tools/kyma-db-manager.js` backs up (`backup`) and restores
(`restore`) the PostgreSQL database of a namespace.

## Audit Trail

Operator and system actions, such as creating or rotating a key, resetting a user's quota or changing
the configuration, are recorded as audit events: who acted, what they did, on which resource, with
which outcome and severity, and from which client address. The application creates these records and
neither updates nor deletes them.

The cockpit has no page for the audit trail. Audit events leave the gateway through the SIEM export's
`audit` category; see [Gateway configuration](/guide/cockpit/configuration#siem-event-export).
