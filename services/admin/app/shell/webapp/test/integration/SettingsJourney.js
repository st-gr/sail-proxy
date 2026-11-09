/* global QUnit */
sap.ui.define([
	"sap/ui/test/opaQunit",
	"admin/shell/test/integration/expectations"
], function (opaTest, expectations) {
	"use strict";

	return {
		run: function () {
			QUnit.module("Shell settings (" + expectations.role + ")");

			opaTest("Save applies a theme live and keeps it for the account; Cancel discards", function (Given, When, Then) {
				Given.iStartMyAppInAFrame("../../index.html?sap-language=EN");
				Then.onTheShell.iSeeTheProfile(expectations.email, expectations.expect.shell.userRoleLabel);

				// Light is the default for a user who never chose
				When.onTheShell.iOpenTheSettings();
				Then.onTheShell.iSeeTheSettingsShowing("theme", "sap_horizon");
				When.onTheShell.iChooseInTheSettings("theme", "sap_horizon_dark");
				When.onTheShell.iPressSaveInTheSettings();
				Then.onTheShell.iSeeTheThemeApplied("sap_horizon_dark");
				Then.onTheShell.iSeeTheAccountSetting("theme", "sap_horizon_dark");

				// Cancel: the edit is neither applied nor written, and is gone on the next open
				When.onTheShell.iOpenTheSettings();
				Then.onTheShell.iSeeTheSettingsShowing("theme", "sap_horizon_dark");
				When.onTheShell.iChooseInTheSettings("theme", "sap_horizon");
				When.onTheShell.iPressCancelInTheSettings();
				Then.onTheShell.iSeeTheThemeApplied("sap_horizon_dark");
				Then.onTheShell.iSeeTheAccountSetting("theme", "sap_horizon_dark");
				When.onTheShell.iOpenTheSettings();
				Then.onTheShell.iSeeTheSettingsShowing("theme", "sap_horizon_dark");

				// Back to Light, so the journeys after this one start as before
				When.onTheShell.iChooseInTheSettings("theme", "sap_horizon");
				When.onTheShell.iPressSaveInTheSettings();
				Then.onTheShell.iSeeTheThemeApplied("sap_horizon");
				Then.onTheShell.iSeeTheAccountSetting("theme", "sap_horizon");
				Then.iTeardownMyApp();
			});

			opaTest("Save of a changed language reloads the cockpit once in that language", function (Given, When, Then) {
				Given.iStartMyAppInAFrame("../../index.html?sap-language=EN");
				Then.onTheShell.iSeeTheProfile(expectations.email, expectations.expect.shell.userRoleLabel);
				When.onTheShell.iOpenTheSettings();
				When.onTheShell.iChooseInTheSettings("language", "de");
				When.onTheShell.iPressSaveInTheSettings();
				Then.onTheShell.iSeeTheCockpitReloadedOnceIn("de");
				Then.onTheShell.iSeeTheAccountSetting("language", "de");
				When.onTheShell.iResetTheLanguage();
				Then.onTheShell.iSeeTheAccountSetting("language", "");
				Then.iTeardownMyApp();
			});
		}
	};
});
