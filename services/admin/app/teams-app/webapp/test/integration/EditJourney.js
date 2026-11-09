sap.ui.define(["sap/ui/test/opaQunit", "admin/teams/test/integration/expectations"], function (opaTest, expectations) {
	"use strict";
	return { run: function () {
		var oFx = expectations.expect.fixtures;
		QUnit.module("Team edit (" + expectations.role + ")");
		opaTest("Editing Tokens per Week saves through the draft and shows as the effective limit", function (Given, When, Then) {
			Given.iStartMyApp();
			When.onTheListReport.onTable().iPressRow({ "Name": oFx.team.name });
			Then.onTheObjectPage.iSeeThisPage();
			When.onTheObjectPage.onHeader().iExecuteEdit();
			When.onTheObjectPage.onForm("Pool").iChangeField({ property: "tokensPerWeek" }, "9000");
			When.onTheObjectPage.onFooter().iExecuteSave();
			Then.onTheObjectPage.iSeeStoredValue("tokensPerWeek", 9000);
			Then.onTheObjectPage.iSeeStoredValue("effectiveTokensPerWeek", 9000);
			Then.onTheObjectPage.iSeeStoredValue("limitSourceTokensPerWeek", "team");
			Given.iTearDownMyApp();
		});
	} };
});
