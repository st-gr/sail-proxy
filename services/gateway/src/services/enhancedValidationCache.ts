import { ValidationCache, ValidationResponse } from '../../../../libs/aws-token-validation/validation-token';
import { secureMetadataExchange, CredentialMetadata } from '../../../../libs/aws-token-validation/secure-metadata-exchange';
import { shouldEnableDistributedCaching } from '../config/unifiedAuthConfig';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

export interface CacheConfiguration {
  defaultTTL: number;
  maxCacheSize: number;
  cleanupInterval: number;
  enableEncryption: boolean;
  enableDistributed: boolean;
  valkeyUrl?: string;
}

export interface CacheMetrics {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  hitRate: number;
  avgResponseTime: number;
  encryptedEntries: number;
  distributedHits: number;
}

export interface CacheEntry {
  data: ValidationResponse | CredentialMetadata;
  timestamp: number;
  expiresAt: number;
  encrypted: boolean;
  accessCount: number;
  lastAccessed: number;
}

export class EnhancedValidationCache {
  private localCache: Map<string, CacheEntry> = new Map();
  private config: CacheConfiguration;
  private metrics: CacheMetrics;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private distributedClient: any = null; // Valkey client if enabled
  // The client of an in-flight connection attempt, before its ping has
  // answered. Tracked so destroy() can close a connection that is still
  // retrying: until the attempt gives up on its own (which takes the whole
  // retry budget) the socket is live, and a cache destroyed in the meantime
  // would otherwise leave it running with nobody holding it.
  private connectingClient: any = null;

  constructor(config?: Partial<CacheConfiguration>) {
    this.config = {
      defaultTTL: 300000, // 5 minutes
      maxCacheSize: 10000,
      cleanupInterval: 60000, // 1 minute
      enableEncryption: process.env.NODE_ENV === 'production',
      enableDistributed: shouldEnableDistributedCaching(),
      valkeyUrl: process.env.VALKEY_URL,
      ...config
    };

    this.metrics = {
      hits: 0,
      misses: 0,
      evictions: 0,
      size: 0,
      hitRate: 0,
      avgResponseTime: 0,
      encryptedEntries: 0,
      distributedHits: 0
    };

    this.initialize();
  }

  private async initialize(): Promise<void> {
    // Initialize distributed cache if enabled
    if (this.config.enableDistributed && this.config.valkeyUrl) {
      try {
        await this.initializeDistributedCache();
        logger.info('EnhancedValidationCache', 'Distributed cache initialized');
      } catch (error) {
        logger.warn('EnhancedValidationCache', `Failed to initialize distributed cache: ${(error as Error).message}`);
        this.config.enableDistributed = false;
      }
    }

    // Start cleanup timer
    this.startCleanupTimer();
    
    logger.info('EnhancedValidationCache', `Cache initialized with TTL: ${this.config.defaultTTL}ms, Max Size: ${this.config.maxCacheSize}`);
  }

  /**
   * Store validation result in cache
   */
  async set(
    key: string, 
    data: ValidationResponse | CredentialMetadata, 
    ttl?: number,
    options?: { encrypt?: boolean; priority?: 'high' | 'medium' | 'low' }
  ): Promise<void> {
    const startTime = Date.now();
    const actualTTL = ttl || this.config.defaultTTL;
    const shouldEncrypt = options?.encrypt ?? this.config.enableEncryption;

    try {
      let processedData = data;
      
      // Encrypt sensitive data if enabled
      if (shouldEncrypt && this.containsSensitiveData(data)) {
        processedData = await this.encryptCacheData(data, key);
        this.metrics.encryptedEntries++;
      }

      const entry: CacheEntry = {
        data: processedData,
        timestamp: Date.now(),
        expiresAt: Date.now() + actualTTL,
        encrypted: shouldEncrypt,
        accessCount: 0,
        lastAccessed: Date.now()
      };

      // Store in local cache
      this.localCache.set(key, entry);

      // Store in distributed cache if enabled
      if (this.config.enableDistributed && this.distributedClient) {
        await this.setDistributed(key, entry, actualTTL);
      }

      // Cleanup if cache is too large
      if (this.localCache.size > this.config.maxCacheSize) {
        await this.evictLRU();
      }

      this.updateMetrics();
      logger.trace('EnhancedValidationCache', `Cached entry for key: ${key.substring(0, 20)}... (${Date.now() - startTime}ms)`);

    } catch (error) {
      logger.error('EnhancedValidationCache', `Failed to cache entry: ${(error as Error).message}`);
    }
  }

