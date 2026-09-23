---
title: SAIL-PROXY Developer Guide - Chapter 3
author: st-gr
date: 2025-01-28
mainfont: Helvetica, Arial, sans-serif
fontsize: 18px
---

# SAIL-PROXY Developer Guide
*Multi-provider AI Gateway for SAP AI Core - Developer Documentation*
**Author:** *st-gr*

[<< Previous Chapter](chapter-2-architecture.md) | [Content Table](README.md) | [Next Chapter >>](chapter-4-gateway-testing.md)

---

## Gateway Service

The Gateway service is the core component of SAIL-PROXY, responsible for API translation, authentication, request routing, and response processing. This chapter provides deep technical details on the Gateway implementation, configuration, and security features.

### Core Implementation

#### Entry Point and Server Setup

**Main Server** (`services/gateway/src/index.ts`):
```typescript
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { authenticationMiddleware } from './middleware/auth.js';
import { rateLimitMiddleware } from './middleware/rateLimit.js';
import { loggingMiddleware } from './middleware/logging.js';

const app = express();

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true
}));

// Core middleware stack
app.use(express.json({ limit: '10mb' }));
app.use(loggingMiddleware);
app.use(authenticationMiddleware);
app.use(rateLimitMiddleware);

// API route handlers
app.use('/openai', openAIRoutes);
app.use('/anthropic', anthropicRoutes);
app.use('/aws-bedrock', bedrockRoutes);
app.use('/openrouter', openRouterRoutes);
app.use('/v1', unifiedRoutes);

const server = app.listen(process.env.PORT || 3000);
```

#### Request Processing Pipeline

**Middleware Stack Architecture**:
```typescript
interface MiddlewareContext {
  correlationId: string;
  user: AuthenticatedUser;
  apiKey: APIKey;
  permissions: Permission[];
  rateLimitInfo: RateLimitInfo;
  startTime: number;
}

// Logging middleware - tracks all requests
const loggingMiddleware = (req: Request, res: Response, next: NextFunction) => {
  req.correlationId = req.headers['x-correlation-id'] || crypto.randomUUID();
  req.startTime = Date.now();
  
  logger.info('Request received', {
    correlationId: req.correlationId,
    method: req.method,
    path: req.path,
    userAgent: req.headers['user-agent'],
    ip: req.ip
  });
  
  next();
};
```

On every LLM-serving route (chat completions, messages, responses, embeddings, AWS Bedrock,
vector stores) the actual per-route middleware order is: validation (unified token or SigV4 auth,
which resolves the caller and attaches its `user` and `entitlement` blocks) → `quotaEnforcement` →
the route's controller, where model substitution (`substitute_models`) resolves the requested model
before the entitlement guard (`enforceEntitlement`) checks it → the upstream call to SAP AI Core.

#### Quota enforcement

`services/gateway/src/middlewares/quotaEnforcement.ts` runs right after validation on every
LLM-serving route (spec §2). It reads the `user` block validation attaches beside `entitlement`
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

### Authentication System

#### Token Validation and User Resolution

**Authentication Middleware** (`services/gateway/src/middleware/auth.ts`):
```typescript
interface AuthenticationResult {
  user: User;
  apiKey: APIKey;
  permissions: Permission[];
}

class AuthenticationService {
  async validateBearerToken(token: string): Promise<AuthenticationResult> {
    // Check token format
    if (!token.startsWith('sp-proj-')) {
      throw new AuthenticationError('Invalid token format');
    }
    
    // Query database for API key
    const apiKey = await this.apiKeyRepository.findByToken(token);
    if (!apiKey || apiKey.status !== 'active') {
      throw new AuthenticationError('Invalid or revoked API key');
    }
    
    // Check expiration
    if (apiKey.expiresAt && new Date() > apiKey.expiresAt) {
      throw new AuthenticationError('API key expired');
    }
    
    // Load user and permissions
    const user = await this.userRepository.findById(apiKey.userId);
    const permissions = await this.permissionService.getUserPermissions(user.id);
    
    return { user, apiKey, permissions };
  }
  
  async validateAWSSignature(req: Request): Promise<AuthenticationResult> {
    const signature = new AWSSignatureV4();
    const isValid = await signature.verify(req);
    
    if (!isValid) {
      throw new AuthenticationError('Invalid AWS signature');
    }
    
    // Extract AWS credentials and validate
    const awsCredentials = await this.awsCredentialRepository.findByAccessKey(
      signature.accessKeyId
    );
    
    return this.resolveAWSUser(awsCredentials);
  }
}
```

