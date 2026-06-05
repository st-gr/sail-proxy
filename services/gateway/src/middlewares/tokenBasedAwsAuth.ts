import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
// axios import removed - using unified admin service client instead
import { 
  ValidationToken, 
  ValidationTokenUtils, 
  ValidationCache,
  ValidationResponse as TokenValidationResponse 
} from '../../../../libs/aws-token-validation/validation-token';
import securityEventEmitter from '../services/securityEventEmitter';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

interface ParsedAuthHeader {
  accessKeyId: string;
  date: string;
  region: string;
  service: string;
  signedHeaders: string[];
  signature: string;
}

interface AwsCredentialsExtended extends Request {
  awsCredentials?: {
    accessKeyId: string;
    userId: string;
    permissions?: string[];
    region?: string;
  };
  awsAuth?: {
    valid: boolean;
    accessKeyId: string;
    userId: string;
    permissions: any[];
    region?: string;
    credentialId?: string;
  };
  isAwsAuthenticated?: boolean;
  validationMetadata?: {
    requestId: string;
    validationTime: number;
    cacheHit: boolean;
  };
  id?: string;
  rawBody?: string;
}

interface AdminServiceConfig {
  baseUrl: string;
  timeout: number;
  retries: number;
  retryDelay: number;
}

class TokenBasedAwsAuth {
  private validationCache: ValidationCache;
  private adminServiceConfig: AdminServiceConfig;
  private fallbackToLocal: boolean;

  constructor() {
    this.validationCache = new ValidationCache();
    this.adminServiceConfig = {
      baseUrl: process.env.ADMIN_SERVICE_URL || 'http://localhost:4004',
      timeout: parseInt(process.env.ADMIN_SERVICE_TIMEOUT || '5000'),
      retries: parseInt(process.env.ADMIN_SERVICE_RETRIES || '2'),
      retryDelay: parseInt(process.env.ADMIN_SERVICE_RETRY_DELAY || '1000')
    };
    this.fallbackToLocal = process.env.UNIFIED_AUTH_FALLBACK_TO_LOCAL === 'true';
    
    logger.info('TokenBasedAwsAuth', `Initialized with admin service URL: ${this.adminServiceConfig.baseUrl}`);
  }

