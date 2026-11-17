import Fragment from "sap/ui/core/Fragment";
import JSONModel from "sap/ui/model/json/JSONModel";
import MessageBox from "sap/m/MessageBox";
import type Dialog from "sap/m/Dialog";
import type View from "sap/ui/core/mvc/View";
import type Event from "sap/ui/base/Event";
import type { LogsApi, Translator } from "../model/api";
import { downloadUrl, rawIndexQuery } from "../model/traceQuery";
import { problemKey, stageList, type TraceFacts, type TraceRow } from "../model/traceView";
import { detailState, offersShowContent, openedContent, stageText } from "../model/traceDetail";

const ODATA_BASE = "/odata/v4/admin";

/** A row of the list as PayloadTraces.controller.ts decorates it. */
export type ShownTrace = TraceRow & { facts: TraceFacts; timeText: string; durationText: string; contentText: string };

interface Host {
    view: () => View;
    api: () => LogsApi | null;
    translate: () => Translator;
    locale: () => string;
    timeText: (iso: string | null | undefined) => string;
    restBase: () => Promise<string>;
    showLogLines: (requestId: string) => void;
}

/** Saves a download under the name and with the type the service gave it. */
function saveFile(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * One request opened (view/TraceDetail.fragment.xml): its facts; a masked prompt and answer at once;
 * the prompt of a request that was not masked only after "Show content", because the service records
 * that open (and every stage opened or downloaded) in the audit log; for a request captured raw its
 * stages, each to view and to download, and all of them as one file; "Log lines" goes to the Gateway
 * log tab searching the request id. Content is shown as text only (Text and TextArea controls). What
 * is offered is decided in model/traceDetail.ts. "Show content", View and the downloads are disabled
 * while their call runs, so a double click records one open or download, not two.
 */
export default class TraceDetail {
    private dialog: Dialog | null = null;
    private readonly model = new JSONModel({});
    private row: ShownTrace | null = null;
    /** Each open owns the dialog's answers: an answer of an earlier open is dropped. */
    private openCount = 0;

    constructor(private readonly host: Host) {}

    private t(key: string, args?: (string | number)[]): string {
        return this.host.translate()(key, args);
    }

    private async ensureDialog(): Promise<Dialog> {
        if (!this.dialog) {
            const view = this.host.view();
            this.dialog = await Fragment.load({ id: view.getId(), name: "admin.logs.view.TraceDetail", controller: this }) as Dialog;
            this.dialog.setModel(this.model, "detail");
            view.addDependent(this.dialog);
        }
        return this.dialog;
    }

    public async open(row: ShownTrace): Promise<void> {
        const dialog = await this.ensureDialog();
        const count = ++this.openCount;
        this.row = row;
        const facts = row.facts;
        const tokens = facts.inputTokens !== null || facts.outputTokens !== null
            ? this.t("tokensText", [facts.inputTokens ?? "-", facts.outputTokens ?? "-"]) : "";
        const state = detailState(row);
        this.model.setData({
            // Every request opens on General; its Raw capture tab (only for a request captured raw) is a deliberate second step.
            tab: "general",
            row, tokens, hasLight: state.hasLight, masked: state.masked, raw: state.raw, sealed: state.sealed, noContent: state.noContent,
            downloadTrace: state.downloadTrace, stageActions: state.stageActions,
            omittedText: facts.omitted ? this.t(facts.omitted === "stream-incomplete" ? "omittedStreamIncomplete" : "omittedNotCaptured") : "",
            truncatedText: facts.truncated ? this.t("truncatedText") : "",
            prompt: "", answer: "", contentShown: false, showContent: offersShowContent({ sealed: state.sealed, contentShown: false }),
            contentBusy: false, contentProblem: "",
            rawId: "", stages: [], stagesBusy: state.loadStages, stagesProblem: "",
            stageName: "", stageContent: "", stageCut: false, stageProblem: "", stageBusy: false, downloading: false
        });
        dialog.open();
        if (state.loadContent) void this.loadContent(count);
        if (state.loadStages) void this.loadStages(count);
    }

    private isCurrent(count: number): boolean {
        return count === this.openCount && !!this.dialog?.isOpen();
    }

    /** The prompt and answer: as stored when masked; the opened prompt when not (the service records it). */
    private async loadContent(count: number): Promise<void> {
        const api = this.host.api();
        if (!api || !this.row || this.model.getProperty("/contentBusy")) return;
        this.model.setProperty("/contentBusy", true);
        this.model.setProperty("/contentProblem", "");
        let result: Awaited<ReturnType<LogsApi["openPayloadTrace"]>>;
        try {
            result = await api.openPayloadTrace(this.row.ID);
        } finally {
            // A later open owns the flag (setData reset it): only this open's own call clears it.
            if (count === this.openCount) this.model.setProperty("/contentBusy", false);
        }
        if (!this.isCurrent(count)) return;
        if (!result.ok) {
            this.model.setProperty("/contentProblem", result.error?.message ?? "");
            return;
        }
        const opened = openedContent(result.body!);
        if (opened.problemKey) this.model.setProperty("/contentProblem", this.t(opened.problemKey));
        this.model.setProperty("/prompt", opened.prompt);
        this.model.setProperty("/answer", opened.answer);
        this.model.setProperty("/contentShown", opened.contentShown);
        this.model.setProperty("/noContent", opened.noContent);
        this.model.setProperty("/showContent", offersShowContent({ sealed: this.model.getProperty("/sealed") as boolean, contentShown: opened.contentShown }));
    }

    private async loadStages(count: number): Promise<void> {
        const api = this.host.api();
        if (!api || !this.row?.requestId) return;
        const result = await api.entries(`${ODATA_BASE}/RawTraceIndex?${rawIndexQuery(this.row.requestId)}`);
        if (!this.isCurrent(count)) return;
        this.model.setProperty("/stagesBusy", false);
        const raw = result.ok ? result.body!.entries[0] : null;
        if (!raw) {
            this.model.setProperty("/stagesProblem", result.ok ? this.t("stagesGone") : result.error?.message ?? "");
            return;
        }
        this.model.setProperty("/rawId", raw.ID);
        this.model.setProperty("/stages", stageList(raw.stageIndex, this.host.locale()));
    }

    public onShowContent(): void {
        void this.loadContent(this.openCount);
    }

    private stageOf(event: Event): string {
        return ((event.getSource() as any).getBindingContext("detail")?.getObject()?.name ?? "") as string;
    }

    /** Opens one stage (recorded by the service): the content is shown as text, JSON indented. */
    public async onViewStage(event: Event): Promise<void> {
        const name = this.stageOf(event);
        const opened = await this.openStage(name);
        if (!opened) return;
        this.model.setProperty("/stageName", name);
        this.model.setProperty("/stageContent", stageText(opened.content, opened.cut));
        this.model.setProperty("/stageCut", opened.cut);
    }

    /** One stage as its own file, as the service sends it (recorded as a download; a cut stage is a .txt file). */
    public async onDownloadStage(event: Event): Promise<void> {
        const name = this.stageOf(event);
        const rawId = this.model.getProperty("/rawId") as string;
        if (rawId && name) await this.download("raw", rawId, name);
    }

    private async openStage(name: string): Promise<{ content: string; cut: boolean } | null> {
        const api = this.host.api();
        const rawId = this.model.getProperty("/rawId") as string;
        if (!api || !rawId || !name || this.model.getProperty("/stageBusy")) return null;
        const count = this.openCount;
        this.model.setProperty("/stageBusy", true);
        this.model.setProperty("/stageProblem", "");
        let result: Awaited<ReturnType<LogsApi["openRawStage"]>>;
        try {
            result = await api.openRawStage(rawId, name);
        } finally {
            if (count === this.openCount) this.model.setProperty("/stageBusy", false);
        }
        if (!this.isCurrent(count)) return null;
        if (!result.ok) {
            this.model.setProperty("/stageProblem", result.error?.message ?? "");
            return null;
        }
        if (result.body!.problem || result.body!.content === null) {
            this.model.setProperty("/stageProblem", this.t(problemKey(result.body!.problem)));
            return null;
        }
        return { content: result.body!.content, cut: result.body!.cut === true };
    }

    public async onDownloadAll(): Promise<void> {
        const rawId = this.model.getProperty("/rawId") as string;
        if (rawId) await this.download("raw", rawId);
    }

    public async onDownloadTrace(): Promise<void> {
        if (this.row && !this.row.rawOnly) await this.download("trace", this.row.ID);
    }

    /** A download read with the session, one at a time; a refusal is shown translated by its code. */
    private async download(kind: "trace" | "raw", id: string, stage?: string): Promise<void> {
        const api = this.host.api();
        if (!api || this.model.getProperty("/downloading")) return;
        this.model.setProperty("/downloading", true);
        let result: Awaited<ReturnType<LogsApi["download"]>>;
        try {
            result = await api.download(downloadUrl(kind, id, await this.host.restBase(), stage));
        } finally {
            this.model.setProperty("/downloading", false);
        }
        if (result.ok) {
            saveFile(result.blob, result.fileName);
            return;
        }
        const key = result.code === "network" ? "apiServerUnreachable" : result.status === 403 ? "apiNotAdmin" : problemKey(result.code);
        MessageBox.error(this.t(key));
    }

    public onLogLines(): void {
        const requestId = this.row?.requestId;
        this.dialog?.close();
        if (requestId) this.host.showLogLines(requestId);
    }

    public onClose(): void {
        this.dialog?.close();
    }
}
