/**
 * What the shipped `api_config.json` holds and a stored configuration lacks, and how picked
 * entries are added to that configuration.
 *
 * An installation keeps its stored configurations across upgrades, so settings that ship later
 * (a new provider key, one more allowed beta flag, the hooks of a new route) never reach them. The
 * comparison offers exactly those additions and nothing else:
 *
 *  - a key the shipped file has and the configuration lacks is offered whole, at the highest
 *    point that is missing;
 *  - an entry a list lacks is offered alone;
 *  - a value that merely differs is the installation's own setting and is never offered. The
 *    same holds for a list entry whose identity exists (a model substitution's `from`, a hook's
 *    plugin id, a `name`, an `id` or a model mapping's `provider`), whatever else that entry holds.
 *
 * It lives here rather than in a controller because this repo's jest cannot resolve `sap/*`,
 * and a rule written inside a module that imports it cannot be unit-tested.
 *
 * The standalone CLI tells its user the same thing at the first start after an update. It cannot
 * import cockpit code, so `npm-dist/sail-proxy/src/utils/shippedDefaults.ts` is a copy of this
 * file; the CLI's `defaults-notice.test.js` fails when the two differ.
 */

export interface ShippedEntry {
    /** Unique within one comparison: the pointer, plus the list entry's identity. */
    id: string;
    /** 'key': `pointer` is the missing key. 'listEntry': `pointer` is the list the entry goes into. */
    kind: 'key' | 'listEntry';
    pointer: string;
    /** The shipped value: the whole subtree of a missing key, or the one list entry. */
    value: unknown;
    /** The section under `api_config` the entry belongs to (`providers`, `hooks`, ...). */
    group: string;
    /**
     * For a list entry, the identities of the shipped list's entries before and after it, nearest
     * first: where it goes is decided against the list as it is when the entry is added.
     */
    before?: string[];
    after?: string[];
}

const PREVIEW_LENGTH = 120;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Key order does not make two values different. */
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (isPlainObject(value)) {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'undefined';
}

/** What makes a list entry "the same entry" in two lists. */
function identityOf(entry: unknown): string {
    if (isPlainObject(entry)) {
        if (typeof entry.from === 'string') return `from:${entry.from}`;
        const request = entry.request;
        const callback = isPlainObject(request) ? request.callback : undefined;
        if (isPlainObject(callback) && typeof callback.id === 'string') return `hook:${callback.id}`;
        if (typeof entry.name === 'string') return `name:${entry.name}`;
        if (typeof entry.id === 'string') return `id:${entry.id}`;
        // A model mapping (`providers.openrouter.model_mappings`) is found by its provider, in any case.
        if (typeof entry.provider === 'string') return `provider:${entry.provider.toLowerCase()}`;
    }
    return `value:${canonical(entry)}`;
}

const escapeSegment = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1');
const unescapeSegment = (segment: string): string => segment.replace(/~1/g, '/').replace(/~0/g, '~');
const segmentsOf = (pointer: string): string[] => pointer.split('/').slice(1).map(unescapeSegment);

function collect(active: unknown, shipped: unknown, pointer: string, entries: ShippedEntry[]): void {
    const group = segmentsOf(pointer)[1] ?? '';
    if (Array.isArray(shipped)) {
        if (!Array.isArray(active)) return;
        const present = new Set(active.map(identityOf));
        const identities = shipped.map(identityOf);
        shipped.forEach((value, index) => {
            const identity = identities[index];
            if (present.has(identity)) return;
            entries.push({
                id: `${pointer}#${identity}`, kind: 'listEntry', pointer, value, group,
                before: identities.slice(0, index).reverse(),
                after: identities.slice(index + 1)
            });
        });
        return;
    }
    if (!isPlainObject(shipped) || !isPlainObject(active)) return;
    for (const key of Object.keys(shipped)) {
        const child = `${pointer}/${escapeSegment(key)}`;
        if (!Object.prototype.hasOwnProperty.call(active, key)) {
            entries.push({
                id: child, kind: 'key', pointer: child, value: shipped[key],
                group: segmentsOf(child)[1] ?? ''
            });
        } else {
            collect(active[key], shipped[key], child, entries);
        }
    }
}

/** The additions the shipped configuration offers this one, in the shipped file's order. */
export function missingShippedEntries(active: unknown, shipped: unknown): ShippedEntry[] {
    const entries: ShippedEntry[] = [];
    collect(active, shipped, '', entries);
    return entries;
}

function nodeAt(document: unknown, segments: string[]): unknown {
    return segments.reduce<unknown>((node, segment) => (isPlainObject(node) ? node[segment] : undefined), document);
}

/**
 * A copy of the configuration with the picked entries added. A list entry goes where the shipped
 * order puts it - after the nearest shipped entry before it that the list holds, else in front of
 * the nearest one after it, else to the end - because the order of a hook list is the order its
 * plugins run in.
 */
export function applyShippedEntries(active: unknown, entries: ShippedEntry[]): any {
    const merged = JSON.parse(JSON.stringify(active));
    for (const entry of entries) {
        const segments = segmentsOf(entry.pointer);
        if (entry.kind === 'key') {
            const parent = nodeAt(merged, segments.slice(0, -1));
            if (isPlainObject(parent)) parent[segments[segments.length - 1]] = JSON.parse(JSON.stringify(entry.value));
            continue;
        }
        const list = nodeAt(merged, segments);
        if (!Array.isArray(list)) continue;
        const identities = list.map(identityOf);
        const value = JSON.parse(JSON.stringify(entry.value));
        const previous = (entry.before ?? []).map((identity) => identities.indexOf(identity)).find((index) => index >= 0);
        const next = (entry.after ?? []).map((identity) => identities.indexOf(identity)).find((index) => index >= 0);
        if (previous !== undefined) list.splice(previous + 1, 0, value);
        else if (next !== undefined) list.splice(next, 0, value);
        else list.push(value);
    }
    return merged;
}

/** Which configuration a comparison started from the list's toolbar is about. */
export type ComparisonTarget =
    | { kind: 'active' }
    | { kind: 'configuration'; id: string }
    | { kind: 'severalTicked' };

/**
 * The toolbar's actions act on the ticked rows (`selectionState.ts`), and so does this one: the
 * one ticked configuration is compared. With nothing ticked it is the active one - the one an
 * upgrade leaves behind. Several ticks are no comparison: its result is one new configuration.
 */
export function comparisonTarget(tickedIds: string[]): ComparisonTarget {
    if (tickedIds.length === 0) return { kind: 'active' };
    if (tickedIds.length === 1) return { kind: 'configuration', id: tickedIds[0] };
    return { kind: 'severalTicked' };
}

/** The entry's place as a reader sees it: the keys below `api_config`, separated. */
export function displayPathOf(entry: ShippedEntry): string {
    return segmentsOf(entry.pointer).slice(1).join(' / ');
}

/** One line for a list of entries: the compact JSON, cut when it is long. */
export function previewOf(value: unknown): string {
    const text = JSON.stringify(value) ?? '';
    return text.length <= PREVIEW_LENGTH ? text : `${text.slice(0, PREVIEW_LENGTH - 1)}…`;
}
