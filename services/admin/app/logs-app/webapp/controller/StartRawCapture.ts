import Fragment from "sap/ui/core/Fragment";
import JSONModel from "sap/ui/model/json/JSONModel";
import MessageBox from "sap/m/MessageBox";
import MessageToast from "sap/m/MessageToast";
import type Dialog from "sap/m/Dialog";
import type View from "sap/ui/core/mvc/View";
import type { LogsApi, Translator } from "../model/api";
import { keyListOutcome, rawCaptureForm, startedNotice, type RawCaptureProblem } from "../model/rawCaptureForm";

const ODATA_BASE = "/odata/v4/admin";
// Service keys and expired keys are left out by model/rawCaptureForm.ts credentialItems.
const API_KEYS = `${ODATA_BASE}/ApiKeys?$select=ID,name,email,maskedKey,isActive,expiresAt,neverExpires&$filter=${encodeURIComponent("IsActiveEntity eq true and isActive eq true and deletedAt eq null")}`;
const AWS_CREDENTIALS = `${ODATA_BASE}/AwsCredentials?$select=ID,name,email,accessKeyId,isActive,expiresAt,neverExpires&$filter=${encodeURIComponent("IsActiveEntity eq true and isActive eq true")}`;

/** The field each refusal of the form is shown at, and its text. */
const PROBLEM_FIELDS: Record<RawCaptureProblem, { fields: string[]; key: string }> = {
    "no-target": { fields: ["keys", "emails"], key: "rawCaptureNoTarget" },
    "no-reason": { fields: ["reason"], key: "rawCaptureNoReason" },
    duration: { fields: ["minutes"], key: "rawCaptureDuration" }
};

interface Host {
    view: () => View;
    api: () => LogsApi | null;
    translate: () => Translator;
    /** The warning of a weak seal key, as the tab shows it ('' when the key is strong). */
    weakKeyText: () => string;
    formatTime: (iso: string) => string;
    /** A session started: the tab reloads its sessions and tells the shell. */
    changed: () => void;
}

/**
 * "Start raw capture" (view/StartRawCapture.fragment.xml): API keys from the key lists and/or e-mail
 * addresses, 15 minutes, 1 hour or 4 hours, and a reason. The dialog says that keys created after the
 * start are not included (D4) and, with a weak seal key, that anyone who knows its value can decrypt
 * the stages (D1); after a start it shows the service's keyWarning.
 */
export default class StartRawCapture {
    private dialog: Dialog | null = null;
    private readonly model = new JSONModel({});

    constructor(private readonly host: Host) {}

    private t(key: string, args?: (string | number)[]): string {
        return this.host.translate()(key, args);
    }

    public async open(): Promise<void> {
        if (!this.dialog) {
            const view = this.host.view();
            this.dialog = await Fragment.load({ id: view.getId(), name: "admin.logs.view.StartRawCapture", controller: this }) as Dialog;
            this.dialog.setModel(this.model, "capture");
            view.addDependent(this.dialog);
        }
        this.model.setData({
            keys: [], keysBusy: true, apiKeyIds: [], emails: "", minutes: "60", reason: "", error: "", busy: false,
            weakKeyText: this.host.weakKeyText(), state: {}, stateText: {}
        });
        this.clearStates();
        this.dialog.open();
        void this.loadKeys();
    }

    private async loadKeys(): Promise<void> {
        const api = this.host.api();
        if (!api) return;
        const [keys, aws] = await Promise.all([api.entries(API_KEYS), api.entries(AWS_CREDENTIALS)]);
        this.model.setProperty("/keysBusy", false);
        const { items, error } = keyListOutcome(keys, aws, (key, args) => this.t(key, args));
        if (error) this.model.setProperty("/error", error);
        this.model.setSizeLimit(Math.max(100, items.length));
        this.model.setProperty("/keys", items);
    }

    private clearStates(): void {
        for (const field of ["keys", "emails", "minutes", "reason"]) {
            this.model.setProperty(`/state/${field}`, "None");
            this.model.setProperty(`/stateText/${field}`, "");
        }
    }

    public async onStart(): Promise<void> {
        const api = this.host.api();
        if (!api || this.model.getProperty("/busy")) return;
        this.clearStates();
        this.model.setProperty("/error", "");
        const data = this.model.getData();
        const form = rawCaptureForm({ apiKeyIds: data.apiKeyIds, emails: data.emails, minutes: data.minutes, reason: data.reason });
        if (!form.ok) {
            const problem = PROBLEM_FIELDS[form.reason];
            for (const field of problem.fields) {
                this.model.setProperty(`/state/${field}`, "Error");
                this.model.setProperty(`/stateText/${field}`, this.t(problem.key));
            }
            return;
        }
        this.model.setProperty("/busy", true);
        const result = await api.startRawCapture(form.payload);
        this.model.setProperty("/busy", false);
        if (!result.ok) {
            this.model.setProperty("/error", result.error?.message ?? "");
            return;
        }
        this.dialog?.close();
        const notice = startedNotice(result.body!, (key, args) => this.t(key, args), this.host.formatTime);
        if (notice.warning) MessageBox.warning(notice.text);
        else MessageToast.show(notice.text);
        this.host.changed();
    }

    public onCancel(): void {
        this.dialog?.close();
    }
}
