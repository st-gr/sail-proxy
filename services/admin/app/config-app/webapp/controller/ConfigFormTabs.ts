import IconTabBar, { IconTabBar$SelectEvent } from "sap/m/IconTabBar";
import IconTabFilter from "sap/m/IconTabFilter";
import Panel from "sap/m/Panel";
import ScrollContainer from "sap/m/ScrollContainer";
import Control from "sap/ui/core/Control";
import CredentialSection from "./ConfigFormCredentials";
import { FORM_SCROLL_FALLBACK_HEIGHT, TAB_SCROLL_ID_PREFIX, formScrollHeight } from "../model/formViewport";
import { ApiConfigGroup, apiConfigGroupOrder, groupSections, resolveGroupSchema, ResolvedSection } from "../model/apiConfigGroups";
import { AddRequest, RemoveRequest, mapEntryDescriptor, mapSectionEntries, mapSpecOf } from "../model/formContainers";
import {
    buildAbsentContent,
    buildDescriptorControls,
    buildMapContent,
    DescriptorControlOptions,
    FieldControl
} from "../model/descriptorControls";
import {
    buildDescriptors,
    Descriptor,
    JsonSchemaNode,
    labelFor,
    MapEntries,
    mapEntriesOf,
    PluginResolver,
    resolveRefsDeep
} from "../model/schemaForm";

/**
 * Everything the tab shell needs from its host to render every group of one configuration
 * document. Deliberately as narrow as `DescriptorControlOptions` plus what building six groups'
 * worth of sections needs beyond a single section: the whole document and the whole schema (a
 * section's own schema is a `$ref` that only resolves against the schema's own `$defs`, per
 * `resolveRef`), and what the credential exit (`buildPlugin`) needs to read a slot's stored state
 * - a configuration id and a role - since a `plugin` descriptor never carries its own value (see
 * `Descriptor`'s own header) and this module does not otherwise know either one.
 */
export interface BuildTabsOptions {
    /** The in-memory configuration document. Sections read `document.api_config.<group>.<section>`. */
    document: Record<string, unknown>;
    /** The whole api-config schema (`apiConfigSchema`), so a group's and a section's `$ref` resolve. */
    schema: Record<string, unknown>;
    /** False renders every JSON-backed control read-only. Credential Set/Clear are not affected. */
    editable: boolean;
    resolvePlugin: PluginResolver;
    /** Called with a changed field's JSON pointer and its new value. */
    onChange: (pointer: string, value: unknown) => void;
    /** Resolves an i18n key. */
    text: (key: string) => string;
    /** The credential exit's other half: builds Set/Clear for a `plugin` descriptor's slot. */
    credentialSection: CredentialSection;
    /** Passed through to `credentialSection.buildControl` unchanged - see `ConfigFormCredentials`. */
    configurationId: string | null;
    isAdmin: boolean;
    /** Restores the tab selected before the last rebuild. Omitted -> the first tab opens. */
    selectedKey?: string;
    /**
     * Creates what the request addresses: one map entry, one array element, or the container of a
     * section the document does not carry. Omitted -> no add affordance anywhere.
     */
    onAddItem?: (request: AddRequest) => void;
    /**
     * Removes what the request addresses: one map entry, or one array element. Omitted -> no remove
     * affordance.
     */
    onRemoveItem?: (request: RemoveRequest) => void;
    /** Offers the control rendering the field at `pointer`, so a save's errors can mark it. */
    onFieldControl?: (pointer: string, control: FieldControl) => void;
    /** What the host remembers about a map entry panel's expansion - see `DescriptorControlOptions`. */
    isEntryExpanded?: (pointer: string) => boolean | undefined;
    /** Called as a map entry panel is expanded or collapsed, so the host's memory stays current. */
    onEntryToggle?: (pointer: string, expanded: boolean) => void;
    /** Offers every container panel this build creates, by its own pointer, for a post-build reveal. */
    onContainerPanel?: (pointer: string, panel: Panel) => void;
    /** Offers the pointer of every map container this build renders - see `DescriptorControlOptions`. */
    onMapContainer?: (pointer: string) => void;
}

