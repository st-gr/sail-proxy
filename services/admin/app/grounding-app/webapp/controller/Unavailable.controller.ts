import JSONModel from "sap/ui/model/json/JSONModel";
import Target from "sap/ui/core/routing/Target";
import BaseController from "./BaseController";

/**
 * The one "not configured" page every Grounding screen redirects to. It says why.
 * @namespace admin.grounding.controller
 */
export default class UnavailableController extends BaseController {

    public onInit(): void {
        this.getView()!.setModel(new JSONModel({ reasonText: "" }), "view");
        this.router().getRoute("groundingUnavailable")!.attachPatternMatched(() => { void this.show(); }, this);
        (this.router().getTarget("unavailable") as Target).attachDisplay(() => { void this.show(); }, this);
    }

    private showing: Promise<void> | null = null;

    /** One run at a time: the route match and the target display both call this for the same navigation. */
    private show(): Promise<void> {
        if (!this.showing) {
            this.showing = this.render().finally(() => { this.showing = null; });
        }
        return this.showing;
    }

    private async render(): Promise<void> {
        await (this.getOwnerComponent() as any).whenReady();
        if (this.appModel().getProperty("/available") === true) {
            const router = this.router();
            const hash = router.getHashChanger().getHash();
            if (hash === "unavailable") {
                router.navTo("groundingStores", {}, undefined, true);
            } else {
                // The screen the user asked for is hidden behind this page; route the current hash again.
                router.parse(hash);
            }
            return;
        }
        const reason = this.appModel().getProperty("/reason") || "unreachable";
        (this.getView()!.getModel("view") as JSONModel).setProperty("/reasonText", await this.text(`unavailable_${reason}`));
    }

    public async onRetry(): Promise<void> {
        await (this.getOwnerComponent() as any).reload();
        // A show() that started before the reload may have rendered the old reason; let it finish, then render again.
        if (this.showing) await this.showing.catch(() => undefined);
        await this.show();
    }
}
