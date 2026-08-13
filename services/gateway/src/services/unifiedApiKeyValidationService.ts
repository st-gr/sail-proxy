/**
 * Unified API Key Validation Service
 * 
 * Provides unified token-based validation for API keys using the admin service.
 * Supports caching, fallback to local validation, and audit logging.
 */

import { Request } from 'express';
import { adminServiceClient } from '../clients/adminServiceClient';
import { unifiedValidationCache } from './unifiedValidationCache';
import { getCachedUnifiedAuthConfig, isStandaloneMode } from '../config/unifiedAuthConfig';
import { UnifiedValidationResponse, UnifiedTokenRequest, ApiKeyValidationData } from '../clients/adminServiceClient';
import apiKeyService from './apiKeyService';
import { getDefaultLogger } from '@libs/logger';
import { secretLabel } from '../utils/secretLabel';
const logger = getDefaultLogger();

export interface UnifiedApiKeyValidationRequest {
  apiKey: string;
  clientIp: string;
  userAgent?: string;
  method: string;
  endpoint: string;
  headers?: Record<string, string>;
}

export interface UnifiedApiKeyValidationResult {
  valid: boolean;
  authType: 'api_key';
  data?: ApiKeyValidationData;
  token?: string; // Unified validation token for subsequent requests
  auditInfo: {
    requestId: string;
    validationTime: number;
    cacheHit: boolean;
    source: 'admin_service' | 'local_fallback' | 'cache';
    responseTime: number;
  };
  error?: {
    code: string;
    message: string;
    details?: any;
  };
}

/**
 * Unified API Key Validation Service
 */
export class UnifiedApiKeyValidationService {
  private config = getCachedUnifiedAuthConfig();

  /**
   * Validate API key using unified token flow
   */
  async validateApiKey(request: UnifiedApiKeyValidationRequest): Promise<UnifiedApiKeyValidationResult> {
    const startTime = Date.now();
    const requestId = this.generateRequestId();
    
    logger.trace('UnifiedApiKeyValidationService', 'Validating API key', {
      keyLabel: secretLabel(request.apiKey),
      endpoint: request.endpoint,
      requestId
    });

    try {
      // In standalone mode, skip admin service validation entirely
      if (isStandaloneMode()) {
        logger.debug('UnifiedApiKeyValidationService', 'Standalone mode detected - using local validation only', {
          requestId
        });
        
        const localResult = await this.validateWithLocalService(request.apiKey);
        if (localResult) {
          return this.createSuccessResult(localResult, requestId, startTime, 'local_fallback');
        }
        
        // Local validation failed in standalone mode
        return this.createErrorResult(requestId, startTime, 'invalid_api_key', 'API key validation failed');
      }

      // Check cache first if enabled
      if (this.config.enabled) {
        const cachedResult = await this.getCachedValidation(request.apiKey);
        if (cachedResult) {
          return this.createSuccessResult(cachedResult, requestId, startTime, 'cache');
        }
      }

      // Try admin service validation
      if (this.config.enabled) {
        try {
          const adminResult = await this.validateWithAdminService(request, requestId);
          if (adminResult) {
            // Cache the result
            await this.cacheValidationResult(request.apiKey, adminResult);
            return this.createSuccessResult(adminResult, requestId, startTime, 'admin_service');
          }
        } catch (adminError) {
          logger.warn('UnifiedApiKeyValidationService', 'Admin service validation failed, trying fallback', {
            error: adminError instanceof Error ? adminError.message : String(adminError),
            requestId
          });
        }
      }

      // Fallback to local validation
      if (this.config.fallbackToLocal) {
        const localResult = await this.validateWithLocalService(request.apiKey);
        if (localResult) {
          // Cache fallback result with shorter TTL
          if (this.config.enabled) {
            await this.cacheValidationResult(request.apiKey, localResult, 'fallback');
          }
          return this.createSuccessResult(localResult, requestId, startTime, 'local_fallback');
        }
      }

      // All validation methods failed
      return this.createErrorResult(requestId, startTime, 'invalid_api_key', 'API key validation failed');

    } catch (error) {
      logger.error('UnifiedApiKeyValidationService', 'API key validation error', error instanceof Error ? error : new Error(String(error)));

      return this.createErrorResult(
        requestId, 
        startTime, 
        'validation_error', 
        'Internal validation error',
        error
      );
    }
  }

