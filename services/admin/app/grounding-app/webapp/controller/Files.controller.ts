import JSONModel from "sap/ui/model/json/JSONModel";
import MessageBox from "sap/m/MessageBox";
import MessageToast from "sap/m/MessageToast";
import BaseController from "./BaseController";
import { toFileRows } from "../model/rows";
import { formatBytes } from "../model/format";
import { uploadProblem } from "../model/upload";

/**
 * My uploaded files: upload, see where each is attached, download, delete.
 * @namespace admin.grounding.controller
 */
export default class FilesController extends BaseController {

    public onInit(): void {
        this.getView()!.setModel(new JSONModel({ files: [], busy: false, storageText: "" }), "view");
        this.router().getRoute("groundingFiles")!.attachPatternMatched(() => { void this.load(); }, this);
    }

    private view(): JSONModel {
        return this.getView()!.getModel("view") as JSONModel;
    }

    public async load(): Promise<void> {
        const api = await this.api();
        if (!api) return;
        this.view().setProperty("/busy", true);
        const [files, storage] = await Promise.all([api.listFiles(), api.storage()]);
        // The header line is extra: without it the list still shows.
        this.view().setProperty("/storageText", storage.ok ? await this.text("storageSummary", [
            (Number(storage.body?.file_count) || 0).toLocaleString(this.locale()),
            formatBytes(storage.body?.logical_bytes, this.locale())
        ]) : "");
        if (!files.ok) {
            this.view().setProperty("/busy", false);
            this.showError(files.error);
            return;
        }
        const attachments = await api.fileAttachments((files.body || []).map((file) => file.id));
        this.view().setProperty("/busy", false);
        if (!attachments.ok) {
            this.showError(attachments.error);
            return;
        }
        this.view().setProperty("/files", toFileRows(files.body || [], attachments.body || {}, this.locale()));
    }

    public onRefresh(): void {
        void this.load();
    }

    public onUploadChange(event: any): void {
        const files = Array.from((event.getParameter("files") || []) as ArrayLike<File>);
        event.getSource().clear();
        if (files.length > 0) void this.uploadFiles(files);
    }

    /** Uploads the files one after the other. Stops at the first failure and says which file it was. */
    public async uploadFiles(files: File[]): Promise<void> {
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
        this.view().setProperty("/busy", true);
        let uploaded = 0;
        for (const file of files) {
            const result = await api.uploadFile(file, file.name);
            if (!result.ok) {
                this.view().setProperty("/busy", false);
                MessageBox.error(`${file.name}: ${result.error ? await this.errorText(result.error) : ""}`);
                await this.load();
                return;
            }
            uploaded++;
        }
        this.view().setProperty("/busy", false);
        MessageToast.show(await this.text("filesUploaded", [uploaded]));
        await this.load();
    }

    public onDownload(event: any): void {
        const row = event.getSource().getBindingContext("view").getObject();
        // No await before window.open: the click's user gesture must still be active, or popup blockers refuse it.
        if (!this.readyApi) return;
        // A plain navigation: the browser saves the response under the name the gateway sends.
        window.open(this.readyApi.downloadUrl(row.id), "_blank");
    }

    public async onDelete(event: any): Promise<void> {
        const row = event.getSource().getBindingContext("view").getObject();
        const attached = row.storeCount > 0;
        const question = attached
            ? await this.text("confirmDeleteAttachedFile", [row.filename, row.storeCount])
            : await this.text("confirmDeleteFile", [row.filename]);
        MessageBox.confirm(question, {
            onClose: async (action: string) => {
                if (action !== MessageBox.Action.OK) return;
                const api = await this.api();
                if (!api) return;
                const result = await api.deleteFile(row.id, attached);
                if (!result.ok) {
                    this.showError(result.error);
                    return;
                }
                MessageToast.show(await this.text("fileDeleted"));
                await this.load();
            }
        });
    }
}
