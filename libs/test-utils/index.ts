/**
 * Shared Test Utilities for SAP LLM Gateway Services
 * 
 * Common test utilities, factories, and helpers used across
 * gateway and admin service test suites.
 */

export interface TestEnvironment {
  originalEnv: { [key: string]: string | undefined };
  testStartTime: number;
}

/**
 * Set up test environment with common configuration
 */
export function setupTestEnvironment(): TestEnvironment {
  const originalEnv = { ...process.env };
  const testStartTime = Date.now();

  // Common test environment variables
  process.env.NODE_ENV = 'test';
  process.env.METADATA_ENCRYPTION_KEY = 'test-encryption-key-32-chars-minimum-length-required-for-validation';
  process.env.VALIDATION_TOKEN_SECRET = 'test-validation-token-secret-32-chars-minimum-length-required';
  process.env.AWS_SECRET_ENCRYPTION_KEY = 'test-aws-secret-encryption-key-32-chars-minimum-length-required';

  return { originalEnv, testStartTime };
}

/**
 * Restore environment after test
 */
export function teardownTestEnvironment(testEnv: TestEnvironment): void {
  // Restore original environment
  process.env = testEnv.originalEnv;
}

/**
 * Common test data factory for API keys
 */
export class TestDataFactory {
  static createApiKeyRequest(overrides: Partial<any> = {}) {
    return {
      apiKey: 'sk-test12345678901234567890123456',
      clientIp: '192.168.1.100',
      userAgent: 'TestClient/1.0',
      method: 'POST',
      endpoint: '/api/test/endpoint',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'TestClient/1.0'
      },
      ...overrides
    };
  }

  static createAwsCredentialRequest(overrides: Partial<any> = {}) {
    return {
      accessKeyId: 'AKIATEST123456789012',
      region: 'us-east-1',
      service: 'bedrock',
      clientIp: '192.168.1.100',
      userAgent: 'aws-sdk-js/1.0.0',
      ...overrides
    };
  }

  static createValidationResponse(valid: boolean = true, overrides: Partial<any> = {}) {
    return {
      valid,
      authType: 'api_key',
      data: {
        keyId: 'test-key-123',
        name: 'Test API Key',
        email: 'test@example.com',
        isActive: true,
        permissions: ['read', 'write']
      },
      metadata: {
        userId: 'test-user-id',
        lastValidated: new Date().toISOString()
      },
      cached: false,
      ...overrides
    };
  }

  static createCacheEntry(overrides: Partial<any> = {}) {
    return {
      data: this.createValidationResponse(),
      expiresAt: Date.now() + 60000,
      createdAt: Date.now(),
      ...overrides
    };
  }
}

/**
 * Test assertion helpers
 */
export class TestAssertions {
  /**
   * Assert that an object has required properties
   */
  static hasRequiredProperties(obj: any, properties: string[]): void {
    for (const prop of properties) {
      if (!(prop in obj)) {
        throw new Error(`Missing required property: ${prop}`);
      }
    }
  }

  /**
   * Assert that a value is a valid UUID
   */
  static isValidUuid(value: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(value);
  }

  /**
   * Assert that a value is a valid API key format
   */
  static isValidApiKeyFormat(value: string): boolean {
    return /^sk-[a-zA-Z0-9]{32,}$/.test(value);
  }

  /**
   * Assert that a value is a valid AWS access key format
   */
  static isValidAwsAccessKeyFormat(value: string): boolean {
    return /^AKIA[A-Z0-9]{16}$/.test(value);
  }

  /**
   * Assert that execution time is within expected bounds
   */
  static isWithinTimebound(startTime: number, maxMs: number): boolean {
    const duration = Date.now() - startTime;
    return duration <= maxMs;
  }
}

/**
 * Mock helpers for testing
 */
export class TestMocks {
  /**
   * Create a mock HTTP client response
   */
  static createMockHttpResponse(data: any, status: number = 200) {
    return {
      data,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers: {
        'content-type': 'application/json'
      }
    };
  }

  /**
   * Create a mock cache adapter
   */
  static createMockCacheAdapter() {
    const cache = new Map();
    
    const createMockFn = (implementation: Function) => {
      // Use jest.fn() if available, otherwise return the implementation directly
      try {
        return (global as any).jest?.fn?.()?.mockImplementation?.(implementation) || implementation;
      } catch {
        return implementation;
      }
    };

    return {
      get: createMockFn((key: string) => Promise.resolve(cache.get(key) || null)),
      set: createMockFn((key: string, value: any, ttl?: number) => {
        cache.set(key, value);
        if (ttl) {
          setTimeout(() => cache.delete(key), ttl * 1000);
        }
        return Promise.resolve();
      }),
      delete: createMockFn((key: string) => {
        cache.delete(key);
        return Promise.resolve();
      }),
      clear: createMockFn(() => {
        cache.clear();
        return Promise.resolve();
      })
    };
  }
}

/**
 * Performance testing helpers
 */
export class PerformanceTestHelpers {
  /**
   * Measure execution time of an async function
   */
  static async measureExecutionTime<T>(fn: () => Promise<T>): Promise<{ result: T; duration: number }> {
    const startTime = Date.now();
    const result = await fn();
    const duration = Date.now() - startTime;
    return { result, duration };
  }

  /**
   * Run concurrent operations and measure performance
   */
  static async runConcurrently<T>(operations: (() => Promise<T>)[], maxConcurrency: number = 10): Promise<T[]> {
    const results: T[] = [];
    
    for (let i = 0; i < operations.length; i += maxConcurrency) {
      const batch = operations.slice(i, i + maxConcurrency);
      const batchResults = await Promise.all(batch.map(op => op()));
      results.push(...batchResults);
    }
    
    return results;
  }
}

/**
 * Common test timeouts and configuration
 */
export const TestConfig = {
  TIMEOUTS: {
    UNIT_TEST: 5000,
    INTEGRATION_TEST: 15000,
    E2E_TEST: 30000,
    PERFORMANCE_TEST: 60000
  },
  
  PERFORMANCE_THRESHOLDS: {
    CACHE_OPERATION_MAX_MS: 100,
    API_CALL_MAX_MS: 5000,
    VALIDATION_MAX_MS: 1000
  },
  
  RETRY_CONFIG: {
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 1000
  }
};