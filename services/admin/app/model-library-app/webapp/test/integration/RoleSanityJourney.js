/* global QUnit */
sap.ui.define(["admin/modellibrary/test/integration/expectations"], function (expectations) {
	"use strict";

	// One of seven verbatim copies (shell, api-keys-app, aws-credentials-app, model-library-app, users-app, security-notifications-app, tool-policies-app): keep them identical.
	// Fails first and explicitly when the browser is not signed in as the expected role
	// (wrong credentials, wrong target, admin fallback) - before any OPA journey runs.
	return {
		run: function () {
			QUnit.module("Role sanity (" + expectations.role + ")");
			QUnit.test("whoami answers as the expected user and role", function (assert) {
				var fnDone = assert.async();
				fetch("/odata/v4/admin/whoami", {
					method: "POST",
					headers: { "Content-Type": "application/json", "Accept": "application/json" },
					body: "{}"
				}).then(function (oResponse) {
					assert.strictEqual(oResponse.status, 200, "whoami responded 200 (Basic auth reached the OData service)");
					return oResponse.json();
				}).then(function (oBody) {
					assert.strictEqual(oBody.user, expectations.email, "signed in as " + expectations.email);
					assert.strictEqual(oBody.isAdmin, expectations.expect.isAdmin, "isAdmin matches the role matrix");
				}).catch(function (oError) {
					assert.ok(false, "whoami failed: " + oError.message);
				}).then(fnDone);
			});
		}
	};
});
