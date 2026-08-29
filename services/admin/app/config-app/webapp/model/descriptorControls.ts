import Control from "sap/ui/core/Control";
import Icon from "sap/ui/core/Icon";
import Item from "sap/ui/core/Item";
import Button from "sap/m/Button";
import ColumnListItem from "sap/m/ColumnListItem";
import ComboBox, { ComboBox$SelectionChangeEvent } from "sap/m/ComboBox";
import Column from "sap/m/Column";
import HBox from "sap/m/HBox";
import Input from "sap/m/Input";
import { InputBase$ChangeEvent } from "sap/m/InputBase";
import Label from "sap/m/Label";
import Link from "sap/m/Link";
import MultiComboBox, { MultiComboBox$SelectionChangeEvent } from "sap/m/MultiComboBox";
import MultiInput, { MultiInput$TokenUpdateEvent } from "sap/m/MultiInput";
import OverflowToolbar from "sap/m/OverflowToolbar";
import Panel, { Panel$ExpandEvent } from "sap/m/Panel";
import ResponsivePopover from "sap/m/ResponsivePopover";
import ScrollContainer from "sap/m/ScrollContainer";
import Select, { Select$ChangeEvent } from "sap/m/Select";
import StepInput, { StepInput$ChangeEvent } from "sap/m/StepInput";
import Switch, { Switch$ChangeEvent } from "sap/m/Switch";
import Table from "sap/m/Table";
import Text from "sap/m/Text";
import Title from "sap/m/Title";
import ToolbarSpacer from "sap/m/ToolbarSpacer";
import Token from "sap/m/Token";
import VBox from "sap/m/VBox";
import SearchField, { SearchField$LiveChangeEvent } from "sap/m/SearchField";
import ColumnElementData from "sap/ui/layout/form/ColumnElementData";
import ColumnLayout from "sap/ui/layout/form/ColumnLayout";
import Form from "sap/ui/layout/form/Form";
import FormContainer from "sap/ui/layout/form/FormContainer";
import FormElement from "sap/ui/layout/form/FormElement";
import {
    AddRequest,
    MapSpec,
    RemoveRequest,
    containerAffordances,
    initialEntryExpanded,
    isMapEntryKey,
    isRemovableEntry,
    lastSegmentOf,
    mapEntriesCollapsed,
    mapSpecOf,
    matchesMapFilter,
    nextTokens
} from "./formContainers";
import { helpFor, helpRowCells, splitHelpText } from "./fieldHelp";
import { Descriptor } from "./schemaForm";
import { ScrollAncestorNode, tabScrollAncestor } from "./formViewport";

/**
 * The one interface a `Form`'s `ColumnLayout` accepts as a field. Anything else - a `VBox`, an
 * `HBox`, any layout container - is rejected by the layout and throws, which takes the whole
 * detail page down with it. Every control destined for `FormElement#fields` is checked against
 * this first; see `buildDescriptorControls`.
 */
const FORM_CONTENT = "sap.ui.core.IFormContent";

/**
 * A string-valued control setting given inside the settings object passed to `new Control({...})`
 * is run through UI5's complex-binding parser the moment it contains "{": `new Text({ text: v })`
 * treats `v` as (possibly mixed) binding syntax, not literal text, if `v` contains one. A JSON
 * snippet (`descriptor.json`, the `raw` fallback's whole reason for existing) routinely does; so,
 * proven by grepping this schema's own `description` text, does at least one schema author's own
 * words (`param_renames`'s description ships a literal `{"max_tokens":"max_completion_tokens"}`
 * example) - so this is not only a document-data concern. A document's own key can also end up in
 * a label (an unknown property surfaces as `raw`, labelled with that key) or in a reason
 * (`No schema defines property "<key>".`), and a document's own free-text value can end up in an
 * `Input`, a list's `Token`s, or a sink's own `name` used as an array-item section's title.
 *
 * None of this may reach a control through its constructor's settings object. Every call site
 * below that hands a control a string it did not type as a literal in this file therefore builds
 * the control first and assigns the string through its own setter afterward (`setText`,
 * `setTooltip`, `setValue`, `setHeaderText`, `setKey`) - a plain property write that never
 * consults the binding parser. A literal typed in this file (a hardcoded i18n key's resolved
 * text with no data concatenated in, a schema `enum` value used as a `Select`/`MultiComboBox`
 * item) needs no such care and is left in the settings object as before.
 */

/**
 * A field control that can show a validation state. Every control this module builds for a
 * scalar field is one; a `raw` snippet and the Buttons of a credential row are not, which is
 * exactly the distinction `onFieldControl` uses to decide what can carry an error.
 */
export interface FieldControl extends Control {
    setValueState(state: string): unknown;
    setValueStateText(text: string): unknown;
}

/**
 * Everything the descriptor renderer needs from its host, so this module stays a pure
 * descriptor -> control factory with no knowledge of configurations, saving or credentials.
 */
export interface DescriptorControlOptions {
    /** False renders every JSON-backed control read-only. Credential controls are not affected. */
    editable: boolean;
    /** Resolves an i18n key. */
    text: (key: string) => string;
    /** Called with the descriptor's JSON pointer and the control's new value. */
    onChange: (pointer: string, value: unknown) => void;
    /**
     * Builds the control(s) for a `plugin` descriptor (the credential exit). Several controls are
     * returned as an array so they can become the `fields` of one `FormElement` and line up in the
     * grid; a single control wrapped in a container could not - see `buildDescriptorControls`.
     */
    buildPlugin: (descriptor: Descriptor) => Control | Control[];
    /**
     * Creates what `request` addresses: an entry of a map, an element of an array, or the container
     * of a section the document does not carry. The request carries the marker the descriptor was
     * built from, so the host applies one write and never has to work out from the pointer alone
     * what kind of container it is. Omitted -> no add affordance anywhere.
     */
    onAddItem?: (request: AddRequest) => void;
    /** Removes what `request` addresses: one map entry, or one array element by index. */
    onRemoveItem?: (request: RemoveRequest) => void;
    /**
     * Offers the control that renders the field at `pointer`, so the host can put an error on it
     * and take it off again. Called once per field descriptor that has a control able to show
     * one; a `raw` snippet has none and is not offered.
     */
    onFieldControl?: (pointer: string, control: FieldControl) => void;
    /**
     * What the host remembers about a map entry panel's expansion, by the entry's own pointer:
     * `true`/`false` for one it has a decision for, `undefined` for one it has never seen. A panel
     * opens by `initialEntryExpanded` - the remembered value when there is one, the map's collapse
     * default otherwise - which is what keeps an expanded override open across a rebuild (a section
     * added, an entry removed, a credential changed) rather than snapping shut. Consulted for map
     * ENTRY panels only; every other panel opens as it always did.
     */
    isEntryExpanded?: (pointer: string) => boolean | undefined;
    /**
     * Called when a map entry panel is expanded or collapsed - by the operator's own click, by
     * Expand all / Collapse all (both go through `setExpanded`, which fires the same event), or by
     * a reveal - so the host's memory stays current. Wired to map ENTRY panels only.
     */
    onEntryToggle?: (pointer: string, expanded: boolean) => void;
    /**
     * Offers every container panel this build creates, by its own pointer - a section, a table, and
     * a map entry alike - so the host can reach one after the build to expand it and scroll it into
     * view. Unlike `entryPanels.onPanel` (which the map toolbar uses and which sees map entries
     * only), this sees every panel, so the target of an add - a newly present section, a new array
     * element - is reachable too.
     */
    onContainerPanel?: (pointer: string, panel: Panel) => void;
    /**
     * Offers the pointer of every map CONTAINER this build renders (the map node itself, not its
     * entries), so the host can work out which of a reveal target's ancestors are map entries -
     * `ancestorEntryPointers`. Called once per map, at the map's own pointer.
     */
    onMapContainer?: (pointer: string) => void;
    /**
     * Set by `buildMapContent` for the descriptors of ONE map's entries, and consumed by whatever
     * renders each of them - a Panel's header toolbar for an object or array entry, one more field
     * beside the control for a scalar one. Never propagated further down: a section clears it before
     * it builds its own children, so a field two levels inside an entry cannot grow a [-] that would
     * delete the whole entry.
     */
    entryRemoval?: {
        /** The map these descriptors are entries of. */
        spec: MapSpec;
        /** Whether this particular descriptor is a removable entry - see `buildMapContent`. */
        removable: (descriptor: Descriptor) => boolean;
    };
    /**
     * i18n key of the tooltip on an array element's [-], set by the array section for its own
     * elements. The sink array keeps its own wording; every other array says "Remove this entry".
     */
    elementRemoveText?: string;
    /**
     * Offers the control - or the `FormElement` - that renders the descriptor at `pointer`, so a
     * map's filter can hide one entry without rebuilding anything. Set by `buildMapContent` only.
     */
    onEntryControl?: (pointer: string, control: EntryControl) => void;
    /**
     * Set by `buildMapContent` for the descriptors of ONE map's entries, like `entryRemoval`, and
     * cleared the same way before an entry builds its own children - so a section nested inside an
     * entry neither opens closed with the entry list nor turns up in the jump list.
     */
    entryPanels?: {
        /** Whether an entry's panel opens CLOSED - see `formContainers.mapEntriesCollapsed`. */
        collapsed: boolean;
        /** Offers one entry's Panel, so Expand all / Collapse all and the jump list can reach it. */
        onPanel: (pointer: string, panel: Panel) => void;
    };
}

