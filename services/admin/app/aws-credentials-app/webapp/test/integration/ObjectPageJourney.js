/* global QUnit */
sap.ui.define([
	"sap/ui/test/opaQunit",
	"admin/awscredentials/test/integration/expectations"
], function (opaTest, expectations) {
	"use strict";

	return {
		run: function () {
			var oExpect = expectations.expect.awsCredentials;
			var oNames = expectations.expect.fixtures;
			QUnit.module("AWS credential object page (" + expectations.role + ")");
			opaTest("An active credential shows Expires At about presetDays ahead and Never Expires off", function (Given, When, Then) {
				Given.iStartMyApp();
				When.onTheListReport.onTable().iPressRow({ "Name": oNames.userAwsCredential });
				Then.onTheObjectPage.iSeeThisPage();
				Then.onTheObjectPage.onForm("AWS Configuration").iCheckField("Expires At");
				Then.onTheObjectPage.onForm("AWS Configuration").iCheckField("Never Expires");
				Then.onTheObjectPage.iSeeStoredValue("neverExpires", false);
				Then.onTheObjectPage.iSeeExpiresAtAboutDaysAhead(oExpect.presetDays);
				Given.iTearDownMyApp();
			});
		}
	};
});
