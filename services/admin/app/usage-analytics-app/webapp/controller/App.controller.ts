import Controller from "sap/ui/core/mvc/Controller";
import ComponentContainer from "sap/ui/core/ComponentContainer";
import JSONModel from "sap/ui/model/json/JSONModel";
import IconTabBar from "sap/m/IconTabBar";
import Event from "sap/ui/base/Event";

export default class AppController extends Controller {
    
    public onInit(): void {
        // Overview view is now loaded declaratively - no manual loading needed
        console.log("Usage Analytics App controller initialized");
    }

    public onTabSelect(event: Event): void {
        const selectedKey = event.getParameter("key");
        
        // Update the selected tab in the view model
        const viewModel = this.getView()?.getModel("viewModel") as JSONModel;
        if (viewModel) {
            viewModel.setProperty("/selectedTab", selectedKey);
        }

        // For now, all tabs show the same Overview content
        // This can be expanded later to show different content per tab
        console.log(`Tab selected: ${selectedKey}`);
    }
}