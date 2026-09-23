---
title: SAIL-PROXY Developer Guide - Chapter 9
author: st-gr
date: 2025-01-28
mainfont: Helvetica, Arial, sans-serif
fontsize: 18px
---

# SAIL-PROXY Developer Guide
*Multi-provider AI Gateway for SAP AI Core - Developer Documentation*
**Author:** *st-gr*

[<< Previous Chapter](chapter-8-workspace-layout.md) | [Content Table](README.md) | [Next Chapter >>](chapter-10-security.md)

---

## Testing Strategy

### Testing Philosophy (from `/CLAUDE.md`)

**Jest-Based Testing Structure**: The project uses a consolidated Jest-based testing structure across all services with clear separation of test types and shared utilities.

**Testing Guidelines**:
1. **Use Jest for all tests** - No custom test runners or scripts
2. **Follow service boundaries** - Gateway tests Gateway, Admin tests Admin
3. **Use shared test utilities** - Available in `libs/test-utils/`
4. **Write proper test categories**:
   - Unit tests: Individual functions/classes in isolation
   - Integration tests: Component interactions within a service
   - HTTP tests: API endpoint testing with real requests
5. **Keep tests organized** - Use descriptive names and proper directory structure

### Test Directory Structure

#### Gateway Service Tests (`services/gateway/test/`)

```
services/gateway/test/
├── setupTests.ts              # Global test setup
├── clients/                   # Client integration tests
│   ├── openai-client.test.ts
│   ├── anthropic-client.test.ts
│   └── bedrock-client.test.ts
├── config/                    # Configuration tests
│   ├── model-mapping.test.ts
│   └── rate-limits.test.ts
├── integration/               # Integration tests (formerly scripts/)
│   ├── api-endpoints.test.ts
│   ├── streaming.test.ts
│   └── authentication.test.ts
└── usage-tracking*.test.ts    # Usage tracking tests
```

