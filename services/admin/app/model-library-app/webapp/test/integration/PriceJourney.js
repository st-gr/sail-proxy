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
			QUnit.module("Manual price (" + expectations.role + ")");
			// Synthetic prices, and the same journey reverts them through revertToSapPrice:
			// the journeys never leave a manual price behind and never deploy anything.
			opaTest("Manual price round trip", function (Given, When, Then) {
				Given.iStartMyAppInAFrame("../../index.html#/model/" + encodeURIComponent(oFx.memberIds[0]));
				Then.onTheDetail.iSeeTheObjectPage();
				if (oLib.canEditPrice) {
					When.onTheDetail.iPressEditPrice();
					When.onTheDetail.iEnterPrices("0.000001", "0.000002", "0.00006", "0.00003", "0.00004");
					When.onTheDetail.iSavePrice();
					Then.onTheDetail.iSeeManualPrice(true);
					Then.onTheDetail.iSeeCostRow("Image Output Cost Factor");
					Then.onTheDetail.iSeeCostRow("Audio Output Cost Factor");
					When.onTheDetail.iPressRevert();
					Then.onTheDetail.iSeeManualPrice(false);
				} else {
					Then.onTheDetail.iSeeAdminActions(false);
				}
				Then.iTeardownMyApp();
			});
		}
	};
});
