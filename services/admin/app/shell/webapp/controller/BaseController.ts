import Controller from "sap/ui/core/mvc/Controller";
import View from "sap/ui/core/mvc/View";
import UIComponent from "sap/ui/core/UIComponent";
import AppComponent from "admin/shell/Component";
import Model from "sap/ui/model/Model";
import ResourceModel from "sap/ui/model/resource/ResourceModel";
import ResourceBundle from "sap/base/i18n/ResourceBundle";
import Router from "sap/ui/core/routing/Router";
import History from "sap/ui/core/routing/History";
import formatMessage from "sap/base/strings/formatMessage";

/**
 * @namespace admin.shell.controller
 */
export default abstract class BaseController extends Controller {
	/**
	 * Convenience method for accessing the component of the controller's view.
	 * @returns The component of the controller's view
	 */
	public getOwnerComponent(): AppComponent {
		return super.getOwnerComponent() as AppComponent;
	}

	/**
	 * Convenience method to get the components' router instance.
	 * @returns The router instance
	 */
	public getRouter(): Router {
		return UIComponent.getRouterFor(this);
	}

	/**
	 * Convenience method for getting the i18n resource bundle of the component.
	 * @returns The i18n resource bundle of the component
	 */
	public getResourceBundle(): ResourceBundle | Promise<ResourceBundle> {
		const oModel = this.getOwnerComponent().getModel("i18n") as ResourceModel;
		return oModel.getResourceBundle();
	}

	/**
	 * Resolves an i18n key against the component's resource bundle, filling `{0}`, `{1}` …
	 * placeholders from `args`. Synchronous: the bundle is already loaded by the time a user
	 * action or a data callback produces a message.
	 * @param sKey The i18n key
	 * @param [aArgs] Placeholder values
	 * @returns The translated text, or the key itself when the bundle has no entry
	 */
	public text(sKey: string, aArgs?: unknown[]): string {
		const oModel = this.getOwnerComponent()?.getModel("i18n") as ResourceModel | undefined;
		const sPattern = (oModel?.getProperty(sKey) as string | null | undefined) ?? sKey;
		return aArgs ? formatMessage(sPattern, aArgs) : sPattern;
	}

	/**
	 * The controller's view. UI5 connects a controller to its view before onInit, so every lifecycle
	 * hook and event handler has one; a call without it is a programming error and says so.
	 * @returns The view of this controller
	 */
	protected view(): View {
		const oView = this.getView();
		if (!oView) {
			throw new Error(`${this.getMetadata().getName()}: the controller is not connected to a view`);
		}
		return oView;
	}

	/**
	 * Convenience method for getting the view model by name in every controller of the application.
	 * @param [sName] The model name
	 * @returns The model instance, undefined when the view has no model of that name
	 */
	public getModel(sName?: string): Model | undefined {
		return this.view().getModel(sName);
	}

	/**
	 * Convenience method for setting the view model in every controller of the application.
	 * @param oModel The model instance
	 * @param [sName] The model name
	 * @returns The current base controller instance
	 */
	public setModel(oModel: Model, sName?: string): BaseController {
		this.view().setModel(oModel, sName);
		return this;
	}

	/**
	 * Convenience method for triggering the navigation to a specific target.
	 * @public
	 * @param sName Target name
	 * @param [oParameters] Navigation parameters
	 * @param [bReplace] Defines if the hash should be replaced (no browser history entry) or set (browser history entry)
	 */
	public navTo(sName: string, oParameters?: object, bReplace?: boolean): void {
		this.getRouter().navTo(sName, oParameters, undefined, bReplace);
	}

	/**
	 * Convenience event handler for navigating back.
	 * It there is a history entry we go one step back in the browser history
	 * If not, it will replace the current entry of the browser history with the main route.
	 */
	public onNavBack(): void {
		const sPreviousHash = History.getInstance().getPreviousHash();
		if (sPreviousHash !== undefined) {
			window.history.go(-1);
		} else {
			this.getRouter().navTo("main", {}, undefined, true);
		}
	}
}
