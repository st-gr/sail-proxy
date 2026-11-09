/* global QUnit */
sap.ui.define([
	"sap/ui/test/opaQunit",
	"admin/app/test/integration/expectations"
], function (opaTest, expectations) {
	"use strict";

	return {
		run: function () {
			var oExpect = expectations.expect.apiKeys;
			var oNames = expectations.expect.fixtures;
			QUnit.module("API keys list (" + expectations.role + ")");
			opaTest("The list shows own rows, other users' rows only per role, and the lifecycle columns", function (Given, When, Then) {
				Given.iStartMyApp();
				Then.onTheListReport.iSeeThisPage();
				// keys are column labels (see UI.LineItem in annotations.cds)
				Then.onTheListReport.onTable().iCheckRows({ "Name": oNames.userActiveKey }, 1);
				Then.onTheListReport.onTable().iCheckRows({ "Name": oNames.otherUserKey }, oExpect.seesOtherUsersRows ? 1 : 0);
				Then.onTheListReport.onTable().iCheckColumns({ "Expires At": { visible: true }, "Never Expires": { visible: true } });
				Given.iTearDownMyApp();
			});
		}
	};
});
