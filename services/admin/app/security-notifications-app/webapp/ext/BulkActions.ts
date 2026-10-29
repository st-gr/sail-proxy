import MessageToast from "sap/m/MessageToast";
import MessageBox from "sap/m/MessageBox";
import ResourceBundle from "sap/base/i18n/ResourceBundle";

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
        let bundle: ResourceBundle;
        try {
            bundle = await getBundle();
        } catch (error) {
            MessageBox.error(String(error));
            return;
        }

        if (!aSelectedContexts || aSelectedContexts.length === 0) {
            MessageToast.show(bundle.getText("selectToMarkSeen") as string);
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
            
            MessageToast.show(bundle.getText("markedAsSeen", [aIDs.length]) as string);
            console.log("✅ Bulk mark as seen completed successfully");

        } catch (oError) {
            MessageToast.show(bundle.getText("errorMarkingSeen") as string);
            console.error("❌ Bulk mark as seen error:", oError);
        }
    },

    /**
     * Bulk action to delete selected notifications (admin only)
     * Called directly from Fiori Elements List Report actions
     */
    onBulkDelete: async function(oBindingContext: any, aSelectedContexts: any[]): Promise<void> {
        console.log("🎉 BulkActions.onBulkDelete called!", { oBindingContext, aSelectedContexts });
        let bundle: ResourceBundle;
        try {
            bundle = await getBundle();
        } catch (error) {
            MessageBox.error(String(error));
            return;
        }

        if (!aSelectedContexts || aSelectedContexts.length === 0) {
            MessageToast.show(bundle.getText("selectToDelete") as string);
            return;
        }

        const aIDs: string[] = aSelectedContexts.map((oContext: any) => oContext.getProperty("ID"));
        console.log("Selected notification IDs for deletion:", aIDs);

        MessageBox.confirm(
            bundle.getText("deleteConfirmBulk", [aSelectedContexts.length]) as string,
            {
                title: bundle.getText("confirmDeletionTitle") as string,
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
                                MessageToast.show(bundle.getText("processedCount", [aIDs.length]) as string);
                            }
                            console.log("✅ Bulk delete completed:", oResponse);

                        } catch (oError) {
                            MessageToast.show(bundle.getText("errorDeleting") as string);
                            console.error("❌ Bulk delete error:", oError);
                        }
                    }
                }
            }
        );
    }
};