/* global QUnit */
sap.ui.require([
	"sap/fe/test/JourneyRunner",
	"sap/ui/test/launchers/iFrameLauncher",
	"admin/users/test/integration/expectations",
	"admin/users/test/integration/pages/ListReport",
	"admin/users/test/integration/pages/ObjectPage",
	"admin/users/test/integration/RoleSanityJourney",
	"admin/users/test/integration/ListJourney",
	"admin/users/test/integration/ObjectPageJourney",
	"admin/users/test/integration/EditJourney",
	"admin/users/test/integration/LifecycleJourney",
	"admin/users/test/integration/ResetQuotaJourney"
], function (JourneyRunner, iFrameLauncher, expectations, ListReport, ObjectPage,
	RoleSanityJourney, ListJourney, ObjectPageJourney, EditJourney, LifecycleJourney, ResetQuotaJourney) {
	"use strict";

	if (expectations.error) {
		QUnit.test("UI journeys bootstrap", function (assert) {
			assert.ok(false, expectations.error);
		});
		QUnit.start();
		return;
	}

	var oRunner = new JourneyRunner({
		launchUrl: sap.ui.require.toUrl("admin/users") + "/test/app.html",
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
	oRunner.run(RoleSanityJourney.run, ListJourney.run, ObjectPageJourney.run, EditJourney.run, LifecycleJourney.run, ResetQuotaJourney.run);
	QUnit.start();
});
