import Controller from "sap/ui/core/mvc/Controller";
import JSONModel from "sap/ui/model/json/JSONModel";
import MessageBox from "sap/m/MessageBox";
import MessageToast from "sap/m/MessageToast";
import Localization from "sap/base/i18n/Localization";
import UIComponent from "sap/ui/core/UIComponent";
import type Table from "sap/m/Table";
import type Event from "sap/ui/base/Event";
import { PluginsApi, basePath, messagesOf, type ApiResult, type Translator } from "../model/api";
import { settleAction } from "../model/settleAction";
import { builtinRows, pageState, pluginRows, rowsForAction, selectionActions, withSelectedVersion, type PluginRow, type RowOptions } from "../model/pluginRows";

/**
 * The Plugins screen: the stored plugins with what the gateways report, the built-ins read-only, and
 * the upload. Everything a plugin's package supplies stays in the view model and reaches the controls
 * through bindings, so a "{" in it is text. MessageBox and MessageToast set their message as text too.
 * @namespace admin.plugins.controller
 */
export default class PluginsController extends Controller {

    private apiPromise: Promise<PluginsApi> | null = null;
    private file: File | null = null;
    /** The last answer of the list: changing the gateway instance needs no new request. */
    private lastResponse: unknown = null;

    public onInit(): void {
        this.getView()!.setModel(new JSONModel({
            loaded: false, busy: false, loadError: "", rows: [], builtins: [], instance: "", instanceOptions: [], showInstances: false,
            settingOff: false, canUpload: false, statusUnavailable: false, notResponding: false, unpackDisabledReason: "", fileName: "", hasFile: false,
            selection: { canEnable: false, enableText: "", canDisable: false, canRemove: false, canAddHooks: false }
        }), "view");
        (this.getOwnerComponent() as UIComponent).getRouter().getRoute("pluginsList")!.attachPatternMatched(() => void this.load());
    }

    private viewModel(): JSONModel {
        return this.getView()!.getModel("view") as JSONModel;
    }

    private async translator(): Promise<Translator> {
        const bundle = await (this.getOwnerComponent()!.getModel("i18n") as any).getResourceBundle();
        return (key, args) => bundle.getText(key, args as any[]);
    }

