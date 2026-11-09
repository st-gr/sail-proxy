---
title: Admin service (CAP)
description: "The CAP service behind the cockpit: model, services, database and tests."
---

# Admin Cockpit (CAP)

The Admin service is built using SAP Cloud Application Programming Model (CAP) and provides the management capabilities behind the Admin Cockpit, through both the cockpit's UI5 apps and OData APIs. It stores API keys, AWS credentials, users, quota profiles, the gateway configuration, the Model Library and the usage data, and it calculates costs. How the cockpit is used is described in the [Admin Cockpit overview](/guide/cockpit/overview); how its apps are built in [UI5 application development](/developer/ui5-apps).

## Prerequisites

- Node.js 20+ and pnpm 10 (see [Development setup](/developer/setup)); `@sap/cds-dk` is a dev dependency of the service, so `npx cds` works without a global install
- `services/admin/.env` (from `.env.sample` or `pnpm run setup:dev`)

**Valkey Required**:
```bash
# Start Valkey container (required dependency)
docker run -d --name valkey --restart unless-stopped \
  -p 127.0.0.1:6379:6379 valkey/valkey:8

# Verify connectivity
docker exec valkey valkey-cli ping  # Should return PONG
```

## Development Setup

### Starting Admin Service

**From project root**:
```bash
pnpm run dev:admin
```

**From service directory**:
```bash
cd services/admin
pnpm run dev            # cds watch
pnpm run dev:ts:mock    # TypeScript entry point (src/index.ts) with nodemon, mocked authentication
# Access at http://localhost:4004/shell/index.html
```

Locally the service uses CAP's mocked users; they are listed in [Development setup](/developer/setup#local-development-authentication).

### Kill Stuck Processes
```bash
sudo kill -9 $(sudo lsof -t -iTCP:4004 -sTCP:LISTEN)
```

### Database Reset

```bash
cd services/admin
# Deletes db/admin.db (with its -shm and -wal files) and deploys the schema into a new, empty file
pnpm run db:reset
```

The local database is `services/admin/db/admin.db` (SQLite). On every start the admin service compares the model with the live SQLite schema and adds missing tables, missing columns and changed views (`src/db/data/sqlite-schema-heal.ts`); it never drops a table or column (a changed view is dropped and recreated). A change it cannot apply additively, such as a new `NOT NULL` column without a default, needs a hand-written migration. `cds deploy --to sqlite` (`pnpm run db:migrate`) recreates the file empty, so do not use it on a database whose data you want to keep.

## CAP Project Structure

**Service Organization**:
```
services/admin/
├── app/                    # Admin Cockpit: shell and one UI5 app per tile
├── src/
│   ├── db/
│   │   ├── schema.cds      # Namespace sap.llm.gateway.admin, includes schema/index.cds
│   │   ├── schema/         # Entity definitions, one file per area
│   │   └── data/           # Seed data and boot-time database steps
│   ├── srv/                # admin-service.cds, validation-service.cds and their handlers
│   ├── services/           # Business logic
│   ├── auth/  middleware/  # Authentication
│   └── index.ts            # Server start
├── test/
├── _i18n/                  # Annotation texts and server messages, seven languages
├── package.json            # cds.requires: profiles for SQLite, PostgreSQL and HANA
└── server.js               # CAP custom server bootstrap
```

## Data Model (CDS)

**Core Entities** (`src/db/schema/*.cds`, namespace `sap.llm.gateway.admin`, included through `schema/index.cds`):

