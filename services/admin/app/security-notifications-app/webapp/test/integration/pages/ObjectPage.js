sap.ui.define(["sap/fe/test/ObjectPage", "sap/ui/test/Opa5"], function (ObjectPage, Opa5) {
	"use strict";

	// Raw values come from the page's binding context (the draft while editing, the active
	// row otherwise) - exact and independent of date formatting.
	function readStored(oLayout, sProperty) {
		var oContext = oLayout.getBindingContext();
		return oContext ? oContext.getProperty(sProperty) : undefined;
	}

	return new ObjectPage({ appId: "admin.securitynotifications", componentId: "MySecurityNotificationsObjectPage", entitySet: "MySecurityNotifications" }, {
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
			}
		}
	});
});
