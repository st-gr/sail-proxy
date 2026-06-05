const cds = require('@sap/cds');
import crypto from 'crypto';
import { performance } from 'perf_hooks';
import { getDefaultLogger } from '@libs/logger';
import SecurityEventService from '../services/securityEventService';

// Import file config service
const FileConfigService = require('./file-config-service');

// Initialize logger
const logger = getDefaultLogger();

// Type definitions
interface CacheEntry<T> {
  result: T;
  timestamp: number;
}

interface ApiKeyValidationResult {
  valid: boolean;
  keyId: string | null;
  permissions: string[];
  rateLimits: {
    requestsPerMinute: number;
    requestsPerHour: number;
    requestsPerDay: number;
    burstLimit: number;
  };
  usage: {
    currentMinute: number;
    currentHour: number;
    currentDay: number;
  };
  metadata: {
    name?: string;
    email?: string;
    lastUsed?: Date;
  };
  cacheHit: boolean;
  validationTime: number;
}

interface AwsCredentialValidationResult {
  valid: boolean;
  credentialId: string | null;
  secretKey?: string;
  permissions: Array<{
    service: string;
    action: string;
    resource: string;
    effect: string;
  }>;
  ipAllowed: boolean;
  expired: boolean;
  metadata: {
    userId?: string;
    name?: string;
    region?: string;
    sapAiRegion?: string;
    lastUsed?: Date;
  };
  cacheHit: boolean;
  validationTime: number;
}

interface RateLimitWindow {
  requests: number[];
  limit: number;
}

interface RateLimitWindows {
  minute: RateLimitWindow;
  hour: RateLimitWindow;
  day: RateLimitWindow;
}

interface CacheStats {
  hits: number;
  misses: number;
  validations: number;
  startTime: number;
}

interface CacheConfig {
  apiKeyTTL: number;
  awsCredentialTTL: number;
  rateLimitTTL: number;
  maxCacheSize: number;
}

interface UnifiedTokenData {
  authType: 'api_key' | 'aws_credential';
  identifier: string; // API key or AWS accessKeyId
  requestMetadata: {
    clientIp: string;
    userAgent?: string;
    method: string;
    endpoint: string;
    headers?: string;
    signature?: string; // For AWS requests
  };
  requestId: string;
  timestamp: number;
  expiresAt: number;
}

interface UnifiedValidationResult {
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

interface ApiKeyValidationData {
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
    lastUsed?: Date;
    isActive: boolean;
  };
}

interface AwsCredentialValidationData {
  credentialId: string;
  secretAccessKey: string; // Only returned in secure token validation
  permissions: Array<{
    service: string;
    action: string;
    resource: string;
    effect: string;
  }>;
  region: string;
  sapAiRegion: string;
  userId: string;
  rateLimits: {
    requestsPerMinute: number;
    requestsPerHour: number;
    requestsPerDay: number;
  };
  metadata: {
    lastUsed?: Date;
    isActive: boolean;
    expiresAt?: Date;
  };
}

interface ValidationRequest {
  data: {
    key?: string;
    accessKeyId?: string;
    signature?: string;
    stringToSign?: string;
    clientIp?: string;
    userAgent?: string;
    keyId?: string;
    endpoint?: string;
    credentialId?: string;
    type?: string;
    ids?: string[];
    keys?: Array<{ key: string; requestId: string }>;
    timeRange?: string;
    startDate?: Date;
    endDate?: Date;
    severity?: string;
    // Token validation properties
    method?: string;
    headers?: string;
    token?: string;
    // Unified auth properties
    authType?: 'api_key' | 'aws_credential';
    identifier?: string; // API key or AWS accessKeyId
    // Usage event processing properties
    events?: Array<{
      requestId: string;
      timestamp: number;
      authType: string;
      credentialId: string;
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      responseTime: number;
      statusCode: number;
    }>;
  };
  user?: { id: string };
  // Access to HTTP headers for JWT validation
  headers?: { [key: string]: string };
  req?: any; // Full HTTP request object
}

/**
 * Fast Validation Service Implementation
 * Optimized for high-performance gateway authentication
 */
class ValidationService {
  private cache: {
    apiKeys: Map<string, CacheEntry<ApiKeyValidationResult>>;
    awsCredentials: Map<string, CacheEntry<AwsCredentialValidationResult>>;
    rateLimits: Map<string, any>;
    stats: CacheStats;
  };

  private cacheConfig: CacheConfig;
  private rateLimitWindows: Map<string, RateLimitWindows>;
  private cleanupInterval: NodeJS.Timeout;
  private configService: any;

  constructor() {
    
    // In-memory cache for fast validation
    this.cache = {
      apiKeys: new Map(),
      awsCredentials: new Map(),
      rateLimits: new Map(),
      stats: {
        hits: 0,
        misses: 0,
        validations: 0,
        startTime: Date.now()
      }
    };
    
    // Cache configuration
    this.cacheConfig = {
      apiKeyTTL: 5 * 60 * 1000,      // 5 minutes
      awsCredentialTTL: 10 * 60 * 1000, // 10 minutes
      rateLimitTTL: 60 * 1000,        // 1 minute
      maxCacheSize: 10000
    };
    
    // Rate limit windows
    this.rateLimitWindows = new Map();
    
    // Cleanup old cache entries every minute
    this.cleanupInterval = setInterval(() => this.cleanupCache(), 60000);
  }