| File | Entities |
|------|----------|
| `api-keys.cds` | `ApiKeys`, `RateLimits`, `RateLimitWindows`, `ApiKeyPermissions`, `ApiKeyUsage`, `ApiKeySecurityEvents`, `ApiKeyRotations`, `ApiKeyBlacklist`, `ModelCosts`, `SapCapacityUnitPrice`, `SapUsageTypeCodes`, `SapServicePlanCodes` |
| `aws-credentials.cds` | `AwsCredentials`, `AwsCredentialIPRestrictions`, `AwsCredentialPermissions`, `AwsCredentialUsage`, `AwsCredentialSecurityEvents`, `AwsCredentialRotations` |
| `simplified-api-config.cds` | `ApiConfigurations` (the gateway configuration documents) |
| `users.cds` | `Users`, `QuotaProfiles`, `UserCredentials`, `UserUsageDaily` |
| `model-library.cds` | `LibraryModels`, `ModelCatalogs`, `ModelCatalogMembers`, `ModelCatalogExclusions`, `ModelCatalogAssignments` |
| `tool-governance.cds` | `ToolPolicies`, `ToolPolicyAllows`, `ToolPolicyDenies`, `ToolPolicySensitive`, `ToolPolicyUntrusted`, `ToolUsage`, `ToolUsageDaily`, `ToolUsageAgentDaily` |
| `security-notifications.cds` | `SecurityNotifications`, `SecurityNotificationUserState` |
| `siem.cds` | `SiemOutbox`, `SiemDelivery`, `SiemCredentials` |
| `audit.cds` | `AuditEvents` |
| `user-preferences.cds` | `UserPreferences` |

`schema/api-config.cds` (a normalized configuration model) is not included by `index.cds` and is not deployed.

**Entity Relationships** (main compositions and associations):
```
ApiKeys
├── RateLimits (1:1)
│   └── RateLimitWindows (1:n)
├── ApiKeyPermissions (1:n)
├── ApiKeyUsage (1:n)
└── ApiKeyBlacklist (reference)

AwsCredentials
├── AwsCredentialIPRestrictions (1:n)
├── AwsCredentialPermissions (1:n)
├── AwsCredentialUsage (1:n)
├── AwsCredentialSecurityEvents (1:n)
└── AwsCredentialRotations (1:n)

Users
├── entitlementCatalog → ModelCatalogs
├── quotaProfile → QuotaProfiles
├── toolPolicy → ToolPolicies
└── UserUsageDaily (by email)
```

**Users** (`users.cds`):
```text
entity Users : managed {
  key email             : String(255);
  displayName           : String(255);
  rolesSnapshot         : String(500);        // JSON array, refreshed on contact
  firstSeenAt           : Timestamp;
  lastSeenAt            : Timestamp;
  status                : String(12) enum { active; deactivated } default 'active';
  statusChangedAt       : Timestamp;
  statusChangedBy       : String(255);
  statusReason          : String(500);
  requestsPerMinute     : Integer;
  spendPerDay           : Decimal(12,4);      // SAP cost, currency of SapCapacityUnitPrice
  spendPerWeek          : Decimal(12,4);
  spendPerMonth         : Decimal(12,4);
  tokensPerDay          : Integer64;
  tokensPerWeek         : Integer64;
  tokensPerMonth        : Integer64;
  quotaResetAt          : Timestamp;          // watermark: usage before it does not count
  entitlementCatalog    : Association to ModelCatalogs;   // null = the default catalog
  quotaProfile          : Association to QuotaProfiles;   // null = no profile: platform.quotas applies
  toolPolicy            : Association to ToolPolicies;    // null = the default tool policy
  toolUsageDaily        : Association to many ToolUsageDaily on toolUsageDaily.email = $self.email;
}
```

One row per person the platform knows, created lazily on first contact (`usersService.touch`) and
by a startup backfill; never deleted. A `null` constraint column inherits the platform default, and
a `null` platform default means unlimited. `ModelCatalogAssignments` is legacy: it is drained once
at startup (`usersService.migrateCatalogAssignments`, called from the admin service's
`initializeUsers`) by copying every row into the matching user's `entitlementCatalog` and deleting
it, so it stays empty from the first boot onward — assignment now lives on `Users.entitlementCatalog`.

```text
entity UserUsageDaily {
  key email    : String(255);
  key day      : Date;            // UTC calendar date of the usage row's validFrom
  key currency : String(3);       // sapCostCurrency of the rows, '' when they carry none
  requests     : Integer64 default 0;
  tokens       : Integer64 default 0;   // input + output + cacheCreationInput (fresh tokens; cache reads are priced, not counted)
  sapCost      : Decimal(12,6) default 0;
  updatedAt    : Timestamp;
}
```

