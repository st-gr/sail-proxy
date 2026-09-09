/* global QUnit */
sap.ui.define([
	"sap/ui/test/opaQunit",
	"admin/modellibrary/test/integration/expectations"
], function (opaTest, expectations) {
	"use strict";

	return {
		run: function () {
			var oLib = expectations.expect.library;
			var oFx = expectations.expect.fixtures.library;
			QUnit.module("Model library grid (" + expectations.role + ")");
			opaTest("The grid shows the role's entitled models", function (Given, When, Then) {
				// the standalone app page (its own bootstrap), relative to this test page
				Given.iStartMyAppInAFrame("../../index.html");
				// the admin sees every foundation model, the user only their catalog's members
				var iExpected = oLib.seesAllModels ? oFx.allIds : oFx.memberIds.length;
				Then.onTheLibrary.iSeeTheCount(iExpected);
				Then.onTheLibrary.iSeeCards(iExpected);
				Then.onTheLibrary.iSeeTheRefreshButton(oLib.canEditPrice);
				Then.iTeardownMyApp();
			});
		}
	};
});
