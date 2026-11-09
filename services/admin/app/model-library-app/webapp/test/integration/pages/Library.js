sap.ui.define([
	"sap/ui/test/Opa5",
	"sap/ui/test/actions/Press",
	"sap/ui/test/actions/EnterText"
], function (Opa5, Press, EnterText) {
	"use strict";

	var sView = "Library"; // admin.modellibrary.view.Library (viewNamespace is set in opaTests.qunit.js)

	// The grid is an aggregation binding without paging, so the OData V4 list binding reads at
	// most the model's size limit (sap.ui.model.Model: 100) however many rows the server counts.
	// The card assertions therefore compare against the clamped number, the count title against
	// the server count.
	function renderedCards(oGrid, iExpected) {
		var oModel = oGrid.getModel();
		return Math.min(iExpected, (oModel && oModel.iSizeLimit) || 100);
	}

	// Remembered by iSeeCards so iSeeFewerCardsThan compares against what was really rendered.
	var iLastCardCount = null;

	Opa5.createPageObjects({
		onTheLibrary: {
			actions: {
				iSelectCapability: function (iIndex) {
					return this.waitFor({
						id: "capabilityGroup",
						viewName: sView,
						success: function (oGroup) {
							oGroup.setSelectedIndex(iIndex);
							oGroup.fireSelect({ selectedIndex: iIndex });
						}
					});
				},
				iTickProvisioning: function (sId) {
					return this.waitFor({ id: sId, viewName: sView, actions: new Press() });
				},
				iSearchFor: function (sText) {
					return this.waitFor({
						id: "searchField",
						viewName: sView,
						actions: new EnterText({ text: sText, pressEnterKey: true })
					});
				},
				iSwitchMode: function (sKey) {
					return this.waitFor({
						id: "modeButton",
						viewName: sView,
						success: function (oSb) {
							oSb.setSelectedKey(sKey);
							oSb.fireSelectionChange({
								item: oSb.getItems().filter(function (oItem) {
									return oItem.getKey() === sKey;
								})[0]
							});
						}
					});
				},
				iPressTheFirstCard: function () {
					return this.waitFor({
						id: "grid",
						viewName: sView,
						check: function (oGrid) {
							return oGrid.getItems().length > 0;
						},
						success: function (oGrid) {
							oGrid.getItems()[0].firePress();
						},
						errorMessage: "the grid never rendered a card to press"
					});
				}
			},
			assertions: {
				iSeeTheCount: function (iExpected) {
					return this.waitFor({
						id: "modelsCount",
						viewName: sView,
						check: function (oTitle) {
							return oTitle.getText() === "Models (" + iExpected + ")";
						},
						success: function (oTitle) {
							Opa5.assert.strictEqual(oTitle.getText(), "Models (" + iExpected + ")", "count matches");
						},
						errorMessage: "count never became " + iExpected
					});
				},
				iSeeCards: function (iExpected) {
					return this.waitFor({
						id: "grid",
						viewName: sView,
						check: function (oGrid) {
							return oGrid.getItems().length === renderedCards(oGrid, iExpected);
						},
						success: function (oGrid) {
							iLastCardCount = oGrid.getItems().length;
							Opa5.assert.strictEqual(iLastCardCount, renderedCards(oGrid, iExpected),
								iLastCardCount + " cards rendered");
						},
						errorMessage: "grid did not render " + iExpected + " cards"
					});
				},
				iSeeFewerCardsThan: function (iBefore) {
					// iLastCardCount is only filled once the preceding iSeeCards has run, and a
					// waitFor body runs long after the journey queued it - so read it in the check,
					// never here.
					var iReference = iBefore;
					return this.waitFor({
						id: "grid",
						viewName: sView,
						check: function (oGrid) {
							iReference = iLastCardCount === null ? iBefore : Math.min(iBefore, iLastCardCount);
							var iNow = oGrid.getItems().length;
							return iNow > 0 && iNow < iReference;
						},
						success: function (oGrid) {
							Opa5.assert.ok(true, "filter narrowed to " + oGrid.getItems().length + " of " + iReference);
						},
						errorMessage: "filter did not narrow the grid below the " + iBefore + " cards seen before"
					});
				},
				iSeeTheLeaderboardWithScores: function () {
					return this.waitFor({
						id: "leaderboard",
						viewName: sView,
						check: function (oTable) {
							return oTable.getVisible() && oTable.getColumns().length > 1;
						},
						success: function (oTable) {
							Opa5.assert.ok(oTable.getColumns().length > 1,
								"leaderboard has " + (oTable.getColumns().length - 1) + " benchmark column(s)");
						},
						errorMessage: "the leaderboard never got a benchmark column"
					});
				},
				iSeeTheChart: function () {
					return this.waitFor({
						id: "chart",
						viewName: sView,
						check: function (oChart) {
							return oChart.getVisible() && !!oChart.getDomRef() &&
								oChart.getDomRef().querySelector("svg circle") !== null;
						},
						success: function () {
							Opa5.assert.ok(true, "chart rendered bubbles");
						},
						errorMessage: "chart rendered no bubbles"
					});
				},
				// visible: false - the button is hidden for a non-admin, and OPA must still find it
				// so a removed or renamed button fails instead of passing as "not visible".
				// The check polls because whoami (model/session.ts) fills /isAdmin and /email
				// asynchronously: asserting straight away would read the pre-role state.
				iSeeTheRefreshButton: function (bVisible) {
					return this.waitFor({
						id: "refreshButton",
						viewName: sView,
						visible: false,
						check: function (oButton) {
							var oViewModel = oButton.getModel("viewModel");
							return !!oViewModel && !!oViewModel.getProperty("/email") &&
								oButton.getVisible() === bVisible;
						},
						success: function (oButton) {
							Opa5.assert.strictEqual(oButton.getVisible(), bVisible,
								"Refresh button visibility matches the role");
						},
						errorMessage: "Refresh button visibility never became " + bVisible + " for this role"
					});
				}
			}
		}
	});
});
