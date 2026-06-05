import configService from './configService';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

interface RateLimitInfo {
  nextAllowedTime: number;
  delaySeconds: number;
  consecutiveRateLimits: number;
  lastRateLimitTime: number;
  errorMessage: string;
}

interface RateLimitConfig {
  enabled?: boolean;
  default_delay_seconds?: number;
  backoff_multiplier?: number;
  max_delay_seconds?: number;
  subpath_specific_delays?: Record<string, number>;
  model_specific_delays?: Record<string, number>;
}

interface Config {
  api_config: {
    [provider: string]: any;
    rate_limit_handling?: RateLimitConfig;
  };
}

interface RateLimitStatus {
  totalRateLimitedEndpoints: number;
  activeDelays: number;
  rateLimitedEndpoints: Record<string, {
    delaySeconds: number;
    consecutiveRateLimits: number;
    timeRemainingMs: number;
    timeRemainingSeconds: number;
    lastRateLimitTime: string;
    errorMessage: string;
  }>;
}

interface RateLimitError extends Error {
  response?: {
    status?: number;
  };
}

class RateLimitManager {
  private rateLimitedEndpoints: Map<string, RateLimitInfo>;
  private activeDelays: Set<string>;

  constructor() {
    // Map to track rate-limited endpoints: key = "modelId:subpath", value = { nextAllowedTime, delaySeconds, consecutiveRateLimits }
    this.rateLimitedEndpoints = new Map<string, RateLimitInfo>();
    
    // Track active delays to prevent duplicate delays for the same endpoint
    this.activeDelays = new Set<string>();
  }

  /**
   * Get the configured delay for a specific model and subpath
   * @param modelId - The model ID
   * @param subpath - The API subpath
   * @returns Delay in seconds
   */
  async getConfiguredDelay(modelId: string, subpath: string): Promise<number> {
    const config: Config = await configService.getConfigAsync();
    const rateLimitConfig = config?.api_config?.rate_limit_handling;
    
    if (!rateLimitConfig || !rateLimitConfig.enabled) {
      return 0;
    }

    // Check for subpath-specific delay
    if (rateLimitConfig.subpath_specific_delays && rateLimitConfig.subpath_specific_delays[subpath]) {
      return rateLimitConfig.subpath_specific_delays[subpath];
    }

    // Check for model-specific delay
    if (rateLimitConfig.model_specific_delays && rateLimitConfig.model_specific_delays[modelId]) {
      return rateLimitConfig.model_specific_delays[modelId];
    }

    // Return default delay
    return rateLimitConfig.default_delay_seconds || 30;
  }

  /**
   * Check if we need to delay a request due to previous rate limits
   * @param modelId - The model ID
   * @param subpath - The API subpath
   * @returns Returns the delay applied in milliseconds (0 if no delay)
   */
  async checkAndApplyDelay(modelId: string, subpath: string): Promise<number> {
    const endpointKey = `${modelId}:${subpath}`;
    const rateLimitInfo = this.rateLimitedEndpoints.get(endpointKey);
    
    if (!rateLimitInfo) {
      return 0; // No previous rate limit
    }

    const now = Date.now();
    const timeUntilAllowed = rateLimitInfo.nextAllowedTime - now;
    
    if (timeUntilAllowed <= 0) {
      // Rate limit period has passed
      logger.info('RateLimitManager', `Rate limit period expired for ${endpointKey}`);
      return 0;
    }

    // Prevent duplicate delays for the same endpoint
    if (this.activeDelays.has(endpointKey)) {
      logger.warn('RateLimitManager', `Concurrent request detected for rate-limited endpoint ${endpointKey}, skipping additional delay`);
      return 0;
    }

    // Apply delay
    this.activeDelays.add(endpointKey);
    const delayMs = timeUntilAllowed;
    
    logger.warn('RateLimitManager', `Applying rate limit delay of ${Math.ceil(delayMs / 1000)}s for ${endpointKey} (${rateLimitInfo.consecutiveRateLimits} consecutive rate limits)`);
    
    try {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      return delayMs;
    } finally {
      this.activeDelays.delete(endpointKey);
    }
  }

