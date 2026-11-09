/**
 * The configuration form's field texts - labels, titles, descriptions - as bundle keys, with the
 * schema's own English as the fallback.
 *
 * The schema (`apiConfigSchema.ts`, a byte-equal copy of the backend's JSON) stays English and is
 * never edited for a language. Instead every text the form shows for a schema FIELD is looked up in
 * the config-app bundle under a key derived from the field's place in the document, and the schema's
 * own text (its `title`, the label derived from the property key, its `description`) is used where
 * the bundle has none. The English values in the default bundle are generated from the schema by
 * `ci/scripts/schema-texts.js`, byte-identical to what this fallback produces, so English output is
 * the same with or without the bundle.
 *
 * The key scheme (the generator follows the same rules, and `test/schemaTexts.test.ts` holds the two
 * to each other):
 *
 * - A path is the document path below `api_config`, segments joined with `.`:
 *   `platform.quotas.tokensPerDay`.
 * - A dynamically-keyed map entry (`additionalProperties` / `patternProperties`) is the fixed segment
 *   `_entry`, never the runtime key: `models.overrides._entry.pseudonymization.method`. An entry's own
 *   label is its key - document data - so `<map>._entry` has a description key and no label key.
 * - An array element is the fixed segment `items`: `observability.siem.sinks.items.url`.
 * - Composed `allOf` branches are folded into the node exactly as the form folds them
 *   (`composeAllOf`: the node's own property wins, then the first branch that declares it), so a path
 *   always has exactly one English text. Conditional `if`/`then` branches render no fields of their
 *   own and carry no keys. The schema has no `oneOf`/`anyOf`.
 * - Keys: `schema.<path>.label` and `schema.<path>.description`, every segment in `[A-Za-z0-9_-]`.
 *   A segment outside that set is not translated (the English is shown); the generator refuses it.
 *
 * Pure and UI5-free: the translator is injected (`ConfigForm._text`, which answers the key itself
 * for a key the bundle does not have), and nothing here reads a bundle or the DOM.
 */

import { messageTranslator } from './validationTexts';

/** Resolves a bundle key; answers the key itself (or undefined) when the bundle has no such key. */
export type SchemaTranslator = (key: string) => string | undefined;

/** The segment standing for any one key of a dynamically-keyed map. */
export const ENTRY_SEGMENT = '_entry';

/** The segment standing for any one element of an array. */
export const ITEMS_SEGMENT = 'items';

const SEGMENT = /^[A-Za-z0-9_-]+$/;

/** Field texts for the form: the bundle's text for a path, or the English given. */
export interface SchemaTexts {
    label(path: string | undefined, english: string): string;
    description(path: string | undefined, english: string): string;
    /** A form diagnostic (`formReason*` - see `./validationTexts`), its arguments inserted verbatim. */
    message(key: string, args?: (string | number)[]): string;
}

export function labelKey(path: string): string {
    return `schema.${path}.label`;
}

export function descriptionKey(path: string): string {
    return `schema.${path}.description`;
}

/** Whether a path can be keyed at all: non-empty, and every segment a plain key segment. */
export function isKeyablePath(path: string | undefined): path is string {
    return typeof path === 'string' && path.length > 0 && path.split('.').every(segment => SEGMENT.test(segment));
}

/** The path of a declared property `key` below `path`. */
export function childTextPath(path: string | undefined, key: string): string | undefined {
    if (path === undefined) {
        return undefined;
    }
    return path.length > 0 ? `${path}.${key}` : key;
}

/** The path of any entry of the map at `path`. */
export function entryTextPath(path: string | undefined): string | undefined {
    return childTextPath(path, ENTRY_SEGMENT);
}

/** The path of any element of the array at `path`. */
export function itemsTextPath(path: string | undefined): string | undefined {
    return childTextPath(path, ITEMS_SEGMENT);
}

/**
 * The path of a pointer whose every segment is a DECLARED property - a group, a section, a field of
 * one: `/api_config/platform/quotas` -> `platform.quotas`. The leading `api_config` is dropped,
 * since the whole form lives below it. A pointer through a map entry or an array element cannot be
 * read this way (its key is document data); the walk that reaches one builds the path itself.
 */
export function textPathOfPointer(pointer: string): string {
    const segments = pointer
        .split('/')
        .filter(segment => segment.length > 0)
        .map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (segments[0] === 'api_config') {
        segments.shift();
    }
    return segments.join('.');
}

/** How one map entry's texts are looked up - see `formContainers.mapEntryDescriptor`. */
export interface MapEntryTexts {
    texts: SchemaTexts;
    /** The entry's own text path. */
    path: string | undefined;
    /** The map's schema names this key, so its label is a schema text rather than document data. */
    declared: boolean;
}

/**
 * The texts of one entry of the map at `containerPath`: a key the map's schema declares as a
 * property is a path of its own (`providers.openai`); any other key is the map's `_entry`.
 */
export function mapEntryTexts(
    texts: SchemaTexts,
    containerPath: string | undefined,
    containerSchema: { properties?: Record<string, unknown> },
    key: string
): MapEntryTexts {
    const declared = Object.prototype.hasOwnProperty.call(containerSchema.properties ?? {}, key);
    return { texts, declared, path: declared ? childTextPath(containerPath, key) : entryTextPath(containerPath) };
}

/**
 * Field texts read through `translate`; with no translator, the English unchanged. A key the
 * translator does not know - it answers the key itself, an empty string or undefined - falls back to
 * the English, so a field added to the schema before its keys exist still reads in English.
 */
export function schemaTexts(translate?: SchemaTranslator): SchemaTexts {
    const lookup = (key: string, english: string): string => {
        if (!translate) {
            return english;
        }
        const text = translate(key);
        return typeof text === 'string' && text.length > 0 && text !== key ? text : english;
    };
    return {
        label: (path, english) => (isKeyablePath(path) ? lookup(labelKey(path), english) : english),
        description: (path, english) => (isKeyablePath(path) ? lookup(descriptionKey(path), english) : english),
        message: messageTranslator(translate)
    };
}

/** The English texts, unchanged - what the form shows where no translator is given. */
export const ENGLISH_SCHEMA_TEXTS: SchemaTexts = schemaTexts();
