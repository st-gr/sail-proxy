import apiConfigSchema from '../webapp/model/apiConfigSchema';
import { groupSections } from '../webapp/model/apiConfigGroups';
import { clearPlugins, pluginFor, registerPlugin } from '../webapp/model/formPlugins';
import { Descriptor, buildDescriptors } from '../webapp/model/schemaForm';
import { helpFor, helpRowCells, splitHelpText } from '../webapp/model/fieldHelp';

/**
 * `helpFor` is the whole decision behind the visible field help: which descriptors get an
 * information affordance next to their label, and what text the popover shows. It is a pure
 * function in a module that imports no UI5, so the rule can be checked here rather than only in
 * a browser - the icon and the popover around it are the part that needs a rendered form.
 *
 * Two properties matter more than the mapping itself:
 *
 * - a descriptor with NO description gets no affordance at all, so nothing on screen offers help
 *   that would then open empty;
 * - the text is the SCHEMA's own words and never a document value. The one descriptor kind that
 *   carries a value worth protecting is `plugin` - a SIEM credential slot - and the tests below
 *   pin that a slot never contributes its value to a popover, with or without a description.
 */
describe('which descriptors get visible field help', () => {
    beforeEach(() => clearPlugins());

    const SIEM_POINTER = '/api_config/observability/siem';
    const CREDENTIAL_PATTERN = '/api_config/observability/siem/sinks/*/*_env';

    /** A switch descriptor, the kind `withDescription` attaches the schema's text to. */
    function switchDescriptor(description?: string): Descriptor {
        const descriptor = { kind: 'switch', pointer: '/a/b', label: 'B', value: true } as Descriptor;
        return description === undefined ? descriptor : ({ ...descriptor, description } as Descriptor);
    }

    it('gives a described field the schema text, unmodified', () => {
        const description = 'RISK - reads raw conversations.';
        expect(helpFor(switchDescriptor(description))).toEqual({ text: description });
    });

    // The mutation-checkable half of the rule: no description, no affordance. An implementation
    // that returned an empty help object here would put an icon on every field in the form, each
    // opening a blank popover.
    it('gives a field with no description no affordance at all', () => {
        expect(helpFor(switchDescriptor())).toBeNull();
    });

    it('gives a field whose description is empty or blank no affordance either', () => {
        expect(helpFor(switchDescriptor(''))).toBeNull();
        expect(helpFor(switchDescriptor('   \n\t '))).toBeNull();
    });

    // A schema author's own words routinely contain "{" - `param_renames` ships a literal JSON
    // example in its description - and the text is handed to the popover verbatim, braces and
    // all, exactly as it reaches the control's tooltip today.
    it('passes a description containing binding-like braces through untouched', () => {
        const description = 'Renames, e.g. {"max_tokens":"max_completion_tokens"}.';
        expect(helpFor(switchDescriptor(description))?.text).toBe(description);
    });

    // A credential slot's descriptor is built before its schema is resolved and carries no
    // description (see `buildNode`'s rule 1), so it gets no help - and above all, the value it
    // would carry is never what the popover would show.
    it('never offers a credential slot value as help', () => {
        const slot = {
            kind: 'plugin',
            pointer: `${SIEM_POINTER}/sinks/0/api_key_env`,
            label: 'api_key_env',
            plugin: 'credential',
            value: 'SIEM_DATADOG_API_KEY_SECRET_VALUE'
        } as unknown as Descriptor;
        expect(helpFor(slot)).toBeNull();
    });

    it('shows the schema text for a credential slot that does carry one, never the slot value', () => {
        const slot = {
            kind: 'plugin',
            pointer: `${SIEM_POINTER}/sinks/0/api_key_env`,
            label: 'api_key_env',
            plugin: 'credential',
            value: 'SIEM_DATADOG_API_KEY_SECRET_VALUE',
            description: 'The environment variable the sink reads its API key from.'
        } as unknown as Descriptor;
        expect(helpFor(slot)).toEqual({ text: 'The environment variable the sink reads its API key from.' });
    });

    /**
     * The same rule over the descriptors the shipped schema actually produces, so a change to
     * `withDescription` - or to the schema's own texts - is caught here and not only in a browser.
     */
    describe('over the descriptors the shipped siem schema produces', () => {
        const siemData = {
            enabled: true,
            batch_size: 100,
            categories: ['security', 'audit'],
            sinks: [
                {
                    name: 'datadog',
                    type: 'datadog',
                    enabled: false,
                    site: 'datadoghq.com',
                    api_key_env: 'SIEM_DATADOG_API_KEY',
                    allow_unmasked_content: false
                }
            ]
        };

        function siemDescriptors(): Descriptor[] {
            const section = groupSections(apiConfigSchema, 'observability').find(s => s.key === 'siem');
            if (!section) {
                throw new Error('observability has no siem section - groupSections regressed');
            }
            return buildDescriptors(section.schema, siemData, section.pointer, pluginFor);
        }

        function sinkChildren(): Descriptor[] {
            const sinks = siemDescriptors().find(d => d.pointer === `${SIEM_POINTER}/sinks`);
            if (!sinks || sinks.kind !== 'section' || sinks.children[0].kind !== 'section') {
                throw new Error('siem/sinks is no longer a section of sections');
            }
            return sinks.children[0].children;
        }

        it('offers the risk description of allow_unmasked_content as its help text', () => {
            const field = sinkChildren().find(d => d.pointer.endsWith('/allow_unmasked_content'));
            if (!field) {
                throw new Error('the datadog sink no longer renders allow_unmasked_content');
            }
            const help = helpFor(field);
            expect(help).not.toBeNull();
            // The schema's own words, not a paraphrase of them.
            expect(help?.text).toBe((field as { description?: string }).description);
            expect(help?.text).toContain('RISK - reads raw conversations.');
        });

        it('offers no help on the credential slot, whose value the document does carry', () => {
            registerPlugin(CREDENTIAL_PATTERN, 'credential');
            const slot = sinkChildren().find(d => d.pointer.endsWith('/api_key_env'));
            expect(slot).toMatchObject({ kind: 'plugin', plugin: 'credential' });
            expect(helpFor(slot as Descriptor)).toBeNull();
        });
    });
});

