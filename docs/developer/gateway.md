---
title: Gateway service
description: Routing, translation layers, streaming, configuration and usage tracking inside the gateway.
---

# Gateway Service

The Gateway service is the core component of SAIL-PROXY, responsible for API translation, authentication, request routing, and response processing. This page provides technical details on the Gateway implementation, configuration, and security features. The endpoint list is in [API endpoints](/reference/api-endpoints), every configuration key in the [Gateway configuration reference](/reference/configuration) and every environment variable in [Environment variables](/reference/environment-variables).

## Core Implementation

### Entry Point and Server Setup

**Main Server** (`services/gateway/src/index.ts`): an Express app without a separate app factory. In order, it:

1. sets `trust proxy` to `TRUST_PROXY_HOPS` (default 0);
2. mounts `body-parser` for JSON and URL-encoded bodies, limited to `config.maxRequestSize` (from `ConfigLoader` in `libs/config`, default `10mb`); for `/aws-bedrock` and SigV4-signed requests the JSON parser keeps the raw body as `req.rawBody` for signature verification;
3. logs every request through `morgan('combined')` into the shared logger;
4. attaches a request context to the logger (request id `gateway-<timestamp>-<random>`, client IP, user agent) and sets `req.debugRequestId`;
5. sets permissive CORS headers and answers `OPTIONS` with 200;
6. serves `GET /health` (`routes/healthRoutes.ts`);
7. mounts the route families: `/v1/models`, `/openai/v1/…` and `/openai/api/v1/…` (chat completions, embeddings, responses, images, files, uploads, vector stores), `/openrouter/api/v1`, `/anthropic/v1`, `/google/v1beta` and `/google/v1`, `/sap/v1/rpt`, `/aws-bedrock`, `/aws/api-keys`, `/api/admin/api-keys`, `/api/admin/api-config`, plus the deployment and grounding routes;
8. registers the global `errorHandler`;
9. at startup, starts the `file_search` workers and sweepers, then calls `app.listen` and attaches the Realtime WebSocket upgrade handler to the server (`attachRealtimeUpgrade(server)`).

Authentication, quota and tool governance are not global middleware: each router mounts them per route, as described below.

### Request Processing Pipeline

**Middleware Stack Architecture**: the global middleware above runs for every request; the rest of the chain is per route. The chat completions router (`routes/chatRoutes.ts`), for example:

```typescript
router.post('/', chatAuth, chatServiceAuth, toolGovernance(openaiChatAdapter), quotaEnforcement, substituteOpenAICompatibleModel, openaiController.handleChatCompletion);
```

On every LLM-serving route (chat completions, messages, responses, embeddings, AWS Bedrock,
vector stores) the actual per-route middleware order is: validation (unified token or SigV4 auth,
which resolves the caller and attaches its `user` and `entitlement` blocks) → `quotaEnforcement` →
the route's controller, where model substitution (`substitute_models`) resolves the requested model
(on `/openai/v1/chat/completions` and `/openai/v1/responses` the `substituteOpenAICompatibleModel`
middleware directly in front of the controller does it, from the openai list, then the perplexity
list) before the entitlement guard (`enforceEntitlement`) checks it → the upstream call to SAP AI Core.

### Quota enforcement

`services/gateway/src/middlewares/quotaEnforcement.ts` runs right after validation on every
LLM-serving route. It reads the `user` block validation attaches beside `entitlement`
(`UserBlock` in `services/gateway/src/clients/adminServiceClient.ts`: `email`, `status`, `roles`,
and `limits` — `requestsPerMinute`, `spendPerDay/Week/Month`, `tokensPerDay/Week/Month`, each
`number | null`). A `status` of `deactivated` is refused with `401`
(`{ error: { type: 'user_deactivated', message: 'This user account is deactivated' } }`) before any
counter is touched.

**Requests per minute/hour/day** are counted in Valkey: `rl:user:<sha256(email)>:<minute>` for the
user-level requests-per-minute limit, `rl:key:<id>:<minute>` / `:h:<hour>` / `:d:<day>` for the
credential's own limits. The minute buckets use a two-bucket sliding window (the current minute's
INCR plus the previous minute's count weighted by the fraction of the current minute that has not yet elapsed, so the carry-over decays to zero as the minute progresses); the
hour and day buckets are plain fixed windows. The user check runs before the key checks, and the
first exceeded check stops the rest — a request already refused on the user's per-minute limit must
not still burn the key's hour/day budget.

**Spend and tokens per day/week/month** are checked against the per-user state document
(`quota:user:<sha256(email)>`, TTL 24 h) that the admin's `userQuotaService` (specifically
`publish`/`buildDocument`) writes, rewritten on every usage batch that touches the user, on every
constraint/status change, on configuration activation, and once a minute for documents whose day
window has rolled over. The admin does not aggregate the usage tables when it publishes a document.
`usageEventProcessor` keeps one bucket per user, UTC day and cost currency (`UserUsageDaily`) in the
same transaction that inserts a batch's usage rows — dropped duplicates never count — and
`userQuotaService` derives the day, ISO-week and month figures from at most ~37 bucket rows per user
(`usageCounters.ts`; one query per user, one per page for the Users list and the quota status page).
A quota reset deletes the user's buckets. `usageCounters.rebuild()` recomputes the buckets from the
rows for the last window horizon: on the first start with an empty bucket table (the migration for
existing deployments), on every daily maintenance run, after the cost recalculation — whether or not
it rewrote any row, because the 62-day retention runs with it — and through the admin-only
`rebuildUsageCounters` action (`emails: []` rebuilds everyone). Rows without a usage signature
(validation logs) and rows whose owner could not be resolved never count; buckets older than 62 days
are purged by that rebuild. The daily run republishes every user's state document as well, which
also refreshes the documents of users idle for more than the 24 h TTL, which would otherwise simply
expire. The daily maintenance run starts 5 minutes after the admin service starts and then every
24 hours from that clock time — so a midday redeploy pins it to midday — unless
`platform.maintenance.dailyRunAtUtc` is set to an `HH:MM` UTC time, in which case the 5-minute
startup run still happens and every run after it starts at that time of day. A configuration
activation or rollback re-arms the schedule without triggering a run.
`services/gateway/src/services/quotaStateReader.ts` reads it with a 10 s local cache per pod
(`QuotaStateReader`), so an admission check costs at most one Valkey `GET` per user per ten seconds
per pod — and the overshoot this bounds is at most one usage batch of traffic between a limit being
crossed and the next document the gateway reads reflecting it.

A quota reset that commits while a daily rebuild is running is re-derived from the usage rows
until the next rebuild: the rebuild reads each user's watermark once, so a watermark stored after
that read only takes effect on the next day's run — or at once, through `rebuildUsageCounters` for
that user. Two admin replicas rebuilding at the same time cannot corrupt the buckets either: the
buckets are keyed `(email, day, currency)`, so the replica that commits second conflicts on that
key, its whole transaction rolls back, and it logs a warning; the winner's rebuilt buckets stand
untouched and complete.

**Fail-open**: when Valkey is unreachable, `quotaEnforcement` runs the same algorithm against this
pod's own in-memory counters instead, and emits `quota_unenforced` at most once per five minutes per
pod (`UNENFORCED_EVERY_MS`) rather than on every request. The same throttled event fires when the
state document cannot be read. Standalone mode (no admin configured) enforces only a per-key
requests-per-minute limit, in memory, from `RATE_LIMIT_RPM` (default 100) — there is no user scope
and no spend/token admission.

A refusal raises `quota_exceeded` (`securityEventEmitter.emitQuotaExceeded`), whose `metadata`
carries `ownerEmail`, `scope`, `dimension`, `window`, `limit` and `used`.

**Two request-rate layers, one page.** `checkRequests` runs the user's per-minute limit (from the
user block: own constraint, else quota profile, else `platform.quotas`) and then the credential's
own minute/hour/day limits (`RateLimits` row, set through `setRateLimits`). The cockpit shows both
on a credential: the credential's three fields, and `ownerRequestsPerMinuteText` — a virtual the
credential after-READ fills from `userQuotaService.statusMany` for the page's distinct owners,
rendered by `quotaLimits.effectiveLimitText` ("60 (Standard profile)"). The `setRateLimits`
parameters carry `UI.ParameterDefaultValue` paths (`in/requestsPerMinute`, …), which Fiori Elements
resolves against the bound row, so the dialog opens with the current values.

