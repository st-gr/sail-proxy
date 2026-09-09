import Controller from "sap/ui/core/mvc/Controller";
import JSONModel from "sap/ui/model/json/JSONModel";
import ODataModel from "sap/ui/model/odata/v4/ODataModel";
import ODataListBinding from "sap/ui/model/odata/v4/ODataListBinding";
import UIComponent from "sap/ui/core/UIComponent";
import MessageBox from "sap/m/MessageBox";
import MessageToast from "sap/m/MessageToast";
import Messaging from "sap/ui/core/Messaging";
import Fragment from "sap/ui/core/Fragment";
import Dialog from "sap/m/Dialog";
import List from "sap/m/List";
import Table from "sap/m/Table";
import Input, { Input$LiveChangeEvent } from "sap/m/Input";
import SearchField from "sap/m/SearchField";
import ListItemBase from "sap/m/ListItemBase";
import * as session from "../model/session";
import { catalogPickSearch, catalogPickCancel } from "../model/catalogPicker";
import { modelIdIn, modelIdNotIn } from "../model/idFilters";
import { headerDirty, isCatalogClean } from "../model/headerDirty";
import { filterUsers } from "../model/userFilter";
import {
  PendingChanges, PendingModel, PendingInvokers, emptyPending, pendingCount, pendingSummary,
  stageAdd, stageRemove, stageExclude, stageInclude, stageAssign,
  mergeMembers, mergeExclusions, mergeUsers, applyPending, saveSummary
} from "../model/catalogPending";
import { toCatalogShapedUsers } from "../model/profileRows";
import { serverErrors, serverErrorText } from "../model/saveMessages";
import type { UiMessage } from "../model/saveMessages";

/**
 * I: the detail header's own update group. An application group ID is deferred, so a Name or
 * Description edit stays in the model until submitBatch — which is what makes Save, Discard and
 * the data-loss guard possible at all.
 */
const HEADER_GROUP = "catalogHeader";
/** The non-cancelling action of the unsaved-changes warning; MessageBox.Action.CANCEL is the other. */
const DISCARD_ACTION = "Discard";
/**
 * Which of the two objects this view manages. They share everything below the selection — one
 * detail page, one staged set of changes, one Save — and differ in what is listed, which container
 * carries the element binding, and which actions Save writes the assignments through.
 */
type Mode = "catalogs" | "profiles";
/** The container that carries the element binding per mode (see Catalogs.view.xml). */
const DETAIL_CONTAINER: Record<Mode, string> = { catalogs: "catalogDetail", profiles: "profileDetail" };
/** The data-loss guard's wording. Verbatim: the OPA page object matches these texts. */
const UNSAVED_WARNING: Record<Mode, string> = {
  catalogs: "You have unsaved changes to this catalog. Discard them?",
  profiles: "You have unsaved changes to this profile. Discard them?"
};

/**
 * @namespace admin.modellibrary.controller
 */
export default class CatalogsController extends Controller {
  private vm(): JSONModel { return this.getOwnerComponent()!.getModel("viewModel") as JSONModel; }
  private odata(): ODataModel { return this.getOwnerComponent()!.getModel() as ODataModel; }
  private router() { return (this.getOwnerComponent() as UIComponent).getRouter(); }
  private selected: any = null;          // current catalog or profile object
  /** Which list is shown; the route decides it and onModeChange navigates to change it. */
  private mode: Mode = "catalogs";
  /** What the detail column is showing — the mode as it was when the row was selected. */
  private selectedKind: Mode = "catalogs";
  private pickerMode: "members" | "exclude" = "members";
  private newDialog: Dialog | null = null;
  private newProfileDialog: Dialog | null = null;
  private selectedItem: ListItemBase | null = null;   // the list row the detail column belongs to
  private saveInFlight = false;                      // a Save (header batch and/or the staged actions) is out and unanswered
  private picker: any = null;
  /**
   * L: the list changes (members, exclusions, assignments) that Save has not written yet. The
   * entities behind the tables are read-only over OData, so — unlike the header — nothing in the
   * OData model can hold these back: they are staged here (catalogPending.ts) and written by
   * onSave through the same actions the buttons used to fire directly.
   */
  private pending: PendingChanges = emptyPending();
  /** The header text differs from the bound value while the user is still typing (see onHeaderLiveChange). */
  private headerEdited = false;

