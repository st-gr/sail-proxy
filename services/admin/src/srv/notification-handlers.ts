const cds = require('@sap/cds');
const { SELECT, DELETE, UPSERT, UPDATE, INSERT } = cds.ql;
import { getDefaultLogger } from '@libs/logger';
import { securityNotificationConfig } from '../config/security-notifications';
import { notificationStreamService } from './notification-stream';

const logger = getDefaultLogger();

interface NotificationRequest {
  data: {
    notificationID?: string;
    snoozeUntil?: string;
    pinned?: boolean;
  };
  user: {
    id: string;
  };
}

/**
 * Handler for marking notification as seen
 */
export async function markNotificationSeen(req: NotificationRequest) {
  logger.debug('NotificationHandlers', '[markNotificationSeen] Handler called', {
    params: (req as any).params,
    userData: req.data,
    user: req.user?.id
  });
  
  // Extract notification ID from bound action context
  const notificationID = (req as any).params?.[0] || req.data?.notificationID;
  const userEmail = req.user?.id;
  
  logger.debug('NotificationHandlers', '[markNotificationSeen] Extracted values', {
    notificationID,
    userEmail
  });
  
  if (!notificationID || !userEmail) {
    logger.warn('NotificationHandlers', '[markNotificationSeen] Missing required values');
    return {
      success: false,
      message: 'Notification ID and user context required'
    };
  }

  try {
    logger.debug('NotificationHandlers', '[markNotificationSeen] Processing user state update');
    
    // Check if record already exists
    const existing = await SELECT.one.from('sap.llm.gateway.admin.SecurityNotificationUserState')
      .where({ notification_ID: notificationID, email: userEmail });
    
    if (existing) {
      // Update existing record
      await UPDATE('sap.llm.gateway.admin.SecurityNotificationUserState')
        .set({
          seenAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString()
        })
        .where({ ID: existing.ID });
      logger.debug('NotificationHandlers', '[markNotificationSeen] Updated existing record:', existing.ID);
    } else {
      // Create new record
      await INSERT.into('sap.llm.gateway.admin.SecurityNotificationUserState').entries({
        ID: cds.utils.uuid(),
        notification_ID: notificationID,
        email: userEmail,
        seenAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        createdBy: userEmail
      });
      logger.debug('NotificationHandlers', '[markNotificationSeen] Created new record');
    }

    // Trigger real-time notification update for all admin users
    notificationStreamService.notifyAll('notification-state-changed', {
      action: 'marked_seen',
      notificationId: notificationID,
      userId: userEmail,
      timestamp: new Date().toISOString()
    });

    (req as any).notify('Notification marked as seen');
    return {
      success: true,
      message: 'Notification marked as seen'
    };
  } catch (error) {
    logger.error('NotificationHandlers', '[markNotificationSeen] Error:', error instanceof Error ? error : new Error(String(error)));
    return {
      success: false,
      message: 'Failed to mark notification as seen'
    };
  }
}

/**
 * Handler for marking notification as unseen (reverses seen status)
 */
export async function markNotificationUnseen(req: NotificationRequest) {
  logger.debug('NotificationHandlers', '[markNotificationUnseen] Handler called', {
    params: (req as any).params,
    userData: req.data,
    user: req.user?.id
  });
  
  // Extract notification ID from bound action context
  const notificationID = (req as any).params?.[0] || req.data?.notificationID;
  const userEmail = req.user?.id;
  
  logger.debug('NotificationHandlers', '[markNotificationUnseen] Extracted values', {
    notificationID,
    userEmail
  });
  
  if (!notificationID || !userEmail) {
    logger.warn('NotificationHandlers', '[markNotificationUnseen] Missing required values');
    return {
      success: false,
      message: 'Notification ID and user context required'
    };
  }

  try {
    logger.debug('NotificationHandlers', '[markNotificationUnseen] Processing user state update');
    
    // Check if record already exists
    const existing = await SELECT.one.from('sap.llm.gateway.admin.SecurityNotificationUserState')
      .where({ notification_ID: notificationID, email: userEmail });
    
    if (existing) {
      // Update existing record - clear seenAt, dismissedAt, and snoozeUntil to mark as unseen and active
      await UPDATE('sap.llm.gateway.admin.SecurityNotificationUserState')
        .set({
          seenAt: null,
          dismissedAt: null,
          snoozeUntil: null,
          modifiedAt: new Date().toISOString()
        })
        .where({ ID: existing.ID });
      logger.debug('NotificationHandlers', '[markNotificationUnseen] Updated existing record - cleared seenAt, dismissedAt, snoozeUntil:', existing.ID);
    } else {
      // Create new record with null values (unseen and active state)
      await INSERT.into('sap.llm.gateway.admin.SecurityNotificationUserState').entries({
        ID: cds.utils.uuid(),
        notification_ID: notificationID,
        email: userEmail,
        seenAt: null,
        dismissedAt: null,
        snoozeUntil: null,
        modifiedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        createdBy: userEmail
      });
      logger.debug('NotificationHandlers', '[markNotificationUnseen] Created new record with all null values');
    }

    // Trigger real-time notification update for all admin users
    notificationStreamService.notifyAll('notification-state-changed', {
      action: 'marked_unseen',
      notificationId: notificationID,
      userId: userEmail,
      timestamp: new Date().toISOString()
    });

    (req as any).notify('Notification marked as unseen');
    return {
      success: true,
      message: 'Notification marked as unseen'
    };
  } catch (error) {
    logger.error('NotificationHandlers', '[markNotificationUnseen] Error:', error instanceof Error ? error : new Error(String(error)));
    return {
      success: false,
      message: 'Failed to mark notification as unseen'
    };
  }
}