  /**
   * Create unified validation token for valid API key
   */
  async createUnifiedToken(request: UnifiedApiKeyValidationRequest): Promise<string | null> {
    if (!this.config.enabled) {
      return null;
    }

    try {
      // Create minimal token request - only include essential headers
      const essentialHeaders: Record<string, string> = {};
      if (request.headers) {
        // Only include security-relevant headers, not all headers
        const securityHeaders = ['authorization', 'x-api-key', 'user-agent', 'origin', 'referer'];
        for (const header of securityHeaders) {
          if (request.headers[header]) {
            essentialHeaders[header] = request.headers[header];
          }
        }
      }

      const tokenRequest: UnifiedTokenRequest = {
        authType: 'api_key',
        identifier: request.apiKey,
        clientIp: request.clientIp,
        userAgent: request.userAgent?.substring(0, 100) || undefined, // Truncate user agent
        method: request.method,
        endpoint: request.endpoint,
        headers: JSON.stringify(essentialHeaders)
      };

      // Skip if admin service client is disabled (standalone mode)
      if (!adminServiceClient) {
        logger.debug('UnifiedApiKeyValidationService', 'Admin service client disabled - cannot create unified token');
        return null;
      }

      const tokenResponse = await adminServiceClient.createUnifiedValidationToken(tokenRequest);
      return tokenResponse.token;

    } catch (error) {
      logger.error('UnifiedApiKeyValidationService', 'Failed to create unified token', error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  }

  /**
   * Validate using admin service
   */
  private async validateWithAdminService(
    request: UnifiedApiKeyValidationRequest, 
    requestId: string
  ): Promise<UnifiedValidationResponse | null> {
    try {
      // Create unified token first
      const token = await this.createUnifiedToken(request);
      if (!token) {
        throw new Error('Failed to create unified validation token');
      }

      // Skip if admin service client is disabled (standalone mode)
      if (!adminServiceClient) {
        logger.debug('UnifiedApiKeyValidationService', 'Admin service client disabled - cannot validate token');
        return null;
      }

      // Validate the token
      const validationResult = await adminServiceClient.validateUnifiedAuthByToken({ token });
      
      if (validationResult.valid && validationResult.authType === 'api_key') {
        return validationResult;
      }

      return null;

    } catch (error) {
      logger.warn('UnifiedApiKeyValidationService', 'Admin service validation failed', {
        error: error instanceof Error ? error.message : String(error),
        requestId
      });
      throw error;
    }
  }

  /**
   * Validate using local API key service (fallback)
   */
  private async validateWithLocalService(apiKey: string): Promise<UnifiedValidationResponse | null> {
    try {
      const validKey = await apiKeyService.validateApiKey(apiKey);
      if (!validKey) {
        return null;
      }

      // Convert local validation result to unified format
      const unifiedResult: UnifiedValidationResponse = {
        valid: true,
        authType: 'api_key',
        data: {
          keyId: validKey.id,
          name: validKey.name,
          email: 'local@fallback.com', // Local service doesn't store email
          permissions: ['gateway:access'], // Default permissions for local keys
          rateLimits: {
            requestsPerMinute: 100,
            requestsPerHour: 1000, 
            requestsPerDay: 10000
          },
          metadata: {
            isActive: validKey.active,
            lastUsed: new Date().toISOString()
          }
        } as ApiKeyValidationData,
        auditInfo: {
          requestId: this.generateRequestId(),
          validationTime: Date.now(),
          cacheHit: false
        }
      };

      return unifiedResult;

    } catch (error) {
      logger.warn('UnifiedApiKeyValidationService', 'Local validation failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * Get cached validation result
   */
  private async getCachedValidation(apiKey: string): Promise<UnifiedValidationResponse | null> {
    try {
      return await unifiedValidationCache.getUnifiedToken(apiKey, 'api_key');
    } catch (error) {
      logger.warn('UnifiedApiKeyValidationService', 'Cache lookup failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * Cache validation result
   */
  private async cacheValidationResult(
    apiKey: string, 
    result: UnifiedValidationResponse, 
    source: 'admin_service' | 'fallback' = 'admin_service'
  ): Promise<void> {
    try {
      await unifiedValidationCache.setUnifiedToken(apiKey, result, { source });
    } catch (error) {
      logger.warn('UnifiedApiKeyValidationService', 'Failed to cache validation result', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Create success result
   */
  private createSuccessResult(
    validationData: UnifiedValidationResponse,
    requestId: string,
    startTime: number,
    source: 'admin_service' | 'local_fallback' | 'cache'
  ): UnifiedApiKeyValidationResult {
    return {
      valid: true,
      authType: 'api_key',
      data: validationData.data as ApiKeyValidationData,
      token: (validationData as any).token,
      auditInfo: {
        requestId,
        validationTime: Date.now(),
        cacheHit: source === 'cache',
        source,
        responseTime: Date.now() - startTime
      }
    };
  }

  /**
   * Create error result
   */
  private createErrorResult(
    requestId: string,
    startTime: number,
    code: string,
    message: string,
    details?: any
  ): UnifiedApiKeyValidationResult {
    return {
      valid: false,
      authType: 'api_key',
      auditInfo: {
        requestId,
        validationTime: Date.now(),
        cacheHit: false,
        source: 'local_fallback',
        responseTime: Date.now() - startTime
      },
      error: {
        code,
        message,
        details: details instanceof Error ? details.message : details
      }
    };
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `apikey-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
  }

  /**
   * Get service metrics
   */
  getMetrics(): {
    config: {
      enabled: boolean;
      fallbackEnabled: boolean;
      adminServiceUrl: string;
    };
    cache: any;
  } {
    return {
      config: {
        enabled: this.config.enabled,
        fallbackEnabled: this.config.fallbackToLocal,
        adminServiceUrl: this.config.adminServiceUrl
      },
      cache: unifiedValidationCache.getUnifiedMetrics()
    };
  }
}

// Export singleton instance
export const unifiedApiKeyValidationService = new UnifiedApiKeyValidationService();

export default UnifiedApiKeyValidationService;