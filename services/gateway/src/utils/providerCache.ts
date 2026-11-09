import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

interface ModelInfo {
  id: string;
  owned_by?: string;
  [key: string]: any;
}

/**
 * Cache for mapping model IDs to their providers (owned_by field)
 * This provides high-performance provider resolution for usage tracking
 */
class ProviderCache {
  private cache = new Map<string, string>();
  private initialized = false;

  /**
   * Populate the cache with model data
   * Called after models are fetched from SAP AI Core
   */
  populate(models: ModelInfo[]): void {
    const previousSize = this.cache.size;
    
    models.forEach(model => {
      if (model.owned_by) {
        this.cache.set(model.id, model.owned_by);
      }
    });

    const newSize = this.cache.size;
    this.initialized = true;
    
    logger.info('ProviderCache', `Provider cache populated: ${newSize} entries (${newSize - previousSize} new)`);
    
    if (process.env.DEBUG === 'true') {
      logger.debug('ProviderCache', `Cache contents: ${JSON.stringify(Array.from(this.cache.entries()))}`);
    }
  }

  /**
   * Get the provider for a given model ID
   * Returns 'unknown' if provider cannot be determined
   */
  getProvider(modelId: string): string {
    if (!this.initialized) {
      logger.warn('ProviderCache', 'Cache not initialized, returning unknown provider');
      return 'unknown';
    }
    
    const provider = this.cache.get(modelId);
    if (!provider) {
      logger.debug('ProviderCache', `No provider found for model: ${modelId}`);
      return 'unknown';
    }
    
    return provider;
  }

  /**
   * Clear the cache
   * Useful for testing or forced refresh scenarios
   */
  clear(): void {
    this.cache.clear();
    this.initialized = false;
    logger.debug('ProviderCache', 'Provider cache cleared');
  }

  /**
   * Get cache statistics
   */
  getStats(): { size: number; initialized: boolean } {
    return {
      size: this.cache.size,
      initialized: this.initialized
    };
  }
}

// Export singleton instance
export const providerCache = new ProviderCache();
export default providerCache;