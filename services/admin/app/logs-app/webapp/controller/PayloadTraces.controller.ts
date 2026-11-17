import Controller from "sap/ui/core/mvc/Controller";
import JSONModel from "sap/ui/model/json/JSONModel";
import MessageBox from "sap/m/MessageBox";
import MessageToast from "sap/m/MessageToast";
import EventBus from "sap/ui/core/EventBus";
import Localization from "sap/base/i18n/Localization";
import type Event from "sap/ui/base/Event";
import { LogsApi, type ActiveCapture, type Translator } from "../model/api";
import { formatLoggedAt, formatToMinute } from "../model/logFormat";
import { restBase } from "../model/logQuery";
import { deleteResultAfter, tracesTouched, type DeleteWhat, type ListTrigger } from "../model/deleteNow";
import { createReloadGate, runReload } from "../model/reloadGate";
import { quickRange, rangeFromPickers, type QuickRangeKind, type UtcRange } from "../model/timeRange";
import { rawIndexQuery, rawListQuery, traceByRequestQuery, traceListQuery, TRACE_LIMIT } from "../model/traceQuery";
import { captureTextKey, fileLoggingTextKey, traceFacts, traceListRows, weakKeyTextKey, withRawOnly, type TraceRow } from "../model/traceView";
import DeleteNow, { STORED_LOGS_DELETED } from "./DeleteNow";
import TraceDetail, { type ShownTrace } from "./TraceDetail";
import StartRawCapture from "./StartRawCapture";
import { showTab } from "./LogsTabs";
import { countText, emptyListText } from "../model/listTexts";
import type GatewayLogController from "./GatewayLog.controller";

const ODATA_BASE = "/odata/v4/admin";
/** Published when a raw capture starts or stops, so the shell's orange bar follows at once. */
export const RAW_CAPTURE_CHANGED = { channel: "admin.rawCapture", event: "changed" };

/**
 * The Payload Traces tab (spec 4.2): whether payload capture is on, the running raw capture sessions
 * with Stop, "Start raw capture", and the traces of a chosen time range. The list needs a range; the
 * filter works within it. A row opens the request's detail (TraceDetail.ts); the dialog that starts
 * a raw capture is StartRawCapture.ts. The list logic is in model/traceQuery.ts and model/traceView.ts.
 * @namespace admin.logs.controller
 */
export default class PayloadTracesController extends Controller {

    private api: LogsApi | null = null;
    private translate: Translator = (key) => key;
    private exited = false;
    private range: UtcRange | null = null;
    private restBasePromise: Promise<string> | null = null;
    private readonly gate = createReloadGate();
    private readonly deleteNow = new DeleteNow(() => this.api, () => this.translate, () => this.model(), () => this.locale(), () => this.reload("delete"));
    private readonly detail = new TraceDetail({
        view: () => this.getView()!, api: () => this.api, translate: () => this.translate, locale: () => this.locale(),
        timeText: (iso) => this.timeText(iso), restBase: () => this.restBase(),
        showLogLines: (requestId) => showTab<GatewayLogController>(this.getView()!, "log")?.showRequest(requestId)
    });
    private readonly starter = new StartRawCapture({
        view: () => this.getView()!, api: () => this.api, translate: () => this.translate,
        weakKeyText: () => this.model().getProperty("/weakKeyText") as string,
        formatTime: (iso) => formatToMinute(iso, this.locale(), this.timeZone()),
        changed: () => this.sessionsChanged()
    });
    /** The Gateway log's "Delete now" emptied the traces too: the list reads again (its own delete reloads by itself). */
    private readonly onStoredDeleted = (_channel: string, _event: string, data: { what?: DeleteWhat; source?: unknown }): void => {
        if (data?.source !== this.deleteNow && tracesTouched(data?.what)) void this.reload("delete");
    };

    public onInit(): void {
        this.getView()!.setModel(new JSONModel({
            rows: [], busy: false, loadError: "", settingsError: "", noDataText: "", footerText: "", captureText: "", weakKeyText: "", fileLoggingText: "", sessions: [],
            fromLocal: "", toLocal: "", rangeState: "None", rangeError: "", search: "", timeZoneText: "", deleting: false, deleteResult: ""
        }), "traces");
        EventBus.getInstance().subscribe(STORED_LOGS_DELETED.channel, STORED_LOGS_DELETED.event, this.onStoredDeleted as any);
        void this.start();
    }

    public onExit(): void {
        this.exited = true;
        this.gate.invalidate();
        EventBus.getInstance().unsubscribe(STORED_LOGS_DELETED.channel, STORED_LOGS_DELETED.event, this.onStoredDeleted as any);
    }

