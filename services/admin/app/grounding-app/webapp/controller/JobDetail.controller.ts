import JSONModel from "sap/ui/model/json/JSONModel";
import BaseController from "./BaseController";
import { toJobRow, toReembedFailureRows, toBlobMigrationFailureRows, isReembedKind, isBlobMigrationKind, hasAdminJobActions, type JobRow } from "../model/jobs";
import { toStoreFileRows } from "../model/rows";

const POLL_INTERVAL_MS = 3000;
const FAILURES_PAGE = 50;

function emptyFailures(): any {
    return { rows: [], hasMore: false, lastId: "", showStore: false, busy: false };
}

/** The kinds whose failures are read a page at a time from the job's failures route. */
function pagedFailures(kind: string): boolean {
    return isReembedKind(kind) || isBlobMigrationKind(kind);
}

/**
 * One job: its progress, the files that failed with their errors, cancel and retry. While the
 * job is active the page refreshes itself, and stops as soon as the user leaves it. A file batch
 * lists its failed members; a re-embed job lists the files it could not re-embed, a page at a time
 * (a bulk re-embed with the store of each, read through the admin route: its stores are other owners').
 * A blob migration (admins only) lists the blobs it could not move the same way, through the admin route.
 * An admin who opens another owner's job (the owner route answers 404) reads it, its failures and its
 * cancel and retry through the admin routes.
 * @namespace admin.grounding.controller
 */
export default class JobDetailController extends BaseController {

    private jobId = "";
    private timer: ReturnType<typeof setTimeout> | null = null;
    private active = false;
    /** The caller's files by id, fetched for this job's failed names; refetched only for a failed id not looked up yet. */
    private filesById: Record<string, any> = {};
    private looked = new Set<string>();
    /** The job's failed count the re-embed failures were loaded for: a poll reloads them only when it changes. */
    private failuresFor = -1;
    /** Another owner's job opened by an admin: every read and action goes through the admin routes. */
    private adminView = false;

    public onInit(): void {
        this.getView()!.setModel(new JSONModel({ job: {}, counts: "", failedFiles: [], reembed: false, blobMigration: false, reembedFailures: emptyFailures(), busy: false, adminView: false }), "view");
        this.router().getRoute("groundingJobDetail")!.attachPatternMatched(this.onJobMatched, this);
        // Any other route of this app means the user left the job: stop refreshing it.
        this.router().attachRouteMatched(this.onRouteMatched, this);
    }

    private onJobMatched = (event: any): void => {
        this.jobId = event.getParameter("arguments").jobId;
        this.active = true;
        // A job switch must never show the previous job's figures under the new id.
        this.stopPolling();
        this.filesById = {};
        this.looked = new Set();
        this.view().setProperty("/job", {});
        this.view().setProperty("/counts", "");
        this.view().setProperty("/failedFiles", []);
        this.view().setProperty("/reembed", false);
        this.view().setProperty("/blobMigration", false);
        this.view().setProperty("/reembedFailures", emptyFailures());
        this.failuresFor = -1;
        this.adminView = false;
        this.view().setProperty("/adminView", false);
        void this.load();
    };

    private onRouteMatched = (event: any): void => {
        if (event.getParameter("name") !== "groundingJobDetail") {
            this.active = false;
            this.stopPolling();
        }
    };

