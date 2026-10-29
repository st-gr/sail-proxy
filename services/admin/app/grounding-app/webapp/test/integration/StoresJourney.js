/* global QUnit */
sap.ui.define([
	"sap/ui/test/opaQunit",
	"admin/grounding/test/integration/expectations"
], function (opaTest, expectations) {
	"use strict";
	return {
		run: function () {
			var oFx = expectations.expect.fixtures.grounding;
			var sNew = "UI Fixture — journey store (" + expectations.role + ")";
			var sStructured = "UI Fixture — structured store (" + expectations.role + ")";
			QUnit.module("Vector stores (" + expectations.role + ")");

			opaTest("The list shows the user's own seeded store", function (Given, When, Then) {
				Given.iStartMyAppInAFrame("../app.html?sap-language=EN&sap-ui-animationMode=none");
				Then.onTheStores.iSeeTheStore(oFx.storeName);
				Then.iTeardownMyApp();
			});

			opaTest("A store's Details show its embedding model as Current, with no Re-embed", function (Given, When, Then) {
				Given.iStartMyAppInAFrame("../app.html?sap-language=EN&sap-ui-animationMode=none");
				When.onTheStores.iOpenTheStore(oFx.storeName);
				Then.onTheStores.iSeeTheStorePage(oFx.storeName);
				When.onTheStores.iOpenTheDetailsTab();
				Then.onTheStores.iSeeTheEmbeddingCurrent();
				Then.onTheStores.iDoNotSeeRereadFiles();
				Then.iTeardownMyApp();
			});

			opaTest("A store can be created, opened and deleted", function (Given, When, Then) {
				Given.iStartMyAppInAFrame("../app.html?sap-language=EN&sap-ui-animationMode=none");
				When.onTheStores.iPressCreate();
				When.onTheStores.iEnterTheNewName(sNew);
				When.onTheStores.iPressTheDialogButton("Create");
				Then.onTheStores.iSeeTheStore(sNew);
				When.onTheStores.iOpenTheStore(sNew);
				Then.onTheStores.iSeeTheStorePage(sNew);
				When.onTheStores.iPressDeleteStore();
				When.onTheStores.iPressTheDialogButton("OK");
				Then.onTheStores.iDoNotSeeTheStore(sNew);
				Then.iTeardownMyApp();
			});

			opaTest("A store created with Structure chunking shows it, and Change Chunking shows an estimate", function (Given, When, Then) {
				Given.iStartMyAppInAFrame("../app.html?sap-language=EN&sap-ui-animationMode=none");
				When.onTheStores.iPressCreate();
				When.onTheStores.iEnterTheNewName(sStructured);
				When.onTheStores.iChooseTheChunkingStrategy("structure", false);
				When.onTheStores.iPressTheDialogButton("Create");
				When.onTheStores.iOpenTheStore(sStructured);
				Then.onTheStores.iSeeTheStorePage(sStructured);
				When.onTheStores.iOpenTheDetailsTab();
				Then.onTheStores.iSeeTheChunking("Structure (");
				When.onTheStores.iPressChangeChunking();
				Then.onTheStores.iSeeTheVisionModes();
				When.onTheStores.iChooseTheChunkingStrategy("static", true);
				When.onTheStores.iPressTheDialogButton("Show Estimate");
				Then.onTheStores.iSeeTheChunkingEstimate();
				When.onTheStores.iPressTheDialogButton("Cancel");
				When.onTheStores.iPressDeleteStore();
				When.onTheStores.iPressTheDialogButton("OK");
				Then.onTheStores.iDoNotSeeTheStore(sStructured);
				Then.iTeardownMyApp();
			});
		}
	};
});
