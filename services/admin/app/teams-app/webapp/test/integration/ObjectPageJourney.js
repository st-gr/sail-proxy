sap.ui.define(["sap/ui/test/opaQunit", "admin/teams/test/integration/expectations"], function (opaTest, expectations) {
	"use strict";
	return { run: function () {
		var oFx = expectations.expect.fixtures;
		QUnit.module("Team object page (" + expectations.role + ")");
		opaTest("Shows the pool, the entitlement fields, the usage charts and the members", function (Given, When, Then) {
			Given.iStartMyApp();
			When.onTheListReport.onTable().iPressRow({ "Name": oFx.team.name });
			Then.onTheObjectPage.iSeeThisPage();
			Then.onTheObjectPage.onForm("Pool").iCheckField("Tokens per Day");
			Then.onTheObjectPage.iSeeStoredValue("tokensPerDay", oFx.team.tokensPerDay);
			Then.onTheObjectPage.onForm("Pool").iCheckField({ property: "tokensPerDayDefaultText" }, "unlimited");
			Then.onTheObjectPage.onForm("Entitlement").iCheckField("Pool Profile");
			Then.onTheObjectPage.onForm("Entitlement").iCheckField("Member Profile");
			Then.onTheObjectPage.onForm("Entitlement").iCheckField("Entitlement Catalog");
			Then.onTheObjectPage.onForm("Entitlement").iCheckField("Tool Policy");
			Then.onTheObjectPage.onForm("Usage").iCheckField("Tokens Today");
			// the charts section sits below the fold: scroll it into view so ObjectPageLayout renders it
			When.onTheObjectPage.iGoToSection("Usage charts");
			Then.onTheObjectPage.iSeeBulletCharts();
			When.onTheObjectPage.iGoToSection("Members");
			Then.onTheObjectPage.onTable({ property: "members", qualifier: "ForTeam" }).iCheckRows({ "E-Mail": oFx.team.memberEmail, "Role": "member" }, 1);
			Then.onTheObjectPage.onTable({ property: "members", qualifier: "ForTeam" }).iCheckRows({ "E-Mail": expectations.email, "Role": "admin" }, 1);
			Given.iTearDownMyApp();
		});
	} };
});
