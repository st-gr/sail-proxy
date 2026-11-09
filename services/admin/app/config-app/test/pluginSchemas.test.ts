import * as fs from 'fs';
import * as path from 'path';
import apiConfigSchema from '../webapp/model/apiConfigSchema';
import { groupSections } from '../webapp/model/apiConfigGroups';
import { evaluateApiConfigDocument } from '../webapp/model/documentGate';
import { pluginFor } from '../webapp/model/formPlugins';
import { sectionSeed } from '../webapp/model/formContainers';
import { Descriptor, JsonSchemaNode, applyDescriptor, buildDescriptors } from '../webapp/model/schemaForm';
import { schemaTexts } from '../webapp/model/schemaTexts';
import {
    PluginSchemaEntry,
    composeApiConfigSchema,
    hasHelpFallback,
    loadPluginSchemas,
    pluginSchemasUrl
} from '../webapp/model/pluginSchemas';

const clone = (value: any): any => JSON.parse(JSON.stringify(value));

function flatten(ds: Descriptor[]): Descriptor[] {
    return ds.reduce<Descriptor[]>((all, d) => all.concat(d, 'children' in d ? flatten((d as any).children) : []), []);
}

/** A sample plugin's settings: one of every control the form offers, as the server returns it (texts filled). */
const SAMPLE: PluginSchemaEntry = {
    id: 'ticket-router',
    summary: 'Routes tickets',
    helpFallback: false,
    schema: {
        type: 'object',
        title: 'Ticket router',
        description: 'Where tickets go.',
        properties: {
            enabled: { type: 'boolean', description: 'Route at all.' },
            max_hops: { type: 'integer', minimum: 1, maximum: 5, description: 'Longest chain.' },
            mode: { type: 'string', enum: ['fast', 'careful'], description: 'How to route.' },
            queue: { type: 'string', description: 'Queue name.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tags to match.' },
            rules: {
                type: 'array',
                description: 'Routing rules.',
                items: { type: 'object', properties: { match: { type: 'string' }, weight: { type: 'integer' } } }
            }
        }
    }
};

const root = (schema: object) => schema as unknown as JsonSchemaNode;

describe('composeApiConfigSchema', () => {
    it('puts each plugin schema under plugins.properties.<id>', () => {
        const composed: any = composeApiConfigSchema(apiConfigSchema as object, [SAMPLE]);
        expect(composed.properties.api_config.properties.plugins.properties['ticket-router']).toEqual(SAMPLE.schema);
    });

    it('returns a base without plugins deep-equal to the input, and never mutates the input', () => {
        const before = clone(apiConfigSchema);
        expect(composeApiConfigSchema(apiConfigSchema as object, [])).toEqual(before);
        composeApiConfigSchema(apiConfigSchema as object, [SAMPLE]);
        expect(clone(apiConfigSchema)).toEqual(before);
        expect((apiConfigSchema as any).properties.api_config.properties.plugins.properties).toBeUndefined();
    });

    it('skips an entry that is not a self-describing object schema or has an unusable id', () => {
        const composed: any = composeApiConfigSchema(apiConfigSchema as object, [
            { id: '__proto__', schema: { type: 'object' } },
            { id: 'has.dot', schema: { type: 'object' } },
            { id: 'not-object', schema: { type: 'string' } },
            { id: 'null-schema', schema: null as any }
        ]);
        expect(composed.properties.api_config.properties.plugins.properties).toBeUndefined();
    });

    it('leaves x-fixedKeys on plugins, so there is no add or remove', () => {
        const composed: any = composeApiConfigSchema(apiConfigSchema as object, [SAMPLE]);
        expect(composed.properties.api_config.properties.plugins['x-fixedKeys']).toBe(true);
    });
});

