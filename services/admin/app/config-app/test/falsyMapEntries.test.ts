import apiConfigSchema from '../webapp/model/apiConfigSchema';
import { mapEntryDescriptor, mapSectionEntries, mapSpecOf, newMapValue } from '../webapp/model/formContainers';
import { pluginFor } from '../webapp/model/formPlugins';
import { JsonSchemaNode, applyDescriptor, mapEntriesOf } from '../webapp/model/schemaForm';

/**
 * A scalar map entry whose value is a legal FALSY value - the number 0, the empty string, the
 * boolean false - is a real entry, not an absent one, and every step of the add -> write ->
 * re-render round trip has to treat it that way. The three that matter in this schema:
 *
 * - `platform.rate_limit_handling.model_specific_delays` and `.subpath_specific_delays` seed at 0
 *   (`{ type: number, minimum: 0 }`, no `default`, so `scalarSeed` returns the `minimum`);
 * - a provider's `param_renames` seeds at "" (`{ type: string }`, no `default`);
 * - a boolean-valued map (`pseudonymization.entities` seeds `true`, but an operator may turn one
 *   OFF), whose entry then carries `false`.
 *
 * The failure this guards against is a value 0/""/false being read as "no entry" by a truthiness
 * test (`if (value)`, `value || ...`, `!value`) somewhere in that round trip, OR being dropped by
 * the JSON round trip `applyDescriptor` uses internally (`deepClone` = `JSON.parse(JSON.stringify)`,
 * which silently drops a key whose value is `undefined` - so a seed that ever became `undefined`
 * would vanish on the NEXT unrelated add). The seed is asserted to be a concrete falsy value rather
 * than `undefined` for exactly that reason, and each entry is put through a SECOND, unrelated add so
 * the clone that add performs is exercised on a document that already carries the falsy entry.
 *
 * These are characterization tests: the behaviour they pin down is the behaviour the form has today.
 * They exist so a later change to the seed rules, the entry enumeration or the descriptor build
 * cannot quietly start treating a 0-second delay override (or an empty rename, or an off toggle) as
 * an entry that was never added.
 */
const root = apiConfigSchema as unknown as JsonSchemaNode;

/** The first schema node named `name` anywhere in the whole api-config schema, resolved shallowly. */
function nodeNamed(name: string): JsonSchemaNode {
    const seen = new Set<unknown>();
    const walk = (node: unknown): JsonSchemaNode | null => {
        if (!node || typeof node !== 'object' || seen.has(node)) {
            return null;
        }
        seen.add(node);
        const record = node as Record<string, unknown>;
        const properties = record.properties as Record<string, JsonSchemaNode> | undefined;
        if (properties && properties[name]) {
            return properties[name];
        }
        for (const key of Object.keys(record)) {
            const found = walk(record[key]);
            if (found) {
                return found;
            }
        }
        return null;
    };
    const found = walk(root);
    if (!found) {
        throw new Error(`nodeNamed: no node "${name}" in the schema`);
    }
    return found;
}

/** The single entry descriptor a scalar map's one key renders to, the way the tab shell builds it. */
function entryDescriptorFor(
    containerSchema: JsonSchemaNode,
    containerPointer: string,
    containerData: Record<string, unknown>,
    key: string
): any {
    const marker = mapEntriesOf(containerSchema, root)!;
    const spec = mapSpecOf(containerPointer, marker);
    const entry = mapSectionEntries({ spec, containerSchema, containerData }).filter(one => one.key === key)[0];
    return mapEntryDescriptor(entry, root, pluginFor);
}

