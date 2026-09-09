using { cuid, managed, temporal } from '@sap/cds/common';
using { sap.llm.gateway.admin.AwsCredentials as AwsCredentials } from './aws-credentials';

namespace sap.llm.gateway.admin;

/**
 * API Key management entity
 * Stores API keys for authentication with the gateway service
 */
entity ApiKeys : cuid, managed {
  // Core fields
  ![key]      : String(256) not null;  // The actual API key (sk-xxxxx). 256, not 128:
                                      // an OpenAI platform key (sk-proj-…) is 164 characters, so a
                                      // caller bringing their own key could not be stored at all.
  maskedKey   : String(64);           // Masked version for List Report display (non-sensitive)
  name        : String(100);          // Human-readable name/description
  email       : String(255);          // Associated email address
  createdBy   : String(100);          // User who created the key
  
  // Status and lifecycle
  isActive    : Boolean default true;
  lastUsed    : Timestamp;
  usageCount  : Integer default 0;
  deletedAt   : Timestamp;            // Soft delete timestamp
  expiresAt   : Timestamp;            // Admin-managed expiration; null while neverExpires is set
  neverExpires : Boolean default false; // Admin-only: the key never expires; clears expiresAt
  lockedByUserDeactivation : Boolean default false; // set by user deactivation; only these rows are restored on reactivation

  // Field control for the Fiori apps (1=ReadOnly, 3=Editable, 7=Mandatory), set per caller role
  // in afterReadLifecycleFieldControl; never persisted.
  virtual isActiveFC     : Integer;
  virtual expiresAtFC    : Integer;
  virtual neverExpiresFC : Integer;

  // Per-credential rate limits (RateLimits row by apiKey_ID / awsCredential_ID), shown read-only in the
  // apps and changed only through setRateLimits; filled in afterReadRateLimits. Never persisted here.
  virtual requestsPerMinute : Integer;
  virtual requestsPerHour   : Integer;
  virtual requestsPerDay    : Integer;

  // Rate limiting configuration
  rateLimits  : Composition of one RateLimits;
  
  // Permissions and scope
  permissions : Composition of many ApiKeyPermissions on permissions.apiKey = $self;
  
  // Security events
  securityEvents : Composition of many ApiKeySecurityEvents on securityEvents.apiKey = $self;
  
  // Audit fields (from managed aspect)
  // createdAt, createdBy, modifiedAt, modifiedBy are provided by managed
}

/**
 * Rate limiting configuration for API keys
 */
entity RateLimits : cuid {
  apiKey              : Association to ApiKeys;
  awsCredential       : Association to AwsCredentials;   // per-credential limits for the SigV4 route (setRateLimits)
  requestsPerMinute   : Integer default 60;
  requestsPerHour     : Integer default 1000;
  requestsPerDay      : Integer default 10000;
  requestsPerMonth    : Integer default 100000;
  
  // Burst allowance
  burstLimit          : Integer default 10;
  deletedAt           : Timestamp;            // Soft delete timestamp
  
  // Custom time windows
  customWindows       : Composition of many RateLimitWindows on customWindows.rateLimit = $self;
}

/**
 * Custom rate limit time windows
 */
entity RateLimitWindows : cuid {
  rateLimit       : Association to RateLimits;
  windowName      : String(50);          // e.g., "startup_burst", "premium_tier"
  duration        : Integer;             // Duration in seconds
  requestLimit    : Integer;             // Max requests in this window
  isActive        : Boolean default true;
}

/**
 * API Key permissions and scopes
 */
entity ApiKeyPermissions : cuid {
  apiKey        : Association to ApiKeys;
  permission    : String(100);          // e.g., "models:read", "chat:create", "admin:write"
  scope         : String(200);          // Optional scope restriction
  grantedAt     : Timestamp default $now;
  grantedBy     : String(100);
  deletedAt     : Timestamp;            // Soft delete timestamp
}

/**
 * API Key usage tracking and analytics
 */
