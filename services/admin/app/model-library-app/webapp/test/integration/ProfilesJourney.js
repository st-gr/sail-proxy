/* global QUnit */
sap.ui.define([
	"sap/ui/test/opaQunit",
	"admin/modellibrary/test/integration/expectations"
], function (opaTest, expectations) {
	"use strict";

	return {
		run: function () {
			var oLib = expectations.expect.library;
			// The journey creates and deletes its own profile; the seed purges anything named
			// "UI Fixture …" that a failed run left behind, and never the three starters.
			var sProfile = expectations.expect.fixtures.profile;
			// Assignments are made to the signed-in administrator's own user row: it exists on
			// every run (the seed creates a key for it) without needing the quota fixtures, which
			// are only seeded when the shell or users-app journeys are in the run.
			var sUser = expectations.email;
			QUnit.module("Entitlements & Quotas — quota profiles (" + expectations.role + ")");
			opaTest("Quota profiles: create, edit the limits, guard, assign and unassign, delete", function (Given, When, Then) {
				if (!oLib.canAssign) {
					// Admin-only, hash included: #/profiles without the role lands on the catalogs
					// and the switch is not offered at all.
					Given.iStartMyAppInAFrame("../../index.html?sap-ui-animationMode=none#/profiles");
					Then.onTheCatalogs.iDoNotSeeTheModeSwitch();
					Then.onTheCatalogs.iSeeCatalogNamed("Default");
					Then.iTeardownMyApp();
					return;
				}
				// The FlexibleColumnLayout waits for every column's transitionend before OPA may
				// continue; under CI load that event can stay out, and the wait polls with a 0 ms timer
				// OPA counts as blocking until its own timeout. No animations, no wait (sap.f FCL
				// `hasAnimations` is false for animation mode none).
				Given.iStartMyAppInAFrame("../../index.html?sap-ui-animationMode=none#/catalogs");
				// The switch navigates to #/profiles, which is what fills the list (its binding is
				// suspended until an administrator asks for it).
				When.onTheCatalogs.iSwitchToProfiles();
				Then.onTheCatalogs.iSeeProfileNamed("Standard");
				When.onTheCatalogs.iOpenNewProfile();
				When.onTheCatalogs.iNameTheProfile(sProfile);
				When.onTheCatalogs.iConfirmCreateProfile();
				Then.onTheCatalogs.iSeeProfileNamed(sProfile);
				Then.onTheCatalogs.iSeeProfileUsers(sProfile, 0);
				When.onTheCatalogs.iSelectProfileNamed(sProfile);
				// I: a limit is an explicit save like the header - and leaving with one unsaved
				// asks first, in the profile's own wording.
				When.onTheCatalogs.iTypeInTheLimit("tokensPerDay", "1000");
				Then.onTheCatalogs.iSeeTheSaveButtonsEnabled(true);
				When.onTheCatalogs.iSelectProfileNamed("Standard");
				Then.onTheCatalogs.iSeeTheUnsavedProfileWarning();
				When.onTheCatalogs.iDiscardInTheWarning();
				When.onTheCatalogs.iSelectProfileNamed(sProfile);
				When.onTheCatalogs.iTypeInTheLimit("tokensPerDay", "1000");
				When.onTheCatalogs.iTypeInTheLimit("tokensPerWeek", "5000");
				When.onTheCatalogs.iPressSave();
				Then.onTheCatalogs.iSeeTheProfileSaved();
				// L: the assignment is staged - the row says so - and Save writes it through
				// assignQuotaProfile, after which the list row counts the user.
				When.onTheCatalogs.iAssignUser(sUser);
				Then.onTheCatalogs.iSeeAssignedProfile(sUser, sProfile + " (unsaved)");
				When.onTheCatalogs.iPressSave();
				Then.onTheCatalogs.iSeeTheProfileSaved();
				Then.onTheCatalogs.iSeeAssignedProfile(sUser, sProfile);
				Then.onTheCatalogs.iSeeProfileUsers(sProfile, 1);
				// A profile somebody carries cannot be deleted, so the journey gives the user back
				// first - and only then is the delete allowed to go through.
				When.onTheCatalogs.iUnassignUser(sUser);
				When.onTheCatalogs.iPressSave();
				Then.onTheCatalogs.iSeeTheProfileSaved();
				Then.onTheCatalogs.iSeeProfileUsers(sProfile, 0);
				When.onTheCatalogs.iPressDeleteProfile();
				When.onTheCatalogs.iConfirmTheMessageBox();
				Then.onTheCatalogs.iDoNotSeeProfileNamed(sProfile);
				Then.iTeardownMyApp();
			});
		}
	};
});