    public onExit(): void {
        this.router().getRoute("groundingJobDetail")!.detachPatternMatched(this.onJobMatched, this);
        this.router().detachRouteMatched(this.onRouteMatched, this);
        this.active = false;
        this.stopPolling();
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

    public async load(quiet = false): Promise<void> {
        this.stopPolling();
        const api = await this.api();
        if (!api) return;
        const jobId = this.jobId;
        if (!quiet) this.view().setProperty("/busy", true);
        try {
            let result = this.adminView ? await api.adminGetJob(jobId) : await api.getJob(jobId);
            if (jobId !== this.jobId) return;
            // Not the caller's job: an admin reads any owner's job on the admin route.
            if (!result.ok && result.status === 404 && !this.adminView && this.appModel().getProperty("/isAdmin") === true) {
                const anyOwner = await api.adminGetJob(jobId);
                if (jobId !== this.jobId) return;
                if (anyOwner.ok) {
                    this.adminView = true;
                    this.view().setProperty("/adminView", true);
                    result = anyOwner;
                }
            }
            if (!result.ok) {
                this.showError(result.error);
                if (result.status === 404) this.onBack();
                return;
            }
            const job = toJobRow(result.body, await this.translator(), this.locale());
            // The admin job routes cancel and retry re-embeds and blob migrations only.
            if (this.adminView && !hasAdminJobActions(job.kind)) {
                job.canCancel = false;
                job.canRetry = false;
            }
            this.view().setProperty("/job", job);
            this.view().setProperty("/reembed", isReembedKind(job.kind));
            this.view().setProperty("/blobMigration", isBlobMigrationKind(job.kind));
            this.view().setProperty("/counts", await this.text("jobCounts", [job.done, job.failed, job.cancelled, job.inProgress]));
            if (pagedFailures(job.kind)) await this.loadReembedFailures(job, jobId, false, quiet);
            else await this.loadFailedFiles(job.storeId, job.batchId, job.failed);
            if (this.active && jobId === this.jobId && job.active) {
                this.stopPolling();
                this.timer = setTimeout(() => { void this.load(true); }, POLL_INTERVAL_MS);
            }
        } finally {
            this.view().setProperty("/busy", false);
        }
    }

    /** The batch's failed members with their errors; the file names come from the caller's file list. */
    private async loadFailedFiles(storeId: string, batchId: string, failed: number): Promise<void> {
        const api = this.readyApi;
        if (!api || !storeId || !batchId || failed === 0) {
            this.view().setProperty("/failedFiles", []);
            return;
        }
        const jobId = this.jobId;
        if (this.adminView) {
            await this.loadAdminFailedFiles(batchId, jobId);
            return;
        }
        const members = await api.listBatchFiles(storeId, batchId, "failed");
        if (!members.ok) {
            if (jobId === this.jobId) this.showError(members.error);
            return;
        }
        // The whole file library is listed only when a failed member is not known yet, not on every poll.
        if ((members.body || []).some((entry: any) => !this.looked.has(entry.id))) {
            const files = await api.listFiles();
            if (!files.ok) {
                if (jobId === this.jobId) this.showError(files.error);
                return;
            }
            const fetched: Record<string, any> = {};
            for (const file of files.body || []) fetched[file.id] = file;
            // The user may have opened another job meanwhile: its cache must not get this job's files.
            if (jobId === this.jobId) {
                this.filesById = fetched;
                for (const entry of members.body || []) this.looked.add(entry.id);
            }
        }
        // The user may have opened another job meanwhile: its page must not get this job's files.
        if (jobId !== this.jobId || batchId !== this.view().getProperty("/job/batchId")) return;
        this.view().setProperty("/failedFiles", toStoreFileRows(members.body || [], this.filesById, await this.translator(), this.locale()));
    }

    /** Another owner's batch: its failed members come with their file names from the admin route. */
    private async loadAdminFailedFiles(batchId: string, jobId: string): Promise<void> {
        const result = await this.readyApi!.adminBatchFailures(batchId);
        if (jobId !== this.jobId) return;
        if (!result.ok) {
            this.showError(result.error);
            return;
        }
        const rows = result.body || [];
        const entries = rows.map((row: any) => ({ id: row.file_id, status: "failed", last_error: row.last_error }));
        const names: Record<string, any> = {};
        for (const row of rows) names[row.file_id] = { filename: row.filename };
        if (batchId !== this.view().getProperty("/job/batchId")) return;
        this.view().setProperty("/failedFiles", toStoreFileRows(entries, names, await this.translator(), this.locale()));
    }

    /**
     * The re-embed job's failed files, or the blob migration's failed blobs: the first page when its failed count changed (or on the first
     * load), or the next page for "More". A poll with an unchanged count keeps the pages shown, and
     * a quiet poll retries a failed request without showing its error again.
     */
    private async loadReembedFailures(job: JobRow, jobId: string, more: boolean, quiet = false): Promise<void> {
        const api = this.readyApi;
        // The user may have opened another job while this one's summary was read.
        if (!api || jobId !== this.jobId) return;
        if (!more && job.failed === this.failuresFor) return;
        if (!more && job.failed === 0) {
            this.view().setProperty("/reembedFailures", emptyFailures());
            this.failuresFor = 0;
            return;
        }
        const after = more ? String(this.view().getProperty("/reembedFailures/lastId") || "") : "";
        const options = { limit: FAILURES_PAGE, after: after || undefined };
        const bulk = job.kind === "reembed_bulk";
        const blobs = isBlobMigrationKind(job.kind);
        this.view().setProperty("/reembedFailures/busy", true);
        try {
            const result = bulk || blobs || this.adminView ? await api.adminJobFailures(jobId, options) : await api.jobFailures(jobId, options);
            // The user may have opened another job meanwhile: its page must not get this job's files.
            if (jobId !== this.jobId) return;
            if (!result.ok) {
                if (!quiet) this.showError(result.error);
                return;
            }
            // A first-page reload answered while "More" was pending: its pages replace what this page continued.
            if (more && after !== String(this.view().getProperty("/reembedFailures/lastId") || "")) return;
            const rows = blobs
                ? toBlobMigrationFailureRows(result.body?.data || [], await this.translator(), this.locale())
                : toReembedFailureRows(result.body?.data || []);
            if (jobId !== this.jobId) return;
            const shown = more ? this.view().getProperty("/reembedFailures/rows") || [] : [];
            this.view().setProperty("/reembedFailures", {
                rows: shown.concat(rows),
                hasMore: result.body?.has_more === true,
                lastId: String(result.body?.last_id || ""),
                showStore: bulk,
                busy: false
            });
            if (!more) this.failuresFor = job.failed;
        } finally {
            if (jobId === this.jobId) this.view().setProperty("/reembedFailures/busy", false);
        }
    }

    public async onMoreFailures(): Promise<void> {
        const job = this.view().getProperty("/job") as JobRow;
        if (job && pagedFailures(job.kind)) await this.loadReembedFailures(job, this.jobId, true);
    }

    public onBack(): void {
        this.active = false;
        this.stopPolling();
        this.router().navTo("groundingJobs");
    }

    /** The owner's store page; another owner's store is a 404 there, so an admin view has no link (the view hides it). */
    public onOpenStore(): void {
        if (this.adminView) return;
        const storeId = this.view().getProperty("/job/storeId");
        if (storeId) this.router().navTo("groundingStoreDetail", { storeId });
    }

    public async onCancel(): Promise<void> {
        if (await this.jobAction("cancel", this.jobId, this.view().getProperty("/job/kind"), this.adminView)) await this.load(true);
    }

    public async onRetry(): Promise<void> {
        if (await this.jobAction("retry", this.jobId, this.view().getProperty("/job/kind"), this.adminView)) await this.load(true);
    }
}
