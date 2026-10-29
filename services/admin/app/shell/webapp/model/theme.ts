/**
 * The cockpit theme: Light, Dark or System (follows prefers-color-scheme). The choice lives in
 * localStorage (STORAGE_KEY) because it must be known before UI5 boots; the signed-in user's choice
 * is also kept on the server (UserPreferences.theme) and adopted on load. index.html carries a
 * dependency-free copy of resolveTheme in an inline script; keep the two in step.
 */
export const STORAGE_KEY = "sail.cockpit.theme";

export const LIGHT = "sap_horizon";
export const DARK = "sap_horizon_dark";
export const SYSTEM = "system";

/** The choices the Settings dialog offers; the server accepts exactly these. */
export const SUPPORTED: readonly string[] = [LIGHT, DARK, SYSTEM];

export function isSupported(choice: string | null | undefined): boolean {
	return typeof choice === "string" && SUPPORTED.includes(choice);
}

/** The stored choice, Light when nothing (or something unknown) is stored. */
export function currentChoice(stored: string | null | undefined): string {
	return isSupported(stored) ? (stored as string) : LIGHT;
}

/** The UI5 theme id for a choice: System picks dark or light by prefersDark; unknown is Light. */
export function themeFor(choice: string | null | undefined, prefersDark: boolean): string {
	if (choice === SYSTEM) return prefersDark ? DARK : LIGHT;
	return choice === DARK ? DARK : LIGHT;
}

/**
 * The theme a URL forces, as UI5 reads it: `sap-theme` or `sap-ui-theme` (null when neither is set).
 * Such an override wins over the stored and the account choice and stops System from following the OS.
 */
export function urlThemeOverride(search: string): string | null {
	const params = new URLSearchParams(search);
	return params.get("sap-theme") || params.get("sap-ui-theme") || null;
}

/** The URL override (urlThemeOverride) wins, then the stored choice, else Light. */
export function resolveTheme(
	urlParam: string | null | undefined,
	stored: string | null | undefined,
	prefersDark: boolean
): string {
	if (urlParam) return urlParam;
	return themeFor(currentChoice(stored), prefersDark);
}

/**
 * Whether the signed-in user's theme (server) replaces this browser's choice on load: not when it
 * is missing or unsupported, not under a sap-theme URL override, not when both mean the same choice.
 * Adopting is live (Theming.setTheme), so unlike the language there is no reload to guard.
 */
export function serverThemeAction(
	server: string | null | undefined,
	stored: string | null | undefined,
	urlParam: string | null | undefined
): "adopt" | "none" {
	if (!isSupported(server) || urlParam) return "none";
	return server === currentChoice(stored) ? "none" : "adopt";
}

/**
 * What a saved Settings choice does: apply it only when the account took it. Applied locally after
 * a failed save, the next load would adopt the account's older theme and silently revert it.
 */
export function themeChangeAction(choice: string, savedForAccount: boolean): "apply" | "keep" | "ignore" {
	if (!isSupported(choice)) return "ignore";
	return savedForAccount ? "apply" : "keep";
}

/** Whether prefers-color-scheme changes must re-apply the theme (System, no URL override). */
export function followsSystem(choice: string | null | undefined, urlParam: string | null | undefined): boolean {
	return choice === SYSTEM && !urlParam;
}
