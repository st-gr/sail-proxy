---
title: Connections internals
description: External provider connections - registry, credentials, list prices, the gateway snapshot and opt-in entitlement.
---

# Connections internals

A Connection is an external provider account (Azure OpenAI, AWS Bedrock, the OpenAI API or the
Anthropic API) that the gateway can send inference to when the SAP AI Core budget runs out. This
page covers the registry: what the admin stores, how the gateway gets it, and how its models enter
the model list and the entitlement rules, and how requests reach a connection. `openai` and
`azure-openai`, `anthropic` and `bedrock` connections serve requests.

## Data model (admin)

`services/admin/src/db/schema/connections.cds`:

- `ProviderConnections`: `name` (the model-id suffix, `^[a-z][a-z0-9-]{1,30}$`, no `--`, not
  `deployed`, unique, immutable), `providerType` (`azure-openai | bedrock | openai | anthropic`,
  immutable), `isActive`, the non-secret settings of each type (endpoint, API mode and version,
  auth mode, tenant and client id, region, access key id, base URL, organization, project,
  Anthropic version) and read-only status (`credentialHint`, `credentialUpdatedAt`, `lastTest*`).
- `ConnectionModels` (composition): `upstreamModel` (the provider's name: Azure deployment,
  Bedrock model or inference-profile id, OpenAI or Anthropic model), `modelId`
  (`<upstreamModel>--<name>`, computed), `family` (`openai | claude`, the routes that will serve it),
  `capabilities`, `isPublished`.
- `ConnectionCredentials`: one encrypted row per connection. It has no composition or backlink from
  `ProviderConnections` and no projection on any service, so no read or `$expand` can reach it.
- `ModelCosts.pricingKind` (`sap_genai` default, `list_price`) and `ModelCosts.currency` (list
  prices only). `LibraryModels.origin` (`sap | external`) and `LibraryModels.connection`.

Connections stand apart from `api_config` versioning: activating or rolling back a configuration
never changes an endpoint, a credential, a price or a published model.

## Admin API

`AdminService.ProviderConnections` and `AdminService.ConnectionModels`, admin role only
(`src/srv/admin-service-connections.ts`, rules in `src/services/connectionValidation.ts`):

- CRUD with validation per provider type (drafts, see Cockpit below); https URLs only (http on loopback for test fakes);
  defaults for the base URL, the Anthropic version and the Azure and Bedrock auth modes.
- `ProviderConnections` is draft-enabled, as every writable cockpit entity is. A plain `POST` creates a draft; a scripted write of an active connection posts with `IsActiveEntity: true` in the body (the draft bypass). Keys always carry `IsActiveEntity` (`ProviderConnections(ID=…,IsActiveEntity=true)`); a bare-ID key (`ProviderConnections(<uuid>)`) answers 400 on GET and PATCH (`connections-draft-odata.test.ts`). `name` and `providerType` are immutable after creation. The actions (`setCredential`, `clearCredential`, `testConnection`, `fetchModels`, `addModel`) work on the saved connection and refuse a draft key (`IsActiveEntity=false`), or any key without `IsActiveEntity=true`, with 400 (same test).
- A model whose id equals an SAP Library row is refused (409); the gateway would drop it anyway.
- `setCredential(secret, sessionToken)` / `clearCredential()`: write-only; only the masked hint is
  read back. `sessionToken` is for Bedrock with access-key auth. Refusals carry a code the app maps to its own texts:
  `secret_required` (400), `session_token_not_applicable` (400), `connection_not_found` (404) and
  `credential_key_missing` (503, the admin has no `CONNECTION_CREDENTIAL_KEY`).
