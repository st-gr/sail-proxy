import Controller from "sap/ui/core/mvc/Controller";
import ComponentContainer from "sap/ui/core/ComponentContainer";

export default class AppController extends Controller {
    
    public onInit(): void {
        // Overview view is now loaded declaratively - no manual loading needed
        console.log("Usage Analytics App controller initialized");
    }
}