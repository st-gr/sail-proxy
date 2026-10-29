sap.ui.define(["sap/fe/test/ObjectPage", "sap/ui/test/Opa5", "sap/ui/test/actions/Press", "sap/ui/test/matchers/PropertyStrictEquals"], function (ObjectPage, Opa5, Press, PropertyStrictEquals) {
	"use strict";

	// Raw values come from the page's binding context (the draft while editing, the active
	// row otherwise) - exact and independent of date formatting.
	function readStored(oLayout, sProperty) {
		var oContext = oLayout.getBindingContext();
		return oContext ? oContext.getProperty(sProperty) : undefined;
	}

	// FE renders form fields as sap.fe.macros.Field wrapping a sap.fe.macros.controls.FieldWrapper
	// (not sap.ui.mdc.Field, despite the SAP docs) - the FieldWrapper carries the editMode used to
	// pick its display vs. edit content control.
	function findMdcField(oFormElement) {
		return oFormElement.findAggregatedObjects(true, function (oControl) {
			return oControl.isA("sap.ui.mdc.Field") || oControl.isA("sap.fe.macros.controls.FieldWrapper");
		})[0];
	}

	return new ObjectPage({ appId: "admin.teams", componentId: "TeamsObjectPage", entitySet: "Teams" }, {
		actions: {
			// The Add Member dialog is a sap.m.TableSelectDialog fed from teamMemberCandidates(); pick one row by e-mail and confirm.
			iPickCandidate: function (sEmail) {
				return this.waitFor({
					controlType: "sap.m.ColumnListItem", searchOpenDialogs: true,
					matchers: function (oItem) { var oCtx = oItem.getBindingContext(); return !!oCtx && oCtx.getProperty("email") === sEmail; },
					actions: new Press(),
					success: function () {
						this.waitFor({ controlType: "sap.m.Button", searchOpenDialogs: true, matchers: new PropertyStrictEquals({ name: "text", value: "Add" }), actions: new Press(),
							success: function () { Opa5.assert.ok(true, "Picked " + sEmail + " and confirmed"); } });
					},
					errorMessage: "No candidate row for " + sEmail
				});
			}
		},
		assertions: {
			// MessageToast renders into the app frame's static area, outside any control tree OPA searches.
			iSeeMessageToast: function (sText) {
				return this.waitFor({
					check: function () {
						return Array.prototype.some.call(Opa5.getWindow().document.querySelectorAll(".sapMMessageToast"), function (e) { return e.textContent === sText; });
					},
					success: function () { Opa5.assert.ok(true, "Toast: " + sText); },
					errorMessage: "No toast reading '" + sText + "'"
				});
			},
			iSeeNoVisibleButton: function (sText) {
				return this.waitFor({ controlType: "sap.m.Button", visible: false,
					check: function (aButtons) { return !aButtons.some(function (b) { return b.getText() === sText && b.getVisible() && !!b.getDomRef(); }); },
					success: function () { Opa5.assert.ok(true, "No visible '" + sText + "' button"); },
					errorMessage: "A visible '" + sText + "' button is shown" });
			},
			// FE renders an action whose Core.OperationAvailable is false as a visible, disabled button.
			iSeeDisabledButton: function (sText) {
				return this.waitFor({ controlType: "sap.m.Button", visible: false,
					check: function (aButtons) { return aButtons.some(function (b) { return b.getText() === sText && b.getVisible() && !!b.getDomRef() && !b.getEnabled(); }); },
					success: function () { Opa5.assert.ok(true, "'" + sText + "' button is visible and disabled"); },
					errorMessage: "No visible, disabled '" + sText + "' button" });
			},
			iSeeStoredValue: function (sProperty, vExpected) {
				return this.waitFor({
					controlType: "sap.uxap.ObjectPageLayout",
					check: function (aLayouts) {
						return readStored(aLayouts[0], sProperty) === vExpected;
					},
					success: function () {
						Opa5.assert.ok(true, "Stored " + sProperty + " is " + JSON.stringify(vExpected));
					},
					errorMessage: "Stored " + sProperty + " never became " + JSON.stringify(vExpected)
				});
			},
			// A regex variant for values that are only known by shape (a timestamp just set by the
			// server), not by exact literal - e.g. quotaResetAt after Reset Quota.
			iSeeStoredValueMatching: function (sProperty, oPattern) {
				return this.waitFor({
					controlType: "sap.uxap.ObjectPageLayout",
					check: function (aLayouts) {
						var vValue = readStored(aLayouts[0], sProperty);
						return typeof vValue === "string" && oPattern.test(vValue);
					},
					success: function (aLayouts) {
						Opa5.assert.ok(true, "Stored " + sProperty + " (" + readStored(aLayouts[0], sProperty) + ") matches " + oPattern);
					},
					errorMessage: "Stored " + sProperty + " never matched " + oPattern
				});
			},
			// Field control decides the mdc Field's editMode: "Editable"/"EditableReadOnly"/... when
			// the role may change the field, "ReadOnly"/"Display" otherwise. Scoped to the form
			// container so a header-facet copy of the same property cannot be picked up.
			// Polled, not asserted on the first match: SideEffects re-render the field, so the
			// edit mode can still be the pre-refresh one when the form element first appears.
			iSeeFieldEditability: function (sFieldGroup, sProperty, bEditable) {
				var sLastMode = "<never rendered>";
				return this.waitFor({
					controlType: "sap.ui.layout.form.FormElement",
					id: new RegExp("FormContainer::FieldGroup::" + sFieldGroup + "::FormElement::DataField::" + sProperty + "$"),
					check: function (aElements) {
						var oField = findMdcField(aElements[0]);
						if (!oField) {
							sLastMode = "<no mdc field>";
							return false;
						}
						sLastMode = oField.getEditMode();
						return /^Editable/.test(sLastMode) === bEditable;
					},
					success: function () {
						Opa5.assert.ok(true,
							sProperty + " edit mode is '" + sLastMode + "' (editable expected: " + bEditable + ")");
					},
					errorMessage: "Field " + sProperty + " in field group " + sFieldGroup +
						" never reached editable=" + bEditable + " (last edit mode: '" + sLastMode + "')"
				});
			},
			// The "Usage charts" custom section draws one macros:MicroChart per UI.Chart #Bullet
			// qualifier, each of which ends up as a sap.suite.ui.microchart.BulletMicroChart.
			// One bullet chart per budget window that has an effective limit (the "Usage charts"
			// section draws nothing for an unlimited window); the expected count comes from the
			// page's own binding context unless the caller pins a number.
			iSeeBulletCharts: function (nExpected) {
				var aLimits = ["effectiveSpendPerDay", "effectiveSpendPerWeek", "effectiveSpendPerMonth", "effectiveTokensPerDay", "effectiveTokensPerWeek", "effectiveTokensPerMonth"];
				var nWanted = nExpected;
				return this.waitFor({
					controlType: "sap.uxap.ObjectPageLayout",
					check: function (aLayouts) {
						if (nExpected === undefined) {
							nWanted = aLimits.filter(function (sProperty) { var v = readStored(aLayouts[0], sProperty); return v !== null && v !== undefined; }).length;
						}
						return aLayouts[0].findAggregatedObjects(true, function (oControl) {
							return oControl.isA("sap.suite.ui.microchart.BulletMicroChart") && oControl.getVisible() && oControl.getDomRef();
						}).length === nWanted;
					},
					success: function () { Opa5.assert.ok(true, nWanted + " bullet chart(s) rendered, one per limited window"); },
					errorMessage: "The number of bullet charts does not match the user's limited windows"
				});
			}
		}
	});
});