  /**
   * Get validation result from cache
   */
  async get(key: string): Promise<ValidationResponse | CredentialMetadata | null> {
    const startTime = Date.now();

    try {
      // Check local cache first
      let entry = this.localCache.get(key);
      let fromDistributed = false;

      if (!entry && this.config.enableDistributed && this.distributedClient) {
        // Check distributed cache
        const distributedEntry = await this.getDistributed(key);
        if (distributedEntry) {
          entry = distributedEntry;
          fromDistributed = true;
          this.metrics.distributedHits++;
          // Store in local cache for faster access
          this.localCache.set(key, entry);
        }
      }

      if (!entry) {
        this.metrics.misses++;
        this.updateMetrics();
        return null;
      }

      // Check expiration
      if (Date.now() > entry.expiresAt) {
        this.localCache.delete(key);
        if (this.config.enableDistributed && this.distributedClient) {
          await this.deleteDistributed(key);
        }
        this.metrics.misses++;
        this.updateMetrics();
        return null;
      }

      // Update access statistics
      entry.accessCount++;
      entry.lastAccessed = Date.now();

      // Decrypt if necessary
      let data = entry.data;
      if (entry.encrypted && this.isEncryptedData(data)) {
        data = await this.decryptCacheData(data, key);
      }

      this.metrics.hits++;
      this.updateMetrics();

      const responseTime = Date.now() - startTime;
      logger.trace('EnhancedValidationCache', `Cache ${fromDistributed ? 'distributed ' : ''}hit for key: ${key.substring(0, 20)}... (${responseTime}ms)`);

      return data;

    } catch (error) {
      logger.error('EnhancedValidationCache', `Failed to retrieve cache entry: ${(error as Error).message}`);
      this.metrics.misses++;
      this.updateMetrics();
      return null;
    }
  }

