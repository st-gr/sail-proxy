import UIComponent from "sap/ui/core/UIComponent";
import models from "admin/shell/model/models";
import Device from "sap/ui/Device";

// Webcomponents are now loaded via SAPUI5 wrapper libraries (sap.ui.webc.main, sap.ui.webc.fiori)
// No explicit imports needed as they're declared in manifest.json dependencies

/**
 * @namespace admin.shell
 */
export default class Component extends UIComponent {
	public static metadata = {
		manifest: "json",
		interfaces: ["sap.ui.core.IAsyncContentCreation"]
	};

	private contentDensityClass: string;

	public init(): void {
		// call the base component's init function
		super.init();

		// Set up UShell services early in shell component
		this.setupUShellServices();

		// create the device model
		this.setModel(models.createDeviceModel(), "device");
	}

	/**
	 * Sets up UShell services for FE compatibility - must be available before FE components load
	 */
	private setupUShellServices(): void {
		if (!window.sap?.ushell) {
			window.sap = window.sap || {};
			
			// Create a complete NavigationService mock
			const navigationServiceMock = {
				storeInnerAppStateAsync: async function() {
					console.log("[UShell Mock] storeInnerAppStateAsync called");
					return Promise.resolve({ appStateKey: "" });
				},
				getInnerAppState: function() {
					console.log("[UShell Mock] getInnerAppState called");
					return Promise.resolve({});
				},
				getCurrentHash: function() {
					return "";
				},
				parseShellHash: function() {
					return { semanticObject: "", action: "", params: {} };
				}
			};

			window.sap.ushell = {
				Container: {
					getServiceAsync: async (serviceName: string) => {
						console.log("[UShell Mock] getServiceAsync:", serviceName);
						if (serviceName === "NavigationService") {
							return navigationServiceMock;
						}
						if (serviceName === "CrossApplicationNavigation") {
							return { 
								toExternal() {}, 
								hrefForExternal() { return ""; } 
							};
						}
						if (serviceName === "AppState") {
							return {
								storeInnerAppStateAsync: async () => ({ appStateKey: "" }),
								createEmptyAppState: () => ({ 
									saveAsPersisted: async () => {}, 
									getKey: () => "" 
								})
							};
						}
						return {};
					},
					getService: function(serviceName: string) {
						console.log("[UShell Mock] getService:", serviceName);
						if (serviceName === "NavigationService") {
							return navigationServiceMock;
						}
						return {};
					}
				}
			};
		}
	}

	/**
	 * This method can be called to determine whether the sapUiSizeCompact or sapUiSizeCozy
	 * design mode class should be set, which influences the size appearance of some controls.
	 * @public
	 * @returns css class, either 'sapUiSizeCompact' or 'sapUiSizeCozy' - or an empty string if no css class should be set
	 */
	public getContentDensityClass(): string {
		if (this.contentDensityClass === undefined) {
			// check whether FLP has already set the content density class; do nothing in this case
			if (document.body.classList.contains("sapUiSizeCozy") || document.body.classList.contains("sapUiSizeCompact")) {
				this.contentDensityClass = "";
			} else if (!Device.support.touch) {
				// apply "compact" mode if touch is not supported
				this.contentDensityClass = "sapUiSizeCompact";
			} else {
				// "cozy" in case of touch support; default for most sap.m controls, but needed for desktop-first controls like sap.ui.table.Table
				this.contentDensityClass = "sapUiSizeCozy";
			}
		}
		return this.contentDensityClass;
	}
}
