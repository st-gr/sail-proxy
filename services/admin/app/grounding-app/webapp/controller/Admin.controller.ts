import JSONModel from "sap/ui/model/json/JSONModel";
import MessageBox from "sap/m/MessageBox";
import MessageToast from "sap/m/MessageToast";
import BaseController from "./BaseController";
import { GroundingApi, ApiResult } from "../model/api";
import {
    overviewTiles, toAdminStoreRow, toAdminFileRow, toFailedRow, toStorageRow, toAdminJobRow,
    adminTabOf, adminListOptions, filtersForLoad, AdminTab, AdminListTab, AdminListOptions, AdminFilters, AdminLoadMode
} from "../model/admin";
import { jobActionTextKey, type Translator } from "../model/jobs";
import { refreshHead, nextPollInterval, documentHidden, POLL_BASE_MS } from "../model/paging";
import { BlobPanelController, emptyBlob } from "./blobPanel";
import { estimateFigures, toSkippedRows } from "../model/reembed";
import { ChunkingFlow, emptyChunking, type ChunkingHost } from "./chunkingFlow";
import { openChangeChunkingDialog } from "./chunkingDialogs";
import { ReextractFlow, emptyReextract } from "./reextractFlow";
import { openReextractDialog } from "./reextractDialog";
import { reextractOutcome } from "../model/reextract";

const POLL_INTERVAL_MS = POLL_BASE_MS;
const PAGE = 20;
/** The gateway's largest page: a quiet jobs refresh reloads what is shown, in requests of this size. */
const MAX_PAGE = 100;

function emptyList(filters: Record<string, string> = {}): any {
    return { rows: [], hasMore: false, lastId: "", busy: false, ...filters };
}

/** The "Re-embed outdated stores" panel: the estimate once asked for, and the bulk job once started. */
function emptyBulk(jobId = ""): any {
    return { loaded: false, busy: false, stores: 0, figures: {}, skipped: [], jobId };
}

/**
 * Grounding administration: everyone's stores, files, failed ingestions, storage and jobs. Only
 * admins get here; anyone else is sent back to the Vector Stores before a request is made. Each list
 * shows one page and "More" adds the next. While a job on the Jobs tab is active the tab refreshes
 * itself, and stops as soon as the user leaves it. Outdated stores are re-embedded one at a time from the
 * Stores tab or all at once from the Overview, after an estimate; re-embed jobs can be cancelled and retried. A store's
 * chunking can be changed and its files read again (Re-read Files) from the Stores tab, after an estimate.
 * File batches stay read-only here. The Overview's Blob storage panel shows where blobs are stored, tests the S3
 * connection and starts or cancels a blob migration.
 * @namespace admin.grounding.controller
 */
export default class AdminController extends BaseController {

    private timer: ReturnType<typeof setTimeout> | null = null;
    private active = false;
    /** The Jobs tab's refresh delay: backs off while nothing changes, back to the base on any change or user action. */
    private jobsInterval = POLL_BASE_MS;
    /** A Jobs refresh was due while the browser tab was hidden: it runs when the tab is shown again. */
    private jobsResumeDue = false;
    /** A failing Jobs refresh shows its error once, not on every tick. */
    private jobsErrorShown = false;
    /** Per list, the number of the newest load: an older answer arriving later is dropped. */
    private loads: Record<string, number> = {};
    /** Per list, the filters its shown first page was loaded with; "More" and the reloads use these. */
    private applied: Partial<Record<AdminListTab, AdminFilters>> = {};
    private blobPanel!: BlobPanelController;
    private chunking!: ChunkingFlow;
    private reextract!: ReextractFlow;