  public onInit(): void {
    this.router().getRoute("catalogs")!.attachPatternMatched(() => this.onRouteMatched("catalogs"), this);
    this.router().getRoute("profiles")!.attachPatternMatched(() => this.onRouteMatched("profiles"), this);
    session.load(this.odata()).then(s => { this.vm().setProperty("/isAdmin", s.isAdmin); this.vm().setProperty("/email", s.email); }).catch(() => undefined);
  }

  /**
   * The hash is what says which mode the view is in — #/catalogs and #/profiles are the same
   * target. session.load is memoized and its /isAdmin handler was attached first (onInit), so by
   * the time this runs the role is known: quota profiles are admin-only, and someone who typed
   * #/profiles without the role is put back on the catalogs.
   */
  private onRouteMatched(mode: Mode): void {
    this.vm().setProperty("/catalogs/layout", "OneColumn");
    this.refreshEntitlement();
    session.load(this.odata()).then(() => this.applyMode(mode)).catch(() => this.applyMode("catalogs"));
  }
  private applyMode(mode: Mode): void {
    const target: Mode = mode === "profiles" && !this.vm().getProperty("/isAdmin") ? "catalogs" : mode;
    if (target !== this.mode) {
      // The other list's rows are not this one's: the detail column starts empty, and whatever was
      // edited but not saved goes with it (a hash typed by hand does not pass the guard).
      this.mode = target;
      this.selectedKind = target;
      this.selected = null;
      this.selectedItem = null;
      this.vm().setProperty("/catalogs/selectedId", "");
      this.vm().setProperty("/catalogs/selectedName", "");
      this.discardAll();
    }
    this.vm().setProperty("/catalogs/mode", target);
    // QuotaProfiles is admin-only and its list binding is suspended in the view, so nothing asks
    // for it until an administrator is actually looking at the profiles.
    if (target === "profiles") {
      const binding = (this.byId("profileList") as List).getBinding("items") as ODataListBinding;
      if (binding?.isSuspended()) binding.resume();
    }
    if (target !== mode) this.router().navTo("catalogs", {}, true);
  }
  /** The switch above the list: the guard first, then the hash — applyMode does the rest. */
  public onModeChange(e: any): void {
    const key = e.getParameter("item").getKey() as Mode;
    if (key === this.mode) return;
    this.confirmDiscard(
      () => this.router().navTo(key === "profiles" ? "profiles" : "catalogs", {}, true),
      // The SegmentedButton has already written the pressed key into the view model; Cancel means
      // the view stays where it is, so the switch has to go back with it.
      () => this.vm().setProperty("/catalogs/mode", this.mode)
    );
  }

  private refreshEntitlement(): void { session.entitlement(this.odata()).then(e => this.vm().setProperty("/entitlement", e)).catch(() => undefined); }
  public onNavBack(): void { this.confirmDiscard(() => this.router().navTo("library")); }
  public onCloseDetail(): void { this.confirmDiscard(() => this.vm().setProperty("/catalogs/layout", "OneColumn")); }

  public onSelectCatalog(e: any): void { this.selectRow(e, "catalogList"); }
  public onSelectProfile(e: any): void { this.selectRow(e, "profileList"); }
  private selectRow(e: any, listId: string): void {
    const item = e.getParameter("listItem") as ListItemBase;
    const ctx = item.getBindingContext();
    this.confirmDiscard(
      () => this.showSelected(item, ctx),
      // Cancel means "stay here", but the List has already moved its highlight to the row that
      // was pressed - put it back on the catalog the detail column is still showing.
      () => { if (this.selectedItem) (this.byId(listId) as List).setSelectedItem(this.selectedItem, true); }
    );
  }

