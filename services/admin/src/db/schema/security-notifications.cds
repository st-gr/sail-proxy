namespace sap.llm.gateway.admin;

using { cuid, managed } from '@sap/cds/common';

/**
 * Unified notification envelope for all security events
 * Provides a consistent interface for UI consumption while maintaining
 * links to detailed concrete event entities
 */
entity SecurityNotifications : cuid, managed {
  type          : String(40);     // 'security_event' | 'rotation_event'
  sourceEntity  : String(60);     // 'AwsCredentialSecurityEvents' | 'ApiKeySecurityEvents' | 'AwsCredentialRotations'
  sourceID      : UUID;           // ID of the source event
  ownerEmail    : String(255);    // Derived from credential.userId or apiKey.email
  title         : String(255);    // User-friendly title
  message       : String(2000);   // Detailed message
  severity      : String(20);     // 'low' | 'medium' | 'high' | 'critical' (compatible with existing)
  eventType     : String(50);     // 'failed_auth' | 'rotation' | 'suspicious_activity' | etc.
  eventDate     : Timestamp;      // When the original event occurred
  
  // Metadata for UI
  icon          : String(100);    // SAP icon name
  actionable    : Boolean default false;  // Whether user can take action
  actionText    : String(100);    // Text for action button
  actionUrl     : String(500);    // URL for action (optional)
}

/**
 * Per-user notification state tracking
 * Enables dismissible, per-user notification management
 * One user dismissing a notification doesn't affect other users
 */
entity SecurityNotificationUserState : cuid, managed {
  notification  : Association to SecurityNotifications;
  email         : String(255);    // $user.id
  seenAt        : Timestamp;      // When user first saw the notification
  dismissedAt   : Timestamp;      // When user dismissed the notification
  snoozeUntil   : Timestamp;      // When snoozed notification should reappear
  pinned        : Boolean default false;  // Whether user pinned this notification
}

// Note: Unique constraint on (notification_ID, email) should be added via database migration
// This ensures one state record per notification per user