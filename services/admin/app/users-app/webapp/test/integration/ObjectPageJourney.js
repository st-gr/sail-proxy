/* global QUnit */
sap.ui.define([
	"sap/ui/test/opaQunit",
	"admin/users/test/integration/expectations"
], function (opaTest, expectations) {
	"use strict";

	return {
		run: function () {
			var oFx = expectations.expect.fixtures;
			QUnit.module("User object page (" + expectations.role + ")");
			opaTest("Shows the seeded constraints, usage, credentials and entitlement", function (Given, When, Then) {
				Given.iStartMyApp();
				When.onTheListReport.onTable().iPressRow({ "E-Mail": oFx.quota.user });
				Then.onTheObjectPage.iSeeThisPage();
				Then.onTheObjectPage.onForm("Constraints").iCheckField("Tokens per Day");
				Then.onTheObjectPage.onForm("Usage").iCheckField("Tokens Today");
				// a spend field is an amount measured in sapCostCurrency: the template must render the pair
				Then.onTheObjectPage.onForm("Usage").iCheckField("Spend Today");
				Then.onTheObjectPage.iSeeStoredValue("tokensPerDay", oFx.quota.tokensPerDay);
				Then.onTheObjectPage.onTable({ property: "apiKeys", qualifier: "ForUser" }).iCheckRows({ "Name": oFx.userActiveKey }, 1);
				Then.onTheObjectPage.onForm("Entitlement").iCheckField("Entitlement Catalog");
				Then.onTheObjectPage.onForm("Entitlement").iCheckField("Quota Profile");
				Then.onTheObjectPage.iSeeStoredValue("quotaProfileName", oFx.quota.profileName);
				// The Default line names what applies while the field is empty: here the assigned
				// profile's value, in the server's own format (en-US grouping for counts, two decimals
				// plus the billing currency for spend). The figures come from the seed, not from here.
				var sProfileSuffix = " (" + oFx.quota.profileName + " profile)";
				Then.onTheObjectPage.onForm("Constraints").iCheckField({ property: "tokensPerDayDefaultText" },
					Number(oFx.quota.profileTokensPerDay).toLocaleString("en-US") + sProfileSuffix);
				Then.onTheObjectPage.onForm("Constraints").iCheckField({ property: "spendPerDayDefaultText" },
					Number(oFx.quota.profileSpendPerDay).toFixed(2) + " " + oFx.quota.currency + sProfileSuffix);
				Given.iTearDownMyApp();
			});
		}
	};
});
