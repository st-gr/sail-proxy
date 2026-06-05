/**
 * Security Event Emitter Service
 * 
 * Handles publishing security events from gateway to admin service.
 * Mirrors the usage event emitter pattern with Valkey pub/sub and memory fallback.
 */

import { v4 as uuidv4 } from 'uuid';
import { 
  SecurityEvent, 
  SecurityEventBatch, 
  SecurityEventEmitterConfig,
  SecurityEventContext,
  FailedAuthEventData,
  SuspiciousActivityEventData,
  RateLimitEventData,
  UnauthorizedAccessEventData,
  SecurityEventType,
  SecurityEventSeverity,
  SecurityEventAction
} from '../types/security';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

class SecurityEventEmitter {
  private config: SecurityEventEmitterConfig;
  private memoryQueue: SecurityEvent[] = [];
  private valkeyClient?: any;

  constructor(config: SecurityEventEmitterConfig) {
    this.config = config;
  }

  public setValkeyClient(client: any): void {
    this.valkeyClient = client;
  }

  /**
   * Emit security event with minimal overhead
   * Non-blocking operation - failures are logged but don't affect request processing
   */
  public async emit(event: SecurityEvent): Promise<void> {
    try {
      // Add gateway metadata
      const enrichedEvent: SecurityEvent = {
        ...event,
        eventId: event.eventId || uuidv4(),
        timestamp: event.timestamp || new Date().toISOString(),
        source: 'gateway',
        gatewayVersion: '1.0.0'
      };

      // Try Valkey pub/sub first if available and working  
      if (this.valkeyClient && this.valkeyClient.status === 'ready') {
        await this.publishToValkey(enrichedEvent);
        return;
      }

      // Fallback to memory queue
      this.addToMemoryQueue(enrichedEvent);
    } catch (error) {
      // Log error but don't throw - security event failures shouldn't break the main flow
      logger.warn('SecurityEventEmitter', 'Failed to emit security event', { 
        eventId: event.eventId,
        eventType: event.eventType,
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  }

  private async publishToValkey(event: SecurityEvent): Promise<void> {
    if (!this.valkeyClient) return;
    
    try {
      await this.valkeyClient.publish('security-events', JSON.stringify(event));
      logger.debug('SecurityEventEmitter', 'Published security event to Valkey', {
        eventId: event.eventId,
        eventType: event.eventType,
        severity: event.severity
      });
    } catch (error) {
      // If Valkey fails, fallback to memory
      this.addToMemoryQueue(event);
      throw error; // Re-throw to trigger warning log
    }
  }

  private addToMemoryQueue(event: SecurityEvent): void {
    // Simple memory queue with size limit
    if (this.memoryQueue.length >= this.config.memoryQueueSize) {
      this.memoryQueue.shift(); // Remove oldest event
    }
    this.memoryQueue.push(event);
    
    logger.debug('SecurityEventEmitter', 'Added security event to memory queue', {
      eventId: event.eventId,
      queueSize: this.memoryQueue.length
    });
  }

  /**
   * Get queued events (for admin service to poll when Valkey unavailable)
   * Returns and clears the queue
   */
  public getAndClearMemoryQueue(): SecurityEvent[] {
    const events = [...this.memoryQueue];
    this.memoryQueue = [];
    return events;
  }

  public getQueueSize(): number {
    return this.memoryQueue.length;
  }

  /**
   * Periodic flush to admin service when Valkey is not available
   * Should be called periodically by a timer
   */
  public async flushToAdminService(): Promise<void> {
    // Skip if no events to process
    if (this.memoryQueue.length === 0) {
      return; 
    }
    
    // Skip if Valkey client is available and working (events should be handled via Valkey)
    if (this.valkeyClient && this.valkeyClient.status === 'ready') {
      return;
    }

    try {
      const events = this.getAndClearMemoryQueue();
      if (events.length === 0) return;

      // Create batch
      const batch: SecurityEventBatch = {
        events,
        batchId: uuidv4(),
        timestamp: new Date().toISOString(),
        source: 'gateway',
        count: events.length
      };

      // Import admin service client here to avoid circular dependencies
      const { adminServiceClient } = await import('../clients/adminServiceClient');
      
      // Skip if admin service client is disabled (standalone mode)
      if (!adminServiceClient) {
        logger.debug('SecurityEventEmitter', 'Admin service client disabled - discarding security events', {
          discarded: events.length
        });
        return;
      }
      
      const response = await adminServiceClient.callAdminAction('processSecurityEvents', batch);
      
      logger.info('SecurityEventEmitter', `Flushed ${events.length} security events to admin service`, {
        batchId: batch.batchId,
        processed: response.processed,
        status: response.status
      });
    } catch (error) {
      logger.warn('SecurityEventEmitter', 'Failed to flush security events to admin service', {
        error: error instanceof Error ? error.message : 'Unknown error',
        queueSize: this.memoryQueue.length
      });
      // Events were already cleared from queue, so they're lost on failure
      // In production, might want to implement retry logic
    }
  }

  // Event creation helpers

  /**
   * Create and emit a failed authentication event
   */
  public async emitFailedAuth(data: FailedAuthEventData): Promise<void> {
    const event: SecurityEvent = {
      eventId: uuidv4(),
      credentialId: data.credentialId,
      authType: data.authType,
      eventType: SecurityEventType.FAILED_AUTH,
      severity: SecurityEventSeverity.HIGH,
      description: `Failed authentication attempt: ${data.reason}`,
      timestamp: new Date().toISOString(),
      clientIP: data.clientIP,
      userAgent: data.userAgent,
      endpoint: data.endpoint,
      method: data.method,
      requestId: data.requestId,
      statusCode: data.statusCode || 401,
      actionTaken: SecurityEventAction.BLOCKED,
      source: 'gateway',
      metadata: {
        reason: data.reason,
        attempts: data.attempts
      }
    };

    await this.emit(event);
  }

  /**
   * Create and emit a suspicious activity event
   */
  public async emitSuspiciousActivity(data: SuspiciousActivityEventData): Promise<void> {
    const severity = data.riskScore && data.riskScore > 0.8 ? 
      SecurityEventSeverity.HIGH : SecurityEventSeverity.MEDIUM;

    const event: SecurityEvent = {
      eventId: uuidv4(),
      credentialId: data.credentialId,
      authType: data.authType,
      eventType: SecurityEventType.SUSPICIOUS_ACTIVITY,
      severity,
      description: `Suspicious activity detected: ${data.activityType} - ${data.details}`,
      timestamp: new Date().toISOString(),
      clientIP: data.clientIP,
      userAgent: data.userAgent,
      endpoint: data.endpoint,
      method: data.method,
      requestId: data.requestId,
      statusCode: data.statusCode,
      actionTaken: SecurityEventAction.MONITORED,
      source: 'gateway',
      metadata: {
        activityType: data.activityType,
        details: data.details,
        riskScore: data.riskScore
      }
    };

    await this.emit(event);
  }

  /**
   * Create and emit a rate limit exceeded event
   */
  public async emitRateLimitExceeded(data: RateLimitEventData): Promise<void> {
    const event: SecurityEvent = {
      eventId: uuidv4(),
      credentialId: data.credentialId,
      authType: data.authType,
      eventType: SecurityEventType.RATE_LIMIT_EXCEEDED,
      severity: SecurityEventSeverity.HIGH,
      description: `Rate limit exceeded: ${data.limitType} (${data.currentCount}/${data.maxAllowed} in ${data.windowSize})`,
      timestamp: new Date().toISOString(),
      clientIP: data.clientIP,
      userAgent: data.userAgent,
      endpoint: data.endpoint,
      method: data.method,
      requestId: data.requestId,
      statusCode: data.statusCode || 429,
      actionTaken: SecurityEventAction.THROTTLED,
      autoBlocked: true,
      source: 'gateway',
      metadata: {
        limitType: data.limitType,
        currentCount: data.currentCount,
        maxAllowed: data.maxAllowed,
        windowSize: data.windowSize
      }
    };

    await this.emit(event);
  }

  /**
   * Create and emit an unauthorized access event
   */
  public async emitUnauthorizedAccess(data: UnauthorizedAccessEventData): Promise<void> {
    const event: SecurityEvent = {
      eventId: uuidv4(),
      credentialId: data.credentialId,
      authType: data.authType,
      eventType: SecurityEventType.UNAUTHORIZED_ACCESS,
      severity: SecurityEventSeverity.HIGH,
      description: `Unauthorized access attempt to ${data.attemptedResource}`,
      timestamp: new Date().toISOString(),
      clientIP: data.clientIP,
      userAgent: data.userAgent,
      endpoint: data.endpoint,
      method: data.method,
      requestId: data.requestId,
      statusCode: data.statusCode || 403,
      actionTaken: SecurityEventAction.BLOCKED,
      source: 'gateway',
      metadata: {
        attemptedResource: data.attemptedResource,
        requiredPermissions: data.requiredPermissions,
        actualPermissions: data.actualPermissions
      }
    };

    await this.emit(event);
  }

  /**
   * Emit a generic security event
   */
  public async emitGenericEvent(
    eventType: SecurityEventType,
    severity: SecurityEventSeverity,
    description: string,
    context: SecurityEventContext,
    metadata?: any
  ): Promise<void> {
    const event: SecurityEvent = {
      eventId: uuidv4(),
      credentialId: context.credentialId,
      authType: context.authType,
      eventType,
      severity,
      description,
      timestamp: new Date().toISOString(),
      clientIP: context.clientIP,
      userAgent: context.userAgent,
      endpoint: context.endpoint,
      method: context.method,
      requestId: context.requestId,
      statusCode: context.statusCode,
      actionTaken: SecurityEventAction.LOGGED,
      source: 'gateway',
      metadata
    };

    await this.emit(event);
  }
}

// Singleton instance
const securityEventEmitter = new SecurityEventEmitter({
  valkeyEnabled: process.env.VALKEY_URL !== undefined,
  memoryQueueSize: 500, // Keep last 500 security events in memory
  batchSize: 50,
  flushInterval: 30000 // Flush every 30 seconds
});

export default securityEventEmitter;
export { SecurityEventEmitter };