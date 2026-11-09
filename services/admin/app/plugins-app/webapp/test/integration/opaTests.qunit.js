/* global QUnit */
sap.ui.require([
	"sap/ui/test/Opa5",
	"sap/ui/test/launchers/iFrameLauncher",
	"admin/plugins/test/integration/expectations",
	"admin/plugins/test/integration/pages/Plugins",
	"admin/plugins/test/integration/RoleSanityJourney",
	"admin/plugins/test/integration/PluginsJourney"
], function (Opa5, iFrameLauncher, expectations, PluginsPage, RoleSanityJourney, PluginsJourney) {
	"use strict";

	if (expectations.error) {
		QUnit.test("UI journeys bootstrap", function (assert) { assert.ok(false, expectations.error); });
		QUnit.start();
		return;
	}
	if (!expectations.expect.fixtures || !expectations.expect.fixtures.plugin) {
		QUnit.test("UI journeys bootstrap", function (assert) {
			assert.ok(false, "The plugin fixtures are missing: seed.js did not run for plugins-app.");
		});
		QUnit.start();
		return;
	}

	Opa5.extendConfig({
		arrangements: new Opa5(),
		autoWait: { timeoutWaiter: { maxDelay: 300 } },
		timeout: 60,
		viewNamespace: "admin.plugins.view."
	});

	// A failed journey leaves its app frame open; the next one must start from a clean page.
	QUnit.testDone(function (details) {
		if (details.failed > 0 && iFrameLauncher.hasLaunched()) { iFrameLauncher.teardown(); }
	});

	RoleSanityJourney.run();
	PluginsJourney.run();
	QUnit.start();
});