  private showSelected(item: ListItemBase, ctx: any): void {
    this.selectedItem = item;
    this.selected = ctx.getObject();
    this.selectedKind = this.mode;
    const isAdmin = this.vm().getProperty("/isAdmin"), email = this.vm().getProperty("/email");
    // The detail Page has no element binding of its own, so what its title, tabs and buttons need
    // from the selected row is copied here (see Catalogs.view.xml).
    this.vm().setProperty("/catalogs/selectedId", this.selected.ID);
    this.vm().setProperty("/catalogs/selectedName", this.selected.name || "");
    this.vm().setProperty("/catalogs/selectedIsDefault", !!this.selected.isDefault);
    this.vm().setProperty("/catalogs/selectedOwnerEmail", this.selected.ownerEmail || "");
    this.vm().setProperty("/catalogs/canEdit", this.mode === "profiles" ? !!isAdmin : (isAdmin ? !this.selected.isDefault : this.selected.ownerEmail === email));
    // I: the header's edits go into the deferred HEADER_GROUP, not the model's $auto group. The
    // other mode's container must lose its context, or its fields would resolve against this one.
    (this.byId(DETAIL_CONTAINER[this.mode === "profiles" ? "catalogs" : "profiles"]) as any).unbindElement();
    (this.byId(DETAIL_CONTAINER[this.mode]) as any).bindElement({ path: ctx.getPath(), parameters: { $$updateGroupId: HEADER_GROUP } });
    this.resetPending();
    this.vm().setProperty("/catalogs/layout", "TwoColumnsMidExpanded");
    if (this.mode === "profiles") { this.loadProfileUsers(); return; }
    this.loadMembers(); this.loadExclusions(); this.loadParentName();
    if (isAdmin) this.loadUsers();
  }

  /** The context the detail column's fields are bound to — where the header's edits are held. */
  private detailContext(): any { return (this.byId(DETAIL_CONTAINER[this.selectedKind]) as any).getBindingContext(); }

  // ---- what the server holds (snapshots) and what the tables show (snapshots + staged changes) ----
  private loadMembers(): void {
    if (!this.selected || this.selected.isDefault) { this.vm().setProperty("/catalogs/membersSnapshot", []); this.renderMembers(); return; }
    const lb = this.odata().bindList("/ModelCatalogMembers", undefined, [], undefined, { $filter: `catalog_ID eq ${this.selected.ID}`, $orderby: "displayName" }) as ODataListBinding;
    lb.requestContexts(0, 500).then(async ctxs => {
      const members = ctxs.map(c => c.getObject() as any);
      // availability from the snapshot (absent flag) — one request for the ids we hold
      const ids = members.map(m => m.modelId);
      let absent = new Set<string>();
      if (ids.length) {
        const lm = this.odata().bindList("/LibraryModels", undefined, [], undefined, { $select: "modelId", $filter: modelIdIn(ids) }) as ODataListBinding;
        const present = new Set((await lm.requestContexts(0, 500)).map(c => c.getProperty("modelId")));
        absent = new Set(ids.filter(id => !present.has(id)));
      }
      this.vm().setProperty("/catalogs/membersSnapshot", members.map(m => ({ ...m, absent: absent.has(m.modelId) })));
      this.renderMembers();
    }).catch((err: any) => MessageBox.error(err?.message || String(err)));
  }
  private loadExclusions(): void {
    if (!this.selected?.isDefault) { this.vm().setProperty("/catalogs/exclusionsSnapshot", []); this.renderExclusions(); return; }
    const lb = this.odata().bindList("/ModelCatalogExclusions", undefined, [], undefined, { $filter: `catalog_ID eq ${this.selected.ID}`, $orderby: "modelId" }) as ODataListBinding;
    lb.requestContexts(0, 500).then(ctxs => { this.vm().setProperty("/catalogs/exclusionsSnapshot", ctxs.map(c => c.getObject())); this.renderExclusions(); })
      .catch((err: any) => MessageBox.error(err?.message || String(err)));
  }
  private renderMembers(): void {
    this.vm().setProperty("/catalogs/members", mergeMembers(this.vm().getProperty("/catalogs/membersSnapshot") || [], this.pending));
    (this.byId("membersTable") as Table)?.removeSelections(true);
  }
  private renderExclusions(): void {
    this.vm().setProperty("/catalogs/exclusions", mergeExclusions(this.vm().getProperty("/catalogs/exclusionsSnapshot") || [], this.pending));
    (this.byId("exclusionsTable") as Table)?.removeSelections(true);
  }
  private memberIds(): string[] { return (this.vm().getProperty("/catalogs/membersSnapshot") || []).map((m: any) => m.modelId); }
  private excludedIds(): string[] { return (this.vm().getProperty("/catalogs/exclusionsSnapshot") || []).map((x: any) => x.modelId); }
  private loadParentName(): void {
    if (!this.selected?.parent_ID) { this.vm().setProperty("/catalogs/parentName", this.selected?.isDefault ? "—" : "— (root)"); return; }
    const cb = this.odata().bindContext(`/ModelCatalogs(${this.selected.parent_ID})`);
    cb.getBoundContext().requestObject().then((p: any) => this.vm().setProperty("/catalogs/parentName", p?.name || this.selected.parent_ID))
      .catch(() => this.vm().setProperty("/catalogs/parentName", this.selected.parent_ID));
  }
  public loadUsers(): void {
    const b = this.odata().bindContext("/libraryUsers(...)");
    b.invoke().then(() => { const r = b.getBoundContext().getObject() as any; this.setUsers(r.value || []); }).catch(() => this.setUsers([]));
  }
  /**
   * The same table for quota profiles: quotaProfileUsers() answers with the profile each user
   * carries, and profileRows.toCatalogShapedUsers renames those two fields so mergeUsers, the
   * staged assign map and the table's bindings need no second version of themselves.
   */
  public loadProfileUsers(): void {
    const b = this.odata().bindContext("/quotaProfileUsers(...)");
    b.invoke().then(() => { const r = b.getBoundContext().getObject() as any; this.setUsers(toCatalogShapedUsers(r.value || [])); }).catch(() => this.setUsers([]));
  }
  public onRefreshUsers(): void { if (this.selectedKind === "profiles") this.loadProfileUsers(); else this.loadUsers(); }

