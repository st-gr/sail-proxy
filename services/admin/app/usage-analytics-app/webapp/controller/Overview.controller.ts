import Controller from "sap/ui/core/mvc/Controller";
import JSONModel from "sap/ui/model/json/JSONModel";
import MessageToast from "sap/m/MessageToast";
import ODataModel from "sap/ui/model/odata/v4/ODataModel";
import ODataContextBinding from "sap/ui/model/odata/v4/ODataContextBinding";
import DateRangeSelection from "sap/m/DateRangeSelection";
import Select from "sap/m/Select";
import Popover from "sap/m/Popover";
import FormattedText from "sap/m/FormattedText";
import VizFrame from "sap/viz/ui5/controls/VizFrame";
import VizPopover from "sap/viz/ui5/controls/Popover";
import FlattenedDataset from "sap/viz/ui5/data/FlattenedDataset";
import DimensionDefinition from "sap/viz/ui5/data/DimensionDefinition";
import MeasureDefinition from "sap/viz/ui5/data/MeasureDefinition";
import UIComponent from "sap/ui/core/UIComponent";
import IconTabBar from "sap/m/IconTabBar";
import FeedItem from "sap/viz/ui5/controls/common/feeds/FeedItem";
import ResourceModel from "sap/ui/model/resource/ResourceModel";
import formatMessage from "sap/base/strings/formatMessage";
import Localization from "sap/base/i18n/Localization";
import Filter from "sap/ui/model/Filter";
import { connectionChartState, avgCostPerRequest } from "../model/connectionSpend";
import { readsSapTenants, tenantFilter, tenantOptions, foldByApiKey, costFiguresByKey, rowCost, totalsCost, sapCostTileText, sapCostTileCurrencies, connectionOptions, usageParams, ConnectionRow, TenantRow } from "../model/tenantFilter";
// import Spreadsheet from "sap/ui/export/Spreadsheet";
// import { EdmType } from "sap/ui/export/util/Type";

export default class OverviewController extends Controller {

    private _sapCostInfoPopover?: Popover;

    /**
     * A text from the app bundle, with {0}-style arguments. Synchronous so formatters can use it;
     * onInit waits for the bundle before loading data, so it is there when texts are needed.
     */
    private text(key: string, args?: unknown[]): string {
        const model = this.getOwnerComponent()?.getModel("i18n") as ResourceModel | undefined;
        const pattern = (model?.getProperty(key) as string | null | undefined) ?? key;
        return args ? formatMessage(pattern, args) : pattern;
    }

    /** The cockpit language as a BCP 47 tag: dates and numbers follow it, not 'en-US' or the browser's language. */
    private locale(): string {
        return Localization.getLanguageTag().toString();
    }

    /** toFixed's digits with the locale's decimal sign, so English stays byte-identical to toFixed. */
    private fixed(value: number, digits: number): string {
        const sign = new Intl.NumberFormat(this.locale()).formatToParts(1.5).find((part) => part.type === "decimal")?.value ?? ".";
        return value.toFixed(digits).replace(".", sign);
    }

    /** The name of a time period key ("month", "custom", ...) in the user's language. */
    private _periodName(period: string): string {
        const names: Record<string, string> = {
            today: this.text("periodToday"),
            week: this.text("periodWeek"),
            month: this.text("periodMonth"),
            quarter: this.text("periodQuarter"),
            year: this.text("periodYear"),
            overall: this.text("periodOverall"),
            custom: this.text("periodCustom")
        };
        return names[period] ?? period;
    }

