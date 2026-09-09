/**
 * A JSON Schema validator for exactly the keyword subset the shipped `siemConfig` schema uses,
 * so the form's gate can be evaluated in the browser by every role.
 *
 * Why this exists rather than a call to `validateConfiguration`: that action is
 * `@(requires: 'admin')` and answers 403 to everyone else, so the live verdict was only
 * available to the one role that can already edit. Gating on a stored verdict instead made the
 * two roles disagree about the same document. This computes the same answer for both, from the
 * data the client already has.
 *
 * Scope, deliberately narrow: it validates the `siem` *section* against `siemConfig`, not the
 * whole document. The form renders only that section and passes everything else through
 * untouched, and an admin's save still runs the backend's whole-document Ajv check unchanged.
 *
 * Parity with the backend is not assumed, it is tested: `test/validateSection.test.ts` runs this
 * and the backend's own Ajv instance over the same corpus and asserts they agree. The backend
 * compiles with `{ allErrors: true, strict: false, validateFormats: false }`, so `format` is
 * deliberately not implemented here either - implementing it would make this stricter than the
 * contract the backend enforces.
 *
 * Supported keywords: type (a single name or draft-07's union LIST, e.g. ["boolean","string"]),
 * properties, patternProperties, required, additionalProperties, propertyNames, items, enum
 * (compared structurally, so a member that is not a string - `hybrid.rerank.enabled`'s true/false
 * beside "auto" - is matched by value, not by spelling), const, minimum, maximum, minLength,
 * maxLength, pattern, minItems, uniqueItems, allOf (each branch either an `if`/`then` conditional
 * or a plain fragment validated as-is), not.
 *
 * NOT implemented, and this list is the one to check before writing a schema against this gate: an
 * unimplemented keyword is SKIPPED, not reported, so every one of these validates fail-OPEN here
 * while the backend's Ajv still enforces it on save - the exact disagreement this module exists to
 * prevent. oneOf, anyOf, if/then/else outside an `allOf` branch (a branch's `else` included),
 * exclusiveMinimum, exclusiveMaximum, multipleOf, maxItems, contains, dependencies,
 * $ref (resolve it first - see the paragraph below) and format (deliberate - see above). Express a
 * union as a `type` list plus an `enum` rather than as a `oneOf`, which is what
 * `capabilities.file_search.hybrid.rerank.enabled` was rewritten to and why.
 *
 * `additionalProperties` is read in both of its draft-07 forms: the boolean `false` (reject an
 * unmatched key) and a schema (validate an unmatched key's value against it). The schema form used
 * to be ignored entirely, which made the gate fail OPEN over every dynamically-keyed map in the
 * document - `providers`' per-provider entries, `models.overrides`' per-model entries and
 * `hooks.defaults`' per-endpoint entries are all reached only that way, so setting
 * `providers.anthropic` to the literal string "not-even-an-object" passed the whole-document gate
 * and then reached `buildDescriptors` unvalidated. Matching order is draft-07's: `properties`
 * first, then `patternProperties`, and `additionalProperties` applies only to a key neither
 * matched.
 *
 * A `$ref` reached only through a schema-valued `additionalProperties` must therefore be resolved
 * before this runs, exactly like one under `properties` - `schemaForm.ts`'s `resolveRefsDeep` walks
 * it for that reason, and `documentGate.ts` (the one caller handing this a schema that has any) runs
 * every group through it first. The other caller, `ConfigForm.ts`, passes `siemSchemaDef`, which
 * carries no `$ref` at all.
 *
 * This module also exports `validateSinkNames`, a rule the schema cannot express and Ajv therefore
 * cannot report. It is kept out of `validateSection` precisely so the parity above stays true; see
 * its own comment.
 */

interface SchemaNode {
    type?: string | string[];
    properties?: Record<string, SchemaNode>;
    patternProperties?: Record<string, SchemaNode>;
    required?: string[];
    additionalProperties?: boolean | SchemaNode;
    propertyNames?: SchemaNode;
    items?: SchemaNode;
    enum?: unknown[];
    const?: unknown;
    minimum?: number;
    maximum?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    minItems?: number;
    uniqueItems?: boolean;
    allOf?: SchemaNode[];
    not?: SchemaNode;
    [key: string]: unknown;
}

/**
 * Returns one message per violation, empty when `data` satisfies `schema`. Messages follow the
 * backend's own wording - `Schema validation error at '<json pointer>': <message>` - so the two
 * read identically wherever they are shown side by side.
 */
export function validateSection(schema: object, data: unknown, pointerPrefix = ""): string[] {
    const errors: string[] = [];
    validateNode(schema as SchemaNode, data, pointerPrefix, errors);
    return errors;
}

