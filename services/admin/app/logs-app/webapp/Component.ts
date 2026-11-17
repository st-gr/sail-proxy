import UIComponent from "sap/ui/core/UIComponent";

/**
 * Logs: the gateway's stored log and the logging switches and levels, for administrators. The shell
 * mounts this component for the "Logs" navigation entry under Settings. The tabs are
 * view/GatewayLog.view.xml and view/LoggingSettings.view.xml.
 */
export default UIComponent.extend("admin.logs.Component", {
  metadata: { manifest: "json" },

  init: function () {
    UIComponent.prototype.init.call(this);
    this.getRouter().initialize();
  }
});