  /**
   * Record a rate limit occurrence
   * @param modelId - The model ID
   * @param subpath - The API subpath
   * @param error - The rate limit error (optional, for additional context)
   */
  async recordRateLimit(modelId: string, subpath: string, error: RateLimitError | null = null): Promise<void> {
    const endpointKey = `${modelId}:${subpath}`;
    const configuredDelay = await this.getConfiguredDelay(modelId, subpath);
    
    logger.debug('RateLimitManager', `recordRateLimit called for ${endpointKey}, configuredDelay: ${configuredDelay}`);
    
    if (configuredDelay === 0) {
      logger.debug('RateLimitManager', `Rate limit handling disabled for ${endpointKey}`);
      return;
    }

    const existing = this.rateLimitedEndpoints.get(endpointKey);
    let delaySeconds = configuredDelay;
    let consecutiveRateLimits = 1;

    if (existing) {
      // Apply exponential backoff for consecutive rate limits
      const config: Config = await configService.getConfigAsync();
      const rateLimitConfig = config?.api_config?.rate_limit_handling;
      const backoffMultiplier = rateLimitConfig?.backoff_multiplier || 1.5;
      const maxDelay = rateLimitConfig?.max_delay_seconds || 300;
      
      consecutiveRateLimits = existing.consecutiveRateLimits + 1;
      delaySeconds = Math.min(existing.delaySeconds * backoffMultiplier, maxDelay);
    }

    const nextAllowedTime = Date.now() + (delaySeconds * 1000);
    
    this.rateLimitedEndpoints.set(endpointKey, {
      nextAllowedTime,
      delaySeconds,
      consecutiveRateLimits,
      lastRateLimitTime: Date.now(),
      errorMessage: error?.message || 'Rate limit detected'
    });

    logger.warn('RateLimitManager', `Rate limit recorded for ${endpointKey}: ${delaySeconds}s delay, ${consecutiveRateLimits} consecutive limits`);
  }

  /**
   * Record a successful request (clears rate limit for that endpoint)
   * @param modelId - The model ID
   * @param subpath - The API subpath
   */
  recordSuccess(modelId: string, subpath: string): void {
    const endpointKey = `${modelId}:${subpath}`;
    
    if (this.rateLimitedEndpoints.has(endpointKey)) {
      logger.info('RateLimitManager', `Successful request for ${endpointKey}, clearing rate limit`);
      this.rateLimitedEndpoints.delete(endpointKey);
    }
  }

  /**
   * Check if an error is a rate limit error
   * @param error - The error to check
   * @returns True if it's a rate limit error
   */
  isRateLimitError(error: RateLimitError | null | undefined): boolean {
    if (!error) return false;
    
    // Check for 429 status code
    if (error.response && error.response.status === 429) {
      logger.debug('RateLimitManager', `Rate limit detected via 429 status code`);
      return true;
    }
    
    // Check for rate limit keywords in error message
    const errorMessage = (error.message || '').toLowerCase();
    const rateLimitKeywords = [
      'too many requests',
      'rate limit',
      'throttled',
      'quota exceeded',
      'too many tokens',
      'please wait before trying again'
    ];
    
    const isRateLimit = rateLimitKeywords.some(keyword => errorMessage.includes(keyword));
    if (isRateLimit) {
      logger.debug('RateLimitManager', `Rate limit detected via error message keyword`);
    }
    
    return isRateLimit;
  }

  /**
   * Get current rate limit status for debugging
   * @returns Current rate limit status
   */
  getStatus(): RateLimitStatus {
    const status: RateLimitStatus = {
      totalRateLimitedEndpoints: this.rateLimitedEndpoints.size,
      activeDelays: this.activeDelays.size,
      rateLimitedEndpoints: {}
    };

    const now = Date.now();
    this.rateLimitedEndpoints.forEach((info, endpointKey) => {
      const timeRemaining = Math.max(0, info.nextAllowedTime - now);
      status.rateLimitedEndpoints[endpointKey] = {
        delaySeconds: info.delaySeconds,
        consecutiveRateLimits: info.consecutiveRateLimits,
        timeRemainingMs: timeRemaining,
        timeRemainingSeconds: Math.ceil(timeRemaining / 1000),
        lastRateLimitTime: new Date(info.lastRateLimitTime).toISOString(),
        errorMessage: info.errorMessage
      };
    });

    return status;
  }

  /**
   * Clear all rate limits (for testing/debugging)
   */
  clearAllRateLimits(): void {
    const count = this.rateLimitedEndpoints.size;
    this.rateLimitedEndpoints.clear();
    this.activeDelays.clear();
    logger.info('RateLimitManager', `Cleared ${count} rate limit entries`);
  }
}

// Export singleton instance
export default new RateLimitManager();