/* global QUnit */
sap.ui.define([
	"sap/ui/test/opaQunit",
	"admin/shell/test/integration/expectations"
], function (opaTest, expectations) {
	"use strict";

	return {
		run: function () {
			QUnit.module("Shell home tiles (" + expectations.role + ")");
			opaTest("Home shows this month's key metrics as tiles, and a tile opens Usage Analytics", function (Given, When, Then) {
				var oFx = expectations.expect.fixtures;
				var bAdmin = expectations.expect.isAdmin;
				// the real shell page (its own bootstrap + ushell mock), relative to this test page
				Given.iStartMyAppInAFrame("../../index.html");
				Then.onTheShell.iSeeTheProfile(expectations.email, expectations.expect.shell.userRoleLabel);
				// An administrator's summary covers every user and adds the "Active users" tile; a user's
				// covers their own usage, whose seeded tokens (fixtures.js quota.seededTokens) are exact.
				Then.onTheShell.iCheckTheHomeTiles(bAdmin
					? { count: 4 }
					: { count: 3, tokens: String(oFx.quota.tokens) });
				When.onTheShell.iPressTheHomeTile("tokens");
				Then.onTheShell.iSeeTheHomeContentReplacedByAnApp();
				Then.iTeardownMyApp();
			});
		}
	};
});
