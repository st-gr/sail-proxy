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
    { grant: 'rotateApiKey', to: 'admin' },

    // Owner or admin (entity @restrict). Each value optional, integer >= 1; the validation actions
    // return what is stored, the gateway enforces it on the next request after cache invalidation.
    { grant: 'setRateLimits', to: 'user', where: 'email = $user.id' },
    { grant: 'setRateLimits', to: 'admin' }
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
    expiresAt,
    neverExpires,
    toolPolicy,
    lockedByUserDeactivation @readonly,
    isActiveFC,
    expiresAtFC,
    neverExpiresFC,
    requestsPerMinute,
    requestsPerHour,
    requestsPerDay,
    ownerRequestsPerMinuteText,
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

    // Owner or admin (entity @restrict). Each value optional, integer >= 1; the validation actions
    // return what is stored, the gateway enforces it on the next request after cache invalidation.
    // The parameter dialog opens with the credential's current limits: Fiori Elements resolves a
    // path-valued UI.ParameterDefaultValue against the bound row (the binding parameter is `in`).
    action setRateLimits(
      @UI.ParameterDefaultValue: { $edmJson: { $Path: 'in/requestsPerMinute' } } requestsPerMinute : Integer,
      @UI.ParameterDefaultValue: { $edmJson: { $Path: 'in/requestsPerHour' } }   requestsPerHour : Integer,
      @UI.ParameterDefaultValue: { $edmJson: { $Path: 'in/requestsPerDay' } }    requestsPerDay : Integer
    ) returns { requestsPerMinute : Integer; requestsPerHour : Integer; requestsPerDay : Integer; };
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

  // Per-currency sapCost totals - see the doc comment on ApiKeyUsageSapCostStats in the schema
  // for why this is a separate entity rather than folded into ApiKeyUsageStats above.
  @readonly
  @(restrict: [
    { grant: ['READ'], to: 'user', where: 'apiKey.email = $user.id' },
    { grant: ['READ'], to: 'admin' }
  ])
  entity ApiKeyUsageSapCostStats as projection on admin.ApiKeyUsageSapCostStats;

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
    
    // Bound action authorization — rotate stays owner-or-admin; enable/disable are admin-only
    // (lifecycle rule: only an administrator may change isActive, not even the owner)
    { grant: 'rotateAwsCredentials', to: 'user', where: 'email = $user.id' },
    { grant: 'rotateAwsCredentials', to: 'admin' },
    { grant: 'enableAwsCredentials', to: 'admin' },
    { grant: 'disableAwsCredentials', to: 'admin' },
    { grant: 'deleteAwsCredentials', to: 'user', where: 'email = $user.id' },
    { grant: 'deleteAwsCredentials', to: 'admin' },

    // Owner or admin (entity @restrict). Each value optional, integer >= 1; the validation actions
    // return what is stored, the gateway enforces it on the next request after cache invalidation.
    { grant: 'setRateLimits', to: 'user', where: 'email = $user.id' },
    { grant: 'setRateLimits', to: 'admin' }
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

    // Owner or admin (entity @restrict). Each value optional, integer >= 1; the validation actions
    // return what is stored, the gateway enforces it on the next request after cache invalidation.
    // The parameter dialog opens with the credential's current limits: Fiori Elements resolves a
    // path-valued UI.ParameterDefaultValue against the bound row (the binding parameter is `in`).
    action setRateLimits(
      @UI.ParameterDefaultValue: { $edmJson: { $Path: 'in/requestsPerMinute' } } requestsPerMinute : Integer,
      @UI.ParameterDefaultValue: { $edmJson: { $Path: 'in/requestsPerHour' } }   requestsPerHour : Integer,
      @UI.ParameterDefaultValue: { $edmJson: { $Path: 'in/requestsPerDay' } }    requestsPerDay : Integer
    ) returns { requestsPerMinute : Integer; requestsPerHour : Integer; requestsPerDay : Integer; };
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

  // lockedByUserDeactivation is lifecycle-owned (userLifecycleService); AwsCredentials has no
  // element list to annotate in place (a `* excluding` projection), so it's server-owned here.
  annotate AdminService.AwsCredentials with { lockedByUserDeactivation @readonly; };

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
  @cds.search: { title, message, ownerEmail, eventType, clientIP, userAgent, endpoint, requestId }
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
    // Request context of the source event (read-only; rotation notifications carry none)
    clientIP,
    userAgent,
    endpoint,
    requestId,
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
  // excluding siemCredentials: that composition's target holds ciphertext/iv/salt/authTag -
  // see the doc comment on SiemCredentials (siem.cds) for why it must never reach OData, and
  // ApiConfigurations grants READ to 'any', so an un-excluded composition would expose it
  // to every authenticated user via $expand or direct navigation.
  entity ApiConfigurations as projection on admin.ApiConfigurations excluding { siemCredentials };
  
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
  // excluding siemCredentials - see the note on the ApiConfigurations projection above;
  // this view selects from ApiConfigurations with no column list, so it inherits the
  // composition too unless excluded here as well.
  entity ActiveConfiguration as projection on admin.ActiveConfiguration excluding { siemCredentials };
  
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
  // SAP Capacity-Unit Price Maintenance
  // ========================================
  //
  // Hand-maintained master data: the CU->currency price is published only through the
  // S-User-gated price list, never an API (price list: https://www.sap.com/products/
  // technology-platform/price-list/list.btpea.US.html). The per-model GenAI conversion
  // rates are NOT maintained here - they are sourced from ModelCosts (the /v2 discovery
  // data; see sapCapacityService._lookupRate). The price table is temporal - a
  // correction is made by INSERTing a new [dateFrom,dateTo] row - so CRUD is admin-only,
  // the same admin-only shape applied to every other writable entity in this file.

  @odata.draft.enabled: true
  @cds.redirection.target: true
  @(restrict: [
    { grant: ['READ', 'CREATE', 'UPDATE', 'DELETE'], to: 'admin' }
  ])
  entity SapCapacityUnitPrice as projection on admin.SapCapacityUnitPrice;

  annotate SapCapacityUnitPrice with @Capabilities.DeleteRestrictions.Deletable: true;

  annotate SapCapacityUnitPrice with @Capabilities.UpdateRestrictions: {
    Updatable: true,
    NonUpdatableProperties: [
      'createdAt', 'createdBy', 'modifiedAt', 'modifiedBy'
    ]
  };

  // Read-only fixed-values code lists backing the Usage Type / Service Plan dropdowns
  // (SapCapacityUnitPrice @Common.ValueList targets). Admin-readable reference data.
  @(restrict: [{ grant: ['READ'], to: 'admin' }])
  entity SapUsageTypeCodes as projection on admin.SapUsageTypeCodes;

  @(restrict: [{ grant: ['READ'], to: 'admin' }])
  entity SapServicePlanCodes as projection on admin.SapServicePlanCodes;

  // ========================================
  // SAP Invoice Reconciliation (Task 13)
  // ========================================
  //
  // Administrator-facing: sums the per-request SAP-native fields already recorded on
  // ApiKeyUsage (capacityUnits, sapCost per sapCostCurrency, genAiTokens, cache tokens) over a
  // billing period and, given the operator-entered SAP invoice line items for that same
  // period, backs out the implied calibration factors (impliedCuFactor,
  // impliedCacheReadFactor, impliedCacheWriteFactor). These are SUGGESTIONS only - read-only,
  // it never writes anything back. The operator sets sap_cache_*_token_billing_factor in
  // api_config.json themselves, after the SAP inquiry (spec Sec11.3). Hourly-provisioning line
  // items (Baseline CU, Infer-S Node Hour, Grounding, Observability) are tenant overhead with
  // no representation on ApiKeyUsage, so they never enter this comparison (spec Sec3.4).
  @(requires: 'admin')
  function reconcileInvoice(
    from: Timestamp,
    to: Timestamp,
    invoiceGenAiTokens: Decimal(20,4),
    invoiceCapacityUnits: Decimal(20,6),
    invoiceCacheReadInputTokens: Decimal(20,4),
    invoiceCacheWriteInputTokens: Decimal(20,4)
  ) returns {
    capacityUnits: Decimal(20,6);
    sapCostByCurrency: array of {
      currency: String(3);
      amount: Decimal(20,6);
    };
    capturedGenAiTokens: Decimal(20,4);
    capturedCacheReadInputTokens: Decimal(20,4);
    capturedCacheWriteInputTokens: Decimal(20,4);
    impliedCuFactor: Decimal(20,6);
    impliedCacheReadFactor: Decimal(20,6);
    impliedCacheWriteFactor: Decimal(20,6);
  };

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
  // Only an administrator may change the active state of an API key.
  @(requires: 'admin')
  action disableApiKey(keyId: UUID) returns {
    success: Boolean;
    message: String;
  };

  @(requires: 'admin')
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
    email: String,
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

  @(requires: 'admin')
  action setSiemCredential(configurationId: UUID, name: String, value: String) returns {
    success : Boolean;
    error   : String;
  };

  @(requires: 'admin')
  action deleteSiemCredential(configurationId: UUID, name: String) returns {
    success : Boolean;
    error   : String;
  };

  // Metadata only - never the value, never the ciphertext.
  @(requires: 'admin')
  action listSiemCredentials(configurationId: UUID) returns array of {
    name       : String;
    updatedAt  : Timestamp;
    updatedBy  : String;
    maskedHint : String;
  };

  // Reports SiemCredentials rows nothing can reach any more - see credentialSweep.ts. Never
  // deletes, never returns a value or ciphertext.
  @(requires: 'admin')
  action findOrphanedSiemCredentials() returns array of {
    configurationId   : UUID;
    configurationName : String;
    name              : String;
    reason            : String;
    updatedAt         : Timestamp;
    updatedBy         : String;
  };

  // Deletes exactly the caller-specified (configurationIds[i], names[i]) pairs - an operator
  // confirms exactly what goes. Irreversible: a credential value can never be read back.
  @(requires: 'admin')
  action deleteOrphanedSiemCredentials(names: array of String, configurationIds: array of UUID) returns {
    success : Boolean;
    deleted : Integer;
    error   : String;
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

  // ========================================
  // Model Library and Entitlements & Quotas
  // ========================================
  //
  // LibraryModels is the snapshot of the gateway's /v1/models list (modelCostService.
  // upsertLibrarySnapshot). Reads are filtered per caller in admin-service-library.ts:
  // a user sees only the effective set of their assigned catalog (or the default minus its
  // exclusions); admins see everything. Catalogs form a two-level hierarchy (admin catalogs
  // and the default as parents, user catalogs as children); members are maintained through
  // the bound actions, never by deep insert (see modelEntitlementService.ts).

  @readonly
  @cds.search: { displayName, modelId, description, provider }
  entity LibraryModels as projection on admin.LibraryModels;

  @(restrict: [
    // A bound action is authorized against the entity's own @restrict with the action name as
    // the event, so every action has to be granted here as well - the @(requires: 'admin') on
    // excludeModels/includeModels is what still keeps plain users out of those two.
    { grant: ['READ', 'CREATE', 'UPDATE', 'DELETE', 'addModels', 'removeModels', 'excludeModels', 'includeModels'], to: 'admin' },
    { grant: ['READ', 'CREATE', 'UPDATE', 'DELETE', 'addModels', 'removeModels'], to: 'user' }   // rows and columns narrowed in before-handlers
  ])
  entity ModelCatalogs as projection on admin.ModelCatalogs;

  @readonly
  entity ModelCatalogMembers as projection on admin.ModelCatalogMembers;

  @readonly
  entity ModelCatalogExclusions as projection on admin.ModelCatalogExclusions;

  // Legacy: drained into Users.entitlementCatalog by the startup migration
  // (usersService.migrateCatalogAssignments); stays declared, empty, for one release.
  @readonly
  @(restrict: [{ grant: ['READ'], to: 'admin' }])
  entity ModelCatalogAssignments as projection on admin.ModelCatalogAssignments;

  @readonly
  entity ModelPrices as projection on admin.ModelCosts {
    ID, model, displayName, dateFrom, dateTo, inputCost, outputCost,
    cacheReadInputCost, cacheCreationInputCost, imageOutputCost, audioInputCost, audioOutputCost,
    provider, version, source, createdAt, createdBy
  };

  type PruneResult { prunedFromChildren : Integer; }
  type ConfigContext {
    override         : LargeString;   // JSON of models.overrides.<modelId> or null
    providerSettings : LargeString;   // JSON of providers.<provider> or null
    cuFactor         : Decimal(10,5);
    cuFactorSource   : String(8);     // config | default
    productive       : Boolean;
  }
  type ManualPriceResult {
    ID : UUID; model : String(100); inputCost : Decimal(10,6); outputCost : Decimal(10,6);
    cacheReadInputCost : Decimal(10,6); cacheCreationInputCost : Decimal(10,6);
    imageOutputCost : Decimal(10,6);
    audioInputCost : Decimal(10,6); audioOutputCost : Decimal(10,6);
    source : String(8); dateFrom : Timestamp;
  }

  extend entity AdminService.LibraryModels with actions {
    @(requires: 'admin')
    action setPrice(inputCost : Decimal(10,6), outputCost : Decimal(10,6),
                    cacheReadInputCost : Decimal(10,6), cacheCreationInputCost : Decimal(10,6),
                    imageOutputCost : Decimal(10,6),
                    audioInputCost : Decimal(10,6), audioOutputCost : Decimal(10,6)) returns ManualPriceResult;
    @(requires: 'admin')
    action revertToSapPrice() returns ManualPriceResult;
    function configContext() returns ConfigContext;
    @(requires: 'admin')
    function fetchDeployments() returns array of {
      id : String; status : String; configurationId : String; configurationName : String;
      createdAt : String; deploymentUrl : String; modelVersion : String;
    };
    @(requires: 'admin')
    action deploy() returns { deploymentId : String; status : String; configurationId : String; reusedConfiguration : Boolean; };
  };

  extend entity AdminService.ModelCatalogs with actions {
    action addModels(modelIds : array of String) returns { added : Integer; prunedFromChildren : Integer; };
    action removeModels(modelIds : array of String) returns { removed : Integer; prunedFromChildren : Integer; };
    @(requires: 'admin')
    action excludeModels(modelIds : array of String, reason : String) returns { excluded : Integer; prunedFromChildren : Integer; };
    @(requires: 'admin')
    action includeModels(modelIds : array of String) returns { included : Integer; };
  };

  @(requires: 'admin')
  action refreshModelLibrary() returns { models : Integer; deployments : Integer; absent : Integer; };

  function myEntitlement() returns {
    catalog  : { ID : UUID; name : String; isDefault : Boolean; };
    modelIds : array of String;
    unrestricted : Boolean;
  };

  @(requires: 'admin')
  action assignCatalog(email : String, catalogId : UUID) returns PruneResult;
  @(requires: 'admin')
  action unassignCatalog(email : String) returns PruneResult;
  @(requires: 'admin')
  function libraryUsers() returns array of { email : String; displayName : String; status : String; catalogId : UUID; catalogName : String; };

  @(requires: 'admin')
  function deploymentStatus(deploymentId : String) returns { status : String; deploymentUrl : String; };

  // ========================================
  // Users & quotas (spec §4)
  // ========================================
  type QuotaLimits {
    requestsPerMinute : Integer; spendPerDay : Decimal(12,4); spendPerWeek : Decimal(12,4); spendPerMonth : Decimal(12,4);
    tokensPerDay : Integer64; tokensPerWeek : Integer64; tokensPerMonth : Integer64;
  }
  type QuotaLimitSources {
    requestsPerMinute : String(9); spendPerDay : String(9); spendPerWeek : String(9); spendPerMonth : String(9);
    tokensPerDay : String(9); tokensPerWeek : String(9); tokensPerMonth : String(9);
  }
  type QuotaWindowUsage { requests : Integer; tokens : Integer64; sapCost : Decimal(12,6); }
  type QuotaStatus {
    email : String(255); status : String(12); roles : array of String;
    limits : QuotaLimits; limitSource : QuotaLimitSources; quotaProfileName : String(100); sapCostCurrency : String(3);
    used : { minuteRequests : Decimal(10,2); day : QuotaWindowUsage; week : QuotaWindowUsage; month : QuotaWindowUsage; };
    remaining : { spendDay : Decimal(12,6); spendWeek : Decimal(12,6); spendMonth : Decimal(12,6);
                  tokensDay : Integer64; tokensWeek : Integer64; tokensMonth : Integer64; };
    resetsAt : { day : Timestamp; week : Timestamp; month : Timestamp; };
    quotaResetAt : Timestamp; lastSeenAt : Timestamp;
    toolPolicy : { name : String(100); mode : String(10); };
  }
  // The home screen's key-metric tiles (usageSummaryService): this calendar month, UTC. `sapCost` is
  // the total in `sapCostCurrency` only; other currencies with cost this month are named, not summed.
  type UsageSummary {
    scope : String(4);            // 'self' (the caller's own usage) or 'all' (every user; administrators)
    monthStart : Date;
    requests : Integer64; tokens : Integer64; users : Integer;
    sapCost : Decimal(14,6); sapCostCurrency : String(3); otherCurrencies : array of String(3);
  }
  type UserLifecycleResult {
    email : String(255); status : String(12);
    lockedApiKeys : Integer; lockedAwsCredentials : Integer; restoredApiKeys : Integer; restoredAwsCredentials : Integer;
    cacheInvalidated : Boolean;
  }
  type QuotaResetResult { email : String(255); ok : Boolean; message : String; quotaResetAt : Timestamp; }
  type CounterRebuildResult { email : String(255); ok : Boolean; buckets : Integer; message : String; }

  @odata.draft.enabled
  @cds.redirection.target: true
  @(Capabilities: { InsertRestrictions: { Insertable: false }, DeleteRestrictions: { Deletable: false } })
  @(restrict: [
    { grant: ['READ', 'UPDATE', 'deactivate', 'reactivate', 'resetQuota'], to: 'admin' }
  ])
  entity Users as projection on admin.Users {
    *,
    // usage figures and effective limits from userQuotaService.status (afterReadUsers), never persisted
    virtual null as usedRequestsMinute : Decimal(10,2) @Core.Computed,
    // the currency every spend figure and spend limit below is denominated in (the active SAP
    // capacity-unit price's currency); the users-app's @Measures.ISOCurrency on the used-spend
    // figures points here. The effective limits carry their own copy that is null when the limit
    // is null: Fiori Elements renders a unit beside an empty amount, and "USD" alone in a limit
    // column reads as a broken value rather than "unlimited".
    virtual null as sapCostCurrency : String(3) @Core.Computed,
    // The assigned quota profile's name (null when the user carries none). The association itself
    // is written ONLY by assignQuotaProfile/unassignQuotaProfile - the draft's read-only guard
    // refuses a PATCH of quotaProfile_ID (admin-service-users.ts).
    virtual null as quotaProfileName : String(100) @Core.Computed,
    // the value that applies when the constraint is empty, and where it comes from (spec §4.2)
    virtual null as requestsPerMinuteDefaultText : String(60) @Core.Computed,
    virtual null as spendPerDayDefaultText : String(60) @Core.Computed,
    virtual null as spendPerWeekDefaultText : String(60) @Core.Computed,
    virtual null as spendPerMonthDefaultText : String(60) @Core.Computed,
    virtual null as tokensPerDayDefaultText : String(60) @Core.Computed,
    virtual null as tokensPerWeekDefaultText : String(60) @Core.Computed,
    virtual null as tokensPerMonthDefaultText : String(60) @Core.Computed,
    virtual null as effectiveSpendPerDayCurrency : String(3) @Core.Computed,
    virtual null as effectiveSpendPerWeekCurrency : String(3) @Core.Computed,
    virtual null as effectiveSpendPerMonthCurrency : String(3) @Core.Computed,
    virtual null as usedSpendDay : Decimal(12,6) @Core.Computed,
    virtual null as usedSpendWeek : Decimal(12,6) @Core.Computed,
    virtual null as usedSpendMonth : Decimal(12,6) @Core.Computed,
    virtual null as usedTokensDay : Integer64 @Core.Computed,
    virtual null as usedTokensWeek : Integer64 @Core.Computed,
    virtual null as usedTokensMonth : Integer64 @Core.Computed,
    virtual null as effectiveRequestsPerMinute : Integer @Core.Computed,
    virtual null as effectiveSpendPerDay : Decimal(12,4) @Core.Computed,
    virtual null as effectiveSpendPerWeek : Decimal(12,4) @Core.Computed,
    virtual null as effectiveSpendPerMonth : Decimal(12,4) @Core.Computed,
    virtual null as effectiveTokensPerDay : Integer64 @Core.Computed,
    virtual null as effectiveTokensPerWeek : Integer64 @Core.Computed,
    virtual null as effectiveTokensPerMonth : Integer64 @Core.Computed,
    virtual null as limitSourceRequestsPerMinute : String(9) @Core.Computed,
    virtual null as limitSourceSpendPerDay : String(9) @Core.Computed,
    virtual null as limitSourceSpendPerWeek : String(9) @Core.Computed,
    virtual null as limitSourceSpendPerMonth : String(9) @Core.Computed,
    virtual null as limitSourceTokensPerDay : String(9) @Core.Computed,
    virtual null as limitSourceTokensPerWeek : String(9) @Core.Computed,
    virtual null as limitSourceTokensPerMonth : String(9) @Core.Computed,
    virtual null as resetsAtDay : Timestamp @Core.Computed,
    virtual null as resetsAtWeek : Timestamp @Core.Computed,
    virtual null as resetsAtMonth : Timestamp @Core.Computed,
    virtual null as criticalitySpendDay : Integer @Core.Computed,
    virtual null as criticalitySpendWeek : Integer @Core.Computed,
    virtual null as criticalitySpendMonth : Integer @Core.Computed,
    virtual null as criticalityTokensDay : Integer @Core.Computed,
    virtual null as criticalityTokensWeek : Integer @Core.Computed,
    virtual null as criticalityTokensMonth : Integer @Core.Computed,
    virtual null as canDeactivate : Boolean @Core.Computed,
    virtual null as canReactivate : Boolean @Core.Computed,
    // Plan B (the Fiori app) criticality for the status field: 3 = active (positive), 1 = deactivated
    // (critical); set in afterReadUsers alongside canDeactivate/canReactivate.
    virtual null as statusCriticality : Integer @Core.Computed,
    apiKeys : Association to many ApiKeys on apiKeys.email = $self.email,
    awsCredentials : Association to many AwsCredentials on awsCredentials.email = $self.email
  } actions {
    action deactivate(reason : String(500)) returns UserLifecycleResult;
    action reactivate() returns UserLifecycleResult;
    action resetQuota() returns QuotaResetResult;
  };

  // A named set of the seven limits an administrator assigns per user (spec 2026-09-08 §2). Sits
  // between the user's own values and platform.quotas; the name is unique and trimmed, the window
  // order is enforced like a user's own constraints, and a profile that is still assigned cannot be
  // deleted (admin-service-quota-profiles.ts).
  @(restrict: [{ grant: ['READ', 'CREATE', 'UPDATE', 'DELETE'], to: 'admin' }])
  entity QuotaProfiles as projection on admin.QuotaProfiles;

  @readonly
  @(restrict: [{ grant: ['READ'], to: 'admin' }])
  entity UserCredentials as projection on admin.UserCredentials;

  @readonly
  @cds.persistence.skip
  @(restrict: [{ grant: ['READ'], to: 'admin' }])
  entity UserQuotaStatus {
    key email : String(255); status : String(12); lastSeenAt : Timestamp; quotaResetAt : Timestamp;
    requestsPerMinute : Integer; spendPerDay : Decimal(12,4); spendPerWeek : Decimal(12,4); spendPerMonth : Decimal(12,4);
    tokensPerDay : Integer64; tokensPerWeek : Integer64; tokensPerMonth : Integer64;
    sapCostCurrency : String(3); quotaProfileName : String(100);
    limitSourceRequestsPerMinute : String(9); limitSourceSpendPerDay : String(9); limitSourceSpendPerWeek : String(9); limitSourceSpendPerMonth : String(9);
    limitSourceTokensPerDay : String(9); limitSourceTokensPerWeek : String(9); limitSourceTokensPerMonth : String(9);
    usedRequestsMinute : Decimal(10,2); usedSpendDay : Decimal(12,6); usedSpendWeek : Decimal(12,6); usedSpendMonth : Decimal(12,6);
    usedTokensDay : Integer64; usedTokensWeek : Integer64; usedTokensMonth : Integer64;
    remainingSpendDay : Decimal(12,6); remainingSpendWeek : Decimal(12,6); remainingSpendMonth : Decimal(12,6);
    remainingTokensDay : Integer64; remainingTokensWeek : Integer64; remainingTokensMonth : Integer64;
    resetsAtDay : Timestamp; resetsAtWeek : Timestamp; resetsAtMonth : Timestamp;
  };

  @(requires: 'admin') action deactivateUser(email : String(255), reason : String(500)) returns UserLifecycleResult;
  @(requires: 'admin') action reactivateUser(email : String(255)) returns UserLifecycleResult;
  @(requires: 'admin') action resetUserQuotas(emails : array of String) returns array of QuotaResetResult;
  @(requires: 'admin') action rebuildUsageCounters(emails : array of String) returns array of CounterRebuildResult;
  @(requires: 'admin') action setUserConstraints(email : String(255), constraints : QuotaLimits) returns Users;
  // The ONLY write path for Users.quotaProfile_ID: both audit, republish the user's quota document
  // and invalidate their credential cache (spec 2026-09-08 §3).
  @(requires: 'admin') action assignQuotaProfile(email : String(255), profileId : UUID) returns Users;
  @(requires: 'admin') action unassignQuotaProfile(email : String(255)) returns Users;
  @(requires: 'admin') function quotaProfileUsers() returns array of {
    email : String(255); displayName : String(255); status : String(12); profileId : UUID; profileName : String(100);
  };
  @(requires: 'admin') function userQuotaStatus(email : String(255)) returns QuotaStatus;
  function myQuotaStatus() returns QuotaStatus;
  /** This month's usage: the caller's own, or every user's for an administrator (the home tiles). */
  function myUsageSummary() returns UsageSummary;

  type UsageUnit { model : String(200); unit : String(6); }
  /** The models whose usage is counted in cells (SAP-RPT), not tokens - names models, not usage, so
   *  every signed-in caller may read it. */
  function usageUnits() returns array of UsageUnit;

  // ========================================
  // Tool governance (spec 2026-09-16 §4/§5)
  // ========================================
  @(restrict: [
    { grant: ['READ', 'CREATE', 'UPDATE', 'DELETE'], to: 'admin' },
    // Bound action authorization: an entity @restrict is a deny-by-default allow-list, so the
    // four assignment actions extended onto ToolPolicies below need their own grants here too.
    { grant: ['assignUser', 'unassignUser', 'assignApiKey', 'unassignApiKey'], to: 'admin' }
  ])
  @odata.draft.enabled
  entity ToolPolicies as projection on admin.ToolPolicies;
  // The draft root is the only write path that is meant to be used, but these two cannot be
  // @readonly: the Fiori list creates an entry inline by POSTing onto the DRAFT root's
  // `allows`/`denies` navigation, and lean-draft's onNew answers that with 405 as soon as the
  // active entity is @readonly (proven by test/integration/http/tool-policies-odata.test.ts).
  // Over HTTP nothing reaches these sets anyway — a write addressed at a draft-enabled entity
  // becomes a NEW/PATCH on its draft and is refused with "A draft-enabled entity can only be
  // modified via its root entity" — and admin-service-tool-policies.ts registers before
  // CREATE/UPDATE/DELETE handlers on both so a programmatic service-level write cannot bypass
  // the pattern validation or the credential-cache invalidation either.
  @(restrict: [{ grant: ['READ', 'CREATE', 'UPDATE', 'DELETE'], to: 'admin' }])
  entity ToolPolicyAllows as projection on admin.ToolPolicyAllows;
  @(restrict: [{ grant: ['READ', 'CREATE', 'UPDATE', 'DELETE'], to: 'admin' }])
  entity ToolPolicyDenies as projection on admin.ToolPolicyDenies;
  // Same reasoning as ToolPolicyAllows/ToolPolicyDenies above: writable so the inline creation on
  // the draft's navigation works, guarded by admin-service-tool-policies.ts against a direct write.
  @(restrict: [{ grant: ['READ', 'CREATE', 'UPDATE', 'DELETE'], to: 'admin' }])
  entity ToolPolicySensitive as projection on admin.ToolPolicySensitive;
  @(restrict: [{ grant: ['READ', 'CREATE', 'UPDATE', 'DELETE'], to: 'admin' }])
  entity ToolPolicyUntrusted as projection on admin.ToolPolicyUntrusted;
  @readonly
  @(restrict: [{ grant: 'READ', to: 'admin' }])
  entity ToolUsageDaily as projection on admin.ToolUsageDaily;

  /** Value help for ToolPolicies.mode, served by an on-READ handler. */
  @readonly
  @cds.persistence.skip
  entity ToolPolicyModes {
    key code : String(10);
    text     : String(40);
  }

  /** Value help for the inventory's facet filter, served by an on-READ handler. */
  @readonly
  @cds.persistence.skip
  entity ToolFacets {
    key code : String(10);
    text     : String(40);
  }

  /** Value help for the inventory's Requested By filter: the client programs actually recorded. */
  @readonly
  @cds.persistence.skip
  @(restrict: [{ grant: 'READ', to: 'admin' }])
  entity ToolAgents {
    key agent : String(60);
    tools     : Integer;
    requests  : Integer;
    lastSeen  : Timestamp;
  }

  /**
   * Tool inventory (spec §8): aggregates of ToolUsageDaily over a day range, served by an on-READ
   * handler. `day` is a filter, not a column: the rows are per tool, not per day, and the filter's
   * range decides the period that is aggregated (default: the last 30 days).
   *
   * AllowedExpressions 'SingleRange' is what turns it into a date control in the filter bar. A Date
   * property without it gets the generic "Define Conditions" dialog, where the calendar is two
   * clicks deep; with it, Fiori Elements renders the date range picker AND the semantic operators
   * ("Last X Days", "This Month"), which is how the period is meant to be chosen.
   */
  @readonly
  @(restrict: [{ grant: 'READ', to: 'admin' }])
  @cds.persistence.skip
  @(Capabilities.FilterRestrictions: { FilterExpressionRestrictions: [
      { Property: day, AllowedExpressions: 'SingleRange' }
  ] })
  entity ToolInventory {
    key identity : String(220);
    key facet    : String(10);
    users        : Integer;
    requests     : Integer;
    allowed      : Integer;
    monitored    : Integer;
    stripped     : Integer;
    rejected     : Integer;
    unlisted     : Integer;
    detected     : Integer;      // denied and used without being prevented (a nested MCP call)
    trustChained : Integer;      // denials caused by the trust chain
    lastSeen     : Timestamp;
    agents       : String(400);   // which client programs asked for it in the range, comma separated
    day          : Date;          // filter only; every row carries the last day of the aggregated range
  }

  /** Recorded tool identities, the value help behind a policy's allow and deny patterns. */
  @readonly
  @cds.persistence.skip
  @(restrict: [{ grant: 'READ', to: 'admin' }])
  entity ToolIdentities {
    key identity : String(220);
    users        : Integer;
    requests     : Integer;
    lastSeen     : Timestamp;
  }

  extend entity AdminService.ToolPolicies with actions {
    @(requires: 'admin') action assignUser(email : String(255)) returns ToolPolicies;
    @(requires: 'admin') action unassignUser(email : String(255)) returns ToolPolicies;
    @(requires: 'admin') action assignApiKey(keyId : UUID) returns ToolPolicies;
    @(requires: 'admin') action unassignApiKey(keyId : UUID) returns ToolPolicies;
  };
  // The ONLY write paths for Users.toolPolicy_ID and ApiKeys.toolPolicy_ID: both invalidate the credential cache.
  @(requires: 'admin') action assignToolPolicy(email : String(255), policyId : UUID) returns Users;
  @(requires: 'admin') action unassignToolPolicy(email : String(255)) returns Users;
  @(requires: 'admin') action setApiKeyToolPolicy(keyId : UUID, policyId : UUID) returns ApiKeys;
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