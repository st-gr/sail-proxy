import Controller from "sap/ui/core/mvc/Controller";
import JSONModel from "sap/ui/model/json/JSONModel";
import ODataModel from "sap/ui/model/odata/v4/ODataModel";
import ODataListBinding from "sap/ui/model/odata/v4/ODataListBinding";
import Context from "sap/ui/model/odata/v4/Context";
import UI5Event from "sap/ui/base/Event";
import MessageToast from "sap/m/MessageToast";
import MessageBox from "sap/m/MessageBox";
import RadioButtonGroup from "sap/m/RadioButtonGroup";
import CheckBox, { CheckBox$SelectEvent } from "sap/m/CheckBox";
import GridContainer from "sap/f/GridContainer";
import Card from "sap/f/Card";
import SearchField, { SearchField$SearchEvent, SearchField$LiveChangeEvent } from "sap/m/SearchField";
import VBox from "sap/m/VBox";
import HBox from "sap/m/HBox";
import Token from "sap/m/Token";
import UIComponent from "sap/ui/core/UIComponent";
import Column from "sap/ui/table/Column";
import Text from "sap/m/Text";
import Label from "sap/m/Label";
import Avatar from "sap/m/Avatar";
import Fragment from "sap/ui/core/Fragment";
import {
  buildFilterExpression, emptyFilters, activeTokens, resetFilterKey, resetFilterGroup,
  Capability, LibraryFilterState, FilterGroup
} from "../model/libraryFilters";
import { collectBenchmarkKeys, leaderboardRows, chartPoints, BENCHMARK_LABELS, benchmarkTooltip, ChartPoint } from "../model/benchmarks";
import { ownCatalogsFilter, catalogPickSearch, catalogPickCancel } from "../model/catalogPicker";
import { colorForIndex } from "../model/chartLayout";
import formatter from "../model/formatter";
import * as session from "../model/session";

const CAPABILITY_ORDER: Capability[] = ["all", "embedding", "imageGeneration", "imageRecognition", "reasoning", "speechToText", "text"];

/**
 * @namespace admin.modellibrary.controller
 */
export default class LibraryController extends Controller {
  private searchTimer: number | null = null;
  private selected = new Set<string>();
  private picker: any = null;

  private vm(): JSONModel { return this.getOwnerComponent()!.getModel("viewModel") as JSONModel; }
  private odata(): ODataModel { return this.getOwnerComponent()!.getModel() as ODataModel; }

  public onInit(): void {
    this.vm().setProperty("/library/filters", emptyFilters());
    session.load(this.odata()).then((s) => {
      this.vm().setProperty("/isAdmin", s.isAdmin);
      this.vm().setProperty("/email", s.email);
    }).catch(() => undefined);
    this.loadProviders();
    this.loadDeployedBaseModels();
    // The grid's items binding does not exist yet in onInit: the view gets its models only when the
    // router places it into the App, which is done by the time the route's patternMatched fires.
    (this.getOwnerComponent() as UIComponent).getRouter().getRoute("library")!.attachPatternMatched(() => {
      this.refreshEntitlement();
      this.applyFilters();
    });
  }

  private refreshEntitlement(): void {
    session.entitlement(this.odata()).then((e) => this.vm().setProperty("/entitlement", e)).catch(() => undefined);
  }

  /**
   * G1: which foundation models have a deployment sibling, for the "Deployed" tile badge. A
   * deployment row's baseModel is its foundation row's modelId, so one $select over the
   * deployment rows is enough — no per-card request. The server already hides the rows this
   * caller may not see.
   */
  private loadDeployedBaseModels(): void {
    const binding = this.odata().bindList("/LibraryModels", undefined, undefined, undefined,
      { $select: "baseModel", $filter: "accessType eq 'deployment'" }) as ODataListBinding;
    binding.requestContexts(0, 500).then((contexts) => {
      const map: Record<string, boolean> = {};
      contexts.forEach((c) => { const base = c.getProperty("baseModel") as string; if (base) map[base] = true; });
      this.vm().setProperty("/library/deployedBaseModels", map);
    }).catch(() => this.vm().setProperty("/library/deployedBaseModels", {}));
  }

  /** Distinct providers of the models this caller may see (the server filters LibraryModels per role). */
  private loadProviders(): void {
    const binding = this.odata().bindList("/LibraryModels", undefined, undefined, undefined, { $select: "provider", $orderby: "provider" }) as ODataListBinding;
    binding.requestContexts(0, 500).then((contexts) => {
      const names = [...new Set(contexts.map((c) => c.getProperty("provider") as string).filter(Boolean))].sort();
      this.vm().setProperty("/library/providerList", names);
    }).catch(() => this.vm().setProperty("/library/providerList", []));
  }

