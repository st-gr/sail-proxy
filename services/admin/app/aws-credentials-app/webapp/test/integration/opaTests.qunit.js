/* global QUnit */
sap.ui.require([
	"sap/fe/test/JourneyRunner",
	"admin/awscredentials/test/integration/expectations",
	"admin/awscredentials/test/integration/pages/ListReport",
	"admin/awscredentials/test/integration/pages/ObjectPage",
	"admin/awscredentials/test/integration/RoleSanityJourney",
	"admin/awscredentials/test/integration/ListJourney",
	"admin/awscredentials/test/integration/ObjectPageJourney",
	"admin/awscredentials/test/integration/EditJourney",
	"admin/awscredentials/test/integration/CreateJourney"
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
		launchUrl: sap.ui.require.toUrl("admin/awscredentials") + "/test/app.html",
		opaConfig: { autoWait: true, timeout: 60 },
		pages: { onTheListReport: ListReport, onTheObjectPage: ObjectPage }
	});
	// run() registers the journeys' tests in microtasks; QUnit.start() begins on the next macrotask.
	oRunner.run(RoleSanityJourney.run, ListJourney.run, ObjectPageJourney.run, EditJourney.run, CreateJourney.run);
	QUnit.start();
});
