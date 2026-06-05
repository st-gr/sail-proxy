/* eslint-disable @typescript-eslint/no-unsafe-call */
import BaseController from "admin/shell/controller/BaseController";
import JSONModel from "sap/ui/model/json/JSONModel";
import ODataModel from "sap/ui/model/odata/v4/ODataModel";
import Filter from "sap/ui/model/Filter";
import FilterOperator from "sap/ui/model/FilterOperator";
import MessageToast from "sap/m/MessageToast";
import Log from "sap/base/Log";
import Event from "sap/ui/base/Event";

// UI5 Web Components - Now using SAPUI5 wrapper types
// No imports needed as components are loaded via manifest.json dependencies

interface SecurityNotification {
	ID: string;
	title: string;
	message: string;
	severity: "low" | "medium" | "high" | "critical";
	eventType: string;
	eventDate: string;
	icon: string;
	actionable: boolean;
	actionText: string;
	actionUrl: string;
	seenAt?: string | null;
	dismissedAt?: string | null;
	snoozeUntil?: string | null;
	pinned?: boolean;
}

/**
 * @namespace admin.shell.controller
 */
export default class Notifications extends BaseController {
	private _refreshInterval?: number;
	private _notificationsModel?: JSONModel;

	public onInit(): void {
		this._initializeNotificationsModel();
		this._loadSecurityNotifications();
		
		// Reduced auto-refresh to 5 minutes (fallback only, SSE provides real-time updates)
		this._refreshInterval = window.setInterval(() => {
			this._loadSecurityNotifications();
		}, 300000); // 5 minutes instead of 30 seconds
	}

	public onAfterRendering(): void {
		// Set up rendering when model changes
		const model = this.getModel("notifications") as JSONModel;
		if (model) {
			// Listen for any property changes in the model
			model.attachPropertyChange(this._renderWCNotifications, this);
			// Also listen for data changes specifically  
			model.attachEvent("dataLoaded", this._renderWCNotifications, this);
		}
		
		// Initial render after view is ready
		setTimeout(() => {
			this._renderWCNotifications();
		}, 100);
	}

	public onExit(): void {
		if (this._refreshInterval) {
			clearInterval(this._refreshInterval);
		}
	}

	/**
	 * Initialize the notifications JSON model
	 */
	private _initializeNotificationsModel(): void {
		this._notificationsModel = new JSONModel({
			notifications: [],
			loading: false,
			error: null
		});
		// Set size limit for larger notification lists
		this._notificationsModel.setSizeLimit(1000);
		this.setModel(this._notificationsModel, "notifications");
	}


	/**
	 * Wait for the OData model to be available
	 */
	private async _waitForModel(): Promise<void> {
		return new Promise((resolve) => {
			const checkModel = () => {
				const oModel = this.getModel();
				if (oModel && oModel.getMetadata && oModel.getMetadata()) {
					resolve();
				} else {
					setTimeout(checkModel, 100);
				}
			};
			checkModel();
		});
	}

