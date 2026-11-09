import { CacheInvalidationService, CacheInvalidationConfig, CacheInvalidationEvent, CacheService } from '../../../../libs/cache-invalidation/cacheInvalidationService';
import { isStandaloneMode } from '../config/unifiedAuthConfig';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

/**
 * No-op cache invalidation service for standalone mode
 */
class NoOpCacheInvalidationService {
  private logger: any;
  private config: CacheInvalidationConfig;

  constructor(config: CacheInvalidationConfig, logger: any) {
    this.config = config;
    this.logger = logger;
  }

  async initialize(): Promise<void> {
    this.logger.info('CacheInvalidationService', 'Running in standalone mode - cache invalidation disabled');
  }

  async shutdown(): Promise<void> {
    // No-op
  }

  registerCacheService(service: CacheService): void {
    // No-op
  }

  async publishInvalidationEvent(event: CacheInvalidationEvent): Promise<boolean> {
    if (this.config.enableLogging) {
      this.logger.debug('CacheInvalidationService', 'Standalone mode - ignoring cache invalidation event:', event);
    }
    return true; // Always succeed in standalone mode
  }

  async invalidateByCredential(credentialId: string, authType: 'api_key' | 'aws_credential', reason?: string): Promise<boolean> {
    if (this.config.enableLogging) {
      this.logger.debug('CacheInvalidationService', `Standalone mode - ignoring invalidation for ${authType}:${credentialId}`);
    }
    return true;
  }

  isHealthy(): boolean {
    return true; // Always healthy in standalone mode
  }

  getConnectionStatus(): { command: boolean; subscriber: boolean } {
    return { command: true, subscriber: true }; // Always connected in standalone mode
  }
}

/**
 * Factory function to create appropriate cache invalidation service
 */
function createCacheInvalidationService(): CacheInvalidationService | NoOpCacheInvalidationService {
  const config = {
    valkeyUrl: process.env.VALKEY_URL,
    channelName: 'cache-invalidation',
    enableLogging: true,
    serviceName: 'gateway'
  };

  if (isStandaloneMode()) {
    return new NoOpCacheInvalidationService(config, logger);
  }

  return new CacheInvalidationService(config, logger);
}

// Create gateway service instance of cache invalidation service
export const gatewayCacheInvalidationService = createCacheInvalidationService();

export default gatewayCacheInvalidationService;