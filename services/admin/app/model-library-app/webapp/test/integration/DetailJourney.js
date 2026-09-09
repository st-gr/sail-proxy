/* global QUnit */
sap.ui.define([
	"sap/ui/test/opaQunit",
	"admin/modellibrary/test/integration/expectations"
], function (opaTest, expectations) {
	"use strict";

	return {
		run: function () {
			var oLib = expectations.expect.library;
			QUnit.module("Model detail (" + expectations.role + ")");
			opaTest("The detail page shows cost operands, configuration and role-gated actions", function (Given, When, Then) {
				Given.iStartMyAppInAFrame("../../index.html");
				When.onTheLibrary.iPressTheFirstCard();
				Then.onTheDetail.iSeeTheObjectPage();
				Then.onTheDetail.iSeeCostRowsWithOperands();
				Then.onTheDetail.iSeeTheConfigurationSection();
				Then.onTheDetail.iSeeAdminActions(oLib.canEditPrice);
				Then.iTeardownMyApp();
			});
		}
	};
});
