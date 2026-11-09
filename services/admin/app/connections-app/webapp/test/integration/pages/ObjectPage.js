sap.ui.define(["sap/fe/test/ObjectPage", "sap/ui/test/Opa5"], function (ObjectPage, Opa5) {
	"use strict";

	// Raw values come from the page's binding context (the draft while editing, the active
	// row otherwise) - exact and independent of formatting.
	function readStored(oLayout, sProperty) {
		var oContext = oLayout.getBindingContext();
		return oContext ? oContext.getProperty(sProperty) : undefined;
	}

	// The one place that knows FE's internal id of a form element: "…FormContainer::<facet id>::FormElement::
	// DataField::<property>", as sap.fe.templates' ObjectPage renders it in SAPUI5 1.136 (ui5.yaml 1.136.22).
	// FE does not promise this scheme; when an upgrade changes it, this helper is the only thing to adapt.
	function formElementId(sFacetId, sProperty) {
		return new RegExp("FormContainer::" + sFacetId + "::FormElement::DataField::" + sProperty + "$");
	}

	// The form elements of one property in the Endpoint section's form, shown or not.
	function endpointElements(sProperty) {
		return { controlType: "sap.ui.layout.form.FormElement", visible: false, id: formElementId("endpoint", sProperty) };
	}

	// A section of the page by its facet id ("…FacetSection::<facet id>"), shown or not.
	function section(sFacetId) {
		return { controlType: "sap.uxap.ObjectPageSection", visible: false, id: new RegExp("FacetSection::" + sFacetId + "$") };
	}

	// A custom header action by its manifest key ("…CustomAction::<key>"), shown or not.
	function headerAction(sKey) {
		return { controlType: "sap.m.Button", visible: false, id: new RegExp("CustomAction::" + sKey + "$") };
	}

	return new ObjectPage({ appId: "admin.connections", componentId: "ConnectionsObjectPage", entitySet: "ProviderConnections" }, {
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
			// The field exists in the Endpoint form and is shown (the provider type uses it).
			iSeeEndpointField: function (sProperty) {
				return this.waitFor(Object.assign(endpointElements(sProperty), {
					check: function (aElements) { return aElements.length === 1 && aElements[0].getVisible() && !!aElements[0].getDomRef(); },
					success: function () { Opa5.assert.ok(true, "Endpoint field " + sProperty + " is shown"); },
					errorMessage: "Endpoint field " + sProperty + " is not shown"
				}));
			},
			// Another provider type's field: its form element exists (one, so a mistyped property cannot pass
			// on no match) and UI.Hidden keeps it from showing.
			iSeeNoEndpointField: function (sProperty) {
				return this.waitFor(Object.assign(endpointElements(sProperty), {
					check: function (aElements) { return aElements.length === 1 && (!aElements[0].getVisible() || !aElements[0].getDomRef()); },
					success: function () { Opa5.assert.ok(true, "Endpoint field " + sProperty + " is hidden"); },
					errorMessage: "Endpoint field " + sProperty + " is shown"
				}));
			},
			// A section UI.Hidden keeps from showing for this connection (it exists: a mistyped id cannot pass).
			iSeeNoSection: function (sFacetId) {
				return this.waitFor(Object.assign(section(sFacetId), {
					check: function (aSections) { return aSections.length === 1 && !aSections[0].getVisible(); },
					success: function () { Opa5.assert.ok(true, "Section " + sFacetId + " is hidden"); },
					errorMessage: "Section " + sFacetId + " is shown"
				}));
			},
			iSeeHeaderAction: function (sKey) {
				return this.waitFor(Object.assign(headerAction(sKey), {
					check: function (aButtons) { return aButtons.length === 1 && aButtons[0].getVisible() && !!aButtons[0].getDomRef(); },
					success: function () { Opa5.assert.ok(true, "Header action " + sKey + " is shown"); },
					errorMessage: "Header action " + sKey + " is not shown"
				}));
			},
			iSeeNoHeaderAction: function (sKey) {
				return this.waitFor(Object.assign(headerAction(sKey), {
					check: function (aButtons) { return aButtons.length === 1 && !aButtons[0].getVisible(); },
					success: function () { Opa5.assert.ok(true, "Header action " + sKey + " is hidden"); },
					errorMessage: "Header action " + sKey + " is shown"
				}));
			}
		}
	});
});