	/**
	 * Load security notifications from OData service
	 */
	private async _loadSecurityNotifications(): Promise<void> {
		// Wait for the component to fully initialize and model to be available
		await this._waitForModel();
		
		const oModel = this.getModel() as ODataModel;
		if (!oModel) {
			Log.error("OData model not found", "", "Notifications.controller");
			return;
		}

		this._notificationsModel?.setProperty("/loading", true);
		this._notificationsModel?.setProperty("/error", null);

		try {
			// Create filters for high and medium severity, unseen notifications
			const aFilters = [
				// Severity filter (high OR medium)
				new Filter({
					filters: [
						new Filter("severity", FilterOperator.EQ, "high"),
						new Filter("severity", FilterOperator.EQ, "medium")
					],
					and: false
				}),
				// Unseen filter using virtual field (server-side filtering)
				new Filter("isSeen", FilterOperator.EQ, false)
			];

			// Create list binding
			const oBinding = oModel.bindList("/MySecurityNotifications", undefined, undefined, aFilters);
			
			// Request data
			const aContexts = await oBinding.requestContexts();
			const aNotifications = aContexts.map(context => context.getObject() as SecurityNotification);

			// Debug: Log notifications received from backend
			Log.info(`Backend returned ${aNotifications.length} notifications (server-side filtered)`, 
				JSON.stringify(aNotifications.slice(0, 2).map(n => ({ 
					ID: n.ID, 
					title: n.title?.substring(0, 30), 
					severity: n.severity,
					seenAt: n.seenAt 
				}))), 
				"Notifications.controller");

			// Transform notifications for UI consumption
			// No client-side filtering needed - server handles all filtering
			const aTransformedNotifications = aNotifications.map(notification => 
				this._transformNotification(notification)
			);

			// Update model
			this._notificationsModel?.setProperty("/notifications", aTransformedNotifications);
			
			// Debug: Log the final data being set
			Log.info(`Using server-filtered ${aTransformedNotifications.length} notifications`, 
				JSON.stringify(aTransformedNotifications.slice(0, 1).map(n => ({ ID: n.ID, title: n.title?.substring(0, 30) }))), 
				"Notifications.controller");
			
			// Update notification count in shell bar
			this._updateNotificationCount(aTransformedNotifications.length);
			
			// Explicitly trigger rendering since array property changes don't always fire events
			this._renderWCNotifications();

		} catch (error) {
			Log.error("Failed to load security notifications", error as string, "Notifications.controller");
			this._notificationsModel?.setProperty("/error", "Failed to load notifications");
		} finally {
			this._notificationsModel?.setProperty("/loading", false);
		}
	}

	/**
	 * Transform notification for UI consumption
	 */
	private _transformNotification(notification: SecurityNotification): SecurityNotification & { importance: string } {
		return {
			...notification,
			importance: this._mapSeverityToImportance(notification.severity)
		};
	}

	/**
	 * Map severity to UI5 WebComponents importance
	 */
	private _mapSeverityToImportance(severity: string): string {
		const severityMap: Record<string, string> = {
			"low": "None",
			"medium": "Informative",
			"high": "Important",
			"critical": "Important"
		};
		return severityMap[severity] || "Informative";
	}

	/**
	 * Update notification count in shell bar
	 */
	private _updateNotificationCount(count: number): void {
		const oAppViewModel = this.getModel("appView") as JSONModel;
		if (oAppViewModel) {
			oAppViewModel.setProperty("/notificationsCount", count);
		}
	}

	/**
	 * Update notification count from current model data
	 */
	private _updateNotificationCountFromModel(): void {
		const notifications = this._notificationsModel?.getProperty("/notifications") as SecurityNotification[];
		const count = notifications ? notifications.length : 0;
		this._updateNotificationCount(count);
	}

	/**
	 * Remove notification from DOM immediately
	 */
	private _removeNotificationFromDOM(notificationId: string): void {
		const htmlControl = this.getView()?.byId("wcNotificationsList");
		if (!htmlControl) {
			return;
		}

		const domRef = htmlControl.getDomRef() as HTMLElement;
		if (!domRef) {
			return;
		}

		// Find and remove the notification element
		const notificationElements = domRef.querySelectorAll('.notification-item');
		notificationElements.forEach(element => {
			// Check if this element belongs to the notification being removed
			const elementId = (element as HTMLElement).dataset.notificationId;
			if (elementId === notificationId) {
				const htmlElement = element as HTMLElement;
				
				// Add fade-out and scale animation
				htmlElement.style.transition = 'opacity 0.4s ease-out, transform 0.4s ease-out, max-height 0.4s ease-out';
				htmlElement.style.opacity = '0';
				htmlElement.style.transform = 'translateX(20px) scale(0.95)';
				htmlElement.style.maxHeight = '0';
				htmlElement.style.margin = '0';
				htmlElement.style.padding = '0';
				
				// Remove after animation completes
				setTimeout(() => {
					try {
						if (htmlElement.parentNode) {
							htmlElement.parentNode.removeChild(htmlElement);
							Log.info(`Removed notification ${notificationId} from DOM`, "", "Notifications.controller");
						}
					} catch (error) {
						Log.error("Error removing notification from DOM", error as string, "Notifications.controller");
					}
				}, 450); // Slightly longer than animation duration
			}
		});
	}

