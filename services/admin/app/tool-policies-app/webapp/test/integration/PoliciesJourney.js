/* global QUnit */
sap.ui.define([
	"sap/ui/test/opaQunit",
	"admin/toolpolicies/test/integration/expectations"
], function (opaTest, expectations) {
	"use strict";

	return {
		run: function () {
			QUnit.module("Tool policies (" + expectations.role + ")");

			opaTest("The list shows the Default policy in monitor mode", function (Given, When, Then) {
				Given.iStartMyApp();
				Then.onTheListReport.onTable().iCheckRows({ "Name": "Default", "Mode": "monitor" });
			});

			opaTest("Create a policy with an allow and a deny entry", function (Given, When, Then) {
				When.onTheListReport.onTable().iExecuteCreate();
				When.onTheObjectPage.onForm("General").iChangeField({ property: "name" }, "Journey policy");
				When.onTheObjectPage.onForm("General").iChangeField({ property: "mode" }, "strip");
				When.onTheObjectPage.iGoToSection("Allow");
				// Creation mode "Inline" (manifest.json): the toolbar's Create appends ONE empty row
				// of normal height, which is then filled in place - there is no persistent
				// double-height creation row with its own "Add Row" link any more. The empty row is
				// matched by its empty Pattern cell, which is also why only one may be open at a time.
				When.onTheObjectPage.onTable({ property: "allows" }).iExecuteCreate();
				When.onTheObjectPage.onTable({ property: "allows" }).iChangeRow({ "Pattern": "" }, { "Pattern": "function:*" });
				When.onTheObjectPage.iGoToSection("Deny");
				When.onTheObjectPage.onTable({ property: "denies" }).iExecuteCreate();
				When.onTheObjectPage.onTable({ property: "denies" }).iChangeRow({ "Pattern": "" }, { "Pattern": "mcp:github/*" });
				When.onTheObjectPage.iGoToSection("Sensitive Tools");
				When.onTheObjectPage.onTable({ property: "sensitive" }).iExecuteCreate();
				When.onTheObjectPage.onTable({ property: "sensitive" }).iChangeRow({ "Pattern": "" }, { "Pattern": "function:shell" });
				When.onTheObjectPage.onFooter().iExecuteSave();
				Then.onTheObjectPage.onHeader().iCheckTitle("Journey policy");
				Then.onTheObjectPage.onTable({ property: "allows" }).iCheckRows({ "Pattern": "function:*" });
				Then.onTheObjectPage.onTable({ property: "sensitive" }).iCheckRows({ "Pattern": "function:shell" });
				Given.iTearDownMyApp();
			});

			opaTest("Opens the Tool Inventory page from the list", function (Given, When, Then) {
				Given.iStartMyApp();
				When.onTheListReport.onHeader().iExecuteAction("Open Tool Inventory");
				// Reached by route name; the route's pattern is the entity set ("ToolInventory:?query:"),
				// because Fiori Elements resolves a page's path from its pattern - a made-up segment
				// such as "inventory" ends on the error page 'Invalid resource path
				// "AdminService.inventory"'.
				Then.onTheInventory.iSeeThisPage();
				When.onTheInventory.onHeader().iExecuteAction("Back to Tool Policies");
				Then.onTheListReport.iSeeThisPage();
				Given.iTearDownMyApp();
			});

			opaTest("Assigns and unassigns a user on the policy's own table", function (Given, When, Then) {
				var oUsers = { property: "assignedUsersList", qualifier: "ForPolicy" };
				Given.iStartMyApp();
				When.onTheListReport.onTable().iExecuteCreate();
				When.onTheObjectPage.onForm("General").iChangeField({ property: "name" }, "Journey assignment policy");
				When.onTheObjectPage.onFooter().iExecuteSave();
				// Assignment lives in the toolbar of the table it changes, not in the page header,
				// and the two tables offer no Create or Delete: a user and an API key exist
				// independently of the policy (Capabilities.NavigationRestrictions in
				// annotations.cds, asserted on the metadata by
				// test/integration/http/tool-policies-odata.test.ts).
				When.onTheObjectPage.iGoToSection("Assigned Users");
				When.onTheObjectPage.onTable(oUsers).iExecuteAction("Assign User");
				When.onTheObjectPage.iPickFromTheAssignmentDialog(expectations.email);
				Then.onTheObjectPage.onTable(oUsers).iCheckRows({ "Email": expectations.email });
				When.onTheObjectPage.onTable(oUsers).iSelectRows({ "Email": expectations.email });
				When.onTheObjectPage.onTable(oUsers).iExecuteAction("Unassign");
				Then.onTheObjectPage.onTable(oUsers).iCheckRows(0);
				Given.iTearDownMyApp();
			});

			// The API key side of the same two buttons, and every rejection the four bound actions
			// can answer with, are covered by test/integration/http/tool-policies-odata.test.ts.
			//
			// Only the earlier, header-based shape of these actions could not be driven from OPA:
			// Fiori Elements' action-parameter dialog (onHeader().iExecuteAction("Assign User") ->
			// onDialog().iChangeDialogField(...).and.iConfirm()) left its busy indicator locked
			// forever after OK, with no request ever sent, while the same action through a direct
			// control API or a raw HTTP call succeeded instantly. The step above avoids that dialog
			// entirely - the picker is a plain sap.m.SelectDialog - which is also why it can be
			// tested here at all.
		}
	};
});
