import { createHash } from 'crypto';

// Make Valkey optional since it may not be installed
let Redis: any;
try {
  Redis = require('iovalkey');
} catch (error) {
  console.warn('iovalkey not available - cache invalidation will be limited');
}

/**
 * The credential part of a unified cache key ('unified:<apikey|token>:<hash>'). The gateway's
 * UnifiedValidationCache keys its entries with this, and buildSpecificCacheKey below addresses them
 * with it, so an invalidation event - which carries the raw credential - hits exactly the key that
 * was written. Full SHA-256: two credentials share a key only through a SHA-256 collision, so a
 * cache hit can never be served to a different credential.
 */
export function hashUnifiedCacheCredential(credential: string): string {
  return createHash('sha256').update(credential).digest('hex');
}

/**
 * Short, non-reversible label for a credential in a log line - never the raw value. Mirrors
 * services/gateway/src/utils/secretLabel.ts and libs/logger's own hashForLabel; libs/ must not
 * import from a service, so this reuses the SHA-256 already computed above rather than adding a
 * third copy of the same hashing helper.
 */
function credentialLabel(credential: string): string {
  return hashUnifiedCacheCredential(credential).slice(0, 8);
}

export interface CacheInvalidationEvent {
  type: 'api_key_disabled' | 'api_key_deleted' | 'aws_credential_disabled' | 'aws_credential_deleted' | 'manual_invalidation' | 'pattern_invalidation';
  /** Credential events only. A 'pattern_invalidation' carries `pattern` instead. */
  credentialId?: string;
  authType?: 'api_key' | 'aws_credential';
  /** 'pattern_invalidation' only: the key pattern every subscriber must clear, e.g. 'unified-cache:*'. */
  pattern?: string;
  reason?: string;
  timestamp: number;
  requestId?: string;
}

export interface CacheInvalidationConfig {
  valkeyUrl?: string;
  channelName: string;
  enableLogging: boolean;
  serviceName: string; // 'admin' or 'gateway'
}

export interface CacheService {
  name: string;
  clearByCredentialId: (credentialId: string, authType: 'api_key' | 'aws_credential') => Promise<boolean>;
  clearByPattern?: (pattern: string) => Promise<number>;
}

/**
 * Shared cache invalidation service for both admin and gateway services
 * Handles publishing and subscribing to cache invalidation events via ValKey pub/sub
 */
export class CacheInvalidationService {
  private config: CacheInvalidationConfig;
  private subscriberClient?: any;
  private commandClient?: any;
  private isSubscriberConnected = false;
  private isCommandConnected = false;
  private registeredCacheServices: CacheService[] = [];
  private logger: any;

  constructor(config: CacheInvalidationConfig, logger: any) {
    this.config = {
      ...config,
      channelName: config.channelName || 'cache-invalidation',
      enableLogging: config.enableLogging !== undefined ? config.enableLogging : true
    };
    this.logger = logger;
  }

