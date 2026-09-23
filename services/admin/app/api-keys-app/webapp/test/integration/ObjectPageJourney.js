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
				// Rate limits are two layers: the key's own (set here) and its owner's user-level limit,
				// shown beside it with its source. The seed gave this key a per-minute limit and its
				// owner the Standard profile; the values come from the seed, not from here.
				var oQuota = oNames.quota;
				Then.onTheObjectPage.onForm("Rate Limits").iCheckField({ property: "requestsPerMinute" }, String(oQuota.keyRequestsPerMinute));
				Then.onTheObjectPage.onForm("Rate Limits").iCheckField({ property: "ownerRequestsPerMinuteText" },
					Number(oQuota.profileRequestsPerMinute).toLocaleString("en-US") + " (" + oQuota.profileName + " profile)");
				// "Set Rate Limits" opens with the current values (UI.ParameterDefaultValue paths), for
				// every role that may run it; Cancel leaves everything as it was.
				When.onTheObjectPage.onForm("Rate Limits").iExecuteAction("Set Rate Limits");
				Then.onTheObjectPage.onDialog().iCheckActionParameterDialogField({ property: "requestsPerMinute" }, String(oQuota.keyRequestsPerMinute));
				When.onTheObjectPage.onDialog().iCancel();
				Then.onTheObjectPage.onForm("Rate Limits").iCheckField({ property: "requestsPerMinute" }, String(oQuota.keyRequestsPerMinute));
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
