/**
 * Security Event Emitter Service
 * 
 * Handles publishing security events from gateway to admin service.
 * Appends to the bounded `siem-events` Valkey stream (with a memory-queue
 * fallback), unlike the usage event emitter, which still uses pub/sub.
 */

import { v4 as uuidv4 } from 'uuid';
import { 
  SecurityEvent, 
  SecurityEventBatch, 
  SecurityEventEmitterConfig,
  FailedAuthEventData,
  RateLimitEventData,
  SecurityEventType,
  SecurityEventSeverity,
  SecurityEventAction,
  SiemUsageEvent
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
    // Declared outside the try block so the catch can still fall back to the
    // memory queue if publishToValkey throws after enrichment.
    let enrichedEvent: SecurityEvent | undefined;
    try {
      // Add gateway metadata
      enrichedEvent = {
        ...event,
        eventId: event.eventId || uuidv4(),
        timestamp: event.timestamp || new Date().toISOString(),
        source: 'gateway',
        gatewayVersion: '1.0.0'
      };

      // Try the Valkey stream first if available and working
      if (this.valkeyClient && this.valkeyClient.status === 'ready') {
        await this.publishToValkey(enrichedEvent);
        return;
      }

      // Fallback to memory queue
      this.addToMemoryQueue(enrichedEvent);
    } catch (error) {
      // publishToValkey rethrows on failure; fall back to the memory queue here
      // so an XADD error doesn't silently drop the event.
      if (enrichedEvent) {
        this.addToMemoryQueue(enrichedEvent);
      }
      // Log error but don't throw - security event failures shouldn't break the main flow
      logger.warn('SecurityEventEmitter', 'Failed to emit security event', {
        eventId: event.eventId,
        eventType: event.eventType,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Emit a request-completion (`usage`) event.
   *
   * Unlike emit(), this does NOT fall back to the memory queue. Two reasons, both about the
   * fallback rather than about the event: the queue drains through
   * `processSecurityEvents` on the admin side, which persists what it is given into the
   * domain security-event tables — the wrong home for a usage event (see
   * securityEventSubscriber.isUsageEvent) — and usage events arrive once per request, so a
   * bounded in-memory queue shared with security events would be filled by them and evict
   * the failed-auth events it exists to protect. With no stream available the event is
   * dropped, which is the correct degraded behaviour for a per-request export.
   */
  public async emitUsage(event: SiemUsageEvent): Promise<void> {
    if (!this.valkeyClient || this.valkeyClient.status !== 'ready') {
      logger.debug('SecurityEventEmitter', 'No stream available; dropping usage SIEM event', {
        requestId: event.requestId,
      });
      return;
    }
    try {
      await this.publishToValkey({
        ...event,
        eventId: event.eventId || uuidv4(),
        timestamp: event.timestamp || new Date().toISOString(),
        source: 'gateway',
        gatewayVersion: '1.0.0',
      });
    } catch {
      // publishToValkey already logged it. Nothing else to try, by design.
    }
  }

  private async publishToValkey(event: SecurityEvent | SiemUsageEvent): Promise<void> {
    if (!this.valkeyClient) return;

    try {
      // A stream, not pub/sub: pub/sub drops messages published while no subscriber is
      // connected, so an admin restart lost events. Stream entries live server-side and
      // are acknowledged only after the admin has persisted them.
      //
      // MAXLEN ~ bounds the stream because this Valkey has no persistence and an
      // emptyDir volume (kyma/manifests/core/valkey.yaml:14-15) — unbounded growth
      // would OOM the pod. The cap is a safety valve; Postgres is the record.
      await this.valkeyClient.xadd(
        'siem-events', 'MAXLEN', '~', '100000', '*',
        'event', JSON.stringify(event),
      );
      logger.debug('SecurityEventEmitter', 'Appended security event to siem-events stream', {
        eventId: event.eventId,
        eventType: event.eventType,
        severity: event.severity,
      });
    } catch (error) {
      logger.warn('SecurityEventEmitter', 'Failed to append to siem-events stream', {
        eventId: event.eventId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;   // let emit() fall through to the memory queue
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
      credentialHint: data.credentialHint,
      credentialMaterial: data.credentialMaterial,
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
   * Create and emit a rate limit exceeded event
   */
  public async emitRateLimitExceeded(data: RateLimitEventData): Promise<void> {
    const event: SecurityEvent = {
      eventId: uuidv4(),
      credentialId: data.credentialId,
      credentialHint: data.credentialHint,
      credentialMaterial: data.credentialMaterial,
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