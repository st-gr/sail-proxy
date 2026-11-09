/**
 * The decisions around the runtime schema (`pluginSchemas.ts`) that must never cost the standard
 * configuration its form: which fetched state a selection may take, how the gate evaluates when a
 * plugin schema misbehaves, and why a gate failure is worded as a plugin's.
 *
 * Pure and UI5-free.
 */
import { evaluateApiConfigDocument } from './documentGate';
import { PluginSchemaEntry, composeApiConfigSchema, hasHelpFallback } from './pluginSchemas';
import { fieldErrorOf } from './validateSection';
import { ENGLISH_MESSAGES, Translator } from './validationTexts';

type Schema = Record<string, unknown>;

/** What a selection's plugin fetch contributes to the form. */
export interface PluginState {
    schema: Schema;
    helpFallback: boolean;
}

/**
 * The state to adopt for the selection `token`, or undefined when another selection has begun since
 * the fetch started. A slow answer from an old selection must not replace the schema a newer one is
 * already editing against.
 */
export function pluginStateIfCurrent(
    token: number,
    currentToken: number,
    base: object,
    plugins: PluginSchemaEntry[]
): PluginState | undefined {
    if (token !== currentToken) {
        return undefined;
    }
    return { schema: composeApiConfigSchema(base, plugins) as Schema, helpFallback: hasHelpFallback(plugins) };
}

/**
 * Evaluates `document` against `schema`; if that throws (a plugin schema the checks cannot run),
 * logs and evaluates against `base` instead. `degraded` tells the caller to stop using `schema`.
 */
export function evaluateGuarded(
    base: Schema,
    schema: Schema,
    document: unknown,
    t: Translator = ENGLISH_MESSAGES
): { valid: boolean; errors: string[]; degraded: boolean } {
    try {
        return { ...evaluateApiConfigDocument(schema, document, t), degraded: false };
    } catch (error) {
        console.warn('ConfigForm: plugin settings schemas could not be evaluated; using the standard schema', error);
        return { ...evaluateApiConfigDocument(base, document, t), degraded: true };
    }
}

/**
 * The plugin ids behind a failed gate when EVERY error is under `/api_config/plugins/<id>`;
 * undefined when any error is elsewhere (or unreadable), so the standard wording applies.
 */
export function pluginOnlyFailure(errors: string[], t: Translator = ENGLISH_MESSAGES): string[] | undefined {
    const ids: string[] = [];
    for (const message of errors) {
        const pointer = fieldErrorOf(message, t)?.pointer ?? '';
        const match = /^\/api_config\/plugins\/([^/]+)/.exec(pointer);
        if (!match) {
            return undefined;
        }
        const id = match[1].replace(/~1/g, '/').replace(/~0/g, '~');
        if (!ids.includes(id)) ids.push(id);
    }
    return ids.length > 0 ? ids : undefined;
}

/**
 * The tooltip of the disabled form button. A failure caused only by plugin settings names the
 * plugin(s) and the JSON view (`pluginText` has `{0}` for the ids); any other failure keeps the
 * standard text followed by the errors.
 */
export function gateFailureReason(
    errors: string[],
    standardText: string,
    pluginText: string,
    t: Translator = ENGLISH_MESSAGES
): string {
    const ids = pluginOnlyFailure(errors, t);
    if (ids) {
        return pluginText.replace('{0}', ids.join(', ')) + '\n' + errors.join('\n');
    }
    return standardText + '\n' + errors.join('\n');
}
