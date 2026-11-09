sap.ui.define([
	"sap/ui/test/Opa5",
	"sap/ui/test/actions/Press"
], function (Opa5, Press) {
	"use strict";

	var sView = "Plugins";   // admin.plugins.view.Plugins

	// Row cells: VBox(id, summary, note), VBox(version select, compatibility), VBox(status, error, detail), rules, VBox(by, at).
	// The actions are the table's toolbar buttons, for the selected rows.
	var ACTION_BUTTONS = ["enableButton", "disableButton", "removeButton", "addHooksButton"];
	function modelRow(oItem) {
		return oItem.getBindingContext("view").getObject();
	}
	function itemOf(oTable, sId) {
		return oTable.getItems().filter(function (oItem) { return modelRow(oItem).id === sId; })[0];
	}
	// What a click on a row's checkbox does: the table's own selection, then its event.
	function selectOnly(oTable, aItems) {
		oTable.removeSelections(true);
		aItems.forEach(function (oItem) { oItem.setSelected(true); });
		oTable.fireSelectionChange({ listItems: aItems, selected: true });
	}

	Opa5.createPageObjects({
		onThePlugins: {
			actions: {
				iChooseTheVersion: function (sId, sVersion) {
					return this.waitFor({
						id: "pluginsTable",
						viewName: sView,
						check: function (oTable) { return !oTable.getBusy() && !!itemOf(oTable, sId); },
						success: function (oTable) {
							var oSelect = itemOf(oTable, sId).getCells()[1].getItems()[0];
							oSelect.setSelectedKey(sVersion);
							oSelect.fireChange({ selectedItem: oSelect.getSelectedItem() });
						},
						errorMessage: "No row for plugin " + sId
					});
				},
				iSelectTheRows: function (aIds) {
					return this.waitFor({
						id: "pluginsTable",
						viewName: sView,
						check: function (oTable) { return !oTable.getBusy() && aIds.every(function (sId) { return !!itemOf(oTable, sId); }); },
						success: function (oTable) { selectOnly(oTable, aIds.map(function (sId) { return itemOf(oTable, sId); })); },
						errorMessage: "Not all of these plugins have a row: " + aIds.join(", ")
					});
				},
				iPressTheAction: function (sId, sButtonId) {
					this.iSelectTheRows([sId]);
					return this.waitFor({
						id: sButtonId,
						viewName: sView,
						actions: new Press(),
						errorMessage: "The " + sButtonId + " for plugin " + sId + " could not be pressed"
					});
				},
				iPressEnable: function (sId) { return this.iPressTheAction(sId, "enableButton"); },
				iPressDisable: function (sId) { return this.iPressTheAction(sId, "disableButton"); },
				iPressRemove: function (sId) { return this.iPressTheAction(sId, "removeButton"); },
				// A journey cannot fill a file input, so it gives the screen the file a chosen one would be.
				iUpload: function (sBase64, sFileName) {
					this.waitFor({
						id: "uploadButton",
						viewName: sView,
						enabled: false,
						success: function (oButton) {
							var oView = oButton;
							while (!oView.getController) { oView = oView.getParent(); }
							var aBytes = Uint8Array.from(window.atob(sBase64), function (sChar) { return sChar.charCodeAt(0); });
							oView.getController().chooseFile(new (Opa5.getWindow().File)([aBytes], sFileName));
						},
						errorMessage: "The upload form is not there"
					});
					return this.waitFor({
						id: "uploadButton",
						viewName: sView,
						actions: new Press(),
						errorMessage: "The Upload button could not be pressed"
					});
				},
				iConfirm: function (sButton) {
					return this.waitFor({
						searchOpenDialogs: true,
						controlType: "sap.m.Button",
						matchers: function (oButton) { return oButton.getText() === sButton; },
						actions: new Press(),
						errorMessage: "No dialog button " + sButton
					});
				}
			},
			assertions: {
				iSeeTheRow: function (sId, oExpected) {
					var oLast = null;
					return this.waitFor({
						id: "pluginsTable",
						viewName: sView,
						check: function (oTable) {
							var oItem = itemOf(oTable, sId);
							if (oTable.getBusy() || !oItem) return false;
							oLast = modelRow(oItem);
							return Object.keys(oExpected).every(function (sKey) { return oLast[sKey] === oExpected[sKey]; });
						},
						success: function () { Opa5.assert.ok(true, "Plugin " + sId + " shows " + JSON.stringify(oExpected)); },
						errorMessage: "Plugin " + sId + " does not show " + JSON.stringify(oExpected) + " (last seen: " + JSON.stringify(oLast) + ")"
					});
				},
				// The state as the admin reads it, whichever the environment gives: CI has Valkey and a gateway, a throwaway admin neither.
				iSeeAnEnabledStatusIn: function (sId, aStates) {
					var sLast = "";
					return this.waitFor({
						id: "pluginsTable",
						viewName: sView,
						check: function (oTable) {
							var oItem = itemOf(oTable, sId);
							if (oTable.getBusy() || !oItem) return false;
							var oStatus = oItem.getCells()[2].getItems()[0];
							sLast = modelRow(oItem).stateKey + "/" + oStatus.getText();
							return aStates.indexOf(modelRow(oItem).stateKey) !== -1 && oStatus.getText() !== "";
						},
						success: function () { Opa5.assert.ok(true, "Plugin " + sId + " shows " + sLast); },
						errorMessage: "Plugin " + sId + " has an unexpected status: " + sLast
					});
				},
				// Package text reaches the control as text: a "{" stays, and markup is not rendered.
				iSeeTheSummaryAsText: function (sId, sSummary) {
					return this.waitFor({
						id: "pluginsTable",
						viewName: sView,
						check: function (oTable) {
							var oItem = itemOf(oTable, sId);
							if (oTable.getBusy() || !oItem) return false;
							var oText = oItem.getCells()[0].getItems()[1];
							return oText.getText() === sSummary && !!oText.getDomRef() && oText.getDomRef().textContent === sSummary;
						},
						success: function () { Opa5.assert.ok(true, "The summary of " + sId + " is shown literally"); },
						errorMessage: "The summary of " + sId + " is not shown literally: " + sSummary
					});
				},
				// Exactly these toolbar actions are on, for whatever is selected.
				iSeeTheActionsOn: function (aOn) {
					var aLast = [];
					return this.waitFor({
						id: ACTION_BUTTONS,
						viewName: sView,
						enabled: false,
						check: function (aButtons) {
							aLast = aButtons.filter(function (oButton) { return oButton.getEnabled(); }).map(function (oButton) { return oButton.getId().split("--").pop(); });
							return aLast.slice().sort().join() === aOn.slice().sort().join();
						},
						success: function () { Opa5.assert.ok(true, "The actions on are: " + (aOn.join(", ") || "none")); },
						errorMessage: "Expected the actions " + aOn.join(", ") + " to be on (last seen: " + aLast.join(", ") + ")"
					});
				},
				iSeeNoRow: function (sId) {
					return this.waitFor({
						id: "pluginsTable",
						viewName: sView,
						check: function (oTable) { return !oTable.getBusy() && !itemOf(oTable, sId); },
						success: function () { Opa5.assert.ok(true, "No row for plugin " + sId); },
						errorMessage: "There still is a row for plugin " + sId
					});
				},
				iSeeTheBuiltinsTableAndUploadForm: function () {
					return this.waitFor({
						id: ["builtinsTable", "uploadForm", "settingsHint"],
						viewName: sView,
						success: function () { Opa5.assert.ok(true, "The built-ins, the upload form and the settings hint are shown"); },
						errorMessage: "The built-ins table, the upload form or the settings hint is missing"
					});
				},
				// Which of the two status banners shows depends on the environment; the setting's banner is off in both.
				iSeeTheListAnsweredWithTheSettingOn: function () {
					return this.waitFor({
						id: "settingOffStrip",
						viewName: sView,
						visible: false,
						check: function (oStrip) { return oStrip.getModel("view").getProperty("/loaded") === true; },
						success: function (oStrip) {
							var oState = oStrip.getModel("view").getData();
							Opa5.assert.strictEqual(oStrip.getVisible(), false, "The setting is on, so no banner names it");
							Opa5.assert.strictEqual(oState.canUpload, true, "An upload can start");
						},
						errorMessage: "The list did not answer"
					});
				},
				iSeeTheDialogSaying: function (sText) {
					return this.waitFor({
						searchOpenDialogs: true,
						controlType: "sap.m.Text",
						matchers: function (oText) { return oText.getText().indexOf(sText) !== -1; },
						success: function () { Opa5.assert.ok(true, "A dialog says: " + sText); },
						errorMessage: "No dialog says: " + sText
					});
				}
			}
		}
	});
});
