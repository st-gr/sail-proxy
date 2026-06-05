/**
 * Admin Service HTTP Client
 * 
 * Handles secure communication with the admin service for unified token authentication.
 * Includes retry logic, circuit breaker, request/response validation, and comprehensive error handling.
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { performance } from 'perf_hooks';
import { getCachedUnifiedAuthConfig, isStandaloneMode } from '../config/unifiedAuthConfig';
import { ValidationTokenUtils } from '../../../../libs/aws-token-validation/validation-token';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

// Extend AxiosRequestConfig to include metadata
declare module 'axios' {
  interface InternalAxiosRequestConfig {
    metadata?: {
      startTime: number;
    };
  }
}

// Type definitions
export interface UnifiedTokenRequest {
  authType: 'api_key' | 'aws_credential';
  identifier: string;
  clientIp: string;
  userAgent?: string;
  method: string;
  endpoint: string;
  headers?: string;
  signature?: string; // Required for AWS credentials
}

export interface UnifiedTokenResponse {
  token: string;
  expiresAt: number;
  requestId: string;
}

export interface UnifiedValidationRequest {
  token: string;
}

export interface UnifiedValidationResponse {
  valid: boolean;
  authType: 'api_key' | 'aws_credential';
  data: ApiKeyValidationData | AwsCredentialValidationData;
  auditInfo: {
    requestId: string;
    validationTime: number;
    cacheHit: boolean;
  };
  error?: {
    code: string;
    message: string;
    details: string;
  };
}

export interface ApiKeyValidationData {
  keyId: string;
  name: string;
  email: string;
  permissions: string[];
  rateLimits: {
    requestsPerMinute: number;
    requestsPerHour: number;
    requestsPerDay: number;
  };
  metadata: {
    isActive: boolean;
    lastUsed: string;
  };
}

export interface AwsCredentialValidationData {
  credentialId: string;
  secretAccessKey: string; // Only returned for validation
  region: string;
  sapAiRegion: string;
  userId: string;
  permissions: string[];
  rateLimits: {
    requestsPerMinute: number;
    requestsPerHour: number;
    requestsPerDay: number;
  };
  metadata: {
    isActive: boolean;
    lastUsed: string;
    expiresAt?: string;
  };
}

export interface AdminServiceHealthResponse {
  status: 'healthy' | 'unhealthy';
  services: {
    database: string;
    cache: string;
    validation: string;
  };
  uptime: number;
  version: string;
  timestamp: string;
}

export interface CircuitBreakerState {
  state: 'closed' | 'open' | 'half-open';
  failures: number;
  lastFailure: number;
  nextRetry: number;
}

export interface RequestMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  avgResponseTime: number;
  circuitBreakerTrips: number;
  retryAttempts: number;
}

/**
 * Admin Service HTTP Client with circuit breaker, retries, and monitoring
 */
export class AdminServiceClient {
  private client: AxiosInstance;
  private circuitBreaker: CircuitBreakerState;
  private metrics: RequestMetrics;
  private config = getCachedUnifiedAuthConfig();

  constructor() {
    this.client = this.createAxiosClient();
    this.circuitBreaker = {
      state: 'closed',
      failures: 0,
      lastFailure: 0,
      nextRetry: 0
    };
    this.metrics = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      avgResponseTime: 0,
      circuitBreakerTrips: 0,
      retryAttempts: 0
    };

