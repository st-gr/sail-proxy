import { getDefaultLogger } from '@libs/logger';

const cds = require('@sap/cds');
const { SELECT, INSERT, DELETE } = cds.ql;
const logger = getDefaultLogger();

/**
 * Service to populate SecurityNotifications from existing security events
 * Provides backfill functionality for existing data without DB migration
 */
export class NotificationPopulationService {
  
  /**
   * Populate SecurityNotifications from all existing security event types
   */
  async populateFromAllSecurityEvents() {
    logger.info('NotificationPopulationService', 'Starting security notification population');
    
    try {
      // Clear existing notifications to avoid duplicates during development
      await DELETE.from('sap.llm.gateway.admin.SecurityNotifications');
      logger.info('NotificationPopulationService', 'Cleared existing notifications');
      
      // Populate from different event sources
      await this.populateFromAwsSecurityEvents();
      await this.populateFromApiKeySecurityEvents(); 
      await this.populateFromAwsCredentialRotations();
      
      logger.info('NotificationPopulationService', 'Security notification population completed');
      
    } catch (error) {
      logger.error('NotificationPopulationService', 'Failed to populate security notifications:', error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
  
  /**
   * Populate from AWS Credential Security Events
   */
  private async populateFromAwsSecurityEvents() {
    const events = await SELECT.from('sap.llm.gateway.admin.AwsCredentialSecurityEvents', (e: any) => {
      e.ID, e.credential_ID, e.eventType, e.severity, e.description, e.createdAt,
      e.clientIP, e.userAgent, e.endpoint, e.requestId
    });
    
    logger.info('NotificationPopulationService', `Processing ${events.length} AWS security events`);
    
    for (const event of events) {
      try {
        // Get credential to determine owner (try both ID and accessKeyId for compatibility)
        let credential = await SELECT.one.from('sap.llm.gateway.admin.AwsCredentials')
          .columns('ID', 'email', 'name')
          .where({ ID: event.credential_ID });
          
        // If not found by ID, try looking up by accessKeyId (for current credentials)
        if (!credential) {
          credential = await SELECT.one.from('sap.llm.gateway.admin.AwsCredentials')
            .columns('ID', 'email', 'name')
            .where({ accessKeyId: event.credential_ID });
        }
        
        // If still not found, try looking up in rotation history (for rotated credentials)
        if (!credential) {
          const rotation = await SELECT.one.from('sap.llm.gateway.admin.AwsCredentialRotations')
            .columns('credential_ID')
            .where({ oldAccessKeyId: event.credential_ID })
            .orderBy('createdAt desc');
          
          if (rotation) {
            credential = await SELECT.one.from('sap.llm.gateway.admin.AwsCredentials')
              .columns('ID', 'email', 'name')
              .where({ ID: rotation.credential_ID });
            
            if (credential) {
              logger.info('NotificationPopulationService', `Found credential via rotation history for old accessKeyId`, {
                oldAccessKeyId: event.credential_ID,
                currentCredentialId: credential.ID,
                credentialEmail: credential.email
              });
            }
          }
        }
          
        if (!credential) {
          logger.warn('NotificationPopulationService', `Credential not found for AWS security event ${event.ID} (checked rotation history)`);
          continue;
        }
        
        // Only process credentials that have proper email addresses
        if (!credential.email) {
          logger.warn('NotificationPopulationService', `Skipping AWS security event ${event.ID} - no email address on credential`);
          continue;
        }
        
        await INSERT.into('sap.llm.gateway.admin.SecurityNotifications').entries({
          type: 'security_event',
          sourceEntity: 'AwsCredentialSecurityEvents',
          sourceID: event.ID,
          ownerEmail: credential.email,
          title: this.generateTitleForAwsEvent(event.eventType, credential.name),
          message: event.description || `${event.eventType} event for AWS credential ${credential.name}`,
          severity: event.severity,
          eventType: event.eventType,
          eventDate: event.createdAt,
          icon: this.getIconForEventType(event.eventType),
          actionable: this.isEventActionable(event.eventType),
          actionText: this.getActionText(event.eventType),
          actionUrl: `/app/aws-credentials/${credential.ID}`
        });
        
      } catch (error) {
        logger.error('NotificationPopulationService', `Failed to process AWS security event ${event.ID}:`, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
  
  /**
   * Populate from API Key Security Events
   */
  private async populateFromApiKeySecurityEvents() {
    const events = await SELECT.from('sap.llm.gateway.admin.ApiKeySecurityEvents', (e: any) => {
      e.ID, e.apiKey_ID, e.eventType, e.severity, e.description, e.createdAt,
      e.clientIP, e.userAgent, e.endpoint, e.requestId
    });
    
    logger.info('NotificationPopulationService', `Processing ${events.length} API key security events`);
    
    for (const event of events) {
      try {
        // Get API key to determine owner
        const apiKey = await SELECT.one.from('sap.llm.gateway.admin.ApiKeys')
          .columns('email', 'name')
          .where({ ID: event.apiKey_ID });
          
        if (!apiKey) {
          logger.warn('NotificationPopulationService', `API key not found for security event ${event.ID}`);
          continue;
        }
        
        await INSERT.into('sap.llm.gateway.admin.SecurityNotifications').entries({
          type: 'security_event',
          sourceEntity: 'ApiKeySecurityEvents', 
          sourceID: event.ID,
          ownerEmail: apiKey.email,
          title: this.generateTitleForApiKeyEvent(event.eventType, apiKey.name),
          message: event.description || `${event.eventType} event for API key ${apiKey.name}`,
          severity: event.severity,
          eventType: event.eventType,
          eventDate: event.createdAt,
          icon: this.getIconForEventType(event.eventType),
          actionable: this.isEventActionable(event.eventType),
          actionText: this.getActionText(event.eventType),
          actionUrl: `/app/api-keys/${apiKey.ID}`
        });
        
      } catch (error) {
        logger.error('NotificationPopulationService', `Failed to process API key security event ${event.ID}:`, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
  
  /**
   * Populate from AWS Credential Rotations
   */
  private async populateFromAwsCredentialRotations() {
    const rotations = await SELECT.from('sap.llm.gateway.admin.AwsCredentialRotations', (r: any) => {
      r.ID, r.credential_ID, r.rotationType, r.reason, r.rotationSuccess, 
      r.rotatedBy, r.createdAt, r.oldAccessKeyId, r.newAccessKeyId
    });
    
    logger.info('NotificationPopulationService', `Processing ${rotations.length} AWS credential rotations`);
    
    for (const rotation of rotations) {
      try {
        // Get credential to determine owner
        const credential = await SELECT.one.from('sap.llm.gateway.admin.AwsCredentials')
          .columns('email', 'name')
          .where({ ID: rotation.credential_ID });
          
        if (!credential) {
          logger.warn('NotificationPopulationService', `Credential not found for rotation ${rotation.ID}`);
          continue;
        }
        
        // Only process credentials that have proper email addresses
        if (!credential.email) {
          logger.warn('NotificationPopulationService', `Skipping rotation ${rotation.ID} - no email address on credential`);
          continue;
        }
        
        const success = rotation.rotationSuccess;
        const severity = success ? 'low' : 'high';
        const eventType = success ? 'credential_rotated' : 'rotation_failed';
        
        await INSERT.into('sap.llm.gateway.admin.SecurityNotifications').entries({
          type: 'rotation_event',
          sourceEntity: 'AwsCredentialRotations',
          sourceID: rotation.ID,
          ownerEmail: credential.email,
          title: this.generateTitleForRotation(rotation.rotationType, success, credential.name),
          message: this.generateMessageForRotation(rotation, credential.name),
          severity,
          eventType,
          eventDate: rotation.createdAt,
          icon: success ? 'sap-icon://key' : 'sap-icon://error',
          actionable: !success, // Failed rotations are actionable
          actionText: success ? null : 'Retry Rotation',
          actionUrl: `/app/aws-credentials/${credential.ID}`
        });
        
      } catch (error) {
        logger.error('NotificationPopulationService', `Failed to process rotation ${rotation.ID}:`, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
  
  /**
   * Generate user-friendly title for AWS security events
   */
  private generateTitleForAwsEvent(eventType: string, credentialName: string): string {
    const titles: { [key: string]: string } = {
      'failed_auth': `Authentication failed for ${credentialName}`,
      'suspicious_activity': `Suspicious activity detected for ${credentialName}`,
      'rate_limit_exceeded': `Rate limit exceeded for ${credentialName}`,
      'unauthorized_access': `Unauthorized access attempt on ${credentialName}`,
      'invalid_signature': `Invalid signature detected for ${credentialName}`
    };
    
    return titles[eventType] || `Security event for ${credentialName}`;
  }
  
  /**
   * Generate user-friendly title for API key security events
   */
  private generateTitleForApiKeyEvent(eventType: string, keyName: string): string {
    const titles: { [key: string]: string } = {
      'failed_auth': `Authentication failed for API key ${keyName}`,
      'suspicious_activity': `Suspicious activity detected for API key ${keyName}`,
      'rate_limit_exceeded': `Rate limit exceeded for API key ${keyName}`,
      'unauthorized_access': `Unauthorized access attempt on API key ${keyName}`
    };
    
    return titles[eventType] || `Security event for API key ${keyName}`;
  }
  
  /**
   * Generate title for credential rotation events
   */
  private generateTitleForRotation(rotationType: string, success: boolean, credentialName: string): string {
    const action = rotationType === 'manual' ? 'Manual' : 'Automatic';
    const result = success ? 'completed' : 'failed';
    return `${action} rotation ${result} for ${credentialName}`;
  }
  
  /**
   * Generate detailed message for rotation events
   */
  private generateMessageForRotation(rotation: any, credentialName: string): string {
    if (rotation.rotationSuccess) {
      return `${rotation.rotationType} rotation completed for ${credentialName}. ` +
             `Old key ${rotation.oldAccessKeyId} has been replaced with ${rotation.newAccessKeyId}. ` +
             `Rotated by: ${rotation.rotatedBy}`;
    } else {
      return `${rotation.rotationType} rotation failed for ${credentialName}. ` +
             `Reason: ${rotation.reason}. Please check the credential configuration and retry.`;
    }
  }
  
  /**
   * Get appropriate SAP icon for event type
   */
  private getIconForEventType(eventType: string): string {
    const icons: { [key: string]: string } = {
      'failed_auth': 'sap-icon://shield',
      'suspicious_activity': 'sap-icon://warning',
      'rate_limit_exceeded': 'sap-icon://measuring-point',
      'unauthorized_access': 'sap-icon://locked',
      'invalid_signature': 'sap-icon://signature',
      'credential_rotated': 'sap-icon://key',
      'rotation_failed': 'sap-icon://error'
    };
    
    return icons[eventType] || 'sap-icon://information';
  }
  
  /**
   * Determine if event type requires user action
   */
  private isEventActionable(eventType: string): boolean {
    const actionableEvents = [
      'failed_auth',
      'suspicious_activity', 
      'unauthorized_access',
      'rotation_failed'
    ];
    
    return actionableEvents.includes(eventType);
  }
  
  /**
   * Get action text for actionable events
   */
  private getActionText(eventType: string): string | null {
    const actionTexts: { [key: string]: string } = {
      'failed_auth': 'View Details',
      'suspicious_activity': 'Investigate',
      'unauthorized_access': 'Secure Account',
      'rotation_failed': 'Retry Rotation'
    };
    
    return actionTexts[eventType] || null;
  }
}

// Export singleton instance
export const notificationPopulationService = new NotificationPopulationService();