/**
 * What a map's toolbar can do to one entry without rebuilding anything: hide it (the filter) and,
 * where the control has a rendering of its own, scroll to it (the jump list). A `Panel`, a
 * `FormElement` and a `VBox` all qualify; `getDomRef` is optional only because the interface is
 * written against what is USED rather than against a UI5 base class.
 */
export interface EntryControl {
    setVisible(visible: boolean): unknown;
    getDomRef?: () => Element | null;
}

/**
 * `descriptor.description` is optional in the schema, and a control's `setTooltip` does not
 * accept `undefined` as an explicit argument the way an omitted constructor settings key did -
 * see this module's header for why the description is set through a setter at all rather than
 * the constructor. A missing description means no tooltip, same as before; this is where that
 * case is handled once instead of at each of the eight call sites below.
 */
function setDescriptionTooltip(control: { setTooltip(tooltip: string): unknown }, description: string | undefined): void {
    if (description !== undefined) {
        control.setTooltip(description);
    }
}

/**
 * How many digits a `multipleOf` needs after the decimal point, which is the StepInput's
 * `displayValuePrecision` for a field that declares one: 0.1 -> 1, 0.25 -> 2, 0.001 -> 3. Used
 * only for the (today, none) float field with a `multipleOf`; a plain float without one shows two
 * decimals. `Number`'s own text form is the source, so an integer multipleOf yields 0.
 */
function decimalPlaces(value: number): number {
    const text = String(value);
    const dot = text.indexOf(".");
    return dot === -1 ? 0 : text.length - dot - 1;
}

/**
 * The one popover every help icon on the page opens, created on the first press and reused by
 * every icon after it.
 *
 * It is made a DEPENDENT of the icon that opens it, so the form's own teardown owns its lifetime:
 * `ConfigForm._render` (and `_clearContent`) call `destroyItems()` on the form's container before
 * every rebuild - a sink added, a map entry removed, another configuration selected - which
 * destroys the icons, and a destroyed icon destroys its dependents with it. The next press after a
 * rebuild finds a destroyed instance and builds one more; there is never a second live one, and
 * nothing survives a rebuild pointing at a control that no longer exists.
 */
let helpPopover: ResponsivePopover | undefined;

/**
 * Shows one description. `title` is the field's own label and `text` the schema's words - both
 * possibly containing "{", so both are assigned through setters (see this module's header), which
 * is also why the popover's `Text` is built empty and filled here rather than per icon.
 *
 * The body is split by `splitHelpText`: a doc URL at the end of the description is the one unbroken
 * token long enough to force a sideways scrollbar, so it is pulled out of the prose and rendered
 * as a compact `Link` beneath it (opening in a new tab) rather than left to overflow the body. The
 * prose `Text` carries `configFormHelpText`, whose `overflow-wrap`/`word-break` break any remaining
 * long token so the popover never scrolls horizontally. `moreLinkText` is the resolved label for
 * that link; the full description, URL and all, stays the field control's hover tooltip untouched.
 */
function openFieldHelp(icon: Icon, title: string, text: string, moreLinkText: string): void {
    if (!helpPopover || helpPopover.isDestroyed()) {
        helpPopover = new ResponsivePopover({
            placement: "Auto",
            contentWidth: "22rem",
            content: [
                new Text({ wrapping: true }).addStyleClass("configFormHelpText"),
                new Link({})
            ]
        });
        // `sapUiContentPadding` is a CONTAINER class: the theme defines it only as
        // `.sapMPopover.sapUiContentPadding .sapMPopoverCont > .sapMPopoverScroll` (and the same
        // for `.sapMDialog`, which is what a ResponsivePopover renders as on a phone) - see the
        // `.sapUiContainerContentPadding` mixin instantiated in sap/m/themes/base/Popover.less and
        // Dialog.less. On the `Text` itself, where it used to sit, it matches no rule at all, which
        // is why the words ran into the popover's border. ResponsivePopover forwards
        // `addStyleClass` to whichever of the two it wraps, so one class covers both renderings.
        helpPopover.addStyleClass("sapUiContentPadding");
    }
    helpPopover.setTitle(title);
    // The header exists to carry the title - and on a phone, where a ResponsivePopover is a Dialog,
    // the close button with it, which is the only way back on exactly the devices this affordance
    // exists for since a hover tooltip never appears there. Every caller passes a field label, so
    // in practice it stays on; a titleless popover would show an empty bar instead.
    helpPopover.setShowHeader(title.length > 0);
    const split = splitHelpText(text);
    const content = helpPopover.getContent();
    (content[0] as Text).setText(split.text);
    const link = content[1] as Link;
    if (split.url) {
        // The URL is document/schema text, so it goes through setters like every other non-literal
        // string here; `_blank` because the admin app is a normal app where a new tab is real
        // navigation, not a sandboxed frame.
        link.setText(moreLinkText);
        link.setHref(split.url);
        link.setTarget("_blank");
        link.setVisible(true);
    } else {
        link.setVisible(false);
    }
    // Re-parented to the icon being pressed before it is opened by it: the popover follows the
    // opener, and its lifetime follows the opener's with it. `openBy` on an already-open popover
    // moves it to the new opener, which is what pressing a second icon should do.
    icon.addDependent(helpPopover);
    helpPopover.openBy(icon);
}

