import apiConfigSchema from '../webapp/model/apiConfigSchema';
import { groupSections } from '../webapp/model/apiConfigGroups';
import { evaluateApiConfigDocument } from '../webapp/model/documentGate';
import {
    MODEL_OVERRIDES_POINTER,
    MapSpec,
    PROVIDERS_POINTER,
    MAP_COLLAPSE_MAX_EXPANDED,
    containerAffordances,
    enumeratedKeys,
    mapEntriesCollapsed,
    mapEntrySummary,
    interpolate,
    isTopLevelContainer,
    isMapEntryKey,
    mapEntryPointer,
    mapEntryDescriptor,
    mapKeyProblem,
    mapKeyRules,
    mapSectionEntries,
    mapSpecOf,
    mapValueSchemaOf,
    matchesMapFilter,
    newArrayElement,
    newMapValue,
    nextTokens,
    remainingKeyChoices,
    sectionSeed,
    undeclaredMapKeys,
    withArrayElement
} from '../webapp/model/formContainers';
import { pluginFor } from '../webapp/model/formPlugins';
import { MapEntries, applyDescriptor, mapNodesOf, removeAt } from '../webapp/model/schemaForm';
import { containerAt, containersOf } from './helpers/formTree';

const shippedConfig = require('../../../api_config.json');

const clone = (value: unknown): any => JSON.parse(JSON.stringify(value));

/**
 * The map i18n keys resolve to themselves, so a test can assert WHICH message was chosen without
 * pinning the English wording - the wording lives in both locale files and is the container
 * verification's business, the choice is this module's.
 */
const text = (key: string): string => key;

/** Reads a JSON pointer out of a document, the way `ConfigForm._readPointer` does. */
function readPointer(document: unknown, pointer: string): unknown {
    let cursor: unknown = document;
    for (const segment of pointer.split('/').filter(Boolean).map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'))) {
        if (cursor === null || typeof cursor !== 'object') {
            return undefined;
        }
        cursor = (cursor as Record<string, unknown>)[segment];
    }
    return cursor;
}

/**
 * One row per map node the schema declares - the pure half of Task 3's add/remove path, held to
 * every one of them rather than to the two `configMaps.ts` named by hand.
 *
 * `pointer` is the template `mapNodesOf` emits, where `*` is one dynamic key. `concrete` is where
 * that map actually sits in `fixture()` below, which carries an entry in every one of them; the two
 * differ only for a map reachable through a key the schema does not name. `key` is a key that map
 * does not already have, chosen to match its own rule.
 *
 * The table is pinned against `mapNodesOf` by the first test in the file, so a map added to the
 * schema later fails here until it has a row - which is the point of deriving the affordances from
 * the schema rather than from a registry: the registry is gone, and this is what replaced it.
 */
interface MapCase {
    concrete: string;
    key: string;
    /**
     * Why an entry this form creates here does not yet validate on its own, or undefined when it
     * does. Named rather than tolerated: these are exactly the maps whose entries require a value
     * only the operator can supply, and any OTHER map joining them turns this file red.
     */
    incomplete?: string;
}

const MAP_CASES: Record<string, MapCase> = {
    '/api_config/providers': { concrete: '/api_config/providers', key: 'example-provider' },
    '/api_config/providers/anthropic/param_renames': {
        concrete: '/api_config/providers/anthropic/param_renames',
        key: 'max_tokens',
        incomplete: 'the renamed-to parameter name is free text the operator types'
    },
    '/api_config/providers/aws-bedrock/param_renames': {
        concrete: '/api_config/providers/aws-bedrock/param_renames',
        key: 'max_tokens',
        incomplete: 'the renamed-to parameter name is free text the operator types'
    },
    '/api_config/providers/openai/param_renames': {
        concrete: '/api_config/providers/openai/param_renames',
        key: 'max_tokens',
        incomplete: 'the renamed-to parameter name is free text the operator types'
    },
    '/api_config/providers/openrouter/param_renames': {
        concrete: '/api_config/providers/openrouter/param_renames',
        key: 'max_tokens',
        incomplete: 'the renamed-to parameter name is free text the operator types'
    },
    '/api_config/providers/perplexity/param_renames': {
        concrete: '/api_config/providers/perplexity/param_renames',
        key: 'max_tokens',
        incomplete: 'the renamed-to parameter name is free text the operator types'
    },
    '/api_config/providers/*/param_renames': {
        concrete: '/api_config/providers/custom-provider/param_renames',
        key: 'max_tokens',
        incomplete: 'the renamed-to parameter name is free text the operator types'
    },
    '/api_config/models/overrides': {
        concrete: '/api_config/models/overrides',
        key: 'example--model--deployed'
    },
    '/api_config/models/overrides/*/hooks': {
        concrete: '/api_config/models/overrides/example-model/hooks',
        key: 'invoke'
    },
    '/api_config/models/overrides/*/pseudonymization/entities': {
        concrete: '/api_config/models/overrides/example-model/pseudonymization/entities',
        key: 'profile-ip-address'
    },
    '/api_config/models/overrides/*/pseudonymization/thresholds': {
        concrete: '/api_config/models/overrides/example-model/pseudonymization/thresholds',
        key: 'profile-person'
    },
    '/api_config/models/overrides/*/param_renames': {
        concrete: '/api_config/models/overrides/example-model/param_renames',
        key: 'max_tokens',
        incomplete: 'the renamed-to parameter name is free text the operator types'
    },
    '/api_config/hooks/definitions': {
        concrete: '/api_config/hooks/definitions',
        key: 'test:rule',
        incomplete: 'a header rule needs the header name, which only the operator knows'
    },
    '/api_config/hooks/defaults': { concrete: '/api_config/hooks/defaults', key: 'gemini' },
    '/api_config/hooks/defaults/*': { concrete: '/api_config/hooks/defaults/anthropic', key: 'responses' },
    '/api_config/hooks/defaults/*/pseudonymization/entities': {
        concrete: '/api_config/hooks/defaults/anthropic/pseudonymization/entities',
        key: 'profile-ip-address'
    },
    '/api_config/hooks/defaults/*/pseudonymization/thresholds': {
        concrete: '/api_config/hooks/defaults/anthropic/pseudonymization/thresholds',
        key: 'profile-person'
    },
    '/api_config/platform/logging/components': {
        concrete: '/api_config/platform/logging/components',
        key: 'ExampleService'
    },
    '/api_config/platform/rate_limit_handling/model_specific_delays': {
        concrete: '/api_config/platform/rate_limit_handling/model_specific_delays',
        key: 'example--model--deployed'
    },
    '/api_config/platform/rate_limit_handling/subpath_specific_delays': {
        concrete: '/api_config/platform/rate_limit_handling/subpath_specific_delays',
        key: 'responses'
    },
    '/api_config/observability/pseudonymization/entities': {
        concrete: '/api_config/observability/pseudonymization/entities',
        key: 'profile-ip-address'
    },
    '/api_config/observability/pseudonymization/thresholds': {
        concrete: '/api_config/observability/pseudonymization/thresholds',
        key: 'profile-person'
    }
};

/**
 * The shipped configuration, plus the one undeclared provider, the one model override and the two
 * empty `entities` maps needed for every map in the table to have a place in ONE document. Still
 * schema-valid, which every assertion below depends on: an add is judged by whether it leaves the
 * document valid, so the document has to start that way.
 */
function fixture(): any {
    const document = clone(shippedConfig);
    const api = document.api_config;
    api.providers['custom-provider'] = { param_renames: {} };
    for (const provider of ['anthropic', 'aws-bedrock', 'openai', 'openrouter', 'perplexity']) {
        api.providers[provider].param_renames = api.providers[provider].param_renames ?? {};
    }
    api.models.overrides['example-model'] = {
        hooks: {},
        pseudonymization: { entities: {}, thresholds: {} },
        param_renames: {}
    };
    api.hooks.defaults.anthropic.pseudonymization = api.hooks.defaults.anthropic.pseudonymization ?? {};
    api.hooks.defaults.anthropic.pseudonymization.entities =
        api.hooks.defaults.anthropic.pseudonymization.entities ?? {};
    api.hooks.defaults.anthropic.pseudonymization.thresholds =
        api.hooks.defaults.anthropic.pseudonymization.thresholds ?? {};
    // The shipped configuration carries no confidence thresholds - the defaults are the
    // point - so the global map has to be seeded here the same way the other two are.
    api.observability.pseudonymization.thresholds =
        api.observability.pseudonymization.thresholds ?? {};
    return document;
}

