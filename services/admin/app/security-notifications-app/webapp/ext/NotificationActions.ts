import MessageToast from "sap/m/MessageToast";
import MessageBox from "sap/m/MessageBox";
import Context from "sap/ui/model/odata/v4/Context";
import ODataContextBinding from "sap/ui/model/odata/v4/ODataContextBinding";
import ExtensionAPI from "sap/fe/core/ExtensionAPI";
import ResourceBundle from "sap/base/i18n/ResourceBundle";
import Localization from "sap/base/i18n/Localization";

let bundlePromise: Promise<ResourceBundle> | undefined;

/** The app's i18n bundle, loaded once for the user's language. */
function getBundle(): Promise<ResourceBundle> {
  if (!bundlePromise) {
    bundlePromise = ResourceBundle.create({
      bundleName: "admin.securitynotifications.i18n.i18n",
      async: true,
      supportedLocales: ["", "de", "es", "fr", "it", "nl", "pt"],
      fallbackLocale: ""
    }) as Promise<ResourceBundle>;
  }
  return bundlePromise;
}

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
    let loaded: ResourceBundle | undefined;
    try {
      const bundle = loaded = await getBundle();
      const notificationId = oBindingContext?.getProperty("ID") as string | undefined;
      const dismissedAt = oBindingContext?.getProperty("dismissedAt") as string | null;
      const currentSnooze = oBindingContext?.getProperty("snoozeUntil") as string | null;

      if (!notificationId) {
        MessageToast.show(bundle.getText("notificationIdNotAvailable") as string);
        return;
      }

      if (dismissedAt) {
        MessageToast.show(bundle.getText("cannotSnoozeDismissed") as string);
        return;
      }

      if (currentSnooze) {
        MessageToast.show(bundle.getText("alreadySnoozed") as string);
        return;
      }

      // Calculate snooze until time (24 hours from now)
      const snoozeUntil = new Date();
      snoozeUntil.setHours(snoozeUntil.getHours() + 24);

      // Show confirmation with snooze duration
      MessageBox.confirm(bundle.getText("snoozeConfirmMsg", [snoozeUntil.toLocaleString(Localization.getLanguageTag().toString())]) as string, {
        title: bundle.getText("snoozeTitle") as string,
        onClose: async (sAction: string) => {
          if (sAction === MessageBox.Action.OK) {
            try {
              // Call the bound action on the current entity
              const boundAction = oBindingContext.getModel().bindContext("snoozeNotification(...)", oBindingContext) as ODataContextBinding;
              boundAction.setParameter("snoozeUntil", snoozeUntil.toISOString());
              
              await boundAction.execute();
              
              // Refresh the context to show updated data
              await oBindingContext.refresh();
              
              MessageToast.show(bundle.getText("snoozedFor24h") as string);
            } catch (error) {
              console.error("Failed to snooze notification:", error);
              MessageToast.show(bundle.getText("failedToSnooze") as string);
            }
          }
        }
      });
    } catch (error) {
      console.error("Failed to snooze notification:", error);
      MessageToast.show(loaded ? loaded.getText("failedToSnooze") as string : String(error));
    }
  },

  /**
   * Toggle pin status of notification (requires parameter input)
   */
  onTogglePin: async function (this: ExtensionAPI, oBindingContext: Context): Promise<void> {
    let loaded: ResourceBundle | undefined;
    try {
      const bundle = loaded = await getBundle();
      const notificationId = oBindingContext?.getProperty("ID") as string | undefined;
      const dismissedAt = oBindingContext?.getProperty("dismissedAt") as string | null;
      const currentPinned = oBindingContext?.getProperty("pinned") as boolean;

      if (!notificationId) {
        MessageToast.show(bundle.getText("notificationIdNotAvailable") as string);
        return;
      }

      if (dismissedAt) {
        MessageToast.show(bundle.getText("cannotPinDismissed") as string);
        return;
      }

      const newPinnedState = !currentPinned;
      const actionText = newPinnedState ? "pin" : "unpin";

      try {
        // Call the bound action on the current entity
        const boundAction = oBindingContext.getModel().bindContext("pinNotification(...)", oBindingContext) as ODataContextBinding;
        boundAction.setParameter("pinned", newPinnedState);
        
        await boundAction.execute();
        
        // Refresh the context to show updated data
        await oBindingContext.refresh();
        
        MessageToast.show((newPinnedState ? bundle.getText("notificationPinned") : bundle.getText("notificationUnpinned")) as string);
      } catch (error) {
        console.error(`Failed to ${actionText} notification:`, error);
        MessageToast.show((newPinnedState ? bundle.getText("failedToPin") : bundle.getText("failedToUnpin")) as string);
      }
    } catch (error) {
      console.error("Failed to toggle pin status:", error);
      MessageToast.show(loaded ? loaded.getText("failedToUpdatePin") as string : String(error));
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