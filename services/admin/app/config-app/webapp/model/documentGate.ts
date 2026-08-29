/**
 * Whole-document gate: decides whether the loaded configuration document validates against the
 * full `api_config` schema, group by group, in the browser - for every role.
 *
 * `validateSection` (./validateSection) validates one already-resolved schema node against one
 * data value; it deliberately has no `$ref` support (see its own header). The six top-level groups
 * of `api_config` (providers, models, capabilities, hooks, platform, observability) are each
 * declared in the schema as a `$ref` into `$defs`, and several groups nest further `$ref`s inside
 * `properties`/`allOf` branches (observability.pseudonymization, observability.siem, and the
 * provider-config branch of providers.openai/providers.openrouter). Handing `validateSection` an
 * unresolved `{ "$ref": ... }` node makes it validate against an empty schema, which accepts
 * everything - a fail-OPEN gate. This module expands every such ref first, with
 * `schemaForm.ts`'s `resolveRefsDeep` (built on the same `resolveRef` `buildDescriptors` relies on
 * for rendering, and shared with `apiConfigGroups.ts`, which needs the identical guarantee for the
 * section schemas it hands the form), rather than teaching `validateSection` about `$ref`.
 *
 * That walk covers `properties`, `items`, `allOf` (`if`/`then`), `patternProperties` and a
 * schema-valued `additionalProperties`, because `validateSection` reads all five.
 * `additionalProperties` used to be skipped, on the reasoning that `validateSection` only ever
 * consulted it as the boolean `false`; that made resolution and validation agree, but agree on
 * failing OPEN - the per-provider keys of `providers`, the per-model keys of `models.overrides` and
 * the per-endpoint keys of `hooks.defaults` are each reached only through a schema-valued
 * `additionalProperties`, so nothing checked them at all and `providers.anthropic` could be the
 * literal string "not-even-an-object" and still pass. `validateSection` now validates such a key
 * against that subschema, so the `$ref` inside it (`$defs/providerCommon`, `$defs/modelOverride`)
 * has to be expanded first or the gate would validate it against `{ "$ref": ... }`, an empty
 * schema, and fail open exactly as it did before.
 *
 * The backend's Ajv check on save remains the authority; this gate only decides whether the browser
 * can safely represent the document as loaded, and a miss here is not a miss there.
 */
import { resolveRefsDeep, JsonSchemaNode } from './schemaForm';
import { validateSection, validateSinkNames } from './validateSection';

/** The six groups `api_config` may carry - the only keys its own `additionalProperties: false` allows. */
const GROUPS = ['providers', 'models', 'capabilities', 'hooks', 'platform', 'observability'] as const;
type Group = (typeof GROUPS)[number];
const GROUP_SET: ReadonlySet<string> = new Set(GROUPS);

export interface DocumentGateResult {
    valid: boolean;
    errors: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validates every group present in `document.api_config` against `schema`, aggregating every
 * group's errors. A group the document does not carry is fine - every group is optional in the
 * schema - but a present, invalid group, or a key `api_config` does not declare (an old
 * pre-restructure flat document's own top-level keys, e.g. `hookDefinitions` or `siem` sitting
 * directly under `api_config` rather than under `observability`), fails the gate.
 *
 * `document` may be anything read back from `JSON.parse`: this is the one entry point the gate
 * gives an untrusted document, so it degrades to "invalid" rather than throwing on a shape it does
 * not expect.
 */
export function evaluateApiConfigDocument(schema: Record<string, unknown>, document: unknown): DocumentGateResult {
    const root = schema as unknown as JsonSchemaNode;

    if (!isPlainObject(document)) {
        return { valid: false, errors: [`Schema validation error at 'root': must be object`] };
    }

    const apiConfig = document.api_config;
    if (apiConfig === undefined) {
        // Nothing to represent yet - the same "fine" this form has always given an empty document.
        return { valid: true, errors: [] };
    }
    if (!isPlainObject(apiConfig)) {
        return { valid: false, errors: [`Schema validation error at '/api_config': must be object`] };
    }

    const errors: string[] = [];

    for (const key of Object.keys(apiConfig)) {
        if (!GROUP_SET.has(key)) {
            errors.push(`Schema validation error at '/api_config': must NOT have additional properties ('${key}')`);
        }
    }

    const apiConfigProperties = (root.properties?.api_config as JsonSchemaNode | undefined)?.properties || {};

    for (const group of GROUPS) {
        if (!Object.prototype.hasOwnProperty.call(apiConfig, group)) {
            continue;
        }
        const pointer = `/api_config/${group}`;
        const groupSchema = resolveRefsDeep(apiConfigProperties[group as Group], root);
        errors.push(...validateSection(groupSchema as unknown as object, apiConfig[group], pointer));

        if (group === 'observability') {
            const observability = apiConfig[group];
            const siem = isPlainObject(observability) ? observability.siem : undefined;
            if (siem !== undefined) {
                errors.push(...validateSinkNames(siem, `${pointer}/siem`));
            }
        }
    }

    return { valid: errors.length === 0, errors };
}