/**
 * Reports every sink after the first that reuses another sink's `name`, empty when they are all
 * distinct.
 *
 * `name` is the key for a sink's delivery rows (`SiemDelivery.sinkName`, written at outbox.ts:54
 * and queried at :82 and :201) and for the dispatcher's per-sink backoff state. Two sinks sharing a
 * name therefore share delivery rows, and one marks the other's events delivered: the events are
 * never exported and nothing reports them missing. That is silent event loss, so a collision must
 * be caught before the document is saved, not after.
 *
 * Deliberately a second function rather than a keyword inside `validateSection`. That function's
 * contract is agreement with the backend's own Ajv instance, measured case by case in
 * `test/validateSection.test.ts`, and Ajv cannot report this: JSON Schema has no cross-item
 * uniqueness keyword, and `uniqueItems` compares whole objects, so two sinks that differ in any
 * other field satisfy it while still colliding on `name`. Folding it in would make the two
 * disagree. The form's gate calls both.
 */
export function validateSinkNames(siem: unknown, pointerPrefix = ""): string[] {
    if (!isPlainObject(siem)) {
        return [];
    }
    const sinks = (siem as Record<string, unknown>).sinks;
    if (!Array.isArray(sinks)) {
        return [];
    }

    const errors: string[] = [];
    sinks.forEach((sink, index) => {
        const name = sinkName(sink);
        if (name === null) {
            // Missing or blank is the schema's business (`required`, `minLength`), not this one's.
            return;
        }
        // Only the sinks before this one, so a collision is reported once - against the later of
        // the two, which is the one to rename.
        const clash = sinkNameClash(name, sinks.slice(0, index));
        if (clash !== -1) {
            errors.push(
                `Duplicate sink name at '${pointerPrefix}/sinks/${index}/name': ` +
                `"${name.trim()}" is already used by sink #${clash}. Delivery rows are keyed by sink name, ` +
                `so two sinks sharing one would mark each other's events delivered.`
            );
        }
    });
    return errors;
}

/**
 * The index of the sink in `sinks` already using `name`, or -1.
 *
 * Shared by `validateSinkNames` and by the form's add-sink dialog, so the rule the gate enforces
 * and the rule the dialog enforces are the same rule and cannot drift apart. Comparison is on the
 * trimmed name: " datadog" and "datadog" would be one key in the delivery table.
 */
export function sinkNameClash(name: string, sinks: unknown[]): number {
    const wanted = name.trim();
    if (wanted.length === 0) {
        return -1;
    }
    for (let index = 0; index < sinks.length; index++) {
        if (sinkName(sinks[index]) === wanted) {
            return index;
        }
    }
    return -1;
}

/** A sink's trimmed name, or null when it has none this rule can compare. */
function sinkName(sink: unknown): string | null {
    if (!isPlainObject(sink)) {
        return null;
    }
    const name = (sink as Record<string, unknown>).name;
    if (typeof name !== "string" || name.trim().length === 0) {
        return null;
    }
    return name.trim();
}

/** Where a message from this module belongs on screen, and what to say there. */
export interface FieldError {
    /** JSON pointer of the field the message is about. */
    pointer: string;
    /** The message's own reason, without the "Schema validation error at ..." preamble. */
    reason: string;
    /** True when the field is missing rather than wrong, so a caller can say so in its own words. */
    missing: boolean;
}

/**
 * Reads one of this module's own messages back into the field it concerns, so the form can put
 * the error on the control instead of only in a dialog.
 *
 * Parsing lives here, beside the code that writes the messages, rather than in the form: the
 * format is this module's, and a caller re-deriving it would drift the moment the wording moves.
 *
 * A missing property is reported against the *object* that lacks it (`must have required property
 * 'url'` at the sink), because that is where Ajv reports it and parity with the backend is the
 * point. The field the user has to fill in is one segment further down, so that segment is
 * appended here. Returns null for a message this module did not produce.
 */
export function fieldErrorOf(message: string): FieldError | null {
    const schemaError = /^Schema validation error at '([^']*)': (.*)$/.exec(message);
    if (schemaError) {
        const pointer = schemaError[1] === "root" ? "" : schemaError[1];
        const reason = schemaError[2];
        const missing = /^must have required property '(.*)'$/.exec(reason);
        return missing
            ? { pointer: `${pointer}/${escapeSegment(missing[1])}`, reason, missing: true }
            : { pointer, reason, missing: false };
    }
    const duplicateName = /^(Duplicate sink name at '([^']*)': .*)$/.exec(message);
    if (duplicateName) {
        return { pointer: duplicateName[2], reason: duplicateName[1], missing: false };
    }
    return null;
}