/**
 * Builds the six-tab shell: one `IconTabFilter` per group of `api_config`, in the document's own
 * order (`apiConfigGroupOrder`), each holding one collapsible `Panel` per section of that group, in
 * the document's order too (`groupSections`), whose body is
 * `buildDescriptors` rooted at `/api_config/<group>/<section>` - the same function and the same
 * pointer shape every existing section (`siem`, until now the only one rendered) already used, so
 * a section this task's schema cannot yet fully describe degrades to the existing `raw` path
 * rather than to something new. Deepening a thin section is later tasks' work, not this one's.
 *
 * `siem` is one such section, now addressed as `/api_config/observability/siem` - the pointer it
 * has always had, since `siem` has always lived under `observability` in the schema
 * (`apiConfigSchema.$defs.observabilityGroup.properties.siem`). Its descriptors, credential
 * controls and plugin registration are therefore unaffected by this move: nothing about how they
 * are built changed, only where the panel that holds them sits.
 */
export function buildTabs(opts: BuildTabsOptions): IconTabBar {
    const documentGroups = (opts.document?.api_config as Record<string, unknown>) || {};

    const controlOptions: DescriptorControlOptions = {
        editable: opts.editable,
        text: opts.text,
        onChange: opts.onChange,
        buildPlugin: (descriptor: Descriptor) => buildCredentialControl(descriptor, opts),
        onAddItem: opts.onAddItem,
        onRemoveItem: opts.onRemoveItem,
        onFieldControl: opts.onFieldControl,
        isEntryExpanded: opts.isEntryExpanded,
        onEntryToggle: opts.onEntryToggle,
        onContainerPanel: opts.onContainerPanel,
        onMapContainer: opts.onMapContainer
    };

    // The tab ORDER follows the document, exactly as the sections and the fields within them do -
    // see `apiConfigGroupOrder`. All six tabs are always built, so a stored `/formSelectedTab` key
    // still names one of them after a rebuild that moved it.
    const groups = apiConfigGroupOrder(opts.schema, opts.document);

    return new IconTabBar({
        id: "configFormTabBar",
        selectedKey: opts.selectedKey || groups[0],
        items: groups.map(group =>
            buildTab(group, documentGroups[group], opts, controlOptions))
    });
}

/**
 * One group as one `IconTabFilter`: `formTab<Group>` from i18n, id `configFormTab-<group>`, whose
 * panels are wrapped in the tab's own scrolling region (`buildTabScroll`) so the tab strip above
 * them stays on screen. The
 * pointer each section's panel is built at, and that section's own resolved schema, both come
 * from `groupSections` (`../model/apiConfigGroups`) - not re-derived here - so the pure module a
 * test can actually call is the same one this function calls.
 *
 * A group that is itself a dynamically-keyed map takes the map path instead. `providers` is the
 * only one: its schema names six providers as real `properties` *and* accepts any other key
 * through `additionalProperties`, so its panel list is a map's entry list that happens to have
 * six entries the schema can title and describe. Whether a group or a section IS a map is asked of
 * the schema (`mapEntriesOf`), never of a registry of pointers - which is what lets every other map
 * in the document have the same affordances these two have always had.
 */
function buildTab(
    group: ApiConfigGroup,
    groupData: unknown,
    opts: BuildTabsOptions,
    controlOptions: DescriptorControlOptions
): IconTabFilter {
    const groupDataObj = isPlainObject(groupData) ? groupData : {};
    // The document decides the panel ORDER, not which panels there are: the sections this group
    // carries first, in the document's own order, then the ones it does not. See `groupSectionKeys`.
    const sections = groupSections(opts.schema, group, groupData);
    // Expanded, not merely resolved at the top: the group's own `additionalProperties` is a `$ref`
    // (`providers` -> `$defs/providerConfig`), and both `mapEntriesOf` and the entry schemas below
    // need it resolved. `groupSections` does the same for each section it hands out.
    const groupSchema = resolveRefsDeep(resolveGroupSchema(opts.schema, group), rootSchema(opts));
    const groupMarker = mapEntriesOf(groupSchema, rootSchema(opts));

    const content: Control[] = groupMarker
        ? buildMapSectionContent(
            { schema: groupSchema, marker: groupMarker, data: groupData, pointer: `/api_config/${group}`, declared: sections },
            opts,
            controlOptions
        )
        : sections.map(section => buildSectionPanel(section, groupDataObj, opts, controlOptions));

    return new IconTabFilter({
        id: `configFormTab-${group}`,
        key: group,
        text: opts.text(`formTab${capitalize(group)}`),
        content: [buildTabScroll(group, content)]
    });
}

