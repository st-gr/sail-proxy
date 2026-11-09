/* global QUnit */
sap.ui.require([
	"sap/ui/test/Opa5",
	"sap/ui/test/launchers/iFrameLauncher",
	"admin/modellibrary/test/integration/expectations",
	"admin/modellibrary/test/integration/pages/Library",
	"admin/modellibrary/test/integration/pages/Detail",
	"admin/modellibrary/test/integration/pages/Catalogs",
	"admin/modellibrary/test/integration/RoleSanityJourney",
	"admin/modellibrary/test/integration/LibraryJourney",
	"admin/modellibrary/test/integration/FilterJourney",
	"admin/modellibrary/test/integration/DetailJourney",
	"admin/modellibrary/test/integration/PriceJourney",
	"admin/modellibrary/test/integration/CatalogsJourney",
	"admin/modellibrary/test/integration/ProfilesJourney"
], function (Opa5, iFrameLauncher, expectations, Library, Detail, Catalogs, RoleSanityJourney, LibraryJourney,
		FilterJourney, DetailJourney, PriceJourney, CatalogsJourney, ProfilesJourney) {
	"use strict";

	if (expectations.error) {
		QUnit.test("UI journeys bootstrap", function (assert) {
			assert.ok(false, expectations.error);
		});
		QUnit.start();
		return;
	}

	// Every journey here reads the seeded catalog, its members and the model count. They are only
	// in the URL when seed.js ran its model-library part (it needs the gateway the pipeline starts
	// in Phase 5); without them the journeys would fail with a bare TypeError.
	if (!expectations.expect.fixtures || !expectations.expect.fixtures.library) {
		QUnit.test("UI journeys bootstrap", function (assert) {
			assert.ok(false, "no model-library fixtures in the 'expect' parameter - " +
				"ci/scripts/ui-journeys/seed.js did not seed the library for this run");
		});
		QUnit.start();
		return;
	}

	// The detail page is a sap.uxap.ObjectPageLayout, whose screen-size handler re-arms a 350 ms
	// timeout while the frame settles; with the default maxDelay (1000) OPA's auto-waiter treats
	// it as blocking and never reaches the page. Timeouts above 300 ms are not waited for.
	Opa5.extendConfig({
		arrangements: new Opa5(),
		autoWait: { timeoutWaiter: { maxDelay: 300 } },
		timeout: 60,
		viewNamespace: "admin.modellibrary.view."
	});

	// A journey that fails before its own iTeardownMyApp leaves the frame open, and the next
	// journey's iStartMyAppInAFrame then fails with "Launch was called twice" — tear it down here
	// so one failure stays one failure.
	QUnit.testDone(function (details) {
		if (details.failed > 0 && iFrameLauncher.hasLaunched()) {
			iFrameLauncher.teardown();
		}
	});

	RoleSanityJourney.run();
	LibraryJourney.run();
	FilterJourney.run();
	DetailJourney.run();
	PriceJourney.run();
	CatalogsJourney.run();
	ProfilesJourney.run();
	QUnit.start();
});