/**
 * Handler for dismissing notification
 */
export async function dismissNotification(req: NotificationRequest) {
  logger.debug('NotificationHandlers', '[dismissNotification] Handler called', {
    params: (req as any).params,
    userData: req.data,
    user: req.user?.id
  });
  
  // Extract notification ID from bound action context
  const notificationID = (req as any).params?.[0] || req.data?.notificationID;
  const userEmail = req.user?.id;
  
  logger.debug('NotificationHandlers', '[dismissNotification] Extracted values', {
    notificationID,
    userEmail
  });
  
  if (!notificationID || !userEmail) {
    return {
      success: false,
      message: 'Notification ID and user context required'
    };
  }

  try {
    // Check if record already exists
    const existing = await SELECT.one.from('sap.llm.gateway.admin.SecurityNotificationUserState')
      .where({ notification_ID: notificationID, email: userEmail });
    
    if (existing) {
      // Update existing record - clear snoozeUntil when dismissing (mutually exclusive states)
      await UPDATE('sap.llm.gateway.admin.SecurityNotificationUserState')
        .set({
          dismissedAt: new Date().toISOString(),
          snoozeUntil: null, // Clear snooze when dismissing
          seenAt: existing.seenAt || new Date().toISOString(), // Keep original seenAt or set now
          modifiedAt: new Date().toISOString()
        })
        .where({ ID: existing.ID });
      logger.debug('NotificationHandlers', '[dismissNotification] Updated existing record, cleared snoozeUntil, preserved seenAt:', existing.seenAt);
    } else {
      // Create new record with both timestamps
      await INSERT.into('sap.llm.gateway.admin.SecurityNotificationUserState').entries({
        ID: cds.utils.uuid(),
        notification_ID: notificationID,
        email: userEmail,
        dismissedAt: new Date().toISOString(),
        seenAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        createdBy: userEmail
      });
      logger.debug('NotificationHandlers', '[dismissNotification] Created new record with both timestamps');
    }

    // Trigger real-time notification update for all admin users
    notificationStreamService.notifyAll('notification-state-changed', {
      action: 'dismissed',
      notificationId: notificationID,
      userId: userEmail,
      timestamp: new Date().toISOString()
    });

    (req as any).notify('Notification dismissed');
    return {
      success: true,
      message: 'Notification dismissed'
    };
  } catch (error) {
    logger.error('NotificationHandlers', 'Error dismissing notification:', error instanceof Error ? error : new Error(String(error)));
    return {
      success: false,
      message: 'Failed to dismiss notification'
    };
  }
}

/**
 * Handler for snoozing notification
 */