/** The marker the FORM derives for this container, by the same route the tab shell takes. */
function markerOf(concrete: string): MapEntries {
    const container = containerAt(fixture(), concrete);
    if (!container || !container.mapEntries) {
        throw new Error(`the form renders no map at ${concrete}`);
    }
    return container.mapEntries;
}

function specOf(template: string): MapSpec {
    const concrete = MAP_CASES[template].concrete;
    return mapSpecOf(concrete, markerOf(concrete));
}

const providers = () => mapSpecOf(PROVIDERS_POINTER, markerOf(PROVIDERS_POINTER));
const overrides = () => mapSpecOf(MODEL_OVERRIDES_POINTER, markerOf(MODEL_OVERRIDES_POINTER));

/**
 * The pure half of Task 3's add/remove path (`webapp/model/formContainers.ts`): what a key may be,
 * what a new entry, element or section holds, what the filter hides, and which affordances the
 * editability matrix allows - for EVERY container the schema declares, not for two named by hand.
 * `webapp/controller/ConfigFormMaps.ts` builds the dialog, the toolbar and the panels around these
 * answers and decides nothing itself; it imports `sap/*`, which this suite cannot resolve, so it is
 * verified in the container instead.
 */
describe('the maps the form offers add and remove on', () => {
    it('is every map node of the schema - no registry, and nothing claimed that the schema does not declare', () => {
        // The test that replaces `configMaps.test.ts`'s "names exactly the two maps" pin. Both
        // directions: a map added to the schema has no row here (and no sample key, so nothing below
        // could exercise it), and a row here that the schema does not declare is a claim on a
        // pointer the form would draw an affordance for and then not honour.
        expect(Object.keys(MAP_CASES).sort()).toEqual(mapNodesOf(apiConfigSchema).sort());
        expect(mapNodesOf(apiConfigSchema).length).toBe(22);
    });

    for (const template of Object.keys(MAP_CASES)) {
        const { concrete } = MAP_CASES[template];
        it(`gives the toolbar and its [+] a spec at ${template}`, () => {
            // Reached through `containersOf`, i.e. through the descriptor tree and the section
            // markers the tab shell actually renders from - not by re-walking the schema here. A
            // marker that stops being produced (or stops reaching the control layer) fails here.
            const spec = mapSpecOf(concrete, markerOf(concrete));

            expect(spec.pointer).toBe(concrete);
            expect(spec.keyPattern).toBeInstanceOf(RegExp);
            expect(spec.keyPattern.source.charAt(0)).toBe('^');
            expect(['object', 'scalar', 'array']).toContain(spec.valueKind);
            expect(containerAffordances({
                editable: true, kind: 'map', pointer: concrete, entryCount: 0, hasAddHandler: true, hasRemoveHandler: true
            }).add).toBe(true);
        });
    }

    it('draws no toolbar for a section that is not a map', () => {
        expect(containerAt(fixture(), '/api_config/observability/siem')).toBeUndefined();
        expect(containerAt(fixture(), '/api_config/platform/timeouts')).toBeUndefined();
    });
});

describe('the key a new entry is created under', () => {
    it('keeps the provider rule: a route segment, because the gateway matches it in a URL path', () => {
        expect(mapKeyProblem('aws-bedrock', [], providers(), text)).toBe('');
        expect(mapKeyProblem('aws bedrock', [], providers(), text)).toBe('formProviderKeyPattern');
        expect(mapKeyProblem('AWS-Bedrock', [], providers(), text)).toBe('formProviderKeyPattern');
        expect(mapKeyProblem('anthropic/v1', [], providers(), text)).toBe('formProviderKeyPattern');
        expect(mapKeyProblem('', [], providers(), text)).toBe('formProviderKeyRequired');
    });

    it('keeps the model-override rule: an id as SAP AI Core spells it, case and dots kept', () => {
        expect(mapKeyProblem('anthropic--claude-4.6-sonnet--deployed', [], overrides(), text)).toBe('');
        expect(mapKeyProblem('claude 4 sonnet', [], overrides(), text)).toBe('formOverrideKeyPattern');
        expect(mapKeyProblem('anthropic/claude', [], overrides(), text)).toBe('formOverrideKeyPattern');
        expect(mapKeyProblem('', [], overrides(), text)).toBe('formOverrideKeyRequired');
    });

    it('accepts every key the shipped configuration already uses, in both of those maps', () => {
        for (const key of Object.keys(shippedConfig.api_config.providers)) {
            expect(mapKeyProblem(key, [], providers(), text)).toBe('');
        }
        for (const key of Object.keys(shippedConfig.api_config.models.overrides)) {
            expect(mapKeyProblem(key, [], overrides(), text)).toBe('');
        }
    });

    it('takes the schema\'s own pattern wherever the schema declares one', () => {
        const components = specOf('/api_config/platform/logging/components');
        // The rule as the schema author wrote it is what a message quotes; the compiled matcher is
        // that source wrapped between anchors of the form's own - see `anchored`.
        expect(components.keyPatternSource).toBe('^[a-zA-Z0-9_-]+$');
        expect(components.keyPattern.source).toBe('^(?:[a-zA-Z0-9_-]+)$');
        expect(mapKeyProblem('ExampleService', [], components, text)).toBe('');
        // The message names the pattern, because nothing else on screen says what a key may be.
        expect(mapKeyProblem('has space', [], components, text))
            .toBe(interpolate('formMapKeyPattern', '^[a-zA-Z0-9_-]+$'));

        // The subpath map's pattern excludes the one key its schema declares beside the entries.
        const subpaths = specOf('/api_config/hooks/defaults/*');
        expect(mapKeyProblem('responses', [], subpaths, text)).toBe('');
        expect(mapKeyProblem('pseudonymization', [], subpaths, text)).toContain('formMapKeyPattern');

        // An entities map only accepts the categories the plugin knows.
        const entities = specOf('/api_config/observability/pseudonymization/entities');
        expect(mapKeyProblem('profile-ip-address', [], entities, text)).toBe('');
        expect(mapKeyProblem('profile-shoe-size', [], entities, text)).toContain('formMapKeyPattern');
    });

    it('falls back to "not empty, no whitespace" where the schema constrains keys not at all', () => {
        // `hooks.defaults`' endpoint identifiers and every `param_renames` parameter name. Nothing
        // here knows the shape of either, so the rule is the weakest one that still refuses a typo.
        const endpoints = specOf('/api_config/hooks/defaults');
        expect(endpoints.keyPattern.source).toBe('^\\S+$');
        expect(mapKeyProblem('gemini', [], endpoints, text)).toBe('');
        expect(mapKeyProblem('two words', [], endpoints, text)).toContain('formMapKeyPatternGeneric');
        expect(mapKeyProblem('   ', [], endpoints, text)).toBe('formMapKeyRequiredGeneric');

        const renames = specOf('/api_config/providers/anthropic/param_renames');
        expect(mapKeyProblem('max_tokens', [], renames, text)).toBe('');
    });

    it('refuses a duplicate and names the clashing key everywhere the message mentions it', () => {
        const message = mapKeyProblem('openai', ['openai'], providers(), key =>
            key === 'formProviderKeyDuplicate'
                ? 'The key "{0}" is already configured here. Edit the existing "{0}" panel.'
                : key);
        expect(message).toBe('The key "openai" is already configured here. Edit the existing "openai" panel.');
        // ... and on a map with no wording of its own, the generic message is the one chosen.
        expect(mapKeyProblem('ExampleService', ['ExampleService'], specOf('/api_config/platform/logging/components'), text))
            .toContain('formMapKeyDuplicateGeneric');
    });

    it('compares keys case-sensitively, because the document does, and trims before it decides', () => {
        expect(mapKeyProblem('Gpt-35-Turbo-0125', ['gpt-35-turbo-0125'], overrides(), text)).toBe('');
        expect(mapKeyProblem('  openai  ', ['openai'], providers(), text)).toContain('formProviderKeyDuplicate');
        expect(mapKeyProblem('  openai  ', [], providers(), text)).toBe('');
    });

    it('separates an entry of a map from a property the schema declares beside its entries', () => {
        // `hooks.defaults.<endpoint>` is a map of subpaths that also declares `pseudonymization`.
        // Only the former may carry a [-]; the latter is a field of the endpoint, not an entry.
        const subpaths = specOf('/api_config/hooks/defaults/*');
        expect(isMapEntryKey('invoke', subpaths)).toBe(true);
        expect(isMapEntryKey('pseudonymization', subpaths)).toBe(false);
        // A map whose schema constrains keys not at all has no such distinction to draw: every key
        // the document carries is an entry.
        expect(isMapEntryKey('anything at all', specOf('/api_config/hooks/defaults'))).toBe(true);
    });
});