describe('a composed plugin schema in the form', () => {
    const composed = composeApiConfigSchema(apiConfigSchema as object, [SAMPLE]);
    const settings = { enabled: true, max_hops: 3, mode: 'fast', queue: 'q1', tags: ['a'], rules: [{ match: 'x', weight: 2 }] };

    it('renders a switch, number, select, text, list and table, with the description', () => {
        const [section] = groupSections(composed as any, 'plugins', { 'ticket-router': settings });
        const ds = flatten(buildDescriptors(section.schema as object, settings, section.pointer, pluginFor));
        const kinds = (pointer: string) => ds.find(d => d.pointer === pointer)?.kind;
        expect(kinds('/api_config/plugins/ticket-router/enabled')).toBe('switch');
        expect(kinds('/api_config/plugins/ticket-router/max_hops')).toBe('number');
        expect(kinds('/api_config/plugins/ticket-router/mode')).toBe('select');
        expect(kinds('/api_config/plugins/ticket-router/queue')).toBe('text');
        expect(kinds('/api_config/plugins/ticket-router/tags')).toBe('list');
        expect(kinds('/api_config/plugins/ticket-router/rules')).toBe('table');
        expect((ds.find(d => d.pointer.endsWith('/max_hops')) as any).description).toBe('Longest chain.');
        expect(ds.some(d => d.kind === 'raw')).toBe(false);
    });

    it('shows a schema default, 3, where the document holds no value, and writes nothing', () => {
        const withDefault: PluginSchemaEntry = {
            id: 'retrying',
            summary: 's',
            helpFallback: false,
            schema: { type: 'object', properties: { retries: { type: 'number', default: 3 } } }
        };
        const withDefaultComposed = composeApiConfigSchema(apiConfigSchema as object, [withDefault]);
        const data = {};
        const [section] = groupSections(withDefaultComposed as any, 'plugins', { retrying: data });
        const ds = flatten(buildDescriptors(section.schema as object, data, section.pointer, pluginFor));
        const retries = ds.find(d => d.pointer === '/api_config/plugins/retrying/retries') as any;
        expect(retries.kind).toBe('number');
        expect(retries.value).toBe(3);
        expect(data).toEqual({});
    });

    it('keeps a disabled plugin\'s settings on the read-only raw path', () => {
        const data = { 'ticket-router': settings, gone: { x: 1 } };
        const sections = groupSections(composed as any, 'plugins', data);
        const gone = sections.find(s => s.key === 'gone')!;
        const ds = flatten(buildDescriptors(gone.schema as object, data.gone, gone.pointer, pluginFor));
        expect(ds.map(d => d.kind)).toEqual(['raw']);
    });

    it('reports a violating setting and accepts a valid one', () => {
        const doc = (s: unknown) => ({ api_config: { plugins: { 'ticket-router': s } } });
        expect(evaluateApiConfigDocument(composed as any, doc(settings)).valid).toBe(true);
        const bad = evaluateApiConfigDocument(composed as any, doc({ ...settings, max_hops: 9, mode: 'slow' }));
        expect(bad.valid).toBe(false);
        expect(bad.errors.some(m => m.includes('/api_config/plugins/ticket-router/max_hops'))).toBe(true);
        expect(bad.errors.some(m => m.includes('/api_config/plugins/ticket-router/mode'))).toBe(true);
    });

    it('offers an enabled plugin the document does not carry as an absent section, and Add section creates it', () => {
        const doc = { api_config: { plugins: {} } };
        const [section] = groupSections(composed as any, 'plugins', doc.api_config.plugins);
        expect(section.key).toBe('ticket-router');
        const absent = buildDescriptors(section.schema as object, undefined, section.pointer, pluginFor);
        expect(absent).toHaveLength(1);
        expect((absent[0] as any).absent).toBe(true);
        // Nothing is written until the operator acts: the document is exactly as it was.
        expect(doc).toEqual({ api_config: { plugins: {} } });
        const added: any = applyDescriptor(doc, section.pointer, sectionSeed(absent[0] as any));
        const fields = flatten(buildDescriptors(section.schema as object, added.api_config.plugins['ticket-router'], section.pointer, pluginFor));
        expect(fields.map(d => d.kind)).toContain('number');
        const edited: any = applyDescriptor(added, '/api_config/plugins/ticket-router/max_hops', 4);
        expect(edited.api_config.plugins['ticket-router']).toEqual({ max_hops: 4 });
    });

    it('a document without the plugin validates and stays unchanged by building the form', () => {
        const doc = { api_config: { platform: {} } };
        const before = clone(doc);
        groupSections(composed as any, 'plugins', undefined);
        expect(evaluateApiConfigDocument(composed as any, doc).valid).toBe(true);
        expect(doc).toEqual(before);
    });
});

describe('plugin texts through the real translator path', () => {
    const bundle = new Map<string, string>();
    const lines = fs.readFileSync(path.join(__dirname, '..', 'webapp', 'i18n', 'i18n.properties'), 'utf8').split(/\r?\n/);
    for (const line of lines) {
        const m = /^([^#=\s][^=]*?)\s*=\s*(.*)$/.exec(line);
        if (m) bundle.set(m[1], m[2]);
    }
    // ConfigForm._text: the bundle's text, or the key itself for a key it does not have.
    const text = (key: string): string => bundle.get(key) ?? key;
    const composed = composeApiConfigSchema(apiConfigSchema as object, [SAMPLE]);

    it('shows the schema\'s text, not the key, where the bundle has none', () => {
        const [section] = groupSections(composed as any, 'plugins', { 'ticket-router': {} });
        const ds = flatten(buildDescriptors(section.schema as object, { max_hops: 2 }, section.pointer, pluginFor, { texts: schemaTexts(text) }));
        const hops = ds.find(d => d.pointer.endsWith('/max_hops')) as any;
        expect(hops.description).toBe('Longest chain.');
        expect(hops.label).toBe('Max Hops');
        expect(hops.label).not.toMatch(/^schema\./);
        expect(bundle.has('schema.plugins.ticket-router.max_hops.label')).toBe(false);
    });

    it('has a translated note for helpFallback in the default bundle', () => {
        expect(bundle.get('formPluginHelpFallback')).toBeTruthy();
    });
});

describe('fetching the schemas', () => {
    it('builds the URL under the route prefix with the UI language', () => {
        expect(pluginSchemasUrl('docker', 'de-DE')).toBe('/admin/api/plugins/settings-schemas?lang=de-DE');
        expect(pluginSchemasUrl('development', 'en')).toBe('/api/plugins/settings-schemas?lang=en');
        expect(pluginSchemasUrl(undefined, 'a b')).toBe('/api/plugins/settings-schemas?lang=a%20b');
    });

    const reply = (status: number, body: unknown) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

    it('returns the entries on success', async () => {
        expect(await loadPluginSchemas('docker', 'en', reply(200, [SAMPLE]) as any)).toEqual([SAMPLE]);
    });

    it('falls back to no plugins, logging, on 401/403, a failure or a malformed answer', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        expect(await loadPluginSchemas('docker', 'en', reply(401, {}) as any)).toEqual([]);
        expect(await loadPluginSchemas('docker', 'en', reply(403, {}) as any)).toEqual([]);
        expect(await loadPluginSchemas('docker', 'en', (async () => { throw new Error('down'); }) as any)).toEqual([]);
        expect(await loadPluginSchemas('docker', 'en', reply(200, { not: 'an array' }) as any)).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(4);
        warn.mockRestore();
    });

    it('reports a help fallback', () => {
        expect(hasHelpFallback([SAMPLE])).toBe(false);
        expect(hasHelpFallback([SAMPLE, { ...SAMPLE, id: 'b', helpFallback: true }])).toBe(true);
    });
});