function validateNode(schema: SchemaNode, data: unknown, pointer: string, errors: string[]): void {
    if (!schema || typeof schema !== "object") {
        return;
    }

    if (schema.type !== undefined && !typeMatches(schema.type, data)) {
        const expected = Array.isArray(schema.type) ? schema.type.join(",") : schema.type;
        errors.push(error(pointer, `must be ${expected}`));
        // A wrong type makes every other keyword meaningless for this node.
        return;
    }

    if (Array.isArray(schema.enum) && !schema.enum.some(option => deepEqual(option, data))) {
        errors.push(error(pointer, "must be equal to one of the allowed values"));
    }

    if (Object.prototype.hasOwnProperty.call(schema, "const") && !deepEqual(schema.const, data)) {
        errors.push(error(pointer, `must be equal to constant`));
    }

    if (typeof data === "number") {
        if (typeof schema.minimum === "number" && data < schema.minimum) {
            errors.push(error(pointer, `must be >= ${schema.minimum}`));
        }
        if (typeof schema.maximum === "number" && data > schema.maximum) {
            errors.push(error(pointer, `must be <= ${schema.maximum}`));
        }
    }

    if (typeof data === "string") {
        if (typeof schema.minLength === "number" && data.length < schema.minLength) {
            errors.push(error(pointer, `must NOT have fewer than ${schema.minLength} characters`));
        }
        if (typeof schema.maxLength === "number" && data.length > schema.maxLength) {
            errors.push(error(pointer, `must NOT have more than ${schema.maxLength} characters`));
        }
        if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(data)) {
            errors.push(error(pointer, `must match pattern "${schema.pattern}"`));
        }
    }

    if (Array.isArray(data)) {
        if (schema.uniqueItems === true && hasDuplicates(data)) {
            errors.push(error(pointer, "must NOT have duplicate items"));
        }
        // The schema's one `minItems` guards a hook's `match` list (`$defs/hookEntryArray`), where an
        // empty list is not a hook with no condition - it is a hook that fires on every request.
        // Unimplemented, this gate called such a document valid and the backend's Ajv then rejected it
        // on save, which is precisely the disagreement this module exists to prevent.
        if (typeof schema.minItems === "number" && data.length < schema.minItems) {
            errors.push(error(pointer, `must NOT have fewer than ${schema.minItems} items`));
        }
        if (schema.items) {
            data.forEach((item, index) => validateNode(schema.items as SchemaNode, item, `${pointer}/${index}`, errors));
        }
    }

    if (isPlainObject(data)) {
        validateObject(schema, data as Record<string, unknown>, pointer, errors);
    }

    if (Array.isArray(schema.allOf)) {
        for (const branch of schema.allOf) {
            validateBranch(branch, data, pointer, errors);
        }
    }

    // `not` is how draft-07 spells "and must NOT carry this". The schema uses it once, inside the
    // `then` of a hook definition's json-path-regex/url-regex branch, to reject an `equals` those
    // two matchers never read. Ajv reports it as one error on the object itself, and so does this -
    // an inner failure is what SATISFIES a `not`, so the inner messages are deliberately discarded.
    if (isPlainObject(schema.not)) {
        const negated: string[] = [];
        validateNode(schema.not as SchemaNode, data, pointer, negated);
        if (negated.length === 0) {
            errors.push(error(pointer, "must NOT be valid"));
        }
    }
}

