import JSONModel from "sap/ui/model/json/JSONModel";
import Dialog from "sap/m/Dialog";
import Button from "sap/m/Button";
import Input from "sap/m/Input";
import Label from "sap/m/Label";
import VBox from "sap/m/VBox";
import SelectDialog from "sap/m/SelectDialog";
import StandardListItem from "sap/m/StandardListItem";
import MessageBox from "sap/m/MessageBox";
import MessageToast from "sap/m/MessageToast";
import { ButtonType, InputType } from "sap/m/library";
import BaseController from "./BaseController";
import { GroundingApi } from "../model/api";
import { toStoreRow, toStoreFileRows, StoreRow } from "../model/rows";
import { formatBytes } from "../model/format";
import { uploadProblem } from "../model/upload";
import { storeNameProblem, parseExpiryDays } from "../model/validation";
import { jobForBatch } from "../model/jobs";
import { canSearch, buildSearchRequest, toSearchRows, isLongPassage, MAX_QUERY_LENGTH } from "../model/search";
import { embeddingReasonText, estimateFigures, lastFailedReembed, pollsStoreOnly } from "../model/reembed";
import type { Translator } from "../model/jobs";
import { ChunkingFlow, emptyChunking } from "./chunkingFlow";
import { openChangeChunkingDialog } from "./chunkingDialogs";
import { ReextractFlow, emptyReextract } from "./reextractFlow";
import { openReextractDialog } from "./reextractDialog";
import type Event from "sap/ui/base/Event";
import type Control from "sap/ui/core/Control";
import { openTeamShareDialog } from "./teamShareDialog";
import type { TeamOption } from "../model/teams";
import type { ApiError } from "../model/api";
import { teamErrorMessage } from "../model/errors";
import { reextractOutcome } from "../model/reextract";

const POLL_INTERVAL_MS = 3000;
/** The new batch's job is the newest one: the first page holds it (and a store's last re-embed, when it is recent). */
const RECENT_JOBS = 20;

function emptySearch(): any {
    return { query: "", maxResults: 10, threshold: "", rewrite: false, canSearch: false, busy: false, message: "", searched: false, rows: [] };
}

function hiddenJobStrip(): any {
    return { visible: false, text: "", jobId: "" };
}

/**
 * One vector store: its files with their ingestion status, attach, upload, detach, retry, the
 * store's own settings and a retrieval test. While any file is still being ingested the screen
 * refreshes itself, and also while the store is being re-embedded. Several files at once are attached as one
 * file batch, which the Jobs screen follows. An outdated store's owner re-embeds it after seeing the estimate, and
 * the owner changes the store's chunking (a re-chunk) after seeing its estimate (chunkingFlow.ts), and has the files an
 * earlier version read read again ("Re-read files", offered only when there are any: reextractFlow.ts).
 * @namespace admin.grounding.controller
 */
export default class StoreDetailController extends BaseController {

    private storeId = "";
    private timer: ReturnType<typeof setTimeout> | null = null;
    private myFiles: any[] = [];
    private active = false;
    private uploading = false;
    private chunking!: ChunkingFlow;
    private reextract!: ReextractFlow;

    public onInit(): void {
        this.getView()!.setModel(new JSONModel({ store: {}, files: [], busy: false, ingesting: false, tab: "files", readOnlyHint: "", jobStarted: hiddenJobStrip(), search: emptySearch(), embeddingReason: "", reembedFailedJobId: "", rechunkTarget: "", rechunkHint: "", chunking: emptyChunking(), reextractOffered: false, reextract: emptyReextract() }), "view");
        const host = {
            getProperty: (path: string) => this.view().getProperty(path),
            setProperty: (path: string, value: any) => { this.view().setProperty(path, value); },
            api: () => this.api(),
            translator: () => this.translator(),
            locale: () => this.locale()
        };
        this.chunking = new ChunkingFlow(host);
        this.reextract = new ReextractFlow(host);
        this.router().getRoute("groundingStoreDetail")!.attachPatternMatched(this.onStoreMatched, this);
        // Any other route of this app means the user left the store: stop refreshing it.
        this.router().attachRouteMatched(this.onRouteMatched, this);
    }

