/**
 * Security Event Subscriber Service for Admin Service
 *
 * Reads security events appended by the gateway to the `siem-events` Valkey
 * stream via the `siem-ingest` consumer group, persists them to the database
 * using SecurityEventService, and writes the normalized event to the SIEM
 * outbox (siem/outbox.ts) — Postgres, not the stream, is the durable record.
 * A stream entry is XACKed only once both writes succeed; a failure at either
 * step leaves it unacknowledged. Unacknowledged entries, whether from that or
 * from a crashed/restarted consumer, are reclaimed with XAUTOCLAIM, which is
 * the property pub/sub lacked (a subscriber offline when a message was
 * published simply lost it).
 */

import Redis from 'iovalkey';
import { getDefaultLogger } from '@libs/logger';
import { SecurityEventService } from './securityEventService';
import { notificationStreamService } from '../srv/notification-stream';
import { toSiemEvent } from '../siem/siemEvent';
import { writeToOutbox } from '../siem/outbox';

const logger = getDefaultLogger();

export interface SecurityEventFromGateway {
  eventId: string;
  credentialId: string;
  // See utils/credentialIdentity.ts (gateway): set only when credentialId is a hash of an
  // unresolved credential, not a resolved row ID or a sentinel.
  credentialHint?: string;
  credentialMaterial?: string;
  authType: 'api_key' | 'aws_credential';
  eventType: string;
  severity: string;
  description: string;
  timestamp: string;
  clientIP?: string;
  userAgent?: string;
  endpoint?: string;
  method?: string;
  requestId?: string;
  statusCode?: number;
  actionTaken?: string;
  autoBlocked?: boolean;
  source: 'gateway';
  metadata?: any;
  /**
   * Present, and equal to 'usage', only on a request-completion event (the gateway's
   * services/siemUsageEvent.ts). A security event never carries it. See isUsageEvent below.
   */
  category?: string;
}

const STREAM_NAME = 'siem-events';
const CONSUMER_GROUP = 'siem-ingest';
const RECLAIM_MIN_IDLE_MS = 60000;

// Mirrors SiemEvent['category'] (siem/siemEvent.ts). Used as the default when an operator
// has not set siem.categories at all — "forward everything" rather than "forward nothing".
const ALL_SIEM_CATEGORIES: readonly string[] = ['security', 'audit', 'usage'];

/**
 * A request-completion event, not a security event. It shares the `siem-events` stream (one
 * transport, one consumer group, one ack discipline) but has no home in the domain
 * *SecurityEvents tables: it records a request that succeeded, has no `actionTaken`, and
 * arrives once per request rather than once per incident. Writing one row per request into
 * the security tables would both corrupt what those tables mean and grow them without bound,
 * so ingest skips step 1 for it and goes straight to the outbox.
 */
function isUsageEvent(event: SecurityEventFromGateway): boolean {
  return event?.category === 'usage';
}

class SecurityEventSubscriber {
  private valkeyClient: Redis | null = null;
  private isSubscribed: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private reconnectDelay: number = 5000; // 5 seconds
  private consumerName: string = '';
  private running: boolean = false;

  constructor() {
    this.initializeSubscription();
  }

  private async initializeSubscription() {
    try {
      // Only initialize if Valkey URL is available
      if (!process.env.VALKEY_URL) {
        logger.info('SecurityEventSubscriber', 'Valkey URL not configured - security event subscription disabled');
        return;
      }

      logger.info('SecurityEventSubscriber', 'Initializing Valkey subscription for security events');
      
      this.valkeyClient = new Redis(process.env.VALKEY_URL);
      
      this.valkeyClient.on('connect', () => {
        logger.info('SecurityEventSubscriber', 'Connected to Valkey for security event subscription');
        this.reconnectAttempts = 0;
      });
      
      this.valkeyClient.on('error', (error) => {
        logger.error('SecurityEventSubscriber', 'Valkey connection error:', error);
        this.handleReconnection();
      });
      
      this.valkeyClient.on('close', () => {
        logger.warn('SecurityEventSubscriber', 'Valkey connection closed');
        this.isSubscribed = false;
        this.handleReconnection();
      });

      // Subscribe to security events channel
      await this.subscribe();
      
    } catch (error) {
      logger.error('SecurityEventSubscriber', 'Failed to initialize security event subscription:', error as Error);
      this.handleReconnection();
    }
  }

