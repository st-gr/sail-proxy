import UIComponent from "sap/ui/core/UIComponent";
import JSONModel from "sap/ui/model/json/JSONModel";
import { createDeviceModel } from "./model/models";
import { initialViewState } from "./model/models";

/**
 * Model Library — the shell mounts this component for both the "Model Library" and the
 * "Entitlements & Quotas" navigation entries and navigates its router to `library` or `catalogs`.
 */
export default UIComponent.extend("admin.modellibrary.Component", {
  metadata: { manifest: "json" },

  init: function () {
    UIComponent.prototype.init.apply(this, arguments);
    this.setModel(createDeviceModel(), "device");
    this.setModel(new JSONModel(initialViewState()), "viewModel");
    this.getRouter().initialize();
  }
});
