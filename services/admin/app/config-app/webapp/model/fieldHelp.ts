import { Descriptor } from "./schemaForm";

/**
 * Which descriptors get a visible help affordance, and what text it shows.
 *
 * The schema's `description` has been on the controls since the form shipped, but only as a
 * `setTooltip`: it needs a mouse, it needs a hover long enough to trigger it, and on a touch
 * device it never appears at all - so the text explaining that `allow_unmasked_content` sends
 * raw conversations out of the box was, in practice, unread. `descriptorControls.ts` turns a
 * non-null answer here into an information icon beside the field's label that opens a popover
 * with this text; the tooltip stays where it is, unchanged.
 *
 * This module imports no UI5 (`Descriptor` is a type from a module that imports none either), so
 * the rule below is unit-testable headlessly - see `test/fieldHelp.test.ts`. The icon and the
 * popover are the only part that needs a rendered form.
 */
export interface FieldHelp {
    /** The schema's own words for this field, verbatim. */
    text: string;
}

/**
 * The help for one descriptor, or null when it has none to offer.
 *
 * Exactly one source is ever read: the descriptor's own `description`, which `schemaForm.ts`
 * copies from the schema node and attaches only when the schema has non-empty text (see
 * `withDescription`). A descriptor's VALUE is never read here, which is what keeps a SIEM
 * credential slot - the one descriptor kind carrying something that must not be shown - out of a
 * popover: a `plugin` descriptor carries no description at all and therefore no affordance, and
 * one that did would still show the schema's text and nothing else.
 *
 * A description that is blank rather than absent yields null too. `withDescription` will not
 * attach one, but a schema author could still write `"description": " "`, and an icon that opens
 * an empty popover is worse than no icon: it promises an explanation that is not there.
 *
 * `description` is read off a widened shape because two descriptor kinds - `raw` and `plugin` -
 * do not declare it (see `DescribableDescriptor`), so the union has no common property to read.
 */
export function helpFor(descriptor: Descriptor): FieldHelp | null {
    const description = (descriptor as { description?: unknown }).description;
    if (typeof description !== "string" || description.trim().length === 0) {
        return null;
    }
    // Unmodified: what the schema says is what the popover shows, braces and all.
    return { text: description };
}

/** A description split into its prose and, when it ends with one, a trailing documentation URL. */
export interface HelpTextParts {
    /** The prose to show in the popover body. Never carries the trailing URL. */
    text: string;
    /** The trailing `https?://…` link, when the description ended with one; otherwise absent. */
    url?: string;
}

/**
 * Separates a description's prose from a documentation URL at its very end.
 *
 * Every one of the shortened field descriptions ends with a link to the doc section carrying the
 * detail the popover no longer repeats - typically after a short label ("Details:", "…tuning
 * guide:"). A URL is a single unbroken token, so left in the body it is the one thing that forces
 * the popover to scroll sideways; pulled out here, the caller renders it as a compact `sap.m.Link`
 * instead. Only a URL at the END is a link: one in the middle of a sentence is prose and stays in
 * `text`.
 *
 * The trailing " :" that introduced the URL is dropped so the body does not end on a dangling
 * colon; a label word before it ("guide", "reference") is left in place, reading as the end of the
 * sentence it belongs to. This module imports no UI5, so the rule is unit-tested headlessly.
 */
export function splitHelpText(description: string): HelpTextParts {
    const match = /\s*(https?:\/\/\S+)\s*$/.exec(description);
    if (!match) {
        return { text: description };
    }
    const prose = description.slice(0, match.index).replace(/\s*:\s*$/, "").trimEnd();
    return { text: prose, url: match[1] };
}

/** How many cells one `FormElement` of a `ColumnLayout` is divided into, at either size. */
const ELEMENT_CELLS = 12;

/** The `ColumnElementData` cell counts for the icon and for each field of one helped row. */
export interface HelpRowCells {
    icon: { large: number; small: number };
    field: { large: number; small: number };
}

/**
 * Splits one row's cells between its help icon and the control(s) it explains.
 *
 * `ColumnLayout` gives a `FormElement` 12 cells at either size, but the FIELDS never get all 12 on
 * a large column: the label sits beside them and takes `labelCellsLarge` of the 12, and
 * `emptyCellsLarge` more are held back at the end of the row - so `budgetLarge` is what is left
 * (`12 - labelCellsLarge - emptyCellsLarge`, 8 with the layout's defaults), and it is read off the
 * layout instance rather than assumed here. On a small column the label sits ABOVE the fields and
 * takes none of their cells, so there the budget is all 12.
 *
 * That budget is the whole point of this function. The sizing this replaces spent `min(8, ...)` of
 * a 11-cell budget on the field and one more on the icon: 9 cells asked of a row that has 8, which
 * `ColumnLayout._getFieldSize` answers by breaking the field onto a line of its own underneath -
 * the reported defect. Everything handed out here fits: `n * field.large + icon.large <=
 * budgetLarge` for every `n` a row can realistically hold (see `fieldHelp.test.ts`).
 *
 * The icon takes one cell, two on a small screen where it is a touch target rather than a click
 * target. `ColumnElementData`'s own note is why the fields are sized at all: once ONE field of an
 * element carries explicit sizing, the calculation for the others "might not lead to the expected
 * result", so both ends are stated.
 */
export function helpRowCells(budgetLarge: number, fieldCount: number): HelpRowCells {
    const icon = { large: 1, small: 2 };
    // A helped row always has the control it explains; guarding the divisor keeps a caller that
    // passes none from producing Infinity cells.
    const fields = Math.max(1, fieldCount);
    return {
        icon,
        field: {
            large: Math.max(1, Math.floor((budgetLarge - icon.large) / fields)),
            small: Math.max(1, Math.floor((ELEMENT_CELLS - icon.small) / fields))
        }
    };
}
