sap.ui.define(["sap/ui/test/opaQunit", "admin/connections/test/integration/expectations"], function (opaTest, expectations) {
	"use strict";
	return { run: function () {
		var oFx = expectations.expect.fixtures;
		QUnit.module("Connections list (" + expectations.role + ")");
		opaTest("The list shows the seeded connection with its provider type and no credential", function (Given, When, Then) {
			Given.iStartMyApp();
			Then.onTheListReport.iSeeThisPage();
			Then.onTheListReport.onTable().iCheckColumns({ "Title": { visible: true }, "Provider Type": { visible: true }, "Credential": { visible: true } });
			// No credential set: the cell shows the empty-value dash (app bundle emptyValue)
			Then.onTheListReport.onTable().iCheckRows({ "Title": oFx.connection.title, "Provider Type": oFx.connection.providerTypeText, "Credential": "\u2014" }, 1);
			Given.iTearDownMyApp();
		});
	} };
});
