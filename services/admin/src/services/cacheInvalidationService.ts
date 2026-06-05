import { CacheInvalidationService } from '@libs/cache-invalidation/cacheInvalidationService';
import { getDefaultLogger } from '@libs/logger';

const logger = getDefaultLogger();

// Create admin service instance of cache invalidation service
export const cacheInvalidationService = new CacheInvalidationService({
  valkeyUrl: process.env.VALKEY_URL,
  channelName: 'cache-invalidation',
  enableLogging: true,
  serviceName: 'admin'
}, logger);

export default cacheInvalidationService;