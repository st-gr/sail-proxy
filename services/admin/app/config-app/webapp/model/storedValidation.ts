/**
 * The validation results a configuration carries, as the detail page lists them.
 *
 * The service stores `validationErrors` and `validationWarnings` as JSON array strings (see
 * `createConfiguration` in src/srv/config-service.ts), so binding either straight to a text shows
 * `["…","…"]`. This turns the pair into one message per entry, errors first, for the Validation
 * Results panel to render one MessageStrip each.
 *
 * It lives here rather than in the controller because this repo's jest cannot resolve `sap/*`,
 * and a rule written inside a module that imports it cannot be unit-tested.
 */

/** One stored validation result. `type` is the MessageStrip type it renders with. */
export interface StoredValidationMessage {
    type: "Error" | "Warning";
    text: string;
}

/** The entries of one stored field. A value that is not a JSON array is shown as it is. */
function entries(stored: unknown): string[] {
    if (typeof stored !== "string" || stored.trim() === "") {
        return [];
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(stored);
    } catch (error) {
        return [stored];
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
        .map(entry => {
            if (typeof entry === "string") {
                return entry;
            }
            const message = (entry as { message?: unknown } | null)?.message;
            return typeof message === "string" ? message : JSON.stringify(entry);
        })
        .filter(text => text.trim() !== "");
}

export function storedValidationMessages(errors: unknown, warnings: unknown): StoredValidationMessage[] {
    return [
        ...entries(errors).map(text => ({ type: "Error" as const, text })),
        ...entries(warnings).map(text => ({ type: "Warning" as const, text }))
    ];
}