  /**
   * Enhanced AWS SigV4 authentication middleware with token-based validation
   */
  async authenticate(req: AwsCredentialsExtended, res: Response, next: NextFunction): Promise<void> {
    const startTime = Date.now();
    const requestId = ValidationTokenUtils.generateRequestId();
    
    try {
      // Check if this is an AWS SigV4 request
      const authHeader = req.headers.authorization as string;
      if (!authHeader || !authHeader.startsWith('AWS4-HMAC-SHA256 ')) {
        logger.trace('TokenBasedAwsAuth', 'No AWS SigV4 authorization header found, skipping');
        return next();
      }

      // Parse authorization header
      const parsed = this.parseAuthHeader(authHeader);
      if (!parsed) {
        logger.warn('TokenBasedAwsAuth', 'Invalid AWS authorization header format');
        return this.respondWithError(res, 401, 'INVALID_AUTH_HEADER', 'Invalid authorization header format');
      }

      logger.info('TokenBasedAwsAuth', `Processing AWS SigV4 request for access key: ${parsed.accessKeyId}`);

      // Create canonical request and string to sign
      const { canonicalRequest, stringToSign } = this.createAwsSignatureData(req, parsed);
      
      // Check cache first
      const signatureHash = crypto.createHash('sha256').update(parsed.signature).digest('hex');
      const cacheKey = ValidationTokenUtils.createCacheKey(parsed.accessKeyId, signatureHash);
      
      let validationResult = this.validationCache.get(cacheKey);
      let cacheHit = false;

      if (validationResult && validationResult.valid) {
        logger.info('TokenBasedAwsAuth', `Cache hit for access key: ${parsed.accessKeyId}`);
        cacheHit = true;
      } else {
        // Create validation token
        const requestMetadata = {
          timestamp: Date.now(),
          clientIp: this.getClientIp(req),
          endpoint: req.path,
          method: req.method,
          headers: this.sanitizeHeaders(req.headers)
        };

        const validationToken = ValidationTokenUtils.createValidationToken(
          parsed.accessKeyId,
          parsed.signature,
          requestMetadata
        );

        // Call admin service for validation using unified service
        try {
          const { unifiedAwsCredentialValidationService } = require('../services/unifiedAwsCredentialValidationService');
          
          const unifiedRequest = {
            accessKeyId: parsed.accessKeyId,
            signature: parsed.signature,
            clientIp: this.getClientIp(req),
            userAgent: req.headers['user-agent'] as string,
            method: req.method,
            endpoint: req.path,
            headers: this.sanitizeHeaders(req.headers)
          };
          
          const unifiedResult = await unifiedAwsCredentialValidationService.validateAwsCredential(unifiedRequest);
          
          if (unifiedResult.valid && unifiedResult.data) {
            // Convert unified result to legacy format for compatibility
            validationResult = {
              valid: true,
              credentialMetadata: {
                credentialId: unifiedResult.data.credentialId,
                permissions: unifiedResult.data.permissions || [],
                region: unifiedResult.data.region,
                sapAiRegion: unifiedResult.data.sapAiRegion,
                userId: unifiedResult.data.userId,
                rateLimits: unifiedResult.data.rateLimits
              },
              validationToken: '',
              auditInfo: {
                requestId: unifiedResult.auditInfo.requestId,
                validationTime: unifiedResult.auditInfo.validationTime,
                cacheHit: unifiedResult.auditInfo.cacheHit,
                ipAllowed: true,
                signatureValid: true
              }
            };
          } else {
            validationResult = {
              valid: false,
              validationToken: '',
              auditInfo: {
                requestId: unifiedResult.auditInfo.requestId,
                validationTime: unifiedResult.auditInfo.validationTime,
                cacheHit: unifiedResult.auditInfo.cacheHit,
                ipAllowed: true,
                signatureValid: false
              },
              error: unifiedResult.error || {
                code: 'VALIDATION_FAILED',
                message: 'AWS credential validation failed',
                details: 'Unified validation returned invalid result'
              }
            };
          }
          
          // Cache the result if valid
          if (validationResult && validationResult.valid) {
            this.validationCache.set(cacheKey, validationResult, 300000); // 5 minutes
          }
        } catch (error) {
          logger.error('TokenBasedAwsAuth', `Admin service validation failed: ${(error as Error).message}`);
          
          // Fallback to local validation if enabled
          if (this.fallbackToLocal) {
            logger.warn('TokenBasedAwsAuth', 'Falling back to local validation');
            validationResult = await this.fallbackLocalValidation(parsed, stringToSign);
          } else {
            return this.respondWithError(res, 503, 'VALIDATION_SERVICE_UNAVAILABLE', 'Credential validation service unavailable');
          }
        }
      }

      // Handle validation result
      if (!validationResult || !validationResult.valid) {
        const errorCode = validationResult?.error?.code || 'INVALID_CREDENTIALS';
        const errorMessage = validationResult?.error?.message || 'Invalid AWS credentials';
        
        logger.warn('TokenBasedAwsAuth', `Authentication failed for ${parsed.accessKeyId}: ${errorMessage}`);
        
        // Emit security event using SecurityEventEmitter
        await securityEventEmitter.emitFailedAuth({
          credentialId: parsed.accessKeyId,
          authType: 'aws_credential',
          reason: errorMessage,
          clientIP: this.getClientIp(req),
          userAgent: req.headers['user-agent'] || 'unknown',
          endpoint: req.originalUrl,
          method: req.method,
          requestId,
          statusCode: 403
        });
        
        return this.respondWithError(res, 403, errorCode, errorMessage);
      }

      // Set authentication context
      req.awsCredentials = {
        accessKeyId: parsed.accessKeyId,
        userId: validationResult.credentialMetadata?.userId || 'unknown',
        permissions: validationResult.credentialMetadata?.permissions?.map((p: any) => p.action) || [],
        region: validationResult.credentialMetadata?.region
      };
      
      // Set awsAuth property for compatibility with proxy service
      req.awsAuth = {
        valid: true,
        accessKeyId: parsed.accessKeyId,
        userId: validationResult.credentialMetadata?.userId || 'unknown',
        permissions: validationResult.credentialMetadata?.permissions || [],
        region: validationResult.credentialMetadata?.region,
        credentialId: validationResult.credentialMetadata?.credentialId
      };
      
      req.isAwsAuthenticated = true;
      req.validationMetadata = {
        requestId,
        validationTime: Date.now() - startTime,
        cacheHit
      };

      // Update unifiedAuth object if it exists (for unified auth compatibility)
      if ((req as any).unifiedAuth) {
        (req as any).unifiedAuth.valid = true;
        (req as any).unifiedAuth.data = {
          accessKeyId: parsed.accessKeyId,
          userId: validationResult.credentialMetadata?.userId || 'unknown',
          permissions: validationResult.credentialMetadata?.permissions || [],
          region: validationResult.credentialMetadata?.region,
          credentialId: validationResult.credentialMetadata?.credentialId
        };
        (req as any).unifiedAuth.auditInfo.validationTime = Date.now() - startTime;
        (req as any).unifiedAuth.auditInfo.cacheHit = cacheHit;
      }

      // Log successful authentication
      logger.info('TokenBasedAwsAuth', `Successfully authenticated AWS request for ${parsed.accessKeyId} (${Date.now() - startTime}ms)`);
      
      // Update usage statistics asynchronously
      this.updateUsageStats(validationResult.credentialMetadata?.credentialId, req);
      
      next();

    } catch (error) {
      logger.error('TokenBasedAwsAuth', `Authentication error: ${(error as Error).message}`);
      return this.respondWithError(res, 500, 'INTERNAL_ERROR', 'Internal authentication error');
    }
  }