  private async subscribe() {
    if (!this.valkeyClient || this.isSubscribed) {
      return;
    }

    try {
      // MKSTREAM creates the stream if the gateway has not written yet. BUSYGROUP means
      // the group already exists, which is the normal case on restart.
      try {
        await this.valkeyClient.xgroup('CREATE', STREAM_NAME, CONSUMER_GROUP, '0', 'MKSTREAM');
      } catch (err: any) {
        if (!String(err?.message || '').includes('BUSYGROUP')) throw err;
      }

      this.isSubscribed = true;
      this.consumerName = `admin-${process.pid}`;
      this.running = true;

      logger.info('SecurityEventSubscriber', 'Successfully joined siem-ingest consumer group on siem-events stream', {
        consumerName: this.consumerName
      });

      void this.consumeLoop();

    } catch (error) {
      logger.error('SecurityEventSubscriber', 'Failed to join siem-ingest consumer group:', error as Error);
      throw error;
    }
  }

  private async consumeLoop(): Promise<void> {
    while (this.running) {
      try {
        // Claim entries a previous consumer took but never acknowledged — this is what
        // makes an admin restart lossless, and the reason for choosing streams.
        await this.reclaimPending();

        const res: any = await this.valkeyClient!.xreadgroup(
          'GROUP', CONSUMER_GROUP, this.consumerName,
          'COUNT', '100', 'BLOCK', '5000',
          'STREAMS', STREAM_NAME, '>',
        );
        if (!res) continue;

        for (const [, entries] of res) {
          for (const [id, fields] of entries) {
            await this.handleStreamEntry(id, fields);
          }
        }
      } catch (error) {
        logger.warn('SecurityEventSubscriber', 'Stream consume error; retrying', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  /**
   * Reclaim entries that a previous consumer read but never acknowledged (e.g. it crashed
   * mid-persist). A minimum idle time of 60s avoids racing a consumer that is still actively
   * working an entry.
   */
  private async reclaimPending(): Promise<void> {
    if (!this.valkeyClient) return;

    try {
      const res: any = await this.valkeyClient.xautoclaim(
        STREAM_NAME, CONSUMER_GROUP, this.consumerName, RECLAIM_MIN_IDLE_MS, '0',
      );
      const entries = res?.[1] ?? [];
      for (const [id, fields] of entries) {
        await this.handleStreamEntry(id, fields);
      }
    } catch (error) {
      logger.warn('SecurityEventSubscriber', 'Failed to reclaim pending stream entries', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Parse a single siem-events stream entry, persist the domain event, write the outbox row,
   * and acknowledge only once both have succeeded, in that order: persist, then outbox, then
   * ack. Acking before either step would drop the event on a crash — the loss this design
   * exists to prevent. A persistence or outbox-write failure leaves the entry unacked, so
   * XAUTOCLAIM redelivers it via reclaimPending once the underlying failure clears. Only
   * entries that are structurally unprocessable — a missing `event` field, or a payload that
   * is not valid JSON — are acked without being persisted, since redelivering those forever
   * could never succeed.
   */
  private async handleStreamEntry(id: string, fields: string[]): Promise<void> {
    const fieldIndex = fields.indexOf('event');
    const raw = fieldIndex !== -1 ? fields[fieldIndex + 1] : undefined;

    if (!raw) {
      logger.warn('SecurityEventSubscriber', 'Stream entry missing event field', { id });
      await this.valkeyClient!.xack(STREAM_NAME, CONSUMER_GROUP, id);
      return;
    }

    let event: SecurityEventFromGateway;
    try {
      event = JSON.parse(raw);
    } catch (parseError) {
      logger.warn('SecurityEventSubscriber', 'Stream entry has a malformed JSON payload; acking rather than redelivering it forever', {
        id,
        error: parseError instanceof Error ? parseError.message : 'Unknown error',
      });
      await this.valkeyClient!.xack(STREAM_NAME, CONSUMER_GROUP, id);
      return;
    }

    logger.debug('SecurityEventSubscriber', 'Received security event:', {
      eventId: event.eventId,
      eventType: event.eventType,
      authType: event.authType,
      severity: event.severity
    });

    try {
      // 1. Persist the domain event. processSecurityEvent lets persistence failures
      //    propagate (it only swallows failures from the best-effort notification step).
      //    Skipped for a usage event, which has no domain table — see isUsageEvent.
      if (!isUsageEvent(event)) {
        await this.processSecurityEvent(event);
      }

      // 2. Write the durable outbox row so per-sink delivery can proceed independently of
      //    the domain tables above — unless an operator has explicitly turned SIEM
      //    forwarding off, in which case nothing is written at all: no outbox row, no
      //    delivery rows, no growth. `categories` further filters by the normalized event's
      //    category — an operator scoping siem.categories to ["audit"] must not still get
      //    security events just because ingest never checked the category it was about to write.
      const { shouldWrite, sinkNames, categories } = await this.getSiemDispatchConfig();
      if (shouldWrite) {
        const siemEvent = toSiemEvent(event);
        if (categories.includes(siemEvent.category)) {
          await writeToOutbox(siemEvent, sinkNames);
        }
      }

      // 3. Ack only now that both writes have succeeded.
      await this.valkeyClient!.xack(STREAM_NAME, CONSUMER_GROUP, id);

    } catch (error) {
      logger.error('SecurityEventSubscriber', 'Failed to persist stream entry; leaving unacked for XAUTOCLAIM redelivery:', error as Error, { id });
    }
  }

  /**
   * Reads siem.enabled and the enabled sink names from the active configuration —
   * ApiConfigurations.configData (simplified-api-config.cds:10-30), a LargeString holding
   * the whole JSON, served through the ActiveConfiguration view. Read the same way
   * ConfigService.getActiveConfiguration reads it: the ApiConfigurations row where
   * isActive is true, highest version first.
   *
   * `shouldWrite` is false only when a configuration was actually read and its
   * `siem.enabled` is explicitly false — an operator's deliberate choice, which must stop
   * even the durable outbox row from being written so nothing grows while forwarding is
   * off. Anything short of that explicit choice (no active configuration row, a `siem`
   * block that is not present yet, a parse failure) is a configuration problem, not a
   * decision to disable, so it falls back to `shouldWrite: true` with an empty sink list:
   * ingest is never stopped, but there is nowhere yet to route delivery. Any resulting
   * orphan (an outbox row with no SiemDelivery row for a currently-enabled sink) is
   * repaired by reconcileOutbox on the dispatcher's next tick (siem/dispatcher.ts).
   *
   * `categories` mirrors the same never-silently-discard default: an unset or empty
   * `siem.categories` means "forward everything" (ALL_SIEM_CATEGORIES), not "forward
   * nothing" — an operator who wants filtering must say so explicitly, and a config-read
   * failure must not start silently dropping categories that were being forwarded before.
   */
  private async getSiemDispatchConfig(): Promise<{ shouldWrite: boolean; sinkNames: string[]; categories: string[] }> {
    const fallback = { shouldWrite: true, sinkNames: [] as string[], categories: [...ALL_SIEM_CATEGORIES] };

    try {
      const cds = require('@sap/cds');
      const { SELECT } = cds.ql;

      const rows = await SELECT.from('sap.llm.gateway.admin.ApiConfigurations')
        .where({ isActive: true })
        .orderBy('version desc')
        .limit(1);

      if (!rows || rows.length === 0) return fallback;

      const configData = JSON.parse(rows[0].configData || '{}');
      const siem = configData?.api_config?.observability?.siem;

      if (siem?.enabled === false) {
        return { shouldWrite: false, sinkNames: [], categories: [] };
      }

      const sinkNames: string[] = (siem?.sinks ?? [])
        .filter((s: any) => s?.enabled)
        .map((s: any) => s?.name)
        .filter((name: any): name is string => typeof name === 'string' && name.length > 0);

      const categories: string[] = Array.isArray(siem?.categories) && siem.categories.length > 0
        ? siem.categories
        : [...ALL_SIEM_CATEGORIES];

      return { shouldWrite: true, sinkNames, categories };
    } catch (error) {
      logger.warn('SecurityEventSubscriber', 'Failed to read SIEM configuration; writing the outbox event with no sinks', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return fallback;
    }
  }

  /**
   * Stop the consume loop. Used by shutdown() and by tests that need the loop to end.
   */
  public stop(): void {
    this.running = false;
  }

  /**
   * Persist the security event, then best-effort resolve its owner and fire a real-time
   * notification. Persistence uses SecurityEventService's *OrThrow variants so a DB failure
   * propagates to handleStreamEntry, which needs it to decide not to ack. Owner lookup and
   * notification are UX niceties, not part of the durability guarantee, so failures there are
   * caught locally and must never affect the ack decision.
   */
  private async processSecurityEvent(event: SecurityEventFromGateway): Promise<void> {
    if (event.authType === 'aws_credential') {
      await SecurityEventService.createAwsSecurityEventOrThrow({
        credentialId: event.credentialId,
        eventType: event.eventType as any,
        severity: event.severity as any,
        description: event.description,
        clientIP: event.clientIP,
        userAgent: event.userAgent,
        endpoint: event.endpoint,
        requestId: event.requestId,
        actionTaken: event.actionTaken,
        autoBlocked: event.autoBlocked
      });
    } else if (event.authType === 'api_key') {
      await SecurityEventService.createApiKeySecurityEventOrThrow({
        keyId: event.credentialId,
        eventType: event.eventType as any,
        severity: event.severity as any,
        description: event.description,
        clientIP: event.clientIP,
        userAgent: event.userAgent,
        endpoint: event.endpoint,
        requestId: event.requestId,
        actionTaken: event.actionTaken,
        autoBlocked: event.autoBlocked
      });
    }

    try {
      let ownerEmail: string | null = null;

      if (event.authType === 'aws_credential') {
        ownerEmail = await this.getAwsCredentialOwner(event.credentialId);
      } else if (event.authType === 'api_key') {
        ownerEmail = await this.getApiKeyOwner(event.credentialId);
      }

      // Send real-time notification to all admin users for high/critical security events
      if (ownerEmail && (event.severity === 'high' || event.severity === 'critical')) {
        notificationStreamService.notifyAll('new-security-event', {
          eventType: event.eventType,
          authType: event.authType,
          severity: event.severity,
          description: event.description,
          timestamp: event.timestamp,
          credentialId: event.credentialId,
          ownerEmail: ownerEmail // Include owner info for admin context
        });

        logger.info('SecurityEventSubscriber', 'Sent real-time notification to all admin users:', {
          ownerEmail,
          eventType: event.eventType,
          severity: event.severity
        });
      }

      logger.debug('SecurityEventSubscriber', 'Successfully processed security event:', {
        eventId: event.eventId,
        eventType: event.eventType,
        authType: event.authType,
        notifiedUser: ownerEmail
      });

    } catch (error) {
      logger.error('SecurityEventSubscriber', 'Failed to notify admins for security event (persistence already succeeded):', error as Error, {
        eventId: event.eventId,
        eventType: event.eventType
      });
    }
  }

  /**
   * Get AWS credential owner email
   */
  private async getAwsCredentialOwner(credentialId: string): Promise<string | null> {
    try {
      const cds = require('@sap/cds');
      const { SELECT } = cds.ql;
      
      logger.debug('SecurityEventSubscriber', 'Looking up AWS credential owner:', { credentialId });
      
      // First try to find by ID (most common case)
      let result = await SELECT.one.from('sap.llm.gateway.admin.AwsCredentials')
        .columns('email')
        .where({ ID: credentialId });
      
      if (result) {
        logger.debug('SecurityEventSubscriber', 'Found AWS credential owner by ID:', { email: result.email });
        return result.email;
      }
      
      // If not found by ID, try by accessKeyId (Gateway might send accessKeyId)
      result = await SELECT.one.from('sap.llm.gateway.admin.AwsCredentials')
        .columns('email')
        .where({ accessKeyId: credentialId });
        
      if (result) {
        logger.debug('SecurityEventSubscriber', 'Found AWS credential owner by accessKeyId:', { email: result.email });
        return result.email;
      }
      
      // If still not found, check rotation history for old accessKeyIds
      logger.debug('SecurityEventSubscriber', 'Looking up AWS credential by rotation history for old accessKeyId');
      const rotationResult = await SELECT.one.from('sap.llm.gateway.admin.AwsCredentialRotations')
        .columns('credential_ID')
        .where({ oldAccessKeyId: credentialId })
        .orderBy('createdAt desc');
        
      if (rotationResult) {
        const ownerResult = await SELECT.one.from('sap.llm.gateway.admin.AwsCredentials')
          .columns('email')
          .where({ ID: rotationResult.credential_ID });
          
        if (ownerResult) {
          logger.debug('SecurityEventSubscriber', 'Found AWS credential owner via rotation history:', { email: ownerResult.email });
          return ownerResult.email;
        }
      }
      
      logger.warn('SecurityEventSubscriber', 'AWS credential owner not found:', { credentialId });
      return null;
    } catch (error) {
      logger.error('SecurityEventSubscriber', 'Failed to get AWS credential owner:', error as Error, { credentialId });
      return null;
    }
  }

  /**
   * Get API key owner email
   */
  private async getApiKeyOwner(keyId: string): Promise<string | null> {
    try {
      const cds = require('@sap/cds');
      const { SELECT } = cds.ql;
      
      logger.debug('SecurityEventSubscriber', 'Looking up API key owner:', { keyId: keyId.substring(0, 10) + '...' });
      
      // First try to find by the actual key string (Gateway sends the key, not the ID)
      let result = await SELECT.one.from('sap.llm.gateway.admin.ApiKeys')
        .columns('email')
        .where({ key: keyId });
      
      if (result) {
        logger.debug('SecurityEventSubscriber', 'Found API key owner by key string:', { email: result.email });
        return result.email;
      }
      
      // If not found by key, try by ID (fallback for cases where ID is actually sent)
      result = await SELECT.one.from('sap.llm.gateway.admin.ApiKeys')
        .columns('email')
        .where({ ID: keyId });
        
      if (result) {
        logger.debug('SecurityEventSubscriber', 'Found API key owner by ID:', { email: result.email });
        return result.email;
      }
      
      // If still not found, check rotation history for old keys
      logger.debug('SecurityEventSubscriber', 'Looking up API key by rotation history for old key');
      const rotationResult = await SELECT.one.from('sap.llm.gateway.admin.ApiKeyRotations')
        .columns('apiKey_ID')
        .where({ oldKey: keyId })
        .orderBy('createdAt desc');
        
      if (rotationResult) {
        const ownerResult = await SELECT.one.from('sap.llm.gateway.admin.ApiKeys')
          .columns('email')
          .where({ ID: rotationResult.apiKey_ID });
          
        if (ownerResult) {
          logger.debug('SecurityEventSubscriber', 'Found API key owner via rotation history:', { email: ownerResult.email });
          return ownerResult.email;
        }
      }
      
      logger.warn('SecurityEventSubscriber', 'API key owner not found:', { keyId: keyId.substring(0, 10) + '...' });
      return null;
    } catch (error) {
      logger.error('SecurityEventSubscriber', 'Failed to get API key owner:', error as Error, { keyId: keyId.substring(0, 10) + '...' });
      return null;
    }
  }

  private async handleReconnection() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('SecurityEventSubscriber', 
        `Max reconnection attempts (${this.maxReconnectAttempts}) reached. Security event subscription disabled.`);
      return;
    }

    this.reconnectAttempts++;
    logger.info('SecurityEventSubscriber', 
      `Attempting to reconnect to Valkey (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    setTimeout(async () => {
      try {
        if (this.valkeyClient) {
          this.valkeyClient.disconnect();
        }
        await this.initializeSubscription();
      } catch (error) {
        logger.error('SecurityEventSubscriber', 'Reconnection attempt failed:', error as Error);
      }
    }, this.reconnectDelay * this.reconnectAttempts); // Exponential backoff
  }

  /**
   * Gracefully shutdown the subscriber
   */
  public async shutdown() {
    logger.info('SecurityEventSubscriber', 'Shutting down security event subscriber');

    // Ends the consumeLoop (it checks `running` between blocking XREADGROUP calls).
    this.stop();

    if (this.valkeyClient) {
      try {
        this.valkeyClient.disconnect();
      } catch (error) {
        logger.warn('SecurityEventSubscriber', 'Error during shutdown:', error as Error);
      }
    }

    this.isSubscribed = false;
    this.valkeyClient = null;
  }

  /**
   * Get subscriber status
   */
  public getStatus() {
    return {
      connected: this.valkeyClient?.status === 'ready' || false,
      subscribed: this.isSubscribed,
      reconnectAttempts: this.reconnectAttempts
    };
  }
}

// Create singleton instance
const securityEventSubscriber = new SecurityEventSubscriber();

// Graceful shutdown handling
process.on('SIGINT', async () => {
  logger.info('SecurityEventSubscriber', 'Received SIGINT, shutting down...');
  await securityEventSubscriber.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('SecurityEventSubscriber', 'Received SIGTERM, shutting down...');
  await securityEventSubscriber.shutdown();
  process.exit(0);
});

export default securityEventSubscriber;
export { SecurityEventSubscriber };