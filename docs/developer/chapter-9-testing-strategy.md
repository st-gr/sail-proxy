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