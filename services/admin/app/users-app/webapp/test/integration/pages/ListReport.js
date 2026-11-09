sap.ui.define(["sap/fe/test/ListReport", "sap/ui/test/Opa5"], function (ListReport, Opa5) {
	"use strict";

	function findRowByEmail(oTable, sEmail) {
		var oBinding = oTable.getRowBinding();
		if (!oBinding) {
			return undefined;
		}
		return oBinding.getContexts().map(function (oContext) {
			return oContext.getObject();
		}).filter(function (oData) {
			return oData.email === sEmail;
		})[0];
	}

	return new ListReport({ appId: "admin.users", componentId: "UsersList", entitySet: "Users" }, {
		assertions: {
			// Reads the bound row directly instead of the formatted cell text: usedTokensMonth is a
			// plain number, and the seeded usage only has to be reached, not matched exactly.
			iSeeTokensThisMonthAtLeast: function (sEmail, iTokens) {
				return this.waitFor({
					controlType: "sap.ui.mdc.Table",
					check: function (aTables) {
						var oRow = findRowByEmail(aTables[0], sEmail);
						return !!oRow && oRow.usedTokensMonth >= iTokens;
					},
					success: function (aTables) {
						var oRow = findRowByEmail(aTables[0], sEmail);
						Opa5.assert.ok(oRow && oRow.usedTokensMonth >= iTokens,
							"Tokens This Month for " + sEmail + " is " + (oRow && oRow.usedTokensMonth) + " (at least " + iTokens + ")");
					},
					errorMessage: "Tokens This Month for " + sEmail + " never reached " + iTokens
				});
			}
		}
	});
});
