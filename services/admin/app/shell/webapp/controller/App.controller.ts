/* eslint-disable @typescript-eslint/no-unsafe-call */
import BaseController from "admin/shell/controller/BaseController";
import UI5Element from "sap/ui/core/Element";
import Device from "sap/ui/Device";
import XMLView from "sap/ui/core/mvc/XMLView";
import Fragment from "sap/ui/core/Fragment";
import JSONModel from "sap/ui/model/json/JSONModel";
import Log from "sap/base/Log";
import Text from "sap/m/Text";
import Title from "sap/m/Title";
import ResponsivePopover from "sap/m/ResponsivePopover";
import HTML from "sap/ui/core/HTML";
import ToolPage from "sap/tnt/ToolPage";
import Dialog from "sap/m/Dialog";
import SideNavigation, { SideNavigation$ItemSelectEvent } from "sap/tnt/SideNavigation";
import NavigationListItem from "sap/tnt/NavigationListItem";
import Component from "sap/ui/core/Component";
import ComponentContainer from "sap/ui/core/ComponentContainer";
import Breadcrumbs from "sap/m/Breadcrumbs";
import Link from "sap/m/Link";
import Button from "sap/m/Button";
import HBox from "sap/m/HBox";

// UI5 Web Components - Now using SAPUI5 wrapper types
import ShellBar, { ShellBar$NotificationsClickEvent } from "sap/ui/webc/fiori/ShellBar";

// Icons are provided via SAPUI5 icon pool, no explicit imports needed


/**
 * @namespace admin.shell.controller
 */
export default class App extends BaseController {
	useOverlayNav: boolean = false;
	private feContainer!: ComponentContainer;
	private currentAppKey: string = "";
	private feRouter?: any;
	private currentRouteName: string = "";
	private sseConnection?: EventSource;
	private sseReconnectAttempts: number = 0;
	private maxReconnectAttempts: number = 5;
	
	// Configuration for the single admin app
	private appConfigurations = {
		"apiKeys": {
			componentName: "admin.app.Component",
			manifest: true,
			title: "API Keys Management",
			route: "#api-keys"
		},
		"awsCredentials": {
			componentName: "admin.awscredentials.Component", 
			manifest: true,
			title: "AWS Credentials Management",
			route: "#aws-credentials"
		},
		"securityEvents": {
			componentName: "admin.securitynotifications.Component",
			manifest: true,
			title: "Security Notifications",
			route: "#security-events"
		},
		"usage": {
			componentName: "admin.usageanalytics.Component",
			manifest: true,
			title: "Usage Analytics",
			route: "#usage-analytics"
		},
		"config": {
			componentName: "admin.config.Component",
			manifest: true,
			title: "Configuration Management",
			route: "#config"
		}
	};

	// Track deployment target (populated during initialization)
	private deployTarget: string = 'unknown';

	/**
	 * Detect deployment target by calling backend endpoint
	 * This avoids assumptions about ports, proxies, or URL patterns
	 */
	private async detectDeploymentTarget(): Promise<void> {
		try {
			// Use relative URL to avoid hardcoding base URLs
			const response = await fetch('/odata/v4/admin/whoami', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Accept': 'application/json'
				}
			});
			