  /**
   * J: libraryUsers() hands the whole list over in one call, so the search box narrows the array
   * we already hold rather than asking the server again — /catalogs/allUsers is what came back,
   * /catalogs/users is what the table shows (with the staged assignments laid over it).
   */
  private setUsers(rows: any[]): void {
    this.vm().setProperty("/catalogs/allUsers", rows);
    this.applyUserQuery();
  }
  private applyUserQuery(): void {
    const query = (this.vm().getProperty("/catalogs/userQuery") as string) || "";
    const rows = filterUsers(this.vm().getProperty("/catalogs/allUsers") || [], query);
    this.vm().setProperty("/catalogs/users", this.selected ? mergeUsers(rows, this.pending, { ID: this.selected.ID, name: this.selected.name }) : rows);
    // Re-filling the rows drops the table's selection, so the toolbar's counters must follow.
    this.clearUserSelection();
  }
  private clearUserSelection(): void {
    (this.byId("assignmentsTable") as Table)?.removeSelections(true);
    this.vm().setProperty("/catalogs/selectedUserCount", 0);
    this.vm().setProperty("/catalogs/selectedAssignedCount", 0);
  }
  public onUserSearch(e: any): void {
    this.vm().setProperty("/catalogs/userQuery", (e.getSource() as SearchField).getValue() || "");
    this.applyUserQuery();
  }
  /** Unassign only means something for a row that has a catalog (staged or stored), hence the second counter. */
  public onUserSelectionChange(): void {
    const rows = this.selectedUserRows();
    this.vm().setProperty("/catalogs/selectedUserCount", rows.length);
    this.vm().setProperty("/catalogs/selectedAssignedCount", rows.filter(r => r.effectiveCatalogId).length);
  }

  private selectedUserRows(): any[] {
    return (this.byId("assignmentsTable") as Table).getSelectedItems()
      .map(i => i.getBindingContext("viewModel")!.getObject() as any);
  }

  // ---- assignments (admin): staged, written by Save ----
  /**
   * Reassigning a user's catalog prunes their own selections server-side, which is why this used
   * to ask first. Now nothing is written until Save — Save is the confirmation — and the
   * Assignments tab says so; the rows show the staged target until then.
   */
  public onAssignSelected(): void {
    const rows = this.selectedUserRows().filter(r => r.email);
    if (!rows.length) { MessageToast.show("Select users first"); return; }
    for (const r of rows) this.pending = stageAssign(this.pending, r.email, this.selected.ID, r.catalogId ?? null);
    this.afterStaging();
  }
  public onUnassignSelected(): void {
    const rows = this.selectedUserRows().filter(r => r.email && r.effectiveCatalogId);
    if (!rows.length) { MessageToast.show("Select assigned users first"); return; }
    for (const r of rows) this.pending = stageAssign(this.pending, r.email, null, r.catalogId ?? null);
    this.afterStaging();
  }
  public onAssign(e: any): void {
    const row = e.getSource().getBindingContext("viewModel").getObject();
    this.pending = stageAssign(this.pending, row.email, this.selected.ID, row.catalogId ?? null);
    this.afterStaging();
  }
  public onUnassign(e: any): void {
    const row = e.getSource().getBindingContext("viewModel").getObject();
    this.pending = stageAssign(this.pending, row.email, null, row.catalogId ?? null);
    this.afterStaging();
  }
  public onTabSelect(): void { /* content is preloaded on select */ }

