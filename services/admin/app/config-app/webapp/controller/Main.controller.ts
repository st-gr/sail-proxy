import Controller from "sap/ui/core/mvc/Controller";
import MessageToast from "sap/m/MessageToast";
import MessageBox from "sap/m/MessageBox";
import JSONModel from "sap/ui/model/json/JSONModel";
import ODataModel from "sap/ui/model/odata/v4/ODataModel";
import Table from "sap/m/Table";
import Dialog from "sap/m/Dialog";
import CodeEditor from "sap/ui/codeeditor/CodeEditor";
import FlexibleColumnLayoutControl from "sap/f/FlexibleColumnLayout";
import Filter from "sap/ui/model/Filter";
import FilterOperator from "sap/ui/model/FilterOperator";
import Control from "sap/ui/core/Control";
import type Context from "sap/ui/model/Context";
import type ODataListBinding from "sap/ui/model/odata/v4/ODataListBinding";
import type ODataContext from "sap/ui/model/odata/v4/Context";
import { SegmentedButton$SelectionChangeEvent } from "sap/m/SegmentedButton";
import ResourceModel from "sap/ui/model/resource/ResourceModel";
import formatMessage from "sap/base/strings/formatMessage";
import Localization from "sap/base/i18n/Localization";
import ConfigForm from "./ConfigForm";
import { storedValidationMessages } from "../model/storedValidation";
import { LatestRequest } from "../model/latestRequest";
import { canSave, selectionState, type ConfigRow, type SelectionState } from "../model/selectionState";
import { activeState, type DetailEdits } from "../model/activeState";

/** The ApiConfigurations row fields this controller reads from a table item's context. */
interface ApiConfigurationRow extends ConfigRow {
    name: string;
    version: string;
}

/**
 * ManagedObject#setBindingContext documents null as "hide the parent context"; its typings
 * accept only a Context.
 */
const NO_BINDING_CONTEXT = null as unknown as Context;

/**
 * Main controller for Configuration Management
 */
export default class MainController extends Controller {

    /**
     * The open configuration: the row last pressed, shown in the detail column. Ticking rows never
     * changes it - the ticked rows are the toolbar's (see model/selectionState.ts).
     */
    private _selectedConfig: any = null;
    /** The configuration whose document the JSON editor holds; null until its read has answered. */
    private _editorConfigId: string | null = null;
    private _originalEditorValue: string = "";
    private _isEditorDirty: boolean = false;
    private _searchTimeout: number | null = null;
    private _filterTimeout: number | null = null;
    private _dialogResizeObserver: ResizeObserver | null = null;
    private _resizeThrottleTimeout: number | null = null;
    private _configForm: ConfigForm | null = null;
    /** The detail read of the last pressed configuration; an earlier press's late answer is dropped. */
    private _detailLoad = new LatestRequest();
    /** The `_detailLoad` token whose read has answered: the open configuration the detail shows. */
    private _shownLoad: number | null = null;

    /**
     * A text from the app bundle, with {0}-style arguments. Synchronous: the texts it serves are
     * shown on user actions, after the asynchronously loaded bundle is in place.
     */
    private text(key: string, args?: unknown[]): string {
        const model = this.getOwnerComponent()?.getModel("i18n") as ResourceModel | undefined;
        const pattern = (model?.getProperty(key) as string | null | undefined) ?? key;
        return args ? formatMessage(pattern, args) : pattern;
    }

    /**
     * Names the detail title's info block and validation list for screen readers, with the headings
     * the panels they replaced carried ("Configuration Information", "Validation Results"). sap.m.VBox
     * has no ariaLabelledBy, so each rendering of either box gets role="group" and an aria-label;
     * a delegate, because a re-render (visibility toggles on every selection) writes a fresh element.
     */
    private _labelDetailGroups(): void {
        const groups: Array<[string, string]> = [["detailInfo", "configInfo"], ["detailValidation", "validationResults"]];
        for (const [id, key] of groups) {
            const box = this.byId(id);
            box?.addEventDelegate({
                onAfterRendering: (): void => {
                    const dom = box.getDomRef();
                    dom?.setAttribute("role", "group");
                    dom?.setAttribute("aria-label", this.text(key));
                }
            });
        }
    }

    /**
     * Helper: wait until a control has rendered once
     */
    private _afterRenderingOnce(control: Control): Promise<void> {
        return new Promise((resolve) => {
            if (control.getDomRef()) {
                // Already rendered
                resolve();
                return;
            }
            
            const delegate = {
                onAfterRendering: () => {
                    control.removeEventDelegate(delegate);
                    resolve();
                }
            } as any;
            control.addEventDelegate(delegate);
        });
    }

    public onInit(): void {
        // Ensure we have the viewModel before proceeding
        const oView = this.getView();
        let oVM = oView?.getModel("viewModel") as JSONModel;
        if (!oVM) {
            // Fallback: get model from owner component
            const oOwner = this.getOwnerComponent();
            oVM = oOwner?.getModel("viewModel") as JSONModel;
            if (oVM && oView) {
                oView.setModel(oVM, "viewModel");
            }
        }
        
        if (!oVM) {
            console.error("viewModel not found in Main controller");
            return;
        }
        
        // Check if OData model is available
        let oDataModel = this.getView()?.getModel();
        
        // If not available on view, try to get it from component and set it on view
        if (!oDataModel) {
            const component = this.getOwnerComponent();
            oDataModel = component?.getModel();
            
            if (oDataModel && oView) {
                oView.setModel(oDataModel);
                oDataModel = this.getView()?.getModel();
            }
        }

        // Initialize view model data with proper defaults to prevent undefined errors
        oVM.setData({
            ...oVM.getData(),
            selectedConfigId: null, // The open configuration (the pressed row), not the ticked ones
            toolbar: { canDelete: false, canDuplicate: false, canActivate: false }, // The ticked rows' actions
            selectedConfigIsActive: false, // Track if selected config is active (for read-only editor)
            selectedConfigName: "", // Track selected config name for title
            selectedConfigVersion: "", // Track selected config version for title
            isEditMode: false, // Track if editor is in edit mode
            selectedValidationMessages: [], // The selected config's stored validation results (strips in the detail title)
            filters: {
                search: "",
                status: "",
                validation: "",
                name: ""
            },
            newConfig: {
                name: "",
                version: "",
                description: "",
                configData: "{\n  \n}"
            },
            dialogMode: "create", // Track if dialog is in "create" or "duplicate" mode
            dialogTitle: this.text("createConfigTitle"),
            rollbackReason: "", // For rollback dialog
            // Form view (see controller/ConfigForm.ts). Defaults keep the detail column exactly
            // as it is today: JSON editor, no form, toggle disabled until the gate says otherwise.
            isAdmin: false,
            configViewMode: "json",
            formViewActive: false,
            formGateEnabled: false,
            formGateReason: "",
            formEditable: false,
            formNotice: "",
            // The tab selected in the form's six-group shell (see controller/ConfigFormTabs.ts),
            // so rebuilding the form - a sink added or removed, a credential changed - does not
            // silently snap the user back to the first tab. Undefined -> the first tab opens.
            formSelectedTab: undefined
        });

        this._configForm = new ConfigForm(this);
        this._configForm.init();
        this._labelDetailGroups();

        // Add FCL state change listener for debugging
        const fcl = this.byId("fcl") as FlexibleColumnLayoutControl;
        if (fcl) {
            fcl.attachStateChange((event: any) => {
                const params = event.getParameters();
                console.log("[FCL] stateChange →", params.layout, "isResize:", params.isResize);
            });
        }

        // Load initial data
        this._loadConfigurations();
    }

    /**
     * Load all configurations
     */
    private _loadConfigurations(): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (viewModel) {
            viewModel.setProperty("/busy", true);
        }

        // Refresh the existing table binding instead of creating a new one
        const table = this.byId("configTable") as Table;
        const binding = table.getBinding("items");
        
