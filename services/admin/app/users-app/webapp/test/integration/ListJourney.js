/* global QUnit */
sap.ui.define([
	"sap/ui/test/opaQunit",
	"admin/users/test/integration/expectations"
], function (opaTest, expectations) {
	"use strict";

	return {
		run: function () {
			var oFx = expectations.expect.fixtures;
			QUnit.module("Users list (" + expectations.role + ")");
			opaTest("The list shows the Status column, the seeded user's row, and at least the seeded tokens this month", function (Given, When, Then) {
				Given.iStartMyApp();
				Then.onTheListReport.iSeeThisPage();
				Then.onTheListReport.onTable().iCheckColumns({ "Status": { visible: true }, "Last Seen": { visible: true }, "Tokens This Month": { visible: true } });
				Then.onTheListReport.onTable().iCheckRows({ "E-Mail": expectations.email }, 1);
				Then.onTheListReport.onTable().iCheckRows({ "E-Mail": oFx.quota.user, "Status": "active" }, 1);
				Then.onTheListReport.iSeeTokensThisMonthAtLeast(oFx.quota.user, oFx.quota.tokens);
				Given.iTearDownMyApp();
			});
		}
	};
});
