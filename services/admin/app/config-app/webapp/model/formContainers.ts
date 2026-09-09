/**
 * Every rule the form applies to a CONTAINER - a dynamically-keyed map, an appendable array, a
 * section the document does not carry - kept apart from the UI5 halves that draw them
 * (`./descriptorControls.ts`, `../controller/ConfigFormMaps.ts`, `../controller/ConfigFormTabs.ts`)
 * for the same reason `schemaForm.ts` is kept apart from `descriptorControls.ts`: those files import
 * `sap/*`, which this repo's jest config cannot resolve, so nothing inside them can be unit-tested.
 * Everything a test can actually decide - whether a key is allowed, what a new entry or element or
 * section holds, whether an entry survives the filter, and which affordances a given editability
 * offers - lives here instead.
 *
 * This replaces `configMaps.ts`, which named TWO maps by hand and gave every other map nothing. The
 * difference is where the answers come from: a `MapEntries` marker, derived from the schema by
 * `schemaForm.mapEntriesOf` and carried on the descriptor, is now the input to every rule below. The
 * only thing still keyed by pointer is the pair of key rules Spec 2 wrote for `providers` and
 * `models.overrides` - two maps whose schema constrains keys not at all, and whose keys mean
 * something on the wire (a route segment, a model id as SAP AI Core spells it). Those two remain a
 * deliberate exception, named and explained; a map that HAS a `propertyNames`/`patternProperties`
 * rule takes it from the schema, and a map that has neither takes the one honest general rule (a key
 * that is not empty and carries no whitespace).
 *
 * Texts are i18n *keys*, not resolved text: this module is imported by tests that have no resource
 * bundle, and the resolution belongs to whoever has one.
 */
import {
    ArrayItems,
    Descriptor,
    JsonSchemaNode,
    MapEntries,
    PluginResolver,
    buildDescriptors,
    labelFor,
    mapEntriesOf
} from './schemaForm';

/** The per-provider map: `/api_config/providers/<route segment>`. */
export const PROVIDERS_POINTER = '/api_config/providers';

/** The per-model override map: `/api_config/models/overrides/<model id>`. */
export const MODEL_OVERRIDES_POINTER = '/api_config/models/overrides';

/**
 * How many entries a NESTED map needs before its filter field is drawn.
 *
 * The design's own number, and it applies to a map that sits inside a section - a `param_renames`, a
 * `components`, an `entities`. A search box over three parameter renames is an affordance for a
 * problem nobody has; over two dozen entity toggles it is how one is found.
 *
 * A TOP-LEVEL map section is never subject to it (`isTopLevelContainer`): Providers, Model Overrides,
 * Hook Definitions and Hook Defaults are whole tabs or whole sections, their filter is what Spec 2
 * promised and shipped for the first two, and it staying put whatever the entry count is what keeps
 * the row above them stable rather than appearing and vanishing as entries are added.
 *
 * The filter is never gated on editability either - it hides panels on screen and changes nothing in
 * the document - so these two are the whole of its rule.
 */
export const MAP_FILTER_MIN_ENTRIES = 8;

/**
 * How many entries a map may have before its entry panels open CLOSED.
 *
 * Three or fewer and every panel opens, which is what a map with two providers or one override has
 * always done and what makes a short map readable at a glance. Four and up, the panels are a LIST
 * first - the header line of each is what is scanned, and the one being looked for is opened - so
 * they open closed with a one-line summary (`mapEntrySummary`) beside each title, and the toolbar
 * grows Expand all / Collapse all and the jump list that go with a list.
 *
 * This is the same number the design uses for "a handful", and deliberately not `MAP_FILTER_MIN_ENTRIES`:
 * a filter earns its place much later than a collapse does. Twenty-odd model overrides, each a
 * screenful of fields, is what this exists for.
 */
export const MAP_COLLAPSE_MAX_EXPANDED = 3;

/** Whether a map with `entryCount` entries opens its entry panels closed - see the constant above. */
export function mapEntriesCollapsed(entryCount: number): boolean {
    return entryCount > MAP_COLLAPSE_MAX_EXPANDED;
}

/** The longest a map entry's header summary may be, ellipsis included - see `mapEntrySummary`. */
export const MAP_SUMMARY_MAX_LENGTH = 60;

/**
 * One map entry, said in one line, for the header of its collapsed panel.
 *
 * The point of a collapsed list is that the closed panels still say something. What they say is the
 * entry's own JSON, read in its own key order and shortened: `streamingSupported on, 4
 * subpaths_native, ...`. The DOCUMENT's keys, not the schema's - a key the entry does not carry is
 * not summarised as absent, it is simply not mentioned, which is what makes the line about this
 * entry rather than about the schema. Same ruling as the section and field order, one line up.
 *
 * The vocabulary is the document's own key names plus exactly two words, `on` and `off`, so the line
 * is not a sentence anyone has to translate and cannot drift from what the JSON editor shows. A
 * boolean is `<key> on`/`<key> off`, a list or a nested MAP is `<n> <key>` (how many, which is the
 * only thing worth a line here), a named block of settings is its key alone, and a scalar is
 * `<key> <value>`.
 *
 * Two things are never in it. An empty list, map or object says nothing, so it is left out rather
 * than reported as `0 x`. And anything that looks like a credential - by its key or by its value -
 * is dropped whole: this line is rendered collapsed, on screen, for every entry at once, which is
 * the last place a token should be able to surface. `_env` keys hold a variable NAME rather than a
 * secret, but they are dropped too: telling one from the other by pattern is exactly the judgement
 * that goes wrong once.
 *
 * `valueSchema` decides one question and no other: whether a nested object is a MAP (its keys are
 * entries, so they are worth counting) or a block of named settings (its keys are fields, so the
 * block's own name is what to say). Unknown - a schema composed through `allOf` that this caller
 * has not flattened - counts, which is the answer that says more.
 */
