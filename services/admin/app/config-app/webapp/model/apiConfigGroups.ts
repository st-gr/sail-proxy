/**
 * The pure half of the tab shell: which six groups `api_config` carries, in what order, and which
 * sections each group declares - resolved against the schema's own `$ref`s, since every group is
 * one (`apiConfigSchema.ts`'s own `$defs.<group>Group`).
 *
 * Kept apart from `../controller/ConfigFormTabs.ts`, which turns this into actual
 * `sap.m.IconTabBar`/`IconTabFilter`/`Panel` controls: that file imports UI5 modules this repo's
 * jest config cannot resolve - no file under `test/` imports a `sap/*` module, because nothing in
 * this suite bootstraps the UI5 runtime jest would need to satisfy that import. The logic a test
 * *can* reach - which tabs exist, in what order, which sections each one holds - lives here
 * instead, so it is unit-tested directly rather than only by inspection of the controller that
 * consumes it. This is the same split `schemaForm.ts` (descriptor building) and
 * `descriptorControls.ts` (control building) already draw.
 */
import { JsonSchemaNode, documentOrderedKeys, resolveRef, resolveRefsDeep } from './schemaForm';

/**
 * The six groups `api_config`'s own `additionalProperties: false` allows - the INVENTORY of what
 * may exist, kept alphabetical so it can be pinned against the schema's own key set (see this
 * module's test) without either list having to be re-sorted to compare.
 *
 * Not the tab order: `apiConfigGroupOrder` below decides that, from the curated `TAB_ORDER`.
 * `documentGate.ts` walks the same six in the schema's own declaration order, because that list
 * drives error aggregation rather than anything on screen.
 */
export const API_CONFIG_GROUPS = ['capabilities', 'hooks', 'models', 'observability', 'platform', 'providers'] as const;
export type ApiConfigGroup = (typeof API_CONFIG_GROUPS)[number];

/**
 * The curated left-to-right order of the six tabs: Platform first, then Providers, Hooks, Models,
 * Observability, Capabilities. A deliberate presentation choice (see `apiConfigGroupOrder`) - Platform
 * is where most configuration starts - distinct from the alphabetical `API_CONFIG_GROUPS` inventory
 * and from the schema's own declaration order (which leads with `providers` and buries `platform`
 * fifth, an authoring order rather than a considered one). Every entry is a member of
 * `API_CONFIG_GROUPS`; a group named here that the schema does not declare is skipped, and one the
 * schema declares but this omits trails in schema order rather than vanishing.
 */
const TAB_ORDER: readonly ApiConfigGroup[] = ['platform', 'providers', 'hooks', 'models', 'observability', 'capabilities'] as const;

/**
 * The six groups in the order the TAB STRIP shows them: the curated `TAB_ORDER`, always, whether or
 * not the document carries a given group.
 *
 * Neither order the code reached for before is a considered one: the schema's *declaration* order
 * leads with `providers` and puts `platform` fifth, and the document's order reshuffled the strip as
 * groups were added (the defect `documentOrderedKeys` describes for sections and fields, one level
 * down). So the tab strip alone gets an explicit order here; sections and fields still follow the
 * schema, which their own authors control. `API_CONFIG_GROUPS` above stays the alphabetical
 * *inventory* of what may exist - which is what the schema pin asserts against - and `TAB_ORDER` is
 * the curated *presentation* of it.
 *
 * Every group gets a tab whether the document carries it or not: an absent group's tab is where
 * **Add section** for its sections lives, and a tab strip whose tabs come and go as sections are
 * added is a strip nobody can aim at. So this reorders six tabs, it never drops one - which is also
 * what keeps `/formSelectedTab` working across a rebuild: the key it stores still names a tab. A
 * group the schema declares but `TAB_ORDER` omits (a future one) is not dropped either: it trails in
 * the schema's own order until it is placed here deliberately. `_document` is no longer consulted -
 * the order is fixed - but stays in the signature for its one caller (`ConfigFormTabs`).
 */
export function apiConfigGroupOrder(schema: Record<string, unknown>, _document?: unknown): ApiConfigGroup[] {
    const root = schema as JsonSchemaNode;
    const declared = Object.keys((root.properties?.api_config as JsonSchemaNode | undefined)?.properties ?? {})
        .filter((key): key is ApiConfigGroup => (API_CONFIG_GROUPS as readonly string[]).indexOf(key) !== -1);
    // Curated tabs first, in TAB_ORDER, keeping only those the schema actually declares; then any
    // declared group TAB_ORDER does not name, in the schema's own order, so a new group still surfaces.
    const curated = TAB_ORDER.filter(group => declared.indexOf(group) !== -1);
    const rest = declared.filter(group => TAB_ORDER.indexOf(group) === -1);
    return curated.concat(rest);
}

