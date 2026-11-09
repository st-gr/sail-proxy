sap.ui.define([
	"sap/ui/test/Opa5",
	"sap/ui/test/actions/Press",
	"sap/ui/test/actions/EnterText"
], function (Opa5, Press, EnterText) {
	"use strict";

	var sView = "Detail"; // admin.modellibrary.view.Detail (viewNamespace is set in opaTests.qunit.js)

	// Edit price and Revert sit in an HBox that carries the role gate (visible="{viewModel>/isAdmin}"),
	// so the buttons' own `visible` property says nothing about what the role sees - walk the parents.
	function isEffectivelyVisible(oControl) {
		for (var oNode = oControl; oNode; oNode = oNode.getParent()) {
			if (typeof oNode.getVisible === "function" && !oNode.getVisible()) {
				return false;
			}
		}
		return true;
	}

	// whoami resolves asynchronously (model/session.ts) and fills /isAdmin and /email together,
	// so a role assertion is only meaningful once /email is set - otherwise "hidden" would pass
	// for the admin as well, simply because the answer had not arrived yet.
	function sessionResolved(oControl) {
		var oViewModel = oControl.getModel("viewModel");
		return !!oViewModel && !!oViewModel.getProperty("/email");
	}

	Opa5.createPageObjects({
		onTheDetail: {
			actions: {
				iPressEditPrice: function () {
					return this.waitFor({ id: "editPriceButton", viewName: sView, actions: new Press() });
				},
				// The price dialog is loaded with the view as owner (Fragment.load({ id: view.getId() })),
				// so its controls answer to the view-relative ids used here.
				iEnterPrices: function (sIn, sOut, sImageOut, sAudioIn, sAudioOut) {
					return this.waitFor({
						id: "priceInput",
						viewName: sView,
						actions: new EnterText({ text: sIn }),
						success: function () {
							this.waitFor({
								id: "priceOutput",
								viewName: sView,
								actions: new EnterText({ text: sOut }),
								success: function () {
									if (sImageOut !== undefined) {
										this.waitFor({
											id: "priceImageOutput",
											viewName: sView,
											actions: new EnterText({ text: sImageOut }),
											success: function () {
												if (sAudioIn !== undefined) {
													this.waitFor({
														id: "priceAudioInput",
														viewName: sView,
														actions: new EnterText({ text: sAudioIn }),
														success: function () {
															if (sAudioOut !== undefined) {
																this.waitFor({ id: "priceAudioOutput", viewName: sView, actions: new EnterText({ text: sAudioOut }) });
															}
														}
													});
												}
											}
										});
									}
								}
							});
						}
					});
				},
				iSavePrice: function () {
					return this.waitFor({ id: "priceSave", viewName: sView, actions: new Press() });
				},
				iPressRevert: function () {
					return this.waitFor({ id: "revertPriceButton", viewName: sView, actions: new Press() });
				}
			},
			assertions: {
				iSeeTheObjectPage: function () {
					return this.waitFor({
						id: "objectPage",
						viewName: sView,
						success: function () {
							Opa5.assert.ok(true, "detail page shown");
						},
						errorMessage: "the detail page never rendered"
					});
				},
				iSeeCostRowsWithOperands: function () {
					return this.waitFor({
						id: "costTable",
						viewName: sView,
						check: function (oTable) {
							return oTable.getItems().length > 0;
						},
						success: function (oTable) {
							// cells: [direction, VBox(value, operands bracket), SAP price]
							var sText = oTable.getItems()[0].getCells()[1].getItems()[1].getText();
							// costDisplay.operandsBracket: "(<cost per 1K> per 1K <multiplication sign> <cuFactor>)"
							// - the escape rather than the literal sign, so the check cannot depend on how
							// the browser decodes this file.
							Opa5.assert.ok(/^\(.+ per 1K \u00d7 .+\)$/.test(sText), "operands bracket shown: " + sText);
						},
						errorMessage: "no cost rows"
					});
				},
				iSeeTheConfigurationSection: function () {
					return this.waitFor({
						id: "secConfiguration",
						viewName: sView,
						success: function () {
							Opa5.assert.ok(true, "configuration section present");
						},
						errorMessage: "the configuration section is missing"
					});
				},
				iSeeAdminActions: function (bExpected) {
					return this.waitFor({
						id: "editPriceButton",
						viewName: sView,
						visible: false,
						check: function (oButton) {
							return sessionResolved(oButton) && isEffectivelyVisible(oButton) === bExpected;
						},
						success: function (oButton) {
							Opa5.assert.strictEqual(isEffectivelyVisible(oButton), bExpected,
								"Edit price visibility matches the role");
							this.waitFor({
								id: "deployButton",
								viewName: sView,
								visible: false,
								check: function (oDeploy) {
									return !!oDeploy.getBindingContext();
								},
								success: function (oDeploy) {
									// Deploy is bound to isAdmin AND accessType eq 'foundation' AND not already
									// deployed (the gateway lists a live deployment sibling) - so the role
									// expectation is narrowed by the model that is actually on screen.
									var oContext = oDeploy.getBindingContext();
									var bDeployed = !!oDeploy.getModel("viewModel").getProperty("/detail/deployed");
									var bDeploy = bExpected && !!oContext &&
										oContext.getProperty("accessType") === "foundation" && !bDeployed;
									Opa5.assert.strictEqual(isEffectivelyVisible(oDeploy), bDeploy,
										"Deploy visibility matches the role");
								}
							});
						},
						errorMessage: "Edit price visibility never became " + bExpected + " for this role"
					});
				},
				// Waits for a costTable row whose direction label (cell 0, a sap.m.Text) equals sLabel.
				iSeeCostRow: function (sLabel) {
					return this.waitFor({
						id: "costTable",
						viewName: sView,
						check: function (oTable) {
							return oTable.getItems().some(function (oItem) {
								return oItem.getCells()[0].getText() === sLabel;
							});
						},
						success: function () {
							Opa5.assert.ok(true, "cost row shown: " + sLabel);
						},
						errorMessage: "no cost row labelled " + sLabel
					});
				},
				iSeeManualPrice: function (bExpected) {
					return this.waitFor({
						id: "revertPriceButton",
						viewName: sView,
						visible: false,
						check: function (oButton) {
							return oButton.getVisible() === bExpected;
						},
						success: function () {
							Opa5.assert.ok(true, bExpected ? "manual price active" : "SAP price active");
						},
						errorMessage: "manual price state did not become " + bExpected
					});
				}
			}
		}
	});
});