    public onInit(): void {
        this.getView()!.setModel(new JSONModel({
            tab: "overview", tiles: [], overviewBusy: false, bulk: emptyBulk(), blob: emptyBlob(), chunking: emptyChunking(), reextract: emptyReextract(),
            stores: emptyList({ owner: "", status: "", shared: "", embeddingState: "" }),
            files: emptyList({ owner: "" }),
            failed: emptyList({ owner: "" }),
            storage: emptyList(),
            jobs: emptyList({ owner: "" })
        }), "view");
        this.blobPanel = new BlobPanelController({
            getProperty: (path) => this.view().getProperty(path),
            setProperty: (path, value) => { this.view().setProperty(path, value); },
            adminApi: () => this.adminApi(),
            translator: () => this.translator(),
            text: (key, args) => this.text(key, args),
            locale: () => this.locale(),
            showError: (error) => { void this.showError(error); },
            confirm: (question, onOk) => {
                MessageBox.confirm(question, {
                    onClose: async (choice: string) => { if (choice === MessageBox.Action.OK) await onOk(); }
                });
            },
            toast: (text) => { MessageToast.show(text); },
            overviewShown: () => this.active && this.currentTab() === "overview",
            schedule: (refresh) => {
                this.stopPolling();
                this.timer = setTimeout(refresh, POLL_INTERVAL_MS);
            },
            openJob: (jobId) => { this.router().navTo("groundingJobDetail", { jobId }); }
        });
        // Any owner's store, through the admin routes.
        const storeHost: ChunkingHost = {
            getProperty: (path) => this.view().getProperty(path),
            setProperty: (path, value) => { this.view().setProperty(path, value); },
            api: () => this.adminApi(),
            translator: () => this.translator(),
            locale: () => this.locale()
        };
        this.chunking = new ChunkingFlow(storeHost, true);
        this.reextract = new ReextractFlow(storeHost, true);
        this.router().getRoute("groundingAdmin")!.attachPatternMatched(this.onAdminMatched, this);
        // Any other route of this app means the user left the screen: stop refreshing it.
        this.router().attachRouteMatched(this.onRouteMatched, this);
        if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibility);
    }

    private onVisibility = (): void => {
        if (this.jobsResumeDue && this.active && this.view().getProperty("/tab") === "jobs" && !documentHidden()) {
            this.jobsResumeDue = false;
            void this.loadList("jobs", "quiet");
        }
    };

    private onAdminMatched = (event: any): void => {
        this.active = true;
        this.stopPolling();
        void this.enter(adminTabOf(event.getParameter("arguments")?.tab));
    };

    private onRouteMatched = (event: any): void => {
        if (event.getParameter("name") !== "groundingAdmin") {
            this.active = false;
            this.stopPolling();
        }
    };

    public onExit(): void {
        this.router().getRoute("groundingAdmin")!.detachPatternMatched(this.onAdminMatched, this);
        this.router().detachRouteMatched(this.onRouteMatched, this);
        this.active = false;
        this.stopPolling();
        if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
    }

    private stopPolling(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    /** True while a refresh is scheduled; lets a check see that leaving the screen stopped it. */
    public isPolling(): boolean {
        return this.timer !== null;
    }

    private view(): JSONModel {
        return this.getView()!.getModel("view") as JSONModel;
    }

    /** The API for an admin; anyone else goes back to the Vector Stores with a message and gets null. */
    private async adminApi(): Promise<GroundingApi | null> {
        const api = await this.api();
        if (!api) return null;
        if (this.appModel().getProperty("/isAdmin") !== true) {
            this.active = false;
            this.stopPolling();
            MessageToast.show(await this.text("adminOnly"));
            this.router().navTo("groundingStores", {}, true);
            return null;
        }
        return api;
    }

    private async enter(tab: AdminTab): Promise<void> {
        const api = await this.adminApi();
        if (!api) return;
        this.view().setProperty("/tab", tab);
        await this.loadTab(tab);
    }

    private loadTab(tab: AdminTab): Promise<void> {
        return tab === "overview" ? this.loadOverview() : this.loadList(tab);
    }

    public async loadOverview(): Promise<void> {
        const api = await this.adminApi();
        if (!api) return;
        const load = this.nextLoad("overview");
        this.view().setProperty("/overviewBusy", true);
        // An estimate shown before is stale after a refresh; the started job's link stays.
        this.nextLoad("bulk");
        this.view().setProperty("/bulk", emptyBulk(this.view().getProperty("/bulk/jobId")));
        const blob = this.loadBlobStorage();
        const result = await api.overview();
        if (load !== this.loads.overview) return;
        this.view().setProperty("/overviewBusy", false);
        if (!result.ok) {
            this.showError(result.error);
            return;
        }
        this.view().setProperty("/tiles", overviewTiles(result.body, await this.translator(), this.locale()));
        await blob;
    }

    /** The Blob storage panel (controller/blobPanel.ts); the view's handlers below delegate to it. */
    public loadBlobStorage(quiet = false): Promise<void> {
        return this.blobPanel.load(quiet);
    }

    public onBlobTest(): Promise<void> {
        return this.blobPanel.test();
    }

    public onBlobMigrate(): Promise<void> {
        return this.blobPanel.migrate();
    }

    public onBlobCancel(): Promise<void> {
        return this.blobPanel.cancel();
    }

    public onViewBlobJob(): void {
        this.blobPanel.viewJob();
    }

    private nextLoad(key: string): number {
        this.loads[key] = (this.loads[key] || 0) + 1;
        return this.loads[key];
    }

    private fetchPage(api: GroundingApi, tab: AdminListTab, options: AdminListOptions): Promise<ApiResult<any>> {
        switch (tab) {
            case "stores": return api.adminStores(options);
            case "files": return api.adminFiles(options);
            case "failed": return api.adminFailed(options);
            case "storage": return api.adminStorage(options);
            default: return api.adminJobs(options);
        }
    }

    private toRow(tab: AdminListTab, entry: any, t: Translator, locale: string): any {
        switch (tab) {
            case "stores": return toAdminStoreRow(entry, t, locale);
            case "files": return toAdminFileRow(entry, locale);
            case "failed": return toFailedRow(entry, locale);
            case "storage": return toStorageRow(entry, locale);
            default: return toAdminJobRow(entry, t, locale);
        }
    }

    /**
     * Loads a list's first page, or with `more` the page after the last one shown. A quiet load
     * (the jobs refresh) reloads every row shown, page by page, without the busy indicator.
     */
    public async loadList(tab: AdminListTab, mode: AdminLoadMode = "apply", everything = false): Promise<void> {
        const more = mode === "more";
        const quiet = mode === "quiet";
        if (tab === "jobs") {
            this.stopPolling();
            this.jobsResumeDue = false;
            if (!quiet) this.jobsInterval = POLL_BASE_MS;
        }
        const api = await this.adminApi();
        if (!api) return;
        const path = `/${tab}`;
        const list = this.view().getProperty(path);
        const before = list.rows as any[];
        const cursor = { hasMore: list.hasMore === true, lastId: String(list.lastId || "") };
        const filters = filtersForLoad(mode, list, this.applied[tab]);
        const load = this.nextLoad(tab);
        if (!quiet) this.view().setProperty(`${path}/busy`, true);
        const t = await this.translator();
        const locale = this.locale();
        const toRow = (entry: any) => this.toRow(tab, entry, t, locale);
        const fetch = (after: string) => this.fetchPage(api, tab, adminListOptions(tab, filters, after, PAGE));
        let rows: any[] = before;
        let hasMore = cursor.hasMore;
        let lastId = cursor.lastId;
        let failure: any = null;
        let replace = !more;
        if (quiet) {
            const result = await refreshHead((page) => this.fetchPage(api, tab, adminListOptions(tab, filters, page.after || "", page.limit)), before, cursor, toRow, PAGE, MAX_PAGE, everything);
            if (result.ok && "rows" in result) ({ rows, hasMore, lastId } = result as any);
            else failure = result;
        } else {
            let result = await fetch(more ? cursor.lastId : "");
            // "More" after a cursor whose row is gone: the answer is empty; start again from the top.
            if (more && result.ok && !(result.body?.data?.length) && result.body?.has_more !== true && cursor.lastId) {
                result = await fetch("");
                replace = true;
            }
            if (!result.ok) failure = result;
            else {
                const page: any[] = (Array.isArray(result.body?.data) ? result.body.data : []).map(toRow);
                rows = replace ? page : before.concat(page);
                hasMore = result.body?.has_more === true;
                lastId = String(result.body?.last_id || "");
            }
        }
        // A filter change, refresh or "More" started after this one owns the list now, and schedules the next refresh.
        if (load !== this.loads[tab]) return;
        this.view().setProperty(`${path}/busy`, false);
        if (!failure && !more) this.applied[tab] = filters;
        if (failure) {
            if (tab !== "jobs" || !quiet || !this.jobsErrorShown) this.showError(failure.error);
            if (tab === "jobs") {
                this.jobsErrorShown = true;
                this.scheduleJobs(before);
            }
            return;
        }
        if (tab === "jobs") {
            this.jobsErrorShown = false;
            if (quiet) this.jobsInterval = nextPollInterval(this.jobsInterval, JSON.stringify(rows) !== JSON.stringify(before));
        }
        this.view().setProperty(`${path}/rows`, rows);
        this.view().setProperty(`${path}/hasMore`, hasMore);
        this.view().setProperty(`${path}/lastId`, lastId);
        if (tab === "jobs") this.scheduleJobs(rows);
    }

    /** Arms the next quiet Jobs refresh while a job is active and the tab is shown; a hidden browser tab waits for its return. */
    private scheduleJobs(rows: any[]): void {
        if (!this.active || this.view().getProperty("/tab") !== "jobs" || !rows.some((row: any) => row.active)) return;
        this.stopPolling();
        this.timer = setTimeout(() => {
            this.timer = null;
            if (documentHidden()) { this.jobsResumeDue = true; return; }
            void this.loadList("jobs", "quiet");
        }, this.jobsInterval);
    }

    private currentTab(): AdminTab {
        return adminTabOf(this.view().getProperty("/tab"));
    }

    /** A tab switch is a route change, so the address names the tab and the lifecycle stays the route's. */
    public onTabSelect(event: any): void {
        const tab = adminTabOf(event.getParameter("key"));
        this.router().navTo("groundingAdmin", { tab }, true);
    }

    public onRefresh(): void {
        void this.loadTab(this.currentTab());
    }

    /** A filter changed (owner submitted, status or shared chosen): the list starts again from its first page. */
    public onFilter(): void {
        const tab = this.currentTab();
        if (tab !== "overview") void this.loadList(tab);
    }

    public onMore(): void {
        const tab = this.currentTab();
        if (tab !== "overview") void this.loadList(tab, "more");
    }

    private rowOf(event: any): any {
        return event.getSource().getBindingContext("view").getObject();
    }

    /**
     * Asks first; on OK runs the action, shows `doneKey` and reloads the list from its first page with its applied
     * filters. A refusal whose status is in `reloadOn` reloads the list too.
     */
    private confirmed(question: string, tab: AdminListTab, action: (api: GroundingApi) => Promise<ApiResult<any>>, doneKey: string,
        reloadOn: number[] = [404]): void {
        MessageBox.confirm(question, {
            onClose: async (choice: string) => {
                if (choice !== MessageBox.Action.OK) return;
                await this.run(tab, action, doneKey, reloadOn);
            }
        });
    }

    private async run(tab: AdminListTab, action: (api: GroundingApi) => Promise<ApiResult<any>>, doneKey: string,
        reloadOn: number[] = [404]): Promise<void> {
        const api = await this.adminApi();
        if (!api) return;
        const result = await action(api);
        if (!result.ok) {
            this.showError(result.error);
            // 404: the row is already gone (deleted elsewhere); reload so the list stops showing it.
            if (reloadOn.includes(result.status)) await this.loadList(tab, "keep");
            return;
        }
        MessageToast.show(await this.text(doneKey));
        await this.loadList(tab, "keep");
    }

    /**
     * Re-embeds another owner's outdated store too: the gateway resolves the owner first (the job is theirs). The
     * confirmation names the estimate's figures, like the owner's. A 409 (the store changed meanwhile: already
     * re-embedding, current again, expired) reloads the list as a 404 does, so the row shows the store as it is now.
     */
    public async onReembedStore(event: any): Promise<void> {
        const row = this.rowOf(event);
        const storeId = row.id;
        const api = await this.adminApi();
        if (!api) return;
        const estimate = await api.adminReembedStoreEstimate(storeId);
        if (!estimate.ok) {
            this.showError(estimate.error);
            if (estimate.status === 404) await this.loadList("stores", "keep");
            return;
        }
        const figures = estimateFigures(estimate.body, this.locale());
        this.confirmed(await this.text("adminConfirmReembedStore", [row.name, row.ownerEmail, figures.files, figures.chunks, figures.tokens]),
            "stores", (adminApi) => adminApi.adminReembedStore(storeId), "reembedStarted", [404, 409]);
    }

    /** Re-chunks any owner's store (the job is the owner's, started by the admin) after its estimate: chunkingFlow.ts. */
    public async onChangeChunkingStore(event: any): Promise<void> {
        const row = this.rowOf(event);
        await this.chunking.prepareChange({ id: row.id, name: row.name, ownerEmail: row.ownerEmail, chunking: row.chunking });
        await openChangeChunkingDialog(this.getView()!, (key, args) => this.text(key, args), this.chunking, async () => {
            MessageToast.show(await this.text("rechunkStarted"));
            await this.loadList("stores", "keep");
        });
    }

    /** Reads any owner's files again that an older version read (the job is the owner's), after its estimate: reextractFlow.ts. */
    public async onReextractStore(event: any): Promise<void> {
        const row = this.rowOf(event);
        const loading = this.reextract.prepare({ id: row.id, name: row.name });
        await openReextractDialog(this.getView()!, (key, args) => this.text(key, args), this.reextract, async (answer) => {
            const outcome = reextractOutcome(answer);
            const message = await this.text(outcome.key, outcome.args);
            // Failed files left out are said in a box the user closes: a toast would vanish before it is read.
            if (outcome.refused) MessageBox.warning(message);
            else MessageToast.show(message);
            await this.loadList("stores", "keep");
        });
        await loading;
    }

    /** What a bulk re-embed would embed, and which stores it would skip and why. */
    public async onReembedEstimate(): Promise<void> {
        const api = await this.adminApi();
        if (!api) return;
        const load = this.nextLoad("bulk");
        this.view().setProperty("/bulk/busy", true);
        const result = await api.adminReembedEstimate();
        if (load !== this.loads.bulk) return;
        this.view().setProperty("/bulk/busy", false);
        if (!result.ok) {
            this.showError(result.error);
            return;
        }
        const t = await this.translator();
        if (load !== this.loads.bulk) return;
        this.view().setProperty("/bulk", {
            ...emptyBulk(this.view().getProperty("/bulk/jobId")),
            loaded: true,
            stores: Number(result.body?.stores) || 0,
            figures: estimateFigures(result.body, this.locale()),
            skipped: toSkippedRows(result.body?.skipped, t)
        });
    }

    /**
     * Confirms with the estimate's figures, then starts one bulk job; the panel links to it (the admin owns it)
     * and lists the stores the start skipped, including any that changed after the estimate. The start's answer
     * is always shown: the load counter guards estimates only, so a Refresh meanwhile cannot drop the job.
     */
    public async onReembedOutdated(): Promise<void> {
        const figures = this.view().getProperty("/bulk/figures");
        MessageBox.confirm(await this.text("adminConfirmReembedOutdated", [figures.stores, figures.files, figures.chunks, figures.tokens]), {
            onClose: async (choice: string) => {
                if (choice !== MessageBox.Action.OK) return;
                const api = await this.adminApi();
                if (!api) return;
                this.view().setProperty("/bulk/busy", true);
                const result = await api.adminReembedOutdated();
                // An estimate still in flight predates this start: its figures must not replace the result.
                this.nextLoad("bulk");
                this.view().setProperty("/bulk/busy", false);
                if (!result.ok) {
                    this.showError(result.error);
                    return;
                }
                const t = await this.translator();
                this.view().setProperty("/bulk", {
                    ...emptyBulk(String(result.body?.job?.id || "")),
                    skipped: toSkippedRows(result.body?.skipped, t)
                });
                MessageToast.show(await this.text("reembedStarted"));
            }
        });
    }

    public onViewBulkJob(): void {
        const jobId = this.view().getProperty("/bulk/jobId");
        if (jobId) this.router().navTo("groundingJobDetail", { jobId });
    }

    /**
     * Re-embed jobs and blob migrations of any owner (the row offers the buttons for those only; the gateway answers
     * 404 for a file batch). Asks first, naming the job and its owner: the job may well be someone else's.
     */
    public async onAdminCancelJob(event: any): Promise<void> {
        await this.confirmJobAction("cancel", this.rowOf(event));
    }

    public async onAdminRetryJob(event: any): Promise<void> {
        await this.confirmJobAction("retry", this.rowOf(event));
    }

    private async confirmJobAction(action: "cancel" | "retry", row: any): Promise<void> {
        const jobId = row.id;
        const key = action === "cancel" ? "adminConfirmCancelJob" : "adminConfirmRetryJob";
        MessageBox.confirm(await this.text(key, [jobId, row.kindText, row.ownerEmail]), {
            onClose: async (choice: string) => {
                if (choice === MessageBox.Action.OK) await this.adminJobAction(action, jobId, row.kind);
            }
        });
    }

    private async adminJobAction(action: "cancel" | "retry", jobId: string, kind: string): Promise<void> {
        const api = await this.adminApi();
        if (!api) return;
        const result = action === "cancel" ? await api.adminCancelJob(jobId) : await api.adminRetryJob(jobId);
        if (!result.ok) {
            this.showError(result.error);
            if (result.status === 404) await this.loadList("jobs", "keep");
            return;
        }
        MessageToast.show(await this.text(jobActionTextKey(action, kind), action === "cancel" ? undefined : [Number(result.body?.retried) || 0]));
        this.jobsInterval = POLL_BASE_MS;
        await this.loadList("jobs", "quiet", true);
    }

    public async onDeleteStore(event: any): Promise<void> {
        const row = this.rowOf(event);
        const storeId = row.id;
        this.confirmed(await this.text("adminConfirmDeleteStore", [row.name, row.ownerEmail]), "stores",
            (api) => api.adminDeleteStore(storeId), "storeDeleted");
    }

    public async onDeleteFile(event: any): Promise<void> {
        const row = this.rowOf(event);
        const fileId = row.id;
        this.confirmed(await this.text("adminConfirmDeleteFile", [row.filename, row.ownerEmail]), "files",
            (api) => api.adminDeleteFile(fileId), "fileDeleted");
    }

    /** The gateway's refusal (job_running, store_expired, nothing_to_retry) is shown in the cockpit's words. */
    public async onRetryFailed(event: any): Promise<void> {
        const row = this.rowOf(event);
        const storeId = row.storeId;
        const fileId = row.fileId;
        await this.run("failed", (api) => api.adminRetry(storeId, fileId), "fileRetryStarted");
    }
}
