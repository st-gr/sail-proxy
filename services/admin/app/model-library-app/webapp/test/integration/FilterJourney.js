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
			QUnit.module("Model library filters (" + expectations.role + ")");
			opaTest("Filters narrow the grid; leaderboard and chart render", function (Given, When, Then) {
				Given.iStartMyAppInAFrame("../../index.html");
				var iAll = oLib.seesAllModels ? oFx.allIds : oFx.memberIds.length;
				Then.onTheLibrary.iSeeCards(iAll);
				// the seed gives the user's two members different provisioning values, so the
				// hosted filter narrows the grid for both roles
				When.onTheLibrary.iTickProvisioning("provHosted");
				Then.onTheLibrary.iSeeFewerCardsThan(iAll);
				When.onTheLibrary.iTickProvisioning("provHosted"); // untick
				Then.onTheLibrary.iSeeCards(iAll);
				if (oLib.seesAllModels) {
					// only the admin sees enough models for a leaderboard and a chart
					When.onTheLibrary.iSwitchMode("leaderboard");
					Then.onTheLibrary.iSeeTheLeaderboardWithScores();
					When.onTheLibrary.iSwitchMode("chart");
					Then.onTheLibrary.iSeeTheChart();
				}
				Then.iTeardownMyApp();
			});
		}
	};
});
