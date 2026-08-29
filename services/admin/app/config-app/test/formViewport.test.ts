import {
    FORM_SCROLL_BOTTOM_GAP,
    FORM_SCROLL_FALLBACK_HEIGHT,
    FORM_SCROLL_MIN_HEIGHT,
    ScrollAncestorNode,
    TAB_SCROLL_ID_PREFIX,
    formScrollHeight,
    formScrollOffset,
    tabScrollAncestor
} from '../webapp/model/formViewport';

/**
 * The arithmetic behind the form's scrolling region (`ConfigFormTabs.buildTab` wraps each tab's
 * section panels in a `sap.m.ScrollContainer` sized by it). The control side is not exercised here
 * for the usual reason - jest in this repo cannot resolve `sap/*`, see `configFormTabs.test.ts`'s
 * own header - which is exactly why the arithmetic lives in a module with no UI5 imports.
 */
describe('the form scrolling region\'s height', () => {
    describe('formScrollOffset', () => {
        it('reserves what sits above the region, plus the bottom gap', () => {
            expect(formScrollOffset(280, 900)).toBe(280 + FORM_SCROLL_BOTTOM_GAP);
        });

        it('rounds a fractional measurement - getBoundingClientRect returns one', () => {
            expect(formScrollOffset(280.4, 900, 0)).toBe(280);
            expect(formScrollOffset(280.6, 900, 0)).toBe(281);
        });

        it('never leaves the region shorter than the minimum height', () => {
            // 800 + gap would leave 92px of a 900px window; the clamp keeps FORM_SCROLL_MIN_HEIGHT.
            expect(formScrollOffset(800, 900)).toBe(900 - FORM_SCROLL_MIN_HEIGHT);
        });

        it('does not clamp while the region still fits', () => {
            expect(formScrollOffset(600, 900, 0)).toBe(600);
            expect(900 - formScrollOffset(600, 900, 0)).toBeGreaterThanOrEqual(FORM_SCROLL_MIN_HEIGHT);
        });

        it('gives the whole viewport to a window too short for the minimum', () => {
            expect(formScrollOffset(120, 200)).toBe(0);
        });

        it('skips the clamp when the viewport height is not known yet', () => {
            expect(formScrollOffset(280, 0)).toBe(280 + FORM_SCROLL_BOTTOM_GAP);
            expect(formScrollOffset(280, Number.NaN)).toBe(280 + FORM_SCROLL_BOTTOM_GAP);
        });

        it('treats an unmeasurable or negative top as no chrome above', () => {
            expect(formScrollOffset(Number.NaN, 900, 0)).toBe(0);
            expect(formScrollOffset(-40, 900, 0)).toBe(0);
        });

        it('honours explicit gap and minimum overrides', () => {
            expect(formScrollOffset(100, 900, 40)).toBe(140);
            expect(formScrollOffset(800, 900, 0, 400)).toBe(500);
        });
    });

    describe('formScrollHeight', () => {
        it('keeps the viewport half live so a resize needs no listener', () => {
            expect(formScrollHeight(280, 900)).toBe(`calc(100vh - ${280 + FORM_SCROLL_BOTTOM_GAP}px)`);
        });

        it('drops the calc() when nothing sits above the region', () => {
            expect(formScrollHeight(0, 900, 0)).toBe('100vh');
            expect(formScrollHeight(120, 200)).toBe('100vh');
        });

        it('emits a CSSSize UI5 accepts - calc() of a viewport unit and a pixel offset', () => {
            expect(formScrollHeight(311.5, 1080)).toMatch(/^calc\(100vh - \d+px\)$/);
        });

        it('never emits a height that would render the region away', () => {
            const height = formScrollHeight(2000, 900);
            expect(height).toBe(`calc(100vh - ${900 - FORM_SCROLL_MIN_HEIGHT}px)`);
        });
    });

    describe('tabScrollAncestor - the region a reveal is confined to', () => {
        // A minimal stand-in for a control: the walk reads only id, type and parent, so a plain
        // object is enough - and is why the traversal lives in this sap/*-free module (see header).
        const node = (opts: {
            id?: string;
            scrollContainer?: boolean;
            parent?: ScrollAncestorNode | null;
        }): ScrollAncestorNode => ({
            getId: () => opts.id ?? '',
            isA: (typeName: string) => typeName === 'sap.m.ScrollContainer' && opts.scrollContainer === true,
            getParent: () => opts.parent ?? null
        });

        it('walks up to the tab ScrollContainer identified by its id prefix', () => {
            const tab = node({ id: `${TAB_SCROLL_ID_PREFIX}platform`, scrollContainer: true });
            const panel = node({ id: 'section-panel', parent: tab });
            const field = node({ id: 'a-field', parent: panel });
            expect(tabScrollAncestor(field)).toBe(tab);
        });

        it('returns the target itself when it is already the tab region', () => {
            const tab = node({ id: `${TAB_SCROLL_ID_PREFIX}models`, scrollContainer: true });
            expect(tabScrollAncestor(tab)).toBe(tab);
        });

        it('skips an inner horizontal ScrollContainer - a table wrapper is not the tab region', () => {
            // A wide table sits in its own sap.m.ScrollContainer; it is a ScrollContainer but has no
            // tab-region id, so the walk must pass through it to the tab region above.
            const tab = node({ id: `${TAB_SCROLL_ID_PREFIX}providers`, scrollContainer: true });
            const tableScroll = node({ id: 'some-generated-id', scrollContainer: true, parent: tab });
            const cell = node({ id: 'a-cell', parent: tableScroll });
            expect(tabScrollAncestor(cell)).toBe(tab);
        });

        it('returns null when no tab region is on the path to the root', () => {
            const root = node({ id: 'detail-page' });
            const leaf = node({ id: 'stray-control', parent: root });
            expect(tabScrollAncestor(leaf)).toBeNull();
        });

        it('does not match a ScrollContainer whose id lacks the tab prefix', () => {
            const other = node({ id: 'configFormOtherScroll-x', scrollContainer: true });
            expect(tabScrollAncestor(other)).toBeNull();
        });

        it('treats null and undefined as nothing to scroll', () => {
            expect(tabScrollAncestor(null)).toBeNull();
            expect(tabScrollAncestor(undefined)).toBeNull();
        });
    });

    describe('the fallback used before the region has a DOM node', () => {
        it('carries no brace, so it is safe in a control settings object', () => {
            // Every string in a settings object goes through UI5's complex-binding parser the
            // moment it contains "{" - see descriptorControls' own note.
            expect(FORM_SCROLL_FALLBACK_HEIGHT).not.toContain('{');
        });

        it('is a viewport-relative calc(), not a fixed pixel height', () => {
            expect(FORM_SCROLL_FALLBACK_HEIGHT).toMatch(/^calc\(100vh - [\d.]+rem\)$/);
        });
    });
});