/**
 * The information affordance for a descriptor the schema describes, or null when it describes
 * none - see `helpFor`, which is the whole rule and is unit-tested on its own.
 *
 * The description has been on these controls as a `setTooltip` since the form shipped, and it
 * stays there; what it could not do is show itself. A tooltip needs a pointing device and a hover
 * held long enough, and on a touch device it never appears at all - so the sentence explaining
 * that `allow_unmasked_content` ships raw conversations was, in practice, unreadable. This is the
 * visible half: an icon next to the label that says there is something to read, and opens it.
 */
function buildHelpIcon(descriptor: Descriptor, options: DescriptorControlOptions, tooltipKey: string): Icon | null {
    const help = helpFor(descriptor);
    if (!help) {
        return null;
    }
    const icon = new Icon({
        src: "sap-icon://message-information",
        // Not decoration: it is the control that opens the explanation, so it takes a tab stop and
        // is announced with the tooltip below as its label. `useIconTooltip` off, or the icon's own
        // name ("message-information") would be offered instead where no tooltip is set.
        decorative: false,
        useIconTooltip: false,
        // A hardcoded i18n key's resolved text with nothing concatenated into it - the one kind of
        // string this module does put in a settings object (see its header).
        tooltip: options.text(tooltipKey)
        // Margin BEGIN, not end: on a field row the icon follows the control it explains (see
        // `buildDescriptorControls`), so the gap belongs on the side facing that control.
    }).addStyleClass("sapUiTinyMarginBegin");
    icon.attachPress(() => openFieldHelp(icon, descriptor.label, help.text, options.text("formHelpMoreLink")));
    return icon;
}

/**
 * The cells a `FormElement`'s FIELDS have between them on a large column: the element's 12 less
 * what the label takes beside them and what the layout holds back at the end of the row. Read off
 * the layout rather than assumed, so a `labelCellsLarge` or `emptyCellsLarge` changed on the
 * `ColumnLayout` below moves the help sizing with it instead of silently overflowing the row.
 */
function largeFieldBudget(layout: ColumnLayout): number {
    return 12 - layout.getLabelCellsLarge() - layout.getEmptyCellsLarge();
}

/**
 * Gives the help icon of one row the smallest share of that row's cells and the control(s) it
 * explains the rest - the arithmetic itself is `helpRowCells`, which is unit-tested.
 *
 * `fields` is the whole row, icon included, so the icon is taken out here rather than at each call
 * site; what is left is what the budget is divided between.
 */
function sizeHelpRow(icon: Icon, fields: Control[], budgetLarge: number): void {
    const explained = fields.filter(field => field !== icon);
    const cells = helpRowCells(budgetLarge, explained.length);
    icon.setLayoutData(new ColumnElementData({ cellsLarge: cells.icon.large, cellsSmall: cells.icon.small }));
    explained.forEach(field => field.setLayoutData(new ColumnElementData({
        cellsLarge: cells.field.large,
        cellsSmall: cells.field.small
    })));
}

/** The control of this group that can carry a validation state, if any. */
function markableField(fields: Control[]): FieldControl | undefined {
    return fields.filter(field =>
        typeof (field as Partial<FieldControl>).setValueState === "function"
        && typeof (field as Partial<FieldControl>).setValueStateText === "function"
    )[0] as FieldControl | undefined;
}

/** Descriptor kinds that render as a labelled field rather than as their own container. */
const FIELD_KINDS = ["switch", "number", "select", "text", "list", "raw", "plugin"];

/**
 * Maps a descriptor list to controls, per the control table in the design spec:
 * boolean -> Switch, number -> StepInput, enum -> Select, string -> Input, object -> Panel,
 * array of objects -> Table, array of enum-constrained scalars -> MultiComboBox, array of free
 * scalars -> MultiInput, anything unrepresentable -> a read-only JSON snippet that says why.
 *
 * Consecutive field descriptors are grouped into one Form; sections and tables get their own
 * Panel, so nesting in the schema shows up as nesting on screen. An array of objects whose
 * members differ by type arrives as a section of sections rather than as a table, and therefore
 * as a panel of panels - one per element, each opening closed.
 */
export function buildDescriptorControls(descriptors: Descriptor[], options: DescriptorControlOptions): Control[] {
    const controls: Control[] = [];
    let pending: Array<{ pointer: string; label: string; fields: Control[]; help?: Icon; required: boolean }> = [];

    const flush = (): void => {
        if (pending.length === 0) {
            return;
        }
        controls.push(buildForm(pending, options));
        pending = [];
    };

    for (const descriptor of descriptors) {
        if (FIELD_KINDS.indexOf(descriptor.kind) !== -1) {
            const built = buildField(descriptor, options);
            const fields = Array.isArray(built) ? built : [built];
            const required = (descriptor as { required?: boolean }).required === true;
            // A scalar map's entry is one labelled control, so its [-] goes in beside that control
            // as one more field of the same row - the shape a credential slot already uses. There is
            // no panel header to hang it on, and a row of its own would not say which key it removes.
            const entryRemove = buildEntryRemoveButton(descriptor, options);
            if (entryRemove) {
                fields.push(entryRemove);
            }
            // The help icon TRAILS the row's controls. `ColumnLayout` lays a `FormElement`'s fields
            // out left to right in the order of the aggregation (see `renderElement`), so leading
            // with the icon pushed the control it explains one cell to the right of every control
            // on a row that has no description - a ragged left edge down the whole form. Trailing,
            // the control starts where every other control starts and only ends one cell earlier.
            // It is added last, after every other field of the row is known, because the row's
            // cells are split between them all - which happens in `buildForm`, where the layout
            // that decides how many cells there are exists.
            const help = buildHelpIcon(descriptor, options, "formFieldHelpTooltip") ?? undefined;
            if (help) {
                fields.push(help);
            }
            // Offered before the IFormContent decision below, so a field that falls back to its
            // own block can still be flagged when a save is refused.
            const markable = options.onFieldControl ? markableField(fields) : undefined;
            if (markable && options.onFieldControl) {
                options.onFieldControl(descriptor.pointer, markable);
            }
            // Not everything that belongs beside a label is a single control. A credential slot is
            // a small composite - which slot, whether a value is stored, Set and Clear - and those
            // go in as separate `fields` of one FormElement, which is what `fields` (0..n of
            // sap.ui.core.Control) is for, so the row lines up with every other row in the grid.
            //
            // What must never happen is a non-IFormContent control reaching the ColumnLayout: it
            // throws, and the throw takes the detail page's header down with it. So the whole group
            // is checked first, and anything that does not qualify falls back to its own labelled
            // block below the grid - misaligned, but rendered, and nothing else lost with it.
            if (fields.length > 0 && fields.every(field => field.isA(FORM_CONTENT))) {
                pending.push({ pointer: descriptor.pointer, label: descriptor.label, fields, help, required });
                continue;
            }
            flush();
            // `.setText(...)`, not `text: descriptor.label` in the constructor - see this
            // module's header for why every string that did not originate as a literal typed in
            // this file goes through a setter, never the settings object.
            const fallbackLabel = new Label({ required });
            fallbackLabel.setText(descriptor.label);
            const fallback = new VBox({
                items: ([fallbackLabel as Control]).concat(fields)
            }).addStyleClass("sapUiSmallMarginBottom");
            options.onEntryControl?.(descriptor.pointer, fallback);
            controls.push(fallback);
            continue;
        }
        flush();
        if (descriptor.kind === "section") {
            const panel = buildSection(descriptor, options);
            options.onEntryControl?.(descriptor.pointer, panel);
            controls.push(panel);
        } else if (descriptor.kind === "table") {
            const tablePanel = new Panel({
                expandable: true,
                expanded: true,
                // A table can still be wider than the detail column. sap.m.Table has no
                // scrollbars of its own, and squeezing its columns into the available width makes
                // cells too narrow to read or click, so it is laid out by content inside a
                // horizontal scroll container - the combination the control's own documentation
                // prescribes.
                content: [new ScrollContainer({
                    horizontal: true,
                    vertical: false,
                    width: "100%",
                    content: [buildTable(descriptor, options)]
                })]
            });
            setDescriptionTooltip(tablePanel, descriptor.description);
            // A table panel has no [+] or [-] of its own, so its help is the only thing its header
            // line carries besides the title - and it is carried there rather than pushed into the
            // content, where an icon on a line of its own above the table read as content.
            setPanelHeader(tablePanel, descriptor.label, buildHelpIcon(descriptor, options, "formSectionHelpTooltip"), []);
            options.onEntryControl?.(descriptor.pointer, tablePanel);
            options.onContainerPanel?.(descriptor.pointer, tablePanel);
            controls.push(tablePanel);
        }
    }
    flush();

    return controls;
}

