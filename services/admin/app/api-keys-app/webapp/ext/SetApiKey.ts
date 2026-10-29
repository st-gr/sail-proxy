import Dialog from "sap/m/Dialog";
import Input from "sap/m/Input";
import Label from "sap/m/Label";
import Button from "sap/m/Button";
import Text from "sap/m/Text";
import MessageBox from "sap/m/MessageBox";
import Device from "sap/ui/Device";
import { ValueState } from "sap/ui/core/library";
import { ButtonType, InputType } from "sap/m/library";
import Context from "sap/ui/model/odata/v4/Context";
import ODataContextBinding from "sap/ui/model/odata/v4/ODataContextBinding";
import SimpleForm from "sap/ui/layout/form/SimpleForm";
import Title from "sap/m/Title";
import ResourceBundle from "sap/base/i18n/ResourceBundle";

/** What AdminService.updateApiKeyValue returns (admin-service.cds). */
type UpdateApiKeyResult = { success?: boolean | null; message?: string | null };

let bundlePromise: Promise<ResourceBundle> | undefined;

/** The app's i18n bundle, loaded once for the user's language. */
function getBundle(): Promise<ResourceBundle> {
    if (!bundlePromise) {
        bundlePromise = ResourceBundle.create({
            bundleName: "admin.app.i18n.i18n",
            async: true,
            supportedLocales: ["", "de", "es", "fr", "it", "nl", "pt"],
            fallbackLocale: ""
        }) as Promise<ResourceBundle>;
    }
    return bundlePromise;
}

/**
 * Custom action handler for "Set API Key" functionality
 */
