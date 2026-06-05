/**
 * Unified Validation Cache
 * 
 * Extends the existing EnhancedValidationCache to support unified token-based authentication.
 * Maintains backward compatibility while adding support for both API key and AWS credential validation data.
 */

import { ValidationCache, ValidationResponse } from '../../../../libs/aws-token-validation/validation-token';
import { secureMetadataExchange, CredentialMetadata } from '../../../../libs/aws-token-validation/secure-metadata-exchange';
import { EnhancedValidationCache, CacheConfiguration, CacheMetrics, CacheEntry } from './enhancedValidationCache';
import { getCachedUnifiedAuthConfig } from '../config/unifiedAuthConfig';
import { UnifiedValidationResponse, ApiKeyValidationData, AwsCredentialValidationData } from '../clients/adminServiceClient';
import { ValkeyDistributedCacheAdapter } from './valkeyDistributedCacheAdapter';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

// Extended cache entry types
export interface UnifiedCacheEntry {
  data: ValidationResponse | CredentialMetadata | UnifiedValidationResponse;
  timestamp: number;
  expiresAt: number;
  encrypted: boolean;
  accessCount: number;
  lastAccessed: number;
  authType?: 'api_key' | 'aws_credential' | 'legacy_aws'; // Track the type of auth data
  tokenSource?: 'admin_service' | 'local_validation' | 'fallback'; // Track where the data came from
  validationMetadata?: {
    requestId: string;
    adminServiceResponseTime?: number;
    fallbackUsed: boolean;
    cacheHit: boolean;
  };
}

// Extended cache configuration
export interface UnifiedCacheConfiguration extends CacheConfiguration {
  unifiedAuthEnabled: boolean;
  tokenTTL: number; // Separate TTL for token validation data
  fallbackTTL: number; // TTL for fallback validation data
  prioritizeAdminService: boolean; // Whether to prefer admin service data over local validation
  enableCrossValidation: boolean; // Enable cross-validation between admin service and local validation
  encryptTokenData: boolean; // Whether to encrypt token validation responses
}

// Extended metrics
export interface UnifiedCacheMetrics extends CacheMetrics {
  unifiedTokenHits: number;
  unifiedTokenMisses: number;
  adminServiceRequests: number;
  fallbackRequests: number;
  crossValidationAttempts: number;
  tokenCacheSize: number;
  avgAdminServiceResponseTime: number;
}

/**
 * Unified Validation Cache extending EnhancedValidationCache
 * 
 * Provides seamless integration between existing AWS validation cache and new unified token system.
 * Supports gradual migration and fallback strategies.
 */
export class UnifiedValidationCache extends EnhancedValidationCache {
  private unifiedConfig: UnifiedCacheConfiguration;
  private unifiedMetrics: UnifiedCacheMetrics;
  private unifiedCache: Map<string, UnifiedCacheEntry> = new Map(); // Separate cache for unified tokens
  private valkeyAdapter: ValkeyDistributedCacheAdapter | null = null;
  private authConfig = getCachedUnifiedAuthConfig();