  private grid(): GridContainer { return this.byId("grid") as GridContainer; }
  private gridBinding(): ODataListBinding { return this.grid().getBinding("items") as ODataListBinding; }

  /**
   * Compile the sidebar state (+ search) into the grid binding's $filter/$search.
   * buildFilterExpression is the single place the "deployments hidden unless requested" rule
   * lives — its result is passed straight through: a null result clears $filter entirely.
   * Leaderboard/chart re-read the same filters (Task 3).
   */
  public applyFilters(): void {
    const state: LibraryFilterState = this.vm().getProperty("/library/filters");
    const expr = buildFilterExpression(state);
    this.vm().setProperty("/library/activeTokens", activeTokens(state));

    const search = (this.vm().getProperty("/library/search") as string || "").trim();
    const binding = this.gridBinding();
    if (!binding) return; // before the view is placed (no model yet); patternMatched applies the filters
    binding.changeParameters({
      $filter: expr ?? undefined,
      $search: search ? `"${search.replace(/"/g, '\\"')}"` : undefined
    });

    if (this.vm().getProperty("/library/mode") !== "catalog") this.loadTableData();
  }

  public onDataReceived(): void {
    const count = this.gridBinding().getCount();
    this.vm().setProperty("/library/count", count ?? this.gridBinding().getLength());
  }

  public onFilterChange(): void {
    const rbg = this.byId("capabilityGroup") as RadioButtonGroup;
    this.vm().setProperty("/library/filters/capability", CAPABILITY_ORDER[rbg.getSelectedIndex()] || "all");
    this.applyFilters();
  }

  public onProviderChange(e: CheckBox$SelectEvent): void {
    const cb = e.getSource() as CheckBox;
    const providers = { ...(this.vm().getProperty("/library/filters/providers") || {}) };
    providers[this.providerValue(cb)] = cb.getSelected();
    this.vm().setProperty("/library/filters/providers", providers);
    this.applyFilters();
  }

  /** L: the facet's label is not its value ("unknown" reads "Other"), so the filter key — which
   * has to match LibraryModels.provider — is read off the bound row, not off the CheckBox text. */
  private providerValue(cb: CheckBox): string {
    return cb.getBindingContext("viewModel")?.getObject() as unknown as string;
  }

  public onReset(): void {
    this.vm().setProperty("/library/filters", emptyFilters());
    (this.byId("capabilityGroup") as RadioButtonGroup).setSelectedIndex(0);
    this.providerCheckboxes().forEach((cb) => cb.setSelected(false));
    this.vm().setProperty("/library/search", "");
    (this.byId("searchField") as SearchField).setValue("");
    this.applyFilters();
  }

  /** The provider filter pane (A11) prefixes each CheckBox with its provider mark, so every row
   * is an HBox(Avatar, CheckBox) rather than a bare CheckBox — this finds the CheckBoxes inside. */
  private providerCheckboxes(): CheckBox[] {
    return (this.byId("providerBox") as VBox).getItems()
      .flatMap((row) => (row as HBox).getItems().filter((c) => c.isA("sap.m.CheckBox"))) as CheckBox[];
  }

  /** Reflects a programmatic filter-state change (token/group reset) back onto the controls that
   * are not two-way bound to /library/filters: the capability radio index and the provider CheckBoxes. */
  private syncFilterControls(state: LibraryFilterState): void {
    (this.byId("capabilityGroup") as RadioButtonGroup).setSelectedIndex(CAPABILITY_ORDER.indexOf(state.capability));
    this.providerCheckboxes().forEach((cb) => cb.setSelected(!!state.providers[this.providerValue(cb)]));
  }

  /** A "View settings" token's x (A4) — resets exactly the one filter the token came from. */
  public onTokenReset(e: UI5Event): void {
    const key = (e.getSource() as Token).getKey();
    const state = resetFilterKey(this.vm().getProperty("/library/filters"), key);
    this.vm().setProperty("/library/filters", state);
    this.syncFilterControls(state);
    this.applyFilters();
  }

  private resetGroup(group: FilterGroup): void {
    const state = resetFilterGroup(this.vm().getProperty("/library/filters"), group);
    this.vm().setProperty("/library/filters", state);
    this.syncFilterControls(state);
    this.applyFilters();
  }

