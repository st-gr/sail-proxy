/**
 * The enabled plugins' settings schemas, and the runtime copy of the api_config schema that carries
 * them (spec 2026-11-04 §6, form editor).
 *
 * `GET /api/plugins/settings-schemas?lang=` answers `[{ id, schema, summary, helpFallback }]` for the
 * enabled plugins only, with each schema's `title` and `description` already in the chosen language.
 * `composeApiConfigSchema` declares each one as a property of `plugins`, so the form, the document
 * gate and the edit checks all see the same schema. The shipped `apiConfigSchema` is never touched:
 * the standard configuration works whatever this fetch does, and a key with no schema (a disabled
 * plugin's settings) stays on the read-only raw path.
 *
 * Pure and UI5-free: the fetch is injected.
 */

/** One plugin as the endpoint answers it. */
export interface PluginSchemaEntry {
    id: string;
    schema: object;
    summary?: string;
    /** The plugin had no help in the UI language; its texts are in another one. */
    helpFallback?: boolean;
}

/** The shape of `fetch` this module needs. */
export type FetchLike = (url: string, init?: { credentials?: 'include'; headers?: Record<string, string>; signal?: AbortSignal }) =>
    Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** A plugin schema larger than this, serialized, is not composed: it would slow every gate run. */
export const MAX_PLUGIN_SCHEMA_BYTES = 256 * 1024;

/** How long the settings-schemas request may take before the form goes on without plugins. */
export const FETCH_TIMEOUT_MS = 3000;

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The first `pattern` or `patternProperties` key in `node` that is not a valid regular expression. */
function uncompilablePattern(node: unknown): string | undefined {
    if (Array.isArray(node)) {
        for (const item of node) {
            const bad = uncompilablePattern(item);
            if (bad !== undefined) return bad;
        }
        return undefined;
    }
    if (!isPlainObject(node)) {
        return undefined;
    }
    const patterns: string[] = [];
    if (typeof node.pattern === 'string') patterns.push(node.pattern);
    if (isPlainObject(node.patternProperties)) patterns.push(...Object.keys(node.patternProperties));
    for (const source of patterns) {
        try {
            new RegExp(source);
        } catch {
            return source;
        }
    }
    for (const value of Object.values(node)) {
        const bad = uncompilablePattern(value);
        if (bad !== undefined) return bad;
    }
    return undefined;
}

/**
 * Whether a plugin's schema may join the form's schema. The checks and form run it in the browser on
 * every edit, so a regular expression that throws, or a schema this large, would cost the standard
 * configuration its form; such a plugin is left out (logged) and its settings stay on the raw path.
 */
function schemaIsSafe(id: string, schema: object): boolean {
    const bytes = new TextEncoder().encode(JSON.stringify(schema)).length;
    if (bytes > MAX_PLUGIN_SCHEMA_BYTES) {
        console.warn(`ConfigForm: plugin '${id}' settings schema is ${bytes} bytes, over ${MAX_PLUGIN_SCHEMA_BYTES}; its settings stay JSON-only`);
        return false;
    }
    const bad = uncompilablePattern(schema);
    if (bad !== undefined) {
        console.warn(`ConfigForm: plugin '${id}' settings schema has an invalid regular expression '${bad}'; its settings stay JSON-only`);
        return false;
    }
    return true;
}

/**
 * A copy of `base` with each plugin's schema under `api_config.plugins.properties.<id>`. Without a
 * usable plugin the input itself comes back, unchanged; the input is never mutated. An entry whose
 * id is not a plain key or whose schema is not an object schema is skipped, so one bad entry cannot
 * break the form.
 */
export function composeApiConfigSchema(base: object, plugins: Array<{ id: string; schema: object }>): object {
    const usable = (plugins ?? []).filter(p =>
        p && typeof p.id === 'string' && SAFE_ID.test(p.id) && p.id !== '__proto__' && isPlainObject(p.schema) && (p.schema as any).type === 'object'
        && schemaIsSafe(p.id, p.schema));
    if (usable.length === 0) {
        return base;
    }
    const copy = JSON.parse(JSON.stringify(base));
    const group = copy?.properties?.api_config?.properties?.plugins;
    if (!isPlainObject(group)) {
        return base;
    }
    const properties: Record<string, unknown> = isPlainObject(group.properties) ? group.properties : {};
    for (const plugin of usable) {
        properties[plugin.id] = JSON.parse(JSON.stringify(plugin.schema));
    }
    group.properties = properties;
    return copy;
}

/** Only the `docker` deploy target serves the admin API under `/admin/api`; any other target (development, standalone) is at `/api`. */
export function pluginSchemasUrl(deployTarget: string | null | undefined, language: string): string {
    const prefix = deployTarget === 'docker' ? '/admin/api' : '/api';
    return `${prefix}/plugins/settings-schemas?lang=${encodeURIComponent(language)}`;
}

/**
 * Fetches the schemas. Never throws: a refusal (401/403), a failure or a malformed answer is logged
 * and answers no plugins, so the form falls back to the standard schema.
 */
export async function loadPluginSchemas(
    deployTarget: string | null | undefined,
    language: string,
    fetchFn: FetchLike,
    timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<PluginSchemaEntry[]> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        // Aborting is for a fetch that honours the signal; the race is for one that never settles.
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                reject(new Error(`no answer within ${timeoutMs} ms`));
            }, timeoutMs);
        });
        const response = await Promise.race([fetchFn(pluginSchemasUrl(deployTarget, language), {
            credentials: 'include',
            headers: { Accept: 'application/json' },
            signal: controller.signal
        }), timeout]);
        if (!response.ok) {
            console.warn(`ConfigForm: plugin settings schemas not available (HTTP ${response.status})`);
            return [];
        }
        const body = await Promise.race([response.json(), timeout]);
        if (!Array.isArray(body)) {
            console.warn('ConfigForm: plugin settings schemas answer is not a list');
            return [];
        }
        return body as PluginSchemaEntry[];
    } catch (error) {
        console.warn('ConfigForm: plugin settings schemas could not be fetched', error);
        return [];
    } finally {
        clearTimeout(timer);
    }
}

/** Whether any plugin's texts are in a language other than the UI's. */
export function hasHelpFallback(plugins: Array<{ helpFallback?: boolean }>): boolean {
    return plugins.some(p => p.helpFallback === true);
}
