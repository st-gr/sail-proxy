import ControllerExtension from "sap/ui/core/mvc/ControllerExtension";
import Log from "sap/base/Log";
import type Context from "sap/ui/model/odata/v4/Context";
import MessageToast from "sap/m/MessageToast";
import NotificationActions from "../NotificationActions";

// Top-level log to confirm module loading
Log.info("[NotificationActions] Controller extension module loaded");

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
				Log.info("[NotificationActions] routing.onAfterBinding called with context:", !!ctx);
				
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
		
		// Monitor for successful delete operations by watching for side effects errors
		onAfterRendering: function(this: any) {
			Log.info("[NotificationActions] onAfterRendering called - setting up delete navigation monitor");
			
			// Set up error monitoring for side effects failures after delete
			if (!this._deleteNavigationSetup) {
				this._deleteNavigationSetup = true;
				this._setupDeleteErrorNavigation();
			}
		}
	},

	// Export action handlers for use in manifest.json (only complex actions that need parameters)
	onSnooze: NotificationActions.onSnooze,
	onTogglePin: NotificationActions.onTogglePin,
	onDelete: NotificationActions.onDelete,
	
	/**
	 * Set up monitoring for side effects errors that indicate successful delete
	 */
	_setupDeleteErrorNavigation: function(this: any) {
		Log.info("[NotificationActions] Setting up delete error navigation monitor");
		
		// Track failed read path count to detect entity deletion
		let failedReadCount = 0;
		let lastFailedReadTime = 0;
		let deleteActionFailed = false;
		let navigationTriggered = false;
		
		// Monitor console errors for side effects failures
		const originalConsoleError = console.error;
		console.error = function(...args: any[]) {
			const errorMessage = args.join(' ');
			
			// Check if the delete action itself failed (before side effects)
			if (errorMessage.includes('Failed to invoke') && 
			    errorMessage.includes('deleteSecurityNotification') &&
			    (errorMessage.includes('400') || errorMessage.includes('Bad Request'))) {
				Log.info("[NotificationActions] Delete action failed - will not navigate");
				deleteActionFailed = true;
				// Reset after 5 seconds
				setTimeout(() => { 
					deleteActionFailed = false;
					navigationTriggered = false; // Also reset navigation flag
				}, 5000);
			}
			
			// Count "Failed to read path" errors - multiple in quick succession indicate deletion
			// BUT only if the delete action didn't fail and navigation hasn't been triggered yet
			if (errorMessage.includes('Failed to read path') && 
			    errorMessage.includes('/MySecurityNotifications(') &&
			    !deleteActionFailed &&
			    !navigationTriggered) {
				const currentTime = Date.now();
				
				// Reset counter if too much time has passed
				if (currentTime - lastFailedReadTime > 5000) {
					failedReadCount = 0;
				}
				
				failedReadCount++;
				lastFailedReadTime = currentTime;
				
				// If we get 5+ failed reads in quick succession, entity was likely deleted
				if (failedReadCount >= 5) {
					Log.info("[NotificationActions] Multiple failed reads detected - entity deleted, navigating to List Report");
					navigationTriggered = true; // Prevent duplicate navigation
					
					setTimeout(() => {
						// Use hash navigation since shell component isn't accessible
						Log.info("[NotificationActions] Using hash navigation to List Report");
						window.location.hash = "#";
						
						// Show success toast after navigation
						setTimeout(() => {
							MessageToast.show("Security notification deleted successfully");
						}, 500);
					}, 1000);
				}
			}
			
			// Check if this is a side effects error after SUCCESSFUL delete (not validation error)
			if (errorMessage.toLowerCase().includes('error while requesting side effects') && 
			    errorMessage.toLowerCase().includes('deleteSecurityNotification') &&
			    errorMessage.toLowerCase().includes('not found') &&
			    !errorMessage.toLowerCase().includes('can only delete') &&
			    !errorMessage.toLowerCase().includes('validation') &&
			    !errorMessage.toLowerCase().includes('bad request') &&
			    !navigationTriggered) {
				
				Log.info("[NotificationActions] Delete side effects error detected - entity was successfully deleted");
				navigationTriggered = true; // Prevent duplicate navigation
				
				// Navigate back after a brief delay to allow error handling to complete
				setTimeout(() => {
					Log.info("[NotificationActions] BRANCH: Using hash navigation to List Report");
					window.location.hash = "#";
					
					// Show success toast after navigation
					setTimeout(() => {
						MessageToast.show("Security notification deleted successfully");
					}, 500);
				}, 1000);
			}
			
			// Call original console.error
			originalConsoleError.apply(console, args);
		};
		
		// Also monitor Log.error for UI5 errors
		const originalLogError = Log.error;
		Log.error = function(sMessage: string, sDetails?: any, sComponent?: string, fnSupportInfo?: any) {
			// First call original Log.error to ensure normal logging
			originalLogError.call(Log, sMessage, sDetails, sComponent, fnSupportInfo);
			
			if (sMessage && sMessage.includes('Error while requesting side effects for the operation AdminService.deleteSecurityNotification') && !navigationTriggered) {
				Log.info("[NotificationActions] UI5 side effects error detected - navigating after delete");
				navigationTriggered = true; // Prevent duplicate navigation
				
				setTimeout(() => {
					Log.info("[NotificationActions] BRANCH: Using hash navigation to List Report");
					window.location.hash = "#";
					
					// Show success toast after navigation
					setTimeout(() => {
						MessageToast.show("Security notification deleted successfully");
					}, 500);
				}, 1000);
			}
		};
		
		// Also try monitoring the UI5 log messages more broadly
		const originalLogMessage = Log._log;
		if (originalLogMessage) {
			Log._log = function(iLevel: any, sMessage: string, sDetails?: any, sComponent?: string, fnSupportInfo?: any) {
				// Check for side effects errors
				if (sMessage && sMessage.includes('Error while requesting side effects') && 
				    sMessage.includes('deleteSecurityNotification') && !navigationTriggered) {
					Log.info("[NotificationActions] Internal UI5 side effects error detected - navigating after delete");
					navigationTriggered = true; // Prevent duplicate navigation
					
					setTimeout(() => {
						Log.info("[NotificationActions] BRANCH: Using hash navigation to List Report");
						window.location.hash = "#";
						
						// Show success toast after navigation
						setTimeout(() => {
							MessageToast.show("Security notification deleted successfully");
						}, 500);
					}, 1000);
				}
				
				// Call original _log method
				return originalLogMessage.call(Log, iLevel, sMessage, sDetails, sComponent, fnSupportInfo);
			};
		}
	},

	/**
	 * Called after any bound action completes - check if it's a delete and navigate
	 */
	async onAfterAction(this: any, actionName: string): Promise<void> {
		if (actionName === 'deleteSecurityNotification') {
			await this.onAfterDeleteActionSuccess();
		}
	},

	/**
	 * Called after delete action succeeds - navigate back to List Report
	 * Uses fallback navigation since FE's routing API may not work after entity deletion
	 */
	async onAfterDeleteActionSuccess(this: any): Promise<void> {
		try {
			Log.info("[NotificationActions] Delete action succeeded, navigating to List Report");
			
			// Success message is now shown via req.notify() from backend
			
			// Use fallback navigation since the entity is deleted
			setTimeout(() => {
				if (window.history?.length > 1) {
					window.history.back();
				} else {
					// Navigate to shell security notifications as final fallback
					window.location.href = "/shell/index.html#security-notifications";
				}
			}, 1000); // Give time for success message to show
			
		} catch (error) {
			Log.error("[NotificationActions] Error navigating after delete:", error);
			// Immediate fallback navigation
			if (window.history?.length > 1) {
				window.history.back();
			} else {
				window.location.href = "/shell/index.html";
			}
		}
	},

	/**
	 * Manual refresh fallback when side effects annotations don't work
	 * Can be called from action handlers or error scenarios
	 */
	async refreshObjectPageContent(this: any): Promise<void> {
		try {
			const context = this.base.getView()?.getBindingContext() as Context;
			if (!context) {
				Log.warning("[NotificationActions] No binding context available for refresh");
				return;
			}

			// Refresh the entire entity instance using Context API
			await context.requestSideEffects([
				{ $NavigationPropertyPath: "" }
			]);

			Log.info("[NotificationActions] Object Page content refreshed manually");
		} catch (error) {
			Log.error("[NotificationActions] Error refreshing Object Page content:", error);
		}
	},

	/**
	 * Refresh specific properties after an action
	 * Useful when automatic side effects fail
	 */
	async refreshSpecificProperties(this: any, properties: string[]): Promise<void> {
		try {
			const context = this.base.getView()?.getBindingContext() as Context;
			if (!context) {
				Log.warning("[NotificationActions] No binding context available for property refresh");
				return;
			}

			// Convert property names to $PropertyPath format
			const propertyPaths = properties.map(prop => ({ $PropertyPath: prop }));
			
			await context.requestSideEffects(propertyPaths);
			
			Log.info(`[NotificationActions] Properties refreshed: ${properties.join(", ")}`);
		} catch (error) {
			Log.error("[NotificationActions] Error refreshing specific properties:", error);
		}
	},

	/**
	 * Fallback refresh handlers for each action type
	 * Called if side effects annotations don't work reliably
	 */
	async onAfterSnoozeActionSuccess(this: any): Promise<void> {
		await this.refreshSpecificProperties(['snoozeUntil', 'dismissedAt', 'seenAt', 'modifiedAt']);
	},

	async onAfterDismissActionSuccess(this: any): Promise<void> {
		await this.refreshSpecificProperties(['dismissedAt', 'seenAt', 'modifiedAt']);
	},

	async onAfterPinActionSuccess(this: any): Promise<void> {
		await this.refreshSpecificProperties(['pinned', 'seenAt', 'modifiedAt']);
	},

	async onAfterMarkSeenActionSuccess(this: any): Promise<void> {
		await this.refreshSpecificProperties(['seenAt', 'modifiedAt']);
	},

	/**
	 * Generic error handler for action failures
	 * Keeps user on Object Page and ensures consistent state
	 */
	onActionError(this: any, error: any): void {
		Log.error("[NotificationActions] Action failed:", error);
		
		// Error dialog should already be shown by FE via req.reject()
		// Just log for debugging - don't navigate away on errors
		
		// Optionally refresh to ensure consistent state
		this.refreshObjectPageContent().catch((refreshError: any) => {
			Log.error("[NotificationActions] Failed to refresh after error:", refreshError);
		});
	},

	/**
	 * Update app state before navigating away (for keep-alive scenarios)  
	 */
	async updateAppStateBeforeNavigation(this: any): Promise<void> {
		try {
			const extensionAPI = this.base.getExtensionAPI();
			await extensionAPI.updateAppState();
			Log.info("[NotificationActions] App state updated before navigation");
		} catch (error) {
			Log.warning("[NotificationActions] Failed to update app state before navigation:", error);
			// Don't block navigation if app state update fails
		}
	},

	/**
	 * Enhanced navigation back to List Report with state management
	 */
	async navigateToListReport(this: any): Promise<void> {
		// Update app state for keep-alive scenarios
		await this.updateAppStateBeforeNavigation();
		
		// Navigate using enhanced delete success handler
		await this.onAfterDeleteActionSuccess();
	}
});