  /**
   * Delete entry from cache
   */
  async delete(key: string): Promise<boolean> {
    try {
      const localDeleted = this.localCache.delete(key);
      
      if (this.config.enableDistributed && this.distributedClient) {
        await this.deleteDistributed(key);
      }

      this.updateMetrics();
      return localDeleted;

    } catch (error) {
      logger.error('EnhancedValidationCache', `Failed to delete cache entry: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Clear entire cache
   */
  async clear(): Promise<void> {
    try {
      this.localCache.clear();
      
      if (this.config.enableDistributed && this.distributedClient) {
        await this.clearDistributed();
      }

      this.resetMetrics();
      logger.info('EnhancedValidationCache', 'Cache cleared');

    } catch (error) {
      logger.error('EnhancedValidationCache', `Failed to clear cache: ${(error as Error).message}`);
    }
  }

  /**
   * Get cache statistics and metrics
   */
  getMetrics(): CacheMetrics & {
    config: CacheConfiguration;
    uptime: number;
    memoryUsage: NodeJS.MemoryUsage;
  } {
    return {
      ...this.metrics,
      config: { ...this.config },
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage()
    };
  }

  /**
   * Get detailed cache analysis
   */
  getAnalytics(): {
    topKeys: Array<{ key: string; accessCount: number; lastAccessed: number }>;
    expirationDistribution: Array<{ bucket: string; count: number }>;
    encryptionStats: { encrypted: number; total: number; percentage: number };
    memoryEstimate: number;
  } {
    const now = Date.now();
    const entries = Array.from(this.localCache.entries());
    
    // Top accessed keys
    const topKeys = entries
      .map(([key, entry]) => ({
        key: key.substring(0, 30) + '...',
        accessCount: entry.accessCount,
        lastAccessed: entry.lastAccessed
      }))
      .sort((a, b) => b.accessCount - a.accessCount)
      .slice(0, 10);

    // Expiration distribution
    const expirationBuckets = {
      'expired': 0,
      '< 1min': 0,
      '1-5min': 0,
      '5-15min': 0,
      '> 15min': 0
    };

    let encryptedCount = 0;
    let memoryEstimate = 0;

    for (const [key, entry] of entries) {
      const timeToExpiry = entry.expiresAt - now;
      
      if (timeToExpiry <= 0) {
        expirationBuckets.expired++;
      } else if (timeToExpiry < 60000) {
        expirationBuckets['< 1min']++;
      } else if (timeToExpiry < 300000) {
        expirationBuckets['1-5min']++;
      } else if (timeToExpiry < 900000) {
        expirationBuckets['5-15min']++;
      } else {
        expirationBuckets['> 15min']++;
      }

      if (entry.encrypted) {
        encryptedCount++;
      }

      // Rough memory estimate
      memoryEstimate += key.length * 2 + JSON.stringify(entry.data).length * 2 + 200; // overhead
    }

    const expirationDistribution = Object.entries(expirationBuckets).map(([bucket, count]) => ({
      bucket,
      count
    }));

    return {
      topKeys,
      expirationDistribution,
      encryptionStats: {
        encrypted: encryptedCount,
        total: entries.length,
        percentage: entries.length > 0 ? Math.round((encryptedCount / entries.length) * 100) : 0
      },
      memoryEstimate
    };
  }

  /**
   * Warm up cache with frequently accessed keys
   */
  async warmup(keys: string[], dataProvider: (key: string) => Promise<ValidationResponse | CredentialMetadata | null>): Promise<{
    warmedUp: number;
    failed: number;
    duration: number;
  }> {
    const startTime = Date.now();
    let warmedUp = 0;
    let failed = 0;

    logger.info('EnhancedValidationCache', `Starting cache warmup for ${keys.length} keys`);

    const warmupPromises = keys.map(async (key) => {
      try {
        const data = await dataProvider(key);
        if (data) {
          await this.set(key, data);
          warmedUp++;
        } else {
          failed++;
        }
      } catch (error) {
        logger.warn('EnhancedValidationCache', `Warmup failed for key ${key}: ${(error as Error).message}`);
        failed++;
      }
    });

    await Promise.all(warmupPromises);

    const duration = Date.now() - startTime;
    logger.info('EnhancedValidationCache', `Cache warmup completed: ${warmedUp} warmed up, ${failed} failed (${duration}ms)`);

    return { warmedUp, failed, duration };
  }

  /**
   * Private helper methods
   */
  private async initializeDistributedCache(): Promise<void> {
    if (!this.config.valkeyUrl) return;

    // Held locally, not on `this`, for the whole attempt. Two initializations
    // can be in flight at once — the constructor starts one without awaiting it
    // — and a catch that cleans up `this.distributedClient` cleans up whichever
    // client won the race, leaking the other. The failing attempt must close the
    // client IT created.
    let client: any = null;

    try {
      // Import Valkey client (only if needed and available)
      const Redis = (await import('iovalkey')).default;

      client = new Redis(this.config.valkeyUrl);
      this.connectingClient = client;

      // An 'error' listener is NOT optional on an iovalkey client. Without one,
      // every connection-level error is an unhandled error event: node-level
      // fatal in production, and in Jest it surfaces as `Connection is closed`
      // raised from iovalkey's close handler when the socket goes away at
      // force-exit — attributed to whichever test suite happened to be loading
      // in that worker. That is an intermittent "Test suite failed to run" on a
      // file with no connection to this code at all, which is exactly how it
      // was found (three different innocent suites, zero failing tests).
      //
      // Distributed caching is an accelerator: the local cache and the
      // authoritative lookup behind it both keep working when valkey does not,
      // so a connection error is logged and otherwise tolerated rather than
      // escalated.

      client.on('error', (error: Error) => {
        logger.warn('EnhancedValidationCache',
          `Valkey connection error (distributed cache is an accelerator; validation still works): ${error.message}`);
      });

      // Test connection (iovalkey auto-connects). Only after it answers does
      // this become the cache's client — publishing it before the ping would
      // make a connection that is still failing briefly look usable.
      await client.ping();
      this.distributedClient = client;
      this.connectingClient = null;
    } catch (error) {
      logger.warn('EnhancedValidationCache', `Valkey not available, disabling distributed cache: ${(error as Error).message}`);
      this.config.enableDistributed = false;
      // Disconnect before dropping the reference. Clearing the field alone
      // leaves a live socket with retries scheduled and nothing holding it —
      // the connection outlives the object that gave up on it, and its eventual
      // close raises the error above with no owner left to attribute it to.
      if (this.distributedClient === client) {
        this.distributedClient = null;
      }
      if (this.connectingClient === client) {
        this.connectingClient = null;
      }
      if (client) {
        try {
          client.disconnect();
        } catch {
          // best-effort cleanup; the connection is already unusable
        }
      }
    }
  }

  private async setDistributed(key: string, entry: CacheEntry, ttl: number): Promise<void> {
    if (!this.distributedClient) return;

    const serializedEntry = JSON.stringify(entry);
    await this.distributedClient.setex(`validation:${key}`, Math.ceil(ttl / 1000), serializedEntry);
  }

  private async getDistributed(key: string): Promise<CacheEntry | null> {
    if (!this.distributedClient) return null;

    const serializedEntry = await this.distributedClient.get(`validation:${key}`);
    return serializedEntry ? JSON.parse(serializedEntry) : null;
  }

  private async deleteDistributed(key: string): Promise<void> {
    if (!this.distributedClient) return;

    await this.distributedClient.del(`validation:${key}`);
  }

  private async clearDistributed(): Promise<void> {
    if (!this.distributedClient) return;

    const keys = await this.distributedClient.keys('validation:*');
    if (keys.length > 0) {
      await this.distributedClient.del(keys);
    }
  }

  private async encryptCacheData(data: any, key: string): Promise<any> {
    try {
      const encryptedData = await secureMetadataExchange.encryptMetadata(data, key);
      return { __encrypted: true, data: encryptedData };
    } catch (error) {
      logger.warn('EnhancedValidationCache', `Failed to encrypt cache data: ${(error as Error).message}`);
      return data; // Fall back to unencrypted
    }
  }

  private async decryptCacheData(encryptedData: any, key: string): Promise<any> {
    try {
      if (encryptedData.__encrypted && encryptedData.data) {
        return await secureMetadataExchange.decryptMetadata(encryptedData.data, key);
      }
      return encryptedData;
    } catch (error) {
      logger.warn('EnhancedValidationCache', `Failed to decrypt cache data: ${(error as Error).message}`);
      throw error; // Don't return corrupted data
    }
  }

  private containsSensitiveData(data: any): boolean {
    const sensitiveFields = ['secretKey', 'secretAccessKey', 'credentials', 'token'];
    const dataStr = JSON.stringify(data).toLowerCase();
    return sensitiveFields.some(field => dataStr.includes(field));
  }

  private isEncryptedData(data: any): boolean {
    return data && typeof data === 'object' && data.__encrypted === true;
  }

  private async evictLRU(): Promise<void> {
    const entries = Array.from(this.localCache.entries());
    
    // Sort by last accessed time (oldest first)
    entries.sort(([, a], [, b]) => a.lastAccessed - b.lastAccessed);
    
    // Remove oldest 10% of entries
    const toEvict = Math.ceil(entries.length * 0.1);
    
    for (let i = 0; i < toEvict; i++) {
      const [key] = entries[i];
      this.localCache.delete(key);
      this.metrics.evictions++;
    }

    logger.debug('EnhancedValidationCache', `Evicted ${toEvict} LRU entries`);
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupInterval);
  }

  private cleanup(): void {
    const now = Date.now();
    let expired = 0;

    for (const [key, entry] of this.localCache.entries()) {
      if (now > entry.expiresAt) {
        this.localCache.delete(key);
        expired++;
      }
    }

    if (expired > 0) {
      logger.debug('EnhancedValidationCache', `Cleaned up ${expired} expired entries`);
      this.updateMetrics();
    }

    // Cleanup metadata exchange
    if (secureMetadataExchange) {
      secureMetadataExchange.cleanup();
    }
  }

  private updateMetrics(): void {
    this.metrics.size = this.localCache.size;
    this.metrics.hitRate = this.metrics.hits + this.metrics.misses > 0 ? 
      this.metrics.hits / (this.metrics.hits + this.metrics.misses) : 0;
  }

  private resetMetrics(): void {
    this.metrics = {
      hits: 0,
      misses: 0,
      evictions: 0,
      size: 0,
      hitRate: 0,
      avgResponseTime: 0,
      encryptedEntries: 0,
      distributedHits: 0
    };
  }

  /**
   * Destroy cache and cleanup resources
   */
  async destroy(): Promise<void> {
    try {
      if (this.cleanupTimer) {
        clearInterval(this.cleanupTimer);
        this.cleanupTimer = null;
      }

      if (this.distributedClient) {
        await this.distributedClient.quit();
        this.distributedClient = null;
      }

      // A connection attempt still in flight owns a live socket that is not
      // this.distributedClient yet. Without this, destroying the cache mid-
      // attempt leaves it retrying until the budget runs out.
      if (this.connectingClient) {
        const pending = this.connectingClient;
        this.connectingClient = null;
        try {
          pending.disconnect();
        } catch {
          // best-effort cleanup; the connection is already unusable
        }
      }

      this.localCache.clear();
      
      if (secureMetadataExchange) {
        secureMetadataExchange.destroy();
      }

      logger.info('EnhancedValidationCache', 'Cache destroyed and resources cleaned up');

    } catch (error) {
      logger.error('EnhancedValidationCache', `Error during cache destruction: ${(error as Error).message}`);
    }
  }
}

// Export singleton instance
export const validationCache = new EnhancedValidationCache();

export default EnhancedValidationCache;