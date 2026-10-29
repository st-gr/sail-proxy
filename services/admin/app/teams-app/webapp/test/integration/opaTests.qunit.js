/* global QUnit */
sap.ui.require([
	"sap/fe/test/JourneyRunner",
	"sap/ui/test/launchers/iFrameLauncher",
	"admin/teams/test/integration/expectations",
	"admin/teams/test/integration/pages/ListReport",
	"admin/teams/test/integration/pages/ObjectPage",
	"admin/teams/test/integration/RoleSanityJourney",
	"admin/teams/test/integration/ListJourney",
	"admin/teams/test/integration/ObjectPageJourney",
	"admin/teams/test/integration/EditJourney",
	"admin/teams/test/integration/TeamAdminJourney",
	"admin/teams/test/integration/MembersJourney",
	"admin/teams/test/integration/MembersInEditJourney"
], function (JourneyRunner, iFrameLauncher, expectations, ListReport, ObjectPage,
	RoleSanityJourney, ListJourney, ObjectPageJourney, EditJourney, TeamAdminJourney, MembersJourney, MembersInEditJourney) {
	"use strict";

	if (expectations.error) {
		QUnit.test("UI journeys bootstrap", function (assert) {
			assert.ok(false, expectations.error);
		});
		QUnit.start();
		return;
	}

	var oRunner = new JourneyRunner({
		launchUrl: sap.ui.require.toUrl("admin/teams") + "/test/app.html",
		// The object page is a sap.uxap.ObjectPageLayout, whose screen-size handler re-arms a
		// 350 ms timeout while the frame settles; with the default maxDelay (1000) OPA's
		// auto-waiter treats it as blocking and never reaches the page. Timeouts above 300 ms
		// are not waited for.
		opaConfig: { autoWait: { timeoutWaiter: { maxDelay: 300 } }, timeout: 60 },
		pages: { onTheListReport: ListReport, onTheObjectPage: ObjectPage }
	});

	// A journey that fails before its own iTearDownMyApp leaves the frame open, and the next
	// journey's iStartMyApp then fails with "Launch was called twice" - tear it down here so
	// one failure stays one failure.
	QUnit.testDone(function (details) {
		if (details.failed > 0 && iFrameLauncher.hasLaunched()) {
			iFrameLauncher.teardown();
		}
	});

	// run() registers the journeys' tests in microtasks; QUnit.start() begins on the next macrotask.
	var aJourneys = [RoleSanityJourney.run, ListJourney.run, ObjectPageJourney.run, MembersJourney.run];
	if (expectations.expect.teams.canManage) aJourneys.push(EditJourney.run, MembersInEditJourney.run); else aJourneys.push(TeamAdminJourney.run);
	oRunner.run.apply(oRunner, aJourneys);
	QUnit.start();
});