/**
 * `splitHelpText` pulls the trailing documentation URL out of a description so the popover renders
 * it as a compact link instead of letting the one unbroken token force a horizontal scrollbar. The
 * rule is only "a URL at the very END is a link": one in the middle of a sentence is prose.
 */
describe('splitHelpText separates a trailing doc URL from the prose', () => {
    const URL = 'https://github.com/st-gr/sail-proxy/blob/main/docs/developer/chapter-3-gateway.md#keys';

    it('splits a description that ends with a URL', () => {
        const result = splitHelpText(`Settings for each provider. Per-provider keys: ${URL}`);
        expect(result.url).toBe(URL);
        // The introducing " :" is dropped so the body does not end on a dangling colon.
        expect(result.text).toBe('Settings for each provider. Per-provider keys');
    });

    it('keeps a trailing label word before the URL in the prose', () => {
        const result = splitHelpText(`Full detail is in the tuning guide: ${URL}`);
        expect(result.url).toBe(URL);
        expect(result.text).toBe('Full detail is in the tuning guide');
    });

    it('returns the whole description as text when there is no URL', () => {
        const description = 'A plain field description with no link at all.';
        expect(splitHelpText(description)).toEqual({ text: description });
    });

    it('does NOT split a URL that sits mid-sentence', () => {
        const description = `See ${URL} for the full list, plus the notes below it.`;
        expect(splitHelpText(description)).toEqual({ text: description });
    });

    it('tolerates trailing whitespace after the URL', () => {
        const result = splitHelpText(`Modes: ${URL}\n`);
        expect(result.url).toBe(URL);
        expect(result.text).toBe('Modes');
    });
});