export function mapEntrySummary(value: unknown, valueSchema?: JsonSchemaNode): string {
    return truncateSummary(summaryOf(value, valueSchema));
}

/**
 * Whether a pointer names a top-level container: the document, a whole tab, or one section of one.
 *
 * The same measure `schemaForm.namesAContainer` uses, and deliberately the same one - a pointer of at
 * most three segments under `api_config`. `/api_config/providers` is a tab, `/api_config/hooks/defaults`
 * is a section, `/api_config/platform/logging/components` (four) is a map inside a section.
 */
export function isTopLevelContainer(pointer: string): boolean {
    const segments = pointer.split('/').filter(segment => segment.length > 0);
    return segments.length > 0 && segments.length <= 3 && segments[0] === 'api_config';
}

/** The i18n key of every string one map's affordances show. */
export interface MapTexts {
    /** Placeholder of the filter field above the entry panels. */
    filterPlaceholderText: string;
    /** Tooltip of the [+] on the container. */
    addText: string;
    /** Tooltip of the [-] on one entry. */
    removeText: string;
    /** Title of the add dialog. */
    addTitleText: string;
    /** Label of the add dialog's key field. */
    keyLabelText: string;
    /** Placeholder of the add dialog's key field. */
    keyPlaceholderText: string;
    /** The paragraph under the add dialog's key field. */
    addHintText: string;
    /** Toast shown once the entry is in the in-memory document. Interpolates `{0}` = the key. */
    addedText: string;
    /** Why an empty key is not a key. */
    keyRequiredText: string;
    /** Why a key that does not match `keyPattern` is refused. Interpolates `{0}` = the pattern. */
    keyPatternText: string;
    /** Why a key already in the map is refused. Interpolates `{0}` = the clashing key. */
    keyDuplicateText: string;
    /** Title of the remove confirmation. */
    removeTitleText: string;
    /** Body of the remove confirmation. Interpolates `{0}` = the key. */
    removeMessageText: string;
    /** Toast shown once the entry is out of the in-memory document. Interpolates `{0}` = the key. */
    removedText: string;
}

/**
 * What the form is asked to create, and where.
 *
 * The marker travels with the request rather than being looked up from the pointer: the control that
 * drew the affordance had the descriptor in hand, and asking the host to re-derive from a pointer
 * alone is what the pointer-keyed dispatch this task removes was made of.
 */
export interface AddRequest {
    /** The container to create, add an entry to, or append an element to. */
    pointer: string;
    kind: 'map' | 'array' | 'section';
    /** The map's own marker, for `kind: 'map'` (and for an absent map container). */
    mapEntries?: MapEntries;
    /** The array's own marker, for `kind: 'array'` (and for an absent array container). */
    arrayItems?: ArrayItems;
}

/** What the form is asked to remove: one map entry, or one array element - both by their own pointer. */
export interface RemoveRequest {
    pointer: string;
    kind: 'map' | 'array';
    /** The marker of the map this entry belongs to, for its wording. Absent for an array element. */
    mapEntries?: MapEntries;
}

/** One map, as the dialog, the toolbar and the entry panels need it. */
export interface MapSpec extends MapTexts {
    /** JSON pointer of the map container - the object whose own keys are the entries. */
    pointer: string;
    /** The marker every answer below was derived from, carried so a request can hand it back. */
    marker: MapEntries;
    /**
     * What a NEW key must look like. Anchored on both ends. It may be stricter than the schema - the
     * two named maps below are - but never looser, which is what keeps a key the dialog accepts from
     * being one the backend rejects.
     */
    keyPattern: RegExp;
    /**
     * What the SCHEMA's own key rule is, when it declares one - `patternProperties`' single regex or
     * `propertyNames.pattern`, anchored. Undefined where the schema constrains keys not at all.
     *
     * Separate from `keyPattern` because the two answer different questions. `keyPattern` decides
     * what may be created; this decides whether an existing key is an ENTRY of the map or a property
     * the schema declares beside it - `hooks.defaults.<endpoint>` is a map of subpaths whose pattern
     * is `^(?!pseudonymization$)...`, and `pseudonymization` is a declared object that must not get
     * an entry's [-]. Where the schema says nothing, every key the document carries is an entry.
     */
    entryPattern?: RegExp;
    /** The key rule as it was written - see `MapKeyRules.source`. What a message or a hint quotes. */
    keyPatternSource: string;
    /**
     * Every key this map accepts, in the key rule's own order, when the rule ENUMERATES them - see
     * `enumeratedKeys`. Undefined for a rule that describes a shape rather than a list.
     *
     * What the add dialog offers as a choice instead of asking for free text. The two maps this is
     * set for (`observability.pseudonymization.entities` and `.thresholds`, and their per-endpoint
     * and per-model copies) accept 27 named categories and nothing else, and their rule is a 511
     * character alternation: shown as a regex it is unreadable, and shown TRUNCATED - which is what
     * a 30rem dialog does to it - it is worse than unreadable, because the prefix of an alternative
     * reads like an alternative. An operator typed the truncation and was refused by a rule that
     * was working exactly as written. A list of the keys is the same rule, said in the one form
     * that cannot be misread.
     */
    keyChoices?: string[];
    /**
     * A non-restrictive list of keys the add dialog SUGGESTS for an open map, in the schema's own
     * order - see `MapEntries.keySuggestions`, its source. Where `keyChoices` restricts the key to
     * one of a fixed set, this only seeds the field: the operator picks a suggestion or types a key
     * of their own, and `keyPattern` (the schema's shape) is still the whole of what is enforced.
     *
     * Consulted only when `keyChoices` is ABSENT: a map whose keys are an enumeration has its closed
     * list already, so the two never coexist by construction. Set only for a map whose node declares
     * `x-keySuggestions` (today, `platform.logging.components`).
     */
    keySuggestions?: string[];
    /** What one entry IS - see `MapEntries.valueKind`. */
    valueKind: MapEntries['valueKind'];
    /** The value a new key of a scalar-valued map starts at. */
    scalarDefault?: unknown;
    /** The value a new key of an object-valued map starts at. */
    valueSkeleton?: unknown;
}

