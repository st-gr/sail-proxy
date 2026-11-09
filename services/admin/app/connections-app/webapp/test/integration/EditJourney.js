sap.ui.define(["sap/ui/test/opaQunit", "admin/connections/test/integration/expectations"], function (opaTest, expectations) {
	"use strict";
	return { run: function () {
		var oFx = expectations.expect.fixtures;
		var sEdited = oFx.connection.title + " (edited)";
		QUnit.module("Connection edit (" + expectations.role + ")");
		opaTest("Editing the title saves through the draft and shows in the header; the title is restored", function (Given, When, Then) {
			Given.iStartMyApp();
			When.onTheListReport.onTable().iPressRow({ "Title": oFx.connection.title });
			Then.onTheObjectPage.iSeeThisPage();
			When.onTheObjectPage.onHeader().iExecuteEdit();
			When.onTheObjectPage.onForm("General").iChangeField({ property: "title" }, sEdited);
			When.onTheObjectPage.onFooter().iExecuteSave();
			Then.onTheObjectPage.iSeeStoredValue("title", sEdited);
			Then.onTheObjectPage.onHeader().iCheckTitle(sEdited);
			// restore the fixture for the journeys that follow
			When.onTheObjectPage.onHeader().iExecuteEdit();
			When.onTheObjectPage.onForm("General").iChangeField({ property: "title" }, oFx.connection.title);
			When.onTheObjectPage.onFooter().iExecuteSave();
			Then.onTheObjectPage.iSeeStoredValue("title", oFx.connection.title);
			Given.iTearDownMyApp();
		});
	} };
});
