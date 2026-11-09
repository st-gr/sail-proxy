sap.ui.define(["sap/ui/test/opaQunit", "admin/teams/test/integration/expectations"], function (opaTest, expectations) {
	"use strict";
	return { run: function () {
		var oFx = expectations.expect.fixtures;
		QUnit.module("Team members (" + expectations.role + ")");
		opaTest("Make the seeded member a team admin, then a member again; remove and re-add it", function (Given, When, Then) {
			Given.iStartMyApp();
			When.onTheListReport.onTable().iPressRow({ "Name": oFx.team.name });
			Then.onTheObjectPage.iSeeThisPage();
			When.onTheObjectPage.iGoToSection("Members");
			When.onTheObjectPage.onTable({ property: "members", qualifier: "ForTeam" }).iSelectRows({ "E-Mail": oFx.team.memberEmail });
			// the member stays selected through the action refreshes, so it is selected once and every action below acts on it
			When.onTheObjectPage.onTable({ property: "members", qualifier: "ForTeam" }).iExecuteAction("Make Team Admin");
			Then.onTheObjectPage.onTable({ property: "members", qualifier: "ForTeam" }).iCheckRows({ "E-Mail": oFx.team.memberEmail, "Role": "admin" }, 1);
			When.onTheObjectPage.onTable({ property: "members", qualifier: "ForTeam" }).iExecuteAction("Make Member");
			Then.onTheObjectPage.onTable({ property: "members", qualifier: "ForTeam" }).iCheckRows({ "E-Mail": oFx.team.memberEmail, "Role": "member" }, 1);
			When.onTheObjectPage.onTable({ property: "members", qualifier: "ForTeam" }).iExecuteAction("Remove");
			Then.onTheObjectPage.iSeeStoredValue("memberCount", 2);
			When.onTheObjectPage.onTable({ property: "members", qualifier: "ForTeam" }).iExecuteAction("Add Member");
			When.onTheObjectPage.iPickCandidate(oFx.team.memberEmail);
			Then.onTheObjectPage.iSeeStoredValue("memberCount", 3);
			Given.iTearDownMyApp();
		});
	} };
});