describe('what a newly added entry holds', () => {
    it('is the empty object for a map whose entry schema requires nothing', () => {
        expect(newMapValue(providers())).toEqual({});
        expect(newMapValue(overrides())).toEqual({});
        expect(newMapValue(specOf('/api_config/hooks/defaults'))).toEqual({});
    });

    it('is the required leaves alone for a map whose entry schema requires something', () => {
        // `{}` would match all four of the rule schema's `if` branches vacuously and arrive with
        // five errors instead of the one the operator can act on.
        expect(newMapValue(specOf('/api_config/hooks/definitions'))).toEqual({ type: 'header' });
    });

    it('is the empty list for an array-valued map, whose entry then offers its own [+]', () => {
        expect(newMapValue(specOf('/api_config/hooks/defaults/*'))).toEqual([]);
        expect(newMapValue(specOf('/api_config/models/overrides/*/hooks'))).toEqual([]);
    });

    it('is the schema\'s own default for a scalar-valued map', () => {
        // INFO, not TRACE - the enum's first member - because the schema now says so. See
        // `documentGate.test.ts` for the proof that saying so changes no validation verdict.
        expect(newMapValue(specOf('/api_config/platform/logging/components'))).toBe('INFO');
        // A masking toggle is added to SAY something, so it starts switched on ...
        expect(newMapValue(specOf('/api_config/observability/pseudonymization/entities'))).toBe(true);
        // ... a delay starts at the schema's own floor, and a rename at the empty string the
        // operator replaces.
        expect(newMapValue(specOf('/api_config/platform/rate_limit_handling/model_specific_delays'))).toBe(0);
        expect(newMapValue(specOf('/api_config/providers/anthropic/param_renames'))).toBe('');
    });

    it('never hands out the same object twice, so two added entries cannot share one value', () => {
        const spec = specOf('/api_config/hooks/definitions');
        const first = newMapValue(spec) as Record<string, unknown>;
        const second = newMapValue(spec) as Record<string, unknown>;
        first.type = 'url-regex';
        expect(second).toEqual({ type: 'header' });
    });
});

describe('adding an entry to every map the schema declares', () => {
    for (const template of Object.keys(MAP_CASES)) {
        const { concrete, key, incomplete } = MAP_CASES[template];

        it(`adds ${key} to ${template} and leaves the document ${incomplete ? 'valid except inside the new entry' : 'valid'}`, () => {
            const document = fixture();
            expect(evaluateApiConfigDocument(apiConfigSchema, document).errors).toEqual([]);

            const spec = mapSpecOf(concrete, markerOf(concrete));
            const pointer = mapEntryPointer(concrete, key);
            // Exactly what `ConfigForm._applyChange` does for a [+]: one write, at the entry's own
            // pointer, of the value the marker says a new key holds.
            const added = applyDescriptor(document, pointer, newMapValue(spec));

            expect(readPointer(added, pointer)).toEqual(newMapValue(spec));
            const errors = evaluateApiConfigDocument(apiConfigSchema, added).errors;
            if (incomplete) {
                expect(errors.length).toBeGreaterThan(0);
                // Whatever is still missing is INSIDE what was just added: the add can never make
                // any other part of the document invalid.
                expect(errors.filter(message => message.indexOf(pointer) === -1)).toEqual([]);
            } else {
                expect(errors).toEqual([]);
            }
        });

        it(`refuses ${key} a second time in ${template}, naming the clash`, () => {
            const document = fixture();
            const spec = mapSpecOf(concrete, markerOf(concrete));
            const pointer = mapEntryPointer(concrete, key);
            const added = applyDescriptor(document, pointer, newMapValue(spec)) as any;

            const existing = Object.keys(readPointer(added, concrete) as Record<string, unknown>);
            expect(existing).toContain(key);
            expect(mapKeyProblem(key, existing, spec, text)).toContain(spec.keyDuplicateText);
            // ... and the message the user reads names the key itself.
            expect(mapKeyProblem(key, existing, spec, k => `clash with "{0}" in ${k}`)).toContain(`"${key}"`);
        });

        it(`removes ${key} from ${template} again, and exactly that`, () => {
            const document = fixture();
            const spec = mapSpecOf(concrete, markerOf(concrete));
            const pointer = mapEntryPointer(concrete, key);
            const added = applyDescriptor(document, pointer, newMapValue(spec));

            const before = Object.keys(readPointer(document, concrete) as Record<string, unknown>);
            const removed = removeAt(added, pointer);

            expect(Object.keys(readPointer(removed, concrete) as Record<string, unknown>)).toEqual(before);
            // Not merely "one key fewer": the document is byte-identical to the one before the add,
            // so nothing else moved on the way in or out.
            expect(removed).toEqual(document);
        });
    }

    it('removes one key the shipped configuration already has, and leaves it valid', () => {
        const document = fixture();
        const overridePointer = MODEL_OVERRIDES_POINTER;
        const existing = Object.keys(readPointer(document, overridePointer) as Record<string, unknown>);
        const removed = removeAt(document, mapEntryPointer(overridePointer, existing[0]));

        expect(Object.keys(readPointer(removed, overridePointer) as Record<string, unknown>))
            .toEqual(existing.slice(1));
        expect(evaluateApiConfigDocument(apiConfigSchema, removed).errors).toEqual([]);
    });
});

