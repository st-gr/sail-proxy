sap.ui.define([], function () {
	"use strict";

	// One of three verbatim copies (shell, api-keys-app, aws-credentials-app): keep them identical.
	// Decodes the role expectations that ci/scripts/ui-journeys/run.js injects into the
	// page URL as ?role=<name>&expect=<base64url JSON>. Never throws: opaTests.qunit.js
	// turns `error` into a failing QUnit test so the runner reports it readably.
	var oParams = new URLSearchParams(window.location.search);
	var sRole = oParams.get("role");
	var sEncoded = oParams.get("expect");
	var oResult = { role: sRole, expect: null, email: null, error: null };

	if (!sRole || !sEncoded) {
		oResult.error = "UI journeys need ?role=<name>&expect=<base64url JSON> - start them through ci/scripts/ui-journeys/run.js";
		return oResult;
	}
	try {
		var sBase64 = sEncoded.replace(/-/g, "+").replace(/_/g, "/");
		while (sBase64.length % 4) {
			sBase64 += "=";
		}
		var aBytes = Uint8Array.from(window.atob(sBase64), function (sChar) {
			return sChar.charCodeAt(0);
		});
		oResult.expect = JSON.parse(new TextDecoder().decode(aBytes));
		oResult.email = oResult.expect.email;
	} catch (oError) {
		oResult.error = "Cannot decode the 'expect' URL parameter: " + oError.message;
	}
	return oResult;
});
