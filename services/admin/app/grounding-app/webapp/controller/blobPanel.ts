/**
 * The Administration overview's "Blob storage" panel: its figures, the S3 connection test, and starting and
 * cancelling a blob migration. No UI5 imports: the Admin controller passes a host with the view model, the API,
 * the texts, the dialogs and the timer, so this runs under jest.
 */
import type { GroundingApi, ApiError } from "../model/api";
import { toBlobPanel, blobsToMove, migrationWarning, connectionTestResult, BLOB_MIGRATION_TARGETS } from "../model/admin";
import { blobStorageText, type Translator } from "../model/jobs";
import { formatBytes } from "../model/format";

/** The panel's model under /blob: the overview's figures once loaded, the chosen migration target and the last connection test. */
export function emptyBlob(): any {
    return { loaded: false, busy: false, testBusy: false, target: "", rows: [], migration: null, canMigrate: false, test: { text: "", type: "None" } };
}

/** What the panel needs from the Admin controller. */
export interface BlobPanelHost {
    getProperty(path: string): any;
    setProperty(path: string, value: any): void;
    /** The API for an admin, or null (the controller has already sent anyone else away). */
    adminApi(): Promise<GroundingApi | null>;
    translator(): Promise<Translator>;
    text(key: string, args?: any[]): Promise<string>;
    locale(): string;
    showError(error: ApiError | null): void;
    /** Asks; runs `onOk` only when the user confirms. */
    confirm(question: string, onOk: () => Promise<void>): void;
    toast(text: string): void;
    /** True while the screen is shown on its Overview tab: only then does the panel refresh itself. */
    overviewShown(): boolean;
    /** Replaces any pending refresh of the screen with `refresh`, after the poll interval. */
    schedule(refresh: () => void): void;
    openJob(jobId: string): void;
}

export class BlobPanelController {
    /** The number of the newest load: an older answer arriving later is dropped. */
    private latest = 0;
    /** The gateway's last blob storage overview: what a migration would move is counted from it. */
    private overview: any = null;

    constructor(private readonly host: BlobPanelHost) {}

    /**
     * Loads the panel. While a migration is active and the overview is shown, it refreshes itself quietly
     * (a failed refresh shows no error and tries again on the next refresh). The migration target keeps the
     * admin's choice; at first it is the configured backend (db when that is not a migration target).
     */
    public async load(quiet = false): Promise<void> {
        const host = this.host;
        const api = await host.adminApi();
        if (!api) return;
        const load = ++this.latest;
        if (!quiet) host.setProperty("/blob/busy", true);
        const result = await api.adminBlobStorage();
        if (load !== this.latest) return;
        host.setProperty("/blob/busy", false);
        if (!result.ok) {
            if (!quiet) host.showError(result.error);
            return;
        }
        const panel = toBlobPanel(result.body, await host.translator(), host.locale());
        if (load !== this.latest) return;
        this.overview = result.body;
        const chosen = String(host.getProperty("/blob/target") || "");
        const targets = BLOB_MIGRATION_TARGETS as readonly string[];
        const target = targets.includes(chosen) ? chosen : targets.includes(panel.backend) ? panel.backend : "db";
        host.setProperty("/blob", { ...emptyBlob(), ...panel, loaded: true, target, test: host.getProperty("/blob/test") });
        if (host.overviewShown() && panel.migration?.active) host.schedule(() => { void this.load(true); });
    }

    /** The S3 probe (PUT and GET of a fixed object under the prefix); the answer names no bucket or key. */
    public async test(): Promise<void> {
        const host = this.host;
        const api = await host.adminApi();
        if (!api) return;
        host.setProperty("/blob/testBusy", true);
        const result = await api.adminBlobStorageTest();
        host.setProperty("/blob/testBusy", false);
        if (!result.ok) {
            host.showError(result.error);
            return;
        }
        host.setProperty("/blob/test", connectionTestResult(result.body, await host.translator()));
    }

    /**
     * Asks first, naming the target and what moves there, and warns when the target is not the backend new uploads
     * go to. A 409 (a migration already runs, the target is not reachable) reloads the panel.
     */
    public async migrate(): Promise<void> {
        const host = this.host;
        const target = String(host.getProperty("/blob/target") || "");
        const backend = String(host.getProperty("/blob/backend") || "");
        const t = await host.translator();
        const locale = host.locale();
        const move = blobsToMove(this.overview, target);
        const question = [
            t("blobConfirmMigrate", [blobStorageText(target, t), move.blobs.toLocaleString(locale), formatBytes(move.bytes, locale)]),
            migrationWarning(target, backend, t)
        ].filter((part) => part !== "").join("\n\n");
        host.confirm(question, async () => {
            const api = await host.adminApi();
            if (!api) return;
            host.setProperty("/blob/busy", true);
            const result = await api.adminBlobMigrate(target);
            host.setProperty("/blob/busy", false);
            if (!result.ok) {
                host.showError(result.error);
                if (result.status === 409) await this.load();
                return;
            }
            host.toast(result.body?.job
                ? await host.text("blobMigrationStarted")
                : await host.text("blobNothingToMigrate", [blobStorageText(target, t)]));
            await this.load();
        });
    }

    /** Cancels the running migration: blobs already moved stay in the target, the others where they are. */
    public async cancel(): Promise<void> {
        const host = this.host;
        const migration = host.getProperty("/blob/migration");
        if (!migration?.id) return;
        host.confirm(await host.text("blobConfirmCancel", [migration.targetText]), async () => {
            const api = await host.adminApi();
            if (!api) return;
            const result = await api.adminCancelJob(migration.id);
            if (!result.ok) host.showError(result.error);
            else host.toast(await host.text("blobMigrationCancelled"));
            await this.load();
        });
    }

    public viewJob(): void {
        const jobId = this.host.getProperty("/blob/migration/id");
        if (jobId) this.host.openJob(jobId);
    }
}