@cds.persistence.index: [
  { name: 'idx_apikeyusage_key_date', columns: ['apiKey_ID', 'validFrom'] },
  { name: 'idx_apikeyusage_email_date', columns: ['email', 'validFrom'] },
  { name: 'idx_apikeyusage_provider_model', columns: ['provider', 'model'] },
  { name: 'idx_apikeyusage_date_range', columns: ['validFrom', 'validTo'] }
]
entity ApiKeyUsage : cuid, temporal {
  apiKey              : Association to ApiKeys;
  endpoint            : String(200);        // Which endpoint was called
  method              : String(10);         // HTTP method
  statusCode          : Integer;            // Response status code
  responseTime        : Integer;            // Response time in milliseconds
  requestSize         : Integer;            // Request size in bytes
  responseSize        : Integer;            // Response size in bytes
  
  // User identification (preserved even after API key deletion)
  email               : String(255);        // Email snapshot at usage time
  keyName             : String(100);        // API key name snapshot at usage time
  
  // Provider and model information
  provider            : String(50);         // openai, anthropic, aws-bedrock, etc.
  model               : String(100);        // Model used for the request
  
  // Token usage (for LLM requests)
  inputTokens         : Integer;
  outputTokens        : Integer;
  cacheCreationInputTokens : Integer;       // Cache creation input tokens (separate pricing)
  cacheReadInputTokens : Integer;           // Cache read input tokens (separate pricing)
  totalTokens         : Integer;
  usageEstimated      : Boolean;            // True when tokens were derived locally because the
                                             // client aborted before the provider reported usage;
                                             // absent/null means provider-reported.
  
  // Cost tracking
  inputCost           : Decimal(10,6);      // Input cost in USD
  outputCost          : Decimal(10,6);      // Output cost in USD
  cacheCreationInputCost : Decimal(10,6);   // Cache creation input cost in USD
  cacheReadInputCost  : Decimal(10,6);      // Cache read input cost in USD
  totalCost           : Decimal(10,6);      // Total cost (inputCost + outputCost + cacheCreationInputCost + cacheReadInputCost)

  // SAP-native Capacity-Unit accounting (additive; nullable; beside the dollar estimate)
  imageInputTokens    : Integer;            // billed image input tokens (captured or computed)
  genAiTokens         : Decimal(14,4);      // Sum per-type: tokens * GenAi rate (cache scaled by calibration)
  capacityUnits       : Decimal(14,6);      // genAiTokens * cuFactor
  sapCost             : Decimal(12,6);      // capacityUnits * pricePerCu, in sapCostCurrency
  sapCostCurrency     : String(3);          // ISO-4217 of the price row used (e.g. 'USD','EUR')

  // Client information
  userAgent           : String(500);
  clientIP            : String(45);         // IPv6 compatible
  
  // Request metadata
  requestId           : String(100);        // Unique request identifier
  sessionId           : String(100);        // Session identifier if available
  
  // Error information
  errorType           : String(100);
  errorMessage        : String(1000);

  // Idempotency: deterministic content signature (same field set as the intra-batch dedup in
  // usageEventProcessor.ts), unique-indexed so the DB itself rejects a second insert of the
  // same usage event arriving from a second admin subscriber replica. NOT requestId alone —
  // AWS Bedrock usage all carries the fallback requestId 'unknown' (see AwsCredentialUsage).
  usageSignature      : String(200);
}

annotate ApiKeyUsage with @assert.unique: { usageSignature: [ usageSignature ] };

/**
 * Security events for API keys (failed auth, suspicious activity, etc.)
 */
entity ApiKeySecurityEvents : cuid, managed {
  apiKey            : Association to ApiKeys;
  eventType         : String(50);           // failed_auth, rate_limit_exceeded, credential_rotation
  severity          : String(20);           // low, medium, high, critical
  description       : String(1000);
  
  // Context information
  clientIP          : String(45);
  userAgent         : String(500);
  endpoint          : String(200);
  requestId         : String(100);
  
  // Response actions
  actionTaken       : String(200);          // blocked, throttled, logged, alerted
  autoBlocked       : Boolean default false;
  
  // Investigation fields
  investigated      : Boolean default false;
  investigatedBy    : String(100);
  investigatedAt    : Timestamp;
  resolution        : String(1000);
}