			if (response.ok) {
				const result = await response.json();
				// The backend can include deployment info in the response
				this.deployTarget = result.deployTarget || 'development';
				console.log(`[detectDeploymentTarget] Detected: ${this.deployTarget}`);
			} else {
				// Fallback: assume local development if API call fails
				this.deployTarget = 'development';
				console.warn('[detectDeploymentTarget] API call failed, assuming development');
			}
		} catch (error) {
			// Fallback: assume local development on any error
			this.deployTarget = 'development';
			console.warn('[detectDeploymentTarget] Error detecting deployment target:', error);
		}
	}

	/**
	 * Get environment-specific component URL for Fiori Elements apps
	 * Uses relative URLs to avoid hardcoding base paths
	 */
	private getComponentUrl(appKey: string): string {
		if (this.deployTarget === 'docker') {
			// Docker: Use full app directory names with /admin/app prefix for nginx routing
			const appPathMap: { [key: string]: string } = {
				'apiKeys': '/admin/app/api-keys-app/',
				'awsCredentials': '/admin/app/aws-credentials-app/',
				'securityEvents': '/admin/app/security-notifications-app/',
				'usage': '/admin/app/usage-analytics-app/',
				'config': '/admin/app/config-app/'
			};
			return appPathMap[appKey] || '/admin/app/api-keys-app/';
		} else {
			// Local development: Use simple relative paths
			const appPathMap: { [key: string]: string } = {
				'apiKeys': '/api-keys/',
				'awsCredentials': '/aws-credentials/',
				'securityEvents': '/security-notifications/',
				'usage': '/usage-analytics/',
				'config': '/config/'
			};
			return appPathMap[appKey] || '/api-keys/';
		}
	}

	/**
	 * Called when the controller is instantiated.
	 */
	onInit() {
		Log.setLevel(Log.Level.DEBUG);

		this.applyContentDensity();
		this.initViewModel();
		this.initOverlayNav();
		
		// Initialize persistent ComponentContainer reference
		this.feContainer = this.getView().byId("feContainer") as ComponentContainer;
		
		// Load user preferences and apply sidepanel state
		this._loadUserPreferences();
		
		// Detect deployment target first, then initialize SSE with correct URL
		this.detectDeploymentTarget().then(() => {
			// Initialize real-time notification system after deployment target is known
			this.initSSE();
		});
	}

	onAfterRendering() {
		// Initialize home content after view is fully rendered
		this.updateContent("home").catch(error => {
			Log.error("Failed to initialize home content", error);
		});
		
		// User preferences are now loaded in onInit()
		
		// Temporary fix for the issue with the side navigation not scrolling to the top
		// Scroll the SideNavigation's NavigationList to the top
		setTimeout(() => {
			const sideNav = this.getView().byId("sideNavigation");
			if (sideNav) {
				// Find the DOM element with class 'sapTntNL'
				const navList = sideNav.getDomRef()?.querySelector(".sapTntNL");
				if (navList) {
					navList.scrollTop = 0;
				}
			}
		}, 0);
		
		// Fix FE floating footer positioning
		this.fixMainContentHeight();
		
		// Apply custom ShellBar styling after rendering
		this._applyShellBarStyling();
	}

	/**
	 * Simple fix for FE floating footer positioning
	 */
	fixMainContentHeight(): void {
		const oMainFlex = this.getView().byId("mainContent");
		if (oMainFlex && oMainFlex.setHeight) {
			oMainFlex.setHeight("calc(100% - 35px)");
		}
	}

	/**
	 * Applies the content density mode to the view.
	 */
	applyContentDensity(): void {
		this.getView().addStyleClass(this.getOwnerComponent().getContentDensityClass());
	}

	/**
	 * Initializes the view model.
	 * This is used to set the initial state of the app.
	 */
	initViewModel(): void {
		const appViewModel = new JSONModel({
			notificationsCount: 0, // Will be updated by Notifications controller
			userInitials: "U", // Default, will be updated when user info is loaded
			userEmail: "", // Will be updated when user info is loaded
			userRole: "User" // Will be updated based on isAdmin flag
		});
		this.getView().setModel(appViewModel, "appView");
		
		// Initialize UI state model with default sidepanel state
		// This ensures the first render has the correct state (avoids visual artifacts)
		const uiModel = new JSONModel({
			sideExpanded: true // Default to expanded, will be overridden by user preferences
		});
		this.getView().setModel(uiModel, "ui");
	}

	/**
	 * Called when the view is created.
	 * This is used to initialize the overlay navigation.
	 */
	initOverlayNav(): void {
		const params = new URLSearchParams(window.location.search);
		this.useOverlayNav = params.get("overlayNavigation") === "true";

		if (this.useOverlayNav) {
			const sideNav = this.getView().byId("sideNavigation") as SideNavigation;
			sideNav.setVisible(false);
		}
	}

	/**
	 * Called when the user clicks on the menu button.
	 * This is used to toggle the side navigation.
	 */
	async onMenuButtonClick(): Promise<void> {
		if (!this.useOverlayNav) {
			// Get current state from the UI model instead of the control
			const uiModel = this.getView().getModel("ui") as JSONModel;
			const currentSideExpanded = uiModel.getProperty("/sideExpanded");
			const newSideExpanded = !currentSideExpanded;
			
			// Update the UI model - this will trigger the binding and update the ToolPage
			uiModel.setProperty("/sideExpanded", newSideExpanded);
			
			// Save the new state to user preferences
			this._saveSidepanelState(!newSideExpanded); // inverted because sidePanelCollapsed = !sideExpanded
			
			Log.info(`Sidepanel toggled via model: sideExpanded=${newSideExpanded}`, "", "App.controller");
		} else {
			const menuButton = this.getView().byId("toggleMenu") as Button;
			await this.openNavigationInOverlay(menuButton);
		}
	}

	/**
	 * Closes the side navigation on phone devices for better UX.
	 */
	closeSideNavigationOnPhone(): void {
		if (Device.system.phone && !this.useOverlayNav) {
			const uiModel = this.getView().getModel("ui") as JSONModel;
			const wasExpanded = uiModel.getProperty("/sideExpanded");
			
			// Update via model binding
			uiModel.setProperty("/sideExpanded", false);
			
			// Save the collapsed state for phone devices
			if (wasExpanded) {
				this._saveSidepanelState(true); // collapsed = true
			}
		}
	}

	/**
	 * Called when the user clicks on the logo button.
	 */
	async onLogoClick(): Promise<void> {
		// updateContent will set the selectedKey, so we don't need to do it here
		await this.updateContent("home");

		this.closeSideNavigationOnPhone();
	}


	/**
	 * Called when the user clicks on the notifications button.
	 */
	onNotificationsClick(event: ShellBar$NotificationsClickEvent): void {
		const notificationsView = this.getView().byId("notificationsView") as XMLView;
		const pop = notificationsView.byId("notificationsPopover") as any;
		const wc = pop?.getDomRef() as any;
		
		// Get opener element from ShellBar's targetRef
		const opener = event.getParameter("targetRef");
		
		if (!opener) {
			Log.warning("Notifications opener not found", "", "App.controller");
			return;
		}
		
		// Check if popover is open
		const isOpen = () => wc?.hasAttribute?.("open") || wc?.open === true;
		
		if (isOpen()) {
			// v2: close declaratively
			wc.open = false;
			Log.info("Closing notifications popover", "", "App.controller");
			return;
		}
		
		// Pass opener to Notifications controller to handle the opening
		const notificationsController = notificationsView.getController() as any;
		if (notificationsController && notificationsController.showNotificationsPopover) {
			notificationsController.showNotificationsPopover(opener);
		}
	}



	/**
	 * Called when the user clicks on the profile button.
	 */
	async onProfileClick(event: any): Promise<void> {
		const popoverCtl = this.getView().byId("userProfilePopover") as any;
		const popEl = popoverCtl?.getDomRef?.() as any;
		
		// 1) Prefer ShellBar's targetRef (same as notifications!)
		const opener = event.getParameter && event.getParameter("targetRef")
			? event.getParameter("targetRef") as HTMLElement
			: (this.getView().byId("profileAvatar")?.getDomRef() as HTMLElement | null);
		
		if (!opener || !popEl) {
			Log.warning("Profile popover or opener not found", "", "App.controller");
			return;
		}
		
		// 2) Simple, idempotent toggle with single source of truth
		const isOpen = popEl.open === true || popEl.hasAttribute?.("open");
		
		if (isOpen) {
			popEl.open = false;
			Log.info("Closing profile popover", "", "App.controller");
			return;
		}
		
		// Set opener and open
		popEl.opener = opener;   // HTMLElement, not ID
		popEl.open = true;
		Log.info("Profile popover opened with targetRef", "", "App.controller");
	}


	/**
	 * Called when the user clicks Sign Out
	 * Handles logout by calling the admin service logout API
	 */
	async onSignOut(): Promise<void> {
		try {
			Log.info('Logout initiated by user', '', 'App.controller');
			
			// Show busy indicator
			sap.ui.core.BusyIndicator.show(0);
			
			// Call the comprehensive logout API that handles all IdPs
			const response = await fetch('/admin/logout', {
				method: 'POST',
				headers: {
					'Accept': 'application/json',
					'Content-Type': 'application/json'
				},
				credentials: 'include'
			});
			
			// Development mode no longer returns 401, but handle it just in case
			if (response.status === 401) {
				Log.info('Unexpected 401 during logout - redirecting to home', '', 'App.controller');
				// Hide busy indicator
				sap.ui.core.BusyIndicator.hide();
				window.location.href = window.location.origin + '/shell/index.html';
				return;
			}
			
			if (!response.ok) {
				throw new Error(`Logout request failed: ${response.status} ${response.statusText}`);
			}
			
			const logoutData = await response.json();
			Log.info('Logout response received', JSON.stringify(logoutData), 'App.controller');
			
			// Hide busy indicator
			sap.ui.core.BusyIndicator.hide();
			
			// Handle the comprehensive logout response
			if (logoutData.success && logoutData.redirectUrl) {
				// Show a message to the user
				const message = logoutData.message || 'Logging out...';
				Log.info(`Logout successful: ${message}`, '', 'App.controller');
				
				// Log development note if present
				if (logoutData.devNote) {
					Log.info(`Development note: ${logoutData.devNote}`, '', 'App.controller');
				}
				
				// Redirect to the logout URL
				window.location.href = logoutData.redirectUrl;
			} else if (logoutData.action === 'authenticate') {
				// Legacy handling - should not occur with new implementation
				window.location.href = window.location.origin + '/shell/index.html';
			} else if (logoutData.message === 'Logged out successfully') {
				// Fallback for simple logout responses
				const redirectUrl = window.location.origin + '/shell/index.html';
				window.location.href = redirectUrl;
			} else {
				// Handle error case
				Log.error('Logout failed', logoutData.error || 'Unknown error', 'App.controller');
				
				// Show error message to user
				const MessageToast = (await import("sap/m/MessageToast")).default;
				MessageToast.show(logoutData.error || 'Logout failed. Please try again.');
			}
			
		} catch (error) {
			// Hide busy indicator on error
			sap.ui.core.BusyIndicator.hide();
			
			Log.error('Logout process failed', error as Error, 'App.controller');
			
			// Show error message to user
			try {
				const MessageToast = (await import("sap/m/MessageToast")).default;
				MessageToast.show('Logout failed. Please close your browser to end the session.');
			} catch (importError) {
				// Fallback if MessageToast import fails
				console.error('Failed to show error message:', importError);
				alert('Logout failed. Please close your browser to end the session.');
			}
		}
	}


	/**
	 * Called when opening the side navigation in overlay mode.
	 */
	async openNavigationInOverlay(menuButton: Button): Promise<void> {
		let popover = this.getView().byId("sideNavPopover") as ResponsivePopover;
		if (!popover) {
			popover = await Fragment.load({
				id: this.getView().getId(),
				name: "admin.shell.fragments.SideNavPopover",
				type: "XML",
				controller: this
			}) as ResponsivePopover;

			this.getView().addDependent(popover);
			popover.setShowHeader(Device.system.phone);
		}

		if (popover.isOpen()) {
			popover.close();
		} else {
			popover.openBy(menuButton);
		}
	}



	/**
	 * Called when an item is selected in the side navigation.
	 */
	async onItemSelect(event: SideNavigation$ItemSelectEvent): Promise<void> {
		const item = event.getParameter("item") as NavigationListItem;
		const key = item.getKey();
		const text = item.getText();

		console.log("[onItemSelect] key=", key, "text=", text);

		// Update the content based on the selected item
		// Note: updateContent will set the selectedKey, so we don't need to do it here
		await this.updateContent(key);

		// if in popover - close the popover
		const popover = this.getView().byId("sideNavPopover") as ResponsivePopover;
		if (popover?.isOpen()) {
			popover.close();
		}

		this.closeSideNavigationOnPhone();
	}

	/**
	 * Updates the main content area based on the selected navigation item.
	 */
	async updateContent(key: string): Promise<void> {
		const staticContainer = this.getView().byId("staticContent");
		const contentTitle = this.getView().byId("contentTitle") as Title;
		if (!staticContainer) return;

		// Map settings to config app
		if (key === "settings") {
			key = "config";
		}

		console.log("[updateContent] key=", key, "hasCfg=", !!this.appConfigurations[key]);
		
		// Update side navigation selectedKey to ensure it's in sync
		const sideNav = this.getView().byId("sideNavigation") as SideNavigation;
		const navKey = key === "config" ? "settings" : key;
		
		// Only set selectedKey if it's a valid navigation item key
		if (["home", "apiKeys", "awsCredentials", "usage", "securityEvents", "settings"].includes(navKey)) {
			sideNav.setSelectedKey(navKey);
		}

		// Check if this is a Fiori Elements app
		if (this.appConfigurations[key]) {
			// Hide shell title for FE apps (they have their own titles)
			contentTitle.setVisible(false);
			// Hide static content, show FE container
			staticContainer.setVisible(false);
			await this.loadFioriElementsApp(key);
		} else {
			// Show shell title for static content, update text
			contentTitle.setVisible(true);
			const sideNav = this.getView().byId("sideNavigation") as SideNavigation;
			const selectedItem = sideNav.getSelectedItem() as NavigationListItem;
			if (selectedItem && typeof selectedItem.getText === 'function') {
				contentTitle.setText(selectedItem.getText());
			} else {
				// Fallback title based on key
				const titleMap: { [key: string]: string } = {
					'home': 'Home',
					'usage': 'Usage Analytics',
					'securityEvents': 'Security Events',
					'settings': 'System Settings'
				};
				contentTitle.setText(titleMap[key] || 'Administration');
			}
			// Show static content, hide FE container
			this.feContainer.setVisible(false);
			staticContainer.setVisible(true);
			// Remove existing static content
			staticContainer.removeAllItems();
			this.loadStaticContent(key, staticContainer);
			
			// Update breadcrumb for static content (especially important for home)
			this.updateBreadcrumb(key);
		}
	}

	/**
	 * Loads the FE app using persistent ComponentContainer pattern (research model recommended)
	 */
	private async loadFioriElementsApp(appKey: string): Promise<void> {
		const cfg = this.appConfigurations[appKey];
		if (!cfg) return;

		sap.ui.core.BusyIndicator.show(0);
		try {
			// Run in standalone mode - no UShell services needed
			
			// Destroy previous FE component, if any
			const oldComponent = this.feContainer.getComponentInstance();
			if (oldComponent) {
				console.log("[loadFioriElementsApp] Destroying old component:", oldComponent.getId());
				oldComponent.destroy();
			}

			// Create FE component and attach it to the persistent container
			// Use environment-aware URL generation
			const componentUrl = this.getComponentUrl(appKey);
			
			let componentConfig;
			if (appKey === "apiKeys") {
				componentConfig = {
					name: "admin.app",
					url: componentUrl,
					manifest: true,
					async: true
				};
			} else if (appKey === "awsCredentials") {
				componentConfig = {
					name: "admin.awscredentials",
					url: componentUrl,
					manifest: true,
					async: true
				};
			} else if (appKey === "securityEvents") {
				componentConfig = {
					name: "admin.securitynotifications",
					url: componentUrl,
					manifest: true,
					async: true
				};
			} else if (appKey === "usage") {
				componentConfig = {
					name: "admin.usageanalytics",
					url: componentUrl,
					manifest: true,
					async: true
				};
			} else if (appKey === "config") {
				componentConfig = {
					name: "admin.config",
					url: componentUrl,
					manifest: true,
					async: true
				};
			} else {
				// Default to API Keys for other cases
				const defaultUrl = this.getComponentUrl('apiKeys');
				componentConfig = {
					name: "admin.app",
					url: defaultUrl,
					manifest: true,
					async: true
				};
			}
			
			console.log(`[loadFioriElementsApp] Loading ${appKey} from ${componentUrl} (deployTarget: ${this.deployTarget})`);
			
			const component = await Component.create(componentConfig);

			console.log("[Component.create OK]", component.getId());
			
			// Propagate OData model from shell to child components (especially usage analytics and config)
			if (appKey === "usage" || appKey === "config") {
				const shellModel = this.getOwnerComponent()?.getModel();
				if (shellModel) {
					console.log(`[Model Propagation] Setting OData model on ${appKey} component`);
					component.setModel(shellModel);
				} else {
					console.warn("[Model Propagation] Shell OData model not found");
				}
			}
			
			this.feContainer.setComponent(component);
			this.feContainer.setVisible(true);
			
			console.log("[ComponentContainer] visible:", this.feContainer.getVisible());
			console.log("[ComponentContainer] component:", this.feContainer.getComponentInstance()?.getId());
			console.log("[ComponentContainer] DOM:", this.feContainer.getDomRef());
			
			// Store current app key for navigation
			this.currentAppKey = appKey;
			
			// Navigate to the appropriate route within the FE app
			const router = component.getRouter();
			if (router) {
				// Setup router listeners for breadcrumb updates
				this.setupFERouterListeners(router);
				
				// Ensure side navigation is updated before navigation
				const sideNav = this.getView().byId("sideNavigation") as SideNavigation;
				const navKey = appKey === "config" ? "settings" : appKey;
				if (["apiKeys", "awsCredentials", "usage", "securityEvents", "settings"].includes(navKey)) {
					sideNav.setSelectedKey(navKey);
				}
				
				if (appKey === "apiKeys") {
					router.navTo("ApiKeysList");
					this.updateBreadcrumb("apiKeys");
				} else if (appKey === "awsCredentials") {
					router.navTo("AwsCredentialsList");
					this.updateBreadcrumb("awsCredentials");
				} else if (appKey === "securityEvents") {
					router.navTo("MySecurityNotificationsList");
					this.updateBreadcrumb("securityEvents");
				} else if (appKey === "usage") {
					router.navTo("overview");
					this.updateBreadcrumb("usage");
				} else if (appKey === "config") {
					router.navTo("main");
					this.updateBreadcrumb("config");
				}
				
				// Apply the simple height fix for floating footer positioning
				this.fixMainContentHeight();
			}
			
		} catch (error) {
			Log.error("Failed to load FE app", error);
			console.error("[Component.create failed]", error);
			// Show error in static content instead
			this.feContainer.setVisible(false);
			const staticContainer = this.getView().byId("staticContent");
			staticContainer.setVisible(true);
			staticContainer.removeAllItems();
			this.loadStaticContent("error", staticContainer);
		} finally {
			sap.ui.core.BusyIndicator.hide();
		}
	}

	/**
	 * Sets up UShell services for FE compatibility
	 */
	private setupUShellServices(): void {
		// Create UShell services if they don't exist or are incomplete
		console.log("[setupUShellServices] Setting up UShell services...");
		
		window.sap = window.sap || {};
		
		const navigationService = {
			storeInnerAppStateAsync: async function() {
				console.log("[NavigationService] storeInnerAppStateAsync called");
				return Promise.resolve({ appStateKey: "" });
			},
			getInnerAppState: function() {
				console.log("[NavigationService] getInnerAppState called");
				return Promise.resolve({});
			},
			getCurrentHash: function() {
				return window.location.hash || "";
			},
			parseShellHash: function(hash?: string) {
				return { semanticObject: "", action: "", params: {} };
			},
			navigate: function() {
				return Promise.resolve();
			}
		};

		const appStateService = {
			createEmptyAppState: () => ({ 
				saveAsPersisted: async () => {}, 
				getKey: () => "",
				setData: () => {},
				getData: () => ({})
			}),
			getAppState: () => Promise.resolve({
				getData: () => ({}),
				setData: () => {},
				save: () => Promise.resolve()
			})
		};

		const crossAppNavService = {
			toExternal() {}, 
			hrefForExternal() { return ""; },
			isNavigationSupported() { return Promise.resolve(true); }
		};

		const urlParsingService = {
			parseShellHash: function(hash?: string) {
				return { semanticObject: "", action: "", params: {} };
			}
		};

		window.sap.ushell = {
			Container: {
				getServiceAsync: async (serviceName: string) => {
					console.log("[UShell] getServiceAsync called for:", serviceName);
					switch (serviceName) {
						case "CrossApplicationNavigation":
							return crossAppNavService;
						case "AppState":
							return appStateService;
						case "NavigationService":
							return navigationService;
						case "URLParsing":
							return urlParsingService;
						default:
							console.log("[UShell] Unknown service requested:", serviceName);
							return {};
					}
				},
				getService: function(serviceName: string) {
					console.log("[UShell] getService called for:", serviceName);
					switch (serviceName) {
						case "NavigationService":
							return navigationService;
						case "URLParsing":
							return urlParsingService;
						case "CrossApplicationNavigation":
							return crossAppNavService;
						case "AppState":
							return appStateService;
						default:
							console.log("[UShell] Unknown service requested:", serviceName);
							return {};
					}
				}
			}
		};
		
		console.log("[setupUShellServices] UShell services setup complete");
	}

	/**
	 * Fallback method to load Fiori Elements app in iframe
	 */
	private loadFioriElementsAppIframe(appKey: string, contentContainer: any): void {
		let appUrl = "";
		
		switch (appKey) {
			case "apiKeys":
				appUrl = "/api-keys/index.html";
				break;
			case "awsCredentials":
				appUrl = "/aws-credentials/index.html";
				break;
			default:
				appUrl = "/";
		}
		
		const iframe = new HTML({
			content: `<iframe src="${appUrl}" width="100%" height="600px" style="border:none;"></iframe>`
		});
		
		contentContainer.addItem(iframe);
	}

	/**
	 * Loads static content for non-app sections
	 */
	private loadStaticContent(key: string, contentContainer: any): void {
		let contentText = "";
		let descriptionText = "";

		switch (key) {
			case "home":
				contentText = "Welcome to the SAIL-PROXY Admin Cockpit";
				descriptionText = "This administration interface allows you to:\n\n• Configure and manage API access credentials\n• Set up and rotate AWS credentials for secure access\n• Monitor usage patterns and track API consumption\n• Analyze security events and access logs\n• Manage LLM gateway settings and configurations\n\nUse the navigation menu on the left to access the different administrative functions.";
				break;
			case "usage":
				contentText = "Usage Analytics";
				descriptionText = "Monitor and analyze LLM Gateway usage patterns:\n\n• View API call statistics and trends\n• Monitor token consumption and costs\n• Analyze usage by application or user\n• Generate usage reports\n• Set up usage alerts and limits";
				break;
			case "securityEvents":
				contentText = "Security Events";
				descriptionText = "Monitor security events and access logs:\n\n• View authentication attempts and failures\n• Monitor suspicious activity patterns\n• Review access logs and audit trails\n• Set up security alerts\n• Export security reports";
				break;
			case "settings":
				contentText = "System Settings";
				descriptionText = "Configure system-wide settings and preferences:\n\n• General application settings\n• Security and authentication policies\n• Rate limiting and throttling rules\n• Logging and monitoring configuration\n• Integration settings";
				break;
			default:
				contentText = "Content Not Available";
				descriptionText = "The selected section is not yet implemented.";
		}

		// Create new content
		const welcomeText = new Text({
			text: contentText
		}).addStyleClass("sapUiMediumMarginBottom");

		const descText = new Text({
			text: descriptionText
		}).addStyleClass("sapUiSmallMarginTop");

		contentContainer.addItem(welcomeText);
		contentContainer.addItem(descText);
	}

	/**
	 * Handle back button press - navigate back appropriately
	 */
	onBackPress(): void {
		console.log("onBackPress: currentRouteName =", this.currentRouteName);
		console.log("onBackPress: currentAppKey =", this.currentAppKey);
		
		// If we're on an Object Page, go back to the List Report
		if (this.currentRouteName && this.currentRouteName.includes("ObjectPage")) {
			if (this.feRouter) {
				if (this.currentAppKey === "apiKeys") {
					console.log("Navigating back to ApiKeysList");
					this.feRouter.navTo("ApiKeysList");
				} else if (this.currentAppKey === "awsCredentials") {
					console.log("Navigating back to AwsCredentialsList");
					this.feRouter.navTo("AwsCredentialsList");
				} else if (this.currentAppKey === "securityEvents") {
					console.log("Navigating back to MySecurityNotificationsList");
					this.feRouter.navTo("MySecurityNotificationsList");
				} else if (this.currentAppKey === "usage") {
					console.log("Navigating back to usage overview");
					this.feRouter.navTo("overview");
				} else if (this.currentAppKey === "config") {
					console.log("Navigating back to config main");
					this.feRouter.navTo("main");
				}
				return;
			}
		}
		
		// Otherwise, go back to home
		console.log("Navigating back to home");
		this.onHomeLinkPress();
	}

	/**
	 * Handle home link press in breadcrumb
	 */
	async onHomeLinkPress(): Promise<void> {
		// updateContent will set the selectedKey and update breadcrumb
		await this.updateContent("home");
	}

	/**
	 * Navigate via breadcrumb and update side navigation to keep it in sync
	 */
	private navigateViaBreadcrumb(appKey: string): void {
		// Update the side navigation to reflect the current app
		const sideNav = this.getView().byId("sideNavigation") as SideNavigation;
		
		// Map config to settings for side navigation
		const navKey = appKey === "config" ? "settings" : appKey;
		
		// Only set selectedKey if it's a valid navigation item key
		if (["home", "apiKeys", "awsCredentials", "usage", "securityEvents", "settings"].includes(navKey)) {
			sideNav.setSelectedKey(navKey);
		}
		
		if (this.feRouter) {
			if (appKey === "apiKeys") {
				this.feRouter.navTo("ApiKeysList");
			} else if (appKey === "awsCredentials") {
				this.feRouter.navTo("AwsCredentialsList");
			} else if (appKey === "securityEvents") {
				this.feRouter.navTo("MySecurityNotificationsList");
			} else if (appKey === "usage") {
				this.feRouter.navTo("overview");
			} else if (appKey === "config") {
				this.feRouter.navTo("main");
			}
		}
	}

	/**
	 * Update breadcrumb based on current navigation state
	 */
	private updateBreadcrumb(appKey: string, objectPageTitle: string = ""): void {
		const navigationArea = this.getView().byId("navigationArea") as HBox;
		const breadcrumbs = this.getView().byId("breadcrumbs") as Breadcrumbs;
		const homeLink = this.getView().byId("homeLink") as Link;

		if (appKey === "home") {
			// Hide navigation area for home
			navigationArea.setVisible(false);
		} else {
			// Show navigation area for FE apps
			navigationArea.setVisible(true);
			
			// Clear existing breadcrumb links except home
			breadcrumbs.removeAllLinks();
			breadcrumbs.addLink(homeLink);

			// Add app-level breadcrumb
			const appConfig = this.appConfigurations[appKey];
			if (appConfig) {
				const appLink = new Link({
					text: appConfig.title,
					press: () => {
						// Don't update side navigation when navigating via breadcrumbs
						// Just navigate directly to avoid selectedItem warnings
						this.navigateViaBreadcrumb(appKey);
					}
				});
				
				breadcrumbs.addLink(appLink);

				// Add object page breadcrumb if provided
				if (objectPageTitle) {
					const objectLink = new Link({
						text: objectPageTitle,
						enabled: false // Current page, not clickable
					});
					breadcrumbs.addLink(objectLink);
				}
			}
		}
	}

	/**
	 * Setup FE router event listeners for breadcrumb updates
	 */
	private setupFERouterListeners(router: any): void {
		this.feRouter = router;
		
		router.attachRouteMatched((event: any) => {
			const routeName = event.getParameter("name");
			console.log("Route matched:", routeName);
			
			// Store current route name for back button logic
			this.currentRouteName = routeName;
			
			// Update breadcrumb based on route
			if (routeName === "ApiKeysList") {
				this.updateBreadcrumb("apiKeys");
			} else if (routeName === "ApiKeysObjectPage") {
				// Try to get object title from context
				setTimeout(() => {
					const objectTitle = this.getObjectPageTitle();
					this.updateBreadcrumb("apiKeys", objectTitle || "Details");
				}, 100);
			} else if (routeName === "AwsCredentialsList") {
				this.updateBreadcrumb("awsCredentials");
			} else if (routeName === "AwsCredentialsObjectPage") {
				setTimeout(() => {
					const objectTitle = this.getObjectPageTitle();
					this.updateBreadcrumb("awsCredentials", objectTitle || "Details");
				}, 100);
			} else if (routeName === "MySecurityNotificationsList") {
				this.updateBreadcrumb("securityEvents");
			} else if (routeName === "MySecurityNotificationsObjectPage") {
				setTimeout(() => {
					const objectTitle = this.getObjectPageTitle();
					this.updateBreadcrumb("securityEvents", objectTitle || "Details");
				}, 100);
			} else if (routeName === "overview") {
				this.updateBreadcrumb("usage");
			} else if (routeName === "costs") {
				this.updateBreadcrumb("usage", "Cost Analysis");
			} else if (routeName === "performance") {
				this.updateBreadcrumb("usage", "Performance Analysis");
			} else if (routeName === "models") {
				this.updateBreadcrumb("usage", "Model Analysis");
			}
		});
	}

	/**
	 * Get object page title from FE app
	 */
	private getObjectPageTitle(): string {
		try {
			// Try to get title from FE app's object page
			const feComponent = this.feContainer.getComponentInstance();
			if (feComponent) {
				const rootView = feComponent.getRootControl();
				// This is a simplified approach - in practice you might need to dig deeper
				// into the FE component structure to get the actual object title
				return "Object Details";
			}
		} catch (error) {
			Log.debug("Could not get object page title", error);
		}
		return "Details";
	}

	/**
	 * Initialize Server-Sent Events connection for real-time notifications
	 */
	private initSSE(): void {
		try {
			Log.info("Initializing SSE connection for real-time notifications", "", "App.controller");
			
			// Connect to SSE endpoint - use environment-aware URL
			const sseUrl = this.deployTarget === 'docker' ? '/admin/api/notifications/stream' : '/api/notifications/stream';
			this.sseConnection = new EventSource(sseUrl, {
				withCredentials: true
			});

			this.sseConnection.onopen = () => {
				Log.info("SSE connection established", "", "App.controller");
				this.sseReconnectAttempts = 0;
			};

			this.sseConnection.onmessage = (event) => {
				try {
					const data = JSON.parse(event.data);
					Log.info("Received SSE message: " + event.type, JSON.stringify(data), "App.controller");
					
					// Handle the real-time notification
					this.handleSSENotification(event.type, data);
				} catch (error) {
					Log.error("Failed to process SSE message", error as Error, "App.controller");
				}
			};

			// Handle specific SSE event types
			this.sseConnection.addEventListener('new-security-event', (event) => {
				try {
					const data = JSON.parse(event.data);
					Log.info("New security event received via SSE", JSON.stringify(data), "App.controller");
					
					// Trigger notification refresh
					this.refreshNotifications();
				} catch (error) {
					Log.error("Failed to process new security event", error as Error, "App.controller");
				}
			});

			// Handle notification state changes (pin, unpin, mark seen, etc.)
			this.sseConnection.addEventListener('notification-state-changed', (event) => {
				try {
					const data = JSON.parse(event.data);
					Log.info("Notification state changed via SSE", JSON.stringify(data), "App.controller");
					
					// Trigger notification refresh
					this.refreshNotifications();
				} catch (error) {
					Log.error("Failed to process notification state change", error as Error, "App.controller");
				}
			});

			// Handle bulk notification changes
			this.sseConnection.addEventListener('notification-bulk-changed', (event) => {
				try {
					const data = JSON.parse(event.data);
					Log.info("Bulk notification change via SSE", JSON.stringify(data), "App.controller");
					
					// Trigger notification refresh
					this.refreshNotifications();
				} catch (error) {
					Log.error("Failed to process bulk notification change", error as Error, "App.controller");
				}
			});

			this.sseConnection.addEventListener('connected', (event) => {
				try {
					const data = JSON.parse(event.data);
					Log.info("SSE connected for user: " + data.userId, "", "App.controller");
				} catch (error) {
					Log.warning("SSE connected but failed to parse data", error as Error, "App.controller");
				}
			});

			this.sseConnection.onerror = (error) => {
				Log.error("SSE connection error", error as Error, "App.controller");
				this.handleSSEReconnection();
			};

		} catch (error) {
			Log.error("Failed to initialize SSE connection", error as Error, "App.controller");
			this.handleSSEReconnection();
		}
	}

	/**
	 * Handle SSE reconnection with exponential backoff
	 */
	private handleSSEReconnection(): void {
		if (this.sseReconnectAttempts >= this.maxReconnectAttempts) {
			Log.error("Max SSE reconnection attempts (" + this.maxReconnectAttempts + ") reached", "", "App.controller");
			return;
		}

		this.sseReconnectAttempts++;
		const delay = Math.pow(2, this.sseReconnectAttempts) * 1000; // Exponential backoff

		Log.info("Attempting SSE reconnection in " + delay + "ms (attempt " + this.sseReconnectAttempts + "/" + this.maxReconnectAttempts + ")", "", "App.controller");

		setTimeout(() => {
			if (this.sseConnection) {
				this.sseConnection.close();
			}
			this.initSSE();
		}, delay);
	}

	/**
	 * Handle incoming SSE notifications
	 */
	private handleSSENotification(eventType: string, data: any): void {
		Log.info("Handling SSE notification: " + eventType, JSON.stringify(data), "App.controller");
		
		// Refresh notifications to show new content
		this.refreshNotifications();
	}

	/**
	 * Refresh the notifications view and count
	 */
	private refreshNotifications(): void {
		try {
			// Update the notification count in the shell bar
			const notificationsView = this.getView().byId("notificationsView") as XMLView;
			if (notificationsView) {
				const notificationsController = notificationsView.getController();
				// @ts-expect-error: Calling a method that exists at runtime
				if (notificationsController && typeof notificationsController._loadSecurityNotifications === 'function') {
					Log.info("Refreshing notifications due to SSE event", "", "App.controller");
					notificationsController._loadSecurityNotifications();
				}
			}
		} catch (error) {
			Log.error("Failed to refresh notifications", error as Error, "App.controller");
		}
	}

	/**
	 * Load user preferences and apply sidepanel state via model binding
	 */
	private async _loadUserPreferences(): Promise<void> {
		try {
			Log.info("Loading user preferences for sidepanel state", "", "App.controller");
			
			// Use direct HTTP request to the CAP service (unbound function)
			const response = await fetch('/odata/v4/admin/getCurrentUserPreferences', {
				method: 'POST',
				headers: {
					'Accept': 'application/json',
					'Content-Type': 'application/json'
				},
				credentials: 'include'
			});
			
			if (!response.ok) {
				Log.warning(`Failed to fetch user preferences: ${response.status}`, "", "App.controller");
				return;
			}
			
			const result = await response.json();
			Log.info(`User preferences response: ${JSON.stringify(result)}`, "", "App.controller");
			
			// Update user initials, email and role
			const appViewModel = this.getView().getModel("appView") as JSONModel;
			if (result.email && appViewModel) {
				const initial = result.email.charAt(0).toUpperCase();
				appViewModel.setProperty("/userInitials", initial);
				appViewModel.setProperty("/userEmail", result.email);
				// Set role based on isAdmin flag
				appViewModel.setProperty("/userRole", result.isAdmin ? "Admin user" : "User");
			}
			
			if (result && typeof result.sidePanelCollapsed === 'boolean') {
				const sideExpanded = !result.sidePanelCollapsed; // invert because sidePanelCollapsed = !sideExpanded
				
				Log.info(`Applying saved sidepanel state via model: sidePanelCollapsed=${result.sidePanelCollapsed}, sideExpanded=${sideExpanded}`, "", "App.controller");
				
				// Update the UI model - this triggers the binding automatically
				const uiModel = this.getView().getModel("ui") as JSONModel;
				if (uiModel) {
					uiModel.setProperty("/sideExpanded", sideExpanded);
					// Force immediate render since this happens after initial load
					sap.ui.getCore().applyChanges();
					Log.info(`UI model updated: sideExpanded=${sideExpanded}`, "", "App.controller");
				}
			} else {
				Log.info("No sidepanel preference found or invalid format, using default (expanded)", "", "App.controller");
			}
			
		} catch (error) {
			Log.error("Failed to load user preferences", error as Error, "App.controller");
			// Continue with default state on error
		}
	}

	/**
	 * Save sidepanel state to user preferences
	 */
	private async _saveSidepanelState(collapsed: boolean): Promise<void> {
		try {
			Log.info(`Saving sidepanel state: collapsed=${collapsed}`, "", "App.controller");
			
			// Use direct HTTP request to the CAP service
			const response = await fetch('/odata/v4/admin/updateUserPreference', {
				method: 'POST',
				headers: {
					'Accept': 'application/json',
					'Content-Type': 'application/json'
				},
				credentials: 'include',
				body: JSON.stringify({
					key: 'sidePanelCollapsed',
					value: collapsed.toString()
				})
			});
			
			if (!response.ok) {
				Log.warning(`Failed to save sidepanel state: ${response.status}`, "", "App.controller");
				return;
			}
			
			Log.info("Sidepanel state saved successfully", "", "App.controller");
			
		} catch (error) {
			Log.error("Failed to save sidepanel state", error as Error, "App.controller");
			// Continue silently - don't disrupt user experience
		}
	}

	/**
	 * Apply custom styling to ShellBar titles and profile button after DOM rendering
	 * This is necessary because Web Components shadow DOM prevents external CSS
	 */
	private _applyShellBarStyling(): void {
		setTimeout(() => {
			try {
				// Find the ShellBar element
				const shellBars = document.querySelectorAll('[ui5-shellbar], ui5-shellbar-ui5');
				shellBars.forEach((shellBar: any) => {
					if (shellBar && shellBar.shadowRoot) {
						// Find the title elements in the shadow DOM
						const primaryTitle = shellBar.shadowRoot.querySelector('.ui5-shellbar-title bdi') || 
						                    shellBar.shadowRoot.querySelector('.ui5-shellbar-title');
						const secondaryTitle = shellBar.shadowRoot.querySelector('.ui5-shellbar-secondary-title');
						
						// Apply styles to SAP AI Core (primary title)
						if (primaryTitle) {
							primaryTitle.style.fontWeight = '400';
							primaryTitle.style.fontSize = '14px';
							primaryTitle.style.color = 'var(--sapShell_TextColor, #32363a)';
						}
						
						// Apply styles to LLM Gateway (secondary title)
						if (secondaryTitle) {
							secondaryTitle.style.fontWeight = '700';
							secondaryTitle.style.fontSize = '16px';
							secondaryTitle.style.color = 'var(--sapShell_SubBrand_TextColor, #0a6ed1)';
						}
						
					}
				});
				
				// Let ShellBar control avatar sizing - removed custom styling
			} catch (error) {
				Log.debug("Failed to apply ShellBar/Avatar styling", error);
			}
		}, 100); // Small delay to ensure DOM is ready
	}


}
