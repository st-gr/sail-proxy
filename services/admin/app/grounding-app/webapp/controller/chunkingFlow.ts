/**
 * The chunking dialogs' logic: the create dialog's fields with the installation default, and a store's
 * "Change Chunking": the fields, the re-chunk estimate, the refusals and the start. No UI5 imports: the
 * controllers (Stores, StoreDetail, Admin) pass a host with the view model, the API and the texts, build the
 * dialog's controls (chunkingDialogs.ts) and delegate here, so this runs under jest.
 *
 * The dialog's state lives under /chunking of the view model; the fields are bound to /chunking/form.
 */
import type { GroundingApi, ApiResult, ChunkingSetting } from "../model/api";
import type { Translator } from "../model/jobs";
import { toChunkingForm, formToSetting, defaultChunking, toChunkingEstimate, chunkingErrorText, chunkingText, overlapLimit, visionCostText, zeroVisionCostText } from "../model/chunking";
import { isRechunkJob } from "../model/jobs";

/**
 * The dialog's state: the store it acts on, its current setting's summary, the fields, the overlap field's bound
 * (half of max tokens), the estimate once read. `visionShown`: the vision mode field is offered (the gateway allows
 * vision, or the store has a mode already); `unmaskedWarning`: page images would reach the vision model unmasked.
 */
export function emptyChunking(): any {
    const form = toChunkingForm(null);
    return {
        storeId: "", storeName: "", ownerEmail: "", current: "", form, overlapMax: overlapLimit(form.maxTokens), message: "", messageType: "None",
        estimate: null, busy: false, visionShown: false, unmaskedWarning: false
    };
}

/** What /status says about vision: allowed here, and whether page images would reach the model unmasked. */
function visionStatus(status: any): { available: boolean; unmaskedWarning: boolean } {
    return { available: status?.vision?.available === true, unmaskedWarning: status?.vision?.unmaskedWarning === true };
}

/** What the flow needs from a controller. */
export interface ChunkingHost {
    getProperty(path: string): any;
    setProperty(path: string, value: any): void;
    /** The API, or null (the controller has already sent the user to the "not configured" page). */
    api(): Promise<GroundingApi | null>;
    translator(): Promise<Translator>;
    locale(): string;
}

/** The store a change dialog acts on: a store row of the owner's page or of the Administration list. */
export interface ChunkingStore { id: string; name: string; ownerEmail?: string; chunking: ChunkingSetting | null }

export class ChunkingFlow {
    /** The number of the newest estimate or field change: an estimate answering after a change is dropped. */
    private latest = 0;
    /** The setting the shown estimate was read for: the start sends exactly this one. */
    private estimatedFor: ChunkingSetting | null = null;

    /** `admin`: the Administration screen acts on any owner's store through the admin routes. */
    constructor(private readonly host: ChunkingHost, private readonly admin = false) {}

    private set(changes: Record<string, any>): void {
        for (const [key, value] of Object.entries(changes)) this.host.setProperty(`/chunking/${key}`, value);
    }

    /** The create dialog: the fields start from the installation default (static 800/400 when it cannot be read). */
    public async prepareCreate(): Promise<void> {
        this.latest++;
        this.estimatedFor = null;
        this.host.setProperty("/chunking", emptyChunking());
        const api = await this.host.api();
        const status = api ? await api.status() : null;
        const body = status?.ok ? status.body : null;
        const vision = visionStatus(body);
        const form = toChunkingForm(defaultChunking(body));
        // Where vision is not allowed a new store gets none (the gateway refuses a mode there).
        if (!vision.available) form.vision = "off";
        this.set({ form, overlapMax: overlapLimit(form.maxTokens), visionShown: vision.available, unmaskedWarning: vision.unmaskedWarning });
    }

    /** The change dialog for `store`: the fields start from its current setting. */
    public async prepareChange(store: ChunkingStore): Promise<void> {
        this.latest++;
        this.estimatedFor = null;
        const load = this.latest;
        const t = await this.host.translator();
        const form = toChunkingForm(store.chunking);
        this.host.setProperty("/chunking", {
            ...emptyChunking(),
            storeId: store.id,
            storeName: store.name,
            ownerEmail: store.ownerEmail || "",
            current: chunkingText(store.chunking, t),
            form,
            overlapMax: overlapLimit(form.maxTokens),
            // A store with a mode always shows it, so a size change never drops the mode unseen.
            visionShown: form.vision !== "off"
        });
        const api = await this.host.api();
        const status = api ? await api.status() : null;
        if (load !== this.latest) return;
        const vision = visionStatus(status?.ok ? status.body : null);
        this.set({ visionShown: vision.available || form.vision !== "off", unmaskedWarning: vision.unmaskedWarning });
    }