        if (binding) {
            binding.refresh();
            
            // Wait for refresh to complete
            binding.attachEventOnce("dataReceived", () => {
                if (viewModel) {
                    viewModel.setProperty("/busy", false);
                }
            });
            
            binding.attachEventOnce("dataRequested", () => {
                // Handle any errors
            });
        } else {
            // Fallback if no binding exists
            if (viewModel) {
                viewModel.setProperty("/busy", false);
            }
            MessageToast.show(this.text("unableToRefresh"));
        }
    }

    /**
     * The ticked rows changed: only the toolbar follows. The open configuration stays as it is.
     */
    public onSelectionChange(): void {
        this._updateToolbar();
    }

    /**
     * The list's rows were (re)loaded - after Activate, Rollback, Save or Refresh a ticked row's
     * state can have changed under its tick, so the toolbar is judged again.
     */
    public onConfigListUpdateFinished(): void {
        this._updateToolbar();
        this._followOpenRowActiveState();
    }

    /** The ticked rows, as the table's checkboxes show them. */
    private _tickedRows(): ApiConfigurationRow[] {
        const table = this.byId("configTable") as Table;
        return table.getSelectedItems()
            .map((item) => item.getBindingContext()?.getObject() as ApiConfigurationRow | undefined)
            .filter((row): row is ApiConfigurationRow => !!row?.ID);
    }

    /**
     * The open configuration's row state, or null when the detail is closed - from the detail
     * page's live row context, never the copy taken at load (`_selectedConfig`).
     */
    private _openRow(): ConfigRow | null {
        const open = this._openContextRow();
        return open ? { ID: open.ID, isActive: open.isActive === true, isValid: open.isValid } : null;
    }

    /** What each list action acts on right now (model/selectionState.ts). */
    private _selectionState(): SelectionState {
        const ticked = this._tickedRows();
        return selectionState(ticked, this._openRow());
    }

    /** Enables the toolbar's Delete, Duplicate and Activate from the ticked rows. */
    private _updateToolbar(): void {
        const viewModel = this.getOwnerComponent()?.getModel("viewModel") as JSONModel;
        const state = this._selectionState();
        viewModel?.setProperty("/toolbar", {
            canDelete: state.canDelete,
            canDuplicate: state.duplicateId !== null,
            canActivate: state.activateId !== null
        });
    }

    /**
     * Handle item press to show details (for table itemPress event)
     */
    public async onItemPress(event: any): Promise<void> {
        // Read the event's parameters before anything is awaited: UI5 hands Event instances back
        // to its object pool once the handler returns, so they cannot be trusted afterwards.
        const pressedItem = event.getParameter("listItem");

        // Pending form edits are not visible to _hasUnsavedChanges below: it tracks the JSON
        // editor's change event, which setValue does not raise, so the form asks for itself.
        if (this._configForm && !(await this._configForm.confirmLeave())) {
            console.log("Navigation cancelled due to unsaved form changes");
            return;
        }

        // Check for unsaved changes before navigating
        if (this._hasUnsavedChanges()) {
            const confirmLeave = await this._confirmNavigationWithUnsavedChanges();
            if (!confirmLeave) {
                console.log("Navigation cancelled due to unsaved changes");
                return;
            } else {
                // User accepted data loss - reset dirty state
                console.log("🗑️ User accepted data loss - resetting dirty state");
                this._isEditorDirty = false;
                this._updateDirtyStateUI();
            }
        }
        
        const item = pressedItem;
        const bindingContext = item?.getBindingContext();

        if (!bindingContext) {
            console.error("No binding context found for item");
            return;
        }

        const configData = bindingContext.getObject();
        console.log("Item pressed, config data:", configData);
        
        if (configData) {
            try {
                // A later press supersedes this one, however their reads are answered.
                const loadToken = this._detailLoad.begin();

                // 1) Resolve the SINGLETON viewModel from the component (never per-view)
                const viewModel = this.getOwnerComponent()?.getModel("viewModel") as JSONModel;
                if (!viewModel) {
                    console.error("ViewModel not found at component level");
                    return;
                }
                
                
                // 2) Optimistically set UI state *first* so visibility gates open
                viewModel.setProperty("/selectedConfigId", configData.ID);
                viewModel.setProperty("/selectedConfigName", configData.name || "");
                viewModel.setProperty("/selectedConfigVersion", configData.version || "");
                viewModel.setProperty("/isEditMode", false); // Always start in view mode
                viewModel.setProperty("/selectedValidationMessages", []); // the previous config's results until this one's load
                viewModel.updateBindings(true); // Force binding update
                
                // Store selected config; the editor holds the previous one's document until this
                // one's read answers, so it is nobody's to duplicate from until then.
                this._selectedConfig = configData;
                this._editorConfigId = null;
                
                // 3) Bind the detail page to the selected row's context (fast path)
                const detailPage = this.byId("detailDynamicPage");
                if (detailPage) {
                    detailPage.setBindingContext(bindingContext);
                    console.log("Detail page binding context set to item context");
                }
                
                // 4) Switch FCL layout (after state + binding are in place)
                const fcl = this.byId("fcl") as FlexibleColumnLayoutControl;
                if (fcl) {
                    console.log("Setting FCL layout to TwoColumnsMidExpanded");
                    fcl.setLayout("TwoColumnsMidExpanded");
                }
                
                // 5) Wait for detail page to render after layout switch
                if (detailPage) {
                    console.log("Waiting for detail page to render...");
                    await this._afterRenderingOnce(detailPage as Control);
                    console.log("Detail page rendered");
                }
                if (!this._detailLoad.isCurrent(loadToken)) {
                    return; // another configuration was pressed (or the column closed) meanwhile
                }
                
                // 6) Load the configuration into the JSON editor. The editor takes its value with
                // or without a DOM, so this does not depend on the form view having shown it yet.
                this._loadConfigurationDetails(configData.ID, loadToken);
                
                // 7) Reset the form view for the newly selected configuration. Nothing else
                // clears it, and it must never be able to break opening the details, so it
                // swallows its own errors and is never awaited.
                this._configForm?.onConfigurationSelected(configData.ID);

            } catch (error) {
                console.error("Error in onItemPress:", error);
            }
        }
    }

    /**
     * Load the selected configuration into the JSON editor (async data loading).
     *
     * The editor is the one declared in the view. Its value is a plain control property that it
     * hands to its Ace instance whenever it renders, so it can be set while the editor has no DOM -
     * hidden behind the form view on a re-selection, or not yet rendered on the first open - and
     * shows once the editor is on screen. Nothing here waits for rendering.
     *
     * `token` is the press's `_detailLoad` token: an answer that arrives after a later press (or
     * after the column closed) is dropped, so the editor never ends on a configuration that is no
     * longer the selected one.
     */
    private _loadConfigurationDetails(configId: string, token: number): void {
        const oModel = this.getView()?.getModel() as ODataModel;
        const configContext = oModel.bindContext(`/ApiConfigurations(ID='${configId}')`);
        const viewModel = this.getOwnerComponent()?.getModel("viewModel") as JSONModel;

        configContext.requestObject().then((fullConfig: any) => {
            if (!this._detailLoad.isCurrent(token)) {
                return;
            }
            console.log("Full config loaded:", fullConfig);
            
            // Store the full config for other operations
            this._selectedConfig = fullConfig;
            this._shownLoad = token;
            
            // Update view model with metadata for UI binding
            if (viewModel) {
                viewModel.setProperty("/selectedConfigName", fullConfig.name || "");
                viewModel.setProperty("/selectedConfigVersion", fullConfig.version || "");
                viewModel.setProperty("/selectedValidationMessages",
                    storedValidationMessages(fullConfig.validationErrors, fullConfig.validationWarnings));
            }
            // The strip follows at once; the editor stays read-only until it holds this document.
            this._applyActiveState(fullConfig.isActive === true);

            const editor = this._getActiveEditor();
            if (!editor) {
                return;
            }

            if (!fullConfig.configData) {
                console.log("No configData field, setting placeholder");
                editor.setValue("{\n  " + JSON.stringify("// " + this.text("jsonEditorConfigUnavailable")) + ": true,\n  \"configId\": \"" + configId + "\"\n}");
                return;
            }

            let formatted: string;
            try {
                formatted = JSON.stringify(JSON.parse(fullConfig.configData), null, 2);
            } catch (e) {
                console.log("JSON parse error, setting raw value");
                editor.setValue(fullConfig.configData);
                return;
            }

            console.log("Setting JSON editor value (formatted)");
            editor.setValue(formatted);
            this._editorConfigId = configId;

            // Set up dirty state tracking (will be activated when edit mode is enabled)
            this._setupDirtyStateTracking(editor, formatted);

            // Edit-first: an inactive config is editable at load (no Edit gate); an active one
            // stays read-only. The editor's editable is bound to /isEditMode.
            this._applyActiveState(fullConfig.isActive === true);
        }).catch((error: any) => {
            console.error("Error loading full config:", error);
            if (!this._detailLoad.isCurrent(token)) {
                return;
            }
            this._shownLoad = token;
            const editor = this._getActiveEditor();
            if (editor) {
                editor.setValue("{\n  " + JSON.stringify("// " + this.text("jsonEditorLoadError")) + ": true,\n  \"error\": \"" + error.message + "\"\n}");
            }
        });
    }

    /** The open detail's edit state, for model/activeState.ts. */
    private _detailEdits(): DetailEdits {
        const openId = this._selectedConfig?.ID ?? null;
        return {
            editorLoaded: openId !== null && this._editorConfigId === openId,
            unsavedEdits: this._hasUnsavedChanges() || this._configForm?.hasUnsavedEdits() === true
        };
    }

    /**
     * The one writer of the open configuration's read-only state: the strip in both views, the
     * JSON editor's editability with its Cancel and Save (model/activeState.ts), and the form's
     * controls. Called when the configuration's document loads and whenever its row's isActive
     * may have changed (`_followOpenRowActiveState`). Unsaved edits stay where they are.
     */
    private _applyActiveState(isActive: boolean): void {
        const state = activeState(isActive, this._detailEdits());
        const viewModel = this.getOwnerComponent()?.getModel("viewModel") as JSONModel;
        viewModel?.setProperty("/selectedConfigIsActive", state.readOnly);
        viewModel?.setProperty("/isEditMode", state.editorEditable);
        this._configForm?.onActiveStateChanged(isActive);
    }

    /**
     * After the list has (re)loaded - Activate, Rollback, Save, Refresh - the detail page's row
     * context carries the open configuration's current isActive; the detail follows it. Not while
     * a newer press is still loading: that configuration's own load applies its state.
     */
    private _followOpenRowActiveState(): void {
        if (this._shownLoad === null || !this._detailLoad.isCurrent(this._shownLoad)) {
            return;
        }
        const row = this._openContextRow();
        if (!row || row.ID !== this._selectedConfig?.ID || typeof row.isActive !== "boolean") {
            return;
        }
        this._applyActiveState(row.isActive);
    }

    /**
     * Close detail view
     */
    public async onCloseDetail(): Promise<void> {
        // Same reason as in onItemPress: the form's own edits are invisible to the editor's
        // dirty tracking, so closing the column has to ask the form first.
        if (this._configForm && !(await this._configForm.confirmLeave())) {
            console.log("Close detail cancelled due to unsaved form changes");
            return;
        }

        // Check for unsaved changes before closing
        if (this._hasUnsavedChanges()) {
            const confirmLeave = await this._confirmNavigationWithUnsavedChanges();
            if (!confirmLeave) {
                console.log("Close detail cancelled due to unsaved changes");
                return;
            } else {
                // User accepted data loss - reset dirty state
                console.log("🗑️ User accepted data loss - resetting dirty state");
                this._isEditorDirty = false;
                this._updateDirtyStateUI();
            }
        }
        
        this._resetDetail();
    }

    /**
     * Empties the detail column: Close and a Delete that removed the open configuration both end
     * here, so neither can leave part of the old configuration in the title or the form. The ticked
     * rows are the toolbar's and stay ticked.
     */
    private _resetDetail(): void {
        // A read still in flight belongs to the configuration being closed.
        this._detailLoad.cancel();

        const fcl = this.byId("fcl") as FlexibleColumnLayoutControl;
        if (fcl) {
            fcl.setLayout("OneColumn");
        }

        // Clear binding context from detail page
        const detailPage = this.byId("detailDynamicPage");
        if (detailPage) {
            detailPage.setBindingContext(NO_BINDING_CONTEXT);
        }

        const viewModel = this.getOwnerComponent()?.getModel("viewModel") as JSONModel;
        if (viewModel) {
            viewModel.setProperty("/selectedConfigId", null);
            viewModel.setProperty("/selectedConfigIsActive", false);
            viewModel.setProperty("/selectedConfigName", "");
            viewModel.setProperty("/selectedConfigVersion", "");
            viewModel.setProperty("/isEditMode", false);
            viewModel.setProperty("/selectedValidationMessages", []);
            viewModel.updateBindings(true);
        }
        
        
        this._selectedConfig = null;
        this._editorConfigId = null;
        this._shownLoad = null;

        // Clear the form view along with it
        this._configForm?.reset();
    }

    /**
     * Switch the detail column between the JSON editor and the schema-driven form
     */
    public onConfigViewModeChange(event: SegmentedButton$SelectionChangeEvent): void {
        const key = event.getParameter("item")?.getKey();
        if (key) {
            this._configForm?.onViewModeChange(key);
        }
    }

    /**
     * Save from the form view. The form writes its result into the JSON editor and this goes
     * through onSaveConfiguration unchanged - the form never saves directly.
     */
    public onConfigFormSave(): void {
        this._configForm?.save();
    }

    /**
     * Cancel from the form view. Discards the form's pending edits and leaves it showing the
     * stored state; the form owns the discard, this only routes the press.
     */
    public onConfigFormCancel(): void {
        this._configForm?.cancel();
    }

    /**
     * Handle search from MDC FilterBar
     */
    public onSearch(event: any): void {
        console.log("📍 MDC FilterBar search triggered");
        this._applyFilters();
    }
    
    /**
     * Handle search field search event (Enter key)
     */
    public onSearchFieldSearch(event: any): void {
        console.log("📍 SearchField search event (Enter key pressed)");
        const query = event.getParameter("query") || event.getSource().getValue();
        console.log("Search query:", query);
        
        // Update viewModel with search value
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (viewModel) {
            viewModel.setProperty("/filters/search", query);
        }
        
        // Auto-trigger search
        this._applyFilters();
    }
    
    /**
     * Handle search field live change (update model only, no auto-trigger)
     */
    public onSearchFieldLiveChange(event: any): void {
        const query = event.getParameter("newValue");
        console.log("📍 SearchField live change:", query);
        
        // Update viewModel with search value but don't auto-apply
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (viewModel) {
            viewModel.setProperty("/filters/search", query);
        }
    }

    /**
     * Handle filter change (no auto-apply, wait for Go button)
     */
    public onFilterChange(event: any): void {
        console.log("🔍 Filter changed, waiting for Go button...");
        // Just log the change, don't auto-apply
    }
    
    /**
     * Apply filters when Go button is pressed
     */
    public onApplyFilters(): void {
        console.log("🔍 Go button pressed, applying filters...");
        this._applyFilters();
    }


    /**
     * Clear all filters (MDC FilterBar clear event)
     */
    public onClearFilters(): void {
        console.log("🧹 Clearing all filters");
        
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (viewModel) {
            viewModel.setProperty("/filters", {
                search: "",
                status: "",
                validation: "",
                name: ""
            });
        }

        // Clear search field directly
        const searchField = this.byId("searchField");
        if (searchField) {
            (searchField as any).setValue("");
        }
        
        // Clear other filter controls
        const statusFilter = this.byId("statusFilter");
        if (statusFilter) {
            (statusFilter as any).setSelectedKey("");
        }
        
        const validationFilter = this.byId("validationFilter");
        if (validationFilter) {
            (validationFilter as any).setSelectedKey("");
        }
        
        const nameFilter = this.byId("nameFilter");
        if (nameFilter) {
            (nameFilter as any).setValue("");
        }

        // Auto-apply cleared filters
        this._applyFilters();
    }
    

    /**
     * Apply all active filters with modern auto-trigger approach
     */
    private _applyFilters(): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        const filters = viewModel?.getProperty("/filters") || {};
        
        console.log("🔍 Applying filters:", filters);
        
        const table = this.byId("configTable") as Table;
        const binding = table.getBinding("items") as ODataListBinding | undefined;
        
        if (binding) {
            const filterArray: Filter[] = [];
            
            // Search filter - use value from viewModel
            const searchQuery = filters.search || "";
            if (searchQuery.trim()) {
                const searchFilters = [
                    new Filter("name", FilterOperator.Contains, searchQuery),
                    new Filter("description", FilterOperator.Contains, searchQuery),
                    new Filter("version", FilterOperator.Contains, searchQuery)
                ];
                filterArray.push(new Filter(searchFilters, false)); // OR logic
                console.log("🔍 Applied search filter:", searchQuery);
            }
            
            // Status filter
            if (filters.status === "active") {
                filterArray.push(new Filter("isActive", FilterOperator.EQ, true));
                console.log("🔍 Applied status filter: active");
            } else if (filters.status === "inactive") {
                filterArray.push(new Filter("isActive", FilterOperator.EQ, false));
                console.log("🔍 Applied status filter: inactive");
            }
            
            // Validation filter
            if (filters.validation === "valid") {
                filterArray.push(new Filter("isValid", FilterOperator.EQ, true));
                console.log("🔍 Applied validation filter: valid");
            } else if (filters.validation === "invalid") {
                filterArray.push(new Filter("isValid", FilterOperator.EQ, false));
                console.log("🔍 Applied validation filter: invalid");
            }
            
            // Name filter
            if (filters.name?.trim()) {
                filterArray.push(new Filter("name", FilterOperator.Contains, filters.name));
                console.log("🔍 Applied name filter:", filters.name);
            }
            
            binding.filter(filterArray);
            console.log("✅ Filters applied successfully, count:", filterArray.length);
            
            // Refresh binding after applying filters to ensure fresh data
            binding.refresh();
        }
    }

    /**
     * Refresh configurations
     */
    public onRefresh(): void {
        const table = this.byId("configTable") as Table;
        const binding = table.getBinding("items");
        if (binding) {
            binding.refresh();
        }
        MessageToast.show(this.text("configRefreshed"));
    }

    /**
     * Open new configuration dialog
     */
    public onNewConfiguration(): void {
        const dialog = this.byId("createConfigDialog") as Dialog;
        
        // Reset form and set create mode
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (viewModel) {
            viewModel.setProperty("/dialogMode", "create");
            viewModel.setProperty("/dialogTitle", this.text("createConfigTitle"));
            viewModel.setProperty("/newConfig", {
                name: "",
                version: "",
                description: "",
                configData: "{\n  \n}"
            });
        }
        
        dialog.open();
        
        // Trigger CodeEditor resize after dialog opens with dynamic height calculation
        setTimeout(() => {
            this._setDynamicEditorHeight("newConfigEditor");
            this._setupDialogResizeHandler("newConfigEditor");
        }, 100);
    }

    /**
     * Create new configuration
     */
    public onCreateConfiguration(): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        const newConfig = viewModel?.getProperty("/newConfig");
        
        // Validate required fields
        if (!newConfig?.name || !newConfig?.version || !newConfig?.configData) {
            MessageBox.error(this.text("fillRequiredFields"));
            return;
        }

        // Validate JSON syntax
        try {
            JSON.parse(newConfig.configData);
        } catch (e) {
            MessageBox.error(this.text("invalidJsonInConfigData"));
            return;
        }

        if (viewModel) {
            viewModel.setProperty("/busy", true);
        }

        const oModel = this.getView()?.getModel() as ODataModel;
        let createBinding: any = null;

        // First validate the configuration data using backend validation
        const validateBinding = oModel.bindContext("/validateConfiguration(...)");
        validateBinding.setParameter("configData", newConfig.configData);

        validateBinding.execute().then(() => {
            const validationResult = validateBinding.getBoundContext()?.getObject();
            
            if (!validationResult?.valid) {
                const message = validationResult?.errors?.length
                    ? this.text("configValidationFailedDetails", [validationResult.errors.join("\n")])
                    : this.text("configValidationFailed");
                MessageBox.error(message);
                if (viewModel) {
                    viewModel.setProperty("/busy", false);
                }
                return Promise.reject(new Error("Validation failed"));
            }

            // If validation passes, proceed with creation
            createBinding = oModel.bindContext("/createConfiguration(...)");
            
            createBinding.setParameter("name", newConfig.name);
            createBinding.setParameter("configData", newConfig.configData);
            createBinding.setParameter("description", newConfig.description);

            return createBinding.execute();
        }).then(() => {
            // Get the result from the create binding
            const createResult = createBinding?.getBoundContext()?.getObject();
            
            if (createResult?.success) {
                MessageToast.show(this.text("configCreated"));
                this.onCancelCreateConfiguration(); // This will clean up resize handler
                this._loadConfigurations();
            } else {
                MessageBox.error(this.text("createFailed", [createResult?.errors?.join(", ") || this.text("unknownError")]));
            }
        }).catch((error: Error) => {
            if (error.message !== "Validation failed") {
                MessageBox.error(this.text("errorCreatingConfigDetail", [error.message]));
            }
        }).finally(() => {
            if (viewModel) {
                viewModel.setProperty("/busy", false);
            }
        });
    }

    /**
     * Cancel create configuration
     */
    public onCancelCreateConfiguration(): void {
        const dialog = this.byId("createConfigDialog") as Dialog;
        dialog.close();
        
        // Clean up resize handler when dialog closes
        this._cleanupDialogResizeHandler();
    }

    /**
     * Set up dirty state tracking for an editor
     */
    private _setupDirtyStateTracking(editor: CodeEditor, initialValue: string): void {
        if (!editor) return;
        
        console.log("🔍 Setting up dirty state tracking for editor:", editor.getId());
        this._originalEditorValue = initialValue;
        this._isEditorDirty = false;
        
        // Remove any existing change handlers to avoid duplicates
        editor.detachChange(this._onEditorChange, this);
        
        // Attach change handler
        editor.attachChange(this._onEditorChange, this);
        
        console.log("✅ Dirty state tracking enabled");
    }
    
    /**
     * Handle editor change events for dirty state tracking
     */
    private _onEditorChange(): void {
        const editor = this._getActiveEditor();
        if (!editor) return;
        
        const currentValue = editor.getValue();
        const wasDirty = this._isEditorDirty;
        this._isEditorDirty = currentValue !== this._originalEditorValue;
        
        if (wasDirty !== this._isEditorDirty) {
            console.log(`📝 Editor dirty state changed: ${this._isEditorDirty ? 'DIRTY' : 'CLEAN'}`);
            
            // Update UI to show dirty state (could add * to title, etc.)
            this._updateDirtyStateUI();
        }
    }
    
    /**
     * Update UI to reflect dirty state
     */
    private _updateDirtyStateUI(): void {
        // Could add visual indicators here, like:
        // - Adding asterisk (*) to configuration name
        // - Changing save button appearance
        // - Adding warning colors
        
        console.log(`🎨 UI dirty state: ${this._isEditorDirty ? 'Modified' : 'Saved'}`);
    }
    
    /**
     * Check if editor has unsaved changes
     */
    private _hasUnsavedChanges(): boolean {
        return this._isEditorDirty;
    }
    
    /**
     * Reset dirty state (call after successful save)
     */
    private _resetDirtyState(): void {
        const editor = this._getActiveEditor();
        if (editor) {
            this._originalEditorValue = editor.getValue();
            this._isEditorDirty = false;
            this._updateDirtyStateUI();
            console.log("✅ Dirty state reset after save");
        }
    }

    /**
     * The form confirmed by reading it back that the editor's document is the stored one (Save from
     * the activation prompt), so the editor has nothing unsaved - also when Save stored nothing
     * because the edit only changed whitespace.
     */
    public markEditorSaved(): void {
        this._resetDirtyState();
    }

    /**
     * Show confirmation dialog for navigation with unsaved changes
     */
    private _confirmNavigationWithUnsavedChanges(): Promise<boolean> {
        return new Promise((resolve) => {
            MessageBox.confirm(
                this.text("unsavedChangesMessage"),
                {
                    title: this.text("unsavedChangesTitle"),
                    actions: [MessageBox.Action.YES, MessageBox.Action.CANCEL],
                    emphasizedAction: MessageBox.Action.CANCEL,
                    onClose: (action: string) => {
                        resolve(action === MessageBox.Action.YES);
                    }
                }
            );
        });
    }

    /**
     * The detail column's JSON editor, declared in the view
     */
    private _getActiveEditor(): CodeEditor | null {
        const editor = this.byId("jsonEditor") as CodeEditor | undefined;
        if (editor) {
            return editor;
        }
        
        console.error("❌ No usable editor found");
        return null;
    }

    /**
     * Validate configuration
     */
    public onValidateConfiguration(): void {
        if (!this._selectedConfig) {
            return;
        }

        const editor = this._getActiveEditor();
        if (!editor) {
            MessageBox.error(this.text("editorUnavailableValidate"));
            return;
        }
        
        const configData = editor.getValue();

        // Validate JSON syntax first
        try {
            JSON.parse(configData);
        } catch (e) {
            MessageBox.error(this.text("invalidJson"));
            return;
        }

        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (viewModel) {
            viewModel.setProperty("/busy", true);
        }

        // Call validateConfiguration action
        const oModel = this.getView()?.getModel() as ODataModel;
        const actionBinding = oModel.bindContext("/validateConfiguration(...)");
        
        actionBinding.setParameter("configData", configData);

        actionBinding.execute().then(() => {
            const result = actionBinding.getBoundContext()?.getObject();
            if (result?.valid) {
                MessageToast.show(this.text("configValidationPassed"));
            } else {
                const message = result?.errors?.length
                    ? this.text("configValidationFailedDetails", [result.errors.join("\n")])
                    : this.text("configValidationFailed");
                MessageBox.error(message);
            }
        }).catch((error: Error) => {
            MessageBox.error(this.text("errorValidatingConfigDetail", [error.message]));
        }).finally(() => {
            if (viewModel) {
                viewModel.setProperty("/busy", false);
            }
        });
    }

    /**
     * Save configuration changes with automatic validation
     */
    public onSaveConfiguration(): void {
        if (!this._selectedConfig) {
            return;
        }

        // Its row left the list (a filter): there is no row state to judge and no context to save to
        if (!this._openRowOrExplain()) {
            return;
        }

        // Prevent saving active configurations - judged by the open configuration, never a ticked row
        if (!canSave(this._openRow())) {
            MessageBox.error(this.text("cannotSaveActive"));
            return;
        }

        const editor = this._getActiveEditor();
        if (!editor) {
            MessageBox.error(this.text("editorUnavailableSave"));
            return;
        }
        
        const configData = editor.getValue();
        
        // Check if any changes were made
        console.log("🔍 Checking for changes...");
        console.log("Current config data length:", configData.length);
        console.log("Original config data length:", this._originalEditorValue?.length || 0);
        
        if (configData === this._originalEditorValue) {
            MessageToast.show(this.text("noChangesDetected"));
            console.log("💡 Save skipped - no changes detected (exact match)");
            return;
        }
        
        // Also check normalized JSON to handle formatting differences
        try {
            const currentNormalized = JSON.stringify(JSON.parse(configData));
            const originalNormalized = this._originalEditorValue ? JSON.stringify(JSON.parse(this._originalEditorValue)) : "";
            
            if (currentNormalized === originalNormalized) {
                MessageToast.show(this.text("noChangesDetected"));
                console.log("💡 Save skipped - no changes detected (normalized match)");
                return;
            }
        } catch (e) {
            console.log("📝 JSON normalization failed, proceeding with string comparison");
        }

        // Validate JSON syntax
        try {
            JSON.parse(configData);
        } catch (e) {
            MessageBox.error(this.text("invalidJsonCannotSave"));
            return;
        }

        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (viewModel) {
            viewModel.setProperty("/busy", true);
        }
        
        // Auto-validate before saving
        console.log("🔍 Auto-validating configuration before save...");
        this._validateBeforeSave(configData, viewModel);
    }
    
    /**
     * Validate configuration before saving
     */
    private _validateBeforeSave(configData: string, viewModel: JSONModel | null): void {
        const oModel = this.getView()?.getModel() as ODataModel;
        const validateBinding = oModel.bindContext("/validateConfiguration(...)");
        validateBinding.setParameter("configData", configData);

        validateBinding.execute().then(() => {
            const validationResult = validateBinding.getBoundContext()?.getObject();
            
            if (!validationResult?.valid) {
                // Validation failed - show error and don't save
                const message = validationResult?.errors?.length
                    ? this.text("validationFailedCannotSaveDetails", [validationResult.errors.join("\n")])
                    : this.text("validationFailedCannotSave");
                MessageBox.error(message);
                
                if (viewModel) {
                    viewModel.setProperty("/busy", false);
                }
                return;
            }
            
            // Validation passed - proceed with save
            console.log("✅ Validation passed, proceeding with save...");
            this._proceedWithSave(configData, viewModel);
            
        }).catch((error: Error) => {
            console.error("❌ Validation error:", error);
            MessageBox.error(this.text("validationErrorCannotSave", [error.message]));
            
            if (viewModel) {
                viewModel.setProperty("/busy", false);
            }
        });
    }
    
    /**
     * Proceed with save after validation passes
     */
    private _proceedWithSave(configData: string, viewModel: JSONModel | null): void {
        // Update the configuration via OData V4 action or direct PATCH
        const oModel = this.getView()?.getModel() as ODataModel;
        
        try {
            console.log("📝 Attempting to save configuration:", this._selectedConfig.ID);
            
            // Use direct property update (updateConfiguration action not available in service)
            console.log("Using direct property update");
            this._saveViaDirectUpdate(oModel, configData, viewModel);
        } catch (error) {
            console.error("❌ Save setup error:", error);
            MessageBox.error(this.text("saveSetupError", [(error as Error).message]));
            if (viewModel) {
                viewModel.setProperty("/busy", false);
            }
        }
    }

    /**
     * Fallback method to save via direct property update
     */
    private _saveViaDirectUpdate(oModel: ODataModel, configData: string, viewModel: JSONModel | null): void {
        console.log("Attempting direct property update...");
        
        // Use the existing binding context from the detail page if available
        const detailPage = this.byId("detailDynamicPage");
        let context = detailPage?.getBindingContext();
        
        if (!context) {
            // Create a new binding context
            console.log("Creating new binding context for save");
            const bindingContext = oModel.bindContext(`/ApiConfigurations(ID='${this._selectedConfig.ID}')`);
            
            bindingContext.requestObject().then(() => {
                const boundContext = bindingContext.getBoundContext();
                if (boundContext) {
                    this._updateContextProperty(boundContext, configData, oModel, viewModel);
                } else {
                    throw new Error("Failed to get bound context");
                }
            }).catch((error: Error) => {
                console.error("❌ Direct update failed:", error);
                MessageBox.error(this.text("saveFailed", [error.message]));
                if (viewModel) {
                    viewModel.setProperty("/busy", false);
                }
            });
        } else {
            // Use existing context
            console.log("Using existing binding context for save");
            this._updateContextProperty(context, configData, oModel, viewModel);
        }
    }
    
    /**
     * Update the context property and submit changes
     */
    private _updateContextProperty(context: any, configData: string, oModel: ODataModel, viewModel: JSONModel | null): void {
        try {
            console.log("Setting configData property on context");

            // The PATCH's own outcome: the server refuses an invalid document or a change to the
            // active configuration (400), and then the model resets the property and this rejects.
            // submitBatch alone resolves either way.
            let patched: Promise<void>;
            if (context.setProperty) {
                patched = context.setProperty("configData", configData);
            } else if (context.getObject) {
                const obj = context.getObject();
                obj.configData = configData;
                patched = Promise.resolve();
            } else {
                throw new Error("Unable to set property on context");
            }

            console.log("✅ Property set, submitting batch...");

            const configId = this._selectedConfig.ID as string;
            // Submit the changes
            Promise.all([patched, oModel.submitBatch(oModel.getUpdateGroupId())]).then(() => {
                console.log("✅ Direct save completed successfully");
                MessageToast.show(this.text("configSaved"));
                this._resetDirtyState();
                this._loadConfigurations();
                this._refreshValidationMessages(configId);
            }).catch((error: Error) => {
                console.error("❌ Batch submit error:", error);
                MessageBox.error(this.text("submitFailed", [error.message]));
            }).finally(() => {
                if (viewModel) {
                    viewModel.setProperty("/busy", false);
                }
            });
            
        } catch (error) {
            console.error("❌ Property update error:", error);
            MessageBox.error(this.text("updatePropertyFailed", [(error as Error).message]));
            if (viewModel) {
                viewModel.setProperty("/busy", false);
            }
        }
    }

    /**
     * A save stores the document's validation result anew (the server recomputes it), so the
     * title's validation strips are read again - from a fresh read of the saved row, as
     * `_loadConfigurationDetails` reads them. Dropped if another configuration was opened since.
     */
    private _refreshValidationMessages(configId: string): void {
        const oModel = this.getView()?.getModel() as ODataModel;
        const viewModel = this.getOwnerComponent()?.getModel("viewModel") as JSONModel;
        const shownLoad = this._shownLoad;
        oModel.bindContext(`/ApiConfigurations(ID='${configId}')`).requestObject().then((saved: unknown) => {
            if (shownLoad === null || !this._detailLoad.isCurrent(shownLoad) || this._selectedConfig?.ID !== configId) {
                return;
            }
            const row = saved as { validationErrors?: unknown; validationWarnings?: unknown } | undefined;
            viewModel?.setProperty("/selectedValidationMessages",
                storedValidationMessages(row?.validationErrors, row?.validationWarnings));
        }).catch((error: Error) => {
            console.error("Re-reading the saved configuration's validation results failed:", error);
        });
    }

    /**
     * Activate the one ticked configuration (the toolbar)
     */
    public onActivateConfiguration(): void {
        const activateId = this._selectionState().activateId;
        const config = this._tickedRows().find((row) => row.ID === activateId);
        if (!config) {
            MessageBox.error(this.text("selectConfigToActivate"));
            return;
        }
        void this._confirmActivate(config);
    }

    /**
     * Activation takes the stored document, so edits of the open configuration that are not saved
     * yet would silently not be part of it. Asks Save / Discard / Cancel (the form's prompt and
     * buttons); resolves true to go on - nothing pending, saved and confirmed stored, or discarded.
     * Without the form (it is created in onInit) Save stores the editor's document but cannot
     * confirm it landed, so it does not go on to activate.
     */
    private _settleEditsBeforeActivate(): Promise<boolean> {
        const open = this._openContextRow();
        const form = this._configForm;
        if (!open || !activeState(open.isActive === true, this._detailEdits()).activateAsksFirst) {
            return Promise.resolve(true);
        }
        const saveAction = this.text("formLeaveSave");
        const discardAction = this.text("formLeaveDiscard");
        return new Promise<boolean>((resolve) => {
            MessageBox.confirm(this.text("activateUnsavedMessage"), {
                title: this.text("unsavedChangesTitle"),
                actions: [saveAction, discardAction, MessageBox.Action.CANCEL],
                emphasizedAction: saveAction,
                onClose: (action: string) => {
                    if (action === saveAction) {
                        if (form) {
                            void form.saveEdits().then(resolve);
                        } else {
                            this.onSaveConfiguration();
                            resolve(false);
                        }
                    } else if (action === discardAction) {
                        // The editor back to the stored document, then the form from it.
                        this.onCancelEdits();
                        form?.discardEdits();
                        resolve(true);
                    } else {
                        resolve(false);
                    }
                }
            });
        });
    }

    /**
     * The open configuration as the list holds it now: the detail page's binding context, which
     * the title's status and the title-bar actions' visibility bind to and which follows every list
     * refresh. `_selectedConfig` is a copy taken when the detail loaded and goes stale once another
     * row is activated, so the title-bar actions never decide by it.
     */
    private _openContextRow(): ApiConfigurationRow | undefined {
        const context = this.byId("detailDynamicPage")?.getBindingContext();
        const row = context?.getObject() as ApiConfigurationRow | undefined;
        return row?.ID ? row : undefined;
    }

    /**
     * The open configuration's live row for an action on it - or, when a configuration is open but
     * its row has left the list (a filter), nothing, after saying so. The list then drops the row's
     * context, so the detail page has none; falling back to `_selectedConfig` would decide by a copy
     * taken at load whose isActive can be stale, and Save writes through that context anyway.
     */
    private _openRowOrExplain(): ApiConfigurationRow | undefined {
        const row = this._openContextRow();
        if (!row && this._selectedConfig) {
            MessageBox.information(this.text("openConfigNotInList"));
        }
        return row;
    }

    /**
     * Activate the open configuration (the detail's title bar), judged by its live row state
     */
    public onActivateOpenConfiguration(): void {
        const config = this._openRowOrExplain();
        if (!config || !activeState(config.isActive === true, this._detailEdits()).canActivate) {
            return;
        }
        void this._confirmActivate(config);
    }

    /**
     * Asks before activating `config`, which restarts the gateway. Activating the open
     * configuration settles its unsaved edits first.
     */
    private async _confirmActivate(config: { ID: string; name: string; version: string }): Promise<void> {
        if (config.ID === this._openContextRow()?.ID && !(await this._settleEditsBeforeActivate())) {
            return;
        }
        const confirmText = this.text("confirmActivateRestart", [config.name, config.version]);
        
        MessageBox.confirm(confirmText, {
            onClose: (action: string) => {
                if (action === MessageBox.Action.OK) {
                    this._activateConfiguration(config.ID);
                }
            }
        });
    }

    /**
     * Internal method to activate configuration
     */
    private _activateConfiguration(configId: string): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (viewModel) {
            viewModel.setProperty("/busy", true);
        }

        const oModel = this.getView()?.getModel() as ODataModel;
        const actionBinding = oModel.bindContext("/activateConfiguration(...)");
        
        actionBinding.setParameter("configId", configId);

        actionBinding.execute().then(() => {
            const result = actionBinding.getBoundContext()?.getObject();
            if (result?.success) {
                MessageToast.show(this.text("configActivated"));
                this._loadConfigurations();
            } else {
                MessageBox.error(this.text("activateFailed", [result?.error || this.text("unknownError")]));
            }
        }).catch((error: Error) => {
            MessageBox.error(this.text("errorActivatingConfigDetail", [error.message]));
        }).finally(() => {
            if (viewModel) {
                viewModel.setProperty("/busy", false);
            }
        });
    }

    /**
     * Duplicate the one ticked configuration (the toolbar). Its editor text is used only when it is
     * the open configuration; any other row is copied from its stored document.
     */
    public onDuplicateConfiguration(): void {
        const state = this._selectionState();
        if (state.duplicateId === null) {
            MessageBox.error(this.text("selectOneToDuplicate"));
            return;
        }
        this._duplicateConfiguration(state.duplicateId, state.duplicateFromEditor);
    }

    /**
     * Duplicate the open configuration (the detail's title bar), as its editor shows it
     */
    public onDuplicateOpenConfiguration(): void {
        const config = this._openRowOrExplain();
        if (!config) {
            return;
        }
        this._duplicateConfiguration(config.ID, true);
    }

    /**
     * Opens the create dialog on a copy of `selectedConfigId`. `fromEditor`: the copy takes the
     * open editor's text (possibly unsaved) - only for the open configuration, and only once the
     * editor holds that configuration's document.
     */
    private _duplicateConfiguration(selectedConfigId: string, fromEditor: boolean): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;

        // In the form view the edits live in the form's document; put them into the editor first,
        // verified, as Save does - otherwise the copy would miss them. Refused -> nothing opens.
        if (fromEditor && this._editorConfigId === selectedConfigId && this._configForm && !this._configForm.syncEditor()) {
            return;
        }

        if (viewModel) {
            viewModel.setProperty("/busy", true);
        }

        // Always fetch the complete configuration data from the server
        const oModel = this.getView()?.getModel() as ODataModel;
        const configContext = oModel.bindContext(`/ApiConfigurations(ID='${selectedConfigId}')`);
        
        configContext.requestObject().then((fullConfig: any) => {
            console.log("Full config loaded for duplication:", fullConfig);
            
            // Get configData, either from editor (if detail view is open) or from server
            let configData = fullConfig.configData || "{}";
            
            // The open configuration's editor content (possibly unsaved) wins over its stored copy
            const editor = this.byId("jsonEditor") as CodeEditor;
            if (editor && fromEditor && this._editorConfigId === selectedConfigId) {
                const editorValue = editor.getValue();
                if (editorValue && editorValue.trim()) {
                    configData = editorValue;
                }
            }
            
            // Format the JSON nicely for the new config editor
            let formattedConfigData = configData;
            try {
                formattedConfigData = JSON.stringify(JSON.parse(configData), null, 2);
            } catch (e) {
                // Keep original if not valid JSON
                formattedConfigData = configData;
            }
            
            if (viewModel) {
                viewModel.setProperty("/dialogMode", "duplicate");
                viewModel.setProperty("/dialogTitle", this.text("duplicateConfigTitle"));
                viewModel.setProperty("/newConfig", {
                    name: this.text("duplicateName", [fullConfig.name]),
                    version: fullConfig.version,
                    description: fullConfig.description || "",
                    configData: formattedConfigData
                });
            }
            
            const dialog = this.byId("createConfigDialog") as Dialog;
            dialog.open();
            
            // Trigger CodeEditor resize after dialog opens with dynamic height calculation
            setTimeout(() => {
                this._setDynamicEditorHeight("newConfigEditor");
                this._setupDialogResizeHandler("newConfigEditor");
            }, 100);
            
        }).catch((error: any) => {
            console.error("Error loading configuration for duplication:", error);
            MessageBox.error(this.text("duplicateLoadFailed", [error.message]));
        }).finally(() => {
            if (viewModel) {
                viewModel.setProperty("/busy", false);
            }
        });
    }

    /**
     * Delete the ticked configurations (the toolbar). Offered only while none of them is active.
     */
    public onDeleteConfiguration(): void {
        const state = this._selectionState();
        if (!state.canDelete) {
            MessageBox.error(this.text("selectConfigsToDelete"));
            return;
        }

        const confirmText = this.text("confirmDeleteCount", [state.deleteIds.length]);
        
        MessageBox.confirm(confirmText, {
            onClose: (action: string) => {
                if (action === MessageBox.Action.OK) {
                    this._deleteConfigurations(state.deleteIds, state.deleteClosesDetail);
                }
            }
        });
    }

    /**
     * Internal method to delete configurations by IDs. `closesDetail`: the open configuration is
     * one of them, so the detail column closes with it.
     */
    private _deleteConfigurations(configIds: string[], closesDetail: boolean): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (viewModel) {
            viewModel.setProperty("/busy", true);
        }

        // Find the contexts for the selected configurations
        const table = this.byId("configTable") as Table;
        const binding = table.getBinding("items") as ODataListBinding | undefined;
        const contexts = binding?.getCurrentContexts();
        
        const targetContexts: ODataContext[] = [];
        if (contexts) {
            for (const context of contexts) {
                const config = context.getObject();
                if (config?.ID && configIds.includes(config.ID)) {
                    targetContexts.push(context);
                }
            }
        }

        if (targetContexts.length === 0) {
            MessageBox.error(this.text("deleteContextsNotFound"));
            if (viewModel) {
                viewModel.setProperty("/busy", false);
            }
            return;
        }

        // Delete all selected configurations
        Promise.all(targetContexts.map(context => context.delete())).then(() => {
            MessageToast.show(this.text("configsDeleted", [targetContexts.length]));

            table.removeSelections();
            this._updateToolbar();
            if (closesDetail) {
                this._resetDetail();
            }
            
            // Refresh the list
            this._loadConfigurations();
        }).catch((error: Error) => {
            console.error("Delete error:", error);
            
            // Extract more meaningful error message from OData error structure
            let errorMessage = this.text("errorDeletingConfigs");
            
            if (error && (error as any).response && (error as any).response.body) {
                const errorBody = (error as any).response.body;
                if (errorBody.error && errorBody.error.message) {
                    errorMessage = errorBody.error.message;
                } else if (errorBody.message) {
                    errorMessage = errorBody.message;
                }
            } else if (error.message) {
                // Check if it's a generic "Forbidden" and provide better context
                if (error.message.toLowerCase().includes('forbidden')) {
                    errorMessage = this.text("deleteActiveForbidden");
                } else {
                    errorMessage = error.message;
                }
            }
            
            MessageBox.error(errorMessage);
        }).finally(() => {
            if (viewModel) {
                viewModel.setProperty("/busy", false);
            }
        });
    }

    /**
     * Handle JSON editor changes
     */
    public onConfigDataChange(): void {
        // Could add auto-validation or change tracking here
    }

    /** The cockpit language as a BCP 47 tag: dates follow it, not the browser's language. */
    private locale(): string {
        return Localization.getLanguageTag().toString();
    }

    /**
     * Format date for display
     */
    public formatDate(dateValue: string): string {
        if (!dateValue) return "";
        try {
            const date = new Date(dateValue);
            return date.toLocaleDateString(this.locale()) + " " + date.toLocaleTimeString(this.locale(), {hour: '2-digit', minute:'2-digit'});
        } catch (e) {
            return dateValue;
        }
    }

    /**
     * Format datetime for display with more detail
     */
    public formatDateTime(dateValue: string, pattern: string): string {
        if (!dateValue) return "";
        try {
            const date = new Date(dateValue);
            return formatMessage(pattern, [date.toLocaleDateString(this.locale()), date.toLocaleTimeString(this.locale())]);
        } catch (e) {
            return dateValue;
        }
    }

    /**
     * "{date} at {time} by {user}" for the detail page, from the bundle's two patterns; just
     * "{date} at {time}" when the row has no modifier, never a dangling "by"
     */
    public formatModifiedAtBy(pattern: string, dateTimePattern: string, dateValue: string, user: string): string {
        if (!pattern || !dateTimePattern) return "";
        const when = this.formatDateTime(dateValue, dateTimePattern);
        return user ? formatMessage(pattern, [when, user]) : when;
    }

    /**
     * Fills a bundle pattern bound as the first part with the remaining parts
     */
    public formatPattern(pattern: string, ...args: unknown[]): string {
        if (!pattern) return "";
        return formatMessage(pattern, args.map((arg) => arg ?? ""));
    }

    /**
     * Defensive boolean formatter - handles any type conversion issues
     */
    public bool(v: any): boolean {
        // Handle various truthy boolean representations
        if (v === true || v === 1 || v === "1" || v === "true" || v === "Yes") {
            return true;
        }
        // Handle various falsy boolean representations  
        if (v === false || v === 0 || v === "0" || v === "false" || v === "No") {
            return false;
        }
        // Default to falsy for unknown values
        return false;
    }

    /**
     * Format active status text
     */
    public activeText(v: any, activeLabel: string, inactiveLabel: string): string {
        return this.bool(v) ? activeLabel : inactiveLabel;
    }

    /**
     * Format active status state
     */
    public activeState(v: any): string {
        return this.bool(v) ? "Success" : "None";
    }

    /**
     * Format active status icon
     */
    public activeIcon(v: any): string {
        return this.bool(v) ? "sap-icon://accept" : "sap-icon://pending";
    }


    /**
     * Open rollback reason dialog
     */
    public onRollbackConfiguration(): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (viewModel) {
            // Clear previous reason
            viewModel.setProperty("/rollbackReason", "");
        }
        
        const dialog = this.byId("rollbackReasonDialog") as Dialog;
        dialog.open();
    }

    /**
     * Cancel rollback
     */
    public onCancelRollback(): void {
        const dialog = this.byId("rollbackReasonDialog") as Dialog;
        dialog.close();
        
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (viewModel) {
            viewModel.setProperty("/rollbackReason", "");
        }
    }

    /**
     * Handle rollback reason input change
     */
    public onRollbackReasonChange(event: any): void {
        const value = event.getParameter("value");
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (viewModel) {
            viewModel.setProperty("/rollbackReason", value);
        }
    }

    /**
     * Execute rollback configuration
     */
    public onConfirmRollback(): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        const rollbackReason = viewModel?.getProperty("/rollbackReason")?.trim();
        
        // Validate reason is provided
        if (!rollbackReason) {
            MessageBox.error(this.text("rollbackReasonRequired"));
            return;
        }

        // Close dialog immediately since reason is provided
        const dialog = this.byId("rollbackReasonDialog") as Dialog;
        dialog.close();

        if (viewModel) {
            viewModel.setProperty("/busy", true);
        }

        const oModel = this.getView()?.getModel() as ODataModel;
        const actionBinding = oModel.bindContext("/rollbackConfiguration(...)");
        
        actionBinding.setParameter("reason", rollbackReason);

        actionBinding.execute().then(() => {
            const result = actionBinding.getBoundContext()?.getObject();
            
            if (result?.success) {
                const message = this.text("rollbackSuccess", [result.rolledBackFrom, result.rolledBackTo, result.reason, new Date(result.rolledBackAt).toLocaleString(this.locale())]);
                MessageBox.success(message);
            } else {
                MessageBox.error(this.text("rollbackFailed", [result?.error || this.text("unknownError")]));
            }
            
            // Always refresh the table after rollback attempt
            this._refreshTable();
        }).catch((error: Error) => {
            console.error("Rollback error:", error);
            
            // Extract meaningful error message
            let errorMessage = this.text("errorDuringRollback");
            if (error && (error as any).response && (error as any).response.body) {
                const errorBody = (error as any).response.body;
                if (errorBody.error && errorBody.error.message) {
                    errorMessage = errorBody.error.message;
                } else if (errorBody.message) {
                    errorMessage = errorBody.message;
                }
            } else if (error.message) {
                errorMessage = error.message;
            }
            
            MessageBox.error(errorMessage);
            
            // Refresh table even on error to show current state
            this._refreshTable();
        }).finally(() => {
            if (viewModel) {
                viewModel.setProperty("/busy", false);
                // Clear the rollback reason after operation
                viewModel.setProperty("/rollbackReason", "");
            }
        });
    }

    /**
     * Refresh the configuration table
     */
    private _refreshTable(): void {
        const table = this.byId("configTable") as Table;
        const binding = table.getBinding("items");
        if (binding) {
            binding.refresh();
        }
    }

    /**
     * Discard unsaved JSON edits and stay in edit mode (edit-first: an inactive config is always
     * editable, so Cancel reverts content rather than dropping to a read-only state).
     */
    public onCancelEdits(): void {
        const editor = this._getActiveEditor();
        if (editor && this._originalEditorValue !== undefined) {
            editor.setValue(this._originalEditorValue);
            this._isEditorDirty = false;
            this._updateDirtyStateUI();
            console.log("📝 Cancelled edits - reverted to loaded content, still editable");
        }
    }

    /**
     * Set dynamic height for CodeEditor based on dialog dimensions and structure
     */
    private _setDynamicEditorHeight(editorId: string): void {
        const editor = this.byId(editorId) as CodeEditor;
        if (!editor) {
            console.warn(`CodeEditor ${editorId} not found for dynamic height setting`);
            return;
        }

        // Wait for editor to be rendered, then calculate optimal height
        setTimeout(() => {
            const editorDom = editor.getDomRef();
            if (!editorDom) {
                console.warn("CodeEditor DOM not ready, falling back to fixed height");
                this._setFixedEditorHeight(editor, 400);
                return;
            }

            // Find dialog body and panel to calculate available space
            const dialogBody = document.querySelector('.dialogBody') as HTMLElement;
            const rightPanel = editorDom.closest('.fullHeightPanel') as HTMLElement;
            
            if (!dialogBody || !rightPanel) {
                console.warn("Dialog structure not found, falling back to fixed height");
                this._setFixedEditorHeight(editor, 400);
                return;
            }

            // Calculate available height based on dialog structure
            const dialogBodyHeight = dialogBody.getBoundingClientRect().height;
            const panelHeaderHeight = 44; // Approximate panel header height
            const panelPadding = 24; // 12px top + 12px bottom padding
            const buffer = 20; // Safety buffer
            
            // Calculate optimal height: dialog body height minus panel overhead
            const optimalHeight = Math.max(dialogBodyHeight - panelHeaderHeight - panelPadding - buffer, 200);
            
            console.log(`Calculated optimal height for ${editorId}:`, {
                dialogBodyHeight,
                panelHeaderHeight,
                panelPadding,
                buffer,
                optimalHeight
            });

            // Apply the calculated height
            this._setFixedEditorHeight(editor, optimalHeight);
        }, 150); // Delay to ensure DOM is fully rendered
    }

    /**
     * Set fixed height on CodeEditor and its ACE editor
     */
    private _setFixedEditorHeight(editor: CodeEditor, height: number): void {
        const heightPx = height + "px";
        
        // Set height on the UI5 CodeEditor
        editor.setHeight(heightPx);
        
        // Also set height on the DOM element directly
        const editorDom = editor.getDomRef() as HTMLElement | null;
        if (editorDom) {
            editorDom.style.height = heightPx;
            editorDom.style.minHeight = heightPx;
            
            // Set height on ACE editor inside
            const aceEditor = editorDom.querySelector('.ace_editor') as HTMLElement;
            if (aceEditor) {
                aceEditor.style.height = heightPx;
                aceEditor.style.minHeight = heightPx;
            }
        }

        // Trigger ACE editor resize if available
        setTimeout(() => {
            (editor as any).getAggregation?.("_editor")?.resize?.();
        }, 50);

        console.log(`✅ CodeEditor height set to ${heightPx} dynamically`);
    }

    /**
     * Setup resize observer for dialog to recalculate editor height on resize
     */
    private _setupDialogResizeHandler(editorId: string): void {
        const dialog = this.byId("createConfigDialog") as Dialog;
        if (!dialog) {
            console.warn("Dialog not found for resize handler setup");
            return;
        }

        // Clean up any existing resize observer
        this._cleanupDialogResizeHandler();

        // Wait for dialog to be fully rendered
        setTimeout(() => {
            const dialogDom = dialog.getDomRef();
            if (!dialogDom) {
                console.warn("Dialog DOM not available for resize handler");
                return;
            }

            // Create ResizeObserver to watch dialog size changes
            this._dialogResizeObserver = new ResizeObserver((entries) => {
                // Throttle resize events to avoid excessive recalculations
                if (this._resizeThrottleTimeout) {
                    clearTimeout(this._resizeThrottleTimeout);
                }

                this._resizeThrottleTimeout = setTimeout(() => {
                    console.log("Dialog resized, recalculating editor height...");
                    this._setDynamicEditorHeight(editorId);
                }, 250); // 250ms throttle
            });

            // Observe the dialog element for size changes
            this._dialogResizeObserver.observe(dialogDom);
            console.log("✅ Dialog resize handler setup complete");
        }, 200);
    }

    /**
     * Clean up dialog resize handler
     */
    private _cleanupDialogResizeHandler(): void {
        if (this._dialogResizeObserver) {
            this._dialogResizeObserver.disconnect();
            this._dialogResizeObserver = null;
            console.log("🧹 Dialog resize observer cleaned up");
        }

        if (this._resizeThrottleTimeout) {
            clearTimeout(this._resizeThrottleTimeout);
            this._resizeThrottleTimeout = null;
        }
    }

    /**
     * Format the configuration title for display
     */
    public formatConfigTitle(name: string, version: string, detailsTitle: string): string {
        if (!name || !version) {
            return detailsTitle;
        }
        return `${name} (${version})`;
    }
}
