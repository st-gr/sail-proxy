sap.ui.define(["sap/ui/test/opaQunit", "admin/connections/test/integration/expectations"], function (opaTest, expectations) {
	"use strict";
	// The seeded SAP AI Core connection (seed.js: an invented service key stored, never tested or activated).
	// No action dialog is opened here: OPA stalls on them.
	return { run: function () {
		var oSap = expectations.expect.fixtures.sapConnection;
		QUnit.module("SAP AI Core connection (" + expectations.role + ")");
		opaTest("The list shows the SAP AI Core connection inactive", function (Given, When, Then) {
			Given.iStartMyApp();
			Then.onTheListReport.iSeeThisPage();
			Then.onTheListReport.onTable().iCheckRows({ "Title": oSap.title, "Provider Type": oSap.providerTypeText, "Active": "No" }, 1);
			Given.iTearDownMyApp();
		});
		opaTest("Shows the tenant fields from the service key, the service-key actions and no Models section", function (Given, When, Then) {
			Given.iStartMyApp();
			When.onTheListReport.onTable().iPressRow({ "Title": oSap.title });
			Then.onTheObjectPage.iSeeThisPage();
			Then.onTheObjectPage.iSeeStoredValue("providerType", "sap-ai-core");
			Then.onTheObjectPage.iSeeStoredValue("isActive", false);
			Then.onTheObjectPage.iSeeHeaderAction("SetServiceKey");
			Then.onTheObjectPage.iSeeHeaderAction("Activate");
			Then.onTheObjectPage.iSeeNoHeaderAction("Deactivate");
			Then.onTheObjectPage.iSeeNoHeaderAction("SetCredential");
			Then.onTheObjectPage.iSeeNoHeaderAction("AddModel");
			When.onTheObjectPage.iGoToSection("Endpoint & Authentication");
			// Read after the section is shown: its fields join the page's $select when they are rendered
			Then.onTheObjectPage.iSeeStoredValue("endpoint", oSap.endpoint);
			Then.onTheObjectPage.iSeeStoredValue("region", oSap.region);
			Then.onTheObjectPage.iSeeStoredValue("resourceGroup", oSap.resourceGroup);
			Then.onTheObjectPage.iSeeStoredValue("productive", oSap.productive);
			Then.onTheObjectPage.iSeeEndpointField("endpoint");
			Then.onTheObjectPage.iSeeEndpointField("region");
			Then.onTheObjectPage.iSeeEndpointField("resourceGroup");
			Then.onTheObjectPage.iSeeEndpointField("productive");
			Then.onTheObjectPage.iSeeNoEndpointField("baseUrl");
			Then.onTheObjectPage.iSeeNoEndpointField("authMode");
			Then.onTheObjectPage.iSeeNoSection("models");
			Given.iTearDownMyApp();
		});
	} };
});