	/**
	 * Remove notification from model data immediately
	 */
	private _removeNotificationFromModel(notificationId: string): void {
		const notifications = this._notificationsModel?.getProperty("/notifications") as SecurityNotification[];
		if (!notifications) {
			return;
		}

		const filteredNotifications = notifications.filter(notification => notification.ID !== notificationId);
		this._notificationsModel?.setProperty("/notifications", filteredNotifications);
		
		Log.info(`Removed notification ${notificationId} from model. Remaining: ${filteredNotifications.length}`, "", "Notifications.controller");
	}

	/**
	 * Handle notification item click - mark as seen and navigate
	 */
	public async onNotificationPress(event: Event): Promise<void> {
		const oSource = event.getSource() as any;
		const oCustomData = oSource.getCustomData();
		
		if (!oCustomData || oCustomData.length === 0) {
			return;
		}

		const sNotificationId = oCustomData.find((cd: any) => cd.getKey() === "notificationId")?.getValue();
		const bActionable = oCustomData.find((cd: any) => cd.getKey() === "actionable")?.getValue() === "true";
		const sActionUrl = oCustomData.find((cd: any) => cd.getKey() === "actionUrl")?.getValue();
		
		if (!sNotificationId) {
			return;
		}
		
		// Mark as seen (non-blocking)
		this._markNotificationSeen(sNotificationId);

		// Navigate if actionable
		if (bActionable && sActionUrl) {
			this._navigateToDetails(sActionUrl);
		}
	}

	/**
	 * Handle notification close - mark as seen only (not dismiss as per requirements)
	 */
	public async onNotificationClose(event: Event): Promise<void> {
		const oSource = event.getSource() as any;
		const oCustomData = oSource.getCustomData();
		
		if (!oCustomData || oCustomData.length === 0) {
			return;
		}

		const sNotificationId = oCustomData.find((cd: any) => cd.getKey() === "notificationId")?.getValue();
		
		if (!sNotificationId) {
			return;
		}
		
		// Mark as seen (this will hide it from the list)
		this._markNotificationSeen(sNotificationId);
	}

	/**
	 * Mark a single notification as seen using bulk action
	 */
	private async _markNotificationSeen(notificationId: string): Promise<void> {
		const oModel = this.getModel() as ODataModel;
		if (!oModel) {
			return;
		}

		try {
			// Use unbound bulk action for single notification
			const oActionBinding = oModel.bindContext("/bulkMarkNotificationsSeen(...)");
			oActionBinding.setParameter("IDs", [notificationId]);
			
			await oActionBinding.execute();

			Log.info(`Notification ${notificationId} marked as seen via bulk action`, "", "Notifications.controller");

			// Refresh notifications to reflect changes
			this._loadSecurityNotifications();
			
		} catch (error) {
			Log.error("Failed to mark notification as seen via bulk action", error as string, "Notifications.controller");
		}
	}

	/**
	 * Mark notification as seen with immediate UI feedback (for close button)
	 */
	private async _markNotificationSeenWithUIFeedback(notificationId: string): Promise<void> {
		// 1. Immediate UI feedback - remove notification from DOM
		this._removeNotificationFromDOM(notificationId);
		
		// 2. Update model data immediately
		this._removeNotificationFromModel(notificationId);
		
		// 3. Update badge count immediately
		this._updateNotificationCountFromModel();
		
		// 4. Execute backend action using bulk API (non-blocking)
		const oModel = this.getModel() as ODataModel;
		if (!oModel) {
			return;
		}

		try {
			// Use unbound bulk action for single notification (no hardcoded users)
			const oActionBinding = oModel.bindContext("/bulkMarkNotificationsSeen(...)");
			oActionBinding.setParameter("IDs", [notificationId]);
			
			await oActionBinding.execute();

			Log.info(`Notification ${notificationId} marked as seen successfully via bulk action`, "", "Notifications.controller");
			
		} catch (error) {
			Log.error("Failed to mark notification as seen via bulk action", error as string, "Notifications.controller");
			
			// On error, reload to get accurate state (this will make the notification reappear)
			this._loadSecurityNotifications();
		}
	}

