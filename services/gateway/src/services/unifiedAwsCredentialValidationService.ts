/**
 * Unified AWS Credential Validation Service
 * 
 * Provides unified token-based validation for AWS credentials using the admin service.
 * Supports caching, fallback to local validation, and audit logging.
 */

import { Request } from 'express';
import { adminServiceClient } from '../clients/adminServiceClient';
import { unifiedValidationCache } from './unifiedValidationCache';
import { getCachedUnifiedAuthConfig, isStandaloneMode } from '../config/unifiedAuthConfig';
import { UnifiedValidationResponse, UnifiedTokenRequest, AwsCredentialValidationData } from '../clients/adminServiceClient';
import { getDefaultLogger } from '@libs/logger';
import { secretLabel } from '../utils/secretLabel';
const logger = getDefaultLogger();

export interface UnifiedAwsCredentialValidationRequest {
  accessKeyId: string;
  signature: string;
  clientIp: string;
  userAgent?: string;
  method: string;
  endpoint: string;
  headers?: Record<string, string>;
}

export interface UnifiedAwsCredentialValidationResult {
  valid: boolean;
  authType: 'aws_credential';
  data?: AwsCredentialValidationData;
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
 * Unified AWS Credential Validation Service
 */
export class UnifiedAwsCredentialValidationService {
  private config = getCachedUnifiedAuthConfig();

  /**
   * Validate AWS credentials using unified token flow
   */
  async validateAwsCredential(request: UnifiedAwsCredentialValidationRequest): Promise<UnifiedAwsCredentialValidationResult> {
    const startTime = Date.now();
    const requestId = this.generateRequestId();
    
    logger.trace('UnifiedAwsCredentialValidationService', 'Validating AWS credentials', {
      accessKeyLabel: secretLabel(request.accessKeyId),
      endpoint: request.endpoint,
      requestId
    });

    try {
      // In standalone mode, skip admin service validation entirely
      if (isStandaloneMode()) {
        logger.debug('UnifiedAwsCredentialValidationService', 'Standalone mode detected - using local validation only', {
          requestId
        });
        
        const localResult = await this.validateWithLocalService(request);
        if (localResult) {
          return this.createSuccessResult(localResult, requestId, startTime, 'local_fallback');
        }
        
        // Local validation failed in standalone mode
        return this.createErrorResult(requestId, startTime, 'invalid_aws_credential', 'AWS credential validation failed');
      }

      // Check cache first if enabled
      if (this.config.enabled) {
        const cachedResult = await this.getCachedValidation(request.accessKeyId);
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
            await this.cacheValidationResult(request.accessKeyId, adminResult, 'admin_service');
            return this.createSuccessResult(adminResult, requestId, startTime, 'admin_service');
          }
        } catch (adminError) {
          logger.warn('UnifiedAwsCredentialValidationService', 'Admin service validation failed, trying fallback', {
            error: adminError instanceof Error ? adminError.message : String(adminError),
            requestId
          });

          // If fallback is enabled, try local validation
          if (this.config.fallbackToLocal) {
            const localResult = await this.validateWithLocalService(request);
            if (localResult) {
              // Cache the fallback result too
              await this.cacheValidationResult(request.accessKeyId, localResult, 'fallback');
              return this.createSuccessResult(localResult, requestId, startTime, 'local_fallback');
            }
          }
        }
      }

