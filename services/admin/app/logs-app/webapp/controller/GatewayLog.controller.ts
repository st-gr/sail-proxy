import Controller from "sap/ui/core/mvc/Controller";
import JSONModel from "sap/ui/model/json/JSONModel";
import MessageToast from "sap/m/MessageToast";
import Localization from "sap/base/i18n/Localization";
import mobileLibrary from "sap/m/library";
import type Table from "sap/ui/table/Table";
import type Event from "sap/ui/base/Event";
import { LogsApi, type Translator } from "../model/api";
import { DEFAULT_LIMIT, mergeEntries, nextPollCursor, pollWasCut, type Entry, type Order } from "../model/liveLog";
import { createReloadGate, runReload } from "../model/reloadGate";
import { searchSegments, segmentsToHtml } from "../model/highlight";
import { copyText } from "../model/clipboard";
import { decorate, type Row } from "../model/logFormat";
import TableFollower from "./TableFollower";
import LiveStatusLine from "./LiveStatusLine";
import EventBus from "sap/ui/core/EventBus";
import DeleteNow, { STORED_LOGS_DELETED } from "./DeleteNow";
import { deleteResultAfter, logTouched, type DeleteWhat, type ListTrigger } from "../model/deleteNow";
import { entriesUrl, exportUrl, pollQuery, restBase } from "../model/logQuery";
import { readOrder, writeOrder, type StorageLike } from "../model/orderPreference";
import { countText, emptyListText } from "../model/listTexts";
import { createPoller, type Poller } from "../model/poller";
import { quickRange, rangeFromPickers, type QuickRangeKind, type UtcRange } from "../model/timeRange";
import { showTab } from "./LogsTabs";
import type PayloadTracesController from "./PayloadTraces.controller";

const ODATA_BASE = "/odata/v4/admin";
const POLL_INTERVAL_MS = 2000;

/**
 * The Gateway Log tab. Live (the default) shows the newest entries and polls every two seconds;
 * choosing a time range ends Live and shows that period. Newest last follows the bottom of the table
 * unless the person has scrolled up. The list logic is in model/liveLog.ts, the timer in model/poller.ts;
 * the timer and the page-visibility listener end in onExit, which runs when the shell unloads the app.
 * The shell only hides the app for its own pages (Home, Administration) and the tab bar does not render
 * a tab that is not chosen: while this view is not on the page a tick fetches nothing, and showing it
 * again polls at once.
 * @namespace admin.logs.controller
 */
export default class GatewayLogController extends Controller {

    private api: LogsApi | null = null;
    private translate: Translator = (key) => key;
    private poller: Poller | null = null;
    private visibilityHandler: (() => void) | null = null;
    private restBasePromise: Promise<string> | null = null;
    private range: UtcRange | null = null;
    /** The newest reload owns the page (model/reloadGate.ts); exit invalidates it. */
    private readonly gate = createReloadGate();
    private readonly status = new LiveStatusLine(() => this.model(), () => this.translate);
    private readonly deleteNow = new DeleteNow(() => this.api, () => this.translate, () => this.model(), () => this.locale(), () => this.reload("delete"));
    /** The Payload Traces tab's "Delete now" emptied the log too: the list reads again (its own delete reloads by itself). */
    private readonly onStoredDeleted = (_channel: string, _event: string, data: { what?: DeleteWhat; source?: unknown }): void => {
        if (data?.source !== this.deleteNow && logTouched(data?.what)) void this.reload("delete");
    };
    private follower: TableFollower | null = null;
    private dropped = 0;
    /** What the next poll asks after: the admin's time of the previous read minus the overlap (model/liveLog.ts). */
    private cursor: string | null = null;

