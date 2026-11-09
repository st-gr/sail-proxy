/**
 * What the text in a NULLABLE number field means.
 *
 * A field whose schema type is a union with `"null"` in it may be empty, and empty is a value:
 * every `platform.quotas.*` field reads `null` as "unlimited". A `StepInput` cannot express that -
 * its value is a float that defaults to 0, and 0 is a quota of nothing rather than the absence of
 * one - so such a field is rendered as a plain `sap.m.Input` and its text has to be read back into
 * either a number or `null`, with the schema's own `integer`/`minimum`/`maximum` enforced at the
 * control the way the StepInput enforced them before.
 *
 * The rule lives here rather than inside `./descriptorControls.ts` for the same reason
 * `./formContainers.ts` and `./formViewport.ts` do: that module imports `sap/*`, which this repo's
 * jest cannot resolve, so a rule written inside it cannot be unit-tested at all.
 *
 * `error` is an i18n *key*, not resolved text - this module has no resource bundle, and the one
 * that has resolves it (see `formContainers.ts`'s header for the same rule).
 */

/** The bounds a number field enforces, as the descriptor carries them. */
export interface NullableNumberField {
    /** The schema said `integer`, so a decimal is not a value this field can take. */
    integer: boolean;
    minimum?: number;
    maximum?: number;
}

/**
 * Either the value to write into the document - a number, or `null` for an emptied field - or the
 * i18n key of what is wrong with the text, with the bound it broke where one applies.
 */
export type NullableNumberEntry =
    | { value: number | null }
    | { error: "formNotANumber" | "formNotAWholeNumber"; bound?: undefined }
    | { error: "formBelowMinimum" | "formAboveMaximum"; bound: number };

/**
 * Reads one typed value. Whitespace only is empty, and empty is `null` - it is checked before the
 * number is parsed, because `Number("")` is 0 and 0 is a quota. A bound is never applied to an
 * emptied field either: unlimited is not "below the minimum".
 */
export function nullableNumberEntry(text: string, field: NullableNumberField): NullableNumberEntry {
    const trimmed = text.trim();
    if (trimmed === "") {
        return { value: null };
    }
    const parsed = Number(trimmed);
    // `Number.isFinite` and not `isNaN`: "Infinity" parses to a number no document should carry.
    if (!Number.isFinite(parsed)) {
        return { error: "formNotANumber" };
    }
    if (field.integer && !Number.isInteger(parsed)) {
        return { error: "formNotAWholeNumber" };
    }
    if (typeof field.minimum === "number" && parsed < field.minimum) {
        return { error: "formBelowMinimum", bound: field.minimum };
    }
    if (typeof field.maximum === "number" && parsed > field.maximum) {
        return { error: "formAboveMaximum", bound: field.maximum };
    }
    return { value: parsed };
}
