import UIComponent from "sap/ui/core/UIComponent";
import { createDeviceModel } from "./model/models";
import JSONModel from "sap/ui/model/json/JSONModel";

/**
 * Configuration Management App Component
 */
export default UIComponent.extend("admin.config.Component", {
    metadata: {
        manifest: "json"
    },

    /**
     * Component initialization
     */
    init: function() {
        // Call parent init
        UIComponent.prototype.init.apply(this, arguments);

        // Create device model
        this.setModel(createDeviceModel(), "device");

        // Create view model for app state
        const viewModel = new JSONModel({
            busy: false,
            selectedConfigId: null,
            editorConfig: {
                type: "json",
                showLineNumbers: true,
                showGutter: true,
                fontSize: "14px",
                theme: "monokai"
            },
            validation: {
                isValid: true,
                errors: [],
                warnings: []
            },
            filters: {
                showActiveOnly: false,
                searchQuery: ""
            }
        });
        this.setModel(viewModel, "viewModel");

        // Initialize router
        this.getRouter().initialize();
    }
});