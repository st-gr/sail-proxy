/* global QUnit */
sap.ui.define([
	"sap/ui/test/opaQunit",
	"admin/app/test/integration/expectations"
], function (opaTest, expectations) {
	"use strict";

	return {
		run: function () {
			var oExpect = expectations.expect.apiKeys;
			QUnit.module("API key create (" + expectations.role + ")");
			opaTest("Create presets Expires At and applies the role's field control", function (Given, When, Then) {
				Given.iStartMyApp();
				When.onTheListReport.onTable().iExecuteCreate();
				Then.onTheObjectPage.iSeeThisPage();
				Then.onTheObjectPage.iSeeExpiresAtAboutDaysAhead(oExpect.presetDays);
				Then.onTheObjectPage.iSeeFieldEditability("General", "isActive", oExpect.editable.isActive);
				Then.onTheObjectPage.iSeeFieldEditability("General", "expiresAt", oExpect.editable.expiresAt);
				Then.onTheObjectPage.iSeeFieldEditability("General", "neverExpires", oExpect.editable.neverExpires);
				// the untouched draft is left behind on purpose; the next seed run purges it
				Given.iTearDownMyApp();
			});
		}
	};
});
