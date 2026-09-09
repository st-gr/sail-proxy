import Controller from "sap/ui/core/mvc/Controller";
import JSONModel from "sap/ui/model/json/JSONModel";
import ODataModel from "sap/ui/model/odata/v4/ODataModel";
import ODataListBinding from "sap/ui/model/odata/v4/ODataListBinding";
import UIComponent from "sap/ui/core/UIComponent";
import MessageBox from "sap/m/MessageBox";
import MessageToast from "sap/m/MessageToast";
import Fragment from "sap/ui/core/Fragment";
import Dialog from "sap/m/Dialog";
import ResponsivePopover from "sap/m/ResponsivePopover";
import * as session from "../model/session";
import { parseScores, BENCHMARK_LABELS, SAFETY_KEYS } from "../model/benchmarks";
import { costRows } from "../model/costDisplay";
import { pollUntilSettled, messageFor } from "../model/deploymentPoll";
import { ownCatalogsFilter, catalogPickSearch, catalogPickCancel } from "../model/catalogPicker";

/**
 * @namespace admin.modellibrary.controller
 */
export default class DetailController extends Controller {
  private modelId = "";
  private priceDialog: Dialog | null = null;

  private vm(): JSONModel { return this.getOwnerComponent()!.getModel("viewModel") as JSONModel; }
  private odata(): ODataModel { return this.getOwnerComponent()!.getModel() as ODataModel; }
  private router() { return (this.getOwnerComponent() as UIComponent).getRouter(); }
  private entityPath(): string { return `/LibraryModels('${this.modelId.replace(/'/g, "''")}')`; }

  public onInit(): void {
    this.router().getRoute("detail")!.attachPatternMatched(this.onRouteMatched, this);
    session.load(this.odata()).then((s) => {
      this.vm().setProperty("/isAdmin", s.isAdmin);
      this.vm().setProperty("/email", s.email);
      this.updateCanDeploy();
    }).catch(() => undefined);
  }

  /** Deploy is offered to admins for a foundation model that has no live deployment yet. */
  private updateCanDeploy(): void {
    const d = this.vm().getProperty("/detail") || {};
    this.vm().setProperty("/detail/canDeploy", !!this.vm().getProperty("/isAdmin") && d.accessType === "foundation" && !d.deployed);
  }

  private onRouteMatched(e: any): void {
    this.modelId = decodeURIComponent(e.getParameter("arguments").modelId);
    this.vm().setProperty("/detail", {
      ...this.vm().getProperty("/detail"),
      modelId: this.modelId, configView: "rows", metrics: { safety: [], quality: [] },
      costRows: [], prices: [], hasManualPrice: false, deployments: [], deploymentsFetched: false, catalogs: [],
      capabilities: [], inputTypes: [], deploymentId: "", deployed: false, canDeploy: false, accessType: "", deploying: false, deployStatus: "",
      config: { overrideRows: [], providerRows: [], overrideJson: "", providerJson: "", providerKey: "" }
    });
    // autoExpandSelect only requests what the view binds; the controller reads these columns itself.
    const controllerColumns = "benchmarks,capabilities,inputTypes,deployment,provider,accessType,sapInputCost,sapOutputCost,sapCacheReadCost,sapCacheCreationCost";
    this.getView()!.bindElement({ path: this.entityPath(), parameters: { $select: controllerColumns }, events: { dataReceived: () => this.onModelLoaded() } });
  }

