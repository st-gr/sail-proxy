import AppComponent from "sap/fe/core/AppComponent";
import JSONModel from "sap/ui/model/json/JSONModel";

/**
 * @namespace admin.securitynotifications
 */
export default class Component extends AppComponent {
    public static readonly metadata = {
        manifest: "json"
    };

    public init(): void {
        super.init();
        
        // Initialize user model for role-based visibility
        this.initUserModel();
    }

    private async initUserModel(): Promise<void> {
        try {
            // Get current user preferences from the service
            const response = await fetch('/odata/v4/admin/getCurrentUserPreferences', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            
            if (response.ok) {
                const userPrefs = await response.json();
                
                // Create comprehensive user model from flattened response
                const userModel = new JSONModel({
                    // Role-based capabilities
                    isAdmin: userPrefs.isAdmin,
                    isUser: userPrefs.isUser,
                    canDeleteOld: userPrefs.canDeleteOld,
                    canManageKeys: userPrefs.canManageKeys,
                    canManageAWS: userPrefs.canManageAWS,
                    
                    // User identity
                    email: userPrefs.email,
                    displayName: userPrefs.displayName,
                    
                    // UI preferences
                    sidePanelCollapsed: userPrefs.sidePanelCollapsed,
                    theme: userPrefs.theme,
                    density: userPrefs.density,
                    tablePageSize: userPrefs.tablePageSize,
                    
                    // App preferences
                    defaultNotificationFilter: userPrefs.defaultNotificationFilter,
                    showDismissedNotifications: userPrefs.showDismissedNotifications,
                    autoMarkAsSeenOnView: userPrefs.autoMarkAsSeenOnView
                });
                
                this.setModel(userModel, "user");
                console.log("User preferences loaded successfully:", { isAdmin: userPrefs.isAdmin });
            } else {
                console.warn("Failed to load user preferences, using fallback");
                await this.createFallbackUserModel();
            }
        } catch (error) {
            console.error("Failed to initialize user model:", error);
            await this.createFallbackUserModel();
        }
    }

    private async createFallbackUserModel(): Promise<void> {
        // Fallback - basic user model with safe defaults
        const userModel = new JSONModel({
            isAdmin: false,
            isUser: true,
            canDeleteOld: false,
            canManageKeys: false,
            canManageAWS: false,
            email: '',
            displayName: 'User',
            sidePanelCollapsed: false,
            theme: 'sap_horizon',
            density: 'cozy',
            tablePageSize: 50,
            showDismissedNotifications: false,
            autoMarkAsSeenOnView: true
        });
        this.setModel(userModel, "user");
    }
}