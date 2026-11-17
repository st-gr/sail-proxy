import apiConfigSchema from '../webapp/model/apiConfigSchema';
import { evaluateApiConfigDocument } from '../webapp/model/documentGate';
import { applyShippedEntries, comparisonTarget, displayPathOf, missingShippedEntries, previewOf } from '../webapp/model/shippedDefaults';

const shippedConfig = require('../../../api_config.json');

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** The shipped configuration as an installation stored it before the tool search beta shipped. */
function storedBeforeBetaRenames(): any {
    const stored = clone(shippedConfig);
    const anthropic = stored.api_config.providers.anthropic;
    delete anthropic.beta_header_renames;
    anthropic.supported_beta_headers = anthropic.supported_beta_headers
        .filter((flag: string) => flag !== 'tool-search-tool-2025-10-19');
    return stored;
}

describe('what the shipped defaults have and a stored configuration lacks', () => {
    it('is nothing for the shipped configuration itself', () => {
        expect(missingShippedEntries(clone(shippedConfig), shippedConfig)).toEqual([]);
    });

    it('is exactly the two beta flag entries for a configuration stored before they shipped', () => {
        const entries = missingShippedEntries(storedBeforeBetaRenames(), shippedConfig);

        expect(entries.map(({ kind, pointer, value, group }) => ({ kind, pointer, value, group }))).toEqual([
            {
                kind: 'listEntry', pointer: '/api_config/providers/anthropic/supported_beta_headers',
                value: 'tool-search-tool-2025-10-19', group: 'providers'
            },
            {
                kind: 'key', pointer: '/api_config/providers/anthropic/beta_header_renames',
                value: { 'advanced-tool-use-2025-11-20': 'tool-search-tool-2025-10-19' }, group: 'providers'
            }
        ]);
        expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
    });

    it('offers a missing key whole, at the highest point that is missing', () => {
        const stored = clone(shippedConfig);
        delete stored.api_config.hooks.defaults.google;

        const entries = missingShippedEntries(stored, shippedConfig);

        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ kind: 'key', pointer: '/api_config/hooks/defaults/google', group: 'hooks' });
        expect(entries[0].value).toEqual(shippedConfig.api_config.hooks.defaults.google);
    });

    it('never offers a value that only differs: that is the installation\'s own setting', () => {
        const active = { api_config: { platform: { timeout: 5, name: 'mine', nested: { on: false } }, list: 'not a list' } };
        const shipped = { api_config: { platform: { timeout: 30, name: 'shipped', nested: { on: true } }, list: ['a'] } };

        expect(missingShippedEntries(active, shipped)).toEqual([]);
    });

    it('a list entry with an identity counts as present when the identity exists, whatever else it holds', () => {
        const active = {
            api_config: {
                substitute_models: [{ from: 'claude-x', to: 'my-own-target' }],
                hooks: [{ request: { callback: { id: 'pluginA' }, match: ['size:min1kb'] } }],
                sinks: [{ name: 'splunk', url: 'https://mine.example.org' }]
            }
        };
        const shipped = {
            api_config: {
                substitute_models: [{ from: 'claude-x', to: 'shipped-target' }, { from: 'claude-y', to: 'other' }],
                hooks: [{ request: { callback: { id: 'pluginA' }, match: [] } }, { request: { callback: { id: 'pluginB' }, match: [] } }],
                sinks: [{ name: 'splunk', url: 'https://shipped.example.org' }]
            }
        };

        const entries = missingShippedEntries(active, shipped);

        expect(entries.map((entry) => [entry.pointer, entry.value])).toEqual([
            ['/api_config/substitute_models', { from: 'claude-y', to: 'other' }],
            ['/api_config/hooks', { request: { callback: { id: 'pluginB' }, match: [] } }]
        ]);
    });

    it('a model mapping counts as present when its provider exists, whatever else it holds', () => {
        // An operator raised max_tokens for one provider. Offered as "missing", the shipped mapping
        // went in ahead of theirs, and the first match is the one that applies.
        const stored = clone(shippedConfig);
        const mappings = stored.api_config.providers.openrouter.model_mappings;
        mappings.find((mapping: any) => mapping.provider === 'Anthropic').max_tokens = 16384;
        expect(missingShippedEntries(stored, shippedConfig)).toEqual([]);

        // Written in another case it is still that provider's mapping.
        mappings.find((mapping: any) => mapping.provider === 'Anthropic').provider = 'anthropic';
        expect(missingShippedEntries(stored, shippedConfig)).toEqual([]);

        // A provider the configuration has no mapping for is offered.
        stored.api_config.providers.openrouter.model_mappings = mappings.filter((mapping: any) => mapping.provider !== 'OpenAI');
        const entries = missingShippedEntries(stored, shippedConfig);
        expect(entries.map((entry) => [entry.pointer, (entry.value as any).provider])).toEqual([
            ['/api_config/providers/openrouter/model_mappings', 'OpenAI']
        ]);
    });

    it('escapes a key that holds a slash or a tilde in its pointer', () => {
        const entries = missingShippedEntries({ api_config: { models: {} } }, { api_config: { models: { 'vendor/model~1': { a: 1 } } } });

        expect(entries[0].pointer).toBe('/api_config/models/vendor~1model~01');
    });
});

