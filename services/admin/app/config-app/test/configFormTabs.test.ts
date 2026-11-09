import apiConfigSchema, { siemSchemaDef } from '../webapp/model/apiConfigSchema';
import { groupSections } from '../webapp/model/apiConfigGroups';
import { clearPlugins, pluginFor, registerPlugin } from '../webapp/model/formPlugins';
import { containerAffordances } from '../webapp/model/formContainers';
import { applyDescriptor, buildDescriptors } from '../webapp/model/schemaForm';
import { FormContainer, containerAt, containersOf } from './helpers/formTree';

/**
 * Exercises the model-layer functions `ConfigFormTabs.buildTab` (the controller) is built from,
 * without importing that file: it pulls in `sap/m/IconTabBar`/`IconTabFilter`/`Panel`, and no
 * test in this suite loads the UI5 runtime jest would need to resolve those modules - see
 * `apiConfigGroups.test.ts`'s own header for the same note.
 *
 * Every section's pointer and resolved schema below comes from `groupSections` - the same
 * function `buildTab` calls - never re-derived inline. An earlier version of this file computed
 * `/api_config/${group}/${key}` and `resolveRef(...)` itself, which meant a bug in the pointer
 * template `buildTab` actually uses could not have turned any of these tests red: the test and
 * the real code would have been wrong in exactly the same way, together. `apiConfigGroups.test.ts`
 * covers `groupSections` on its own merits (pointer shape, section order); this file covers what
 * sits on top of it for `siem` specifically and for one platform field's round trip.
 */
describe('the tab shell\'s section-building, siem among it', () => {
    beforeEach(() => clearPlugins());

    const SIEM_POINTER = '/api_config/observability/siem';
    const CREDENTIAL_PATTERN = '/api_config/observability/siem/sinks/*/*_env';

    const siemData = {
        enabled: true,
        batch_size: 100,
        interval_ms: 15000,
        categories: ['security', 'audit'],
        sinks: [
            { name: 'datadog', type: 'datadog', enabled: false, site: 'datadoghq.com', api_key_env: 'SIEM_DATADOG_API_KEY' }
        ]
    };

    /** The `siem` entry of observability's own `groupSections(apiConfigSchema, 'observability')`. */
    function siemSection() {
        const section = groupSections(apiConfigSchema, 'observability').find(s => s.key === 'siem');
        if (!section) {
            throw new Error('observability has no siem section - groupSections regressed');
        }
        return section;
    }

    /** What ConfigForm.ts built directly before this task: buildDescriptors on siemSchemaDef, unmoved. */
    function siemDescriptorsBeforeTheMove(): unknown {
        return buildDescriptors(siemSchemaDef, siemData, SIEM_POINTER, pluginFor);
    }

    /** What ConfigFormTabs.buildTab now builds: siem resolved as observability's own section. */
    function siemDescriptorsAfterTheMove(): unknown {
        const section = siemSection();
        return buildDescriptors(section.schema, siemData, section.pointer, pluginFor);
    }

    it('resolves siem to the exact same schema object the pre-move form used directly, at the pointer it has always had', () => {
        const section = siemSection();
        expect(section.schema).toBe(siemSchemaDef);
        expect(section.pointer).toBe(SIEM_POINTER);
    });

    it('builds a byte-identical descriptor tree for siem across the move into the observability tab', () => {
        // No credential plugin registered: proves the descriptor shape alone is unaffected by
        // the move, before the plugin-registration case below adds that back in.
        expect(siemDescriptorsAfterTheMove()).toEqual(siemDescriptorsBeforeTheMove());
    });

    it('snapshots the siem descriptor tree, so any future drift - moved or not - is caught', () => {
        expect(siemDescriptorsAfterTheMove()).toMatchSnapshot();
    });

    // Plugin registration - the credential exit - is a separate concern from descriptor shape:
    // ConfigForm.ts registers it once, in its constructor, unaffected by where a section is
    // rendered. This proves the same registration still reaches the same pointer post-move.
    it('still resolves the credential plugin at the sink slot pointer after the move', () => {
        registerPlugin(CREDENTIAL_PATTERN, 'credential');
        const after = siemDescriptorsAfterTheMove() as Array<{ pointer: string; kind: string }>;
        const sinks = after.find(d => d.pointer === `${SIEM_POINTER}/sinks`) as any;
        const slot = sinks.children[0].children.find((c: any) => c.pointer.endsWith('/api_key_env'));
        expect(slot).toMatchObject({ kind: 'plugin', plugin: 'credential' });
        // Same plugin descriptor the old, unmoved call would have built - the registration itself
        // did not change, only where the panel holding it sits.
        expect(siemDescriptorsBeforeTheMove()).toEqual(siemDescriptorsAfterTheMove());
    });

    // A section this task's schema fully describes (unlike hooks.definitions or providers.openai,
    // which degrade to raw - see apiConfigGroups.test.ts) - proves a plain field elsewhere in the
    // six-tab shell round-trips through the same buildDescriptors/applyDescriptor pair the siem
    // form has always used, at the pointer groupSections actually gives the platform tab for it.
    it('a switch change in a platform section applies at the pointer the platform tab renders it', () => {
        const section = groupSections(apiConfigSchema, 'platform').find(s => s.key === 'security');
        if (!section) {
            throw new Error('platform has no security section - groupSections regressed');
        }

        const descriptors = buildDescriptors(section.schema, { trust_forwarded_for: false }, section.pointer, pluginFor);
        const trustForwardedFor = descriptors.find(d => d.pointer === `${section.pointer}/trust_forwarded_for`);
        expect(trustForwardedFor).toMatchObject({ kind: 'switch', value: false });

        const document = { api_config: { platform: { security: { trust_forwarded_for: false } } } };
        const updated = applyDescriptor(document, `${section.pointer}/trust_forwarded_for`, true) as any;

        expect(updated.api_config.platform.security.trust_forwarded_for).toBe(true);
        // The rest of the document is untouched - applyDescriptor clones rather than mutates.
        expect(document.api_config.platform.security.trust_forwarded_for).toBe(false);
    });
});

