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
import { credentialIdentity, resolvedCredentialIdentity } from '../utils/credentialIdentity';
import { getDefaultLogger } from '@libs/logger';
import { redactUrl } from '../utils/redactUrl';
import { secretLabel } from '../utils/secretLabel';
import { getClientIp } from '../utils/clientIp';
import { getTrustForwardedFor } from '../services/configService';
import type { EntitlementBlock, UserBlock, TeamBlock } from '../clients/adminServiceClient';
import type { ToolPolicyBlock } from '../toolGovernance/identity';
import {
  isAwsSigV4Request,
  isAmzDateFresh,
  parseSigV4AuthHeader,
  signingScopesFor,
  verifySigV4Request,
  ParsedSigV4Header as ParsedAuthHeader,
  SigningKeyProvider
} from '../utils/sigv4Verifier';
import { adminSigningKeyProvider, localSigningKeyProvider } from '../services/awsSigningKeyProviders';
const logger = getDefaultLogger();

/**
 * Where the signing key for a validated request comes from: the admin service, or the
 * local credential store (standalone mode and the local fallback).
 */
interface SigningKeyProviders {
  admin: SigningKeyProvider;
  local: SigningKeyProvider;
}

type SourcedValidationResponse = TokenValidationResponse & { keySource?: keyof SigningKeyProviders };

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
    entitlement?: EntitlementBlock;
    user?: UserBlock;
    team?: TeamBlock;
    teamToolPolicy?: ToolPolicyBlock;
    rateLimits?: { requestsPerMinute: number | null; requestsPerHour: number | null; requestsPerDay: number | null };
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
  private signingKeyProviders: SigningKeyProviders;

  constructor(signingKeyProviders: SigningKeyProviders = { admin: adminSigningKeyProvider, local: localSigningKeyProvider }) {
    this.signingKeyProviders = signingKeyProviders;
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
      if (!isAwsSigV4Request(authHeader)) {
        logger.trace('TokenBasedAwsAuth', 'No AWS SigV4 authorization header found, skipping');
        return next();
      }

      // Parse authorization header
      const parsed = parseSigV4AuthHeader(authHeader);
      if (!parsed) {
        logger.warn('TokenBasedAwsAuth', 'Invalid AWS authorization header format');
        return this.respondWithError(res, 401, 'INVALID_AUTH_HEADER', 'Invalid authorization header format');
      }

      logger.info('TokenBasedAwsAuth', `Processing AWS SigV4 request for access key: ${secretLabel(parsed.accessKeyId)}`);

      // A missing or stale x-amz-date is rejected before any credential lookup. A replay of an
      // old request is what the owner should hear about, so the event (only) names the credential:
      // resolved after the 401 is written, so the client never waits for the lookup.
      if (!isAmzDateFresh(req.headers['x-amz-date'])) {
        const reason = 'Request date missing or outside the allowed clock skew';
        logger.warn('TokenBasedAwsAuth', `Authentication failed for ${secretLabel(parsed.accessKeyId)}: ${reason}`);
        this.respondWithError(res, 401, 'INVALID_REQUEST_DATE', reason);
        try {
          await this.emitFailedAuth(req, parsed.accessKeyId, reason, requestId, 401, await this.resolveCredentialIdForEvent(req, parsed));
        } catch (error) {
          logger.warn('TokenBasedAwsAuth', `Failed-auth event for a refused request date not emitted: ${(error as Error).message}`);
        }
        return;
      }

      // Check cache first. A hit only says the credential exists; the signature is
      // verified below on every path.
      const signatureHash = crypto.createHash('sha256').update(parsed.signature).digest('hex');
      const cacheKey = ValidationTokenUtils.createCacheKey(parsed.accessKeyId, signatureHash);
      
      let validationResult = this.validationCache.get(cacheKey) as SourcedValidationResponse | null;
      let cacheHit = false;
      // Set when the admin refused a credential that exists (disabled/expired): its row ID.
      let refusedCredentialId: string | undefined;

      if (validationResult && validationResult.valid) {
        logger.info('TokenBasedAwsAuth', `Cache hit for access key: ${secretLabel(parsed.accessKeyId)}`);
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
            headers: this.sanitizeHeaders(req.headers),
            // The admin returns the signing keys for these with the validation
            signingScopes: signingScopesFor({ date: parsed.date, region: parsed.region, service: parsed.service })
          };
          
          const unifiedResult = await unifiedAwsCredentialValidationService.validateAwsCredential(unifiedRequest);
          
          if (unifiedResult.valid && unifiedResult.data) {
            // Convert unified result to legacy format for compatibility
            validationResult = {
              valid: true,
              // Where the credential was validated, also for a cache hit (never guessed from 'cache')
              keySource: unifiedResult.keySource === 'local' ? 'local' : 'admin',
              credentialMetadata: {
                credentialId: unifiedResult.data.credentialId,
                permissions: unifiedResult.data.permissions || [],
                region: unifiedResult.data.region,
                sapAiRegion: unifiedResult.data.sapAiRegion,
                userId: unifiedResult.data.userId,
                rateLimits: unifiedResult.data.rateLimits,
                entitlement: unifiedResult.data.entitlement,
                user: unifiedResult.data.user,
                team: unifiedResult.data.team,
                teamToolPolicy: unifiedResult.data.teamToolPolicy
              },
              validationToken: '',
              auditInfo: {
                requestId: unifiedResult.auditInfo.requestId,
                validationTime: unifiedResult.auditInfo.validationTime,
                cacheHit: unifiedResult.auditInfo.cacheHit,
                ipAllowed: true,
                // Not checked here: the signature is verified after validation, on every path.
                signatureValid: false
              }
            };
          } else {
            refusedCredentialId = unifiedResult.error?.credentialId;
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
            validationResult = await this.fallbackLocalValidation(parsed);
          } else {
            return this.respondWithError(res, 503, 'VALIDATION_SERVICE_UNAVAILABLE', 'Credential validation service unavailable');
          }
        }
      }

      // Handle validation result
      if (!validationResult || !validationResult.valid) {
        const errorCode = validationResult?.error?.code || 'INVALID_CREDENTIALS';
        const errorMessage = validationResult?.error?.message || 'Invalid AWS credentials';
        
        logger.warn('TokenBasedAwsAuth', `Authentication failed for ${secretLabel(parsed.accessKeyId)}: ${errorMessage}`);
        await this.emitFailedAuth(req, parsed.accessKeyId, errorMessage, requestId, 403, refusedCredentialId);
        return this.respondWithError(res, 403, errorCode, errorMessage);
      }

      // Verify the signature with a signing key from the source that validated the credential.
      const keyProvider = this.signingKeyProviders[validationResult.keySource ?? 'admin'];
      if (!(await verifySigV4Request(req, parsed, keyProvider))) {
        const reason = 'Invalid AWS signature';
        logger.warn('TokenBasedAwsAuth', `Authentication failed for ${secretLabel(parsed.accessKeyId)}: ${reason}`);
        await this.emitFailedAuth(req, parsed.accessKeyId, reason, requestId, 403, validationResult.credentialMetadata?.credentialId);
        return this.respondWithError(res, 403, 'INVALID_SIGNATURE', reason);
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
        credentialId: validationResult.credentialMetadata?.credentialId,
        entitlement: validationResult.credentialMetadata?.entitlement,
        user: validationResult.credentialMetadata?.user,
        team: validationResult.credentialMetadata?.team,
        teamToolPolicy: validationResult.credentialMetadata?.teamToolPolicy,
        rateLimits: validationResult.credentialMetadata?.rateLimits
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
          credentialId: validationResult.credentialMetadata?.credentialId,
          entitlement: validationResult.credentialMetadata?.entitlement,
          user: validationResult.credentialMetadata?.user,
          team: validationResult.credentialMetadata?.team,
          teamToolPolicy: validationResult.credentialMetadata?.teamToolPolicy,
          rateLimits: validationResult.credentialMetadata?.rateLimits
        };
        (req as any).unifiedAuth.auditInfo.validationTime = Date.now() - startTime;
        (req as any).unifiedAuth.auditInfo.cacheHit = cacheHit;
      }

      // Log successful authentication
      logger.info('TokenBasedAwsAuth', `Successfully authenticated AWS request for ${secretLabel(parsed.accessKeyId)} (${Date.now() - startTime}ms)`);
      
      // Update usage statistics asynchronously
      this.updateUsageStats(validationResult.credentialMetadata?.credentialId, req);
      
      next();

    } catch (error) {
      logger.error('TokenBasedAwsAuth', `Authentication error: ${(error as Error).message}`);
      return this.respondWithError(res, 500, 'INTERNAL_ERROR', 'Internal authentication error');
    }
  }

  // Old validateWithAdminService method removed - now using unified AWS credential validation service

  /**
   * Fallback to local validation (for development/emergency)
   */
  private async fallbackLocalValidation(
    parsed: ParsedAuthHeader
  ): Promise<SourcedValidationResponse> {
    try {
      // Import local AWS credentials service
      const { findAwsCredential } = require('../services/awsCredentialsService');
      
      const credential = await findAwsCredential(parsed.accessKeyId);
      if (!credential) {
        return ValidationTokenUtils.createErrorResponse(
          'CREDENTIAL_NOT_FOUND',
          'AWS credential not found',
          ValidationTokenUtils.generateRequestId()
        );
      }

      // The signature is verified by authenticate() with the local signing-key provider.
      return {
        valid: true,
        keySource: 'local',
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
          signatureValid: false
        }
      };
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
   * The credential ID for the failed-auth event of a request refused before validation, through
   * the unified validation (no signing keys). Undefined for an unknown key id, and when the lookup
   * fails: the client's response never depends on it.
   */
  private async resolveCredentialIdForEvent(req: Request, parsed: ParsedAuthHeader): Promise<string | undefined> {
    try {
      const { unifiedAwsCredentialValidationService } = require('../services/unifiedAwsCredentialValidationService');
      return await unifiedAwsCredentialValidationService.resolveCredentialId({
        accessKeyId: parsed.accessKeyId,
        signature: parsed.signature,
        clientIp: this.getClientIp(req),
        userAgent: req.headers['user-agent'] as string,
        method: req.method,
        endpoint: req.path,
        headers: this.sanitizeHeaders(req.headers)
      });
    } catch (error) {
      logger.debug('TokenBasedAwsAuth', `Credential lookup for the failed-auth event failed: ${(error as Error).message}`);
      return undefined;
    }
  }

  /**
   * Helper methods
   */
  // Emit security event using SecurityEventEmitter. accessKeyId is a public
  // identifier by AWS design, but when the lookup failed it is an unresolved
  // credential — hash + hint it the same as an unresolved API key, for consistency
  // (see utils/credentialIdentity.ts). When the credential resolved (a later check
  // failed, or the admin refused it as disabled/expired), its row ID replaces the hash
  // (and the material), so the admin links the event to the credential and notifies its
  // owner; the hint still shows which access key id was presented.
  private async emitFailedAuth(req: Request, accessKeyId: string, reason: string, requestId: string, statusCode: number, resolvedCredentialId?: string): Promise<void> {
    await securityEventEmitter.emitFailedAuth({
      ...(resolvedCredentialId ? resolvedCredentialIdentity(accessKeyId, resolvedCredentialId) : credentialIdentity(accessKeyId)),
      authType: 'aws_credential',
      reason,
      clientIP: this.getClientIp(req),
      userAgent: req.headers['user-agent'] || 'unknown',
      endpoint: redactUrl(req.originalUrl),
      method: req.method,
      requestId,
      statusCode
    });
  }

  // Delegates to utils/clientIp's single derivation, gated on the
  // `security.trust_forwarded_for` config flag.
  private getClientIp(req: Request): string {
    return getClientIp(req, getTrustForwardedFor());
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