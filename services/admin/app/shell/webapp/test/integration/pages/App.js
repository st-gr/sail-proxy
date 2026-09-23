sap.ui.define(["sap/ui/test/Opa5", "sap/ui/test/matchers/PropertyStrictEquals"], function (Opa5, PropertyStrictEquals) {
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
				},
				// The card is only rendered once _loadMyQuota resolves (quota>/available becomes
				// true), so visible:false disables OPA5's default visibility filter and the check
				// polls the control's own getVisible() instead - same pattern as iSeeTheProfile.
				// bVisible comes from the role matrix (roles.js quota.cardVisible): false waits for
				// the same control and asserts it stays invisible, it never skips the check.
				// oRow is optional: when omitted, only the card's presence is asserted (the admin
				// role has no seeded constraints, so its row values are not fixed numbers).
				iCheckTheQuotaCard: function (bVisible, oRow) {
					var mLastRow = null;
					return this.waitFor({
						id: "myQuotaCard",
						viewName: sViewName,
						visible: false,
						check: function (oCard) {
							if (oCard.getVisible() !== bVisible) {
								return false;
							}
							if (!bVisible || !oRow) {
								return true;
							}
							var aRows = (oCard.getModel("quota").getProperty("/rows") || []);
							mLastRow = aRows.filter(function (oData) {
								return oData.key === oRow.key;
							})[0] || null;
							return !!mLastRow && mLastRow.used === oRow.used && mLastRow.limit === oRow.limit;
						},
						success: function (oCard) {
							if (!bVisible) {
								Opa5.assert.strictEqual(oCard.getVisible(), false, "The My quota card is not visible for this role");
								return;
							}
							if (!oRow) {
								Opa5.assert.ok(oCard.getVisible(), "The My quota card is visible");
								return;
							}
							Opa5.assert.ok(!!mLastRow, "Quota row '" + oRow.key + "' is present");
							Opa5.assert.strictEqual(mLastRow.used, oRow.used, "Row '" + oRow.key + "' used is " + oRow.used);
							Opa5.assert.strictEqual(mLastRow.limit, oRow.limit, "Row '" + oRow.key + "' limit is " + oRow.limit);
						},
						errorMessage: bVisible
							? "The My quota card never showed" +
								(oRow ? " row '" + oRow.key + "' as used=" + oRow.used + "/limit=" + oRow.limit +
									" (last seen: " + JSON.stringify(mLastRow) + ")" : "")
							: "The My quota card was visible although the role matrix expects it hidden"
					});
				},
				// One BulletMicroChart per quota row — the card is a VBox of rows, each carrying a chart.
				// A chart is drawn only under a window that has a limit: the expected count comes from the
				// card's own model (rows with a limit) unless the caller pins a number.
				iSeeQuotaCharts: function (nExpected) {
					var nWanted = nExpected;
					return this.waitFor({
						id: "myQuotaRows",
						viewName: sViewName,
						check: function (oRows) {
							if (nExpected === undefined) {
								nWanted = (oRows.getModel("quota").getProperty("/rows") || []).filter(function (r) { return !r.unlimited; }).length;
							}
							return oRows.findAggregatedObjects(true, function (oControl) {
								return oControl.isA("sap.suite.ui.microchart.BulletMicroChart");
							}).length === nWanted;
						},
						success: function () {
							Opa5.assert.ok(true, nWanted + " quota bullet chart(s) rendered, one per limited window");
						},
						errorMessage: "The number of quota bullet charts does not match the limited windows"
					});
				},
				// The row's reset text ("Resets …") is rendered for a window that has a reset time.
				iSeeQuotaResetText: function (sKey) {
					return this.waitFor({
						id: "myQuotaCard",
						viewName: sViewName,
						check: function (oCard) {
							var oRow = (oCard.getModel("quota").getProperty("/rows") || []).filter(function (r) { return r.key === sKey; })[0];
							return !!oRow && /^Resets /.test(oRow.resetText);
						},
						success: function () {
							Opa5.assert.ok(true, "Quota row '" + sKey + "' shows its reset time");
						},
						errorMessage: "Quota row '" + sKey + "' has no reset text"
					});
				},
				// The profile popover's tool-policy line names the caller's effective policy and its
				// mode, once myQuotaStatus resolves (quota>/toolPolicyText).
				iSeeToolPolicyLine: function () {
					return this.waitFor({
						id: "myQuotaCompactToolPolicy",
						viewName: sViewName,
						visible: false,
						matchers: new PropertyStrictEquals({ name: "visible", value: true }),
						success: function (oText) {
							Opa5.assert.ok(/^Tool policy: .+ \((monitor|strip|reject)\)$/.test(oText.getText()), "tool policy line: " + oText.getText());
						},
						errorMessage: "The tool policy line never appeared"
					});
				},
				// The tiles render once _loadHomeSummary resolves (home>/available), so visible:false and
				// the check reads the bound model - same pattern as iCheckTheQuotaCard. oExpected.count is
				// the number of tiles the role gets (an administrator has the extra "Active users" tile);
				// oExpected.tokens, when given, pins the tokens tile to the seeded usage.
				iCheckTheHomeTiles: function (oExpected) {
					var aLastTiles = [];
					function tokensTile() {
						return aLastTiles.filter(function (oTile) { return oTile.key === "tokens"; })[0] || null;
					}
					return this.waitFor({
						id: "homeTiles",
						viewName: sViewName,
						visible: false,
						check: function (oBox) {
							if (!oBox.getVisible()) {
								return false;
							}
							aLastTiles = oBox.getModel("home").getProperty("/tiles") || [];
							if (aLastTiles.length !== oExpected.count) {
								return false;
							}
							return oExpected.tokens === undefined || (!!tokensTile() && tokensTile().value === oExpected.tokens);
						},
						success: function () {
							Opa5.assert.strictEqual(aLastTiles.length, oExpected.count, "Home shows " + oExpected.count + " tiles");
							if (oExpected.tokens !== undefined) {
								Opa5.assert.strictEqual(tokensTile().value, oExpected.tokens, "The tokens tile shows " + oExpected.tokens);
							}
						},
						errorMessage: "The home tiles never showed " + oExpected.count + " tiles" +
							(oExpected.tokens !== undefined ? " with tokens " + oExpected.tokens : "") +
							" (last seen: " + JSON.stringify(aLastTiles) + ")"
					});
				},
				// updateContent hides the static home content (tiles, quota card) whenever a Fiori
				// Elements app - Usage Analytics after a tile press - takes the content area.
				iSeeTheHomeContentReplacedByAnApp: function () {
					return this.waitFor({
						id: "staticContent",
						viewName: sViewName,
						visible: false,
						check: function (oBox) {
							return oBox.getVisible() === false;
						},
						success: function () {
							Opa5.assert.ok(true, "The home content gave way to an app");
						},
						errorMessage: "The home content stayed visible - no app opened"
					});
				}
			},
			actions: {
				// Presses the tile bound to `sKey` (home>/tiles[].key): its press opens Usage Analytics.
				iPressTheHomeTile: function (sKey) {
					return this.waitFor({
						controlType: "sap.m.GenericTile",
						viewName: sViewName,
						matchers: function (oTile) {
							var oContext = oTile.getBindingContext("home");
							return !!oContext && oContext.getProperty("key") === sKey;
						},
						success: function (aTiles) {
							aTiles[0].firePress();
							Opa5.assert.ok(true, "Pressed the '" + sKey + "' tile");
						},
						errorMessage: "No home tile with key '" + sKey + "'"
					});
				}
			}
		}
	});
});
