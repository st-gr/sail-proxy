/* global QUnit */
sap.ui.define([
	"sap/ui/test/opaQunit",
	"admin/plugins/test/integration/expectations"
], function (opaTest, expectations) {
	"use strict";

	// seed.js stores fixture plugin `id` in versions 1.0.0, 1.1.0 and an incompatible 9.0.0, all disabled,
	// and purges every plugin whose id starts with its prefix before a run. The journeys end clean themselves,
	// so a plugin does not stay enabled on the CI gateway for the journeys after this app.
	var START = "../app.html?sap-language=EN&sap-ui-animationMode=none";

	return {
		run: function () {
			var oFx = expectations.expect.fixtures.plugin;
			QUnit.module("Plugins (" + expectations.role + ")");

			opaTest("The list shows a stored plugin, disabled, its package text as text", function (Given, When, Then) {
				Given.iStartMyAppInAFrame(START);
				Then.onThePlugins.iSeeTheRow(oFx.id, { stateKey: "disabled", statusText: "Disabled", canEnable: false, canDisable: false, canRemove: true, uploadedBy: expectations.email });
				Then.onThePlugins.iSeeTheSummaryAsText(oFx.id, oFx.summary);
				Then.onThePlugins.iSeeTheBuiltinsTableAndUploadForm();
				Then.onThePlugins.iSeeTheListAnsweredWithTheSettingOn();
				Then.iTeardownMyApp();
			});

			opaTest("An incompatible version cannot be enabled and says why", function (Given, When, Then) {
				Given.iStartMyAppInAFrame(START);
				Then.onThePlugins.iSeeTheRow(oFx.id, { selectedVersion: "9.0.0", canEnable: false });
				When.onThePlugins.iChooseTheVersion(oFx.id, "1.1.0");
				Then.onThePlugins.iSeeTheRow(oFx.id, { selectedVersion: "1.1.0", canEnable: true, enableText: "Enable", compatibilityText: "" });
				Then.iTeardownMyApp();
			});

			opaTest("Enable, switch version and disable", function (Given, When, Then) {
				Given.iStartMyAppInAFrame(START);
				When.onThePlugins.iChooseTheVersion(oFx.id, "1.0.0");
				When.onThePlugins.iPressEnable(oFx.id);
				Then.onThePlugins.iSeeTheRow(oFx.id, { enabledVersion: "1.0.0", selectedVersion: "1.0.0", canDisable: true, canRemove: false, canEnable: false });
				Then.onThePlugins.iSeeAnEnabledStatusIn(oFx.id, ["running", "installed", "pending", "failed", "notResponding", "unavailable"]);

				When.onThePlugins.iChooseTheVersion(oFx.id, "1.1.0");
				Then.onThePlugins.iSeeTheRow(oFx.id, { enableText: "Switch to this version", canEnable: true, canRemove: true });
				When.onThePlugins.iPressEnable(oFx.id);
				Then.onThePlugins.iSeeTheRow(oFx.id, { enabledVersion: "1.1.0", selectedVersion: "1.1.0", canRemove: false });

				When.onThePlugins.iPressDisable(oFx.id);
				When.onThePlugins.iConfirm("Disable");
				Then.onThePlugins.iSeeTheRow(oFx.id, { enabledVersion: null, stateKey: "disabled" });
				Then.iTeardownMyApp();
			});

			opaTest("A package the server refuses shows the server's message", function (Given, When, Then) {
				Given.iStartMyAppInAFrame(START);
				Then.onThePlugins.iSeeTheRow(oFx.id, { stateKey: "disabled" });
				When.onThePlugins.iUpload(window.btoa("this is not a zip file"), "broken.zip");
				Then.onThePlugins.iSeeTheDialogSaying(oFx.refusedMessage);
				When.onThePlugins.iConfirm("Close");
				Then.iTeardownMyApp();
			});

			opaTest("Upload stores a new disabled version, and remove deletes it", function (Given, When, Then) {
				Given.iStartMyAppInAFrame(START);
				Then.onThePlugins.iSeeTheRow(oFx.id, { stateKey: "disabled" });
				When.onThePlugins.iUpload(oFx.uploadBase64, oFx.id + "-2.0.0.zip");
				Then.onThePlugins.iSeeTheRow(oFx.uploadId, { selectedVersion: "2.0.0", stateKey: "disabled", canEnable: true });
				Then.onThePlugins.iSeeTheActionsOn([]);
				When.onThePlugins.iSelectTheRows([oFx.uploadId]);
				Then.onThePlugins.iSeeTheActionsOn(["enableButton", "removeButton"]);
				When.onThePlugins.iChooseTheVersion(oFx.id, "9.0.0");
				Then.onThePlugins.iSeeTheRow(oFx.id, { selectedVersion: "9.0.0", canEnable: false });
				When.onThePlugins.iSelectTheRows([oFx.id]);
				Then.onThePlugins.iSeeTheActionsOn(["removeButton"]);
				When.onThePlugins.iSelectTheRows([oFx.id, oFx.uploadId]);
				Then.onThePlugins.iSeeTheActionsOn(["enableButton", "removeButton"]);
				When.onThePlugins.iPressRemove(oFx.uploadId);
				When.onThePlugins.iConfirm("Remove Version");
				Then.onThePlugins.iSeeNoRow(oFx.uploadId);
				Then.iTeardownMyApp();
			});
		}
	};
});