    /**
     * Explains how the SAP Cost tile amount is computed: the SAP AI Core Capacity-Unit billing
     * chain (model tokens -> GenAI Tokens -> Capacity Units -> SAP Cost). Opened by pressing a
     * SAP Cost tile on the Overview or Cost tab.
     */
    public onSapCostTileInfo(event: any): void {
        if (!this._sapCostInfoPopover) {
            this._sapCostInfoPopover = new Popover({
                title: this.text("sapCostInfoTitle"),
                placement: "Auto",
                contentWidth: "30rem",
                content: [
                    new FormattedText({
                        htmlText: this.text("sapCostInfoHtml")
                    })
                ]
            });
            this._sapCostInfoPopover.addStyleClass("sapUiContentPadding");
            this.getView()?.addDependent(this._sapCostInfoPopover);
        }
        this._sapCostInfoPopover.openBy(event.getSource());
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
                oView.setModel(oVM, "viewModel"); // attach for bindings in this view
            }
        }
        
        if (!oVM) {
            console.error("viewModel not found in Overview controller");
            return;
        }
        
        // Check if OData model is available and log debugging info
        let oDataModel = this.getView()?.getModel();
        console.log("[Overview.onInit] OData model available on view:", !!oDataModel);
        
        // If not available on view, try to get it from component and set it on view
        if (!oDataModel) {
            const component = this.getOwnerComponent();
            oDataModel = component?.getModel();
            console.log("[Overview.onInit] OData model available on component:", !!oDataModel);
            
            if (oDataModel && oView) {
                console.log("[Overview.onInit] Setting OData model on view from component");
                oView.setModel(oDataModel);
                oDataModel = this.getView()?.getModel(); // Re-get to confirm
            }
        }
        
        console.log("[Overview.onInit] Final OData model available:", !!oDataModel);
        console.log("[Overview.onInit] OData model type:", oDataModel?.getMetadata?.().getName?.());
        console.log("[Overview.onInit] OData service URL:", (oDataModel as ODataModel | undefined)?.getServiceUrl?.());
        
        // Always use live data from CAP service (Phase 1 complete)
        oVM.setProperty("/useMockData", false);
        
        if (!oDataModel) {
            console.error("[Overview.onInit] OData model not available - this should not happen in production");
            return;
        } else {
            console.log("[Overview.onInit] OData model available, using live data");
        }
        
        // Initialize time period selection (will be overridden by user preferences)
        oVM.setProperty("/selectedTimePeriod", "month");
        oVM.setProperty("/customDateRange", "");
        oVM.setProperty("/tenantScope", "");
        oVM.setProperty("/tenantScopes", []);
        oVM.setProperty("/tenantScopeVisible", false);
        oVM.setProperty("/connectionScope", "");
        oVM.setProperty("/connectionScopes", []);
        oVM.setProperty("/connectionScopeVisible", false);
        oVM.setProperty("/lastUpdated", new Date().toLocaleString(this.locale()));
        
        // Initialize selected tab (default to overview)
        oVM.setProperty("/selectedTab", "overview");
        
        // Create dedicated chart model
        const chartModel = new JSONModel();
        this.getView()?.setModel(chartModel, "chartModel");
        
        // Debug model inheritance
        const comp = this.getOwnerComponent();
        console.log("[dbg] Owner comp id:", comp?.getId());
        console.log("[dbg] Models on owner:", Object.keys((comp as any)?.oModels || {}));
        console.log("[dbg] Models propagated to view:", Object.keys((oView as any)?.oPropagatedProperties?.oModels || {}));
        console.log("[dbg] viewModel present?", !!oView?.getModel("viewModel"));
        console.log("[dbg] mockData present?", !!oView?.getModel("mockData"));
        
        // FORCE model inheritance since propagation failed
        if (comp && !oView?.getModel("mockData")) {
            const mockDataModel = comp.getModel("mockData");
            if (mockDataModel) {
                console.log("[dbg] Manually setting mockData model on view");
                oView?.setModel(mockDataModel, "mockData");
            }
        }
        
        // Load user preferences BEFORE loading initial data (preferences determine time period)
        const i18nModel = this.getOwnerComponent()?.getModel("i18n") as ResourceModel | undefined;
        Promise.resolve(i18nModel?.getResourceBundle()).catch(() => undefined)
            .then(() => this._loadUserPreferences())
            .then(() => {
                this._loadInitialData();
            });
        // Note: _setupCharts() is called after data is loaded in _prepareChartData()
        
        // Set up router event listener to sync tab selection
        const router = (this.getOwnerComponent() as UIComponent | undefined)?.getRouter();
        if (router) {
            router.attachRouteMatched(this._onRouteMatched.bind(this));
        }
        
    }


    /**
     * Load user preferences and set time period selection
     */
    private async _loadUserPreferences(): Promise<void> {
        const oDataModel = this.getView()?.getModel() as ODataModel;
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        
        if (!oDataModel || !viewModel) {
            console.warn("OData model or viewModel not available for loading preferences");
            return;
        }

        try {
            // Call getCurrentUserPreferences action
            const context = oDataModel.bindContext("/getCurrentUserPreferences(...)", undefined, {
                $$groupId: "$auto"
            });
            
            await context.execute();
            const preferences = context.getBoundContext()?.getObject();
            
            if (preferences && preferences.analyticsTimePeriod) {
                console.log("Loaded user preferences:", preferences);
                
                // Set time period preference in view model
                viewModel.setProperty("/selectedTimePeriod", preferences.analyticsTimePeriod);
                
                // Set custom date range if available
                if (preferences.analyticsCustomRange) {
                    try {
                        const customRange = JSON.parse(preferences.analyticsCustomRange);
                        
                        // If the stored custom range is valid, set it as Date objects in view model
                        if (customRange.from && customRange.to) {
                            console.log("Setting date range from preferences:", customRange);
                            viewModel.setProperty("/customDateRangeStart", new Date(customRange.from));
                            viewModel.setProperty("/customDateRangeEnd", new Date(customRange.to));
                        }
                    } catch (e) {
                        console.warn("Failed to parse custom date range:", preferences.analyticsCustomRange);
                    }
                }
            } else {
                console.log("No analytics preferences found, using defaults");
            }
        } catch (error) {
            console.error("Failed to load user preferences:", error);
            // Continue with defaults
        }
    }

    /**
     * Save time period preference to server
     */
    private async _saveTimePeriodPreference(timePeriod: string, customRange: any): Promise<void> {
        const oDataModel = this.getView()?.getModel() as ODataModel;
        
        if (!oDataModel) {
            console.warn("OData model not available for saving preferences");
            return;
        }

        try {
            // Save time period preference
            const timePeriodContext = oDataModel.bindContext("/updateUserPreference(...)", undefined, {
                $$groupId: "$auto"
            });
            timePeriodContext.setParameter("key", "analyticsTimePeriod");
            timePeriodContext.setParameter("value", timePeriod);
            
            const timePeriodResult = await timePeriodContext.execute();
            console.log("Time period preference saved:", timePeriodResult);
            
            // Save custom date range if it's a custom period
            if (timePeriod === "custom" && customRange) {
                const customRangeContext = oDataModel.bindContext("/updateUserPreference(...)", undefined, {
                    $$groupId: "$auto"
                });
                customRangeContext.setParameter("key", "analyticsCustomRange");
                customRangeContext.setParameter("value", JSON.stringify(customRange));
                
                const customRangeResult = await customRangeContext.execute();
                console.log("Custom date range preference saved:", customRangeResult);
            }
        } catch (error) {
            console.error("Failed to save time period preference:", error);
            // Don't show error to user, just log it
        }
    }

    /**
     * Load initial usage statistics data
     */
    /** Counts the data loads; a load that is no longer the latest must not write data or clear busy. */
    private _loadSeq = 0;

    private async _loadInitialData(): Promise<void> {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (!viewModel) {
            console.error("viewModel is undefined in _loadInitialData");
            return;
        }
        const loadId = ++this._loadSeq;
        viewModel.setProperty("/busy", true);
        
        try {
            console.log("Loading live data from CAP service...");
            if (((viewModel.getProperty("/teamScopes") as unknown[]) || []).length === 0) await this._loadTeamScopes();
            if (!this._tenantsLoaded) await this._loadTenantScopes();
            await this._loadApiKeyOwners();
            if (loadId !== this._loadSeq) return;
            await this._loadLiveData(loadId);
            if (loadId !== this._loadSeq) return;
            await this._loadSapBillingStats();
        } catch (error) {
            if (loadId !== this._loadSeq) return;
            console.error("Error loading usage statistics:", error);
            // A scoped request the server refuses (stale team selection) carries its own message.
            const scoped = !!viewModel.getProperty("/teamScope");
            MessageToast.show(scoped && (error as Error)?.message ? (error as Error).message : this.text("errorLoadingStats"));
            // Initialize with empty data structure on error
            this._processUsageData({
                apiKeyUsage: [],
                awsCredentialUsage: [],
                providerUsage: [],
                emailUsage: [],
                endpointUsage: [],
                modelUsage: []
            });
        } finally {
            if (loadId === this._loadSeq) viewModel.setProperty("/busy", false);
        }
    }

    /**
     * Load live data from CAP OData service
     */
    private async _loadLiveData(loadId: number): Promise<void> {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        const oDataModel = this.getView()?.getModel() as ODataModel;
        
        // Check if OData model is available
        if (!oDataModel) {
            console.error("OData model not available. Falling back to mock data.");
            throw new Error("OData model not available");
        }
        
        // Get date range from current time period selection
        const selectedTimePeriod = viewModel.getProperty("/selectedTimePeriod") || "month";
        const dateRange = this._calculateDateRange(selectedTimePeriod);
        const granularity = this._getGranularityForPeriod(selectedTimePeriod);
        
        // Update viewModel with calculated date range
        viewModel.setProperty("/dateRange", dateRange);
        viewModel.setProperty("/granularity", granularity);
        
        const parameters = {
            startDate: this._formatDateForOData(dateRange.startDate),
            endDate: this._formatDateForOData(dateRange.endDate),
            granularity: granularity
        };

        console.log("CAP Service Request Parameters:", parameters);
        console.log("OData Model available:", !!oDataModel);
        console.log("OData Model service URL:", oDataModel?.getServiceUrl?.());

        try {
            // getUsageStatistics is an Action (POST), not a Function (GET)
            // For OData V4 actions, we need to create a deferred binding context
            const context = oDataModel.bindContext("/getUsageStatistics(...)", undefined, {
                $$groupId: "$auto"
            });
            context.setParameter("startDate", parameters.startDate);
            context.setParameter("endDate", parameters.endDate);
            context.setParameter("granularity", parameters.granularity);
            const teamScope = viewModel.getProperty("/teamScope") as string;
            if (teamScope) context.setParameter("teamId", teamScope);
            const extra = usageParams(this._tenantInUse(), viewModel.getProperty("/connectionScope") as string);
            Object.entries(extra).forEach(([name, value]) => context.setParameter(name, value));
            
            await context.execute();
            if (loadId !== this._loadSeq) return;
            const result = context.getBoundContext()?.getObject();
            
            console.log("CAP Service Response:", result);
            // The Connection Select lists the connections with usage in this period; a chosen one without any
            // falls back to all connections, and the figures are read again unfiltered.
            if (result && (await this._updateConnectionScopes(result.connectionNames || [], loadId))) {
                return this._loadLiveData(loadId);
            }
            
            if (result && typeof result === 'object') {
                this._processUsageData(result);
                MessageToast.show(this.text("usageDataLoaded", [this._periodName(selectedTimePeriod)]));
            } else {
                console.warn("Empty or invalid response from CAP service");
                MessageToast.show(this.text("noUsageData"));
                // Initialize with empty data structure
                this._processUsageData({
                    apiKeyUsage: [],
                    awsCredentialUsage: [],
                    providerUsage: [],
                    emailUsage: [],
                    endpointUsage: [],
                    modelUsage: []
                });
            }
        } catch (error) {
            console.error("CAP OData request failed:", error);
            throw error;
        }
    }

    /** The Team selector: platform admins pick any team or "All teams", team admins one of their teams or "My usage". */
    private async _loadTeamScopes(): Promise<void> {
        const viewModel = this.getView()!.getModel("viewModel") as JSONModel;
        await (this.getOwnerComponent() as UIComponent & { userContextReady?: Promise<void> }).userContextReady;
        const ctx = viewModel.getProperty("/userContext") || {};
        const model = this.getView()!.getModel() as ODataModel;
        const scopes: Array<{ key: string; text: string }> = [];
        try {
            if (ctx.isAdmin) {
                const contexts = await model.bindList("/Teams", undefined, [], undefined,
                    { $select: "ID,name", $orderby: "name", $filter: "IsActiveEntity eq true" }).requestContexts(0, 500);
                scopes.push({ key: "", text: this.text("teamScopeAll") },
                    ...contexts.map((c) => {
                        const name = c.getProperty("name") as string;
                        return { key: c.getProperty("ID") as string, text: name };
                    }));
            } else if (ctx.isTeamAdmin) {
                const op = model.bindContext("/myTeams(...)") as ODataContextBinding;
                await op.execute();
                const teams = ((op.getBoundContext()?.getObject() as { value?: Array<{ teamId: string; name: string; role: string }> })?.value) ?? [];
                scopes.push({ key: "", text: this.text("teamScopeMine") },
                    ...teams.filter((t) => t.role === "admin").map((t) => ({ key: t.teamId, text: t.name })));
            }
        } catch (error) {
            // No selector: the statistics load unscoped, exactly as before.
            console.warn("Could not load the team scopes:", error);
            scopes.length = 0;
        }
        viewModel.setProperty("/teamScopes", scopes);
        if (!scopes.some((s) => s.key === viewModel.getProperty("/teamScope"))) viewModel.setProperty("/teamScope", "");
    }

    /** Whether the SAP tenants were read; they are read once per session, like the team scopes. */
    private _tenantsLoaded = false;

    /**
     * The tenant Select (SAP bills per subaccount, so an invoice is compared with one tenant's usage):
     * "All tenants" and each tenant by displayName or zone; hidden with at most one tenant, which is
     * then preselected. A failed read leaves the figures unfiltered, as before.
     */
    private async _loadTenantScopes(): Promise<void> {
        const viewModel = this.getView()!.getModel("viewModel") as JSONModel;
        const model = this.getView()!.getModel() as ODataModel;
        const userContext = viewModel.getProperty("/userContext");
        // SapTenants is admin-only: any other viewer gets no Select and no request (read once a context is known).
        if (!readsSapTenants(userContext)) {
            viewModel.setProperty("/tenantScopes", []);
            viewModel.setProperty("/tenantScopeVisible", false);
            viewModel.setProperty("/tenantScope", "");
            if (userContext) this._tenantsLoaded = true;
            return;
        }
        try {
            const contexts = await model.bindList("/SapTenants", undefined, [], undefined, { $select: "zone,displayName" }).requestContexts(0, 500);
            const options = tenantOptions(contexts.map((c) => c.getObject() as TenantRow), this.text("tenantScopeAll"));
            viewModel.setProperty("/tenantScopes", options.options);
            viewModel.setProperty("/tenantScopeVisible", options.visible);
            const current = viewModel.getProperty("/tenantScope") as string;
            viewModel.setProperty("/tenantScope", options.options.some((o) => o.key === current) ? current : options.selected);
            this._tenantsLoaded = true;
        } catch (error) {
            console.warn("Could not load the SAP tenants:", error);
            viewModel.setProperty("/tenantScopes", []);
            viewModel.setProperty("/tenantScopeVisible", false);
            viewModel.setProperty("/tenantScope", "");
        }
    }

    /** The tenant the figures are narrowed to: only when the Select is shown, so one tenant changes nothing. */
    private _tenantInUse(): string {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        return viewModel.getProperty("/tenantScopeVisible") ? (viewModel.getProperty("/tenantScope") as string) || "" : "";
    }

    /** Sets the Connection Select from the period's connection names; true when the chosen connection had to be reset. */
    private async _updateConnectionScopes(usedNames: string[], loadId: number): Promise<boolean> {
        const viewModel = this.getView()!.getModel("viewModel") as JSONModel;
        const model = this.getView()!.getModel() as ODataModel;
        let rows: ConnectionRow[] = [];
        // ProviderConnections is admin-only: any other viewer gets the raw connection names and no request is made.
        if (usedNames.length && viewModel.getProperty("/userContext")?.isAdmin) {
            try {
                const contexts = await model.bindList("/ProviderConnections", undefined, [], undefined, { $select: "name,title,providerType" }).requestContexts(0, 500);
                rows = contexts.map((c) => c.getObject() as ConnectionRow);
            } catch (error) {
                console.warn("Could not load the connections:", error);
            }
        }
        if (loadId !== this._loadSeq) return false;
        const options = connectionOptions(rows, usedNames, this.text("connectionScopeAll"));
        viewModel.setProperty("/connectionScopes", options.options);
        viewModel.setProperty("/connectionScopeVisible", options.visible);
        const current = viewModel.getProperty("/connectionScope") as string;
        if (current && !options.options.some((o) => o.key === current)) {
            viewModel.setProperty("/connectionScope", "");
            return true;
        }
        return false;
    }

    public onConnectionScopeChange(): void {
        this._loadInitialData();
    }

    public onTenantScopeChange(): void {
        this._loadInitialData();
    }

    /** The CSV line naming the selected tenant, empty while all tenants are shown. */
    private _tenantCsvLine(): string {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        const tenant = this._tenantInUse();
        if (!tenant) return "";
        const scopes = (viewModel.getProperty("/tenantScopes") || []) as Array<{ key: string; text: string }>;
        return `${this.text("tenantScope")}: ${scopes.find((s) => s.key === tenant)?.text ?? tenant}\n`;
    }

    public onTeamScopeChange(): void {
        this._loadInitialData();
    }

    /** The CSV line naming the selected team, empty while unscoped. */
    private _teamScopeCsvLine(): string {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        const scope = viewModel.getProperty("/teamScope") as string;
        if (!scope) return "";
        const scopes = (viewModel.getProperty("/teamScopes") || []) as Array<{ key: string; text: string }>;
        return `${this.text("teamScope")}: ${scopes.find((s) => s.key === scope)?.text ?? scope}\n`;
    }

    /** Cached API key id -> owner (name + email), so usage tables never show a raw GUID. */
    private _apiKeyOwners: Record<string, { name?: string; email?: string }> = {};

    /**
     * Fetch the API key id -> owner (name + email) map once per load. The stats/usage data
     * key on the key GUID only; this resolves each to its owner-facing identity (the service
     * RBAC-filters ApiKeys, so a non-admin only sees their own). Best-effort: on failure the
     * map is left empty and the tables fall back to the id. Two owners can both name a key
     * 'claude', which is why email is shown alongside the name.
     */
    private async _loadApiKeyOwners(): Promise<void> {
        const oDataModel = this.getView()?.getModel() as ODataModel;
        if (!oDataModel) {
            this._apiKeyOwners = {};
            return;
        }
        const owners: Record<string, { name?: string; email?: string }> = {};
        try {
            const keysBinding = oDataModel.bindList("/ApiKeys", undefined, undefined, undefined, {
                $select: "ID,name,email"
            });
            const keyContexts = await keysBinding.requestContexts(0, 1000);
            keyContexts.forEach(context => {
                const key = context.getObject() as { ID?: string; name?: string; email?: string };
                if (key?.ID) {
                    owners[key.ID] = { name: key.name, email: key.email };
                }
            });
        } catch (error) {
            console.warn("API key owner lookup failed; usage tables will show ids", error);
        }
        this._apiKeyOwners = owners;
    }

    /**
     * Load the SAP-native Capacity-Unit / cost aggregates (Task 11), beside the dollar-estimate
     * data loaded by _loadLiveData above. Read directly from the two OData entity sets rather
     * than folded into the getUsageStatistics() pipeline: capacityUnits/genAiTokens/
     * imageInputTokens are on ApiKeyUsageStats (currency-neutral, safe to sum per apiKey);
     * sapCost is priced per currency, so it lives on the separate ApiKeyUsageSapCostStats view
     * (grouped by apiKey + sapCostCurrency) to avoid summing different currencies together.
     * Failures here are logged and leave the SAP billing tables empty - they must never break
     * the main dashboard load.
     */
    private async _loadSapBillingStats(): Promise<void> {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        const oDataModel = this.getView()?.getModel() as ODataModel;
        if (!viewModel || !oDataModel) {
            return;
        }

        const filters = tenantFilter(this._tenantInUse()).map((f) => new Filter(f.path, f.operator as any, f.value1));

        try {
            // Resolve each api key GUID to its owner name + email from the map loaded up
            // front by _loadApiKeyOwners (the stats views key on the GUID only).
            const ownerById = this._apiKeyOwners;

            const withOwner = (rows: any[]): any[] =>
                rows.map(row => {
                    const owner = ownerById[row.apiKey_ID] || {};
                    return { ...row, apiKeyName: owner.name, apiKeyEmail: owner.email };
                });

            const capacityBinding = oDataModel.bindList("/ApiKeyUsageStats", undefined, undefined, filters, {
                $select: "apiKey_ID,sapTenant,totalImageInputTokens,totalImageOutputTokens,totalAudioInputTokens,totalAudioOutputTokens,totalGenAiTokens,totalCapacityUnits"
            });
            const capacityContexts = await capacityBinding.requestContexts();
            // A row per key and tenant: with all tenants shown, a key's rows are folded into one.
            const capacityRows = withOwner(foldByApiKey(capacityContexts.map(context => context.getObject()), [
                "totalImageInputTokens", "totalImageOutputTokens", "totalAudioInputTokens", "totalAudioOutputTokens", "totalGenAiTokens", "totalCapacityUnits"
            ]));

            // sapCost lives on a separate view grouped by apiKey + currency (a key can be
            // billed in more than one currency). Aggregate it per key from the PRICED rows
            // only (sapCostCurrency set); the unpriced rows - usage with no matching
            // ModelCosts/price yet - carry a null currency and would otherwise show as empty
            // $0.00 lines. Then fold the per-key cost into the capacity rows so there is one
            // row per API key.
            const costBinding = oDataModel.bindList("/ApiKeyUsageSapCostStats", undefined, undefined, filters, {
                $select: "apiKey_ID,sapTenant,sapCostCurrency,totalSapCost"
            });
            const costContexts = await costBinding.requestContexts();
            // Per key and currency, never one sum across currencies (a key can span tenants billed differently).
            const costByKey = costFiguresByKey(costContexts.map(context => context.getObject()));

            const merged = capacityRows.map((row: any) => {
                const cost = rowCost(costByKey[row.apiKey_ID]);
                const cu = Number(row.totalCapacityUnits) || 0;
                return {
                    ...row,
                    ...cost,
                    // Effective price per Capacity Unit so the row's arithmetic closes:
                    // Capacity Units x Price per CU = SAP Cost (the missing reconciliation link).
                    pricePerCu: cost.sapCost != null && cu > 0 ? cost.sapCost / cu : null
                };
            });
            viewModel.setProperty("/charts/sapBillingCapacityStats", merged);

            // Column totals for the bottom-of-table footer, so the figures can be reconciled
            // against the SAP invoice (which reports one total per service + subaccount).
            const cost = totalsCost(merged);
            viewModel.setProperty("/charts/sapBillingTotals", {
                totalImageInputTokens: merged.reduce((s, r) => s + (Number(r.totalImageInputTokens) || 0), 0),
                totalImageOutputTokens: merged.reduce((s, r) => s + (Number(r.totalImageOutputTokens) || 0), 0),
                totalAudioInputTokens: merged.reduce((s, r) => s + (Number(r.totalAudioInputTokens) || 0), 0),
                totalAudioOutputTokens: merged.reduce((s, r) => s + (Number(r.totalAudioOutputTokens) || 0), 0),
                totalGenAiTokens: merged.reduce((s, r) => s + (Number(r.totalGenAiTokens) || 0), 0),
                totalCapacityUnits: merged.reduce((s, r) => s + (Number(r.totalCapacityUnits) || 0), 0),
                // One total only for a single currency; several currencies are listed, never summed into one.
                totalSapCost: cost.sapCostByCurrency.length ? cost.sapCost : 0, // no cost at all stays 0, as before
                sapCostByCurrency: cost.sapCostByCurrency,
                // Blended effective price per CU for the footer: total SAP Cost / total Capacity Units.
                pricePerCu: (() => {
                    const cu = merged.reduce((s, r) => s + (Number(r.totalCapacityUnits) || 0), 0);
                    return cu > 0 && cost.sapCost ? cost.sapCost / cu : null;
                })(),
                sapCostCurrency: cost.sapCostCurrency
            });
        } catch (error) {
            console.error("Failed to load SAP-native CU/cost analytics:", error);
            viewModel.setProperty("/charts/sapBillingCapacityStats", []);
            viewModel.setProperty("/charts/sapBillingTotals", {});
        }

        // Team billing has its own failure path, so a failed team read leaves the per-key table intact.
        try {
            // Team billing is admin-only on the server; skip the read for other users (no 403 in the log).
            if (viewModel.getProperty("/userContext")?.isAdmin) {
                const teamBinding = oDataModel.bindList("/TeamSapBillingStats", undefined, undefined, filters, { $select: "teamId,sapCostCurrency,teamName,totalRequests,totalGenAiTokens,totalCapacityUnits,totalSapCost" });
                const teamRows = (await teamBinding.requestContexts()).map(context => context.getObject()).map((row: any) => {
                    const cu = Number(row.totalCapacityUnits) || 0; const cost = Number(row.totalSapCost) || 0;
                    return { ...row, teamName: row.teamName || this.text("noTeam"), sapCost: cost, pricePerCu: cu > 0 ? cost / cu : null };
                });
                viewModel.setProperty("/charts/sapBillingTeamStats", teamRows);
                const teamCurrencies = new Set(teamRows.map(r => r.sapCostCurrency));
                viewModel.setProperty("/charts/sapBillingTeamTotals", {
                    totalRequests: teamRows.reduce((s, r) => s + (Number(r.totalRequests) || 0), 0),
                    totalGenAiTokens: teamRows.reduce((s, r) => s + (Number(r.totalGenAiTokens) || 0), 0),
                    totalCapacityUnits: teamRows.reduce((s, r) => s + (Number(r.totalCapacityUnits) || 0), 0),
                    totalSapCost: teamRows.reduce((s, r) => s + (Number(r.sapCost) || 0), 0),
                    sapCostCurrency: teamCurrencies.size === 1 ? [...teamCurrencies][0] : null
                });
            }
        } catch (error) {
            console.error("Failed to load the SAP billing by team:", error);
            viewModel.setProperty("/charts/sapBillingTeamStats", []);
            viewModel.setProperty("/charts/sapBillingTeamTotals", {});
        }
    }

    /**
     * Process and transform raw usage data for UI consumption
     */
    private _processUsageData(data: any): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        const userContext = viewModel.getProperty("/userContext");
        
        // Safety check for userContext
        if (!userContext) {
            console.warn("User context not loaded yet, using default admin context");
            // Use default context as fallback
            const defaultUserContext = {
                email: "admin@example.com",
                isAdmin: true,
                roles: ["admin"]
            };
            viewModel.setProperty("/userContext", defaultUserContext);
            this._processUsageData(data); // Retry with default context
            return;
        }
        
        // Set raw data - handle both mock data and CAP service response formats
        viewModel.setProperty("/apiKeyUsage", data.apiKeyUsage || []);
        viewModel.setProperty("/awsCredentialUsage", data.awsCredentialUsage || []);
        viewModel.setProperty("/providerUsage", data.providerUsage || []);
        viewModel.setProperty("/emailUsage", data.emailUsage || []);
        viewModel.setProperty("/teamUsage", data.teamUsage || []);
        viewModel.setProperty("/endpointUsage", data.endpointUsage || []);
        viewModel.setProperty("/modelUsage", data.modelUsage || []);
        
        console.log("Raw usage data processed:", {
            apiKeyUsage: data.apiKeyUsage?.length || 0,
            awsCredentialUsage: data.awsCredentialUsage?.length || 0,
            providerUsage: data.providerUsage?.length || 0,
            emailUsage: data.emailUsage?.length || 0,
            endpointUsage: data.endpointUsage?.length || 0,
            modelUsage: data.modelUsage?.length || 0
        });

        // Calculate KPIs based on user context
        this._calculateKPIs(data, userContext);
        
        // Prepare chart data for all tabs
        this._prepareChartData(data);
        this._prepareCostData(data);
        this._preparePerformanceData(data);
        void this._prepareModelData(data).catch((error) => {
            console.error("Failed to prepare model data:", error);
        });
        
        // Set user-specific usage summary
        if (!userContext.isAdmin && !viewModel.getProperty("/teamScope")) {
            this._setMyUsageSummary(data, userContext.email);
        }
    }

    /**
     * Calculate KPI values from usage data
     */
    private _calculateKPIs(data: any, userContext: any): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        
        // Safety check for userContext
        if (!userContext) {
            console.error("userContext is undefined in _calculateKPIs");
            return;
        }
        
        let totalRequests = 0;
        let totalTokens = 0;
        let totalCost = 0;
        let totalResponseTime = 0;
        let responseTimeCount = 0;
        let totalErrors = 0;

        // Filter data based on user context
        let filteredProviderUsage = data.providerUsage || [];
        let filteredModelUsage = data.modelUsage || [];
        
        if (!userContext.isAdmin && !viewModel.getProperty("/teamScope")) {
            // For non-admin users, filter by their email in emailUsage
            const userEmailUsage = (data.emailUsage || []).find((usage: any) => usage.email === userContext.email);
            if (userEmailUsage) {
                totalRequests = userEmailUsage.totalRequests || 0;
                totalTokens = userEmailUsage.totalTokens || 0;
                totalCost = userEmailUsage.totalCost || 0;
                totalResponseTime = userEmailUsage.avgResponseTime * totalRequests || 0;
                responseTimeCount = totalRequests;
            }
        } else {
            // For admin users, aggregate from all providers
            filteredProviderUsage.forEach((provider: any) => {
                totalRequests += provider.totalRequests || 0;
                totalTokens += provider.totalTokens || 0;
                totalErrors += provider.errorCount || 0;
                if (provider.avgResponseTime) {
                    totalResponseTime += provider.avgResponseTime * provider.totalRequests;
                    responseTimeCount += provider.totalRequests;
                }
            });

            // Aggregate cost from API keys and AWS credentials
            (data.apiKeyUsage || []).forEach((apiKey: any) => {
                totalCost += apiKey.totalCost || 0;
            });
            
            (data.awsCredentialUsage || []).forEach((cred: any) => {
                totalCost += cred.totalCost || 0;
            });
        }

        const avgResponseTime = responseTimeCount > 0 ? Math.round(totalResponseTime / responseTimeCount) : 0;
        const errorRate = totalRequests > 0 ? totalErrors / totalRequests : 0;
        // The cost is the SAP token-cost estimate, so it is spread over the SAP requests only; the
        // connection rows share the usage rows' scope (the user's own for a non-admin).
        const avgCost = avgCostPerRequest(totalCost, totalRequests, data.connectionUsage);

        const kpis = {
            totalRequests,
            totalTokens,
            totalCost,
            avgResponseTime,
            errorRate,
            avgCostPerRequest: avgCost,
            targetRequests: totalRequests * 1.2, // 20% target increase
            maxRequests: totalRequests * 1.5
        };

        viewModel.setProperty("/kpis", kpis);
    }

    /**
     * Set usage summary for non-admin users
     */
    private _setMyUsageSummary(data: any, userEmail: string): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        
        const userEmailUsage = (data.emailUsage || []).find((usage: any) => usage.email === userEmail);
        
        if (userEmailUsage) {
            viewModel.setProperty("/myUsage", {
                totalRequests: userEmailUsage.totalRequests || 0,
                totalCost: userEmailUsage.totalCost || 0,
                avgResponseTime: userEmailUsage.avgResponseTime || 0,
                lastActivity: userEmailUsage.lastActivity || null
            });
        } else {
            viewModel.setProperty("/myUsage", {
                totalRequests: 0,
                totalCost: 0,
                avgResponseTime: 0,
                lastActivity: null
            });
        }
    }

    /**
     * Prepare data for charts
     */
    private _prepareChartData(data: any): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        const chartModel = this.getView()?.getModel("chartModel") as JSONModel;
        
        // Ensure provider usage data includes individual token fields
        const providerUsage = (data.providerUsage || []).map((provider: any) => ({
            ...provider,
            inputTokens: provider.totalInputTokens || 0,
            cacheCreationInputTokens: provider.totalCacheCreationInputTokens || 0,
            cacheReadInputTokens: provider.totalCacheReadInputTokens || 0,
            outputTokens: provider.totalOutputTokens || 0
        }));
        
        // Prepare model efficiency data for bubble chart
        const modelEfficiency = (data.modelUsage || []).map((model: any) => {
            const inputTokens = model.totalInputTokens || 0;
            const cacheCreationInputTokens = model.totalCacheCreationInputTokens || 0;
            const cacheReadInputTokens = model.totalCacheReadInputTokens || 0;
            const outputTokens = model.totalOutputTokens || 0;
            const totalTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens + outputTokens;
            return {
                ...model,
                inputTokens,
                cacheCreationInputTokens,
                cacheReadInputTokens,
                outputTokens,
                costPerToken: model.totalCost && totalTokens ? 
                    (model.totalCost / totalTokens * 1000000) : 0 // Cost per million tokens
            };
        });

        const chartData = {
            providerUsage,
            modelUsage: data.modelUsage || [],
            modelEfficiency,
            endpointUsage: data.endpointUsage || [],
            // Connection (external provider) spend, apart from SAP cost; /charts is written here only.
            ...connectionChartState(data.connectionUsage)
        };

        // Set data in both models
        viewModel.setProperty("/charts", chartData);
        
        // Set data directly in the dedicated chart model
        if (chartModel) {
            chartModel.setData(chartData);
            console.log("Chart model updated with data:", chartData);
            
            // Refresh chart bindings after data update
            this._refreshChartBindings();
        }
        
        // Debug: Check if table data is set correctly
        console.log("Charts data set:", chartData);
        console.log("Provider usage for table:", chartData.providerUsage);
        
        // Trigger chart setup after data is available
        setTimeout(() => {
            this._setupCharts();
        }, 200);
    }

    /**
     * Prepare cost-specific data for Cost Analysis tab
     */
    private _prepareCostData(data: any): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        const chartModel = this.getView()?.getModel("chartModel") as JSONModel;
        
        // Calculate cost data from both API keys and AWS credentials
        let totalSystemCost = 0;
        const apiKeyCosts = data.apiKeyUsage || [];
        const awsCredCosts = data.awsCredentialUsage || [];

        // Sum total costs from API keys and AWS credentials
        apiKeyCosts.forEach((apiKey: any) => {
            totalSystemCost += apiKey.totalCost || 0;
        });
        awsCredCosts.forEach((cred: any) => {
            totalSystemCost += cred.totalCost || 0;
        });

        // Calculate provider costs for pie chart (aggregate by provider)
        const providerCostMap = new Map();
        (data.providerUsage || []).forEach((provider: any) => {
            // Get total cost from model usage for this provider
            const providerModels = (data.modelUsage || []).filter((model: any) => model.provider === provider.provider);
            const providerTotalCost = providerModels.reduce((sum: number, model: any) => sum + (model.totalCost || 0), 0);
            providerCostMap.set(provider.provider, {
                provider: provider.provider,
                totalCost: providerTotalCost,
                costPercentage: 0 // Will be calculated below
            });
        });

        const providerCosts = Array.from(providerCostMap.values());
        const totalProviderCost = providerCosts.reduce((sum: number, p: any) => sum + p.totalCost, 0);
        providerCosts.forEach((p: any) => {
            p.costPercentage = totalProviderCost > 0 ? (p.totalCost / totalProviderCost) * 100 : 0;
        });
        
        // Add cost breakdown to model usage data
        const modelCostData = (data.modelUsage || []).map((model: any) => {
            const inputTokens = model.totalInputTokens || 0;
            const cacheCreationInputTokens = model.totalCacheCreationInputTokens || 0;
            const cacheReadInputTokens = model.totalCacheReadInputTokens || 0;
            const outputTokens = model.totalOutputTokens || 0;
            
            // Use individual costs from backend
            const inputCost = model.totalInputCost || 0;
            const cacheCreationCost = model.totalCacheCreationInputCost || 0;
            const cacheReadCost = model.totalCacheReadInputCost || 0;
            const outputCost = model.totalOutputCost || 0;
            
            return {
                ...model,
                inputTokens,
                cacheCreationInputTokens,
                cacheReadInputTokens,
                outputTokens,
                inputCost,
                cacheCreationCost,
                cacheReadCost,
                outputCost,
                costPerRequest: model.totalRequests > 0 ? (model.totalCost || 0) / model.totalRequests : 0
            };
        });

        // Prepare Top K API keys and AWS credentials by cost with individual token field mappings
        const topApiKeys = [...apiKeyCosts].map((apiKey: any) => ({
            ...apiKey,
            // Owner-facing identity resolved from the ApiKeys map (rows key on the GUID
            // keyId): show the name with the owner email beside it, never a raw GUID.
            keyName: apiKey.keyName || this._apiKeyOwners[apiKey.keyId]?.name,
            email: apiKey.email || this._apiKeyOwners[apiKey.keyId]?.email,
            inputTokens: apiKey.totalInputTokens || 0,
            cacheCreationInputTokens: apiKey.totalCacheCreationInputTokens || 0,
            cacheReadInputTokens: apiKey.totalCacheReadInputTokens || 0,
            outputTokens: apiKey.totalOutputTokens || 0
        })).sort((a: any, b: any) => (b.totalCost || 0) - (a.totalCost || 0)).slice(0, 50);
        
        const topAwsCredentials = [...awsCredCosts].map((cred: any) => ({
            ...cred,
            inputTokens: cred.totalInputTokens || 0,
            cacheCreationInputTokens: cred.totalCacheCreationInputTokens || 0,
            cacheReadInputTokens: cred.totalCacheReadInputTokens || 0,
            outputTokens: cred.totalOutputTokens || 0
        })).sort((a: any, b: any) => (b.totalCost || 0) - (a.totalCost || 0)).slice(0, 50);

        // Prepare Top K email usage with individual token field mappings (already has RBAC filtering from CAP service)
        const emailUsage = (data.emailUsage || []).map((email: any) => ({
            ...email,
            inputTokens: email.totalInputTokens || 0,
            cacheCreationInputTokens: email.totalCacheCreationInputTokens || 0,
            cacheReadInputTokens: email.totalCacheReadInputTokens || 0,
            outputTokens: email.totalOutputTokens || 0
        }));
        const topEmailsByUsage = [...emailUsage].sort((a: any, b: any) => (b.totalCost || 0) - (a.totalCost || 0)).slice(0, 50);
        
        // Ensure /cost section exists in the model
        if (!viewModel.getProperty("/cost")) {
            viewModel.setProperty("/cost", {});
        }
        
        // Preserve existing topK value to avoid overwriting user selection
        const currentTopK = viewModel.getProperty("/cost/topK");
        
        // Set cost-specific data
        viewModel.setProperty("/charts/providerCosts", providerCosts);
        viewModel.setProperty("/charts/modelCostData", modelCostData);
        
        // Only set default topK if it doesn't exist
        const finalTopK = currentTopK || "50";
        viewModel.setProperty("/cost/topK", finalTopK);
        
        // Use the current (or default) topK value to filter the lists
        const actualTopK = parseInt(finalTopK.toString(), 10);
        const filteredTopEmailsByUsage = topEmailsByUsage.slice(0, actualTopK);
        const filteredTopApiKeys = topApiKeys.slice(0, actualTopK);
        const filteredTopAwsCredentials = topAwsCredentials.slice(0, actualTopK);
        
        viewModel.setProperty("/charts/topEmailsByUsage", filteredTopEmailsByUsage);
        viewModel.setProperty("/charts/topApiKeys", filteredTopApiKeys);
        viewModel.setProperty("/charts/topAwsCredentials", filteredTopAwsCredentials);

        // Column totals for the footer (Totals) row of every Cost-tab table, so the figures
        // can be reconciled against the SAP invoice (one total per service + subaccount).
        const sumFields = (rows: any[], fields: string[]): Record<string, number> => {
            const totals: Record<string, number> = {};
            fields.forEach(f => { totals[f] = (rows || []).reduce((s, r) => s + (Number(r[f]) || 0), 0); });
            return totals;
        };
        const usageTotalFields = ["inputTokens", "cacheCreationInputTokens", "cacheReadInputTokens", "outputTokens", "totalCost", "totalRequests"];
        viewModel.setProperty("/charts/modelCostTotals", sumFields(modelCostData, [
            "inputTokens", "cacheCreationInputTokens", "cacheReadInputTokens", "outputTokens",
            "inputCost", "cacheCreationCost", "cacheReadCost", "outputCost", "totalCost"
        ]));
        viewModel.setProperty("/charts/topEmailsTotals", sumFields(filteredTopEmailsByUsage, [
            ...usageTotalFields, "uniqueApiKeysUsed", "uniqueAwsCredentialsUsed"
        ]));
        viewModel.setProperty("/charts/topApiKeysTotals", sumFields(filteredTopApiKeys, usageTotalFields));
        viewModel.setProperty("/charts/topAwsCredentialsTotals", sumFields(filteredTopAwsCredentials, usageTotalFields));

        this._setTopTeams(viewModel, data.teamUsage || [], actualTopK);

        // Update KPIs with better cost calculation
        const costKpis = viewModel.getProperty("/kpis") || {};
        costKpis.totalSystemCost = totalSystemCost;
        costKpis.avgCostPerProvider = providerCosts.length > 0 ? totalProviderCost / providerCosts.length : 0;
        viewModel.setProperty("/kpis", costKpis);
        
        if (chartModel) {
            chartModel.setProperty("/providerCosts", providerCosts);
            chartModel.setProperty("/modelCostData", modelCostData);
            chartModel.setProperty("/topEmailsByUsage", topEmailsByUsage);
            chartModel.setProperty("/topApiKeys", topApiKeys);
            chartModel.setProperty("/topAwsCredentials", topAwsCredentials);
            
            console.log("Cost data prepared:", {
                providerCosts: providerCosts.length,
                modelCostData: modelCostData.length,
                topApiKeys: topApiKeys.length,
                topAwsCredentials: topAwsCredentials.length,
                totalSystemCost
            });
        }
    }

    /**
     * Prepare performance-specific data for Performance Analysis tab
     */
    private _preparePerformanceData(data: any): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        const chartModel = this.getView()?.getModel("chartModel") as JSONModel;
        
        // Calculate success rates for providers
        const performanceData = (data.providerUsage || []).map((provider: any) => ({
            ...provider,
            successRate: provider.totalRequests > 0 ? 
                (provider.totalRequests - (provider.errorCount || 0)) / provider.totalRequests : 1
        }));
        
        // Sort by response time for performance analysis
        const sortedByPerformance = [...performanceData].sort((a, b) => 
            (a.avgResponseTime || 0) - (b.avgResponseTime || 0)
        );
        
        viewModel.setProperty("/charts/performanceData", performanceData);
        viewModel.setProperty("/charts/sortedByPerformance", sortedByPerformance);
        
        if (chartModel) {
            chartModel.setProperty("/performanceData", performanceData);
            chartModel.setProperty("/sortedByPerformance", sortedByPerformance);
        }
    }

    /**
     * Which models' usage is counted in cells (SAP-RPT) rather than tokens, keyed by model id -
     * backs the Unit column in the Model Performance Details table. Calls the unbound usageUnits()
     * function the same way getUsageStatistics/getCurrentUserPreferences are called above.
     */
    private async _usageUnitsByModel(): Promise<Map<string, string>> {
        const oDataModel = this.getView()?.getModel() as ODataModel;
        if (!oDataModel) return new Map();
        try {
            const context = oDataModel.bindContext("/usageUnits(...)", undefined, { $$groupId: "$auto" });
            await context.execute();
            const units = (context.getBoundContext()?.getObject() as { value?: { model: string; unit: string }[] })?.value || [];
            return new Map(units.map(u => [u.model, u.unit]));
        } catch (error) {
            console.error("Failed to load usage units:", error);
            return new Map();
        }
    }

    /**
     * Prepare model-specific data for Models Analysis tab
     */
    private async _prepareModelData(data: any): Promise<void> {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        const chartModel = this.getView()?.getModel("chartModel") as JSONModel;
        
        // Find top model by usage
        const modelUsage = data.modelUsage || [];
        const topModel = modelUsage.reduce((top: any, current: any) => {
            return !top || current.totalRequests > top.totalRequests ? current : top;
        }, null);
        
        // Sort models by requests for usage distribution
        const sortedModels = [...modelUsage].sort((a, b) => 
            (b.totalRequests || 0) - (a.totalRequests || 0)
        );
        
        const unitsByModel = await this._usageUnitsByModel();

        // Add costPerToken for efficiency column and ensure cache token fields are present
        const modelsWithEfficiency = modelUsage.map((model: any) => {
            const inputTokens = model.totalInputTokens || 0;
            const cacheCreationInputTokens = model.totalCacheCreationInputTokens || 0;
            const cacheReadInputTokens = model.totalCacheReadInputTokens || 0;
            const outputTokens = model.totalOutputTokens || 0;
            const totalTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens + outputTokens;
            const unit = unitsByModel.get(model.modelId) ?? "tokens";
            return {
                ...model,
                inputTokens,
                cacheCreationInputTokens,
                cacheReadInputTokens,
                outputTokens,
                costPerToken: model.totalCost && totalTokens ?
                    (model.totalCost / totalTokens * 1000000) : 0,
                unit,
                // Tokens per second only means something for token-billed models; SAP-RPT rows
                // count table cells and rerank rows search units, so they show no figure.
                tokensPerSecond: unit !== "tokens" ? null : (model.tokensPerSecond ?? null)
            };
        });
        
        viewModel.setProperty("/topModel", topModel || { modelId: "N/A" });
        viewModel.setProperty("/charts/sortedModels", sortedModels);
        viewModel.setProperty("/charts/modelsWithEfficiency", modelsWithEfficiency);
        
        if (chartModel) {
            chartModel.setProperty("/topModel", topModel);
            chartModel.setProperty("/sortedModels", sortedModels);
            chartModel.setProperty("/modelsWithEfficiency", modelsWithEfficiency);
        }
    }

    /**
     * Set up tab-specific charts when tab becomes active
     */
    private _setupTabSpecificCharts(tabKey: string): void {
        switch (tabKey) {
            case "overview":
                this._setupCharts(); // Existing overview charts
                break;
            case "costs":
                this._setupCostChart();
                break;
            case "performance":
                this._setupPerformanceChart();
                break;
            case "models":
                this._setupModelUsageChart();
                break;
        }
    }

    /**
     * Set up cost analysis pie chart
     */
    private _setupCostChart(): void {
        const costChart = this.byId("costChart") as any;
        const costPopover = this.byId("costPopover") as any;
        const chartModel = this.getView()?.getModel("chartModel") as JSONModel;
        
        console.log("Setting up cost chart:", {
            chartExists: !!costChart,
            popoverExists: !!costPopover,
            modelExists: !!chartModel
        });
        
        if (!costChart || !costPopover || !chartModel) {
            console.warn("Cost chart setup failed - missing elements");
            return;
        }
        
        costChart.setModel(chartModel);
        chartModel.setSizeLimit(2000);

        // Always recreate the dataset to ensure fresh data
        if (costChart.getDataset()) {
            costChart.destroyDataset();
        }
        if (costChart.getFeeds()?.length > 0) {
            costChart.destroyFeeds();
        }

        const providerCosts = chartModel.getProperty("/providerCosts") || [];
        console.log("Provider costs data for chart:", providerCosts);

        if (providerCosts.length > 0) {
            // Measure and dimension names are the legend, axis and popover labels; the feeds refer to them.
            const providerName = this.text("provider");
            const totalCostName = this.text("totalCost");
            const oDataset = new FlattenedDataset({
                dimensions: [new DimensionDefinition({ name: providerName, value: "{provider}" })],
                measures: [new MeasureDefinition({ name: totalCostName, value: "{totalCost}" })],
                data: { path: "/providerCosts" }
            });
            costChart.setDataset(oDataset);

            costChart.addFeed(new FeedItem({
                uid: "size", type: "Measure", values: [totalCostName]
            }));
            costChart.addFeed(new FeedItem({
                uid: "color", type: "Dimension", values: [providerName]
            }));

            costChart.setVizType("pie");
            costChart.setVizProperties({
                title: { text: this.text("chartCostDistribution") },
                plotArea: { 
                    dataLabel: { 
                        visible: true
                    } 
                },
                legend: { visible: true }
            });
            costPopover.connect(costChart.getVizUid());
            console.log("Cost chart configured successfully");
        } else {
            console.warn("No provider cost data available for chart");
        }
    }

    /**
     * Set up performance analysis chart
     */
    private _setupPerformanceChart(): void {
        const performanceChart = this.byId("performanceChart") as any;
        const performancePopover = this.byId("performancePopover") as any;
        const chartModel = this.getView()?.getModel("chartModel") as JSONModel;
        
        if (!performanceChart || !performancePopover || !chartModel) return;
        
        performanceChart.setModel(chartModel);
        
        if (!performanceChart.getDataset()) {
            // Measure and dimension names are the legend, axis and popover labels; the feeds refer to them.
            const providerName = this.text("provider");
            const avgResponseTimeName = this.text("avgResponseTime");
            const oDataset = new FlattenedDataset({
                dimensions: [new DimensionDefinition({ name: providerName, value: "{provider}" })],
                measures: [new MeasureDefinition({ name: avgResponseTimeName, value: "{avgResponseTime}" })],
                data: { path: "/performanceData" }
            });
            performanceChart.setDataset(oDataset);

            performanceChart.addFeed(new FeedItem({
                uid: "primaryValues", type: "Measure", values: [avgResponseTimeName]
            }));
            performanceChart.addFeed(new FeedItem({
                uid: "axisLabels", type: "Dimension", values: [providerName]
            }));

            performanceChart.setVizType("column");
            performanceChart.setVizProperties({
                title: { text: this.text("chartAvgResponseTimeByProvider") },
                plotArea: { dataLabel: { visible: true } },
                valueAxis: { title: { text: this.text("axisResponseTimeMs") } },
                categoryAxis: { title: { text: this.text("provider") } }
            });
            performancePopover.connect(performanceChart.getVizUid());
        }
    }

    /**
     * Set up model usage distribution chart
     */
    private _setupModelUsageChart(): void {
        const modelUsageChart = this.byId("modelUsageChart") as any;
        const modelUsagePopover = this.byId("modelUsagePopover") as any;
        const chartModel = this.getView()?.getModel("chartModel") as JSONModel;
        
        if (!modelUsageChart || !modelUsagePopover || !chartModel) return;
        
        modelUsageChart.setModel(chartModel);
        
        if (!modelUsageChart.getDataset()) {
            // Measure and dimension names are the legend, axis and popover labels; the feeds refer to them.
            const modelName = this.text("modelColumn");
            const totalRequestsName = this.text("totalRequests");
            const oDataset = new FlattenedDataset({
                dimensions: [new DimensionDefinition({ name: modelName, value: "{modelId}" })],
                measures: [new MeasureDefinition({ name: totalRequestsName, value: "{totalRequests}" })],
                data: { path: "/sortedModels" }
            });
            modelUsageChart.setDataset(oDataset);

            modelUsageChart.addFeed(new FeedItem({
                uid: "size", type: "Measure", values: [totalRequestsName]
            }));
            modelUsageChart.addFeed(new FeedItem({
                uid: "color", type: "Dimension", values: [modelName]
            }));

            modelUsageChart.setVizType("donut");
            modelUsageChart.setVizProperties({
                title: { text: this.text("modelUsageDistribution") },
                plotArea: { dataLabel: { visible: true } }
            });
            modelUsagePopover.connect(modelUsageChart.getVizUid());
        }
    }

    /**
     * Set up VizFrame chart configurations
     */
    private _setupCharts(): void {
        setTimeout(() => {
            this._setupProviderChart();
            this._setupReliabilityChart();
            this._setupModelChart();
        }, 100);
    }

    // Ensure all numeric fields are true numbers (not "1,234" or "12.3 ms")
    private _normalizeNumberFields(rows: any[], numericKeys: string[]): void {
        rows.forEach((r) => {
            numericKeys.forEach((k) => {
                const v = r[k];
                if (v != null && typeof v !== "number") {
                    const n = Number(String(v).replace(/[^\d.-]/g, ""));
                    r[k] = isNaN(n) ? null : n;
                }
            });
        });
    }

    // Generic, safe refresh for a VizFrame list binding
    private _refreshChart(vfId: string, path: string, rows: any[], opts?: { rebuild?: boolean }): void {
        const vf = this.byId(vfId) as any; // sap.viz.ui5.controls.VizFrame
        const model = this.getView()?.getModel("chartModel") as JSONModel;
        if (!vf || !model) return;

        // Optional: rebuild dataset/feeds when structure truly changed
        if (opts?.rebuild) {
            const pops = []; // e.g., [this.byId("providerPopover"), this.byId("modelPopover")]
            pops.forEach((p: any) => p?.disconnect?.());
            vf.destroyFeeds();
            vf.destroyDataset();
            // Caller will immediately re-run _setup*Chart() to recreate dataset/feeds
        }

        // Suspend -> mutate -> resume to avoid transient invalid states (the [50017] culprit)
        const ds = vf.getDataset?.();
        const b = ds?.getBinding?.("data");
        b?.suspend();
        model.setProperty(path, rows);
        b?.resume(true); // force update
        model.updateBindings(true);
    }

    /**
     * Refresh chart bindings after data updates
     */
    private _refreshChartBindings(): void {
        const m = this.getView()?.getModel("chartModel") as JSONModel;
        if (!m) return;

        // Pull the arrays (already set by your _prepareChartData or setData)
        const providerRows = m.getProperty("/providerUsage") ?? [];
        const modelRows = m.getProperty("/modelEfficiency") ?? [];

        // Normalize numeric fields to avoid [50017] from stringy numbers
        this._normalizeNumberFields(providerRows, ["totalRequests"]);
        this._normalizeNumberFields(modelRows, ["costPerToken", "avgResponseTime", "totalRequests"]);

        // Suspend → setProperty → resume(true) to avoid transient invalid states
        this._refreshChart("providerChart", "/providerUsage", providerRows);
        this._refreshChart("modelChart", "/modelEfficiency", modelRows);

        // If you ever change measure/dimension NAMES or vizType, do:
        // this._refreshChart("providerChart", "/providerUsage", providerRows, { rebuild: true });
        // this._setupProviderChart(); // to recreate dataset/feeds
        // ...same for modelChart
    }

    private _setupProviderChart(): void {
        const providerChart = this.byId("providerChart") as any;
        const providerPopover = this.byId("providerPopover") as any;
        const chartModel = this.getView()?.getModel("chartModel") as JSONModel;
        if (!providerChart || !providerPopover || !chartModel) return;

        // Set default model once (harmless if called multiple times)
        providerChart.setModel(chartModel);
        chartModel.setSizeLimit(2000);

        // Create dataset once if missing (don't recreate on every call)
        if (!providerChart.getDataset()) {
            // Measure and dimension names are the legend, axis and popover labels; the feeds refer to them.
            const providerName = this.text("provider");
            const totalRequestsName = this.text("totalRequests");
            const oDataset = new FlattenedDataset({
                dimensions: [new DimensionDefinition({ name: providerName, value: "{provider}" })],
                measures:   [new MeasureDefinition({ name: totalRequestsName, value: "{totalRequests}" })],
                data:       { path: "/providerUsage" } // plain path, no model prefix
            });
            providerChart.setDataset(oDataset);

            // Feeds must match the measure/dimension names above exactly
            providerChart.addFeed(new FeedItem({
                uid: "primaryValues", type: "Measure", values: [totalRequestsName]
            }));
            providerChart.addFeed(new FeedItem({
                uid: "axisLabels", type: "Dimension", values: [providerName]
            }));

            providerChart.setVizType("column");
            providerChart.setVizProperties({
                title: { text: this.text("providerUsageTitle") },
                plotArea: { dataLabel: { visible: true } },
                valueAxis: { title: { text: this.text("totalRequests") } },
                categoryAxis: { title: { text: this.text("provider") } },
                legend: { visible: false }
            });
            providerPopover.connect(providerChart.getVizUid());
        }
    }

    private _setupReliabilityChart(): void {
        const reliabilityChart = this.byId("reliabilityChart") as VizFrame;
        const reliabilityPopover = this.byId("reliabilityPopover") as VizPopover;
        
        if (reliabilityChart && reliabilityPopover) {
            reliabilityChart.setVizProperties({
                title: {
                    text: this.text("providerReliabilityTitle")
                },
                plotArea: {
                    mode: "dual",
                    primaryScale: "requests",
                    secondaryScale: "errorRate",
                    dataLabel: { visible: true }
                },
                valueAxis: {
                    title: { text: this.text("requestsColumn") }
                },
                valueAxis2: {
                    title: { text: this.text("axisErrorRatePercent") }
                },
                categoryAxis: {
                    title: { text: this.text("provider") }
                }
            });
            
            reliabilityPopover.connect(reliabilityChart.getVizUid());
        }
    }

    private _setupModelChart(): void {
        const modelChart = this.byId("modelChart") as any;
        const modelPopover = this.byId("modelPopover") as any;
        const chartModel = this.getView()?.getModel("chartModel") as JSONModel;
        if (!modelChart || !modelPopover || !chartModel) return;

        modelChart.setModel(chartModel);
        chartModel.setSizeLimit(2000);

        if (!modelChart.getDataset()) {
            // Measure and dimension names are the legend, axis and popover labels; the feeds refer to them.
            const modelName = this.text("modelColumn");
            const avgResponseTimeName = this.text("avgResponseTime");
            const totalRequestsName = this.text("totalRequests");
            const costPerTokenName = this.text("costPerToken");
            const oDataset = new FlattenedDataset({
                dimensions: [new DimensionDefinition({ name: modelName, value: "{modelId}" })],
                measures: [
                    new MeasureDefinition({ name: costPerTokenName,   value: "{costPerToken}" }),
                    new MeasureDefinition({ name: avgResponseTimeName, value: "{avgResponseTime}" }),
                    new MeasureDefinition({ name: totalRequestsName,   value: "{totalRequests}" })
                ],
                data: { path: "/modelEfficiency" }
            });
            modelChart.setDataset(oDataset);

            modelChart.addFeed(new FeedItem({
                uid: "valueAxis",  type: "Measure", values: [costPerTokenName]    // X
            }));
            modelChart.addFeed(new FeedItem({
                uid: "valueAxis2", type: "Measure", values: [avgResponseTimeName] // Y
            }));
            modelChart.addFeed(new FeedItem({
                uid: "bubbleWidth", type: "Measure", values: [totalRequestsName]   // size
            }));
            modelChart.addFeed(new FeedItem({
                uid: "color", type: "Dimension", values: [modelName]
            }));

            modelChart.setVizType("bubble");
            modelChart.setVizProperties({
                title: { text: this.text("chartModelEfficiency") },
                plotArea: { dataLabel: { visible: true } },
                valueAxis:  { title: { text: this.text("axisCostPerMillionTokens") } },
                valueAxis2: { title: { text: this.text("axisAvgResponseTimeMs") } }
            });
            modelPopover.connect(modelChart.getVizUid());
        }
    }

    /**
     * Event Handlers
     */
    public onDateRangeChange(event: any): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        
        // Get dates from event parameters (SAP UI5 way)
        const dateFrom = event.getParameter("from");
        const dateTo = event.getParameter("to");
        const isValid = event.getParameter("valid");
        
        if (isValid && dateFrom && dateTo) {
            const startDate = new Date(dateFrom);
            const endDate = new Date(dateTo);
            
            console.log("Date range changed:", { from: dateFrom, to: dateTo });
            
            // Update view model with Date objects for binding
            viewModel.setProperty("/customDateRangeStart", startDate);
            viewModel.setProperty("/customDateRangeEnd", endDate);
            
            // Create JSON object for saving preferences
            const customRange = {
                from: startDate.toISOString().split('T')[0],
                to: endDate.toISOString().split('T')[0]
            };
            
            // Save the custom range preference immediately
            this._saveTimePeriodPreference("custom", customRange);
            
            this._loadInitialData();
        }
    }

    public onGranularityChange(): void {
        this._loadInitialData();
    }

    public onProviderFilterChange(): void {
        this._loadInitialData();
    }

    public onRefreshData(): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (viewModel) {
            // Update timestamp immediately when refresh is triggered
            viewModel.setProperty("/lastUpdated", new Date().toLocaleString(this.locale()));
        }
        
        MessageToast.show(this.text("refreshingData"));
        this._loadInitialData();
    }

    public onTimePeriodChange(): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (!viewModel) return;

        const selectedPeriod = viewModel.getProperty("/selectedTimePeriod");
        
        // Handle custom date range
        if (selectedPeriod === "custom") {
            const startDate = viewModel.getProperty("/customDateRangeStart");
            const endDate = viewModel.getProperty("/customDateRangeEnd");
            
            if (!startDate || !endDate) {
                MessageToast.show(this.text("selectCustomRange"));
                return;
            }
            
            // Save custom range preference
            const customRange = {
                from: startDate.toISOString().split('T')[0],
                to: endDate.toISOString().split('T')[0]
            };
            this._saveTimePeriodPreference(selectedPeriod, customRange);
        } else {
            // Save time period preference for non-custom periods
            this._saveTimePeriodPreference(selectedPeriod, null);
        }
        
        // Update last updated timestamp
        viewModel.setProperty("/lastUpdated", new Date().toLocaleString(this.locale()));
        
        // Show user feedback
        const periodText = selectedPeriod === "custom" ? this.text("customPeriod") : this._periodName(selectedPeriod);
        MessageToast.show(this.text("loadingDataFor", [periodText]));
        
        // Reload data with new time period (date range calculated in _loadLiveData)
        this._loadInitialData();
    }


    public onModelPress(event: any): void {
        const context = event.getSource().getBindingContext("viewModel");
        const model = context.getObject();
        
        MessageToast.show(this.text("modelSelectedToast", [model.modelId]));
        // Navigate to model details or show details popover
    }

    public onUserPress(event: any): void {
        const context = event.getSource().getBindingContext("viewModel");
        const user = context.getObject();
        
        MessageToast.show(this.text("userSelectedToast", [user.email]));
        // Navigate to user details
    }

    /**
     * Excel export handler for the table toolbar button
     */
    public onExportToExcel(): void {
        this.onExportExcel(); // Delegate to existing export method
    }

    /**
     * Export Functions - Temporarily disabled
     */
    public onExportExcel(): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (!viewModel) {
            MessageToast.show(this.text("noDataForExport"));
            return;
        }
        
        const providerUsage = viewModel.getProperty("/charts/providerUsage") || [];
        // Use the processed model data with correct field mappings from the Models tab
        const modelUsage = viewModel.getProperty("/charts/modelsWithEfficiency") || [];
        
        // Create CSV content
        let csvContent = "Provider Usage\n";
        csvContent += "Provider,Total Requests,Input Tokens (k),Cache Create Tokens (k),Cache Read Tokens (k),Output Tokens (k),Avg Response Time (ms),Error Count\n";
        
        providerUsage.forEach((provider: any) => {
            const inputTokensK = (provider.inputTokens || 0) / 1000;
            const cacheCreateTokensK = (provider.cacheCreationInputTokens || 0) / 1000;
            const cacheReadTokensK = (provider.cacheReadInputTokens || 0) / 1000;
            const outputTokensK = (provider.outputTokens || 0) / 1000;
            
            csvContent += `${provider.provider},${provider.totalRequests},${inputTokensK.toFixed(3)},${cacheCreateTokensK.toFixed(3)},${cacheReadTokensK.toFixed(3)},${outputTokensK.toFixed(3)},${provider.avgResponseTime},${provider.errorCount}\n`;
        });
        
        csvContent += "\nModel Usage\n";
        csvContent += this._modelUsageCsv(modelUsage);
        
        // Download CSV file
        this._downloadFile(
            `usage_analytics_${new Date().toISOString().split('T')[0]}.csv`,
            csvContent,
            "text/csv"
        );
        
        MessageToast.show(this.text("exportedCsv"));
        return;
    }

    /**
     * The per-model CSV rows shared by the Overview export and the Export Data menu. Access Type
     * is the raw 'foundation' or 'deployment' (empty when unknown): it tells a model from its
     * deployment-served twin.
     */
    private _modelUsageCsv(modelUsage: any[]): string {
        let csvContent = "Model ID,Provider,Access Type,Total Requests,Input Tokens (k),Input Rate per 1k Tokens,Cache Create Tokens (k),Cache Create Rate per 1k Tokens,Cache Read Tokens (k),Cache Read Rate per 1k Tokens,Output Tokens (k),Output Rate per 1k Tokens,Total Cost,Avg Response Time (ms),Error Count\n";

        modelUsage.forEach((model: any) => {
            // Convert token counts to thousands and calculate rates per 1k tokens
            const inputTokensK = (model.inputTokens || 0) / 1000;
            const cacheCreateTokensK = (model.cacheCreationInputTokens || 0) / 1000;
            const cacheReadTokensK = (model.cacheReadInputTokens || 0) / 1000;
            const outputTokensK = (model.outputTokens || 0) / 1000;

            const inputRatePer1k = (inputTokensK > 0) ? (model.totalInputCost || 0) / inputTokensK : 0;
            const cacheCreateRatePer1k = (cacheCreateTokensK > 0) ? (model.totalCacheCreationInputCost || 0) / cacheCreateTokensK : 0;
            const cacheReadRatePer1k = (cacheReadTokensK > 0) ? (model.totalCacheReadInputCost || 0) / cacheReadTokensK : 0;
            const outputRatePer1k = (outputTokensK > 0) ? (model.totalOutputCost || 0) / outputTokensK : 0;

            csvContent += `${model.modelId},${model.provider},${model.accessType || ''},${model.totalRequests},${inputTokensK.toFixed(3)},${inputRatePer1k.toFixed(3)},${cacheCreateTokensK.toFixed(3)},${cacheCreateRatePer1k.toFixed(3)},${cacheReadTokensK.toFixed(3)},${cacheReadRatePer1k.toFixed(3)},${outputTokensK.toFixed(3)},${outputRatePer1k.toFixed(3)},${model.totalCost},${model.avgResponseTime},${model.errorCount}\n`;
        });

        return csvContent;
    }

    /**
     * Export the Models tab's per-model usage to CSV (respects time period and user context)
     */
    public onExportModelUsage(): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (!viewModel) {
            MessageToast.show(this.text("noDataForExport"));
            return;
        }

        const userContext = viewModel.getProperty("/userContext");
        const dateRange = viewModel.getProperty("/dateRange");
        const modelUsage = viewModel.getProperty("/charts/modelsWithEfficiency") || [];

        if (modelUsage.length === 0) {
            MessageToast.show(this.text("noModelUsageForExport"));
            return;
        }

        let csvContent = "Model Usage Report\n";
        csvContent += `Export Date: ${new Date().toLocaleString(this.locale())}\n`;
        csvContent += `Time Period: ${dateRange ? this.formatDateRange(dateRange) : 'All Time'}\n`;
        csvContent += `User: ${userContext?.email || 'All Users'} (${userContext?.isAdmin ? 'Admin' : 'Regular User'})\n${this._teamScopeCsvLine()}${this._tenantCsvLine()}\n`;
        csvContent += this._modelUsageCsv(modelUsage);

        const fileName = `model_usage_${new Date().toISOString().split('T')[0]}.csv`;
        this._downloadFile(fileName, csvContent, "text/csv");

        MessageToast.show(this.text("modelUsageExported", [fileName]));
    }

    public onExportJSON(): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (!viewModel) {
            MessageToast.show(this.text("noDataForExport"));
            return;
        }
        
        const userContext = viewModel.getProperty("/userContext") || {};
        
        const exportData = {
            exportedAt: new Date().toISOString(),
            dateRange: viewModel.getProperty("/dateRange"),
            granularity: viewModel.getProperty("/granularity"),
            teamScope: this._teamScopeCsvLine().trim() || undefined,
            userContext: {
                isAdmin: userContext.isAdmin,
                email: userContext.email
            },
            kpis: viewModel.getProperty("/kpis"),
            charts: viewModel.getProperty("/charts")
        };
        
        const jsonContent = JSON.stringify(exportData, null, 2);
        this._downloadFile(
            `usage_analytics_${new Date().toISOString().split('T')[0]}.json`,
            jsonContent,
            "application/json"
        );
        
        MessageToast.show(this.text("exportedJSON"));
        return;
    }

    /** Export the Teams by Cost rows to CSV (respects the time period). */
    public onExportTeamUsage(): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        const rows = viewModel?.getProperty("/charts/topTeamsByUsage") || [];
        if (rows.length === 0) { MessageToast.show(this.text("noTeamUsageForExport")); return; }
        const dateRange = viewModel.getProperty("/dateRange");
        let csv = "Team Usage Report\n";
        csv += `Export Date: ${new Date().toLocaleString(this.locale())}\n`;
        csv += `Time Period: ${dateRange ? this.formatDateRange(dateRange) : 'All Time'}\n${this._teamScopeCsvLine()}${this._tenantCsvLine()}\n`;
        csv += "Team,Total Requests,Input Tokens,Cache Create Tokens,Cache Read Tokens,Output Tokens,Total Cost,Users with Usage,Last Activity\n";
        rows.forEach((r: any) => {
            const last = r.lastActivity ? new Date(r.lastActivity).toLocaleString(this.locale()) : "Never";
            csv += `"${r.teamName}",${r.totalRequests || 0},${r.inputTokens || 0},${r.cacheCreationInputTokens || 0},${r.cacheReadInputTokens || 0},${r.outputTokens || 0},${r.totalCost || 0},${r.uniqueUsers || 0},"${last}"\n`;
        });
        const fileName = `team_usage_${new Date().toISOString().split('T')[0]}.csv`;
        this._downloadFile(fileName, csv, "text/csv");
        MessageToast.show(this.text("teamUsageExported", [fileName]));
    }

    /**
     * Export API Key Usage data to CSV (respects time period and user context)
     */
    public onExportApiKeyUsage(): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (!viewModel) {
            MessageToast.show(this.text("noDataForExport"));
            return;
        }
        
        const userContext = viewModel.getProperty("/userContext");
        const dateRange = viewModel.getProperty("/dateRange");
        // Use the processed data with correct field mappings from the Cost tab
        let apiKeyUsage = viewModel.getProperty("/charts/topApiKeys") || [];
        
        // If no processed data available, fall back to raw data and apply field mappings
        if (apiKeyUsage.length === 0) {
            const rawApiKeyUsage = viewModel.getProperty("/apiKeyUsage") || [];
            apiKeyUsage = rawApiKeyUsage.map((apiKey: any) => ({
                ...apiKey,
                inputTokens: apiKey.totalInputTokens || 0,
                cacheCreationInputTokens: apiKey.totalCacheCreationInputTokens || 0,
                cacheReadInputTokens: apiKey.totalCacheReadInputTokens || 0,
                outputTokens: apiKey.totalOutputTokens || 0
            }));
        }
        
        if (apiKeyUsage.length === 0) {
            MessageToast.show(this.text("noApiKeyUsageForExport"));
            return;
        }
        
        // Filter data based on user context (already filtered by CAP service, but double-check)
        let filteredData = apiKeyUsage;
        if (!userContext?.isAdmin && !this.getView()?.getModel("viewModel")?.getProperty("/teamScope")) {
            // For non-admin users, filter by their email (though this should already be done server-side)
            filteredData = apiKeyUsage.filter((item: any) => item.email === userContext?.email);
        }
        
        // Create CSV content
        let csvContent = "API Key Usage Report\n";
        csvContent += `Export Date: ${new Date().toLocaleString(this.locale())}\n`;
        csvContent += `Time Period: ${dateRange ? this.formatDateRange(dateRange) : 'All Time'}\n`;
        csvContent += `User: ${userContext?.email || 'All Users'} (${userContext?.isAdmin ? 'Admin' : 'Regular User'})\n${this._teamScopeCsvLine()}${this._tenantCsvLine()}\n`;
        
        csvContent += "API Key Name,Owner Email,Total Requests,Input Tokens (k),Input Rate per 1k Tokens,Cache Create Tokens (k),Cache Create Rate per 1k Tokens,Cache Read Tokens (k),Cache Read Rate per 1k Tokens,Output Tokens (k),Output Rate per 1k Tokens,Total Cost,Avg Response Time (ms),Error Count,Last Activity\n";
        
        filteredData.forEach((apiKey: any) => {
            const lastActivity = apiKey.lastActivity ? new Date(apiKey.lastActivity).toLocaleString(this.locale()) : "Never";
            
            // Convert token counts to thousands and calculate rates per 1k tokens
            const inputTokensK = (apiKey.inputTokens || 0) / 1000;
            const cacheCreateTokensK = (apiKey.cacheCreationInputTokens || 0) / 1000;
            const cacheReadTokensK = (apiKey.cacheReadInputTokens || 0) / 1000;
            const outputTokensK = (apiKey.outputTokens || 0) / 1000;
            
            const inputRatePer1k = (inputTokensK > 0) ? (apiKey.totalInputCost || 0) / inputTokensK : 0;
            const cacheCreateRatePer1k = (cacheCreateTokensK > 0) ? (apiKey.totalCacheCreationInputCost || 0) / cacheCreateTokensK : 0;
            const cacheReadRatePer1k = (cacheReadTokensK > 0) ? (apiKey.totalCacheReadInputCost || 0) / cacheReadTokensK : 0;
            const outputRatePer1k = (outputTokensK > 0) ? (apiKey.totalOutputCost || 0) / outputTokensK : 0;
            
            csvContent += `"${apiKey.keyName || 'Unknown'}","${apiKey.email || ''}",${apiKey.totalRequests || 0},${inputTokensK.toFixed(3)},${inputRatePer1k.toFixed(3)},${cacheCreateTokensK.toFixed(3)},${cacheCreateRatePer1k.toFixed(3)},${cacheReadTokensK.toFixed(3)},${cacheReadRatePer1k.toFixed(3)},${outputTokensK.toFixed(3)},${outputRatePer1k.toFixed(3)},${apiKey.totalCost || 0},${apiKey.avgResponseTime || 0},${apiKey.errorCount || 0},"${lastActivity}"\n`;
        });
        
        // Download CSV file
        const fileName = `api_key_usage_${new Date().toISOString().split('T')[0]}.csv`;
        this._downloadFile(fileName, csvContent, "text/csv");
        
        MessageToast.show(this.text("apiKeyUsageExported", [fileName]));
    }

    /**
     * Export AWS Credential Usage data to CSV (respects time period and user context)
     */
    public onExportAwsCredentialUsage(): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (!viewModel) {
            MessageToast.show(this.text("noDataForExport"));
            return;
        }
        
        const userContext = viewModel.getProperty("/userContext");
        const dateRange = viewModel.getProperty("/dateRange");
        // Use the processed data with correct field mappings from the Cost tab
        let awsCredentialUsage = viewModel.getProperty("/charts/topAwsCredentials") || [];
        
        // If no processed data available, fall back to raw data and apply field mappings
        if (awsCredentialUsage.length === 0) {
            const rawAwsCredentialUsage = viewModel.getProperty("/awsCredentialUsage") || [];
            awsCredentialUsage = rawAwsCredentialUsage.map((cred: any) => ({
                ...cred,
                inputTokens: cred.totalInputTokens || 0,
                cacheCreationInputTokens: cred.totalCacheCreationInputTokens || 0,
                cacheReadInputTokens: cred.totalCacheReadInputTokens || 0,
                outputTokens: cred.totalOutputTokens || 0
            }));
        }
        
        if (awsCredentialUsage.length === 0) {
            MessageToast.show(this.text("noAwsUsageForExport"));
            return;
        }
        
        // Filter data based on user context (already filtered by CAP service, but double-check)
        let filteredData = awsCredentialUsage;
        if (!userContext?.isAdmin && !this.getView()?.getModel("viewModel")?.getProperty("/teamScope")) {
            // For non-admin users, filter by their email (though this should already be done server-side)
            filteredData = awsCredentialUsage.filter((item: any) => item.email === userContext?.email);
        }
        
        // Create CSV content
        let csvContent = "AWS Credential Usage Report\n";
        csvContent += `Export Date: ${new Date().toLocaleString(this.locale())}\n`;
        csvContent += `Time Period: ${dateRange ? this.formatDateRange(dateRange) : 'All Time'}\n`;
        csvContent += `User: ${userContext?.email || 'All Users'} (${userContext?.isAdmin ? 'Admin' : 'Regular User'})\n${this._teamScopeCsvLine()}${this._tenantCsvLine()}\n`;
        
        csvContent += "Credential Name,Total Requests,Input Tokens (k),Input Rate per 1k Tokens,Cache Create Tokens (k),Cache Create Rate per 1k Tokens,Cache Read Tokens (k),Cache Read Rate per 1k Tokens,Output Tokens (k),Output Rate per 1k Tokens,Total Cost,Avg Response Time (ms),Error Count,Last Activity\n";
        
        filteredData.forEach((credential: any) => {
            const lastActivity = credential.lastActivity ? new Date(credential.lastActivity).toLocaleString(this.locale()) : "Never";
            
            // Convert token counts to thousands and calculate rates per 1k tokens
            const inputTokensK = (credential.inputTokens || 0) / 1000;
            const cacheCreateTokensK = (credential.cacheCreationInputTokens || 0) / 1000;
            const cacheReadTokensK = (credential.cacheReadInputTokens || 0) / 1000;
            const outputTokensK = (credential.outputTokens || 0) / 1000;
            
            const inputRatePer1k = (inputTokensK > 0) ? (credential.totalInputCost || 0) / inputTokensK : 0;
            const cacheCreateRatePer1k = (cacheCreateTokensK > 0) ? (credential.totalCacheCreationInputCost || 0) / cacheCreateTokensK : 0;
            const cacheReadRatePer1k = (cacheReadTokensK > 0) ? (credential.totalCacheReadInputCost || 0) / cacheReadTokensK : 0;
            const outputRatePer1k = (outputTokensK > 0) ? (credential.totalOutputCost || 0) / outputTokensK : 0;
            
            csvContent += `"${credential.credentialName || 'Unknown'}",${credential.totalRequests || 0},${inputTokensK.toFixed(3)},${inputRatePer1k.toFixed(3)},${cacheCreateTokensK.toFixed(3)},${cacheCreateRatePer1k.toFixed(3)},${cacheReadTokensK.toFixed(3)},${cacheReadRatePer1k.toFixed(3)},${outputTokensK.toFixed(3)},${outputRatePer1k.toFixed(3)},${credential.totalCost || 0},${credential.avgResponseTime || 0},${credential.errorCount || 0},"${lastActivity}"\n`;
        });
        
        // Download CSV file
        const fileName = `aws_credential_usage_${new Date().toISOString().split('T')[0]}.csv`;
        this._downloadFile(fileName, csvContent, "text/csv");
        
        MessageToast.show(this.text("awsUsageExported", [fileName]));
    }

    /**
     * Calculate date range for time period selection
     */
    private _calculateDateRange(timePeriod: string): { startDate: Date; endDate: Date } {
        const now = new Date();
        let startDate: Date, endDate: Date;
        
        switch (timePeriod) {
            case "today":
                startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
                break;
            case "week":
                const weekStart = new Date(now);
                weekStart.setDate(now.getDate() - now.getDay());
                startDate = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate());
                endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
                break;
            case "month":
                startDate = new Date(now.getFullYear(), now.getMonth(), 1);
                endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
                break;
            case "quarter":
                const quarterStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
                startDate = quarterStart;
                endDate = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3 + 3, 0, 23, 59, 59);
                break;
            case "year":
                startDate = new Date(now.getFullYear(), 0, 1);
                endDate = new Date(now.getFullYear(), 11, 31, 23, 59, 59);
                break;
            case "overall":
                startDate = new Date(2020, 0, 1); // Arbitrary start date
                endDate = now;
                break;
            case "custom":
                // Get dates from view model
                const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
                const customStartDate = viewModel?.getProperty("/customDateRangeStart");
                const customEndDate = viewModel?.getProperty("/customDateRangeEnd");
                
                if (customStartDate && customEndDate) {
                    startDate = new Date(customStartDate);
                    endDate = new Date(customEndDate);
                    // Set end time to end of day for consistency with other periods
                    endDate.setHours(23, 59, 59, 999);
                } else {
                    console.warn("Custom date range selected but no valid dates found, falling back to current month");
                    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
                    endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
                }
                break;
            default:
                // Default to current month
                startDate = new Date(now.getFullYear(), now.getMonth(), 1);
                endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
        }
        
        return { startDate, endDate };
    }

    /**
     * Get appropriate granularity for time period
     */
    private _getGranularityForPeriod(timePeriod: string): string {
        switch (timePeriod) {
            case "today":
                return "hour";
            case "week":
            case "month":
                return "day";
            case "quarter":
                return "week";
            case "year":
            case "overall":
                return "month";
            case "custom":
                // Calculate granularity based on custom date range span
                const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
                const customStartDate = viewModel?.getProperty("/customDateRangeStart");
                const customEndDate = viewModel?.getProperty("/customDateRangeEnd");
                
                if (customStartDate && customEndDate) {
                    const diffMs = customEndDate.getTime() - customStartDate.getTime();
                    const diffDays = diffMs / (1000 * 60 * 60 * 24);
                    
                    if (diffDays <= 1) {
                        return "hour";
                    } else if (diffDays <= 31) {
                        return "day";
                    } else if (diffDays <= 120) {
                        return "week";
                    } else {
                        return "month";
                    }
                }
                return "day"; // fallback
            default:
                return "day";
        }
    }

    /**
     * Utility Functions
     */
    private _formatDateForOData(date: Date): string {
        return date.toISOString().split('T')[0]; // YYYY-MM-DD format
    }

    private _downloadFile(filename: string, content: string, mimeType: string): void {
        const blob = new Blob([content], { type: mimeType });
        const url = window.URL.createObjectURL(blob);
        
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.style.display = "none";
        
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        window.URL.revokeObjectURL(url);
    }

    // Formatter functions for the view
    public formatNumber(value: number): string {
        if (!value && value !== 0) return "0";
        return new Intl.NumberFormat(this.locale()).format(value);
    }

    // The Model Performance Details table's Unit column: 'cells' for SAP-RPT models and 'units'
    // for rerank models (usageUnits()), 'tokens' for everything else - takes the i18n texts as
    // bound parts, like formatSapCost.
    public formatUnit(unit: string, cellsText: string, unitsText: string, tokensText: string): string {
        if (unit === "cells") return cellsText;
        return unit === "units" ? unitsText : tokensText;
    }

    // The API key cost table's name: the admin service key carries the grounding cockpit's usage
    // on behalf of users (isServiceKey from getUsageStatistics), so it is named for that.
    public formatApiKeyName(keyName: string, isServiceKey: boolean, serviceKeyText: string): string {
        return isServiceKey ? serviceKeyText : keyName;
    }

    // The Model Performance Details table's Access column: how the model is reached, which tells
    // a model from its deployment-served twin of the same name. Empty when the service could not
    // tell (a model the Model Library does not know).
    public formatAccessType(accessType: string | null, foundationText: string, deploymentText: string): string {
        if (accessType === "deployment") return deploymentText;
        return accessType === "foundation" ? foundationText : "";
    }

    public formatSmartCurrency(value: number): string {
        if (!value && value !== 0) return "$0.00";
        
        // Simple dollar formatting with two decimals
        return new Intl.NumberFormat(this.locale(), {
            style: 'currency',
            currency: 'USD',
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }).format(value);
    }

    // SAP-native sapCost is priced per sapCostCurrency (USD, EUR, ...), unlike the dollar-estimate
    // columns which are always USD - the currency must be shown alongside the amount rather than
    // assumed, so this formatter (unlike formatSmartCurrency) takes it as a second bound part.
    // A cost cell: the one figure, or with several currencies each currency's figure (never one sum).
    public formatSapCostCell(value: number, currency: string, byCurrency: Array<{ currency: string; cost: number }>): string {
        if (byCurrency && byCurrency.length > 1) return byCurrency.map(f => this.formatSapCost(f.cost, f.currency)).join(", ");
        return this.formatSapCost(value, currency);
    }

    public formatSapCost(value: number, currency: string): string {
        if (!value && value !== 0) return "";
        // Currency's own convention (2 decimals for USD) - not the 6-decimal DB precision.
        return new Intl.NumberFormat(this.locale(), {
            style: 'currency',
            currency: currency || 'USD'
        }).format(value);
    }

    // The SAP Cost tile subheader: the billing currency (USD until one is known) in the bundle's pattern.
    public formatSapCostSubheader(pattern: string, currency: string, byCurrency?: Array<{ currency: string; cost: number }>): string {
        return formatMessage(pattern || "", [sapCostTileCurrencies(currency, byCurrency)]);
    }

    // The SAP Cost tile value: one figure per currency when there are several, never one sum.
    public formatSapCostTile(total: number | null, currency: string | null, byCurrency?: Array<{ currency: string; cost: number }>): string {
        return sapCostTileText((cost, cur) => this.formatSapCost(cost, cur), total, currency, byCurrency);
    }

    // The Connections cost tile: one list-price figure per currency, never summed across currencies.
    public formatConnectionCost(figures: { currency: string; cost: number }[]): string {
        return (figures || []).map((f) => this.formatSapCost(f.cost, f.currency)).join(" | ") || "0";
    }

    // The Connections cost tile subheader: the currencies of the figures in the bundle's pattern.
    public formatConnectionCostSubheader(pattern: string, figures: { currency: string; cost: number }[]): string {
        return formatMessage(pattern || "", [(figures || []).map((f) => f.currency).join(", ") || "USD"]);
    }

    // A spend-by-connection row's cost; the unpriced requests have no currency and so no amount.
    public formatConnectionRowCost(value: number, currency: string | null): string {
        return currency ? this.formatSapCost(value, currency) : "";
    }

    public formatCostPerRequest(value: number): string {
        if (!value && value !== 0) return "$0.00000";
        
        // For very small values (typical AI model costs), use more decimal places
        let fractionDigits = 5;
        if (value > 0 && value < 0.000001) {
            fractionDigits = 8; // Use 8 decimal places for very small values
        } else if (value > 0 && value < 0.0001) {
            fractionDigits = 6; // Use 6 decimal places for small values
        }
        
        return new Intl.NumberFormat(this.locale(), {
            style: 'currency',
            currency: 'USD',
            minimumFractionDigits: fractionDigits,
            maximumFractionDigits: fractionDigits
        }).format(value);
    }

    public formatCostPerToken(value: number): string {
        if (!value && value !== 0) return "$0.00";
        return new Intl.NumberFormat(this.locale(), {
            style: 'currency',
            currency: 'USD',
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }).format(value);
    }

    public formatPercent(value: number): string {
        if (!value && value !== 0) return "0%";
        return new Intl.NumberFormat(this.locale(), {
            style: 'percent',
            minimumFractionDigits: 1,
            maximumFractionDigits: 2
        }).format(value);
    }

    // Tokens per second (Models tab): end-to-end output throughput over the full response time,
    // one decimal; a dash when the period holds no measured request for the model.
    public formatTokensPerSecond(value: number | null): string {
        if (value === null || value === undefined || !Number.isFinite(value)) return "–";
        return new Intl.NumberFormat(this.locale(), {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1
        }).format(value);
    }

    public formatDuration(value: number): string {
        if (!value && value !== 0) return "0ms";
        
        if (value >= 60000) {
            return `${this.fixed(value / 60000, 1)}min`;
        } else if (value >= 1000) {
            return `${this.fixed(value / 1000, 1)}s`;
        } else {
            return `${Math.round(value)}ms`;
        }
    }

    public formatDateTime(value: string): string {
        if (!value) return this.text("never");
        
        const date = new Date(value);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffHours = diffMs / (1000 * 60 * 60);
        const diffDays = diffMs / (1000 * 60 * 60 * 24);
        
        if (diffHours < 1) {
            return this.text("justNow");
        } else if (diffHours < 24) {
            return this.text("hoursAgo", [Math.round(diffHours)]);
        } else if (diffDays < 7) {
            return this.text("daysAgo", [Math.round(diffDays)]);
        } else {
            return date.toLocaleDateString(this.locale());
        }
    }

    public formatErrorState(value: number): string {
        if (!value && value !== 0) return "Good";
        if (value < 0.01) return "Good";      // < 1%
        if (value < 0.05) return "Critical"; // < 5%
        return "Error";                      // >= 5%
    }

    public formatDateRange(dateRange: any): string {
        if (!dateRange || !dateRange.startDate || !dateRange.endDate) {
            return "";
        }
        
        const start = dateRange.startDate.toLocaleDateString(this.locale());
        const end = dateRange.endDate.toLocaleDateString(this.locale());
        return `${start} - ${end}`;
    }

    public formatModelName(modelId: string): string {
        if (!modelId) return "N/A";
        
        // Clean up common model name patterns for better display
        return modelId
            .replace(/^anthropic--/, "")
            .replace(/--deployed$/, "")
            .replace(/^us\.anthropic\./i, "")
            .replace(/-v1:0$/, "")
            .replace(/^gpt-/, "GPT-")
            .replace(/-deployment$/, "")
            .replace(/\./g, " ")
            .replace(/-/g, " ")
            .replace(/\b\w/g, l => l.toUpperCase()); // Title case
    }

    public onTestPress(): void {
        console.log("Test button pressed!");
        MessageToast.show(this.text("appWorking"));
    }

    /**
     * Handle Top K selection change for API Keys and AWS Credentials
     */
    public onTopKChange(event: any): void {
        const selectedKey = event.getSource().getSelectedKey();
        const topK = parseInt(selectedKey, 10);
        
        console.log("onTopKChange - selectedKey:", selectedKey, "topK:", topK);
        
        if (!isNaN(topK)) {
            // The two-way binding already updated /cost/topK, so we don't need to set it again
            // Just update the filtered lists based on the new K value
            this._rebuildCostTablesAndCharts(topK);
            MessageToast.show(this.text("topKUpdated", [topK]));
        } else {
            console.error("Invalid topK value:", selectedKey);
        }
    }

    /** Map raw teamUsage rows, keep the top K by cost and store the list and its footer totals (no users total: a user can count in several teams). */
    private _setTopTeams(viewModel: JSONModel, rawTeams: any[], topK: number): void {
        const teams = rawTeams.map((team: any) => ({
            ...team,
            teamName: team.teamName || this.text("noTeam"),
            inputTokens: team.totalInputTokens || 0,
            cacheCreationInputTokens: team.totalCacheCreationInputTokens || 0,
            cacheReadInputTokens: team.totalCacheReadInputTokens || 0,
            outputTokens: team.totalOutputTokens || 0
        }));
        const top = teams.sort((a: any, b: any) => (b.totalCost || 0) - (a.totalCost || 0)).slice(0, topK);
        const totals: Record<string, number> = {};
        ["inputTokens", "cacheCreationInputTokens", "cacheReadInputTokens", "outputTokens", "totalCost", "totalRequests"]
            .forEach(f => { totals[f] = top.reduce((sum: number, r: any) => sum + (Number(r[f]) || 0), 0); });
        viewModel.setProperty("/charts/topTeamsByUsage", top);
        viewModel.setProperty("/charts/topTeamsTotals", totals);
    }

    /**
     * Rebuild cost tables and charts based on new topK value
     */
    private _rebuildCostTablesAndCharts(topK: number): void {
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (!viewModel) return;

        // Get the base data and filter to topK
        const emailUsage = viewModel.getProperty("/emailUsage") || [];
        const apiKeyCosts = viewModel.getProperty("/apiKeyUsage") || [];
        const awsCredCosts = viewModel.getProperty("/awsCredentialUsage") || [];

        const topEmailsByUsage = [...emailUsage].sort((a: any, b: any) => (b.totalCost || 0) - (a.totalCost || 0)).slice(0, topK);
        const topApiKeys = [...apiKeyCosts].sort((a: any, b: any) => (b.totalCost || 0) - (a.totalCost || 0)).slice(0, topK);
        const topAwsCredentials = [...awsCredCosts].sort((a: any, b: any) => (b.totalCost || 0) - (a.totalCost || 0)).slice(0, topK);

        console.log("Rebuilding cost tables with topK:", topK, {
            emails: topEmailsByUsage.length,
            apiKeys: topApiKeys.length,
            awsCredentials: topAwsCredentials.length
        });

        // Update only the filtered lists, don't touch /cost/topK
        viewModel.setProperty("/charts/topEmailsByUsage", topEmailsByUsage);
        this._setTopTeams(viewModel, viewModel.getProperty("/teamUsage") || [], topK);
        viewModel.setProperty("/charts/topApiKeys", topApiKeys);
        viewModel.setProperty("/charts/topAwsCredentials", topAwsCredentials);
    }

    /**
     * Handle tab selection for content switching
     */
    public onTabSelect(event: any): void {
        const selectedKey = event.getParameter("key");
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        
        console.log("[Overview] Tab selected:", selectedKey);
        
        if (viewModel) {
            // Update selected tab in view model for content switching
            viewModel.setProperty("/selectedTab", selectedKey);
            
            // Set up tab-specific charts after content becomes visible
            setTimeout(() => {
                this._setupTabSpecificCharts(selectedKey);
            }, 100);
        }
    }

    /**
     * Handle route matched events to sync tab selection
     */
    private _onRouteMatched(event: any): void {
        const routeName = event.getParameter("name");
        console.log("[Overview] Route matched:", routeName);
        
        // Update tab bar selection and content to match current route
        const tabBar = this.byId("analyticsTabBar") as IconTabBar | undefined;
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        
        if (tabBar && routeName && viewModel) {
            tabBar.setSelectedKey(routeName);
            viewModel.setProperty("/selectedTab", routeName);
            
            // Set up tab-specific charts
            setTimeout(() => {
                this._setupTabSpecificCharts(routeName);
            }, 100);
        }
    }
}