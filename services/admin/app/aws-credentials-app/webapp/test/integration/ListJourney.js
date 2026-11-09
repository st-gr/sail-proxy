/* global QUnit */
sap.ui.define([
	"sap/ui/test/opaQunit",
	"admin/awscredentials/test/integration/expectations"
], function (opaTest, expectations) {
	"use strict";

	return {
		run: function () {
			var oExpect = expectations.expect.awsCredentials;
			var oNames = expectations.expect.fixtures;
			QUnit.module("AWS credentials list (" + expectations.role + ")");
			opaTest("The list shows own rows, other users' rows only per role, and the lifecycle columns", function (Given, When, Then) {
				Given.iStartMyApp();
				Then.onTheListReport.iSeeThisPage();
				Then.onTheListReport.onTable().iCheckRows({ "Name": oNames.userAwsCredential }, 1);
				Then.onTheListReport.onTable().iCheckRows({ "Name": oNames.otherUserAwsCredential }, oExpect.seesOtherUsersRows ? 1 : 0);
				Then.onTheListReport.onTable().iCheckColumns({ "Expires": { visible: true }, "Never Expires": { visible: true } });
				Given.iTearDownMyApp();
			});
		}
	};
});