/**
 * The key rule for one map: the pattern a new key must match, the message that says so, and the
 * placeholder of the field it is typed into.
 *
 * Three sources, in the order they are consulted:
 *
 * 1. The two maps Spec 2 wrote rules for by hand. Neither schema constrains its keys (both accept
 *    any key and validate only the value), and both keys mean something outside this document: a
 *    provider key is the route segment the gateway matches on the wire, a model override key is the
 *    internal id SAP AI Core spells on its model list. The form is stricter than the schema there on
 *    purpose, and that judgement is not derivable from the schema - it is the one thing left in this
 *    module that is keyed by pointer.
 * 2. The schema's own rule, when it declares one (`platform.logging.components`, both delay maps,
 *    `hooks.definitions`, every `entities` map, the per-endpoint subpath maps).
 * 3. Neither: a key that is not empty and carries no whitespace. `hooks.defaults`' endpoint keys and
 *    every `param_renames` map land here. A whitespace-free key is the weakest rule that still
 *    refuses what is almost certainly a typo, and it is deliberately not tightened by guessing: a
 *    parameter name and an endpoint identifier have no shape this form knows.
 */
export interface MapKeyRules {
    pattern: RegExp;
    /**
     * The rule as it was WRITTEN, for showing to a human - the schema's own `patternProperties`
     * source, or the form's own. `pattern` above is that source compiled into a whole-key matcher
     * (`anchored`), which wraps it in a non-capturing group and is therefore no longer the text the
     * schema author typed; a message or a hint that quoted it would be quoting the form's plumbing.
     */
    source: string;
    /** i18n key of the message shown when a key does not match. Interpolates `{0}` = `source`. */
    message: string;
    /** i18n key of the key field's placeholder. */
    placeholder: string;
    /** The keys `pattern` enumerates, in its own order - see `enumeratedKeys`. */
    choices?: string[];
}

/**
 * The literal keys a key rule ENUMERATES, in the rule's own order, or undefined when the rule
 * describes a shape rather than a list.
 *
 * A rule is an enumeration when it is exactly an anchored alternation of literals - `^(a|b|c)$`, or
 * the same with a non-capturing group - and every alternative is plain text carrying no regex
 * metacharacter of its own. Nothing looser: the moment an alternative can match more than itself,
 * the list of alternatives is no longer the list of keys, and offering it as one would be a lie the
 * form's own validation would then contradict. So `^[a-z]+$` (a shape), `^(a|b)+$` (a repetition of
 * a choice, which matches `abba`) and `^(?!pseudonymization$)[a-zA-Z0-9_/-]+$` (a shape with an
 * exclusion) all enumerate nothing, and are shown as the pattern they are.
 *
 * The order is the pattern's, not sorted: the schema lists the 27 masking categories in the order
 * an operator reading the schema or the JSON sees them, and re-sorting here would make the form's
 * list a third order to reconcile.
 */
export function enumeratedKeys(source: string): string[] | undefined {
    if (source.charAt(0) !== '^') {
        return undefined;
    }
    let body = source.slice(1);
    if (!endsWithAnchor(body)) {
        return undefined;
    }
    body = body.slice(0, -1);
    // The whole of the rule must be ONE group. `(a|b)+`, `(a)(b)` and `(?!x)y` all fail here or at
    // the metacharacter check below, which is the point: only a bare alternation enumerates.
    if (body.charAt(0) !== '(' || body.charAt(body.length - 1) !== ')') {
        return undefined;
    }
    body = body.slice(1, -1);
    if (body.slice(0, 2) === '?:') {
        body = body.slice(2);
    }
    const alternatives = body.split('|');
    if (alternatives.length < 2) {
        return undefined;
    }
    if (alternatives.some(alternative => alternative.length === 0 || REGEX_METACHARACTER.test(alternative))) {
        return undefined;
    }
    return alternatives;
}

/**
 * The keys of an enumerated map that are still free, in the pattern's order - what the add dialog
 * offers, and nothing else.
 *
 * A key the map already carries is not a key that can be added: `mapKeyProblem` refuses it as a
 * duplicate, so offering it would be offering the one choice guaranteed to fail. `existing` is
 * re-read when the dialog opens rather than closed over, for the same reason the duplicate check is.
 *
 * The empty list for a map that is not enumerated at all - a caller asks this only after seeing
 * `keyChoices`, and an unenumerated map has no choices to leave over.
 */
export function remainingKeyChoices(spec: MapSpec, existing: string[]): string[] {
    return (spec.keyChoices ?? []).filter(choice => existing.indexOf(choice) === -1);
}

export function mapKeyRules(pointer: string, marker: MapEntries): MapKeyRules {
    const named = NAMED_MAPS[pointer];
    if (named) {
        return named.rules;
    }
    if (typeof marker.keyPattern === 'string' && marker.keyPattern.length > 0) {
        const choices = enumeratedKeys(marker.keyPattern);
        return {
            pattern: anchored(marker.keyPattern),
            source: marker.keyPattern,
            message: 'formMapKeyPattern',
            placeholder: 'formMapKeyPlaceholderGeneric',
            ...(choices ? { choices } : {})
        };
    }
    return {
        pattern: /^\S+$/,
        source: '\\S+',
        message: 'formMapKeyPatternGeneric',
        placeholder: 'formMapKeyPlaceholderGeneric'
    };
}

/**
 * Everything the map affordances need for the container at `pointer`, from its marker and its
 * pointer alone - the replacement for `configMaps.mapSpecFor`, which answered `undefined` for every
 * map but two and is why seventeen of them had no [+] at all.
 */