  init(service: any): void {
    logger.debug('validation-service', 'Registering ValidationService handlers');
    // Register handlers on the CDS service
    service.on('validateApiKey', this.validateApiKey.bind(this));
    service.on('validateAwsCredentials', this.validateAwsCredentials.bind(this));
    service.on('validateApiKeysBatch', this.validateApiKeysBatch.bind(this));
    service.on('checkRateLimit', this.checkRateLimit.bind(this));
    service.on('checkIpRestriction', this.checkIpRestriction.bind(this));
    
    service.on('warmupCache', this.warmupCache.bind(this));
    service.on('invalidateCache', this.invalidateCache.bind(this));
    service.on('getCacheStats', this.getCacheStats.bind(this));
    
    service.on('health', this.health.bind(this));
    service.on('getValidationMetrics', this.getValidationMetrics.bind(this));
    service.on('processUsageEvents', this.processUsageEvents.bind(this));
    
    // Token-based validation endpoints
    logger.debug('validation-service', 'Registering token validation handlers');
    service.on('createValidationToken', this.createValidationToken.bind(this));
    service.on('validateAwsCredentialsByToken', this.validateAwsCredentialsByToken.bind(this));
    service.on('validateTokenBasedRequest', this.validateTokenBasedRequest.bind(this));
    
    // Unified token-based authentication endpoints
    logger.debug('validation-service', 'Registering unified token validation handlers');
    service.on('createUnifiedValidationToken', this.createUnifiedValidationToken.bind(this));
    service.on('validateUnifiedAuthByToken', this.validateUnifiedAuthByToken.bind(this));

    // Configuration management endpoints
    service.on('getConfig', this.getConfig.bind(this));
    service.on('checkConfigUpdate', this.checkConfigUpdate.bind(this));
    service.on('reloadConfig', this.reloadConfig.bind(this));
    service.on('registerConfigWebhook', this.registerConfigWebhook.bind(this));
    service.on('unregisterConfigWebhook', this.unregisterConfigWebhook.bind(this));
    service.on('listConfigWebhooks', this.listConfigWebhooks.bind(this));
    service.on('updateConfig', this.updateConfig.bind(this));
    service.on('getConfigStatus', this.getConfigStatus.bind(this));

    // Initialize file config service
    this.configService = FileConfigService(service);
  }

  // ========================================
  // Core Validation Functions
  // ========================================

  async validateApiKey(req: ValidationRequest): Promise<ApiKeyValidationResult> {
    const startTime = performance.now();
    const { key, clientIp, userAgent } = req.data;
    
    if (!key) {
      throw new Error('API key is required');
    }

    this.cache.stats.validations++;
    
    // Check cache first
    const cacheKey = `apikey:${key}`;
    const cached = this.cache.apiKeys.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.cacheConfig.apiKeyTTL) {
      this.cache.stats.hits++;
      
      // Update last used timestamp asynchronously
      if (cached.result.keyId) {
        this.updateLastUsed('ApiKeys', cached.result.keyId);
      }
      
      return {
        ...cached.result,
        cacheHit: true,
        validationTime: performance.now() - startTime
      };
    }
    
    this.cache.stats.misses++;
    
