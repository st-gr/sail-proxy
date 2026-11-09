/**
 * "Re-read files": whether a store offers it, the dialog's estimate and the start. No UI5 imports: the store page
 * (or the Administration store list, through the admin routes) passes a host with the view model, the API and the texts, builds the dialog's controls (reextractDialog.ts) and
 * delegates here, so this runs under jest. The dialog's state lives under /reextract of the view model.
 */
import type { GroundingApi, ApiResult } from "../model/api";
import type { Translator } from "../model/jobs";
import { reextractOffered, toReextractEstimate, reextractErrorText } from "../model/reextract";
import { visionCostText, zeroVisionCostText } from "../model/chunking";
import type { ChunkingHost } from "./chunkingFlow";

export function emptyReextract(): any {
    return { storeId: "", storeName: "", estimate: null, message: "", messageType: "None", busy: false };
}

export class ReextractFlow {
    /** The number of the newest dialog: an estimate answering for an older one is dropped. */
    private latest = 0;

    /** `admin`: the Administration screen estimates and starts any owner's store through the admin routes. */
    constructor(private readonly host: ChunkingHost, private readonly admin = false) {}

    private set(changes: Record<string, any>): void {
        for (const [key, value] of Object.entries(changes)) this.host.setProperty(`/reextract/${key}`, value);
    }

    /** Whether the store has files to read again or failed files to queue again (false when the estimate fails). */
    public async offered(storeId: string): Promise<boolean> {
        const api = await this.host.api();
        if (!api || !storeId) return false;
        const result = await api.reextractEstimate(storeId);
        return result.ok && reextractOffered(result.body);
    }

    /** The dialog for `store`: reads the estimate, prices the vision rows, and explains what cannot start. */
    public async prepare(store: { id: string; name: string }): Promise<void> {
        const load = ++this.latest;
        this.host.setProperty("/reextract", { ...emptyReextract(), storeId: store.id, storeName: store.name, busy: true });
        const api = await this.host.api();
        if (!api) return;
        const result = this.admin ? await api.adminReextractEstimate(store.id) : await api.reextractEstimate(store.id);
        const t = await this.host.translator();
        if (load !== this.latest) return;
        this.set({ busy: false });
        if (!result.ok) {
            this.refused(result, t);
            return;
        }
        const estimate = toReextractEstimate(result.body, this.host.locale(), t);
        this.set({ estimate });
        if (estimate.vision) await this.priceVision(api, result.body, load, t);
        if (load !== this.latest) return;
        if (estimate.running) this.set({ message: t("chunkingErrRunning"), messageType: "Error" });
        else if (!estimate.reads && estimate.hasRetryFiles) this.set({ message: t("reextractRetryOnly", [estimate.retryFiles]), messageType: "Information" });
        else if (!estimate.reads) this.set({ message: t("reextractNothing"), messageType: "Information" });
    }

    /** Starts the re-extract the shown estimate allows. Answers the gateway's `{ job, retried_files }`, or null with the refusal shown. */
    public async start(): Promise<any | null> {
        if (this.host.getProperty("/reextract/estimate/canStart") !== true) return null;
        const api = await this.host.api();
        if (!api) return null;
        const storeId = String(this.host.getProperty("/reextract/storeId"));
        this.set({ busy: true });
        const result = this.admin ? await api.adminStartReextract(storeId) : await api.startReextract(storeId);
        this.set({ busy: false });
        if (!result.ok) {
            // The store changed since the estimate: it no longer holds, so the start is not offered again.
            this.refused(result, await this.host.translator());
            this.set({ estimate: null });
            return null;
        }
        return result.body;
    }

    /** The installation's currency as the last price answer named it (null until one did). */
    private currency: string | null = null;

    private async priceVision(api: GroundingApi, body: any, load: number, t: Translator): Promise<void> {
        const model = typeof body?.vision_model === "string" ? body.vision_model : "";
        const input = Number(body?.estimated_vision_input_tokens) || 0;
        const output = Number(body?.estimated_vision_output_tokens) || 0;
        const answer = model && (input > 0 || output > 0) ? await api.modelCost(model, input, output) : null;
        if (load !== this.latest) return;
        const locale = this.host.locale();
        if (answer?.ok && typeof answer.body?.currency === "string") this.currency = answer.body.currency;
        const text = answer === null ? zeroVisionCostText(this.currency, locale, t)
            : visionCostText(answer.ok ? answer.body : null, locale, t, model);
        this.set({ "estimate/visionCost": text });
    }

    private refused(result: ApiResult<any>, t: Translator): void {
        const error = result.error || { status: result.status, code: `http_${result.status}`, message: "" };
        this.set({ message: reextractErrorText(error, t, this.host.locale()), messageType: error.code === "nothing_to_reextract" ? "Information" : "Error" });
    }
}