  /**
   * Initialize the cache invalidation service
   */
  async initialize(): Promise<void> {
    try {
      if (this.config.valkeyUrl && Redis) {
        this.logger.info('CacheInvalidationService', `Initializing ValKey clients for cache invalidation (${this.config.serviceName})`);
        
        // Initialize command client (used by both admin and gateway for regular operations)
        this.commandClient = new Redis(this.config.valkeyUrl);
        
        this.commandClient.on('error', (err: Error) => {
          this.logger.warn('CacheInvalidationService', 'ValKey command client error:', err instanceof Error ? err.message : String(err));
          this.isCommandConnected = false;
        });

        this.commandClient.on('connect', () => {
          this.logger.info('CacheInvalidationService', `Command client connected to ValKey (${this.config.serviceName})`);
          this.isCommandConnected = true;
        });

        // Initialize subscriber client for gateway service
        if (this.config.serviceName === 'gateway') {
          this.subscriberClient = new Redis(this.config.valkeyUrl);
          
          this.subscriberClient.on('error', (err: Error) => {
            this.logger.warn('CacheInvalidationService', 'ValKey subscriber client error:', err instanceof Error ? err.message : String(err));
            this.isSubscriberConnected = false;
          });

          this.subscriberClient.on('connect', () => {
            this.logger.info('CacheInvalidationService', `Subscriber client connected to ValKey (${this.config.serviceName})`);
            this.isSubscriberConnected = true;
          });

          // Set up message handler for subscribers
          this.subscriberClient.on('message', (channel: string, message: string) => {
            this.handleInvalidationEvent(channel, message);
          });

          // Subscribe to cache invalidation events
          await this.subscriberClient.subscribe(this.config.channelName);
          this.logger.info('CacheInvalidationService', `Subscribed to ${this.config.channelName} channel`);
        }

        // Test command client connection
        await this.commandClient.ping();
        this.logger.info('CacheInvalidationService', `Cache invalidation service initialized successfully (${this.config.serviceName})`);
      } else {
        this.logger.warn('CacheInvalidationService', 'ValKey not available - cache invalidation will be limited to local operations');
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('CacheInvalidationService', `Failed to initialize cache invalidation service: ${errorMsg}`);
      throw error;
    }
  }

  /**
   * Register a cache service for invalidation (gateway only)
   */
  registerCacheService(service: CacheService): void {
    if (this.config.serviceName !== 'gateway') {
      this.logger.warn('CacheInvalidationService', 'Cache service registration is only available for gateway service');
      return;
    }

    this.registeredCacheServices.push(service);
    this.logger.info('CacheInvalidationService', `Registered cache service: ${service.name}`);
  }

  /**
   * Invalidate cache for an API key (admin service publishes, gateway receives)
   */
  async invalidateApiKey(keyId: string, reason: 'disabled' | 'deleted' | 'manual' = 'manual', requestId?: string): Promise<void> {
    const event: CacheInvalidationEvent = {
      type: reason === 'disabled' ? 'api_key_disabled' : reason === 'deleted' ? 'api_key_deleted' : 'manual_invalidation',
      credentialId: keyId,
      authType: 'api_key',
      reason,
      timestamp: Date.now(),
      requestId
    };

    await this.publishInvalidationEvent(event);
    
    if (this.config.enableLogging) {
      this.logger.info('CacheInvalidationService', `Invalidated API key cache: ${credentialLabel(keyId)} (reason: ${reason}) - using specific cache key invalidation`);
    }
  }

  /**
   * Invalidate cache for AWS credentials
   */
  async invalidateAwsCredential(credentialId: string, reason: 'disabled' | 'deleted' | 'manual' = 'manual', requestId?: string): Promise<void> {
    const event: CacheInvalidationEvent = {
      type: reason === 'disabled' ? 'aws_credential_disabled' : reason === 'deleted' ? 'aws_credential_deleted' : 'manual_invalidation',
      credentialId,
      authType: 'aws_credential',
      reason,
      timestamp: Date.now(),
      requestId
    };

    await this.publishInvalidationEvent(event);
    
    if (this.config.enableLogging) {
      this.logger.info('CacheInvalidationService', `Invalidated AWS credential cache: ${credentialLabel(credentialId)} (reason: ${reason}) - using specific cache key invalidation`);
    }
  }

  /**
   * Bulk invalidate multiple cache entries
   */
  async bulkInvalidate(invalidations: Array<{credentialId: string, authType: 'api_key' | 'aws_credential', reason?: string}>): Promise<void> {
    const promises = invalidations.map(inv => {
      if (inv.authType === 'api_key') {
        return this.invalidateApiKey(inv.credentialId, 'manual');
      } else {
        return this.invalidateAwsCredential(inv.credentialId, 'manual');
      }
    });

    await Promise.all(promises);
    
    if (this.config.enableLogging) {
      this.logger.info('CacheInvalidationService', `Bulk invalidated ${invalidations.length} cache entries`);
    }
  }

  /**
   * Invalidate every cache entry matching a key pattern, everywhere.
   *
   * Deleting the Valkey keys is only half the job: each gateway process also holds the same
   * validations in memory, and nothing in a KEYS+DEL reaches those. So this clears the
   * distributed keys AND publishes a 'pattern_invalidation' that every subscriber dispatches to
   * its registered caches' clearByPattern. Used when a change affects everyone at once - a
   * default entitlement catalog change, for instance - where per-credential invalidation would
   * mean enumerating every credential in the system.
   *
   * Distributed keys go first: a subscriber that cleared its memory before the Valkey keys were
   * gone would just repopulate from them.
   */
  async invalidatePattern(pattern: string, reason?: string, requestId?: string): Promise<number> {
    const cleared = await this.clearCachePattern(pattern);

    const event: CacheInvalidationEvent = {
      type: 'pattern_invalidation',
      pattern,
      reason,
      timestamp: Date.now(),
      requestId
    };
    await this.publishInvalidationEvent(event);

    if (this.config.enableLogging) {
      this.logger.info('CacheInvalidationService', `Invalidated cache pattern ${pattern} (reason: ${reason ?? 'manual'}) - ${cleared} distributed key(s), published to subscribers`);
    }

    return cleared;
  }

  /**
   * Clear specific cache keys directly
   */
  async clearCacheKey(cacheKey: string): Promise<boolean> {
    if (!this.commandClient || !this.isCommandConnected) {
      this.logger.warn('CacheInvalidationService', 'Cannot clear cache key - ValKey command client not connected');
      return false;
    }

    try {
      const result = await this.commandClient.del(cacheKey);
      
      if (this.config.enableLogging) {
        this.logger.info('CacheInvalidationService', `Cleared cache key: ${cacheKey} (${result ? 'found' : 'not found'})`);
      }
      
      return result > 0;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('CacheInvalidationService', `Failed to clear cache key ${cacheKey}: ${errorMsg}`);
      return false;
    }
  }

  /**
   * Clear all cache keys matching a pattern
   */
  async clearCachePattern(pattern: string): Promise<number> {
    if (!this.commandClient || !this.isCommandConnected) {
      this.logger.warn('CacheInvalidationService', 'Cannot clear cache pattern - ValKey command client not connected');
      return 0;
    }

    try {
      const keys = await this.commandClient.keys(pattern);
      if (keys.length === 0) {
        return 0;
      }

      const result = await this.commandClient.del(...keys);
      
      if (this.config.enableLogging) {
        this.logger.info('CacheInvalidationService', `Cleared ${result} cache keys matching pattern: ${pattern}`);
      }
      
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('CacheInvalidationService', `Failed to clear cache pattern ${pattern}: ${errorMsg}`);
      return 0;
    }
  }

  /**
   * Handle incoming cache invalidation events (gateway only)
   */
  private async handleInvalidationEvent(channel: string, message: string): Promise<void> {
    if (this.config.serviceName !== 'gateway') return;

    try {
      if (channel !== this.config.channelName) return;

      // Skip null or empty messages
      if (message === null || message === undefined || message === '') {
        this.logger.debug('CacheInvalidationService', 'Skipping null/empty invalidation message');
        return;
      }

      const event: CacheInvalidationEvent = JSON.parse(message);
      
      if (this.config.enableLogging) {
        this.logger.info('CacheInvalidationService', `Received invalidation event: ${event.type} for ${event.pattern ?? (event.credentialId ? credentialLabel(event.credentialId) : undefined)}`);
      }

      // Process the invalidation event
      await this.processInvalidationEvent(event);

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      // `message` is the raw pub/sub payload, which for a credential event carries the raw
      // credentialId - never log it verbatim; a label still lets repeated bad messages be
      // correlated without exposing anything.
      this.logger.warn('CacheInvalidationService', `Failed to process invalidation event: ${errorMsg} - message label: ${credentialLabel(message)}`);
    }
  }

  /**
   * Process a cache invalidation event (gateway only).
   *
   * Public so the dispatch can be driven directly by a test: everything above it is ValKey
   * plumbing, and a wiring bug here (an event type nobody dispatches) is invisible from outside.
   */
  async processInvalidationEvent(event: CacheInvalidationEvent): Promise<void> {
    if (this.config.serviceName !== 'gateway') return;

    if (event.type === 'pattern_invalidation') {
      await this.processPatternInvalidation(event);
      return;
    }

    if (!event.credentialId || !event.authType) {
      this.logger.warn('CacheInvalidationService', `Ignoring ${event.type} event without a credentialId/authType`);
      return;
    }

    const startTime = Date.now();
    let totalCleared = 0;

    // Clear cache in all registered services
    for (const service of this.registeredCacheServices) {
      try {
        const cleared = await service.clearByCredentialId(event.credentialId, event.authType);
        if (cleared) {
          totalCleared++;
          this.logger.debug('CacheInvalidationService', `Cleared cache in ${service.name} for ${credentialLabel(event.credentialId)}`);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        this.logger.warn('CacheInvalidationService', `Failed to clear cache in ${service.name}: ${errorMsg}`);
      }
    }

    // Also clear ValKey distributed cache entries directly
    if (this.commandClient && this.isCommandConnected) {
      try {
        const specificCacheKey = this.buildSpecificCacheKey(event.credentialId, event.authType);
        const distributedCleared = await this.clearCacheKey(specificCacheKey);
        if (distributedCleared) {
          totalCleared += 1;
          this.logger.debug('CacheInvalidationService', `Cleared specific cache key: ${specificCacheKey}`);
        } else {
          this.logger.debug('CacheInvalidationService', `Cache key not found (may have already expired): ${specificCacheKey}`);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        this.logger.warn('CacheInvalidationService', `Failed to clear distributed cache: ${errorMsg}`);
      }
    }

    const processingTime = Date.now() - startTime;
    
    if (this.config.enableLogging) {
      this.logger.info('CacheInvalidationService',
        `Processed invalidation for ${credentialLabel(event.credentialId)}: cleared ${totalCleared} entries in ${processingTime}ms`);
    }
  }

  /**
   * A pattern event reaches the in-process caches, which a KEYS+DEL on ValKey never touches.
   * A registered cache without clearByPattern is skipped rather than treated as an error - the
   * capability is optional on the CacheService contract.
   */
  private async processPatternInvalidation(event: CacheInvalidationEvent): Promise<void> {
    const pattern = event.pattern;
    if (!pattern) {
      this.logger.warn('CacheInvalidationService', 'Ignoring pattern_invalidation event without a pattern');
      return;
    }

    const startTime = Date.now();
    let totalCleared = 0;

    for (const service of this.registeredCacheServices) {
      if (typeof service.clearByPattern !== 'function') {
        this.logger.debug('CacheInvalidationService', `${service.name} has no clearByPattern - skipping pattern ${pattern}`);
        continue;
      }
      try {
        const cleared = await service.clearByPattern(pattern);
        totalCleared += typeof cleared === 'number' ? cleared : 0;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        this.logger.warn('CacheInvalidationService', `Failed to clear pattern ${pattern} in ${service.name}: ${errorMsg}`);
      }
    }

    if (this.config.enableLogging) {
      this.logger.info('CacheInvalidationService',
        `Processed pattern invalidation ${pattern}: cleared ${totalCleared} entries in ${Date.now() - startTime}ms`);
    }
  }

  /**
   * Build specific cache key for a credential (replaces wildcard pattern approach)
   */
  private buildSpecificCacheKey(credentialId: string, authType: 'api_key' | 'aws_credential'): string {
    // Build the specific cache key that matches the unified cache system
    // This ensures we only clear the cache entry for the specific rotated credential
    const prefix = authType === 'api_key' ? 'apikey' : 'token';
    const keyHash = hashUnifiedCacheCredential(credentialId);
    return `unified-cache:unified:${prefix}:${keyHash}`;
  }

  /**
   * Publish cache invalidation event to ValKey pub/sub
   */
  private async publishInvalidationEvent(event: CacheInvalidationEvent): Promise<void> {
    if (!this.commandClient || !this.isCommandConnected) {
      this.logger.warn('CacheInvalidationService', 'Cannot publish invalidation event - ValKey command client not connected');
      return;
    }

    try {
      const eventJson = JSON.stringify(event);
      await this.commandClient.publish(this.config.channelName, eventJson);
      
      if (this.config.enableLogging) {
        this.logger.debug('CacheInvalidationService', `Published invalidation event: ${event.type} for ${event.pattern ?? (event.credentialId ? credentialLabel(event.credentialId) : undefined)}`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('CacheInvalidationService', `Failed to publish invalidation event: ${errorMsg}`);
    }
  }

  /**
   * Get service status
   */
  getStatus(): { 
    commandConnected: boolean;
    subscriberConnected: boolean;
    valkeyAvailable: boolean; 
    channelName: string; 
    serviceName: string;
    registeredServices: string[];
  } {
    return {
      commandConnected: this.isCommandConnected,
      subscriberConnected: this.isSubscriberConnected,
      valkeyAvailable: !!this.commandClient,
      channelName: this.config.channelName,
      serviceName: this.config.serviceName,
      registeredServices: this.registeredCacheServices.map(s => s.name)
    };
  }

  /**
   * Shutdown the service
   */
  async shutdown(): Promise<void> {
    const shutdownPromises: Promise<void>[] = [];
    
    if (this.commandClient) {
      shutdownPromises.push(this.commandClient.quit().then(() => {
        this.isCommandConnected = false;
      }));
    }
    
    if (this.subscriberClient) {
      shutdownPromises.push(this.subscriberClient.quit().then(() => {
        this.isSubscriberConnected = false;
      }));
    }
    
    await Promise.all(shutdownPromises);
    this.logger.info('CacheInvalidationService', `Cache invalidation service shutdown complete (${this.config.serviceName})`);
  }
}