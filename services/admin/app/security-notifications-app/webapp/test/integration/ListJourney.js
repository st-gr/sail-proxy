/* global QUnit */
sap.ui.define([
	"sap/ui/test/opaQunit",
	"admin/securitynotifications/test/integration/expectations"
], function (opaTest, expectations) {
	"use strict";

	return {
		run: function () {
			var oEv = expectations.expect.fixtures.securityEvent;
			var bSeesClientIp = expectations.expect.securityNotifications.seesClientIp;
			QUnit.module("Security notifications list (" + expectations.role + ")");
			opaTest("The list shows the Client IP column with the seeded address", function (Given, When, Then) {
				Given.iStartMyApp();
				Then.onTheListReport.iSeeThisPage();
				// roles.js drives the column: a role expecting false asserts the column is absent
				// (iCheckColumns treats visible:false as "no such column, or an invisible one").
				Then.onTheListReport.onTable().iCheckColumns({ "Client IP": { visible: bSeesClientIp } });
				// No expected count: seed.js runs once per role x app in a full pipeline pass, so
				// several notifications can carry this fixture IP by the time this journey runs -
				// only its presence is asserted here; ObjectPageJourney confirms the seeded row itself.
				// A hidden column has no cell to read, so the value assertion belongs to the roles
				// that see it; the column assertion above is what covers the other case.
				if (bSeesClientIp) {
					Then.onTheListReport.onTable().iCheckRows({ "Client IP": oEv.clientIP });
				}
				Given.iTearDownMyApp();
			});
		}
	};
});
