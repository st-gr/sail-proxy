import ControllerExtension from "sap/ui/core/mvc/ControllerExtension";
import Log from "sap/base/Log";
import type Context from "sap/ui/model/odata/v4/Context";
import MessageToast from "sap/m/MessageToast";
import ResourceBundle from "sap/base/i18n/ResourceBundle";
import type PageController from "sap/fe/core/PageController";
import NotificationActions from "../NotificationActions";

// Top-level log to confirm module loading
Log.info("[NotificationActions] Controller extension module loaded");

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

/** The List Report's route in manifest.json. */
const LIST_ROUTE = "MySecurityNotificationsList";

/** FE names the annotated delete action with its service prefix ("AdminService.deleteSecurityNotification"). */
function isDeleteAction(actionName: string): boolean {
	return actionName.split(".").pop() === "deleteSecurityNotification";
}

/** A caught value as a Log detail: Errors keep their stack, anything else becomes text. */
function logDetail(error: unknown): string | Error {
	return error instanceof Error ? error : String(error);
}

/**
 * Shows the "deleted successfully" toast from the bundle (fire-and-forget). It is shown while the
 * app navigates to the List Report, so it must not close on that hash change.
 */
function showDeletedToast(): void {
	getBundle().then((bundle) => {
		MessageToast.show(bundle.getText("deletedSuccessfully") as string, { closeOnBrowserNavigation: false });
	}).catch(() => { /* bundle load failure is non-critical for a toast */ });
}

/**
 * Controller extension for Security Notifications ObjectPage
 * Handles auto-marking, navigation after delete actions, and manual refresh fallbacks
 */
export default ControllerExtension.extend("admin.securitynotifications.ext.controller.NotificationActions", {
	// Must be "override", not "overrides" for FE V4
	override: {
		// Hook group corresponds to sap.fe.core.controllerextensions.Routing
		routing: {
			/**
			 * Called after route binding is complete
			 * Auto-mark notification as seen when ObjectPage is opened
			 */
			onAfterBinding(this: any, ctx?: Context) {
				Log.info("[NotificationActions] routing.onAfterBinding called with context:", String(!!ctx));
				
				// Check if context is invalid (entity was deleted) and navigate back
				if (!ctx) {
					Log.info("[NotificationActions] No context after binding - entity may have been deleted, navigating back");
					setTimeout(() => {
						if (window.history?.length > 1) {
							window.history.back();
						} else {
							window.location.href = "/shell/index.html#security-notifications";
						}
					}, 500);
					return;
				}
				
				// Auto-mark notification as seen
				Log.info("[NotificationActions] Calling auto-mark with context ID:", ctx.getProperty?.("ID"));
				NotificationActions.onAfterBinding.call(this, ctx).catch((error: any) => {
					Log.error("[NotificationActions] Failed to auto-mark as seen:", error);
				});

				// Trigger resize tick for layout consistency (from AWS credentials pattern)
				setTimeout(() => {
					window.dispatchEvent(new Event("resize"));
					Log.info("[NotificationActions] Layout resize tick sent");
				}, 0);
			},

			/**
			 * Alternative hook - called when navigating to object page  
			 */
			onAfterRouteMatched(this: any, oEvent?: any) {
				Log.info("[NotificationActions] routing.onAfterRouteMatched called");
				
				// Try to get context from the view
				const oView = this.getView?.();
				const oContext = oView?.getBindingContext?.();
				
				if (oContext) {
					Log.info("[NotificationActions] Found context in onAfterRouteMatched, calling auto-mark");
					NotificationActions.onAfterBinding.call(this, oContext).catch((error: any) => {
						Log.error("[NotificationActions] Failed to auto-mark in onAfterRouteMatched:", error);
					});
				} else {
					Log.warning("[NotificationActions] No context found in onAfterRouteMatched");
				}
			}
		},

		// Page ready hook for additional initialization if needed
		onPageReady(this: any) {
			Log.info("[NotificationActions] onPageReady called");
			
			// Also try auto-mark here as a fallback
			const oView = this.getView?.();
			const oContext = oView?.getBindingContext?.();
			
			if (oContext) {
				Log.info("[NotificationActions] Found context in onPageReady, calling auto-mark as fallback");
				NotificationActions.onAfterBinding.call(this, oContext).catch((error: any) => {
					Log.error("[NotificationActions] Failed to auto-mark in onPageReady:", error);
				});
			}
		},
		
		// Hook group corresponds to sap.fe.core.controllerextensions.EditFlow
		editFlow: {
			/**
			 * FE calls this only after an action succeeded; a failed action rejects before it and FE
			 * shows the error, so the page stays. After a successful delete the page's entity is gone,
			 * so go back to the List Report (FE marked it dirty, it re-reads without the row).
			 */
			onAfterActionExecution(this: { base: PageController }, actionName: string) {
				if (!isDeleteAction(actionName)) {
					return;
				}
				Log.info("[NotificationActions] Delete succeeded - navigating to the List Report");
				showDeletedToast();
				this.base.getExtensionAPI().getRouting().navigateToRoute(LIST_ROUTE)
					.catch((error: unknown) => {
						Log.error("[NotificationActions] Navigation after delete failed:", logDetail(error));
					});
			}
		}
	},

	// Export action handlers for use in manifest.json (only complex actions that need parameters)
	onSnooze: NotificationActions.onSnooze,
	onTogglePin: NotificationActions.onTogglePin,
});