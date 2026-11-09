import UIComponent from "sap/ui/core/UIComponent";
import JSONModel from "sap/ui/model/json/JSONModel";
import { GroundingApi, basePath } from "./model/api";
import type { Translator } from "./model/api";
import { availabilityOf } from "./model/status";
import { loadTeams } from "./model/teams";

/**
 * Grounding - the shell mounts this component for the "Vector Stores", "Files" and "Jobs" navigation
 * entries and navigates its router to `groundingStores`, `groundingFiles` or `groundingJobs`.
 */
export default UIComponent.extend("admin.grounding.Component", {
  metadata: { manifest: "json" },

  /** The pending or settled _load(); init starts it, reload replaces it. */
  _ready: undefined as Promise<GroundingApi> | undefined,

  init: function () {
    UIComponent.prototype.init.call(this);
    this.setModel(new JSONModel({ ready: false, available: false, reason: "", isAdmin: false, email: "", maxFileBytes: 0, teams: [] }), "viewModel");
    this._ready = this._load();
    this.getRouter().initialize();
  },

  /** The API, once whoami and the status call have answered. Never rejects. */
  whenReady: function (): Promise<GroundingApi> {
    return this._ready ?? this.reload();
  },

  /** Asks the gateway again whether file_search is available, for the "Try Again" button. */
  reload: function (): Promise<GroundingApi> {
    this._ready = this._load();
    return this._ready;
  },

  _load: async function (): Promise<GroundingApi> {
    const viewModel = this.getModel("viewModel") as JSONModel;
    let deployTarget = "development";
    try {
      const response = await fetch("/odata/v4/admin/whoami", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: "{}",
        credentials: "include"
      });
      if (response.ok) {
        const who = await response.json();
        deployTarget = who.deployTarget || "development";
        viewModel.setProperty("/isAdmin", who.isAdmin === true);
        viewModel.setProperty("/email", who.user || "");
      }
    } catch (error) {
      // The status call below tells the user what they need to know.
    }
    const fetchJson = async (url: string) => {
      const r = await fetch(url, { headers: { Accept: "application/json" }, credentials: "include" });
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    };
    viewModel.setProperty("/teams", await loadTeams(viewModel.getProperty("/isAdmin") === true, fetchJson));
    // The API's own error texts (unreachable, too large, failed status) come from the app's bundle;
    // without it they stay English, so this still never rejects
    let t: Translator | undefined;
    try {
      const bundle = await (this.getModel("i18n") as any).getResourceBundle();
      t = (key, args) => bundle.getText(key, args as any[]);
    } catch (error) {
      t = undefined;
    }
    const api = new GroundingApi(basePath(deployTarget), (input: string, init?: any) => fetch(input, init), t);
    const availability = availabilityOf(await api.status());
    viewModel.setProperty("/available", availability.available);
    viewModel.setProperty("/reason", availability.reason);
    viewModel.setProperty("/maxFileBytes", availability.maxFileBytes);
    viewModel.setProperty("/ready", true);
    return api;
  }
});
