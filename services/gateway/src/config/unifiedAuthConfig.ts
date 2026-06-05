/**
 * Unified Authentication Configuration
 * 
 * Manages environment-based configuration for the unified token authentication system.
 * Provides type-safe configuration with validation and defaults.
 */

import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

/**
 * Determines if the gateway should run in standalone mode
 * 
 * Standalone mode is enabled when any of these conditions are true:
 * - GATEWAY_STANDALONE is explicitly set to 'true'
 * - UNIFIED_TOKEN_SYSTEM_ENABLED is false or undefined
 * - VALKEY_URL is empty or undefined
 * - ADMIN_SERVICE_URL is empty or undefined
 */
export function isStandaloneMode(): boolean {
  // Explicit standalone mode override
  const gatewayStandalone = process.env.GATEWAY_STANDALONE === 'true';
  if (gatewayStandalone) {
    return true;
  }
  
  // Check other conditions for implicit standalone mode
  const unifiedTokenEnabled = process.env.UNIFIED_TOKEN_SYSTEM_ENABLED === 'true';
  const hasValkeyUrl = !!(process.env.VALKEY_URL?.trim());
  const hasAdminServiceUrl = !!(process.env.ADMIN_SERVICE_URL?.trim());
  
  // Standalone mode if unified token system is disabled OR missing required services
  return !unifiedTokenEnabled || !hasValkeyUrl || !hasAdminServiceUrl;
}

/**
 * Determines if distributed caching (Valkey) should be enabled
 * 
 * Distributed caching requires:
 * - Not in standalone mode
 * - Valid Valkey URL
 */
export function shouldEnableDistributedCaching(): boolean {
  return !isStandaloneMode() && !!(process.env.VALKEY_URL?.trim());
}

export interface UnifiedAuthConfig {
  enabled: boolean;
  adminServiceUrl: string;
  fallbackToLocal: boolean;
  cacheTtlSeconds: number;
  tokenCacheTtlSeconds: number;
  requestTimeoutMs: number;
  maxRetryAttempts: number;
  cacheMaxSize: number;
  encryptSecrets: boolean;
  circuitBreakerThreshold: number;
  circuitBreakerTimeoutMs: number;
  healthCheckIntervalMs: number;
}

export interface UnifiedAuthRuntimeConfig extends UnifiedAuthConfig {
  isProduction: boolean;
  isDevelopment: boolean;
  hasValkey: boolean;
  isStandalone: boolean;
  version: string;
}

/**
 * Parse and validate environment variables for unified auth configuration
 */
export function getUnifiedAuthConfig(): UnifiedAuthRuntimeConfig {
  const config: UnifiedAuthRuntimeConfig = {
    // Core feature toggle
    enabled: process.env.UNIFIED_TOKEN_SYSTEM_ENABLED === 'true',
    
    // Admin service connection
    adminServiceUrl: process.env.ADMIN_SERVICE_URL || 'http://localhost:4004',
    
    // Fallback behavior
    fallbackToLocal: process.env.UNIFIED_AUTH_FALLBACK_TO_LOCAL !== 'false',
    
    // Cache TTL configuration
    cacheTtlSeconds: parseIntWithDefault(process.env.UNIFIED_AUTH_CACHE_TTL_SECONDS, 86400), // 24 hours
    tokenCacheTtlSeconds: parseIntWithDefault(process.env.UNIFIED_AUTH_TOKEN_CACHE_TTL_SECONDS, 3600), // 1 hour
    
    // HTTP client configuration
    requestTimeoutMs: parseIntWithDefault(process.env.UNIFIED_AUTH_REQUEST_TIMEOUT_MS, 5000),
    maxRetryAttempts: parseIntWithDefault(process.env.UNIFIED_AUTH_MAX_RETRY_ATTEMPTS, 3),
    
    // Cache configuration
    cacheMaxSize: parseIntWithDefault(process.env.UNIFIED_AUTH_CACHE_MAX_SIZE, 5000),
    encryptSecrets: process.env.UNIFIED_AUTH_CACHE_ENCRYPT_SECRETS !== 'false', // Default true
    
    // Circuit breaker configuration
    circuitBreakerThreshold: parseIntWithDefault(process.env.UNIFIED_AUTH_CIRCUIT_BREAKER_THRESHOLD, 5),
    circuitBreakerTimeoutMs: parseIntWithDefault(process.env.UNIFIED_AUTH_CIRCUIT_BREAKER_TIMEOUT_MS, 30000),
    
    // Health check configuration
    healthCheckIntervalMs: parseIntWithDefault(process.env.UNIFIED_AUTH_HEALTH_CHECK_INTERVAL_MS, 30000),
    
    // Runtime environment detection
    isProduction: process.env.NODE_ENV === 'production',
    isDevelopment: process.env.NODE_ENV === 'development',
    hasValkey: shouldEnableDistributedCaching(),
    isStandalone: isStandaloneMode(),
    
    // Version information
    version: process.env.npm_package_version || '1.0.0'
  };

  // Validate configuration
  validateConfiguration(config);
  
  // Log configuration in development (with sensitive data masked)
  if (config.isDevelopment) {
    logConfigurationSafely(config);
  }

  return config;
}