  private onModelLoaded(): void {
    const ctx = this.getView()!.getBindingContext();
    if (!ctx || !ctx.getObject()) {
      MessageBox.error(`Model ${this.modelId} is not in your entitlement or does not exist.`, { onClose: () => this.onNavBack() });
      return;
    }
    const m = ctx.getObject() as any;
    // Metrics
    const scores = parseScores(m.benchmarks);
    const toRows = (keys: string[]) => keys.filter((k) => scores[k] !== undefined).map((k) => ({ label: BENCHMARK_LABELS[k] || k, value: String(scores[k]) }));
    this.vm().setProperty("/detail/metrics", { safety: toRows(SAFETY_KEYS), quality: toRows(Object.keys(BENCHMARK_LABELS).filter((k) => !SAFETY_KEYS.includes(k))) });
    // Properties
    const arr = (j: string) => { try { const v = JSON.parse(j || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };
    const nice = (s: string) => s.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
    this.vm().setProperty("/detail/capabilities", arr(m.capabilities).map(nice));
    this.vm().setProperty("/detail/inputTypes", arr(m.inputTypes).map(nice));
    // Deployment id: deployment rows carry it in their own JSON; a foundation model is "deployed"
    // when the gateway lists a live deployment sibling (accessType 'deployment', same baseModel).
    this.vm().setProperty("/detail/accessType", m.accessType);
    this.applyDeployment(m.deployment);
    if (m.accessType === "foundation") this.loadDeployedSibling();
    this.loadConfigContext(m);
    this.loadPrices(m);
    this.loadCatalogs();
  }

  private applyDeployment(json: string | null): void {
    try {
      const d = JSON.parse(json || "null");
      const id = d?.deploymentUrl ? d.deploymentUrl.split("/").pop() : (d?.configurationName || "");
      this.vm().setProperty("/detail/deploymentId", id);
      this.vm().setProperty("/detail/deployed", !!id);
    } catch { this.vm().setProperty("/detail/deploymentId", ""); this.vm().setProperty("/detail/deployed", false); }
    this.updateCanDeploy();
  }

  private loadDeployedSibling(): void {
    const modelId = this.modelId;
    const q = modelId.replace(/'/g, "''");
    const lb = this.odata().bindList("/LibraryModels", undefined, [], undefined, {
      $filter: `baseModel eq '${q}' and accessType eq 'deployment'`, $select: "modelId,deployment"
    }) as ODataListBinding;
    lb.requestContexts(0, 5).then((ctxs) => {
      if (this.modelId !== modelId) return; // the page moved on
      const withId = ctxs.map((c) => c.getObject() as any).find((r) => r.deployment);
      if (withId) this.applyDeployment(withId.deployment);
    }).catch(() => undefined);
  }

  private loadConfigContext(m: any): void {
    const b = this.odata().bindContext(`${this.entityPath()}/AdminService.configContext(...)`);
    b.invoke().then(() => {
      const c = b.getBoundContext().getObject() as any;
      const rowsOf = (json: string | null) => {
        try {
          const o = JSON.parse(json || "null");
          return o && typeof o === "object" ? Object.entries(o).map(([key, value]) => ({ key, value: typeof value === "object" ? JSON.stringify(value) : String(value) })) : [];
        } catch { return []; }
      };
      const pre = (json: string | null) => json ? `<pre>${JSON.stringify(JSON.parse(json), null, 2).replace(/[<&]/g, (ch) => ch === "<" ? "&lt;" : "&amp;")}</pre>` : "";
      this.vm().setProperty("/detail/config", {
        overrideRows: rowsOf(c.override), providerRows: rowsOf(c.providerSettings),
        overrideJson: pre(c.override), providerJson: pre(c.providerSettings),
        providerKey: (m.provider || "").toLowerCase().replace(/\s+/g, "-")
      });
      this.vm().setProperty("/detail/cuFactor", Number(c.cuFactor));
      this.vm().setProperty("/detail/cuFactorSource", c.cuFactorSource);
      this.refreshCostRows(m);
    }).catch((err: any) => {
      this.vm().setProperty("/detail/cuFactorSource", "default");
      this.vm().setProperty("/detail/cuFactor", 1.90385);
      this.refreshCostRows(m);
      MessageToast.show(`Configuration context unavailable: ${err?.message || err}`);
    });
  }

  private loadPrices(m: any): void {
    const lb = this.odata().bindList("/ModelPrices", undefined, [], undefined, { $filter: `model eq '${this.modelId.replace(/'/g, "''")}'`, $orderby: "dateFrom desc" }) as ODataListBinding;
    lb.requestContexts(0, 100).then((ctxs) => {
      const prices = ctxs.map((c) => c.getObject() as any);
      this.vm().setProperty("/detail/prices", prices);
      this.refreshCostRows(m);
    }).catch((err: any) => MessageBox.error(err?.message || String(err)));
  }

  private refreshCostRows(m: any): void {
    const prices: any[] = this.vm().getProperty("/detail/prices") || [];
    const current = prices.find((p) => String(p.dateTo).startsWith("9999")) || null;
    const cuFactor = this.vm().getProperty("/detail/cuFactor") || 1.90385;
    this.vm().setProperty("/detail/hasManualPrice", !!current && current.source === "manual");
    this.vm().setProperty("/detail/costRows", costRows(m, current, cuFactor));
  }

  public onNavBack(): void { this.router().navTo("library"); }
  public onRefreshDetail(): void { this.getView()!.getElementBinding()?.refresh(); }

  // ---- price editing (admin) ----
  public async onEditPrice(): Promise<void> {
    const m = this.getView()!.getBindingContext()!.getObject() as any;
    const prices: any[] = this.vm().getProperty("/detail/prices") || [];
    const current = prices.find((p) => String(p.dateTo).startsWith("9999"));
    this.vm().setProperty("/detail/priceEdit", {
      inputCost: current?.inputCost ?? m.sapInputCost ?? "",
      outputCost: current?.outputCost ?? m.sapOutputCost ?? "",
      cacheReadInputCost: current?.cacheReadInputCost ?? m.sapCacheReadCost ?? "",
      cacheCreationInputCost: current?.cacheCreationInputCost ?? m.sapCacheCreationCost ?? ""
    });
    if (!this.priceDialog) {
      try {
        this.priceDialog = await Fragment.load({ id: this.getView()!.getId(), name: "admin.modellibrary.view.PriceDialog", controller: this }) as Dialog;
      } catch (err: any) {
        MessageBox.error(err?.message || String(err));
        return;
      }
      this.getView()!.addDependent(this.priceDialog);
    }
    this.priceDialog.open();
  }

  public onCancelPrice(): void { this.priceDialog?.close(); }

  public onSavePrice(): void {
    const e = this.vm().getProperty("/detail/priceEdit");
    const b = this.odata().bindContext(`${this.entityPath()}/AdminService.setPrice(...)`);
    b.setParameter("inputCost", e.inputCost);
    b.setParameter("outputCost", e.outputCost);
    b.setParameter("cacheReadInputCost", e.cacheReadInputCost === "" ? null : e.cacheReadInputCost);
    b.setParameter("cacheCreationInputCost", e.cacheCreationInputCost === "" ? null : e.cacheCreationInputCost);
    b.invoke().then(() => {
      MessageToast.show("Price saved");
      this.priceDialog?.close();
      this.loadPrices(this.getView()!.getBindingContext()!.getObject());
    }).catch((err: any) => MessageBox.error(err?.message || String(err)));
  }

  public onRevertPrice(): void {
    const b = this.odata().bindContext(`${this.entityPath()}/AdminService.revertToSapPrice(...)`);
    b.invoke().then(() => {
      MessageToast.show("Reverted to the SAP price");
      this.loadPrices(this.getView()!.getBindingContext()!.getObject());
    }).catch((err: any) => MessageBox.error(err?.message || String(err)));
  }

  // ---- deployments (admin) ----
  public onFetchDeployments(): void {
    const b = this.odata().bindContext(`${this.entityPath()}/AdminService.fetchDeployments(...)`);
    this.vm().setProperty("/busy", true);
    b.invoke().then(() => {
      const r = b.getBoundContext().getObject() as any;
      const rows = r.value || r || [];
      this.vm().setProperty("/detail/deployments", rows);
      this.vm().setProperty("/detail/deploymentsFetched", true);
      // The sibling lookup (loadDeployedSibling) may not have found a live deployment yet
      // (e.g. it just landed, or the sibling row's JSON was stale) - a RUNNING row here is as good a source.
      if (!this.vm().getProperty("/detail/deployed")) {
        const running = rows.find((d: any) => d.status === "RUNNING");
        if (running) {
          this.vm().setProperty("/detail/deploymentId", running.id);
          this.vm().setProperty("/detail/deployed", true);
          this.updateCanDeploy();
        }
      }
    }).catch((err: any) => MessageBox.error(err?.message || String(err))).finally(() => this.vm().setProperty("/busy", false));
  }

  /** Header "Model Deployments" link: fetches on first press (same as the Deployments section button), opens the popover once fetched. */
  public onDeploymentsLinkPress(e: any): void {
    if (!this.vm().getProperty("/detail/deploymentsFetched")) { this.onFetchDeployments(); return; }
    (this.byId("deploymentsPopover") as ResponsivePopover).openBy(e.getSource());
  }

  /** Popover title from the i18n pattern (bound as the first part — the resource bundle is async). */
  public formatDeploymentsTitle(pattern: string, deployments: any[]): string {
    const n = Array.isArray(deployments) ? deployments.length : 0;
    return (pattern || "Model Deployments ({0})").replace("{0}", String(n));
  }

  /** The i18n model's bundle is loaded asynchronously here, so getResourceBundle() is a promise. */
  private async text(key: string, args?: any[]): Promise<string> {
    const bundle = await (this.getView()!.getModel("i18n") as any).getResourceBundle();
    return bundle.getText(key, args);
  }

  public onCopyDeploymentId(e: any): void {
    const id = e.getSource().getBindingContext("viewModel").getProperty("id");
    navigator.clipboard.writeText(id).then(async () => MessageToast.show(await this.text("deploymentIdCopied")))
      .catch((err: any) => MessageBox.error(err?.message || String(err)));
  }

  public async onDeploy(): Promise<void> {
    if (this.vm().getProperty("/detail/deploying")) return;   // a deploy/poll is already in flight for this page
    const m = this.getView()!.getBindingContext()!.getObject() as any;
    const text = await this.text("deployConfirm", [m.displayName || m.modelId]);
    MessageBox.confirm(text, { title: "Create deployment", actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL], emphasizedAction: MessageBox.Action.OK, onClose: (a: string) => { if (a === MessageBox.Action.OK) this.deploy(); } });
  }

  /**
   * The poll captures the modelId it started for; the detail route is reused across
   * navigations (onRouteMatched only overwrites this.modelId), so a poll for model A that
   * settles after the user has moved on to model B must not toast/refresh/error against B's
   * page. Every step after an await re-checks this.modelId and simply drops stale results.
   */
  private deploy(): void {
    const modelId = this.modelId;
    const b = this.odata().bindContext(`${this.entityPath()}/AdminService.deploy(...)`);
    this.vm().setProperty("/detail/deploying", true);
    this.vm().setProperty("/detail/deployStatus", "Creating deployment…");
    b.invoke().then(async () => {
      if (this.modelId !== modelId) return;
      const r = b.getBoundContext().getObject() as any;
      this.vm().setProperty("/detail/deployStatus", `Deployment ${r.deploymentId} created (${r.reusedConfiguration ? "reused" : "new"} configuration ${r.configurationId}); waiting for RUNNING…`);
      const result = await pollUntilSettled(async () => {
        const s = this.odata().bindContext(`/deploymentStatus(deploymentId='${String(r.deploymentId).replace(/'/g, "''")}')`);
        await s.invoke();
        return (s.getBoundContext().getObject() as any).status;
      });
      if (this.modelId !== modelId) return;   // settled after leaving this model's page: drop it
      this.vm().setProperty("/detail/deployStatus", `${messageFor(result)} (deployment ${r.deploymentId})`);
      if (result.outcome === "running") { MessageToast.show(messageFor(result)); this.onFetchDeployments(); this.getView()!.getElementBinding()?.refresh(); }
      else MessageBox.warning(messageFor(result));
    }).catch((err: any) => {
      if (this.modelId !== modelId) return;
      this.vm().setProperty("/detail/deployStatus", "");
      MessageBox.error(err?.message || String(err));
    }).finally(() => { if (this.modelId === modelId) this.vm().setProperty("/detail/deploying", false); });
  }

  // ---- catalogs containing this model ----
  private loadCatalogs(): void {
    const lb = this.odata().bindList("/ModelCatalogMembers", undefined, [], undefined, { $filter: `modelId eq '${this.modelId.replace(/'/g, "''")}'`, $expand: "catalog($select=ID,name,ownerEmail,isDefault)" }) as ODataListBinding;
    lb.requestContexts(0, 200).then((ctxs) => {
      const email = this.vm().getProperty("/email"); const isAdmin = this.vm().getProperty("/isAdmin");
      this.vm().setProperty("/detail/catalogs", ctxs.map((c) => c.getObject() as any).filter((r) => r.catalog).map((r) => ({ id: r.catalog.ID, name: r.catalog.name, ownerEmail: r.catalog.ownerEmail, canEdit: isAdmin || r.catalog.ownerEmail === email })));
    }).catch((err: any) => MessageBox.error(err?.message || String(err)));
  }

  private catalogPicker: any = null;
  public async onAddToCatalog(): Promise<void> {
    if (!this.catalogPicker) {
      try {
        this.catalogPicker = await Fragment.load({ id: this.getView()!.getId(), name: "admin.modellibrary.view.AddModelsDialog", controller: this });
      } catch (err: any) {
        MessageBox.error(err?.message || String(err));
        return;
      }
      this.getView()!.addDependent(this.catalogPicker);
    }
    // Users may only pick catalogs they own; admins any non-default catalog.
    const email = this.vm().getProperty("/email"); const isAdmin = this.vm().getProperty("/isAdmin");
    (this.catalogPicker.getBinding("items") as ODataListBinding).changeParameters({ $filter: ownCatalogsFilter(isAdmin, email) });
    this.catalogPicker.open();
  }

  public onCatalogPickCancel(e: any): void { catalogPickCancel(e); }

  public onCatalogPickSearch(e: any): void { catalogPickSearch(e); }

  public onCatalogPicked(e: any): void {
    const item = e.getParameter("selectedItem"); if (!item) return;
    const catalogId = item.getBindingContext().getProperty("ID");
    this.addModelsTo(catalogId, [this.modelId]).then(() => this.loadCatalogs());
  }

  /** Shared with the Library: addModels on one catalog, reporting prunes and the 400 for out-of-parent ids. */
  private addModelsTo(catalogId: string, modelIds: string[]): Promise<void> {
    const b = this.odata().bindContext(`/ModelCatalogs(${catalogId})/AdminService.addModels(...)`);
    b.setParameter("modelIds", modelIds);
    return b.invoke().then(() => { const r = b.getBoundContext().getObject() as any; MessageToast.show(`${r.added} model(s) added`); })
      .catch((err: any) => { MessageBox.error(err?.message || String(err)); });
  }

  public onRemoveFromCatalog(e: any): void {
    const row = e.getSource().getBindingContext("viewModel").getObject();
    const b = this.odata().bindContext(`/ModelCatalogs(${row.id})/AdminService.removeModels(...)`);
    b.setParameter("modelIds", [this.modelId]);
    b.invoke().then(() => { const r = b.getBoundContext().getObject() as any; MessageToast.show(r.prunedFromChildren ? `Removed; ${r.prunedFromChildren} model(s) were also removed from child catalogs.` : "Removed"); this.loadCatalogs(); })
      .catch((err: any) => MessageBox.error(err?.message || String(err)));
  }
}
