/**
 * Security Notifications Configuration
 * Centralized configuration for security notification settings
 */

export interface SecurityNotificationConfig {
  /** Minimum age in days before a notification can be deleted */
  minDeleteAgeDays: number;
  /** Maximum days in the future a notification can be snoozed */
  maxSnoozeDays: number;
}

/**
 * Load security notification configuration from environment variables
 */
export function loadSecurityNotificationConfig(): SecurityNotificationConfig {
  return {
    // Default: 30 days minimum age for deletion (configurable via SECURITY_NOTIFICATION_MIN_DELETE_AGE_DAYS)
    minDeleteAgeDays: parseInt(process.env.SECURITY_NOTIFICATION_MIN_DELETE_AGE_DAYS || '30', 10),
    
    // Default: 30 days maximum snooze period (configurable via SECURITY_NOTIFICATION_MAX_SNOOZE_DAYS) 
    maxSnoozeDays: parseInt(process.env.SECURITY_NOTIFICATION_MAX_SNOOZE_DAYS || '30', 10)
  };
}

/**
 * Validate configuration values
 */
export function validateSecurityNotificationConfig(config: SecurityNotificationConfig): void {
  if (config.minDeleteAgeDays < 1) {
    throw new Error('SECURITY_NOTIFICATION_MIN_DELETE_AGE_DAYS must be at least 1 day');
  }
  
  if (config.maxSnoozeDays < 1) {
    throw new Error('SECURITY_NOTIFICATION_MAX_SNOOZE_DAYS must be at least 1 day');
  }
  
  if (config.minDeleteAgeDays > 365) {
    throw new Error('SECURITY_NOTIFICATION_MIN_DELETE_AGE_DAYS cannot exceed 365 days');
  }
  
  if (config.maxSnoozeDays > 365) {
    throw new Error('SECURITY_NOTIFICATION_MAX_SNOOZE_DAYS cannot exceed 365 days');
  }
}

// Export singleton configuration instance
export const securityNotificationConfig = loadSecurityNotificationConfig();

// Validate configuration on module load
validateSecurityNotificationConfig(securityNotificationConfig);