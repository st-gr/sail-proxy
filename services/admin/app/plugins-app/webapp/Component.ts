import UIComponent from "sap/ui/core/UIComponent";

/**
 * Plugins: an admin installs, enables and removes gateway plugins here. The shell mounts this
 * component for the "Plugins" navigation entry. The screen is controller/Plugins.controller.ts.
 */
export default UIComponent.extend("admin.plugins.Component", {
  metadata: { manifest: "json" },

  init: function () {
    UIComponent.prototype.init.call(this);
    this.getRouter().initialize();
  }
});
