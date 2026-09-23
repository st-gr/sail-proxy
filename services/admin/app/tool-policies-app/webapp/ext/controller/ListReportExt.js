sap.ui.define([], function () {
	"use strict";

	// Two list reports in one Fiori Elements app: the policies list and the tool inventory. The
	// header actions move between them by ROUTE NAME (sap.fe.core.controllerextensions.Routing), and
	// each route's pattern must be the entity set it shows - a made-up pattern segment such as
	// "inventory" is resolved as a resource path and fails with
	// 'Invalid resource path "AdminService.inventory"'. Same shape as api-keys-app's second list.
	return {
		onOpenInventory: function () {
			this.routing.navigateToRoute("ToolInventoryList");
		},
		onOpenPolicies: function () {
			this.routing.navigateToRoute("ToolPoliciesList");
		}
	};
});