	/**
	 * Clear all notifications by marking them as seen
	 */
	public async onClearAllNotifications(): Promise<void> {
		const notifications = this._notificationsModel?.getProperty("/notifications") as SecurityNotification[];
		if (!notifications || notifications.length === 0) {
			return;
		}

		try {
			// 1. Immediate UI feedback - clear all notifications from DOM and model
			this._clearAllNotificationsFromUI();
			
			// Get all notification IDs for backend action
			const aNotificationIds = notifications.map(notification => notification.ID);
			
			// 2. Use bulk mark as seen action (non-blocking)
			const oModel = this.getModel() as ODataModel;
			const oActionBinding = oModel.bindContext("/bulkMarkNotificationsSeen(...)");
			oActionBinding.setParameter("IDs", aNotificationIds);
			
			await oActionBinding.execute();
			
			MessageToast.show("All notifications marked as seen");
			
			Log.info(`Bulk marked ${aNotificationIds.length} notifications as seen`, "", "Notifications.controller");
			
		} catch (error) {
			Log.error("Failed to clear all notifications", error as string, "Notifications.controller");
			MessageToast.show("Failed to clear notifications");
			
			// On error, reload to get accurate state
			this._loadSecurityNotifications();
		}
	}

	/**
	 * Clear all notifications from UI immediately
	 */
	private _clearAllNotificationsFromUI(): void {
		// Clear model data
		this._notificationsModel?.setProperty("/notifications", []);
		
		// Update badge count
		this._updateNotificationCount(0);
		
		// Clear DOM content
		const htmlControl = this.getView()?.byId("wcNotificationsList");
		if (htmlControl) {
			const domRef = htmlControl.getDomRef() as HTMLElement;
			if (domRef) {
				// Add fade-out animation to all notifications
				const notificationElements = domRef.querySelectorAll('.notification-item');
				notificationElements.forEach((element, index) => {
					(element as HTMLElement).style.transition = `opacity 0.3s ease-out ${index * 0.1}s`;
					(element as HTMLElement).style.opacity = '0';
				});
				
				// Clear all content after animation
				setTimeout(() => {
					this._clearDOMContent(domRef);
				}, 300 + (notificationElements.length * 100));
			}
		}
		
		Log.info("Cleared all notifications from UI with animation", "", "Notifications.controller");
	}

	/**
	 * Navigate to notification details (prepare for intent-based navigation)
	 */
	private _navigateToDetails(actionUrl: string): void {
		// For now, prepare navigation URL for future intent-based navigation
		// This can be enhanced when shell routing is extended with intent navigation
		Log.info(`Navigation to: ${actionUrl}`, "", "Notifications.controller");
		
		// TODO: Implement intent-based navigation when shell supports it
		// Example: this.getRouter().navToIntent("SecurityNotifications-display", { notificationId });
	}


	/**
	 * Render notifications list using direct DOM manipulation
	 */
	private _renderWCNotifications(): void {
		// Use setTimeout to ensure DOM is ready and avoid race conditions
		setTimeout(() => {
			this._doRenderNotifications();
		}, 50);
	}

	/**
	 * Actual rendering logic with proper DOM creation
	 */
	private _doRenderNotifications(): void {
		const data = this._notificationsModel?.getProperty("/notifications") as SecurityNotification[] || [];
		const loading = this._notificationsModel?.getProperty("/loading") as boolean;
		const error = this._notificationsModel?.getProperty("/error") as string;
		
		const htmlControl = this.getView()?.byId("wcNotificationsList");
		if (!htmlControl) {
			return;
		}

		// Get DOM element for direct manipulation
		const domRef = htmlControl.getDomRef() as HTMLElement;
		if (!domRef) {
			return;
		}

		// Clear existing content
		this._clearDOMContent(domRef);

		// Show loading state
		if (loading) {
			domRef.appendChild(this._createLoadingElement());
			return;
		}

		// Show error state
		if (error) {
			domRef.appendChild(this._createErrorElement(error));
			return;
		}

		// Show notifications or empty state
		if (data.length === 0) {
			return; // Empty state handled by IllustratedMessage in XML
		}

		// Create notifications container and list
		const container = this._createNotificationsContainer();
		const listElement = this._createNotificationsList(data);
		
		container.appendChild(listElement);
		domRef.appendChild(container);
		
		Log.info(`Rendered ${data.length} notifications using optimized DOM creation`, "", "Notifications.controller");
	}