  /**
   * Create secure signed token (JWT-style but compatible with admin service)
   */
  private createSecureToken(tokenData: any): string {
    const secret = process.env.VALIDATION_TOKEN_SECRET || 'dev-secret-change-in-production';
    
    // Create JWT-style token but decode to simple JSON in admin service
    const header = { alg: 'HS256', typ: 'JWT' };
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(tokenData)).toString('base64url');
    
    const signature = crypto
      .createHmac('sha256', secret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url');

    return `${encodedHeader}.${encodedPayload}.${signature}`;
  }

  /**
   * Parse AWS4 Authorization header
   */
  private parseAuthHeader(authHeader: string): ParsedAuthHeader | null {
    if (!authHeader || !authHeader.startsWith('AWS4-HMAC-SHA256 ')) {
      return null;
    }
    
    const authString = authHeader.substring('AWS4-HMAC-SHA256 '.length);
    const parts: { [key: string]: string } = {};
    
    // Parse Credential=..., SignedHeaders=..., Signature=...
    const regex = /(\w+)=([^,]+)/g;
    let match;
    while ((match = regex.exec(authString)) !== null) {
      if (match[1] && match[2]) {
        parts[match[1]] = match[2];
      }
    }
    
    if (!parts.Credential || !parts.SignedHeaders || !parts.Signature) {
      return null;
    }
    
    // Parse credential string
    const credentialParts = parts.Credential.split('/');
    if (credentialParts.length !== 5) {
      return null;
    }
    
    return {
      accessKeyId: credentialParts[0]!,
      date: credentialParts[1]!,
      region: credentialParts[2]!,
      service: credentialParts[3]!,
      signedHeaders: parts.SignedHeaders.split(';'),
      signature: parts.Signature
    };
  }

  /**
   * Create AWS signature data for validation
   */
  private createAwsSignatureData(req: Request, parsed: ParsedAuthHeader): {
    canonicalRequest: string;
    stringToSign: string;
  } {
    const method = req.method.toUpperCase();
    const path = req.path;
    const query = new URLSearchParams(req.query as any).toString();
    const payloadHash = req.headers['x-amz-content-sha256'] as string || 'UNSIGNED-PAYLOAD';
    
    // Create canonical request
    const canonicalHeaders = parsed.signedHeaders
      .sort()
      .map(name => {
        const value = req.headers[name.toLowerCase()] || '';
        return `${name.toLowerCase()}:${value.toString().trim()}`;
      })
      .join('\n');
    
    const signedHeadersString = parsed.signedHeaders.sort().join(';');
    
    const canonicalRequest = [
      method,
      this.encodeUriPath(path),
      query,
      canonicalHeaders,
      '',
      signedHeadersString,
      payloadHash
    ].join('\n');

    // Create string to sign
    const algorithm = 'AWS4-HMAC-SHA256';
    const timestamp = req.headers['x-amz-date'] as string;
    const credentialScope = `${parsed.date}/${parsed.region}/${parsed.service}/aws4_request`;
    const hashedCanonicalRequest = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
    
    const stringToSign = [
      algorithm,
      timestamp,
      credentialScope,
      hashedCanonicalRequest
    ].join('\n');

    return { canonicalRequest, stringToSign };
  }

  // Old validateWithAdminService method removed - now using unified AWS credential validation service