/**
 * The label is an explicit `sap.m.Label` rather than the plain string the aggregation also
 * accepts, because that is the only place a mandatory field can be marked for every row alike.
 * `FormElement` does derive the asterisk from a field's own `required` property, but a credential
 * row's fields are a Text, an ObjectStatus and two Buttons - none of which has one - so a schema
 * that insists on a credential slot would go unmarked. `wrapping` matches what `FormElement`
 * sets on the label it would otherwise have created itself, so nothing about the layout changes.
 */
function buildForm(
    elements: Array<{ pointer: string; label: string; fields: Control[]; help?: Icon; required: boolean }>,
    options: DescriptorControlOptions
): Form {
    const layout = new ColumnLayout({ columnsM: 1, columnsL: 1, columnsXL: 2 });
    // Sized here, not where the icon was built: how many cells a row's fields have between them is
    // the LAYOUT's answer, and this is where the layout of these rows comes into existence.
    const budgetLarge = largeFieldBudget(layout);
    return new Form({
        editable: options.editable,
        layout,
        formContainers: [
            new FormContainer({
                formElements: elements.map(element => {
                    if (element.help) {
                        sizeHelpRow(element.help, element.fields, budgetLarge);
                    }
                    const label = new Label({ required: element.required, wrapping: true });
                    label.setText(element.label);
                    const formElement = new FormElement({ label, fields: element.fields });
                    // A scalar map's entries are consecutive fields and therefore share one Form.
                    // The FormElement is what the filter hides, so the row - label, control and its
                    // [-] together - goes away as one, and the grid closes up behind it.
                    options.onEntryControl?.(element.pointer, formElement);
                    return formElement;
                })
            })
        ]
    });
}

/**
 * A section as a Panel.
 *
 * Three things can sit in its header beside the title, and a Panel shows either a plain `headerText`
 * or a `headerToolbar`, so the toolbar is only built when there is something to put in it:
 *
 * - the [+] of an array, appending one element (the sink array's opens the sink dialog instead - see
 *   `ConfigForm.onAddItem` - which is why the tooltip differs);
 * - the [-] of one array element, by index;
 * - the [-] of one map entry, set on this section by the map that owns it (`entryRemoval`).
 *
 * The fourth affordance, **Add section**, goes in the panel's CONTENT instead, directly under the
 * notice saying the document does not carry this container (`buildAbsentContent`) - it is the answer
 * to that sentence rather than an action on a panel that has something in it.
 *
 * All four follow the same editability rule as every JSON-backed control on the page -
 * `options.editable`, which is admin AND inactive - because adding or removing is an edit like any
 * other.
 */
function buildSection(descriptor: Descriptor, options: DescriptorControlOptions): Panel {
    if (descriptor.kind !== "section") {
        throw new Error("buildSection: not a section descriptor");
    }

    const actions: Control[] = [];
    if (descriptor.arrayItems && options.onAddItem) {
        const request: AddRequest = {
            pointer: descriptor.pointer,
            kind: "array",
            arrayItems: descriptor.arrayItems
        };
        const add = options.onAddItem;
        actions.push(new Button({
            icon: "sap-icon://add",
            type: "Transparent",
            // The sink array is the one whose elements pick their fields by a discriminator, and the
            // one whose [+] opens a dialog rather than appending a skeleton. Its wording says so.
            tooltip: options.text(descriptor.arrayItems.discriminated ? "formSinkAdd" : "formArrayAdd"),
            visible: options.editable,
            press: () => add(request)
        }));
    }
    if (typeof descriptor.arrayIndex === "number" && options.onRemoveItem) {
        const request: RemoveRequest = { pointer: descriptor.pointer, kind: "array" };
        const remove = options.onRemoveItem;
        actions.push(new Button({
            icon: "sap-icon://less",
            type: "Transparent",
            tooltip: options.text(options.elementRemoveText ?? "formArrayRemove"),
            visible: options.editable,
            press: () => remove(request)
        }));
    }
    const entryRemove = buildEntryRemoveButton(descriptor, options);
    if (entryRemove) {
        actions.push(entryRemove);
    }

    const entryPanels = options.entryPanels;
    const panel = new Panel({
        expandable: true,
        // An ENTRY of a map opens by what the host remembers about it, falling back to what its map
        // decided for all of them at once (a list of more than three opens closed -
        // `mapEntriesCollapsed`); anything else opens closed only if it says it is collapsed - one
        // array element among many, where the list of headers is read first.
        expanded: entryPanels
            ? initialEntryExpanded(options.isEntryExpanded?.(descriptor.pointer), entryPanels.collapsed)
            : descriptor.collapsed !== true,
        content: buildSectionBody(descriptor, options)
    });
    setDescriptionTooltip(panel, descriptor.description);
    setPanelHeader(
        panel,
        descriptor.label,
        buildHelpIcon(descriptor, options, "formSectionHelpTooltip"),
        actions,
        descriptor.summary
    );
    // A map entry's expansion is remembered across rebuilds, so its every change has to reach the
    // host - the operator's own toggle, and Expand all / Collapse all and a reveal, which both go
    // through `setExpanded` and fire this same event. Wired for map ENTRY panels only: nothing else
    // is remembered.
    if (entryPanels && options.onEntryToggle) {
        const toggle = options.onEntryToggle;
        panel.attachExpand((event: Panel$ExpandEvent) => toggle(descriptor.pointer, event.getParameter("expand") === true));
    }
    if (entryPanels) {
        entryPanels.onPanel(descriptor.pointer, panel);
    }
    options.onContainerPanel?.(descriptor.pointer, panel);
    return panel;
}

