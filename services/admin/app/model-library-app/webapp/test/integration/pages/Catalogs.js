sap.ui.define([
	"sap/ui/test/Opa5",
	"sap/ui/test/actions/Press",
	"sap/ui/test/actions/EnterText"
], function (Opa5, Press, EnterText) {
	"use strict";

	var sView = "Catalogs"; // admin.modellibrary.view.Catalogs (viewNamespace is set in opaTests.qunit.js)

	// whoami resolves asynchronously (model/session.ts) and fills /isAdmin and /email together;
	// a role assertion before that would read the pre-role state.
	function sessionResolved(oControl) {
		var oViewModel = oControl.getModel("viewModel");
		return !!oViewModel && !!oViewModel.getProperty("/email");
	}

	function itemsTitled(oList, sName) {
		return oList.getItems().filter(function (oItem) {
			return oItem.getTitle() === sName;
		});
	}

	// ModelPicker.fragment.xml binds description="{modelId}".
	function offeredIds(oDialog) {
		return oDialog.getItems().map(function (oItem) {
			return oItem.getDescription();
		});
	}

	// The assignments table's rows: cells [e-mail, assigned catalog/profile, HBox of the two buttons].
	// The same table serves both modes, so these helpers do too.
	function userRow(oTable, sEmail) {
		return oTable.getItems().filter(function (oItem) {
			return oItem.getCells()[0].getText() === sEmail;
		})[0] || null;
	}

	function rowButton(oRow, sText) {
		return oRow.getCells()[2].getItems().filter(function (oButton) {
			return oButton.getVisible() && oButton.getText() === sText;
		})[0] || null;
	}

	// sap.m.MessageBox labels its standard actions from the sap.m library bundle
	// (MessageBox.js: MessageBox._rb.getText("MSGBOX_" + sAction)), so a step that presses one
	// must read that bundle rather than hardcode English - and read it from the application
	// frame, which runs its own UI5 instance. A custom action (our "Discard") keeps its own
	// string and needs none of this.
	function messageBoxActionText(sAction) {
		var oWindow = Opa5.getWindow();
		var Lib = oWindow.sap.ui.require("sap/ui/core/Lib");
		var oBundle = Lib
			? Lib.getResourceBundleFor("sap.m")
			: oWindow.sap.ui.getCore().getLibraryResourceBundle("sap.m");
		return oBundle.getText("MSGBOX_" + sAction);
	}

	Opa5.createPageObjects({
		onTheCatalogs: {
			actions: {
				iOpenNewCatalog: function () {
					return this.waitFor({ id: "newCatalogButton", viewName: sView, actions: new Press() });
				},
				// The dialogs are loaded with the view as owner (Fragment.load({ id: view.getId() })),
				// so their controls answer to the view-relative ids used here.
				iNameIt: function (sName) {
					return this.waitFor({ id: "newCatalogName", viewName: sView, actions: new EnterText({ text: sName }) });
				},
				iConfirmCreate: function () {
					return this.waitFor({
						controlType: "sap.m.Button",
						searchOpenDialogs: true,
						matchers: function (oButton) {
							return oButton.getText() === "Create";
						},
						actions: new Press(),
						errorMessage: "the new-catalog dialog has no Create button"
					});
				},
				iSelectCatalogNamed: function (sName) {
					return this.waitFor({
						id: "catalogList",
						viewName: sView,
						check: function (oList) {
							return itemsTitled(oList, sName).length > 0;
						},
						success: function (oList) {
							var oItem = itemsTitled(oList, sName)[0];
							oList.setSelectedItem(oItem);
							oList.fireSelectionChange({ listItem: oItem });
						},
						errorMessage: "catalog not selectable: " + sName
					});
				},
				// The mode switch is a SegmentedButton whose selectedKey is two-way bound: a real
				// press writes the key into the view model and then fires selectionChange, which is
				// what onModeChange reacts to (guard first, then the hash).
				iSwitchToProfiles: function () {
					return this.waitFor({
						id: "modeSwitch",
						viewName: sView,
						check: function (oSwitch) {
							return oSwitch.getItems().length === 2;
						},
						success: function (oSwitch) {
							var oItem = oSwitch.getItems().filter(function (oCandidate) {
								return oCandidate.getKey() === "profiles";
							})[0];
							oSwitch.setSelectedKey("profiles");
							oSwitch.fireSelectionChange({ item: oItem });
						},
						errorMessage: "the Catalogs | Quota profiles switch never offered both modes"
					});
				},
				// The list header's one button creates whatever the list is showing.
				iOpenNewProfile: function () {
					return this.waitFor({ id: "newCatalogButton", viewName: sView, actions: new Press() });
				},
				iNameTheProfile: function (sName) {
					return this.waitFor({ id: "newProfileName", viewName: sView, actions: new EnterText({ text: sName }) });
				},
				iConfirmCreateProfile: function () {
					return this.waitFor({
						controlType: "sap.m.Button",
						searchOpenDialogs: true,
						matchers: function (oButton) {
							return oButton.getText() === "Create";
						},
						actions: new Press(),
						errorMessage: "the new-profile dialog has no Create button"
					});
				},
				iSelectProfileNamed: function (sName) {
					return this.waitFor({
						id: "profileList",
						viewName: sView,
						check: function (oList) {
							return itemsTitled(oList, sName).length > 0;
						},
						success: function (oList) {
							var oItem = itemsTitled(oList, sName)[0];
							oList.setSelectedItem(oItem);
							oList.fireSelectionChange({ listItem: oItem });
						},
						errorMessage: "profile not selectable: " + sName
					});
				},
				// The limit Inputs carry their property name as their id (model/profileRows.ts
				// PROFILE_LIMIT_FIELDS). EnterText fires `change`, which is what puts the parsed
				// number into the deferred update group.
				iTypeInTheLimit: function (sField, sValue) {
					return this.waitFor({ id: sField, viewName: sView, actions: new EnterText({ text: sValue }) });
				},
				iAssignUser: function (sEmail) {
					return this.waitFor({
						id: "assignmentsTable",
						viewName: sView,
						check: function (oTable) {
							var oRow = userRow(oTable, sEmail);
							return !!oRow && !!rowButton(oRow, "Assign");
						},
						success: function (oTable) {
							rowButton(userRow(oTable, sEmail), "Assign").firePress();
							Opa5.assert.ok(true, "staged the assignment of " + sEmail);
						},
						errorMessage: "no assignable row for " + sEmail
					});
				},
				iUnassignUser: function (sEmail) {
					return this.waitFor({
						id: "assignmentsTable",
						viewName: sView,
						check: function (oTable) {
							var oRow = userRow(oTable, sEmail);
							return !!oRow && !!rowButton(oRow, "Unassign");
						},
						success: function (oTable) {
							rowButton(userRow(oTable, sEmail), "Unassign").firePress();
							Opa5.assert.ok(true, "staged the unassignment of " + sEmail);
						},
						errorMessage: "no unassignable row for " + sEmail
					});
				},
				iPressDeleteProfile: function () {
					return this.waitFor({ id: "deleteProfileButton", viewName: sView, actions: new Press() });
				},
				iPressAddModels: function () {
					return this.waitFor({ id: "addMembersButton", viewName: sView, actions: new Press() });
				},
				iPressDeleteCatalog: function () {
					return this.waitFor({ id: "deleteCatalogButton", viewName: sView, actions: new Press() });
				},
				// The delete confirmation is a MessageBox with the standard OK/Cancel actions.
				// The unsaved-changes guard offers our own "Discard" action next to the standard
				// Cancel: a custom action keeps its own string (MessageBox only translates the
				// members of MessageBox.Action), so only Cancel goes through the bundle.
				iDiscardInTheWarning: function () {
					return this.waitFor({
						controlType: "sap.m.Button",
						searchOpenDialogs: true,
						matchers: function (oButton) {
							return oButton.getText() === "Discard";
						},
						actions: new Press(),
						errorMessage: "the unsaved-changes warning has no Discard button"
					});
				},
				iCancelTheWarning: function () {
					return this.waitFor({
						controlType: "sap.m.Button",
						searchOpenDialogs: true,
						matchers: function (oButton) {
							return oButton.getText() === messageBoxActionText("CANCEL");
						},
						actions: new Press(),
						errorMessage: "the unsaved-changes warning has no Cancel button"
					});
				},
				iConfirmTheMessageBox: function () {
					return this.waitFor({
						controlType: "sap.m.Button",
						searchOpenDialogs: true,
						matchers: function (oButton) {
							return oButton.getText() === messageBoxActionText("OK");
						},
						actions: new Press(),
						errorMessage: "the confirmation dialog has no OK button"
					});
				},
				// I: the header saves explicitly. EnterText fires the Input's change event, which
				// is what puts the edit into the deferred update group; the footer buttons only
				// become pressable once the controller has flagged the header dirty, and waitFor
				// with an action already polls for that.
				iTypeInTheDescription: function (sText) {
					return this.waitFor({ id: "catalogDescription", viewName: sView, actions: new EnterText({ text: sText }) });
				},
				iPressSave: function () {
					return this.waitFor({ id: "saveButton", viewName: sView, actions: new Press() });
				},
				iPressDiscard: function () {
					return this.waitFor({ id: "discardButton", viewName: sView, actions: new Press() });
				},
				// cells: [displayName, modelId, status] - the row is selected through the table, the
				// way the toolbar's Remove reads it (getSelectedContexts).
				iSelectMemberRow: function (sId) {
					return this.waitFor({
						id: "membersTable",
						viewName: sView,
						check: function (oTable) {
							return oTable.getItems().some(function (oItem) { return oItem.getCells()[1].getText() === sId; });
						},
						success: function (oTable) {
							oTable.getItems().forEach(function (oItem) {
								if (oItem.getCells()[1].getText() === sId) { oTable.setSelectedItem(oItem, true); }
							});
							Opa5.assert.ok(true, "selected member row " + sId);
						},
						errorMessage: "no member row for " + sId
					});
				},
				iPressRemoveMembers: function () {
					return this.waitFor({ id: "removeMembersButton", viewName: sView, actions: new Press() });
				},
				// The picker is a growing sap.m.SelectDialog in MultiSelect mode, so only the first
				// page of models is loaded: a model that is not on it is fetched through the
				// dialog's search (the controller turns that into $search on LibraryModels) before
				// the rows are ticked. The journeys pick a single model, hence the search term.
				// Confirming goes through the dialog's own OK button (matched by id suffix, so it
				// does not depend on the button text) - that is the path that also closes the
				// dialog, which every assertion after it needs.
				iPickModelsInDialog: function (aIds) {
					function allOffered(oDialog) {
						return aIds.every(function (sId) {
							return offeredIds(oDialog).indexOf(sId) !== -1;
						});
					}
					return this.waitFor({
						id: "modelPicker",
						viewName: sView,
						check: function (oDialog) {
							return oDialog.getItems().length > 0;
						},
						success: function (oDialog) {
							if (!allOffered(oDialog)) {
								oDialog.fireSearch({ value: aIds[0] });
							}
							this.waitFor({
								id: "modelPicker",
								viewName: sView,
								check: allOffered,
								success: function () {
									oDialog.getItems().forEach(function (oItem) {
										oItem.setSelected(aIds.indexOf(oItem.getDescription()) !== -1);
									});
									this.waitFor({
										controlType: "sap.m.Button",
										searchOpenDialogs: true,
										matchers: function (oButton) {
											return oButton.getId() === oDialog.getId() + "-ok";
										},
										actions: new Press(),
										errorMessage: "the model picker has no OK button"
									});
								},
								errorMessage: "the model picker never offered " + aIds.join(", ")
							});
						},
						errorMessage: "the model picker never offered a model"
					});
				}
			},
			assertions: {
				iSeeCatalogNamed: function (sName) {
					return this.waitFor({
						id: "catalogList",
						viewName: sView,
						check: function (oList) {
							return itemsTitled(oList, sName).length > 0;
						},
						success: function () {
							Opa5.assert.ok(true, "catalog listed: " + sName);
						},
						errorMessage: "catalog not listed: " + sName
					});
				},
				// Deleting a catalog goes through the detail page's element binding; the model tells
				// the list binding about it (ODataModel -> ODataBinding#onDelete), so the row goes
				// on its own - this polls for that rather than sleeping.
				iDoNotSeeCatalogNamed: function (sName) {
					return this.waitFor({
						id: "catalogList",
						viewName: sView,
						check: function (oList) {
							return itemsTitled(oList, sName).length === 0;
						},
						success: function () {
							Opa5.assert.ok(true, "catalog gone from the list: " + sName);
						},
						errorMessage: "catalog still listed after the delete: " + sName
					});
				},
				iSeeProfileNamed: function (sName) {
					return this.waitFor({
						id: "profileList",
						viewName: sView,
						check: function (oList) {
							return itemsTitled(oList, sName).length > 0;
						},
						success: function () {
							Opa5.assert.ok(true, "profile listed: " + sName);
						},
						errorMessage: "profile not listed: " + sName
					});
				},
				iDoNotSeeProfileNamed: function (sName) {
					return this.waitFor({
						id: "profileList",
						viewName: sView,
						check: function (oList) {
							return itemsTitled(oList, sName).length === 0;
						},
						success: function () {
							Opa5.assert.ok(true, "profile gone from the list: " + sName);
						},
						errorMessage: "profile still listed after the delete: " + sName
					});
				},
				// The row's second cell: the profile the user carries, "(unsaved)" while Save has
				// not written the staged assignment yet.
				iSeeAssignedProfile: function (sEmail, sText) {
					var sLast = null;
					return this.waitFor({
						id: "assignmentsTable",
						viewName: sView,
						check: function (oTable) {
							var oRow = userRow(oTable, sEmail);
							sLast = oRow ? oRow.getCells()[1].getText() : null;
							return sLast === sText;
						},
						success: function () {
							Opa5.assert.strictEqual(sLast, sText, sEmail + " shows \"" + sText + "\"");
						},
						errorMessage: sEmail + " never showed \"" + sText + "\" (last seen: " + sLast + ")"
					});
				},
				// assignedUsers is counted server-side and is not on the CREATE response, so this
				// polls: it only becomes true once the list row has been read again.
				iSeeProfileUsers: function (sName, iCount) {
					var sLast = null;
					return this.waitFor({
						id: "profileList",
						viewName: sView,
						check: function (oList) {
							var aRows = itemsTitled(oList, sName);
							sLast = aRows.length ? aRows[0].getInfo() : null;
							return sLast === iCount + " users";
						},
						success: function () {
							Opa5.assert.strictEqual(sLast, iCount + " users", sName + " carries " + iCount + " user(s)");
						},
						errorMessage: sName + " never showed " + iCount + " users (last seen: " + sLast + ")"
					});
				},
				// visible: false - the switch must be found for either role, so a removed or
				// renamed control fails instead of passing as "not visible".
				iDoNotSeeTheModeSwitch: function () {
					return this.waitFor({
						id: "modeSwitch",
						viewName: sView,
						visible: false,
						check: function (oSwitch) {
							return sessionResolved(oSwitch) && oSwitch.getVisible() === false;
						},
						success: function () {
							Opa5.assert.ok(true, "the Catalogs | Quota profiles switch is hidden");
						},
						errorMessage: "the mode switch is visible without the admin role"
					});
				},
				// The same gate as iSeeTheCatalogSaved, read off a control the profiles mode shows
				// (the catalog header form is hidden there, and OPA only finds visible controls).
				iSeeTheProfileSaved: function () {
					return this.waitFor({
						id: "profileName",
						viewName: sView,
						check: function (oInput) {
							var oViewModel = oInput.getModel("viewModel");
							return !oInput.getModel().hasPendingChanges("catalogHeader") &&
								oViewModel.getProperty("/catalogs/pendingCount") === 0 &&
								!oViewModel.getProperty("/catalogs/saving");
						},
						success: function () {
							Opa5.assert.ok(true, "the profile's changes were written");
						},
						errorMessage: "the profile's changes were never written"
					});
				},
				iSeeMembers: function (aIds) {
					return this.waitFor({
						id: "membersTable",
						viewName: sView,
						check: function (oTable) {
							// cells: [displayName, modelId, availability]
							var aRows = oTable.getItems().map(function (oItem) {
								return oItem.getCells()[1].getText();
							});
							return aIds.every(function (sId) {
								return aRows.indexOf(sId) !== -1;
							});
						},
						success: function () {
							Opa5.assert.ok(true, "members present: " + aIds.join(", "));
						},
						errorMessage: "members missing: " + aIds.join(", ")
					});
				},
				// The status cell of a member row: "Added — unsaved" / "Removed — unsaved" while a change
				// is staged, the availability ("Available", "No longer available") once it is written
				// or dropped. Polls, because Save reloads the rows from the server.
				iSeeMemberState: function (sId, sText) {
					var sLast = null;
					return this.waitFor({
						id: "membersTable",
						viewName: sView,
						check: function (oTable) {
							var aRows = oTable.getItems().filter(function (oItem) { return oItem.getCells()[1].getText() === sId; });
							sLast = aRows.length ? aRows[0].getCells()[2].getText() : null;
							return sLast === sText;
						},
						success: function () {
							Opa5.assert.strictEqual(sLast, sText, "member " + sId + " shows \"" + sText + "\"");
						},
						errorMessage: "member " + sId + " never showed \"" + sText + "\" (last seen: " + sLast + ")"
					});
				},
				// enabled: false - the buttons must be found whether or not they are enabled, so a
				// removed or renamed button fails instead of passing as "not enabled".
				iSeeTheSaveButtonsEnabled: function (bEnabled) {
					return this.waitFor({
						id: "saveButton",
						viewName: sView,
						enabled: false,
						check: function (oButton) {
							return oButton.getEnabled() === bEnabled;
						},
						success: function (oButton) {
							Opa5.assert.strictEqual(oButton.getEnabled(), bEnabled, "Save button enabled: " + bEnabled);
						},
						errorMessage: "the Save button never became " + (bEnabled ? "enabled" : "disabled")
					});
				},
				iSeeTheDescription: function (sText) {
					return this.waitFor({
						id: "catalogDescription",
						viewName: sView,
						check: function (oInput) {
							return oInput.getValue() === sText;
						},
						success: function () {
							Opa5.assert.ok(true, "catalog description is \"" + sText + "\"");
						},
						errorMessage: "the catalog description never became \"" + sText + "\""
					});
				},
				// The header's edits live in the deferred "catalogHeader" update group (see
				// Catalogs.controller HEADER_GROUP): they count as pending until the batch has
				// come back, so this is the race-free "the save is through" gate.
				// The guard's MessageBox: matched on the text the controller passes, so a reworded
				// warning fails here rather than passing on any open dialog.
				iSeeTheUnsavedChangesWarning: function () {
					return this.waitFor({
						controlType: "sap.m.Dialog",
						searchOpenDialogs: true,
						check: function (aDialogs) {
							return aDialogs.some(function (oDialog) {
								return oDialog.getContent().some(function (oControl) {
									return typeof oControl.getText === "function" &&
										oControl.getText() === "You have unsaved changes to this catalog. Discard them?";
								});
							});
						},
						success: function () {
							Opa5.assert.ok(true, "the unsaved-changes warning is open");
						},
						errorMessage: "no unsaved-changes warning appeared"
					});
				},
				// The profiles mode says "profile", not "catalog" - a separate matcher, not a
				// looser one, so a warning with the wrong wording fails here rather than passing
				// on either text.
				iSeeTheUnsavedProfileWarning: function () {
					return this.waitFor({
						controlType: "sap.m.Dialog",
						searchOpenDialogs: true,
						check: function (aDialogs) {
							return aDialogs.some(function (oDialog) {
								return oDialog.getContent().some(function (oControl) {
									return typeof oControl.getText === "function" &&
										oControl.getText() === "You have unsaved changes to this profile. Discard them?";
								});
							});
						},
						success: function () {
							Opa5.assert.ok(true, "the profile's unsaved-changes warning is open");
						},
						errorMessage: "no unsaved-changes warning for the profile appeared"
					});
				},
				// Cancel must leave the highlight on the catalog the detail column is still
				// showing - the List has already moved it to the pressed row by the time
				// selectionChange fires, and onSelectCatalog puts it back.
				iSeeTheSelectedCatalog: function (sName) {
					return this.waitFor({
						id: "catalogList",
						viewName: sView,
						check: function (oList) {
							var oItem = oList.getSelectedItem();
							return !!oItem && oItem.getTitle() === sName;
						},
						success: function () {
							Opa5.assert.ok(true, "the selected catalog is " + sName);
						},
						errorMessage: "the selected catalog never became " + sName
					});
				},
				// Save is through once the header's group has no pending changes, nothing is staged and
				// the controller has cleared its in-flight flag (viewModel /catalogs/saving).
				iSeeTheCatalogSaved: function () {
					return this.waitFor({
						id: "catalogDescription",
						viewName: sView,
						check: function (oInput) {
							var oViewModel = oInput.getModel("viewModel");
							return !oInput.getModel().hasPendingChanges("catalogHeader") &&
								oViewModel.getProperty("/catalogs/pendingCount") === 0 &&
								!oViewModel.getProperty("/catalogs/saving");
						},
						success: function () {
							Opa5.assert.ok(true, "the catalog's changes were written");
						},
						errorMessage: "the catalog's changes were never written"
					});
				},
				iSeePickerOffersOnly: function (aAllowedIds) {
					return this.waitFor({
						id: "modelPicker",
						viewName: sView,
						check: function (oDialog) {
							return oDialog.getItems().length > 0;
						},
						success: function (oDialog) {
							var aOffered = offeredIds(oDialog);
							Opa5.assert.ok(aOffered.every(function (sId) {
								return aAllowedIds.indexOf(sId) !== -1;
							}), "picker offers only the parent's models (" + aOffered.length + ": " + aOffered.join(", ") + ")");
						},
						errorMessage: "the model picker never offered a model"
					});
				},
				// visible: false - both tabs must exist for either role, so a renamed or removed
				// tab fails instead of passing as "not visible".
				iSeeTabs: function (mVisible) {
					return this.waitFor({
						id: "exclusionsTab",
						viewName: sView,
						visible: false,
						check: function (oExclusions) {
							return sessionResolved(oExclusions) && oExclusions.getVisible() === mVisible.exclusions;
						},
						success: function (oExclusions) {
							Opa5.assert.strictEqual(oExclusions.getVisible(), mVisible.exclusions,
								"Exclusions tab visibility");
							this.waitFor({
								id: "assignmentsTab",
								viewName: sView,
								visible: false,
								check: function (oAssignments) {
									return oAssignments.getVisible() === mVisible.assignments;
								},
								success: function (oAssignments) {
									Opa5.assert.strictEqual(oAssignments.getVisible(), mVisible.assignments,
										"Assignments tab visibility");
								},
								errorMessage: "Assignments tab visibility never became " + mVisible.assignments
							});
						},
						errorMessage: "Exclusions tab visibility never became " + mVisible.exclusions
					});
				}
			}
		}
	});
});
