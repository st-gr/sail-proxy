import apiConfigSchema, { siemSchemaDef } from '../webapp/model/apiConfigSchema';
import { API_CONFIG_GROUPS, apiConfigGroupOrder, groupSectionKeys, groupSections, resolveGroupSchema } from '../webapp/model/apiConfigGroups';
import { labelFor } from '../webapp/model/schemaForm';

/**
 * `ConfigFormTabs.buildTabs` (the controller) turns this exact data - which groups, in what
 * order, which sections each one holds - into `sap.m.IconTabBar`/`IconTabFilter`/`Panel`
 * controls. That file cannot be imported here: it pulls in `sap/m/IconTabBar`, and no test in
 * this suite loads the UI5 runtime jest would need to resolve that module (see every other file
 * under `test/` - none imports a `sap/*` module). So this is where the tab shell's count and
 * order are actually exercised, against the same functions the controller calls.
 */
describe('apiConfigGroups (the tab shell\'s pure half)', () => {
    // Against the schema's own declared groups, not a second hardcoded array: a twin of two
    // literals can never disagree with itself, so it cannot catch a seventh group added to the
    // schema without a matching addition here - it would silently render with no tab at all.
    // This fails the moment the two lists diverge, in either direction.
    it('matches api_config\'s own declared groups exactly, alphabetical - so a future group cannot silently get no tab', () => {
        const schemaGroups = Object.keys((apiConfigSchema as any).properties.api_config.properties).sort();
        expect(API_CONFIG_GROUPS).toEqual(schemaGroups);
    });

    /**
     * The tab strip is a fixed, curated order - Platform, Providers, Hooks, Models, Observability,
     * Capabilities - not the document's order and not the schema's declaration order, so it never
     * reshuffles as the document is filled in. All six tabs are always built: an absent group's tab
     * is where **Add section** for its sections lives, and a strip whose tabs come and go is one
     * nobody can aim at (and `/formSelectedTab` would then be restoring a key with no tab behind it).
     */
    describe('apiConfigGroupOrder (the tab strip\'s order)', () => {
        const CURATED = ['platform', 'providers', 'hooks', 'models', 'observability', 'capabilities'];

        it('uses the curated tab order with no document to follow', () => {
            expect(apiConfigGroupOrder(apiConfigSchema)).toEqual(CURATED);
        });

        it('uses the curated order for the shipped document, ignoring its key order', () => {
            const shipped = require('../../../../gateway/api_config.json');
            expect(apiConfigGroupOrder(apiConfigSchema, shipped)).toEqual(CURATED);
            // Platform leads - neither the alphabetical inventory (capabilities first) nor the
            // schema's own declaration order (providers first) does.
            expect(apiConfigGroupOrder(apiConfigSchema, shipped)[0]).toBe('platform');
            expect(API_CONFIG_GROUPS[0]).toBe('capabilities');
            expect(Object.keys((apiConfigSchema as any).properties.api_config.properties)[0]).toBe('providers');
        });

        it('keeps the curated order however the document orders its groups', () => {
            // The document no longer influences the strip at all: a config carrying capabilities and
            // models first still shows Platform first.
            expect(apiConfigGroupOrder(apiConfigSchema, { api_config: { capabilities: {}, models: {} } }))
                .toEqual(CURATED);
        });

        it('always returns all six, so a stored /formSelectedTab key still names a tab', () => {
            for (const document of [undefined, {}, { api_config: {} }, { api_config: { models: {} } }]) {
                const order = apiConfigGroupOrder(apiConfigSchema, document);
                expect(order).toHaveLength(6);
                expect(order.slice().sort()).toEqual(API_CONFIG_GROUPS.slice().sort());
            }
        });

        it('ignores a top-level key that is not a group - api_config declares no others', () => {
            const order = apiConfigGroupOrder(apiConfigSchema, { api_config: { not_a_group: {}, hooks: {} } });
            expect(order).toEqual(CURATED);
            expect(order).not.toContain('not_a_group');
        });

        it('survives a document that is not an object at all', () => {
            expect(apiConfigGroupOrder(apiConfigSchema, 'nonsense')).toEqual(CURATED);
            expect(apiConfigGroupOrder(apiConfigSchema, null)).toEqual(CURATED);
        });
    });

    it('resolves each group\'s $ref to an object schema with its own declared sections', () => {
        for (const group of API_CONFIG_GROUPS) {
            const groupSchema = resolveGroupSchema(apiConfigSchema, group);
            expect(groupSchema.type).toBe('object');
        }
    });

    it('orders observability\'s sections as the schema declares them, with no document to follow', () => {
        const groupSchema = resolveGroupSchema(apiConfigSchema, 'observability');
        expect(groupSectionKeys(groupSchema)).toEqual(['pseudonymization', 'siem']);
    });

    it('orders platform\'s seven sections as the schema declares them, with no document to follow', () => {
        const groupSchema = resolveGroupSchema(apiConfigSchema, 'platform');
        expect(groupSectionKeys(groupSchema)).toEqual(['billing', 'timeouts', 'logging', 'rate_limit_handling', 'security', 'quotas', 'maintenance']);
    });

    it('orders capabilities\' six sections as the schema declares them, with no document to follow', () => {
        const groupSchema = resolveGroupSchema(apiConfigSchema, 'capabilities');
        expect(groupSectionKeys(groupSchema)).toEqual([
            'web_search', 'file_search', 'hosted_tools', 'namespace_tools', 'custom_tools', 'tool_search'
        ]);
    });

    /**
     * The ruling this task carries out: a group's sections render in the schema's declaration
     * order, always, present or absent alike, so the tab's panels never reshuffle as the document
     * is filled in. This replaced a document-order-first rule; see `documentOrderedKeys`'s own
     * comment for why (the rate_limit_handling report, where added maps pushed unset fields away).
     * An absent section is a notice with **Add section** on it, and it holds its schema position.
     */
    describe('section order follows the schema, not the document and not the alphabet', () => {
        const platformSchema = () => resolveGroupSchema(apiConfigSchema, 'platform');

        it('renders the shipped platform group in the schema\'s order, which it happens to match', () => {
            const shipped = require('../../../../gateway/api_config.json').api_config.platform;
            expect(groupSectionKeys(platformSchema(), shipped)).toEqual(Object.keys(shipped));
            // The shipped document happens to carry its sections in the schema's own order.
            expect(Object.keys(shipped)).toEqual(['billing', 'timeouts', 'logging', 'rate_limit_handling', 'security', 'quotas', 'maintenance']);
        });

        it('keeps the schema\'s order for a document that reverses two keys, not the document\'s', () => {
            const reversed = { security: {}, timeouts: {} };
            expect(groupSectionKeys(platformSchema(), reversed).slice(0, 2)).toEqual(['billing', 'timeouts']);
        });

        it('holds an absent section in its schema position rather than trailing it', () => {
            // A single carried section no longer leads the rest: the schema's order stands.
            expect(groupSectionKeys(platformSchema(), { security: {} }))
                .toEqual(['billing', 'timeouts', 'logging', 'rate_limit_handling', 'security', 'quotas', 'maintenance']);
        });

        it('ignores a document key the group does not declare - that is not a section', () => {
            expect(groupSectionKeys(platformSchema(), { not_a_section: {}, logging: {} })[0]).toBe('billing');
            expect(groupSectionKeys(platformSchema(), { not_a_section: {} })).not.toContain('not_a_section');
        });

        it('falls back to the schema\'s order for a group the document does not carry at all', () => {
            expect(groupSectionKeys(platformSchema(), undefined)).toEqual(groupSectionKeys(platformSchema()));
            expect(groupSectionKeys(platformSchema(), 'not an object')).toEqual(groupSectionKeys(platformSchema()));
        });

        it('carries the same order through groupSections, which is what buildTab calls', () => {
            const sections = groupSections(apiConfigSchema, 'platform', { security: {}, logging: {} });
            expect(sections.map(s => s.key)).toEqual(['billing', 'timeouts', 'logging', 'rate_limit_handling', 'security', 'quotas', 'maintenance']);
            expect(sections.map(s => s.pointer)[0]).toBe('/api_config/platform/billing');
        });
    });

    // providers and models declare their sections the same way every other group does. providers
    // names all six keys the gateway actually reads (configService.ts's PROVIDER_KEYS), so each
    // gets its own panel; its `additionalProperties` still accepts a seventh provider, but an
    // undeclared key is not a section - see groupSectionKeys's own header. models declares only
    // `overrides`, whose per-model keys live inside that one section.
    it('lists providers\' six named providers and models\' one section, not the dynamic keys within them', () => {
        expect(groupSectionKeys(resolveGroupSchema(apiConfigSchema, 'providers'))).toEqual([
            'anthropic', 'aws-bedrock', 'google', 'openai', 'openrouter', 'perplexity'
        ]);
        expect(groupSectionKeys(resolveGroupSchema(apiConfigSchema, 'models'))).toEqual(['overrides']);
    });

    // The six above are not a hand-kept twin of the gateway's list: PROVIDER_KEYS is what decides
    // whether a provider's configuration is read at all (providerConfig() returns undefined for any
    // other key), so a provider named in the schema but not there would render an editable panel
    // that changes nothing. Asserted against the shipped configuration's own provider keys, which
    // the backend validates against this same schema.
    it('names exactly the providers the shipped configuration carries, so no panel is inert', () => {
        const shipped = require('../../../../gateway/api_config.json').api_config.providers;
        expect(groupSectionKeys(resolveGroupSchema(apiConfigSchema, 'providers'))).toEqual(Object.keys(shipped).sort());
    });

    // groupSections is the function ConfigFormTabs.buildTab actually calls to get a section's
    // pointer and resolved schema - not a template it re-derives locally. Testing it here, and
    // having the controller call it (rather than the controller and the tests each computing
    // their own copy of "/api_config/<group>/<key>" and resolveRef), is what makes a pointer bug
    // in the real code show up as a red test - see this function's own header for the mistake
    // this replaces.
    describe('groupSections (what buildTab actually calls)', () => {
        it('pointers and resolves observability\'s two sections, siem to the exact object siemSchemaDef is', () => {
            const sections = groupSections(apiConfigSchema, 'observability');
            expect(sections.map(s => s.key)).toEqual(['pseudonymization', 'siem']);
            expect(sections.map(s => s.pointer)).toEqual([
                '/api_config/observability/pseudonymization',
                '/api_config/observability/siem'
            ]);
            // Same reference, not a copy - the schema `buildDescriptors` is handed for siem is
            // the one thing that must not have changed shape when siem moved into this tab.
            expect(sections.find(s => s.key === 'siem')!.schema).toBe(siemSchemaDef);
        });

        it('pointers platform\'s seven sections under /api_config/platform/<key>', () => {
            const sections = groupSections(apiConfigSchema, 'platform');
            expect(sections.map(s => s.pointer)).toEqual([
                '/api_config/platform/billing',
                '/api_config/platform/timeouts',
                '/api_config/platform/logging',
                '/api_config/platform/rate_limit_handling',
                '/api_config/platform/security',
                '/api_config/platform/quotas',
                '/api_config/platform/maintenance'
            ]);
            expect(sections.every(s => s.schema.type === 'object')).toBe(true);
        });

        // Non-inertness evidence (recorded, not committed as a permanent break): temporarily
        // changing groupSections's pointer template from `/api_config/${group}/${key}` to
        // `/WRONG/${group}/${key}` and re-running this suite turned exactly the two assertions
        // above that check `.pointer` red (six pointer strings across both, all prefixed
        // `/WRONG/` instead of `/api_config/`); every other test in this file - which does not
        // read `.pointer` - stayed green. Reverted immediately after; see the task report for the
        // full before/after test output.
        it('every pointer this function returns is rooted at /api_config, not something else', () => {
            for (const group of API_CONFIG_GROUPS) {
                for (const section of groupSections(apiConfigSchema, group)) {
                    expect(section.pointer.indexOf(`/api_config/${group}/`)).toBe(0);
                }
            }
        });
    });

    // ConfigFormTabs.buildTab titles the siem section's panel with labelFor('siem') - see
    // schemaForm.ts's ACRONYMS. Without an entry there it title-cases to "Siem".
    it('titles the siem section panel "SIEM", not "Siem"', () => {
        expect(labelFor('siem')).toBe('SIEM');
    });
});
