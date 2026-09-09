sap.ui.define(["sap/fe/test/ObjectPage", "sap/ui/test/Opa5"], function (ObjectPage, Opa5) {
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

	return new ObjectPage({ appId: "admin.users", componentId: "UsersObjectPage", entitySet: "Users" }, {
		assertions: {
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
			}
		}
	});
});