/**
 * The affordances the tab shell puts on a container, one per marker kind, for a document that
 * carries every one of them.
 *
 * `ConfigFormTabs.buildTab` and `descriptorControls.buildSection` cannot be imported here (both
 * pull in `sap/*`), so what is exercised is what they DECIDE FROM: the container each of them finds
 * - through `containersOf`, which mirrors the shell's traversal over the same exported functions -
 * and `containerAffordances`, which is the whole of the editability rule they apply. The buttons
 * themselves are the container verification's business.
 */
describe('the affordances the tab shell offers, per container', () => {
    const shipped = require('../../../api_config.json');

    const affordancesFor = (container: FormContainer, editable: boolean) => containerAffordances({
        editable,
        kind: container.kind,
        pointer: container.pointer,
        entryCount: 20,
        hasAddHandler: true,
        hasRemoveHandler: true
    });

    it('finds a map container for every map node the schema declares, and only those', () => {
        // The test that replaces `configMaps.test.ts`'s registry pin at the SHELL level: every map
        // the schema declares is reached by the traversal that renders the tabs, so every one of
        // them gets the toolbar. Dropping the marker for any of them fails here.
        const maps = containersOf(shipped)
            .filter(container => container.kind === 'map')
            .map(container => container.pointer);

        for (const pointer of [
            '/api_config/providers',
            '/api_config/models/overrides',
            '/api_config/hooks/definitions',
            '/api_config/hooks/defaults',
            '/api_config/platform/logging/components',
            '/api_config/platform/rate_limit_handling/model_specific_delays',
            '/api_config/platform/rate_limit_handling/subpath_specific_delays',
            '/api_config/observability/pseudonymization/entities'
        ]) {
            expect(maps).toContain(pointer);
        }
        // ... including the ones only reachable through another map's own entries, which no
        // registry ever listed: a per-endpoint subpath map, and a provider's parameter renames.
        expect(maps).toContain('/api_config/hooks/defaults/anthropic');
        expect(maps.filter(pointer => pointer.endsWith('/param_renames')).length).toBeGreaterThan(0);
        // Nothing that is not a map: a section of plain fields has no toolbar to draw.
        expect(maps).not.toContain('/api_config/platform/timeouts');
        expect(maps).not.toContain('/api_config/observability/siem');
    });

    it('offers the [+] on an array as well as on a map, and keeps the sink array discriminated', () => {
        const containers = containersOf(shipped);
        const sinks = containers.filter(one => one.pointer === '/api_config/observability/siem/sinks')[0];
        const hooks = containers.filter(one => one.pointer === '/api_config/hooks/defaults/openai/responses')[0];

        // Both are appendable. Only one of them opens the sink dialog rather than appending the
        // schema's own skeleton, and `discriminated` is what says so - the same flag that chooses
        // between the "Add a sink" and "Add an entry" wordings.
        expect(sinks).toMatchObject({ kind: 'array', arrayItems: { discriminated: true } });
        expect(hooks).toMatchObject({ kind: 'array', arrayItems: { discriminated: false } });
        expect(affordancesFor(sinks, true).add).toBe(true);
        expect(affordancesFor(hooks, true).add).toBe(true);
    });

    it('draws nothing on a read-only form - not on a map, an array, or an absent section', () => {
        // The editability pin the design asks for, over the containers of a real document rather
        // than over a hand-made one: an active configuration, or a non-admin, gets no [+], no [-]
        // and no Add section anywhere.
        const containers = containersOf(shipped).concat(containersOf({ api_config: {} }));
        expect(containers.length).toBeGreaterThan(20);
        for (const container of containers) {
            expect(affordancesFor(container, false)).toMatchObject({ add: false, remove: false });
        }
        // ... and the filter stays, on the maps big enough to have one: it hides panels rather than
        // changing anything.
        expect(affordancesFor(containersOf(shipped).filter(one => one.kind === 'map')[0], false).filter).toBe(true);
    });

    it('marks a map container absent when the section around it is present but it is not', () => {
        // The nested case: `platform.logging` is carried, `platform.logging.components` is not. It
        // gets the same notice and the same Add section a whole absent section does, rather than
        // rendering as an empty panel with no way forward.
        const document = { api_config: { platform: { logging: { defaultLevel: 'INFO' } } } };
        const components = containerAt(document, '/api_config/platform/logging/components');

        expect(components).toMatchObject({ kind: 'map', absent: true });
        expect(affordancesFor(components!, true).add).toBe(true);
        expect(affordancesFor(components!, false).add).toBe(false);
    });
});