describe('appending to and removing from an array', () => {
    const HOOKS_POINTER = '/api_config/hooks/defaults/openai/responses';
    const SINKS_POINTER = '/api_config/observability/siem/sinks';

    it('appends the schema\'s own skeleton to a hook list, and nothing optional beside it', () => {
        const document = fixture();
        const container = containerAt(document, HOOKS_POINTER);
        expect(container).toMatchObject({ kind: 'array', arrayItems: { discriminated: false } });

        const before = readPointer(document, HOOKS_POINTER) as unknown[];
        const appended = withArrayElement(before, newArrayElement(container!.arrayItems!));
        const added = applyDescriptor(document, HOOKS_POINTER, appended) as any;
        const after = readPointer(added, HOOKS_POINTER) as unknown[];

        expect(after).toHaveLength(before.length + 1);
        expect(after[after.length - 1]).toEqual({ request: { callback: { id: '' }, match: [] } });
        // Deliberately not yet valid, and only inside the element just added: `match` needs one rule
        // and `callback.id` a plugin name, which is what the operator supplies.
        const errors = evaluateApiConfigDocument(apiConfigSchema, added).errors;
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.filter(message => message.indexOf(`${HOOKS_POINTER}/${before.length}`) === -1)).toEqual([]);
    });

    it('removes exactly one element by index, leaving every other element in place', () => {
        const document = fixture();
        const before = readPointer(document, HOOKS_POINTER) as unknown[];
        expect(before.length).toBeGreaterThan(1);

        const removed = removeAt(document, `${HOOKS_POINTER}/0`);
        const after = readPointer(removed, HOOKS_POINTER) as unknown[];

        expect(after).toHaveLength(before.length - 1);
        expect(after).toEqual(before.slice(1));
        expect(evaluateApiConfigDocument(apiConfigSchema, removed).errors).toEqual([]);
    });

    it('never hands out the same skeleton twice, so two appended hooks cannot share one object', () => {
        const container = containerAt(fixture(), HOOKS_POINTER)!;
        const first = newArrayElement(container.arrayItems!) as any;
        const second = newArrayElement(container.arrayItems!) as any;
        first.request.callback.id = 'pseudonymization';
        expect(second).toEqual({ request: { callback: { id: '' }, match: [] } });
    });

    /**
     * The owner's live failure, as a test. On a MINIMAL document the [+] on the sink list used to
     * write `{"api_config":{...},"sinks":[...]}` - the pointer's longest resolvable SUFFIX, at the
     * document root - because `observability.siem` was not there to write into. The save was then
     * refused by whole-document validation naming a pointer nobody could act on.
     *
     * `_writeSinks` is unchanged and still goes through `_applyChange`; what changed under it is
     * `applyDescriptor`, which now resolves from the root and creates the objects on the way.
     */
    it('creates observability.siem.sinks on a minimal document instead of writing at the root', () => {
        const minimal = { api_config: { platform: { logging: { defaultLevel: 'INFO' } } } };
        const sink = { name: 'first', type: 'webhook', url: 'https://example.invalid/siem' };

        const added = applyDescriptor(minimal, SINKS_POINTER, [sink]) as any;

        expect(added.api_config.observability.siem.sinks).toEqual([sink]);
        expect(Object.keys(added)).toEqual(['api_config']);
        expect(added.sinks).toBeUndefined();
        expect(evaluateApiConfigDocument(apiConfigSchema, added).errors).toEqual([]);
        // The input is untouched - `applyDescriptor` clones.
        expect((minimal as any).api_config.observability).toBeUndefined();
    });
});

describe('typing a value into a free-text list', () => {
    it('turns the typed text into one more value, trimmed at the ends and nowhere else', () => {
        expect(nextTokens([], 'header:contentTypeJson')).toEqual(['header:contentTypeJson']);
        expect(nextTokens(['a'], '  b  ')).toEqual(['a', 'b']);
        // Free text, not narrowed: a rule id carries colons and equals signs, an org suffix a dot.
        expect(nextTokens([], 'header:x-app=cli')).toEqual(['header:x-app=cli']);
        expect(nextTokens([], 'Inc.')).toEqual(['Inc.']);
    });

    it('refuses text that is not a value - the schema wants a non-empty string', () => {
        expect(nextTokens([], '')).toBeNull();
        expect(nextTokens([], '   ')).toBeNull();
        expect(nextTokens(['a'], '\t')).toBeNull();
    });

    it('refuses a duplicate, before and after trimming', () => {
        // A repeated rule id changes nothing about what a hook matches, and several of these arrays
        // declare uniqueItems, so a second copy would be a document the gate refuses.
        expect(nextTokens(['header:contentTypeJson'], 'header:contentTypeJson')).toBeNull();
        expect(nextTokens(['a', 'b'], '  b ')).toBeNull();
        // Case is part of the value, so these are two different rule ids.
        expect(nextTokens(['a'], 'A')).toEqual(['a', 'A']);
    });

    it('never mutates the list it was given, and keeps its order', () => {
        const existing = ['b', 'a'];
        expect(nextTokens(existing, 'c')).toEqual(['b', 'a', 'c']);
        expect(existing).toEqual(['b', 'a']);
    });

    it('lets a hook created by the [+] be completed in the form, and only then does it validate', () => {
        // The defect this closes, end to end: the [+] appends a skeleton whose `match` is empty and
        // whose `callback.id` is "", and `match` renders as the very control that could not take a
        // value. With one, and an id, the document validates - so the hook can be finished here
        // rather than in the JSON editor.
        const document = fixture();
        const pointer = '/api_config/hooks/defaults/openai/responses';
        const container = containerAt(document, pointer)!;
        const before = readPointer(document, pointer) as unknown[];
        const index = before.length;

        let next = applyDescriptor(
            document,
            pointer,
            withArrayElement(before, newArrayElement(container.arrayItems!))
        );
        expect(evaluateApiConfigDocument(apiConfigSchema, next).errors.length).toBeGreaterThan(0);

        const matchPointer = `${pointer}/${index}/request/match`;
        next = applyDescriptor(next, matchPointer, nextTokens([], 'header:contentTypeJson'));
        next = applyDescriptor(next, `${pointer}/${index}/request/callback/id`, 'pseudonymizationPlugin');

        expect(readPointer(next, matchPointer)).toEqual(['header:contentTypeJson']);
        expect(evaluateApiConfigDocument(apiConfigSchema, next).errors).toEqual([]);

        // ... and the [-] on that element takes it away again, exactly it.
        const removed = removeAt(next, `${pointer}/${index}`);
        expect(readPointer(removed, pointer)).toEqual(before);
        expect(evaluateApiConfigDocument(apiConfigSchema, removed).errors).toEqual([]);
    });
});

describe('Add section, on a document that carries almost nothing', () => {
    /** The document from the design's problem statement, near enough. */
    const minimal = (): any => ({
        api_config: {
            platform: {
                timeouts: { default: 600000, streaming: 600000 },
                logging: { defaultLevel: 'INFO' }
            }
        }
    });

    it('finds an absent container for every section the document does not carry', () => {
        const absent = containersOf(minimal()).filter(container => container.absent);
        // Not a fixed list - what the schema declares - but it must at least reach the sections the
        // design names, and every one of them must be offered rather than silently rendered.
        expect(absent.map(container => container.pointer)).toEqual(expect.arrayContaining([
            '/api_config/platform/rate_limit_handling',
            '/api_config/platform/security',
            '/api_config/observability/siem',
            '/api_config/hooks/defaults',
            '/api_config/hooks/definitions',
            '/api_config/models/overrides',
            // The nested case: `logging` IS carried, `logging.components` is not - a map container
            // inside a present section, which gets the same notice and the same affordance.
            '/api_config/platform/logging/components'
        ]));
    });

    for (const pointer of [
        '/api_config/platform/rate_limit_handling',
        '/api_config/observability/siem',
        '/api_config/hooks/defaults',
        '/api_config/platform/logging/components'
    ]) {
        it(`writes an empty container at exactly ${pointer} and nowhere else`, () => {
            const document = minimal();
            const container = containerAt(document, pointer);
            expect(container?.absent).toBe(true);

            const added = applyDescriptor(document, pointer, sectionSeed(container!)) as any;

            expect(readPointer(added, pointer)).toEqual({});
            // Nothing else in the document moved, and in particular nothing landed at the root.
            expect(Object.keys(added)).toEqual(['api_config']);
            expect(readPointer(added, '/api_config/platform/timeouts'))
                .toEqual(readPointer(document, '/api_config/platform/timeouts'));
            // The section is gone again when it is removed. What stays behind is the empty GROUP
            // object `applyDescriptor` created on the way in (`observability`, `hooks`) - an
            // intermediate the pointer needed, which every group's schema accepts as empty.
            const back = removeAt(added, pointer) as any;
            expect(readPointer(back, pointer)).toBeUndefined();
            expect(evaluateApiConfigDocument(apiConfigSchema, back).errors).toEqual([]);
            // An empty section is a valid section: the form may open on what it just created.
            expect(evaluateApiConfigDocument(apiConfigSchema, added).errors).toEqual([]);
        });
    }

    it('writes the empty LIST for a container that is an array, not the empty object', () => {
        expect(sectionSeed({ arrayItems: { discriminated: true, skeleton: {} } })).toEqual([]);
        expect(sectionSeed({})).toEqual({});
    });

    it('renders no field at its schema default for a section the document does not carry', () => {
        // The reason Add section exists at all: before it, `rate_limit_handling` rendered every one
        // of its fields at a default nobody had chosen, and editing one wrote at the document root.
        const container = containerAt(minimal(), '/api_config/platform/rate_limit_handling');
        expect(container).toEqual({ pointer: '/api_config/platform/rate_limit_handling', kind: 'section', absent: true });
    });

    it('lets the whole minimal document be filled in section by section, and stays valid throughout', () => {
        let document = minimal();
        for (const container of containersOf(minimal()).filter(one => one.absent)) {
            document = applyDescriptor(document, container.pointer, sectionSeed(container)) as any;
        }
        expect(evaluateApiConfigDocument(apiConfigSchema, document).errors).toEqual([]);
    });
});