/**
 * A section panel's header line: its title, and at the right end whatever explains or acts on it.
 *
 * A Panel shows a plain `headerText` OR a `headerToolbar`, never both, so a panel with neither help
 * nor actions keeps `headerText` - its title then renders through the same control as every other
 * plain section's, which is why a toolbar is not built unconditionally.
 *
 * A panel with a description now always gets one. The help icon used to go to the top of the panel's
 * CONTENT whenever there was no toolbar to hang it on, where it sat alone on the first line as
 * though it were one of the section's own fields; the header line is where it says something about
 * the section rather than about what is in it. It goes after the spacer, ahead of the actions, so
 * one section's icon is in the same place as the next one's whether or not that section has a [+].
 */
function setPanelHeader(
    panel: Panel,
    label: string,
    help: Icon | null,
    actions: Control[],
    summary?: string
): void {
    if (!help && actions.length === 0 && !summary) {
        panel.setHeaderText(label);
        return;
    }
    // `label` here is a sink's own, free-text `name` when this section is one array item (see
    // `buildItemSection` in `schemaForm.ts`) - document data with no pattern restricting its
    // characters, so it is set through `.setText`, not the constructor.
    const title = new Title({ level: "H4" });
    title.setText(label);
    const heading: Control[] = [title];
    if (summary) {
        // A collapsed entry's one line of content, beside its title - the whole reason a list of
        // twenty overrides can be read closed. Document data, so it goes in through `.setText`.
        const line = new Text({ wrapping: false });
        line.setText(summary);
        heading.push(line.addStyleClass("sapUiSmallMarginBegin"));
    }
    heading.push(new ToolbarSpacer());
    if (help) {
        heading.push(help);
    }
    panel.setHeaderToolbar(new OverflowToolbar({ content: heading.concat(actions) }));
}

/**
 * What goes inside a section's Panel: the notice and **Add section** for a container the document
 * does not carry, one map's entries for a map, and its children's controls for everything else.
 *
 * `entryRemoval` and `elementRemoveText` are re-decided here for every level rather than passed
 * through: a section that is a map sets its own (`buildMapContent`), a section that is an array sets
 * the wording its elements use, and anything else clears both - so a field deep inside one entry
 * cannot inherit the [-] that would delete the entry around it.
 */
function buildSectionBody(descriptor: Descriptor, options: DescriptorControlOptions): Control[] {
    if (descriptor.kind !== "section") {
        return [];
    }
    if (descriptor.absent === true) {
        return buildAbsentContent(descriptor, options);
    }
    if (descriptor.mapEntries) {
        return buildMapContent(descriptor, options);
    }
    const childOptions: DescriptorControlOptions = {
        ...options,
        entryRemoval: undefined,
        entryPanels: undefined,
        onEntryControl: undefined,
        elementRemoveText: descriptor.arrayItems
            ? (descriptor.arrayItems.discriminated ? "formSinkRemove" : "formArrayRemove")
            : undefined
    };
    return buildDescriptorControls(descriptor.children, childOptions);
}

/**
 * A container the document does not carry: what it would hold, said once, and the one action that
 * creates it.
 *
 * The notice alone is what Spec 2 shipped, and it is where the form dead-ended - the JSON editor was
 * the only way to bring a section into existence, and an edit made in the form before that landed at
 * the document root. **Add section** writes the empty container (`{}`, or `[]` for an array) at this
 * pointer through the same single mutation path every other edit takes; the panel then re-renders
 * with its fields, its own [+], or both.
 */
export function buildAbsentContent(descriptor: Descriptor, options: DescriptorControlOptions): Control[] {
    if (descriptor.kind !== "section") {
        return [];
    }
    const content: Control[] = [new Text({ text: options.text("formSectionAbsent") })];
    const affordances = containerAffordances({
        editable: options.editable,
        kind: "section",
        pointer: descriptor.pointer,
        entryCount: 0,
        hasAddHandler: typeof options.onAddItem === "function",
        hasRemoveHandler: false
    });
    if (!affordances.add || !options.onAddItem) {
        return content;
    }
    const add = options.onAddItem;
    const request: AddRequest = {
        pointer: descriptor.pointer,
        kind: "section",
        ...(descriptor.mapEntries ? { mapEntries: descriptor.mapEntries } : {}),
        ...(descriptor.arrayItems ? { arrayItems: descriptor.arrayItems } : {})
    };
    content.push(new Button({
        icon: "sap-icon://add",
        type: "Transparent",
        text: options.text("formAddSection"),
        tooltip: options.text("formAddSectionTooltip"),
        press: () => add(request)
    }).addStyleClass("sapUiTinyMarginTop"));
    return content;
}

/**
 * One map's entries: the filter row and the [+] above them, then one control per entry, each
 * carrying the [-] that removes it.
 *
 * Every entry is a child descriptor of this section - the renderer built them from the document's
 * own keys - so this adds affordances rather than content. Which of those children is an ENTRY (and
 * therefore removable) is `isMapEntryKey`'s answer, not a guess: `hooks.defaults.<endpoint>` is a map
 * of subpaths that also declares `pseudonymization`, and that one is a field of the endpoint rather
 * than an entry of it. A child the document does not carry (`absent`) is not removable either -
 * there is nothing to remove, and offering it would write the same document back.
 *
 * Filtering is client-side and non-destructive: every entry stays built and in the aggregation, and
 * a non-matching one is only `setVisible(false)`, so clearing the field brings it back exactly as it
 * was - open or collapsed, edited or not. Nothing about the document is touched.
 */
export function buildMapContent(descriptor: Descriptor, options: DescriptorControlOptions): Control[] {
    if (descriptor.kind !== "section" || !descriptor.mapEntries) {
        return [];
    }
    const spec = mapSpecOf(descriptor.pointer, descriptor.mapEntries);
    // Named to the host so a reveal can tell which of a target's ancestors are map entries.
    options.onMapContainer?.(spec.pointer);
    const isEntry = (child: Descriptor): boolean =>
        isRemovableEntry(lastSegmentOf(child.pointer), (child as { absent?: true }).absent !== true, spec);

    const children = descriptor.children.filter(child => isMapEntryKey(lastSegmentOf(child.pointer), spec));
    // Decided once, for the whole list, before any of it is built: a map of more than three opens
    // every entry closed, and its toolbar grows the affordances that go with a closed list.
    const collapsed = mapEntriesCollapsed(children.length);

    const visibility: Record<string, EntryControl[]> = {};
    const panels: Record<string, Panel> = {};
    const controls = buildDescriptorControls(descriptor.children, {
        ...options,
        elementRemoveText: undefined,
        entryRemoval: { spec, removable: isEntry },
        entryPanels: { collapsed, onPanel: (pointer, panel) => { panels[pointer] = panel; } },
        onEntryControl: (pointer, control) => {
            visibility[pointer] = (visibility[pointer] ?? []).concat([control]);
        }
    });

    const entries: MapEntryControls[] = children.map(child => ({
        key: lastSegmentOf(child.pointer),
        controls: visibility[child.pointer] ?? [],
        panel: panels[child.pointer],
        visible: true
    }));

    const toolbar = buildMapToolbar(spec, entries, options);
    return toolbar ? ([toolbar as Control]).concat(controls) : controls;
}