    // Start health check if enabled and not in standalone mode
    if (this.config.enabled && this.config.healthCheckIntervalMs > 0 && !isStandaloneMode()) {
      this.startHealthCheck();
    }
  }

  /**
   * Create unified validation token
   */
  async createUnifiedValidationToken(request: UnifiedTokenRequest): Promise<UnifiedTokenResponse> {
    const startTime = performance.now();
    
    try {
      logger.trace('AdminServiceClient', 'Creating unified validation token', {
        authType: request.authType,
        identifier: request.identifier.substring(0, 10) + '...',
        endpoint: request.endpoint
      });

      const response = await this.makeRequest<UnifiedTokenResponse>('POST', '/odata/v4/validation/createUnifiedValidationToken', request);
      
      const responseTime = performance.now() - startTime;
      logger.trace('AdminServiceClient', `Token created successfully (${responseTime.toFixed(2)}ms)`, {
        requestId: response.requestId,
        expiresAt: new Date(response.expiresAt).toISOString()
      });

      return response;

    } catch (error) {
      const responseTime = performance.now() - startTime;
      logger.error('AdminServiceClient', `Failed to create unified token (${responseTime.toFixed(2)}ms)`, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * Validate unified authentication token
   */
  async validateUnifiedAuthByToken(request: UnifiedValidationRequest): Promise<UnifiedValidationResponse> {
    const startTime = performance.now();
    
    try {
      logger.trace('AdminServiceClient', 'Validating unified auth token', {
        tokenPrefix: request.token.substring(0, 20) + '...'
      });

      const response = await this.makeRequest<UnifiedValidationResponse>('POST', '/odata/v4/validation/validateUnifiedAuthByToken', request);
      
      const responseTime = performance.now() - startTime;
      logger.trace('AdminServiceClient', `Token validated (${responseTime.toFixed(2)}ms)`, {
        valid: response.valid,
        authType: response.authType,
        cacheHit: response.auditInfo.cacheHit,
        requestId: response.auditInfo.requestId
      });

      return response;

    } catch (error) {
      const responseTime = performance.now() - startTime;
      logger.error('AdminServiceClient', `Failed to validate token (${responseTime.toFixed(2)}ms)`, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * Check admin service health
   */
  async checkHealth(): Promise<AdminServiceHealthResponse> {
    try {
      logger.trace('AdminServiceClient', 'Checking admin service health');

      const response = await this.makeRequest<AdminServiceHealthResponse>('GET', '/odata/v4/validation/health()');
      
      logger.trace('AdminServiceClient', 'Health check successful', {
        status: response.status,
        uptime: response.uptime
      });

      return response;

    } catch (error) {
      logger.warn('AdminServiceClient', 'Health check failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Get active configuration using ValidationService with JWT authentication
   */
  async getActiveConfiguration(): Promise<any> {
    try {
      logger.trace('AdminServiceClient', 'Requesting active configuration from ValidationService');

      // Use GET request for OData function calls
      const response = await this.makeRequest<any>('GET', `/odata/v4/validation/getConfig()`);
      
      logger.trace('AdminServiceClient', 'Active configuration retrieved successfully');
      return response;

    } catch (error) {
      logger.warn('AdminServiceClient', 'Failed to get active configuration', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Process usage events (routes to ValidationService with standard JWT authorization)
   */
  async callAdminAction(action: string, payload: any): Promise<any> {
    try {
      logger.trace('AdminServiceClient', `Calling admin action: ${action}`);

      // Currently only supports processUsageEvents
      if (action !== 'processUsageEvents') {
        throw new Error(`Unsupported admin action: ${action}`);
      }

      // Use standard makeRequest with Authorization header (consistent with other endpoints)
      const response = await this.makeRequest<any>('POST', `/odata/v4/validation/${action}`, payload);
      
      logger.trace('AdminServiceClient', `Admin action ${action} successful`);
      return response;

    } catch (error) {
      logger.warn('AdminServiceClient', `Admin action ${action} failed`, {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Get circuit breaker state and metrics
   */
  getMetrics(): {
    circuitBreaker: CircuitBreakerState;
    requests: RequestMetrics;
    config: {
      enabled: boolean;
      adminServiceUrl: string;
      fallbackEnabled: boolean;
      timeoutMs: number;
      maxRetries: number;
    };
  } {
    return {
      circuitBreaker: { ...this.circuitBreaker },
      requests: { ...this.metrics },
      config: {
        enabled: this.config.enabled,
        adminServiceUrl: this.config.adminServiceUrl,
        fallbackEnabled: this.config.fallbackToLocal,
        timeoutMs: this.config.requestTimeoutMs,
        maxRetries: this.config.maxRetryAttempts
      }
    };
  }

  /**
   * Reset circuit breaker (for testing/recovery)
   */
  resetCircuitBreaker(): void {
    this.circuitBreaker = {
      state: 'closed',
      failures: 0,
      lastFailure: 0,
      nextRetry: 0
    };
    logger.info('AdminServiceClient', 'Circuit breaker reset');
  }

  /**
   * Private helper methods
   */
  private createAxiosClient(): AxiosInstance {
    const client = axios.create({
      baseURL: this.config.adminServiceUrl,
      timeout: this.config.requestTimeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': `Gateway-UnifiedAuth/${this.config.version}`,
        // JWT token-based auth will be handled per-request
      },
      validateStatus: (status) => status < 500 // Only treat 5xx as errors for retry logic
    });

    // Request interceptor for logging and metrics
    client.interceptors.request.use(
      (config) => {
        config.metadata = { startTime: performance.now() };
        this.metrics.totalRequests++;
        return config;
      },
      (error) => {
        this.metrics.failedRequests++;
        return Promise.reject(error);
      }
    );

    // Response interceptor for metrics and error handling
    client.interceptors.response.use(
      (response) => {
        const responseTime = performance.now() - (response.config.metadata?.startTime || 0);
        this.updateResponseTimeMetrics(responseTime);
        this.metrics.successfulRequests++;
        
        // Handle HTTP errors that don't throw (4xx)
        if (response.status >= 400) {
          const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
          (error as any).response = response;
          throw error;
        }
        
        return response;
      },
      (error) => {
        const responseTime = performance.now() - (error.config?.metadata?.startTime || 0);
        this.updateResponseTimeMetrics(responseTime);
        this.metrics.failedRequests++;
        return Promise.reject(error);
      }
    );

    return client;
  }

  private createAuthToken(requestId: string): string {
    // Create a SAP-style JWT token matching the mocked user in admin service
    const payload = {
      // Standard JWT claims
      iss: 'gateway-service', 
      sub: 'admin@test.com', // Match the mocked user
      aud: 'admin-service',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300, // 5 minutes
      
      // SAP-style claims matching package.json mocked auth
      email: 'admin@test.com', // Must match mocked user
      scope: ['admin', 'user', 'gateway'], // Must match mocked roles + gateway role
      roles: ['admin', 'user', 'gateway'], // Alternative role format + gateway role
      service: 'gateway',
      requestId
    };

    // Create simple JWT manually since we just need basic auth
    const header = { alg: 'HS256', typ: 'JWT' };
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    
    const crypto = require('crypto');
    const secret = process.env.VALIDATION_TOKEN_SECRET || 'dev-secret-change-in-production';
    const signature = crypto
      .createHmac('sha256', secret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url');

    return `${encodedHeader}.${encodedPayload}.${signature}`;
  }

  private async makeRequest<T>(method: 'GET' | 'POST', path: string, data?: any): Promise<T> {
    // Check circuit breaker
    if (this.circuitBreaker.state === 'open') {
      if (Date.now() < this.circuitBreaker.nextRetry) {
        throw new Error('Circuit breaker is open - admin service unavailable');
      } else {
        this.circuitBreaker.state = 'half-open';
        logger.info('AdminServiceClient', 'Circuit breaker moving to half-open state');
      }
    }

    let lastError: Error = new Error('No attempts made');
    let attempt = 0;
    const maxAttempts = this.config.maxRetryAttempts + 1;

    while (attempt < maxAttempts) {
      try {
        const requestId = ValidationTokenUtils.generateRequestId();
        const authToken = this.createAuthToken(requestId);
        
        const config: AxiosRequestConfig = {
          method,
          url: path,
          headers: {
            'Authorization': `Bearer ${authToken}`,
            'X-Request-ID': requestId
          },
          ...(data && method === 'POST' && { data })
        };

        const response: AxiosResponse<T> = await this.client.request(config);
        
        // Success - update circuit breaker
        this.onRequestSuccess();
        
        return response.data;

      } catch (error) {
        lastError = error as Error;
        attempt++;
        
        if (attempt < maxAttempts) {
          this.metrics.retryAttempts++;
          const delay = this.calculateRetryDelay(attempt);
          logger.warn('AdminServiceClient', `Request failed, retrying in ${delay}ms`, {
            attempt,
            maxAttempts,
            error: lastError instanceof Error ? lastError.message : String(lastError)
          });
          await this.sleep(delay);
        }
      }
    }

    // All attempts failed
    this.onRequestFailure(lastError);
    throw lastError;
  }

  private onRequestSuccess(): void {
    if (this.circuitBreaker.state === 'half-open') {
      this.circuitBreaker.state = 'closed';
      this.circuitBreaker.failures = 0;
      logger.info('AdminServiceClient', 'Circuit breaker closed - service recovered');
    }
  }

  private onRequestFailure(error: Error): void {
    this.circuitBreaker.failures++;
    this.circuitBreaker.lastFailure = Date.now();

    if (this.circuitBreaker.failures >= this.config.circuitBreakerThreshold) {
      this.circuitBreaker.state = 'open';
      this.circuitBreaker.nextRetry = Date.now() + this.config.circuitBreakerTimeoutMs;
      this.metrics.circuitBreakerTrips++;
      
      logger.error('AdminServiceClient', 'Circuit breaker opened - admin service marked as unavailable', undefined, {});
    }
  }


  private calculateRetryDelay(attempt: number): number {
    // Exponential backoff with jitter
    const baseDelay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
    const jitter = Math.random() * 1000;
    return Math.floor(baseDelay + jitter);
  }

  private updateResponseTimeMetrics(responseTime: number): void {
    // Simple moving average
    const totalRequests = this.metrics.successfulRequests + this.metrics.failedRequests;
    if (totalRequests === 1) {
      this.metrics.avgResponseTime = responseTime;
    } else {
      this.metrics.avgResponseTime = ((this.metrics.avgResponseTime * (totalRequests - 1)) + responseTime) / totalRequests;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private startHealthCheck(): void {
    const healthCheckInterval = setInterval(async () => {
      try {
        await this.checkHealth();
      } catch (error) {
        // Health check failures are logged but don't affect circuit breaker
        logger.debug('AdminServiceClient', 'Periodic health check failed', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }, this.config.healthCheckIntervalMs);

    // Cleanup interval on process exit
    process.on('SIGTERM', () => clearInterval(healthCheckInterval));
    process.on('SIGINT', () => clearInterval(healthCheckInterval));
  }
}

/**
 * Create admin service client instance based on deployment mode
 */
function createAdminServiceClient(): AdminServiceClient | null {
  if (isStandaloneMode()) {
    logger.info('AdminServiceClient', 'Running in standalone mode - admin service client disabled');
    return null;
  }
  return new AdminServiceClient();
}

// Export singleton instance (may be null in standalone mode)
export const adminServiceClient = createAdminServiceClient();

export default AdminServiceClient;