  // ---- create / update / delete ----
  /** The list header's one button: it creates whatever the list is showing. */
  public onNew(): void { if (this.mode === "profiles") this.onNewProfile(); else this.onNewCatalog(); }

  public async onNewCatalog(): Promise<void> {
    if (!this.newDialog) {
      try {
        this.newDialog = await Fragment.load({ id: this.getView()!.getId(), name: "admin.modellibrary.view.NewCatalogDialog", controller: this }) as Dialog;
      } catch (err: any) {
        MessageBox.error(err?.message || String(err));
        return;
      }
      this.getView()!.addDependent(this.newDialog);
    }
    this.vm().setProperty("/catalogs/new", { name: "", description: "" });
    this.newDialog.open();
  }
  public onCancelNewCatalog(): void { this.newDialog?.close(); }
  public onCreateCatalog(): void {
    const n = this.vm().getProperty("/catalogs/new");
    if (!n.name?.trim()) { MessageToast.show("Name is required"); return; }
    const list = this.byId("catalogList") as List;
    const binding = list.getBinding("items") as any;
    const ctx = binding.create({ name: n.name.trim(), description: n.description || "" }, true);
    ctx.created().then(() => { MessageToast.show("Catalog created"); this.newDialog?.close(); binding.refresh(); })
      .catch((err: any) => MessageBox.error(err?.message || String(err)));
  }

  public async onNewProfile(): Promise<void> {
    if (!this.newProfileDialog) {
      try {
        this.newProfileDialog = await Fragment.load({ id: this.getView()!.getId(), name: "admin.modellibrary.view.NewProfileDialog", controller: this }) as Dialog;
      } catch (err: any) {
        MessageBox.error(err?.message || String(err));
        return;
      }
      this.getView()!.addDependent(this.newProfileDialog);
    }
    this.vm().setProperty("/catalogs/newProfile", { name: "", description: "" });
    this.newProfileDialog.open();
  }
  public onCancelNewProfile(): void { this.newProfileDialog?.close(); }
  public onCreateProfile(): void {
    const n = this.vm().getProperty("/catalogs/newProfile");
    if (!n.name?.trim()) { MessageToast.show("Name is required"); return; }
    const binding = (this.byId("profileList") as List).getBinding("items") as any;
    const ctx = binding.create({ name: n.name.trim(), description: n.description || "" }, true);
    // The CREATE response does not carry assignedUsers (it is counted in the service's after-READ),
    // so the new row would show no count at all until the list is read again.
    ctx.created().then(() => { MessageToast.show("Quota profile created"); this.newProfileDialog?.close(); binding.refresh(); })
      .catch((err: any) => MessageBox.error(err?.message || String(err)));
  }

  // ---- the catalog's unsaved state: header edits (I) plus staged list changes (L) ----
  /** What the Save/Discard buttons, the footer's summary and the data-loss guard read. */
  private refreshDirty(): void {
    const count = pendingCount(this.pending);
    const headerPending = this.headerEdited || this.odata().hasPendingChanges(HEADER_GROUP);
    this.vm().setProperty("/catalogs/pendingCount", count);
    this.vm().setProperty("/catalogs/pendingText", pendingSummary(this.pending));
    this.vm().setProperty("/catalogs/dirty", !this.saveInFlight && (headerPending || count > 0));
  }
  /** After a click staged something: the tables show it, the footer counts it. */
  private afterStaging(): void {
    this.renderMembers(); this.renderExclusions(); this.applyUserQuery();
    this.refreshDirty();
  }
  private resetPending(): void {
    this.pending = emptyPending();
    this.headerEdited = false;
    this.refreshDirty();
  }