/**
 * Validate unified auth configuration
 */
function validateConfiguration(config: UnifiedAuthRuntimeConfig): void {
  const errors: string[] = [];

  // Validate admin service URL (only when not in standalone mode)
  if (config.enabled && !config.isStandalone && !isValidUrl(config.adminServiceUrl)) {
    errors.push(`Invalid ADMIN_SERVICE_URL: ${config.adminServiceUrl}`);
  }

  // Validate timeout values
  if (config.requestTimeoutMs < 1000 || config.requestTimeoutMs > 60000) {
    errors.push(`Invalid request timeout: ${config.requestTimeoutMs}ms (must be 1-60 seconds)`);
  }

  // Validate cache settings
  if (config.cacheTtlSeconds < 10 || config.cacheTtlSeconds > 604800) {
    errors.push(`Invalid cache TTL: ${config.cacheTtlSeconds}s (must be 10s-7d)`);
  }

  if (config.cacheMaxSize < 100 || config.cacheMaxSize > 100000) {
    errors.push(`Invalid cache max size: ${config.cacheMaxSize} (must be 100-100,000)`);
  }

  // Validate retry attempts
  if (config.maxRetryAttempts < 0 || config.maxRetryAttempts > 10) {
    errors.push(`Invalid max retry attempts: ${config.maxRetryAttempts} (must be 0-10)`);
  }

  // Validate circuit breaker settings
  if (config.circuitBreakerThreshold < 1 || config.circuitBreakerThreshold > 100) {
    errors.push(`Invalid circuit breaker threshold: ${config.circuitBreakerThreshold} (must be 1-100)`);
  }

  if (errors.length > 0) {
    const errorMessage = `Unified Auth Configuration Errors:\n${errors.join('\n')}`;
    logger.error('UnifiedAuthConfig', errorMessage);
    throw new Error(errorMessage);
  }
}

/**
 * Safely log configuration without exposing sensitive data
 */
function logConfigurationSafely(config: UnifiedAuthRuntimeConfig): void {
  const safeConfig = {
    ...config,
    adminServiceUrl: maskUrl(config.adminServiceUrl)
  };
  
  logger.info('UnifiedAuthConfig', 'Unified Auth Configuration:', safeConfig);
}

/**
 * Parse integer from environment variable with default fallback
 */
function parseIntWithDefault(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    logger.warn('UnifiedAuthConfig', `Invalid integer value "${value}", using default ${defaultValue}`);
    return defaultValue;
  }
  
  return parsed;
}

/**
 * Validate URL format
 */
function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mask sensitive parts of URLs for logging
 */
function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      return `${parsed.protocol}//*****:*****@${parsed.host}${parsed.pathname}`;
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * Get configuration summary for health checks and diagnostics
 */
export function getConfigurationSummary(): {
  enabled: boolean;
  fallbackAvailable: boolean;
  cacheEnabled: boolean;
  distributedCacheEnabled: boolean;
  environment: string;
} {
  const config = getUnifiedAuthConfig();
  
  return {
    enabled: config.enabled,
    fallbackAvailable: config.fallbackToLocal,
    cacheEnabled: config.cacheMaxSize > 0,
    distributedCacheEnabled: config.hasValkey,
    environment: process.env.NODE_ENV || 'unknown'
  };
}

/**
 * Singleton configuration instance
 */
let configInstance: UnifiedAuthRuntimeConfig | null = null;

/**
 * Get cached configuration instance (for performance)
 */
export function getCachedUnifiedAuthConfig(): UnifiedAuthRuntimeConfig {
  if (!configInstance) {
    configInstance = getUnifiedAuthConfig();
  }
  return configInstance;
}

/**
 * Clear cached configuration (for testing)
 */
export function clearConfigurationCache(): void {
  configInstance = null;
}