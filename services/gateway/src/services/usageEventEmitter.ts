import { UsageEvent } from '../types/usage';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();
import { isStandaloneMode } from '../config/unifiedAuthConfig';

interface UsageEmitterConfig {
  valkeyEnabled: boolean;
  memoryQueueSize: number;
}

class UsageEventEmitter {
  private config: UsageEmitterConfig;
  private memoryQueue: UsageEvent[] = [];
  private valkeyClient?: any;

  constructor(config: UsageEmitterConfig) {
    this.config = config;
  }

  public setValkeyClient(client: any): void {
    this.valkeyClient = client;
  }

  /**
   * Emit usage event with minimal overhead
   * Non-blocking operation - failures are logged but don't affect request processing
   */
  public async emit(event: UsageEvent): Promise<void> {
    try {
      // Skip usage event emission in standalone mode
      if (isStandaloneMode()) {
        return;
      }

      // Try Valkey pub/sub first if available and working  
      if (this.valkeyClient && ['connecting', 'connect', 'ready'].includes(this.valkeyClient.status)) {
        logger.debug('UsageEventEmitter', `Publishing to Valkey (status: ${this.valkeyClient.status})`);
        await this.publishToValkey(event);
        return;
      }

      // Fallback to memory queue
      logger.debug('UsageEventEmitter', `Falling back to memory queue (Valkey client: ${!!this.valkeyClient}, status: ${this.valkeyClient?.status || 'N/A'})`);
      this.addToMemoryQueue(event);
    } catch (error) {
      // Log error but don't throw - usage tracking should never break request processing
      logger.warn('UsageEventEmitter', 'Failed to emit usage event');
    }
  }

  private async publishToValkey(event: UsageEvent): Promise<void> {
    if (!this.valkeyClient) return;
    
    try {
      await this.valkeyClient.publish('usage-events', JSON.stringify(event));
      logger.debug('UsageEventEmitter', `Successfully published event to Valkey: ${event.requestId}`);
    } catch (error) {
      logger.warn('UsageEventEmitter', `Failed to publish to Valkey: ${error instanceof Error ? error.message : 'Unknown error'}, falling back to memory`);
      // If Valkey fails, fallback to memory
      this.addToMemoryQueue(event);
      throw error; // Re-throw to trigger warning log
    }
  }

  private addToMemoryQueue(event: UsageEvent): void {
    // Simple memory queue with size limit
    if (this.memoryQueue.length >= this.config.memoryQueueSize) {
      this.memoryQueue.shift(); // Remove oldest event
    }
    this.memoryQueue.push(event);
  }

  /**
   * Get queued events (for admin service to poll when Valkey unavailable)
   * Returns and clears the queue
   */
  public getAndClearMemoryQueue(): UsageEvent[] {
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

      // Import admin service client here to avoid circular dependencies
      const { adminServiceClient } = await import('../clients/adminServiceClient');
      
      // Skip if admin service client is disabled (standalone mode)
      if (!adminServiceClient) {
        logger.debug('UsageEventEmitter', 'Admin service client disabled - discarding usage events', {
          discarded: events.length
        });
        return;
      }
      
      const response = await adminServiceClient.callAdminAction('processUsageEvents', { events });
      
      logger.info('UsageEventEmitter', `Flushed ${events.length} usage events to admin service`, {
        processed: response.processed,
        status: response.status
      });
    } catch (error) {
      logger.warn('UsageEventEmitter', 'Failed to flush usage events to admin service', {
        error: error instanceof Error ? error.message : 'Unknown error',
        queueSize: this.memoryQueue.length
      });
      // Events were already cleared from queue, so they're lost on failure
      // In production, might want to implement retry logic
    }
  }
}

// Singleton instance
const usageEmitter = new UsageEventEmitter({
  valkeyEnabled: process.env.VALKEY_URL !== undefined,
  memoryQueueSize: 1000 // Keep last 1000 events in memory
});

export default usageEmitter;