  /**
   * sap.m.Input writes its bound property only on `change`, so while the user types the model
   * still holds the old value: headerDirty compares the typed text with it and falls back to the
   * model's pending-changes flag, which covers the other field.
   */
  public onHeaderLiveChange(e: Input$LiveChangeEvent): void {
    const input = e.getSource() as Input;
    const ctx = input.getBindingContext();
    const path = input.getBinding("value")?.getPath();
    if (!ctx || !path) return;
    // A profile's limits are numbers; what the field holds is always text.
    const stored = ctx.getProperty(path);
    this.headerEdited = headerDirty(e.getParameter("value"), stored === null || stored === undefined ? stored : String(stored), false);
    this.refreshDirty();
  }

  /** Once the change event has committed the value, the model alone knows whether anything differs. */
  public onHeaderChange(): void { this.headerEdited = false; this.refreshDirty(); }

  /**
   * Save: the header's batch first (nothing else is sent if it fails), then the staged list
   * changes through their actions (catalogPending.applyPending: one call per set, the users one
   * at a time). What could not be written stays staged, with the server's message, so Save can
   * be tried again or the rest discarded; what was written is reloaded from the server.
   */
  public async onSave(): Promise<void> {
    if (this.saveInFlight) return;
    const odata = this.odata();
    // Both buttons go dark for the duration: resetChanges throws while a request for the group is
    // running, so Discard must not be reachable until the batch is done. The guard has to agree
    // with them — hasPendingChanges keeps reporting the edit for the whole round trip — hence the
    // flag, which isCatalogClean reads.
    this.saveInFlight = true;
    this.vm().setProperty("/catalogs/saving", true);
    this.refreshDirty();
    try {
      if (odata.hasPendingChanges(HEADER_GROUP)) {
        try {
          await odata.submitBatch(HEADER_GROUP);
        } catch (err: any) {
          MessageBox.error(err?.message || String(err));
          return;
        }
        if (odata.hasPendingChanges(HEADER_GROUP)) {
          // The batch came back but the change is still pending: one of its PATCHes was answered
          // with an error inside the change set, which does not reject submitBatch. The server's
          // reason ("tokensPerDay must not exceed tokensPerWeek") is only in the message manager,
          // so it is read out here — otherwise this reads as "try again", which cannot work.
          // The messages are removed afterwards so the next Save does not re-show stale text.
          const path = this.detailContext()?.getPath?.();
          const raw = Messaging.getMessageModel().getData() as UiMessage[];
          const reported = serverErrors(raw, path);
          const detail = serverErrorText(raw, path);
          MessageBox.error(`The ${this.selectedKind === "profiles" ? "profile" : "catalog"} was not saved.${detail ? `\n${detail}` : ""}\nYour changes are still here — try Save again.`);
          if (reported.length) Messaging.removeMessages(reported as any);
          return;
        }
        this.headerEdited = false;
        this.syncSelectedName();
        this.refreshListRow();
      }
      if (pendingCount(this.pending) > 0) {
        const { remaining, failed, results } = await applyPending(this.pending, this.invokers());
        this.pending = remaining;
        MessageToast.show(saveSummary(results));
        if (failed.length) {
          MessageBox.error(`Not saved — still pending:\n${failed.map(f => `${f.step}: ${f.message}`).join("\n")}`);
        }
        if (this.selectedKind === "profiles") {
          // the row's "n users" is counted server-side, so it only changes once the list is read again
          this.loadProfileUsers(); this.refreshListRow();
        } else {
          this.loadMembers(); this.loadExclusions(); this.refreshEntitlement();
          if (this.vm().getProperty("/isAdmin")) this.loadUsers();
        }
      } else {
        MessageToast.show("Saved");
      }
    } finally {
      this.saveInFlight = false;
      this.vm().setProperty("/catalogs/saving", false);
      this.refreshDirty();
    }
  }