export function mapSpecOf(pointer: string, marker: MapEntries): MapSpec {
    const rules = mapKeyRules(pointer, marker);
    const named = NAMED_MAPS[pointer];
    const spec: MapSpec = {
        pointer,
        marker,
        keyPattern: rules.pattern,
        keyPatternSource: rules.source,
        valueKind: marker.valueKind,
        ...(named ? named.texts : GENERIC_MAP_TEXTS),
        keyPatternText: rules.message,
        keyPlaceholderText: rules.placeholder
    };
    if (typeof marker.keyPattern === 'string' && marker.keyPattern.length > 0) {
        spec.entryPattern = anchored(marker.keyPattern);
    }
    if (rules.choices) {
        spec.keyChoices = rules.choices;
    }
    // A non-restrictive suggestion list, from the marker rather than the key rule - the two are
    // separate concepts (see `MapSpec.keySuggestions`). Carried only when the map has no closed
    // enumeration to offer already; the two are mutually exclusive by construction (a `keyChoices`
    // map's keys are an alternation, and no such node carries `x-keySuggestions`), but the guard
    // keeps that a fact of the data rather than an assumption this code would silently break on.
    if (marker.keySuggestions?.length && !spec.keyChoices) {
        spec.keySuggestions = marker.keySuggestions;
    }
    if (marker.valueKind === 'scalar') {
        spec.scalarDefault = marker.scalarDefault;
        // A scalar map's [+] writes a value as well as a key, and the hint is the one place that can
        // be said before the entry appears.
        spec.addHintText = named ? spec.addHintText : 'formMapAddHintScalar';
    }
    if (marker.valueKind === 'object') {
        spec.valueSkeleton = marker.valueSkeleton;
    }
    return spec;
}

/**
 * Whether a key the document carries is an ENTRY of this map - and therefore removable - rather than
 * a property the schema declares beside its entries. See `MapSpec.entryPattern`.
 */
export function isMapEntryKey(key: string, spec: MapSpec): boolean {
    return spec.entryPattern ? spec.entryPattern.test(key) : true;
}

/**
 * Whether one entry of a map may carry a [-].
 *
 * Two conditions, and both are needed. It has to be an entry rather than a property declared beside
 * the entries (above), and the document has to actually carry it: a declared key the document does
 * not have - `providers.openrouter` on a configuration that never mentions openrouter - renders as
 * a panel saying so, and removing what is not there would write the same document back.
 *
 * Asked by both halves, from what each of them holds: `mapSectionEntries` knows whether the
 * container has the key, `descriptorControls.buildMapContent` knows the same thing as the entry
 * descriptor's `absent` marker.
 */
export function isRemovableEntry(key: string, present: boolean, spec: MapSpec): boolean {
    return present && isMapEntryKey(key, spec);
}

/**
 * Why an entry may not be created under this key, or "" when it may.
 *
 * Three rules, in the order the user hits them: a key is required, it must look like what it is, and
 * it must not already be in this map. The duplicate check is a case-sensitive exact match, because
 * that is how the document's own keys are compared: a map with both `openai` and `OpenAI` in it is a
 * map with two entries, and silently merging the second into the first would discard whatever the
 * user typed into the one already on screen.
 */
export function mapKeyProblem(
    key: string,
    existing: string[],
    spec: MapSpec,
    text: (key: string) => string
): string {
    const trimmed = key.trim();
    if (trimmed.length === 0) {
        return text(spec.keyRequiredText);
    }
    if (!spec.keyPattern.test(trimmed)) {
        // The generic message names the rule, because there is nothing else to tell the user what
        // this map's keys look like; the two named messages spell their rule in words and carry no
        // `{0}`, so this interpolation is a no-op for them.
        return interpolate(text(spec.keyPatternText), spec.keyPatternSource);
    }
    if (existing.indexOf(trimmed) !== -1) {
        return interpolate(text(spec.keyDuplicateText), trimmed);
    }
    return '';
}

/**
 * What a newly added map entry holds: the smallest value its own schema describes.
 *
 * An object entry is `MapEntries.valueSkeleton` - `{}` wherever the entry schema requires nothing
 * (`providers`, `models.overrides`, `hooks.defaults`' endpoints), the required leaves alone where it
 * does (`hooks.definitions`). An array entry is the empty list, and the entry's own `[+]` then
 * appends elements to it. A scalar entry is the schema's own default.
 *
 * Nothing optional is invented: a key the operator never set must not appear in the saved document.
 */
export function newMapValue(spec: MapSpec): unknown {
    if (spec.valueKind === 'array') {
        return [];
    }
    if (spec.valueKind === 'scalar') {
        return spec.scalarDefault;
    }
    return clone(spec.valueSkeleton ?? {});
}

/**
 * The list a free-text scalar array becomes when the operator types `typed` into it, or null when
 * that text may not become a token.
 *
 * The pure half of the `sap.m.MultiInput` validator (`descriptorControls.ts`'s `list` branch). A
 * MultiInput with NO validator never turns typed text into a token at all - it looks like a field
 * that takes values and silently drops every one of them - which is what made a hook's `match` list
 * impossible to fill in, and therefore a hook created by the [+] impossible to complete in the form.
 *
 * Two refusals, and no others. Empty or whitespace is not a value: the arrays this renders are typed
 * `{ items: { type: 'string', minLength: 1 } }`, so an empty token would be a token the backend
 * rejects on save. A duplicate is not a new value either, and `match` in particular is a set of rule
 * ids where repeating one changes nothing; several of these arrays also declare `uniqueItems`, so
 * this keeps the control from producing a document the gate refuses. Everything else is accepted
 * verbatim, trimmed only at the ends - a rule id, an org suffix and a gazetteer entry are free text
 * this form has no business narrowing.
 */
export function nextTokens(existing: string[], typed: string): string[] | null {
    const trimmed = typed.trim();
    if (trimmed.length === 0) {
        return null;
    }
    if (existing.indexOf(trimmed) !== -1) {
        return null;
    }
    return existing.concat([trimmed]);
}

