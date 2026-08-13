using { cuid, managed, temporal } from '@sap/cds/common';

namespace sap.llm.gateway.admin;

/**
 * AWS-style credentials for SAP AI Core authentication
 * Supports AWS SigV4 signature authentication method
 */
entity AwsCredentials : cuid, managed {
  // AWS-style identifiers
  accessKeyId       : String(20) not null;  // AKIA... format
  secretAccessKey   : String(512);                // Encrypted/hashed secret (supports iv:encrypted format with safety margin)
  
  // Security fields
  secretHash        : String(128);                 // HMAC-SHA256 hash of secret
  salt              : String(32);                  // Random salt for hashing
  
  // Metadata
  userId            : String(100);                 // Associated user/service (legacy)
  email             : String(255);                 // Owner email address (for notifications)
  name              : String(100);                 // Human-readable name
  description       : String(500);                // Purpose description
  
  // Status and lifecycle
  isActive          : Boolean default true;
  lastUsed          : Timestamp;
  usageCount        : Integer default 0;
  expiresAt         : Timestamp;                   // Optional expiration
  
  // AWS region configuration
  region            : String(20) default 'us-east-1';
  sapAiRegion       : String(50);                  // SAP AI Core region
  
  // Security policies
  ipRestrictions    : Composition of many AwsCredentialIPRestrictions on ipRestrictions.credential = $self;
  permissions       : Composition of many AwsCredentialPermissions on permissions.credential = $self;
  
  // Usage tracking
  usageHistory      : Composition of many AwsCredentialUsage on usageHistory.credential = $self;
  
  // Security events
  securityEvents    : Composition of many AwsCredentialSecurityEvents on securityEvents.credential = $self;
}

/**
 * IP address restrictions for AWS credentials
 */
entity AwsCredentialIPRestrictions : cuid, managed {
  credential    : Association to AwsCredentials;
  ipAddress     : String(45);              // IPv4 or IPv6 address
  ipRange       : String(50);              // CIDR notation (e.g., 192.168.1.0/24)
  description   : String(200);
  isAllowed     : Boolean default true;    // true = allowlist, false = blocklist
  isActive      : Boolean default true;
}

/**
 * Permissions and scopes for AWS credentials
 */
entity AwsCredentialPermissions : cuid, managed {
  credential      : Association to AwsCredentials;
  service         : String(50);           // bedrock, s3, etc.
  action          : String(100);          // bedrock:InvokeModel, etc.
  resource        : String(200);          // ARN or resource identifier
  effect          : String(10) default 'Allow'; // Allow or Deny
  condition       : String(1000);         // JSON condition
  isActive        : Boolean default true;
}

/**
 * AWS credential usage tracking for SigV4 authenticated requests
 */
@cds.persistence.index: [
  { name: 'idx_awscredusage_cred_date', columns: ['credential_ID', 'validFrom'] },
  { name: 'idx_awscredusage_user_date', columns: ['userId', 'validFrom'] },
  { name: 'idx_awscredusage_provider_model', columns: ['provider', 'modelId'] },
  { name: 'idx_awscredusage_date_range', columns: ['validFrom', 'validTo'] }
]
entity AwsCredentialUsage : cuid, temporal {
  credential          : Association to AwsCredentials;
  
  // Request information
  requestId           : String(100);
  method              : String(10);           // HTTP method
  endpoint            : String(200);          // API endpoint called
  service             : String(50);           // AWS service (bedrock, s3, etc.)
  operation           : String(100);          // Specific operation
  
  // Response information
  statusCode          : Integer;
  responseTime        : Integer;              // Response time in milliseconds
  requestSize         : Integer;              // Request size in bytes
  responseSize        : Integer;              // Response size in bytes
  
  // AWS-specific fields
  awsRegion           : String(20);
  signatureVersion    : String(20) default 'AWS4-HMAC-SHA256';
  canonicalRequest    : String(2000);         // For debugging signature issues
  
  // User identification (preserved even after credential deletion)
  userId              : String(100);        // User ID snapshot at usage time
  credentialName      : String(100);        // Credential name snapshot at usage time
  
  // Model and provider information (for Bedrock requests)
  modelId             : String(200);
  provider            : String(50);
  inputTokens         : Integer;
  outputTokens        : Integer;
  cacheCreationInputTokens : Integer;       // Cache creation input tokens (separate pricing)
  cacheReadInputTokens : Integer;           // Cache read input tokens (separate pricing)
  usageEstimated      : Boolean;            // True when tokens were derived locally because the
                                             // client aborted before the provider reported usage;
                                             // absent/null means provider-reported.
  
  // Client information
  userAgent           : String(500);
  clientIP            : String(45);
  
  // Cost and billing
  inputCost           : Decimal(10,6);      // Input cost in USD
  outputCost          : Decimal(10,6);      // Output cost in USD
  cacheCreationInputCost : Decimal(10,6);   // Cache creation input cost in USD
  cacheReadInputCost  : Decimal(10,6);      // Cache read input cost in USD
  totalCost           : Decimal(10,6);      // Total cost (inputCost + outputCost + cacheCreationInputCost + cacheReadInputCost)
  billingRegion       : String(20);
  
  // Error tracking
  errorCode           : String(50);
  errorMessage        : String(1000);
  errorType           : String(100);
}

/**
 * Security events for AWS credentials (suspicious activity, etc.)
 */
entity AwsCredentialSecurityEvents : cuid, managed {
  credential        : Association to AwsCredentials;
  eventType         : String(50);           // failed_auth, suspicious_ip, rate_limit_exceeded
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
 * AWS credential rotation history
 */
entity AwsCredentialRotations : cuid, managed {
  credential        : Association to AwsCredentials;
  oldAccessKeyId    : String(20);
  newAccessKeyId    : String(20);
  rotationType      : String(20);           // manual, automatic, emergency
  reason            : String(200);
  rotatedBy         : String(100);
  rotationSuccess   : Boolean;
  oldKeyDeactivatedAt : Timestamp;
  oldKeyDeletedAt   : Timestamp;
}

// Views for common queries
view ActiveAwsCredentials as select from AwsCredentials where isActive = true;

view ExpiredAwsCredentials as select from AwsCredentials 
  where isActive = true and expiresAt < $now;

view AwsCredentialUsageStats as select from AwsCredentialUsage {
  key credential,
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
  count(case when statusCode >= 400 then 1 end) as errorCount : Integer
} 
where provider is not null
group by credential;

view AwsCredentialSecuritySummary as select from AwsCredentialSecurityEvents {
  key credential,
  key eventType,
  key severity,
  count(*) as eventCount : Integer,
  max(createdAt) as lastOccurrence : Timestamp
} group by credential, eventType, severity;