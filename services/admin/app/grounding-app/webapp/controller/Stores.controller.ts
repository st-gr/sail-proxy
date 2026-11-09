import JSONModel from "sap/ui/model/json/JSONModel";
import Dialog from "sap/m/Dialog";
import Button from "sap/m/Button";
import Input from "sap/m/Input";
import Label from "sap/m/Label";
import VBox from "sap/m/VBox";
import Title from "sap/m/Title";
import MessageBox from "sap/m/MessageBox";
import MessageToast from "sap/m/MessageToast";
import { ButtonType, InputType } from "sap/m/library";
import BaseController from "./BaseController";
import { toStoreRow } from "../model/rows";
import { storeNameProblem, parseExpiryDays } from "../model/validation";
import { ChunkingFlow, emptyChunking } from "./chunkingFlow";
import { chunkingFields } from "./chunkingDialogs";

/**
 * My vector stores: list, create (with the store's chunking setting), open.
 * @namespace admin.grounding.controller
 */
export default class StoresController extends BaseController {

    private chunking!: ChunkingFlow;

    public onInit(): void {
        this.getView()!.setModel(new JSONModel({ stores: [], busy: false, chunking: emptyChunking() }), "view");
        const view = (): JSONModel => this.getView()!.getModel("view") as JSONModel;
        this.chunking = new ChunkingFlow({
            getProperty: (path) => view().getProperty(path),
            setProperty: (path, value) => { view().setProperty(path, value); },
            api: () => this.api(),
            translator: () => this.translator(),
            locale: () => this.locale()
        });
        this.router().getRoute("groundingStores")!.attachPatternMatched(() => { void this.load(); }, this);
    }

    public async load(): Promise<void> {
        const api = await this.api();
        if (!api) return;
        const view = this.getView()!.getModel("view") as JSONModel;
        view.setProperty("/busy", true);
        const result = await api.listStores();
        view.setProperty("/busy", false);
        if (!result.ok) {
            this.showError(result.error);
            return;
        }
        const t = await this.translator();
        const locale = this.locale();
        view.setProperty("/stores", (result.body || []).map((store: any) => toStoreRow(store, t, locale)));
    }

    public onRefresh(): void {
        void this.load();
    }

    public onOpen(event: any): void {
        const row = event.getSource().getBindingContext("view").getObject();
        this.router().navTo("groundingStoreDetail", { storeId: row.id });
    }

    public async onCreate(): Promise<void> {
        const name = new Input({ id: this.createId("storeNameInput"), maxLength: 256, placeholder: await this.text("storeNamePlaceholder") });
        const days = new Input({ type: InputType.Text, placeholder: "1 - 365" });
        // The chunking fields start from the installation default.
        await this.chunking.prepareCreate();
        const create = new Button({
            text: await this.text("create"),
            type: ButtonType.Emphasized,
            press: async () => {
                const storeName = name.getValue().trim();
                if (storeNameProblem(storeName)) {
                    MessageBox.error(await this.text("nameRequired"));
                    return;
                }
                const expiry = parseExpiryDays(days.getValue());
                if (!expiry.ok) {
                    MessageBox.error(await this.text("expiryInvalid"));
                    return;
                }
                const expiresDays = expiry.days ?? undefined;
                // A problem is shown in the dialog, next to the fields.
                const chunking = await this.chunking.setting();
                if (!chunking) return;
                // Disabled before the first await, so a second press cannot start a second create.
                create.setEnabled(false);
                let closed = false;
                try {
                    const api = await this.api();
                    if (!api) return;
                    const result = await api.createStore(storeName, expiresDays, chunking);
                    if (!result.ok) {
                        this.showError(result.error);
                        return;
                    }
                    closed = true;
                    dialog.close();
                    MessageToast.show(await this.text("storeCreated"));
                    void this.load();
                } catch (error) {
                    this.showThrown(error);
                } finally {
                    // Also when a request throws: the dialog must stay usable.
                    if (!closed) create.setEnabled(true);
                }
            }
        });
        const dialog = new Dialog({
            title: await this.text("createStore"),
            contentWidth: "28rem",
            content: [
                new VBox({
                    items: [
                        new Label({ text: await this.text("storeName"), labelFor: name }), name,
                        new Label({ text: await this.text("expiryDays"), labelFor: days }), days,
                        new Title({ text: await this.text("detailChunking"), level: "H3" }).addStyleClass("sapUiSmallMarginTop"),
                        await chunkingFields((key, args) => this.text(key, args), (local) => this.createId(local) as string, this.chunking)
                    ]
                }).addStyleClass("sapUiSmallMargin")
            ],
            beginButton: create,
            endButton: new Button({ text: await this.text("cancel"), press: () => dialog.close() }),
            afterClose: () => dialog.destroy()
        });
        this.getView()!.addDependent(dialog);
        dialog.open();
    }
}