    public onInit(): void {
        const model = new JSONModel({
            entries: [], appliedSearch: "", appliedLevel: "", statusText: "", liveIcon: "", liveText: "", liveType: "Default", live: true, order: readOrder(this.storage()), busy: false, deleting: false, deleteResult: "", loadError: "", pollError: "", droppedText: "",
            footerText: "", noDataText: "", newBelow: false, fromLocal: "", toLocal: "", rangeState: "None", rangeError: "", search: "", level: "",
            timeZoneText: "",
            // The most rows the view holds (the journey reads it to tell a full view)
            limit: DEFAULT_LIMIT
        });
        model.setSizeLimit(DEFAULT_LIMIT);
        this.getView()!.setModel(model, "log");
        this.follower = new TableFollower(() => this.table(), () => this.order(), (value) => model.setProperty("/newBelow", value), () => this.updateStatus());
        this.poller = createPoller({
            intervalMs: POLL_INTERVAL_MS,
            run: (isCurrent) => this.poll(isCurrent),
            canRun: () => !!this.getView()?.getDomRef(),
            setTimer: (fn, ms) => setTimeout(fn, ms),
            clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
        });
        this.visibilityHandler = () => this.poller?.setHidden(document.hidden);
        document.addEventListener("visibilitychange", this.visibilityHandler);
        this.poller.setHidden(document.hidden);
        EventBus.getInstance().subscribe(STORED_LOGS_DELETED.channel, STORED_LOGS_DELETED.event, this.onStoredDeleted as any);
        void this.start();
    }

    /** The view is on the page again (the shell or the tab bar showed it): catch up at once. */
    public onAfterRendering(): void {
        this.poller?.runNow();
    }

    public onExit(): void {
        this.gate.invalidate();
        this.poller?.dispose();
        this.poller = null;
        if (this.visibilityHandler) document.removeEventListener("visibilitychange", this.visibilityHandler);
        this.visibilityHandler = null;
        EventBus.getInstance().unsubscribe(STORED_LOGS_DELETED.channel, STORED_LOGS_DELETED.event, this.onStoredDeleted as any);
    }

    private async start(): Promise<void> {
        const bundle = await (this.getOwnerComponent()!.getModel("i18n") as any).getResourceBundle();
        if (!this.poller) return;   // the app was left meanwhile
        this.translate = (key, args) => bundle.getText(key, args as any[]);
        this.model().setProperty("/noDataText", this.translate("noEntries"));
        this.api = new LogsApi(ODATA_BASE, (input: string, init?: any) => fetch(input, init), this.translate, this.locale());
        this.model().setProperty("/timeZoneText", this.translate("timeZoneNote", [this.timeZone()]));
        // Asked now, so that Export opens its window right in the click (a later window.open may be blocked).
        void this.restBase();
        this.updateStatus();
        await this.reload();
    }

    private model(): JSONModel {
        return this.getView()!.getModel("log") as JSONModel;
    }

    private table(): Table {
        return this.byId("logTable") as Table;
    }

    private storage(): StorageLike | null {
        try { return window.localStorage; } catch (error) { return null; }
    }

    private locale(): string {
        return Localization.getLanguageTag().toString();
    }

    private timeZone(): string {
        return Localization.getTimezone();
    }

    private order(): Order {
        return this.model().getProperty("/order") as Order;
    }

    private rows(entries: Entry[]): Row[] {
        const locale = this.locale();
        const timeZone = this.timeZone();
        return entries.map((entry) => decorate(entry, locale, timeZone));
    }

    /** The search and level the shown rows were read with (the poll, the highlighting and the export use these). */
    private applied(): { level: string; search: string } {
        return { level: this.model().getProperty("/appliedLevel") as string, search: this.model().getProperty("/appliedSearch") as string };
    }