    /** The tab is shown again: the bar and the sessions as they are now (the settings tab or another administrator may have changed them). */
    public onAfterRendering(): void {
        if (!this.api) return;
        void this.loadSettings();
        void this.loadSessions();
    }

    private async start(): Promise<void> {
        const bundle = await (this.getOwnerComponent()!.getModel("i18n") as any).getResourceBundle();
        if (this.exited) return;
        this.translate = (key, args) => bundle.getText(key, args as any[]);
        this.api = new LogsApi(ODATA_BASE, (input: string, init?: any) => fetch(input, init), this.translate, this.locale());
        const model = this.model();
        model.setProperty("/timeZoneText", this.translate("timeZoneNote", [this.timeZone()]));
        model.setProperty("/noDataText", this.translate("tracesRangeRequired"));
        void this.restBase();
        await Promise.all([this.loadSettings(), this.loadSessions()]);
    }

    private model(): JSONModel {
        return this.getView()!.getModel("traces") as JSONModel;
    }

    private locale(): string {
        return Localization.getLanguageTag().toString();
    }

    private timeZone(): string {
        return Localization.getTimezone();
    }

    private timeText(iso: string | null | undefined): string {
        return iso ? formatLoggedAt(iso, this.locale(), this.timeZone()) : "";
    }

    /** Docker and Kyma serve the admin's /api under /admin/api (nginx); local development under /api. */
    private restBase(): Promise<string> {
        this.restBasePromise ??= this.api!.deployTarget().then(restBase);
        return this.restBasePromise;
    }

    /** The bar: payload capture on or off, and the warning of a seal key that is not strong. */
    private async loadSettings(): Promise<void> {
        const result = await this.api!.getSettings();
        if (this.exited) return;
        const model = this.model();
        model.setProperty("/settingsError", result.ok ? "" : result.error?.message ?? "");
        if (!result.ok) return;
        model.setProperty("/captureText", this.translate(captureTextKey(result.body!)));
        const weak = weakKeyTextKey(result.body!.traceKeyStatus);
        model.setProperty("/weakKeyText", weak ? this.translate(weak) : "");
        const files = fileLoggingTextKey(result.body!.payloadFileLoggingEnabled);
        model.setProperty("/fileLoggingText", files ? this.translate(files) : "");
    }

    private async loadSessions(): Promise<void> {
        const result = await this.api!.activeRawCapture();
        if (this.exited || !result.ok) return;
        this.model().setProperty("/sessions", (result.body ?? []).map((s: ActiveCapture) => ({
            ...s,
            endsText: formatToMinute(s.endsAt, this.locale(), this.timeZone()),
            targetsText: this.translate("sessionTargets", [s.keyCount, s.addressCount])
        })));
    }

    /** After a start or a stop: the sessions here, and the shell's orange bar at once. */
    private sessionsChanged(): void {
        void this.loadSessions();
        EventBus.getInstance().publish(RAW_CAPTURE_CHANGED.channel, RAW_CAPTURE_CHANGED.event);
    }

    private decorate(row: TraceRow): ShownTrace {
        const facts = traceFacts(row);
        const number = new Intl.NumberFormat(this.locale());
        return {
            ...row, facts,
            timeText: this.timeText(row.capturedAt),
            durationText: facts.durationMs === null ? "" : this.translate("durationMs", [number.format(facts.durationMs)]),
            contentText: facts.contentKeys.map((key) => this.translate(key)).join(", ")
        };
    }