  // Per-group reset icons in the filter pane (A7) — each clears only its own group.
  public onResetCapabilityGroup(): void { this.resetGroup("capability"); }
  public onResetInputTypesGroup(): void { this.resetGroup("inputTypes"); }
  public onResetProvisioningGroup(): void { this.resetGroup("provisioning"); }
  public onResetProviderGroup(): void { this.resetGroup("provider"); }
  public onResetAccessTypeGroup(): void { this.resetGroup("accessType"); }
  public onResetOtherGroup(): void { this.resetGroup("other"); }

  public onSearch(e: SearchField$SearchEvent): void {
    this.vm().setProperty("/library/search", e.getParameter("query") || "");
    this.applyFilters();
  }

  public onSearchLive(e: SearchField$LiveChangeEvent): void {
    if (this.searchTimer) window.clearTimeout(this.searchTimer);
    const value = e.getParameter("newValue") || "";
    this.searchTimer = window.setTimeout(() => {
      this.vm().setProperty("/library/search", value);
      this.applyFilters();
    }, 400);
  }

  public onCardPress(e: UI5Event): void {
    const ctx = (e.getSource() as Card).getBindingContext() as Context;
    (this.getOwnerComponent() as UIComponent).getRouter().navTo("detail", { modelId: encodeURIComponent(ctx.getProperty("modelId") as string) });
  }

  public onOpenCatalogs(): void {
    (this.getOwnerComponent() as UIComponent).getRouter().navTo("catalogs");
  }

  public onRefresh(): void {
    const binding = this.odata().bindContext("/refreshModelLibrary(...)");
    this.vm().setProperty("/busy", true);
    binding.invoke()
      .then(() => {
        const r = binding.getBoundContext().getObject() as any;
        MessageToast.show(`Refreshed: ${r.models} models, ${r.deployments} deployments, ${r.absent} absent`);
        this.gridBinding().refresh();
        this.loadProviders();
        this.loadDeployedBaseModels();
      })
      .catch((err: any) => MessageBox.error(err?.message || String(err)))
      .finally(() => this.vm().setProperty("/busy", false));
  }

  public onModeChange(): void {
    if (this.vm().getProperty("/library/mode") === "catalog") {
      const count = this.gridBinding().getCount();
      if (count !== undefined) this.vm().setProperty("/library/count", count);
    }
    this.applyFilters();
  }

  /**
   * Reads the currently filtered set once (max 500) and derives the leaderboard and the chart.
   * Reuses buildFilterExpression — same as applyFilters — so catalog, leaderboard and chart agree
   * on which models are in scope, with one deliberate difference (G3): "Show Deployments" is
   * forced off here. A deployment row repeats its base model's benchmarks and has none of its
   * own, so with the toggle on every scored model would be listed and plotted twice. Building the
   * expression from the amended state, rather than appending a clause, keeps the rule in the one
   * place it lives.
   */
  public loadTableData(): void {
    const state: LibraryFilterState = this.vm().getProperty("/library/filters");
    const expr = buildFilterExpression({ ...state, other: { ...state.other, deployments: false } });
    const search = (this.vm().getProperty("/library/search") as string || "").trim();
    const params: Record<string, string> = { $select: "modelId,displayName,provider,latestVersion,benchmarks", $orderby: "displayName" };
    if (expr) params.$filter = expr;
    if (search) params.$search = `"${search.replace(/"/g, '\\"')}"`;
    const lb = this.odata().bindList("/LibraryModels", undefined, undefined, undefined, params) as ODataListBinding;
    lb.requestContexts(0, 500).then((ctxs) => {
      const rows = ctxs.map((c) => c.getObject() as any);
      const keys = collectBenchmarkKeys(rows);
      const table = leaderboardRows(rows);
      this.vm().setProperty("/library/leaderboard", { columns: keys, rows: table, scoredCount: table.length });
      this.buildLeaderboardColumns(keys);
      const chart = this.vm().getProperty("/library/chart");
      const x = keys.includes(chart.x) ? chart.x : (keys[0] || "");
      const y = keys.includes(chart.y) && chart.y !== x ? chart.y : (keys.find((k) => k !== x) || "");
      this.vm().setProperty("/library/chart/keys", keys.map((k) => ({ key: k, label: BENCHMARK_LABELS[k] || k })));
      this.vm().setProperty("/library/chart/x", x);
      this.vm().setProperty("/library/chart/y", y);
      // C2: each point carries its legend/bubble colour (colorForIndex(i), same array order as
      // both the BubbleChart's own rendering and the legend list bound to this same path).
      this.vm().setProperty("/library/chart/points", chartPoints(rows, x, y).map((p, i) => ({ ...p, color: colorForIndex(i) })));
      this.renderChart();
    }).catch((err: any) => MessageBox.error(err?.message || String(err)));
  }