The running usage counters the quota windows are read from ([Gateway service, Quota enforcement](/developer/gateway#quota-enforcement)). Written by the usage processor with the rows, deleted by a quota reset, rebuilt from
the rows by `usageCounters.rebuild()`. A new deployment needs the table before the admin starts:
Postgres (Docker, Kyma) gets it through schema evolution, local SQLite through the boot-time
self-heal; the first start then backfills it from the rows. Deleting an AWS credential no longer
deletes its usage rows — they keep the owner snapshot (`userId`) and lose `credential_ID`.

## Service Implementation

**Services** (`src/srv/*.cds`):

- **`AdminService`** (`admin-service.cds`, served at `/odata/v4/admin`, `@(requires: 'authenticated-user')`, with `@(restrict: …)` per entity and `@(requires: 'admin')` on administrative actions). Projections of the entities above, analytics views (`ApiKeyUsageStats`, `ApiKeyUsageSapCostStats`, `AwsCredentialUsageStats`, `UserQuotaStatus`, …) and actions, among them:
  - API keys and credentials: `createApiKey`, `rotateApiKey`, `disableApiKey`, `enableApiKey`, `deleteApiKey`, `setRateLimits`, `createAwsCredentials`, `rotateAwsCredentials`
  - Configuration: `createConfiguration`, `activateConfiguration`, `rollbackConfiguration`, `validateConfiguration`, `getActiveConfiguration`
  - Model Library and entitlements: `refreshModelLibrary`, `addModels`, `removeModels`, `setPrice`, `revertToSapPrice`, `assignCatalog`, `deploy`
  - Users and quotas: `deactivate`, `reactivate`, `resetQuota`, `setUserConstraints`, `assignQuotaProfile`, `rebuildUsageCounters`, `myQuotaStatus`, `myUsageSummary`
  - Security notifications and SIEM: `dismissNotification`, `snoozeNotification`, `setSiemCredential`, …
- **`ValidationService`** (`validation-service.cds`, served at `/odata/v4/validation`): the fast endpoints the gateway calls, such as `validateUnifiedAuthByToken`, `validateAwsCredentialsByToken`, `processUsageEvents`, `getConfig` and the cache operations.
- **REST routes** mounted on the CAP Express app: `/api/admin` (`config-rest-api.ts`: health, `api-config`, logout, notification stream), `/api/grounding` and the server-sent events stream `/api/notifications/stream`.

## Custom Handlers

**Service Handlers** (`src/srv/*.ts`): `admin-service.ts` exports the handler function CAP calls for `AdminService` (`module.exports = (srv) => …`); it registers the handlers of the `AdminService` class and mounts the REST routes once the service is served. Larger areas live in their own modules: `admin-service-library.ts` (Model Library), `admin-service-users.ts`, `admin-service-quota-profiles.ts`, `admin-service-tool-policies.ts`, `config-service.ts` (configuration documents), `validation-service.ts` and `notification-handlers.ts`. Business logic sits in `src/services/` (for example `usageEventProcessor.ts`, `modelCostService.ts`, `userQuotaService.ts`, `usersService.ts`). The admin issues API keys as `sk-` followed by random hex.

**Database transactions on SQLite.** The local SQLite database has a single connection. Never hold a CAP request transaction open across a call to the gateway: a gateway call that validates back against the admin then waits for the same connection and the request deadlocks. Read what you need first in its own `cds.tx(fn)` outside the request, then call the gateway. Inside a request handler never open a second root transaction with `cds.tx(fn)` either; use `cds.run`, which joins the ambient transaction.

## Testing Admin Service

**Test Structure**:
```
services/admin/test/
├── setupTests.ts              # Global test setup
├── unit/                      # Unit tests
├── integration/               # Integration tests (cds.test, in-memory SQLite)
│   └── http/                  # HTTP endpoint tests
├── security/                  # Security tests
├── bruno/                     # API testing collections
└── *.test.ts                  # SIEM, docker manifest and other suites
```

**Running Tests** (every script except `test:integration:http`, `test:safety`, `test:unified-tokens` and `test:token-system`, which run ts-node scripts, runs Jest with `cds.requires.db.kind=sqlite`; the `pretest*` scripts build `libs/test-utils` first):
```bash
# All admin tests
pnpm test:admin

# Specific test categories
pnpm test:admin:unit           # test/unit
pnpm test:admin:integration    # test/integration
pnpm test:admin:http           # test/integration/http

# From admin service directory
cd services/admin
pnpm test                      # All admin tests
pnpm test:unit                 # Unit tests only
pnpm test:integration          # Integration tests only
pnpm test:coverage
```

The suites that need a running admin service on port 4004 run only when `ADMIN_SERVICE_URL` is set (`describeLive` from `libs/test-utils`), because they write rows into that instance's database. The `cds.test` suites load `services/admin/.env`; when it points at a live gateway or Valkey, run them with the CI environment instead.

## Fiori Elements Apps

The cockpit apps live under `services/admin/app/` (the shell plus one app per tile); how they are built, tested and registered with the shell is described in [UI5 application development](/developer/ui5-apps). The configuration app is described here because its rules are tied to the service's handlers.

**Configuration app detail page** (`app/config-app/webapp/view/Main.view.xml`, `controller/Main.controller.ts`,
`controller/ConfigForm.ts`): a freestyle `sap.f.DynamicPage` with a Form view and a JSON view. The structural
rules below are guarded by `app/config-app/test/detailView.test.ts` (it parses the view and the
controller; no browser needed). Ordering rules such as setting the editor's value before it renders, and
applying a read only while `LatestRequest` says it is current, are not structurally guarded; they are
covered by review and by checking the page in a browser.

- **Content.** `f:content` holds exactly one control, the `VBox id="detailContent"` wrapper (JSON panel
  with the read-only strip and `jsonEditor`, plus the empty state). The Form view hides this wrapper; it
  is never replaced or rebuilt in code (the old programmatic editor and its fixed 500 ms wait are gone).
- **Info and validation.** The status, validity, last modified, checksum and the stored validation
  messages (`model/storedValidation.ts`, bound from `/selectedValidationMessages`) live in the title's
  `expandedContent`, because the title is the one part of the page that is on screen in both views.
  They exist once, read-only (no input controls), and the message list is capped in height and scrolls.
- **Header.** The form sits in the `DynamicPageHeader`, which has no `visible` binding: it is always
  there, and only the `configFormPanel` inside it toggles with the view (`ConfigForm._setJsonVisible`).
  Reason: `DynamicPage` recomputes whether the header may snap the title only when the header's box is
  resized. Hiding the whole header replaces the box without a resize, so the title snapped and
  collapsed the info block while the JSON view scrolled. Hiding the panel shrinks the box, so the rule is
  recomputed; an idle header is styled to 0 px.
- **JSON editor value.** `_loadConfigurationDetails` calls `setValue` on the one `jsonEditor` whether or
  not it has been rendered: `CodeEditor` keeps the value as a property and pushes it into Ace on its
  first rendering, so no wait is needed and a re-selection in Form view needs no ordering.
- **Rapid presses.** `model/latestRequest.ts` (`LatestRequest`) hands each press a token. A read that
  answers after a later press, Close or Delete is dropped, so the editor, name, messages and edit mode
  always belong to the last press.

**Configuration app: the two selections.** Pressing a row and ticking a row are separate selections
(`model/selectionState.ts`, pure and unit-tested; the controller only wires it):

- **Press = the open configuration.** `onItemPress` sets `_selectedConfig`, `/selectedConfigId` and the
  detail page's binding context to the row's list context. The open row carries the standard `navigated`
  marker (`${path:'ID',targetType:'any'}` — without `targetType` the V4 Guid part is formatted to the
  target's boolean type and throws a `FormatException`). A press never writes `/toolbar`.
- **Tick = the toolbar's targets.** `onSelectionChange` and `onConfigListUpdateFinished` (the table's
  `updateFinished`, after every list refresh) only recompute `/toolbar/{canDelete,canDuplicate,canActivate}`.
  Each toolbar handler takes its target from `_selectionState()` at press time: Delete acts on every
  ticked row and is disabled while any ticked row is active (the service's delete refuses an active row
  anyway); Duplicate and Activate need exactly one ticked row, Activate an inactive, valid one. A ticked
  row that a filter removed is not in `getSelectedItems()` and is not acted on. Delete closes the detail
  only when the open row was among the deleted ones; Close leaves the ticks alone.
- **Title-bar actions = the open row.** `onActivateOpenConfiguration` and `onDuplicateOpenConfiguration`
  read the open row from the detail page's live binding context (`_openContextRow()`), the context the
  buttons' `visible` binds to — never from `_selectedConfig`, a copy taken at load whose `isActive`
  goes stale once another row is activated. When a filter takes the open row out of the list, V4
  destroys its context and the detail page has none; `_openRowOrExplain()` then shows
  `openConfigNotInList` (also in front of Save) instead of falling back to the stale copy.
- **Duplicate of the open configuration** copies the editor's text only when `_editorConfigId` equals
  the copied ID (the editor holds that configuration's document; reset on every press). In the form
  view `ConfigForm.syncEditor()` first validates the form's edits as Save does (marks the fields,
  `formInvalidBeforeDuplicate`, no copy) and writes the document into the editor, verified.

**Configuration app: the open configuration's active state.** `model/activeState.ts` derives, from the
row's `isActive` and the detail's edits (`editorLoaded`, `unsavedEdits`), `readOnly` (the strip in both
views, `/selectedConfigIsActive`), `editorEditable` (`/isEditMode`: the editor and its Cancel/Save),
`canSave`, `canActivate` and `activateAsksFirst`.

- `_applyActiveState(isActive)` is the one writer of `/selectedConfigIsActive` and `/isEditMode`
  (besides the press, which starts read-only, and `_resetDetail`; a structural test enforces it), and
  calls `ConfigForm.onActiveStateChanged(isActive)`. That re-renders the form only when its
  editability flipped and never touches `_document`/`_documentBaseline`: unsaved edits stay on screen
  and stay dirty.
- It runs when the document loads and from `_followOpenRowActiveState()` after every list refresh
  (Activate, Rollback, Save, Refresh, filters), reading the open row's live context. The
  `LatestRequest` token guards it: while a newer press is still loading, that press applies its own
  state. While the open row is filtered out of the list its state is not followed.
- Save's guard is `canSave(this._openRow())` — the open row's live state, never a ticked row's.

**Configuration app: activating the open configuration with unsaved edits.** Activation takes the stored
document, so `_confirmActivate` runs `_settleEditsBeforeActivate()` when the target is the open row and
`activateAsksFirst` holds (decided without the form; the form is called only when it exists). The box
(`unsavedChangesTitle`, `activateUnsavedMessage`, buttons `formLeaveSave`/`formLeaveDiscard`/Cancel):

- **Save** → `ConfigForm.saveEdits()`. Form view: `_saveConfirmed()`. JSON view: the host's
  `onSaveConfiguration()`, then the `_awaitPersisted` read-back; once it holds the document the host's
  `markEditorSaved()` clears the editor's dirty flag (also for a whitespace-only edit, which Save itself
  skips as "no changes"); if it never does, `formSaveNotPersisted` and no activation. Only a confirmed
  save continues to the restart confirmation.
- **Discard** → `onCancelEdits()` (editor back to the stored text) and `ConfigForm.discardEdits()`, then
  the restart confirmation.
- **Cancel** → nothing. Activating any other row never asks.

A configuration that turns active by another route (Rollback, another session) while it holds unsaved
edits keeps them on screen, read-only and unsaveable.

**Configuration app: the Save outcome.** `_updateContextProperty` waits for the `setProperty` promise
together with `submitBatch` — `submitBatch` alone resolves even when the PATCH was refused. A refusal
shows `submitFailed` with the server's (translated) message and keeps the edit and the dirty flag; a
success re-reads the row (`_refreshValidationMessages`) for the title's validation messages.

**ApiConfigurations: server-managed fields and the before-UPDATE handler** (`src/srv/config-service.ts`,
`onBeforeConfigurationUpdate`). Every OData UPDATE of `ApiConfigurations` passes it, in this order:

| Step | Payload | Outcome |
|---|---|---|
| 1 | carries `isActive`, `deployedAt` or `deployedBy` | 400 `CONFIG_SAVE_ACTIVATION_COLUMNS` |
| 2 | no `configData` | `checksum`, `isValid`, `validationErrors`, `validationWarnings`, `lastValidated` are dropped from the payload; the rest (name, description, …) is stored |
| 3 | `configData` is not JSON | 400 `CONFIG_SAVE_INVALID_JSON` |
| 4 | no resolvable ID | 400 `CONFIG_SAVE_NO_KEY` |
| 5 | the row is active and its canonical document differs | 400 `CONFIG_SAVE_ACTIVE` (the unchanged document, however formatted, passes) |
| 6 | the document fails create's validator | 400 `CONFIG_SAVE_INVALID`, `{0}` = the errors joined by `; ` |
| 7 | valid | `checksum` = sha256 of `JSON.stringify(parsed)` (exactly create's), plus the validation columns (`validationColumns()`: errors/warnings as JSON arrays of strings or null, `lastValidated`); the `configData` text is stored as sent |

- **OData CREATE is refused.** `onBeforeConfigurationCreate` rejects every POST on `ApiConfigurations` with
  400 `CONFIG_CREATE_USE_ACTION`, pointing to the `createConfiguration` action: the entity is writable where it
  is a table (Postgres), and a POST would store a row with no validation, checksum or validation result. The
  action, Duplicate (which calls it) and the REST `PUT /api/admin/api-config` insert through db-level
  `cds.run` and never pass the handler.
- `isActive`, `deployedAt` and `deployedBy` are server-managed: only Activate and Rollback change them,
  through db-level `cds.run`, which no service handler sees. Refusing (rather than silently dropping)
  them tells an API client why; without it, deactivate → change → reactivate by three PATCHes bypassed
  the active-save guard and the activation hooks.
- The stored row (step 5) is read with `cds.run(SELECT.one…)` inside the request's transaction — never
  `cds.tx(fn)`: the admin's SQLite has one connection and a second root transaction deadlocks.
- Activation's own UPDATE stores its validation result and the recomputed checksum (it heals a stale
  one); Rollback writes no `configData`.
- **OData PUT is refused.** CAP fills a PUT's omitted fields with their defaults (`isActive: false`), so
  every PUT carries `isActive` and fails step 1. Clients use PATCH, as the app does. The REST route
  `PUT /api/admin/api-config` is unaffected: it creates a new configuration through
  `createConfiguration`.
- **Messages.** The 400 texts are a CAP runtime bundle, `services/admin/_i18n/messages{,_de,_es,_fr,_it,_nl,_pt}.properties`,
  picked by the request's `Accept-Language`. `cds build` does not merge it, so `docker/admin.Dockerfile`
  copies `_i18n` into both stages; without it the image answers with the raw key.
- **Publisher rule.** `after('UPDATE')` (`onConfigurationUpdated`) publishes `config-changed` only when
  the before handler flagged the request's document as changed (a `WeakSet` keyed by `req`) and the row,
  read back within the request, is active. Via OData that combination is refused at step 5, so it serves
  service-level updates only. An OData PATCH hands the after handler one object, not an array (the old
  `results[0]` never published). The publish goes through `publishWithTimeout` (3 s race, shared with
  activation); a failure is logged, not rethrown, since the update is already stored.
- Tests: `test/unit/services/config-save-recompute.test.ts` (handler, publisher, bundle parity) and the
  cds.test suite `test/integration/http/config-save-recompute-odata.test.ts` (PATCH end to end, EN and DE
  texts).

## Security Implementation

**Authentication by deployment target** (`src/auth/authInit.ts`, `src/middleware/authMiddleware.ts`):

- **Development** (`DEPLOY_TARGET` unset or `development`): CAP's mocked authentication with the users in `cds.requires.auth["[development]"]` of `package.json`.
- **Docker and Kyma** (`DEPLOY_TARGET=docker`): `src/index.ts` starts the server programmatically, serves `/api/health` without authentication and installs `createAuthMiddleware()`, which takes the user from the `X-Auth-Request-*` headers oauth2-proxy sets after the OIDC login and maps the groups to the roles `admin`, `user` and `gateway` (`ROLE_MAPPING`).
- **XSUAA, BTP, XSA**: CAP's own authentication.

The providers are configured as described in [Authentication providers](/deploy/authentication).

## Compilation Issues

**Common Build Problems**:
```bash
# Clear CAP cache
rm -rf .cdsrc-private.json
rm -rf node_modules/.cache

# Check that the model compiles
npx cds compile src/srv --to edmx > /dev/null

# Full build (cds build, tsc, copies and every cockpit app)
pnpm run build
```

## Performance

- **Indexes**: CAP creates no secondary indexes from the model. The admin service creates the ones it needs at boot (for example `src/db/data/tool-usage-indexes.ts`).
- **Database**: SQLite in local development; PostgreSQL in Docker and Kyma, where the admin container runs `cds-deploy` with `schema_evolution: auto` before it starts. A `[hana]` profile exists in `package.json`.
- **Caching**: the gateway caches validation results and configuration; the admin invalidates them over Valkey when keys, users or the configuration change.

## API Usage Examples

### OData Queries
```bash
# Active API keys
GET /odata/v4/admin/ActiveApiKeys

# API key usage statistics
GET /odata/v4/admin/ApiKeyUsageStats

# AWS credential security events
GET /odata/v4/admin/AwsCredentialSecurityEvents?$filter=severity eq 'high'

# Active configuration
GET /odata/v4/admin/ActiveConfiguration
```

### Custom Actions
```bash
# Create a new API key
POST /odata/v4/admin/createApiKey
{
  "name": "My API Key",
  "email": "user@example.com",
  "permissions": ["models:read", "chat:create"],
  "rateLimits": {
    "requestsPerMinute": 100,
    "requestsPerHour": 2000,
    "requestsPerDay": 20000
  }
}

# Create AWS credentials
POST /odata/v4/admin/createAwsCredentials
{
  "userId": "user123",
  "email": "user@example.com",
  "name": "Production Credentials",
  "description": "AWS credentials for production workload",
  "permissions": ["bedrock:InvokeModel"]
}

# Validate an API key
POST /odata/v4/admin/validateApiKey
{
  "key": "sk-1234567890abcdef"
}
```

Locally, add `-u admin@test.com:admin` to a `curl` call; behind nginx in Docker the paths start with `/admin`.

## Integration with Gateway Service

- The gateway validates every API key and AWS credential through `ValidationService` and caches the result.
- The gateway publishes usage and security events on Valkey; the admin's `usageEventProcessor` and `securityEventSubscriber` store them.
- Activating a configuration publishes it to the gateways over Valkey; without Valkey the gateway fetches it over HTTP.
- The admin calls the gateway for the model list (Model Library snapshot), deployments and grounding (`GATEWAY_URL`).

## Production Considerations

- **Database**: PostgreSQL in Docker and Kyma; back it up as described in [Backup, restore and upgrade](/deploy/backup-and-upgrade).
- **Keys**: `VALIDATION_TOKEN_SECRET`, `METADATA_ENCRYPTION_KEY` and `AWS_SECRET_ENCRYPTION_KEY` must be set and kept; losing `AWS_SECRET_ENCRYPTION_KEY` makes the stored AWS secrets unreadable.
- **Authentication**: an OIDC provider through oauth2-proxy ([Authentication providers](/deploy/authentication)).
- **Health**: `GET /api/health` answers without authentication in Docker and Kyma.

## Troubleshooting

### Database Connection Timeouts

If you see errors like `TimeoutError: ResourceRequest timed out` or `Failed to get active configuration`, this is usually a database configuration issue.

#### Problem: PostgreSQL vs SQLite Configuration

The `.env` file supports both development (SQLite) and production (PostgreSQL) configurations:

**For Local Development** (default):
```bash
# SQLite configuration (development)
cds.requires.db.kind=sqlite
cds.requires.db.credentials.database=db/admin.db
```

**For Docker/Production**:
```bash
# PostgreSQL configuration (production)
cds.requires.db.kind=postgres
cds.requires.db.impl=@cap-js/postgres
cds.requires.db.credentials.host=postgres
cds.requires.db.credentials.port=5432
cds.requires.db.credentials.user=admin_user
cds.requires.db.credentials.password=<your_password>
cds.requires.db.credentials.database=sap_llm_gateway
```

#### Solution

1. **For local development**: Ensure PostgreSQL settings are commented out and SQLite is active
2. **For Docker deployment**: Uncomment PostgreSQL settings and comment out SQLite
3. **Check NODE_ENV**: Set to `development` for local, `production` for Docker

The connection pool timeout occurs when trying to connect to PostgreSQL (`postgres:5432`) in a local environment where PostgreSQL is not running.