describe('the filter above a map', () => {
    const keys = [
        'anthropic--claude-4-sonnet--deployed',
        'anthropic--claude-3-haiku--deployed',
        'gpt-35-turbo-0125',
        'sonar-pro'
    ];
    const shown = (filter: string): string[] => keys.filter(key => matchesMapFilter(key, filter));

    it('hides every entry whose key does not carry the text, and reveals them again when it is cleared', () => {
        expect(shown('haiku')).toEqual(['anthropic--claude-3-haiku--deployed']);
        expect(shown('gpt')).toEqual(['gpt-35-turbo-0125']);
        expect(shown('')).toEqual(keys);
    });

    it('matches case-insensitively, anywhere in the key', () => {
        expect(shown('CLAUDE')).toEqual([
            'anthropic--claude-4-sonnet--deployed',
            'anthropic--claude-3-haiku--deployed'
        ]);
        expect(shown('turbo')).toEqual(['gpt-35-turbo-0125']);
    });

    it('treats a blank filter as no filter, so a stray space does not blank the page', () => {
        expect(shown('   ')).toEqual(keys);
    });

    it('hides everything when nothing matches, rather than falling back to showing all', () => {
        expect(shown('mistral')).toEqual([]);
    });
});

describe('the editability matrix, applied to a container', () => {
    const handlers = { hasAddHandler: true, hasRemoveHandler: true };
    /** A map inside a section, which is what the entry-count threshold is a rule for. */
    const NESTED = '/api_config/platform/logging/components';

    it('offers add and remove only to an editable form', () => {
        expect(containerAffordances({ editable: true, kind: 'map', pointer: NESTED, entryCount: 20, ...handlers }))
            .toEqual({ add: true, remove: true, filter: true, expand: true, jump: true });
    });

    it('offers neither on a read-only form - an active configuration, or a non-admin', () => {
        // The pin the design asks for: no [+], no [-], no Add section for anyone who may not edit.
        for (const kind of ['map', 'array', 'section'] as const) {
            expect(containerAffordances({ editable: false, kind, pointer: NESTED, entryCount: 20, ...handlers }))
                .toMatchObject({ add: false, remove: false });
        }
    });

    it('leaves the filter usable read-only: it hides panels, it does not change the document', () => {
        expect(containerAffordances({
            editable: false, kind: 'map', pointer: NESTED, entryCount: 20, hasAddHandler: false, hasRemoveHandler: false
        }).filter).toBe(true);
    });

    it('draws a NESTED map\'s filter only once there are enough entries to be worth filtering', () => {
        const filterAt = (entryCount: number): boolean =>
            containerAffordances({ editable: true, kind: 'map', pointer: NESTED, entryCount, ...handlers }).filter;
        expect(filterAt(8)).toBe(false);
        expect(filterAt(9)).toBe(true);
        // An array's elements are addressed by index, not by key - there is nothing to filter on.
        expect(containerAffordances({ editable: true, kind: 'array', pointer: NESTED, entryCount: 99, ...handlers }).filter)
            .toBe(false);
    });

    it('keeps a top-level map section\'s filter whatever the entry count, and Providers has five', () => {
        // Spec 2 promised and shipped the filter on Providers, which has five declared entries; the
        // threshold is a rule for a map INSIDE a section, not for a whole tab or a whole section
        // whose filter row would otherwise appear and vanish as entries are added.
        const filterOn = (pointer: string, entryCount: number): boolean =>
            containerAffordances({ editable: true, kind: 'map', pointer, entryCount, ...handlers }).filter;

        expect(Object.keys(fixture().api_config.providers)).toHaveLength(6);
        expect(groupSections(apiConfigSchema, 'providers')).toHaveLength(5);
        expect(filterOn(PROVIDERS_POINTER, 5)).toBe(true);
        for (const pointer of [MODEL_OVERRIDES_POINTER, '/api_config/hooks/definitions', '/api_config/hooks/defaults']) {
            expect(filterOn(pointer, 0)).toBe(true);
            expect(isTopLevelContainer(pointer)).toBe(true);
        }
        // ... and a nested map with the same five entries has none.
        expect(filterOn(NESTED, 5)).toBe(false);
        expect(isTopLevelContainer(NESTED)).toBe(false);
    });

    it('offers add on a container the document does not carry - that is what Add section writes', () => {
        // Spec 2 withheld it there, which is why an absent map could not be created from the form at
        // all. The container is now created by the same affordance, at the same pointer.
        expect(containerAffordances({
            editable: true, kind: 'section', pointer: NESTED, entryCount: 0, ...handlers
        }).add).toBe(true);
    });

    it('withholds each affordance the host offers no handler for', () => {
        expect(containerAffordances({
            editable: true, kind: 'map', pointer: NESTED, entryCount: 20, hasAddHandler: false, hasRemoveHandler: false
        })).toEqual({ add: false, remove: false, filter: true, expand: true, jump: true });
    });

    // Expand all, Collapse all and the jump list appear exactly where the entries start collapsed:
    // they are the affordances a CLOSED list needs, and a map of three has no closed list.
    it('draws the collapse affordances only for a map long enough to be read as a list', () => {
        const at = (entryCount: number) =>
            containerAffordances({ editable: true, kind: 'map', pointer: NESTED, entryCount, ...handlers });
        expect(at(3)).toMatchObject({ expand: false, jump: false });
        expect(at(4)).toMatchObject({ expand: true, jump: true });
        expect(mapEntriesCollapsed(3)).toBe(false);
        expect(mapEntriesCollapsed(4)).toBe(true);
        expect(MAP_COLLAPSE_MAX_EXPANDED).toBe(3);
        // Read-only changes nothing about them: they open and scroll panels, they do not edit.
        expect(containerAffordances({
            editable: false, kind: 'map', pointer: NESTED, entryCount: 20, hasAddHandler: false, hasRemoveHandler: false
        })).toMatchObject({ expand: true, jump: true });
        // An array's elements are addressed by index - it is not a map and has neither.
        expect(containerAffordances({ editable: true, kind: 'array', pointer: NESTED, entryCount: 99, ...handlers }))
            .toMatchObject({ expand: false, jump: false });
    });
});

describe('the entries one map section shows', () => {
    it('shows the schema\'s five declared providers first, then whatever else the document carries', () => {
        const declared = groupSections(apiConfigSchema, 'providers');
        const entries = mapSectionEntries({
            spec: providers(),
            containerSchema: { additionalProperties: { type: 'object' } },
            containerData: fixture().api_config.providers,
            declared
        });

        expect(entries.map(entry => entry.key)).toEqual(
            declared.map(section => section.key).concat(['custom-provider'])
        );
        // A declared provider is built from its OWN schema (openai composes extra fields), an
        // undeclared one from the map's generic entry schema.
        expect(entries[0].schema).toBe(declared[0].schema);
        expect(entries[entries.length - 1].pointer).toBe('/api_config/providers/custom-provider');
    });

    it('offers no [-] for a declared key the document does not carry - there is nothing to remove', () => {
        const declared = groupSections(apiConfigSchema, 'providers');
        const entries = mapSectionEntries({
            spec: providers(),
            containerSchema: {},
            containerData: { anthropic: {} },
            declared
        });

        expect(entries.filter(entry => entry.removable).map(entry => entry.key)).toEqual(['anthropic']);
    });

    it('is empty for a container the document does not carry, rather than throwing', () => {
        expect(mapSectionEntries({
            spec: overrides(),
            containerSchema: {},
            containerData: undefined
        })).toEqual([]);
        expect(undeclaredMapKeys(undefined, ['anthropic'])).toEqual([]);
    });

    it('reads the entry schema from patternProperties first, then additionalProperties', () => {
        const patterned = { patternProperties: { '^x$': { type: 'number' } }, additionalProperties: { type: 'string' } };
        expect(mapValueSchemaOf(patterned)).toEqual({ type: 'number' });
        expect(mapValueSchemaOf({ additionalProperties: { type: 'string' } })).toEqual({ type: 'string' });
        // A node that is not a map at all answers "anything", not undefined - see its own header.
        expect(mapValueSchemaOf({ additionalProperties: false })).toEqual({});
    });
});