/** A new element of an appendable array: the item schema's own skeleton, never shared. */
export function newArrayElement(arrayItems: ArrayItems): unknown {
    return clone(arrayItems.skeleton);
}

/** The array `elements` with `element` appended. Never mutates its input. */
export function withArrayElement(elements: unknown[], element: unknown): unknown[] {
    return elements.concat([element]);
}

/**
 * What **Add section** writes at an absent container's own pointer: the empty container, and nothing
 * inside it.
 *
 * `[]` for a section that is an array, `{}` for everything else. Not the section's fields at their
 * schema defaults: those are the consumers' business, and writing them would save a configuration
 * the operator never chose. The panel re-renders as a present-but-empty section, and every field in
 * it is then edited - and written - one at a time, exactly as in a section the document already had.
 */
export function sectionSeed(container: { arrayItems?: ArrayItems }): unknown {
    return container.arrayItems ? [] : {};
}

/**
 * Whether an entry key survives the filter box. Case-insensitive substring on the key itself - the
 * identifier, not its humanized panel title - so typing `claude` finds every Claude override and
 * typing nothing finds everything.
 */
export function matchesMapFilter(key: string, filter: string): boolean {
    const needle = filter.trim().toLowerCase();
    if (needle.length === 0) {
        return true;
    }
    return key.toLowerCase().indexOf(needle) !== -1;
}

/** Which of a container's affordances may be drawn - see `containerAffordances`. */
export interface ContainerAffordances {
    /** Draw the [+] on the container, or **Add section** on an absent one. */
    add: boolean;
    /** Draw the [-] on each entry or element. */
    remove: boolean;
    /** Draw the filter field above the entries. */
    filter: boolean;
    /** Draw Expand all / Collapse all - only worth it where the entries open closed. */
    expand: boolean;
    /** Draw the jump list - same condition: a list long enough to have to be navigated. */
    jump: boolean;
}

/**
 * Which affordances a container offers, given the form's own editability matrix.
 *
 * Add and remove are edits like any other, so they follow `editable` - admin AND inactive - and are
 * drawn for nobody else. Unlike Spec 2's rule, add no longer needs the container to be PRESENT:
 * creating it is what **Add section** now does, on the same pointer, through the same single
 * mutation path. That was the whole of the old restriction's justification, and it is gone.
 *
 * The filter is not gated on editability. It changes nothing in the document - it hides panels on
 * screen - and a two-dozen-entry override list is exactly as hard to read for someone who may not
 * edit it as for someone who may. Only a map has entries to filter at all; a top-level map section
 * always has one, and a map nested inside a section has one once it holds enough entries to be worth
 * filtering (`MAP_FILTER_MIN_ENTRIES`).
 */
export function containerAffordances(options: {
    editable: boolean;
    kind: 'map' | 'array' | 'section';
    /** The container's own pointer - only the filter reads it, to tell a section from a nested map. */
    pointer: string;
    entryCount: number;
    hasAddHandler: boolean;
    hasRemoveHandler: boolean;
}): ContainerAffordances {
    const collapsed = options.kind === 'map' && mapEntriesCollapsed(options.entryCount);
    return {
        add: options.editable && options.hasAddHandler,
        remove: options.editable && options.hasRemoveHandler,
        filter: options.kind === 'map'
            && (isTopLevelContainer(options.pointer) || options.entryCount > MAP_FILTER_MIN_ENTRIES),
        // Both appear exactly when the entries start collapsed, and for the same reason the filter
        // is not gated on editability: neither touches the document. Expand all on a map whose
        // panels are all open already, and a jump list of three, are affordances for no problem.
        expand: collapsed,
        jump: collapsed
    };
}

/**
 * The keys a map container carries that no declared section already shows, in document order.
 *
 * Only `providers` has both: its schema names the six providers the gateway itself reads as real
 * `properties` (so each renders as its own titled panel with its own descriptions) and accepts any
 * other key through `additionalProperties`. Before this, such a key rendered nowhere at all - the
 * tab shell enumerates a group's declared sections - so an UNDECLARED provider in the document was
 * invisible in the form while sitting in the JSON editor. It is also what a newly added provider is,
 * one second after the [+] dialog closes, which is why the two cases are one function.
 */
export function undeclaredMapKeys(entries: Record<string, unknown> | undefined, declared: string[]): string[] {
    if (!entries) {
        return [];
    }
    return Object.keys(entries).filter(key => declared.indexOf(key) === -1);
}

/**
 * The schema one entry of this map is built and validated against: the single `patternProperties`
 * value schema when the node declares one (draft-07 consults it before `additionalProperties`, and
 * no node in this schema declares two patterns over one map), else the schema-valued
 * `additionalProperties`.
 *
 * `container` must be self-contained - `resolveRefsDeep`'d, as `groupSections` hands sections out -
 * because nothing here resolves a `$ref`. An empty schema (which accepts anything) comes back for a
 * node that is not a map at all; `mapEntriesOf` is what decides that question, and this is only ever
 * asked of a node it has already answered yes for.
 */
export function mapValueSchemaOf(container: JsonSchemaNode): JsonSchemaNode {
    const patternProperties = (container.patternProperties ?? {}) as Record<string, JsonSchemaNode>;
    const patterns = Object.keys(patternProperties);
    if (patterns.length > 0) {
        return patternProperties[patterns[0]];
    }
    const additional = container.additionalProperties;
    return additional !== null && typeof additional === 'object' && !Array.isArray(additional)
        ? (additional as JsonSchemaNode)
        : {};
}

/** One entry of a map section, as the panel that shows it needs it. */
export interface MapSectionEntry {
    /** The entry's own key in the document - what the filter matches on and what the [-] names. */
    key: string;
    /** `<container>/<escaped key>` - where this entry's controls are built. */
    pointer: string;
    /** The schema this entry's controls are built from. */
    schema: JsonSchemaNode;
    /** The entry's own data, or undefined for a declared key the document does not carry. */
    data: unknown;
    /** Whether the [-] may be offered - see below. */
    removable: boolean;
}

