/* global QUnit */
sap.ui.define([
	"sap/ui/test/opaQunit",
	"admin/users/test/integration/expectations"
], function (opaTest, expectations) {
	"use strict";

	return {
		run: function () {
			var oFx = expectations.expect.fixtures;
			QUnit.module("User lifecycle (" + expectations.role + ")");
			// The "other" user, not the seeded-usage user, so the rows the list and reset-quota
			// journeys depend on stay active for the rest of the run.
			//
			// deactivate/reactivate now carry Common.SideEffects (users-app/annotations.cds) that
			// refresh status/canDeactivate/canReactivate and the two credential tables in place, so
			// this stays on one object page instance throughout - no teardown/re-navigation.
			opaTest("Deactivate locks the user's credentials and Reactivate unlocks them, both in place", function (Given, When, Then) {
				Given.iStartMyApp();
				When.onTheListReport.onTable().iPressRow({ "E-Mail": oFx.quota.other });
				Then.onTheObjectPage.iSeeThisPage();
				When.onTheObjectPage.onHeader().iExecuteAction("Deactivate");
				When.onTheObjectPage.onDialog().iChangeDialogField({ property: "reason" }, "journey").and.iConfirm();
				Then.onTheObjectPage.iSeeStoredValue("status", "deactivated");
				Then.onTheObjectPage.onHeader().iCheckAction("Reactivate", { visible: true, enabled: true });
				// the API Keys section sits below the fold since "Usage charts" joined the page: scroll it into view so its table loads
				When.onTheObjectPage.iGoToSection("API Keys");
				Then.onTheObjectPage.onTable({ property: "apiKeys", qualifier: "ForUser" })
					.iCheckRows({ "Name": oFx.otherUserKey, "Locked by Deactivation": "Yes" }, 1);
				When.onTheObjectPage.onHeader().iExecuteAction("Reactivate");
				Then.onTheObjectPage.iSeeStoredValue("status", "active");
				Then.onTheObjectPage.onHeader().iCheckAction("Deactivate", { visible: true, enabled: true });
				// the API Keys section sits below the fold since "Usage charts" joined the page: scroll it into view so its table loads
				When.onTheObjectPage.iGoToSection("API Keys");
				Then.onTheObjectPage.onTable({ property: "apiKeys", qualifier: "ForUser" })
					.iCheckRows({ "Name": oFx.otherUserKey, "Locked by Deactivation": "No" }, 1);
				Given.iTearDownMyApp();
			});
		}
	};
});
