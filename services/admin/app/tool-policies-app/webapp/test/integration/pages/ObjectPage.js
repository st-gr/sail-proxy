sap.ui.define(["sap/fe/test/ObjectPage", "sap/ui/test/actions/Press", "sap/ui/test/matchers/PropertyStrictEquals"], function (ObjectPage, Press, PropertyStrictEquals) {
	"use strict";
	return new ObjectPage({ appId: "admin.toolpolicies", componentId: "ToolPoliciesObjectPage", entitySet: "ToolPolicies" }, {
		actions: {
			// "Assign User" and "Assign API Key" (ext/controller/AssignmentActions.js) open a
			// multi-select sap.m.TableSelectDialog over the candidates rather than the Fiori Elements
			// action-parameter dialog that asked for an email address or a key id as free text.
			// Pressing a row toggles its selection; OK confirms every row that is selected.
			iPickFromTheAssignmentDialog: function (sCellText) {
				this.waitFor({
					controlType: "sap.m.ColumnListItem",
					searchOpenDialogs: true,
					matchers: function (oItem) {
						return oItem.getCells().some(function (oCell) {
							return oCell.getText && oCell.getText() === sCellText;
						});
					},
					actions: new Press(),
					errorMessage: "The assignment dialog never offered a row for '" + sCellText + "'"
				});
				return this.waitFor({
					controlType: "sap.m.Button",
					searchOpenDialogs: true,
					matchers: new PropertyStrictEquals({ name: "text", value: "Assign" }),
					actions: new Press(),
					errorMessage: "The assignment dialog had no Assign button"
				});
			}
		}
	});
});
