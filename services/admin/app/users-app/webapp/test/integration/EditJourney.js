/* global QUnit */
sap.ui.define([
	"sap/ui/test/opaQunit",
	"admin/users/test/integration/expectations"
], function (opaTest, expectations) {
	"use strict";

	return {
		run: function () {
			var oExpect = expectations.expect.users;
			var oFx = expectations.expect.fixtures;
			QUnit.module("User edit (" + expectations.role + ")");
			opaTest("Edit applies the role's field control and Tokens per Week saves in place", function (Given, When, Then) {
				Given.iStartMyApp();
				When.onTheListReport.onTable().iPressRow({ "E-Mail": oFx.quota.user });
				Then.onTheObjectPage.iSeeThisPage();
				When.onTheObjectPage.onHeader().iExecuteEdit();
				// "ConstraintsTokens" is the FIELD GROUP the token windows now live in (the
				// Constraints section is a CollectionFacet of three groups, and iSeeFieldEditability
				// addresses a form element by its field group's stable id). onForm still takes the
				// SUBSECTION title, which is the collection facet's own label, "Constraints".
				Then.onTheObjectPage.iSeeFieldEditability("ConstraintsTokens", "tokensPerWeek", oExpect.canManage);
				Then.onTheObjectPage.iSeeFieldEditability("ConstraintsTokens", "tokensPerDay", oExpect.canManage);
				When.onTheObjectPage.onForm("Constraints").iChangeField({ property: "tokensPerWeek" }, "5000");
				When.onTheObjectPage.onFooter().iExecuteSave();
				// the page context is the draft until activation succeeds; a failed Save (error dialog, 4xx) would leave it in edit mode
				Then.onTheObjectPage.iSeeStoredValue("IsActiveEntity", true);
				Then.onTheObjectPage.iSeeStoredValue("tokensPerWeek", 5000);
				Given.iTearDownMyApp();
			});
		}
	};
});
