/* global QUnit */
sap.ui.define([
	"sap/ui/test/opaQunit",
	"admin/app/test/integration/expectations"
], function (opaTest, expectations) {
	"use strict";

	return {
		run: function () {
			var oFx = expectations.expect.fixtures;
			QUnit.module("API key team (" + expectations.role + ")");
			opaTest("A key shows its effective team and Change Team offers the owner's teams", function (Given, When, Then) {
				Given.iStartMyApp();
				When.onTheListReport.onTable().iPressRow({ "Name": oFx.userNeverExpiresKey });
				Then.onTheObjectPage.iSeeThisPage();
				// The owner (user@test.com) is a member of the fixture team, which is also the primary one.
				Then.onTheObjectPage.onForm("Key Information").iCheckField({ property: "effectiveTeamName" }, oFx.team.name);
				When.onTheObjectPage.onHeader().iExecuteAction("Change Team");
				Then.onTheObjectPage.iSeeChangeTeamOffering(oFx.team.name);
				When.onTheObjectPage.iCloseTheOpenDialog();
				Given.iTearDownMyApp();
			});
		}
	};
});