    private onStoreMatched = (event: any): void => {
        this.storeId = event.getParameter("arguments").storeId;
        this.active = true;
        // A store switch must never show the previous store's name or files under the new id.
        this.stopPolling();
        this.view().setProperty("/store", {});
        this.view().setProperty("/files", []);
        this.view().setProperty("/ingesting", false);
        this.view().setProperty("/tab", "files");
        this.view().setProperty("/readOnlyHint", "");
        this.view().setProperty("/jobStarted", hiddenJobStrip());
        this.view().setProperty("/search", emptySearch());
        this.view().setProperty("/embeddingReason", "");
        this.view().setProperty("/reembedFailedJobId", "");
        this.view().setProperty("/rechunkTarget", "");
        this.view().setProperty("/rechunkHint", "");
        this.view().setProperty("/reextractOffered", false);
        void this.load();
    };

    private onRouteMatched = (event: any): void => {
        if (event.getParameter("name") !== "groundingStoreDetail") {
            this.active = false;
            this.stopPolling();
        }
    };

    public onExit(): void {
        this.router().getRoute("groundingStoreDetail")!.detachPatternMatched(this.onStoreMatched, this);
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

    /** True once the store is loaded and the caller owns it; a shared store of someone else is read-only. */
    private owned(): boolean {
        return this.view().getProperty("/store/owned") === true;
    }

    /** `quiet` skips the busy indicator; `poll` marks the timer's refresh, which may read the store alone. */
    public async load(quiet = false, poll = false): Promise<void> {
        this.stopPolling();
        const api = await this.api();
        if (!api) return;
        const storeId = this.storeId;
        if (!quiet) this.view().setProperty("/busy", true);
        const store = await api.getStore(storeId);
        if (storeId !== this.storeId) return;
        if (!store.ok) {
            if (!this.uploading) this.view().setProperty("/busy", false);
            this.showError(store.error);
            if (store.status === 404) this.onBack();
            return;
        }
        const t = await this.translator();
        if (storeId !== this.storeId) return;
        const storeRow = toStoreRow(store.body, t, this.locale());
        if (storeRow.readOnly) {
            // A store shared by someone else: metadata and Test Retrieval only. Its file list stays private
            // to the owner, so it is never requested. The hint is resolved before anything is written,
            // and a store opened meanwhile owns the view.
            const hint = await this.text("sharedReadOnlyHint", [storeRow.ownerEmail]);
            const extras = await this.embeddingExtras(api, storeId, storeRow, t);
            if (storeId !== this.storeId) return;
            this.myFiles = [];
            this.view().setProperty("/busy", false);
            this.view().setProperty("/store", storeRow);
            await this.showTeamShares(storeRow);
            this.view().setProperty("/files", []);
            this.view().setProperty("/ingesting", storeRow.inProgressFiles > 0);
            this.view().setProperty("/readOnlyHint", hint);
            this.view().setProperty("/embeddingReason", extras.reason);
            this.view().setProperty("/reembedFailedJobId", "");
            if (this.view().getProperty("/tab") === "files") this.view().setProperty("/tab", "details");
            return;
        }
        if (pollsStoreOnly(poll, storeRow)) {
            // Only a re-embed runs: until its switch, the store object is all that changes.
            const teamShares = this.view().getProperty("/store/teamShares");
            this.view().setProperty("/store", storeRow);
            this.view().setProperty("/store/teamShares", teamShares);
            this.pollAgain(storeId, true);
            return;
        }
        // "Re-read files" is asked about on a full load, not on every refresh while files ingest; only where a re-chunk
        // could start (the owner's store, not expired, its dimension, no job running): the gateway refuses the same.
        const offer: Promise<boolean | null> = poll ? Promise.resolve(null)
            : storeRow.canChangeChunking ? this.reextract.offered(storeId) : Promise.resolve(false);
        const [storeFiles, files, extras, running, offered] = await Promise.all([
            api.listStoreFiles(storeId), api.listFiles(), this.embeddingExtras(api, storeId, storeRow, t), this.chunking.runningJob(storeRow.reembedJobId), offer
        ]);
        if (!this.uploading) this.view().setProperty("/busy", false);
        if (storeId !== this.storeId) return;
        if (!storeFiles.ok || !files.ok) {
            this.showError(storeFiles.error || files.error);
            return;
        }
        this.myFiles = files.body || [];
        const filesById: Record<string, any> = {};
        for (const file of this.myFiles) filesById[file.id] = file;
        const rows = toStoreFileRows(storeFiles.body || [], filesById, t, this.locale());
        this.view().setProperty("/store", storeRow);
        await this.showTeamShares(storeRow);
        this.view().setProperty("/readOnlyHint", "");
        this.view().setProperty("/files", rows);
        this.view().setProperty("/embeddingReason", extras.reason);
        this.view().setProperty("/reembedFailedJobId", extras.failedJobId);
        // A running re-chunk names its target setting, a re-extract says the files are read again; a plain re-embed keeps its own hint.
        this.view().setProperty("/rechunkTarget", running.target);
        this.view().setProperty("/rechunkHint", running.reextract ? t("reextractRunningHint") : running.target ? t("rechunkRunningHint", [running.target]) : "");
        if (offered !== null) this.view().setProperty("/reextractOffered", offered);
        const ingesting = rows.some((row) => row.status === "in_progress");
        this.view().setProperty("/ingesting", ingesting);
        // A running re-embed is followed too, so the page shows the switch to the configured model when it completes.
        this.pollAgain(storeId, ingesting || storeRow.reembedding);
    }

    /** The teams the store is shared with, named from the viewer's teams, and the teams still offered to share with. */
    private async showTeamShares(storeRow: StoreRow): Promise<void> {
        const viewModel = this.getOwnerComponent()!.getModel("viewModel") as JSONModel;
        const teams = (viewModel.getProperty("/teams") ?? []) as TeamOption[];
        const isAdmin = viewModel.getProperty("/isAdmin") === true;
        const byId = new Map(teams.map((x) => [x.id, x]));
        // A team the viewer is not in has no name here (myTeams lists only their own): a short id stands in.
        const names = await Promise.all(storeRow.teamIds.map(async (id) => byId.get(id)?.name ?? await this.text("unknownTeam", [id.slice(0, 8)])));
        this.view().setProperty("/store/teamShares", storeRow.teamIds.map((id, i) => ({
            id, name: names[i], canRemove: storeRow.owned || isAdmin || byId.get(id)?.canShare === true
        })));
        this.view().setProperty("/shareableTeams", teams.filter((x) => x.canShare && !storeRow.teamIds.includes(x.id)));
    }

    /** A refused team share: the cockpit's text for the code, never the gateway's English. */
    private async showTeamError(error: ApiError | null): Promise<void> {
        MessageBox.error(error ? teamErrorMessage(error, "requestFailed", await this.translator(), this.locale()) : await this.text("requestFailed"));
    }

    private pollAgain(storeId: string, running: boolean): void {
        if (!this.uploading && this.active && storeId === this.storeId && running) {
            // Two overlapping quiet loads must not leave two timers.
            this.stopPolling();
            this.timer = setTimeout(() => { void this.load(true, true); }, POLL_INTERVAL_MS);
        }
    }

    /**
     * The state's reason and, for the owner of an outdated store with no re-embed running, the newest
     * re-embed job of the store when it failed (a failed job leaves the store without reembed_job_id).
     * An outdated store's reason names the configured model, read fresh from /status.
     */
    private async embeddingExtras(api: GroundingApi, storeId: string, row: StoreRow, t: Translator): Promise<{ reason: string; failedJobId: string }> {
        const outdated = row.embeddingState === "outdated";
        const [status, jobs] = await Promise.all([
            outdated ? api.status() : Promise.resolve(null),
            outdated && row.owned && !row.reembedding ? api.listJobs({ limit: RECENT_JOBS }) : Promise.resolve(null)
        ]);
        const configured = status?.ok && typeof status.body?.embeddingModel === "string" ? status.body.embeddingModel : "";
        return {
            reason: embeddingReasonText(row.embeddingState, row.embeddingModel, configured, t),
            failedJobId: jobs?.ok ? lastFailedReembed(jobs.body?.data || [], storeId) : ""
        };
    }

    /** Estimate first, then a confirmation that says what will be embedded, then the start; the running strip links to the job. */
    public async onReembed(): Promise<void> {
        if (!this.owned()) return;
        const storeId = this.storeId;
        const name = this.view().getProperty("/store/name");
        const api = await this.api();
        if (!api) return;
        const estimate = await api.reembedEstimate(storeId);
        if (storeId !== this.storeId) return;
        if (!estimate.ok) {
            this.showError(estimate.error);
            return;
        }
        const figures = estimateFigures(estimate.body, this.locale());
        MessageBox.confirm(await this.text("confirmReembedStore", [name, figures.files, figures.chunks, figures.tokens]), {
            onClose: async (action: string) => {
                if (action !== MessageBox.Action.OK) return;
                const started = await api.reembedStore(storeId);
                if (!started.ok) this.showError(started.error);
                else MessageToast.show(await this.text("reembedStarted"));
                if (storeId === this.storeId) await this.load(true);
            }
        });
    }

    /** The setting's fields, then the estimate, then the start: chunkingFlow.ts; the running strip links to the job. */
    public async onChangeChunking(): Promise<void> {
        const store = this.view().getProperty("/store");
        if (!this.owned() || !store?.canChangeChunking) return;
        const storeId = this.storeId;
        await this.chunking.prepareChange({ id: storeId, name: store.name, chunking: store.chunking });
        await openChangeChunkingDialog(this.getView()!, (key, args) => this.text(key, args), this.chunking, async () => {
            MessageToast.show(await this.text("rechunkStarted"));
            if (storeId === this.storeId) await this.load(true);
        });
    }

    /** What this version reads better, the estimate, then the start; the running strip links to the job. */
    public async onReextract(): Promise<void> {
        const store = this.view().getProperty("/store");
        if (!this.owned() || !store?.canChangeChunking) return;
        const storeId = this.storeId;
        const loading = this.reextract.prepare({ id: storeId, name: store.name });
        await openReextractDialog(this.getView()!, (key, args) => this.text(key, args), this.reextract, async (answer) => {
            const outcome = reextractOutcome(answer);
            const message = await this.text(outcome.key, outcome.args);
            // Failed files left out are said in a box the user closes: a toast would vanish before it is read.
            if (outcome.refused) MessageBox.warning(message);
            else MessageToast.show(message);
            if (storeId === this.storeId) await this.load(true);
        });
        await loading;
    }

    public onViewReembedJob(): void {
        const jobId = this.view().getProperty("/store/reembedJobId");
        if (jobId) this.router().navTo("groundingJobDetail", { jobId });
    }

    public onViewFailedReembedJob(): void {
        const jobId = this.view().getProperty("/reembedFailedJobId");
        if (jobId) this.router().navTo("groundingJobDetail", { jobId });
    }

    public onBack(): void {
        this.active = false;
        this.stopPolling();
        this.router().navTo("groundingStores");
    }

    public async onAttach(): Promise<void> {
        if (!this.owned()) return;
        const attached = new Set((this.view().getProperty("/files") as any[]).map((row) => row.id));
        const candidates = this.myFiles.filter((file) => !attached.has(file.id));
        const dialog = new SelectDialog({
            title: await this.text("chooseFile"),
            noDataText: await this.text("noFilesToAttach"),
            multiSelect: true,
            items: candidates.map((file) => new StandardListItem({ title: file.filename, description: formatBytes(file.bytes, this.locale()) }).data("fileId", file.id) as StandardListItem),
            confirm: (event: any) => {
                const fileIds = ((event.getParameter("selectedItems") || []) as any[]).map((item) => item.data("fileId") as string);
                dialog.destroy();
                if (fileIds.length === 1) void this.attach(fileIds[0]);
                else if (fileIds.length > 1) void this.attachBatch(fileIds);
            },
            cancel: () => dialog.destroy()
        });
        this.getView()!.addDependent(dialog);
        dialog.open("");
    }

    private async attach(fileId: string): Promise<boolean> {
        const storeId = this.storeId;
        const api = await this.api();
        if (!api) return false;
        const result = await api.attachFile(storeId, fileId);
        if (!result.ok) {
            this.showError(result.error);
            return false;
        }
        MessageToast.show(await this.text("fileAttached"));
        await this.load(true);
        return true;
    }

    /** Several files at once: one file batch, followed as a job. */
    private async attachBatch(fileIds: string[]): Promise<void> {
        const storeId = this.storeId;
        this.view().setProperty("/busy", true);
        let failure = "";
        try {
            failure = await this.startBatch(storeId, fileIds);
        } finally {
            this.view().setProperty("/busy", false);
        }
        if (failure) MessageBox.error(failure);
        await this.load(true);
    }

    /**
     * Creates the file batch and points the "View Job" link at its job. The batch answer names no
     * job; the newest jobs do name their batch. Returns the failure message, or "" when it started.
     */
    private async startBatch(storeId: string, fileIds: string[]): Promise<string> {
        const api = await this.api();
        if (!api) return "";
        const batch = await api.createFileBatch(storeId, fileIds);
        if (!batch.ok) return batch.error ? await this.errorText(batch.error) : await this.text("requestFailed");
        const jobs = await api.listJobs({ limit: RECENT_JOBS });
        const job = jobs.ok ? jobForBatch(jobs.body?.data || [], batch.body?.id) : null;
        if (storeId !== this.storeId) return "";
        const text = await this.text("jobStartedToast", [fileIds.length]);
        this.view().setProperty("/jobStarted", { visible: true, text, jobId: job ? job.id : "" });
        MessageToast.show(text);
        return "";
    }

    public onViewJob(): void {
        const jobId = this.view().getProperty("/jobStarted/jobId");
        if (jobId) this.router().navTo("groundingJobDetail", { jobId });
        else this.router().navTo("groundingJobs");
    }

    public onJobStripClose(): void {
        this.view().setProperty("/jobStarted", hiddenJobStrip());
    }

    public onUploadChange(event: any): void {
        const files = Array.from((event.getParameter("files") || []) as ArrayLike<File>);
        event.getSource().clear();
        if (files.length > 0 && this.owned()) void this.uploadAndAttach(files);
    }

    /**
     * Uploads each file and attaches it to this store: one file directly, several as one file
     * batch once all are uploaded. Stops at the first failure and says which file it was.
     */
    public async uploadAndAttach(files: File[]): Promise<void> {
        const storeId = this.storeId;
        const api = await this.api();
        if (!api) return;
        const maxFileBytes = Number(this.appModel().getProperty("/maxFileBytes")) || 0;
        for (const file of files) {
            const problem = uploadProblem(file, maxFileBytes);
            if (problem) {
                MessageBox.error(await this.text(`uploadProblem_${problem}`, [file.name, formatBytes(maxFileBytes, this.locale())]));
                return;
            }
        }
        this.stopPolling();
        this.uploading = true;
        this.view().setProperty("/busy", true);
        let failure = "";
        const batched = files.length > 1;
        const uploadedIds: string[] = [];
        try {
            for (const file of files) {
                const uploaded = await api.uploadFile(file, file.name);
                if (!uploaded.ok) {
                    failure = `${file.name}: ${uploaded.error ? await this.errorText(uploaded.error) : ""}`;
                    break;
                }
                if (batched) {
                    uploadedIds.push(uploaded.body.id);
                    continue;
                }
                const attached = await api.attachFile(storeId, uploaded.body.id);
                if (!attached.ok) {
                    failure = `${file.name}: ${attached.error ? await this.errorText(attached.error) : ""}`;
                    break;
                }
            }
            // A failed upload attaches none of the files: the uploaded ones stay in the library.
            if (batched && !failure) failure = await this.startBatch(storeId, uploadedIds);
        } finally {
            this.uploading = false;
            this.view().setProperty("/busy", false);
        }
        if (failure) {
            MessageBox.error(failure);
        } else if (!batched) {
            MessageToast.show(await this.text("filesUploaded", [files.length]));
        }
        await this.load(true);
    }

    public async onDetach(event: any): Promise<void> {
        if (!this.owned()) return;
        const storeId = this.storeId;
        const row = event.getSource().getBindingContext("view").getObject();
        const api = await this.api();
        if (!api) return;
        const result = await api.detachFile(storeId, row.id);
        if (!result.ok) {
            this.showError(result.error);
            return;
        }
        MessageToast.show(await this.text("fileDetached"));
        await this.load(true);
    }

    /** A failed file's retry. The gateway's refusal (job_running, store_expired, nothing_to_retry) is shown as sent. */
    public async onRetryFile(event: any): Promise<void> {
        if (!this.owned()) return;
        const storeId = this.storeId;
        const row = event.getSource().getBindingContext("view").getObject();
        const api = await this.api();
        if (!api) return;
        const result = await api.retryFile(storeId, row.id);
        if (!result.ok) {
            this.showError(result.error);
            return;
        }
        MessageToast.show(await this.text("fileRetryStarted"));
        await this.load(true);
    }

    public onSearchQueryChange(event: any): void {
        this.view().setProperty("/search/canSearch", canSearch(String(event.getParameter("value") ?? "")));
    }

    /** Test retrieval. A form problem is explained instead of sent; a gateway error is shown as it was sent. */
    public async onSearch(): Promise<void> {
        const storeId = this.storeId;
        const form = this.view().getProperty("/search");
        if (!canSearch(String(form.query ?? ""))) return;
        const request = buildSearchRequest({ query: String(form.query ?? ""), maxResults: form.maxResults, threshold: String(form.threshold ?? ""), rewrite: form.rewrite === true });
        if (!request.ok) {
            this.view().setProperty("/search/message", await this.text(`searchProblem_${request.problem}`, [MAX_QUERY_LENGTH]));
            this.view().setProperty("/search/rows", []);
            this.view().setProperty("/search/searched", false);
            return;
        }
        const api = await this.api();
        if (!api) return;
        this.view().setProperty("/search/message", "");
        this.view().setProperty("/search/busy", true);
        const result = await api.searchStore(storeId, request.body);
        if (storeId !== this.storeId) return;
        this.view().setProperty("/search/busy", false);
        if (!result.ok) {
            this.view().setProperty("/search/message", result.error ? await this.errorText(result.error) : await this.text("requestFailed"));
            this.view().setProperty("/search/rows", []);
            this.view().setProperty("/search/searched", false);
            return;
        }
        const rows = toSearchRows(result.body, this.locale()).map((row) => ({ ...row, expanded: false, long: isLongPassage(row.text) }));
        this.view().setProperty("/search/rows", rows);
        this.view().setProperty("/search/searched", true);
    }

    public onTogglePassage(event: any): void {
        const context = event.getSource().getBindingContext("view");
        this.view().setProperty("expanded", !context.getProperty("expanded"), context);
    }

    public async onRename(): Promise<void> {
        if (!this.owned()) return;
        const storeId = this.storeId;
        const name = new Input({ value: this.view().getProperty("/store/name"), maxLength: 256 });
        await this.inputDialog(await this.text("rename"), await this.text("storeName"), name, async () => {
            const storeName = name.getValue().trim();
            if (storeNameProblem(storeName)) {
                MessageBox.error(await this.text("nameRequired"));
                return false;
            }
            const api = await this.api();
            if (!api) return false;
            const result = await api.modifyStore(storeId, { name: storeName });
            if (!result.ok) {
                this.showError(result.error);
                return false;
            }
            MessageToast.show(await this.text("storeRenamed"));
            return true;
        });
    }

    public async onSetExpiry(): Promise<void> {
        if (!this.owned()) return;
        const storeId = this.storeId;
        const days = new Input({ type: InputType.Text, placeholder: "1 - 365" });
        await this.inputDialog(await this.text("setExpiry"), await this.text("expiryDays"), days, async () => {
            const expiry = parseExpiryDays(days.getValue());
            if (!expiry.ok) {
                MessageBox.error(await this.text("expiryInvalid"));
                return false;
            }
            const value = expiry.days;
            const api = await this.api();
            if (!api) return false;
            const result = await api.modifyStore(storeId, { expiresDays: value });
            if (!result.ok) {
                this.showError(result.error);
                return false;
            }
            MessageToast.show(await this.text("expirySaved"));
            return true;
        });
    }

    /** A one-field dialog. `save` returns true when the dialog may close. */
    private async inputDialog(title: string, label: string, input: Input, save: () => Promise<boolean>): Promise<void> {
        const saveButton = new Button({
            text: await this.text("save"),
            type: ButtonType.Emphasized,
            press: async () => {
                // Disabled before the first await, so a second press cannot send the request twice.
                saveButton.setEnabled(false);
                let closed = false;
                try {
                    if (await save()) {
                        closed = true;
                        dialog.close();
                        await this.load(true);
                    }
                } catch (error) {
                    this.showThrown(error);
                } finally {
                    // Also when a request throws: the dialog must stay usable.
                    if (!closed) saveButton.setEnabled(true);
                }
            }
        });
        const dialog = new Dialog({
            title,
            content: [new VBox({ items: [new Label({ text: label, labelFor: input }), input] }).addStyleClass("sapUiSmallMargin")],
            beginButton: saveButton,
            endButton: new Button({ text: await this.text("cancel"), press: () => dialog.close() }),
            afterClose: () => dialog.destroy()
        });
        this.getView()!.addDependent(dialog);
        dialog.open();
    }

    public async onDelete(): Promise<void> {
        if (!this.owned()) return;
        const storeId = this.storeId;
        const name = this.view().getProperty("/store/name");
        MessageBox.confirm(await this.text("confirmDeleteStore", [name]), {
            onClose: async (action: string) => {
                if (action !== MessageBox.Action.OK) return;
                const api = await this.api();
                if (!api) return;
                const result = await api.deleteStore(storeId);
                if (!result.ok) {
                    this.showError(result.error);
                    return;
                }
                MessageToast.show(await this.text("storeDeleted"));
                this.onBack();
            }
        });
    }

    /** Sharing is for an admin on a store they own (the buttons show only then; the gateway refuses anyone else). */
    public async onShare(): Promise<void> {
        if (!this.owned()) return;
        const storeId = this.storeId;
        const name = this.view().getProperty("/store/name");
        MessageBox.confirm(await this.text("confirmShareStore", [name]), {
            onClose: async (action: string) => {
                if (action !== MessageBox.Action.OK) return;
                await this.setShared(storeId, true);
            }
        });
    }

    public async onUnshare(): Promise<void> {
        if (!this.owned()) return;
        await this.setShared(this.storeId, false);
    }

    public async onShareWithTeam(): Promise<void> {
        if (!this.owned()) return;
        const choices = this.view().getProperty("/shareableTeams") as TeamOption[];
        const teamId = await openTeamShareDialog(this.getView()!, choices, (key, args) => this.text(key, args as any[]));
        if (!teamId) return;
        const api = await this.api();
        if (!api) return;
        const result = await api.shareWithTeam(this.storeId, teamId);
        if (!result.ok) { await this.showTeamError(result.error); return; }
        MessageToast.show(await this.text("storeSharedWithTeam", [choices.find((x) => x.id === teamId)?.name ?? teamId]));
        await this.load(true);
    }

    public async onUnshareTeam(event: Event): Promise<void> {
        const share = (event.getSource() as Control).getBindingContext("view")!.getObject() as { id: string; name: string };
        MessageBox.confirm(await this.text("confirmUnshareTeam", [share.name]), {
            onClose: async (action: string) => {
                if (action !== MessageBox.Action.OK) return;
                const api = await this.api();
                if (!api) return;
                const result = await api.unshareFromTeam(this.storeId, share.id);
                if (!result.ok) { await this.showTeamError(result.error); return; }
                MessageToast.show(await this.text("storeUnsharedFromTeam", [share.name]));
                await this.load(true);
            }
        });
    }

    private async setShared(storeId: string, shared: boolean): Promise<void> {
        const api = await this.api();
        if (!api) return;
        const result = shared ? await api.share(storeId) : await api.unshare(storeId);
        if (!result.ok) {
            this.showError(result.error);
            return;
        }
        MessageToast.show(await this.text(shared ? "storeShared" : "storeUnshared"));
        if (storeId === this.storeId) await this.load(true);
    }
}
