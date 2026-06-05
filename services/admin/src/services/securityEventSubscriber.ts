/**
 * Security Event Subscriber Service for Admin Service
 * 
 * Subscribes to security events published by gateway via Valkey pub/sub
 * and persists them to the database using SecurityEventService.
 */

import Redis from 'iovalkey';
import { getDefaultLogger } from '@libs/logger';
import { SecurityEventService } from './securityEventService';
import { notificationStreamService } from '../srv/notification-stream';

const logger = getDefaultLogger();

export interface SecurityEventFromGateway {
  eventId: string;
  credentialId: string;
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
}

class SecurityEventSubscriber {
  private valkeyClient: Redis | null = null;
  private isSubscribed: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private reconnectDelay: number = 5000; // 5 seconds

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
      await this.valkeyClient.subscribe('security-events');
      this.isSubscribed = true;
      
      logger.info('SecurityEventSubscriber', 'Successfully subscribed to security-events channel');
      
      // Handle incoming security events
      this.valkeyClient.on('message', this.handleSecurityEvent.bind(this));
      
    } catch (error) {
      logger.error('SecurityEventSubscriber', 'Failed to subscribe to security-events channel:', error as Error);
      throw error;
    }
  }

  private async handleSecurityEvent(channel: string, message: string) {
    if (channel !== 'security-events') {
      return;
    }

    try {
      const event: SecurityEventFromGateway = JSON.parse(message);
      
      logger.debug('SecurityEventSubscriber', 'Received security event:', {
        eventId: event.eventId,
        eventType: event.eventType,
        authType: event.authType,
        severity: event.severity
      });

      // Process the security event
      await this.processSecurityEvent(event);
      
    } catch (error) {
      logger.error('SecurityEventSubscriber', 'Failed to process security event message:', error as Error, {
        message: message.substring(0, 200) // Log first 200 chars for debugging
      });
    }
  }

  private async processSecurityEvent(event: SecurityEventFromGateway) {
    try {
      let ownerEmail: string | null = null;

      // Convert gateway event to admin service format and persist
      if (event.authType === 'aws_credential') {
        const createdEvent = await SecurityEventService.createAwsSecurityEvent({
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

        // Get the credential owner's email for notification
        ownerEmail = await this.getAwsCredentialOwner(event.credentialId);

      } else if (event.authType === 'api_key') {
        const createdEvent = await SecurityEventService.createApiKeySecurityEvent({
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

        // Get the API key owner's email for notification
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
      logger.error('SecurityEventSubscriber', 'Failed to persist security event:', error as Error, {
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
    
    if (this.valkeyClient) {
      try {
        if (this.isSubscribed) {
          await this.valkeyClient.unsubscribe('security-events');
        }
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