/**
 * Every entry a map section shows, in the order it shows them: the schema's own declared keys first,
 * in their declared order, then whatever else the document carries.
 *
 * Only `providers` has both kinds. Its schema names the six providers the gateway itself reads as
 * real `properties` - so each renders as its own titled panel with its own descriptions, built from
 * its own schema rather than from the generic entry schema - and accepts any other key through
 * `additionalProperties`.
 *
 * A declared key the document does NOT carry still gets its panel (saying it is not present, with
 * **Add section** on it) but no [-]: there is nothing to remove, and offering it would write the
 * same document back. Everything the document carries is removable.
 *
 * Shared with the tests rather than written twice: `ConfigFormTabs` turns this into panels and
 * decides nothing itself, so a test calling this is testing the enumeration the controller runs.
 */
export function mapSectionEntries(options: {
    spec: MapSpec;
    /** The map node itself, self-contained - see `mapValueSchemaOf`. */
    containerSchema: JsonSchemaNode;
    /** The map container in the document, or undefined when the document does not carry it. */
    containerData: Record<string, unknown> | undefined;
    /**
     * The sections the schema declares under this container, resolved. Supplied by the tab shell for
     * the `providers` GROUP, whose declared keys are whole sections with their own composed schemas;
     * omitted everywhere else, where the node's own `properties` are read directly.
     */
    declared?: Array<{ key: string; pointer: string; schema: JsonSchemaNode }>;
}): MapSectionEntry[] {
    const spec = options.spec;
    const data = options.containerData ?? {};
    const valueSchema = mapValueSchemaOf(options.containerSchema);
    const declared = options.declared ?? Object.keys(options.containerSchema.properties ?? {}).map(key => ({
        key,
        pointer: mapEntryPointer(spec.pointer, key),
        schema: (options.containerSchema.properties ?? {})[key]
    }));

    const entry = (key: string, pointer: string, schema: JsonSchemaNode): MapSectionEntry => ({
        key,
        pointer,
        schema,
        data: data[key],
        removable: isRemovableEntry(key, Object.prototype.hasOwnProperty.call(data, key), spec)
    });

    return declared
        .map(section => entry(section.key, section.pointer, section.schema))
        .concat(undeclaredMapKeys(options.containerData, declared.map(section => section.key))
            .map(key => entry(key, mapEntryPointer(spec.pointer, key), valueSchema)));
}

/**
 * One map entry as one descriptor: its own fields as children, its own map marker when the entry is
 * itself a map (`hooks.defaults`' endpoints are), and its schema's description as the panel tooltip.
 *
 * `buildDescriptors` returns ONE descriptor at the entry's own pointer whenever the entry is not an
 * object it can break into children - the absent marker for an entry the document does not carry, or
 * a single field for an entry that is one scalar. Both are passed straight through: wrapping either
 * in a section would add a panel that says nothing, and would rob a scalar entry of the labelled row
 * its [-] belongs beside. Every other entry is an object, whose children come back as a list.
 *
 * Here rather than in `ConfigFormTabs`, which is the only production caller, because it is the one
 * step of the map path a test cannot otherwise reach: that file imports `sap/*`. The test helper
 * that mirrors the tab shell's traversal calls this same function, so the descriptor a test reasons
 * about is the descriptor the form renders, not a second construction of one.
 */
export function mapEntryDescriptor(
    entry: MapSectionEntry,
    rootSchema: JsonSchemaNode,
    resolvePlugin: PluginResolver
): Descriptor {
    const descriptors = buildDescriptors(entry.schema as object, entry.data, entry.pointer, resolvePlugin);
    if (descriptors.length === 1 && descriptors[0].pointer === entry.pointer) {
        return descriptors[0];
    }
    const marker = mapEntriesOf(entry.schema, rootSchema);
    const description = entry.schema.description;
    // The one-line summary its panel header shows while it is collapsed. Built here rather than in
    // the control layer because this is where the entry's own DATA and its own resolved schema are
    // both in hand - a descriptor carries neither, and re-deriving them from a pointer is what this
    // module exists to avoid. Left off entirely when the entry has nothing to say, so the header
    // renders as a plain title rather than a title and an empty status.
    const summary = mapEntrySummary(entry.data, entry.schema);
    return {
        kind: 'section',
        pointer: entry.pointer,
        label: labelFor(entry.key),
        ...(marker ? { mapEntries: marker } : {}),
        ...(typeof description === 'string' && description.length > 0 ? { description } : {}),
        ...(summary.length > 0 ? { summary } : {}),
        children: descriptors
    };
}

/** Where one entry of the map at `containerPointer` lives, RFC 6901-escaped. */
export function mapEntryPointer(containerPointer: string, key: string): string {
    return `${containerPointer}/${escapeSegment(key)}`;
}

/** The container a pointer's last segment sits in - `/a/b/c` -> `/a/b`. */
export function containerPointerOf(pointer: string): string {
    return pointer.slice(0, pointer.lastIndexOf('/'));
}

/** The last segment of a pointer, unescaped - a map entry's own key, or an array index. */
export function lastSegmentOf(pointer: string): string {
    return unescapeSegment(pointer.slice(pointer.lastIndexOf('/') + 1));
}

/**
 * The map-entry container pointers on the path down to `pointer`, outermost first.
 *
 * A map entry lives at `<mapNode>/<key>`, so a prefix of `pointer` is an ancestor map ENTRY exactly
 * when its own parent is one of the map container nodes the form has on screen (`mapNodePointers` -
 * the pointers of the maps themselves, e.g. `/api_config/models/overrides`). For a section added
 * under a model override - `/api_config/models/overrides/<model>/hooks/<subpath>` - that is the
 * override entry `/api_config/models/overrides/<model>`; a path through nested maps (a per-endpoint
 * subpath map inside `hooks.defaults`, a provider's `param_renames`) yields every entry on it.
 *
 * The target itself is never included: it is the newly created container the reveal scrolls to and
 * expands in its own right, not one of the ancestors that have to be opened to make it visible. The
 * RFC 6901 escaping of a key (`/` -> `~1`) keeps a key with a slash in it from splitting into two
 * segments here, so the path is walked in real segments.
 */
