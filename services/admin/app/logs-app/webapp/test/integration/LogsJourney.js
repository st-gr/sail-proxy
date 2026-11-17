/* global QUnit */
sap.ui.define([
	"sap/ui/test/opaQunit",
	"admin/logs/test/integration/expectations"
], function (opaTest, expectations) {
	"use strict";

	// Log entries cannot be seeded: the service only reads them, and they arrive from a gateway through
	// Valkey. So these journeys check the page whether rows are there or not; the rows themselves are
	// checked in a container. seed.js resets the logging settings before the run.
	var START = "../app.html?sap-language=EN&sap-ui-animationMode=none";
	var NOTHING = "no-such-entry-" + Date.now();
	var COMPONENT = "JourneyComponent";

	return {
		run: function () {
			QUnit.module("Logs (" + expectations.role + ")");

			opaTest("The log opens live and newest last, with its columns, time range, search, level and export", function (Given, When, Then) {
				Given.iStartMyAppInAFrame(START);
				Then.onTheLogs.iSeeTheView({ live: true, order: "newestLast", hasRange: false });
				Then.onTheLogs.iSeeTheLogTableAndFilters();
				Then.iTeardownMyApp();
			});

			opaTest("Newest first is remembered for the next visit, and newest last comes back", function (Given, When, Then) {
				Given.iStartMyAppInAFrame(START);
				When.onTheLogs.iChooseTheOrder("newestFirst");
				Then.onTheLogs.iSeeTheView({ order: "newestFirst" });
				Then.iTeardownMyApp();
				Given.iStartMyAppInAFrame(START);
				Then.onTheLogs.iSeeTheView({ order: "newestFirst" });
				When.onTheLogs.iChooseTheOrder("newestLast");
				Then.onTheLogs.iSeeTheView({ order: "newestLast" });
				Then.iTeardownMyApp();
			});

			opaTest("The Live button and the status line say in words whether Live is on", function (Given, When, Then) {
				Given.iStartMyAppInAFrame(START);
				Then.onTheLogs.iSeeTheView({ live: true });
				Then.onTheLogs.iSeeLiveSaying(true, "Live: on", "Following new entries");
				When.onTheLogs.iPress("liveButton");
				Then.onTheLogs.iSeeLiveSaying(false, "Live: off", "Live is off");
				When.onTheLogs.iPress("liveButton");
				Then.onTheLogs.iSeeLiveSaying(true, "Live: on", "Following new entries");
				Then.iTeardownMyApp();
			});

			opaTest("A quick time range ends Live, and Live clears the range again", function (Given, When, Then) {
				Given.iStartMyAppInAFrame(START);
				When.onTheLogs.iPress("lastHourButton");
				Then.onTheLogs.iSeeTheView({ live: false, hasRange: true });
				When.onTheLogs.iPress("liveButton");
				Then.onTheLogs.iSeeTheView({ live: true, hasRange: false });
				Then.iTeardownMyApp();
			});

			opaTest("The search and the level go to the service", function (Given, When, Then) {
				Given.iStartMyAppInAFrame(START);
				When.onTheLogs.iSearchFor(NOTHING);
				Then.onTheLogs.iSeeNoRows();
				When.onTheLogs.iSearchFor("");
				When.onTheLogs.iChooseTheLevel("WARN");
				Then.onTheLogs.iSeeOnlyRowsAtLevels(["WARN", "ERROR"]);
				Then.iTeardownMyApp();
			});

			opaTest("Delete now asks first, Cancel changes nothing, and confirming deletes the stored log", function (Given, When, Then) {
				Given.iStartMyAppInAFrame(START);
				Then.onTheLogs.iSeeTheView({ live: true });
				When.onTheLogs.iRememberTheRows();
				When.onTheLogs.iPress("deleteNowButton");
				Then.onTheLogs.iSeeTheDeleteConfirmation();
				When.onTheLogs.iConfirm("Cancel");
				Then.onTheLogs.iSeeNothingDeleted();
				When.onTheLogs.iPress("deleteNowButton");
				Then.onTheLogs.iSeeTheDeleteConfirmation();
				When.onTheLogs.iConfirm("Delete the log");
				Then.onTheLogs.iSeeTheDeleteDone();
				Then.onTheLogs.iSeeTheView({ live: true });
				Then.iTeardownMyApp();
			});

			// Traces cannot be seeded either (they arrive from a gateway); the rows, the detail and the stages are checked in a container.
			opaTest("Payload traces ask for a time range first; Last hour shows the list with its columns", function (Given, When, Then) {
				Given.iStartMyAppInAFrame(START);
				When.onTheLogs.iOpenTheTracesTab();
				Then.onTheLogs.iSeeTheTracesAskForARange();
				When.onTheLogs.iPressTraces("tracesLastHourButton");
				Then.onTheLogs.iSeeTheTracesOfTheRange();
				Then.iTeardownMyApp();
			});

			opaTest("Start raw capture says what it includes, needs a reason, and Cancel closes it", function (Given, When, Then) {
				Given.iStartMyAppInAFrame(START);
				When.onTheLogs.iOpenTheTracesTab();
				When.onTheLogs.iPressTraces("startRawCaptureButton");
				Then.onTheLogs.iSeeTheStartDialog();
				When.onTheLogs.iEnterTheAddresses("jane.roe@example.org");
				When.onTheLogs.iPressInTheStartDialog("startRawCaptureConfirm");
				Then.onTheLogs.iSeeThatAReasonIsRequired();
				When.onTheLogs.iPressInTheStartDialog("startRawCaptureCancel");
				Then.onTheLogs.iSeeTheStartDialogClosed();
				Then.iTeardownMyApp();
			});

			opaTest("Switches and levels offers each setting's configured value first, with Save in the footer", function (Given, When, Then) {
				Given.iStartMyAppInAFrame(START);
				When.onTheLogs.iOpenTheSettingsTab();
				Then.onTheLogs.iSeeTheSettingsControls();
				Then.iTeardownMyApp();
			});

			opaTest("A component level with a time limit is saved through the pop-up, and reset again", function (Given, When, Then) {
				Given.iStartMyAppInAFrame(START);
				When.onTheLogs.iOpenTheSettingsTab();
				Then.onTheLogs.iSeeTheSettingsControls();
				When.onTheLogs.iAddTheComponentLevel(COMPONENT, "DEBUG", "15");
				When.onTheLogs.iPressSettings("saveSettingsButton");
				When.onTheLogs.iConfirm("OK");
				Then.onTheLogs.iSeeTheComponentLevel(COMPONENT, true);
				When.onTheLogs.iPressSettings("resetSettingsButton");
				When.onTheLogs.iConfirm("OK");
				Then.onTheLogs.iSeeTheComponentLevel(COMPONENT, false);
				Then.iTeardownMyApp();
			});
		}
	};
});
