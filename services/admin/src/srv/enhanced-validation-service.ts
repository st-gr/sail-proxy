const cds = require('@sap/cds');
import crypto from 'crypto';
import { performance } from 'perf_hooks';
import { 
  ValidationToken, 
  ValidationTokenUtils, 
  ValidationRequest as TokenValidationRequest,
  ValidationResponse as TokenValidationResponse,
  ValidationCache 
} from '@libs/aws-token-validation/validation-token';

interface ValidationRequest {
  data: {
    key?: string;
    accessKeyId?: string;
    signature?: string;
    stringToSign?: string;
    clientIp?: string;
    userAgent?: string;
    token?: string;
    validationToken?: ValidationToken;
    method?: string;
    endpoint?: string;
    headers?: Record<string, string>;
  };
  user?: { id: string };
}

class EnhancedValidationService {
  private cache: ValidationCache;
  private secretCache: Map<string, { secretKey: string; timestamp: number }> = new Map();
  private readonly SECRET_CACHE_TTL = 600000; // 10 minutes
  
  constructor() {
    this.cache = new ValidationCache();
  }

  init(service: any): void {
    // Register existing handlers
    service.on('validateApiKey', this.validateApiKey.bind(this));
    service.on('validateAwsCredentials', this.validateAwsCredentials.bind(this));
    
    // Register new token-based validation handlers
    service.on('validateAwsCredentialsByToken', this.validateAwsCredentialsByToken.bind(this));
    service.on('createValidationToken', this.createValidationToken.bind(this));
    service.on('validateTokenBasedRequest', this.validateTokenBasedRequest.bind(this));
    
    // Cache and monitoring
    service.on('getCacheStats', this.getCacheStats.bind(this));
    service.on('invalidateValidationCache', this.invalidateValidationCache.bind(this));
    service.on('health', this.health.bind(this));
  }

  // ========================================
  // Token-Based Validation (New)
  // ========================================