export async function snoozeNotification(req: NotificationRequest) {
  logger.debug('NotificationHandlers', '[snoozeNotification] Handler called', {
    params: (req as any).params,
    userData: req.data,
    user: req.user?.id
  });
  
  // Extract notification ID from bound action context
  const notificationID = (req as any).params?.[0] || req.data?.notificationID;
  const { snoozeUntil } = req.data;
  const userEmail = req.user?.id;
  
  logger.debug('NotificationHandlers', '[snoozeNotification] Extracted values', {
    notificationID,
    userEmail,
    snoozeUntil
  });
  
  if (!notificationID || !userEmail || !snoozeUntil) {
    return {
      success: false,
      message: 'Notification ID, user context, and snooze time required'
    };
  }

  // Validate snooze time
  const snoozeDate = new Date(snoozeUntil);
  const now = new Date();
  const maxSnooze = new Date(now.getTime() + (securityNotificationConfig.maxSnoozeDays * 24 * 60 * 60 * 1000));
  
  if (snoozeDate <= now) {
    return (req as any).reject(400, 'Snooze time must be in the future', 'snoozeUntil');
  }
  
  if (snoozeDate > maxSnooze) {
    return (req as any).reject(400, `Snooze time cannot be more than ${securityNotificationConfig.maxSnoozeDays} days in the future`, 'snoozeUntil');
  }

  try {
    // Check if record already exists
    const existing = await SELECT.one.from('sap.llm.gateway.admin.SecurityNotificationUserState')
      .where({ notification_ID: notificationID, email: userEmail });
    
    if (existing) {
      // Update existing record - clear dismissedAt when snoozing
      await UPDATE('sap.llm.gateway.admin.SecurityNotificationUserState')
        .set({
          snoozeUntil: snoozeUntil,
          dismissedAt: null, // Clear dismissed when snoozing
          seenAt: existing.seenAt || new Date().toISOString(), // Keep original or set now
          modifiedAt: new Date().toISOString()
        })
        .where({ ID: existing.ID });
      logger.debug('NotificationHandlers', '[snoozeNotification] Updated existing record, cleared dismissedAt, preserved seenAt:', existing.seenAt);
    } else {
      // Create new record
      await INSERT.into('sap.llm.gateway.admin.SecurityNotificationUserState').entries({
        ID: cds.utils.uuid(),
        notification_ID: notificationID,
        email: userEmail,
        snoozeUntil: snoozeUntil,
        seenAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        createdBy: userEmail
      });
      logger.debug('NotificationHandlers', '[snoozeNotification] Created new record');
    }

    // Trigger real-time notification update for all admin users
    notificationStreamService.notifyAll('notification-state-changed', {
      action: 'snoozed',
      notificationId: notificationID,
      userId: userEmail,
      snoozeUntil,
      timestamp: new Date().toISOString()
    });

    (req as any).notify('Notification snoozed until ' + new Date(snoozeUntil).toLocaleString());
    return {
      success: true,
      message: 'Notification snoozed'
    };
  } catch (error) {
    logger.error('NotificationHandlers', 'Error snoozing notification:', error instanceof Error ? error : new Error(String(error)));
    return {
      success: false,
      message: 'Failed to snooze notification'
    };
  }
}

/**
 * Handler for pinning notification (parameter-less)
 */
export async function pinNotification(req: NotificationRequest) {
  logger.debug('NotificationHandlers', '[pinNotification] Handler called', {
    params: (req as any).params,
    userData: req.data,
    user: req.user?.id
  });
  
  // Extract notification ID from bound action context
  const notificationID = (req as any).params?.[0] || req.data?.notificationID;
  const userEmail = req.user?.id;
  
  logger.debug('NotificationHandlers', '[pinNotification] Extracted values', {
    notificationID,
    userEmail
  });
  
  if (!notificationID || !userEmail) {
    return {
      success: false,
      message: 'Notification ID and user context required'
    };
  }

  try {
    await upsertUserState(notificationID, userEmail, { 
      pinned: true,
      seenAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString()
    });

    // Trigger real-time notification update for all admin users
    notificationStreamService.notifyAll('notification-state-changed', {
      action: 'pinned',
      notificationId: notificationID,
      userId: userEmail,
      timestamp: new Date().toISOString()
    });

    (req as any).notify('Notification pinned');
    return {
      success: true,
      message: 'Notification pinned'
    };
  } catch (error) {
    logger.error('NotificationHandlers', '[pinNotification] Error:', error instanceof Error ? error : new Error(String(error)));
    return {
      success: false,
      message: 'Failed to pin notification'
    };
  }
}

/**
 * Handler for unpinning notification (parameter-less)
 */
export async function unpinNotification(req: NotificationRequest) {
  logger.debug('NotificationHandlers', '[unpinNotification] Handler called', {
    params: (req as any).params,
    userData: req.data,
    user: req.user?.id
  });
  
  // Extract notification ID from bound action context
  const notificationID = (req as any).params?.[0] || req.data?.notificationID;
  const userEmail = req.user?.id;
  
  logger.debug('NotificationHandlers', '[unpinNotification] Extracted values', {
    notificationID,
    userEmail
  });
  
  if (!notificationID || !userEmail) {
    return {
      success: false,
      message: 'Notification ID and user context required'
    };
  }

  try {
    await upsertUserState(notificationID, userEmail, { 
      pinned: false,
      seenAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString() 
    });

    // Trigger real-time notification update for all admin users
    notificationStreamService.notifyAll('notification-state-changed', {
      action: 'unpinned',
      notificationId: notificationID,
      userId: userEmail,
      timestamp: new Date().toISOString()
    });

    (req as any).notify('Notification unpinned');
    return {
      success: true,
      message: 'Notification unpinned'
    };
  } catch (error) {
    logger.error('NotificationHandlers', '[unpinNotification] Error:', error instanceof Error ? error : new Error(String(error)));
    return {
      success: false,
      message: 'Failed to unpin notification'
    };
  }
}