    /** Reads the newest entries (of the range, if one is chosen) and, in Live, starts polling. */
    private async reload(trigger: ListTrigger = "user"): Promise<void> {
        if (!this.api) return;
        const api = this.api;
        this.poller?.stop();
        const model = this.model();
        model.setProperty("/deleteResult", deleteResultAfter(model.getProperty("/deleteResult") as string, trigger));
        const live = model.getProperty("/live") === true;
        model.setProperty("/pollError", "");
        const typed = { level: model.getProperty("/level") as string, search: model.getProperty("/search") as string };
        const query = { top: DEFAULT_LIMIT, count: true, ...typed, ...(live || !this.range ? {} : this.range) };
        model.setProperty("/appliedSearch", String(query.search ?? "").trim());
        model.setProperty("/appliedLevel", query.level);
        await runReload(this.gate, () => api.entries(entriesUrl(ODATA_BASE, query)), (result) => {
            this.follower!.following = true;
            model.setProperty("/newBelow", false);
            this.cursor = result.ok ? nextPollCursor(null, { ok: true, ...result.body! }) : null;
            if (!result.ok) {
                model.setProperty("/loadError", result.error?.message ?? "");
                this.show([], 0);
            } else {
                model.setProperty("/loadError", "");
                const merged = mergeEntries([], this.rows(result.body!.entries), this.order(), DEFAULT_LIMIT);
                const count = result.body!.count;
                this.show(merged.entries, count !== null ? Math.max(0, count - merged.entries.length) : 0);
                this.scrollToNewest();
            }
            // Not an administrator (403): the service refuses every read, so nothing is polled.
            if (model.getProperty("/live") === true && result.status !== 403) this.poller?.start();
            this.updateStatus();
        }, (busy) => model.setProperty("/busy", busy));
    }

    /**
     * One poll of Live: what was stored after the cursor, with the applied filters, merged without
     * duplicates. A full answer may have cut off older new entries, so the view reloads instead.
     */
    private async poll(isCurrent: () => boolean): Promise<void> {
        if (!this.api) return;
        const token = this.gate.current();
        const model = this.model();
        const result = await this.api.entries(entriesUrl(ODATA_BASE, pollQuery(this.cursor, this.applied(), DEFAULT_LIMIT)));
        if (!this.gate.isLatest(token) || !isCurrent()) return;
        if (!result.ok) {
            model.setProperty("/pollError", this.translate("pollFailed", [result.error?.message ?? ""]));
            if (result.status === 403) this.poller?.stop();
            return;
        }
        model.setProperty("/pollError", "");
        model.setProperty("/loadError", "");
        if (pollWasCut(result.body!.entries.length, DEFAULT_LIMIT)) {
            void this.reload("poll");
            return;
        }
        this.cursor = nextPollCursor(this.cursor, { ok: true, ...result.body! });
        const before = model.getProperty("/entries") as Row[];
        const merged = mergeEntries(before, this.rows(result.body!.entries), this.order(), DEFAULT_LIMIT);
        if (merged.added === 0 && merged.dropped === 0) return;
        const first = this.table().getFirstVisibleRow();
        this.show(merged.entries, this.dropped + merged.dropped);
        this.follower!.afterMerge(before, first, merged.entries, merged.added);
    }

    /** The Live button and the status line in words (LiveStatusLine). */
    private updateStatus(): void {
        const live = this.model().getProperty("/live") === true;
        this.status.update({ live, range: !live && !!this.range, order: this.order(), following: this.follower!.following });
    }

    private show(entries: Row[], dropped: number): void {
        const model = this.model();
        this.dropped = dropped;
        model.setProperty("/entries", entries);
        const number = new Intl.NumberFormat(this.locale());
        model.setProperty("/droppedText", dropped > 0 ? this.translate("droppedEntries", [number.format(dropped), number.format(DEFAULT_LIMIT)]) : "");
        model.setProperty("/footerText", countText(entries.length, "footerShownOne", "footerShown", this.translate, (n) => number.format(n)));
        const applied = this.applied();
        model.setProperty("/noDataText", emptyListText(!!applied.search || !!applied.level, "noEntries", "noEntriesFiltered", this.translate));
    }

    private scrollToNewest(): void {
        this.follower!.scrollToNewest((this.model().getProperty("/entries") as Row[]).length);
    }

    public onFirstVisibleRowChanged(event: Event): void {
        const first = (event as any).getParameter("firstVisibleRow") as number;
        this.follower!.onFirstVisibleRowChanged(first, (this.model().getProperty("/entries") as Row[]).length);
    }

    public onJumpToNewest(): void {
        this.scrollToNewest();
    }

    public onOrderChange(): void {
        const order = this.order();
        writeOrder(this.storage(), order);
        const entries = this.model().getProperty("/entries") as Row[];
        this.model().setProperty("/entries", mergeEntries(entries, [], order, DEFAULT_LIMIT).entries);
        this.scrollToNewest();
        this.updateStatus();
    }

