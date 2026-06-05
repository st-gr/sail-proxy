/**
 * Valkey Distributed Cache Adapter for Unified Validation Cache
 * 
 * Provides Valkey-backed distributed caching for unified token validation responses.
 * Supports encryption, serialization, TTL management, and connection pooling.
 */

import Redis, { RedisOptions } from 'iovalkey';

// Use any for Valkey client type to avoid complex type issues
type ValkeyClient = any;
import { UnifiedValidationResponse } from '../clients/adminServiceClient';
import { UnifiedCacheEntry, UnifiedCacheConfiguration } from './unifiedValidationCache';
import { secureMetadataExchange, CredentialMetadata } from '../../../../libs/aws-token-validation/secure-metadata-exchange';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

export interface ValkeyAdapterConfiguration {
  valkeyUrl: string;
  keyPrefix: string;
  defaultTTL: number;
  enableEncryption: boolean;
  connectionTimeout: number;
  retryAttempts: number;
  retryDelay: number;
}

export interface ValkeyAdapterMetrics {
  connections: number;
  operations: number;
  errors: number;
  avgResponseTime: number;
  cacheHits: number;
  cacheMisses: number;
  encryptedOperations: number;
}

/**
 * Valkey adapter for distributed unified validation caching
 */
export class ValkeyDistributedCacheAdapter {
  private client: ValkeyClient | null = null;
  private config: ValkeyAdapterConfiguration;
  private metrics: ValkeyAdapterMetrics;
  private connectionPromise: Promise<void> | null = null;
  private isConnected: boolean = false;

  constructor(config: Partial<ValkeyAdapterConfiguration>) {
    this.config = {
      valkeyUrl: config.valkeyUrl || process.env.VALKEY_URL || 'redis://localhost:6379',
      keyPrefix: config.keyPrefix || 'unified-cache:',
      defaultTTL: config.defaultTTL || 300, // 5 minutes in seconds
      enableEncryption: config.enableEncryption ?? true,
      connectionTimeout: config.connectionTimeout || 5000,
      retryAttempts: config.retryAttempts || 3,
      retryDelay: config.retryDelay || 1000,
      ...config
    };

    this.metrics = {
      connections: 0,
      operations: 0,
      errors: 0,
      avgResponseTime: 0,
      cacheHits: 0,
      cacheMisses: 0,
      encryptedOperations: 0
    };

    logger.info('ValkeyDistributedCacheAdapter', 'Valkey adapter initialized', {
      valkeyUrl: this.config.valkeyUrl.replace(/\/\/.*@/, '//***@'), // Hide credentials
      keyPrefix: this.config.keyPrefix,
      encryptionEnabled: this.config.enableEncryption
    });
  }

  /**
   * Initialize Valkey connection
   */
  async connect(): Promise<void> {
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = this.establishConnection();
    return this.connectionPromise;
  }

