import UIComponent from "sap/ui/core/UIComponent";
import models from "./model/models";
import JSONModel from "sap/ui/model/json/JSONModel";

/**
 * @namespace admin.usageanalytics
 */
export default class Component extends UIComponent {
    
    public static metadata = {
        manifest: "json"
    };

    public init(): void {
        super.init();
        
        // Set up models
        this.setModel(models.createDeviceModel(), "device");
        
        // Check if OData model is available (should be propagated from shell)
        const oDataModel = this.getModel();
        console.log("[UsageAnalytics.Component.init] OData model available:", !!oDataModel);
        if (oDataModel) {
            console.log("[UsageAnalytics.Component.init] OData service URL:", oDataModel.getServiceUrl?.());
        }
        
        // Initialize view model with default state
        const viewModel = new JSONModel({
            busy: false,
            delay: 0,
            dateRange: {
                startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
                endDate: new Date()
            },
            granularity: "day",
            selectedTab: "overview",
            userContext: {
                email: "",
                isAdmin: false,
                roles: []
            },
            filters: {
                provider: "",
                model: "",
                endpoint: ""
            }
        });
        this.setModel(viewModel, "viewModel");

        // mockData model is now loaded automatically via manifest dataSource

        // Initialize router
        this.getRouter().initialize();

        // Load user context
        this._loadUserContext();
    }

    /**
     * Load user context for role-based access
     */
    private async _loadUserContext(): Promise<void> {
        try {
            // Use the same endpoint as other apps in the admin service
            const response = await fetch('/odata/v4/admin/getCurrentUserPreferences', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                credentials: 'include'
            });
            
            if (!response.ok) {
                console.warn(`Failed to fetch user preferences: ${response.status}`);
                return;
            }
            
            const userPrefs = await response.json();
            console.log(`User preferences loaded:`, userPrefs);
            
            const viewModel = this.getModel("viewModel") as JSONModel;
            viewModel.setProperty("/userContext", {
                email: userPrefs.email || "",
                isAdmin: userPrefs.isAdmin || false,
                roles: userPrefs.roles ? JSON.parse(userPrefs.roles) : []
            });
            
        } catch (error) {
            console.warn("Could not load user context:", error);
            // Fallback to default values on error
            const viewModel = this.getModel("viewModel") as JSONModel;
            viewModel.setProperty("/userContext", {
                email: "",
                isAdmin: false,
                roles: []
            });
        }
    }

}