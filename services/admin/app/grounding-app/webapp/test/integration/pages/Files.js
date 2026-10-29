sap.ui.define([
	"sap/ui/test/Opa5",
	"sap/ui/test/actions/Press",
	"sap/ui/test/matchers/PropertyStrictEquals"
], function (Opa5, Press, PropertyStrictEquals) {
	"use strict";

	var sView = "Files"; // admin.grounding.view.Files

	function rowWithName(oTable, sName) {
		return oTable.getItems().filter(function (oItem) {
			return oItem.getCells()[0].getText() === sName;
		})[0];
	}

	Opa5.createPageObjects({
		onTheFiles: {
			actions: {
				iPressDeleteFor: function (sFileName) {
					return this.waitFor({
						id: "filesTable",
						viewName: sView,
						check: function (oTable) { return !!rowWithName(oTable, sFileName); },
						success: function (oTable) {
							// cells[4] is the HBox with Download and Delete
							rowWithName(oTable, sFileName).getCells()[4].getItems()[1].firePress();
						},
						errorMessage: "No file named " + sFileName
					});
				},
				iConfirm: function () {
					return this.waitFor({
						searchOpenDialogs: true,
						controlType: "sap.m.Button",
						matchers: new PropertyStrictEquals({ name: "text", value: "OK" }),
						actions: new Press()
					});
				}
			},
			assertions: {
				iSeeTheFileAttachedTo: function (sFileName, sStoreName) {
					return this.waitFor({
						id: "filesTable",
						viewName: sView,
						check: function (oTable) {
							var oRow = rowWithName(oTable, sFileName);
							return !!oRow && oRow.getCells()[3].getText() === sStoreName;
						},
						success: function () { Opa5.assert.ok(true, sFileName + " is listed as attached to " + sStoreName); },
						errorMessage: sFileName + " is not listed as attached to " + sStoreName
					});
				},
				iSeeTheDeleteQuestionNaming: function (sFileName) {
					return this.waitFor({
						searchOpenDialogs: true,
						controlType: "sap.m.Text",
						check: function (aTexts) {
							return aTexts.some(function (oText) {
								return oText.getText().indexOf(sFileName) !== -1 && oText.getText().indexOf("Detach it everywhere") !== -1;
							});
						},
						success: function () { Opa5.assert.ok(true, "The question says the file is attached and will be detached"); },
						errorMessage: "The delete question does not mention detaching"
					});
				},
				iDoNotSeeTheFile: function (sFileName) {
					return this.waitFor({
						id: "filesTable",
						viewName: sView,
						check: function (oTable) { return !oTable.getBusy() && !rowWithName(oTable, sFileName); },
						success: function () { Opa5.assert.ok(true, sFileName + " is gone"); },
						errorMessage: sFileName + " is still listed"
					});
				}
			}
		}
	});
});