export function ancestorEntryPointers(pointer: string, mapNodePointers: string[]): string[] {
    const nodes = new Set(mapNodePointers);
    const segments = pointer.split('/');
    const result: string[] = [];
    for (let depth = 2; depth <= segments.length; depth++) {
        const prefix = segments.slice(0, depth).join('/');
        if (prefix === pointer) {
            continue;
        }
        if (nodes.has(segments.slice(0, depth - 1).join('/'))) {
            result.push(prefix);
        }
    }
    return result;
}

/**
 * Whether a map entry's panel opens expanded, given what the form remembers about it and what the
 * map's own collapse rule would do with an entry it has never seen.
 *
 * A remembered decision wins whichever way it went - an entry the operator expanded stays expanded
 * across a rebuild, one they collapsed stays collapsed - and an entry the form has no memory of
 * (`remembered === undefined`) follows the default: closed when the map opens its entries closed
 * (`mapEntriesCollapsed`, i.e. more than three), open otherwise.
 */
export function initialEntryExpanded(remembered: boolean | undefined, collapsedByDefault: boolean): boolean {
    return remembered !== undefined ? remembered : !collapsedByDefault;
}

/**
 * Substitutes every `{0}` in an i18n text. `String#replace` with a string needle replaces the first
 * occurrence only, and these messages name the key twice ("... the key \"{0}\" ... edit the existing
 * \"{0}\" entry"), so the split/join form is used rather than a regex whose needle would have to be
 * escaped.
 */
export function interpolate(text: string, value: string): string {
    return text.split('{0}').join(value);
}

// --- internals -------------------------------------------------------------

/** Every generic map text - what a map with no rules of its own shows. */
const GENERIC_MAP_TEXTS: MapTexts = {
    filterPlaceholderText: 'formMapFilterGeneric',
    addText: 'formMapAddGeneric',
    removeText: 'formMapRemoveGeneric',
    addTitleText: 'formMapAddTitleGeneric',
    keyLabelText: 'formMapKeyLabelGeneric',
    keyPlaceholderText: 'formMapKeyPlaceholderGeneric',
    addHintText: 'formMapAddHintGeneric',
    addedText: 'formMapAddedGeneric',
    keyRequiredText: 'formMapKeyRequiredGeneric',
    keyPatternText: 'formMapKeyPatternGeneric',
    keyDuplicateText: 'formMapKeyDuplicateGeneric',
    removeTitleText: 'formMapRemoveTitleGeneric',
    removeMessageText: 'formMapRemoveMessageGeneric',
    removedText: 'formMapRemovedGeneric'
};

/**
 * The two maps whose key rule and wording are the form's own rather than the schema's - Spec 2's,
 * carried over unchanged. See `mapKeyRules` for why these two and no others.
 */
const NAMED_MAPS: Record<string, { rules: MapKeyRules; texts: MapTexts }> = {
    [PROVIDERS_POINTER]: {
        rules: {
            // A route segment: the gateway matches it in a URL path, and the shipped keys
            // (anthropic, aws-bedrock, openai, openrouter, perplexity) are exactly this shape.
            pattern: /^[a-z0-9-]+$/,
            source: '[a-z0-9-]+',
            message: 'formProviderKeyPattern',
            placeholder: 'formProviderKeyPlaceholder'
        },
        texts: {
            filterPlaceholderText: 'formProviderFilter',
            addText: 'formProviderAdd',
            removeText: 'formProviderRemove',
            addTitleText: 'formProviderAddTitle',
            keyLabelText: 'formProviderKey',
            keyPlaceholderText: 'formProviderKeyPlaceholder',
            addHintText: 'formProviderAddHint',
            addedText: 'formProviderAdded',
            keyRequiredText: 'formProviderKeyRequired',
            keyPatternText: 'formProviderKeyPattern',
            keyDuplicateText: 'formProviderKeyDuplicate',
            removeTitleText: 'formProviderRemoveTitle',
            removeMessageText: 'formProviderRemoveMessage',
            removedText: 'formProviderRemoved'
        }
    },
    [MODEL_OVERRIDES_POINTER]: {
        rules: {
            // A model internal id as SAP AI Core spells it: `anthropic--claude-4.6-sonnet--deployed`,
            // `gpt-35-turbo-0125`, `o3-mini`. Dots and underscores are allowed because ids in the
            // shipped configuration carry them; case is kept, because the id is compared verbatim.
            pattern: /^[A-Za-z0-9._-]+$/,
            source: '[A-Za-z0-9._-]+',
            message: 'formOverrideKeyPattern',
            placeholder: 'formOverrideKeyPlaceholder'
        },
        texts: {
            filterPlaceholderText: 'formOverrideFilter',
            addText: 'formOverrideAdd',
            removeText: 'formOverrideRemove',
            addTitleText: 'formOverrideAddTitle',
            keyLabelText: 'formOverrideKey',
            keyPlaceholderText: 'formOverrideKeyPlaceholder',
            addHintText: 'formOverrideAddHint',
            addedText: 'formOverrideAdded',
            keyRequiredText: 'formOverrideKeyRequired',
            keyPatternText: 'formOverrideKeyPattern',
            keyDuplicateText: 'formOverrideKeyDuplicate',
            removeTitleText: 'formOverrideRemoveTitle',
            removeMessageText: 'formOverrideRemoveMessage',
            removedText: 'formOverrideRemoved'
        }
    }
};

