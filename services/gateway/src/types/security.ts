/**
 * Security Event Types and Interfaces for Gateway Service
 * 
 * Defines the structure for security events that will be published
 * from gateway to admin service for tracking and analysis.
 */

export interface SecurityEvent {
  // Core identification
  eventId: string;
  credentialId: string;
  // Set only when credentialId is a hash (an unresolved credential — see
  // utils/credentialIdentity.ts): the first 8 characters of the presented value, for
  // format identification in the SIEM UI without exposing the secret.
  credentialHint?: string;
  // The full presented value, set only for an unresolved credential. Never leaves this
  // pipeline except when a sink's own `include_credential_material` config opts in
  // (services/admin/src/siem/dispatcher.ts) — default false.
  credentialMaterial?: string;
  authType: 'api_key' | 'aws_credential';
  
  // Event classification
  eventType: 'failed_auth' | 'rate_limit_exceeded' | 'credential_rotation';
  severity: 'low' | 'medium' | 'high' | 'critical';
  
  // Event details
  description: string;
  timestamp: string; // ISO 8601 format
  
  // Request context
  clientIP?: string;
  userAgent?: string;
  endpoint?: string;
  method?: string;
  requestId?: string;
  
  // Response and actions
  statusCode?: number;
  actionTaken?: string;
  autoBlocked?: boolean;
  
  // Gateway-specific metadata
  source: 'gateway';
  gatewayVersion?: string;
  
  // Additional context data
  metadata?: {
    [key: string]: any;
  };
}

/**
 * The prompt/response block a usage event may carry. Either the text fields are present, or
 * `omitted` says why they are not — never both.
 */
export interface SiemUsageContent {
  prompt?: string;
  response?: string;
  /** True when either field was cut at `siem.content_max_bytes`. */
  truncated?: boolean;
  /** Whether the pseudonymization pipeline masked this request. */
  masked?: boolean;
  /**
   * Why the text was withheld. See services/siemUsageEvent.ts. `'stream-incomplete'` is the
   * streaming case: the stream errored or the client hung up, so the prompt ships without a
   * response rather than a partial one being passed off as the whole answer.
   */
  omitted?: 'not-masked' | 'not-requested' | 'stream-incomplete';
}

/**
 * What the pseudonymization pipeline did to this request, in counts.
 *
 * Deliberately NOT part of `content`: it carries no conversation text, so it is not subject
 * to the content gates. An operator who has not opted any sink into content still gets to
 * see that a request masked 200 values — that is the whole point of shipping it, and
 * withholding it would leave saturation visible only to whoever reads gateway logs.
 *
 * Nothing here can identify a masked value: `categories` is distinct values per category and
 * `masked_values` is the distinct total. See plugins/pseudonymization/saturationReport.ts.
 */
export interface SiemUsagePseudonymization {
  /** Distinct values masked in this request. */
  masked_values: number;
  /** Distinct masked values per category, highest first. */
  categories: Record<string, number>;
  /** Whether `masked_values` passed `pseudonymization.saturation_warn` (default 40). */
  saturated: boolean;
}

/**
 * A request-completion event. Published to the same `siem-events` stream as a SecurityEvent
 * but a different shape and a different meaning: `category: 'usage'` is the discriminator
 * the admin side branches on (securityEventSubscriber.ts, siem/siemEvent.ts), and it is the
 * only event that ever carries conversation content.
 *
 * Deliberately not an extension of SecurityEvent: it has no `actionTaken`, no
 * `credentialMaterial`, and its `eventType` is not one of the security event types. Sharing
 * that interface would let a usage event be passed anywhere a security event is expected —
 * including `processSecurityEvents`, which would persist it into the domain tables.
 */
export interface SiemUsageEvent {
  eventId: string;
  category: 'usage';
  eventType: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  timestamp: string;
  credentialId?: string;
  authType?: string;
  clientIP?: string;
  userAgent?: string;
  endpoint?: string;
  requestId?: string;
  statusCode?: number;
  model?: string;
  source: 'gateway';
  gatewayVersion?: string;
  content?: SiemUsageContent;
  /** Present only when the pseudonymization plugin ran for this request. */
  pseudonymization?: SiemUsagePseudonymization;
}

export interface ApiKeySecurityEvent extends Omit<SecurityEvent, 'authType' | 'credentialId'> {
  authType: 'api_key';
  keyId: string;
  keyName?: string;
}

export interface AwsCredentialSecurityEvent extends Omit<SecurityEvent, 'authType' | 'credentialId'> {
  authType: 'aws_credential';
  credentialId: string;
  accessKeyId?: string;
  awsRegion?: string;
  service?: string;
  operation?: string;
}

export interface SecurityEventBatch {
  events: SecurityEvent[];
  batchId: string;
  timestamp: string;
  source: 'gateway';
  count: number;
}

// Security event emitter configuration
export interface SecurityEventEmitterConfig {
  valkeyEnabled: boolean;
  memoryQueueSize: number;
  batchSize: number;
  flushInterval: number; // milliseconds
}

// Event creation helpers
export interface SecurityEventContext {
  credentialId: string;
  credentialHint?: string;
  credentialMaterial?: string;
  authType: 'api_key' | 'aws_credential';
  clientIP?: string;
  userAgent?: string;
  endpoint?: string;
  method?: string;
  requestId?: string;
  statusCode?: number;
}

export interface FailedAuthEventData extends SecurityEventContext {
  reason: string;
  attempts?: number;
}

export interface RateLimitEventData extends SecurityEventContext {
  limitType: string;
  currentCount: number;
  maxAllowed: number;
  windowSize: string;
}

// Event severity calculation
export enum SecurityEventSeverity {
  LOW = 'low',
  MEDIUM = 'medium', 
  HIGH = 'high',
  CRITICAL = 'critical'
}

// Common event types
export enum SecurityEventType {
  FAILED_AUTH = 'failed_auth',
  RATE_LIMIT_EXCEEDED = 'rate_limit_exceeded',
  CREDENTIAL_ROTATION = 'credential_rotation'
}

// Event actions
export enum SecurityEventAction {
  LOGGED = 'logged',
  BLOCKED = 'blocked',
  THROTTLED = 'throttled',
  MONITORED = 'monitored',
  ALERTED = 'alerted',
  QUARANTINED = 'quarantined'
}