/**
 * One entry of a map, as the TOOLBAR above it holds it: what it is called, what hides when the
 * filter excludes it, its own Panel when it has one (a scalar entry is one form row, not a panel),
 * and whether the filter is showing it right now.
 *
 * `visible` is state the toolbar keeps for itself rather than reading back off a control, because
 * the filter, the jump list and Expand all all have to agree on the same answer: what is on screen.
 */
interface MapEntryControls {
    key: string;
    controls: EntryControl[];
    panel?: Panel;
    visible: boolean;
}

/** The [-] on one entry of the map that owns this descriptor, or null when there is none to draw. */
function buildEntryRemoveButton(descriptor: Descriptor, options: DescriptorControlOptions): Button | null {
    const entryRemoval = options.entryRemoval;
    if (!entryRemoval || !options.onRemoveItem || !entryRemoval.removable(descriptor)) {
        return null;
    }
    const affordances = containerAffordances({
        editable: options.editable,
        kind: "map",
        pointer: entryRemoval.spec.pointer,
        entryCount: 0,
        hasAddHandler: false,
        hasRemoveHandler: true
    });
    if (!affordances.remove) {
        return null;
    }
    const remove = options.onRemoveItem;
    const request: RemoveRequest = {
        pointer: descriptor.pointer,
        kind: "map",
        mapEntries: entryRemoval.spec.marker
    };
    return new Button({
        icon: "sap-icon://less",
        type: "Transparent",
        tooltip: options.text(entryRemoval.spec.removeText),
        press: () => remove(request)
    });
}

/**
 * The row above a map's entries: a filter field once there are enough entries to be worth filtering,
 * the jump list and Expand all / Collapse all once the entries open closed, and the [+] when the
 * form is editable. Null when there would be none of them - a lone search box over an empty map is
 * an affordance for nothing.
 *
 * Only the [+] is gated on editability. The other three change nothing in the document - they hide,
 * scroll and open panels - and a twenty-entry override list is exactly as hard to navigate for
 * someone who may not edit it as for someone who may.
 *
 * Everything here acts on the entries ALREADY BUILT, never by rebuilding the form: Expand all is
 * `setExpanded` on the panels that are on screen, and the jump list is `scrollIntoView` on one of
 * them. A rebuild would discard every panel's open/closed state and the filter with it.
 */
function buildMapToolbar(
    spec: MapSpec,
    entries: MapEntryControls[],
    options: DescriptorControlOptions
): OverflowToolbar | null {
    const affordances = containerAffordances({
        editable: options.editable,
        kind: "map",
        pointer: spec.pointer,
        entryCount: entries.length,
        hasAddHandler: typeof options.onAddItem === "function",
        hasRemoveHandler: false
    });
    // A scalar map's entries are form rows, not panels: there is nothing to expand, so those two
    // buttons are not drawn however many entries there are.
    const expandable = affordances.expand && entries.some(entry => entry.panel !== undefined);
    if (!affordances.add && !affordances.filter && !affordances.jump && !expandable) {
        return null;
    }

    const content: Control[] = [];
    const jump = affordances.jump ? buildJumpList(entries, options) : undefined;

    if (affordances.filter) {
        const filter = new SearchField({
            width: "20rem",
            liveChange: (event: SearchField$LiveChangeEvent) => {
                const value = event.getParameter("newValue") ?? "";
                entries.forEach(entry => {
                    entry.visible = matchesMapFilter(entry.key, value);
                    entry.controls.forEach(control => control.setVisible(entry.visible));
                });
                // The jump list offers what is on screen and nothing else: a filtered-out entry is
                // not listed, so choosing one can never scroll to a panel the filter is hiding.
                if (jump) {
                    syncJumpItems(jump, entries);
                }
            }
        });
        filter.setPlaceholder(options.text(spec.filterPlaceholderText));
        content.push(filter);
    }
    if (jump) {
        content.push(jump);
    }
    content.push(new ToolbarSpacer());
    if (expandable) {
        content.push(buildExpandButton(entries, options, true));
        content.push(buildExpandButton(entries, options, false));
    }
    if (affordances.add && options.onAddItem) {
        const add = options.onAddItem;
        const request: AddRequest = { pointer: spec.pointer, kind: "map", mapEntries: spec.marker };
        content.push(new Button({
            icon: "sap-icon://add",
            type: "Transparent",
            tooltip: options.text(spec.addText),
            press: () => add(request)
        }));
    }
    return new OverflowToolbar({ content });
}

/** Expand all / Collapse all: `setExpanded` on every entry the filter is currently showing. */
function buildExpandButton(
    entries: MapEntryControls[],
    options: DescriptorControlOptions,
    expand: boolean
): Button {
    return new Button({
        icon: expand ? "sap-icon://expand-group" : "sap-icon://collapse-group",
        type: "Transparent",
        text: options.text(expand ? "formMapExpandAll" : "formMapCollapseAll"),
        press: () => entries.forEach(entry => {
            if (entry.visible && entry.panel) {
                entry.panel.setExpanded(expand);
            }
        })
    });
}

/**
 * The jump list: the entries the filter is showing, in document order, and choosing one opens that
 * entry and scrolls it to the top of the tab's scrolling region.
 *
 * A `ComboBox` rather than a `Select` for two reasons: a Select always has a selection, so it would
 * claim an entry is chosen before anyone chose one, and picking the same entry twice would raise no
 * event the second time. This one clears itself after each jump, so the entry just visited can be
 * jumped back to.
 */
function buildJumpList(entries: MapEntryControls[], options: DescriptorControlOptions): ComboBox {
    const jump = new ComboBox({ width: "14rem" });
    jump.setPlaceholder(options.text("formMapJump"));
    jump.setTooltip(options.text("formMapJumpTooltip"));
    syncJumpItems(jump, entries);
    jump.attachSelectionChange((event: ComboBox$SelectionChangeEvent) => {
        const item = event.getParameter("selectedItem");
        const key = item ? item.getKey() : "";
        const entry = entries.filter(candidate => candidate.key === key)[0];
        if (entry) {
            revealEntry(entry);
        }
        // Cleared so the same entry can be chosen again - see this function's own header.
        jump.setSelectedKey("");
        jump.setValue("");
    });
    return jump;
}

/** The visible entries as the jump list's items, in document order. Item text is a document key. */
function syncJumpItems(jump: ComboBox, entries: MapEntryControls[]): void {
    jump.destroyItems();
    for (const entry of entries) {
        if (!entry.visible) {
            continue;
        }
        const item = new Item();
        item.setKey(entry.key);
        item.setText(entry.key);
        jump.addItem(item);
    }
}

/**
 * Brings one control to the top of its tab's scrolling region, without moving anything else.
 *
 * The reveal is confined to the enclosing tab `sap.m.ScrollContainer` (`tabScrollAncestor`): its
 * `scrollToElement(control, 0)` scrolls only that container, where `Element.scrollIntoView` would
 * have scrolled every scrollable ancestor up to the document and taken the whole master-detail page
 * with it (the "trapped far down the page" regression). A control that is not inside a tab region -
 * which a section never is, but a stray caller could be - is left where it is rather than scrolled
 * by the document.
 *
 * `scrollToElement` accepts a `UI5Element` directly (see `sap.m.ScrollContainer` in `@sapui5/types`,
 * `scrollToElement(element: HTMLElement | UI5Element, time?: int)`), so the control's own DOM node
 * does not have to be resolved here; passing 0 as the time scrolls immediately, without animation.
 */
