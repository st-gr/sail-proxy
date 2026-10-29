/* global QUnit */
sap.ui.define([
	"sap/ui/test/opaQunit",
	"admin/grounding/test/integration/expectations"
], function (opaTest, expectations) {
	"use strict";
	return {
		run: function () {
			var oFx = expectations.expect.fixtures.grounding;
			QUnit.module("Files (" + expectations.role + ")");

			opaTest("A file uploaded into a store is ingested and completes", function (Given, When, Then) {
				Given.iStartMyAppInAFrame("../app.html?sap-language=EN&sap-ui-animationMode=none");
				When.onTheStores.iOpenTheStore(oFx.storeName);
				Then.onTheStores.iSeeTheStorePage(oFx.storeName);
				When.onTheStores.iUploadAndAttach(oFx.fileName, "Grounding journey note. The quick brown fox jumps over the lazy dog.");
				Then.onTheStores.iSeeTheFileWithStatus(oFx.fileName, "Completed");
				Then.iTeardownMyApp();
			});

			opaTest("The Files screen shows where the file is attached, and deleting it detaches it first", function (Given, When, Then) {
				Given.iStartMyAppInAFrame("../app.html?sap-language=EN&sap-ui-animationMode=none#/files");
				Then.onTheFiles.iSeeTheFileAttachedTo(oFx.fileName, oFx.storeName);
				When.onTheFiles.iPressDeleteFor(oFx.fileName);
				Then.onTheFiles.iSeeTheDeleteQuestionNaming(oFx.fileName);
				When.onTheFiles.iConfirm();
				Then.onTheFiles.iDoNotSeeTheFile(oFx.fileName);
				Then.iTeardownMyApp();
			});
		}
	};
});
