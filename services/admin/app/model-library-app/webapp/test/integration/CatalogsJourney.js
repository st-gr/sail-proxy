/* global QUnit */
sap.ui.define([
	"sap/ui/test/opaQunit",
	"admin/modellibrary/test/integration/expectations"
], function (opaTest, expectations) {
	"use strict";

	return {
		run: function () {
			var oLib = expectations.expect.library;
			var oNames = expectations.expect.fixtures;
			var oFx = oNames.library;
			// the catalog this journey creates: a child of the user's assigned catalog for the
			// user, a root catalog for the admin
			var sNewCatalog = oLib.seesAllModels ? oNames.adminCatalog : oNames.userCatalog;
			var sMember = oFx.memberIds[0];
			QUnit.module("Entitlements & Quotas — catalogs (" + expectations.role + ")");
			opaTest("Catalogs: create a child, stage and save members, discard and guard, admin tabs", function (Given, When, Then) {
				// Animations off: the FlexibleColumnLayout otherwise waits for column transitionend
				// events that can stay out under CI load (see ProfilesJourney).
				Given.iStartMyAppInAFrame("../../index.html?sap-ui-animationMode=none#/catalogs");
				Then.onTheCatalogs.iSeeCatalogNamed("Default");
				Then.onTheCatalogs.iSeeCatalogNamed(oNames.teamCatalog);
				When.onTheCatalogs.iOpenNewCatalog();
				When.onTheCatalogs.iNameIt(sNewCatalog);
				When.onTheCatalogs.iConfirmCreate();
				Then.onTheCatalogs.iSeeCatalogNamed(sNewCatalog);
				When.onTheCatalogs.iSelectCatalogNamed(sNewCatalog);
				When.onTheCatalogs.iPressAddModels();
				if (!oLib.seesAllModels) {
					// a user's catalog is a child of their assigned catalog and may only hold its models
					Then.onTheCatalogs.iSeePickerOffersOnly(oFx.memberIds);
				}
				// L: picking a model stages it - the row says so and Save is what writes it. After
				// Save the row is reloaded from the server and shows its availability instead.
				When.onTheCatalogs.iPickModelsInDialog([sMember]);
				Then.onTheCatalogs.iSeeMembers([sMember]);
				Then.onTheCatalogs.iSeeMemberState(sMember, "Added — unsaved");
				Then.onTheCatalogs.iSeeTheSaveButtonsEnabled(true);
				When.onTheCatalogs.iPressSave();
				Then.onTheCatalogs.iSeeTheCatalogSaved();
				Then.onTheCatalogs.iSeeMemberState(sMember, "Available");
				// L: a removal is staged the same way, and Discard puts the row back.
				When.onTheCatalogs.iSelectMemberRow(sMember);
				When.onTheCatalogs.iPressRemoveMembers();
				Then.onTheCatalogs.iSeeMemberState(sMember, "Removed — unsaved");
				When.onTheCatalogs.iPressDiscard();
				Then.onTheCatalogs.iSeeMemberState(sMember, "Available");
				Then.onTheCatalogs.iSeeTheSaveButtonsEnabled(false);
				// I: the header no longer saves on its own - Discard puts the field back (which it
				// could not do if the edit had already been sent), Save persists it.
				When.onTheCatalogs.iTypeInTheDescription("discarded by the journey");
				Then.onTheCatalogs.iSeeTheSaveButtonsEnabled(true);
				When.onTheCatalogs.iPressDiscard();
				Then.onTheCatalogs.iSeeTheDescription("");
				Then.onTheCatalogs.iSeeTheSaveButtonsEnabled(false);
				When.onTheCatalogs.iTypeInTheDescription("saved by the journey");
				When.onTheCatalogs.iPressSave();
				Then.onTheCatalogs.iSeeTheCatalogSaved();
				// re-binding the detail page re-reads the catalog, so this is the persisted value
				When.onTheCatalogs.iSelectCatalogNamed("Default");
				When.onTheCatalogs.iSelectCatalogNamed(sNewCatalog);
				Then.onTheCatalogs.iSeeTheDescription("saved by the journey");
				Then.onTheCatalogs.iSeeMemberState(sMember, "Available");
				// I + L: leaving with anything unsaved asks first - here a staged removal. Cancel keeps
				// the staged change and the list's highlight where they were; Discard drops the change
				// and lets the switch through.
				When.onTheCatalogs.iSelectMemberRow(sMember);
				When.onTheCatalogs.iPressRemoveMembers();
				Then.onTheCatalogs.iSeeMemberState(sMember, "Removed — unsaved");
				When.onTheCatalogs.iSelectCatalogNamed("Default");
				Then.onTheCatalogs.iSeeTheUnsavedChangesWarning();
				When.onTheCatalogs.iCancelTheWarning();
				Then.onTheCatalogs.iSeeTheSelectedCatalog(sNewCatalog);
				Then.onTheCatalogs.iSeeMemberState(sMember, "Removed — unsaved");
				When.onTheCatalogs.iSelectCatalogNamed("Default");
				Then.onTheCatalogs.iSeeTheUnsavedChangesWarning();
				When.onTheCatalogs.iDiscardInTheWarning();
				Then.onTheCatalogs.iSeeTheSelectedCatalog("Default");
				Then.onTheCatalogs.iSeeTabs({ exclusions: oLib.canManageDefault, assignments: oLib.canAssign });
				// the discarded removal was never written: the member is still there
				When.onTheCatalogs.iSelectCatalogNamed(sNewCatalog);
				Then.onTheCatalogs.iSeeMemberState(sMember, "Available");
				// Deleting the journey's own catalog: the seed purges every non-default catalog on
				// each run, so this leaves nothing behind. Nothing exercised deletion before, which
				// is how the DELETE landing in the header's deferred update group - where nothing
				// ever submitted it - stayed invisible to the suite.
				When.onTheCatalogs.iPressDeleteCatalog();
				When.onTheCatalogs.iConfirmTheMessageBox();
				Then.onTheCatalogs.iDoNotSeeCatalogNamed(sNewCatalog);
				Then.iTeardownMyApp();
			});
		}
	};
});