#### API Key Security Features

**Rate Limiting Implementation**:
```typescript
class RateLimitService {
  private redis: Redis;
  private algorithms = {
    'sliding-window': this.slidingWindowLimit.bind(this),
    'token-bucket': this.tokenBucketLimit.bind(this),
    'fixed-window': this.fixedWindowLimit.bind(this),
  };
  
  async checkRateLimit(apiKey: APIKey, endpoint: string): Promise<RateLimitResult> {
    const limits = this.parseRateLimits(apiKey.rateLimits);
    const algorithm = apiKey.rateLimitAlgorithm || 'sliding-window';
    
    for (const limit of limits) {
      const result = await this.algorithms[algorithm](apiKey.id, limit, endpoint);
      if (!result.allowed) {
        return {
          allowed: false,
          resetTime: result.resetTime,
          remaining: 0,
          limit: limit.requests
        };
      }
    }
    
    return { allowed: true, remaining: limits[0].requests, limit: limits[0].requests };
  }
  
  private async slidingWindowLimit(keyId: string, limit: RateLimit, endpoint: string): Promise<any> {
    const key = `rate_limit:${keyId}:${endpoint}:${limit.window}`;
    const now = Date.now();
    const windowStart = now - (limit.windowMs);
    
    // Remove expired entries and count current requests
    await this.redis.zremrangebyscore(key, '-inf', windowStart);
    const currentRequests = await this.redis.zcard(key);
    
    if (currentRequests >= limit.requests) {
      const oldestRequest = await this.redis.zrange(key, 0, 0, 'WITHSCORES');
      const resetTime = oldestRequest[1] + limit.windowMs;
      return { allowed: false, resetTime };
    }
    
    // Add current request
    await this.redis.zadd(key, now, `${now}-${crypto.randomUUID()}`);
    await this.redis.expire(key, Math.ceil(limit.windowMs / 1000));
    
    return { allowed: true };
  }
}
```

### API Translation Layer

#### OpenAI API Implementation

**OpenAI Route Handler** (`services/gateway/src/routes/openai.ts`):
```typescript
class OpenAITranslator {
  async translateChatCompletion(request: OpenAIRequest): Promise<SAPRequest> {
    const { model, messages, stream, tools, ...otherParams } = request;
    
    // Model substitution
    const sapModel = this.modelMappings[model] || model;
    
    // Message format translation
    const translatedMessages = messages.map(msg => ({
      role: this.translateRole(msg.role),
      content: this.translateContent(msg.content)
    }));
    
    // SAP AI Core orchestration request
    return {
      orchestration_config: {
        model_name: sapModel,
        model_params: {
          max_tokens: otherParams.max_tokens,
          temperature: otherParams.temperature,
          top_p: otherParams.top_p,
        },
        template_id: 'chat-completion'
      },
      input_params: {
        messages: translatedMessages,
        tools: tools ? this.translateTools(tools) : undefined
      }
    };
  }
  
  async translateResponse(sapResponse: SAPResponse, originalRequest: OpenAIRequest): Promise<OpenAIResponse> {
    const { choices, usage } = sapResponse;
    
    return {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: originalRequest.model,
      choices: choices.map(choice => ({
        index: choice.index,
        message: {
          role: 'assistant',
          content: choice.message.content,
          tool_calls: choice.message.tool_calls ? 
            this.translateToolCalls(choice.message.tool_calls) : undefined
        },
        finish_reason: this.translateFinishReason(choice.finish_reason)
      })),
      usage: {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens
      }
    };
  }
}

// Route implementation
router.post('/v1/chat/completions', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const translator = new OpenAITranslator();
    const sapRequest = await translator.translateChatCompletion(req.body);
    
    if (req.body.stream) {
      return await handleStreamingResponse(req, res, sapRequest);
    } else {
      return await handleBatchResponse(req, res, sapRequest);
    }
  } catch (error) {
    return handleAPIError(res, error);
  }
});
```

#### The model list

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

#### Anthropic API Implementation