/**
 * Helper function to upsert user state (SQLite-friendly)
 */
async function upsertUserState(notificationID: string, userEmail: string, patch: any) {
  const existing = await SELECT.one.from('sap.llm.gateway.admin.SecurityNotificationUserState')
    .where({ notification_ID: notificationID, email: userEmail });
  
  if (existing) {
    // Update existing record - preserve original timestamps where appropriate
    await UPDATE('sap.llm.gateway.admin.SecurityNotificationUserState')
      .set({
        ...patch,
        seenAt: existing.seenAt || patch.seenAt // Keep original seenAt if it exists
      })
      .where({ ID: existing.ID });
    logger.debug('NotificationHandlers', `[upsertUserState] Updated existing record: ${existing.ID}`);
  } else {
    // Create new record
    await INSERT.into('sap.llm.gateway.admin.SecurityNotificationUserState').entries({
      ID: cds.utils.uuid(),
      notification_ID: notificationID,
      email: userEmail,
      ...patch,
      createdAt: new Date().toISOString(),
      createdBy: userEmail
    });
    logger.debug('NotificationHandlers', '[upsertUserState] Created new record');
  }
}

/**
 * Handler for deleting security notifications (admin only, configurable minimum age)
 */
export async function deleteSecurityNotification(req: NotificationRequest) {
  logger.debug('NotificationHandlers', '[deleteSecurityNotification] Handler called', {
    params: (req as any).params,
    userData: req.data,
    user: req.user?.id
  });
  
  // Extract notification ID from bound action context
  const notificationID = (req as any).params?.[0] || req.data?.notificationID;
  
  logger.debug('NotificationHandlers', '[deleteSecurityNotification] Extracted notificationID:', notificationID);
  
  if (!notificationID) {
    logger.debug('NotificationHandlers', '[deleteSecurityNotification] Missing notification ID');
    return {
      success: false,
      message: 'Notification ID is required'
    };
  }

  try {
    const tx = cds.transaction(req);
    
    // Get the notification to check its age and source info
    const notification = await tx.run(SELECT.one.from('sap.llm.gateway.admin.SecurityNotifications')
      .where({ ID: notificationID }));
    
    if (!notification) {
      return (req as any).reject(404, 'Notification not found');
    }

    // Check if notification is at least the configured minimum age
    const minAgeDate = new Date();
    minAgeDate.setDate(minAgeDate.getDate() - securityNotificationConfig.minDeleteAgeDays);
    
    const notificationDate = new Date(notification.createdAt);
    if (notificationDate > minAgeDate) {
      return (req as any).reject(400, `Can only delete notifications older than ${securityNotificationConfig.minDeleteAgeDays} days`);
    }

    // 1) Delete per-user state records
    await tx.run(DELETE.from('sap.llm.gateway.admin.SecurityNotificationUserState')
      .where({ notification_ID: notificationID }));

    // 2) Delete source record based on sourceEntity
    if (notification.sourceEntity === 'ApiKeySecurityEvents') {
      await tx.run(DELETE.from('sap.llm.gateway.admin.ApiKeySecurityEvents')
        .where({ ID: notification.sourceID }));
    } else if (notification.sourceEntity === 'AwsCredentialSecurityEvents') {
      await tx.run(DELETE.from('sap.llm.gateway.admin.AwsCredentialSecurityEvents')
        .where({ ID: notification.sourceID }));
    } else if (notification.sourceEntity === 'AwsCredentialRotations') {
      await tx.run(DELETE.from('sap.llm.gateway.admin.AwsCredentialRotations')
        .where({ ID: notification.sourceID }));
    }

    // 3) Delete the notification itself
    await tx.run(DELETE.from('sap.llm.gateway.admin.SecurityNotifications')
      .where({ ID: notificationID }));

    // Success message will be shown by frontend after navigation
    
    // Return empty object to avoid navigation issues
    return {};

  } catch (error) {
    logger.error('NotificationHandlers', 'Error deleting security notification:', error instanceof Error ? error : new Error(String(error)));
    return {
      success: false,
      message: 'An error occurred while deleting the notification'
    };
  }
}