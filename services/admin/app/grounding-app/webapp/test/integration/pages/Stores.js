sap.ui.define([
	"sap/ui/test/Opa5",
	"sap/ui/test/actions/Press",
	"sap/ui/test/actions/EnterText",
	"sap/ui/test/matchers/PropertyStrictEquals"
], function (Opa5, Press, EnterText, PropertyStrictEquals) {
	"use strict";

	var sList = "Stores";        // admin.grounding.view.Stores
	var sDetail = "StoreDetail"; // admin.grounding.view.StoreDetail

	// In the stores list the name cell is a VBox (the name, then the Shared badge); in a store's file
	// table it is the file name's Text.
	function nameOf(oItem) {
		var oCell = oItem.getCells()[0];
		return oCell.getItems ? oCell.getItems()[0].getText() : oCell.getText();
	}

	function rowWithName(oTable, sName) {
		return oTable.getItems().filter(function (oItem) {
			return nameOf(oItem) === sName;
		})[0];
	}

	function isSharedRow(oItem) {
		return oItem.getCells()[0].getItems()[1].getVisible();
	}

	Opa5.createPageObjects({
		onTheStores: {
			actions: {
				iPressCreate: function () {
					return this.waitFor({ id: "createStoreButton", viewName: sList, actions: new Press() });
				},
				iEnterTheNewName: function (sName) {
					// The dialog has two text inputs; the name is the one with the id storeNameInput.
					return this.waitFor({
						id: "storeNameInput",
						viewName: sList,
						searchOpenDialogs: true,
						actions: new EnterText({ text: sName })
					});
				},
				iPressTheDialogButton: function (sText) {
					return this.waitFor({
						searchOpenDialogs: true,
						controlType: "sap.m.Button",
						matchers: new PropertyStrictEquals({ name: "text", value: sText }),
						actions: new Press()
					});
				},
				iOpenTheStore: function (sName) {
					return this.waitFor({
						id: "storesTable",
						viewName: sList,
						check: function (oTable) { return !!rowWithName(oTable, sName); },
						success: function (oTable) { rowWithName(oTable, sName).firePress(); },
						errorMessage: "No store named " + sName
					});
				},
				iPressShare: function () {
					return this.waitFor({ id: "shareStoreButton", viewName: sDetail, actions: new Press() });
				},
				iPressShareWithTeam: function () {
					return this.waitFor({ id: "shareTeamButton", viewName: sDetail, actions: new Press(), errorMessage: "No Share With Team button" });
				},
				iChooseTeamAndShare: function (sTeam) {
					return this.waitFor({
						controlType: "sap.m.Select",
						searchOpenDialogs: true,
						success: function (aSelects) {
							var oSelect = aSelects[0];
							oSelect.setSelectedKey(oSelect.getItems().filter(function (oItem) { return oItem.getText() === sTeam; })[0].getKey());
							this.waitFor({
								controlType: "sap.m.Button",
								searchOpenDialogs: true,
								matchers: new PropertyStrictEquals({ name: "text", value: "Share" }),
								actions: new Press()
							});
						},
						errorMessage: "No team select in the Share With Team dialog"
					});
				},
				iPressStopSharing: function () {
					return this.waitFor({ id: "unshareStoreButton", viewName: sDetail, actions: new Press() });
				},
				iOpenTheDetailsTab: function () {
					return this.waitFor({
						id: "storeTabs",
						viewName: sDetail,
						success: function (oTabBar) { oTabBar.setSelectedKey("details"); }
					});
				},
				iChooseTheChunkingStrategy: function (sKey, bOnStorePage) {
					// The create dialog (Stores) and the Change Chunking dialog (StoreDetail) build the same fields.
					return this.waitFor({
						id: "chunkingTypeSelect",
						viewName: bOnStorePage ? sDetail : sList,
						searchOpenDialogs: true,
						success: function (oSelect) {
							oSelect.setSelectedKey(sKey);
							oSelect.fireChange({ selectedItem: oSelect.getSelectedItem() });
						},
						errorMessage: "The chunking strategy cannot be chosen"
					});
				},
				iPressChangeChunking: function () {
					return this.waitFor({ id: "changeChunkingButton", viewName: sDetail, actions: new Press() });
				},
				iPressDeleteStore: function () {
					return this.waitFor({ id: "deleteStoreButton", viewName: sDetail, actions: new Press() });
				},
				iUploadAndAttach: function (sFileName, sContent) {
					// The native file picker cannot be driven from a test; the controller method it
					// feeds can, with a File built here.
					return this.waitFor({
						viewName: sDetail,
						id: "storeDetailPage",
						success: function (oPage) {
							// The File must come from the app frame's window, where the app builds its FormData.
							var FrameFile = Opa5.getWindow().File;
							var oController = oPage.getParent().getController();
							oController.uploadAndAttach([new FrameFile([sContent], sFileName, { type: "text/plain" })]);
						}
					});
				}
			},
			assertions: {
				iSeeTheStore: function (sName) {
					return this.waitFor({
						id: "storesTable",
						viewName: sList,
						check: function (oTable) { return !!rowWithName(oTable, sName); },
						success: function () { Opa5.assert.ok(true, "The list shows the store " + sName); },
						errorMessage: "The store " + sName + " is not listed"
					});
				},
				iDoNotSeeTheStore: function (sName) {
					return this.waitFor({
						id: "storesTable",
						viewName: sList,
						check: function (oTable) { return !oTable.getBusy() && !rowWithName(oTable, sName); },
						success: function () { Opa5.assert.ok(true, "The list no longer shows the store " + sName); },
						errorMessage: "The store " + sName + " is still listed"
					});
				},
				iSeeTheStoreSharedBy: function (sName, sOwner) {
					return this.waitFor({
						id: "storesTable",
						viewName: sList,
						check: function (oTable) {
							var oRow = rowWithName(oTable, sName);
							return !!oRow && isSharedRow(oRow) && oRow.getCells()[1].getText() === sOwner;
						},
						success: function () { Opa5.assert.ok(true, "The list shows " + sName + " as Shared by " + sOwner); },
						errorMessage: "The list does not show " + sName + " as Shared by " + sOwner
					});
				},
				iSeeTheStoresList: function () {
					return this.waitFor({
						id: "storesPage",
						viewName: sList,
						success: function () { Opa5.assert.ok(true, "The Vector Stores list is shown"); },
						errorMessage: "The Vector Stores list is not shown"
					});
				},
				iSeeTheStoreReadOnly: function (sOwner) {
					this.waitFor({
						id: "sharedReadOnlyStrip",
						viewName: sDetail,
						check: function (oStrip) { return oStrip.getText().indexOf(sOwner) !== -1; },
						success: function () { Opa5.assert.ok(true, "The store page says it is shared by " + sOwner); },
						errorMessage: "The store page does not say it is shared by " + sOwner
					});
					// visible:false makes OPA hand over hidden controls too, so the check can assert that they stay hidden.
					// The shared store is Current, which hides Re-embed by itself, so the check also reads the view
					// model the buttons bind to: the row is not owned and offers no Re-embed whatever its state.
					return this.waitFor({
						id: ["filesTab", "renameStoreButton", "setExpiryButton", "deleteStoreButton", "shareStoreButton", "reembedStoreButton"],
						viewName: sDetail,
						visible: false,
						check: function (aControls) {
							var oStore = aControls.length ? aControls[0].getModel("view").getProperty("/store") : null;
							return aControls.length === 6 && aControls.every(function (oControl) { return !oControl.getVisible(); })
								&& !!oStore && oStore.owned === false && oStore.canReembed === false;
						},
						success: function () { Opa5.assert.ok(true, "The store is read-only: no Files tab, no rename, expiry, delete, share or re-embed; the row is not owned and cannot be re-embedded"); },
						errorMessage: "The shared store shows the Files tab or an owner action, or its row is owned or re-embeddable"
					});
				},
				iSeeTheEmbeddingCurrent: function () {
					// A store seeded under the configured model: its Details name a model and say Current, the
					// page shows no outdated strip, and the header offers no Re-embed.
					var sLastSeen = "";
					this.waitFor({
						id: ["detailEmbeddingModelText", "detailEmbeddingState"],
						viewName: sDetail,
						check: function (aControls) {
							sLastSeen = aControls[0].getText() + " / " + aControls[1].getText();
							return aControls[0].getText() !== "" && aControls[1].getText() === "Current";
						},
						success: function () { Opa5.assert.ok(true, "The Details tab shows the embedding model and Current: " + sLastSeen); },
						errorMessage: "The Details tab does not show an embedding model as Current (last seen: " + sLastSeen + ")"
					});
					return this.waitFor({
						id: ["reembedStoreButton", "embeddingStateStrip"],
						viewName: sDetail,
						visible: false,
						check: function (aControls) {
							return aControls.length === 2 && aControls.every(function (oControl) { return !oControl.getVisible(); });
						},
						success: function () { Opa5.assert.ok(true, "A current store offers no Re-embed and shows no outdated strip"); },
						errorMessage: "A current store offers Re-embed or shows the outdated strip"
					});
				},
				iDoNotSeeRereadFiles: function () {
					// The offer is read in the same load that fills the Chunking section: once its text is there,
					// the button's visibility is final. A store whose files this version ingested has nothing to
					// read again, so the header offers no Re-read Files.
					this.waitFor({
						id: "detailChunkingText",
						viewName: sDetail,
						check: function (oText) { return oText.getText() !== ""; },
						errorMessage: "The Chunking section never showed the store's setting"
					});
					return this.waitFor({
						id: "reextractButton",
						viewName: sDetail,
						visible: false,
						check: function (oButton) { return !oButton.getVisible(); },
						success: function () { Opa5.assert.ok(true, "A store read by this version offers no Re-read Files"); },
						errorMessage: "A store read by this version offers Re-read Files"
					});
				},
				iSeeTheChunking: function (sPrefix) {
					var sLastSeen = "";
					return this.waitFor({
						id: "detailChunkingText",
						viewName: sDetail,
						check: function (oText) {
							sLastSeen = oText.getText();
							return sLastSeen.indexOf(sPrefix) === 0;
						},
						success: function () { Opa5.assert.ok(true, "The Chunking section shows " + sLastSeen); },
						errorMessage: "The Chunking section does not show " + sPrefix + " (last seen: " + sLastSeen + ")"
					});
				},
				iSeeTheVisionModes: function () {
					// The vision mode field offers its four modes; it is shown only where the gateway allows vision,
					// so this looks at the field whether it is visible or not and changes nothing.
					return this.waitFor({
						id: "chunkingVisionSelect",
						viewName: sDetail,
						searchOpenDialogs: true,
						visible: false,
						check: function (oSelect) {
							return oSelect.getItems().map(function (oItem) { return oItem.getKey(); }).join() === "off,no_text,auto,all";
						},
						success: function (oSelect) { Opa5.assert.ok(true, "The vision mode field offers off, no_text, auto and all (selected: " + oSelect.getSelectedKey() + ")"); },
						errorMessage: "The Change Chunking dialog has no vision mode field with the four modes"
					});
				},
				iSeeTheChunkingEstimate: function () {
					// The figures of an empty store: no file, every figure labelled as an estimate, and Start offered.
					return this.waitFor({
						id: ["chunkingEstimateBox", "chunkingEstimateFiles", "chunkingEstimateEmbeddingTokens", "chunkingStartButton"],
						viewName: sDetail,
						searchOpenDialogs: true,
						check: function (aControls) {
							return aControls.length === 4 && aControls[0].getVisible() && aControls[1].getText() !== ""
								&& aControls[2].getText() !== "" && aControls[3].getVisible() && aControls[3].getEnabled();
						},
						success: function (aControls) { Opa5.assert.ok(true, "The dialog shows the estimate: " + aControls[1].getText() + " file(s), " + aControls[2].getText() + " embedding tokens"); },
						errorMessage: "The Change Chunking dialog shows no estimate that can be started"
					});
				},
				iSeeTheTeamShare: function (sTeam) {
					return this.waitFor({
						id: "teamSharesList",
						viewName: sDetail,
						check: function (oList) {
							return oList.getItems().some(function (oItem) { return oItem.getBindingContext("view").getProperty("name") === sTeam; });
						},
						success: function () { Opa5.assert.ok(true, "Shared with " + sTeam); },
						errorMessage: "Not shared with " + sTeam
					});
				},
				iSeeTheStoreShared: function (bShared) {
					// After Share the page offers Stop Sharing, after Stop Sharing it offers Share again.
					return this.waitFor({
						id: bShared ? "unshareStoreButton" : "shareStoreButton",
						viewName: sDetail,
						success: function () { Opa5.assert.ok(true, bShared ? "The store is shared with all users" : "The store is no longer shared"); },
						errorMessage: bShared ? "The store page does not offer Stop Sharing" : "The store page does not offer Share"
					});
				},
				iSeeTheStorePage: function (sName) {
					return this.waitFor({
						id: "storeDetailPage",
						viewName: sDetail,
						matchers: new PropertyStrictEquals({ name: "title", value: sName }),
						success: function () { Opa5.assert.ok(true, "The store page shows " + sName); },
						errorMessage: "The store page does not show " + sName
					});
				},
				iSeeTheFileWithStatus: function (sFileName, sStatusText) {
					// Ingestion is a real embedding call; the page refreshes itself every 3 seconds.
					return this.waitFor({
						id: "storeFilesTable",
						viewName: sDetail,
						timeout: 120,
						check: function (oTable) {
							var oRow = rowWithName(oTable, sFileName);
							// The status cell is a VBox: the status, then the "Context incomplete" mark.
							return !!oRow && oRow.getCells()[1].getItems()[0].getText() === sStatusText;
						},
						success: function () { Opa5.assert.ok(true, sFileName + " is " + sStatusText); },
						errorMessage: sFileName + " did not reach the status " + sStatusText
					});
				}
			}
		}
	});
});