/**
 * The cell arithmetic behind a helped row, which is where the icon broke the layout.
 *
 * `ColumnLayout` gives one `FormElement` 12 cells, but on a large column the LABEL sits beside the
 * fields and takes `labelCellsLarge` of them (4 by default) with `emptyCellsLarge` more held back
 * at the end - so the fields have 8 between them, not 12. The sizing this replaces handed the one
 * control of an ordinary field `min(8, floor((12 - 1) / 1))` = 8 cells and the icon 1 more: 9 cells
 * asked of a row that has 8. `ColumnLayout._getFieldSize` answers that by breaking the control onto
 * a line of its own beneath the label, which is exactly what the owner saw.
 *
 * So the property that matters is not any particular number but that the row's total FITS, at every
 * field count a row can carry - a credential slot is four fields plus the icon. Every assertion
 * below is written that way, and each of them fails if the old `min(8, ...)` is put back.
 */
describe('how a helped row divides its cells', () => {
    /** What `ColumnLayout`'s own defaults leave the fields on a large column: 12 - 4 label - 0 empty. */
    const DEFAULT_BUDGET_LARGE = 8;

    /**
     * The whole invariant, at every field count a form row realistically holds: one control, a
     * control and its [-], and up to the four of a credential slot - and past them, to the point
     * where one cell each is all that is left to give.
     */
    it.each([1, 2, 3, 4, 5, 6, 7])('fits %i field(s) and the icon into the large budget', fields => {
        const cells = helpRowCells(DEFAULT_BUDGET_LARGE, fields);
        expect(cells.field.large * fields + cells.icon.large).toBeLessThanOrEqual(DEFAULT_BUDGET_LARGE);
        // Not by starving the fields: every one of them keeps a cell to render in.
        expect(cells.field.large).toBeGreaterThanOrEqual(1);
    });

    // On a small column the label is ABOVE the fields and takes none of their cells, so all 12 are
    // theirs - and the icon takes two there, being a touch target rather than a click target.
    it.each([1, 2, 3, 4, 5])('fits %i field(s) and the icon into the 12 cells of a small row', fields => {
        const cells = helpRowCells(DEFAULT_BUDGET_LARGE, fields);
        expect(cells.icon.small).toBe(2);
        expect(cells.field.small * fields + cells.icon.small).toBeLessThanOrEqual(12);
        expect(cells.field.small).toBeGreaterThanOrEqual(1);
    });

    // Fitting is not enough on its own - returning one cell per field would fit too, and leave an
    // Input a sliver wide. What is left over must be less than one more cell each.
    it.each([1, 2, 3])('leaves no room it could have given to the %i field(s)', fields => {
        const cells = helpRowCells(DEFAULT_BUDGET_LARGE, fields);
        const spare = DEFAULT_BUDGET_LARGE - cells.icon.large - cells.field.large * fields;
        expect(spare).toBeLessThan(fields);
    });

    // The ordinary case, stated as the number it is: label 4, icon 1, control 7 - the control keeps
    // the left edge it has on a row with no help and gives up its last cell to the icon.
    it('gives the single control of an ordinary field 7 of the 8 cells beside the label', () => {
        expect(helpRowCells(DEFAULT_BUDGET_LARGE, 1)).toEqual({
            icon: { large: 1, small: 2 },
            field: { large: 7, small: 10 }
        });
    });

    // The budget is the layout's answer, not a constant: a wider label (or cells held back at the
    // end of the row) leaves less, and the fields have to shrink with it rather than overflow.
    it('divides whatever budget the layout reports, not a fixed 8', () => {
        expect(helpRowCells(6, 1).field.large).toBe(5);
        expect(helpRowCells(10, 3).field.large).toBe(3);
    });

    // A budget too small to divide is not a reason to render a zero-cell control: the row then
    // wraps, which is visible, rather than the field vanishing, which is not.
    it('keeps a cell for the field even where the budget cannot cover the row', () => {
        expect(helpRowCells(1, 1).field.large).toBe(1);
        expect(helpRowCells(8, 0).field.large).toBeGreaterThanOrEqual(1);
    });
});