- `test/tool-governance-identity.test.ts` — the identity strings and the pattern regex (`^(function|hosted|mcp):([^*\s]+\*?|\*)$`), including the bare namespace wildcard `function:*`
- `test/tool-governance-evaluate.test.ts` — pure evaluation: allow/deny precedence, the two-policy merge (most restrictive wins), a `tool_choice` forcing a stripped tool, fail-open with no policy block
- `test/tool-governance-adapters-anthropic-openai.test.ts`, `test/tool-governance-adapters-responses-gemini.test.ts` — one suite per pair of adapters: declared tools, the forced tool, strip leaving the rest of the body intact, invoked tools from a non-streaming response and from an accumulated stream
- `test/tool-governance-scoped-allow.test.ts` — the scoped-vs-global pattern rule, `deniedBy` with scoped allows (a server-limited policy leaves the rest of the caller's tools alone, `mcp:<server>/*` is unlimited, deny still wins), and `serverLimit`/`evaluate` narrowing a bare server declaration to `monitored`/`stripped`/`rejected` per mode and per a prefix vs. named-tools scoped allow
- `test/tool-governance-narrowing.test.ts` — the Responses and Anthropic adapters rendering `EvaluationResult.narrow` into a bare server declaration (`allowed_tools`, and the Anthropic `mcp_toolset`'s `default_config`/`configs`), including the client-already-narrowed intersection, the deprecated no-toolset shape left untouched, and the middleware narrowing a bare declaration end to end
- `test/tool-governance-middleware.test.ts` — monitor leaves the request untouched, strip mutates `req.body`, reject returns each family's own 403 shape, a malformed policy block or an adapter throw fails open
- `test/tool-governance-wiring.test.ts` — the middleware is mounted on all four routes, after authentication and before quota enforcement; the Bedrock router governs tools after both authentications (unified/SigV4, then service auth) and before quota enforcement, and its controller records invoked tools for both a complete and a streamed response
- `test/tool-governance-result-sources.test.ts` — each adapter's `resultSources`: pairing a result with the call that produced it per family (OpenAI chat `tool`/legacy `function` messages, Responses `function_call_output`/`custom_tool_call_output`/`mcp_call`/hosted `*_call`, Anthropic `tool_result`/`mcp_tool_result`/hosted `*_tool_result`, Gemini `functionResponse`), and a result whose call is missing from the body falling back to `UNKNOWN_SOURCE`
- `test/tool-governance-trust-chain.test.ts` — the trust step in `evaluate()`: no taint changes nothing, strip/monitor/reject each denying the sensitive tools with reason `trust_chain`, a mixed refusal naming both reasons, label union across the user and key blocks, a forced tool_choice on a withheld tool turning strip into reject, an older admin's block (no labels) never tainting, an ordinary policy denial still carrying reason `policy`, the strip notice naming the sources, and `policyBlocksFromRequest` keeping label lists
- `test/tool-governance-trust-wiring.test.ts` — the middleware and the call gate end to end: strip removes the sensitive tool after an untrusted result and names the source in the notice and the event; the usage fold records `reason` and the `source` entries; a mixed reject names both reasons; no untrusted result taints nothing; a nested call inside a replayed container call counts as a source and the gate then refuses a nested sensitive call; the same call passes without the taint; under Monitor (trust chain or a plain policy deny) the gate passes the nested call but still records it `detected`
- `test/tool-governance-bedrock-adapter.test.ts` — the Bedrock adapter (2026-09-22 §4): Converse declares/forces/strips/notes and pairs `toolResult`↔`toolUse` for `resultSources`; an Anthropic-shaped invoke body delegates to the Anthropic adapter and any other invoke body declares nothing; invoked tools read from a Converse response and from native stream events, with the stream parser's placeholder tool ignored; a strip that would empty an already-tool-using Converse conversation is refused instead of stripped; a reject through the middleware answers with Bedrock's own 403 `AccessDeniedException` shape
- `test/tool-governance-stream-tap.test.ts` — `tapStreamedTools`: tool-start frames are recorded from written chunks and every write still reaches the client unaltered; an ungoverned request or a scan error leaves the write alone; a native and an Anthropic-shaped tool-start frame are reassembled correctly when split across two or three writes, including a split inside the `data:` prefix; a frame that arrives whole is not double-counted when the following write starts a new line; 70 KiB with no newline never throws, and a following tool-start frame is still recorded
- `test/realtime/relay-transform.test.ts` — the relay's client hook as a transform (spec 2026-09-22 §5.1): forwarding a replacement instead of the original, dropping a frame with a reply to the client and nothing forwarded upstream, sending a `thenUpstream` frame after the forwarded one in order, a throwing hook forwarding the original, binary frames passing untouched when the hook returns nothing, and the handle's own `sendUpstream`/`sendClient`
- `test/realtime/realtime-tool-gate.test.ts` — `createRealtimeToolGate` (spec 2026-09-22 §5.2–§5.3): declarations — strip removes a denied tool and appends the notice to the frame's own `instructions` (and leaves them untouched when the frame carries none), reject drops the frame and answers with the Realtime error event, `response.create` is judged the same way as `session.update`, monitor and non-tool frames are left alone; the trust chain in a session — strip forwards the result and follows it with a corrective `session.update` that withholds the sensitive tool, reject refuses the result, monitor changes nothing but still records the source, and a result for an unknown call counts as `<unknown>`
- `test/realtime/realtime-tools.test.ts` — the realtime relay's frame parsing: declared tools read off `session.update`, invoked tools off `response.done`
- `test/sap-rpt-controller.test.ts` — the SAP-RPT controller: a 200 relayed byte-for-byte with headers (marking `res.locals.sapRelay`), a `--deployed` request resolved identically to its bare twin, cells billed against the resolved twin, a deep-context call accounted on the `--deep-context` id, SAP's 422/400 relayed verbatim and billing nothing, 404/403 in the SAP shape for an unknown or unentitled model (without marking it a SAP relay), 502 when the deployment cannot be reached, and `executeBeforePlugins`/`executeAfterPlugins` never called
- `test/sap-rpt-usage.test.ts` — the cell fold from `metadata` (`cellsFromResponse`), the `--deep-context` id `accountedModel` produces only for a `context_mode: "deep"` response (stripped of `--deployed` first), and `rptError`'s envelope shape
- `test/sap-rpt-routes.test.ts` — auth then quota then the controller, an OpenAI-shaped 401 from auth and the real `quotaEnforcement` 429 (no `message`) both reshaped into the SAP shape (the 429's `msg` composed from its fields, the original fields preserved on `detail[0].quota`), a relayed upstream 401 from SAP itself left untouched via `res.locals.sapRelay`, `predict-parquet` routed to its own handler, and tool governance never mounted on this route

#### Admin Service Tests (`services/admin/test/`)

```
services/admin/test/
├── setupTests.ts              # Global test setup
├── unit/                      # Unit tests
│   ├── services/
│   │   ├── ApiKeyService.test.ts
│   │   ├── UserService.test.ts
│   │   └── AnalyticsService.test.ts
│   ├── handlers/
│   │   ├── api-key-handler.test.ts
│   │   └── usage-handler.test.ts
│   └── utils/
│       ├── validation.test.ts
│       └── encryption.test.ts
├── integration/               # Integration tests
│   ├── odata-services.test.ts
│   ├── database-operations.test.ts
│   └── http/                  # HTTP endpoint tests
│       ├── api-keys-endpoint.test.ts
│       ├── analytics-endpoint.test.ts
│       └── configuration-endpoint.test.ts
├── security/                  # Security tests
│   ├── jwt-validation.test.ts
│   ├── rbac.test.ts
│   └── encryption.test.ts
└── bruno/                     # API testing collections
    ├── api-keys/
    ├── users/
    └── analytics/
```

- `test/unit/services/usage-counters.test.ts` — bucket folding, upsert, window derivation, rebuild from rows (watermarks, AWS attribution, retention)
- `test/unit/usage-event-processor-counters.test.ts` — the processor's buckets land with the rows in one transaction (real SQLite)
- `test/unit/services/cost-recalculation-rebuild.test.ts` — the daily recalculation rebuilds the buckets and republishes on every run, and a rebuild failure leaves its own counts intact
- `test/unit/services/cost-recalculation-schedule.test.ts` — when that run happens: 5 minutes after startup and every 24 hours from then, or at `platform.maintenance.dailyRunAtUtc` each day, re-armed on a configuration activation
- `test/unit/services/tool-policy-service.test.ts` — admin: pattern validation, the single default policy, the effective block a validation response carries for a user and for a key
- `test/unit/services/tool-trust-labels.test.ts` — admin: `validatePolicyWrite` accepting valid sensitive/untrusted patterns and rejecting malformed ones, and `recordToolUsage` writing `reason` on the raw row and rolling trust-chain hits into `ToolUsageDaily.trustChained`
- `test/unit/services/tool-usage-service.test.ts` — admin: the daily aggregate upsert arithmetic and the retention boundaries read from `platform.toolGovernance.retention`
- `test/integration/http/tool-policy-validation.test.ts` — admin, cds.test HTTP: the pattern syntax and mode rejected with 400, the default policy's `isDefault` fixed
- `test/integration/http/tool-policies-odata.test.ts` — admin, cds.test HTTP: the ToolPolicies OData surface, the assignment actions, the ToolInventory day-range projection, and creating a policy with sensitive tools and untrusted sources (refusing a malformed untrusted pattern, cascading their deletion with the policy)
- `test/unit/services/sap-rpt-pricing.test.ts` — admin: `pricingTwins` tries the exact id, then a deep-context id's bare model, then the `--deployed` twins; `deriveDeepContextRows` adds one pricing-only row per large SAP-RPT model (none for the small ones), always as `accessType: 'deployment'` regardless of the parent's own accessType, clamps the derived `displayName` to 100 characters, and mirrors the parent's `absent` flag
- `test/integration/http/users-odata.test.ts` (`usageUnits` describe block) — admin, cds.test HTTP: `usageUnits()` lists the models whose usage is counted in cells, from a seeded `unit: 'cells'` `ApiKeyUsage` row
- `services/admin/app/model-library-app/test/costDisplay.test.ts` — Model Library detail's cost math and display: `capacityUnitsPerMillion`, `operandsBracket`, `costRows` (including the manual-price and image/audio cost factor rows), and `costUnitLabel`, which labels SAP-RPT models' cost per 1K cells and everything else per 1K tokens

### Shared Test Utilities (`libs/test-utils/`)

#### Test Data Factories

**API Key Factory**:
```typescript
// libs/test-utils/src/factories/ApiKeyFactory.ts
export class ApiKeyFactory {
  static createApiKeyRequest(overrides: Partial<ApiKeyRequest> = {}): ApiKeyRequest {
    return {
      name: 'Test API Key',
      description: 'Generated for testing',
      rateLimits: '1000/hour',
      ipRestrictions: [],
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      ...overrides
    };
  }
  
  static createApiKey(overrides: Partial<ApiKey> = {}): ApiKey {
    return {
      id: crypto.randomUUID(),
      token: 'sp-proj-' + crypto.randomBytes(32).toString('hex'),
      status: 'active',
      createdAt: new Date(),
      createdBy: 'test-user',
      ...this.createApiKeyRequest(),
      ...overrides
    };
  }
}
```

**Response Factory**:
```typescript
// libs/test-utils/src/factories/ResponseFactory.ts
export class ResponseFactory {
  static createOpenAIResponse(overrides: Partial<OpenAIResponse> = {}): OpenAIResponse {
    return {
      id: 'chatcmpl-' + crypto.randomUUID(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'gpt-4o',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'Hello! How can I help you today?'
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 10,
        total_tokens: 20
      },
      ...overrides
    };
  }
  
  static createValidationResponse(isValid: boolean): ValidationResponse {
    return {
      valid: isValid,
      user: isValid ? UserFactory.createUser() : undefined,
      permissions: isValid ? ['read', 'write'] : [],
      errors: isValid ? [] : ['Invalid API key']
    };
  }
}
```

#### Test Assertions

**Custom Assertions**:
```typescript
// libs/test-utils/src/assertions/TestAssertions.ts
export class TestAssertions {
  static hasRequiredProperties(obj: any, properties: string[]): void {
    for (const prop of properties) {
      expect(obj).toHaveProperty(prop);
    }
  }
  
  static isValidApiKeyFormat(key: string): boolean {
    return /^sp-proj-[a-f0-9]{64}$/.test(key);
  }
  
  static isValidOpenAIResponse(response: any): void {
    expect(response).toHaveProperty('id');
    expect(response).toHaveProperty('object');
    expect(response).toHaveProperty('choices');
    expect(response).toHaveProperty('usage');
    expect(Array.isArray(response.choices)).toBe(true);
  }
  
  static isValidUsageEvent(event: any): void {
    const requiredFields = [
      'id', 'userId', 'apiKeyId', 'model', 'endpoint',
      'promptTokens', 'completionTokens', 'totalTokens',
      'responseTime', 'timestamp'
    ];
    this.hasRequiredProperties(event, requiredFields);
    
    expect(typeof event.promptTokens).toBe('number');
    expect(typeof event.completionTokens).toBe('number');
    expect(event.totalTokens).toBe(event.promptTokens + event.completionTokens);
  }
}
```

#### Mock Implementations

**Mock Cache Adapter**:
```typescript
// libs/test-utils/src/mocks/MockCacheAdapter.ts
export class MockCacheAdapter {
  private store = new Map<string, any>();
  
  async get(key: string): Promise<any> {
    return this.store.get(key);
  }
  
  async set(key: string, value: any, ttl?: number): Promise<void> {
    this.store.set(key, value);
    if (ttl) {
      setTimeout(() => this.store.delete(key), ttl * 1000);
    }
  }
  
  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
  
  async clear(): Promise<void> {
    this.store.clear();
  }
  
  // Test helpers
  getStore(): Map<string, any> {
    return new Map(this.store);
  }
  
  hasKey(key: string): boolean {
    return this.store.has(key);
  }
}
```

**Mock SAP AI Core**:
```typescript
// libs/test-utils/src/mocks/MockSAPAICore.ts
export class MockSAPAICore {
  private responses = new Map<string, any>();
  private streamResponses = new Map<string, AsyncIterator<any>>();
  
  mockResponse(model: string, response: any): void {
    this.responses.set(model, response);
  }
  
  mockStreamResponse(model: string, chunks: any[]): void {
    this.streamResponses.set(model, this.createAsyncIterator(chunks));
  }
  
  async sendRequest(request: SAPRequest): Promise<SAPResponse> {
    const model = request.orchestration_config.model_name;
    const response = this.responses.get(model);
    
    if (!response) {
      throw new Error(`No mock response configured for model: ${model}`);
    }
    
    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 10));
    
    return response;
  }
  
  async *sendStreamRequest(request: SAPRequest): AsyncIterator<any> {
    const model = request.orchestration_config.model_name;
    const iterator = this.streamResponses.get(model);
    
    if (!iterator) {
      throw new Error(`No mock stream response configured for model: ${model}`);
    }
    
    yield* iterator;
  }
  
  private async *createAsyncIterator(chunks: any[]): AsyncIterator<any> {
    for (const chunk of chunks) {
      await new Promise(resolve => setTimeout(resolve, 5)); // Simulate streaming delay
      yield chunk;
    }
  }
}
```

### Test Environment Setup

#### Global Test Setup

**Setup and Teardown** (`test/setupTests.ts`):
```typescript
import { setupTestEnvironment, teardownTestEnvironment } from '@sap-llm-gateway/libs/test-utils';

// Global setup
beforeAll(async () => {
  await setupTestEnvironment();
});

// Global teardown
afterAll(async () => {
  await teardownTestEnvironment();
});

// Reset state between tests
afterEach(async () => {
  // Clear test database
  await clearTestDatabase();
  
  // Clear cache
  await clearTestCache();
  
  // Reset mocks
  jest.clearAllMocks();
});

async function clearTestDatabase(): Promise<void> {
  // Implementation depends on database type
  if (process.env.NODE_ENV === 'test') {
    // Clear test tables
  }
}

async function clearTestCache(): Promise<void> {
  // Clear Redis test database
  if (process.env.REDIS_TEST_URL) {
    // Clear test cache
  }
}
```

#### Environment-Specific Configuration

**Test Environment Variables** (`.env.test`):
```bash
NODE_ENV=test
LOG_LEVEL=error
DATABASE_URL=sqlite::memory:
REDIS_URL=redis://localhost:6379/1
SAP_TEST_CLIENT_ID=test-client-id
SAP_TEST_CLIENT_SECRET=test-secret
VALIDATION_TOKEN_SECRET=test-secret-key
```

### Running Tests

#### Command Reference (from `/CLAUDE.md`)

**Root Level (recommended)**:
```bash
# All tests
pnpm test:all                  # Run all tests across services

# Service-specific tests
pnpm test:gateway              # Gateway service tests
pnpm test:admin                # Admin service tests

# Test categories
pnpm test:gateway:unit         # Gateway unit tests
pnpm test:gateway:integration  # Gateway integration tests
pnpm test:gateway:usage        # Gateway usage tracking tests
pnpm test:admin:unit           # Admin unit tests
pnpm test:admin:integration    # Admin integration tests
pnpm test:admin:http           # Admin HTTP endpoint tests

# Development
pnpm test:watch                # Watch mode for development
pnpm test:coverage             # Coverage reports across services
```

**Service Level**:
```bash
cd services/gateway
pnpm test                      # All gateway tests
pnpm test:unit                 # Unit tests only
pnpm test:integration          # Integration tests only
pnpm test:usage                # Usage tracking tests only

cd services/admin
pnpm test                      # All admin tests
pnpm test:unit                 # Unit tests only
pnpm test:integration          # Integration tests only
pnpm test:http                 # HTTP endpoint tests only
pnpm test:security             # Security tests only
```

### Test Categories and Examples

#### Unit Tests

**Authentication Service Unit Test**:
```typescript
// services/gateway/test/unit/AuthService.test.ts
import { AuthService } from '../../src/services/AuthService';
import { MockCacheAdapter, ApiKeyFactory } from '@sap-llm-gateway/libs/test-utils';

describe('AuthService', () => {
  let authService: AuthService;
  let mockCache: MockCacheAdapter;
  
  beforeEach(() => {
    mockCache = new MockCacheAdapter();
    authService = new AuthService({ cache: mockCache });
  });
  
  describe('validateApiKey', () => {
    it('should validate a valid API key', async () => {
      const apiKey = ApiKeyFactory.createApiKey();
      await mockCache.set(`api_key:${apiKey.token}`, apiKey);
      
      const result = await authService.validateApiKey(apiKey.token);
      
      expect(result.valid).toBe(true);
      expect(result.apiKey).toEqual(apiKey);
    });
    
    it('should reject invalid API key format', async () => {
      const result = await authService.validateApiKey('invalid-key');
      
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid API key format');
    });
    
    it('should reject expired API key', async () => {
      const apiKey = ApiKeyFactory.createApiKey({
        expiresAt: new Date(Date.now() - 1000) // Expired 1 second ago
      });
      await mockCache.set(`api_key:${apiKey.token}`, apiKey);
      
      const result = await authService.validateApiKey(apiKey.token);
      
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('API key expired');
    });
  });
});
```

#### Integration Tests

**API Endpoint Integration Test**:
```typescript
// services/gateway/test/integration/openai-endpoint.test.ts
import request from 'supertest';
import { app } from '../../src/app';
import { TestDataFactory, MockSAPAICore } from '@sap-llm-gateway/libs/test-utils';

describe('OpenAI API Integration', () => {
  let mockSAPAICore: MockSAPAICore;
  let apiKey: string;
  
  beforeEach(async () => {
    mockSAPAICore = new MockSAPAICore();
    const keyData = TestDataFactory.createApiKey();
    apiKey = keyData.token;
    
    // Mock SAP AI Core response
    mockSAPAICore.mockResponse('gpt-4o', {
      choices: [{
        message: { role: 'assistant', content: 'Hello from SAP AI Core!' }
      }],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }
    });
  });
  
  describe('POST /openai/v1/chat/completions', () => {
    it('should handle valid chat completion request', async () => {
      const response = await request(app)
        .post('/openai/v1/chat/completions')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 50
        })
        .expect(200);
      
      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('choices');
      expect(response.body.choices[0].message.content).toBe('Hello from SAP AI Core!');
    });
    
    it('should handle streaming requests', async () => {
      mockSAPAICore.mockStreamResponse('gpt-4o', [
        { choices: [{ delta: { content: 'Hello' } }] },
        { choices: [{ delta: { content: ' world' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] }
      ]);
      
      const response = await request(app)
        .post('/openai/v1/chat/completions')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true
        })
        .expect(200);
      
      expect(response.headers['content-type']).toBe('text/event-stream');
    });
  });
});
```

#### HTTP Endpoint Tests

**Admin API HTTP Test**:
```typescript
// services/admin/test/integration/http/api-keys-endpoint.test.ts
import request from 'supertest';
import { adminApp } from '../../../src/app';
import { TestDataFactory } from '@sap-llm-gateway/libs/test-utils';

describe('API Keys HTTP Endpoint', () => {
  let authToken: string;
  
  beforeEach(async () => {
    const user = TestDataFactory.createUser({ role: 'admin' });
    authToken = generateJWT(user);
  });
  
  describe('POST /admin/api-keys', () => {
    it('should create new API key', async () => {
      const response = await request(adminApp)
        .post('/admin/api-keys')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          name: 'Test Key',
          description: 'Test API key creation',
          rateLimits: '1000/hour'
        })
        .expect(201);
      
      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('token');
      expect(response.body.name).toBe('Test Key');
      expect(response.body.token).toMatch(/^sp-proj-[a-f0-9]{64}$/);
    });
    
    it('should require authentication', async () => {
      await request(adminApp)
        .post('/admin/api-keys')
        .send({
          name: 'Test Key',
          description: 'Should fail'
        })
        .expect(401);
    });
  });
});
```

### UI Journeys (OPA5 in CI)

Role-based UI5 control-level tests for the admin cockpit run on every `pnpm run ci` as
**Phase 6.6** (after the CLI end-to-end phase, as the last consumer of the CI database),
against the dev-mode admin the pipeline starts in Phase 5. They cover the
shell (navigation entries and profile per role, the home page's key-metric tiles and its "My quota"
card), the
API-keys app and the AWS-credentials app (list visibility, object page, edit, create), the
Model Library (entitled models, filters, model detail, manual prices, catalogs), Users & Quotas
(admin only: list, object page, edit, deactivate/reactivate lifecycle, reset quota), Security
Notifications (client IP on the list and the object page) and Tool Policies (admin only: the
seeded Default policy in monitor mode, creating a policy with an inline allow and a deny entry) as
`admin@test.com` and `user@test.com`.

**Where things live**

| Path | Purpose |
|---|---|
| `ci/scripts/ui-journeys/roles.js` | the role matrix — what each role must and must not see or edit |
| `ci/scripts/ui-journeys/fixtures.js` | fixture names (`UI Fixture — …`) and dev user emails, plus a `quota` block (minimal limits so an accidental real request is refused, and the seeded usage figures) and a `securityEvent` block (client IP, user agent, endpoint, request ID of the seeded notification) |
| `ci/scripts/ui-journeys/seed.js` | deletes every draft, API key, AWS credential and non-default model catalog, then creates the fixtures over OData (as the admin); posts synthetic usage for the quota fixtures through the admin's `processUsageEvents` action and a security event through `logSecurityEvent` |
| `ci/scripts/ui-journeys/run.js` | runs `ui5-test-runner` per role × app, writes `ci/reports/ui-journeys/<app>-<role>/` (HTML report, `junit.xml`, screenshots); an `APPS` entry can restrict itself to certain roles via `roles` — `users-app` and `tool-policies-app` are `roles: ['admin']`, since both are admin-only apps |
| `services/admin/app/<app>/webapp/test/integration/` | the OPA5 pages and journeys of each app (`opaTests.qunit.html` is the entry) |
| `services/admin/app/shell/webapp/test/integration/` | Shell journeys: navigation entries and profile per role, home page key-metric tiles, and the My quota card's bullet charts and reset text |
| `services/admin/app/model-library-app/webapp/test/integration/` | Model Library journeys: grid count per role, filters, leaderboard/chart (admin), detail cost operands and role-gated actions, manual price round trip (admin), catalogs create / stage and save members / discard a staged removal / the unsaved-changes guard / admin tabs / delete, and (`ProfilesJourney.js`, admin only) quota profiles create / edit the limits / the unsaved-profile guard / assign and unassign / delete refused while assigned — `minTests: 7` in `run.js` covers the added journey |
| `services/admin/app/users-app/webapp/test/integration/` | Users & Quotas journeys (admin only): list sort/status/seeded usage, object page constraints/usage/API Keys/Entitlement (including the assigned quota-profile field), Usage bullet charts, edit field control, deactivate/reactivate lifecycle with locked credentials, reset quota |
| `services/admin/app/security-notifications-app/webapp/test/integration/` | Security Notifications journeys: list Client IP column, object page notification details (Client IP, User Agent, Endpoint, Request ID) |
| `services/admin/app/tool-policies-app/webapp/test/integration/` | Tool Policies journeys (admin only, `minTests: 4`): the list shows the seeded Default policy in monitor mode, creating a policy with an inline allow entry, an inline deny entry and an inline Sensitive-Tools entry, the Tool Inventory page and back, and assigning then unassigning a user from the policy's own Assigned Users table. The API key side of the assignment actions is covered by `test/integration/http/tool-policies-odata.test.ts`; `PoliciesJourney.js`'s own comments carry why the earlier, header-based shape of those actions could not be driven from OPA at all |

`run.js` injects the selected role's expectations into the page URL (`?role=…&expect=<base64url JSON>`);
journeys read them from `expectations.js` and never assert against literals. **To add a role
expectation, edit `roles.js`** (for example a new entry in `shell.visibleNav`); to check something
new, add one journey file and list it in the app's `opaTests.qunit.js`. The first test of every
page calls `whoami` and fails immediately if the browser is not signed in as the expected role.

**Running locally.** The journeys purge and seed the database they run against, so they only
run when `ADMIN_SERVICE_URL` is set, the seed refuses any target that is not a dev-mode
`admin@test.com` admin, and it refuses port 4004 outside the pipeline — pointing
`ADMIN_SERVICE_URL` at your own dev admin would purge its API keys and AWS credentials.
`pnpm run ci` handles this
(it backs up `services/admin/db/admin.db` in Phase 1 and restores it in Phase 10). For a
standalone run, start a throwaway admin on a scratch database first:

```bash
cd services/admin
npx cds deploy --to sqlite:/tmp/ui-journeys.db
CDS_CONFIG='{"[development]":{"requires":{"db":{"kind":"sqlite","impl":"@cap-js/sqlite","credentials":{"url":"/tmp/ui-journeys.db","database":"/tmp/ui-journeys.db"}}}}}' PORT=4014 pnpm run dev:ts:mock
# in another terminal, from the repository root
ADMIN_SERVICE_URL=http://localhost:4014 pnpm run ui:journeys
```

**The `[development]` key and the `database` entry are both load-bearing.** A top-level
`CDS_CONFIG` block is overridden by the profile the dev server runs under, and
`credentials.database` beats `credentials.url` — so the shorter spelling starts a throwaway that
serves the DEV database instead of the scratch file, and the seed then purges the dev API keys and
AWS credentials.

**Check the running service, not its log.** The log line
`connect to db > sqlite { url: '/tmp/ui-journeys.db', database: '/tmp/ui-journeys.db' }` is printed
by a process that may then lose the port to another admin (`EADDRINUSE`, further down the same log)
and exit, leaving the seed pointed at whatever owns the port. `pnpm run dev:ts:mock` is a nodemon
supervisor that respawns `cds serve` after every kill and every file change, so an old throwaway
can come back and hold the port long after you think it is gone: stop one by killing the
`pnpm run dev:ts:mock` process, not the listener. Ask the service which database it serves —
`curl -u admin@test.com:x http://localhost:<port>/odata/v4/admin/ToolPolicies?\$select=name` on a
scratch database answers with `Default` alone.

`seed.js` enforces the same rule from its side: it refuses any target holding an API key or AWS
credential whose owner is neither a mocked fixture user nor a `*.service.key`, naming what it found.
The CI pipeline restores its database afterwards and opts out with `UI_JOURNEYS_IN_PIPELINE=1`.

The Model Library journeys need the gateway the pipeline starts in Phase 5
(`refreshModelLibrary` reads the model list; it spends no tokens). Locally, either restrict a run to
the other apps with `UI_JOURNEYS_APPS=shell,api-keys-app,aws-credentials-app`, run the full
pipeline, or give the throwaway admin a scratch *copy* of a database that already holds a
library snapshot (copy `admin.db` and its `-wal` file while the dev admin is stopped) and set
`UI_JOURNEYS_SKIP_LIBRARY_REFRESH=1` so the seed keeps that snapshot instead of asking the
gateway — `UI_JOURNEYS_APPS=model-library-app UI_JOURNEYS_SKIP_LIBRARY_REFRESH=1
ADMIN_SERVICE_URL=http://localhost:4014 pnpm run ui:journeys`. The pipeline never sets that flag. `run.js` and `seed.js` read `UI_JOURNEYS_APPS`, so a restricted run seeds only the fixtures its
apps read: the model-library fixtures (the seed drops every non-default catalog, refreshes the
snapshot and creates the fixture catalog, its assignment and one default-catalog exclusion) for
`model-library-app`, the quota fixtures for `shell` or `users-app`, and the security event for
`security-notifications-app`.

The Users & Quotas and shell "My quota" journeys need the seeded usage rows, and the admin only
persists a `processUsageEvents` batch once it has model data from a gateway
(`modelCostService.hasValidModelData()`, which reads `GET <GATEWAY_URL>/v1/models`, by default
`http://localhost:3000`). Without one the seed still reports success and those journeys then time
out waiting for usage that was never stored, so start the gateway — or a stub that answers
`/v1/models` — on a private port and give the throwaway admin `GATEWAY_URL=http://localhost:<port>`
next to its `CDS_CONFIG`. The pipeline starts the real gateway in Phase 5, so this is a standalone
concern only. When the scratch copy predates the current schema, run
`npx cds deploy --to sqlite:/tmp/ui-journeys.db` against the copy before starting the admin;
otherwise the first read fails with `no such table: sap_llm_gateway_admin_Users`. Deploying
recreates every table, so the copy loses its library snapshot — when the model-library journeys
are part of the run, copy a database that already has the current schema instead.

The dev admin serves each app's `webapp/` live (cds-plugin-ui5), so no build is needed before a
run. Docker and Kyma images strip `app/*/dist/test` and exclude the test-only UI5 libraries, so
deployed images carry no test page (a locally built admin still serves them from `dist`).

### Performance Testing

#### Load Testing with Artillery

**Artillery Configuration** (`test/load/artillery.yml`):
```yaml
config:
  target: 'http://localhost:3000'
  phases:
    - duration: 60
      arrivalRate: 10
      name: 'Warm up'
    - duration: 300
      arrivalRate: 50
      name: 'Load test'
  defaults:
    headers:
      Authorization: 'Bearer sp-proj-test-key'
      Content-Type: 'application/json'

scenarios:
  - name: 'Chat Completions'
    weight: 80
    flow:
      - post:
          url: '/openai/v1/chat/completions'
          json:
            model: 'gpt-4o'
            messages:
              - role: 'user'
                content: 'Hello world'
            max_tokens: 50
          capture:
            - json: '$.usage.total_tokens'
              as: 'tokens'
      - think: 1
  
  - name: 'Model Listing'
    weight: 20
    flow:
      - get:
          url: '/v1/models'
```

#### Memory Leak Detection

**Memory Test**:
```typescript
// test/performance/memory-leak.test.ts
describe('Memory Leak Detection', () => {
  it('should not leak memory during request processing', async () => {
    const initialMemory = process.memoryUsage();
    
    // Process many requests
    for (let i = 0; i < 1000; i++) {
      await request(app)
        .post('/openai/v1/chat/completions')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ model: 'gpt-4o', messages: [{ role: 'user', content: 'test' }] });
    }
    
    // Force garbage collection
    if (global.gc) {
      global.gc();
    }
    
    const finalMemory = process.memoryUsage();
    const memoryGrowth = finalMemory.heapUsed - initialMemory.heapUsed;
    
    // Allow for some growth but detect significant leaks
    expect(memoryGrowth).toBeLessThan(50 * 1024 * 1024); // 50MB threshold
  }, 30000);
});
```

---

*Next: Dive into [Security Implementation](chapter-10-security.md) details and best practices.*