/**
 * Unified Token Authentication Middleware
 * 
 * Handles both API key and AWS credential authentication through unified tokens.
 * Supports fallback to existing authentication methods for backward compatibility.
 */

import { Request, Response, NextFunction } from 'express';
import { unifiedApiKeyValidationService } from '../services/unifiedApiKeyValidationService';
import { getCachedUnifiedAuthConfig } from '../config/unifiedAuthConfig';
import apiKeyAuth from './apiKeyAuth';
import tokenBasedAwsAuth from './tokenBasedAwsAuth';
import securityEventEmitter from '../services/securityEventEmitter';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

interface UnifiedAuthRequest extends Request {
  unifiedAuth?: {
    authType: 'api_key' | 'aws_credential';
    valid: boolean;
    data: any;
    token?: string;
    auditInfo: {
      requestId: string;
      validationTime: number;
      cacheHit: boolean;
      source: string;
      responseTime: number;
    };
  };
  // Preserve existing auth properties for compatibility
  apiKey?: any;
  apiKeyInfo?: any;
  awsAuth?: any;
}

/**
 * Unified authentication middleware that handles both API keys and AWS credentials
 */
const unifiedTokenAuth = async (req: UnifiedAuthRequest, res: Response, next: NextFunction): Promise<void> => {
  const config = getCachedUnifiedAuthConfig();
  const startTime = Date.now();

  try {
    // Skip unified auth if disabled - fall back to existing auth
    if (!config.enabled) {
      logger.trace('UnifiedTokenAuth', 'Unified auth disabled, using legacy authentication');
      return await handleLegacyAuth(req, res, next);
    }

    // Determine authentication type based on request headers
    const authType = detectAuthType(req);
    
    logger.trace('UnifiedTokenAuth', 'Processing unified authentication', {
      authType,
      method: req.method,
      url: req.originalUrl,
      userAgent: req.headers['user-agent']?.substring(0, 50)
    });

    let validationResult: any = null;

    // Handle API key authentication
    if (authType === 'api_key') {
      const apiKey = extractApiKey(req);
      if (apiKey) {
        validationResult = await unifiedApiKeyValidationService.validateApiKey({
          apiKey,
          clientIp: getClientIp(req),
          userAgent: req.headers['user-agent'],
          method: req.method,
          endpoint: req.originalUrl || req.path,
          headers: sanitizeHeaders(req.headers)
        });
      }
    }
    
    // Handle AWS credential authentication
    else if (authType === 'aws_credential') {
      // For AWS SigV4, we need to delegate to existing AWS middleware for validation
      // since we can't extract the secret key from the signed request.
      // However, we can still extract metadata for unified auth processing.
      const awsCredentials = extractAwsCredentials(req);
      if (awsCredentials) {
        logger.trace('UnifiedTokenAuth', 'AWS credential auth detected, delegating to existing AWS middleware with unified processing');
        
        // Store AWS metadata for unified processing
        req.unifiedAuth = {
          authType: 'aws_credential',
          valid: false, // Will be set by AWS middleware
          data: {
            accessKeyId: awsCredentials.accessKeyId,
            region: awsCredentials.region,
            sessionToken: awsCredentials.sessionToken
          },
          token: awsCredentials.accessKeyId,
          auditInfo: {
            requestId: `aws-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            validationTime: Date.now() - startTime,
            cacheHit: false,
            source: 'aws_sigv4',
            responseTime: Date.now() - startTime
          }
        };
        
        // Delegate to existing AWS middleware for actual validation
        return await tokenBasedAwsAuth(req, res, next);
      }
    }

    // Process validation result
    if (validationResult && validationResult.valid) {
      // Set unified auth info
      req.unifiedAuth = {
        authType: validationResult.authType,
        valid: true,
        data: validationResult.data,
        token: validationResult.token,
        auditInfo: validationResult.auditInfo
      };

      // Maintain backward compatibility by setting legacy auth properties
      if (authType === 'api_key') {
        req.apiKey = {
          key: extractApiKey(req),
          ...validationResult.data
        };
        req.apiKeyInfo = {
          active: true,
          ...validationResult.data
        };
      }

      const responseTime = Date.now() - startTime;
      logger.trace('UnifiedTokenAuth', 'Unified authentication successful', {
        authType: validationResult.authType,
        source: validationResult.auditInfo.source,
        cacheHit: validationResult.auditInfo.cacheHit,
        responseTime,
        requestId: validationResult.auditInfo.requestId
      });

      return next();
    }

    // Authentication failed - emit security event and mark to prevent duplicates
    if (authType !== 'unknown') {
      // Set flag to prevent duplicate events from fallback auth
      (req as any).unifiedAuthAttempted = true;
      
      await securityEventEmitter.emitFailedAuth({
        credentialId: extractCredentialId(req, authType),
        authType,
        reason: validationResult?.error?.message || 'Authentication failed',
        clientIP: req.ip || req.connection.remoteAddress,
        userAgent: req.get('User-Agent'),
        endpoint: req.originalUrl,
        method: req.method,
        requestId: (req as any).debugRequestId,
        statusCode: 401
      });
    }

    // Authentication failed - try fallback if enabled
    if (config.fallbackToLocal) {
      logger.trace('UnifiedTokenAuth', 'Unified auth failed, trying legacy fallback');
      return await handleLegacyAuth(req, res, next);
    }

    // No fallback - return authentication error
    const responseTime = Date.now() - startTime;
    logger.warn('UnifiedTokenAuth', 'Unified authentication failed', {
      authType,
      responseTime,
      error: validationResult?.error
    });

    res.status(401).json({
      error: {
        message: validationResult?.error?.message || 'Authentication failed',
        type: 'authentication_error',
        code: validationResult?.error?.code || 'auth_failed',
        details: {
          authType,
          supportedTypes: ['api_key', 'aws_credential']
        }
      }
    });
    return;

  } catch (error) {
    const responseTime = Date.now() - startTime;
    logger.error('UnifiedTokenAuth', 'Unified authentication error', error instanceof Error ? error : new Error(String(error)), {
      responseTime,
      url: req.originalUrl
    });

    // On internal error, try fallback if enabled
    if (config.fallbackToLocal) {
      logger.trace('UnifiedTokenAuth', 'Error occurred, trying legacy fallback');
      return await handleLegacyAuth(req, res, next);
    }

    res.status(500).json({
      error: {
        message: 'Internal authentication error',
        type: 'server_error'
      }
    });
    return;
  }
};

/**
 * Extract credential ID for security event logging
 */
function extractCredentialId(req: Request, authType: 'api_key' | 'aws_credential'): string {
  if (authType === 'api_key') {
    return extractApiKey(req) || 'unknown';
  } else if (authType === 'aws_credential') {
    const authHeader = req.get('Authorization');
    if (authHeader && authHeader.startsWith('AWS4-HMAC-SHA256')) {
      const credentialMatch = authHeader.match(/Credential=([^\/]+)/);
      return credentialMatch ? credentialMatch[1] : 'unknown';
    }
  }
  return 'unknown';
}

/**
 * Detect authentication type from request headers
 */
function detectAuthType(req: Request): 'api_key' | 'aws_credential' | 'unknown' {
  // Check for API key indicators
  if (extractApiKey(req)) {
    return 'api_key';
  }

  // Check for AWS SigV4 indicators
  if (req.headers['x-amz-date'] && req.headers['authorization']) {
    const authHeader = req.headers['authorization'] as string;
    if (authHeader.includes('AWS4-HMAC-SHA256')) {
      return 'aws_credential';
    }
  }

  return 'unknown';
}

/**
 * Extract AWS credentials from request headers (SigV4)
 */
function extractAwsCredentials(req: Request): {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region?: string;
} | null {
  try {
    // Check for AWS SigV4 Authorization header
    const authHeader = req.headers['authorization'] as string;
    if (!authHeader || !authHeader.includes('AWS4-HMAC-SHA256')) {
      return null;
    }

    // Parse the AWS SigV4 authorization header
    // Format: AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20230301/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=...
    const credentialMatch = authHeader.match(/Credential=([^/]+)\/([^/]+)\/([^/]+)/);
    if (!credentialMatch) {
      return null;
    }

    const accessKeyId = credentialMatch[1];
    const region = credentialMatch[3];

    // For AWS SigV4, we don't have direct access to the secret key or session token
    // as they're used to compute the signature. However, we can extract the access key
    // and region, then use the existing AWS middleware for validation.
    
    // Check for session token in headers (X-Amz-Security-Token)
    const sessionToken = req.headers['x-amz-security-token'] as string;

    return {
      accessKeyId,
      secretAccessKey: '', // We'll need to handle this differently for SigV4
      sessionToken,
      region
    };

  } catch (error) {
    logger.debug('UnifiedTokenAuth', 'Failed to extract AWS credentials', {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

/**
 * Extract API key from various header locations
 */
function extractApiKey(req: Request): string | null {
  // Check standard API key headers
  let apiKey = req.headers['x-api-key'] || req.headers['x-stainless-key'] || req.query.api_key;
  
  // Handle array values
  if (Array.isArray(apiKey)) {
    apiKey = apiKey[0];
  }

  // Check Authorization header for Bearer tokens that look like API keys
  if (!apiKey && req.headers['authorization']) {
    const authHeader = req.headers['authorization'] as string;
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7).trim();
      if (token.startsWith('sk-')) {
        apiKey = token;
      }
    }
  }

  return apiKey as string || null;
}

/**
 * Get client IP address
 */
function getClientIp(req: Request): string {
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
         (req.headers['x-real-ip'] as string) ||
         req.connection?.remoteAddress ||
         req.socket?.remoteAddress ||
         '127.0.0.1';
}

/**
 * Sanitize headers for logging (remove sensitive data)
 */
function sanitizeHeaders(headers: any): Record<string, string> {
  const sanitized: Record<string, string> = {};
  
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    
    if (lowerKey.includes('authorization') || 
        lowerKey.includes('api-key') || 
        lowerKey.includes('x-api-key')) {
      sanitized[key] = '[REDACTED]';
    } else if (Array.isArray(value)) {
      sanitized[key] = value.join(', ');
    } else {
      sanitized[key] = String(value);
    }
  }
  
  return sanitized;
}

/**
 * Handle legacy authentication (fallback)
 */
async function handleLegacyAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authType = detectAuthType(req);
  
  if (authType === 'api_key') {
    return apiKeyAuth(req, res, next);
  } else if (authType === 'aws_credential') {
    return tokenBasedAwsAuth(req, res, next);
  } else {
    // Try API key auth as default fallback
    return apiKeyAuth(req, res, next);
  }
}

/**
 * Middleware factory for enabling/disabling unified auth
 */
export const createUnifiedTokenAuth = (options?: {
  enableUnifiedAuth?: boolean;
  fallbackToLegacy?: boolean;
}) => {
  return async (req: UnifiedAuthRequest, res: Response, next: NextFunction) => {
    const config = getCachedUnifiedAuthConfig();
    
    // Override config with options if provided
    if (options?.enableUnifiedAuth !== undefined) {
      config.enabled = options.enableUnifiedAuth;
    }
    if (options?.fallbackToLegacy !== undefined) {
      config.fallbackToLocal = options.fallbackToLegacy;
    }

    return unifiedTokenAuth(req, res, next);
  };
};

export default unifiedTokenAuth;
export { UnifiedAuthRequest };