**Anthropic Route Handler** (`services/gateway/src/routes/anthropic.ts`):
```typescript
class AnthropicTranslator {
  async translateMessages(request: AnthropicRequest): Promise<SAPRequest> {
    const { model, messages, max_tokens, tools, ...otherParams } = request;
    
    // Anthropic-specific message handling
    const processedMessages = this.processAnthropicMessages(messages);
    
    return {
      orchestration_config: {
        model_name: this.modelMappings[model] || model,
        model_params: {
          max_tokens,
          temperature: otherParams.temperature,
          top_p: otherParams.top_p,
          stop_sequences: otherParams.stop_sequences,
        }
      },
      input_params: {
        messages: processedMessages,
        tools: tools ? this.translateAnthropicTools(tools) : undefined,
        system: otherParams.system
      }
    };
  }
  
  private processAnthropicMessages(messages: AnthropicMessage[]): SAPMessage[] {
    // Handle Anthropic's unique message format
    return messages.map(msg => {
      if (Array.isArray(msg.content)) {
        // Multi-modal content (text + images)
        return {
          role: msg.role,
          content: msg.content.map(item => {
            if (item.type === 'image') {
              return {
                type: 'image_url',
                image_url: {
                  url: `data:${item.source.media_type};base64,${item.source.data}`
                }
              };
            }
            return item;
          })
        };
      }
      return msg;
    });
  }
}
```

#### AWS Bedrock Implementation

**Bedrock Route Handler** (`services/gateway/src/routes/bedrock.ts`):
```typescript
class BedrockTranslator {
  async translateInvokeRequest(request: BedrockInvokeRequest): Promise<SAPRequest> {
    const { modelId, body } = request;
    const parsedBody = JSON.parse(body);
    
    // Model-specific translation based on provider
    if (modelId.includes('anthropic')) {
      return this.translateAnthropicBedrock(parsedBody, modelId);
    } else if (modelId.includes('amazon')) {
      return this.translateTitanBedrock(parsedBody, modelId);
    } else if (modelId.includes('ai21')) {
      return this.translateJurassicBedrock(parsedBody, modelId);
    }
    
    throw new Error(`Unsupported Bedrock model: ${modelId}`);
  }
  
  private async translateAnthropicBedrock(body: any, modelId: string): Promise<SAPRequest> {
    // Anthropic Claude via Bedrock has specific format requirements
    return {
      orchestration_config: {
        model_name: this.mapBedrockModel(modelId),
        model_params: {
          max_tokens: body.max_tokens_to_sample || body.max_tokens,
          temperature: body.temperature,
          top_p: body.top_p,
          stop_sequences: body.stop_sequences,
        }
      },
      input_params: {
        prompt: body.prompt,
        messages: body.messages
      }
    };
  }
}

// AWS Signature V4 validation
router.use('/model/:modelId/*', async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  
  if (authHeader?.startsWith('AWS4-HMAC-SHA256')) {
    // Validate AWS SigV4 signature
    const signatureValidator = new AWSSignatureV4Validator();
    const isValid = await signatureValidator.validate(req);
    
    if (!isValid) {
      return res.status(403).json({ error: 'Invalid AWS signature' });
    }
    
    // Resolve AWS credentials to internal user
    req.awsCredentials = await resolveAWSCredentials(req);
  }
  
  next();
});
```

