import apiConfigSchema from '../webapp/model/apiConfigSchema';
import { groupSections } from '../webapp/model/apiConfigGroups';
import { evaluateApiConfigDocument } from '../webapp/model/documentGate';
import { evaluateGuarded, gateFailureReason, pluginOnlyFailure, pluginStateIfCurrent } from '../webapp/model/pluginRuntime';
import { MAX_PLUGIN_SCHEMA_BYTES, composeApiConfigSchema, loadPluginSchemas } from '../webapp/model/pluginSchemas';
import { pluginFor } from '../webapp/model/formPlugins';
import { buildDescriptors } from '../webapp/model/schemaForm';

const base = apiConfigSchema as unknown as Record<string, unknown>;
const GOOD = { id: 'good', schema: { type: 'object', properties: { n: { type: 'integer' } } } };
const STANDARD_DOC = { api_config: { platform: {}, plugins: { bad: { x: 1 }, good: { n: 1 } } } };

let warn: jest.SpyInstance;
beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => warn.mockRestore());

describe('a plugin schema that would break the checks is left out', () => {
    const cases: Array<[string, object]> = [
        ['an invalid pattern', { type: 'object', properties: { s: { type: 'string', pattern: '(' } } }],
        ['an invalid patternProperties key', { type: 'object', patternProperties: { '[': { type: 'string' } } }],
        ['an oversized schema', { type: 'object', description: 'x'.repeat(MAX_PLUGIN_SCHEMA_BYTES + 1) }]
    ];
    it.each(cases)('%s: logged, standard groups still render, the gate still works, settings stay raw', (_name, schema) => {
        const composed: any = composeApiConfigSchema(base, [GOOD, { id: 'bad', schema }]);
        const props = composed.properties.api_config.properties.plugins.properties;
        expect(Object.keys(props)).toEqual(['good']);
        expect(warn.mock.calls.some(c => String(c[0]).includes("'bad'"))).toBe(true);
        // no throw, valid, standard group renders
        expect(evaluateApiConfigDocument(composed, STANDARD_DOC)).toEqual({ valid: true, errors: [] });
        expect(groupSections(composed, 'platform', {}).length).toBeGreaterThan(0);
        const bad = groupSections(composed, 'plugins', STANDARD_DOC.api_config.plugins).find(s => s.key === 'bad')!;
        const ds = buildDescriptors(bad.schema as object, { x: 1 }, bad.pointer, pluginFor);
        expect(ds.map(d => d.kind)).toEqual(['raw']);
    });

    it('evaluateGuarded degrades to the base schema when the plugin schema makes the check throw', () => {
        const hostile: any = composeApiConfigSchema(base, [GOOD]);
        hostile.properties.api_config.properties.plugins.properties.good.properties.s = { type: 'string', pattern: '(' };
        const doc = { api_config: { platform: {}, plugins: { good: { n: 1, s: 'x' } } } };
        expect(() => evaluateApiConfigDocument(hostile, doc)).toThrow();
        const result = evaluateGuarded(base, hostile, doc);
        expect(result).toMatchObject({ valid: true, errors: [], degraded: true });
        expect(evaluateGuarded(base, base, STANDARD_DOC).degraded).toBe(false);
    });
});

describe('loadPluginSchemas timeout', () => {
    it('gives up on a fetch that never settles, logging, answering no plugins', async () => {
        const never = (() => new Promise(() => undefined)) as any;
        expect(await loadPluginSchemas('docker', 'en', never, 20)).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('aborts the request it gave up on', async () => {
        let signal: AbortSignal | undefined;
        const hung = ((_url: string, init: any) => { signal = init.signal; return new Promise(() => undefined); }) as any;
        await loadPluginSchemas('docker', 'en', hung, 20);
        expect(signal?.aborted).toBe(true);
    });
});

describe('the reason a plugin setting turns the form off', () => {
    const composed: any = composeApiConfigSchema(base, [{ id: 'good', schema: { type: 'object', properties: { n: { type: 'integer', maximum: 3 } } } }]);
    const pluginErrors = evaluateApiConfigDocument(composed, { api_config: { plugins: { good: { n: 9 } } } }).errors;
    const mixedErrors = evaluateApiConfigDocument(composed, { api_config: { plugins: { good: { n: 9 } }, platform: 3 } }).errors;

    it('names the plugin when every error is under plugins', () => {
        expect(pluginErrors.length).toBeGreaterThan(0);
        expect(pluginOnlyFailure(pluginErrors)).toEqual(['good']);
        const reason = gateFailureReason(pluginErrors, 'STANDARD', 'Plugin {0}: use the JSON view');
        expect(reason.startsWith('Plugin good: use the JSON view')).toBe(true);
        expect(reason).not.toContain('STANDARD');
    });

    it('keeps the standard text when any error is elsewhere or unreadable', () => {
        expect(pluginOnlyFailure(mixedErrors)).toBeUndefined();
        expect(gateFailureReason(mixedErrors, 'STANDARD', 'Plugin {0}').startsWith('STANDARD')).toBe(true);
        expect(pluginOnlyFailure(['something odd'])).toBeUndefined();
        expect(pluginOnlyFailure([])).toBeUndefined();
    });
});

describe('a selection switch during the plugin fetch', () => {
    it('only the current selection adopts its answer', async () => {
        let selection = 1;
        const answers: Array<(v: any[]) => void> = [];
        const fetchFor = () => new Promise<any[]>(resolve => answers.push(resolve));
        const adopt = async (token: number) => {
            const plugins = await fetchFor();
            return pluginStateIfCurrent(token, selection, base, plugins);
        };
        const first = adopt(1);
        selection = 2; // the operator picked another configuration while selection 1's fetch was out
        const second = adopt(2);
        answers[1]([GOOD]);
        answers[0]([]);
        const newer = await second;
        expect(await first).toBeUndefined();
        expect(Object.keys((newer!.schema as any).properties.api_config.properties.plugins.properties)).toEqual(['good']);
    });

    it('carries the help fallback of the answer', () => {
        expect(pluginStateIfCurrent(1, 1, base, [{ ...GOOD, helpFallback: true }])?.helpFallback).toBe(true);
    });
});