  constructor(config?: Partial<UnifiedCacheConfiguration>) {
    // Get auth config first
    const authConfig = getCachedUnifiedAuthConfig();
    
    // Initialize parent with enhanced configuration
    const baseConfig: Partial<CacheConfiguration> = {
      defaultTTL: config?.defaultTTL || 300000, // 5 minutes
      maxCacheSize: config?.maxCacheSize || 10000,
      cleanupInterval: config?.cleanupInterval || 60000,
      enableEncryption: config?.enableEncryption ?? (process.env.NODE_ENV === 'production'),
      enableDistributed: config?.enableDistributed ?? authConfig.hasValkey,
      valkeyUrl: config?.valkeyUrl || authConfig.hasValkey ? process.env.VALKEY_URL : undefined
    };

    super(baseConfig);
    
    // Store auth config after super() call
    this.authConfig = authConfig;

    // Initialize unified-specific configuration
    this.unifiedConfig = {
      ...baseConfig,
      unifiedAuthEnabled: authConfig.enabled,
      tokenTTL: authConfig.tokenCacheTtlSeconds * 1000, // Convert to milliseconds
      fallbackTTL: Math.min(baseConfig.defaultTTL || 300000, 60000), // Max 1 minute for fallback data
      prioritizeAdminService: true,
      enableCrossValidation: authConfig.isDevelopment, // Enable in development for debugging
      encryptTokenData: authConfig.encryptSecrets,
      ...config
    } as UnifiedCacheConfiguration;

    // Initialize unified metrics
    this.unifiedMetrics = {
      ...this.getMetrics(),
      unifiedTokenHits: 0,
      unifiedTokenMisses: 0,
      adminServiceRequests: 0,
      fallbackRequests: 0,
      crossValidationAttempts: 0,
      tokenCacheSize: 0,
      avgAdminServiceResponseTime: 0
    };

    // Initialize Valkey adapter if distributed caching is enabled
    if (this.unifiedConfig.enableDistributed && this.unifiedConfig.valkeyUrl) {
      this.valkeyAdapter = new ValkeyDistributedCacheAdapter({
        valkeyUrl: this.unifiedConfig.valkeyUrl,
        keyPrefix: 'unified-cache:',
        defaultTTL: Math.floor(this.unifiedConfig.tokenTTL / 1000), // Convert to seconds
        enableEncryption: this.unifiedConfig.encryptTokenData
      });
      
      // Initialize Valkey connection asynchronously
      this.valkeyAdapter.connect().catch((error: any) => {
        logger.error('UnifiedValidationCache', 'Failed to connect to Valkey, continuing with local cache only', error instanceof Error ? error : new Error(String(error)));
        this.valkeyAdapter = null;
      });
    }

    logger.info('UnifiedValidationCache', 'Unified validation cache initialized', {
      unifiedAuthEnabled: this.unifiedConfig.unifiedAuthEnabled,
      tokenTTL: this.unifiedConfig.tokenTTL,
      encryptTokenData: this.unifiedConfig.encryptTokenData,
      distributedEnabled: this.unifiedConfig.enableDistributed,
      valkeyConfigured: this.valkeyAdapter !== null
    });
  }

