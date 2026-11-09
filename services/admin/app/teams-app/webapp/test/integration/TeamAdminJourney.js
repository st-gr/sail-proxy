sap.ui.define(["sap/ui/test/opaQunit", "admin/teams/test/integration/expectations"], function (opaTest, expectations) {
	"use strict";
	return { run: function () {
		var oFx = expectations.expect.fixtures;
		QUnit.module("Teams for a team admin (" + expectations.role + ")");
		opaTest("the list shows the administered team and no Create", function (Given, When, Then) {
			Given.iStartMyApp();
			Then.onTheListReport.iSeeThisPage();
			Then.onTheListReport.onTable().iCheckRows({ "Name": oFx.team.name }, 1);
			Then.onTheListReport.iSeeNoVisibleButton("Create");
			Given.iTearDownMyApp();
		});
		opaTest("the team page offers member actions but no Edit or Delete, and Reset Quota is disabled", function (Given, When, Then) {
			Given.iStartMyApp();
			When.onTheListReport.onTable().iPressRow({ "Name": oFx.team.name });
			Then.onTheObjectPage.iSeeThisPage();
			Then.onTheObjectPage.iSeeDisabledButton("Reset Quota");
			Then.onTheObjectPage.iSeeNoVisibleButton("Edit");
			Then.onTheObjectPage.iSeeNoVisibleButton("Delete");
			Given.iTearDownMyApp();
		});
	} };
});