/**
 * Resolves one group's `$ref` (`apiConfigSchema.properties.api_config.properties.<group>`,
 * pointing at `$defs.<group>Group`) against the whole schema, so its own `properties` - the
 * group's sections - are reachable without a caller re-deriving the pointer.
 */
export function resolveGroupSchema(schema: Record<string, unknown>, group: ApiConfigGroup): JsonSchemaNode {
    const root = schema as JsonSchemaNode;
    const apiConfigProperties = ((root.properties?.api_config as JsonSchemaNode | undefined)?.properties) || {};
    return resolveRef(apiConfigProperties[group] || {}, root);
}

/**
 * A resolved group schema's own declared sections, in the order the form shows them: the schema's
 * declaration order, always, whether or not the document carries a given section. One collapsible
 * panel per section, per the design.
 *
 * Was alphabetical, then briefly document-order-first; a fixed schema order is what keeps the tab's
 * panels from reshuffling as the document is filled in - see `documentOrderedKeys` (`./schemaForm`)
 * for why. The same function orders the fields WITHIN a section, so the two halves cannot drift.
 *
 * `groupData` is the group's own subtree of the document (`document.api_config.<group>`), no longer
 * consulted for order but kept in the signature; the schema's declaration order stands whether or
 * not it is passed.
 *
 * Only `properties` counts. A group may also accept keys its schema does not name, through a
 * schema-valued `additionalProperties` (`providers` keeps one so a new provider needs no schema
 * change), and those are not sections: nothing declares them, so nothing can title a panel for one
 * that the document does not already carry. `providers` therefore lists the six provider keys the
 * gateway itself reads, which the schema names for exactly this reason; the dynamic keys *within* a
 * section (`models.overrides`' per-model entries) are `buildDescriptors`'s to surface, not this
 * function's concern.
 */
export function groupSectionKeys(groupSchema: JsonSchemaNode, groupData?: unknown): string[] {
    return documentOrderedKeys(Object.keys(groupSchema.properties ?? {}), groupData);
}

/** One section of a group, resolved and pointered - see `groupSections`. */
export interface ResolvedSection {
    /** The section's own key within the group, e.g. `siem` within `observability`. */
    key: string;
    /** `/api_config/<group>/<key>` - where `buildDescriptors` is rooted for this section. */
    pointer: string;
    /**
     * The section's own schema, with every `$ref` inside it expanded against the whole schema, so
     * it is self-contained.
     *
     * Expanded, not merely resolved at the top: `buildDescriptors` treats the schema it is handed
     * as the root for its own `$ref` lookups, so a ref living *inside* a section - `providers.openai`
     * and `providers.openrouter` compose `$defs/providerCommon` through an `allOf` - cannot be
     * resolved from the section subtree and left the whole provider rendering as one `raw` JSON
     * blob. Doing it here rather than in `ConfigFormTabs.buildTab` is the point: the controller
     * cannot be unit-tested (see this module's header), so the guarantee lives in the function the
     * tests can call and the controller keeps calling it unchanged.
     *
     * A section containing no `$ref` at all - every one but those two - is handed back as the very
     * object the schema module holds, not a copy; see `resolveRefsDeep`.
     */
    schema: JsonSchemaNode;
}

/**
 * Every section of one group, resolved and pointered - exactly what `ConfigFormTabs.buildTab`
 * needs to call `buildDescriptors` once per section, and now the only place that pointer template
 * and that `resolveRef` call are written: `buildTab` calls this rather than re-deriving either,
 * so a test calling this function is testing the same computation the controller runs, not a
 * second copy of it that could drift silently out of step. (An earlier version of this task's own
 * test suite made exactly that mistake - re-implementing `/api_config/<group>/<key>` and
 * `resolveRef` inline in the test file rather than calling a shared function - which is why this
 * function exists apart from `buildTab` at all.)
 *
 * `groupData` decides only the ORDER, never which sections there are - see `groupSectionKeys`. A
 * caller that has no document in hand (a test asking what the schema declares) omits it and gets
 * the schema's own order.
 */
export function groupSections(
    schema: Record<string, unknown>,
    group: ApiConfigGroup,
    groupData?: unknown
): ResolvedSection[] {
    const root = schema as JsonSchemaNode;
    const groupSchema = resolveGroupSchema(schema, group);
    return groupSectionKeys(groupSchema, groupData).map(key => ({
        key,
        pointer: `/api_config/${group}/${key}`,
        schema: resolveRefsDeep((groupSchema.properties ?? {})[key], root)
    }));
}
