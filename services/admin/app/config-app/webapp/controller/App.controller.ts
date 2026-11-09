import Controller from "sap/ui/core/mvc/Controller";
import type UIComponent from "sap/ui/core/UIComponent";

/**
 * @namespace admin.config.controller
 */
export default class AppController extends Controller {
    
    public onInit(): void {
        // Get the router and initialize
        const router = (this.getOwnerComponent() as UIComponent | undefined)?.getRouter();
        router?.initialize();
    }
}