  /**
   * Fallback to local validation (for development/emergency)
   */
  private async fallbackLocalValidation(
    parsed: ParsedAuthHeader,
    stringToSign: string
  ): Promise<TokenValidationResponse> {
    try {
      // Import local AWS credentials service
      const { findAwsCredential, getSecretForSignature } = require('../services/awsCredentialsService');
      
      const credential = await findAwsCredential(parsed.accessKeyId);
      if (!credential) {
        return ValidationTokenUtils.createErrorResponse(
          'CREDENTIAL_NOT_FOUND',
          'AWS credential not found',
          ValidationTokenUtils.generateRequestId()
        );
      }

      const secretKey = await getSecretForSignature(credential);
      const expectedSignature = crypto
        .createHmac('sha256', secretKey)
        .update(stringToSign)
        .digest('hex');

      const isValid = crypto.timingSafeEqual(
        Buffer.from(parsed.signature.toLowerCase()),
        Buffer.from(expectedSignature.toLowerCase())
      );

      if (isValid) {
        return {
          valid: true,
          credentialMetadata: {
            credentialId: credential.id,
            permissions: [{ service: 'bedrock', action: 'bedrock:InvokeModel', resource: '*', effect: 'Allow' }],
            region: credential.region || 'us-east-1',
            sapAiRegion: credential.sapAiRegion || 'us-east-1',
            userId: credential.userId || 'local-fallback',
            rateLimits: {
              requestsPerMinute: 60,
              requestsPerHour: 1000,
              requestsPerDay: 10000
            }
          },
          validationToken: '',
          auditInfo: {
            requestId: ValidationTokenUtils.generateRequestId(),
            validationTime: 0,
            cacheHit: false,
            ipAllowed: true,
            signatureValid: true
          }
        };
      } else {
        return ValidationTokenUtils.createErrorResponse(
          'INVALID_SIGNATURE',
          'Invalid AWS signature',
          ValidationTokenUtils.generateRequestId()
        );
      }
    } catch (error) {
      logger.error('TokenBasedAwsAuth', `Local fallback validation failed: ${(error as Error).message}`);
      return ValidationTokenUtils.createErrorResponse(
        'FALLBACK_ERROR',
        'Local validation failed',
        ValidationTokenUtils.generateRequestId()
      );
    }
  }

  /**
   * Helper methods
   */
  private encodeUriPath(path: string): string {
    return path.split('/').map(segment => 
      encodeURIComponent(segment).replace(/%2F/g, '/')
    ).join('/');
  }

  private getClientIp(req: Request): string {
    return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
           (req.headers['x-real-ip'] as string) ||
           req.connection.remoteAddress ||
           req.ip ||
           'unknown';
  }

  private sanitizeHeaders(headers: any): Record<string, string> {
    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === 'string') {
        sanitized[key.toLowerCase()] = value;
      }
    }
    // Remove sensitive headers
    delete sanitized.authorization;
    delete sanitized.cookie;
    return sanitized;
  }

  private respondWithError(res: Response, status: number, code: string, message: string): void {
    res.status(status).json({
      error: {
        code,
        message,
        timestamp: new Date().toISOString()
      }
    });
  }


  private updateUsageStats(credentialId?: string, req?: Request): void {
    if (!credentialId) return;
    
    // Only call recordUsage when Valkey is NOT available (fallback mode)
    // When Valkey is available, usage tracking happens through the normal event emission flow
    setTimeout(async () => {
      try {
        // Check if we're in standalone mode or if distributed caching is unavailable
        const { isStandaloneMode, shouldEnableDistributedCaching } = require('../config/unifiedAuthConfig');
        
        // Only use direct admin service call when Valkey/distributed caching is not available
        if (isStandaloneMode() || !shouldEnableDistributedCaching()) {
          const { adminServiceClient } = require('../clients/adminServiceClient');
          if (adminServiceClient) {
            logger.debug('TokenBasedAwsAuth', 'Using fallback usage tracking (Valkey unavailable)', {
              standalone: isStandaloneMode(),
              distributedCaching: shouldEnableDistributedCaching()
            });
            
            // Use the admin service client to record usage with proper JWT authentication
            await (adminServiceClient as any).makeRequest('POST', '/recordUsage', {
              credentialId,
              endpoint: req?.path,
              method: req?.method,
              timestamp: new Date().toISOString()
            });
          }
        } else {
          logger.trace('TokenBasedAwsAuth', 'Skipping direct recordUsage call (Valkey available)', {
            standalone: isStandaloneMode(),
            distributedCaching: shouldEnableDistributedCaching()
          });
        }
      } catch (error) {
        logger.trace('TokenBasedAwsAuth', `Failed to update usage stats: ${(error as Error).message}`);
      }
    }, 0);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): any {
    return this.validationCache.getStats();
  }

  /**
   * Clear validation cache
   */
  clearCache(): void {
    this.validationCache.clear();
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    if (this.validationCache) {
      this.validationCache.destroy();
    }
  }
}

// Create singleton instance
const tokenBasedAwsAuth = new TokenBasedAwsAuth();

/**
 * Express middleware function
 */
export const awsSigV4TokenAuth = (req: AwsCredentialsExtended, res: Response, next: NextFunction) => {
  return tokenBasedAwsAuth.authenticate(req, res, next);
};

/**
 * Export utilities for testing and monitoring
 */
export {
  TokenBasedAwsAuth,
  ParsedAuthHeader,
  AwsCredentialsExtended
};

export default awsSigV4TokenAuth;