describe('adding picked shipped entries to a configuration', () => {
    it('all entries of the stored configuration give back the shipped one, and the stored one is left alone', () => {
        const stored = storedBeforeBetaRenames();
        const before = clone(stored);

        const merged = applyShippedEntries(stored, missingShippedEntries(stored, shippedConfig));

        expect(merged).toEqual(shippedConfig);
        expect(stored).toEqual(before);
        expect(evaluateApiConfigDocument(apiConfigSchema, merged).valid).toBe(true);
    });

    it('only the picked entries are added', () => {
        const stored = storedBeforeBetaRenames();
        const [listEntry] = missingShippedEntries(stored, shippedConfig);

        const merged = applyShippedEntries(stored, [listEntry]);

        expect(merged.api_config.providers.anthropic.supported_beta_headers).toContain('tool-search-tool-2025-10-19');
        expect(merged.api_config.providers.anthropic.beta_header_renames).toBeUndefined();
    });

    it('a list entry goes where the shipped order puts it: after the nearest entry before it that both lists hold', () => {
        const active = { api_config: { hooks: ['mine-first', 'a', 'c', 'mine-last'] } };
        const shipped = { api_config: { hooks: ['a', 'b', 'c', 'd'] } };

        const merged = applyShippedEntries(active, missingShippedEntries(active, shipped));

        expect(merged.api_config.hooks).toEqual(['mine-first', 'a', 'b', 'c', 'd', 'mine-last']);
    });

    it('with nothing before it in common it goes in front of the nearest shared entry after it, else to the end', () => {
        const front = { api_config: { hooks: ['mine', 'c'] } };
        expect(applyShippedEntries(front, missingShippedEntries(front, { api_config: { hooks: ['a', 'b', 'c'] } })).api_config.hooks)
            .toEqual(['mine', 'a', 'b', 'c']);

        const none = { api_config: { hooks: ['mine'] } };
        expect(applyShippedEntries(none, missingShippedEntries(none, { api_config: { hooks: ['a', 'b'] } })).api_config.hooks)
            .toEqual(['mine', 'a', 'b']);
    });

    it('a missing key lands under an escaped pointer too', () => {
        const active = { api_config: { models: {} } };
        const shipped = { api_config: { models: { 'vendor/model~1': { a: 1 } } } };

        expect(applyShippedEntries(active, missingShippedEntries(active, shipped))).toEqual(shipped);
    });
});

describe('the one-line preview of an entry', () => {
    it('is the compact JSON, cut with an ellipsis when it is long', () => {
        expect(previewOf('tool-search-tool-2025-10-19')).toBe('"tool-search-tool-2025-10-19"');
        expect(previewOf({ a: 1, b: [true] })).toBe('{"a":1,"b":[true]}');
        const long = previewOf({ text: 'x'.repeat(300) });
        expect(long.length).toBe(120);
        expect(long.endsWith('…')).toBe(true);
    });
});

describe('the path an entry is shown under', () => {
    it('is its keys below api_config, with a slash inside a key left as it is', () => {
        const [entry] = missingShippedEntries({ api_config: { models: {} } }, { api_config: { models: { 'vendor/model': { a: 1 } } } });

        expect(displayPathOf(entry)).toBe('models / vendor/model');
    });
});

describe('which configuration the toolbar\'s Compare with defaults compares', () => {
    it('the ticked one, like the toolbar\'s other actions', () => {
        expect(comparisonTarget(['c-1'])).toEqual({ kind: 'configuration', id: 'c-1' });
    });

    it('the active one when nothing is ticked', () => {
        expect(comparisonTarget([])).toEqual({ kind: 'active' });
    });

    it('none when several are ticked: one comparison shows one configuration', () => {
        expect(comparisonTarget(['c-1', 'c-2'])).toEqual({ kind: 'severalTicked' });
    });
});
