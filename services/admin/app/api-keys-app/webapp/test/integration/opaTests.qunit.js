/* global QUnit */
sap.ui.require([
	"sap/fe/test/JourneyRunner",
	"admin/app/test/integration/expectations",
	"admin/app/test/integration/pages/ListReport",
	"admin/app/test/integration/pages/ObjectPage",
	"admin/app/test/integration/RoleSanityJourney",
	"admin/app/test/integration/ListJourney",
	"admin/app/test/integration/ObjectPageJourney",
	"admin/app/test/integration/EditJourney",
	"admin/app/test/integration/CreateJourney"
], function (JourneyRunner, expectations, ListReport, ObjectPage,
	RoleSanityJourney, ListJourney, ObjectPageJourney, EditJourney, CreateJourney) {
	"use strict";

	if (expectations.error) {
		QUnit.test("UI journeys bootstrap", function (assert) {
			assert.ok(false, expectations.error);
		});
		QUnit.start();
		return;
	}

	var oRunner = new JourneyRunner({
		launchUrl: sap.ui.require.toUrl("admin/app") + "/test/app.html",
		opaConfig: { autoWait: true, timeout: 60 },
		pages: { onTheListReport: ListReport, onTheObjectPage: ObjectPage }
	});
	// run() registers the journeys' tests in microtasks; QUnit.start() begins on the next macrotask.
	oRunner.run(RoleSanityJourney.run, ListJourney.run, ObjectPageJourney.run, EditJourney.run, CreateJourney.run);
	QUnit.start();
});
