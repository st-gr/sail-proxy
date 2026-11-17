import Controller from "sap/ui/core/mvc/Controller";
import JSONModel from "sap/ui/model/json/JSONModel";
import type View from "sap/ui/core/mvc/View";
import type LoggingSettingsController from "./LoggingSettings.controller";

/**
 * The Logs page: which tab is open (the model "logsUi", bound two-way to the tab bar, so a tab another
 * tab opens counts too), and the footer of the Switches and levels tab, whose buttons go to that tab's
 * controller.
 * @namespace admin.logs.controller
 */
export default class LogsController extends Controller {

    public onInit(): void {
        this.getView()!.setModel(new JSONModel({ tab: "log" }), "logsUi");
    }

    private settings(): LoggingSettingsController | null {
        const view = this.byId("settingsView") as View | undefined;
        return view ? (view.getController() as unknown as LoggingSettingsController) : null;
    }

    public onSaveSettings(): void { this.settings()?.onSave(); }

    public onResetSettings(): void { this.settings()?.onReset(); }

    public onCancelSettings(): void { this.settings()?.onCancel(); }
}