    public onLiveToggle(): void {
        const model = this.model();
        if (model.getProperty("/live") === true) {
            this.range = null;
            model.setProperty("/fromLocal", "");
            model.setProperty("/toLocal", "");
            this.clearRangeState();
            void this.reload();
        } else {
            // A poll in flight learns from its isCurrent() that Live is off; a reload in flight still shows its rows.
            this.poller?.stop();
            model.setProperty("/deleteResult", deleteResultAfter(model.getProperty("/deleteResult") as string, "user"));
            this.updateStatus();
        }
    }

    /** Refresh, a search and a level change read again with the current filters. */
    public onReload(): void {
        void this.reload();
    }

    public onDeleteNow(): void { this.deleteNow.ask(); }

    public onLast15(): void { this.applyQuickRange("last15"); }
    public onLastHour(): void { this.applyQuickRange("lastHour"); }
    public onToday(): void { this.applyQuickRange("today"); }

    private applyQuickRange(kind: QuickRangeKind): void {
        const range = quickRange(kind, new Date(), this.timeZone());
        const model = this.model();
        model.setProperty("/fromLocal", range.fromLocal);
        model.setProperty("/toLocal", range.toLocal);
        this.useRange({ from: range.from, to: range.to });
    }

    /** A time typed or picked: from and to in the person's time zone; one end may stay open, both empty is Live. */
    public onRangeChange(): void {
        const model = this.model();
        const picked = rangeFromPickers(model.getProperty("/fromLocal") as string, model.getProperty("/toLocal") as string, this.timeZone());
        if (picked.kind === "error") {
            model.setProperty("/rangeState", "Error");
            model.setProperty("/rangeError", this.translate(picked.key));
        } else if (picked.kind === "range") {
            this.useRange(picked.range);
        } else {
            this.clearRangeState();
            this.range = null;
            model.setProperty("/live", true);
            void this.reload();
        }
    }

    private useRange(range: UtcRange): void {
        this.clearRangeState();
        this.range = { from: range.from, to: range.to };
        this.model().setProperty("/live", false);
        this.updateStatus();
        void this.reload();
    }

    private clearRangeState(): void {
        this.model().setProperty("/rangeState", "None");
        this.model().setProperty("/rangeError", "");
    }

    /** The export opens as a download in a new window, for the current time range, search and level. */
    public async onExport(): Promise<void> {
        if (!this.api) return;
        const base = await this.restBase();
        mobileLibrary.URLHelper.redirect(exportUrl(base, { ...(this.range ?? {}), ...this.applied() }), true);
    }

    /** Docker and Kyma serve the admin's /api under /admin/api (nginx); local development under /api. */
    private restBase(): Promise<string> {
        this.restBasePromise ??= this.api!.deployTarget().then(restBase);
        return this.restBasePromise;
    }

    /** A log value as markup for FormattedText: each piece escaped, the applied search term in bold. */
    public highlight(text: unknown, term: unknown): string {
        return segmentsToHtml(searchSegments(String(text ?? ""), String(term ?? "")));
    }

    public onCopyRequestId(event: Event): void {
        const row = (event.getSource() as any).getBindingContext("log")?.getObject() as Row | undefined;
        if (!row?.requestId) return;
        void copyText(navigator.clipboard, row.requestId).then((key) => MessageToast.show(this.translate(key)));
    }

    /** "Payload trace": the request's trace on the Payload Traces tab (it says so when there is none). */
    public onPayloadTrace(event: Event): void {
        const row = (event.getSource() as any).getBindingContext("log")?.getObject() as Row | undefined;
        if (row?.requestId) void showTab<PayloadTracesController>(this.getView()!, "traces")?.showRequestTrace(row.requestId);
    }

    /** "Log lines" of a payload trace: Live, searching the request id (Live finds it however old it is). */
    public showRequest(requestId: string): void {
        const model = this.model();
        this.range = null;
        model.setProperty("/fromLocal", "");
        model.setProperty("/toLocal", "");
        this.clearRangeState();
        model.setProperty("/search", requestId);
        model.setProperty("/live", true);
        void this.reload();
    }
}
