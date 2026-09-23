/* global QUnit */
sap.ui.require([
	"sap/fe/test/JourneyRunner",
	"sap/ui/test/launchers/iFrameLauncher",
	"admin/toolpolicies/test/integration/expectations",
	"admin/toolpolicies/test/integration/pages/ListReport",
	"admin/toolpolicies/test/integration/pages/ObjectPage",
	"admin/toolpolicies/test/integration/pages/Inventory",
	"admin/toolpolicies/test/integration/RoleSanityJourney",
	"admin/toolpolicies/test/integration/PoliciesJourney"
], function (JourneyRunner, iFrameLauncher, expectations, ListReport, ObjectPage, Inventory,
	RoleSanityJourney, PoliciesJourney) {
	"use strict";

	if (expectations.error) {
		QUnit.test("UI journeys bootstrap", function (assert) {
			assert.ok(false, expectations.error);
		});
		QUnit.start();
		return;
	}

	var oRunner = new JourneyRunner({
		launchUrl: sap.ui.require.toUrl("admin/toolpolicies") + "/test/app.html",
		// The object page is a sap.uxap.ObjectPageLayout, whose screen-size handler re-arms a
		// 350 ms timeout while the frame settles; with the default maxDelay (1000) OPA's
		// auto-waiter treats it as blocking and never reaches the page. Timeouts above 300 ms
		// are not waited for.
		opaConfig: { autoWait: { timeoutWaiter: { maxDelay: 300 } }, timeout: 60 },
		// The FlexibleColumnLayout underlying List Report/Object Page navigation waits for a
		// column transitionend under CI load, which can block OPA until timeout; animations off.
		launchParameters: { "sap-ui-animationMode": "none" },
		pages: { onTheListReport: ListReport, onTheObjectPage: ObjectPage, onTheInventory: Inventory }
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
	oRunner.run(RoleSanityJourney.run, PoliciesJourney.run);
	QUnit.start();
});