function validateObject(schema: SchemaNode, data: Record<string, unknown>, pointer: string, errors: string[]): void {
    for (const key of schema.required || []) {
        if (!Object.prototype.hasOwnProperty.call(data, key)) {
            errors.push(error(pointer, `must have required property '${key}'`));
        }
    }

    const properties = schema.properties || {};
    for (const key of Object.keys(properties)) {
        if (Object.prototype.hasOwnProperty.call(data, key)) {
            validateNode(properties[key], data[key], `${pointer}/${escapeSegment(key)}`, errors);
        }
    }

    // A key not named in `properties` may still be declared through a regex in
    // `patternProperties` (hooks.definitions, platform.logging.components,
    // platform.rate_limit_handling's two delay maps): such a key is both validated against its
    // matching subschema(s) and, unlike a truly unknown key, never flagged by additionalProperties
    // below.
    const patternEntries = Object.entries(schema.patternProperties || {})
        .map(([pattern, subschema]) => ({ regex: new RegExp(pattern), subschema }));
    const matchedByPattern = new Set<string>();
    if (patternEntries.length > 0) {
        for (const key of Object.keys(data)) {
            if (Object.prototype.hasOwnProperty.call(properties, key)) {
                continue;
            }
            for (const { regex, subschema } of patternEntries) {
                if (regex.test(key)) {
                    matchedByPattern.add(key);
                    validateNode(subschema, data[key], `${pointer}/${escapeSegment(key)}`, errors);
                }
            }
        }
    }

    // What draft-07 does with a key neither `properties` nor `patternProperties` matched: reject it
    // when `additionalProperties` is `false`, validate it against that subschema when it is one, and
    // accept it untouched otherwise (`true`, or absent). The schema form is what every dynamically
    // keyed map in this document relies on - see this module's header - so ignoring it made the gate
    // accept a provider entry that is not even an object.
    const additional = schema.additionalProperties;
    const additionalSchema = isPlainObject(additional) ? (additional as SchemaNode) : undefined;
    if (additional === false || additionalSchema) {
        for (const key of Object.keys(data)) {
            if (Object.prototype.hasOwnProperty.call(properties, key) || matchedByPattern.has(key)) {
                continue;
            }
            if (additionalSchema) {
                validateNode(additionalSchema, data[key], `${pointer}/${escapeSegment(key)}`, errors);
            } else {
                errors.push(error(pointer, `must NOT have additional properties`));
            }
        }
    }

    // `propertyNames` validates each KEY of the object, as a string, against its own schema. It is
    // how draft-07 closes a node whose properties arrive through `allOf` branches, which is what five
    // of the six named providers are (`google` is the exception - it declares its one honoured field
    // through a targeted `$ref` and is closed with a plain `additionalProperties: false`):
    // `additionalProperties` is scoped to the schema object that declares
    // it and cannot see a branch's `properties`, so putting `additionalProperties: false` on
    // `providers.openai` would reject the very fields `$defs/providerCommon` contributes. An `enum`
    // of the names that provider's own code reads rejects the ones it does not - an
    // `anthropic_bedrock_version` under openai - without restating those fields under every provider.
    //
    // Ajv reports such a failure as TWO errors against the OBJECT - an inner `enum` saying only
    // "must be equal to one of the allowed values", and a `propertyNames` umbrella - naming neither
    // the key nor the allowed set, and reading like a complaint about a value. The backend
    // (`src/srv/schemaErrors.ts`'s `formatSchemaError`) rewrites the inner one to name both and to
    // point one segment deeper, at the key itself, because that is the pointer the form renders a
    // control at for an undeclared key, and drops the umbrella as a duplicate. This emits that one
    // message per offending key, identically, so the two verdicts read the same and land on the
    // same control - compared message for message in `test/documentGate.test.ts`.
    const propertyNames = schema.propertyNames;
    if (isPlainObject(propertyNames)) {
        for (const key of Object.keys(data)) {
            const nameErrors: string[] = [];
            validateNode(propertyNames as SchemaNode, key, pointer, nameErrors);
            if (nameErrors.length > 0) {
                errors.push(propertyNameError(pointer, key, (propertyNames as SchemaNode).enum));
            }
        }
    }
}

/**
 * The message for a key its object's `propertyNames` rejects, in the backend's own wording. The
 * allowed set is named only when the schema states one as an `enum`, which is what Ajv can put in
 * `params.allowedValues` and therefore all the backend can name.
 */
function propertyNameError(pointer: string, key: string, allowed: unknown): string {
    const allowedSuffix = Array.isArray(allowed) ? ` (allowed: ${allowed.join(", ")})` : "";
    return error(
        `${pointer}/${escapeSegment(key)}`,
        `property "${key}" is not one of the settings this provider reads${allowedSuffix}`
    );
}

/**
 * An `allOf` branch, which in this schema is always `{ if, then }`: the `then` schema applies
 * only when the `if` schema matches, and a non-matching `if` is not itself an error.
 */
function validateBranch(branch: SchemaNode, data: unknown, pointer: string, errors: string[]): void {
    const condition = branch.if as SchemaNode | undefined;
    const consequent = branch.then as SchemaNode | undefined;

    if (!condition) {
        validateNode(branch, data, pointer, errors);
        return;
    }

    const conditionErrors: string[] = [];
    validateNode(condition, data, pointer, conditionErrors);
    if (conditionErrors.length === 0 && consequent) {
        validateNode(consequent, data, pointer, errors);
    }
}

function typeMatches(type: string | string[], data: unknown): boolean {
    const types = Array.isArray(type) ? type : [type];
    return types.some(expected => {
        if (expected === "integer") {
            return typeof data === "number" && Number.isInteger(data);
        }
        if (expected === "number") {
            return typeof data === "number";
        }
        if (expected === "array") {
            return Array.isArray(data);
        }
        if (expected === "object") {
            return isPlainObject(data);
        }
        if (expected === "null") {
            return data === null;
        }
        return typeof data === expected;
    });
}

function isPlainObject(data: unknown): boolean {
    return data !== null && typeof data === "object" && !Array.isArray(data);
}

function hasDuplicates(items: unknown[]): boolean {
    const seen: string[] = [];
    for (const item of items) {
        const key = JSON.stringify(item);
        if (seen.indexOf(key) !== -1) {
            return true;
        }
        seen.push(key);
    }
    return false;
}

function deepEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

function escapeSegment(segment: string): string {
    return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function error(pointer: string, message: string): string {
    return `Schema validation error at '${pointer || "root"}': ${message}`;
}