  /**
   * C1: the leaderboard's "Model" cell mirrors the library card — provider mark + bold name on
   * one line, "Version: <latestVersion>" (grey) underneath — instead of "name (id)".
   */
  private buildLeaderboardColumns(keys: string[]): void {
    const table = this.byId("leaderboard") as any;
    table.destroyColumns();
    table.addColumn(new Column({
      label: new Label({ text: "Model" }), width: "22rem", sortProperty: "displayName",
      template: new HBox({ alignItems: "Center", items: [
        // The model prefix belongs in a separate "model" field, never embedded in "path" — an
        // earlier batch hit this exact bug (see Library.controller.ts's providerBox row / A11).
        new Avatar({
          displaySize: "XS", displayShape: "Square",
          src: { path: "provider", model: "viewModel", formatter: formatter.providerSrc },
          initials: { path: "provider", model: "viewModel", formatter: formatter.providerInitials }
        }).addStyleClass("sapUiTinyMarginEnd"),
        new VBox({ items: [
          new Text({ text: "{viewModel>displayName}" }).addStyleClass("mlCardName"),
          new Text({ text: { path: "latestVersion", model: "viewModel", formatter: formatter.version } }).addStyleClass("mlCardId")
        ] })
      ] })
    }));
    keys.forEach((k) => table.addColumn(new Column({
      // H: the hint tells the reader to hover a metric name for more information, so the tooltip
      // is the label plus its plain-language sentence (source, scale, direction) — repeating the
      // label alone told them nothing they could not already read in the header.
      label: new Label({ text: BENCHMARK_LABELS[k] || k, tooltip: benchmarkTooltip(k), wrapping: true }),
      sortProperty: `scores/${k}`, hAlign: "End",
      template: new Text({ text: `{viewModel>scores/${k}}` })
    })));
  }

  /** The BubbleChart control is bound to /library/chart/points and re-renders on the property change. */
  private renderChart(): void {
    const st = this.vm().getProperty("/library/chart");
    this.vm().setProperty("/library/chart/xLabel", BENCHMARK_LABELS[st.x] || st.x);
    this.vm().setProperty("/library/chart/yLabel", BENCHMARK_LABELS[st.y] || st.y);
  }

  public onChartBubblePress(e: UI5Event<{ point: ChartPoint }>): void {
    const point = e.getParameter("point");
    if (point?.modelId) (this.getOwnerComponent() as UIComponent).getRouter().navTo("detail", { modelId: encodeURIComponent(point.modelId) });
  }

  public onChartAxisChange(): void { this.loadTableData(); }

  public onSwapAxes(): void {
    const st = this.vm().getProperty("/library/chart");
    this.vm().setProperty("/library/chart/x", st.y);
    this.vm().setProperty("/library/chart/y", st.x);
    this.loadTableData();
  }

  // ---- multi-select and "Add to catalog" from the grid ----
  public onCardSelect(e: any): void {
    const id = e.getSource().getBindingContext().getProperty("modelId");
    if (e.getParameter("selected")) this.selected.add(id); else this.selected.delete(id);
    this.vm().setProperty("/library/selectedCount", this.selected.size);
  }

  public async onAddSelectedToCatalog(): Promise<void> {
    if (!this.picker) {
      try {
        this.picker = await Fragment.load({ id: this.getView()!.getId(), name: "admin.modellibrary.view.AddModelsDialog", controller: this });
      } catch (err: any) {
        MessageBox.error(err?.message || String(err));
        return;
      }
      this.getView()!.addDependent(this.picker);
    }
    const email = this.vm().getProperty("/email"); const isAdmin = this.vm().getProperty("/isAdmin");
    (this.picker.getBinding("items") as ODataListBinding).changeParameters({ $filter: ownCatalogsFilter(isAdmin, email) });
    this.picker.open();
  }

  public onCatalogPickCancel(e: any): void { catalogPickCancel(e); }

  public onCatalogPickSearch(e: any): void { catalogPickSearch(e); }

  public onCatalogPicked(e: any): void {
    const item = e.getParameter("selectedItem"); if (!item) return;
    const catalogId = item.getBindingContext().getProperty("ID");
    const b = this.odata().bindContext(`/ModelCatalogs(${catalogId})/AdminService.addModels(...)`);
    b.setParameter("modelIds", [...this.selected]);
    b.invoke().then(() => {
      const r = b.getBoundContext().getObject() as any;
      MessageToast.show(`${r.added} model(s) added`);
      this.selected.clear();
      this.vm().setProperty("/library/selectedCount", 0);
    }).catch((err: any) => MessageBox.error(err?.message || String(err)));
  }
}
