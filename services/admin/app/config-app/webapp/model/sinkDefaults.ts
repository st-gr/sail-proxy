/**
 * Default credential slot names for a sink created through the form's [+] dialog.
 *
 * `SinkEditor#openAdd` (`../controller/ConfigFormSinks`) creates a new sink with only `name` and
 * `type` - every other field is left for the administrator to fill in through the form, and
 * renders at its schema default. A `*_env` field cannot work that way: the schema requires some of
 * them (datadog's `api_key_env`, s3's two access-key fields, ...), but the credential control
 * renders a slot *name* as read-only text with no way to type one in - it is not the field for a
 * secret value, so it must never become an editable text input. Without a default here, such a
 * sink could be created but never saved from the form: Save is refused for a field the form gives
 * no way to set.
 *
 * So every `*_env` field a newly created sink's type declares is seeded with a name following the
 * convention the shipped configuration already uses: `SIEM_` + the sink's name + `_` + the field
 * name with its `_env` suffix dropped, uppercased, with anything outside `[A-Z0-9_]` replaced by
 * `_`. The result always satisfies the schema's slot-name pattern `^[A-Z][A-Z0-9_]*$` - the `SIEM_`
 * prefix supplies the required leading letter regardless of what the sink is named - which matters
 * because that pattern is what keeps a pasted secret out of a public repo: `api_config.json` is
 * tracked in three synced copies there, and this field is a slot name, never a credential value.
 *
 * Two shipped slot names (`SIEM_AZURE_CLIENT_SECRET` for `azure_sentinel`,
 * `SIEM_GCS_SERVICE_ACCOUNT_JSON` for `gcs_pubsub`) do not follow this convention. They are
 * existing configuration and are never rewritten here - this only ever names a slot for a sink the
 * dialog is creating right now.
 */

interface JsonSchemaNode {
    properties?: Record<string, JsonSchemaNode>;
    items?: JsonSchemaNode;
    allOf?: JsonSchemaNode[];
    if?: JsonSchemaNode;
    then?: JsonSchemaNode;
    const?: unknown;
    [key: string]: unknown;
}

/**
 * The `*_env` fields a sink of `type` declares, read from the sink item schema's `allOf`/`if`/
 * `then` branches - the same discrimination the shipped schema uses to make e.g. `api_key_env`
 * apply only to `datadog`. `schema` is the `siem` section schema (as passed to `sinkTypes`), not
 * the item schema itself, so a caller does not have to know the array is nested under
 * `properties.sinks.items`.
 *
 * Schema-driven rather than a hand-written per-type table, so a seventh sink type or a renamed
 * slot needs no edit here.
 */
export function envFieldsForType(schema: Record<string, unknown>, type: string): string[] {
    const properties = (schema.properties ?? {}) as Record<string, JsonSchemaNode>;
    const items = (properties.sinks?.items ?? {}) as JsonSchemaNode;
    const branches = Array.isArray(items.allOf) ? items.allOf : [];

    for (const branch of branches) {
        const conditionProperties = branch.if?.properties ?? {};
        if (conditionProperties.type?.const === type) {
            const thenProperties = branch.then?.properties ?? {};
            return Object.keys(thenProperties).filter(field => field.endsWith("_env"));
        }
    }
    return [];
}

/**
 * The default slot name for `field` (a `*_env` property) of a sink named `sinkName`. See the
 * module doc for the convention and why it always satisfies the schema's pattern.
 */
export function defaultSlotName(sinkName: string, field: string): string {
    const base = `SIEM_${sinkName}_${field.replace(/_env$/, "")}`;
    return base.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

/**
 * The name the [+] dialog presets for a new sink of `type`: `<type>_<YYYYMMDD>_<HHMMSS>`, in UTC.
 *
 * A sink name has to be unique in its configuration - it keys the per-sink delivery rows - and an
 * empty field made that the user's problem, discovered only when the dialog rejected the name they
 * had chosen. A timestamp makes it unique by construction for the common case of adding sinks one
 * at a time. It does not replace the duplicate check: the field stays editable, and a name typed
 * over the preset is validated exactly as before.
 *
 * UTC, not local time, so two administrators in different zones cannot produce the same-looking
 * name for different instants - the collision the preset exists to avoid.
 *
 * The result feeds `defaultSlotName`, so it must survive uppercasing into `^[A-Z][A-Z0-9_]*$`:
 * digits and underscores only after the type, which the schema's own enum keeps within `[a-z_]`.
 * The longest shipped type (`azure_sentinel`) yields 30 characters, inside the schema's 40.
 */
export function presetSinkName(type: string, now: Date = new Date()): string {
    // "2026-08-22T14:15:30.123Z" -> "20260822_141530". Built off toISOString because it is the
    // only formatter that is UTC without a timezone database.
    const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
    return `${type}_${stamp}`;
}

/**
 * Every `*_env` field `type` declares, each set to its default slot name - what a sink named
 * `sinkName` and newly created through the form's [+] dialog should carry beyond `name` and `type`
 * so it can be saved from the form without a trip to the JSON editor.
 */
export function defaultSlotsFor(
    schema: Record<string, unknown>,
    sinkName: string,
    type: string
): Record<string, string> {
    const slots: Record<string, string> = {};
    for (const field of envFieldsForType(schema, type)) {
        slots[field] = defaultSlotName(sinkName, field);
    }
    return slots;
}