      // All validation attempts failed
      return this.createErrorResult(requestId, startTime, 'validation_failed', 'AWS credential validation failed');

    } catch (error) {
      logger.error('UnifiedAwsCredentialValidationService', 'Validation error', error instanceof Error ? error : new Error(String(error)));
      
      return this.createErrorResult(requestId, startTime, 'internal_error', 'Internal validation error');
    }
  }

  /**
   * Validate AWS credentials with admin service using unified token system
   */
  private async validateWithAdminService(
    request: UnifiedAwsCredentialValidationRequest,
    requestId: string
  ): Promise<AwsCredentialValidationData | null> {
    if (!adminServiceClient) {
      throw new Error('Admin service client not available');
    }

    try {
      logger.trace('UnifiedAwsCredentialValidationService', 'Creating unified validation token for AWS credential', {
        accessKeyLabel: secretLabel(request.accessKeyId),
        requestId
      });

      // Filter headers to only include security-relevant ones for AWS SigV4
      const securityHeaders = this.filterSecurityRelevantHeaders(request.headers || {});
      
      // Create unified validation token with minimal data
      const tokenRequest: UnifiedTokenRequest = {
        authType: 'aws_credential',
        identifier: request.accessKeyId,
        clientIp: request.clientIp,
        userAgent: this.truncateUserAgent(request.userAgent),
        method: request.method,
        endpoint: this.shortenEndpoint(request.endpoint),
        headers: JSON.stringify(securityHeaders),
        signature: request.signature
      };

      const tokenResponse = await adminServiceClient.createUnifiedValidationToken(tokenRequest);
      
      logger.trace('UnifiedAwsCredentialValidationService', 'Validating unified auth token', {
        tokenId: tokenResponse.requestId,
        requestId
      });

      // Validate using the unified token
      const validationResponse = await adminServiceClient.validateUnifiedAuthByToken({
        token: tokenResponse.token
      });

      if (validationResponse.valid && validationResponse.authType === 'aws_credential') {
        logger.trace('UnifiedAwsCredentialValidationService', 'AWS credential validation successful via admin service', {
          credentialId: (validationResponse.data as AwsCredentialValidationData)?.credentialId,
          requestId
        });
        
        return validationResponse.data as AwsCredentialValidationData;
      } else {
        logger.warn('UnifiedAwsCredentialValidationService', 'AWS credential validation failed', {
          error: validationResponse.error,
          requestId
        });
        
        return null;
      }
    } catch (error) {
      logger.error('UnifiedAwsCredentialValidationService', 'Admin service validation error', error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * Validate with local service (fallback)
   */
  private async validateWithLocalService(request: UnifiedAwsCredentialValidationRequest): Promise<AwsCredentialValidationData | null> {
    try {
      // Import local AWS credentials service
      const awsCredentialsService = require('./awsCredentialsService');
      
      const credential = await awsCredentialsService.findAwsCredential(request.accessKeyId);
      if (!credential) {
        logger.debug('UnifiedAwsCredentialValidationService', 'AWS credential not found in local service', {
          accessKeyLabel: secretLabel(request.accessKeyId)
        });
        return null;
      }

      // For local validation, we need to verify the signature
      const secretKey = await awsCredentialsService.getSecretForSignature(credential);
      // Simplified signature validation - in production, implement proper AWS SigV4 validation
      
      const validationData: AwsCredentialValidationData = {
        credentialId: credential.id || 'local-' + request.accessKeyId,
        secretAccessKey: secretKey,
        permissions: ['bedrock:InvokeModel'],
        region: credential.region || 'us-east-1',
        sapAiRegion: credential.sapAiRegion || 'us-east-1',
        userId: credential.userId || 'local-user',
        rateLimits: {
          requestsPerMinute: 100,
          requestsPerHour: 1000,
          requestsPerDay: 10000
        },
        metadata: {
          lastUsed: new Date().toISOString(),
          isActive: true
        }
      };

      logger.debug('UnifiedAwsCredentialValidationService', 'AWS credential validated via local service', {
        credentialId: validationData.credentialId,
        region: validationData.region
      });

      return validationData;
    } catch (error) {
      logger.error('UnifiedAwsCredentialValidationService', 'Local validation error', error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  }

  /**
   * Get cached validation result using unified cache
   */
  private async getCachedValidation(accessKeyId: string): Promise<AwsCredentialValidationData | null> {
    try {
      const cachedResponse = await unifiedValidationCache.getUnifiedToken(accessKeyId, 'aws_credential');
      
      if (cachedResponse && cachedResponse.valid && cachedResponse.authType === 'aws_credential') {
        logger.trace('UnifiedAwsCredentialValidationService', 'Cache hit for AWS credential', {
          accessKeyLabel: secretLabel(accessKeyId)
        });
        return cachedResponse.data as AwsCredentialValidationData;
      }
      
      return null;
    } catch (error) {
      logger.warn('UnifiedAwsCredentialValidationService', 'Cache lookup failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * Cache validation result using unified cache
   */
  private async cacheValidationResult(
    accessKeyId: string, 
    data: AwsCredentialValidationData, 
    source: 'admin_service' | 'local_validation' | 'fallback' = 'admin_service'
  ): Promise<void> {
    try {
      // Create UnifiedValidationResponse format for caching
      const unifiedResponse = {
        valid: true,
        authType: 'aws_credential' as const,
        data: data,
        auditInfo: {
          requestId: this.generateRequestId(),
          validationTime: 0,
          cacheHit: false
        }
      };
      
      // Use unified cache method which handles TTL configuration automatically
      await unifiedValidationCache.setUnifiedToken(accessKeyId, unifiedResponse, { source });
      
      logger.trace('UnifiedAwsCredentialValidationService', 'Cached AWS credential validation result', {
        accessKeyLabel: secretLabel(accessKeyId),
        source
      });
    } catch (error) {
      logger.warn('UnifiedAwsCredentialValidationService', 'Failed to cache result', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Create success result
   */
  private createSuccessResult(
    data: AwsCredentialValidationData,
    requestId: string,
    startTime: number,
    source: 'admin_service' | 'local_fallback' | 'cache'
  ): UnifiedAwsCredentialValidationResult {
    return {
      valid: true,
      authType: 'aws_credential',
      data,
      auditInfo: {
        requestId,
        validationTime: Date.now() - startTime,
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
  ): UnifiedAwsCredentialValidationResult {
    return {
      valid: false,
      authType: 'aws_credential',
      auditInfo: {
        requestId,
        validationTime: Date.now() - startTime,
        cacheHit: false,
        source: 'admin_service',
        responseTime: Date.now() - startTime
      },
      error: {
        code,
        message,
        details
      }
    };
  }

  /**
   * Filter headers to only include those relevant for AWS SigV4 validation
   * This significantly reduces token size while maintaining security
   */
  private filterSecurityRelevantHeaders(headers: Record<string, any>): Record<string, any> {
    const relevantHeaders: Record<string, any> = {};
    
    // Only include headers that are actually needed for AWS SigV4 validation
    const awsRelevantHeaderNames = [
      'host',
      'x-amz-date',
      'x-amz-target',
      'x-amz-content-sha256',
      'authorization',
      'content-type',
      'content-length'
    ];
    
    for (const [key, value] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase();
      if (awsRelevantHeaderNames.includes(lowerKey) || lowerKey.startsWith('x-amz-')) {
        relevantHeaders[key] = value;
      }
    }
    
    return relevantHeaders;
  }

  /**
   * Truncate user agent to reduce token size
   */
  private truncateUserAgent(userAgent?: string): string | undefined {
    if (!userAgent) return undefined;
    
    // Keep only the first part of user agent (usually the main application)
    const truncated = userAgent.split(' ')[0];
    return truncated.length > 50 ? truncated.substring(0, 50) : truncated;
  }

  /**
   * Shorten endpoint path to reduce token size
   */
  private shortenEndpoint(endpoint: string): string {
    // Remove query parameters and keep only the path
    try {
      const url = new URL(endpoint, 'http://localhost');
      return url.pathname;
    } catch {
      // If URL parsing fails, just return the original endpoint
      return endpoint;
    }
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `aws-val-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

// Export singleton instance
export const unifiedAwsCredentialValidationService = new UnifiedAwsCredentialValidationService();
export default unifiedAwsCredentialValidationService;