export function scrollControlIntoTabView(control: Control): void {
    // `tabScrollAncestor` walks by id and type only, which `Control` exposes; the match it returns
    // is the `sap.m.ScrollContainer` it tested `isA` against, so the cast back is sound.
    const scroll = tabScrollAncestor(control as unknown as ScrollAncestorNode);
    if (scroll) {
        (scroll as unknown as ScrollContainer).scrollToElement(control, 0);
    }
}

/**
 * Opens one entry and brings it to the top of the view.
 *
 * The panel is expanded FIRST and scrolled to second: the header is already in the DOM either way,
 * so the scroll lands on the entry whether or not the re-rendering the expansion schedules has
 * happened yet. A scalar entry has no panel - its form row is scrolled to as it is. The scroll is
 * confined to the tab's own region (`scrollControlIntoTabView`); it never moves the page.
 */
function revealEntry(entry: MapEntryControls): void {
    if (entry.panel) {
        entry.panel.setExpanded(true);
    }
    const target: EntryControl | undefined = entry.panel ?? entry.controls[0];
    if (target) {
        scrollControlIntoTabView(target as unknown as Control);
    }
}

function buildTable(descriptor: Descriptor, options: DescriptorControlOptions): Table {
    if (descriptor.kind !== "table") {
        throw new Error("buildTable: not a table descriptor");
    }
    return new Table({
        fixedLayout: false,
        // The column labels are the JSON property names on purpose: they are what the same
        // configuration shows in the JSON editor, and the two views must be readable together.
        columns: descriptor.columns.map(column => new Column({
            header: new Text({ text: column }),
            demandPopin: true,
            popinDisplay: "Inline",
            minScreenWidth: "Desktop"
        })),
        items: descriptor.rows.map(row => new ColumnListItem({
            // Compact cells: a cell that cannot be represented gets its reason as a tooltip
            // rather than as a second line of text, which would bury the row it belongs to.
            // A cell is one cell, so a composite field is boxed here - a table cell is not laid
            // out by a ColumnLayout, so no IFormContent rule applies.
            cells: row.map(cell => {
                const built = buildField(cell, options, true);
                return Array.isArray(built) ? new HBox({ items: built }) : built;
            })
        }))
    });
}

