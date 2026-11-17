import Controller from "sap/ui/core/mvc/Controller";
import JSONModel from "sap/ui/model/json/JSONModel";
import MessageBox from "sap/m/MessageBox";
import MessageToast from "sap/m/MessageToast";
import Localization from "sap/base/i18n/Localization";
import type Event from "sap/ui/base/Event";
import { LogsApi, type ApiResult, type Translator } from "../model/api";
import { formatToMinute } from "../model/logFormat";
import { clearedByFixed, componentHints, fieldOfErrorCode, formFromResult, formSignature, paramsFromForm, validateForm, type ComponentRow, type SettingsForm, type SettingsResult } from "../model/settingsForm";
import { describeForm } from "../model/settingsTexts";

const ODATA_BASE = "/odata/v4/admin";
const FIELDS = ["storage", "defaultLevel", "defaultDuration"];
const VERBOSE = ["DEBUG", "TRACE"];

/**
 * The "Switches and levels" tab: storing on or off, the default level and the component levels, read
 * with getLoggingSettings; each list's first item is the configured value. Save, Reset to configuration
 * and Cancel are in the Logs page's footer (view/Logs.view.xml, controller/Logs.controller.ts), which
 * reads the component model "settingsUi" ({ loaded, dirty }) this controller keeps. Save and Reset ask
 * first, as the configuration app does before an activation. The form logic is in model/settingsForm.ts
 * and model/settingsTexts.ts.
 * @namespace admin.logs.controller
 */
export default class LoggingSettingsController extends Controller {

    private api: LogsApi | null = null;
    private translate: Translator = (key) => key;
    /** Set when the shell unloads the app: an answer that arrives later is dropped. */
    private exited = false;
    /** What the service last returned: Cancel shows it again. */
    private lastResult: SettingsResult | null = null;
    private savedSignature = "";
    /** The component names of the stored gateway log (gatewayLogComponents). */
    private storedComponents: string[] = [];
    private readonly ui = new JSONModel({ loaded: false, dirty: false });

    public onInit(): void {
        this.getView()!.setModel(new JSONModel({ loaded: false, busy: false, error: "", warning: "", environmentReported: true, payloadFileLoggingEnabled: false, components: [], texts: {}, state: {}, stateText: {}, fixed: {} }), "form");
        this.getOwnerComponent()!.setModel(this.ui, "settingsUi");
        void this.start();
    }

    public onExit(): void {
        this.exited = true;
    }

    private async start(): Promise<void> {
        const bundle = await (this.getOwnerComponent()!.getModel("i18n") as any).getResourceBundle();
        if (this.exited) return;
        this.translate = (key, args) => bundle.getText(key, args as any[]);
        this.api = new LogsApi(ODATA_BASE, (input: string, init?: any) => fetch(input, init), this.translate, Localization.getLanguageTag().toString());
        this.model().setProperty("/busy", true);
        const result = await this.api.getSettings();
        if (this.exited) return;
        this.model().setProperty("/busy", false);
        if (result.ok) this.showResult(result.body!);
        else this.model().setProperty("/error", result.error?.message ?? "");
        void this.loadComponents();
    }

    /** The names the stored log has, as suggestions; without them the field is plain free text and warns about nothing. */
    private async loadComponents(): Promise<void> {
        const result = await this.api!.logComponents();
        if (this.exited || !result.ok) return;
        this.storedComponents = Array.isArray(result.body?.value) ? result.body!.value : [];
        this.refreshTexts();
    }

    /** The stored log's component names and the configured ones, each once. */
    private knownComponents(): string[] {
        const configured = this.currentForm().configuration?.components?.map((c) => c.component) ?? [];
        return [...new Set([...this.storedComponents, ...configured])].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
    }

    private model(): JSONModel {
        return this.getView()!.getModel("form") as JSONModel;
    }

    private formatTime(iso: string): string {
        return formatToMinute(iso, Localization.getLanguageTag().toString(), Localization.getTimezone());
    }

    /** What the service now returns, as the form, with its texts, no field marked, and nothing to save. */
    private showResult(result: SettingsResult): void {
        this.lastResult = result;
        const form = formFromResult(result, new Date());
        const model = this.model();
        model.setData({ ...model.getData(), ...form, loaded: true, error: "", warning: result.warning || "",
            payloadFileLoggingEnabled: result.payloadFileLoggingEnabled === true });
        this.clearStates();
        this.refreshTexts();
        this.savedSignature = formSignature(this.currentForm());
        this.ui.setData({ loaded: true, dirty: false });
    }

    private currentForm(): SettingsForm {
        return this.model().getData() as SettingsForm;
    }

