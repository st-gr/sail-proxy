/* global QUnit */
sap.ui.require([
	"sap/ui/test/Opa5",
	"admin/shell/test/integration/expectations",
	"admin/shell/test/integration/pages/App",
	"admin/shell/test/integration/RoleSanityJourney",
	"admin/shell/test/integration/NavigationJourney"
], function (Opa5, expectations, App, RoleSanityJourney, NavigationJourney) {
	"use strict";

	if (expectations.error) {
		QUnit.test("UI journeys bootstrap", function (assert) {
			assert.ok(false, expectations.error);
		});
		QUnit.start();
		return;
	}

	Opa5.extendConfig({
		arrangements: new Opa5(),
		autoWait: true,
		timeout: 60,
		viewNamespace: "admin.shell.view."
	});

	RoleSanityJourney.run();
	NavigationJourney.run();
	QUnit.start();
});
