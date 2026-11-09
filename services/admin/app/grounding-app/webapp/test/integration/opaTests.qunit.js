/* global QUnit */
sap.ui.require([
	"sap/ui/test/Opa5",
	"sap/ui/test/launchers/iFrameLauncher",
	"admin/grounding/test/integration/expectations",
	"admin/grounding/test/integration/pages/Stores",
	"admin/grounding/test/integration/pages/Files",
	"admin/grounding/test/integration/pages/Jobs",
	"admin/grounding/test/integration/pages/Admin",
	"admin/grounding/test/integration/RoleSanityJourney",
	"admin/grounding/test/integration/StoresJourney",
	"admin/grounding/test/integration/FilesJourney",
	"admin/grounding/test/integration/JobsJourney",
	"admin/grounding/test/integration/AdministrationJourney"
], function (Opa5, iFrameLauncher, expectations, StoresPage, FilesPage, JobsPage, AdminPage, RoleSanityJourney, StoresJourney, FilesJourney, JobsJourney, AdministrationJourney) {
	"use strict";

	if (expectations.error) {
		QUnit.test("UI journeys bootstrap", function (assert) { assert.ok(false, expectations.error); });
		QUnit.start();
		return;
	}
	if (!expectations.expect.fixtures || !expectations.expect.fixtures.grounding) {
		QUnit.test("UI journeys bootstrap", function (assert) {
			assert.ok(false, "The grounding fixtures are missing: seed.js did not run for grounding-app (it needs the Phase 5 gateway with a file_search database).");
		});
		QUnit.start();
		return;
	}

	Opa5.extendConfig({
		arrangements: new Opa5(),
		autoWait: { timeoutWaiter: { maxDelay: 300 } },
		timeout: 60,
		viewNamespace: "admin.grounding.view."
	});

	// A failed journey leaves its app frame open; the next one must start from a clean page.
	QUnit.testDone(function (details) {
		if (details.failed > 0 && iFrameLauncher.hasLaunched()) { iFrameLauncher.teardown(); }
	});

	RoleSanityJourney.run();
	StoresJourney.run();
	FilesJourney.run();
	JobsJourney.run();
	AdministrationJourney.run();
	QUnit.start();
});
