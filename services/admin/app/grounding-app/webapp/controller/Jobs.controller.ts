import JSONModel from "sap/ui/model/json/JSONModel";
import BaseController from "./BaseController";
import { toJobRow } from "../model/jobs";
import { refreshHead, nextPollInterval, documentHidden, POLL_BASE_MS } from "../model/paging";

const JOB_PAGE = 20;
/** The gateway's largest page: the quiet refresh reloads what is shown, in pages of this size. */
const MAX_PAGE = 100;

/**
 * My jobs, newest first: progress, cancel, retry of failed files. While any job is active the
 * list refreshes itself, and stops as soon as the user leaves it.
 * @namespace admin.grounding.controller
 */
export default class JobsController extends BaseController {

    private timer: ReturnType<typeof setTimeout> | null = null;
    private active = false;
    private loads = 0;
    /** The delay of the next refresh: backs off while nothing changes, back to the base on any change or user action. */
    private interval = POLL_BASE_MS;
    /** A refresh was due while the browser tab was hidden: it runs when the tab is shown again. */
    private resumeDue = false;
    /** A failing refresh shows its error once, not on every tick. */
    private errorShown = false;

    public onInit(): void {
        this.getView()!.setModel(new JSONModel({ jobs: [], busy: false, hasMore: false, lastId: "" }), "view");
        this.router().getRoute("groundingJobs")!.attachPatternMatched(this.onJobsMatched, this);
        // Any other route of this app means the user left the list: stop refreshing it.
        this.router().attachRouteMatched(this.onRouteMatched, this);
        if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibility);
    }

    private onVisibility = (): void => {
        if (this.resumeDue && this.active && !documentHidden()) {
            this.resumeDue = false;
            void this.load(true);
        }
    };

    private onJobsMatched = (): void => {
        this.active = true;
        void this.load();
    };

    private onRouteMatched = (event: any): void => {
        if (event.getParameter("name") !== "groundingJobs") {
            this.active = false;
            this.stopPolling();
        }
    };

    public onExit(): void {
        this.router().getRoute("groundingJobs")!.detachPatternMatched(this.onJobsMatched, this);
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

    private view(): JSONModel {
        return this.getView()!.getModel("view") as JSONModel;
    }

    /** True while a refresh is scheduled; lets a check see that leaving the list stopped it. */
    public isPolling(): boolean {
        return this.timer !== null;
    }

    /**
     * Loads the first page, or with `more` the page after the last one shown. A quiet load (the refresh while a job
     * is active) reloads only the head of the list, down to the deepest active job, and keeps the loaded tail.
     */
    public async load(quiet = false, more = false, everything = false): Promise<void> {
        this.stopPolling();
        this.resumeDue = false;
        if (!quiet) this.interval = POLL_BASE_MS;
        const api = await this.api();
        if (!api) return;
        const before = this.view().getProperty("/jobs") as any[];
        const cursor = { hasMore: this.view().getProperty("/hasMore") === true, lastId: String(this.view().getProperty("/lastId") || "") };
        const load = ++this.loads;
        if (!quiet) this.view().setProperty("/busy", true);
        const t = await this.translator();
        const locale = this.locale();
        const toRow = (job: any) => toJobRow(job, t, locale);
        let rows: any[];
        let hasMore: boolean;
        let lastId: string;
        let failure: any = null;
        if (quiet) {
            const result = await refreshHead((options) => api.listJobs(options), before, cursor, toRow, JOB_PAGE, MAX_PAGE, everything);
            if (result.ok && "rows" in result) ({ rows, hasMore, lastId } = result as any);
            else { failure = result; rows = before; hasMore = cursor.hasMore; lastId = cursor.lastId; }
        } else {
            let result = await api.listJobs(more && cursor.lastId ? { limit: JOB_PAGE, after: cursor.lastId } : { limit: JOB_PAGE });
            let appended = more;
            // "More" after a cursor whose row is gone: the answer is empty; start again from the top.
            if (more && result.ok && !(result.body?.data?.length) && result.body?.has_more !== true && cursor.lastId) {
                result = await api.listJobs({ limit: JOB_PAGE });
                appended = false;
            }
            if (!result.ok) { failure = result; rows = before; hasMore = cursor.hasMore; lastId = cursor.lastId; }
            else {
                const page = (Array.isArray(result.body?.data) ? result.body.data : []).map(toRow);
                rows = appended ? before.concat(page) : page;
                hasMore = result.body?.has_more === true;
                lastId = String(result.body?.last_id || "");
            }
        }
        // A refresh or "More" started after this one owns the list now, and schedules the next refresh.
        if (load !== this.loads) return;
        this.view().setProperty("/busy", false);
        if (failure) {
            if (!quiet || !this.errorShown) this.showError(failure.error);
            this.errorShown = true;
            this.schedule(before);
            return;
        }
        this.errorShown = false;
        const changed = JSON.stringify(rows) !== JSON.stringify(before);
        if (quiet) this.interval = nextPollInterval(this.interval, changed);
        this.view().setProperty("/jobs", rows);
        this.view().setProperty("/hasMore", hasMore);
        this.view().setProperty("/lastId", lastId);
        this.schedule(rows);
    }

    /** Arms the next quiet refresh while a job is active; a hidden tab waits for its return instead. */
    private schedule(rows: any[]): void {
        if (!this.active || !rows.some((row: any) => row.active)) return;
        this.stopPolling();
        this.timer = setTimeout(() => {
            this.timer = null;
            if (documentHidden()) { this.resumeDue = true; return; }
            void this.load(true);
        }, this.interval);
    }

    public onMore(): Promise<void> {
        return this.load(false, true);
    }

    public onRefresh(): void {
        void this.load();
    }

    public onOpen(event: any): void {
        const row = event.getSource().getBindingContext("view").getObject();
        this.router().navTo("groundingJobDetail", { jobId: row.id });
    }

    public async onCancel(event: any): Promise<void> {
        const row = event.getSource().getBindingContext("view").getObject();
        if (await this.jobAction("cancel", row.id, row.kind)) { this.interval = POLL_BASE_MS; await this.load(true, false, true); }
    }

    public async onRetry(event: any): Promise<void> {
        const row = event.getSource().getBindingContext("view").getObject();
        if (await this.jobAction("retry", row.id, row.kind)) { this.interval = POLL_BASE_MS; await this.load(true, false, true); }
    }
}
