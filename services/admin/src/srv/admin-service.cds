using { sap.llm.gateway.admin as admin } from '../db/schema';

/**
 * Admin Service for SAP LLM Gateway
 * Provides CRUD operations and management capabilities for API keys, AWS credentials, and configuration
 */
@(requires: 'authenticated-user')
service AdminService {

  // ========================================
  // API Key Management
  // ========================================
  
  @odata.draft.enabled
  @cds.redirection.target: true
  @(restrict: [
    // CRUD for users on their own rows
    { grant: ['READ', 'CREATE', 'UPDATE', 'DELETE'], to: 'user', where: 'email = $user.id' },
    // CRUD for admins
    { grant: ['READ', 'CREATE', 'UPDATE', 'DELETE'], to: 'admin' },
    
    // Bound action authorization
    { grant: 'rotateApiKey', to: 'user', where: 'email = $user.id' },
    { grant: 'rotateApiKey', to: 'admin' }
  ])
  entity ApiKeys as projection on admin.ApiKeys {
    ID,
    ![key],
    maskedKey,
    name,
    email,
    isActive,
    lastUsed,
    usageCount,
    deletedAt,
    createdAt,
    createdBy,
    modifiedAt,
    modifiedBy
  };

  // Put actions in a separate extend so the projection stays pure
  extend entity AdminService.ApiKeys with actions {
    // Authorization handled by @restrict on entity level
    action rotateApiKey() returns {
      success: Boolean;
      newMaskedKey: String;
      message: String;
    };
  };

  
  @readonly
  @cds.redirection.target: false
  @(restrict: [
    { grant: ['READ'], to: 'user', where: 'email = $user.id' },
    { grant: ['READ'], to: 'admin' }
  ])
  entity ActiveApiKeys as projection on admin.ActiveApiKeys;
  
  entity RateLimits as projection on admin.RateLimits;
  entity RateLimitWindows as projection on admin.RateLimitWindows;
  entity ApiKeyPermissions as projection on admin.ApiKeyPermissions;
  
  @readonly
  entity ApiKeyUsage as projection on admin.ApiKeyUsage;
  
  @readonly 
  @(restrict: [
    { grant: ['READ'], to: 'user', where: 'apiKey.email = $user.id' },
    { grant: ['READ'], to: 'admin' }
  ])
  entity ApiKeyUsageStats as projection on admin.ApiKeyUsageStats;
  
  entity ApiKeyBlacklist as projection on admin.ApiKeyBlacklist;
  
  // ========================================
  // AWS Credentials Management  
  // ========================================
  
  @odata.draft.enabled
  @cds.redirection.target: true
  @(restrict: [
    // CRUD for users on their own rows (using email field)
    { grant: ['READ', 'CREATE', 'UPDATE', 'DELETE'], to: 'user', where: 'email = $user.id' },
    // CRUD for admins
    { grant: ['READ', 'CREATE', 'UPDATE', 'DELETE'], to: 'admin' },
    
    // Bound action authorization
    { grant: 'rotateAwsCredentials', to: 'user', where: 'email = $user.id' },
    { grant: 'rotateAwsCredentials', to: 'admin' },
    { grant: 'enableAwsCredentials', to: 'user', where: 'email = $user.id' },
    { grant: 'enableAwsCredentials', to: 'admin' },
    { grant: 'disableAwsCredentials', to: 'user', where: 'email = $user.id' },
    { grant: 'disableAwsCredentials', to: 'admin' },
    { grant: 'deleteAwsCredentials', to: 'user', where: 'email = $user.id' },
    { grant: 'deleteAwsCredentials', to: 'admin' }
  ])
  entity AwsCredentials as projection on admin.AwsCredentials {
    *
  } excluding { 
    secretHash,       // Never expose hashes
    salt             // Never expose salt
  };

  // Put actions in a separate extend so the projection stays pure
  extend entity AdminService.AwsCredentials with actions {
    // Authorization handled by @restrict on entity level
    action rotateAwsCredentials() returns {
      success: Boolean;
      newAccessKeyId: String;
      newSecretAccessKey: String;
      message: String;
    };
    
    action enableAwsCredentials() returns {
      success: Boolean;
      message: String;
    };
    
    action disableAwsCredentials() returns {
      success: Boolean;
      message: String;
    };
    
    action deleteAwsCredentials() returns {
      success: Boolean;
      message: String;
    };
  };
  
  // Computed fields are added by service handlers, not in projection
  
  // Capabilities for Fiori Elements
  annotate ApiKeys with @Capabilities.DeleteRestrictions.Deletable: true;
  
  annotate ApiKeys with @Capabilities.UpdateRestrictions: {
    Updatable: true,
    NonUpdatableProperties: [
      'createdAt', 'createdBy', 'modifiedAt', 'modifiedBy', 'key', 'maskedKey'
    ]
  };

  annotate AwsCredentials with @Capabilities.DeleteRestrictions.Deletable: true;
  
  annotate AwsCredentials with @Capabilities.UpdateRestrictions: {
    Updatable: true,
    NonUpdatableProperties: [
      'createdAt', 'createdBy', 'modifiedAt', 'modifiedBy', 'accessKeyId', 'secretAccessKey'
    ]
  };
  
  // These computed fields will be added in service handlers
  
  @readonly
  @(restrict: [
    { grant: ['READ'], to: 'user', where: 'email = $user.id' },
    { grant: ['READ'], to: 'admin' }
  ])
  entity ActiveAwsCredentials as projection on admin.ActiveAwsCredentials {
    *
  } excluding { 
    secretAccessKey, secretHash, salt 
  };
  
  @readonly
  @(restrict: [
    { grant: ['READ'], to: 'user', where: 'email = $user.id' },
    { grant: ['READ'], to: 'admin' }
  ])
  entity ExpiredAwsCredentials as projection on admin.ExpiredAwsCredentials {
    *
  } excluding { 
    secretAccessKey, secretHash, salt 
  };
  
  entity AwsCredentialIPRestrictions as projection on admin.AwsCredentialIPRestrictions;
  entity AwsCredentialPermissions as projection on admin.AwsCredentialPermissions;
  
  @readonly
  @cds.redirection.target
  @(restrict: [
    { grant: ['READ'], to: 'user', where: 'credential.email = $user.id' },
    { grant: ['READ'], to: 'admin' }
  ])
  entity AwsCredentialUsage as projection on admin.AwsCredentialUsage;
  
  @readonly
  @(restrict: [
    { grant: ['READ'], to: 'user', where: 'credential.email = $user.id' },
    { grant: ['READ'], to: 'admin' }
  ])
  entity AwsCredentialUsageStats as projection on admin.AwsCredentialUsageStats;
  
  @readonly
  @cds.redirection.target
  @(requires: 'admin')
  entity AwsCredentialSecurityEvents as projection on admin.AwsCredentialSecurityEvents;

  // Expose ApiKeySecurityEvents (previously missing)
  @readonly
  @cds.redirection.target
  @(restrict: [
    { grant: ['READ'], to: 'user', where: 'apiKey.email = $user.id' },
    { grant: ['READ'], to: 'admin' }
  ])
  entity ApiKeySecurityEvents as projection on admin.ApiKeySecurityEvents;
  
  @readonly
  @(restrict: [
    { grant: ['READ'], to: 'user', where: 'credential.email = $user.id' },
    { grant: ['READ'], to: 'admin' }
  ])
  entity AwsCredentialSecuritySummary as projection on admin.AwsCredentialSecuritySummary;
  
  entity AwsCredentialRotations as projection on admin.AwsCredentialRotations;

  // ========================================
  // Security Notifications
  // ========================================

  // Unified security notifications
  @readonly
  @(restrict: [
    { grant: ['READ'], to: 'user', where: 'ownerEmail = $user.id' },
    { grant: ['READ'], to: 'admin' }
  ])
  entity SecurityNotifications as projection on admin.SecurityNotifications;

  // User notification state (users can only manage their own state)
  @(restrict: [
    { grant: ['READ', 'CREATE', 'UPDATE'], to: 'user', where: 'email = $user.id' },
    { grant: ['READ'], to: 'admin' }
  ])
  entity SecurityNotificationUserState as projection on admin.SecurityNotificationUserState;

  // User preferences - each user can only access their own preferences
  @odata.draft.enabled
  @cds.redirection.target: true
  @(restrict: [
    { grant: ['READ', 'CREATE', 'UPDATE'], to: 'user', where: 'email = $user.id' },
    { grant: ['READ', 'CREATE', 'UPDATE', 'DELETE'], to: 'admin' }
  ])
  entity UserPreferences as projection on admin.UserPreferences {
    *
  } excluding { 
    // Exclude computed/managed fields from direct editing
    roles, isAdmin, isUser, canDeleteOld, canManageKeys, canManageAWS
  };

  // Convenience view for UI consumption
  @cds.redirection.target: true
  @(Capabilities.DeleteRestrictions: {
    Deletable: false
  })
  @(restrict: [
    { grant: ['READ'], to: 'user' },
    { grant: ['READ'], to: 'admin' },
    
    // Bound action permissions for notification management
    { grant: 'markNotificationSeen', to: 'user' },
    { grant: 'markNotificationSeen', to: 'admin' },
    { grant: 'markNotificationUnseen', to: 'user' },
    { grant: 'markNotificationUnseen', to: 'admin' },
    { grant: 'dismissNotification', to: 'user' },
    { grant: 'dismissNotification', to: 'admin' },
    { grant: 'snoozeNotification', to: 'user' },
    { grant: 'snoozeNotification', to: 'admin' },
    { grant: 'pinNotification', to: 'user' },
    { grant: 'pinNotification', to: 'admin' },
    { grant: 'unpinNotification', to: 'user' },
    { grant: 'unpinNotification', to: 'admin' },
    { grant: 'deleteSecurityNotification', to: 'admin' }
  ])
  entity MySecurityNotifications as projection on admin.SecurityNotifications {
    ID,
    createdAt,
    type,
    sourceEntity,
    sourceID,
    ownerEmail,
    title,
    message,
    severity,
    eventType,
    eventDate, // Already a real DB field - sortable!
    icon,
    actionable,
    actionText,
    actionUrl,
    // User state fields - Using cast to ensure proper timestamp type in PostgreSQL
    // These will be populated by afterRead handler from SecurityNotificationUserState
    cast(null as Timestamp) as seenAt : Timestamp,
    cast(null as Timestamp) as dismissedAt : Timestamp, 
    cast(null as Timestamp) as snoozeUntil : Timestamp,
    // Pinned field - populated by afterRead handler, but must be non-virtual for sorting/grouping
    false as pinned : Boolean,
    // Action availability flags - true virtual elements (not persisted, not selected from DB)
    // These exist only in OData metadata and are populated in TypeScript afterRead handler
    virtual null as canPin : Boolean @Core.Computed,
    virtual null as canUnpin : Boolean @Core.Computed,
    virtual null as canMarkSeen : Boolean @Core.Computed,
    virtual null as canMarkUnseen : Boolean @Core.Computed,
    virtual null as canDelete : Boolean @Core.Computed,
    // Computed field for filtering: true if notification is snoozed
    virtual null as isSnoozed : Boolean @Core.Computed,
    // Computed field for filtering: true if notification is seen
    virtual null as isSeen : Boolean @Core.Computed
  };

  // Add bound actions to MySecurityNotifications entity with side effects
  extend entity AdminService.MySecurityNotifications with actions {
    @(
      cds.odata.bindingparameter.name: 'in',
      Common.SideEffects: {
        TargetProperties: [
          'in/seenAt',
          'in/modifiedAt',
          'in/canMarkSeen',
          'in/canMarkUnseen'
        ]
      }
    )
    action markNotificationSeen() returns {
      success: Boolean;
      message: String;
    };
    
    @(
      cds.odata.bindingparameter.name: 'in',
      Common.SideEffects: {
        TargetProperties: [
          'in/seenAt',
          'in/dismissedAt',
          'in/snoozeUntil',
          'in/modifiedAt',
          'in/canMarkSeen',
          'in/canMarkUnseen'
        ]
      }
    )
    action markNotificationUnseen() returns {
      success: Boolean;
      message: String;
    };
    
    @(
      cds.odata.bindingparameter.name: 'in',
      Common.SideEffects: {
        TargetProperties: [
          'in/dismissedAt',
          'in/snoozeUntil',
          'in/seenAt',
          'in/modifiedAt'
        ]
      }
    )
    action dismissNotification() returns {
      success: Boolean;
      message: String;
    };
    
    @(
      cds.odata.bindingparameter.name: 'in',
      Common.SideEffects: {
        TargetProperties: [
          'in/snoozeUntil',
          'in/dismissedAt',
          'in/seenAt',
          'in/modifiedAt'
        ]
      }
    )
    action snoozeNotification(snoozeUntil: Timestamp) returns {
      success: Boolean;
      message: String;
    };
    
    @(
      cds.odata.bindingparameter.name: 'in',
      Common.SideEffects: {
        TargetProperties: [
          'in/pinned',
          'in/seenAt',
          'in/modifiedAt',
          'in/canPin',
          'in/canUnpin'
        ]
      }
    )
    action pinNotification() returns {
      success: Boolean;
      message: String;
    };
    
    @(
      cds.odata.bindingparameter.name: 'in',
      Common.SideEffects: {
        TargetProperties: [
          'in/pinned',
          'in/seenAt',
          'in/modifiedAt',
          'in/canPin',
          'in/canUnpin'
        ]
      }
    )
    action unpinNotification() returns {
      success: Boolean;
      message: String;
    };
    
    @(
      cds.odata.bindingparameter.name: 'in',
      Common.SideEffects: {
        // Trigger a refresh that will fail for deleted entity, causing navigation
        TargetProperties: ['in']
      }
    )
    action deleteSecurityNotification() returns {
      success: Boolean;
      message: String;
    };
  };
  
  // ========================================
  // API Configuration Management (Simplified for Production)
  // ========================================
  
  @cds.redirection.target
  @(
    restrict: [
      { grant: 'READ', to: 'any' },
      { grant: 'CREATE', to: 'admin' },
      { grant: 'UPDATE', to: 'admin' },
      { grant: 'DELETE', to: 'admin', where: 'isActive = false' }
    ]
  )
  @Fiori.UI.LineItem: [
    { Value: name, Label: 'Name' },
    { Value: version, Label: 'Version' },
    { Value: isActive, Label: 'Status' },
    { Value: deployedAt, Label: 'Deployed' },
    { Value: deployedBy, Label: 'Deployed By' }
  ]
  @Fiori.UI.SelectionFields: [ isActive, deployedBy ]
  entity ApiConfigurations as projection on admin.ApiConfigurations;
  
  // Add ETag support for optimistic concurrency control
  annotate ApiConfigurations with { modifiedAt @odata.etag };
  
  @readonly
  @(requires: 'admin')
  @Fiori.UI.LineItem: [
    { Value: name, Label: 'Name' },
    { Value: version, Label: 'Version' },
    { Value: deployedAt, Label: 'Deployed' },
    { Value: deployedBy, Label: 'Deployed By' }
  ]
  entity ActiveConfiguration as projection on admin.ActiveConfiguration;
  
  @readonly
  @(requires: 'admin')
  @Fiori.UI.LineItem: [
    { Value: name, Label: 'Name' },
    { Value: version, Label: 'Version' },
    { Value: isActive, Label: 'Status' },
    { Value: createdAt, Label: 'Created' },
    { Value: deployedAt, Label: 'Deployed' }
  ]
  @Fiori.UI.SelectionFields: [ createdBy, deployedBy ]
  entity ConfigurationHistory as projection on admin.ConfigurationHistory;
  
  // ========================================
  // Custom Types for Complex Returns
  // ========================================
  
  type ApiKeyUsageItem : {
    keyId: UUID;
    keyName: String;
    totalRequests: Integer;
    totalTokens: Integer;
    totalCost: Decimal;
    errorRate: Decimal;
  };
  
  type AwsCredentialUsageItem : {
    credentialId: UUID;
    userId: String;
    totalRequests: Integer;
    totalTokens: Integer;
    totalCost: Decimal;
    errorRate: Decimal;
  };
  
  type ProviderUsageItem : {
    provider: String;
    totalRequests: Integer;
    totalTokens: Integer;
    avgResponseTime: Integer;
    errorRate: Decimal;
  };
  
  type UsageStatisticsResult : {
    apiKeyUsage: array of ApiKeyUsageItem;
    awsCredentialUsage: array of AwsCredentialUsageItem;
    providerUsage: array of ProviderUsageItem;
  };

  // ========================================
  // Custom Actions and Functions
  // ========================================
  
  // API Key Actions
  action createApiKey(
    name: String,
    email: String,
    permissions: array of String,
    rateLimits: {
      requestsPerMinute: Integer;
      requestsPerHour: Integer;
      requestsPerDay: Integer;
    }
  ) returns {
    id: UUID;
    ![key]: String;
    maskedKey: String;
    name: String;
    email: String;
    isActive: Boolean;
    createdAt: Timestamp;
  };
  
  // Keep these actions for potential programmatic use, but remove from UI
  action disableApiKey(keyId: UUID) returns {
    success: Boolean;
    message: String;
  };
  
  action enableApiKey(keyId: UUID) returns {
    success: Boolean;
    message: String;
  };
  
  action deleteApiKey(keyId: UUID) returns {
    success: Boolean;
    message: String;
  };
  
  
  @(requires: 'admin')
  action disableApiKeysByEmail(email: String) returns {
    success: Boolean;
    disabledCount: Integer;
    message: String;
  };

  action updateApiKeyValue(
    keyId: UUID,
    newKey: String
  ) returns {
    success: Boolean;
    message: String;
  };
  
  action validateApiKey(![key]: String) returns {
    isValid: Boolean;
    keyInfo: {
      id: UUID;
      name: String;
      email: String;
      isActive: Boolean;
      permissions: array of String;
    };
  };
  
  // AWS Credentials Actions
  action createAwsCredentials(
    userId: String,
    name: String,
    description: String,
    expiresAt: Timestamp,
    permissions: array of String
  ) returns {
    id: UUID; 
    accessKeyId: String;
    secretAccessKey: String;  // Only returned once!
    region: String;
    sapAiRegion: String;
    expiresAt: Timestamp;
  };
  
  
  
  // Gateway Validation Actions
  // Simple lookup endpoints for gateway service to validate credentials
  
  @(restrict: [
    { grant: ['EXECUTE'], to: 'gateway' },
    { grant: ['EXECUTE'], to: 'admin' }
  ])
  function getApiKeyByKey(
    ![key]: String(128)
  ) returns {
    found: Boolean;
    keyInfo: {
      id: UUID;
      name: String;
      email: String;
      isActive: Boolean;
      permissions: array of String;
      lastUsed: Timestamp;
    };
  };

  @(restrict: [
    { grant: ['EXECUTE'], to: 'gateway' },
    { grant: ['EXECUTE'], to: 'admin' }
  ])
  function getAwsCredentialByAccessKeyId(
    accessKeyId: String(20)
  ) returns {
    found: Boolean;
    credentialInfo: {
      id: UUID;
      userId: String;
      name: String;
      isActive: Boolean;
      permissions: array of String;
      region: String;
      expiresAt: Timestamp; 
      lastUsed: Timestamp;
      accessKeyId: String;
      secretAccessKey: String;
      secretHash: String;
    };
  };
  
  // Configuration Actions (Simplified Production-Ready)
  @(requires: 'admin')
  action createConfiguration(
    name: String,
    configData: String,  // JSON string
    description: String
  ) returns {
    success: Boolean;
    configId: UUID;
    version: String;
    checksum: String;
    errors: array of String;
    warnings: array of String;
  };
  
  @(requires: 'admin')
  action activateConfiguration(
    configId: UUID
  ) returns {
    success: Boolean;
    version: String;
    checksum: String;
    activatedAt: Timestamp;
    error: String;
  };
  
  @(requires: 'admin')
  action rollbackConfiguration(
    reason: String
  ) returns {
    success: Boolean;
    rolledBackFrom: String;
    rolledBackTo: String;
    reason: String;
    rolledBackAt: Timestamp;
    error: String;
  };
  
  @(requires: 'admin')
  action validateConfiguration(configData: String) returns {
    valid: Boolean;
    errors: array of String;
    warnings: array of String;
  };
  
  // Gateway service endpoint - simplified
  @(restrict: [
    { grant: ['EXECUTE'], to: 'gateway' },
    { grant: ['EXECUTE'], to: 'admin' }
  ])
  function getActiveConfiguration() returns {
    success: Boolean;
    data: {
      id: UUID;
      version: String;
      configData: String;  // JSON configuration
      checksum: String;
      deployedAt: Timestamp;
      deployedBy: String;
    };
    error: String;
  };
  
  @(requires: 'admin')
  action getConfigurationHistory(
    limit: Integer
  ) returns {
    success: Boolean;
    history: array of {
      id: UUID;
      name: String;
      version: String;
      isActive: Boolean;
      deployedAt: Timestamp;
      deployedBy: String;
      rollbackReason: String;
      createdAt: Timestamp;
      createdBy: String;
      checksum: String;
    };
    total: Integer;
    error: String;
  };
  
  @(requires: 'admin')
  action getConfigurationStatus() returns {
    success: Boolean;
    status: {
      timestamp: String;
      eventPublishing: Boolean;
      activeConfig: {
        hasActiveConfig: Boolean;
        version: String;
        deployedAt: Timestamp;
        checksum: String;
      };
    };
    error: String;
  };
  
  // Analytics and Reporting Functions
  // Changed from action to function since it's read-only (no side effects)
  function getUsageStatistics(
    startDate: Date,
    endDate: Date,
    granularity: String  // hour, day, week, month
  ) returns UsageStatisticsResult;
  
  @(requires: 'admin')
  action getSecurityEvents(
    startDate: DateTime,
    endDate: DateTime,
    severity: String
  ) returns array of {
    eventType: String;
    severity: String;
    count: Integer;
    lastOccurrence: DateTime;
    affectedCredentials: Integer;
  };
  
  @(restrict: [
    { grant: ['EXECUTE'], to: 'gateway' },
    { grant: ['EXECUTE'], to: 'admin' }
  ])
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
    }
  ) returns {
    processed: Integer;
    status: String;
  };
  
  // ========================================
  // Debug Actions
  // ========================================
  
  action whoami() returns {
    user: String;
    roles: array of String;
    attr: String;
    isAdmin: Boolean;
    isUser: Boolean;
    deployTarget: String;
  };

  // ========================================
  // Cache Invalidation Actions
  // ========================================
  
  @(restrict: [
    { grant: ['EXECUTE'], to: 'admin' }
  ])
  action invalidateCache(
    credentialId: String,
    authType: String,  // 'api_key' or 'aws_credential'
    reason: String
  ) returns {
    success: Boolean;
    message: String;
    invalidated: Integer;
  };
  
  @(restrict: [
    { grant: ['EXECUTE'], to: 'admin' }
  ])
  action clearCachePattern(
    pattern: String,
    reason: String
  ) returns {
    success: Boolean;
    message: String;
    cleared: Integer;
  };
  
  // ========================================
  // Token-Based Validation Actions
  // ========================================
  
  action createValidationToken(
    accessKeyId: String,
    signature: String,
    clientIp: String,
    method: String,
    endpoint: String,
    headers: String  // JSON string
  ) returns {
    token: String;
    expiresAt: Integer;
    requestId: String;
  };
  
  action validateTokenBasedRequest(
    token: String
  ) returns {
    valid: Boolean;
    credentialInfo: String;  // JSON string
    error: String;
  };
  
  // Cache and Health Actions
  action getCacheStats() returns {
    validationCache: {
      size: Integer;
      hitRate: Decimal;
      missRate: Decimal;
      evictions: Integer;
    };
    secretCache: {
      size: Integer;
      ttl: Integer;
    };
    uptime: Integer;
    memoryUsage: String;  // JSON string
  };
  
  action invalidateValidationCache() returns {
    cleared: Boolean;
    stats: String;  // JSON string
  };
  
  action health() returns {
    status: String;
    services: {
      database: String;
      cache: String;
      validation: String;
    };
    timestamp: String;
  };

  // Security Event Actions
  @(restrict: [
    { grant: ['EXECUTE'], to: 'gateway' },
    { grant: ['EXECUTE'], to: 'admin' }
  ])
  action logSecurityEvent(
    credentialId: String,
    authType: String,  // 'api_key' or 'aws_credentials'
    eventType: String, // 'failed_auth', 'suspicious_activity', etc.
    severity: String,  // 'low', 'medium', 'high', 'critical'
    description: String,
    clientIP: String,
    userAgent: String,
    endpoint: String,
    requestId: String,
    actionTaken: String
  ) returns {
    success: Boolean;
    message: String;
  };
  
  action getValidationMetrics() returns {
    totalValidations: Integer;
    successfulValidations: Integer;
    failedValidations: Integer;
    avgResponseTime: Integer;
    cacheHitRate: Decimal;
    topFailureReasons: array of {
      reason: String;
      count: Integer;
    };
    suspiciousActivity: array of {
      type: String;
      count: Integer;
      severity: String;
    };
  };

  // ========================================
  // Security Notification Management Actions
  // ========================================

  // Notification management actions
  action dismissNotification(notificationID: UUID) returns {
    success: Boolean;
    message: String;
  };

  action markNotificationSeen(notificationID: UUID) returns {
    success: Boolean;
    message: String;
  };

  action snoozeNotification(
    notificationID: UUID,
    snoozeUntil: Timestamp
  ) returns {
    success: Boolean;
    message: String;
  };

  action pinNotification(
    notificationID: UUID,
    pinned: Boolean
  ) returns {
    success: Boolean;
    message: String;
  };

  // Notification population action (development/admin use)
  @(requires: 'admin')
  action populateSecurityNotifications() returns {
    success: Boolean;
    message: String;
    notificationsCreated: Integer;
  };

  // Delete security notification (admin only, configurable minimum age)
  @(requires: 'admin')
  action deleteSecurityNotification(notificationID: UUID) returns {
    success: Boolean;
    message: String;
  };

  // ========================================
  // Bulk Actions for List Report
  // ========================================

  // Bulk action to mark multiple notifications as seen
  action bulkMarkNotificationsSeen(IDs: array of UUID) returns {
    success: Boolean;
    updated: Integer;
    message: String;
  };

  // Bulk action to delete multiple notifications (admin only, configurable minimum age)
  @(requires: 'admin')
  action bulkDeleteSecurityNotifications(IDs: array of UUID) returns {
    success: Boolean;
    updated: Integer;
    failed: Integer;
    message: String;
  };

  // User preferences management actions
  action getCurrentUserPreferences() returns {
    // User identity
    email: String;
    displayName: String;
    
    // Role-based capabilities
    isAdmin: Boolean;
    isUser: Boolean;
    canDeleteOld: Boolean;
    canManageKeys: Boolean;
    canManageAWS: Boolean;
    
    // UI preferences
    sidePanelCollapsed: Boolean;
    theme: String;
    density: String;
    tablePageSize: Integer;
    
    // App preferences
    defaultNotificationFilter: String;
    showDismissedNotifications: Boolean;
    autoMarkAsSeenOnView: Boolean;
    
    // Usage analytics preferences
    analyticsTimePeriod: String;
    analyticsCustomRange: String;
  };

  action updateUserPreference(
    key: String,
    value: String
  ) returns {
    success: Boolean;
    message: String;
  };
}

// ========================================
// Operation Availability Annotations
// ========================================

// Control button visibility based on current state
// Virtual fields are true virtual elements populated in TypeScript afterRead handler
annotate AdminService.MySecurityNotifications with actions {
  pinNotification          @Core.OperationAvailable : canPin;
  unpinNotification        @Core.OperationAvailable : canUnpin;
  markNotificationSeen     @Core.OperationAvailable : canMarkSeen;
  markNotificationUnseen   @Core.OperationAvailable : canMarkUnseen;
  deleteSecurityNotification @Core.OperationAvailable : canDelete;
};

// Clean projection without any virtual fields - all UI logic handled in TypeScript