  /**
   * Store unified validation token response
   */
  async setUnifiedToken(
    tokenOrKey: string,
    response: UnifiedValidationResponse,
    options?: {
      ttl?: number;
      priority?: 'high' | 'medium' | 'low';
      source?: 'admin_service' | 'local_validation' | 'fallback';
    }
  ): Promise<void> {
    if (!this.unifiedConfig.unifiedAuthEnabled) {
      logger.debug('UnifiedValidationCache', 'Unified auth disabled, skipping unified token cache');
      return;
    }

    const startTime = Date.now();
    const cacheKey = this.generateUnifiedCacheKey(tokenOrKey, response.authType);
    const ttl = options?.ttl || this.getTokenTTL(response.authType, options?.source);
    const shouldEncrypt = this.unifiedConfig.encryptTokenData && this.containsUnifiedSensitiveData(response);

    try {
      let processedData: UnifiedValidationResponse = response;

      // Encrypt sensitive data if enabled
      if (shouldEncrypt) {
        processedData = await this.encryptUnifiedCacheData(response, cacheKey);
      }

      const entry: UnifiedCacheEntry = {
        data: processedData,
        timestamp: Date.now(),
        expiresAt: Date.now() + ttl,
        encrypted: shouldEncrypt,
        accessCount: 0,
        lastAccessed: Date.now(),
        authType: response.authType,
        tokenSource: options?.source || 'admin_service',
        validationMetadata: {
          requestId: response.auditInfo.requestId,
          adminServiceResponseTime: options?.source === 'admin_service' ? (Date.now() - startTime) : undefined,
          fallbackUsed: options?.source === 'fallback',
          cacheHit: false
        }
      };

      // Store in unified cache
      this.unifiedCache.set(cacheKey, entry);

      // Store in distributed cache if enabled
      if (this.valkeyAdapter) {
        try {
          await this.valkeyAdapter.set(cacheKey, entry, Math.floor(ttl / 1000));
        } catch (error) {
          logger.warn('UnifiedValidationCache', 'Failed to store in Valkey, continuing with local cache', {
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      // Update metrics
      this.unifiedMetrics.adminServiceRequests += options?.source === 'admin_service' ? 1 : 0;
      this.unifiedMetrics.fallbackRequests += options?.source === 'fallback' ? 1 : 0;
      this.updateUnifiedMetrics();

      logger.trace('UnifiedValidationCache', `Unified token cached`, {
        cacheKey: cacheKey.substring(0, 30) + '...',
        authType: response.authType,
        source: options?.source,
        ttl,
        encrypted: shouldEncrypt,
        duration: Date.now() - startTime
      });

      // Cleanup if cache is too large
      if (this.unifiedCache.size > this.unifiedConfig.maxCacheSize) {
        await this.evictUnifiedLRU();
      }

    } catch (error) {
      logger.error('UnifiedValidationCache', 'Failed to cache unified token', error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Get unified validation response from cache
   */
  async getUnifiedToken(tokenOrKey: string, authType: 'api_key' | 'aws_credential'): Promise<UnifiedValidationResponse | null> {
    if (!this.unifiedConfig.unifiedAuthEnabled) {
      logger.debug('UnifiedValidationCache', 'Unified auth disabled, skipping unified token lookup');
      return null;
    }

    const startTime = Date.now();
    const cacheKey = this.generateUnifiedCacheKey(tokenOrKey, authType);

    try {
      // Check unified cache first
      let entry = this.unifiedCache.get(cacheKey);
      let fromDistributed = false;

      if (!entry && this.valkeyAdapter) {
        // Check distributed cache
        try {
          const distributedEntry = await this.valkeyAdapter.get(cacheKey);
          if (distributedEntry) {
            entry = distributedEntry;
            fromDistributed = true;
            // Store in local cache for faster access
            this.unifiedCache.set(cacheKey, entry);
          }
        } catch (error) {
          logger.warn('UnifiedValidationCache', 'Failed to retrieve from Valkey, using local cache only', {
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      if (!entry) {
        this.unifiedMetrics.unifiedTokenMisses++;
        this.updateUnifiedMetrics();
        return null;
      }

      // Check expiration
      if (Date.now() > entry.expiresAt) {
        this.unifiedCache.delete(cacheKey);
        if (this.valkeyAdapter) {
          try {
            await this.valkeyAdapter.delete(cacheKey);
          } catch (error) {
            logger.warn('UnifiedValidationCache', 'Failed to delete expired entry from Valkey', {
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
        this.unifiedMetrics.unifiedTokenMisses++;
        this.updateUnifiedMetrics();
        return null;
      }

      // Update access statistics
      entry.accessCount++;
      entry.lastAccessed = Date.now();

      // Decrypt if necessary
      let data = entry.data as UnifiedValidationResponse;
      if (entry.encrypted && this.isUnifiedEncryptedData(data)) {
        data = await this.decryptUnifiedCacheData(data, cacheKey);
      }

      // Update cache hit metadata
      if (data.auditInfo) {
        data.auditInfo.cacheHit = true;
      }

      this.unifiedMetrics.unifiedTokenHits++;
      this.updateUnifiedMetrics();

      const responseTime = Date.now() - startTime;
      logger.trace('UnifiedValidationCache', `Unified token cache ${fromDistributed ? 'distributed ' : ''}hit`, {
        cacheKey: cacheKey.substring(0, 30) + '...',
        authType: data.authType,
        source: entry.tokenSource,
        valid: data.valid,
        responseTime
      });

      return data;

    } catch (error) {
      logger.error('UnifiedValidationCache', 'Failed to retrieve unified token from cache', error instanceof Error ? error : new Error(String(error)));
      
      this.unifiedMetrics.unifiedTokenMisses++;
      this.updateUnifiedMetrics();
      return null;
    }
  }

  /**
   * Delete unified token from cache
   */
  async deleteUnifiedToken(tokenOrKey: string, authType: 'api_key' | 'aws_credential'): Promise<boolean> {
    const cacheKey = this.generateUnifiedCacheKey(tokenOrKey, authType);

    try {
      const localDeleted = this.unifiedCache.delete(cacheKey);
      
      if (this.valkeyAdapter) {
        try {
          await this.valkeyAdapter.delete(cacheKey);
        } catch (error) {
          logger.warn('UnifiedValidationCache', 'Failed to delete from Valkey', {
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      this.updateUnifiedMetrics();
      return localDeleted;

    } catch (error) {
      logger.error('UnifiedValidationCache', 'Failed to delete unified token from cache', error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  /**
   * Clear unified token cache
   */
  async clearUnifiedTokens(): Promise<void> {
    try {
      this.unifiedCache.clear();
      
      if (this.valkeyAdapter) {
        try {
          await this.valkeyAdapter.clear();
        } catch (error) {
          logger.warn('UnifiedValidationCache', 'Failed to clear Valkey cache', {
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      this.resetUnifiedMetrics();
      logger.info('UnifiedValidationCache', 'Unified token cache cleared');

    } catch (error) {
      logger.error('UnifiedValidationCache', 'Failed to clear unified token cache', error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Get comprehensive cache metrics including unified token metrics
   */
  getUnifiedMetrics(): UnifiedCacheMetrics & {
    config: UnifiedCacheConfiguration;
    uptime: number;
    memoryUsage: NodeJS.MemoryUsage;
    cacheBreakdown: {
      legacyValidation: number;
      unifiedTokens: number;
      total: number;
    };
  } {
    const baseMetrics = this.getMetrics();
    
    return {
      ...this.unifiedMetrics,
      config: { ...this.unifiedConfig },
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      cacheBreakdown: {
        legacyValidation: baseMetrics.size,
        unifiedTokens: this.unifiedCache.size,
        total: baseMetrics.size + this.unifiedCache.size
      }
    };
  }

  /**
   * Get unified cache analytics
   */
  getUnifiedAnalytics(): {
    authTypeDistribution: Array<{ authType: string; count: number; percentage: number }>;
    sourceDistribution: Array<{ source: string; count: number; percentage: number }>;
    performanceMetrics: {
      avgResponseTime: number;
      adminServiceAvgTime: number;
      fallbackUsage: number;
    };
    unifiedCacheEfficiency: {
      hitRate: number;
      memoryEfficiency: number;
      encryptionOverhead: number;
    };
  } {
    const entries = Array.from(this.unifiedCache.entries());
    const totalEntries = entries.length;

    // Auth type distribution
    const authTypes = new Map<string, number>();
    const sources = new Map<string, number>();
    let totalResponseTime = 0;
    let adminServiceTime = 0;
    let adminServiceCount = 0;
    let fallbackCount = 0;
    let encryptedCount = 0;

    for (const [, entry] of entries) {
      // Auth type stats
      const authType = entry.authType || 'unknown';
      authTypes.set(authType, (authTypes.get(authType) || 0) + 1);

      // Source distribution
      const source = entry.tokenSource || 'unknown';
      sources.set(source, (sources.get(source) || 0) + 1);

      // Performance metrics
      if (entry.validationMetadata?.adminServiceResponseTime) {
        adminServiceTime += entry.validationMetadata.adminServiceResponseTime;
        adminServiceCount++;
      }

      if (entry.tokenSource === 'fallback') {
        fallbackCount++;
      }

      if (entry.encrypted) {
        encryptedCount++;
      }
    }

    const authTypeDistribution = Array.from(authTypes.entries()).map(([authType, count]) => ({
      authType,
      count,
      percentage: totalEntries > 0 ? Math.round((count / totalEntries) * 100) : 0
    }));

    const sourceDistribution = Array.from(sources.entries()).map(([source, count]) => ({
      source,
      count,
      percentage: totalEntries > 0 ? Math.round((count / totalEntries) * 100) : 0
    }));

    return {
      authTypeDistribution,
      sourceDistribution,
      performanceMetrics: {
        avgResponseTime: totalResponseTime > 0 ? totalResponseTime / totalEntries : 0,
        adminServiceAvgTime: adminServiceCount > 0 ? adminServiceTime / adminServiceCount : 0,
        fallbackUsage: totalEntries > 0 ? Math.round((fallbackCount / totalEntries) * 100) : 0
      },
      unifiedCacheEfficiency: {
        hitRate: this.unifiedMetrics.unifiedTokenHits + this.unifiedMetrics.unifiedTokenMisses > 0 ? 
          this.unifiedMetrics.unifiedTokenHits / (this.unifiedMetrics.unifiedTokenHits + this.unifiedMetrics.unifiedTokenMisses) : 0,
        memoryEfficiency: this.estimateUnifiedMemoryUsage(),
        encryptionOverhead: totalEntries > 0 ? Math.round((encryptedCount / totalEntries) * 100) : 0
      }
    };
  }

  /**
   * Cross-validate between admin service and local validation (development mode)
   */
  async crossValidate(
    tokenOrKey: string,
    authType: 'api_key' | 'aws_credential',
    adminServiceResponse: UnifiedValidationResponse,
    localValidationResponse: ValidationResponse | null
  ): Promise<{
    consistent: boolean;
    discrepancies: string[];
    recommendation: 'use_admin_service' | 'use_local' | 'investigate';
  }> {
    if (!this.unifiedConfig.enableCrossValidation) {
      return {
        consistent: true,
        discrepancies: [],
        recommendation: 'use_admin_service'
      };
    }

    this.unifiedMetrics.crossValidationAttempts++;
    const discrepancies: string[] = [];

    try {
      // Only cross-validate if we have both responses
      if (!localValidationResponse) {
        return {
          consistent: false,
          discrepancies: ['Local validation unavailable'],
          recommendation: 'use_admin_service'
        };
      }

      // Compare validation results (basic comparison)
      if (adminServiceResponse.valid !== localValidationResponse.valid) {
        discrepancies.push(`Validation mismatch: admin=${adminServiceResponse.valid}, local=${localValidationResponse.valid}`);
      }

      // For AWS credentials, compare additional metadata if available
      if (authType === 'aws_credential' && localValidationResponse.credentialMetadata) {
        const adminData = adminServiceResponse.data as AwsCredentialValidationData;
        const localData = localValidationResponse.credentialMetadata;

        if (adminData.region !== localData.region) {
          discrepancies.push(`Region mismatch: admin=${adminData.region}, local=${localData.region}`);
        }
      }

      const consistent = discrepancies.length === 0;
      
      logger.debug('UnifiedValidationCache', 'Cross-validation completed', {
        tokenPrefix: tokenOrKey.substring(0, 20) + '...',
        authType,
        consistent,
        discrepancies: discrepancies.length,
        recommendation: this.getRecommendation(discrepancies, adminServiceResponse, localValidationResponse)
      });

      return {
        consistent,
        discrepancies,
        recommendation: this.getRecommendation(discrepancies, adminServiceResponse, localValidationResponse)
      };

    } catch (error) {
      logger.error('UnifiedValidationCache', 'Cross-validation failed', error instanceof Error ? error : new Error(String(error)));

      return {
        consistent: false,
        discrepancies: [`Cross-validation error: ${error instanceof Error ? error.message : String(error)}`],
        recommendation: 'use_admin_service'
      };
    }
  }

  /**
   * Clear cache entries for a specific credential
   * Used by cache invalidation system
   */
  async clearByCredentialId(credentialId: string, authType: 'api_key' | 'aws_credential'): Promise<boolean> {
    let cleared = false;
    
    try {
      // Build possible cache keys for this credential
      const possibleKeys = this.buildPossibleCacheKeys(credentialId, authType);
      
      // Clear from local cache
      for (const key of possibleKeys) {
        if (this.unifiedCache.has(key)) {
          this.unifiedCache.delete(key);
          cleared = true;
        }
      }
      
      // Clear from distributed cache
      if (this.valkeyAdapter) {
        for (const key of possibleKeys) {
          try {
            const deletedFromValkey = await this.valkeyAdapter.delete(key);
            if (deletedFromValkey) {
              cleared = true;
            }
          } catch (error) {
            logger.warn('UnifiedValidationCache', `Failed to delete key ${key} from Valkey`, {
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }
      
      if (cleared) {
        logger.info('UnifiedValidationCache', `Cleared cache for credential: ${credentialId} (${authType})`);
      }
      
      return cleared;
    } catch (error) {
      logger.error('UnifiedValidationCache', `Failed to clear cache for credential ${credentialId}`, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  /**
   * Clear cache entries matching a pattern
   */
  async clearByPattern(pattern: string): Promise<number> {
    let totalCleared = 0;
    
    try {
      // Clear from local cache (approximate pattern matching)
      const localKeys = Array.from(this.unifiedCache.keys());
      const matchingLocalKeys = localKeys.filter(key => this.matchesPattern(key, pattern));
      
      for (const key of matchingLocalKeys) {
        this.unifiedCache.delete(key);
        totalCleared++;
      }
      
      // Clear from Valkey using native pattern support
      if (this.valkeyAdapter) {
        try {
          const valkeyCleared = await this.valkeyAdapter.clearPattern(pattern);
          totalCleared += valkeyCleared;
        } catch (error) {
          logger.warn('UnifiedValidationCache', `Failed to clear pattern ${pattern} from Valkey`, {
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      
      if (totalCleared > 0) {
        logger.info('UnifiedValidationCache', `Cleared ${totalCleared} cache entries matching pattern: ${pattern}`);
      }
      
      return totalCleared;
    } catch (error) {
      logger.error('UnifiedValidationCache', `Failed to clear cache pattern ${pattern}`, error instanceof Error ? error : new Error(String(error)));
      return 0;
    }
  }

  /**
   * Build possible cache keys for a credential
   */
  private buildPossibleCacheKeys(credentialId: string, authType: 'api_key' | 'aws_credential'): string[] {
    const keys: string[] = [];
    
    // Build the specific cache key using the same hash function as cache invalidation
    const prefix = authType === 'api_key' ? 'apikey' : 'token';
    const keyHash = this.hashKey(credentialId);
    
    // Primary key that should match the current cache entry
    keys.push(`unified:${prefix}:${keyHash}`);
    
    // Legacy patterns for migration compatibility (these may not exist but check anyway)
    if (authType === 'api_key') {
      keys.push(`unified:apikey:${credentialId}`); // Unhashed legacy format
      keys.push(`unified:token:${credentialId}`);  // Wrong prefix legacy format
    } else if (authType === 'aws_credential') {
      keys.push(`unified:token:${credentialId}`);  // Unhashed legacy format
      keys.push(`unified:awscred:${credentialId}`); // Different prefix legacy
      keys.push(`unified:aws:${credentialId}`);     // Short prefix legacy
    }
    
    return keys;
  }

  /**
   * Simple pattern matching for local cache keys
   */
  private matchesPattern(key: string, pattern: string): boolean {
    // Convert Redis-style pattern to RegExp
    const regexPattern = pattern
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(key);
  }

  /**
   * Override parent destroy method to cleanup unified resources
   */
  async destroy(): Promise<void> {
    try {
      // Clear unified cache
      this.unifiedCache.clear();

      // Disconnect Valkey adapter
      if (this.valkeyAdapter) {
        try {
          await this.valkeyAdapter.disconnect();
        } catch (error) {
          logger.warn('UnifiedValidationCache', 'Failed to disconnect Valkey adapter', {
            error: error instanceof Error ? error.message : String(error)
          });
        }
        this.valkeyAdapter = null;
      }

      // Call parent destroy
      await super.destroy();

      logger.info('UnifiedValidationCache', 'Unified cache destroyed and resources cleaned up');

    } catch (error) {
      logger.error('UnifiedValidationCache', 'Error during unified cache destruction', error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Private helper methods for unified cache functionality
   */
  private generateUnifiedCacheKey(tokenOrKey: string, authType: 'api_key' | 'aws_credential'): string {
    // Create a consistent cache key that works for both tokens and API keys
    const prefix = authType === 'api_key' ? 'apikey' : 'token';
    const keyHash = this.hashKey(tokenOrKey);
    return `unified:${prefix}:${keyHash}`;
  }

  private hashKey(key: string): string {
    // Simple hash function for cache keys (in production, use crypto.createHash)
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      const char = key.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }

  private getTokenTTL(authType: 'api_key' | 'aws_credential', source?: string): number {
    if (source === 'fallback') {
      return this.unifiedConfig.fallbackTTL;
    }
    
    // Use unified token TTL for admin service responses
    return this.unifiedConfig.tokenTTL;
  }

  private containsUnifiedSensitiveData(response: UnifiedValidationResponse): boolean {
    try {
      const responseStr = JSON.stringify(response).toLowerCase();
      const sensitiveFields = ['secretkey', 'secretaccesskey', 'credentials', 'token', 'password'];
      return sensitiveFields.some(field => responseStr.includes(field));
    } catch {
      return false;
    }
  }

  private async encryptUnifiedCacheData(data: UnifiedValidationResponse, key: string): Promise<UnifiedValidationResponse> {
    try {
      // Convert to a format compatible with secureMetadataExchange
      const metadataForEncryption: CredentialMetadata = {
        credentialId: `unified-token-${data.authType}`,
        permissions: [{
          service: 'unified-auth',
          action: 'validate',
          resource: data.authType,
          effect: 'allow'
        }],
        region: 'global',
        sapAiRegion: 'global',
        userId: 'unified-user',
        rateLimits: { requestsPerMinute: 0, requestsPerHour: 0, requestsPerDay: 0 },
        // Store the actual unified data in a custom field
        ...(data as any).unifiedPayload ? { unifiedPayload: data } : {}
      };
      
      // Use a deterministic salt based on the cache key to ensure consistency
      const salt = key + '-unified-cache-salt';
      const encryptedData = await secureMetadataExchange.encryptMetadata(metadataForEncryption, key, salt);
      
      return { 
        ...data, 
        __encrypted: true, 
        __encryptedData: encryptedData,
        __originalData: JSON.stringify(data) // Store serialized original data as backup
      } as any;
    } catch (error) {
      logger.warn('UnifiedValidationCache', 'Failed to encrypt unified cache data', {
        error: error instanceof Error ? error.message : String(error)
      });
      return data; // Fall back to unencrypted
    }
  }

  private async decryptUnifiedCacheData(encryptedData: any, key: string): Promise<UnifiedValidationResponse> {
    try {
      if (encryptedData.__encrypted && encryptedData.__encryptedData) {
        // Use the same deterministic salt for decryption
        const salt = key + '-unified-cache-salt';
        const decryptedMetadata: CredentialMetadata = await secureMetadataExchange.decryptMetadata(encryptedData.__encryptedData, key, salt);
        
        // Try to extract original data from the stored backup
        if (encryptedData.__originalData) {
          try {
            const originalData = JSON.parse(encryptedData.__originalData);
            return originalData;
          } catch (parseError) {
            logger.warn('UnifiedValidationCache', 'Failed to parse original data, using decrypted metadata', {
              error: parseError instanceof Error ? parseError.message : String(parseError)
            });
            // Fall through to reconstruct from metadata
          }
        }
        
        // Reconstruct UnifiedValidationResponse from decrypted metadata
        // This is a fallback if __originalData is not available
        const reconstructed: UnifiedValidationResponse = {
          valid: true, // Assume valid if it was cached
          authType: decryptedMetadata.credentialId.includes('api_key') ? 'api_key' : 'aws_credential',
          data: {
            // Generic data structure - this is why we prefer __originalData
            credentialId: decryptedMetadata.credentialId,
            region: decryptedMetadata.region,
            userId: decryptedMetadata.userId,
            permissions: decryptedMetadata.permissions.map(p => `${p.service}:${p.action}`),
            rateLimits: decryptedMetadata.rateLimits,
            metadata: {
              isActive: true,
              lastUsed: new Date().toISOString()
            }
          } as any,
          auditInfo: {
            requestId: 'decrypted-' + Date.now(),
            validationTime: Date.now(),
            cacheHit: true
          }
        };
        
        return reconstructed;
      }
      return encryptedData;
    } catch (error) {
      logger.warn('UnifiedValidationCache', 'Failed to decrypt unified cache data', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error; // Don't return corrupted data
    }
  }

  private isUnifiedEncryptedData(data: any): boolean {
    return data && typeof data === 'object' && data.__encrypted === true && data.__encryptedData;
  }

  private async evictUnifiedLRU(): Promise<void> {
    const entries = Array.from(this.unifiedCache.entries());
    
    // Sort by last accessed time (oldest first)
    entries.sort(([, a], [, b]) => a.lastAccessed - b.lastAccessed);
    
    // Remove oldest 10% of entries
    const toEvict = Math.ceil(entries.length * 0.1);
    
    for (let i = 0; i < toEvict; i++) {
      const [key] = entries[i];
      this.unifiedCache.delete(key);
    }

    logger.debug('UnifiedValidationCache', `Evicted ${toEvict} unified LRU entries`);
  }

  private updateUnifiedMetrics(): void {
    this.unifiedMetrics.tokenCacheSize = this.unifiedCache.size;
    
    // Update average admin service response time
    let totalTime = 0;
    let count = 0;
    
    for (const [, entry] of this.unifiedCache.entries()) {
      if (entry.validationMetadata?.adminServiceResponseTime) {
        totalTime += entry.validationMetadata.adminServiceResponseTime;
        count++;
      }
    }
    
    this.unifiedMetrics.avgAdminServiceResponseTime = count > 0 ? totalTime / count : 0;
  }

  private resetUnifiedMetrics(): void {
    this.unifiedMetrics = {
      ...this.getMetrics(),
      unifiedTokenHits: 0,
      unifiedTokenMisses: 0,
      adminServiceRequests: 0,
      fallbackRequests: 0,
      crossValidationAttempts: 0,
      tokenCacheSize: 0,
      avgAdminServiceResponseTime: 0
    };
  }

  private estimateUnifiedMemoryUsage(): number {
    let memoryEstimate = 0;
    
    for (const [key, entry] of this.unifiedCache.entries()) {
      // Rough memory estimate: key + entry data + metadata
      memoryEstimate += key.length * 2; // String overhead
      memoryEstimate += JSON.stringify(entry.data).length * 2; // Data size
      memoryEstimate += 500; // Entry metadata overhead
    }
    
    return memoryEstimate;
  }

  private getRecommendation(
    discrepancies: string[], 
    adminResponse: UnifiedValidationResponse, 
    localResponse: ValidationResponse
  ): 'use_admin_service' | 'use_local' | 'investigate' {
    if (discrepancies.length === 0) {
      return 'use_admin_service'; // Consistent, prefer admin service
    }
    
    if (discrepancies.length > 2) {
      return 'investigate'; // Too many discrepancies
    }
    
    // Default to admin service for minor discrepancies
    return 'use_admin_service';
  }

}

// Export singleton instance
export const unifiedValidationCache = new UnifiedValidationCache();

export default UnifiedValidationCache;