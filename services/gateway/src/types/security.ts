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
  authType: 'api_key' | 'aws_credential';
  
  // Event classification
  eventType: 'failed_auth' | 'suspicious_activity' | 'rate_limit_exceeded' | 'unauthorized_access' | 
           'credential_rotation' | 'ip_blocked' | 'brute_force_detected' | 'invalid_signature' |
           'expired_token' | 'malformed_request' | 'access_denied';
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

export interface SuspiciousActivityEventData extends SecurityEventContext {
  activityType: string;
  details: string;
  riskScore?: number;
}

export interface RateLimitEventData extends SecurityEventContext {
  limitType: string;
  currentCount: number;
  maxAllowed: number;
  windowSize: string;
}

export interface UnauthorizedAccessEventData extends SecurityEventContext {
  attemptedResource: string;
  requiredPermissions: string[];
  actualPermissions: string[];
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
  SUSPICIOUS_ACTIVITY = 'suspicious_activity',
  RATE_LIMIT_EXCEEDED = 'rate_limit_exceeded',
  UNAUTHORIZED_ACCESS = 'unauthorized_access',
  CREDENTIAL_ROTATION = 'credential_rotation',
  IP_BLOCKED = 'ip_blocked',
  BRUTE_FORCE_DETECTED = 'brute_force_detected',
  INVALID_SIGNATURE = 'invalid_signature',
  EXPIRED_TOKEN = 'expired_token',
  MALFORMED_REQUEST = 'malformed_request',
  ACCESS_DENIED = 'access_denied'
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