    private refreshTexts(): void {
        const model = this.model();
        const texts = describeForm(this.currentForm(), this.translate, (iso) => this.formatTime(iso), new Date());
        model.setProperty("/texts", texts);
        const known = this.knownComponents();
        model.setProperty("/knownComponents", known.map((name) => ({ name })));
        const rows = model.getProperty("/components") as (ComponentRow & { componentState?: string })[];
        const hints = componentHints(rows, known);
        rows.forEach((row, index) => {
            model.setProperty(`/components/${index}/configText`, texts.components[index].configText);
            model.setProperty(`/components/${index}/endsText`, texts.components[index].endsText);
            // A refusal (no name, a name twice) stays; a hint is a warning that never blocks saving.
            if (row.componentState === "Error") return;
            const hint = hints[index];
            model.setProperty(`/components/${index}/componentState`, hint ? "Warning" : "None");
            model.setProperty(`/components/${index}/componentStateText`, hint ? this.translate(hint.key, hint.args) : "");
        });
        this.ui.setProperty("/dirty", formSignature(this.currentForm()) !== this.savedSignature);
    }

    private clearStates(): void {
        const model = this.model();
        for (const field of FIELDS) {
            model.setProperty(`/state/${field}`, "None");
            model.setProperty(`/stateText/${field}`, "");
        }
        (model.getProperty("/components") as ComponentRow[]).forEach((_row, index) => {
            model.setProperty(`/components/${index}/componentState`, "None");
            model.setProperty(`/components/${index}/componentStateText`, "");
        });
    }

    public onFormChange(): void {
        this.refreshTexts();
    }

    public onAddComponent(): void {
        const model = this.model();
        const rows = model.getProperty("/components") as ComponentRow[];
        const row: ComponentRow = { component: "", level: "DEBUG", duration: "60", until: null, configLevel: null };
        model.setProperty("/components", [...rows, { ...row, componentState: "None", componentStateText: "" }]);
        this.refreshTexts();
    }

    public onRemoveComponent(event: Event): void {
        const path = (event.getSource() as any).getBindingContext("form").getPath() as string;
        const index = Number(path.split("/").pop());
        const rows = (this.model().getProperty("/components") as ComponentRow[]).filter((_row, i) => i !== index);
        this.model().setProperty("/components", rows);
        this.refreshTexts();
    }

    /** The footer's Save: checks the component rows, asks, then saves. A new row shows its configured level once read back. */
    public onSave(): void {
        this.clearStates();
        this.refreshTexts();   // a kept limit that has run out meanwhile now says so
        const form = this.currentForm();
        const problems = validateForm(form);
        if (problems.length) {
            for (const problem of problems) {
                this.model().setProperty(problem.path.replace(/component$/, "componentState"), "Error");
                this.model().setProperty(problem.path.replace(/component$/, "componentStateText"), this.translate(problem.key));
            }
            return;
        }
        const verbose = VERBOSE.includes(form.defaultLevel) || form.components.some((row) => VERBOSE.includes(row.level));
        const cleared = clearedByFixed(form);
        const question = [this.translate("confirmSaveSettings"),
            verbose ? this.translate("confirmVerbose") : "",
            cleared.length ? this.translate("confirmClearsFixed", [cleared.join(", ")]) : ""].filter((part) => part !== "").join("\n\n");
        this.confirm(question, () => this.apply(() => this.api!.setSettings(paramsFromForm(this.currentForm(), new Date()))));
    }

    /** The footer's Reset to configuration. */
    public onReset(): void {
        this.clearStates();
        this.confirm(this.translate("confirmResetSettings"), () => this.apply(() => this.api!.resetSettings()));
    }

    /** The footer's Cancel: the form as the service last returned it. */
    public onCancel(): void {
        if (this.lastResult) this.showResult(this.lastResult);
    }

    /** The decision pop-up of the configuration app's activation: OK goes on, Cancel leaves everything as it is. */
    private confirm(text: string, onOk: () => Promise<void>): void {
        MessageBox.confirm(text, {
            onClose: (action: unknown) => {
                if (action === MessageBox.Action.OK) void onOk();
            }
        });
    }

    /**
     * A refusal is shown at its field where it has one, otherwise above the form. A success shows what
     * the service now returns; a warning (the gateway could not be told now) is a message, not an error.
     */
    private async apply(call: () => Promise<ApiResult<SettingsResult>>): Promise<void> {
        const model = this.model();
        model.setProperty("/busy", true);
        model.setProperty("/error", "");
        model.setProperty("/warning", "");
        const result = await call();
        if (this.exited) return;
        model.setProperty("/busy", false);
        if (!result.ok) {
            const field = fieldOfErrorCode(result.error?.code);
            const message = result.error?.message ?? "";
            if (field) {
                model.setProperty(`/state/${field}`, "Error");
                model.setProperty(`/stateText/${field}`, message);
            } else {
                model.setProperty("/error", message);
            }
            return;
        }
        this.showResult(result.body!);
        if (!result.body!.warning) MessageToast.show(this.translate("settingsSaved"));
    }
}
