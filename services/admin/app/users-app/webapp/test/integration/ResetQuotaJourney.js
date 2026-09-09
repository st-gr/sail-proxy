/* global QUnit */
sap.ui.define([
	"sap/ui/test/opaQunit",
	"admin/users/test/integration/expectations"
], function (opaTest, expectations) {
	"use strict";

	return {
		run: function () {
			var oFx = expectations.expect.fixtures;
			QUnit.module("Reset Quota (" + expectations.role + ")");
			// Runs last (see opaTests.qunit.js): it zeroes the seeded usage user's counters, which
			// the list and object page journeys assert are at least the seeded amount.
			opaTest("Reset Quota from the list zeroes today's usage and stamps quotaResetAt", function (Given, When, Then) {
				Given.iStartMyApp();
				When.onTheListReport.onTable().iSelectRows({ "E-Mail": oFx.quota.user });
				When.onTheListReport.onTable().iExecuteAction("Reset Quota");
				When.onTheListReport.onTable().iPressRow({ "E-Mail": oFx.quota.user });
				Then.onTheObjectPage.iSeeThisPage();
				// iSeeStoredValue cannot read virtuals reliably right after a side-effects refresh -
				// assert through the rendered Usage form instead.
				Then.onTheObjectPage.onForm("Usage").iCheckField({ property: "usedTokensDay" }, "0");
				Then.onTheObjectPage.onForm("Usage").iCheckField("Quota Reset At");
				Then.onTheObjectPage.iSeeStoredValueMatching("quotaResetAt", /^\d{4}-/);
				Given.iTearDownMyApp();
			});
		}
	};
});
