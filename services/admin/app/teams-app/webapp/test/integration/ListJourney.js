sap.ui.define(["sap/ui/test/opaQunit", "admin/teams/test/integration/expectations"], function (opaTest, expectations) {
	"use strict";
	return { run: function () {
		var oFx = expectations.expect.fixtures;
		QUnit.module("Teams list (" + expectations.role + ")");
		opaTest("The list shows the seeded team with its member count", function (Given, When, Then) {
			Given.iStartMyApp();
			Then.onTheListReport.iSeeThisPage();
			Then.onTheListReport.onTable().iCheckColumns({ "Name": { visible: true }, "Members": { visible: true }, "Tokens This Month": { visible: true } });
			Then.onTheListReport.onTable().iCheckRows({ "Name": oFx.team.name, "Members": "3" }, 1);
			Given.iTearDownMyApp();
		});
	} };
});
