/* global QUnit */
sap.ui.define([
	"sap/ui/test/opaQunit",
	"admin/app/test/integration/expectations"
], function (opaTest, expectations) {
	"use strict";

	return {
		run: function () {
			var oExpect = expectations.expect.apiKeys;
			var oNames = expectations.expect.fixtures;
			QUnit.module("API key object page (" + expectations.role + ")");
			opaTest("An active key shows Expires At about presetDays ahead and Never Expires off", function (Given, When, Then) {
				Given.iStartMyApp();
				When.onTheListReport.onTable().iPressRow({ "Name": oNames.userActiveKey });
				Then.onTheObjectPage.iSeeThisPage();
				Then.onTheObjectPage.onForm("Key Information").iCheckField("Expires At");
				Then.onTheObjectPage.onForm("Key Information").iCheckField("Never Expires");
				Then.onTheObjectPage.iSeeStoredValue("neverExpires", false);
				Then.onTheObjectPage.iSeeExpiresAtAboutDaysAhead(oExpect.presetDays);
				Given.iTearDownMyApp();
			});
			opaTest("A never-expires key shows the flag and no expiry", function (Given, When, Then) {
				Given.iStartMyApp();
				When.onTheListReport.onTable().iPressRow({ "Name": oNames.userNeverExpiresKey });
				Then.onTheObjectPage.iSeeThisPage();
				Then.onTheObjectPage.iSeeStoredValue("neverExpires", true);
				Then.onTheObjectPage.iSeeStoredValue("expiresAt", null);
				Given.iTearDownMyApp();
			});
		}
	};
});
