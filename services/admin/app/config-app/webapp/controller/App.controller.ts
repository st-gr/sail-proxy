import Controller from "sap/ui/core/mvc/Controller";

/**
 * @namespace admin.config.controller
 */
export default class AppController extends Controller {
    
    public onInit(): void {
        // Get the router and initialize
        const router = this.getOwnerComponent()?.getRouter();
        router?.initialize();
    }
}