describe('the descriptor one map entry is rendered from', () => {
    const providerEntries = (containerData: Record<string, unknown>) => mapSectionEntries({
        spec: providers(),
        containerSchema: { additionalProperties: { type: 'object' } },
        containerData,
        declared: groupSections(apiConfigSchema, 'providers')
    });

    const descriptorFor = (entry: any) =>
        mapEntryDescriptor(entry, apiConfigSchema as any, pluginFor) as any;

    it('is the absent marker itself for a declared key the document does not carry', () => {
        // Passed through, not wrapped: the entry's OWN panel says "not present" and carries Add
        // section. Wrapping it would put that notice one panel deeper, inside a panel that says
        // nothing, and would leave the entry looking present while it is not.
        const openrouter = providerEntries({ anthropic: {} }).filter(entry => entry.key === 'openrouter')[0];
        const descriptor = descriptorFor(openrouter);

        expect(descriptor).toMatchObject({
            kind: 'section',
            pointer: '/api_config/providers/openrouter',
            absent: true,
            children: []
        });
        expect(openrouter.removable).toBe(false);
    });

    it('is the field itself for an entry that is one scalar, so its [-] sits beside the control', () => {
        // A scalar map's entry is a labelled row, not a panel. Wrapping it in a section would give
        // every parameter rename and every component override a collapsible panel of its own.
        const renames = specOf('/api_config/providers/anthropic/param_renames');
        const entry = mapSectionEntries({
            spec: renames,
            containerSchema: { additionalProperties: { type: 'string', minLength: 1 } },
            containerData: { max_tokens: 'max_completion_tokens' }
        })[0];

        const descriptor = descriptorFor(entry);
        expect(descriptor.kind).toBe('text');
        expect(descriptor.pointer).toBe('/api_config/providers/anthropic/param_renames/max_tokens');
        expect(descriptor.value).toBe('max_completion_tokens');
    });

    it('wraps an object entry in a section titled with its key, carrying its schema description', () => {
        const anthropic = providerEntries({ anthropic: { timeout: 1000 } })
            .filter(entry => entry.key === 'anthropic')[0];
        const descriptor = descriptorFor(anthropic);

        expect(descriptor.kind).toBe('section');
        expect(descriptor.absent).toBeUndefined();
        expect(descriptor.label).toBe('Anthropic');
        expect(descriptor.children.length).toBeGreaterThan(1);
        expect(typeof descriptor.description).toBe('string');
        expect(anthropic.removable).toBe(true);
    });

    it('carries its own map marker when the entry is itself a map', () => {
        // `hooks.defaults.<endpoint>` is an entry of one map and a map of subpaths in its own right,
        // so its panel needs both a [-] from the map above it and a [+] of its own.
        const defaults = specOf('/api_config/hooks/defaults');
        const section = groupSections(apiConfigSchema, 'hooks').filter(one => one.key === 'defaults')[0];
        const entry = mapSectionEntries({
            spec: defaults,
            containerSchema: section.schema,
            containerData: fixture().api_config.hooks.defaults
        }).filter(one => one.key === 'anthropic')[0];

        expect(descriptorFor(entry).mapEntries).toEqual({
            valueKind: 'array',
            keyPattern: '^(?!pseudonymization$)[a-zA-Z0-9_/-]+$'
        });
    });
});

describe('mapKeyRules', () => {
    it('is the only thing left in the form that is keyed by pointer, and only for two pointers', () => {
        const marker: MapEntries = { valueKind: 'object' };
        expect(mapKeyRules(PROVIDERS_POINTER, marker).message).toBe('formProviderKeyPattern');
        expect(mapKeyRules(MODEL_OVERRIDES_POINTER, marker).message).toBe('formOverrideKeyPattern');
        // Every other pointer answers from the marker alone - the same marker, the same answer,
        // wherever in the document that map happens to sit.
        expect(mapKeyRules('/api_config/hooks/defaults', marker))
            .toEqual(mapKeyRules('/api_config/somewhere/else', marker));
    });

    it('anchors a schema pattern that does not anchor itself, so it cannot match part of a key', () => {
        const rules = mapKeyRules('/api_config/anywhere', { valueKind: 'scalar', keyPattern: '[a-z]+' });
        expect(rules.pattern.test('abc')).toBe(true);
        expect(rules.pattern.test('a b')).toBe(false);
        // A source with a top-level alternation cannot come apart when it is wrapped.
        const alternation = mapKeyRules('/api_config/anywhere', { valueKind: 'scalar', keyPattern: 'a|b' });
        expect(alternation.pattern.test('a')).toBe(true);
        expect(alternation.pattern.test('ac')).toBe(false);
    });

    it('anchors a pattern that only LOOKS anchored, where its first and last character are the anchors of different alternatives', () => {
        // `^foo|bar$` starts with ^ and ends with $ and is nevertheless two alternatives, each
        // anchored at one end only: it matches `foozz` and `xxbar`. Returning such a source
        // unchanged - which an "already anchored, leave it alone" shortcut does - lets a key through
        // that the form's own whole-key rule says it should refuse.
        const rules = mapKeyRules('/api_config/anywhere', { valueKind: 'scalar', keyPattern: '^foo|bar$' });
        expect(rules.pattern.source).toBe('^(?:foo|bar)$');
        expect(rules.pattern.test('foo')).toBe(true);
        expect(rules.pattern.test('bar')).toBe(true);
        expect(rules.pattern.test('foozz')).toBe(false);
        expect(rules.pattern.test('xxbar')).toBe(false);
        // The source is quoted to the user as the schema wrote it, not as it was compiled.
        expect(rules.source).toBe('^foo|bar$');
    });

    it('leaves an escaped dollar sign alone - it is a literal, not an anchor', () => {
        const rules = mapKeyRules('/api_config/anywhere', { valueKind: 'scalar', keyPattern: '^cost\\$' });
        expect(rules.pattern.source).toBe('^(?:cost\\$)$');
        expect(rules.pattern.test('cost$')).toBe(true);
        expect(rules.pattern.test('cost')).toBe(false);
    });

    it('keeps the real schema patterns working through the wrapping, lookahead and all', () => {
        // The one pattern in this schema with structure inside it: a subpath key may be anything the
        // character class allows EXCEPT the declared property sitting beside the entries.
        const subpaths = specOf('/api_config/hooks/defaults/*');
        expect(subpaths.keyPattern.test('invoke')).toBe(true);
        expect(subpaths.keyPattern.test('invoke-with-response-stream')).toBe(true);
        expect(subpaths.keyPattern.test('pseudonymization')).toBe(false);
        expect(subpaths.keyPattern.test('has space')).toBe(false);
        for (const template of Object.keys(MAP_CASES)) {
            const spec = specOf(template);
            expect(spec.keyPattern.test(MAP_CASES[template].key)).toBe(true);
        }
    });
});

/**
 * The defect this replaces: `observability.pseudonymization.thresholds` accepts 27 named masking
 * categories and nothing else, and its schema says so as a 511 character alternation. The add
 * dialog quoted that rule ("Allowed keys match: ^(profile-address|...") into a 30rem dialog, where
 * it was cut off mid-alternative; the owner read the truncation `profile-addres`, typed it, and was
 * refused by a rule that was working exactly as written. A rule that enumerates its keys is offered
 * as the list it is, and never quoted as a regex.
 */
