/* global QUnit */
sap.ui.define([
	"sap/ui/test/opaQunit",
	"admin/securitynotifications/test/integration/expectations"
], function (opaTest, expectations) {
	"use strict";

	return {
		run: function () {
			var oEv = expectations.expect.fixtures.securityEvent;
			QUnit.module("Security notification object page (" + expectations.role + ")");
			opaTest("Shows the seeded notification's request context", function (Given, When, Then) {
				// The list is grouped by Pinned (UI.PresentationVariant), so a row's index in the
				// table aggregation is offset by the group header and every fixture run shares the
				// same Client IP - neither an index nor the IP alone identifies this run's own row
				// reliably. Navigate straight to it by ID (seed.js resolves the ID after creating it).
				Given.iStartMyApp("/MySecurityNotifications(ID=" + oEv.id + ")");
				Then.onTheObjectPage.iSeeThisPage();
				Then.onTheObjectPage.onForm("Notification Details").iCheckField("Client IP");
				Then.onTheObjectPage.onForm("Notification Details").iCheckField("User Agent");
				Then.onTheObjectPage.onForm("Notification Details").iCheckField("Endpoint");
				Then.onTheObjectPage.onForm("Notification Details").iCheckField("Request ID");
				Then.onTheObjectPage.iSeeStoredValue("clientIP", oEv.clientIP);
				Then.onTheObjectPage.iSeeStoredValue("requestId", oEv.requestId);
				Given.iTearDownMyApp();
			});
		}
	};
});