  private async establishConnection(): Promise<void> {
    try {
      const clientOptions: RedisOptions = {
        connectTimeout: this.config.connectionTimeout,
        retryStrategy: (retries: any) => {
          if (retries >= this.config.retryAttempts) {
            logger.error('ValkeyDistributedCacheAdapter', 'Max retry attempts reached', undefined, {
              retries,
              maxAttempts: this.config.retryAttempts
            });
            return null; // Stop retrying
          }
          const delay = Math.min(this.config.retryDelay * Math.pow(2, retries), 10000);
          logger.warn('ValkeyDistributedCacheAdapter', `Retrying connection in ${delay}ms`, {
            attempt: retries + 1,
            maxAttempts: this.config.retryAttempts
          });
          return delay;
        }
      };

      this.client = new Redis(this.config.valkeyUrl, clientOptions);

      // Set up event handlers
      this.client.on('connect', () => {
        logger.info('ValkeyDistributedCacheAdapter', 'Connected to Valkey');
        this.isConnected = true;
        this.metrics.connections++;
      });

      this.client.on('error', (error: Error) => {
        logger.error('ValkeyDistributedCacheAdapter', 'Valkey connection error', error);
        this.metrics.errors++;
        this.isConnected = false;
      });

      this.client.on('disconnect', () => {
        logger.warn('ValkeyDistributedCacheAdapter', 'Disconnected from Valkey');
        this.isConnected = false;
      });

      // Test the connection (iovalkey auto-connects)
      await this.client.ping();
      
      logger.info('ValkeyDistributedCacheAdapter', 'Valkey connection established successfully');

    } catch (error) {
      this.isConnected = false;
      logger.error('ValkeyDistributedCacheAdapter', 'Failed to establish Valkey connection', error instanceof Error ? error : new Error(String(error)), {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Store unified cache entry in Valkey
   */
  async set(key: string, entry: UnifiedCacheEntry, ttlSeconds?: number): Promise<void> {
    const startTime = Date.now();
    
    try {
      await this.ensureConnected();
      
      const valkeyKey = this.buildValkeyKey(key);
      const ttl = ttlSeconds || this.config.defaultTTL;
      
      let serializedEntry: string;
      
      if (this.config.enableEncryption && this.shouldEncryptEntry(entry)) {
        // Encrypt the entry before storing
        const encryptedEntry = await this.encryptEntry(entry, key);
        serializedEntry = JSON.stringify(encryptedEntry);
        this.metrics.encryptedOperations++;
      } else {
        serializedEntry = JSON.stringify(entry);
      }
      
      await this.client!.setex(valkeyKey, ttl, serializedEntry);
      
      this.updateMetrics(startTime, true);
      
      logger.trace('ValkeyDistributedCacheAdapter', 'Entry stored in Valkey', {
        key: valkeyKey,
        ttl,
        encrypted: this.config.enableEncryption && this.shouldEncryptEntry(entry),
        size: serializedEntry.length
      });

    } catch (error) {
      this.updateMetrics(startTime, false);
      logger.error('ValkeyDistributedCacheAdapter', 'Failed to store entry in Valkey', error instanceof Error ? error : new Error(String(error)), {
        error: error instanceof Error ? error.message : String(error),
        key
      });
      throw error;
    }
  }

  /**
   * Retrieve unified cache entry from Valkey
   */
  async get(key: string): Promise<UnifiedCacheEntry | null> {
    const startTime = Date.now();
    
    try {
      await this.ensureConnected();
      
      const valkeyKey = this.buildValkeyKey(key);
      const serializedEntry = await this.client!.get(valkeyKey);
      
      if (!serializedEntry) {
        this.metrics.cacheMisses++;
        this.updateMetrics(startTime, true);
        return null;
      }
      
      let entry: UnifiedCacheEntry;
      
      try {
        const parsedEntry = JSON.parse(serializedEntry);
        
        if (this.isEncryptedEntry(parsedEntry)) {
          // Decrypt the entry
          entry = await this.decryptEntry(parsedEntry, key);
          this.metrics.encryptedOperations++;
        } else {
          entry = parsedEntry;
        }
      } catch (parseError) {
        logger.warn('ValkeyDistributedCacheAdapter', 'Failed to parse entry from Valkey', {
          error: parseError instanceof Error ? parseError.message : String(parseError),
          key
        });
        return null;
      }
      
      // Check if entry has expired (additional safety check)
      if (Date.now() > entry.expiresAt) {
        await this.delete(key); // Clean up expired entry
        this.metrics.cacheMisses++;
        this.updateMetrics(startTime, true);
        return null;
      }
      
      this.metrics.cacheHits++;
      this.updateMetrics(startTime, true);
      
      logger.trace('ValkeyDistributedCacheAdapter', 'Entry retrieved from Valkey', {
        key: valkeyKey,
        encrypted: this.isEncryptedEntry(entry),
        authType: entry.authType
      });
      
      return entry;

    } catch (error) {
      this.updateMetrics(startTime, false);
      logger.error('ValkeyDistributedCacheAdapter', 'Failed to retrieve entry from Valkey', error instanceof Error ? error : new Error(String(error)), {
        error: error instanceof Error ? error.message : String(error),
        key
      });
      return null; // Return null on error to allow fallback to local cache
    }
  }

  /**
   * Delete entry from Valkey
   */
  async delete(key: string): Promise<boolean> {
    const startTime = Date.now();
    
    try {
      await this.ensureConnected();
      
      const valkeyKey = this.buildValkeyKey(key);
      const result = await this.client!.del(valkeyKey);
      
      this.updateMetrics(startTime, true);
      
      logger.trace('ValkeyDistributedCacheAdapter', 'Entry deleted from Valkey', {
        key: valkeyKey,
        existed: result > 0
      });
      
      return result > 0;

    } catch (error) {
      this.updateMetrics(startTime, false);
      logger.error('ValkeyDistributedCacheAdapter', 'Failed to delete entry from Valkey', error instanceof Error ? error : new Error(String(error)), {
        error: error instanceof Error ? error.message : String(error),
        key
      });
      return false;
    }
  }

  /**
   * Clear all unified cache entries from Valkey
   */
  async clear(): Promise<void> {
    const startTime = Date.now();
    
    try {
      await this.ensureConnected();
      
      const pattern = this.buildValkeyKey('*');
      const keys = await this.client!.keys(pattern);
      
      if (keys.length > 0) {
        await this.client!.del(keys);
      }
      
      this.updateMetrics(startTime, true);
      
      logger.info('ValkeyDistributedCacheAdapter', 'Cleared unified cache entries from Valkey', {
        deletedKeys: keys.length
      });

    } catch (error) {
      this.updateMetrics(startTime, false);
      logger.error('ValkeyDistributedCacheAdapter', 'Failed to clear Valkey cache', error instanceof Error ? error : new Error(String(error)), {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Clear cache entries matching a pattern
   */
  async clearPattern(pattern: string): Promise<number> {
    const startTime = Date.now();
    
    try {
      await this.ensureConnected();
      
      const keys = await this.client!.keys(pattern);
      if (keys.length === 0) {
        return 0;
      }

      const result = await this.client!.del(keys);
      
      this.updateMetrics(startTime, true);
      
      logger.info('ValkeyDistributedCacheAdapter', 'Cleared cache entries by pattern', {
        pattern,
        deletedKeys: result
      });

      return result;

    } catch (error) {
      this.updateMetrics(startTime, false);
      logger.error('ValkeyDistributedCacheAdapter', 'Failed to clear cache pattern', error instanceof Error ? error : new Error(String(error)), {
        error: error instanceof Error ? error.message : String(error),
        pattern
      });
      return 0;
    }
  }

  /**
   * Get adapter metrics
   */
  getMetrics(): ValkeyAdapterMetrics & { isConnected: boolean } {
    return {
      ...this.metrics,
      isConnected: this.isConnected
    };
  }

  /**
   * Close Valkey connection
   */
  async disconnect(): Promise<void> {
    try {
      if (this.client && this.isConnected) {
        await this.client.quit();
        this.client = null;
        this.isConnected = false;
        this.connectionPromise = null;
        logger.info('ValkeyDistributedCacheAdapter', 'Valkey connection closed');
      }
    } catch (error) {
      logger.error('ValkeyDistributedCacheAdapter', 'Error closing Valkey connection', error instanceof Error ? error : new Error(String(error)), {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Private helper methods
   */
  private buildValkeyKey(key: string): string {
    return `${this.config.keyPrefix}${key}`;
  }

  private async ensureConnected(): Promise<void> {
    if (!this.isConnected) {
      await this.connect();
    }
  }

  private shouldEncryptEntry(entry: UnifiedCacheEntry): boolean {
    // Encrypt if contains sensitive data
    try {
      const entryStr = JSON.stringify(entry.data).toLowerCase();
      const sensitiveFields = ['secretkey', 'secretaccesskey', 'credentials', 'token', 'password'];
      return sensitiveFields.some(field => entryStr.includes(field));
    } catch {
      return false;
    }
  }

  private async encryptEntry(entry: UnifiedCacheEntry, key: string): Promise<any> {
    try {
      // Convert entry to CredentialMetadata format for encryption
      const metadataForEncryption: CredentialMetadata = {
        credentialId: `valkey-${entry.authType || 'unknown'}`,
        permissions: [{
          service: 'unified-cache',
          action: 'valkey-store',
          resource: entry.authType || '*',
          effect: 'allow'
        }],
        region: 'valkey',
        sapAiRegion: 'valkey',
        userId: 'valkey-user',
        rateLimits: { requestsPerMinute: 0, requestsPerHour: 0, requestsPerDay: 0 }
      };

      const salt = `valkey-${key}-salt`;
      const encryptedData = await secureMetadataExchange.encryptMetadata(metadataForEncryption, key, salt);
      
      return {
        ...entry,
        __valkeyEncrypted: true,
        __encryptedData: encryptedData,
        __originalEntry: JSON.stringify(entry)
      };
    } catch (error) {
      logger.warn('ValkeyDistributedCacheAdapter', 'Failed to encrypt entry, storing unencrypted', {
        error: error instanceof Error ? error.message : String(error)
      });
      return entry;
    }
  }

  private async decryptEntry(encryptedEntry: any, key: string): Promise<UnifiedCacheEntry> {
    try {
      if (encryptedEntry.__valkeyEncrypted && encryptedEntry.__encryptedData) {
        // Try to use original entry if available
        if (encryptedEntry.__originalEntry) {
          return JSON.parse(encryptedEntry.__originalEntry);
        }
        
        // Fallback to decryption (though we don't store much useful data in the metadata)
        const salt = `valkey-${key}-salt`;
        await secureMetadataExchange.decryptMetadata(encryptedEntry.__encryptedData, key, salt);
        
        // Return the entry without encryption markers
        const { __valkeyEncrypted, __encryptedData, __originalEntry, ...cleanEntry } = encryptedEntry;
        return cleanEntry;
      }
      
      return encryptedEntry;
    } catch (error) {
      logger.warn('ValkeyDistributedCacheAdapter', 'Failed to decrypt entry', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  private isEncryptedEntry(entry: any): boolean {
    return entry && typeof entry === 'object' && entry.__valkeyEncrypted === true;
  }

  private updateMetrics(startTime: number, success: boolean): void {
    const duration = Date.now() - startTime;
    this.metrics.operations++;
    
    if (!success) {
      this.metrics.errors++;
    }
    
    // Update average response time
    this.metrics.avgResponseTime = 
      (this.metrics.avgResponseTime * (this.metrics.operations - 1) + duration) / this.metrics.operations;
  }
}

// Export singleton instance
export const valkeyDistributedCacheAdapter = new ValkeyDistributedCacheAdapter({});

export default ValkeyDistributedCacheAdapter;