describe('a key rule that enumerates its keys', () => {
    const thresholds = (): MapSpec => specOf('/api_config/observability/pseudonymization/thresholds');
    const entities = (): MapSpec => specOf('/api_config/observability/pseudonymization/entities');

    /** The alternatives the schema's own pattern spells, derived without `enumeratedKeys`. */
    const alternativesOf = (source: string): string[] => source.slice(2, -2).split('|');

    it('reads the masking categories out of the schema\'s own alternation, in the schema\'s order', () => {
        const source = thresholds().keyPatternSource;
        const choices = enumeratedKeys(source);
        expect(choices).toHaveLength(27);
        expect(choices![0]).toBe('profile-address');
        expect(choices![26]).toBe('profile-username-password');
        // The pattern's order, not sorted and not re-derived from a list typed out here: a copy of
        // the categories in this file could only ever agree with itself.
        expect(choices).toEqual(alternativesOf(source));
    });

    it('accepts a capturing and a non-capturing alternation alike', () => {
        expect(enumeratedKeys('^(a|b|c)$')).toEqual(['a', 'b', 'c']);
        expect(enumeratedKeys('^(?:a|b)$')).toEqual(['a', 'b']);
        // A hyphen is an ordinary character outside a class - every masking category carries one.
        expect(enumeratedKeys('^(profile-org|profile-location)$')).toEqual(['profile-org', 'profile-location']);
    });

    it('enumerates nothing for a rule that describes a SHAPE rather than a list', () => {
        expect(enumeratedKeys('^[a-z]+$')).toBeUndefined();
        // A repetition of a choice also matches `abba`, which is not one of the alternatives - so
        // the alternatives are not the keys, and offering them as such would be a lie.
        expect(enumeratedKeys('^(a|b)+$')).toBeUndefined();
        // The one pattern in this schema with structure inside it: hooks.defaults' subpath keys.
        expect(enumeratedKeys('^(?!pseudonymization$)[a-zA-Z0-9_/-]+$')).toBeUndefined();
        // Unanchored, so it matches a key that merely CONTAINS an alternative.
        expect(enumeratedKeys('a|b')).toBeUndefined();
        // Anchored at one end of each alternative only - see mapKeyRules's own `^foo|bar$` case.
        expect(enumeratedKeys('^a|b$')).toBeUndefined();
        // Structure inside one alternative is structure a list of literals cannot state.
        expect(enumeratedKeys('^(a.c|b)$')).toBeUndefined();
        expect(enumeratedKeys('^(a|)$')).toBeUndefined();
        // Two groups are not one alternation.
        expect(enumeratedKeys('^(a)(b)$')).toBeUndefined();
        // One literal is a rule, not a choice.
        expect(enumeratedKeys('^(a)$')).toBeUndefined();
    });

    // Derived from every map the schema declares rather than asserted for one: a map that starts
    // enumerating its keys later gets the ComboBox without anyone remembering to ask for it, and a
    // map that stops turns this red rather than silently offering a list that is no longer the rule.
    it('is exactly the six masking maps, across every map the schema declares', () => {
        expect(Object.keys(MAP_CASES).filter(template => specOf(template).keyChoices).sort()).toEqual([
            '/api_config/hooks/defaults/*/pseudonymization/entities',
            '/api_config/hooks/defaults/*/pseudonymization/thresholds',
            '/api_config/models/overrides/*/pseudonymization/entities',
            '/api_config/models/overrides/*/pseudonymization/thresholds',
            '/api_config/observability/pseudonymization/entities',
            '/api_config/observability/pseudonymization/thresholds'
        ]);
        // The maps whose keys are free text or a shape keep the Input and the quoted pattern.
        expect(providers().keyChoices).toBeUndefined();
        expect(overrides().keyChoices).toBeUndefined();
        expect(specOf('/api_config/hooks/defaults/*').keyChoices).toBeUndefined();
        expect(specOf('/api_config/platform/logging/components').keyChoices).toBeUndefined();
    });

    it('offers only the keys the map does not already carry, in the pattern\'s order', () => {
        const spec = thresholds();
        const all = spec.keyChoices!;
        expect(remainingKeyChoices(spec, [])).toEqual(all);
        expect(remainingKeyChoices(spec, ['profile-person', 'profile-address']))
            .toEqual(all.filter(choice => choice !== 'profile-person' && choice !== 'profile-address'));
        // The order is the pattern's throughout: removing the first choice promotes the second,
        // rather than re-sorting what is left.
        const remaining = remainingKeyChoices(spec, ['profile-address']);
        expect(remaining).toHaveLength(26);
        expect(remaining[0]).toBe('profile-bank-account');
        // A key the document carries that is not a choice at all subtracts nothing - the map's
        // entries and its choices are the same set here, but nothing in this function assumes it.
        expect(remainingKeyChoices(spec, ['not-a-category'])).toEqual(all);
        // A map that enumerates nothing has nothing to leave over.
        expect(remainingKeyChoices(providers(), [])).toEqual([]);
    });

    it('offers no key its own validation would then refuse, and the truncation is not one of them', () => {
        const spec = thresholds();
        for (const choice of spec.keyChoices!) {
            expect(mapKeyProblem(choice, [], spec, text)).toBe('');
        }
        // The key the owner actually typed. The rule was right; the way it was shown was not.
        expect(mapKeyProblem('profile-addres', [], spec, text)).toBe('formMapKeyPattern');
        // Empty and duplicate handling is untouched by the choice list.
        expect(mapKeyProblem('', [], spec, text)).toBe('formMapKeyRequiredGeneric');
        expect(mapKeyProblem('profile-person', ['profile-person'], spec, text))
            .toBe('formMapKeyDuplicateGeneric');
    });

    // A scalar map's [+] writes a value as well as a key, and the dialog hint quotes it - so what
    // the seed IS has to be something the operator can be told in one number.
    it('seeds a new threshold at the value schema\'s own default, and a new category toggle at true', () => {
        expect(thresholds().valueKind).toBe('scalar');
        // The value schema declares "default": 0.5, which outranks its "minimum": 0 - masking a new
        // category only above half-confidence, not always. See scalarSeed's own ordering.
        expect(thresholds().scalarDefault).toBe(0.5);
        expect(newMapValue(thresholds())).toBe(0.5);
        expect(thresholds().addHintText).toBe('formMapAddHintScalar');
        // A category is added to switch it ON.
        expect(entities().scalarDefault).toBe(true);
        // A schema `default` still wins over the minimum - see scalarSeed's own ordering.
        expect(specOf('/api_config/platform/logging/components').scalarDefault).toBe('INFO');
    });
});

/**
 * A non-restrictive suggestion list an OPEN map may carry - the counterpart to `keyChoices`, and
 * deliberately not the same thing. `keyChoices` RESTRICTS the key to a fixed set (the masking-
 * category maps); `keySuggestions` only SEEDS the add dialog's ComboBox, and any key matching the
 * schema's shape is still accepted. The two are mutually exclusive by construction.
 */
describe('a map that suggests keys without restricting them', () => {
    const components = (): MapSpec => specOf('/api_config/platform/logging/components');

    it('carries the components map\'s suggestions in the schema\'s order, and no keyChoices', () => {
        const spec = components();
        expect(spec.keySuggestions).toEqual([
            'AnthropicService',
            'AwsBedrockService',
            'ConfigService',
            'ModelService',
            'openaiController',
            'OpenRouterController',
            'OpenRouterService',
            'RateLimitManager',
            'SAPAIService',
            'UsageTrackingService'
        ]);
        // It SUGGESTS, it does not restrict: the map has no closed enumeration, so the schema's
        // shape is still the whole of the key rule - a custom component the operator types is
        // accepted, and the casing is kept verbatim (a case-sensitive match on the wire).
        expect(spec.keyChoices).toBeUndefined();
        expect(mapKeyProblem('MyCustomService', [], spec, text)).toBe('');
        expect(mapKeyProblem('openaiController', [], spec, text)).toBe('');
    });

    it('never coexists with keyChoices: a masking-category map has choices and no suggestions', () => {
        const entities = specOf('/api_config/observability/pseudonymization/entities');
        expect(entities.keyChoices).toHaveLength(27);
        expect(entities.keySuggestions).toBeUndefined();
    });

    it('is the ONLY map carrying suggestions, and a plain free-key map carries neither field', () => {
        // Derived from every map the schema declares rather than asserted for one: a map that starts
        // carrying `x-keySuggestions` later shows up here without anyone updating this list.
        expect(Object.keys(MAP_CASES).filter(template => specOf(template).keySuggestions).sort())
            .toEqual(['/api_config/platform/logging/components']);
        // A param_renames map and the hooks.defaults endpoint map are open free-key maps: no closed
        // choices, and no suggestions the form could know.
        const renames = specOf('/api_config/providers/anthropic/param_renames');
        expect(renames.keyChoices).toBeUndefined();
        expect(renames.keySuggestions).toBeUndefined();
        const endpoints = specOf('/api_config/hooks/defaults');
        expect(endpoints.keyChoices).toBeUndefined();
        expect(endpoints.keySuggestions).toBeUndefined();
    });
});