- `setListPrice(inputCost, outputCost, cacheReadCost, cacheCreationCost, currency)`: per 1K tokens,
  closes the open `list_price` row and opens a new one. The currency defaults to the installation
  billing currency (`quotaCurrency()`, the SAP capacity-unit price row's currency).
- `publish()` / `unpublish()`: publishing needs a list price in force (409 `model_unpriced`).
- `testConnection()` / `fetchModels()`: through the gateway (`gatewayConnectionsClient.ts` →
  `POST /api/admin/connections/:id/test`, `GET /api/admin/connections/:id/models`, service key
  `ADMIN_TO_GATEWAY` with `connections:read`). The gateway refetches the snapshot, calls the provider
  and answers a reason code (`ok`, `no_credential`, `not_supported`, `unauthorized`, `forbidden`,
  `not_found`, `unreachable`, `timeout`, `upstream_error`) with the status and the provider's error
  code at most, never its text. The test result is kept in `lastTestAt` / `lastTestResult`; the model
  list is not stored. The handlers call the gateway before touching the database: the gateway calls
  back into the admin, and on SQLite the request must not hold the one connection meanwhile.
- Every write is audited by field name (credential actions at severity high, the value never) and
  announces itself on the Valkey channel `sap-llm-gateway:connections-changed` after commit.

## Credentials

`src/services/connectionCredentialStore.ts` follows the SIEM credential store: AES-256-GCM, a
scrypt-derived key per record (random 32-byte salt), the master key `CONNECTION_CREDENTIAL_KEY`
read on every call (rotation needs no restart, but makes stored credentials undecryptable). There is
no default: without the key nothing is stored (the action answers 503) and nothing resolves. A
wrong key or a tampered row resolves to null. The code is a copy, not a shared module, so the SIEM
store stays untouched. Docker and Kyma setup generate the key and keep it across re-runs.

## Snapshot for the gateway

`ValidationService.getConnections()` (`src/services/connectionSnapshot.ts`) answers only the
gateway's service JWT (`isGatewayServiceCaller`, 403 otherwise). It returns every connection with
`isActive`, its decrypted credentials (null when absent or undecryptable) and its published models,
each with `priced` (a `list_price` row in force now). The gateway lists only the models of active
connections; an inactive connection's models stay known so they answer 503 instead of reaching SAP.

The gateway's `ConnectionRegistry` (`services/gateway/src/connections/`) keeps it in process memory
only. It refetches on the change marker (`configService` subscribes and calls the handler
`index.ts` registers) and after 60 s, which also catches a price that expired by date. A change marked
while a refetch is in flight is not in its result: the snapshot stays stale and a caller of `ensureFresh`
waits for one more fetch. A failed
refetch keeps the last snapshot and retries after 10 s; the log names counts and the error class,
never content. The request path (`getModels`) waits only for the first load; later refetches run in
the background. A standalone gateway (`GATEWAY_STANDALONE`) takes its snapshot from `connections.json`
instead (see [Standalone file backend](#standalone-file-backend)); a non-standalone gateway without
`ADMIN_SERVICE_URL` has no connections.

## Model list

`modelService.getModels` merges the published connection models into the SAP list on every call
(`mergeExternalModels.ts`). An entry carries `accessType: 'external'`, `connectionId`,
`providerType`, `family`, `upstreamModel`, `capabilities` and `priced`, with or without
`SAP_INCLUDE_EXTENDED_MODEL_ATTRIBUTES`. If the SAP list fetch fails, the connection models are
served alone; with none, the SAP error propagates as before. An external id equal to an SAP id is
dropped with a warning and recorded as shadowed. The Anthropic models list takes external entries
by `family === 'claude'`.

The admin's Library snapshot stores external entries as `origin = 'external'` with their
connection name. The SAP pricing refresh skips them; their price is the list price.

## Entitlement: opt-in

A connection model is never granted by the default catalog. In the gateway,
`isModelEntitled(block, id)` refuses an external id under `mode: 'all'`, asking the registry rather
than the admin's exclusion list: the entitlement block is cached with the credential for up to an
hour, and a model published in between would otherwise reach every default-catalog caller. A catalog
that lists the id grants it; no block (admins, standalone) stays unrestricted. Substitution runs
before entitlement, so a rename onto a connection model is checked under its new id. On the admin
side the default catalog's effective set leaves out `origin = 'external'` rows, so user catalogs
below the default cannot hold them; admin catalogs can.

Configuration validation warns, without failing, when a `substitute_models` target containing `--`
names no connection model.

## Routing

Every inference route calls `resolveExternalTarget(req, res, modelId, served, shape)`
(`services/gateway/src/upstreams/externalTarget.ts`) after substitution, before anything
SAP-specific (on chat completions before the route's own entitlement check, which it repeats). It answers `sap` for any id that is not a connection model (the
route carries on unchanged), `handled` after sending a refusal, or `external` with the connection,
the model and its adapter. In order:

1. `connectionRegistry.refreshForRequest()`: the first load is waited for; a refetch the change
   marker asked for (an admin change a moment ago) is waited for at most `FRESH_WAIT_MS` (1.5 s),
   and not at all while the last fetch failed, so SAP traffic never waits on a failing admin; a
   refetch due by TTL runs in the background;
2. `connectionRegistry.resolveExternal(id)`: no hit, or a shadowed id, is `sap`;
3. entitlement again, against the registry view the dispatch uses: the route's own check may have
   run before a refresh published the model, and the default catalog grants any id it does not
   know to be external. The 403 is the route's usual body (the Gemini envelope on `/google`);
4. the model's family must be the one the route serves, else 400 `model_route_mismatch` naming the
   matching routes;
5. an inactive connection, or one without an adapter (no usable credential, a provider type not
   served yet), is 503 `connection_unavailable`;
6. a model without a list price in force (`priced: false`) is 409 `model_unpriced`;
7. `req.__externalUsage` is set, which tags the usage event.

| Route | Served family | Dispatch |
|---|---|---|
| `/openai/v1/chat/completions` (and the OpenRouter facade, which re-enters it) | `openai` | `chatDispatch.ts`: hook plugins first, then the post-plugin body; native SSE |
| `/openai/v1/responses` | `openai` | the controller's native passthrough (`forwardStream`) with the connection's URL and headers; `__responsesUpstream` points at the connection, so web-search continuations follow it |
| `/openai/v1/embeddings` | `openai` | `embeddingsDispatch.ts`: the whole body, every input |
| `/anthropic/v1/messages` | `claude` | `messagesDispatch.ts`: before plugins, then the outbound body; native SSE re-framed per event |
| `/aws-bedrock`, `/google` | none | 400 `model_route_mismatch` |
| images, SAP RPT, realtime | none | 404: they resolve an SAP deployment first, which a connection model never has |

No SAP model lookup, token, URL or orchestration transform runs for a connection model. The
outbound body is the client's body after the plugins, with `model` set to the upstream model and
no unsupported-parameter stripping or renames (those are keyed on SAP providers). Responses carry
the client's model id again (streamed Responses frames keep the provider's name).

Chat streams: the upstream is always asked for usage (`stream_options.include_usage: true`); the
usage-only chunk (`choices: []`) is forwarded only when the client asked for it. Frames are
written with `res.write`, which the pseudonymization plugin intercepts to unmask. A client that
disconnects aborts the upstream and records status 499 once; an upstream that breaks off after the
200 gets an error frame and `[DONE]`, recorded as 502.

## Adapters

`services/gateway/src/upstreams/`: `adapterFor(connection)` returns an adapter with
`buildRequest(route, clientBody, upstreamModel)`, `listModels()`, `testConnection()` and
`secrets()` (every credential value it may send, for redaction).

| | `openai` | `azure-openai`, `apiMode: v1` | `azure-openai`, `apiMode: deployments` |
|---|---|---|---|
| chat | `{baseUrl}/chat/completions` | `{endpoint}/openai/v1/chat/completions` | `{endpoint}/openai/deployments/{deployment}/chat/completions?api-version=` |
| responses | `{baseUrl}/responses` | `{endpoint}/openai/v1/responses` | `{endpoint}/openai/responses?api-version=` |
| embeddings | `{baseUrl}/embeddings` | `{endpoint}/openai/v1/embeddings` | `{endpoint}/openai/deployments/{deployment}/embeddings?api-version=` |
| auth | `Authorization: Bearer`, `OpenAI-Organization`, `OpenAI-Project` | `api-key`, or an Entra bearer token | same |
| test | `GET {baseUrl}/models` | `GET {endpoint}/openai/v1/models` | `GET {endpoint}/openai/models?api-version=` |
| model list | `GET {baseUrl}/models` | `GET {endpoint}/openai/deployments?api-version=2022-12-01`; 404 (retired on newer resources) gives an empty list | same |

Entra (`authMode: entra-client-secret`): the client-credential flow against
`{AZURE_AUTHORITY_HOST}/{tenantId}/oauth2/v2.0/token` (default host
`https://login.microsoftonline.com`), scope `https://cognitiveservices.azure.com/.default`, the
token cached per connection until five minutes before it expires; the cache key includes a hash
of the secret, so a rotated secret fetches anew.

### The `anthropic` adapter and the messages dispatch

`anthropicAdapter.ts`: base URL `https://api.anthropic.com` (`settings.baseUrl`); `x-api-key` and
`anthropic-version` (default `2023-06-01`, `settings.anthropicVersion` overrides). The client's
`anthropic-beta` header is passed on. `listModels` pages `GET /v1/models` with `after_id`;
`testConnection` calls `GET /v1/models?limit=1`.

`messagesDispatch.ts` serves `/anthropic/v1/messages`:

- Before plugins run first, then the outbound body is built (masking reaches the provider); forced
  pseudonymization fails closed (`refuseIfForcedWithoutPlugin`). `model` is the upstream model in
  the outbound body and the client's id in the response.
- Usage is exclusive: Anthropic reports `input_tokens` without cache read and creation tokens, so
  `foldExclusiveUsage` is applied and nothing is subtracted. Image tokens are not folded on this
  path: the provider's `input_tokens` already include them. Usage, pricing and hook lookups use
  the served Connection model id (`target.model.modelId`, whose `--<name>` suffix names the
  connection), also when the client's id was substituted; the client's id only appears in the
  response and stream events.
- Streams: the native SSE is re-framed event by event (`event:` plus `data:`), written with
  `res.write` so the pseudonymization plugin can unmask. The source is an `AnthropicEventSource`;
  `sseEventSource` is the SSE implementation, `eventStreamEventSource` the Bedrock one (below).
- A request with a `web_search` tool is refused before plugins with 400 `web_search_not_supported`.
- `count_tokens` stays a local estimate and does not call the provider.
- Upstream errors go through `sendUpstreamError`, which redacts `adapter.secrets()`.

Known pricing gaps: the list price has one cache-creation rate, so 1-hour cache writes (Anthropic
bills them at 2x input, 1.25x for 5-minute writes) are under-billed; the premium of the 1M-context
beta above 200K input tokens is not priced; Anthropic server tools other than web search (for
example code execution) are passed through and their charges are not priced.

### The `bedrock` adapter

`bedrockAdapter.ts` serves Claude on the `messages` route only (`buildRequest` throws for any other
route). Requests go to `{runtime}/model/{encodeURIComponent(model)}/invoke` or
`invoke-with-response-stream`, with `runtime` = `https://bedrock-runtime.<region>.amazonaws.com`
(`settings.runtimeEndpoint` overrides it). The body is the client's body without `model`, `stream`
and `anthropic_beta`, with `anthropic_version: "bedrock-2023-05-31"` unless the client set one; it is
sent as the exact JSON string that was signed.

- **Sign-in.** `authMode: bearer` sends the Bedrock API key as `Authorization: Bearer` to both
  planes. Otherwise `libs/aws-signing/sigV4.ts` (`signAwsRequest`) signs with service `bedrock` for
  the runtime and the control plane alike, with the optional session token as
  `x-amz-security-token`. The signer is generic: the canonical URI is double-encoded as every
  non-S3 service requires (model ids contain `:`); `s3Signer.ts` keeps S3's single encoding and is
  unchanged. Node builtins only, like the S3 signer.
- **Control plane.** Test Connection calls `GET /foundation-models?byProvider=Anthropic` on
  `https://bedrock.<region>.amazonaws.com`. With a `runtimeEndpoint`, the control plane uses the same
  origin with `bedrock-runtime` read as `bedrock` (one fake server serves both in tests). The model
  list pages `GET /inference-profiles?typeEquals=SYSTEM_DEFINED` (stopping when a `nextToken` repeats) and adds the Anthropic foundation models; only ids containing `anthropic.claude` are kept.
  Newer Claude models are invoked by inference-profile id only, which is why the profiles are listed.
  IAM: `testConnection` needs `bedrock:ListFoundationModels` only; `listModels` needs it and
  `bedrock:ListInferenceProfiles`, all or nothing (either refusal fails the list).
- **Beta flags.** They follow the SAP Bedrock path's precedence: the client's `anthropic-beta`
  header wins, and a body `anthropic_beta` is used only when there is no header. The result is
  filtered through the configured supported and excluded lists (`filterBetaFeatures` with
  `configService.getSupportedBetaHeaders()` and `getExcludedBetaHeaders()`) into the body's
  `anthropic_beta`, omitted when empty (Bedrock answers unknown flags with 400). The SAP path's
  model-keyed quarantine and injected flags are not applied.
- **Event stream.** A streamed invoke answers in AWS's binary event stream.
  `utils/eventStreamDecoder.ts` (`EventStreamDecoder`) reassembles messages across arbitrary chunk
  boundaries, checks both CRCs (`crc32` from `bedrockEventStream.ts`), bounds the message length at
  16 MiB and rejects non-string headers (`EventStreamError`). `eventStreamEventSource` in
  `messagesDispatch.ts` turns the `chunk` frames' base64 payloads into Anthropic events for the
  same re-framing as SSE. An `exception` frame ends the stream like a break, with an Anthropic
  `event: error`: `overloaded_error` for `throttlingException` and `serviceUnavailableException`,
  `api_error` otherwise; an `error` frame (`:error-code`) is treated alike, and a clean end inside a
  partial message is the broken-stream error. The message names the exception type or code only, never the frame payload, which
  can echo request data.
- **Usage.** Bedrock Claude reports `input_tokens` exclusive of cache read and creation, so
  `foldExclusiveUsage` applies as for Anthropic. Usage comes from `message_start` and
  `message_delta`; `amazon-bedrock-invocationMetrics` on `message_stop` is removed before the client
  sees it and used only when no usage was seen.
- **Refusals.** Web search stays refused (400 `web_search_not_supported`; Bedrock rejects the server
  tool anyway); `count_tokens` stays local. Credentials (secret key, session token, API key) are
  listed in `secrets()` and redacted from errors; the access key id is not a secret.

Known pricing gaps: as for `anthropic`, the list price has one cache-creation rate, so 1-hour cache
writes are under-billed, and the premium of the 1M-context beta above 200K input tokens is not priced.

## Errors

`upstreams/upstreamCall.ts`. One retry, after 250 ms, only for a connection reset before any
response; never on an HTTP status and never once a response started. Timeouts are
`api_config.platform.timeouts` (`configService.getTimeout`). An upstream status is passed through
with its error normalised to the route's shape (`normalizeUpstreamError`); a transport failure is
502, a timeout 504. Before anything reaches the client, the log or the payload log, every value
from `adapter.secrets()` is replaced by `[REDACTED]`: OpenAI and Azure echo a wrong key in their
401 message.

## Pricing and spend

The usage event of a connection request carries `provider` (the provider type), `connectionId`,
`upstreamModel` and `origin: 'external'`; `model` is the id the client asked for. OpenAI and Azure
count cached tokens inside `prompt_tokens`, so the gateway folds them as inclusive.

The admin records such a row with `origin = 'external'`, `connection` (the name) and
`upstreamModel` on `ApiKeyUsage` / `AwsCredentialUsage`.

**Price rule** (`src/services/externalUsagePricing.ts`). The price is the `list_price` row in force
at the request's timestamp, per 1K tokens:
`(input·in + output·out + cacheRead·(cacheReadPrice ?? in) + cacheCreation·(cacheCreationPrice ?? in)) / 1000`,
rounded to 6 decimals. The row gets `listCost`, `listCostCurrency` (the price's currency) and
`pricingMissing` (true when no price was in force; `listCost` is then null). The SAP columns
(`totalCost`, `sapCost`, ...) stay null: SAP pricing would read the list-price row as a GenAI rate.
A price changed later does not re-price old rows.

**Processing gate.** External usage is priced and booked without SAP model data (the SAP model
list may be down). SAP usage still waits in the buffer until that data is there.

**Buckets and windows.** The daily buckets have `externalCost` beside the SAP cost columns. The
quota and team-pool windows keep their wire name `sapCost`, which now means SAP cost plus
Connection spend in the quota currency, so the gateway is unchanged. Spend in another currency is
recorded on the row and in `externalCost` per currency, but not counted toward the windows.

**SAP-only readers.** The home "SAP cost" tile, SAP billing, reconciliation, the nightly
recalculation (it skips external rows), the rate lookup and model pricing ignore list prices and
external rows. Connection spend is shown apart: the home "Connections cost" tile, and in Usage
Analytics the "Connections cost" KPI and the "Connections spend" table
(`getUsageStatistics.connectionUsage`, per connection and currency, with the unpriced requests).
`reconcileInvoice` and `getUsageStatistics` take an optional SAP `tenant` (the tenant key, `<subdomain>.<landscape>`) that
narrows the SAP figures to it; Connection figures never filter by tenant.

## Cockpit

`services/admin/app/connections-app` (admin only; `ui5Apps` registration, Dockerfile and nginx parity as for every shell app, see [UI5 applications](/developer/ui5-apps)).

- **Drafts.** Fiori elements V4 edits only through drafts, so `ProviderConnections` is draft-enabled. Models are not part of the draft: their rules (computed id, immutable upstream model, family check, audit) live on their own handlers, which refuse deep writes. Models change through actions on the saved connection: `addModel`, and on `ConnectionModels` `setListPrice`, `publish`, `unpublish`, `remove`. A draft shows the model count of its active connection.
- **Custom dialogs, only where Fiori elements cannot do the job.** The credential dialog (the generic action dialog has no masked parameter) and the Add model picker (a list fetched live from the provider through `fetchModels`; free text stays allowed, and a failed fetch falls back to it). The price dialog is the generic one; the server computes its defaults (`connectionModelPrices.ts`): the price in force, else a LiteLLM suggestion.
- **Models table.** Multi-select rows; the toolbar actions Set price (one row only), Publish, Unpublish and Remove (confirmation). Publish needs a price (409 `model_unpriced`).
- **Deleting a connection** deletes its models one by one through the service (each audited, its open list price closed) and then its credential (`before DELETE`, `admin-service-connections.ts`).
- **LiteLLM price suggestion.** `services/admin/src/services/litellmPrices.json` is `{ _notice, prices }`: a trimmed snapshot of LiteLLM's `model_prices_and_context_window.json` (MIT; the notice travels inside the file into the image's dist). `listPriceSuggestion.ts` looks a model up per provider type; `connectionModelPrices.ts` offers it for USD installations only (the snapshot is in USD, there is no exchange-rate table). Non-USD installations get no suggestion. There is no refresh script in the repo: `LITELLM-NOTICE.md` beside the snapshot holds the source commit, the filter and the exact `node -e` command; run it from that directory against a fresh copy of the source file, then update the commit and date in the notice.
- **Model Library and Usage Analytics.** The Library shows a model's origin (SAP AI Core or Connection `<name>`) and leaves Connection prices to Connections. The average cost per request counts SAP requests only.

## SAP AI Core as a connection

A `ProviderConnections` row of type `sap-ai-core` carries the SAP target: the service key (stored like any credential, parsed with the CLI's service-key parser), the resource group, the productive flag and the price region (the last two live in `SapTenants`). At most one such row is active; activating one deactivates the other. `activate` needs a passing `testConnection` (token plus foundation-model list); deleting or clearing the credential of the active row is refused. The test gate covers the target as it serves: a changed `resourceGroup` on the active row is refused (409 `connection_active`) and on an inactive one resets `lastTestResult`; `setCredential` on the active row takes a key of the same tenant key only (409 `tenant_mismatch` otherwise) and resets the test result without deactivating. `endpoint`, `region`, `clientId` and `tenantId` are server-owned: a create or update drops them, `setCredential` sets them.

- **Target resolution.** The gateway's `sapTarget` module answers the current SAP target for every SAP call: the active connection's key if there is one, else the environment key. `sapTargetSync` refetches it from the admin on the change marker and, once the snapshot is older than its 60 s TTL, when a request reads it (there is no timer), and swaps it atomically; in-flight requests keep the target object they started with. If the gateway already serves a connection key and the new key fails the token request, it is not adopted and the previous target stays; if the gateway is still on the environment key, the connection key (or a matching last-known copy) is installed unprobed and SAP calls fail until fixed (`sapTargetSync`). A connection whose credential is unusable is never installed; a gateway on the environment key then installs that connection's last-known copy if there is one. The target carries a fingerprint (`sapTargetFingerprint`) and a version; a changed target makes the Model Library and catalogs follow the new tenant.
- **Last-known copy.** `lastKnownTarget` keeps the target AES-256-GCM encrypted in Valkey, keyed from `VALIDATION_TOKEN_SECRET`. Without Valkey, or with that secret unset or a publicly known default, the copy lives in process memory only, so a cold boot during an admin outage uses the environment key. It is written whenever a target from the admin is installed (also an unprobed one while the gateway was on the environment key). It is cleared when a snapshot has no active SAP AI Core connection and this process has seen one before (including a copy restored at boot); the process remembers the clear and deletes again only after it wrote a new copy, and once per process on the first snapshot without any SAP AI Core connection if a leftover copy exists. At boot the copy is installed without asking the admin when the admin does not answer in time.
- **Tenants.** `SapTenants` holds one row per tenant (key `zone`: `<subdomain>.<landscape>` of the auth-URL host, so one subdomain on two landscapes is two tenants) with `productive` and `priceRegion`. Usage rows carry the tenant; `sap-tenant-backfill` assigns rows from before the feature to the environment tenant once: one UPDATE per usage table, in one transaction with its marker row. Correcting `productive` reprices the tenant's last 62 days. Workers pin one SAP target per item.
- **Reads.** The Usage Analytics views have one row per key and tenant; SAP cost is shown per currency when tenants differ. The tenant filter is offered when more than one tenant exists.
- **Deployment id.** `SAP_AI_DEPLOYMENT_ID` names a deployment of the environment tenant: `getSAPAICoreConfig` (`configService`) uses it for the environment target only. Under a connection target it is ignored and the orchestration deployment is auto-discovered (whatever `SAP_AI_AUTO_DISCOVER_DEPLOYMENT` says); each install of a connection target logs one line when the variable is set.
- **Standalone / npm CLI.** The SAP target is unchanged: the environment or file key. `connections.json` (see [Standalone file backend](#standalone-file-backend)) refuses `sap-ai-core`; its other types work as in the cockpit.
- **AWS credentials.** A new credential's draft prefill and the region default follow `SAP_AI_REGION` or the active key's region.

## Standalone file backend

A standalone gateway (no `ADMIN_SERVICE_URL`) takes its snapshot from `connections.json` instead of the admin
(`services/gateway/src/connections/fileBackend.ts`, a `ConnectionBackend` like the admin one, so the registry,
adapters and routing are unchanged).

- **Path.** `connectionsFilePath(env)`: `CONNECTIONS_FILE_PATH`, else `connections.json` beside `CONFIG_FILE_PATH`,
  else no file backend. The CLI sets `CONNECTIONS_FILE_PATH` in `gateway-env.ts` from its config directory
  (`SAIL_PROXY_CONFIG_DIR`, else `~/.sail-proxy`, or `%APPDATA%\sail-proxy` on Windows). A missing file is no connections;
  a malformed one rejects, so the registry keeps its last snapshot (the warning names the path inside the document, never
  a value). Any other read error (`EACCES`, `EISDIR`, …) is logged with its code and the file path and rejects the same
  way. The file is read on
  every fetch, so the registry TTL (60 s) bounds how long a hand edit takes.
- **Format.** `{ "version": 1, "connections": [ { name, type, active?, settings?, secret?, sessionToken?, models? } ] }`. Types are
  `openai | azure-openai | anthropic | bedrock` (`sap-ai-core` is refused: the standalone SAP key comes from `.env`).
  Settings keys are checked per type; unknown keys anywhere are errors. Name rules match the admin's (spec §3), and so do
  the per-type rules of `services/admin/src/services/connectionValidation.ts`, ported to path-only errors: azure-openai
  needs `endpoint`, `apiMode` is `v1|deployments` (`deployments` needs `apiVersion`), `authMode` is
  `api-key|entra-client-secret` (entra needs `tenantId` and `clientId`); bedrock needs a well-formed `region`, `authMode`
  is `access-key|bearer` (`access-key` needs `accessKeyId`); an absent mode takes the cockpit's default (`v1`, `api-key`,
  `access-key`). `baseUrl`/`endpoint`/`runtimeEndpoint` must be https (http only on `localhost`/`127.0.0.1`),
  `upstreamModel` matches `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`, and `sessionToken` is for bedrock with `access-key` auth only (as `setCredential`).
- **Secrets** are a string or `{ "env": NAME }`. Env refs are resolved at each fetch, but against the `process.env` the CLI fixed when it spawned the gateway
  (`buildGatewayEnv`: shell, then `.env`). A reload only rereads the file, so a new or changed variable (including unset to set)
  is seen only after a gateway restart; an unset variable gives a
  connection without a credential (503 `connection_unavailable`); only own string properties count, so a name such as
  `toString` resolves to nothing. Text and mode come from one file handle. A loose mode (group/other bits) on a
  non-Windows host logs one warning; a refused file logs once per distinct refusal, not on every 10 s retry.
- **CLI writes** run read-change-write under `connections.json.lock` (created with `wx`; waits 3 s, takes over a lock
  older than 30 s), write `connections.json.tmp` (0600) and rename it; a failed write removes the `.tmp`.
- **`priced: true`.** Standalone records no usage and has no admin to hold list prices, so every file model counts as
  priced and the `model_unpriced` gate never fires. Prices in the file are not supported.
- **Shared validation.** The CLI (`npm-dist/sail-proxy/src/utils/connections-storage.ts`) validates before it writes,
  with its own copy of the rules. The gateway test and the CLI test (`npm-dist/sail-proxy/test/connections-storage.test.js`)
  both run the one fixture `services/gateway/test/fixtures/connections-file-cases.json`, so the two cannot drift apart;
  change a rule in both and add a case.
- **Routes.** `connectionAdminRoutes.ts` mounts `/api/admin/connections` for standalone with `gatewayStandaloneOnlyAuth`
  (the standalone caller only, like `/aws/api-keys`); distributed gateways keep `gatewayStandaloneOrServiceKeyAuth`.
  Standalone adds `POST /reload` (marks the registry stale and refetches; answers the connection and model counts),
  next to the shared `POST /:id/test` and `GET /:id/models`. The id is the connection name. The CLI calls `/reload`
  after every edit and tells the user when a running gateway answered but did not reload.

## Live check

`services/gateway/test/live/openai-connection.live.test.ts` runs the `openai` adapter against the
real API: `CONNECTIONS_LIVE=1 pnpm exec cross-env NODE_ENV=test jest --config jest.config.json
test/live/openai-connection.live.test.ts`, with `OPENAI_API_KEY` in the environment or the gateway
`.env`. It is skipped otherwise and never runs in CI.

`services/gateway/test/live/anthropic-connection.live.test.ts` does the same for the `anthropic`
adapter (`ANTHROPIC_API_KEY`, `claude-haiku-4-5-20251001`).

`services/gateway/test/live/bedrock-connection.live.test.ts` does the same for the `bedrock`
adapter, once per credential kind present (access key with an optional session token, Bedrock API
key). It reads `AWS_REGION`, `BEDROCK_MODEL_ID`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_SESSION_TOKEN` and `AWS_BEARER_TOKEN_BEDROCK` from `AWS_CONNECTION_ENV_FILE` (default
`~/Documents/repos/aws-connection.env`) and prints statuses, counts and the error type only. An invoke
passes with 200, or with 429 `ThrottlingException`; anything else, 403 above all, fails.

Live proof so far: the control plane (Test Connection, model list) and a 429 `ThrottlingException`
on invoke, because the maintainer's AWS account is throttled. The 200 path, plain and streamed, is
proven against fakes only until that limit lifts.