/**
 * The one thing that keeps the tab strip on screen: each tab's section panels scroll INSIDE the
 * tab rather than scrolling the page.
 *
 * The form sits in the detail `DynamicPage`'s HEADER (see `view/ConfigForm.fragment.xml` for why),
 * and a header taller than the page is scrolled away with everything else no matter what
 * `preserveHeaderStateOnScroll` says - so the tab strip, and the Save/Cancel in the page title,
 * used to disappear the moment the operator scrolled to the field they were editing. Bounding the
 * form's own height leaves the page nothing to scroll, and the scrolling moves in here, below the
 * strip. `formViewport` owns the arithmetic and its reasoning.
 *
 * The container is not `focusable`: it adds no tab stop of its own, and every focusable control in
 * a section stays in the natural tab order, with the browser scrolling each into view as focus
 * reaches it. The filter rows and map toolbars are inside, with the sections they belong to, so
 * they scroll with them.
 */
function buildTabScroll(group: ApiConfigGroup, content: Control[]): ScrollContainer {
    const scroll = new ScrollContainer({
        id: `${TAB_SCROLL_ID_PREFIX}${group}`,
        vertical: true,
        horizontal: false,
        // A literal, and brace-free: it is replaced by the measured height on the first rendering,
        // and is what a tab whose DOM cannot be read falls back to.
        height: FORM_SCROLL_FALLBACK_HEIGHT,
        content
    });
    // Measured after rendering, because how much chrome sits above this tab is not knowable before
    // it: the read-only banner and the notice strip come and go. Re-applying the height re-renders,
    // which measures once more - and the second pass reads the same top, computes the same string
    // and stops, since the container's own height does not move its own top edge.
    scroll.addEventDelegate({ onAfterRendering: () => sizeTabScroll(scroll) });
    return scroll;
}

/** Sizes one tab's scrolling region against the viewport it is currently rendered in. */
function sizeTabScroll(scroll: ScrollContainer): void {
    const dom = scroll.getDomRef();
    if (!dom) {
        return;
    }
    const top = dom.getBoundingClientRect().top;
    if (top <= 0) {
        // Nothing laid out to measure - a detached or hidden tab reads 0, and taking that at face
        // value would claim the whole viewport for a region that has the page title, the panel
        // header and the tab strip above it. The fallback height stands until a real rendering.
        return;
    }
    const height = formScrollHeight(top, window.innerHeight);
    if (scroll.getHeight() !== height) {
        scroll.setHeight(height);
    }
}

/** One section of a group as one collapsible `Panel`. */
function buildSectionPanel(
    section: ResolvedSection,
    groupDataObj: Record<string, unknown>,
    opts: BuildTabsOptions,
    controlOptions: DescriptorControlOptions
): Panel {
    const panel = new Panel({
        headerText: labelFor(section.key),
        expandable: true,
        expanded: true,
        content: buildSectionContent(section.schema, groupDataObj[section.key], section.pointer, opts, controlOptions)
    });
    // A top-level section is a reveal target too - Add section on an absent one is built from here -
    // so it is offered by pointer alongside every nested panel `descriptorControls` reports.
    opts.onContainerPanel?.(section.pointer, panel);
    return panel;
}

/**
 * The controls inside one section's Panel.
 *
 * Three shapes, decided from the schema and the data alone:
 *
 * A section that IS a dynamically-keyed map renders as its entries, with the filter row and the [+]
 * above them. That question cannot be answered from a descriptor tree - `buildDescriptors` on an
 * object section returns that section's CHILDREN, never a descriptor for the section itself - so it
 * is asked of the schema directly, with the whole schema as the root the value `$ref`s resolve
 * against (`mapEntriesOf` refuses anything else; see its own header).
 *
 * A section the document does not carry says so, and offers **Add section**. Which sections those
 * are is the renderer's ruling, not this file's: `buildDescriptors` returns one `absent` section
 * descriptor for a section or map container built from no data at all (see `namesAContainer` in
 * `../model/schemaForm`), so the notice is drawn from that marker rather than from "no data and no
 * controls happened to come out". The two differ exactly where it matters - a section whose schema
 * declares fields, e.g. `platform.rate_limit_handling`, used to render every one of them at its
 * schema default and looked configured while being unset.
 *
 * Everything else renders as its descriptors, which is where every nested map and every appendable
 * array gets the same affordances (`descriptorControls.buildSection`).
 */
function buildSectionContent(
    schema: JsonSchemaNode,
    data: unknown,
    pointer: string,
    opts: BuildTabsOptions,
    controlOptions: DescriptorControlOptions
): Control[] {
    const marker = mapEntriesOf(schema, rootSchema(opts));
    if (marker) {
        return buildMapSectionContent({ schema, marker, data, pointer }, opts, controlOptions);
    }
    const descriptors = buildDescriptors(schema as object, data, pointer, opts.resolvePlugin);
    if (descriptors.length === 1 && descriptors[0].kind === "section" && descriptors[0].absent === true) {
        return buildAbsentContent(descriptors[0], controlOptions);
    }
    return buildDescriptorControls(descriptors, controlOptions);
}

