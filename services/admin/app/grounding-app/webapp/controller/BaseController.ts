import Controller from "sap/ui/core/mvc/Controller";
import JSONModel from "sap/ui/model/json/JSONModel";
import MessageBox from "sap/m/MessageBox";
import MessageToast from "sap/m/MessageToast";
import Router from "sap/ui/core/routing/Router";
import UIComponent from "sap/ui/core/UIComponent";
import Localization from "sap/base/i18n/Localization";
import { GroundingApi, ApiError } from "../model/api";
import { jobActionTextKey, type Translator } from "../model/jobs";
import { errorMessage } from "../model/errors";

/**
 * What every Grounding screen needs: the API, the texts, and the redirect to the
 * "not configured" page when file_search is unavailable.
 * @namespace admin.grounding.controller
 */
export default class BaseController extends Controller {

    /** The API as the last api() call left it; null while the app is unavailable. Lets a click handler stay synchronous. */
    protected readyApi: GroundingApi | null = null;

    protected router(): Router {
        return (this.getOwnerComponent() as UIComponent).getRouter();
    }

    protected appModel(): JSONModel {
        return this.getOwnerComponent()!.getModel("viewModel") as JSONModel;
    }

    protected async text(key: string, args?: any[]): Promise<string> {
        const bundle = await (this.getOwnerComponent()!.getModel("i18n") as any).getResourceBundle();
        return bundle.getText(key, args);
    }

    /** A synchronous translator over the loaded bundle, to inject into the pure model helpers (toJobRow). */
    protected async translator(): Promise<Translator> {
        const bundle = await (this.getOwnerComponent()!.getModel("i18n") as any).getResourceBundle();
        return (key, args) => bundle.getText(key, args as any[]);
    }

    /** The cockpit language as a BCP 47 tag, for the pure helpers' dates and numbers (they default to 'en-US'). */
    protected locale(): string {
        return Localization.getLanguageTag().toString();
    }

    /** The API, or null after sending the user to the "not configured" page. */
    protected async api(): Promise<GroundingApi | null> {
        const api = await (this.getOwnerComponent() as any).whenReady() as GroundingApi;
        if (this.appModel().getProperty("/available") !== true) {
            // Display the target directly: navTo does nothing when the hash already is #/unavailable.
            void this.router().getTargets()!.display("unavailable");
            this.readyApi = null;
            return null;
        }
        this.readyApi = api;
        return api;
    }

    /** A refusal in the cockpit's words when its code is known (errorMessage), else the server's message. */
    protected async showError(error: ApiError | null): Promise<void> {
        MessageBox.error(error ? await this.errorText(error) : await this.text("requestFailed"));
    }

    protected async errorText(error: ApiError): Promise<string> {
        return errorMessage(error, await this.translator(), this.locale());
    }

    /** A request that threw instead of returning a failure. */
    protected async showThrown(error: unknown): Promise<void> {
        MessageBox.error((error as Error)?.message || await this.text("requestFailed"));
    }

    /**
     * Cancel or retry a job, shared by the Jobs list and the job page. The gateway's refusal
     * (job_running, store_expired, nothing_to_retry) is shown in the cockpit's words; the toast names blobs for a
     * blob migration (`kind`) and files otherwise. `admin` acts on another owner's job through the admin routes.
     * True when it was done.
     */
    protected async jobAction(action: "cancel" | "retry", jobId: string, kind = "", admin = false): Promise<boolean> {
        const api = await this.api();
        if (!api) return false;
        const result = admin
            ? (action === "cancel" ? await api.adminCancelJob(jobId) : await api.adminRetryJob(jobId))
            : (action === "cancel" ? await api.cancelJob(jobId) : await api.retryJob(jobId));
        if (!result.ok) {
            this.showError(result.error);
            return false;
        }
        MessageToast.show(await this.text(jobActionTextKey(action, kind), action === "cancel" ? undefined : [Number(result.body?.retried) || 0]));
        return true;
    }
}
