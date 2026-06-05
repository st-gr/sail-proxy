import MessageToast from "sap/m/MessageToast";
import MessageBox from "sap/m/MessageBox";

/**
 * Bulk action handlers for Security Notifications
 * Standalone module for direct use in manifest.json
 */
export default {
    /**
     * Bulk action to mark selected notifications as seen
     * Called directly from Fiori Elements List Report actions
     */
    onBulkMarkAsSeen: async function(oBindingContext: any, aSelectedContexts: any[]): Promise<void> {
        console.log("🎉 BulkActions.onBulkMarkAsSeen called!", { oBindingContext, aSelectedContexts });
        
        if (!aSelectedContexts || aSelectedContexts.length === 0) {
            MessageToast.show("Please select notifications to mark as seen");
            return;
        }

        const aIDs: string[] = aSelectedContexts.map((oContext: any) => oContext.getProperty("ID"));
        console.log("Selected notification IDs:", aIDs);
        
        try {
            // Get the model from the binding context
            const oModel = oBindingContext?.getModel() || aSelectedContexts[0]?.getModel();
            if (!oModel) {
                throw new Error("Could not get OData model");
            }

            // Call the bulk action using the model's callFunction method
            const oBinding = oModel.bindContext("/bulkMarkNotificationsSeen(...)");
            await oBinding.setParameter("IDs", aIDs).execute();
            
            // Refresh the list
            if (aSelectedContexts[0]?.getBinding) {
                const oListBinding = aSelectedContexts[0].getBinding();
                await oListBinding?.refresh();
            }
            
            MessageToast.show(`Marked ${aIDs.length} notification(s) as seen`);
            console.log("✅ Bulk mark as seen completed successfully");
            
        } catch (oError) {
            MessageToast.show("Error marking notifications as seen");
            console.error("❌ Bulk mark as seen error:", oError);
        }
    },

    /**
     * Bulk action to delete selected notifications (admin only)
     * Called directly from Fiori Elements List Report actions
     */
    onBulkDelete: function(oBindingContext: any, aSelectedContexts: any[]): void {
        console.log("🎉 BulkActions.onBulkDelete called!", { oBindingContext, aSelectedContexts });
        
        if (!aSelectedContexts || aSelectedContexts.length === 0) {
            MessageToast.show("Please select notifications to delete");
            return;
        }

        const aIDs: string[] = aSelectedContexts.map((oContext: any) => oContext.getProperty("ID"));
        console.log("Selected notification IDs for deletion:", aIDs);
        
        MessageBox.confirm(
            `Delete ${aSelectedContexts.length} notification(s)?`,
            {
                title: "Confirm Deletion",
                onClose: async (sAction: string) => {
                    if (sAction === MessageBox.Action.OK) {
                        try {
                            // Get the model from the binding context
                            const oModel = oBindingContext?.getModel() || aSelectedContexts[0]?.getModel();
                            if (!oModel) {
                                throw new Error("Could not get OData model");
                            }

                            // Call the bulk delete action using the model's callFunction method
                            const oBinding = oModel.bindContext("/bulkDeleteSecurityNotifications(...)");
                            oBinding.setParameter("IDs", aIDs);
                            await oBinding.execute();
                            
                            // Get the response from the backend
                            const oResponse = oBinding.getBoundContext()?.getObject();
                            
                            // Refresh the list
                            if (aSelectedContexts[0]?.getBinding) {
                                const oListBinding = aSelectedContexts[0].getBinding();
                                await oListBinding?.refresh();
                            }
                            
                            // Show the actual response message from the backend
                            if (oResponse?.message) {
                                if (oResponse.success) {
                                    MessageToast.show(oResponse.message);
                                } else {
                                    MessageBox.error(oResponse.message);
                                }
                            } else {
                                // Fallback message if response is not structured as expected
                                MessageToast.show(`Processed ${aIDs.length} notification(s)`);
                            }
                            console.log("✅ Bulk delete completed:", oResponse);
                            
                        } catch (oError) {
                            MessageToast.show("Error deleting notifications");
                            console.error("❌ Bulk delete error:", oError);
                        }
                    }
                }
            }
        );
    }
};