	/**
	 * DOM Rendering Utilities
	 */

	/**
	 * Clear DOM content efficiently
	 */
	private _clearDOMContent(element: HTMLElement): void {
		while (element.firstChild) {
			element.removeChild(element.firstChild);
		}
	}

	/**
	 * Create loading element with CSS animation
	 */
	private _createLoadingElement(): HTMLElement {
		const container = document.createElement("div");
		container.style.cssText = "text-align: center; padding: 1rem;";

		// Create spinner
		const spinner = document.createElement("div");
		spinner.style.cssText = `
			display: inline-block; 
			width: 32px; 
			height: 32px; 
			border: 3px solid #f3f3f3; 
			border-top: 3px solid #0070f2; 
			border-radius: 50%; 
			animation: spin 1s linear infinite;
		`;

		// Create loading text
		const loadingText = document.createElement("div");
		loadingText.style.cssText = "margin-top: 0.5rem; color: #666;";
		loadingText.textContent = "Loading notifications...";

		// Add CSS animation
		const style = document.createElement("style");
		style.textContent = `
			@keyframes spin {
				0% { transform: rotate(0deg); }
				100% { transform: rotate(360deg); }
			}
		`;

		container.appendChild(style);
		container.appendChild(spinner);
		container.appendChild(loadingText);

		return container;
	}

	/**
	 * Create error element
	 */
	private _createErrorElement(error: string): HTMLElement {
		const container = document.createElement("div");
		container.style.cssText = "padding: 1rem; color: #dc3545; text-align: center;";

		const icon = document.createElement("div");
		icon.style.cssText = "font-size: 1.2em; margin-bottom: 0.5rem;";
		icon.textContent = "⚠️";

		const errorText = document.createElement("div");
		errorText.textContent = error;

		container.appendChild(icon);
		container.appendChild(errorText);

		return container;
	}

	/**
	 * Create notifications container
	 */
	private _createNotificationsContainer(): HTMLElement {
		const container = document.createElement("div");
		container.style.cssText = "padding: 0.5rem; max-height: 400px; overflow-y: auto;";
		return container;
	}

	/**
	 * Create notifications list using native Web Components
	 */
	private _createNotificationsList(notifications: SecurityNotification[]): HTMLElement {
		// For now, use styled divs that look like notification items
		// Could be enhanced to use actual ui5-list and ui5-li-notification elements
		const listContainer = document.createElement("div");

		notifications.forEach(notification => {
			const notificationElement = this._createNotificationItem(notification);
			listContainer.appendChild(notificationElement);
		});

		return listContainer;
	}

