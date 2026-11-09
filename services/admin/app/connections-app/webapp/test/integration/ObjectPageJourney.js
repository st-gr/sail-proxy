sap.ui.define(["sap/ui/test/opaQunit", "admin/connections/test/integration/expectations"], function (opaTest, expectations) {
	"use strict";
	return { run: function () {
		var oFx = expectations.expect.fixtures;
		QUnit.module("Connection object page (" + expectations.role + ")");
		opaTest("Shows the general and endpoint sections for the provider type", function (Given, When, Then) {
			Given.iStartMyApp();
			When.onTheListReport.onTable().iPressRow({ "Title": oFx.connection.title });
			Then.onTheObjectPage.iSeeThisPage();
			Then.onTheObjectPage.iSeeStoredValue("name", oFx.connection.name);
			Then.onTheObjectPage.onForm("General").iCheckField({ property: "title" }, oFx.connection.title);
			Then.onTheObjectPage.onForm("General").iCheckField({ property: "providerType" }, "OpenAI");
			When.onTheObjectPage.iGoToSection("Endpoint & Authentication");
			Then.onTheObjectPage.iSeeEndpointField("baseUrl");
			Then.onTheObjectPage.iSeeNoEndpointField("endpoint");
			Then.onTheObjectPage.iSeeNoEndpointField("tenantId");
			Then.onTheObjectPage.iSeeNoEndpointField("region");
			Then.onTheObjectPage.iSeeNoEndpointField("resourceGroup");
			Given.iTearDownMyApp();
		});
		opaTest("Shows the fixture model in the Models section, unpriced", function (Given, When, Then) {
			Given.iStartMyApp();
			When.onTheListReport.onTable().iPressRow({ "Title": oFx.connection.title });
			Then.onTheObjectPage.iSeeThisPage();
			When.onTheObjectPage.iGoToSection("Models");
			Then.onTheObjectPage.onTable({ property: "models", qualifier: "ForConnection" }).iCheckRows({ "Upstream Model": oFx.connection.model, "Priced": "No" }, 1);
			Given.iTearDownMyApp();
		});
	} };
});
