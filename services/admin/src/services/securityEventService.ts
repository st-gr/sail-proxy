import { v4 as uuidv4 } from 'uuid';
import { getDefaultLogger } from '@libs/logger';

const cds = require('@sap/cds');
const logger = getDefaultLogger();

export interface SecurityEventData {
  credentialId: string;
  eventType: 'failed_auth' | 'suspicious_activity' | 'rate_limit_exceeded' | 'unauthorized_access' | 'credential_rotation' | 'ip_blocked' | 'brute_force_detected';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  clientIP?: string;
  userAgent?: string;
  endpoint?: string;
  requestId?: string;
  actionTaken?: string;
  autoBlocked?: boolean;
}

export interface ApiKeySecurityEventData {
  keyId: string;
  eventType: 'failed_auth' | 'suspicious_activity' | 'rate_limit_exceeded' | 'unauthorized_access' | 'key_rotation' | 'ip_blocked' | 'brute_force_detected';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  clientIP?: string;
  userAgent?: string;
  endpoint?: string;
  requestId?: string;
  actionTaken?: string;
  autoBlocked?: boolean;
}

/**
 * Service for creating and persisting security events
 */
export class SecurityEventService {
  
  /**
   * Create and persist an AWS credential security event
   */
  static async createAwsSecurityEvent(eventData: SecurityEventData): Promise<void> {
    try {
      const securityEvent = {
        ID: uuidv4(),
        credential_ID: eventData.credentialId,
        eventType: eventData.eventType,
        severity: eventData.severity,
        description: eventData.description,
        clientIP: eventData.clientIP || null,
        userAgent: eventData.userAgent || null,
        endpoint: eventData.endpoint || null,
        requestId: eventData.requestId || null,
        actionTaken: eventData.actionTaken || 'logged',
        autoBlocked: eventData.autoBlocked || false,
        investigated: false,
        createdAt: new Date(),
        createdBy: 'system'
      };

      const db = await cds.connect.to('db');
      await db.run(
        cds.ql.INSERT.into('sap.llm.gateway.admin.AwsCredentialSecurityEvents').entries(securityEvent)
      );

      // Automatically create SecurityNotification
      await this.createNotificationForAwsEvent(securityEvent);

      logger.warn('SecurityEventService', `AWS Security Event Created: ${eventData.eventType}`, {
        credentialId: eventData.credentialId,
        severity: eventData.severity,
        description: eventData.description,
        clientIP: eventData.clientIP,
        actionTaken: eventData.actionTaken
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('SecurityEventService', `Failed to create AWS security event: ${errorMessage}`, error as Error);
      // Don't throw - security event failures shouldn't break the main flow
    }
  }

  /**
   * Create and persist an API key security event
   */
  static async createApiKeySecurityEvent(eventData: ApiKeySecurityEventData): Promise<void> {
    try {
      // Look up the API key's UUID from the database
      const db = await cds.connect.to('db');
      const { SELECT } = cds.ql;
      
      // First try to find by the actual key string (Gateway sends the key, not the ID)
      let apiKeyResult = await db.run(
        SELECT.one.from('sap.llm.gateway.admin.ApiKeys')
          .columns('ID')
          .where({ key: eventData.keyId })
      );
      
      // If not found by key, try by ID (fallback for cases where ID is actually sent)
      if (!apiKeyResult && eventData.keyId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
        apiKeyResult = await db.run(
          SELECT.one.from('sap.llm.gateway.admin.ApiKeys')
            .columns('ID')
            .where({ ID: eventData.keyId })
        );
      }
      
      // If still not found, check rotation history for old keys
      if (!apiKeyResult) {
        const rotationResult = await db.run(
          SELECT.one.from('sap.llm.gateway.admin.ApiKeyRotations')
            .columns('apiKey_ID')
            .where({ oldKey: eventData.keyId })
            .orderBy('createdAt desc')
        );
        
        if (rotationResult) {
          apiKeyResult = { ID: rotationResult.apiKey_ID };
          logger.info('SecurityEventService', 'Found API key UUID via rotation history for old key', {
            oldKey: eventData.keyId.substring(0, 10) + '...',
            currentApiKeyId: rotationResult.apiKey_ID
          });
        }
      }
      
      if (!apiKeyResult) {
        logger.warn('SecurityEventService', 'API key not found even after checking rotation history', { 
          keyId: eventData.keyId.substring(0, 10) + '...' 
        });
        // Use the key string as the ID temporarily - this will allow notification creation with system owner
        apiKeyResult = { ID: eventData.keyId };
      }

      const securityEvent = {
        ID: uuidv4(),
        apiKey_ID: apiKeyResult.ID,
        eventType: eventData.eventType,
        severity: eventData.severity,
        description: eventData.description,
        clientIP: eventData.clientIP || null,
        userAgent: eventData.userAgent || null,
        endpoint: eventData.endpoint || null,
        requestId: eventData.requestId || null,
        actionTaken: eventData.actionTaken || 'logged',
        autoBlocked: eventData.autoBlocked || false,
        investigated: false,
        createdAt: new Date(),
        createdBy: 'system'
      };

      await db.run(
        cds.ql.INSERT.into('sap.llm.gateway.admin.ApiKeySecurityEvents').entries(securityEvent)
      );

      // Automatically create SecurityNotification
      await this.createNotificationForApiKeyEvent(securityEvent);

      logger.warn('SecurityEventService', `API Key Security Event: ${eventData.eventType}`, {
        keyId: eventData.keyId,
        severity: eventData.severity,
        description: eventData.description,
        clientIP: eventData.clientIP,
        actionTaken: eventData.actionTaken
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('SecurityEventService', `Failed to create API key security event: ${errorMessage}`, error as Error);
      // Don't throw - security event failures shouldn't break the main flow
    }
  }

  /**
   * Create security event for failed authentication attempts
   */
  static async logFailedAuthentication(
    credentialId: string,
    authType: 'api_key' | 'aws_credentials',
    clientIP?: string,
    userAgent?: string,
    endpoint?: string,
    requestId?: string
  ): Promise<void> {
    const eventData = {
      credentialId: credentialId,
      eventType: 'failed_auth' as const,
      severity: 'high' as const,
      description: `Failed authentication attempt for ${authType}`,
      clientIP,
      userAgent,
      endpoint,
      requestId,
      actionTaken: 'blocked'
    };

    if (authType === 'aws_credentials') {
      await this.createAwsSecurityEvent(eventData);
    } else {
      await this.createApiKeySecurityEvent({
        keyId: credentialId,
        eventType: eventData.eventType,
        severity: eventData.severity,
        description: eventData.description,
        clientIP,
        userAgent,
        endpoint,
        requestId,
        actionTaken: eventData.actionTaken
      });
    }
  }

  /**
   * Create security event for suspicious activity
   */
  static async logSuspiciousActivity(
    credentialId: string,
    authType: 'api_key' | 'aws_credentials',
    description: string,
    severity: 'low' | 'medium' | 'high' | 'critical' = 'medium',
    clientIP?: string,
    userAgent?: string,
    endpoint?: string,
    requestId?: string,
    actionTaken: string = 'monitored'
  ): Promise<void> {
    const eventData = {
      credentialId,
      eventType: 'suspicious_activity' as const,
      severity,
      description,
      clientIP,
      userAgent,
      endpoint,
      requestId,
      actionTaken
    };

    if (authType === 'aws_credentials') {
      await this.createAwsSecurityEvent(eventData);
    } else {
      await this.createApiKeySecurityEvent({
        keyId: credentialId,
        eventType: eventData.eventType,
        severity: eventData.severity,
        description: eventData.description,
        clientIP,
        userAgent,
        endpoint,
        requestId,
        actionTaken: eventData.actionTaken
      });
    }
  }

  /**
   * Create security event for rate limit violations
   */
  static async logRateLimitExceeded(
    credentialId: string,
    authType: 'api_key' | 'aws_credentials',
    limitType: string,
    clientIP?: string,
    userAgent?: string,
    endpoint?: string,
    requestId?: string
  ): Promise<void> {
    const eventData = {
      credentialId,
      eventType: 'rate_limit_exceeded' as const,
      severity: 'high' as const,
      description: `Rate limit exceeded: ${limitType}`,
      clientIP,
      userAgent,
      endpoint,
      requestId,
      actionTaken: 'throttled',
      autoBlocked: true
    };

    if (authType === 'aws_credentials') {
      await this.createAwsSecurityEvent(eventData);
    } else {
      await this.createApiKeySecurityEvent({
        keyId: credentialId,
        eventType: eventData.eventType,
        severity: eventData.severity,
        description: eventData.description,
        clientIP,
        userAgent,
        endpoint,
        requestId,
        actionTaken: eventData.actionTaken,
        autoBlocked: eventData.autoBlocked
      });
    }
  }

  /**
   * Create SecurityNotification for AWS security event
   */
  private static async createNotificationForAwsEvent(securityEvent: any): Promise<void> {
    try {
      const db = await cds.connect.to('db');
      
      // Get credential to determine owner (try both ID and accessKeyId for compatibility)
      let credential = await db.run(
        cds.ql.SELECT.one.from('sap.llm.gateway.admin.AwsCredentials')
          .columns('ID', 'email', 'name')
          .where({ ID: securityEvent.credential_ID })
      );
      
      // If not found by ID, try looking up by accessKeyId (for current credentials)
      if (!credential) {
        credential = await db.run(
          cds.ql.SELECT.one.from('sap.llm.gateway.admin.AwsCredentials')
            .columns('ID', 'email', 'name')
            .where({ accessKeyId: securityEvent.credential_ID })
        );
      }
      
      // If still not found, try looking up in rotation history (for rotated credentials)
      if (!credential) {
        const rotation = await db.run(
          cds.ql.SELECT.one.from('sap.llm.gateway.admin.AwsCredentialRotations')
            .columns('credential_ID')
            .where({ oldAccessKeyId: securityEvent.credential_ID })
            .orderBy('createdAt desc')
        );
        
        if (rotation) {
          credential = await db.run(
            cds.ql.SELECT.one.from('sap.llm.gateway.admin.AwsCredentials')
              .columns('ID', 'email', 'name')
              .where({ ID: rotation.credential_ID })
          );
          
          if (credential) {
            logger.info('SecurityEventService', `Found credential via rotation history for old accessKeyId`, {
              oldAccessKeyId: securityEvent.credential_ID,
              currentCredentialId: credential.ID,
              credentialEmail: credential.email
            });
          }
        }
      }
        
      if (!credential || !credential.email) {
        logger.warn('SecurityEventService', `AWS credential not found for event ${securityEvent.ID} - creating system notification`, {
          credentialId: securityEvent.credential_ID,
          hasCredential: !!credential,
          credentialEmail: credential?.email || 'none',
          checkedRotationHistory: true
        });
        
        // For invalid/unknown AWS credentials, create a system-level notification for administrators
        // This ensures security events are visible even when the credential owner cannot be determined
        const notification = {
          ID: uuidv4(),
          type: 'security_event',
          sourceEntity: 'AwsCredentialSecurityEvents',
          sourceID: securityEvent.ID,
          ownerEmail: 'system', // System-level notification for admins
          title: this.generateTitleForAwsEvent(securityEvent.eventType, 'Unknown AWS Credential'),
          message: securityEvent.description || `${securityEvent.eventType} event for unknown AWS credential (${securityEvent.credential_ID})`,
          severity: securityEvent.severity,
          eventType: securityEvent.eventType,
          eventDate: securityEvent.createdAt,
          icon: this.getIconForEventType(securityEvent.eventType),
          actionable: true, // Unknown credentials are always actionable
          actionText: 'Investigate',
          actionUrl: `/app/security-events`, // Link to security events page
          createdAt: new Date(),
          createdBy: 'system'
        };

        await db.run(
          cds.ql.INSERT.into('sap.llm.gateway.admin.SecurityNotifications').entries(notification)
        );

        logger.info('SecurityEventService', `Created system notification for unknown AWS credential security event`, {
          eventId: securityEvent.ID,
          notificationId: notification.ID,
          eventType: securityEvent.eventType,
          severity: securityEvent.severity
        });
        
        return;
      }
      
      const notification = {
        ID: uuidv4(),
        type: 'security_event',
        sourceEntity: 'AwsCredentialSecurityEvents',
        sourceID: securityEvent.ID,
        ownerEmail: credential.email,
        title: this.generateTitleForAwsEvent(securityEvent.eventType, credential.name),
        message: securityEvent.description || `${securityEvent.eventType} event for AWS credential ${credential.name}`,
        severity: securityEvent.severity,
        eventType: securityEvent.eventType,
        eventDate: securityEvent.createdAt,
        icon: this.getIconForEventType(securityEvent.eventType),
        actionable: this.isEventActionable(securityEvent.eventType),
        actionText: this.getActionText(securityEvent.eventType),
        actionUrl: `/app/aws-credentials/${credential.ID}`,
        createdAt: new Date(),
        createdBy: 'system'
      };

      await db.run(
        cds.ql.INSERT.into('sap.llm.gateway.admin.SecurityNotifications').entries(notification)
      );

      logger.info('SecurityEventService', `Created notification for AWS security event`, {
        eventId: securityEvent.ID,
        notificationId: notification.ID,
        ownerEmail: credential.email,
        eventType: securityEvent.eventType,
        severity: securityEvent.severity
      });

    } catch (error) {
      logger.error('SecurityEventService', `Failed to create notification for AWS event: ${error instanceof Error ? error.message : error}`, error instanceof Error ? error : undefined);
    }
  }

  /**
   * Create SecurityNotification for API key security event
   */
  private static async createNotificationForApiKeyEvent(securityEvent: any): Promise<void> {
    try {
      const db = await cds.connect.to('db');
      
      // Get API key to determine owner
      // For failed authentication events from gateway, apiKey_ID contains the API key string, not the UUID
      let apiKey;
      
      if (securityEvent.eventType === 'failed_auth' && securityEvent.apiKey_ID) {
        // For failed auth events, apiKey_ID contains the actual API key string from gateway
        // Try to look up by the API key string first
        apiKey = await db.run(
          cds.ql.SELECT.one.from('sap.llm.gateway.admin.ApiKeys')
            .columns('ID', 'email', 'name')
            .where({ key: securityEvent.apiKey_ID })
        );
        
        logger.info('SecurityEventService', `Looking up API key by key string for failed auth`, {
          apiKeyString: typeof securityEvent.apiKey_ID === 'string' ? securityEvent.apiKey_ID.substring(0, 10) + '...' : securityEvent.apiKey_ID,
          found: !!apiKey,
          apiKeyEmail: apiKey?.email || 'none'
        });
        
        // If not found by key string, try by ID (fallback for other event types)
        if (!apiKey) {
          apiKey = await db.run(
            cds.ql.SELECT.one.from('sap.llm.gateway.admin.ApiKeys')
              .columns('ID', 'email', 'name')
              .where({ ID: securityEvent.apiKey_ID })
          );
        }
        
        // If still not found, try looking up in rotation history (for rotated API keys)
        if (!apiKey) {
          const rotation = await db.run(
            cds.ql.SELECT.one.from('sap.llm.gateway.admin.ApiKeyRotations')
              .columns('apiKey_ID')
              .where({ oldKey: securityEvent.apiKey_ID })
              .orderBy('createdAt desc')
          );
          
          if (rotation) {
            apiKey = await db.run(
              cds.ql.SELECT.one.from('sap.llm.gateway.admin.ApiKeys')
                .columns('ID', 'email', 'name')
                .where({ ID: rotation.apiKey_ID })
            );
            
            if (apiKey) {
              logger.info('SecurityEventService', `Found API key via rotation history for old key`, {
                oldKey: securityEvent.apiKey_ID.substring(0, 10) + '...',
                currentApiKeyId: apiKey.ID,
                apiKeyEmail: apiKey.email
              });
            }
          }
        }
      } else {
        // For other events, use the apiKey_ID as UUID
        apiKey = await db.run(
          cds.ql.SELECT.one.from('sap.llm.gateway.admin.ApiKeys')
            .columns('ID', 'email', 'name')
            .where({ ID: securityEvent.apiKey_ID })
        );
      }
        
      if (!apiKey || !apiKey.email) {
        logger.warn('SecurityEventService', `API key not found for event ${securityEvent.ID} - creating system notification`, {
          apiKeyId: securityEvent.apiKey_ID || 'none',
          apiKeyIdType: typeof securityEvent.apiKey_ID,
          eventType: securityEvent.eventType,
          hasApiKey: !!apiKey,
          apiKeyEmail: apiKey?.email || 'none',
          lookupMethod: securityEvent.eventType === 'failed_auth' ? 'by_key_string_with_rotation_history' : 'by_uuid',
          checkedRotationHistory: securityEvent.eventType === 'failed_auth'
        });
        
        // For invalid/unknown API keys, create a system-level notification for administrators
        // This ensures security events are visible even when the API key owner cannot be determined
        const notification = {
          ID: uuidv4(),
          type: 'security_event',
          sourceEntity: 'ApiKeySecurityEvents',
          sourceID: securityEvent.ID,
          ownerEmail: 'system', // System-level notification for admins
          title: this.generateTitleForApiKeyEvent(securityEvent.eventType, 'Unknown API Key'),
          message: securityEvent.description || `${securityEvent.eventType} event for unknown API key (${typeof securityEvent.apiKey_ID === 'string' ? securityEvent.apiKey_ID.substring(0, 10) + '...' : 'unknown'})`,
          severity: securityEvent.severity,
          eventType: securityEvent.eventType,
          eventDate: securityEvent.createdAt,
          icon: this.getIconForEventType(securityEvent.eventType),
          actionable: true, // Unknown keys are always actionable
          actionText: 'Investigate',
          actionUrl: `/app/security-events`, // Link to security events page
          createdAt: new Date(),
          createdBy: 'system'
        };

        await db.run(
          cds.ql.INSERT.into('sap.llm.gateway.admin.SecurityNotifications').entries(notification)
        );

        logger.info('SecurityEventService', `Created system notification for unknown API key security event`, {
          eventId: securityEvent.ID,
          notificationId: notification.ID,
          eventType: securityEvent.eventType,
          severity: securityEvent.severity
        });
        
        return;
      }
      
      const notification = {
        ID: uuidv4(),
        type: 'security_event',
        sourceEntity: 'ApiKeySecurityEvents',
        sourceID: securityEvent.ID,
        ownerEmail: apiKey.email,
        title: this.generateTitleForApiKeyEvent(securityEvent.eventType, apiKey.name),
        message: securityEvent.description || `${securityEvent.eventType} event for API key ${apiKey.name}`,
        severity: securityEvent.severity,
        eventType: securityEvent.eventType,
        eventDate: securityEvent.createdAt,
        icon: this.getIconForEventType(securityEvent.eventType),
        actionable: this.isEventActionable(securityEvent.eventType),
        actionText: this.getActionText(securityEvent.eventType),
        actionUrl: `/app/api-keys/${apiKey.ID}`,
        createdAt: new Date(),
        createdBy: 'system'
      };

      await db.run(
        cds.ql.INSERT.into('sap.llm.gateway.admin.SecurityNotifications').entries(notification)
      );

      logger.info('SecurityEventService', `Created notification for API key security event`, {
        eventId: securityEvent.ID,
        notificationId: notification.ID,
        ownerEmail: apiKey.email,
        eventType: securityEvent.eventType,
        severity: securityEvent.severity
      });

    } catch (error) {
      logger.error('SecurityEventService', `Failed to create notification for API key event: ${error instanceof Error ? error.message : error}`, error instanceof Error ? error : undefined);
    }
  }

  // Helper methods for notification creation
  private static generateTitleForAwsEvent(eventType: string, credentialName: string): string {
    const titles: { [key: string]: string } = {
      'failed_auth': `Authentication failed for ${credentialName}`,
      'suspicious_activity': `Suspicious activity detected for ${credentialName}`,
      'rate_limit_exceeded': `Rate limit exceeded for ${credentialName}`,
      'unauthorized_access': `Unauthorized access attempt on ${credentialName}`,
      'invalid_signature': `Invalid signature detected for ${credentialName}`
    };
    
    return titles[eventType] || `Security event for ${credentialName}`;
  }

  private static generateTitleForApiKeyEvent(eventType: string, keyName: string): string {
    const titles: { [key: string]: string } = {
      'failed_auth': `Authentication failed for API key ${keyName}`,
      'suspicious_activity': `Suspicious activity detected for API key ${keyName}`,
      'rate_limit_exceeded': `Rate limit exceeded for API key ${keyName}`,
      'unauthorized_access': `Unauthorized access attempt on API key ${keyName}`,
      'key_rotation': `API key ${keyName} was rotated`
    };
    
    return titles[eventType] || `Security event for API key ${keyName}`;
  }

  private static getIconForEventType(eventType: string): string {
    const icons: { [key: string]: string } = {
      'failed_auth': 'sap-icon://shield',
      'suspicious_activity': 'sap-icon://warning',
      'rate_limit_exceeded': 'sap-icon://measuring-point',
      'unauthorized_access': 'sap-icon://locked',
      'invalid_signature': 'sap-icon://signature',
      'key_rotation': 'sap-icon://key'
    };
    
    return icons[eventType] || 'sap-icon://information';
  }

  private static isEventActionable(eventType: string): boolean {
    const actionableEvents = [
      'failed_auth',
      'suspicious_activity', 
      'unauthorized_access'
    ];
    
    return actionableEvents.includes(eventType);
  }

  private static getActionText(eventType: string): string | null {
    const actionTexts: { [key: string]: string } = {
      'failed_auth': 'View Details',
      'suspicious_activity': 'Investigate',
      'unauthorized_access': 'Secure Account'
    };
    
    return actionTexts[eventType] || null;
  }
}

export default SecurityEventService;