/* global QUnit */
sap.ui.require([
	"sap/ui/test/Opa5",
	"sap/ui/test/launchers/iFrameLauncher",
	"admin/logs/test/integration/expectations",
	"admin/logs/test/integration/pages/Logs",
	"admin/logs/test/integration/RoleSanityJourney",
	"admin/logs/test/integration/LogsJourney"
], function (Opa5, iFrameLauncher, expectations, LogsPage, RoleSanityJourney, LogsJourney) {
	"use strict";

	if (expectations.error) {
		QUnit.test("UI journeys bootstrap", function (assert) { assert.ok(false, expectations.error); });
		QUnit.start();
		return;
	}

	Opa5.extendConfig({
		arrangements: new Opa5(),
		autoWait: { timeoutWaiter: { maxDelay: 300 } },
		timeout: 60,
		viewNamespace: "admin.logs.view."
	});

	// A failed journey leaves its app frame open; the next one must start from a clean page.
	QUnit.testDone(function (details) {
		if (details.failed > 0 && iFrameLauncher.hasLaunched()) { iFrameLauncher.teardown(); }
	});

	RoleSanityJourney.run();
	LogsJourney.run();
	QUnit.start();
});