  async validateAwsCredentialsByToken(req: ValidationRequest): Promise<TokenValidationResponse> {
    const startTime = performance.now();
    const requestId = ValidationTokenUtils.generateRequestId();
    
    try {
      const { token, stringToSign, signature } = req.data;
      
      if (!token) {
        return ValidationTokenUtils.createErrorResponse(
          'MISSING_TOKEN',
          'Validation token is required',
          requestId
        );
      }

      // Verify and decode JWT token
      let validationToken: ValidationToken;
      try {
        const decoded = ValidationTokenUtils.verifyValidationJWT(token);
        validationToken = decoded;
      } catch (error) {
        return ValidationTokenUtils.createErrorResponse(
          'INVALID_TOKEN',
          'Invalid or expired validation token',
          requestId,
          { error: (error as Error).message }
        );
      }

      // Check if token is expired
      if (ValidationTokenUtils.isTokenExpired(validationToken)) {
        return ValidationTokenUtils.createErrorResponse(
          'TOKEN_EXPIRED',
          'Validation token has expired',
          requestId
        );
      }

      // Check cache first
      const cacheKey = ValidationTokenUtils.createCacheKey(
        validationToken.accessKeyId,
        validationToken.signatureHash
      );
      
      const cachedResult = this.cache.get(cacheKey);
      if (cachedResult) {
        cachedResult.auditInfo.cacheHit = true;
        cachedResult.auditInfo.validationTime = performance.now() - startTime;
        return cachedResult;
      }

      // Validate signature hash matches
      const currentSignatureHash = crypto
        .createHash('sha256')
        .update(signature || '')
        .digest('hex');
      
      if (currentSignatureHash !== validationToken.signatureHash) {
        return ValidationTokenUtils.createErrorResponse(
          'SIGNATURE_MISMATCH',
          'Signature hash does not match token',
          requestId
        );
      }

      // Lookup credential in database
      const credentialRecord = await this.lookupAwsCredential(validationToken.accessKeyId);
      
      if (!credentialRecord) {
        return ValidationTokenUtils.createErrorResponse(
          'CREDENTIAL_NOT_FOUND',
          'AWS credential not found or inactive',
          requestId
        );
      }

      // Check expiration
      if (credentialRecord.expiresAt && new Date(credentialRecord.expiresAt) < new Date()) {
        return ValidationTokenUtils.createErrorResponse(
          'CREDENTIAL_EXPIRED',
          'AWS credential has expired',
          requestId
        );
      }

      // Get secret key for signature validation
      const secretKey = await this.getSecretKey(credentialRecord);
      
      // Validate AWS signature
      const isValidSignature = stringToSign && signature ? 
        this.validateAwsSignature(secretKey, signature, stringToSign) : false;

      // Check IP restrictions
      const ipAllowed = await this.checkIpRestrictions(
        credentialRecord.ID,
        validationToken.requestMetadata.clientIp
      );

      const validationResult: TokenValidationResponse = {
        valid: isValidSignature && ipAllowed,
        credentialMetadata: isValidSignature ? {
          credentialId: credentialRecord.ID,
          permissions: credentialRecord.permissions || [],
          region: credentialRecord.region,
          sapAiRegion: credentialRecord.sapAiRegion,
          userId: credentialRecord.userId,
          rateLimits: {
            requestsPerMinute: 60,
            requestsPerHour: 1000,
            requestsPerDay: 10000
          },
          ipRestrictions: credentialRecord.ipRestrictions
        } : undefined,
        validationToken: token,
        auditInfo: {
          requestId,
          validationTime: performance.now() - startTime,
          cacheHit: false,
          ipAllowed,
          signatureValid: isValidSignature
        }
      };

      // Cache the result
      this.cache.set(cacheKey, validationResult, 300000); // 5 minutes

      // Log usage if successful
      if (isValidSignature && ipAllowed) {
        this.logValidationEvent(credentialRecord.ID, validationToken, true);
      } else {
        this.logValidationEvent(credentialRecord.ID, validationToken, false, {
          reason: !isValidSignature ? 'invalid_signature' : 'ip_blocked'
        });
      }

      return validationResult;

    } catch (error) {
      console.error('Token-based validation error:', error);
      return ValidationTokenUtils.createErrorResponse(
        'VALIDATION_ERROR',
        'Internal validation error',
        requestId,
        { error: (error as Error).message }
      );
    }
  }

  async createValidationToken(req: ValidationRequest): Promise<{
    token: string;
    expiresAt: number;
    requestId: string;
  }> {
    const { accessKeyId, signature, clientIp, method, endpoint, headers } = req.data;
    
    if (!accessKeyId || !signature) {
      throw new Error('AccessKeyId and signature are required');
    }

    const requestId = ValidationTokenUtils.generateRequestId();
    const requestMetadata = {
      timestamp: Date.now(),
      clientIp: clientIp || 'unknown',
      endpoint: endpoint || '',
      method: method || 'POST',
      headers: headers || {}
    };

    const validationToken = ValidationTokenUtils.createValidationToken(
      accessKeyId,
      signature,
      requestMetadata
    );

    const jwt = ValidationTokenUtils.createValidationJWT(validationToken, requestId);

    return {
      token: jwt,
      expiresAt: validationToken.expiresAt,
      requestId
    };
  }

  async validateTokenBasedRequest(req: ValidationRequest): Promise<{
    valid: boolean;
    credentialInfo?: any;
    error?: string;
  }> {
    try {
      const response = await this.validateAwsCredentialsByToken(req);
      
      return {
        valid: response.valid,
        credentialInfo: response.credentialMetadata,
        error: response.error?.message
      };
    } catch (error) {
      return {
        valid: false,
        error: (error as Error).message
      };
    }
  }

  // ========================================
  // Enhanced Helper Methods
  // ========================================

