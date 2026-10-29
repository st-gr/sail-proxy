sap.ui.define([
	"sap/ui/test/Opa5",
	"sap/ui/test/actions/Press"
], function (Opa5, Press) {
	"use strict";

	var sView = "Admin";   // admin.grounding.view.Admin
	var sList = "Stores";  // admin.grounding.view.Stores

	// Admin stores table cells: VBox (name, Shared badge), owner, status, files, size, embedding model, last active, actions.
	function storeRows(oTable) {
		return oTable.getItems().map(function (oItem) {
			var aCells = oItem.getCells();
			return {
				name: aCells[0].getItems()[0].getText(),
				shared: aCells[0].getItems()[1].getVisible(),
				owner: aCells[1].getText()
			};
		});
	}

	Opa5.createPageObjects({
		onTheAdministration: {
			actions: {
				iTestTheS3Connection: function () {
					return this.waitFor({
						id: "blobTestButton",
						viewName: sView,
						actions: new Press(),
						errorMessage: "The Test S3 Connection button could not be pressed"
					});
				}
			},
			assertions: {
				iSeeTheOverviewTiles: function (iCount, sStoresTile, iMinStores) {
					var aLastSeen = [];
					return this.waitFor({
						id: "overviewTiles",
						viewName: sView,
						check: function (oTiles) {
							var aTiles = oTiles.getItems();
							aLastSeen = aTiles.map(function (oTile) {
								return oTile.getHeader() + "=" + oTile.getTileContent()[0].getContent().getText();
							});
							if (oTiles.getBusy() || aTiles.length !== iCount) return false;
							var oStores = aTiles.filter(function (oTile) { return oTile.getHeader() === sStoresTile; })[0];
							return !!oStores && parseInt(oStores.getTileContent()[0].getContent().getText().replace(/\D/g, ""), 10) >= iMinStores;
						},
						success: function () { Opa5.assert.ok(true, "The overview shows " + iCount + " tiles: " + aLastSeen.join(", ")); },
						errorMessage: "The overview did not show " + iCount + " tiles with at least " + iMinStores + " vector stores"
					});
				},
				iSeeTheTile: function (sHeader, sValue) {
					var sLastSeen = "";
					return this.waitFor({
						id: "overviewTiles",
						viewName: sView,
						check: function (oTiles) {
							var oTile = oTiles.getItems().filter(function (oItem) { return oItem.getHeader() === sHeader; })[0];
							sLastSeen = oTile ? oTile.getTileContent()[0].getContent().getText() : "(no tile)";
							return !oTiles.getBusy() && sLastSeen === sValue;
						},
						success: function () { Opa5.assert.ok(true, "The " + sHeader + " tile shows " + sValue); },
						errorMessage: "The " + sHeader + " tile does not show " + sValue + " (last seen: " + sLastSeen + ")"
					});
				},
				iSeeTheStoreOf: function (sName, sOwner, bShared) {
					return this.waitFor({
						id: "adminStoresTable",
						viewName: sView,
						check: function (oTable) {
							return !oTable.getBusy() && storeRows(oTable).some(function (oRow) {
								return oRow.name === sName && oRow.owner === sOwner && oRow.shared === bShared;
							});
						},
						success: function () {
							Opa5.assert.ok(true, "Administration lists " + sName + " of " + sOwner + (bShared ? ", shared" : ""));
						},
						errorMessage: "Administration does not list " + sName + " of " + sOwner + (bShared ? " as shared" : "")
					});
				},
				// The Blob storage panel: the configured backend, the S3 state, and a row for the backend's storage.
				iSeeTheBlobStorage: function (sBackend, sS3State) {
					var sLastSeen = "";
					return this.waitFor({
						id: "blobStoragePanel",
						viewName: sView,
						check: function (oPanel) {
							var oView = oPanel.getParent();
							while (oView && !oView.byId) { oView = oView.getParent(); }
							var oBackend = oView.byId("blobBackendText");
							var oS3 = oView.byId("blobS3Status");
							var oTable = oView.byId("blobStorageTable");
							var aStorages = oTable.getItems().map(function (oItem) { return oItem.getCells()[0].getText(); });
							sLastSeen = oBackend.getText() + " / " + oS3.getText() + " / [" + aStorages.join(", ") + "]";
							return oPanel.getVisible() && oBackend.getText() === sBackend && oS3.getText() === sS3State && aStorages.indexOf(sBackend) !== -1;
						},
						success: function () { Opa5.assert.ok(true, "The Blob storage panel shows " + sLastSeen); },
						errorMessage: "The Blob storage panel does not show " + sBackend + " / " + sS3State + " (last seen: " + sLastSeen + ")"
					});
				},
				iSeeTheConnectionTestResult: function (sText) {
					var sLastSeen = "";
					return this.waitFor({
						id: "blobTestStrip",
						viewName: sView,
						visible: false,
						check: function (oStrip) {
							sLastSeen = oStrip.getText();
							return oStrip.getVisible() && sLastSeen === sText;
						},
						success: function () { Opa5.assert.ok(true, "The connection test answered: " + sText); },
						errorMessage: "The connection test did not answer " + sText + " (last seen: " + sLastSeen + ")"
					});
				},
				iAmSentBackToTheStores: function () {
					return this.waitFor({
						id: "storesPage",
						viewName: sList,
						check: function () {
							// The Administration page must not be on screen. This sees the redirect only; that no admin
							// request was sent is the controller's isAdmin check (adminApi), which a journey cannot observe.
							var vShown = Opa5.getPlugin().getMatchingControls({ id: /--adminPage$/, visible: true });
							return !vShown || vShown.length === 0;
						},
						success: function () { Opa5.assert.ok(true, "The Administration link led back to Vector Stores"); },
						errorMessage: "The Administration link did not lead back to Vector Stores"
					});
				}
			}
		}
	});
});