/**
 * A map of more than three entries renders its panels CLOSED, so each header has to say what is
 * inside it. This is that line: the entry's own JSON, in its own key order, shortened.
 */
describe('the one-line summary on a collapsed map entry', () => {
    it('says what a scalar entry is, in one word or the value itself', () => {
        expect(mapEntrySummary(true)).toBe('on');
        expect(mapEntrySummary(false)).toBe('off');
        expect(mapEntrySummary(0.65)).toBe('0.65');
        expect(mapEntrySummary('max_tokens')).toBe('max_tokens');
        // An entry the document does not carry has nothing to say - it renders as a notice.
        expect(mapEntrySummary(undefined)).toBe('');
        expect(mapEntrySummary(null)).toBe('');
    });

    it('counts a list, and says nothing at all about an empty one', () => {
        expect(mapEntrySummary([1, 2, 3])).toBe('3');
        expect(mapEntrySummary([])).toBe('');
        expect(mapEntrySummary({})).toBe('');
    });

    it('reads an object entry in the DOCUMENT\'s key order, saying each key in as few words as it can', () => {
        const summary = mapEntrySummary({
            streaming: true,
            caching: false,
            version: 'bedrock-2023-05-31',
            retries: 3,
            empty_list: [],
            subpaths: ['invoke', 'converse']
        });
        expect(summary).toBe('streaming on, caching off, version bedrock-2023-05-31, retr…');
        expect(summary.length).toBeLessThanOrEqual(60);
    });

    it('counts a nested MAP\'s keys and NAMES a block of declared settings', () => {
        const value = { hooks: { invoke: [], converse: [] }, pseudonymization: { enabled: true } };
        const schema = {
            type: 'object',
            properties: {
                hooks: { type: 'object', patternProperties: { '^[a-z]+$': { type: 'array' } } },
                pseudonymization: { type: 'object', properties: { enabled: { type: 'boolean' } } }
            }
        } as any;
        expect(mapEntrySummary(value, schema)).toBe('2 hooks, pseudonymization');
        // With no schema to ask, both are counted - the answer that says more, and never a wrong
        // claim about which keys a node declares.
        expect(mapEntrySummary(value)).toBe('2 hooks, 1 pseudonymization');
    });

    it('never puts anything credential-shaped on screen', () => {
        expect(mapEntrySummary({ api_key: 'abc123', enabled: true })).toBe('enabled on');
        expect(mapEntrySummary({ api_key_env: 'SIEM_DATADOG_API_KEY' })).toBe('');
        expect(mapEntrySummary({ token_env: 'X', secret: 'y', password: 'z', privateKey: 'k' })).toBe('');
        // ...and a value that announces itself as one, whatever its key is called.
        expect(mapEntrySummary({ note: 'sk-ant-api03-notarealkey' })).toBe('');
        expect(mapEntrySummary({ note: 'A'.repeat(40) })).toBe('');
        expect(mapEntrySummary('sk-ant-api03-notarealkey')).toBe('');
        // An ordinary sentence-shaped value is not a secret and stays.
        expect(mapEntrySummary({ note: 'two words' })).toBe('note two words');
    });

    it('truncates to one line, cutting at the limit and never mid-separator', () => {
        const summary = mapEntrySummary({ a: 'a word '.repeat(20) });
        expect(summary.length).toBeLessThanOrEqual(60);
        // It filled the line before it cut it - a limit that trims to nothing is not a limit.
        expect(summary.length).toBeGreaterThan(50);
        expect(summary.endsWith('…')).toBe(true);
        expect(summary.charAt(summary.length - 2)).not.toBe(' ');
        expect(summary.charAt(summary.length - 2)).not.toBe(',');
    });

    // The summary reaches the panel through the ENTRY DESCRIPTOR, built where the entry's data and
    // its resolved schema are both in hand - the control layer has neither.
    it('rides on the entry descriptor the tab shell builds, for the shipped model overrides', () => {
        const document = fixture();
        const spec = mapSpecOf(MODEL_OVERRIDES_POINTER, markerOf(MODEL_OVERRIDES_POINTER));
        const section = groupSections(apiConfigSchema, 'models').filter(one => one.key === 'overrides')[0];
        const entries = mapSectionEntries({
            spec,
            containerSchema: section.schema,
            containerData: readPointer(document, MODEL_OVERRIDES_POINTER) as Record<string, unknown>
        });
        const haiku = entries.filter(entry => entry.key.indexOf('claude-3-haiku') !== -1)[0];
        const descriptor = mapEntryDescriptor(haiku, apiConfigSchema as any, pluginFor) as any;

        expect(descriptor.summary).toBe(mapEntrySummary(haiku.data, haiku.schema));
        expect(descriptor.summary).toContain('streamingSupported on');
        expect(descriptor.summary.length).toBeLessThanOrEqual(60);
        // An entry with nothing to say carries no key at all, so its header stays a plain title.
        const bare = mapEntryDescriptor(
            { key: 'empty', pointer: mapEntryPointer(MODEL_OVERRIDES_POINTER, 'empty'), schema: haiku.schema, data: {}, removable: true },
            apiConfigSchema as any,
            pluginFor
        );
        expect(Object.prototype.hasOwnProperty.call(bare, 'summary')).toBe(false);
    });
});

/**
 * The add dialog is now submitted two ways - the Add button and Enter in the key field - and both
 * run the SAME handler behind one guard, so an Enter the browser also delivers to the default
 * button cannot add the entry twice. The guard is in `ConfigFormMaps.openAdd`, which imports
 * `sap/*` and cannot be loaded here; what this file can hold to account is the check that handler
 * runs, and that its verdict does not depend on how many times it is asked.
 *
 * The UI wiring itself - Enter submitting, Escape still cancelling, no double entry - is container
 * verification's, and is named in this task's report as such.
 */
describe('the add dialog\'s submit path, reached by the Add button and by Enter alike', () => {
    it('gives the same verdict however often it is asked', () => {
        const spec = providers();
        expect(mapKeyProblem('example-provider', [], spec, text)).toBe('');
        expect(mapKeyProblem('example-provider', [], spec, text)).toBe('');
    });

    it('refuses the second submit of a key the first one created - the guard is not the only thing holding it', () => {
        const spec = providers();
        expect(mapKeyProblem('example-provider', ['example-provider'], spec, text))
            .toBe(interpolate(text('formProviderKeyDuplicate'), 'example-provider'));
    });

    it('leaves a refused key correctable rather than final - the dialog stays open on a problem', () => {
        const spec = specOf('/api_config/observability/pseudonymization/thresholds');
        // The truncation the owner typed, refused; then the real key, accepted - the same field,
        // the same handler, without the dialog having closed in between.
        expect(mapKeyProblem('profile-addres', [], spec, text)).toBe('formMapKeyPattern');
        expect(mapKeyProblem('profile-address', [], spec, text)).toBe('');
    });
});

describe('interpolate', () => {
    it('substitutes every occurrence, not only the first', () => {
        expect(interpolate('{0} and {0}', 'x')).toBe('x and x');
    });

    it('leaves a value with regex metacharacters alone', () => {
        expect(interpolate('key "{0}"', 'a.b-c$')).toBe('key "a.b-c$"');
    });
});