    /** Reads the traces of the range with the filter text; without a range the list asks for one. */
    private async reload(trigger: ListTrigger = "user"): Promise<void> {
        if (!this.api) return;
        const api = this.api;
        const model = this.model();
        model.setProperty("/deleteResult", deleteResultAfter(model.getProperty("/deleteResult") as string, trigger));
        const search = String(model.getProperty("/search") ?? "");
        const query = traceListQuery(this.range, search);
        if (!query.ok) {
            this.gate.invalidate();
            model.setProperty("/rows", []);
            model.setProperty("/footerText", "");
            model.setProperty("/noDataText", this.translate("tracesRangeRequired"));
            return;
        }
        const rawQuery = rawListQuery(this.range)!;
        await runReload(this.gate, () => Promise.all([
            api.entries(`${ODATA_BASE}/PayloadTraces?${query.query}`),
            api.entries(`${ODATA_BASE}/RawTraceIndex?${rawQuery}`)
        ]), ([light, raw]) => {
            if (!light.ok) {
                model.setProperty("/loadError", light.error?.message ?? "");
                model.setProperty("/rows", []);
                model.setProperty("/footerText", "");
                return;
            }
            // A failed raw read is said, not dropped: with payload capture off the raw traces may be all there is.
            model.setProperty("/loadError", raw.ok ? "" : raw.error?.message ?? "");
            // A cut light read gets only the raw-only rows newer than its oldest row (older ones could show twice);
            // the footer says the list is cut, and that raw-only rows are left out when they are.
            const list = traceListRows(light.body!, raw.ok ? raw.body!.entries : [], search, TRACE_LIMIT);
            const rows = list.rows.map((row) => this.decorate(row));
            model.setSizeLimit(Math.max(100, rows.length));
            model.setProperty("/rows", rows);
            model.setProperty("/noDataText", emptyListText(search.trim() !== "", "tracesNone", "tracesNoneFiltered", this.translate));
            const number = new Intl.NumberFormat(this.locale());
            const shown = list.cut
                ? this.translate("tracesShownOfMany", [number.format(rows.length), number.format(list.total ?? rows.length)])
                : countText(rows.length, "tracesShownOne", "tracesShown", this.translate, (n) => number.format(n));
            model.setProperty("/footerText", list.rawLeftOut ? `${shown} · ${this.translate("tracesRawLeftOut")}` : shown);
        }, (busy) => model.setProperty("/busy", busy));
    }

    public onReload(): void { void this.reload(); }

    /** Refresh: the bar and the sessions too. */
    public onRefresh(): void {
        void this.loadSettings();
        void this.loadSessions();
        void this.reload();
    }

    public onDeleteNow(): void { this.deleteNow.ask(); }

    public onLast15(): void { this.applyQuickRange("last15"); }
    public onLastHour(): void { this.applyQuickRange("lastHour"); }
    public onToday(): void { this.applyQuickRange("today"); }

    private applyQuickRange(kind: QuickRangeKind): void {
        const range = quickRange(kind, new Date(), this.timeZone());
        this.model().setProperty("/fromLocal", range.fromLocal);
        this.model().setProperty("/toLocal", range.toLocal);
        this.useRange({ from: range.from, to: range.to });
    }

    /** A time typed or picked, in the person's time zone; one end may stay open, both empty ask for a range again. */
    public onRangeChange(): void {
        const model = this.model();
        const picked = rangeFromPickers(model.getProperty("/fromLocal") as string, model.getProperty("/toLocal") as string, this.timeZone());
        if (picked.kind === "error") {
            model.setProperty("/rangeState", "Error");
            model.setProperty("/rangeError", this.translate(picked.key));
            return;
        }
        this.useRange(picked.kind === "range" ? picked.range : null);
    }

    private useRange(range: UtcRange | null): void {
        this.model().setProperty("/rangeState", "None");
        this.model().setProperty("/rangeError", "");
        this.range = range;
        void this.reload();
    }

    public onOpenTrace(event: Event): void {
        const row = (event.getSource() as any).getBindingContext("traces")?.getObject() as ShownTrace | undefined;
        if (row) void this.detail.open(row);
    }

    /** The Gateway log's "Payload trace": the request's light trace, else its raw trace, else a message. */
    public async showRequestTrace(requestId: string): Promise<void> {
        if (!this.api || !requestId) return;
        const light = await this.api.entries(`${ODATA_BASE}/PayloadTraces?${traceByRequestQuery(requestId)}`);
        if (light.ok && light.body!.entries.length) {
            void this.detail.open(this.decorate(light.body!.entries[0]));
            return;
        }
        const raw = await this.api.entries(`${ODATA_BASE}/RawTraceIndex?${rawIndexQuery(requestId)}`);
        if (raw.ok && raw.body!.entries.length) {
            const [row] = withRawOnly([], raw.body!.entries, "");
            void this.detail.open(this.decorate(row));
            return;
        }
        const failed = !light.ok ? light : !raw.ok ? raw : null;
        if (failed) MessageBox.error(failed.error?.message ?? "");
        else MessageToast.show(this.translate("noTraceForRequest"));
    }

    public onStartRawCapture(): void { void this.starter.open(); }

    public async onStopRawCapture(event: Event): Promise<void> {
        const session = (event.getSource() as any).getBindingContext("traces")?.getObject() as ActiveCapture | undefined;
        if (!session || !this.api) return;
        const result = await this.api.stopRawCapture(session.ID);
        if (this.exited) return;
        if (result.ok) MessageToast.show(this.translate("rawCaptureStopped"));
        else MessageBox.error(result.error?.message ?? "");
        this.sessionsChanged();
    }
}
