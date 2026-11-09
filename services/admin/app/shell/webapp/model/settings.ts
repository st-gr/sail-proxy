/** The values the Settings dialog edits: language ("" = browser default) and theme choice. */
export interface SettingsValues {
	language: string;
	theme: string;
}

/**
 * The settings Save writes to the account, in order: only the changed ones, the theme first (it is
 * applied live) and the language last (applying it reloads the cockpit).
 */
export function changedSettings(current: SettingsValues, edited: SettingsValues): (keyof SettingsValues)[] {
	const changed: (keyof SettingsValues)[] = [];
	if (edited.theme !== current.theme) changed.push("theme");
	if (edited.language !== current.language) changed.push("language");
	return changed;
}
