sap.ui.define(["sap/ui/test/opaQunit", "admin/teams/test/integration/expectations"], function (opaTest, expectations) {
	"use strict";
	return { run: function () {
		var oFx = expectations.expect.fixtures;
		QUnit.module("Team members in edit mode (" + expectations.role + ")");
		// Members are not part of the draft's Save: in edit mode the actions act at once on the saved
		// team, and the draft's member table follows (teams polish, item 5).
		opaTest("Remove and re-add the seeded member while the team is in edit mode; Set as Primary names team and member", function (Given, When, Then) {
			Given.iStartMyApp();
			When.onTheListReport.onTable().iPressRow({ "Name": oFx.team.name });
			Then.onTheObjectPage.iSeeThisPage();
			When.onTheObjectPage.onHeader().iExecuteEdit();
			Then.onTheObjectPage.iSeeStoredValue("IsActiveEntity", false);
			When.onTheObjectPage.iGoToSection("Members");
			When.onTheObjectPage.onTable({ property: "members", qualifier: "ForTeam" }).iSelectRows({ "E-Mail": oFx.team.memberEmail });
			When.onTheObjectPage.onTable({ property: "members", qualifier: "ForTeam" }).iExecuteAction("Remove");
			Then.onTheObjectPage.iSeeStoredValue("memberCount", 2);
			When.onTheObjectPage.onTable({ property: "members", qualifier: "ForTeam" }).iExecuteAction("Add Member");
			When.onTheObjectPage.iPickCandidate(oFx.team.memberEmail);
			Then.onTheObjectPage.iSeeStoredValue("memberCount", 3);
			Then.onTheObjectPage.onTable({ property: "members", qualifier: "ForTeam" }).iCheckRows({ "E-Mail": oFx.team.memberEmail }, 1);
			When.onTheObjectPage.onTable({ property: "members", qualifier: "ForTeam" }).iSelectRows({ "E-Mail": oFx.team.memberEmail });
			When.onTheObjectPage.onTable({ property: "members", qualifier: "ForTeam" }).iExecuteAction("Set as Primary");
			Then.onTheObjectPage.iSeeMessageToast(oFx.team.name + " is now the primary team of " + oFx.team.memberEmail);
			When.onTheObjectPage.onFooter().iExecuteSave();
			Then.onTheObjectPage.iSeeStoredValue("IsActiveEntity", true);
			Then.onTheObjectPage.iSeeStoredValue("memberCount", 3);
			Given.iTearDownMyApp();
		});
	} };
});