export default {
    /**
     * Determines if the "Set API Key" action is visible (only in display mode)
     * @param oBindingContext - The binding context
     * @param aSelectedContexts - Selected contexts (not used for single object)
     * @returns True if action should be visible
     */
    isVisible: function (oBindingContext: Context, aSelectedContexts: Context[]): boolean {
        // Only show in display mode (not in draft/edit mode)
        return oBindingContext && oBindingContext.getProperty("IsActiveEntity") === true;
    },

    /**
     * Handle the "Set API Key" action button press
     * @param oBindingContext - The binding context
     * @param aSelectedContexts - Selected contexts (not used for single object)
     */
    onSetApiKey: async function (oBindingContext: Context, aSelectedContexts: Context[]): Promise<void> {
        let bundle: ResourceBundle;
        try {
            bundle = await getBundle();
        } catch (error) {
            MessageBox.error(String(error));
            return;
        }
        if (!oBindingContext) {
            MessageBox.error(bundle.getText("noContextAvailable") as string);
            return;
        }
        
        const oModel = oBindingContext.getModel();
        const sKeyId = oBindingContext.getProperty("ID") as string;
        const sCurrentKey = oBindingContext.getProperty("key") as string;

        // Create input field with proper Fiori patterns
        const oInput = new Input({
            type: InputType.Text,
            placeholder: "sk-...",
            liveChange: function(oEvent) {
                // Live validation - lightweight
                const sValue = (oEvent.getParameter("value") ?? "").trim();
                if (!sValue) {
                    oInput.setValueState(ValueState.None);
                    return;
                }
                if (!/^sk-[A-Za-z0-9_-]{16,}$/.test(sValue)) {
                    oInput.setValueState(ValueState.Warning);
                    oInput.setValueStateText(bundle.getText("keyShouldStart") as string);
                } else {
                    oInput.setValueState(ValueState.None);
                }
            },
            submit: function() {
                const oBeginButton = oDialog.getBeginButton() as Button;
                oBeginButton?.firePress();
            }
        });

        // Show only last 4 characters of current key (security best practice)
        const sObscured = sCurrentKey ? bundle.getText("currentKey", [sCurrentKey.slice(-4)]) : "";

        // Create simple form
        const oContent = new SimpleForm({
            editable: true,
            layout: "ResponsiveGridLayout",
            content: [
                // Helper text section
                new Text({
                    text: bundle.getText("setApiKeyHelp")
                }),

                // Form fields section
                new Label({
                    text: bundle.getText("newApiKey"),
                    required: true
                }),
                oInput,
                
                // Current key info (if available)
                ...(sCurrentKey ? [
                    new Text({ text: sObscured })
                ] : [])
            ]
        });

        // Create dialog
        const oDialog = new Dialog({
            title: bundle.getText("replaceApiKeyTitle"),
            content: oContent,
            contentWidth: "30rem",
            stretch: Device.system.phone,   // responsive on phones
            resizable: false,
            draggable: false,
            escapeHandler: function(oPromise) {
                oDialog.close();
                oPromise.resolve();
            },
            beginButton: new Button({
                text: bundle.getText("save"),
                type: ButtonType.Emphasized,
                press: async function () {
                    const sNewKey = oInput.getValue().trim();

                    // Simple required + format check
                    if (!sNewKey) {
                        oInput.setValueState(ValueState.Error);
                        oInput.setValueStateText(bundle.getText("pleaseEnterApiKey") as string);
                        oInput.focus();
                        return;
                    }
                    if (!/^sk-[A-Za-z0-9_-]{16,}$/.test(sNewKey)) {
                        oInput.setValueState(ValueState.Error);
                        oInput.setValueStateText(bundle.getText("apiKeyMustStart") as string);
                        oInput.focus();
                        return;
                    }

                    oDialog.setBusy(true);
                    try {
                        // Call the updateApiKeyValue action
                        const oOperationBinding = oModel.bindContext("/updateApiKeyValue(...)") as ODataContextBinding;
                        oOperationBinding.setParameter("keyId", sKeyId);
                        oOperationBinding.setParameter("newKey", sNewKey);
                        
                        const oContext = await oOperationBinding.execute("$auto");
                        const oResult = oOperationBinding.getBoundContext()?.getObject() as UpdateApiKeyResult | undefined;

                        // Check if the action was actually successful
                        if (oResult && oResult.success === false) {
                            // Backend returned success=false, show error
                            oDialog.setBusy(false);
                            MessageBox.error(oResult.message || (bundle.getText("failedToReplace") as string));
                            return;
                        }

                        // Request side effects to refresh the affected properties
                        await oBindingContext.requestSideEffects([
                            { $PropertyPath: "key" },
                            { $PropertyPath: "modifiedAt" },
                            { $PropertyPath: "modifiedBy" }
                        ]);

                        oDialog.setBusy(false);
                        oDialog.close();
                        MessageBox.success(oResult?.message || (bundle.getText("apiKeyReplaced") as string));
                    } catch (oError: any) {
                        oDialog.setBusy(false);
                        // Extract meaningful error message from OData error
                        let sErrorMessage = bundle.getText("failedToReplace") as string;
                        
                        if (oError.message) {
                            sErrorMessage = oError.message;
                        } else if (oError.error && oError.error.message) {
                            sErrorMessage = oError.error.message;
                        } else if (oError.responseText) {
                            try {
                                const oErrorData = JSON.parse(oError.responseText);
                                if (oErrorData.error && oErrorData.error.message) {
                                    sErrorMessage = oErrorData.error.message;
                                }
                            } catch (e) {
                                // Parsing failed, use default message
                            }
                        }
                        
                        MessageBox.error(sErrorMessage);
                    }
                }
            }),
            endButton: new Button({
                text: bundle.getText("cancel"),
                type: ButtonType.Transparent,
                press: function () {
                    oDialog.close();
                }
            }),
            afterOpen: function () {
                oInput.focus();
            },
            afterClose: function () {
                oDialog.destroy();
            }
        });

        // Set the model on the dialog
        oDialog.setModel(oModel);
        
        // Open dialog
        oDialog.open();
    }
};