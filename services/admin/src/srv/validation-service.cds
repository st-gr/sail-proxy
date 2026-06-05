using { sap.llm.gateway.admin as admin } from '../db/schema';

/**
 * Fast Validation Service for Gateway Authentication
 * Provides unprotected but rate-limited endpoints for API key and AWS credential validation
 * Optimized for high-performance authentication middleware
 */
service ValidationService {

  // ========================================
  // Fast Validation Endpoints (Unprotected)
  // ========================================
  
  /**
   * Fast Usage Event Processing
   * Used by gateway for usage tracking when Redis is unavailable
   * Uses standard JWT authorization via Authorization header
   */
  action processUsageEvents(
    events: array of {
      requestId: String;
      timestamp: Integer;  
      authType: String;
      credentialId: String;
      provider: String;
      model: String;
      inputTokens: Integer;
      outputTokens: Integer;
      responseTime: Integer;
      statusCode: Integer;
      endpoint: String; // Add endpoint field for better granularity
    }
  ) returns {
    processed: Integer;
    status: String;
  };
  
  /**
   * Fast API Key Validation
   * Used by gateway middleware for authentication
   */
  function validateApiKey(
    ![key]: String(64) @mandatory,
    clientIp: String(45),
    userAgent: String(500)
  ) returns {
    valid: Boolean;
    keyId: UUID;
    permissions: array of String;
    rateLimits: {
      requestsPerMinute: Integer;
      requestsPerHour: Integer; 
      requestsPerDay: Integer;
      burstLimit: Integer;
    };
    usage: {
      currentMinute: Integer;
      currentHour: Integer;
      currentDay: Integer;
    };
    metadata: {
      name: String(100);
      email: String(255);
      lastUsed: Timestamp;
    };
    // Performance metrics
    cacheHit: Boolean;
    validationTime: Integer; // milliseconds
  };


  /**
   * Batch API Key Validation
   * For high-throughput scenarios
   */
  function validateApiKeysBatch(
    keys: array of {
      ![key]: String(64);
      requestId: String(100);
    }
  ) returns array of {
    requestId: String(100);
    valid: Boolean;
    keyId: UUID;
    permissions: array of String;
    rateLimits: {
      requestsPerMinute: Integer;
      requestsPerHour: Integer;
      requestsPerDay: Integer;
    };
  };

  /**
   * Rate Limit Check
   * Separate endpoint for rate limit validation
   */
  function checkRateLimit(
    keyId: UUID @mandatory,
    endpoint: String(200)
  ) returns {
    allowed: Boolean;
    rateLimitHit: String(20); // minute, hour, day, burst
    resetTime: Timestamp;
    remaining: {
      minute: Integer;
      hour: Integer;
      day: Integer;
    };
    retryAfter: Integer; // seconds
  };

  /**
   * IP Restriction Check for AWS Credentials
   */
  function checkIpRestriction(
    credentialId: UUID @mandatory,
    clientIp: String(45) @mandatory
  ) returns {
    allowed: Boolean;
    restrictionType: String(20); // allowlist, blocklist, none
    matchedRule: String(200);
  };

  // ========================================
  // Token-based AWS Credential Validation
  // ========================================
  
  /**
   * Create validation token for AWS credential requests
   * Called by gateway middleware to create secure validation tokens
   */
  action createValidationToken(
    accessKeyId: String(20) @mandatory,
    signature: String(200) @mandatory,
    clientIp: String(45) @mandatory,
    method: String(10) @mandatory,
    endpoint: String(200) @mandatory,
    headers: String(2000) // JSON string
  ) returns {
    token: String(500);
    expiresAt: Integer;
    requestId: String(36);
  };

  /**
   * Validate AWS credentials using token-based approach
   * High-performance validation with caching and security features
   */
  action validateAwsCredentialsByToken(
    token: String(2000) @mandatory,
    stringToSign: String(2000) @mandatory,
    signature: String(200) @mandatory
  ) returns {
    valid: Boolean;
    credentialMetadata: {
      credentialId: String(36);
      permissions: array of {
        service: String(50);
        action: String(100);
        resource: String(200);
        effect: String(10);
      };
      region: String(20);
      sapAiRegion: String(50);
      userId: String(255);
      rateLimits: {
        requestsPerMinute: Integer;
        requestsPerHour: Integer;
        requestsPerDay: Integer;
      };
    };
    validationToken: String(2000);
    auditInfo: {
      requestId: String(36);
      validationTime: Integer;
      cacheHit: Boolean;
      ipAllowed: Boolean;
      signatureValid: Boolean;
    };
    error: {
      code: String(50);
      message: String(200);
      details: String(500);
    };
  };

  /**
   * Validate token-based requests (simplified validation)
   * Used for fast token verification without full credential lookup
   */
  action validateTokenBasedRequest(
    token: String(500) @mandatory
  ) returns {
    valid: Boolean;
    credentialInfo: String(2000); // JSON string
    error: String(500);
  };

  // ========================================
  // Unified Token-based Authentication System
  // ========================================
  
  /**
   * Create unified validation token for both API keys and AWS credentials
   * Supports both authentication types through a single interface
   */
  action createUnifiedValidationToken(
    authType: String(20) @mandatory, // 'api_key' or 'aws_credential'
    identifier: String(255) @mandatory, // API key or AWS accessKeyId
    clientIp: String(45) @mandatory,
    userAgent: String(500),
    method: String(10) @mandatory,
    endpoint: String(200) @mandatory,
    headers: String(2000), // JSON string
    signature: String(200) // Required for AWS credentials
  ) returns {
    token: String(2000);
    expiresAt: Integer;
    requestId: String(36);
  };

  /**
   * Validate authentication using unified token-based approach
   * Returns different data structures based on authentication type
   */
  action validateUnifiedAuthByToken(
    token: String(2000) @mandatory
  ) returns {
    valid: Boolean;
    authType: String(20); // 'api_key' or 'aws_credential'
    data: {
      // For API Keys
      keyId: String(36);
      name: String(100);
      email: String(255);
      // For AWS Credentials  
      credentialId: String(36);
      secretAccessKey: String(255); // Critical for AWS SigV4 validation
      region: String(20);
      sapAiRegion: String(50);
      userId: String(255);
      // Common fields
      permissions: array of String;
      rateLimits: {
        requestsPerMinute: Integer;
        requestsPerHour: Integer;
        requestsPerDay: Integer;
      };
      metadata: {
        lastUsed: Timestamp;
        isActive: Boolean;
        expiresAt: Timestamp; // For AWS credentials
      };
    };
    auditInfo: {
      requestId: String(36);
      validationTime: Integer;
      cacheHit: Boolean;
    };
    error: {
      code: String(50);
      message: String(200);
      details: String(500);
    };
  };

  // ========================================
  // Cache Management Endpoints (Internal)
  // ========================================
  
  /**
   * Warm up validation cache
   * Called by admin service when keys/credentials are modified
   */
  action warmupCache(
    type: String(20), // api_key, aws_credential
    ids: array of UUID
  ) returns {
    warmedUp: Integer;
    cacheSize: Integer;
  };

  /**
   * Invalidate cache entries
   * Called when keys are revoked or modified
   */
  action invalidateCache(
    type: String(20),
    ids: array of UUID
  ) returns {
    invalidated: Integer;
    remainingCacheSize: Integer;
  };

  /**
   * Get cache statistics
   */
  function getCacheStats() returns {
    apiKeys: {
      size: Integer;
      hitRate: Decimal(5,4);
      missRate: Decimal(5,4);
      evictions: Integer;
    };
    awsCredentials: {
      size: Integer;
      hitRate: Decimal(5,4);
      missRate: Decimal(5,4);
      evictions: Integer;
    };
    performance: {
      avgValidationTime: Integer;
      maxValidationTime: Integer;
      validationsPerSecond: Integer;
    };
  };

  // ========================================
  // Health and Monitoring
  // ========================================
  
  /**
   * Health check for validation service
   */
  function health() returns {
    status: String(10); // healthy, degraded, unhealthy
    cacheStatus: String(10);
    dbStatus: String(10);
    responseTime: Integer;
    uptime: Integer;
    version: String(20);
  };

  /**
   * Get validation metrics
   */
  function getValidationMetrics(
    timeRange: String(10) // 1h, 24h, 7d
  ) returns {
    totalValidations: Integer;
    successfulValidations: Integer;
    failedValidations: Integer;
    avgResponseTime: Integer;
    cacheHitRate: Decimal(5,4);
    topFailureReasons: array of {
      reason: String(100);
      count: Integer;
    };
    suspiciousActivity: array of {
      type: String(50);
      count: Integer;
      severity: String(20);
    };
  };

  // ========================================
  // Configuration Management (File-based)
  // ========================================
  
  /**
   * Get current gateway configuration
   * Used by gateway service at startup and runtime
   */
  function getConfig() returns {
    success: Boolean;
    config: {};  // Full API configuration object
    version: Integer;
    checksum: String(64);
    lastModified: Timestamp;
    error: String(500);
  };

  /**
   * Check if configuration has been updated
   * Used by gateway for polling-based updates
   */
  function checkConfigUpdate(
    version: Integer,
    checksum: String(64)
  ) returns {
    hasUpdate: Boolean;
    currentVersion: Integer;
    currentChecksum: String(64);
    needsReload: Boolean;
  };

  /**
   * Force reload configuration from file
   */
  action reloadConfig() returns {
    success: Boolean;
    version: Integer;
    error: String(500);
  };

  /**
   * Register webhook for configuration changes
   * Gateway service can register to receive notifications
   */
  action registerConfigWebhook(
    serviceId: String(50) @mandatory,
    callbackUrl: String(500) @mandatory,
    environment: String(20)
  ) returns {
    success: Boolean;
    subscriberId: String(100);
    error: String(500);
  };

  /**
   * Unregister configuration webhook
   */
  action unregisterConfigWebhook(
    serviceId: String(50),
    subscriberId: String(100)
  ) returns {
    success: Boolean;
    removed: Integer;
    error: String(500);
  };

  /**
   * List registered configuration webhooks
   */
  function listConfigWebhooks() returns {
    webhooks: array of {
      subscriberId: String(100);
      serviceId: String(50);
      callbackUrl: String(500);
      environment: String(20);
      registeredAt: Timestamp;
      lastNotified: Timestamp;
    };
    total: Integer;
  };

  /**
   * Update configuration file
   * Used by admin interface to modify configuration
   */
  action updateConfig(
    config: {} @mandatory
  ) returns {
    success: Boolean;
    version: Integer;
    error: String(500);
  };

  /**
   * Get configuration service status
   */
  function getConfigStatus() returns {
    status: String(20);
    configPath: String(500);
    ![exists]: Boolean;
    version: Integer;
    lastModified: Timestamp;
    subscriberCount: Integer;
    fileWatcherActive: Boolean;
  };
}