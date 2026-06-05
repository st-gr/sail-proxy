import MessageToast from "sap/m/MessageToast";
import MessageBox from "sap/m/MessageBox";
import Context from "sap/ui/model/odata/v4/Context";
import ExtensionAPI from "sap/fe/core/ExtensionAPI";

/**
 * Custom action handlers for Security Notifications management
 * Note: Simple actions (Mark as Seen, Dismiss) are now handled by bound actions via UI.Identification
 * This file only contains handlers for actions that need parameters or special UI logic
 */
export default {
  /**
   * Snooze notification (requires parameter input)
   */
  onSnooze: async function (this: ExtensionAPI, oBindingContext: Context): Promise<void> {
    try {
      const notificationId = oBindingContext?.getProperty("ID") as string | undefined;
      const dismissedAt = oBindingContext?.getProperty("dismissedAt") as string | null;
      const currentSnooze = oBindingContext?.getProperty("snoozeUntil") as string | null;
      
      if (!notificationId) {
        MessageToast.show("Notification ID not available.");
        return;
      }

      if (dismissedAt) {
        MessageToast.show("Cannot snooze a dismissed notification.");
        return;
      }

      if (currentSnooze) {
        MessageToast.show("Notification is already snoozed.");
        return;
      }

      // Calculate snooze until time (24 hours from now)
      const snoozeUntil = new Date();
      snoozeUntil.setHours(snoozeUntil.getHours() + 24);

      // Show confirmation with snooze duration
      MessageBox.confirm(`Snooze this notification until ${snoozeUntil.toLocaleString()}?`, {
        title: "Snooze Notification",
        onClose: async (sAction: string) => {
          if (sAction === MessageBox.Action.OK) {
            try {
              // Call the bound action on the current entity
              const boundAction = oBindingContext.getModel().bindContext("snoozeNotification(...)", oBindingContext);
              boundAction.setParameter("snoozeUntil", snoozeUntil.toISOString());
              
              await boundAction.execute();
              
              // Refresh the context to show updated data
              await oBindingContext.refresh();
              
              MessageToast.show("Notification snoozed for 24 hours.");
            } catch (error) {
              console.error("Failed to snooze notification:", error);
              MessageToast.show("Failed to snooze notification. Please try again.");
            }
          }
        }
      });
    } catch (error) {
      console.error("Failed to snooze notification:", error);
      MessageToast.show("Failed to snooze notification. Please try again.");
    }
  },

  /**
   * Toggle pin status of notification (requires parameter input)
   */
  onTogglePin: async function (this: ExtensionAPI, oBindingContext: Context): Promise<void> {
    try {
      const notificationId = oBindingContext?.getProperty("ID") as string | undefined;
      const dismissedAt = oBindingContext?.getProperty("dismissedAt") as string | null;
      const currentPinned = oBindingContext?.getProperty("pinned") as boolean;
      
      if (!notificationId) {
        MessageToast.show("Notification ID not available.");
        return;
      }

      if (dismissedAt) {
        MessageToast.show("Cannot pin/unpin a dismissed notification.");
        return;
      }

      const newPinnedState = !currentPinned;
      const actionText = newPinnedState ? "pin" : "unpin";

      try {
        // Call the bound action on the current entity
        const boundAction = oBindingContext.getModel().bindContext("pinNotification(...)", oBindingContext);
        boundAction.setParameter("pinned", newPinnedState);
        
        await boundAction.execute();
        
        // Refresh the context to show updated data
        await oBindingContext.refresh();
        
        MessageToast.show(`Notification ${actionText}ned successfully.`);
      } catch (error) {
        console.error(`Failed to ${actionText} notification:`, error);
        MessageToast.show(`Failed to ${actionText} notification. Please try again.`);
      }
    } catch (error) {
      console.error("Failed to toggle pin status:", error);
      MessageToast.show("Failed to update pin status. Please try again.");
    }
  },

  /**
   * Delete security notification (admin only, configurable minimum age)
   */
  onDelete: async function (this: ExtensionAPI, oBindingContext: Context): Promise<void> {
    try {
      const notificationId = oBindingContext?.getProperty("ID") as string | undefined;
      const title = oBindingContext?.getProperty("title") as string | undefined;
      const createdAt = oBindingContext?.getProperty("createdAt") as string | undefined;
      
      if (!notificationId) {
        MessageToast.show("Notification ID not available.");
        return;
      }

      // Calculate age in days
      const created = new Date(createdAt || '');
      const now = new Date();
      const ageInDays = Math.floor((now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24));

      // Note: Age validation is also performed on the backend with configurable limits
      // This frontend check uses the default 30-day limit for immediate user feedback
      if (ageInDays < 30) {
        MessageBox.error(`Cannot delete notifications younger than 30 days. This notification is ${ageInDays} days old.`, {
          title: "Delete Not Allowed"
        });
        return;
      }

      // Show confirmation dialog
      MessageBox.confirm(`Are you sure you want to permanently delete this security notification?\n\n"${title}"\n\nThis action cannot be undone and will also delete the source security event.`, {
        title: "Delete Security Notification",
        onClose: async (sAction: string) => {
          if (sAction === MessageBox.Action.OK) {
            try {
              // Call the bound action on the current entity
              const boundAction = oBindingContext.getModel().bindContext("deleteSecurityNotification(...)", oBindingContext);
              
              await boundAction.execute();
              
              // Navigate back to List Report after successful delete
              // Use window.history.back() as a reliable fallback
              MessageToast.show("Security notification deleted successfully");
              
              // Navigate back with a slight delay to ensure the success message is processed
              setTimeout(() => {
                if (window.history?.length > 1) {
                  window.history.back();
                } else {
                  // Navigate to shell root as final fallback
                  window.location.href = "/shell/index.html#security-notifications";
                }
              }, 500);
              
            } catch (error) {
              console.error("Failed to delete notification:", error);
              MessageToast.show("Failed to delete notification. Please try again.");
            }
          }
        }
      });
    } catch (error) {
      console.error("Failed to delete notification:", error);
      MessageToast.show("Failed to delete notification. Please try again.");
    }
  },

  /**
   * Auto-mark notification as seen when object page is opened
   * This function is called automatically by the ObjectPage controller extension
   */
  onAfterBinding: async function (this: any, bindingContext?: Context): Promise<void> {
    console.log("[NotificationActions.onAfterBinding] Starting auto-mark process");
    try {
      // Use passed context or get from extension API
      const ctx = bindingContext || this.getBindingContext?.();
      if (!ctx) {
        console.log("[NotificationActions.onAfterBinding] No binding context available for auto-mark as seen");
        return;
      }

      const seenAt = ctx.getProperty("seenAt") as string | null;
      const notificationId = ctx.getProperty("ID") as string | undefined;

      console.log("[NotificationActions.onAfterBinding] Auto-mark check:", { 
        notificationId, 
        seenAt: seenAt,
        hasSeenAt: !!seenAt,
        contextPath: ctx.getPath?.()
      });

      // Auto-mark as seen if not already seen
      if (!seenAt && notificationId) {
        console.log("[NotificationActions.onAfterBinding] Executing auto-mark for notification:", notificationId);
        try {
          // Call the bound action on the current entity
          const boundAction = ctx.getModel().bindContext("AdminService.markNotificationSeen(...)", ctx);
          console.log("[NotificationActions.onAfterBinding] Created bound action, executing...");
          
          await boundAction.execute();
          
          console.log("[NotificationActions.onAfterBinding] Notification auto-marked as seen:", notificationId);
          
          // Refresh the context to show updated data immediately
          console.log("[NotificationActions.onAfterBinding] Refreshing context...");
          await ctx.refresh();
          console.log("[NotificationActions.onAfterBinding] Context refreshed successfully");
          
        } catch (error) {
          // Silent fail for auto-marking - not critical if it fails
          console.warn("[NotificationActions.onAfterBinding] Failed to auto-mark notification as seen:", error);
        }
      } else if (seenAt) {
        console.log("[NotificationActions.onAfterBinding] Notification already seen, skipping auto-mark:", notificationId);
      } else {
        console.log("[NotificationActions.onAfterBinding] Missing notification ID, cannot auto-mark");
      }
    } catch (error) {
      console.warn("[NotificationActions.onAfterBinding] Failed to auto-mark notification as seen:", error);
    }
  }
};