	/**
	 * Create individual notification item with proper event handling
	 */
	private _createNotificationItem(notification: SecurityNotification): HTMLElement {
		const severityColor = notification.severity === "high" ? "#dc3545" : "#fd7e14";
		const severityBg = notification.severity === "high" ? "#f8d7da" : "#fff3cd";
		const hoverBg = notification.severity === "high" ? "#f1c6c7" : "#ffecb5";

		// Create main container
		const container = document.createElement("div");
		container.className = "notification-item";
		container.dataset.notificationId = notification.ID; // Add data attribute for identification
		container.style.cssText = `
			display: flex; 
			align-items: center; 
			padding: 0.75rem; 
			margin: 0.5rem 0; 
			border-left: 3px solid ${severityColor}; 
			background-color: ${severityBg};
			border-radius: 4px;
			cursor: pointer;
			border: 1px solid ${severityColor}20;
			transition: background-color 0.2s ease;
		`;

		// Add hover effects
		container.addEventListener("mouseenter", () => {
			container.style.backgroundColor = hoverBg;
		});
		container.addEventListener("mouseleave", () => {
			container.style.backgroundColor = severityBg;
		});

		// Add click handler for notification
		container.addEventListener("click", () => {
			this._handleNotificationClick(notification);
		});

		// Create severity icon
		const iconElement = document.createElement("div");
		iconElement.style.cssText = `margin-right: 0.75rem; color: ${severityColor}; font-size: 1.2em;`;
		iconElement.textContent = notification.severity === "high" ? "🚨" : "⚠️";

		// Create content area
		const contentElement = document.createElement("div");
		contentElement.style.cssText = "flex: 1;";

		// Create title
		const titleElement = document.createElement("div");
		titleElement.style.cssText = "font-weight: bold; font-size: 0.875rem; color: #333; margin-bottom: 0.25rem;";
		titleElement.textContent = notification.title;

		// Create message
		const messageElement = document.createElement("div");
		messageElement.style.cssText = "font-size: 0.75rem; color: #666;";
		messageElement.textContent = notification.message;

		// Create close button
		const closeButton = document.createElement("button");
		closeButton.style.cssText = `
			background: none; 
			border: none; 
			font-size: 1.2rem; 
			cursor: pointer; 
			padding: 0.25rem;
			color: #666;
			margin-left: 0.5rem;
			border-radius: 3px;
		`;
		closeButton.textContent = "×";
		closeButton.title = "Mark as seen";

		// Add close button hover effects
		closeButton.addEventListener("mouseenter", () => {
			closeButton.style.backgroundColor = "#f0f0f0";
		});
		closeButton.addEventListener("mouseleave", () => {
			closeButton.style.backgroundColor = "transparent";
		});

		// Add close button click handler (with event propagation stop)
		closeButton.addEventListener("click", (event) => {
			event.stopPropagation();
			this._handleNotificationClose(notification);
		});

		// Assemble the notification item
		contentElement.appendChild(titleElement);
		contentElement.appendChild(messageElement);
		
		container.appendChild(iconElement);
		container.appendChild(contentElement);
		container.appendChild(closeButton);

		return container;
	}

	/**
	 * Handle notification click with proper navigation
	 */
	private _handleNotificationClick(notification: SecurityNotification): void {
		// Mark as seen (non-blocking) but don't remove from UI for clicks
		this._markNotificationSeen(notification.ID);
		
		// Navigate if actionable
		if (notification.actionable && notification.actionUrl) {
			this._navigateToDetails(notification.actionUrl);
		}
	}

	/**
	 * Handle notification close button click
	 */
	private _handleNotificationClose(notification: SecurityNotification): void {
		// Mark as seen when closed and provide immediate UI feedback
		this._markNotificationSeenWithUIFeedback(notification.ID);
	}

	/**
	 * Escape HTML to prevent XSS
	 */
	private _escapeHtml(unsafe: string): string {
		return unsafe
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#039;");
	}

	/**
	 * Show notifications popover (called from App controller)
	 */
	public showNotificationsPopover(openerEl: HTMLElement): void {
		// Refresh notifications when popover is opened to get latest seen status
		Log.info("Refreshing notifications when popover opened", "", "Notifications.controller");
		this._loadSecurityNotifications();
		
		// Get popover reference
		const popover = this.getView().byId("notificationsPopover") as any; // sap.ui.webc.main.Popover
		const popEl = popover?.getDomRef?.() as any;
		
		if (!openerEl) {
			Log.warning("No opener element provided", "", "Notifications.controller");
			return;
		}
		
		const openNow = (el: any) => {
			// v2 API: pass the HTMLElement, not an id string
			el.opener = openerEl;
			el.open = true; // declarative open in v2
			Log.info("Notifications popover opened", "", "Notifications.controller");
		};
		
		if (popEl) {
			openNow(popEl);
		} else {
			// Popover not rendered yet – open right after rendering
			popover.attachEventOnce("afterRendering", () => openNow(popover.getDomRef()));
		}
	}
}