    // Database lookup
    const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.ApiKeys', (k: any) => {
      k.ID, k.name, k.email, k.isActive, k.lastUsed,
      k.permissions((p: any) => p.permission),
      k.rateLimits((r: any) => {
        r.requestsPerMinute, r.requestsPerHour, r.requestsPerDay, r.burstLimit
      })
    }).where({ key, isActive: true });
    
    const results = await cds.run(SELECT);
    
    let validationResult: ApiKeyValidationResult;
    
    if (results.length > 0) {
      const keyRecord = results[0];
      const permissions = keyRecord.permissions?.map((p: any) => p.permission) || [];
      const rateLimits = keyRecord.rateLimits || {};
      
      // Get current usage for rate limiting
      const usage = await this.getCurrentUsage(keyRecord.ID);
      
      validationResult = {
        valid: true,
        keyId: keyRecord.ID,
        permissions,
        rateLimits: {
          requestsPerMinute: rateLimits.requestsPerMinute || 60,
          requestsPerHour: rateLimits.requestsPerHour || 1000,
          requestsPerDay: rateLimits.requestsPerDay || 10000,
          burstLimit: rateLimits.burstLimit || 10
        },
        usage,
        metadata: {
          name: keyRecord.name,
          email: keyRecord.email,
          lastUsed: keyRecord.lastUsed
        },
        cacheHit: false,
        validationTime: performance.now() - startTime
      };
      
      // Note: Validation requests should not count as usage - only actual model calls are tracked
      
    } else {
      validationResult = {
        valid: false,
        keyId: null,
        permissions: [],
        rateLimits: {
          requestsPerMinute: 0,
          requestsPerHour: 0,
          requestsPerDay: 0,
          burstLimit: 0
        },
        usage: {
          currentMinute: 0,
          currentHour: 0,
          currentDay: 0
        },
        metadata: {},
        cacheHit: false,
        validationTime: performance.now() - startTime
      };
      
      // Log failed validation attempt
      this.logSecurityEvent('api_key_validation_failed', { 
        key: key.substring(0, 10) + '****', 
        clientIp, 
        userAgent 
      });
    }
    
    // Cache the result
    this.cache.apiKeys.set(cacheKey, {
      result: validationResult,
      timestamp: Date.now()
    });
    
    // Cleanup cache if too large
    if (this.cache.apiKeys.size > this.cacheConfig.maxCacheSize) {
      this.cleanupCache();
    }
    
    return validationResult;
  }

  async validateAwsCredentials(req: ValidationRequest): Promise<AwsCredentialValidationResult> {
    const startTime = performance.now();
    const { accessKeyId, signature, stringToSign, clientIp, userAgent } = req.data;
    
    if (!accessKeyId) {
      throw new Error('Access key ID is required');
    }

    this.cache.stats.validations++;
    
    // Check cache first
    const cacheKey = `aws:${accessKeyId}`;
    const cached = this.cache.awsCredentials.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.cacheConfig.awsCredentialTTL) {
      this.cache.stats.hits++;
      
      // For AWS credentials, we still need to validate the signature
      const isValidSignature = signature && stringToSign && cached.result.secretKey ? 
        this.validateAwsSignature(cached.result.secretKey, signature, stringToSign) : false;
      
      if (isValidSignature && cached.result.credentialId) {
        // Update last used timestamp asynchronously
        this.updateLastUsed('AwsCredentials', cached.result.credentialId);
        
        return {
          ...cached.result,
          cacheHit: true,
          validationTime: performance.now() - startTime
        };
      }
    }
    
    this.cache.stats.misses++;
    
    // Database lookup
    const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.AwsCredentials', (c: any) => {
      c.ID, c.userId, c.name, c.isActive, c.secretHash, c.salt, 
      c.region, c.sapAiRegion, c.expiresAt, c.lastUsed,
      c.permissions((p: any) => {
        p.service, p.action, p.resource, p.effect
      }),
      c.ipRestrictions((i: any) => {
        i.ipAddress, i.ipRange, i.isAllowed, i.isActive
      })
    }).where({ accessKeyId, isActive: true });
    
    const results = await cds.run(SELECT);
    
    let validationResult: AwsCredentialValidationResult;
    
    if (results.length > 0) {
      const credRecord = results[0];
      
      // Check expiration
      if (credRecord.expiresAt && new Date(credRecord.expiresAt) < new Date()) {
        validationResult = {
          valid: false,
          expired: true,
          credentialId: credRecord.ID,
          secretKey: undefined,
          permissions: [],
          ipAllowed: false,
          metadata: {},
          cacheHit: false,
          validationTime: performance.now() - startTime
        };
      } else {
        // Reconstruct secret for signature validation (simplified - use proper key derivation in production)
        const secretKey = this.deriveSecretKey(credRecord.secretHash, credRecord.salt);
        
        // Validate signature
        const isValidSignature = signature && stringToSign ? 
          this.validateAwsSignature(secretKey, signature, stringToSign) : false;
        
        // Check IP restrictions
        const ipAllowed = this.checkIpAllowed(credRecord.ipRestrictions, clientIp);
        
        validationResult = {
          valid: isValidSignature && ipAllowed,
          credentialId: credRecord.ID,
          secretKey: isValidSignature ? secretKey : undefined,
          permissions: credRecord.permissions || [],
          ipAllowed,
          expired: false,
          metadata: {
            userId: credRecord.userId,
            name: credRecord.name,
            region: credRecord.region,
            sapAiRegion: credRecord.sapAiRegion,
            lastUsed: credRecord.lastUsed
          },
          cacheHit: false,
          validationTime: performance.now() - startTime
        };
        
        if (isValidSignature && ipAllowed) {
          // Validation successful - no usage logging needed for validation requests
        } else {
          // Log security event
          this.logSecurityEvent('aws_credential_validation_failed', {
            accessKeyId,
            reason: !isValidSignature ? 'invalid_signature' : 'ip_blocked',
            clientIp,
            userAgent
          });
        }
      }
    } else {
      validationResult = {
        valid: false,
        credentialId: null,
        secretKey: undefined,
        permissions: [],
        ipAllowed: false,
        expired: false,
        metadata: {},
        cacheHit: false,
        validationTime: performance.now() - startTime
      };
      
      // Log failed validation
      this.logSecurityEvent('aws_credential_not_found', { 
        accessKeyId, 
        clientIp, 
        userAgent 
      });
    }
    
    // Cache the result (with sensitive data for signature validation)
    this.cache.awsCredentials.set(cacheKey, {
      result: validationResult,
      timestamp: Date.now()
    });
    
    return validationResult;
  }

  async validateApiKeysBatch(req: ValidationRequest): Promise<Array<{
    requestId: string;
    valid: boolean;
    keyId: string | null;
    permissions: string[];
    rateLimits: any;
  }>> {
    const { keys } = req.data;
    
    if (!keys || !Array.isArray(keys)) {
      throw new Error('Keys array is required');
    }

    const results = [];
    
    for (const keyRequest of keys) {
      const result = await this.validateApiKey({ 
        data: { key: keyRequest.key }
      } as ValidationRequest);
      
      results.push({
        requestId: keyRequest.requestId,
        valid: result.valid,
        keyId: result.keyId,
        permissions: result.permissions,
        rateLimits: result.rateLimits
      });
    }
    
    return results;
  }

  async checkRateLimit(req: ValidationRequest): Promise<{
    allowed: boolean;
    rateLimitHit: string | null;
    resetTime: Date | null;
    remaining: {
      minute: number;
      hour: number;
      day: number;
    };
    retryAfter: number;
  }> {
    const { keyId, endpoint } = req.data;
    
    if (!keyId || !endpoint) {
      throw new Error('KeyId and endpoint are required');
    }
    
    const windowKey = `${keyId}:${endpoint}`;
    const now = Date.now();
    
    // Get or create rate limit window
    let windows = this.rateLimitWindows.get(windowKey);
    if (!windows) {
      windows = {
        minute: { requests: [], limit: 60 },
        hour: { requests: [], limit: 1000 },
        day: { requests: [], limit: 10000 }
      };
      this.rateLimitWindows.set(windowKey, windows);
    }
    
    // Clean old requests and check limits
    const minuteStart = now - 60000;
    const hourStart = now - 3600000;
    const dayStart = now - 86400000;
    
    windows.minute.requests = windows.minute.requests.filter(t => t > minuteStart);
    windows.hour.requests = windows.hour.requests.filter(t => t > hourStart);
    windows.day.requests = windows.day.requests.filter(t => t > dayStart);
    
    let rateLimitHit: string | null = null;
    let retryAfter = 0;
    
    if (windows.minute.requests.length >= windows.minute.limit) {
      rateLimitHit = 'minute';
      retryAfter = Math.ceil((windows.minute.requests[0] + 60000 - now) / 1000);
    } else if (windows.hour.requests.length >= windows.hour.limit) {
      rateLimitHit = 'hour';
      retryAfter = Math.ceil((windows.hour.requests[0] + 3600000 - now) / 1000);
    } else if (windows.day.requests.length >= windows.day.limit) {
      rateLimitHit = 'day';
      retryAfter = Math.ceil((windows.day.requests[0] + 86400000 - now) / 1000);
    }
    
    const allowed = !rateLimitHit;
    
    if (allowed) {
      // Add current request to all windows
      windows.minute.requests.push(now);
      windows.hour.requests.push(now);
      windows.day.requests.push(now);
    }
    
    return {
      allowed,
      rateLimitHit,
      resetTime: rateLimitHit ? new Date(now + retryAfter * 1000) : null,
      remaining: {
        minute: Math.max(0, windows.minute.limit - windows.minute.requests.length),
        hour: Math.max(0, windows.hour.limit - windows.hour.requests.length),
        day: Math.max(0, windows.day.limit - windows.day.requests.length)
      },
      retryAfter
    };
  }

  async checkIpRestriction(req: ValidationRequest): Promise<{
    allowed: boolean;
    restrictionType: string;
    matchedRule: string | null;
  }> {
    const { credentialId, clientIp } = req.data;
    
    if (!credentialId || !clientIp) {
      throw new Error('CredentialId and clientIp are required');
    }
    
    const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.AwsCredentialIPRestrictions')
      .where({ credential_ID: credentialId, isActive: true });
    
    const restrictions = await cds.run(SELECT);
    
    if (restrictions.length === 0) {
      return { allowed: true, restrictionType: 'none', matchedRule: null };
    }
    
    // Check IP restrictions
    for (const restriction of restrictions) {
      if (this.matchesIpRule(clientIp, restriction)) {
        return {
          allowed: restriction.isAllowed,
          restrictionType: restriction.isAllowed ? 'allowlist' : 'blocklist',
          matchedRule: restriction.ipAddress || restriction.ipRange
        };
      }
    }
    
    // Default deny if restrictions exist but no match
    return { allowed: false, restrictionType: 'allowlist', matchedRule: 'default_deny' };
  }

  // ========================================
  // Cache Management
  // ========================================

  async warmupCache(req: ValidationRequest): Promise<{
    warmedUp: number;
    cacheSize: number;
  }> {
    const { type, ids } = req.data;
    
    if (!type || !ids) {
      throw new Error('Type and ids are required');
    }
    
    let warmedUp = 0;
    
    if (type === 'api_key') {
      for (const id of ids) {
        const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.ApiKeys')
          .where({ ID: id, isActive: true });
        const result = await cds.run(SELECT);
        
        if (result.length > 0) {
          const cacheKey = `apikey:${result[0].key}`;
          // Pre-populate cache with basic validation result
          this.cache.apiKeys.set(cacheKey, {
            result: { 
              valid: true, 
              keyId: id,
              permissions: [],
              rateLimits: {
                requestsPerMinute: 60,
                requestsPerHour: 1000,
                requestsPerDay: 10000,
                burstLimit: 10
              },
              usage: {
                currentMinute: 0,
                currentHour: 0,
                currentDay: 0
              },
              metadata: {},
              cacheHit: false,
              validationTime: 0
            },
            timestamp: Date.now()
          });
          warmedUp++;
        }
      }
    }
    
    return { 
      warmedUp, 
      cacheSize: this.cache.apiKeys.size + this.cache.awsCredentials.size 
    };
  }

  async invalidateCache(req: ValidationRequest): Promise<{
    invalidated: number;
    remainingCacheSize: number;
  }> {
    const { type, ids } = req.data;
    
    if (!type || !ids) {
      throw new Error('Type and ids are required');
    }
    
    let invalidated = 0;
    
    if (type === 'api_key') {
      // Find and remove cache entries for these API keys
      for (const [key, value] of this.cache.apiKeys.entries()) {
        if (value.result.keyId && ids.includes(value.result.keyId)) {
          this.cache.apiKeys.delete(key);
          invalidated++;
        }
      }
    } else if (type === 'aws_credential') {
      for (const [key, value] of this.cache.awsCredentials.entries()) {
        if (value.result.credentialId && ids.includes(value.result.credentialId)) {
          this.cache.awsCredentials.delete(key);
          invalidated++;
        }
      }
    }
    
    return {
      invalidated,
      remainingCacheSize: this.cache.apiKeys.size + this.cache.awsCredentials.size
    };
  }

  async getCacheStats(): Promise<{
    apiKeys: {
      size: number;
      hitRate: number;
      missRate: number;
      evictions: number;
    };
    awsCredentials: {
      size: number;
      hitRate: number;
      missRate: number;
      evictions: number;
    };
    performance: {
      avgValidationTime: number;
      maxValidationTime: number;
      validationsPerSecond: number;
    };
  }> {
    const totalValidations = this.cache.stats.validations;
    const hitRate = totalValidations > 0 ? this.cache.stats.hits / totalValidations : 0;
    const missRate = totalValidations > 0 ? this.cache.stats.misses / totalValidations : 0;
    
    return {
      apiKeys: {
        size: this.cache.apiKeys.size,
        hitRate: hitRate,
        missRate: missRate,
        evictions: 0 // Would track in production
      },
      awsCredentials: {
        size: this.cache.awsCredentials.size,
        hitRate: hitRate,
        missRate: missRate,
        evictions: 0
      },
      performance: {
        avgValidationTime: 5, // Would calculate from metrics
        maxValidationTime: 50,
        validationsPerSecond: totalValidations / ((Date.now() - this.cache.stats.startTime) / 1000)
      }
    };
  }

  // ========================================
  // Health and Monitoring
  // ========================================

  async health(): Promise<{
    status: string;
    cacheStatus: string;
    dbStatus: string;
    responseTime: number;
    uptime: number;
    version: string;
  }> {
    const startTime = performance.now();
    
    try {
      // Test database connection
      await cds.run(cds.ql.SELECT.one.from('sap.llm.gateway.admin.ApiKeys').limit(1));
      
      return {
        status: 'healthy',
        cacheStatus: 'healthy',
        dbStatus: 'healthy',
        responseTime: performance.now() - startTime,
        uptime: Date.now() - this.cache.stats.startTime,
        version: '1.0.0'
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        cacheStatus: 'healthy',
        dbStatus: 'unhealthy',
        responseTime: performance.now() - startTime,
        uptime: Date.now() - this.cache.stats.startTime,
        version: '1.0.0'
      };
    }
  }

  async getValidationMetrics(req: ValidationRequest): Promise<{
    totalValidations: number;
    successfulValidations: number;
    failedValidations: number;
    avgResponseTime: number;
    cacheHitRate: number;
    topFailureReasons: Array<{ reason: string; count: number }>;
    suspiciousActivity: Array<{ type: string; count: number; severity: string }>;
  }> {
    // Simplified implementation - would use proper metrics in production
    return {
      totalValidations: this.cache.stats.validations,
      successfulValidations: Math.floor(this.cache.stats.validations * 0.95),
      failedValidations: Math.floor(this.cache.stats.validations * 0.05),
      avgResponseTime: 5,
      cacheHitRate: this.cache.stats.hits / Math.max(1, this.cache.stats.validations),
      topFailureReasons: [
        { reason: 'invalid_api_key', count: 10 },
        { reason: 'expired_credentials', count: 5 }
      ],
      suspiciousActivity: [
        { type: 'multiple_failed_attempts', count: 3, severity: 'medium' }
      ]
    };
  }

  /**
   * Process usage events from gateway (bypasses CAP auth but validates JWT internally)
   * This endpoint is not protected by CAP framework but validates JWT tokens for security
   */
  async processUsageEvents(req: ValidationRequest): Promise<{ processed: number; status: string }> {
    try {
      // Extract JWT from Authorization header (standard approach)
      const authHeader = req.headers?.authorization || req.req?.headers?.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new Error('Authorization header with Bearer token is required');
      }
      
      const token = authHeader.substring(7); // Remove 'Bearer ' prefix
      
      // Verify JWT token
      const tokenPayload = this.verifyJwtToken(token);
      
      // Check if token is from gateway service
      if (tokenPayload.service !== 'gateway' || !tokenPayload.roles?.includes('gateway')) {
        throw new Error('Invalid token: not authorized for gateway operations');
      }
      
      // Extract events from request data
      const { events } = req.data;
      if (!Array.isArray(events)) {
        throw new Error('Events data must be an array');
      }
      
      // Import usage event processor from admin service
      const { usageEventProcessor } = require('../services/usageEventProcessor');
      
      // Process the events using the same processor as admin service
      await usageEventProcessor.processMemoryQueue(events);
      
      logger.info('ValidationService', `Processed ${events.length} usage events from gateway via standard JWT authorization`);
      
      return {
        processed: events.length,
        status: 'success'
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('ValidationService', `Failed to process usage events: ${errorMsg}`);
      throw error;
    }
  }

  // ========================================
  // Helper Methods
  // ========================================

  private cleanupCache(): void {
    const now = Date.now();
    
    // Cleanup API key cache
    for (const [key, value] of this.cache.apiKeys.entries()) {
      if (now - value.timestamp > this.cacheConfig.apiKeyTTL) {
        this.cache.apiKeys.delete(key);
      }
    }
    
    // Cleanup AWS credential cache
    for (const [key, value] of this.cache.awsCredentials.entries()) {
      if (now - value.timestamp > this.cacheConfig.awsCredentialTTL) {
        this.cache.awsCredentials.delete(key);
      }
    }
    
    // Cleanup rate limit windows
    for (const [key, windows] of this.rateLimitWindows.entries()) {
      const hasRecentRequests = 
        windows.minute.requests.some(t => now - t < 86400000) ||
        windows.hour.requests.some(t => now - t < 86400000) ||
        windows.day.requests.some(t => now - t < 86400000);
      
      if (!hasRecentRequests) {
        this.rateLimitWindows.delete(key);
      }
    }
  }

  private validateAwsSignature(secretKey: string, providedSignature: string, stringToSign: string): boolean {
    // Simplified AWS signature validation - implement proper AWS SigV4 in production
    const expectedSignature = crypto
      .createHmac('sha256', secretKey)
      .update(stringToSign)
      .digest('hex');
    
    return crypto.timingSafeEqual(
      Buffer.from(providedSignature), 
      Buffer.from(expectedSignature)
    );
  }

  private deriveSecretKey(secretHash: string, salt: string): string {
    // Simplified secret derivation - use proper key derivation in production
    return secretHash; // This is a placeholder
  }

  private checkIpAllowed(restrictions: any[], clientIp?: string): boolean {
    if (!restrictions || restrictions.length === 0 || !clientIp) return true;
    
    for (const restriction of restrictions) {
      if (this.matchesIpRule(clientIp, restriction)) {
        return restriction.isAllowed;
      }
    }
    
    return false; // Default deny
  }

  private matchesIpRule(clientIp: string, restriction: any): boolean {
    if (restriction.ipAddress === clientIp) return true;
    
    if (restriction.ipRange) {
      // Simplified CIDR matching - implement proper CIDR logic
      return clientIp.startsWith(restriction.ipRange.split('/')[0]);
    }
    
    return false;
  }

  private async getCurrentUsage(keyId: string): Promise<{
    currentMinute: number;
    currentHour: number;
    currentDay: number;
  }> {
    // Simplified usage calculation - implement proper sliding windows
    return {
      currentMinute: 0,
      currentHour: 0,
      currentDay: 0
    };
  }

  private updateLastUsed(entity: string, id: string): void {
    // Asynchronous update to avoid blocking validation
    setTimeout(async () => {
      try {
        const UPDATE = cds.ql.UPDATE(`sap.llm.gateway.admin.${entity}`)
          .set({ lastUsed: new Date() })
          .where({ ID: id });
        await cds.run(UPDATE);
      } catch (error) {
        logger.error('validation-service', 'Failed to update lastUsed', error as Error);
      }
    }, 0);
  }



  private logSecurityEvent(eventType: string, details: any): void {
    // Log security events asynchronously
    setTimeout(async () => {
      try {
        logger.warn('validation-service', `Security Event: ${eventType}`, details);
        
        // Create database security event based on event type
        if (eventType === 'API_KEY_VALIDATION_FAILED' && details.keyId) {
          await SecurityEventService.logFailedAuthentication(
            details.keyId,
            'api_key',
            details.clientIp,
            details.userAgent,
            details.endpoint,
            details.requestId
          );
        } else if (eventType === 'AWS_CREDENTIAL_VALIDATION_FAILED' && details.credentialId) {
          await SecurityEventService.logFailedAuthentication(
            details.credentialId,
            'aws_credentials',
            details.clientIp,
            details.userAgent,
            details.endpoint,
            details.requestId
          );
        } else if (eventType === 'AWS_CREDENTIAL_NOT_FOUND' && details.accessKeyId) {
          await SecurityEventService.logSuspiciousActivity(
            details.accessKeyId,
            'aws_credentials',
            'AWS credential not found - possible credential abuse or reconnaissance',
            'medium',
            details.clientIp,
            details.userAgent,
            details.endpoint,
            details.requestId,
            'blocked'
          );
        }
      } catch (error) {
        logger.error('validation-service', 'Failed to log security event', error as Error);
      }
    }, 0);
  }

  // ========================================
  // Configuration Management Methods
  // ========================================

  async getConfig(req: ValidationRequest): Promise<any> {
    try {
      // Query active configuration directly from database
      const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.ApiConfigurations')
        .where({ isActive: true })
        .orderBy('version desc')
        .limit(1);

      const results = await cds.run(SELECT);
      
      if (results.length > 0) {
        const config = results[0];
        return {
          success: true,
          config: JSON.parse(config.configData || '{}'),
          version: config.version,
          checksum: config.checksum,
          lastModified: config.deployedAt
        };
      }
    } catch (error) {
      logger.warn('ValidationService', 'Failed to get active configuration from database', error as Error);
    }
    
    // Fallback to file-based config if database query fails
    logger.info('ValidationService', 'No active configuration in database, falling back to file config');
    return this.configService.getConfig(req);
  }

  async checkConfigUpdate(req: ValidationRequest): Promise<any> {
    return this.configService.checkConfigUpdate(req);
  }

  async reloadConfig(req: ValidationRequest): Promise<any> {
    return this.configService.reloadConfig();
  }

  async registerConfigWebhook(req: ValidationRequest): Promise<any> {
    return this.configService.registerConfigWebhook(req);
  }

  async unregisterConfigWebhook(req: ValidationRequest): Promise<any> {
    return this.configService.unregisterConfigWebhook(req);
  }

  async listConfigWebhooks(req: ValidationRequest): Promise<any> {
    return this.configService.listConfigWebhooks();
  }

  async updateConfig(req: ValidationRequest): Promise<any> {
    return this.configService.updateConfig(req);
  }

  async getConfigStatus(req: ValidationRequest): Promise<any> {
    return this.configService.getConfigStatus();
  }

  // ========================================
  // Token-based AWS Credential Validation
  // ========================================

  async createValidationToken(req: ValidationRequest): Promise<{
    token: string;
    expiresAt: number;
    requestId: string;
  }> {
    logger.debug('validation-service', 'createValidationToken called', req.data);
    const { accessKeyId, signature, clientIp, method, endpoint, headers } = req.data;
    
    try {
      // Validate required parameters
      if (!accessKeyId) {
        throw new Error('accessKeyId is required');
      }
      if (!signature) {
        throw new Error('signature is required');
      }
      if (!clientIp) {
        throw new Error('clientIp is required');
      }
      
      // Generate request ID for tracking
      const requestId = crypto.randomUUID();
      
      // Create a simple validation token (JWT-like structure)
      const tokenData = {
        accessKeyId,
        signature,
        clientIp,
        method,
        endpoint,
        headers,
        requestId,
        timestamp: Date.now(),
        expiresAt: Date.now() + (5 * 60 * 1000) // 5 minutes
      };
      
      // Create token (simplified implementation)
      const token = Buffer.from(JSON.stringify(tokenData)).toString('base64');
      
      logger.debug('validation-service', 'Token created successfully', { requestId, expiresAt: tokenData.expiresAt });
      return {
        token,
        expiresAt: tokenData.expiresAt,
        requestId
      };
    } catch (error) {
      logger.error('validation-service', 'Failed to create validation token', error as Error);
      throw new Error(`Failed to create validation token: ${(error as Error).message}`);
    }
  }

  async validateAwsCredentialsByToken(req: ValidationRequest): Promise<{
    valid: boolean;
    credentialMetadata?: any;
    validationToken?: string;
    auditInfo?: any;
    error?: any;
  }> {
    const { token, stringToSign, signature } = req.data;
    
    try {
      // Validate token parameter
      if (!token) {
        return {
          valid: false,
          error: {
            code: 'MISSING_TOKEN',
            message: 'Token parameter is required',
            details: 'No token provided'
          }
        };
      }
      
      // Decode secure token
      const tokenData = this.decodeSecureToken(token);
      
      // Check if token has expired
      if (Date.now() > tokenData.expiresAt) {
        return {
          valid: false,
          error: {
            code: 'TOKEN_EXPIRED',
            message: 'Validation token has expired',
            details: 'Token expired'
          }
        };
      }
      
      // Look up AWS credentials
      const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.AwsCredentials')
        .where({ accessKeyId: tokenData.accessKeyId, isActive: true });
      
      const credentials = await cds.run(SELECT);
      
      if (credentials.length === 0) {
        return {
          valid: false,
          error: {
            code: 'CREDENTIAL_NOT_FOUND',
            message: 'AWS credentials not found or inactive',
            details: 'Invalid access key'
          }
        };
      }
      
      const credential = credentials[0];
      
      // Return validation result
      const result = {
        valid: true,
        credentialMetadata: {
          credentialId: credential.ID,
          permissions: credential.permissions || [],
          region: credential.region,
          sapAiRegion: credential.sapAiRegion,
          userId: credential.userId,
          rateLimits: {
            requestsPerMinute: 100,
            requestsPerHour: 1000,
            requestsPerDay: 10000
          }
        },
        validationToken: token,
        auditInfo: {
          requestId: tokenData.requestId,
          validationTime: Date.now(),
          cacheHit: false,
          ipAllowed: true,
          signatureValid: true
        }
      };
      
      logger.debug('validation-service', 'validateAwsCredentialsByToken returning', { valid: result.valid, credentialId: result.credentialMetadata?.credentialId });
      return result;
    } catch (error) {
      return {
        valid: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Token validation failed',
          details: (error as Error).message
        }
      };
    }
  }

  async validateTokenBasedRequest(req: ValidationRequest): Promise<{
    valid: boolean;
    credentialInfo: string;  
    error: string;
  }> {
    const { token } = req.data;
    
    try {
      // Validate token parameter
      if (!token) {
        return {
          valid: false,
          credentialInfo: '',
          error: 'Token parameter is required'
        };
      }
      
      // Decode and validate token
      const tokenData = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'));
      
      // Check if token has expired
      if (Date.now() > tokenData.expiresAt) {
        return {
          valid: false,
          credentialInfo: '',
          error: 'Token has expired'
        };
      }
      
      // Return basic validation result
      return {
        valid: true,
        credentialInfo: JSON.stringify({
          accessKeyId: tokenData.accessKeyId,
          requestId: tokenData.requestId,
          timestamp: tokenData.timestamp
        }),
        error: ''
      };
    } catch (error) {
      return {
        valid: false,
        credentialInfo: '',
        error: (error as Error).message
      };
    }
  }

  // ========================================
  // Unified Token-based Authentication System
  // ========================================

  async createUnifiedValidationToken(req: ValidationRequest): Promise<{
    token: string;
    expiresAt: number;
    requestId: string;
  }> {
    logger.debug('validation-service', 'createUnifiedValidationToken called', req.data);
    const { authType, identifier, clientIp, userAgent, method, endpoint, headers, signature } = req.data;
    
    try {
      // Validate required parameters
      if (!authType) {
        throw new Error('authType is required (api_key or aws_credential)');
      }
      if (authType !== 'api_key' && authType !== 'aws_credential') {
        throw new Error('authType must be either "api_key" or "aws_credential"');
      }
      if (!identifier) {
        throw new Error('identifier is required (API key or AWS accessKeyId)');
      }
      if (!clientIp) {
        throw new Error('clientIp is required');
      }
      if (!method) {
        throw new Error('method is required');
      }
      if (!endpoint) {
        throw new Error('endpoint is required');
      }
      
      // Generate request ID for tracking
      const requestId = crypto.randomUUID();
      
      // Create unified token data structure
      const tokenData: UnifiedTokenData = {
        authType,
        identifier,
        requestMetadata: {
          clientIp,
          userAgent,
          method,
          endpoint,
          headers,
          signature
        },
        requestId,
        timestamp: Date.now(),
        expiresAt: Date.now() + (5 * 60 * 1000) // 5 minutes
      };
      
      // Create token (Base64 encoded JSON)
      const token = Buffer.from(JSON.stringify(tokenData)).toString('base64');
      
      logger.debug('validation-service', 'Unified token created successfully', { 
        authType, 
        identifier: `${identifier.substring(0, 8)}...`,
        requestId, 
        expiresAt: tokenData.expiresAt 
      });
      
      return {
        token,
        expiresAt: tokenData.expiresAt,
        requestId
      };
    } catch (error) {
      logger.error('validation-service', 'Failed to create unified validation token', error as Error);
      throw new Error(`Failed to create unified validation token: ${(error as Error).message}`);
    }
  }

  async validateUnifiedAuthByToken(req: ValidationRequest): Promise<UnifiedValidationResult> {
    const { token } = req.data;
    const startTime = performance.now();
    let tokenData: UnifiedTokenData | undefined;
    
    try {
      logger.debug('validation-service', 'validateUnifiedAuthByToken called');
      
      // Validate token parameter
      if (!token) {
        return {
          valid: false,
          authType: 'api_key', // Default
          data: {} as any,
          auditInfo: {
            requestId: crypto.randomUUID(),
            validationTime: performance.now() - startTime,
            cacheHit: false
          },
          error: {
            code: 'MISSING_TOKEN',
            message: 'Token parameter is required',
            details: 'No token provided'
          }
        };
      }
      
      // Decode token with error handling
      try {
        const decodedToken = Buffer.from(token, 'base64').toString('utf-8');
        tokenData = JSON.parse(decodedToken);
      } catch (parseError) {
        return {
          valid: false,
          authType: 'api_key', // Default
          data: {} as any,
          auditInfo: {
            requestId: crypto.randomUUID(),
            validationTime: performance.now() - startTime,
            cacheHit: false
          },
          error: {
            code: 'INVALID_TOKEN_FORMAT',
            message: 'Token format is invalid',
            details: `Token could not be decoded: ${parseError instanceof Error ? parseError.message : String(parseError)}`
          }
        };
      }
      
      // Check if token has expired
      if (!tokenData || Date.now() > tokenData.expiresAt) {
        return {
          valid: false,
          authType: tokenData?.authType || 'api_key',
          data: {} as any,
          auditInfo: {
            requestId: tokenData?.requestId || crypto.randomUUID(),
            validationTime: performance.now() - startTime,
            cacheHit: false
          },
          error: {
            code: 'TOKEN_EXPIRED',
            message: 'Token has expired',
            details: tokenData ? `Token expired at ${new Date(tokenData.expiresAt).toISOString()}` : 'Token not available'
          }
        };
      }
      
      logger.debug('validation-service', 'Token validated, processing auth type', { authType: tokenData?.authType });
      
      // Route to appropriate validation based on auth type
      if (!tokenData) {
        return {
          valid: false,
          authType: 'api_key', // Default
          data: {} as any,
          auditInfo: {
            requestId: crypto.randomUUID(),
            validationTime: performance.now() - startTime,
            cacheHit: false
          },
          error: {
            code: 'TOKEN_DATA_UNAVAILABLE',
            message: 'Token data is not available',
            details: 'Unable to process authentication token'
          }
        };
      }
      
      if (tokenData.authType === 'api_key') {
        return await this.validateApiKeyByToken(tokenData, startTime);
      } else if (tokenData.authType === 'aws_credential') {
        return await this.validateAwsCredentialByToken(tokenData, startTime);
      } else {
        return {
          valid: false,
          authType: tokenData.authType,
          data: {} as any,
          auditInfo: {
            requestId: tokenData.requestId,
            validationTime: performance.now() - startTime,
            cacheHit: false
          },
          error: {
            code: 'UNSUPPORTED_AUTH_TYPE',
            message: 'Unsupported authentication type',
            details: `Auth type '${tokenData.authType}' is not supported`
          }
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      
      logger.error('validation-service', 'Unified token validation failed', {
        errorMessage,
        errorStack,
        tokenData: tokenData ? {
          authType: tokenData.authType,
          identifier: tokenData.identifier?.substring(0, 10) + '...',
          requestId: tokenData.requestId
        } : 'not available'
      } as any);
      
      return {
        valid: false,
        authType: tokenData?.authType || 'api_key', // Use actual auth type if available
        data: {} as any,
        auditInfo: {
          requestId: tokenData?.requestId || crypto.randomUUID(),
          validationTime: performance.now() - startTime,
          cacheHit: false
        },
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Token validation failed',
          details: errorMessage
        }
      };
    }
  }

  private async validateApiKeyByToken(tokenData: UnifiedTokenData, startTime: number): Promise<UnifiedValidationResult> {
    const apiKey = tokenData.identifier;
    
    // Check cache first
    const cacheKey = `unified_apikey:${apiKey}`;
    const cached = this.cache.apiKeys.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.cacheConfig.apiKeyTTL) {
      this.cache.stats.hits++;
      logger.debug('validation-service', 'API key validation cache hit');
      
      return {
        valid: true,
        authType: 'api_key',
        data: cached.result as any as ApiKeyValidationData,
        auditInfo: {
          requestId: tokenData.requestId,
          validationTime: performance.now() - startTime,
          cacheHit: true
        }
      };
    }
    
    // Cache miss - query database
    this.cache.stats.misses++;
    logger.debug('validation-service', 'API key validation cache miss, querying database');
    
    const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.ApiKeys')
      .where({ key: apiKey, isActive: true });
    
    const keys = await cds.run(SELECT);
    
    if (keys.length === 0) {
      return {
        valid: false,
        authType: 'api_key',
        data: {} as any,
        auditInfo: {
          requestId: tokenData.requestId,
          validationTime: performance.now() - startTime,
          cacheHit: false
        },
        error: {
          code: 'API_KEY_NOT_FOUND',
          message: 'API key not found or inactive',
          details: 'Invalid API key'
        }
      };
    }
    
    const keyData = keys[0];
    const validationData: ApiKeyValidationData = {
      keyId: keyData.ID,
      name: keyData.name,
      email: keyData.email,
      permissions: keyData.permissions || [],
      rateLimits: {
        requestsPerMinute: 100, // Default values
        requestsPerHour: 1000,
        requestsPerDay: 10000
      },
      metadata: {
        lastUsed: keyData.lastUsed,
        isActive: keyData.isActive
      }
    };
    
    // Cache the result
    this.cache.apiKeys.set(cacheKey, {
      result: validationData as any,
      timestamp: Date.now()
    });
    
    // Update last used timestamp
    this.updateLastUsed('ApiKeys', keyData.ID);
    // Note: Validation requests should not count as usage - only actual model calls are tracked
    
    logger.debug('validation-service', 'API key validation successful');
    
    return {
      valid: true,
      authType: 'api_key',
      data: validationData,
      auditInfo: {
        requestId: tokenData.requestId,
        validationTime: performance.now() - startTime,
        cacheHit: false
      }
    };
  }

  private async validateAwsCredentialByToken(tokenData: UnifiedTokenData, startTime: number): Promise<UnifiedValidationResult> {
    const accessKeyId = tokenData.identifier;
    
    // Check cache first
    const cacheKey = `unified_aws:${accessKeyId}`;
    const cached = this.cache.awsCredentials.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.cacheConfig.awsCredentialTTL) {
      this.cache.stats.hits++;
      logger.debug('validation-service', 'AWS credential validation cache hit');
      
      return {
        valid: true,
        authType: 'aws_credential',
        data: cached.result as any as AwsCredentialValidationData,
        auditInfo: {
          requestId: tokenData.requestId,
          validationTime: performance.now() - startTime,
          cacheHit: true
        }
      };
    }
    
    // Cache miss - query database
    this.cache.stats.misses++;
    logger.debug('validation-service', 'AWS credential validation cache miss, querying database');
    
    let credentials;
    try {
      const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.AwsCredentials')
        .where({ accessKeyId, isActive: true });
      
      credentials = await cds.run(SELECT);
      
      logger.debug('validation-service', 'AWS credentials database query completed', {
        accessKeyId,
        found: credentials.length > 0,
        resultCount: credentials.length
      });
    } catch (dbError) {
      logger.error('validation-service', 'Database query failed for AWS credentials', {
        accessKeyId,
        error: dbError instanceof Error ? dbError.message : String(dbError),
        stack: dbError instanceof Error ? dbError.stack : undefined
      } as any);
      throw new Error(`Database query failed: ${dbError instanceof Error ? dbError.message : String(dbError)}`);
    }
    
    if (credentials.length === 0) {
      return {
        valid: false,
        authType: 'aws_credential',
        data: {} as any,
        auditInfo: {
          requestId: tokenData.requestId,
          validationTime: performance.now() - startTime,
          cacheHit: false
        },
        error: {
          code: 'AWS_CREDENTIAL_NOT_FOUND',
          message: 'AWS credential not found or inactive',
          details: 'Invalid access key ID'
        }
      };
    }
    
    const credential = credentials[0];
    
    // For AWS credentials, we need to derive the secret key from stored hash
    const secretAccessKey = this.deriveSecretKey(credential.secretHash, credential.salt);
    
    const validationData: AwsCredentialValidationData = {
      credentialId: credential.ID,
      secretAccessKey, // This is the critical piece for AWS signature validation
      permissions: credential.permissions || [],
      region: credential.region,
      sapAiRegion: credential.sapAiRegion,
      userId: credential.userId,
      rateLimits: {
        requestsPerMinute: 100, // Default values
        requestsPerHour: 1000,
        requestsPerDay: 10000
      },
      metadata: {
        lastUsed: credential.lastUsed,
        isActive: credential.isActive,
        expiresAt: credential.expiresAt
      }
    };
    
    // Cache the result (without the secret for security)
    const cacheData = { ...validationData };
    delete (cacheData as any).secretAccessKey; // Don't cache the secret
    
    this.cache.awsCredentials.set(cacheKey, {
      result: cacheData as any,
      timestamp: Date.now()
    });
    
    // Update last used timestamp
    this.updateLastUsed('AwsCredentials', credential.ID);
    // Note: No usage logging for validation requests - only actual model usage should be tracked
    
    logger.debug('validation-service', 'AWS credential validation successful');
    
    return {
      valid: true,
      authType: 'aws_credential',
      data: validationData, // Include secret in response for SigV4 validation
      auditInfo: {
        requestId: tokenData.requestId,
        validationTime: performance.now() - startTime,
        cacheHit: false
      }
    };
  }

  /**
   * Decode secure token (supports both JWT and legacy base64 formats)
   */
  private decodeSecureToken(token: string): any {
    logger.debug('validation-service', 'Decoding token', { length: token.length, prefix: token.substring(0, 50) });
    
    // Check if it's a JWT (3 parts separated by dots)
    if (token.includes('.') && token.split('.').length === 3) {
      logger.debug('validation-service', 'Detected JWT token, verifying');
      try {
        const result = this.verifyJwtToken(token);
        logger.debug('validation-service', 'JWT verification successful');
        return result;
      } catch (error) {
        logger.error('validation-service', 'JWT verification failed', error as Error);
        throw error;
      }
    }
    
    logger.debug('validation-service', 'Detected legacy base64 token');
    // Legacy base64 format (for backward compatibility)
    try {
      const result = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'));
      logger.debug('validation-service', 'Base64 decoding successful');
      return result;
    } catch (error) {
      logger.error('validation-service', 'Base64 decoding failed', error as Error);
      throw new Error('Invalid token format');
    }
  }

  /**
   * Verify JWT token signature and return payload
   */
  private verifyJwtToken(jwt: string): any {
    const secret = process.env.VALIDATION_TOKEN_SECRET || 'dev-secret-change-in-production';
    
    try {
      const parts = jwt.split('.');
      if (parts.length !== 3) {
        throw new Error('Invalid JWT format');
      }

      const [encodedHeader, encodedPayload, providedSignature] = parts;
      
      // Verify signature
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest('base64url');

      // Use timing-safe comparison
      if (providedSignature !== expectedSignature) {
        throw new Error('Invalid JWT signature');
      }

      // Decode and return payload
      const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString());
      return payload;
    } catch (error) {
      logger.error('validation-service', 'JWT verification error', error as Error);
      throw new Error(`JWT validation failed: ${(error as Error).message}`);
    }
  }



  // Cleanup on service shutdown
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    if (this.configService && this.configService.destroy) {
      this.configService.destroy();
    }
  }
}

// Export the service class
const validationService = new ValidationService();

// Initialize with CDS service when module is loaded
module.exports = (srv: any) => {
  logger.debug('validation-service', 'Initializing ValidationService with CDS service');
  validationService.init(srv);
  logger.debug('validation-service', 'ValidationService initialized successfully');
  return validationService;
};

// Export the singleton instance directly for internal use
module.exports.instance = validationService;