  /** The actions Save writes the staged changes through — the very calls the buttons used to fire directly. */
  private invokers(): PendingInvokers {
    const id = this.selected.ID;
    const bound = async (action: string, params: Record<string, any>) => {
      const b = this.odata().bindContext(`/ModelCatalogs(${id})/AdminService.${action}(...)`);
      for (const [k, v] of Object.entries(params)) b.setParameter(k, v);
      await b.invoke();
      return b.getBoundContext().getObject() as any;
    };
    const unbound = async (action: string, params: Record<string, any>) => {
      const b = this.odata().bindContext(`/${action}(...)`);
      for (const [k, v] of Object.entries(params)) b.setParameter(k, v);
      await b.invoke();
      return b.getBoundContext().getObject() as any;
    };
    if (this.selectedKind === "profiles") {
      // A profile holds no models, so nothing stages the four model steps for one; they are here
      // because applyPending takes one set of invokers, and they must never pass silently.
      const never = (step: string) => async (): Promise<never> => { throw new Error(`${step} cannot be staged for a quota profile`); };
      return {
        addModels: never("Adding models"), removeModels: never("Removing models"),
        excludeModels: never("Excluding models"), includeModels: never("Including models"),
        assignCatalog: (email: string, profileId: string) => unbound("assignQuotaProfile", { email, profileId }),
        unassignCatalog: (email: string) => unbound("unassignQuotaProfile", { email })
      };
    }
    return {
      addModels: (modelIds: string[]) => bound("addModels", { modelIds }),
      removeModels: (modelIds: string[]) => bound("removeModels", { modelIds }),
      excludeModels: (rows: PendingModel[]) => bound("excludeModels", { modelIds: rows.map(r => r.modelId), reason: rows[0]?.reason || "Excluded in the Model Library" }),
      includeModels: (modelIds: string[]) => bound("includeModels", { modelIds }),
      assignCatalog: (email: string, catalogId: string) => unbound("assignCatalog", { email, catalogId }),
      unassignCatalog: (email: string) => unbound("unassignCatalog", { email })
    };
  }

  public onDiscard(): void { this.discardAll(); }

  /**
   * The detail page has its own element binding and cache, so the list never sees what Save
   * changed: its row would keep the old name and description until the next full load.
   */
  private refreshListRow(): void {
    const ctx = this.selectedItem?.getBindingContext() as any;
    if (ctx?.refresh) ctx.refresh(); else (this.byId(this.selectedKind === "profiles" ? "profileList" : "catalogList") as List).getBinding("items")?.refresh();
  }

  /** The detail Page's title is the view model's copy of the name, so a renamed row has to say so. */
  private syncSelectedName(): void {
    const name = this.detailContext()?.getProperty("name");
    if (typeof name === "string") this.vm().setProperty("/catalogs/selectedName", name);
  }

  private discardAll(): void {
    // resetChanges throws while a batch for the group is still running. saveInFlight keeps both
    // callers off that path — the button is disabled and the guard proceeds without asking — so
    // this is the backstop, not the mechanism: an exception here would abort whatever navigation
    // the guard was letting through, and there is nothing to reset anyway once the edit is on
    // its way.
    try { this.odata().resetChanges(HEADER_GROUP); } catch { /* a save for this group is in flight */ }
    this.resetPending();
    this.renderMembers(); this.renderExclusions(); this.applyUserQuery();
  }

  /**
   * Every way out of an edited catalog goes through here. The header's edits sit in a deferred
   * update group that nothing submits on its own, and the staged list changes exist only in this
   * controller — so switching catalog, closing the detail column or deleting the catalog would
   * drop them without a word.
   */
  private confirmDiscard(proceed: () => void, onCancel?: () => void): void {
    const clean = isCatalogClean({
      saveInFlight: this.saveInFlight,
      pending: this.headerEdited || this.odata().hasPendingChanges(HEADER_GROUP),
      pendingCount: pendingCount(this.pending)
    });
    if (clean) {
      proceed();
      return;
    }
    MessageBox.warning(UNSAVED_WARNING[this.selectedKind], {
      actions: [DISCARD_ACTION, MessageBox.Action.CANCEL],
      emphasizedAction: DISCARD_ACTION,
      onClose: (action: string) => {
        if (action !== DISCARD_ACTION) { onCancel?.(); return; }
        this.discardAll();
        proceed();
      }
    });
  }

