sap.ui.define(["sap/ui/test/Opa5"], function (Opa5) {
	"use strict";

	var sViewName = "App"; // admin.shell.view.App (viewNamespace is set in opaTests.qunit.js)

	// text -> visible, for every sap.tnt.NavigationListItem in both navigation lists
	function collectNavigation(oSideNavigation) {
		var mVisibleByText = {};
		function walk(aItems) {
			(aItems || []).forEach(function (oItem) {
				mVisibleByText[oItem.getText()] = oItem.getVisible();
				walk(oItem.getItems());
			});
		}
		walk(oSideNavigation.getItem() ? oSideNavigation.getItem().getItems() : []);
		walk(oSideNavigation.getFixedItem() ? oSideNavigation.getFixedItem().getItems() : []);
		return mVisibleByText;
	}

	function profileTexts(oPopover) {
		return oPopover.findAggregatedObjects(true, function (oControl) {
			return oControl.isA("sap.m.Text");
		}).map(function (oText) {
			return oText.getText();
		});
	}

	Opa5.createPageObjects({
		onTheShell: {
			assertions: {
				// The popover is only rendered when opened, so visible:false; its texts are bound to
				// appView>/userEmail and appView>/userRole, which the controller sets together with
				// appView>/isAdmin from getCurrentUserPreferences - so once the email shows, the
				// role-dependent navigation state is final.
				iSeeTheProfile: function (sEmail, sRoleLabel) {
					return this.waitFor({
						id: "userProfilePopover",
						viewName: sViewName,
						visible: false,
						check: function (oPopover) {
							return profileTexts(oPopover).indexOf(sEmail) !== -1;
						},
						success: function (oPopover) {
							var aTexts = profileTexts(oPopover);
							Opa5.assert.ok(aTexts.indexOf(sEmail) !== -1, "Profile shows the signed-in user " + sEmail);
							Opa5.assert.ok(aTexts.indexOf(sRoleLabel) !== -1,
								"Profile shows the role label '" + sRoleLabel + "' (texts: " + aTexts.join(" | ") + ")");
						},
						errorMessage: "The profile popover never showed " + sEmail +
							" - getCurrentUserPreferences did not resolve for this role"
					});
				},
				// Polls until the whole matrix holds: the entries are bound to appView>/isAdmin,
				// which getCurrentUserPreferences resolves asynchronously, so the first render can
				// still show the pre-role state. Independent of iSeeTheProfile running first.
				iSeeNavigationEntries: function (aVisibleNav, aHiddenNav) {
					var mLastSeen = {};
					return this.waitFor({
						id: "sideNavigation",
						viewName: sViewName,
						check: function (oSideNavigation) {
							mLastSeen = collectNavigation(oSideNavigation);
							return aVisibleNav.every(function (sText) {
								return mLastSeen[sText] === true;
							}) && aHiddenNav.every(function (sText) {
								return mLastSeen[sText] === false;
							});
						},
						success: function () {
							aVisibleNav.forEach(function (sText) {
								Opa5.assert.strictEqual(mLastSeen[sText], true, "Navigation entry '" + sText + "' is visible");
							});
							aHiddenNav.forEach(function (sText) {
								// strictEqual, not notStrictEqual: a hidden entry must exist and be invisible,
								// so a renamed or removed entry fails instead of passing as "not visible".
								Opa5.assert.strictEqual(mLastSeen[sText], false, "Navigation entry '" + sText + "' is hidden");
							});
						},
						error: function () {
							Opa5.assert.ok(false, "Observed navigation: " + JSON.stringify(mLastSeen));
						},
						errorMessage: "The side navigation never matched the role matrix (visible: " +
							aVisibleNav.join(", ") + " | hidden: " + aHiddenNav.join(", ") + ")"
					});
				}
			}
		}
	});
});