/**
 * API Key rotation history
 */
entity ApiKeyRotations : cuid, managed {
  apiKey            : Association to ApiKeys;
  oldKey            : String(256);          // The old API key that was rotated
  newKey            : String(256);          // The new API key after rotation
  rotationType      : String(20);           // manual, automatic, emergency
  reason            : String(200);
  rotatedBy         : String(100);
  rotationSuccess   : Boolean;
  oldKeyDeactivatedAt : Timestamp;
  oldKeyDeletedAt   : Timestamp;
}

/**
 * API Key blacklist for revoked or compromised keys
 */
entity ApiKeyBlacklist : cuid, managed {
  ![key]        : String(256) not null;
  reason        : String(200);              // Reason for blacklisting
  severity      : String(20) default 'medium'; // low, medium, high, critical
  revokedBy     : String(100);
  autoRevoked   : Boolean default false;    // Automatically revoked by system
}

// Views for common queries
// $now must be followed by a space: @cap-js/sqlite only rewrites CURRENT_TIMESTAMP to an ISO
// string inside a view when it is followed by '(' or a space, so it must not end the predicate.
view ActiveApiKeys as select from ApiKeys where isActive = true and deletedAt is null and (neverExpires = true or expiresAt > $now or expiresAt is null);

view ApiKeyUsageStats as select from ApiKeyUsage {
  key apiKey,
  count(*) as totalRequests : Integer,
  coalesce(sum(inputTokens), 0) as totalInputTokens : Integer,
  coalesce(sum(outputTokens), 0) as totalOutputTokens : Integer,
  coalesce(sum(cacheCreationInputTokens), 0) as totalCacheCreationInputTokens : Integer,
  coalesce(sum(cacheReadInputTokens), 0) as totalCacheReadInputTokens : Integer,
  coalesce(sum(inputCost), 0.0) as totalInputCost : Decimal(12,6),
  coalesce(sum(outputCost), 0.0) as totalOutputCost : Decimal(12,6),
  coalesce(sum(cacheCreationInputCost), 0.0) as totalCacheCreationInputCost : Decimal(12,6),
  coalesce(sum(cacheReadInputCost), 0.0) as totalCacheReadInputCost : Decimal(12,6),
  coalesce(sum(totalCost), 0.0) as totalCost : Decimal(12,6),
  coalesce(avg(responseTime), 0) as avgResponseTime : Integer,
  // SAP-native Capacity-Unit accounting, beside the dollar-estimate columns above. These three
  // are currency-neutral (token/CU counts, not priced amounts) so they sum safely across all of
  // an apiKey's rows regardless of sapCostCurrency. sapCost itself is deliberately NOT summed
  // here — see ApiKeyUsageSapCostStats below for why, and where it lives instead.
  coalesce(sum(imageInputTokens), 0) as totalImageInputTokens : Integer,
  coalesce(sum(genAiTokens), 0) as totalGenAiTokens : Decimal(16,4),
  coalesce(sum(capacityUnits), 0) as totalCapacityUnits : Decimal(16,6)
}
where provider is not null
group by apiKey;

/**
 * SAP-native sapCost, summed per apiKey AND per sapCostCurrency, so a USD total and a EUR total
 * for the same key are never added into one meaningless figure.
 *
 * This is a companion view rather than an extra column on ApiKeyUsageStats above: sapCost is the
 * one SAP-native aggregate that is NOT currency-neutral, so summing it correctly requires
 * grouping by sapCostCurrency too. Folding that into ApiKeyUsageStats's `group by apiKey` would
 * change that view's grain from "one row per apiKey" to "one row per apiKey per currency" -
 * splitting every dollar-estimate aggregate on it (totalRequests, totalCost, avgResponseTime,
 * ...) by currency as a side effect, which distorts the existing rollup for any apiKey that has
 * both legacy rows (sapCostCurrency is null, pre-dating this feature) and SAP-priced rows. Kept
 * separate, ApiKeyUsageStats keeps its original one-row-per-apiKey grain and callers that want
 * the per-currency sapCost breakdown query this view instead.
 */