## Authentication System

### Token Validation and User Resolution

**Authentication Middleware** (`services/gateway/src/middlewares/unifiedTokenAuth.ts`, created per router with `createUnifiedTokenAuth()`):

1. **Detect the credential type** (`detectAuthType`): an AWS SigV4 `Authorization` header with `x-amz-date` is an AWS credential; anything else is an API key.
2. **API keys**: `extractApiKey` reads `Authorization: Bearer`, `x-api-key`, `x-stainless-key` or `x-goog-api-key`. `unifiedApiKeyValidationService.validateApiKey` checks the validation cache (`unifiedValidationCache`, in memory and, with distributed caching, in Valkey) and on a miss asks the admin service (`AdminServiceClient.validateUnifiedAuthByToken`, `POST /odata/v4/validation/validateUnifiedAuthByToken`). The admin issues keys as `sk-` plus random hex.
3. **AWS credentials**: the access key id, region and session token are extracted and validation is delegated to `middlewares/tokenBasedAwsAuth.ts`, which verifies the SigV4 signature over `req.rawBody`.
4. **Success**: `req.unifiedAuth` carries the result; the validation response also attaches the caller's `user` and `entitlement` blocks.
5. **Failure**: `securityEventEmitter.emitFailedAuth` records the attempt, then the request either falls back to the legacy local check (`UNIFIED_AUTH_FALLBACK_TO_LOCAL`) or gets a 401 `authentication_error`.

When the unified token system is off (`UNIFIED_TOKEN_SYSTEM_ENABLED` not `true`) or the gateway runs standalone, the legacy middleware (`middlewares/apiKeyAuth.ts`) checks keys locally.

### API Key Security Features

**Rate Limiting Implementation**: request-rate limits are part of quota enforcement (above). The counters live in `services/gateway/src/services/rateLimitStore.ts`: `ValkeyRateLimitStore` keeps the shared buckets, with an in-memory store as the fail-open fallback. Credential secrets in the validation cache are encrypted when `UNIFIED_AUTH_CACHE_ENCRYPT_SECRETS` is `true`.

## API Translation Layer

### OpenAI API Implementation

**OpenAI Route Handler** (`routes/chatRoutes.ts` → `controllers/openaiController.ts`, `handleChatCompletion`):

1. `validateChatRequest` (`controllers/openaiRequestValidation.ts`) checks the body.
2. `enforceEntitlement` checks the (substituted) model against the caller's entitlement.
3. A deployed model (`--deployed`, a direct model deployment) is sent to its deployment; every other model goes through orchestration.
4. `transformRequestToSAPFormat` builds the Orchestration API v2 payload: `config.modules.prompt_templating.model` (name and parameters) and `prompt.template` with the translated messages and tools; `config.stream` when the client streams.
5. The before-plugins run (`executeBeforePlugins` with the hook configuration from `configService.getHookConfig(model, subpath, 'openai')`); a plugin may answer the request itself.
6. `sapAIService.completeChat` or `sapAIService.streamChatCompletion` calls `POST {SAP_AI_CORE_URL}/v2/inference/deployments/{id}/v2/completion`.
7. `transformSAPResponseToOpenAI` builds the `chat.completion` (or `chat.completion.chunk`) object; `inferFinishReason` maps the finish reason; the after-plugins run.
8. `emitUsageEvent` records the usage, with the orchestration usage folded into the OpenAI usage shape (`utils/usageFolding.ts`).

### The model list

`GET /v1/models` (`services/gateway/src/services/modelService.ts` `getModels`) returns the models a
request can actually be routed to: SAP AI Core foundation models with an `orchestration` scenario,
plus the running deployments, minus the deprecated ones, filtered by the caller's entitlement.

`GET /v1/models?include=unroutable` additionally returns the foundation models SAP AI Core
publishes that this gateway cannot route — those without an `orchestration` scenario, the GPT
realtime models among them. Every item of that list carries `routable` (an extended attribute, so
it needs `SAP_INCLUDE_EXTENDED_MODEL_ATTRIBUTES=true`), `false` on exactly those models. Both
variants come out of one fetch and share its cache entry and expiry.

The only caller that passes the parameter is the admin service's `modelCostService`, whose two
`/v1/models` pulls feed the Model Library snapshot: an administrator can then see what SAP AI Core
offers. `mapModelToLibraryRow` takes both access flags straight from SAP's scenarios — such a row
keeps `llmAccess` when the model can be deployed (its deployment is routable like any other) and
gets `orchestration: false`, which the library shows as *Deployment only*. `updatePricingDatabase`
skips the flagged rows, so they reach nothing but the snapshot. Without the parameter the response
is the routable list, unchanged.

The gateway's Valkey `model-list-updated` publish (`configService.publishModelListAfterConfigUpdate`)
feeds that same admin snapshot, so it carries the same full list — otherwise a Valkey deployment
would snapshot only the routable models and mark the others absent again after every publish.

### Anthropic API Implementation

**Anthropic Route Handler** (`routes/anthropicRoutes.ts` → `controllers/anthropicController.ts`, `handleMessages`). The router mounts `POST /messages`, `/complete` and `/messages-beta` with the chain `anthropicAuth` → `anthropicServiceAuth` → `toolGovernance(anthropicAdapter)` → `quotaEnforcement` → controller; `POST /messages/count_tokens` has only authentication.

- **Deployed models** (`accessType` `deployment` or a `--deployed` id): `awsBedrockService.processBedrockRequest` sends the Anthropic body to the model deployment's `invoke` or `invoke-with-response-stream` subpath and returns the answer in Anthropic format.
- **Every other model**: `anthropicService.transformRequestToSAPFormat` translates the Messages request (system prompt, content blocks, images, tools, tool results) into the orchestration payload; `sapAIService.completeChat` or `streamChatCompletion` sends it; `anthropicResponseService` translates the answer back, including `mapSapFinishReasonToAnthropic`, `mapSapCacheUsageToAnthropic` and `mapSapCacheCreationToAnthropic`.

**Prompt caching on the orchestration path** (`services/anthropicCacheBreakpoints.ts`). The client's own `cache_control` breakpoints are forwarded when prompt caching is on for the target model, by the same rule as the Responses bridge (`utils/promptCachingSupport.ts`: Anthropic models by default, a `supports_prompt_caching` override on the model or provider either way); otherwise they are removed and the request is built as if unmarked. None are added when the client sends none (caching is opt-in on the Anthropic API, unlike the Responses bridge, which inserts them for Codex). A message the client marked keeps its text as `{type:'text', text, cache_control}` blocks, the shape orchestration honours; unmarked messages stay plain strings, so a request without breakpoints produces the same payload as before. Rules:

- At most four breakpoints reach SAP; extra ones are dropped from the earliest.
- Every breakpoint is sent as `{type:'ephemeral'}` (5 minutes). `scope` and other fields are dropped, and so is `ttl`: orchestration honours `1h` (arm C of the capture), but usage pricing books every cache write at one rate and Anthropic bills 1-hour writes higher, so `ttl` stays off until pricing distinguishes them.
- Empty text blocks are dropped from a marked turn (Anthropic refuses them); an empty block's breakpoint moves to the previous text block of the same turn.
- Orchestration refuses array content on `tool` messages, so a breakpoint on a `tool_result` moves to the last non-empty text of the nearest earlier message (user, system or assistant, `tool_calls` turns included); with no such message it is dropped. In a tool loop whose assistant turns carry only tool calls, that can be the turn where the loop started, so the tool results of the loop itself are not cached; a client that ends its turn with text after the tool results (Claude Code's system reminders) keeps the breakpoint on that text.
- Tools are never marked: no capture shows orchestration forwarding a breakpoint on `prompt.tools`.

Every response, streaming or not, reports `cache_creation_input_tokens`, `cache_read_input_tokens` and the `cache_creation` object (`ephemeral_5m_input_tokens`, `ephemeral_1h_input_tokens`), as 0 when nothing was cached. The live captures behind these rules are `test/fixtures/orchestration/cache-probe-result.md` and `anthropic-cache-live-result.md`; `test/anthropic-cache-live.test.ts` (opt-in, `ANTHROPIC_CACHE_LIVE_PROBE=1`) repeats them.

Errors use the Anthropic envelope (`utils/anthropicErrors.ts`).

### AWS Bedrock Implementation

**Bedrock Route Handler** (`routes/awsBedrockRoutes.ts` → `controllers/awsBedrockController.ts`, `handleBedrockRequest` → `services/awsBedrockService.ts`, `processBedrockRequest`). The route is `POST /aws-bedrock/model/:modelId/:subpath`, the Bedrock runtime shape (`invoke`, `invoke-with-response-stream`, `converse`, `converse-stream`). A model without a deployment (`utils/deployedModel.ts`) is handed to the /anthropic flow (`serveThroughOrchestration` → `anthropicController.handleMessages`), which serves it through orchestration and runs that route's plugins and usage booking: an `invoke` body is an Anthropic Messages request already (Claude models only), a Converse body is translated by `utils/bedrockConverse.ts`, and the answer goes back in Bedrock's shape. For a deployed model, a subpath listed in the model's `subpaths_native` (by default `invoke` and `invoke-with-response-stream`) is passed through to the SAP AI Core deployment. A subpath the model does not serve natively is emulated: an `invoke` request is translated from the Anthropic Messages body to the Converse API (`transformAnthropicToBedrockConverse`) and sent to `converse` or `converse-stream`; a `converse` request is forwarded unchanged. AWS SigV4 requests are verified against the raw body. The service writes its streams as SSE, as it does for the Anthropic route; for the two streaming subpaths the controller first installs `installBedrockEventStream` (`utils/bedrockEventStream.ts`) on `res`, which turns each SSE event into an AWS event stream frame on its way to the socket. Before-plugins, the tool tap and the service therefore keep writing and reading SSE.

**The middleware chain** (`services/gateway/src/routes/awsBedrockRoutes.ts`):
`conditionalUnifiedAuth` (unified token auth, skipped when SigV4 already authenticated the request) →
`bedrockServiceAuth` → `toolGovernance(bedrockAdapter)` → `quotaEnforcement` →
`awsBedrockController.handleBedrockRequest`. Tool governance now sits between service authentication
and quota enforcement — the same position the other REST families use; the tool governance page of this section describes the adapter itself (shape
detection, the Converse/Anthropic-invoke split, the `stripRefusal`/`rejectionHeaders` additions, and
the stream tap that records tools from Bedrock's own passthrough stream).

### Google Gemini route

`/google` lets any Gemini-shaped client — Gemini CLI, `@google/genai`, anything building
`<baseUrl>/<apiVersion>/models/<model>:<method>` — reach EVERY model the gateway offers. A Gemini
model with a SAP AI Core deployment is served natively; every other model (Claude, GPT, Mistral,
Perplexity, and an undeployed Gemini model) is served by SAP orchestration through a
Gemini↔orchestration translation. API-key auth, entitlement, quotas, hooks/plugins and metered
usage are unchanged from the other inference routes — what differs is the error envelope
(`{error:{code,message,status}}`, never the OpenAI or Anthropic shape) and that the model name
arrives in the URL path rather than the body.

**Module map** (`services/gateway/src/`):

| File | Role |
|---|---|
| `routes/googleRoutes.ts` | mounts `/google/v1beta` and `/google/v1`; auth, service auth, quota middleware |
| `controllers/googleController.ts` | parses the request, resolves the route (`chooseRoute`), entitlement, hooks, error shaping |
| `controllers/googleDispatch.ts` | the three transports: native deployment, orchestration chat bridge, embeddings |
| `controllers/googleWire.ts` | conventions shared by controller and dispatch: error envelope, SSE headers/teardown, usage folding |
| `services/googleGeminiService.ts` | `parseModelMethod`, `resolveGeminiDeployment`, `geminiUrl`, usage/error helpers |
| `google/orchestrationBridge/requestTranslator.ts` | Gemini body → `SapV2CompletionRequest` |
| `google/orchestrationBridge/geminiParts.ts` | one Gemini `Part` → one orchestration content block; `UnsupportedGeminiInputError` |
| `google/orchestrationBridge/responseTranslator.ts` | orchestration envelope → Gemini response (+ `usageMetadata`) |
| `google/orchestrationBridge/streamTranslator.ts` | `StreamChunk` → Gemini SSE frames (+ final usage) |
| `utils/geminiBodyAdapter.ts` | text extraction/replacement for the pseudonymization plugin |

`/google/v1beta` and `/google/v1` in `src/index.ts` mount the same router twice: the `@google/genai`
SDK builds its URL as `<baseUrl>/<apiVersion>/models/<model>:<method>` and defaults `apiVersion` to
`v1beta`, while other callers may send `v1`. Express receives `<model>:<method>` as one path
segment; `parseModelMethod` (`googleGeminiService.ts`) splits it back apart on the last colon.

**Route choice** (`chooseRoute`, `googleController.ts`) follows the rule `/openai/v1/responses`
uses: a deployment serves the request when one exists AND can serve it; orchestration serves
everything else. It is pure given a `getDetails` reader, so the whole table is unit-tested without
a live catalogue.

| Method | Condition (checked in order) | Route |
|---|---|---|
| `generateContent` / `streamGenerateContent` | explicit `<m>--deployed`, deployment's provider matches `/google\|gemini/i` | **native**, on that deployment |
| | explicit `<m>--deployed`, deployment's provider is NOT Google (e.g. a Claude deployment asked for in Gemini shape) | **bridge**, on the base model name |
| | bare `<m>` with a Google-provider twin (`resolveGeminiDeployment`) | **native**, on the twin |
| | bare `<m>`, `getModelDetails(model)` returns an entry | **bridge**, `modelName = details.model \|\| baseModel` |
| | none of the above | 404 |
| `embedContent` | bare `<m>`'s details carry `allowedScenarios` including `orchestration` | **embeddings via orchestration** (exact usage) |
| | else a Google-provider twin or explicit `--deployed` id whose capabilities include `embedding` | **embeddings native** (estimated usage) |
| | else | 404 |

For `embedContent` the orchestration branch is checked FIRST deliberately: it is the metered path
(`/openai/v1/embeddings` never uses a deployment either), and a chat deployment is never offered
`embedContent` at all — SAP refuses the subpath outright — which the capability check on the native
branch enforces. `accountedModelId(route)` is the id entitlement, hooks and usage are recorded
against: the deployment id for `native`/`embeddings-native`, the orchestration model name otherwise.

**Entitlement is checked on BOTH ids when routing moves the request.** The requested (post-substitution)
model and the accounted id are different entries in the catalogue whenever a bare Gemini name is
swapped onto its `--deployed` twin, or a `--deployed` id is bridged under its base name — so both must
be entitled, and the 403 names the one that failed (`emitNotEntitled` reports that same id, so the
client message and the `model_not_entitled` security event agree). This is the parity
`/openai/v1/responses` established at its own sibling swap: a catalog that lists only the bare id must
not admit the decorated deployment, or vice versa.

**Dependency on `SAP_INCLUDE_EXTENDED_MODEL_ATTRIBUTES`.** `chooseRoute`'s `hasOrchestrationScenario`
reads `details.allowedScenarios`. That field is an extended attribute: `transformModelsToOpenAIFormat`
(`services/modelService.ts`) only copies it onto a model's transformed entry when
`includeExtendedAttributes` — `process.env.SAP_INCLUDE_EXTENDED_MODEL_ATTRIBUTES === 'true'` — is on,
and `getModelDetails`/`getModelById` read off that same transformed cache. With the flag off,
`allowedScenarios` is absent from every model's details, `hasOrchestrationScenario` is always false,
and the `embedContent` route choice's first branch never matches — every `embedContent` request
either falls to a native embedding deployment (if one happens to exist) or 404s. The flag must be
`true` for `embedContent` to work at all in the general case.

**`req.body.model` for the plugin pipeline.** `handleGemini` sets `req.__endpoint = 'google'` and
`req.body.model = accountedId` before calling `getHookConfig`/`executeBeforePlugins`, because the
plugin pipeline (built for OpenAI/Anthropic bodies) and the pseudonymization body-shape adapter both
read `req.body.model` — a field Gemini requests carry nowhere (the model comes from the URL). Both
fields are supplied only for the plugin pipeline's benefit; `req.body.model` is deleted again
immediately after the before-plugin call, before anything reaches SAP — the inference proxy and
orchestration both reject an unexpected `model` field on the body.

**The `pluginResult.response` short-circuit superset.** `executeBeforePlugins` can return
`{ stop: true, response }` when a plugin (a cache hit, say) wants to answer the request itself.
Every other route only ever checks `pluginResult.stop` and returns, because no shipped plugin sets
`.response` today. `handleGemini` additionally honors it: when `pluginResult.response !== undefined`
and `res` hasn't been written to yet, it responds `res.status(200).json(pluginResult.response)`. This
is a benign superset of the other routes' behavior — nothing changes for a plugin that never sets
the field — that lets a future plugin answer a Gemini request without writing to `res` itself.

**SAP subpath facts** (probed live against SAP AI Core).
SAP's inference proxy allowlists subpaths per deployed model rather than per gateway route:

- A chat deployment answers `models/<m>:generateContent` (200) and
  `models/<m>:streamGenerateContent` (200, SSE, with or without `?alt=sse`); `:countTokens`,
  `:embedContent` and `:predict` are refused with `400 {"error":"BadRequest","message":"Subpath
  '<p>' is not allowed for model '<m>'."}`.
- An embedding deployment (e.g. `gemini-embedding-2`) answers `models/<m>:embedContent` (200,
  `{"embedding":{"values":[...]}}`, with **no** `usageMetadata` — the reason `dispatchEmbeddings`
  estimates tokens for this path) and refuses `:predict`/`:batchEmbedContents`/`:countTokens` the
  same way.
- Headers sent to SAP: `Authorization: Bearer <AI Core token>`, `AI-Resource-Group: <resource
  group>` (`headersForSap` in `googleController.ts`).

**The documented refusals apply on BOTH routes.** `fileData`, a non-image `inlineData`, a hosted tool
(`googleSearch`, `codeExecution`, …), `candidateCount > 1` and a missing or non-array `contents` are
refused with 400 `INVALID_ARGUMENT` naming the item path whichever transport would serve the turn. The
bridge enforces them by translating; the controller calls `validateGeminiRequest(body)`
(`requestTranslator.ts`) before a native chat post, which runs those same three translation steps and
discards their output rather than keeping a second copy of the rules. Without it the same body was
refused or served depending only on which model the router picked.

**Translation table** (bridge; `google/orchestrationBridge/`):

*Request* (`requestTranslator.ts`, `geminiParts.ts`):
- `systemInstruction.parts[].text` (joined `\n`) → the first message, `{ role: 'system', content }`.
- `contents[]`: role `user`/`model` → `user`/`assistant`; `text` parts → text content blocks;
  `inlineData` with an `image/*` mime type → an `image_url` data-URI block, any other mime type or a
  `fileData` part → `UnsupportedGeminiInputError` (400 `INVALID_ARGUMENT` naming the item path).
- `functionCall` in a `model` turn → assistant `tool_calls[]` with a minted nine-character id (`c<turn:5><part:3>`, e.g. `c00001000` — Mistral refuses any other shape)
  (Gemini carries no ids of its own); `functionResponse` in a `user` turn → `{ role: 'tool',
  tool_call_id, content }`, matched to the preceding model turn's calls by POSITION.
- `tools[].functionDeclarations[]` → chat `tools`; any other tool key (`googleSearch`,
  `codeExecution`, …) → `UnsupportedGeminiInputError`.
- `toolConfig.functionCallingConfig.mode` → `tool_choice` (AUTO/ANY/NONE).
- `generationConfig`: `temperature`, `topP`→`top_p`, `maxOutputTokens`→`max_tokens`,
  `stopSequences`→`stop`; `candidateCount > 1` → error; `responseMimeType`/`responseSchema`/
  `responseJsonSchema` → `response_format`; `thinkingConfig.thinkingBudget` → a reasoning-effort
  band (0 → minimal, ≤1024 → low, ≤8192 → medium, else high; −1 → medium); `topK`, `seed`,
  `safetySettings`, `presencePenalty`, `frequencyPenalty` are dropped (documented in the user
  guide's limits list, not approximated). `temperature`/`top_p` then go through
  `utils/samplingSupport.ts` (`dropUnsupportedSampling`): SAP refuses the pair for `anthropic--*`
  ("`temperature` and `top_p` cannot both be specified") and, for the gpt-5..9/o-series family,
  `top_p` outright plus any temperature other than 1 — the refused key is deleted so Gemini CLI's
  defaults (temperature 0, topP 1) do not turn into an in-stream 400 the CLI reports as "Model
  stream ended without a finish reason". Measured live 2026-09-08; Gemini, Mistral and gpt-4.x
  accept both.

::: v-pre
*Envelope quirks measured live 2026-09-08* (`assembleOrchestrationPayload`, shared with the
Responses bridge — so both bridges behave the same):
- SAP appends `prompt.template` AFTER `messages_history`, so the usual shape (system message in the
  template, conversation in the history) ends every turn with the system message. Mistral's LLM
  module refuses a system message after a tool result (a bare "400 - LLM Module: An error occurred
  while processing your request"; user→system is accepted). On a `mistralai--*` tool turn the newest
  message becomes the template and the system message leads the history — the shape
  `openaiController`'s chat branch has always sent. Other models keep the system-only template.
- The template is the one place SAP's placeholder parser reads: `{{?name}}` / `{{ ?name }}` (letter
  first, letter or digit last, single `_`/`-` inside) is substituted, and a name without a value is
  a 400 ("Unused parameters: ['name']"); `{{bar}}`, `{{ x }}`, `{{#if}}` pass untouched, a malformed
  name (`{{? foo }}`, `{{?foo.bar}}`) is a hard templating error. `literalPlaceholderValues` maps
  every well-formed name in the swapped-in message to its own text so it reaches the model verbatim.
  History content is never parsed, which is why the swap is confined to the one provider that needs
  it.
- Tool-call ids must be nine alphanumerics for Mistral (`mintToolCallId`, above); the Responses
  bridge passes the client's ids through, and pi/Codex echo the ids the model minted, which are
  already that shape.
- OpenAI's `developer` role (pi sends the system prompt that way to reasoning-capable models) is
  mapped to `system` in `responsesInputToMessages`; orchestration rejects it for Gemini ("Invalid
  role 'developer' in message").
:::

*Response* (`responseTranslator.ts`): `choices[0].message.content` → `candidates[0].content.parts[{
text }]`; `tool_calls[]` → `functionCall` parts; `finish_reason` maps `stop`→`STOP`, `length`→
`MAX_TOKENS`, `tool_calls`→`STOP`, `content_filter`→`SAFETY`, anything else→`OTHER`; SAP's `usage` →
`usageMetadata` (`promptTokenCount`, `candidatesTokenCount`, `cachedContentTokenCount`,
`totalTokenCount`).

*Stream* (`streamTranslator.ts`, `StreamChunk` → Gemini SSE frames): a text delta becomes a frame
carrying `candidates[0].content.parts[{ text }]`; tool-call deltas accumulate per index and are
emitted as ONE frame with the complete `functionCall` part when that call closes; the final frame
carries `finishReason` and `usageMetadata`; a chunk carrying `error` becomes one Gemini error frame
and ends the stream.

**The Gemini split-placeholder retention buffer.** The pseudonymization plugin's SSE unmask
interceptor (`installSseUnmaskInterceptor` in `src/plugins/pseudonymization/index.ts`) buffers a
`gemini_text:<candidateIndex>` `StreamUnmaskBuffer` per candidate, because a placeholder token can
straddle two Gemini frames exactly as an Anthropic `text_delta` can — and the byte-level safety net
below it only resolves whole tokens. The buffer flushes when that candidate's `finishReason`
arrives (a Gemini stream always ends with one — the bridge translator's `finish()` emits a terminal
frame even when SAP sent none). A terminal frame routinely carries no text of its own (`parts` can
be empty, and SAP's native shape can omit `content` entirely), so a retained tail still has to land
somewhere: the handler appends it to the last text part if one exists, or materialises
`candidate.content = { role: 'model', parts: [{ text: remainder }] }` when there is none — dropping
it would silently truncate the answer. On the BRIDGE path this is a no-op in practice: frames reach
`res.write` already unmasked because the after-plugin chain ran per frame before they got there
(`pluginFrame` in `googleWire.ts`). It matters on the NATIVE pass-through, which has no per-frame
plugin chain and relies on this interceptor alone.

**SIEM stream-content capture is not wired for Gemini frames.** `appendStreamContent`
(`services/siemStreamCapture.ts`) is called from the Anthropic `text_delta`/`delta` handlers and the
generic after-chain handler in `pseudonymization/index.ts`, but not from the `candidates[]` handler
that processes Gemini frames. This is deliberate rather than an oversight: on the bridge path the
frames reaching that code are already unmasked (the after-plugin chain ran first), so capturing them
there would capture cleartext under a code path meant to capture the masked wire form. On the NATIVE
pass-through this same code IS the masking boundary — the text arriving here is still masked, which
is what this interceptor unmasks before it reaches the client — so a capture added there would be
correct. Wiring it correctly therefore needs a path-aware gate — capture only on the native
pass-through, never on the bridge — and is left as follow-up work.

### SAP-RPT tabular prediction route

`/sap/v1/rpt` relays SAP's relational pretrained transformer (RPT) models — a tabular contract
(rows in, predictions out), not a chat contract. The route is a pass-through: the gateway adds
authentication, entitlement, quota, deployment resolution, usage and cost, and re-validates nothing
SAP validates itself. It runs **no hook chain** — masking of tabular cells was judged feasible and
deliberately declined — and has no streaming and no tool governance, so nothing else in
this page's middleware stack applies to it. This section covers only the gateway side; the client side is described in [Tabular prediction (SAP-RPT)](/guide/clients/tabular-prediction).

**Module map** (`services/gateway/src/`):

| File | Role |
|---|---|
| `routes/sapRptRoutes.ts` | mounts `POST /:model/predict` and `POST /:model/predict-parquet`; `shapeMiddlewareErrors` first, then `createUnifiedTokenAuth()`, then `quotaEnforcement` — no hook middleware, no tool governance |
| `controllers/sapRptController.ts` | resolves the model, checks entitlement, forwards the body verbatim, folds usage, relays SAP's response |
| `sapRpt/usage.ts` | `cellsFromResponse` (cells from the response's `metadata`), `accountedModel` (the `--deep-context` id) |
| `sapRpt/errors.ts` | `rptError` — the gateway's own refusals in SAP's `{detail:[{loc,msg,type}], status:{code,message}}` shape |
| `sapRpt/shapeMiddlewareErrors.ts` | reshapes `createUnifiedTokenAuth()`'s 401 and `quotaEnforcement`'s 429 from the OpenAI `{error:{...}}` envelope into the SAP shape above, so a client of this route parses one error shape throughout |
| `utils/deployedTwin.ts` | `resolveDeployedTwin` — the bare-model / `--deployed` twin resolver this route shares with `/google` and the OpenAI Realtime route |

**Errors in the SAP shape throughout.** `createUnifiedTokenAuth()` and `quotaEnforcement` answer
401/429 in the OpenAI envelope everywhere else in the gateway; this route must not. `router.use(
shapeMiddlewareErrors)` is mounted before both, patching `res.json` for the request so a 401 from
auth or a 429 from quota is rewritten through `rptError` before it reaches the client; every other
status, including SAP's own relayed body, passes through untouched.

**The controller** (`sapRptController.ts`), for both `predict` and `predict-parquet`: resolve the
model through `resolveDeployedTwin` (substituted via `configService.getSubstitutedModel('sap-rpt',
...)` first); a `null` twin is 404 `model_not_found` in the SAP shape. Check entitlement on BOTH
the requested id and the resolved twin id (`isModelEntitled`), naming whichever fails in the 403
`model_not_entitled` message and the `model_not_entitled` security event — the same both-ids rule
`/google` and the realtime route apply when routing can move the request onto a different
catalogue entry. POST to `${twin.deploymentUrl}/predict` (or `/predict-parquet`) with
`Authorization: Bearer <AI Core token>` and `AI-Resource-Group`, `configService.getTimeout(false)`
as the timeout, and `validateStatus: () => true` so SAP's 4xx/5xx bodies reach the fold logic
instead of throwing. An unreachable upstream is 502 `upstream_unavailable`. On any response,
`RELAYED_HEADERS` (`content-type`, `ai-inference-id`, `x-request-id`, `x-upstream-service-time`)
and the body are relayed exactly as SAP sent them — string bodies via `res.send`, everything else
via `res.json`, so SAP's own JSON is never re-serialized. `predictParquet` forwards the raw
multipart request stream (`req` itself, with its `content-type`) rather than `req.body`; JSON
parsing never runs for that subpath. Body size is the gateway's global JSON limit
(`bodyParser.json({ limit: config.maxRequestSize })` in `src/index.ts`); there is no per-route
override. `config.maxRequestSize` comes from `ConfigLoader.loadConfig()` (`libs/config/index.ts`):
`'10mb'` from `loadBaseConfig()`, overridable per deploy target only by adding a `maxRequestSize`
key to `services/<service>/config/<DEPLOY_TARGET>.json` — no target's config file in this repo
does, and no environment variable reaches it, so every deployment runs at the 10 MB default.

**Usage and cost** (`sapRpt/usage.ts`). `cellsFromResponse(body)` reads only `body.metadata`
(present on a 200, absent on an error) and returns `null` if any of `num_rows`, `num_columns`,
`num_predictions` is missing or not a non-negative number: `inputCells = num_rows × num_columns`
(every cell sent, index and target columns included) and `predictCells = num_predictions` (query
rows × target columns). The controller sets `usage.unit = 'cells'` before folding these into the
existing `inputTokens`/`outputTokens` fields via `updateTokenCounts`, so the whole cost, quota and
analytics pipeline applies unchanged — `UsageEvent` gained `unit?: 'tokens' | 'cells'` (default
`'tokens'`) for exactly this. A rejected call (`cellsFromResponse` returns `null`) emits no usage
event at all, so it bills nothing. `accountedModel(model, contextMode)` records a `context_mode:
"deep"` response against `<bare model>--deep-context` — stripping a trailing `--deployed` first,
since the admin's Deep Context row is keyed on the bare id — and returns `model` unchanged for
every other call.

**Admin-side pricing** mirrors the gateway's `DEEP_CONTEXT_SUFFIX` ('`--deep-context`') with its
own copy in `services/admin/src/services/pricingTwins.ts`, kept separate from
`modelCostService.ts` on purpose: that module does `const { ... } = cds.ql` at top level, and
`sapCapacityService.ts` importing it just for this helper would drag that eager destructure into
suites that mock `@sap/cds` without a `.ql`. `pricingTwins(modelId)` returns the ids a price may be
maintained under, in lookup order (itself, then its bare model if it's a `--deep-context` id, then
each `--deployed` twin) — used identically by `modelCostService.getModelPricing` and
`sapCapacityService._lookupRate`. `deriveDeepContextRows` (`librarySnapshot.ts`) derives one
pricing-only `LibraryModels` row per snapshot row matching `/^sap-rpt-.*-large$/`, named `"<model>
(Deep Context)"`, with `deployment: null` and mirroring the parent's `absent` flag; it is excluded
from the default entitlement catalog (`modelEntitlementService.effectiveModelIds`) so it never
appears as an offerable or callable model — only as something a price can be maintained on. Usage
Analytics and the API-key billing breakdown read a `unit` per model (`ApiKeyUsage.unit` /
`AwsCredentialUsage.unit`, the `usageUnits()` function on `AdminService`) to label these rows in
cells rather than tokens.

**No hooks by design, and a test that pins it.** `sapRptRoutes.ts` never calls `getHookConfig` or
`executeBeforePlugins`/`executeAfterPlugins`, and `hooks.defaults` in `api_config.json` has no
`sap-rpt` key — unlike every chat/completion route, this one has no plugin pipeline to opt out of.
`test/sap-rpt-controller.test.ts` pins this by spying on `executeBeforePlugins` and
`executeAfterPlugins` and asserting neither is called; `test/sap-rpt-routes.test.ts` pins the
companion fact that tool governance — which has nothing to govern in a tabular request — is never
mounted on the router at all.

**Configuration.** The six models each carry a `models.overrides` entry keyed on their
`--deployed` published id (the same convention `resolveDeployedTwin` resolves against), declaring
the subpaths this route needs and no streaming:

```json
"sap-rpt-1.6--deployed": { "streamingSupported": false, "subpaths_emulated": [], "subpaths_native": ["predict", "predict-parquet"] }
```

Kept in sync across `services/gateway/api_config.json`, `services/admin/api_config.json` and
`npm-dist/sail-proxy/src/templates/api_config.template.json` by `cli-tools/sync-api-config.js`, as
every override is.

### Image generation

Gemini image models are served two ways: natively through `/google` (unchanged relay — the Google
route section above already covers `responseModalities`/`imageConfig` passing through unmodified,
and the `chooseRoute` refusal below), and through an OpenAI-shaped surface,
`POST /openai/v1/images/generations` (JSON) and `POST /openai/v1/images/edits` (multipart), also
mounted at `/openai/api/v1/images/...`.

**Usage split** (`services/gateway/src/services/googleGeminiService.ts`, `usageFromGemini`, and the
streaming last-frame fold). `promptTokensDetails`/`candidatesTokensDetails` modality `IMAGE` are
read into `imageInputTokens`/`imageOutputTokens`; `outputTokens` keeps the full
`candidatesTokenCount + thoughtsTokenCount`, so `imageOutputTokens` is a subset, not an addition. A
missing details array yields `0` for both. This is unconditional on `/google` — a text-only Gemini
call simply reports `0`.

**Orchestration refusal** (`googleController.ts`). `requestsImageOutput(req.body)` checks
`generationConfig.responseModalities` for `IMAGE` (case-insensitive). When the resolved route is
`chooseRoute`'s `image-unavailable` kind (the model has no Google deployment), the controller
answers the Gemini error envelope with HTTP 400 `INVALID_ARGUMENT` and the message `Model <model>
has no deployment; image output (responseModalities IMAGE) needs a deployment of the model on SAP AI
Core.` A model `chooseRoute` cannot route at all (`null` — typically a deployment-only image model
with no deployment, which the catalogue therefore never lists) gets the same message with HTTP 404
`NOT_FOUND` instead of the generic "not available" text. A model without the `image-generation`
capability is not second-guessed — the request goes to its deployment and SAP's own error is relayed.

**Images controller** (`controllers/imagesController.ts`, routes in `routes/imagesRoutes.ts`,
mounted with the standard chain — unified auth → `serviceConfigurations.openai` →
`quotaEnforcement`, same as `responsesRoutes.ts`/`filesRoutes.ts`). The pure mapping lives in
`controllers/imagesMapping.ts` (`mapImageRequest`, `openAiUsageFromGemini`, `sumUsages`,
`extractImages`, `assembleImagesResponse`) so it is unit-tested without Express or a live
deployment. `generateImage`/`editImage` resolve the requested model to its deployment
(`resolveDeployedTwin`), then loop `n` times (1–4) issuing one `generateContent` call per image on
that deployment (`geminiUrl`), reusing `headersForSap` and `isGoogleProvider` — both now exported
from `googleController.ts` rather than kept private to the Google route. Each call emits its own
usage event (`createUsageMetrics`/`emitUsageEvent`) against the deployment id, exactly like the
`/google` native path; a failure partway through an `n > 1` loop answers the error after the usage
events for the images already produced were emitted (SAP billed them, so the gateway does not
pretend otherwise). Uploads for `/edits` go through `extractBoundary`/`parseMultipartFields` in
`utils/multipart.ts` — `MultipartParser` and `parsePartHeaders` moved there from the files
controller (`filesController.ts` keeps importing them from the new location, so its own multipart
tests stay green with no behavior change). Three caps, all enforced WHILE the body streams so
nothing over-sized is ever buffered whole: `maxFileBytes` (20 MB) over each single `image`/`mask`
part — the part that breaks it finishes the parse with `tooLarge`/`tooLargeField` and destroys the
request; `maxBytes` (4 x 20 MB + 64 KB) over the whole body, since at most four input images are
accepted, mirroring `n`'s maximum (a fifth `image` part is a 400 on `param: image`); and
`maxTextFieldBytes`, raised from the shared default of 1 KB to 32 KB for this endpoint because
`prompt` IS the instruction — an over-budget text field is reported in `truncated` and answered
400 rather than served shortened. The files endpoint drives the parser through its own
`parseMultipartUpload` and is unaffected by all three.

**No masking on images.** The pseudonymization plugin rewrites text; it does not touch image
bytes, and neither the Images endpoints nor the `/google` image path run a prompt or an upload
through it — an `inlineData` part and an image prompt reach SAP AI Core as sent. Documented in the
user guide too (features, Gemini) so nobody infers coverage from the text path's.

**Admin side.** `ModelCosts.imageOutputCost` (per 1000 tokens, `Decimal(10,6)`, null = not
maintained) is set through the Model Library price dialog's fifth field, *Image output cost per 1K
tokens*, and the `setPrice` action's fifth parameter. The same rule — text output tokens =
`outputTokens − imageOutputTokens`; image rate = `imageOutputCost` when maintained, else the model's
output rate — is applied independently in three places: `modelCostService.calculateCosts` (USD),
`sapCapacityService.computeSapNative` (capacity units — see the Model Library and entitlements page of this section), and
`costRecalculationService.buildUpdateSQL` (Postgres and SQLite, so a rate entered later reprices
history — the Postgres reprice gate carries an image disjunct in BOTH its eligibility and its drift
clause, because an image row can hold no input and no cache tokens at all and its rate is the
manual `imageOutputCost` that neither the input nor the cache drift terms look at; the SQLite
variant has no drift clause, only the activity gate, which gained the same disjunct). A manual rate
resolves across the `--deployed` twin in both directions (`modelCostService.getModelPricing` tries
the id, then `<id>--deployed`, then — for a `--deployed` id — the bare model), since usage is
accounted against the deployment id while the price may have been entered on the bare entry. The
dev SQLite database needs the hand-applied migration for the new columns on `ApiKeyUsage`,
`AwsCredentialUsage` and `ModelCosts` — `cds deploy --to sqlite` alone recreates the file empty; the
DDL delta is in [docs/developer/sqlite-migrations/image-output-sqlite-migration.sql](https://github.com/st-gr/sail-proxy/blob/main/docs/developer/sqlite-migrations/image-output-sqlite-migration.sql).

**Tests**: `test/images-mapping.test.ts` (every `size`/`quality` mapping, `n` range, every refused
parameter, edits' part order, usage summing), `test/images-routes.test.ts` (the routes through the
real router against a fake deployment server), `test/multipart-fields.test.ts` (the shared module
leaves the files endpoint green), `test/google-usage-split.test.ts` (details present/absent,
text-only, streaming); admin: `test/unit/services/model-cost-image-output.test.ts`,
`test/unit/sap-capacity-service.test.ts`, `test/unit/services/cost-recalculation-sqlite.test.ts`,
`test/integration/http/model-library-odata.test.ts`,
`app/model-library-app/test/costDisplay.test.ts`, `test/unit/usage-analytics-sap-native.test.ts`.

### OpenAI Realtime route

`/openai/v1/realtime` and `/v1/realtime` (GET + WebSocket upgrade) relay the OpenAI Realtime API to
SAP AI Core's `gpt-realtime` deployment. A WebSocket upgrade never enters Express, so the route is a
handler on the HTTP server's `upgrade` event (`attachRealtimeUpgrade(server)` in `src/index.ts`,
right after `app.listen`).

**Module map** (`services/gateway/src/`):

| File | Role |
|---|---|
| `realtime/realtimeUpgrade.ts` | path match, admission chain, twin resolution, entitlement, upstream connect, client handshake, observer wiring; `RealtimeDeps` for tests |
| `realtime/admission.ts` | `prepareUpgradeRequest` (what the Express middlewares read), the recording response shim, `runMiddleware`, `writeRefusal` (a recorded refusal as one raw HTTP/1.1 response) |
| `realtime/relay.ts` | frames forwarded unchanged both ways; observer hook after forwarding; close propagation |
| `realtime/realtimeObserver.ts` | pure: `classifyFrame`, `usageMetricsFromResponseDone` |
| `realtime/closeCodes.ts` | pure: close codes/reasons, `propagatedClose` (1005 → 1000, 1006 → 1011) |
| `utils/deployedTwin.ts` | `resolveDeployedTwin` — the bare-model / `--deployed` twin resolver shared with `/google` |

**Admission (everything before the 101).** Unified auth → service auth (`serviceConfigurations.openai`)
→ entitlement on both the requested id and the resolved twin (`model_not_entitled` security event
as on `/google`) → `quotaEnforcement` (the connect counts as one request). The middlewares are the
route's own, unchanged: `runMiddleware` hands them the upgrade `IncomingMessage` extended with
`originalUrl`, `path`, `query`, `get()`, `ip`, `debugRequestId`, and a response shim that records
`status/set/setHeader/json/send/end`; `next()` means admitted, a recorded response is written to the
raw socket as HTTP/1.1 (status line, headers incl. `Retry-After`/`X-RateLimit-*`, the JSON body) and
the socket ended. Only when the upstream socket is open is the client handshake completed
(`WebSocketServer({ noServer: true }).handleUpgrade`), so an upstream refusal is a plain HTTP
answer too (502/503; the AI Core token fetch and the upstream WebSocket handshake are each bounded
by 15 s). Node emits `upgrade` for any request carrying `Connection: Upgrade`, so a request that is
not an RFC 6455 handshake (not `GET`, `Upgrade` other than `websocket`, no `Sec-WebSocket-Key`,
`Sec-WebSocket-Version` other than `13`) is refused 400 `bad_request` right after the path match —
before auth, and before a billable upstream session is opened.

**Upstream.** `<deploymentUrl>/v1/realtime` with `Authorization: Bearer <AI Core token>`
(`modelService.getAuthToken`, cached) and `AI-Resource-Group`; the `deploymentUrl` of a realtime
deployment is already `wss://…` on SAP's dedicated realtime host — the generic inference host
refuses upgrades. A resolved URL that is not `wss://` is refused 502.

**Metering.** The observer parses upstream text frames only: `response.created` counts one request
(auth + quota run again through the shim; a refusal sends the client
`{"type":"error","error":{"type":"quota_exceeded",…}}`, `response.cancel` upstream, and closes both
sides 1008 `quota_exceeded` — or 1008 `unauthorized`); `response.done` emits one
`emitUsageEvent(req, metrics, '<twin id>', 200)` with `inputTokens = input_tokens − cached_tokens`
(the full-rate share, matching `noteExtraUsage` on the chat routes — before 2026-09-15 the relay
emitted the inclusive figure and cached tokens were priced twice), `cacheReadInputTokens =
cached_tokens`, `audioInputTokens = audio_tokens − cached_tokens_details.audio_tokens` clamped to
`[0, inputTokens]`, and `audioOutputTokens = output_token_details.audio_tokens` clamped to
`[0, outputTokens]` — cached audio counts as cached; `error` is logged. Frames are never delayed
by the observer. Each response gets its own request id (`<connection id>-<response id>`), because
the admin's usage idempotency signature begins with the request id and would otherwise drop the
second of two identical-looking responses.

**Backpressure.** A peer that stops reading would let the gateway buffer a whole session's audio:
once a destination socket's `bufferedAmount` passes `RELAY_HIGH_WATER_BYTES` (8 MiB) the relay
pauses the *source* socket, and resumes it from the `send` callback once the destination is back at
or below `RELAY_LOW_WATER_BYTES` (1 MiB). Frames are never dropped or reordered — they wait in the
source's receive buffer — and each direction keeps its own paused flag (`onBackpressure(side,
paused)` is logged at `info`).

**Shutdown.** `attachRealtimeUpgrade` returns a handle whose `closeAll(code, reason)` closes every
tracked client socket (the relay's close propagation then ends each upstream). `gracefulShutdown`
calls it with 1001 `server_shutdown` before the Valkey clients are disconnected — a session must
not outlive its quota store — and before `server.close()`, which would otherwise never call back
while an upgraded socket keeps the server alive.

**Ingress.** Docker nginx: an `http`-level `map $http_upgrade $connection_upgrade` and
`location ~ ^/gateway/(openai/)?v1/realtime$` ahead of `location /gateway/` (same `auth_request`,
`proxy_http_version 1.1`, `Upgrade`/`Connection` forwarded, 3600 s timeouts). Kyma: the nginx pod
runs the same `sail-proxy-nginx` image in `CONFIG_MODE=template`, so it renders the same Docker
template and needs no manifest change; the `gw.conf` generator in `kyma/scripts/setup-kyma.js` (the
entrypoint's `configmap` mode) carries the same `map` and location in both auth modes. The APIRule
sends `/*` to nginx unchanged. Standalone (npm-dist): the gateway listens directly.

**Tests** (`services/gateway/test/realtime/`): pure suites for the observer and close codes; the
admission shim and refusal writer; the relay over real loopback sockets; and
`realtime-upgrade.test.ts`, which runs the handler against a fake upstream `ws` server with auth,
quota and the catalogue injected through `RealtimeDeps` — 101 and a relayed turn, binary
pass-through, one usage event per `response.done`, the 1008 quota close with `response.cancel`,
HTTP refusals 401/403/429/404/502, upstream 503/502, 1011 on abnormal upstream closure, client
close → upstream 1000, the 400 `bad_request` refusals of non-handshake upgrades, per-response
request ids, a `response.done` arriving after the client closed, and `closeAll`. The relay suite
also drives the high/low-water pause and resume over real sockets. `realtime-wiring.test.ts` pins
the `index.ts` attachment and the `closeAll` call in `gracefulShutdown`.

## Streaming Implementation

### Server-Sent Events (SSE) Handling

**Streaming Response Manager**: there is no separate streaming class; each controller streams its own protocol with shared helpers.

- `sapAIService.streamChatCompletion` posts the orchestration request with `config.stream.enabled` and hands each parsed SSE chunk to the controller's `onChunk` callback; an `AbortController` cancels the upstream call when the client disconnects.
- `utils/streamStart.ts` defers the stream start: `deferStreamStart` holds the status line and the protocol preamble (Anthropic's `message_start`, OpenAI's role chunk) until the upstream delivers substantive content (`isSubstantiveChunk`) or `STREAM_START_DEADLINE_MS` (10 s) passes. An upstream failure that arrives first is answered with its real HTTP status and a JSON error body (`failureFromChunk`, `failureFromError`) instead of an in-stream error under a 200. After the start, keepalives follow every `STREAM_KEEPALIVE_INTERVAL_MS` (5 s).
- `utils/sseWriter.ts` writes the frames: `writeChunk`, `writeEventStream` (named events for Anthropic), `writeDone` (`data: [DONE]`), `writeError`, `writePing`.
- The after-plugins run per chunk (the stream strategy), so the pseudonymization plugin can unmask placeholders before a frame reaches the client.
- Usage is taken from the final chunk and emitted once the stream ends.

### Streaming Emulation

**Pseudo-Streaming for Batch Models**: a model listed in a provider's `emulate_streaming_for_models` (exact name, or the name without its `<provider>--` prefix; `configService.shouldEmulateStreaming`) is called without streaming, and the controller replays the full answer as a stream. On the OpenAI routes `emulateOpenAIStreamFromFullResponse` sends the role chunk, then the content split by `chunkText` (about 15 characters per chunk), then one chunk per tool call (index, id, name, whole arguments), then the finish chunk and `data: [DONE]`. A `--deployed` model on `/openai/v1/chat/completions` streams for real when the client asks for a stream: the deployment is called with `stream: true` and `include_usage`, and `controllers/deployedStreamRelay.ts` relays its chunks, each through the after-plugins (per-chunk unmasking), bills from the usage frame and forwards that frame only on `stream_options.include_usage`. A one-piece answer (a deployment that answers JSON, or the `/responses` fallback when a deployment refuses function tools on chat) is replayed as above. The Bedrock route emulates the subpaths a model does not serve natively (see above).

## Configuration Management

### Dynamic Configuration Loading

**Configuration Service** (`services/gateway/src/services/configService.ts`):

- **Admin-managed** (Docker, Kyma): the gateway subscribes to the Valkey channel `sap-llm-gateway:config-changed` (`CONFIG_CHANGE_CHANNEL`) and requests its initial configuration from the admin service; without Valkey it fetches it over HTTP (`fetchConfigurationFromAdmin`, retried `CONFIG_FETCH_RETRIES` times with backoff). Activating or rolling back a configuration in the cockpit publishes a change event, and the gateway reloads (`handleConfigChangeEvent`, `triggerConfigurationReload`), including the plugins.
- **Standalone**: the configuration is read from `CONFIG_FILE_PATH` (default `api_config.json` in the working directory); when the file does not exist, the minimal default configuration is written there.
- **Access**: `getConfig()` returns the cached configuration; the typed accessors (`getSubstitutedModel`, `shouldEmulateStreaming`, `getUnsupportedParams`, `getHookConfig`, `getFileSearchConfig`, …) read from it.

Every configuration key is described in the [Gateway configuration reference](/reference/configuration).

### Model Mapping Configuration

Model renames are `substitute_models` lists per provider, matched exactly; the rules are under *Model renames* below. Per-model settings (streaming support, native and emulated subpaths, capabilities) live in `models.overrides`, keyed on the model id.

### Provider configuration keys

`api_config.providers` holds per-provider settings, keyed by the provider's **wire name** as it
appears in the route — so `aws-bedrock` keeps its hyphen. Two things about that map are worth
knowing when editing it:

**Which keys the gateway actually reads.** Six providers are wired into request handling today:
`anthropic`, `aws-bedrock`, `google`, `openai`, `openrouter`, and `perplexity` (`PROVIDER_KEYS` in
`services/configService.ts`). `google` is the newest and the narrowest: it carries **only**
`substitute_models`, read by `getSubstitutedModel('google', …)` on the `/google` route, and its
schema block is composed WITHOUT `providerCommon` — it names that one field through a targeted `$ref`
and is closed with a plain `additionalProperties: false`, so the other common settings are rejected
rather than merely inert. Any **other** provider
key is still accepted and schema-validated against the shared `providerCommon` shape, so no schema
change is needed to stage a new provider — but its settings stay **inert** until the gateway itself
learns to route that provider.

**Each named provider has a closed key set.** The six named providers each carry exactly the
settings their own request path reads. Five are enforced by a `propertyNames` enum per provider
(their fields arrive through an `allOf` on `providerCommon`, which an `additionalProperties: false`
could not see); `google`, which composes nothing, uses `additionalProperties: false` directly:

- the **shared** settings (`substitute_models`, `unsupported_params`, `param_renames`,
  `emulate_streaming_for_models`, `supports_prompt_caching`, `supports_responses_api`, …);
- the **Anthropic wire version and beta-flag filters** (`anthropic_bedrock_version`,
  `supported_beta_headers`, `excluded_beta_headers`) — only on `anthropic` and `aws-bedrock`;
- their **own extension** (`openai_deployment_api_version`; `default_pricing`, `model_mappings`) —
  only on `openai` and `openrouter` respectively.

A setting written under a provider whose code never reads it is **rejected** at validation, rather
than silently kept as a value that does nothing. `perplexity` carries only the shared set, and
`google` only `substitute_models`.

**Model renames (`substitute_models`).** `configService.getSubstitutedModel(provider, model)` is the
one matcher: an exact, case-sensitive match on `from`, the first entry wins, one pass (a `to` is never
renamed again). Each route reads its own provider's list — `anthropic` (messages, count tokens,
the Anthropic response path), `aws-bedrock`, `google`, `openrouter` on its chat completions
route, and `sap-rpt` on the `/sap/v1/rpt/:model/predict` and `predict-parquet` routes (`sapRptController.ts`). On `/openai/v1/chat/completions` and `/openai/v1/responses` (and their `/openai/api/v1/`
forms) the `substituteOpenAICompatibleModel` middleware (`middlewares/modelSubstitution.ts`) sits
directly in front of the controller and consults the `openai` list, then `perplexity`; the first list
that renames wins, because a client's model name carries no provider. Embeddings, images and the model
list are not renamed. Everything after the rename — streaming emulation, the entitlement guard,
routing, hooks, the response's and every stream chunk's `model`, and the usage event — sees the
forwarded name; no provider maps it back to the name the client sent. The shipped and fallback
configurations carry empty `openai` lists: the old samples (`GPT-4` → `o1`, `GPT-3.5` → `GPT-4`) were
never applied while the openai routes ignored the list. Tests: `test/openai-model-substitution-*.test.ts`.

## Security Implementation

### Cryptographic Key Management

**Key Generation and Usage**: the three 256-bit keys are generated at setup (`docker/setup-docker.js`, or by hand as in [Development setup](/developer/setup)) and passed as environment variables; the services do not generate them.

| Key | Used by | Purpose |
|-----|---------|---------|
| `VALIDATION_TOKEN_SECRET` | gateway and admin (`libs/aws-token-validation/validation-token.ts`) | HMAC-SHA256 signature of the validation tokens (JWT format) the two services exchange; must be equal on both sides |
| `METADATA_ENCRYPTION_KEY` | gateway and admin (`libs/aws-token-validation/secure-metadata-exchange.ts`) | AES-256-CBC encryption of exchanged metadata with a PBKDF2-derived key and an HMAC-SHA256 tag |
| `AWS_SECRET_ENCRYPTION_KEY` | admin (`services/admin/src/utils/awsSecretCrypto.ts`) | AES-256-CBC encryption of stored AWS secret keys, key derived with scrypt; the admin warns at startup when the key is unset or publicly known |

The variables are described in [Environment variables](/reference/environment-variables).

## Usage Tracking and Analytics

### Comprehensive Usage Logging

**Usage Tracking Service**: each controller creates a `UsageMetrics` object (`createUsageMetrics` in `utils/usageTracker.ts`), fills the token counts from the upstream usage (`updateTokenCounts`), and calls `emitUsageEvent(req, metrics, model, statusCode)` when the response is finished. In standalone mode `emitUsageEvent` returns without recording anything; otherwise it attaches the credential (`extractAuthInfo`), the request id and the timing, and hands the event to `services/usageEventEmitter.ts`, which publishes it on the Valkey channel `usage-events`; when Valkey is unavailable it keeps the events in a memory queue. The admin service's `usageEventProcessor` subscribes to the channel, deduplicates, calculates the cost and writes the usage rows.

`UsageMetrics`/`UsageEvent` (`services/gateway/src/types/usage.ts`) carry an optional
`imageOutputTokens`, set by the Google route and the images controller (section above) for any call
that returned image output, and left unset by every other route. It is a modality split of
`outputTokens`, never an addition to it, so a client counting total output tokens sees no change —
only a consumer that cares which tokens were image versus text needs the new field.
`audioInputTokens`/`audioOutputTokens` follow the same rule — subsets of `inputTokens`/
`outputTokens`, set only by the realtime relay.

### Token Counting and Cost Calculation

**Token Counter Service**: tokens are counted by SAP AI Core and taken from its usage. The gateway counts tokens itself only for Anthropic's `POST /anthropic/v1/messages/count_tokens` (`controllers/countTokensController.ts`): `services/tokenCountService.ts` (`getTokenCount`) tokenizes the translated request locally with `gpt-tokenizer`, preloading the `cl100k_base` and `o200k_base` encodings at startup. Costs are calculated in the admin service from the Model Library prices.
