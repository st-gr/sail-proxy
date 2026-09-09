import JSONModel from "sap/ui/model/json/JSONModel";
import Device from "sap/ui/Device";

export function createDeviceModel(): JSONModel {
  const model = new JSONModel(Device);
  model.setDefaultBindingMode("OneWay");
  return model;
}

/** Everything the views bind that is not OData. Filled by the controllers. */
export function initialViewState() {
  return {
    busy: false,
    isAdmin: false,
    email: "",
    entitlement: { catalogName: "", isDefault: true, unrestricted: false, modelIds: [] as string[] },
    library: {
      mode: "catalog",                     // catalog | leaderboard | chart
      search: "",
      count: 0,
      activeTokens: [] as { key: string; text: string }[], // active filters as "View settings" tokens (A4)
      selectMode: false,
      selectedCount: 0,
      filters: {
        capability: "all",                 // all | text | imageRecognition | imageGeneration | reasoning | embedding | speechToText
        inputTypes: { text: false, image: false, audio: false, video: false },
        provisioning: { hosted: false, managed: false, remote: false },
        providers: {} as Record<string, boolean>,
        accessType: { llmAccess: false, orchestration: false },
        other: { latestOnly: false, streaming: false, deployments: false }
      },
      providerList: [] as string[],
      // G: modelIds of the foundation models that have a deployment sibling — the "Deployed" tile
      // badge binds this map, filled once per library load by Library.controller.
      deployedBaseModels: {} as Record<string, boolean>,
      leaderboard: { columns: [] as string[], rows: [] as any[], scoredCount: 0 },
      chart: { x: "", y: "", xLabel: "", yLabel: "", keys: [] as string[], points: [] as any[] }
    },
    detail: {
      modelId: "", config: null as any, cuFactor: 0, cuFactorSource: "default", prices: [] as any[],
      deployments: [] as any[], deploying: false, deployStatus: "", catalogs: [] as any[]
    },
    // I: "dirty" is the catalog's unsaved state (header edits and staged list changes) — the
    // footer's Save/Discard bind it; "pendingCount"/"pendingText" count the staged changes and
    // "saving" holds the buttons dark while Save is on the wire.
    // J: "allUsers" is what libraryUsers() returned, "users" what the search leaves of it, and the
    // two counters drive the Assignments toolbar's buttons.
    // L: "membersSnapshot"/"exclusionsSnapshot" are what the server holds; "members"/"exclusions"
    // are those rows with the staged changes laid over them (catalogPending.ts).
    // "mode" is which of the two objects the view manages — entitlement catalogs or quota profiles.
    // Everything below it is shared: one selection, one staged set of changes, one Save.
    catalogs: {
      mode: "catalogs",                      // catalogs | profiles (the profiles mode is admin-only)
      // The selected object as the detail Page's own controls read it: the Page carries no element
      // binding (the two modes are different entity types — see Catalogs.view.xml), so its title and
      // the tab/button visibilities come from here instead of from the entity.
      selectedId: "", selectedName: "", selectedIsDefault: false, selectedOwnerEmail: "",
      layout: "OneColumn", dirty: false, pendingCount: 0, pendingText: "", saving: false,
      membersSnapshot: [] as any[], members: [] as any[], exclusionsSnapshot: [] as any[], exclusions: [] as any[],
      allUsers: [] as any[], users: [] as any[], userQuery: "",
      selectedUserCount: 0, selectedAssignedCount: 0
    }
  };
}
