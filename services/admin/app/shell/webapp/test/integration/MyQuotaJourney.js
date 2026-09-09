/* global QUnit */
sap.ui.define([
	"sap/ui/test/opaQunit",
	"admin/shell/test/integration/expectations"
], function (opaTest, expectations) {
	"use strict";

	return {
		run: function () {
			QUnit.module("Shell my quota (" + expectations.role + ")");
			opaTest("Home shows the My quota card with the seeded tokens against the limit", function (Given, When, Then) {
				var oFx = expectations.expect.fixtures;
				var bCardVisible = expectations.expect.quota.cardVisible;
				// the real shell page (its own bootstrap + ushell mock), relative to this test page
				Given.iStartMyAppInAFrame("../../index.html");
				Then.onTheShell.iSeeTheProfile(expectations.email, expectations.expect.shell.userRoleLabel);
				// roles.js quota.cardVisible drives the card: false asserts it stays hidden. The admin
				// has no seeded constraints (platform defaults are unlimited), so only the card's
				// presence is asserted for that role - the row values are checked for the user role,
				// whose fixture constraints (fixtures.js quota.tokensPerDay) make the numbers exact.
				Then.onTheShell.iCheckTheQuotaCard(bCardVisible, bCardVisible && !expectations.expect.isAdmin
					? { key: "tokensDay", used: String(oFx.quota.tokens), limit: "1,000" }
					: null);
				Then.iTeardownMyApp();
			});
		}
	};
});
