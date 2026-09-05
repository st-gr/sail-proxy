/* global QUnit */
sap.ui.define([
	"sap/ui/test/opaQunit",
	"admin/shell/test/integration/expectations"
], function (opaTest, expectations) {
	"use strict";

	return {
		run: function () {
			var oShell = expectations.expect.shell;
			QUnit.module("Shell navigation (" + expectations.role + ")");
			opaTest("The side navigation and the profile match the role matrix", function (Given, When, Then) {
				// the real shell page (its own bootstrap + ushell mock), relative to this test page
				Given.iStartMyAppInAFrame("../../index.html");
				Then.onTheShell.iSeeTheProfile(expectations.email, oShell.userRoleLabel);
				Then.onTheShell.iSeeNavigationEntries(oShell.visibleNav, oShell.hiddenNav);
				Then.iTeardownMyApp();
			});
		}
	};
});