function buildField(descriptor: Descriptor, options: DescriptorControlOptions, compact = false): Control | Control[] {
    switch (descriptor.kind) {
        case "switch": {
            const swtch = new Switch({
                state: descriptor.value === true,
                enabled: options.editable,
                change: (event: Switch$ChangeEvent) => {
                    options.onChange(descriptor.pointer, event.getParameter("state"));
                }
            });
            // Two of these switches disclose data when enabled - allow_unmasked_content sends
            // raw conversations to a sink, include_credential_material sends a credential value -
            // and their descriptions say so. Rendering the text here is what keeps that from
            // being a surprise discovered afterwards; `.setTooltip` (not the constructor) because
            // a schema description is not guaranteed free of "{" - see this module's header.
            setDescriptionTooltip(swtch, descriptor.description);
            return swtch;
        }

        case "number": {
            // Read before the value is inspected: narrowing on `descriptor.value` would leave
            // nothing of the union to read `minimum` off in the branch where it is not a number.
            const minimum = typeof descriptor.minimum === "number" ? descriptor.minimum : undefined;
            const maximum = typeof descriptor.maximum === "number" ? descriptor.maximum : undefined;
            // A StepInput defaults to whole-number stepping (step 1, displayValuePrecision 0), which
            // ROUNDS a typed decimal to an integer - so a float field like min_confidence could not
            // accept 0.5 at all. A control must never be stricter than the schema, so a float gets
            // fractional stepping and two-decimal display. `multipleOf`, when the schema declares one
            // (none does today), fixes both step and precision; otherwise a float steps by 0.01 with
            // two decimals shown, enough to type any two-decimal value in [0,1] and a 1.x multiplier.
            let step = 1;
            let displayValuePrecision = 0;
            if (!descriptor.integer) {
                if (typeof descriptor.multipleOf === "number" && descriptor.multipleOf > 0) {
                    step = descriptor.multipleOf;
                    displayValuePrecision = decimalPlaces(descriptor.multipleOf);
                } else {
                    step = 0.01;
                    displayValuePrecision = 2;
                }
            }
            const settings: Record<string, unknown> = {
                // A StepInput has no empty state - its value is a float defaulting to 0 - so an
                // optional integer the document does not carry opens at the schema's own floor.
                // Opening at 0 would show a field with a minimum of 1 sitting below it.
                value: typeof descriptor.value === "number" ? descriptor.value : (minimum ?? 0),
                editable: options.editable,
                step,
                displayValuePrecision,
                change: (event: StepInput$ChangeEvent) => {
                    options.onChange(descriptor.pointer, (event.getSource() as StepInput).getValue());
                }
            };
            // The schema's own bounds, enforced by the control rather than only on save.
            if (minimum !== undefined) {
                settings.min = minimum;
            }
            if (maximum !== undefined) {
                settings.max = maximum;
            }
            const stepInput = new StepInput(settings);
            setDescriptionTooltip(stepInput, descriptor.description);
            return stepInput;
        }

        case "select": {
            // A read-only select is read-only for everyone, on any configuration: it is the
            // discriminator that decides which fields the section around it renders, so it is
            // shown and not offered for editing. See buildItemSection in schemaForm.
            const selectable = options.editable && descriptor.readOnly !== true;
            // A Select's key is a string, so an enum member that is not one - `hybrid.rerank.enabled`
            // chooses between the booleans true/false and the string "auto" - has to travel as its
            // own text and be mapped back on the way out. `optionValues` is that mapping, in
            // `options` order (see schemaForm's `Descriptor`); without it the document would gain
            // the TEXT "true" where reranker.ts compares with `=== true`. An all-string enum carries
            // no `optionValues` at all and takes exactly the path it always did.
            const keys = descriptor.options;
            const values = descriptor.optionValues;
            const select = new Select({
                // Schema-`enum`-constrained (the document gate requires it to be, before the
                // form can even open), never document free text - safe in the constructor.
                // `String` is identity for a string member and the key for any other.
                selectedKey: String(descriptor.value),
                // Both, to match the Input path: `enabled` is what actually stops interaction,
                // `editable` keeps the control's own read-only state consistent with it.
                editable: selectable,
                enabled: selectable,
                items: keys.map(option => new Item({ key: option, text: option })),
                change: (event: Select$ChangeEvent) => {
                    const key = (event.getSource() as Select).getSelectedKey();
                    const index = keys.indexOf(key);
                    options.onChange(descriptor.pointer, values && index !== -1 ? values[index] : key);
                }
            });
            // Why the control cannot be edited outranks what the property means: an
            // administrator looking for a tooltip on a disabled control is asking the first
            // question, not the second.
            setDescriptionTooltip(select, descriptor.readOnly === true ? options.text("formTypeFixed") : descriptor.description);
            return select;
        }

        case "text": {
            const input = new Input({
                editable: options.editable,
                change: (event: InputBase$ChangeEvent) => {
                    const control = event.getSource() as Input;
                    const value = control.getValue();
                    // The schema's own pattern is enforced here, so the form cannot produce
                    // something validateConfiguration would reject on save.
                    if (descriptor.kind === "text" && descriptor.pattern && !new RegExp(descriptor.pattern).test(value)) {
                        control.setValueState("Error");
                        control.setValueStateText(options.text("formPatternMismatch") + " " + descriptor.pattern);
                        return;
                    }
                    // The schema's own length bounds, enforced inline for the same reason as the
                    // pattern: a `minLength: 1` field (sink `site`, most string fields) rejects the
                    // empty string, and the one `maxLength: 40` field (sink `name`) rejects an
                    // over-long one, before save rather than only on it. Not `format` - the backend
                    // compiles Ajv with `validateFormats: false`, so enforcing `uri` here would block
                    // values it accepts, the opposite of letting a field take what the schema allows.
                    if (descriptor.kind === "text" && typeof descriptor.minLength === "number" && value.length < descriptor.minLength) {
                        control.setValueState("Error");
                        control.setValueStateText(options.text("formTooShort") + " " + descriptor.minLength);
                        return;
                    }
                    if (descriptor.kind === "text" && typeof descriptor.maxLength === "number" && value.length > descriptor.maxLength) {
                        control.setValueState("Error");
                        control.setValueStateText(options.text("formTooLong") + " " + descriptor.maxLength);
                        return;
                    }
                    control.setValueState("None");
                    options.onChange(descriptor.pointer, value);
                }
            });
            // `descriptor.value` is a document's own free text - a URL, a path, a name - with no
            // guarantee it is free of "{"; `.setValue`, not the constructor.
            input.setValue(descriptor.value ?? "");
            setDescriptionTooltip(input, descriptor.description);
            return input;
        }

        case "list": {
            const allowed = descriptor.options;
            if (allowed && allowed.length > 0) {
                // The schema constrains the items to an enum, so this is a choice, not free text.
                // Offering the allowed values makes a typo impossible and satisfies `uniqueItems`
                // by construction - neither of which a token field could promise.
                const multiComboBox = new MultiComboBox({
                    width: "100%",
                    editable: options.editable,
                    enabled: options.editable,
                    items: allowed.map(value => new Item({ key: value, text: value })),
                    // The selected subset of the schema's own enum, not document free text - safe
                    // in the constructor, same as `select`'s `selectedKey` above.
                    selectedKeys: descriptor.values,
                    selectionChange: (event: MultiComboBox$SelectionChangeEvent) => {
                        const control = event.getSource() as MultiComboBox;
                        // The changed item is applied from the event rather than trusted to be in
                        // getSelectedKeys() already, and the result is put back in the schema's own
                        // enum order so an unedited value never moves.
                        const changed = event.getParameter("changedItem");
                        const key = changed ? changed.getKey() : undefined;
                        const selected = event.getParameter("selected") === true;
                        const chosen = control.getSelectedKeys().filter(value => value !== key);
                        if (key !== undefined && selected) {
                            chosen.push(key);
                        }
                        options.onChange(descriptor.pointer, allowed.filter(value => chosen.indexOf(value) !== -1));
                    }
                });
                setDescriptionTooltip(multiComboBox, descriptor.description);
                return multiComboBox;
            }
            const multiInput = new MultiInput({
                editable: options.editable,
                width: "100%",
                // MultiInput overrides the inherited default to true, which draws a value-help
                // indicator. Nothing here answers valueHelpRequest, so it would be an affordance
                // that does nothing.
                showValueHelp: false,
                // Free-text values (no schema `enum`, e.g. observability.pseudonymization's
                // org_suffixes/location_gazetteer): each token is built empty and given its
                // key/text through setters, not the constructor - the same reasoning as `Input`
                // above, for the same untrusted-string-into-a-constructor risk (`schemaForm.ts`'s
                // plain-string-array branch renders these as a `list` descriptor with no
                // `options`, reaching this branch directly against the shipped schema).
                tokens: descriptor.values.map(value => {
                    const token = new Token();
                    token.setKey(value);
                    token.setText(value);
                    return token;
                }),
                tokenUpdate: (event: MultiInput$TokenUpdateEvent) => {
                    // tokenUpdate fires before the aggregation settles, so derive the new value
                    // from the event's own added/removed lists rather than reading the tokens.
                    const control = event.getSource() as MultiInput;
                    const current = control.getTokens().map(token => token.getText());
                    const added = (event.getParameter("addedTokens") || []).map(token => token.getText());
                    const removed = (event.getParameter("removedTokens") || []).map(token => token.getText());
                    const next = current
                        .concat(added)
                        .filter((value, index, all) => removed.indexOf(value) === -1 && all.indexOf(value) === index);
                    options.onChange(descriptor.pointer, next);
                }
            });
            // Without a validator a MultiInput NEVER turns typed text into a token: `_validateCurrentText`
            // asks the registered validators what the text should become, and with none registered the
            // answer is nothing at all. The field looked like it took values and dropped every one of
            // them - which is how a hook appended by the [+] became impossible to complete, since its
            // `match` list is exactly this control.
            //
            // The document is written from HERE rather than left to `tokenUpdate` alone. UI5 does raise
            // tokenUpdate for a token a validator produced, and the handler above answers it with the
            // same list this computes (its added/removed derivation is de-duplicated, so seeing the new
            // token in both `getTokens()` and `addedTokens` is harmless) - but the value landing in the
            // document is the whole point of the fix and may not rest on that.
            multiInput.addValidator((args: { text: string }) => {
                const existing = multiInput.getTokens().map(token => token.getText());
                const next = nextTokens(existing, args.text);
                if (!next) {
                    // Empty, whitespace, or already in the list: no token, and the text stays in the
                    // field for the operator to correct rather than vanishing without a word.
                    return null;
                }
                const created = next[next.length - 1];
                // Free text the operator just typed - `.setKey`/`.setText`, never the constructor's
                // settings object. See this module's header.
                const token = new Token();
                token.setKey(created);
                token.setText(created);
                options.onChange(descriptor.pointer, next);
                return token;
            });
            setDescriptionTooltip(multiInput, descriptor.description);
            return multiInput;
        }

        case "raw": {
            // `descriptor.json` is `JSON.stringify` of a document value the schema could not
            // otherwise represent - routinely an object, so routinely a string starting with
            // "{". `descriptor.reason` interpolates the document's own key for an unrecognized
            // property (`No schema defines property "<key>".`). Neither may reach a `Text`
            // through the constructor - see this module's header - so both are set afterward.
            const reasonText = options.text("formUnrepresentable") + " " + descriptor.reason;
            if (compact) {
                const text = new Text();
                text.setText(descriptor.json);
                text.setTooltip(reasonText);
                return text;
            }
            const json = new Text({ wrapping: true });
            json.setText(descriptor.json);
            const reason = new Text({ wrapping: true }).addStyleClass("sapUiTinyMarginTop");
            reason.setText(reasonText);
            return new VBox({ items: [json, reason] });
        }

        case "plugin":
            return options.buildPlugin(descriptor);

        default:
            return new Text({ text: options.text("formUnsupportedNode") });
    }
}