  private async lookupAwsCredential(accessKeyId: string): Promise<any> {
    try {
      const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.AwsCredentials', (c: any) => {
        c.ID, c.userId, c.name, c.isActive, c.secretAccessKey, c.secretHash, c.salt,
        c.region, c.sapAiRegion, c.expiresAt, c.lastUsed,
        c.permissions((p: any) => {
          p.service, p.action, p.resource, p.effect
        }),
        c.ipRestrictions((i: any) => {
          i.ipAddress, i.ipRange, i.isAllowed, i.isActive
        })
      }).where({ accessKeyId, isActive: true });

      const results = await cds.run(SELECT);
      return results.length > 0 ? results[0] : null;
    } catch (error) {
      console.error('Error looking up AWS credential:', error);
      return null;
    }
  }

  private async getSecretKey(credentialRecord: any): Promise<string> {
    const cacheKey = `secret:${credentialRecord.ID}`;
    const cached = this.secretCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.SECRET_CACHE_TTL) {
      return cached.secretKey;
    }

    let secretKey: string;
    
    if (credentialRecord.secretAccessKey) {
      // If stored encrypted, decrypt it
      secretKey = this.decryptSecret(credentialRecord.secretAccessKey);
    } else if (credentialRecord.secretHash && credentialRecord.salt) {
      // Derive from hash and salt (simplified - use proper key derivation in production)
      secretKey = this.deriveSecretKey(credentialRecord.secretHash, credentialRecord.salt);
    } else {
      throw new Error('No secret key available for credential');
    }

    // Cache the secret key
    this.secretCache.set(cacheKey, {
      secretKey,
      timestamp: Date.now()
    });

    return secretKey;
  }

  private decryptSecret(encryptedSecret: string): string {
    try {
      const key = this.getEncryptionKey();
      const decipher = crypto.createDecipher('aes-256-cbc', key);
      let decrypted = decipher.update(encryptedSecret, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (error) {
      throw new Error('Failed to decrypt secret key');
    }
  }

  private deriveSecretKey(secretHash: string, salt: string): string {
    // Simplified secret derivation - implement proper key derivation in production
    return crypto
      .createHmac('sha256', salt)
      .update(secretHash)
      .digest('hex');
  }

  private getEncryptionKey(): string {
    return process.env.AWS_SECRET_ENCRYPTION_KEY || 'default-dev-key-not-for-production-use-12345';
  }

  private validateAwsSignature(secretKey: string, providedSignature: string, stringToSign: string): boolean {
    try {
      const expectedSignature = crypto
        .createHmac('sha256', secretKey)
        .update(stringToSign)
        .digest('hex');
      
      return crypto.timingSafeEqual(
        Buffer.from(providedSignature.toLowerCase()),
        Buffer.from(expectedSignature.toLowerCase())
      );
    } catch (error) {
      console.error('Signature validation error:', error);
      return false;
    }
  }

  private async checkIpRestrictions(credentialId: string, clientIp: string): Promise<boolean> {
    try {
      const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.AwsCredentialIPRestrictions')
        .where({ credential_ID: credentialId, isActive: true });
      
      const restrictions = await cds.run(SELECT);
      
      if (restrictions.length === 0) {
        return true; // No restrictions = allowed
      }

      // Check if IP matches any restriction
      for (const restriction of restrictions) {
        if (this.matchesIpRule(clientIp, restriction)) {
          return restriction.isAllowed;
        }
      }

      return false; // Default deny if restrictions exist but no match
    } catch (error) {
      console.error('IP restriction check error:', error);
      return false;
    }
  }

  private matchesIpRule(clientIp: string, restriction: any): boolean {
    if (restriction.ipAddress === clientIp) return true;
    
    if (restriction.ipRange) {
      // Simplified CIDR matching
      const [network, prefixLength] = restriction.ipRange.split('/');
      if (clientIp.startsWith(network.split('.').slice(0, parseInt(prefixLength) / 8).join('.'))) {
        return true;
      }
    }
    
    return false;
  }

  private async logValidationEvent(
    credentialId: string,
    validationToken: ValidationToken,
    success: boolean,
    details?: any
  ): Promise<void> {
    setTimeout(async () => {
      try {
        const INSERT = cds.ql.INSERT.into('sap.llm.gateway.admin.AwsCredentialUsage').entries({
          credential_ID: credentialId,
          endpoint: validationToken.requestMetadata.endpoint,
          method: validationToken.requestMetadata.method,
          statusCode: success ? 200 : 403,
          clientIP: validationToken.requestMetadata.clientIp,
          userAgent: validationToken.requestMetadata.headers['user-agent'] || '',
          requestId: validationToken.challengeNonce,
          validationSuccess: success,
          validationDetails: JSON.stringify(details || {})
        });
        await cds.run(INSERT);
      } catch (error) {
        console.error('Failed to log validation event:', error);
      }
    }, 0);
  }

  // ========================================
  // Legacy Methods (Maintained for compatibility)
  // ========================================

  async validateApiKey(req: ValidationRequest): Promise<any> {
    // Existing implementation remains the same
    const { key } = req.data;
    if (!key) {
      throw new Error('API key is required');
    }
    
    const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.ApiKeys')
      .where({ key, isActive: true });
    
    const results = await cds.run(SELECT);
    
    return {
      valid: results.length > 0,
      keyInfo: results.length > 0 ? results[0] : null
    };
  }

  async validateAwsCredentials(req: ValidationRequest): Promise<any> {
    // Existing implementation for backward compatibility
    const { accessKeyId, signature, stringToSign } = req.data;
    
    if (!accessKeyId) {
      throw new Error('Access key ID is required');
    }

    const credentialRecord = await this.lookupAwsCredential(accessKeyId);
    
    if (!credentialRecord) {
      return { valid: false, error: 'Credential not found' };
    }

    const secretKey = await this.getSecretKey(credentialRecord);
    const isValidSignature = signature && stringToSign ? 
      this.validateAwsSignature(secretKey, signature, stringToSign) : false;

    return {
      valid: isValidSignature,
      credentialInfo: isValidSignature ? credentialRecord : null
    };
  }

  // ========================================
  // Cache and Monitoring
  // ========================================

  async getCacheStats(): Promise<any> {
    const cacheStats = this.cache.getStats();
    const secretCacheSize = this.secretCache.size;
    
    return {
      validationCache: cacheStats,
      secretCache: {
        size: secretCacheSize,
        ttl: this.SECRET_CACHE_TTL
      },
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage()
    };
  }

  async invalidateValidationCache(req: ValidationRequest): Promise<{ cleared: boolean; stats: any }> {
    const statsBefore = this.cache.getStats();
    this.cache.clear();
    this.secretCache.clear();
    const statsAfter = this.cache.getStats();
    
    return {
      cleared: true,
      stats: {
        before: statsBefore,
        after: statsAfter
      }
    };
  }

  async health(): Promise<{
    status: string;
    services: {
      database: string;
      cache: string;
      validation: string;
    };
    timestamp: string;
  }> {
    try {
      // Test database connection
      await cds.run(cds.ql.SELECT.one.from('sap.llm.gateway.admin.AwsCredentials').limit(1));
      
      return {
        status: 'healthy',
        services: {
          database: 'healthy',
          cache: 'healthy',
          validation: 'healthy'
        },
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        services: {
          database: 'unhealthy',
          cache: 'healthy',
          validation: 'degraded'
        },
        timestamp: new Date().toISOString()
      };
    }
  }

  destroy(): void {
    if (this.cache) {
      this.cache.destroy();
    }
    this.secretCache.clear();
  }
}

// Export the enhanced service
const enhancedValidationService = new EnhancedValidationService();

module.exports = (srv: any) => {
  enhancedValidationService.init(srv);
  return enhancedValidationService;
};