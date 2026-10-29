/* global QUnit */
sap.ui.define([
	"sap/ui/test/opaQunit",
	"admin/grounding/test/integration/expectations"
], function (opaTest, expectations) {
	"use strict";
	return {
		run: function () {
			var oFx = expectations.expect.fixtures.grounding;
			// The "ui-fixture-" prefix makes seed.js purge these files before the next run.
			var aFiles = [
				{ name: "ui-fixture-puffins.txt", content: "Island ledger. At dawn the lighthouse warden on Skerrymore counted forty-two nesting puffins on the western cliffs." },
				{ name: "ui-fixture-barley.txt", content: "Kitchen notes. Simmer the pearl barley with thyme, leeks and carrots for twenty minutes, then season." }
			];
			QUnit.module("Jobs and test retrieval (" + expectations.role + ")");

			opaTest("Two files uploaded together become one job that completes and is listed on the Jobs screen", function (Given, When, Then) {
				Given.iStartMyAppInAFrame("../app.html?sap-language=EN&sap-ui-animationMode=none");
				When.onTheStores.iOpenTheStore(oFx.storeName);
				Then.onTheStores.iSeeTheStorePage(oFx.storeName);
				When.onTheJobs.iUploadAndAttachTogether(aFiles);
				Then.onTheJobs.iSeeTheJobStarted();
				When.onTheJobs.iPressViewJob();
				Then.onTheJobs.iSeeTheJobWithState("Completed", "2/2");
				When.onTheJobs.iGoBackToTheJobs();
				Then.onTheJobs.iSeeAJobOfTheStoreWithState(oFx.storeName, "Completed");
				Then.iTeardownMyApp();
			});

			opaTest("Test retrieval returns the file that holds the answer first", function (Given, When, Then) {
				Given.iStartMyAppInAFrame("../app.html?sap-language=EN&sap-ui-animationMode=none");
				When.onTheStores.iOpenTheStore(oFx.storeName);
				Then.onTheStores.iSeeTheStorePage(oFx.storeName);
				When.onTheJobs.iOpenTheTestRetrievalTab();
				When.onTheJobs.iSearchFor("How many puffins did the lighthouse warden count?");
				Then.onTheJobs.iSeeTheFirstResultFrom(aFiles[0].name);
				Then.iTeardownMyApp();
			});
		}
	};
});