**The real middleware chain** (`services/gateway/src/routes/awsBedrockRoutes.ts`):
`conditionalUnifiedAuth` (unified token auth, skipped when SigV4 already authenticated the request) →
`bedrockServiceAuth` → `toolGovernance(bedrockAdapter)` → `quotaEnforcement` →
`awsBedrockController.handleBedrockRequest`. Tool governance now sits between service authentication
and quota enforcement — the same position the other REST families use; see
[tool-governance.md](tool-governance.md#middleware-mount-points) for the adapter itself (shape
detection, the Converse/Anthropic-invoke split, the `stripRefusal`/`rejectionHeaders` additions, and
the stream tap that records tools from Bedrock's own passthrough stream).

#### Google Gemini route

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

**SAP subpath facts** (probed live against SAP AI Core; memory `sap-ai-core-subpath-allowlist`).
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
  chapter's limits list, not approximated). `temperature`/`top_p` then go through
  `utils/samplingSupport.ts` (`dropUnsupportedSampling`): SAP refuses the pair for `anthropic--*`
  ("`temperature` and `top_p` cannot both be specified") and, for the gpt-5..9/o-series family,
  `top_p` outright plus any temperature other than 1 — the refused key is deleted so Gemini CLI's
  defaults (temperature 0, topP 1) do not turn into an in-stream 400 the CLI reports as "Model
  stream ended without a finish reason". Measured live 2026-09-08; Gemini, Mistral and gpt-4.x
  accept both.

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

#### SAP-RPT tabular prediction route

`/sap/v1/rpt` relays SAP's relational pretrained transformer (RPT) models — a tabular contract
(rows in, predictions out), not a chat contract. The route is a pass-through: the gateway adds
authentication, entitlement, quota, deployment resolution, usage and cost, and re-validates nothing
SAP validates itself. It runs **no hook chain** — masking of tabular cells was judged feasible and
deliberately declined (spec §2) — and has no streaming and no tool governance, so nothing else in
this chapter's middleware stack applies to it. The measured request/response/error shapes this
route relays live in `docs/superpowers/specs/2026-09-22-sap-rpt-tabular-route-design.md` §3; this
section covers only the gateway side.

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

#### Image generation

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
user chapters too (features, Gemini) so nobody infers coverage from the text path's.

**Admin side.** `ModelCosts.imageOutputCost` (per 1000 tokens, `Decimal(10,6)`, null = not
maintained) is set through the Model Library price dialog's fifth field, *Image output cost per 1K
tokens*, and the `setPrice` action's fifth parameter. The same rule — text output tokens =
`outputTokens − imageOutputTokens`; image rate = `imageOutputCost` when maintained, else the model's
output rate — is applied independently in three places: `modelCostService.calculateCosts` (USD),
`sapCapacityService.computeSapNative` (capacity units — see
[model-library-entitlements.md](model-library-entitlements.md)), and
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
DDL delta is parked at [docs/developer/sqlite-migrations/image-output-sqlite-migration.sql](sqlite-migrations/image-output-sqlite-migration.sql).

**Tests**: `test/images-mapping.test.ts` (every `size`/`quality` mapping, `n` range, every refused
parameter, edits' part order, usage summing), `test/images-routes.test.ts` (the routes through the
real router against a fake deployment server), `test/multipart-fields.test.ts` (the shared module
leaves the files endpoint green), `test/google-usage-split.test.ts` (details present/absent,
text-only, streaming); admin: `test/unit/services/model-cost-image-output.test.ts`,
`test/unit/sap-capacity-service.test.ts`, `test/unit/services/cost-recalculation-sqlite.test.ts`,
`test/integration/http/model-library-odata.test.ts`,
`app/model-library-app/test/costDisplay.test.ts`, `test/unit/usage-analytics-sap-native.test.ts`.

#### OpenAI Realtime route

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

### Streaming Implementation

#### Server-Sent Events (SSE) Handling

**Streaming Response Manager**:
```typescript
class StreamingManager {
  async handleStreamingResponse(
    req: AuthenticatedRequest, 
    res: Response, 
    sapRequest: SAPRequest
  ): Promise<void> {
    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control'
    });
    
    const sapStream = await this.sapAICore.createStream(sapRequest);
    const translator = this.getTranslator(req.path);
    
    let buffer = '';
    let tokenCount = 0;
    
    sapStream.on('data', async (chunk: Buffer) => {
      try {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = JSON.parse(line.slice(6));
            const translatedChunk = await translator.translateStreamChunk(data);
            
            res.write(`data: ${JSON.stringify(translatedChunk)}\n\n`);
            tokenCount += this.countTokens(translatedChunk);
          }
        }
      } catch (error) {
        logger.error('Stream processing error', { error: error.message });
        res.write(`data: ${JSON.stringify({ error: 'Stream processing failed' })}\n\n`);
      }
    });
    
    sapStream.on('end', () => {
      res.write('data: [DONE]\n\n');
      res.end();
      
      // Log usage after stream completion
      this.usageTracker.logUsage({
        userId: req.user.id,
        apiKeyId: req.apiKey.id,
        model: sapRequest.orchestration_config.model_name,
        tokensUsed: tokenCount,
        endpoint: req.path
      });
    });
    
    sapStream.on('error', (error) => {
      logger.error('SAP AI Core stream error', { error: error.message });
      res.write(`data: ${JSON.stringify({ error: 'Internal server error' })}\n\n`);
      res.end();
    });
  }
}
```

#### Streaming Emulation

**Pseudo-Streaming for Batch Models**:
```typescript
class StreamingEmulator {
  async emulateStreaming(
    response: APIResponse, 
    res: Response, 
    chunkDelay: number = 50
  ): Promise<void> {
    const content = response.choices[0].message.content;
    const words = content.split(' ');
    
    let accumulatedContent = '';
    
    for (let i = 0; i < words.length; i++) {
      accumulatedContent += (i > 0 ? ' ' : '') + words[i];
      
      const chunk = {
        id: response.id,
        object: 'chat.completion.chunk',
        created: response.created,
        model: response.model,
        choices: [{
          index: 0,
          delta: {
            role: i === 0 ? 'assistant' : undefined,
            content: (i > 0 ? ' ' : '') + words[i]
          },
          finish_reason: i === words.length - 1 ? 'stop' : null
        }]
      };
      
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      
      if (i < words.length - 1) {
        await new Promise(resolve => setTimeout(resolve, chunkDelay));
      }
    }
    
    res.write('data: [DONE]\n\n');
    res.end();
  }
}
```

### Configuration Management

#### Dynamic Configuration Loading

**Configuration Service** (`services/gateway/src/config/ConfigService.ts`):
```typescript
interface GatewayConfiguration {
  modelMappings: Record<string, string>;
  rateLimits: RateLimitConfig;
  streamingEmulation: Record<string, boolean>;
  pluginConfig: PluginConfiguration;
  cacheConfig: CacheConfiguration;
}

class ConfigurationManager {
  private config: GatewayConfiguration;
  private watchers: Map<string, fs.FSWatcher> = new Map();
  
  constructor() {
    this.loadConfiguration();
    this.setupConfigWatchers();
  }
  
  private loadConfiguration(): void {
    // Cascade: base -> environment -> service -> runtime
    const baseConfig = this.loadBaseConfig();
    const envConfig = this.loadEnvironmentConfig();
    const serviceConfig = this.loadServiceConfig();
    const runtimeConfig = this.loadRuntimeConfig();
    
    this.config = deepMerge(baseConfig, envConfig, serviceConfig, runtimeConfig);
  }
  
  private setupConfigWatchers(): void {
    // Watch for configuration file changes
    const configPath = path.join(process.cwd(), 'config/api_config.json');
    
    this.watchers.set('api_config', fs.watch(configPath, (eventType) => {
      if (eventType === 'change') {
        logger.info('Configuration file changed, reloading...');
        this.loadConfiguration();
        this.emit('configurationChanged', this.config);
      }
    }));
  }
  
  async updateConfiguration(updates: Partial<GatewayConfiguration>): Promise<void> {
    // Admin API can trigger real-time config updates
    this.config = deepMerge(this.config, updates);
    
    // Persist to database/file
    await this.persistConfiguration(updates);
    
    // Notify all components of config change
    this.emit('configurationChanged', this.config);
  }
}
```

#### Model Mapping Configuration

**Model Substitution Engine**:
```typescript
class ModelMappingService {
  private mappings: Map<string, ModelMapping>;
  
  resolveModel(requestedModel: string, provider: string): ModelMapping {
    // Check exact match first
    if (this.mappings.has(requestedModel)) {
      return this.mappings.get(requestedModel);
    }
    
    // Check pattern matches
    for (const [pattern, mapping] of this.mappings) {
      if (this.matchesPattern(requestedModel, pattern)) {
        return { ...mapping, resolvedName: this.applyPattern(requestedModel, pattern, mapping.targetModel) };
      }
    }
    
    // Fallback to provider defaults
    return this.getProviderDefault(provider);
  }
  
  private matchesPattern(model: string, pattern: string): boolean {
    // Support glob-like patterns: gpt-4* -> gpt-4o, gpt-4-turbo, etc.
    const regex = new RegExp(pattern.replace('*', '.*'));
    return regex.test(model);
  }
}
```

#### Provider configuration keys

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
learns to route that provider. (Traceability of every key to its read site is kept in the maintainer's local notes,
outside the repository.)

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

### Security Implementation

#### Cryptographic Key Management

**Key Generation and Usage** (adapted from `/CRYPTOGRAPHIC_KEY_GENERATION.md`):
```typescript
class SecurityManager {
  private validationTokenSecret: Buffer;
  private metadataEncryptionKey: Buffer;
  private awsSecretEncryptionKey: Buffer;
  
  constructor() {
    // Load or generate cryptographic keys
    this.validationTokenSecret = this.loadOrGenerateKey('VALIDATION_TOKEN_SECRET', 32);
    this.metadataEncryptionKey = this.loadOrGenerateKey('METADATA_ENCRYPTION_KEY', 32);
    this.awsSecretEncryptionKey = this.loadOrGenerateKey('AWS_SECRET_ENCRYPTION_KEY', 32);
  }
  
  private loadOrGenerateKey(envVar: string, bytes: number): Buffer {
    const existing = process.env[envVar];
    if (existing) {
      return Buffer.from(existing, 'hex');
    }
    
    // Generate new key for development
    const key = crypto.randomBytes(bytes);
    logger.warn(`Generated new ${envVar}. Add to environment: ${key.toString('hex')}`);
    return key;
  }
  
  encryptMetadata(plaintext: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipher('aes-256-cbc', this.metadataEncryptionKey);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
  }
  
  decryptMetadata(ciphertext: string): string {
    const [ivHex, encryptedHex] = ciphertext.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');
    const decipher = crypto.createDecipher('aes-256-cbc', this.metadataEncryptionKey);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }
  
  generateJWT(payload: any, expiresIn: string = '1h'): string {
    return jwt.sign(payload, this.validationTokenSecret, { 
      expiresIn,
      algorithm: 'HS256',
      issuer: 'sail-proxy-gateway'
    });
  }
  
  verifyJWT(token: string): any {
    return jwt.verify(token, this.validationTokenSecret, {
      algorithms: ['HS256'],
      issuer: 'sail-proxy-gateway'
    });
  }
}
```

### Usage Tracking and Analytics

#### Comprehensive Usage Logging

**Usage Tracking Service**:
```typescript
interface UsageEvent {
  id: string;
  userId: string;
  apiKeyId: string;
  correlationId: string;
  timestamp: Date;
  endpoint: string;
  method: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  responseTime: number;
  statusCode: number;
  ipAddress: string;
  userAgent: string;
  cost?: number;
}

class UsageTracker {
  private redis: Redis;
  private database: Database;
  private eventQueue: Queue<UsageEvent>;
  
  async logUsage(event: Omit<UsageEvent, 'id' | 'timestamp'>): Promise<void> {
    const fullEvent: UsageEvent = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      ...event
    };
    
    // Immediate Redis publish for real-time analytics
    await this.redis.publish('usage-events', JSON.stringify(fullEvent));
    
    // Queue for database persistence
    await this.eventQueue.add('persist-usage', fullEvent, {
      attempts: 3,
      backoff: 'exponential'
    });
    
    // Update real-time counters
    await this.updateCounters(fullEvent);
  }
  
  private async updateCounters(event: UsageEvent): Promise<void> {
    const date = event.timestamp.toISOString().split('T')[0];
    const hour = event.timestamp.getHours();
    
    // Increment various counters for analytics
    await Promise.all([
      this.redis.hincrby(`usage:daily:${date}`, 'requests', 1),
      this.redis.hincrby(`usage:daily:${date}`, 'tokens', event.totalTokens),
      this.redis.hincrby(`usage:hourly:${date}:${hour}`, 'requests', 1),
      this.redis.hincrby(`usage:user:${event.userId}:${date}`, 'requests', 1),
      this.redis.hincrby(`usage:model:${event.model}:${date}`, 'requests', 1)
    ]);
  }
}
```

`UsageMetrics`/`UsageEvent` (`services/gateway/src/types/usage.ts`) carry an optional
`imageOutputTokens`, set by the Google route and the images controller (section above) for any call
that returned image output, and left unset by every other route. It is a modality split of
`outputTokens`, never an addition to it, so a client counting total output tokens sees no change —
only a consumer that cares which tokens were image versus text needs the new field.
`audioInputTokens`/`audioOutputTokens` follow the same rule — subsets of `inputTokens`/
`outputTokens`, set only by the realtime relay.

#### Token Counting and Cost Calculation

**Token Counter Service**:
```typescript
class TokenCounter {
  private encoders = new Map<string, any>();
  
  async countTokens(text: string, model: string): Promise<number> {
    const encoder = this.getEncoder(model);
    
    if (encoder) {
      return encoder.encode(text).length;
    }
    
    // Fallback estimation (approximately 4 characters per token)
    return Math.ceil(text.length / 4);
  }
  
  private getEncoder(model: string): any {
    if (!this.encoders.has(model)) {
      // Load model-specific encoder
      try {
        const encoding = getEncoding(this.getEncodingName(model));
        this.encoders.set(model, encoding);
      } catch (error) {
        logger.warn(`No encoder found for model ${model}, using estimation`);
        return null;
      }
    }
    
    return this.encoders.get(model);
  }
  
  private getEncodingName(model: string): string {
    // Map models to their tokenizer encodings
    if (model.startsWith('gpt-4')) return 'cl100k_base';
    if (model.startsWith('gpt-3.5')) return 'cl100k_base';
    if (model.startsWith('claude')) return 'cl100k_base'; // Approximation
    return 'cl100k_base'; // Default fallback
  }
}
```

---

*Next: Learn how to [run and test the Gateway](chapter-4-gateway-testing.md) service effectively.*