/**
 * The schema's `patternProperties` source as a whole-key rule.
 *
 * A JSON Schema pattern is an unanchored search: `"^[a-z]+$"` in this schema happens to spell its own
 * anchors, but draft-07 would accept `"[a-z]+"` and match it anywhere in the key. The form must
 * refuse a key the schema's own matcher would refuse and no more, so the source is always wrapped in
 * a non-capturing group between anchors of this function's own.
 *
 * Wrapped ALWAYS, never trusted for already carrying anchors: `^foo|bar$` starts with `^` and ends
 * with `$` and is nevertheless two alternatives, only one of which is anchored at each end - it
 * matches `xxbar` and `foozz`. Returning that source unchanged (which this did) would have let a key
 * through that the schema's own alternation also lets through, but the form's OWN generalisation of
 * the rule would then be wrong for any pattern where the two differ. The outer anchors are stripped
 * first so the result does not read `^(?:^...$)$`; a `$` that is escaped (`\$`, a literal dollar
 * sign) is not an anchor and is left alone.
 */
function anchored(source: string): RegExp {
    let body = source;
    if (body.charAt(0) === '^') {
        body = body.slice(1);
    }
    if (endsWithAnchor(body)) {
        body = body.slice(0, -1);
    }
    return new RegExp(`^(?:${body})$`);
}

/**
 * A key whose value must never reach a panel header. Matched on the KEY, so a value is dropped for
 * what it configures rather than for what it happens to look like; `_env` names are dropped with
 * the secrets themselves, because a rule that keeps "the name of the variable" and drops "the
 * variable" is a rule that gets it wrong once and puts a token on screen.
 */
const SECRET_KEY = /(secret|token|password|passphrase|credential|api[_-]?key|private[_-]?key|_env$)/i;

/**
 * A value that announces itself as a credential whatever it is called - the vendor prefixes this
 * repository's own scanning rules already know, plus any long unbroken opaque run, which is what a
 * key nobody named `token` still looks like.
 */
const SECRET_VALUE = /^(sk-|gh[pousr]_|github_pat_|AKIA|xox[baprs]-|eyJ)|^[A-Za-z0-9+/_-]{32,}={0,2}$/;

/** See `mapEntrySummary`. The truncation is applied once, to the finished line. */
function summaryOf(value: unknown, schema: JsonSchemaNode | undefined): string {
    if (value === undefined || value === null) {
        return '';
    }
    if (typeof value === 'boolean') {
        return value ? 'on' : 'off';
    }
    if (typeof value === 'number') {
        return String(value);
    }
    if (typeof value === 'string') {
        return SECRET_VALUE.test(value) ? '' : value;
    }
    if (Array.isArray(value)) {
        // A list with no key of its own to name it - the entry IS the list, and its own panel title
        // already says which one. How many is the whole of what is left to say.
        return value.length === 0 ? '' : String(value.length);
    }
    const properties = (schema?.properties ?? {}) as Record<string, JsonSchemaNode>;
    const entries = value as Record<string, unknown>;
    return Object.keys(entries)
        .map(key => summaryPart(key, entries[key], properties[key]))
        .filter(part => part.length > 0)
        .join(', ');
}

/** One `key: value` pair of an object entry, said in as few words as it can be. */
function summaryPart(key: string, value: unknown, schema: JsonSchemaNode | undefined): string {
    if (value === undefined || value === null || SECRET_KEY.test(key)) {
        return '';
    }
    if (typeof value === 'boolean') {
        return `${key} ${value ? 'on' : 'off'}`;
    }
    if (typeof value === 'number') {
        return `${key} ${value}`;
    }
    if (typeof value === 'string') {
        return value.length === 0 || SECRET_VALUE.test(value) ? '' : `${key} ${value}`;
    }
    if (Array.isArray(value)) {
        return value.length === 0 ? '' : `${value.length} ${key}`;
    }
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) {
        return '';
    }
    return describesNamedBlock(schema) ? key : `${keys.length} ${key}`;
}

/**
 * Whether a schema describes a block of NAMED settings rather than a map of entries - the one
 * question `mapEntrySummary` asks a schema. A node that declares `properties` and no dynamic key
 * rule is a block ("pseudonymization" says everything); anything else, an unknown schema included,
 * has countable keys ("2 hooks").
 */
function describesNamedBlock(schema: JsonSchemaNode | undefined): boolean {
    if (!schema || !schema.properties) {
        return false;
    }
    const patterns = Object.keys((schema.patternProperties ?? {}) as Record<string, unknown>);
    const additional = schema.additionalProperties;
    const openToSchema = additional !== null && typeof additional === 'object' && !Array.isArray(additional);
    return patterns.length === 0 && !openToSchema;
}

/** The summary at its length limit, with an ellipsis standing for what did not fit. */
function truncateSummary(summary: string): string {
    if (summary.length <= MAP_SUMMARY_MAX_LENGTH) {
        return summary;
    }
    return `${summary.slice(0, MAP_SUMMARY_MAX_LENGTH - 1).replace(/[\s,]+$/, '')}…`;
}

/**
 * Any character that makes a regex alternative mean more than the text it spells - see
 * `enumeratedKeys`. A `-` is deliberately absent: outside a character class it is an ordinary
 * character, and every one of the 27 masking categories carries one.
 */
const REGEX_METACHARACTER = /[\\^$.|?*+()[\]{}]/;

/** Whether `source` ends in a `$` that is an anchor rather than an escaped literal dollar sign. */
function endsWithAnchor(source: string): boolean {
    if (source.charAt(source.length - 1) !== '$') {
        return false;
    }
    let backslashes = 0;
    for (let index = source.length - 2; index >= 0 && source.charAt(index) === '\\'; index--) {
        backslashes++;
    }
    return backslashes % 2 === 0;
}

function clone(value: unknown): unknown {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function escapeSegment(segment: string): string {
    return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapeSegment(segment: string): string {
    return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}
