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
			QUnit.module("API key edit (" + expectations.role + ")");
			opaTest("Edit applies the role's field control and Never Expires drives Expires At in place", function (Given, When, Then) {
				Given.iStartMyApp();
				When.onTheListReport.onTable().iPressRow({ "Name": oNames.userActiveKey });
				Then.onTheObjectPage.iSeeThisPage();
				When.onTheObjectPage.onHeader().iExecuteEdit();
				Then.onTheObjectPage.iSeeFieldEditability("General", "isActive", oExpect.editable.isActive);
				Then.onTheObjectPage.iSeeFieldEditability("General", "expiresAt", oExpect.editable.expiresAt);
				Then.onTheObjectPage.iSeeFieldEditability("General", "neverExpires", oExpect.editable.neverExpires);
				if (oExpect.editable.neverExpires) {
					// tick: the server clears Expires At and makes it read-only (SideEffects refresh it in place)
					When.onTheObjectPage.onForm("Key Information").iClickCheckBox({ property: "neverExpires" });
					Then.onTheObjectPage.iSeeStoredValue("neverExpires", true);
					Then.onTheObjectPage.iSeeStoredValue("expiresAt", null);
					Then.onTheObjectPage.iSeeFieldEditability("General", "expiresAt", false);
					// untick: the platform preset comes back and the field is editable again
					When.onTheObjectPage.onForm("Key Information").iClickCheckBox({ property: "neverExpires" });
					Then.onTheObjectPage.iSeeStoredValue("neverExpires", false);
					Then.onTheObjectPage.iSeeExpiresAtAboutDaysAhead(oExpect.presetDays);
					Then.onTheObjectPage.iSeeFieldEditability("General", "expiresAt", true);
				} else {
					// a plain rename must save without touching the lifecycle fields
					When.onTheObjectPage.onForm("Key Information").iChangeField({ property: "name" }, oNames.userActiveKey + " (renamed)");
				}
				When.onTheObjectPage.onFooter().iExecuteSave();
				// the page context is the draft until activation succeeds; a failed Save (error dialog, 4xx) would leave it in edit mode
				Then.onTheObjectPage.iSeeStoredValue("IsActiveEntity", true);
				if (!oExpect.editable.neverExpires) {
					Then.onTheObjectPage.iSeeStoredValue("name", oNames.userActiveKey + " (renamed)");
				}
				Then.onTheObjectPage.iSeeStoredValue("neverExpires", false);
				Then.onTheObjectPage.iSeeExpiresAtAboutDaysAhead(oExpect.presetDays);
				Given.iTearDownMyApp();
			});
		}
	};
});