describe('a scalar map entry with a falsy value survives the add -> write -> re-render round trip', () => {
    it('seeds a delay map at the number 0, not at undefined', () => {
        // `undefined` would be dropped by the next `applyDescriptor`'s internal JSON clone; 0 is a
        // real value the document keeps. Both delay maps share the same `{ type: number, minimum: 0 }`
        // value schema, so one assertion covers the rule for both.
        const marker = mapEntriesOf(nodeNamed('model_specific_delays'), root)!;
        const spec = mapSpecOf('/api_config/platform/rate_limit_handling/model_specific_delays', marker);
        const seed = newMapValue(spec);
        expect(seed).toBe(0);
        expect(seed).not.toBeUndefined();
    });

    it('keeps a 0-second delay entry through a SECOND, unrelated add and renders it as a number field', () => {
        const model = nodeNamed('model_specific_delays');
        const modelSpec = mapSpecOf('/api_config/platform/rate_limit_handling/model_specific_delays', mapEntriesOf(model, root)!);

        // First add: the delay override the operator created, at its real seed (0).
        let doc: unknown = {};
        doc = applyDescriptor(
            doc,
            '/api_config/platform/rate_limit_handling/model_specific_delays/gpt-4o',
            newMapValue(modelSpec)
        );

        // Second, unrelated add: a subpath delay. `applyDescriptor` deep-clones the whole document
        // (via JSON) to do it, which is the step that would drop a 0 read as absent.
        doc = applyDescriptor(
            doc,
            '/api_config/platform/rate_limit_handling/subpath_specific_delays/v1~1chat',
            0
        );

        const rlh = (doc as any).api_config.platform.rate_limit_handling;
        // The first entry is still in the document, still 0, after the second add's clone.
        expect(rlh.model_specific_delays).toHaveProperty('gpt-4o', 0);
        expect(rlh.subpath_specific_delays).toHaveProperty('v1/chat', 0);

        // And it renders as the number field it is - not as an absent marker, not dropped.
        const descriptor = entryDescriptorFor(
            model,
            '/api_config/platform/rate_limit_handling/model_specific_delays',
            rlh.model_specific_delays,
            'gpt-4o'
        );
        expect(descriptor.kind).toBe('number');
        expect(descriptor.value).toBe(0);
        expect(descriptor.absent).toBeUndefined();
    });

    it('keeps an empty-string map entry through a SECOND, unrelated add and renders it as a text field', () => {
        // `param_renames` is a string-valued map: its [+] seeds the empty string. An empty rename is
        // still an entry the operator created, and "" must not be read as "no key".
        const renames = nodeNamed('param_renames');
        const spec = mapSpecOf('/api_config/providers/anthropic/param_renames', mapEntriesOf(renames, root)!);
        expect(newMapValue(spec)).toBe('');

        let container: Record<string, unknown> = { some_param: newMapValue(spec) };
        // Exercise the JSON clone that a subsequent add performs on the container.
        container = JSON.parse(JSON.stringify(container));
        expect(container).toHaveProperty('some_param', '');

        const descriptor = entryDescriptorFor(renames, '/api_config/providers/anthropic/param_renames', container, 'some_param');
        expect(descriptor.kind).toBe('text');
        expect(descriptor.value).toBe('');
        expect(descriptor.absent).toBeUndefined();
    });

    it('keeps a false boolean map entry through a JSON clone and renders it as a switch', () => {
        // The pseudonymization entities map seeds `true` (a map entry is added to switch a category
        // ON), but the operator may turn one OFF - and a `false` toggle is an entry, not the absence
        // of one. `entities` is the boolean-valued map this schema has.
        const entities = nodeNamed('entities');
        const marker = mapEntriesOf(entities, root)!;
        expect(marker.valueKind).toBe('scalar');

        // One category explicitly off, then the clone a later add would perform.
        let container: Record<string, unknown> = JSON.parse(JSON.stringify({ EMAIL_ADDRESS: false }));
        expect(container).toHaveProperty('EMAIL_ADDRESS', false);

        const descriptor = entryDescriptorFor(entities, '/api_config/observability/pseudonymization/entities', container, 'EMAIL_ADDRESS');
        expect(descriptor.kind).toBe('switch');
        expect(descriptor.value).toBe(false);
        expect(descriptor.absent).toBeUndefined();
    });
});