view ApiKeyUsageSapCostStats as select from ApiKeyUsage {
  key apiKey,
  key sapCostCurrency,
  coalesce(sum(sapCost), 0) as totalSapCost : Decimal(14,6)
}
where provider is not null
group by apiKey, sapCostCurrency;

view ApiKeySecuritySummary as select from ApiKeySecurityEvents {
  key apiKey,
  key eventType,
  key severity,
  count(*) as eventCount : Integer,
  max(createdAt) as lastOccurrence : Timestamp
} group by apiKey, eventType, severity;

/**
 * Model pricing history table
 * Tracks pricing changes over time with date ranges
 */
@cds.persistence.table
@cds.persistence.index: [
  { name: 'idx_modelcosts_current', columns: ['model', 'dateTo'] },
  { name: 'idx_modelcosts_temporal', columns: ['model', 'dateFrom', 'dateTo'] },
  { name: 'idx_modelcosts_model', columns: ['model'] }
]
entity ModelCosts : cuid, managed {
  @cds.persistence.index
  model         : String(100) not null;    // Model identifier (indexed for lookups)
  displayName   : String(100);             // Clean display name from gateway service
  dateFrom      : Timestamp not null;      // Start date for this pricing
  @cds.persistence.index
  dateTo        : Timestamp not null;      // End date for this pricing (9999-12-31 for current, indexed for current pricing queries)
  inputCost     : Decimal(10,6) not null;  // Input cost per 1000 tokens
  outputCost    : Decimal(10,6) not null;  // Output cost per 1000 tokens
  cacheReadInputCost     : Decimal(10,6);  // Cache read input cost per 1000 tokens (SAP: typically 90% discount)
  cacheCreationInputCost : Decimal(10,6);  // Cache creation/write input cost per 1000 tokens (SAP: typically 25% premium)
  provider      : String(50);              // Model provider (Anthropic, OpenAI, etc.)
  version       : String(50);              // Model version/name
  complexCost   : LargeString;             // JSON cost structure for tiered pricing (null for simple cost models)
  source        : String(8) default 'sap';      // sap | manual — manual rows are never closed by the gateway refresh

  // Audit fields provided by managed aspect
};

/**
 * SAP Capacity-Unit price (CU -> currency), by usage type (productive/non-productive)
 * and temporal validity. Extended plan = the generative AI hub.
 */
@cds.persistence.table
@cds.persistence.index: [
  { name: 'idx_sapcuprice_lookup', columns: ['usageType', 'dateFrom', 'dateTo'] }
]
entity SapCapacityUnitPrice : cuid, managed {
  dateFrom      : Timestamp not null;
  dateTo        : Timestamp not null;
  pricePerCu    : Decimal(10,6) not null;
  currency      : String(3) default 'USD';
  @assert.range
  servicePlan   : String(30) enum {
    standard;
    extended;
  } default 'extended';
  @assert.range
  usageType     : String(20) enum {
    productive;
    nonProductive = 'non-productive';
  } not null;   // only these two participate in price matching (sapCapacityService/costRecalculationService)
  region        : String(50);
  sku           : String(20);
};

// Fixed-values code lists backing the Usage Type / Service Plan dropdowns on the
// SapCapacityUnitPrice object page. Fiori Elements V4 renders a dropdown only from a
// @Common.ValueList + @Common.ValueListWithFixedValues pointing at an entity (the
// @assert.range enums above only validate). These are seeded read-only; keep their codes
// in sync with the usageType/servicePlan enums.
entity SapUsageTypeCodes {
  key code : String(20);
  name     : String(40);
}

entity SapServicePlanCodes {
  key code : String(30);
  name     : String(40);
}