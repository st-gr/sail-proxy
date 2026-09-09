import Control from "sap/ui/core/Control";
import Icon from "sap/ui/core/Icon";
import RenderManager from "sap/ui/core/RenderManager";
import formatter from "../model/formatter";

/**
 * A row of sap.ui.core.Icon built from two JSON arrays (capabilities, inputTypes) — a
 * capability/modality icon strip for the library card footer. A formatter cannot target an
 * aggregation binding, so this renders the icons itself instead of going through XML binding.
 *
 * @namespace admin.modellibrary.control
 */
export default class IconStrip extends Control {
  static readonly metadata = {
    properties: {
      capabilities: { type: "string", defaultValue: "[]" },
      inputTypes: { type: "string", defaultValue: "[]" }
    },
    aggregations: {
      _icons: { type: "sap.ui.core.Icon", multiple: true, visibility: "hidden" }
    }
  };

  static readonly renderer = {
    apiVersion: 2,
    render(rm: RenderManager, control: IconStrip): void {
      rm.openStart("div", control).class("mlCardIcons").openEnd();
      (control.getAggregation("_icons") as Icon[] | null || []).forEach((icon) => rm.renderControl(icon));
      rm.close("div");
    }
  };

  onBeforeRendering(): void {
    this.destroyAggregation("_icons");
    formatter.capabilityIcons(this.getCapabilities(), this.getInputTypes())
      .forEach((item) => this.addAggregation("_icons", new Icon({ src: item.icon, tooltip: item.tooltip, size: "0.75rem" }).addStyleClass("mlIconChip")));
  }

  getCapabilities(): string { return this.getProperty("capabilities"); }
  setCapabilities(value: string): this { return this.setProperty("capabilities", value); }
  getInputTypes(): string { return this.getProperty("inputTypes"); }
  setInputTypes(value: string): this { return this.setProperty("inputTypes", value); }
}
