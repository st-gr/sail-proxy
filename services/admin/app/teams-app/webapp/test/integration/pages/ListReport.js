sap.ui.define(["sap/fe/test/ListReport", "sap/ui/test/Opa5"], function (ListReport, Opa5) {
	"use strict";

	return new ListReport({ appId: "admin.teams", componentId: "TeamsList", entitySet: "Teams" }, {
		assertions: {
			iSeeNoVisibleButton: function (sText) {
				return this.waitFor({ controlType: "sap.m.Button", visible: false,
					check: function (aButtons) { return !aButtons.some(function (b) { return b.getText() === sText && b.getVisible() && !!b.getDomRef(); }); },
					success: function () { Opa5.assert.ok(true, "No visible '" + sText + "' button"); },
					errorMessage: "A visible '" + sText + "' button is shown" });
			}
		}
	});
});
