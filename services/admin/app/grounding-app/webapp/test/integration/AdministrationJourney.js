/* global QUnit */
sap.ui.define([
	"sap/ui/test/opaQunit",
	"admin/grounding/test/integration/expectations"
], function (opaTest, expectations) {
	"use strict";
	return {
		run: function () {
			var oFx = expectations.expect.fixtures.grounding;
			var oUsers = expectations.expect.fixtures.users;
			QUnit.module("Administration and sharing (" + expectations.role + ")");

			if (expectations.expect.isAdmin) {
				opaTest("Administration opens on the overview", function (Given, When, Then) {
					Given.iStartMyAppInAFrame("../app.html?sap-language=EN&sap-ui-animationMode=none#/admin");
					// The seed leaves at least four stores: one per role, the admin's share fixture and its shared one.
					Then.onTheAdministration.iSeeTheOverviewTiles(7, "Vector Stores", 4);
					// Every seeded store is built with the configured model, so none is outdated.
					Then.onTheAdministration.iSeeTheTile("Outdated Stores", "0");
					Then.iTeardownMyApp();
				});

				// The journeys' gateway stores blobs in the database and has no S3 configuration.
				opaTest("The overview shows where blobs are stored and tests the S3 connection", function (Given, When, Then) {
					Given.iStartMyAppInAFrame("../app.html?sap-language=EN&sap-ui-animationMode=none#/admin");
					Then.onTheAdministration.iSeeTheBlobStorage("Database", "Not configured");
					When.onTheAdministration.iTestTheS3Connection();
					Then.onTheAdministration.iSeeTheConnectionTestResult("S3 is not configured, or its credentials are missing.");
					Then.iTeardownMyApp();
				});

				opaTest("Administration lists every user's stores and marks the shared one", function (Given, When, Then) {
					Given.iStartMyAppInAFrame("../app.html?sap-language=EN&sap-ui-animationMode=none#/admin/stores");
					Then.onTheAdministration.iSeeTheStoreOf(oFx.storeName, oUsers.admin, false);
					Then.onTheAdministration.iSeeTheStoreOf(oFx.storeName, oUsers.user, false);
					Then.onTheAdministration.iSeeTheStoreOf(oFx.sharedStoreName, oFx.sharedOwner, true);
					Then.iTeardownMyApp();
				});

				// On the admin's own share fixture, never a store whose name another role's store has too.
				opaTest("The owner shares a store with all users and stops sharing it", function (Given, When, Then) {
					Given.iStartMyAppInAFrame("../app.html?sap-language=EN&sap-ui-animationMode=none");
					When.onTheStores.iOpenTheStore(oFx.shareStoreName);
					Then.onTheStores.iSeeTheStorePage(oFx.shareStoreName);
					When.onTheStores.iPressShare();
					When.onTheStores.iPressTheDialogButton("OK");
					Then.onTheStores.iSeeTheStoreShared(true);
					When.onTheStores.iPressStopSharing();
					Then.onTheStores.iSeeTheStoreShared(false);
					Then.iTeardownMyApp();
				});

				opaTest("The owner shares a store with a team", function (Given, When, Then) {
					Given.iStartMyAppInAFrame("../app.html?sap-language=EN&sap-ui-animationMode=none");
					When.onTheStores.iOpenTheStore(oFx.shareStoreName);
					Then.onTheStores.iSeeTheStorePage(oFx.shareStoreName);
					When.onTheStores.iPressShareWithTeam();
					When.onTheStores.iChooseTeamAndShare(expectations.expect.fixtures.team.name);
					When.onTheStores.iOpenTheDetailsTab();
					Then.onTheStores.iSeeTheTeamShare(expectations.expect.fixtures.team.name);
					Then.iTeardownMyApp();
				});
			} else {
				opaTest("A user's link to Administration leads back to Vector Stores", function (Given, When, Then) {
					Given.iStartMyAppInAFrame("../app.html?sap-language=EN&sap-ui-animationMode=none#/admin");
					Then.onTheAdministration.iAmSentBackToTheStores();
					Then.iTeardownMyApp();
				});

				opaTest("A store shared by the admin is listed as Shared and opens read-only", function (Given, When, Then) {
					Given.iStartMyAppInAFrame("../app.html?sap-language=EN&sap-ui-animationMode=none");
					Then.onTheStores.iSeeTheStoreSharedBy(oFx.sharedStoreName, oFx.sharedOwner);
					When.onTheStores.iOpenTheStore(oFx.sharedStoreName);
					Then.onTheStores.iSeeTheStorePage(oFx.sharedStoreName);
					Then.onTheStores.iSeeTheStoreReadOnly(oFx.sharedOwner);
					Then.iTeardownMyApp();
				});

				opaTest("Test retrieval on a shared store answers from its document", function (Given, When, Then) {
					Given.iStartMyAppInAFrame("../app.html?sap-language=EN&sap-ui-animationMode=none");
					When.onTheStores.iOpenTheStore(oFx.sharedStoreName);
					Then.onTheStores.iSeeTheStorePage(oFx.sharedStoreName);
					When.onTheJobs.iOpenTheTestRetrievalTab();
					When.onTheJobs.iSearchFor("When does the cafeteria serve lentil soup?");
					Then.onTheJobs.iSeeTheFirstResultFrom(oFx.sharedFileName);
					Then.iTeardownMyApp();
				});
			}
		}
	};
});