    /** whoami tells Docker from local development; without an answer the local path is the guess, and the list call reports the failure. */
    private api(): Promise<PluginsApi> {
        this.apiPromise ??= (async () => {
            let deployTarget = "development";
            try {
                const response = await fetch("/odata/v4/admin/whoami", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Accept: "application/json" },
                    body: "{}",
                    credentials: "include"
                });
                if (response.ok) deployTarget = (await response.json()).deployTarget || deployTarget;
            } catch (error) {
                // The list call below tells the user what they need to know.
            }
            return new PluginsApi(basePath(deployTarget), (input: string, init?: any) => fetch(input, init), await this.translator());
        })();
        return this.apiPromise;
    }

    private async rowOptions(): Promise<RowOptions> {
        return { t: await this.translator(), language: Localization.getLanguageTag().toString(), locale: Localization.getLanguageTag().toString() };
    }

    private async load(): Promise<void> {
        const model = this.viewModel();
        model.setProperty("/busy", true);
        const result = await (await this.api()).list();
        model.setProperty("/busy", false);
        model.setProperty("/loadError", result.ok ? "" : result.error?.message ?? "");
        if (result.ok) {
            this.lastResponse = result.body;
            await this.render();
        }
    }

    /** The answer on screen, for the chosen gateway instance. An instance that has gone falls back to all of them. */
    private async render(): Promise<void> {
        const model = this.viewModel();
        const options = await this.rowOptions();
        const known = pageState(this.lastResponse, "", options).instanceOptions.map((option) => option.key);
        const instance = known.includes(model.getProperty("/instance")) ? model.getProperty("/instance") as string : "";
        model.setProperty("/instance", instance);
        const selected = this.selectedRows().map((row) => row.id);
        model.setProperty("/rows", pluginRows(this.lastResponse, instance, options));
        this.reselect(selected);
        model.setProperty("/selection", selectionActions(this.selectedRows(), options.t));
        model.setProperty("/builtins", builtinRows(this.lastResponse, instance, options));
        const state = pageState(this.lastResponse, instance, options);
        for (const [key, value] of Object.entries(state)) model.setProperty(`/${key}`, value);
        model.setProperty("/loaded", true);
    }

    private rowOf(event: Event): PluginRow & { path: string } {
        const context = (event.getSource() as any).getBindingContext("view");
        return { ...context.getObject(), path: context.getPath() };
    }

    public onRefresh(): void {
        void this.load();
    }

    public onInstanceChange(): void {
        void this.render();
    }

    public onVersionChange(event: Event): void {
        const row = this.rowOf(event);
        const version = (event.getSource() as any).getSelectedKey() as string;
        const { path, ...plain } = row;
        this.viewModel().setProperty(path, withSelectedVersion(plain as PluginRow, version, this.viewModel().getProperty("/canUpload") === true));
        void this.updateSelectionActions();
    }

    public onSelectionChange(): void {
        void this.updateSelectionActions();
    }

    private table(): Table {
        return this.byId("pluginsTable") as Table;
    }

    private selectedRows(): PluginRow[] {
        return this.table().getSelectedItems().map((item) => item.getBindingContext("view")!.getObject() as PluginRow);
    }

    private async updateSelectionActions(): Promise<void> {
        this.viewModel().setProperty("/selection", selectionActions(this.selectedRows(), await this.translator()));
    }

    /** The rows are rebuilt on every answer, so the selection follows the plugin's id rather than its position. */
    private reselect(ids: string[]): void {
        const table = this.table();
        table.removeSelections(true);
        table.getItems().forEach((item) => {
            const row = item.getBindingContext("view")?.getObject() as PluginRow | undefined;
            if (row && ids.includes(row.id)) (item as any).setSelected(true);
        });
    }

    public async onEnable(): Promise<void> {
        const { fitting, skipped } = rowsForAction(this.selectedRows(), "canEnable");
        const api = await this.api();
        await this.onEachRow(fitting, skipped, (row) => api.enable(row.id, row.selectedVersion), (row) => this.text("enabledMessage", [row.id, row.selectedVersion]));
    }

    public async onDisable(): Promise<void> {
        const { fitting, skipped } = rowsForAction(this.selectedRows(), "canDisable");
        const questions = await Promise.all(fitting.map((row) => this.text("disableConfirm", [row.id])));
        if (!await this.confirm(await this.withSkipped(questions, skipped), await this.text("disableAction"))) return;
        const api = await this.api();
        await this.onEachRow(fitting, skipped, (row) => api.disable(row.id), (row) => this.text("disabledMessage", [row.id]));
    }

    public async onRemove(): Promise<void> {
        const { fitting, skipped } = rowsForAction(this.selectedRows(), "canRemove");
        const questions = await Promise.all(fitting.map((row) => this.text("removeConfirm", [row.id, row.selectedVersion])));
        if (!await this.confirm(await this.withSkipped(questions, skipped), await this.text("removeAction"))) return;
        const api = await this.api();
        await this.onEachRow(fitting, skipped, (row) => api.removeVersion(row.id, row.selectedVersion), (row) => this.text("removedMessage", [row.id, row.selectedVersion]));
    }

    /** The lines, and a last one naming the selected rows the action leaves as they are. */
    private async withSkipped(lines: string[], skipped: PluginRow[]): Promise<string> {
        const note = skipped.length ? [await this.text("skippedMessage", [skipped.map((row) => row.id).join(", ")])] : [];
        return [...lines, ...note].join("\n\n");
    }

    /**
     * Runs an action for each row it fits, one after the other. A refusal does not stop the rest: every
     * row is tried, and the message names what each came to and which selected rows were left out.
     */
    private async onEachRow(rows: PluginRow[], skipped: PluginRow[], call: (row: PluginRow) => Promise<ApiResult>, success: (row: PluginRow) => Promise<string>): Promise<void> {
        const done: string[] = [];
        const warnings: string[] = [];
        const refused: string[] = [];
        for (const row of rows) {
            const result = await call(row);
            if (result.ok) {
                done.push(await success(row));
                warnings.push(...messagesOf(result.body));
            } else {
                const reason = result.error?.message ?? await this.text("requestFailed");
                refused.push(rows.length > 1 ? `${row.id}: ${reason}` : reason);
            }
        }
        const summary = await this.withSkipped([...refused, ...done, ...warnings], skipped);
        // As in settleAction: a refusal at once, a success only once the list shows it.
        if (refused.length) {
            MessageBox.error(summary);
            await this.load();
            return;
        }
        await this.load();
        if (warnings.length) MessageBox.warning(summary);
        else if (done.length) MessageToast.show(summary);
    }

    /** One configuration with the hooks of every selected plugin that has some; it is not active, and the message says where to activate it. */
    public async onAddHooks(): Promise<void> {
        const { fitting, skipped } = rowsForAction(this.selectedRows(), "canAddHooks");
        if (fitting.length === 0) return;
        const result = await (await this.api()).addSuggestedHooks(fitting.map((row) => row.id));
        const name = String(result.body?.name ?? "");
        await this.afterAction(result, await this.withSkipped([await this.text("hooksAddedMessage", [name])], skipped), true);
    }

    public onFileChosen(event: Event): void {
        const files = (event as any).getParameter("files") as FileList | undefined;
        this.chooseFile(files && files.length ? files[0] : null);
    }

    public async onWrongFileType(): Promise<void> {
        this.chooseFile(null);
        MessageBox.error(await this.text("uploadWrongType"));
    }

    private chooseFile(file: File | null): void {
        this.file = file;
        this.viewModel().setProperty("/hasFile", file !== null);
    }

    public async onUpload(): Promise<void> {
        if (!this.file) return;
        const result = await (await this.api()).upload(this.file);
        if (result.ok) {
            this.chooseFile(null);
            this.viewModel().setProperty("/fileName", "");
        }
        const key = result.body?.unchanged === true ? "uploadUnchangedMessage" : "uploadedMessage";
        await this.afterAction(result, await this.text(key, [String(result.body?.id ?? ""), String(result.body?.version ?? "")]));
    }

    /** A refusal shows the server's message at once; a success its message and any warnings, after the list is read again. */
    private async afterAction(result: ApiResult, success: string, alwaysDialog = false): Promise<void> {
        await settleAction(result, success, {
            reload: () => this.load(),
            error: (message) => MessageBox.error(message),
            warning: (message) => MessageBox.warning(message),
            success: (message, dialog) => (dialog ? MessageBox.success(message) : MessageToast.show(message))
        }, await this.text("requestFailed"), alwaysDialog);
    }

    private async text(key: string, args?: string[]): Promise<string> {
        return (await this.translator())(key, args);
    }

    private confirm(message: string, action: string): Promise<boolean> {
        return new Promise((resolve) => {
            MessageBox.confirm(message, {
                actions: [action, MessageBox.Action.CANCEL],
                emphasizedAction: action,
                onClose: (choice: unknown) => resolve(choice === action)
            });
        });
    }
}