  public onDeleteCatalog(): void {
    // A DELETE must not race the header PATCH that Save just sent: the guard treats an in-flight
    // save as clean (isCatalogClean), so it would let the delete through without a word.
    if (this.saveInFlight) { MessageToast.show("Wait for the save to finish"); return; }
    this.confirmDiscard(() => {
      MessageBox.confirm(`Delete catalog "${this.selected.name}"?`, { onClose: (a: string) => {
        if (a !== MessageBox.Action.OK) return;
        const ctx = this.detailContext();
        // "$auto" explicitly: Context#delete falls back to the *binding's* update group when
        // none is given (ODataBinding#lockGroup: `sGroupId ??= this.getUpdateGroupId()`), and on
        // this element binding that is HEADER_GROUP — a deferred application group nothing
        // submits. The DELETE would sit in the queue, the promise would never settle, and the
        // queued deletion would itself count as a pending change, so the next navigation would
        // offer to "discard" the delete.
        ctx.delete("$auto").then(() => { MessageToast.show("Catalog deleted"); this.selectedItem = null; this.onCloseDetail(); (this.byId("catalogList") as List).getBinding("items")?.refresh(); }).catch((err: any) => MessageBox.error(err?.message || String(err)));
      } });
    });
  }

  /** The same delete, with the server's 409 as the answer when somebody is still assigned. */
  public onDeleteProfile(): void {
    if (this.saveInFlight) { MessageToast.show("Wait for the save to finish"); return; }
    this.confirmDiscard(() => {
      MessageBox.confirm(`Delete quota profile "${this.selected.name}"?`, { onClose: (a: string) => {
        if (a !== MessageBox.Action.OK) return;
        this.detailContext().delete("$auto")
          .then(() => { MessageToast.show("Quota profile deleted"); this.selectedItem = null; this.onCloseDetail(); (this.byId("profileList") as List).getBinding("items")?.refresh(); })
          .catch((err: any) => MessageBox.error(err?.message || String(err)));
      } });
    });
  }

  // ---- members and exclusions: staged, written by Save ----
  private async openPicker(mode: "members" | "exclude"): Promise<void> {
    this.pickerMode = mode;
    if (!this.picker) {
      try {
        this.picker = await Fragment.load({ id: this.getView()!.getId(), name: "admin.modellibrary.view.ModelPicker", controller: this });
      } catch (err: any) {
        MessageBox.error(err?.message || String(err));
        return;
      }
      this.getView()!.addDependent(this.picker);
    }
    let filter: string | undefined;
    if (mode === "members" && !this.vm().getProperty("/isAdmin")) {
      const ids: string[] = this.vm().getProperty("/entitlement/modelIds") || [];
      filter = modelIdIn(ids);
    }
    if (mode === "exclude") {
      // neither what the server holds nor what is already staged is offered again
      filter = modelIdNotIn([...this.excludedIds(), ...this.pending.exclude.map(x => x.modelId)]);
    }
    (this.picker.getBinding("items") as ODataListBinding).changeParameters({ $filter: filter });
    this.picker.setTitle(mode === "exclude" ? "Exclude models from the default catalog" : "Add models");
    this.picker.open();
  }
  public onAddMembers(): void { this.openPicker("members"); }
  public onExclude(): void { this.openPicker("exclude"); }
  /** Shared with the AddModelsDialog picker used by Detail/Library: narrow to the typed search text. */
  public onModelPickSearch(e: any): void { catalogPickSearch(e); }
  /** Shared with the AddModelsDialog picker: drop the search narrowing so the next open starts fresh. */
  public onModelPickCancel(e: any): void { catalogPickCancel(e); }
  public onModelsPicked(e: any): void {
    const rows: PendingModel[] = (e.getParameter("selectedContexts") || []).map((c: any) => ({ modelId: c.getProperty("modelId"), displayName: c.getProperty("displayName") }));
    if (!rows.length) return;
    this.pending = this.pickerMode === "exclude"
      ? stageExclude(this.pending, rows.map(r => ({ ...r, reason: "Excluded in the Model Library" })), this.excludedIds())
      : stageAdd(this.pending, rows, this.memberIds());
    this.afterStaging();
  }
  public onRemoveMembers(): void {
    const t = this.byId("membersTable") as Table;
    const ids = t.getSelectedContexts().map(c => (c.getObject() as any).modelId);
    if (!ids.length) { MessageToast.show("Select models first"); return; }
    this.pending = stageRemove(this.pending, ids, this.memberIds());
    this.afterStaging();
  }
  public onInclude(): void {
    const t = this.byId("exclusionsTable") as Table;
    const ids = t.getSelectedContexts().map(c => (c.getObject() as any).modelId);
    if (!ids.length) { MessageToast.show("Select exclusions first"); return; }
    this.pending = stageInclude(this.pending, ids, this.excludedIds());
    this.afterStaging();
  }
}
