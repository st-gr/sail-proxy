/**
 * The configuration form's validation and diagnostic messages, as bundle keys with English defaults.
 *
 * Two families live here. The `validation*` messages are the gate's own (`validateSection`,
 * `validateSinkNames`, `documentGate`): their English is the backend's api_config validator wording,
 * held to it message for message by `test/documentGate.test.ts`, so the English below must not move.
 * The `formReason*` messages say why the form shows a value as JSON (`schemaForm`'s raw descriptors).
 *
 * Pure and UI5-free: the bundle is injected as a raw-text lookup (`ConfigForm._text`, which answers
 * the key itself for a key the bundle does not have), and the patterns are formatted here the way
 * UI5's `formatMessage` formats them - `{n}` is an argument, `''` is one apostrophe. Without a lookup,
 * or for a key the bundle lacks, the English default is used, so the jest suites read English.
 * Arguments carry every dynamic part (pointers, limits, type names, property names, allowed lists);
 * they are inserted verbatim and never translated.
 */

/** Resolves a message key with optional {0} arguments to the text shown. */
export type Translator = (key: string, args?: (string | number)[]) => string;

/** A bundle's raw text for a key; the key itself, an empty string or undefined when it has none. */
export type TextLookup = (key: string) => string | undefined;

/** English defaults: each value is byte-identical to the default bundle's, so the pure tests hold. */
const EN_TEXTS: Record<string, string> = {
    validationAt: "Schema validation error at ''{0}'': {1}",
    validationType: 'must be {0}',
    validationEnum: 'must be equal to one of the allowed values',
    validationConst: 'must be equal to constant',
    validationMinimum: 'must be >= {0}',
    validationMaximum: 'must be <= {0}',
    validationMinLength: 'must NOT have fewer than {0} characters',
    validationMaxLength: 'must NOT have more than {0} characters',
    validationPattern: 'must match pattern "{0}"',
    validationUniqueItems: 'must NOT have duplicate items',
    validationMinItems: 'must NOT have fewer than {0} items',
    validationNot: 'must NOT be valid',
    validationRequired: "must have required property ''{0}''",
    validationAdditional: 'must NOT have additional properties',
    validationAdditionalNamed: "must NOT have additional properties (''{0}'')",
    validationPropertyName: 'property "{0}" is not one of the settings this provider reads',
    validationPropertyNameAllowed: 'property "{0}" is not one of the settings this provider reads (allowed: {1})',
    validationDuplicateSink: "Duplicate sink name at ''{0}'': \"{1}\" is already used by sink #{2}. Delivery rows are keyed by sink name, so two sinks sharing one would mark each other''s events delivered.",
    formReasonNoSchema: 'No schema is defined for this node.',
    formReasonType: 'Expected type "{0}", got "{1}".',
    formReasonArrayItems: 'Array item schema is not an object; no table representation.',
    formReasonUnsupported: 'Unsupported schema shape (type: "{0}").',
    formReasonUnknownProperty: 'No schema defines property "{0}".',
    formReasonOtherVariant: 'Property "{0}" does not belong to {1} "{2}".'
};

// UI5's own message-format grammar (sap/base/strings/formatMessage): '' | 'quoted' | {n} | a lone brace.
const MESSAGE_FORMAT = /('')|'([^']+(?:''[^']*)*)(?:'|$)|\{([0-9]+(?:\s*,[^{}]*)?)\}|[{}]/g;

/** Formats `pattern` as UI5's `formatMessage` does; a lone brace is kept rather than thrown on. */
export function formatPattern(pattern: string, args: (string | number)[] = []): string {
    return pattern.replace(MESSAGE_FORMAT, (whole: string, apostrophe?: string, quoted?: string, index?: string) => {
        if (apostrophe) {
            return "'";
        }
        if (quoted) {
            return quoted.replace(/''/g, "'");
        }
        if (index) {
            return String(args[parseInt(index, 10)]);
        }
        return whole;
    });
}

/** The English messages - what every validator says when no translator is handed in. */
export const ENGLISH_MESSAGES: Translator = (key, args) => formatPattern(EN_TEXTS[key] ?? key, args);

/**
 * Messages read through `lookup`; with no lookup, the English unchanged. A key the bundle does not
 * know falls back to its English default, so a message added before its keys still reads in English.
 */
export function messageTranslator(lookup?: TextLookup): Translator {
    if (!lookup) {
        return ENGLISH_MESSAGES;
    }
    return (key, args) => {
        const text = lookup(key);
        const pattern = typeof text === 'string' && text.length > 0 && text !== key ? text : EN_TEXTS[key] ?? key;
        return formatPattern(pattern, args);
    };
}

/**
 * A matcher for the messages `t` writes under `key`: their arguments back, in argument order, or
 * null for a text that is not such a message. Built from the translated pattern itself, so reading a
 * message back follows the language it was written in.
 */
export function messageMatcher(t: Translator, key: string, argCount: number): (text: string) => string[] | null {
    const markers = Array.from({ length: argCount }, (_unused, i) => `\u0000${i}\u0000`);
    const template = t(key, markers);
    const order: number[] = [];
    const source = template
        .split(/(\u0000\d+\u0000)/)
        .map(part => {
            const marker = /^\u0000(\d+)\u0000$/.exec(part);
            if (marker) {
                order.push(Number(marker[1]));
                return '([\\s\\S]*?)';
            }
            return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('');
    const regex = new RegExp(`^${source}$`);
    return text => {
        const match = regex.exec(text);
        if (!match) {
            return null;
        }
        const args: string[] = new Array(argCount).fill('');
        order.forEach((argument, group) => {
            args[argument] = match[group + 1];
        });
        return args;
    };
}