/**
 * A section (or a whole tab) that is one map: the filter row and the [+], then one panel per entry -
 * the schema's own declared keys first, in their declared order, then whatever else the document
 * carries.
 *
 * The entries are turned into ONE section descriptor and handed to the same
 * `descriptorControls.buildMapContent` a map nested inside a section goes through, so a map is
 * rendered by one piece of code wherever it sits. What this function adds is the part a descriptor
 * tree cannot carry: the map's own marker, and each entry's own schema - a declared provider is
 * built from its own composed schema (openai adds fields of its own), an undeclared one from the
 * map's generic entry schema.
 */
function buildMapSectionContent(
    container: {
        schema: JsonSchemaNode;
        marker: MapEntries;
        data: unknown;
        pointer: string;
        declared?: ResolvedSection[];
    },
    opts: BuildTabsOptions,
    controlOptions: DescriptorControlOptions
): Control[] {
    const label = labelFor(lastSegment(container.pointer));
    if (!isPlainObject(container.data)) {
        // The container itself is not in the document. Spec 2 stopped here, with a notice and no way
        // forward; **Add section** now writes the empty container at this pointer.
        return buildAbsentContent(
            { kind: "section", pointer: container.pointer, label, absent: true, mapEntries: container.marker, children: [] },
            controlOptions
        );
    }

    const spec = mapSpecOf(container.pointer, container.marker);
    const children = mapSectionEntries({
        spec,
        containerSchema: container.schema,
        containerData: container.data as Record<string, unknown>,
        declared: container.declared
    }).map(entry => mapEntryDescriptor(entry, rootSchema(opts), opts.resolvePlugin));

    return buildMapContent(
        { kind: "section", pointer: container.pointer, label, mapEntries: container.marker, children },
        controlOptions
    );
}

/** The whole api-config schema, as the node type every `$ref` in it is written against. */
function rootSchema(opts: BuildTabsOptions): JsonSchemaNode {
    return opts.schema as JsonSchemaNode;
}

/** The last segment of a JSON pointer, unescaped. */
function lastSegment(pointer: string): string {
    return pointer.slice(pointer.lastIndexOf("/") + 1).replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * The credential exit for every group alike, not only `siem` - a `plugin` descriptor's value is
 * deliberately never read (see `Descriptor`'s own header), so the slot *name* is read from the
 * document here, exactly as `ConfigForm` read it for `siem` alone before this task.
 */
function buildCredentialControl(descriptor: Descriptor, opts: BuildTabsOptions): Control[] {
    const slot = readPointer(opts.document, descriptor.pointer);
    return opts.credentialSection.buildControl(
        typeof slot === "string" ? slot : "",
        opts.configurationId,
        opts.isAdmin
    );
}

/** Reads a JSON pointer out of a document. Mirrors `ConfigForm`'s own `_readPointer`. */
function readPointer(document: unknown, pointer: string): unknown {
    let cursor: unknown = document;
    const segments = pointer.split("/").filter(segment => segment.length > 0)
        .map(segment => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
    for (const segment of segments) {
        if (cursor === null || typeof cursor !== "object") {
            return undefined;
        }
        cursor = (cursor as Record<string, unknown>)[segment];
    }
    return cursor;
}

/**
 * A schema node's own `description`, or undefined. A map entry's panel is built by
 * `descriptorControls.buildSection` from the descriptor this file synthesizes for it, and that
 * descriptor is not one `withDescription` ever passed through - so the description is read here and
 * put on it by hand, which is what gives an entry panel the same tooltip every other panel has.
 */
function descriptionOf(schema: object): string | undefined {
    const description = (schema as Record<string, unknown>).description;
    return typeof description === "string" && description.length > 0 ? description : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function capitalize(word: string): string {
    return word.charAt(0).toUpperCase() + word.slice(1);
}

/** The tab that was selected, restored across a rebuild - see `ConfigForm._render`. */
export function attachTabSelection(tabBar: IconTabBar, onSelect: (key: string) => void): void {
    tabBar.attachSelect((event: IconTabBar$SelectEvent) => {
        const key = event.getParameter("key");
        if (key) {
            onSelect(key);
        }
    });
}
