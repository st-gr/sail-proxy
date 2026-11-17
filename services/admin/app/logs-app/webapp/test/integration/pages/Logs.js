sap.ui.define([
	"sap/ui/test/Opa5",
	"sap/ui/test/actions/Press"
], function (Opa5, Press) {
	"use strict";

	var LOG = "GatewayLog";            // admin.logs.view.GatewayLog
	var SETTINGS = "LoggingSettings";  // admin.logs.view.LoggingSettings
	var TRACES = "PayloadTraces";      // admin.logs.view.PayloadTraces (and its dialogs, loaded with the view's id)
	var COLUMNS = ["Date and time", "Level", "Component", "Request ID", "Message"];
	var TRACE_COLUMNS = ["Date and time", "Route", "Model", "API key and user", "Status", "Duration", "Content"];

	var aRemembered = [];   // { key, at } of the rows shown before Delete now was pressed
	function rowKey(oRow) { return oRow.ID + "|" + oRow.timeText + "|" + oRow.messageText; }
	function keyedRow(oRow) { return { key: rowKey(oRow), at: Date.parse(oRow.loggedAt) }; }
	// The remembered rows that are shown in oTable now (the same comparison as shownAfter in model/deleteNow.ts).
	function rememberedShown(oTable) {
		var aNow = rowsOf(oTable).map(rowKey);
		return aRemembered.filter(function (oRow) { return aNow.indexOf(oRow.key) !== -1; });
	}
	// The remembered rows that are missing (missingWithinWindow in model/deleteNow.ts): a remembered row that is not shown
	// counts, unless the view is full (it holds the app's row limit, the model's /limit) and the row is not newer than the
	// oldest row shown now, so newer entries may have pushed it out.
	function missingWithinWindow(oTable) {
		var aShown = rowsOf(oTable).map(keyedRow);
		var bFull = aShown.length >= logModel(oTable).getProperty("/limit");
		var iOldest = Infinity;
		aShown.forEach(function (oRow) { if (oRow.at < iOldest) { iOldest = oRow.at; } });
		var aNow = aShown.map(function (oRow) { return oRow.key; });
		return aRemembered.filter(function (oRow) { return aNow.indexOf(oRow.key) === -1 && !(bFull && oRow.at <= iOldest); })
			.map(function (oRow) { return oRow.key; });
	}
	function logModel(oControl) { return oControl.getModel("log"); }
	function formModel(oControl) { return oControl.getModel("form"); }
	function tracesModel(oControl) { return oControl.getModel("traces"); }
	// Controls found in an open dialog do not come back in the order of their ids: pick each by its id.
	function byId(aControls, sId) {
		return aControls.filter(function (oControl) { return oControl.getId().split("--").pop() === sId; })[0];
	}
	function rowsOf(oTable) { return logModel(oTable).getProperty("/entries"); }
	function componentRow(oTable, sName) {
		return oTable.getItems().filter(function (oItem) { return oItem.getBindingContext("form").getObject().component === sName; })[0];
	}

	Opa5.createPageObjects({
		onTheLogs: {
			actions: {
				iPress: function (sId) {
					return this.waitFor({ id: sId, viewName: LOG, actions: new Press(), errorMessage: "Cannot press " + sId });
				},
				iChooseTheOrder: function (sKey) {
					return this.waitFor({
						id: "orderButton",
						viewName: LOG,
						success: function (oButton) {
							oButton.setSelectedKey(sKey);
							oButton.fireSelectionChange({ item: oButton.getItems().filter(function (oItem) { return oItem.getKey() === sKey; })[0] });
						},
						errorMessage: "No order toggle"
					});
				},
				iSearchFor: function (sText) {
					return this.waitFor({
						id: "searchField",
						viewName: LOG,
						success: function (oSearch) {
							oSearch.setValue(sText);
							oSearch.fireSearch({ query: sText });
						},
						errorMessage: "No search field"
					});
				},
				iChooseTheLevel: function (sLevel) {
					return this.waitFor({
						id: "levelSelect",
						viewName: LOG,
						success: function (oSelect) {
							oSelect.setSelectedKey(sLevel);
							oSelect.fireChange({ selectedItem: oSelect.getSelectedItem() });
						},
						errorMessage: "No level filter"
					});
				},
				// Remembers the rows the table shows now (after it has loaded), to compare with after the delete or the Cancel.
				iRememberTheRows: function () {
					return this.waitFor({
						id: "logTable",
						viewName: LOG,
						check: function (oTable) { return !oTable.getBusy() && logModel(oTable).getProperty("/footerText") !== ""; },
						success: function (oTable) {
							aRemembered = rowsOf(oTable).map(keyedRow);
							Opa5.assert.ok(true, aRemembered.length + " rows remembered");
						},
						errorMessage: "The log table did not load"
					});
				},
				iOpenTheSettingsTab: function () {
					return this.waitFor({ id: "settingsTab", viewName: "Logs", actions: new Press(), errorMessage: "No Switches and levels tab" });
				},
				iAddTheComponentLevel: function (sName, sLevel, sDuration) {
					this.waitFor({ id: "addComponentButton", viewName: SETTINGS, actions: new Press(), errorMessage: "No Add button" });
					return this.waitFor({
						id: "componentsTable",
						viewName: SETTINGS,
						check: function (oTable) { return oTable.getItems().length > 0; },
						success: function (oTable) {
							var aCells = oTable.getItems()[oTable.getItems().length - 1].getCells();
							aCells[0].setValue(sName);
							aCells[1].setSelectedKey(sLevel);
							aCells[2].getItems()[0].setSelectedKey(sDuration);
							aCells[2].getItems()[0].fireChange({ selectedItem: aCells[2].getItems()[0].getSelectedItem() });
						},
						errorMessage: "The new component row is missing"
					});
				},
				iPressSettings: function (sId) {
					// Save, Reset to configuration and Cancel are in the Logs page's footer.
					var bFooter = ["saveSettingsButton", "resetSettingsButton", "cancelSettingsButton"].indexOf(sId) >= 0;
					return this.waitFor({ id: sId, viewName: bFooter ? "Logs" : SETTINGS, actions: new Press(), errorMessage: "Cannot press " + sId });
				},
				iOpenTheTracesTab: function () {
					return this.waitFor({ id: "payloadTracesTab", viewName: "Logs", actions: new Press(), errorMessage: "No Payload traces tab" });
				},
				iPressTraces: function (sId) {
					return this.waitFor({ id: sId, viewName: TRACES, actions: new Press(), errorMessage: "Cannot press " + sId });
				},
				iPressInTheStartDialog: function (sId) {
					return this.waitFor({ id: sId, viewName: TRACES, searchOpenDialogs: true, actions: new Press(), errorMessage: "Cannot press " + sId });
				},
				iEnterTheAddresses: function (sText) {
					return this.waitFor({
						id: "rawCaptureEmails",
						viewName: TRACES,
						searchOpenDialogs: true,
						success: function (oArea) { oArea.setValue(sText); oArea.fireChange({ value: sText }); },
						errorMessage: "No e-mail addresses field"
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
				// The columns and the filter bar; every row that is there shows a date and a time with milliseconds.
				iSeeTheLogTableAndFilters: function () {
					this.waitFor({
						id: ["fromPicker", "toPicker", "last15Button", "lastHourButton", "todayButton", "searchField", "levelSelect", "exportButton", "timeZoneText"],
						viewName: LOG,
						success: function () { Opa5.assert.ok(true, "The time range, the quick buttons, the search, the level and the export are there"); },
						errorMessage: "A filter control is missing"
					});
					return this.waitFor({
						id: "logTable",
						viewName: LOG,
						check: function (oTable) { return !oTable.getBusy() && logModel(oTable).getProperty("/footerText") !== ""; },
						success: function (oTable) {
							var aLabels = oTable.getColumns().map(function (oColumn) { return oColumn.getLabel().getText(); });
							Opa5.assert.deepEqual(aLabels, COLUMNS, "The columns are " + COLUMNS.join(", "));
							var aBad = rowsOf(oTable).filter(function (oRow) { return !/\d{4}/.test(oRow.timeText) || !/\d{2}:\d{2}:\d{2}\.\d{3}/.test(oRow.timeText); });
							Opa5.assert.strictEqual(aBad.length, 0, rowsOf(oTable).length + " rows, each with a date and a time with milliseconds");
						},
						errorMessage: "The log table did not load"
					});
				},
				iSeeTheView: function (oExpected) {
					var oLast = {};
					return this.waitFor({
						id: "logTable",
						viewName: LOG,
						check: function (oTable) {
							var oData = logModel(oTable).getData();
							oLast = { live: oData.live, order: oData.order, fromLocal: oData.fromLocal, busy: oTable.getBusy() };
							if (oTable.getBusy()) return false;
							return Object.keys(oExpected).every(function (sKey) {
								return sKey === "hasRange" ? (oData.fromLocal !== "") === oExpected.hasRange : oData[sKey] === oExpected[sKey];
							});
						},
						success: function () { Opa5.assert.ok(true, "The view shows " + JSON.stringify(oExpected)); },
						errorMessage: "The view does not show " + JSON.stringify(oExpected) + " (last seen: " + JSON.stringify(oLast) + ")"
					});
				},
				// What the Live button and the status line beside the table say, in words.
				iSeeLiveSaying: function (bPressed, sButtonText, sStatusText) {
					var sLast = "";
					return this.waitFor({
						id: ["liveButton", "liveStatusText"],
						viewName: LOG,
						check: function (aControls) {
							sLast = aControls[0].getPressed() + " / " + aControls[0].getText() + " / " + aControls[1].getText();
							return aControls[0].getPressed() === bPressed && aControls[0].getText() === sButtonText && aControls[1].getText() === sStatusText;
						},
						success: function () { Opa5.assert.ok(true, "Live shows: " + sLast); },
						errorMessage: "Live does not show " + bPressed + " / " + sButtonText + " / " + sStatusText + " (last seen: " + sLast + ")"
					});
				},
				iSeeOnlyRowsAtLevels: function (aLevels) {
					return this.waitFor({
						id: "logTable",
						viewName: LOG,
						check: function (oTable) { return !oTable.getBusy(); },
						success: function (oTable) {
							var aOther = rowsOf(oTable).filter(function (oRow) { return aLevels.indexOf(oRow.level) === -1; });
							Opa5.assert.strictEqual(aOther.length, 0, "Every row is at " + aLevels.join(" or "));
						},
						errorMessage: "The log table did not answer"
					});
				},
				// The delete confirmation: its text says what goes, that it cannot be undone and that Cancel is the default.
				iSeeTheDeleteConfirmation: function () {
					return this.waitFor({
						searchOpenDialogs: true,
						controlType: "sap.m.Dialog",
						success: function (aDialogs) {
							var oDialog = aDialogs[0];
							var sText = oDialog.getContent().map(function (oControl) { return oControl.getText ? oControl.getText() : ""; }).join(" ");
							Opa5.assert.ok(/all stored entries of the gateway log/i.test(sText) && /cannot be undone/.test(sText) && /new entries/.test(sText), "The pop-up says what is deleted: " + sText);
							var oCancel = oDialog.getButtons().filter(function (oButton) { return oButton.getText() === "Cancel"; })[0];
							var vFocus = oDialog.getInitialFocus();
							Opa5.assert.ok(vFocus === oCancel.getId() || vFocus === oCancel, "Cancel has the initial focus");
						},
						errorMessage: "The delete confirmation did not open"
					});
				},
				// After a confirmed delete: the message names a number, the table is not busy, the button can be used again and
				// none of the remembered rows is shown (entries that arrived after the delete may be).
				iSeeTheDeleteDone: function () {
					var sLast = "";
					return this.waitFor({
						id: ["deleteResultStrip", "logTable", "deleteNowButton"],
						viewName: LOG,
						check: function (aControls) {
							sLast = aControls[0].getText() + " / still shown: " + rememberedShown(aControls[1]).length;
							return !aControls[1].getBusy() && aControls[0].getVisible() && aControls[2].getEnabled() && rememberedShown(aControls[1]).length === 0;
						},
						success: function (aControls) {
							Opa5.assert.ok(/^(No stored entries were there to delete\.|One entry was deleted\.|[\d.,\s\u00a0\u202f]+ entries were deleted\.)$/.test(aControls[0].getText()), "The message reports the count: " + aControls[0].getText());
						},
						errorMessage: "The delete did not finish with a message and without the remembered rows (last seen: " + sLast + ")"
					});
				},
				// The stored rows are still there (a cancelled delete changes nothing): the message strip stays hidden, and every
				// remembered row is shown, except, in a full view, rows not newer than its oldest row (pushed out by new entries).
				iSeeNothingDeleted: function () {
					return this.waitFor({
						id: ["deleteResultStrip", "deleteNowButton", "logTable"],
						viewName: LOG,
						visible: false,   // the message strip is not rendered while it has no message
						success: function (aControls) {
							Opa5.assert.ok(!aControls[0].getVisible() && aControls[1].getEnabled(), "No message, and the button can be pressed");
							Opa5.assert.deepEqual(missingWithinWindow(aControls[2]), [], "No remembered row is missing, apart from rows pushed out of a full view (" + rememberedShown(aControls[2]).length + " of " + aRemembered.length + ")");
						},
						errorMessage: "A cancelled delete changed the page"
					});
				},
				iSeeNoRows: function () {
					return this.waitFor({
						id: "logTable",
						viewName: LOG,
						check: function (oTable) { return !oTable.getBusy() && rowsOf(oTable).length === 0 && logModel(oTable).getProperty("/loadError") === ""; },
						success: function () { Opa5.assert.ok(true, "No row matches"); },
						errorMessage: "Rows are shown for a search that matches nothing"
					});
				},
				// Before a range is chosen the list asks for one, and the bar says whether payload capture is on.
				iSeeTheTracesAskForARange: function () {
					var sLast = "";
					return this.waitFor({
						id: ["tracesTable", "captureStrip", "tracesFromPicker", "tracesToPicker", "tracesLast15Button", "tracesTodayButton", "tracesSearchField", "startRawCaptureButton"],
						viewName: TRACES,
						check: function (aControls) {
							var oTable = byId(aControls, "tracesTable");
							var sBar = byId(aControls, "captureStrip").getText();
							sLast = oTable.getNoDataText() + " / " + sBar;
							return oTable.getItems().length === 0 && /^Choose a time range/.test(oTable.getNoDataText()) && /^Payload capture is (on|off)/.test(sBar);
						},
						success: function () { Opa5.assert.ok(true, "The list asks for a time range: " + sLast); },
						errorMessage: "The Payload traces tab does not ask for a time range (last seen: " + sLast + ")"
					});
				},
				// After a quick range: the read has answered without an error, every row shows a date and a time, and an empty list says so.
				iSeeTheTracesOfTheRange: function () {
					var sLast = "";
					return this.waitFor({
						id: "tracesTable",
						viewName: TRACES,
						check: function (oTable) {
							var oData = tracesModel(oTable).getData();
							sLast = oData.noDataText + " / " + oData.footerText + " / " + oData.loadError;
							return !oTable.getBusy() && oData.footerText !== "" && oData.loadError === "";
						},
						success: function (oTable) {
							var aLabels = oTable.getColumns().map(function (oColumn) { return oColumn.getHeader().getText(); });
							Opa5.assert.deepEqual(aLabels, TRACE_COLUMNS, "The columns are " + TRACE_COLUMNS.join(", "));
							var aRows = tracesModel(oTable).getProperty("/rows");
							var aBad = aRows.filter(function (oRow) { return !/\d{4}/.test(oRow.timeText) || !/\d{2}:\d{2}:\d{2}/.test(oRow.timeText); });
							Opa5.assert.strictEqual(aBad.length, 0, aRows.length + " rows, each with a date and a time");
							if (aRows.length === 0) {
								Opa5.assert.ok(/^No payload traces in this time range/.test(oTable.getNoDataText()), "The empty list says so: " + oTable.getNoDataText());
							}
						},
						errorMessage: "The traces of the range did not load (last seen: " + sLast + ")"
					});
				},
				// The dialog says that keys created later are not included, and the reason is marked as required.
				iSeeTheStartDialog: function () {
					return this.waitFor({
						id: ["startRawCaptureDialog", "rawCaptureInfoStrip", "rawCaptureReasonLabel", "rawCaptureKeys", "rawCaptureMinutes"],
						viewName: TRACES,
						searchOpenDialogs: true,
						success: function (aControls) {
							var sInfo = byId(aControls, "rawCaptureInfoStrip").getText();
							Opa5.assert.ok(/Keys created after the start are not included/.test(sInfo), "The dialog says what it includes: " + sInfo);
							Opa5.assert.ok(byId(aControls, "rawCaptureReasonLabel").getRequired(), "The reason is marked as required");
							Opa5.assert.strictEqual(byId(aControls, "rawCaptureMinutes").getSelectedKey(), "60", "The duration starts at 1 hour");
						},
						errorMessage: "The start dialog did not open"
					});
				},
				iSeeThatAReasonIsRequired: function () {
					return this.waitFor({
						id: ["rawCaptureReason", "startRawCaptureDialog"],
						viewName: TRACES,
						searchOpenDialogs: true,
						check: function (aControls) { return byId(aControls, "rawCaptureReason").getValueState() === "Error"; },
						success: function (aControls) {
							Opa5.assert.strictEqual(byId(aControls, "rawCaptureReason").getValueStateText(), "Enter the reason for the capture.", "The reason field says that a reason is needed");
							Opa5.assert.ok(byId(aControls, "startRawCaptureDialog").isOpen(), "Nothing was started: the dialog stays open");
						},
						errorMessage: "A start without a reason was not refused at the reason field"
					});
				},
				iSeeTheStartDialogClosed: function () {
					return this.waitFor({
						id: "startRawCaptureDialog",
						viewName: TRACES,
						visible: false,
						check: function (oDialog) { return !oDialog.isOpen(); },
						success: function () { Opa5.assert.ok(true, "Cancel closed the dialog"); },
						errorMessage: "The start dialog is still open"
					});
				},
				iSeeTheSettingsControls: function () {
					this.waitFor({
						id: ["storageSelect", "captureSelect", "defaultLevelSelect", "componentsTable"],
						viewName: SETTINGS,
						check: function (aControls) { return formModel(aControls[0]).getProperty("/loaded") === true; },
						success: function (aControls) {
							var firstItem = function (oSelect) { return oSelect.getItems()[0].getText(); };
							Opa5.assert.ok(firstItem(aControls[0]).indexOf("As configured (") === 0, "Storing offers the configured value first: " + firstItem(aControls[0]));
							Opa5.assert.ok(firstItem(aControls[1]).indexOf("As configured (") === 0, "Payload traces offer the configured value first: " + firstItem(aControls[1]));
							Opa5.assert.deepEqual(aControls[1].getItems().map(function (oItem) { return oItem.getKey(); }), ["config", "on", "off"], "Payload traces: as configured, on, off");
							Opa5.assert.ok(firstItem(aControls[2]).indexOf("As configured (") === 0, "The default level offers the configured value first: " + firstItem(aControls[2]));
						},
						errorMessage: "The settings did not load"
					});
					// The duration shows only for a default level set here; Save and Cancel wait for a change.
					this.waitFor({
						id: "defaultDurationSelect",
						viewName: SETTINGS,
						visible: false,
						check: function (oSelect) { return !oSelect.getDomRef(); },   // its form element is hidden: not rendered
						success: function () { Opa5.assert.ok(true, "No duration while the default level follows the configuration"); },
						errorMessage: "The duration shows for a level that follows the configuration"
					});
					return this.waitFor({
						id: ["saveSettingsButton", "resetSettingsButton", "cancelSettingsButton"],
						viewName: "Logs",
						enabled: false,
						success: function (aButtons) {
							Opa5.assert.strictEqual(aButtons[0].getEnabled(), false, "Save waits for a change");
							Opa5.assert.strictEqual(aButtons[2].getEnabled(), false, "Cancel waits for a change");
							Opa5.assert.strictEqual(aButtons[1].getEnabled(), true, "Reset to configuration is there");
						},
						errorMessage: "The footer of the settings is missing"
					});
				},
				iSeeTheComponentLevel: function (sName, bThere) {
					return this.waitFor({
						id: "componentsTable",
						viewName: SETTINGS,
						check: function (oTable) {
							if (formModel(oTable).getProperty("/busy")) return false;
							var oItem = componentRow(oTable, sName);
							if (!bThere) return !oItem;
							var oRow = oItem && oItem.getBindingContext("form").getObject();
							return !!oRow && oRow.duration === "keep" && oRow.endsText !== "";
						},
						success: function () { Opa5.assert.ok(true, bThere ? sName + " has its level, with the time it ends" : "No level for " + sName); },
						errorMessage: bThere ? sName + " was not saved with a time limit" : sName + " is still there"
					});
				}
			}
		}
	});
});
