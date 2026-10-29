/**
 * The cockpit language. The choice lives in localStorage (STORAGE_KEY, "" = follow the browser)
 * because it must be known before UI5 boots; the signed-in user's choice is also kept on the server
 * (UserPreferences.language) and adopted on load. index.html carries a dependency-free copy of
 * resolveLanguage in an inline script; keep the two in step.
 */
export const STORAGE_KEY = "sail.cockpit.language";

/** The languages every cockpit bundle has; "" means the browser default. */
export const SUPPORTED: readonly string[] = ["", "en", "de", "es", "fr", "it", "nl", "pt"];

export function isSupported(code: string | null | undefined): boolean {
	return typeof code === "string" && SUPPORTED.includes(code);
}

/**
 * URL `sap-language` wins, then a supported stored choice, then the first browser language whose
 * primary subtag is supported, else English.
 */
export function resolveLanguage(
	urlParam: string | null | undefined,
	stored: string | null | undefined,
	browserList: readonly string[] | null | undefined
): string {
	if (urlParam) return urlParam;
	if (stored && isSupported(stored)) return stored;
	for (const tag of browserList || []) {
		const primary = String(tag).toLowerCase().split("-")[0];
		if (primary && isSupported(primary)) return primary;
	}
	return "en";
}

/** sessionStorage marker: the language code this tab already reloaded to adopt (one reload per distinct server value). */
export const SESSION_RELOAD_KEY = "sail.cockpit.languageAdopted";

/**
 * Whether the signed-in user's stored language (server, null = never chosen) should replace this
 * browser's choice: not when never chosen or unsupported, not under a sap-language URL override,
 * not when both already mean the same language ("" and nothing stored both follow the browser).
 */
export function needsServerLanguage(
	server: string | null | undefined,
	stored: string | null | undefined,
	urlParam: string | null | undefined
): boolean {
	if (server === null || server === undefined || !isSupported(server)) return false;
	if (urlParam) return false;
	const current = isSupported(stored) ? stored : "";
	return server !== current;
}

/**
 * What the shell does after loading the user's preferences: reload once to adopt a differing
 * server language, but only when this browser's storage took the new value (storageWritable)
 * and the tab has not already reloaded for this very value (adoptedMarker, the code stored by the
 * last adoption, null when none), so a blocked storage can never cause a reload loop while a
 * different user signing in on the same tab still gets their own language.
 */
export function serverLanguageAction(
	server: string | null | undefined,
	stored: string | null | undefined,
	urlParam: string | null | undefined,
	storageWritable: boolean,
	adoptedMarker: string | null
): "reload" | "none" {
	if (!needsServerLanguage(server, stored, urlParam)) return "none";
	if (!storageWritable || adoptedMarker === server) return "none";
	return "reload";
}

/**
 * What a Settings choice does once the save to the account has finished: apply it (store and
 * reload) only when the account took it. Applied locally after a failed save, the next load would
 * adopt the account's older language again and silently revert the choice, so the current
 * language stays and the user is told to try again.
 */
export function languageChangeAction(code: string, savedForAccount: boolean): "apply" | "keep" | "ignore" {
	if (!isSupported(code)) return "ignore";
	return savedForAccount ? "apply" : "keep";
}