    /** A field changed: the estimate no longer matches it, Static never sends contextual, and the overlap bound follows max. */
    public changed(): void {
        this.latest++;
        this.estimatedFor = null;
        if (this.host.getProperty("/chunking/form/type") !== "structure") this.host.setProperty("/chunking/form/contextual", false);
        this.set({ estimate: null, message: "", messageType: "None", busy: false, overlapMax: overlapLimit(this.host.getProperty("/chunking/form/maxTokens")) });
    }

    /** The checked setting, or null with the problem shown in the dialog. */
    public async setting(): Promise<ChunkingSetting | null> {
        const result = formToSetting(this.host.getProperty("/chunking/form"), await this.host.translator());
        if (result.ok) return result.setting;
        this.set({ message: result.message, messageType: "Error" });
        return null;
    }

    /**
     * Reads the estimate for the fields' setting. The dialog shows its figures as estimates; a setting the store
     * already has, or a running re-embed or re-chunk, is explained instead of being offered to start. It can be
     * asked again without a field change (a running job may have finished meanwhile).
     */
    public async estimate(): Promise<void> {
        this.estimatedFor = null;
        const setting = await this.setting();
        if (!setting) return;
        const api = await this.host.api();
        if (!api) return;
        const load = ++this.latest;
        const storeId = String(this.host.getProperty("/chunking/storeId"));
        this.set({ busy: true, message: "", messageType: "None", estimate: null });
        const result = this.admin ? await api.adminChunkingEstimate(storeId, setting) : await api.chunkingEstimate(storeId, setting);
        const t = await this.host.translator();
        if (load !== this.latest) return;
        this.set({ busy: false });
        if (!result.ok) {
            this.refused(result, t);
            return;
        }
        const estimate = toChunkingEstimate(result.body, this.host.locale());
        this.estimatedFor = setting;
        this.set({ estimate });
        if (estimate.vision) await this.priceVision(api, result.body, load, t);
        if (load !== this.latest) return;
        if (estimate.running) this.set({ message: t("chunkingErrRunning"), messageType: "Error" });
        else if (estimate.fillsContexts) this.set({ message: t("chunkingFillContexts", [estimate.missingContexts]), messageType: "Information" });
        else if (estimate.unchanged) this.set({ message: t("chunkingUnchanged"), messageType: "Information" });
    }

    /**
     * Starts the re-chunk with exactly the setting the shown estimate was read for (never the fields re-read).
     * Answers the job, or null with the refusal shown in the dialog.
     */
    public async start(): Promise<any | null> {
        const setting = this.estimatedFor;
        if (!setting || this.host.getProperty("/chunking/estimate/canStart") !== true) return null;
        const api = await this.host.api();
        if (!api) return null;
        const storeId = String(this.host.getProperty("/chunking/storeId"));
        this.set({ busy: true });
        const result = this.admin ? await api.adminStartChunking(storeId, setting) : await api.startChunking(storeId, setting);
        this.set({ busy: false });
        if (!result.ok) {
            // The store changed since the estimate (a job started, the setting switched, the model went away):
            // the estimate no longer holds, so the start is offered again only after a new one.
            this.refused(result, await this.host.translator());
            this.estimatedFor = null;
            this.set({ estimate: null });
            return null;
        }
        return result.body;
    }

    /** The installation's currency as the last price answer named it (null until one did). */
    private currency: string | null = null;

    /** The vision rows' cost: their tokens at the Model Library's price of the vision model, "up to", or unknown. */
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
        this.set({ message: chunkingErrorText(error, t, this.host.locale()), messageType: error.code === "chunking_current" ? "Information" : "Error" });
    }

    /** The summary of the setting a running job re-chunks the store to, or "" when the job is a plain re-embed, a
     *  re-extract (the store keeps its setting) or unreadable. */
    public async runningTarget(jobId: string): Promise<string> {
        return (await this.runningJob(jobId)).target;
    }

    /** What a running store job does: the setting a re-chunk switches the store to (runningTarget), and whether it re-extracts. */
    public async runningJob(jobId: string): Promise<{ target: string; reextract: boolean }> {
        const none = { target: "", reextract: false };
        if (!jobId) return none;
        const api = await this.host.api();
        if (!api) return none;
        const job = await api.getJob(jobId);
        if (!job.ok || !isRechunkJob(job.body)) return none;
        if (job.body.reextract === true) return { target: "", reextract: true };
        return { target: chunkingText(job.body.target_chunking, await this.host.translator()), reextract: false };
    }
}
