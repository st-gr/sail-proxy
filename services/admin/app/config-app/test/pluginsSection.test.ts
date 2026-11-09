import apiConfigSchema from '../webapp/model/apiConfigSchema';
import * as fs from 'fs';
import * as path from 'path';
import { API_CONFIG_GROUPS, apiConfigGroupOrder, emptyGroupNoteKey, formTabGroups, groupSections, resolveGroupSchema } from '../webapp/model/apiConfigGroups';
import { evaluateApiConfigDocument } from '../webapp/model/documentGate';
import { pluginFor } from '../webapp/model/formPlugins';
import { Descriptor, JsonSchemaNode, applyDescriptor, buildDescriptors, mapEntriesOf, mapNodesOf, resolveRefsDeep } from '../webapp/model/schemaForm';

const shippedConfig = require('../../../api_config.json');

const clone = (value: any): any => JSON.parse(JSON.stringify(value));
const root = apiConfigSchema as unknown as JsonSchemaNode;

function flatten(ds: Descriptor[]): Descriptor[] {
    return ds.reduce<Descriptor[]>((all, d) => all.concat(d, 'children' in d ? flatten((d as any).children) : []), []);
}

/** The runtime copy Task 8 will build: one enabled plugin's schema declared beside the default entry. */
function withPluginSchema(): JsonSchemaNode {
    const copy = clone(apiConfigSchema);
    copy.properties.api_config.properties.plugins.properties = {
        foo: { type: 'object', properties: { a: { type: 'integer' }, on: { type: 'boolean' } } }
    };
    return copy;
}

describe('api_config.plugins (the optional plugins section)', () => {
    const DOC = { api_config: { plugins: { foo: { a: 1 } } } };

    it('is a seventh group, placed last in the tab strip', () => {
        expect(API_CONFIG_GROUPS).toContain('plugins');
        const order = apiConfigGroupOrder(apiConfigSchema, DOC);
        expect(order).toHaveLength(7);
        expect(order[order.length - 1]).toBe('plugins');
    });

    it('declares fixed keys over a plain-object default entry, with a title and description', () => {
        const group = resolveGroupSchema(apiConfigSchema, 'plugins') as any;
        expect(group.type).toBe('object');
        expect(group['x-fixedKeys']).toBe(true);
        expect(group.additionalProperties).toEqual({ type: 'object' });
        expect(typeof group.title).toBe('string');
        expect(typeof group.description).toBe('string');
    });

    it('passes the document gate, with or without the section', () => {
        expect(evaluateApiConfigDocument(apiConfigSchema, DOC)).toEqual({ valid: true, errors: [] });
        expect(evaluateApiConfigDocument(apiConfigSchema, shippedConfig).valid).toBe(true);
    });

    it('fails the gate for a plugin entry that is not an object', () => {
        const result = evaluateApiConfigDocument(apiConfigSchema, { api_config: { plugins: { foo: 3 } } });
        expect(result.valid).toBe(false);
        expect(result.errors.some(m => m.includes('/api_config/plugins/foo'))).toBe(true);
    });

    it('is not a map: no add or remove control, whether or not plugin schemas are declared', () => {
        expect(mapEntriesOf(resolveGroupSchema(apiConfigSchema, 'plugins'), root)).toBeUndefined();
        const runtime = withPluginSchema();
        const group = resolveRefsDeep(resolveGroupSchema(runtime as any, 'plugins'), runtime);
        expect(mapEntriesOf(group, runtime)).toBeUndefined();
    });

    it('is not listed among the schema\'s map nodes either', () => {
        expect(mapNodesOf(apiConfigSchema)).not.toContain('/api_config/plugins');
    });

    it('still treats other maps as maps', () => {
        expect(mapEntriesOf(resolveRefsDeep(resolveGroupSchema(apiConfigSchema, 'providers'), root), root)).toBeDefined();
    });

    it('shows a setting with no schema as a panel of the plugins tab, whatever the document carries', () => {
        expect(groupSections(apiConfigSchema, 'plugins')).toEqual([]);
        const sections = groupSections(apiConfigSchema, 'plugins', DOC.api_config.plugins);
        expect(sections.map(s => s.key)).toEqual(['foo']);
        expect(sections[0].pointer).toBe('/api_config/plugins/foo');
        expect(sections[0].schema).toEqual({ type: 'object' });
    });

    it('renders an undeclared plugin setting as raw children and writes the document back unchanged', () => {
        const doc = { api_config: { plugins: { foo: { a: 1, nested: { b: [1, 2] } } } } };
        const [section] = groupSections(apiConfigSchema, 'plugins', doc.api_config.plugins);
        const ds = flatten(buildDescriptors(section.schema as object, doc.api_config.plugins.foo, section.pointer, pluginFor));
        expect(ds.map(d => d.kind)).toEqual(['raw', 'raw']);
        expect(ds.some(d => 'mapEntries' in d)).toBe(false);
        let out: unknown = clone(doc);
        for (const d of ds) {
            if ('value' in d) out = applyDescriptor(out, d.pointer, (d as any).value);
        }
        expect(out).toEqual(doc);
    });

    it('with a plugin schema declared, the declared plugin gets controls and an undeclared one stays visible', () => {
        const runtime = withPluginSchema();
        const data = { foo: { a: 2, on: true }, bar: { x: 1 } };
        const sections = groupSections(runtime as any, 'plugins', data);
        expect(sections.map(s => s.key)).toEqual(['foo', 'bar']);
        const foo = flatten(buildDescriptors(sections[0].schema as object, data.foo, sections[0].pointer, pluginFor));
        expect(foo.map(d => d.kind)).toEqual(['number', 'switch']);
        const bar = flatten(buildDescriptors(sections[1].schema as object, data.bar, sections[1].pointer, pluginFor));
        expect(bar.map(d => d.kind)).toEqual(['raw']);
        expect(evaluateApiConfigDocument(runtime as any, { api_config: { plugins: data } }).valid).toBe(true);
    });

    it('a document without plugins is unaffected', () => {
        expect(groupSections(apiConfigSchema, 'plugins', undefined)).toEqual([]);
        expect(groupSections(apiConfigSchema, 'plugins', {})).toEqual([]);
    });
});

describe('the plugins tab by role', () => {
    const DOC = { api_config: { plugins: { foo: { a: 1 } } } };

    it('is built for an administrator, last, like every other tab', () => {
        expect(formTabGroups(apiConfigSchema, DOC, true)).toEqual(apiConfigGroupOrder(apiConfigSchema, DOC));
    });

    it('is not built for a regular user, whatever the document carries; the other six keep their order', () => {
        const groups = formTabGroups(apiConfigSchema, DOC, false);
        expect(groups).not.toContain('plugins');
        expect(groups).toEqual(apiConfigGroupOrder(apiConfigSchema, DOC).filter(g => g !== 'plugins'));
        expect(groups).toHaveLength(6);
    });

    it('notes an empty plugins tab, and only the plugins tab', () => {
        expect(emptyGroupNoteKey('plugins', 0)).toBe('formPluginsEmpty');
        expect(emptyGroupNoteKey('plugins', 1)).toBeUndefined();
        expect(emptyGroupNoteKey('platform', 0)).toBeUndefined();
    });

    it('has the note in every language bundle', () => {
        for (const lang of ['', '_en', '_de', '_es', '_fr', '_it', '_nl', '_pt']) {
            const text = fs.readFileSync(path.join(__dirname, `../webapp/i18n/i18n${lang}.properties`), 'utf8');
            expect(text).toMatch(/^formPluginsEmpty=\S/m);
        }
    });
});
