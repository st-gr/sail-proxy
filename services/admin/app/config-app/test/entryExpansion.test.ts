import {
    ancestorEntryPointers,
    initialEntryExpanded,
    mapEntriesCollapsed
} from '../webapp/model/formContainers';

/**
 * The two pure decisions the form's expansion memory rests on, kept apart from the `sap/*` halves
 * that consume them (`descriptorControls.buildSection`, `ConfigForm._render`) so a test can call
 * them directly - the same reason every other rule in `formContainers.ts` lives there.
 *
 * `ancestorEntryPointers` is what an add reveals through: given the pointer of the thing just
 * created and the map container nodes currently on screen, it names the map entries that have to be
 * opened for that thing to be visible. `initialEntryExpanded` is the remembered-else-default rule
 * each entry panel opens by.
 */
describe('ancestorEntryPointers - the map entries on the path to a pointer', () => {
    const OVERRIDES = '/api_config/models/overrides';

    it('names the model override a section was added under, and nothing above it', () => {
        // The symptom's own path: Add section under a model override's hooks. The override entry is
        // the one map entry that has to reopen for the new section to show; the map itself
        // (/models/overrides) is a node, not an entry, and the /hooks group is a plain section.
        const target = `${OVERRIDES}/anthropic--claude/hooks/messages`;
        expect(ancestorEntryPointers(target, [OVERRIDES])).toEqual([
            `${OVERRIDES}/anthropic--claude`
        ]);
    });

    it('excludes the target itself even when the target is a map entry (Add map entry)', () => {
        // Adding a new key to the overrides map: the new entry is the target, revealed and expanded
        // in its own right, so it is not one of its own ancestors. There is no ancestor entry here -
        // the map is a whole tab.
        const target = `${OVERRIDES}/gpt-4o`;
        expect(ancestorEntryPointers(target, [OVERRIDES])).toEqual([]);
    });

    it('walks two nested map entries, outermost first', () => {
        // A map inside a map inside a map: adding a leaf under the innermost entry names both the
        // outer and the inner entry, in path order, and never the map nodes between them.
        const nodes = ['/a/m1', '/a/m1/k1/m2'];
        const target = '/a/m1/k1/m2/k2/leaf';
        expect(ancestorEntryPointers(target, nodes)).toEqual(['/a/m1/k1', '/a/m1/k1/m2/k2']);
    });

    it('names a per-endpoint subpath map entry (a nested map inside hooks.defaults)', () => {
        const nodes = ['/api_config/hooks/defaults', '/api_config/hooks/defaults/anthropic'];
        const target = '/api_config/hooks/defaults/anthropic/v1~1messages';
        // The endpoint entry (anthropic) is the one map entry on the path; the escaped subpath key
        // is the target and is excluded.
        expect(ancestorEntryPointers(target, nodes)).toEqual([
            '/api_config/hooks/defaults/anthropic'
        ]);
    });

    it('returns nothing when no map node is an ancestor of the pointer', () => {
        expect(ancestorEntryPointers('/api_config/platform/timeouts/connect_ms', [OVERRIDES])).toEqual([]);
    });

    it('does not split an escaped slash inside a key into two segments', () => {
        // A provider whose route segment carries a slash would be one entry, not two levels.
        const nodes = ['/api_config/providers'];
        const target = '/api_config/providers/some~1route/param_renames';
        expect(ancestorEntryPointers(target, nodes)).toEqual([
            '/api_config/providers/some~1route'
        ]);
    });
});

describe('initialEntryExpanded - remembered decision else the collapse default', () => {
    it('honours a remembered expansion whichever way it went', () => {
        expect(initialEntryExpanded(true, true)).toBe(true);
        expect(initialEntryExpanded(true, false)).toBe(true);
        expect(initialEntryExpanded(false, true)).toBe(false);
        expect(initialEntryExpanded(false, false)).toBe(false);
    });

    it('falls back to the collapse default for an entry it has never seen', () => {
        // Never seen, a >3 map opens closed; a small one opens open.
        expect(initialEntryExpanded(undefined, mapEntriesCollapsed(20))).toBe(false);
        expect(initialEntryExpanded(undefined, mapEntriesCollapsed(2))).toBe(true);
    });
});
