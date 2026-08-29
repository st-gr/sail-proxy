/**
 * How tall the form's scrolling region may be.
 *
 * The whole form lives inside the detail `sap.f.DynamicPage`'s `DynamicPageHeader` (see
 * `view/ConfigForm.fragment.xml`'s own header for why it has to). A header that is taller than the
 * page makes `preserveHeaderStateOnScroll` moot - DynamicPage disregards it and scrolls the header
 * away with the rest of the page, taking the tab bar with it - so nothing inside the header can be
 * made sticky from the outside. The fix is the other direction: bound the form so the page has
 * nothing left to scroll, and let the section panels scroll INSIDE each tab instead
 * (`ConfigFormTabs.buildTab`). The tab strip, the page title's Save/Cancel and the read-only banner
 * then stay put because they sit outside that region.
 *
 * The height is emitted as `calc(100vh - <offset>px)` rather than a measured pixel height on
 * purpose: only the offset - how much chrome sits ABOVE the scrolling region - is measured, and it
 * does not change when the window is resized in a top-anchored layout. The viewport half stays a
 * live CSS unit, so a resized window re-sizes the region with no listener and no re-measurement.
 *
 * This module is deliberately free of `sap/*` imports so the arithmetic is testable: jest in this
 * repo cannot resolve the UI5 runtime (see `test/configFormTabs.test.ts`'s header).
 */

/**
 * What is left below the scrolling region.
 *
 * Not decoration: the region's measured top cannot see what sits UNDER it - the tab bar's own
 * content padding, the `DynamicPageHeader`'s and the form `Panel`'s bottom padding. Reserving less
 * than those add up to gives the page a few pixels to scroll, and a `DynamicPage` with anything at
 * all to scroll takes the header (and with it the tab strip) away again, which is the whole defect.
 * 2rem at the default content density covers them with room to spare; over-reserving costs a sliver
 * of unused height, under-reserving costs the fix.
 */
export const FORM_SCROLL_BOTTOM_GAP = 32;

/**
 * The shortest the scrolling region may become. A form squeezed below this is unusable, so past
 * this point the region is allowed to overflow the viewport and the page scrolls again - which is
 * still the better of the two, and only reachable on a window too short to show a form at all.
 */
export const FORM_SCROLL_MIN_HEIGHT = 240;

/**
 * The height used until the region has a DOM node to measure, and whenever it has none. Sized for
 * the chrome that is always there (shell bar, page title, the form panel's own header toolbar, the
 * banners and the tab strip); the measured value replaces it on the first rendering.
 *
 * Brace-free by construction, so it is safe to pass through a control's settings object - see
 * `descriptorControls`'s note on UI5's complex-binding parser.
 */
export const FORM_SCROLL_FALLBACK_HEIGHT = "calc(100vh - 18rem)";

/**
 * The prefix of the id `ConfigFormTabs.buildTabScroll` gives each tab's `sap.m.ScrollContainer`
 * (`configFormTabScroll-<group>`). It is the one region a reveal is allowed to move: the tab strip,
 * the page title and the banners sit OUTSIDE it, and moving anything else - the document above all -
 * is the scroll regression this identifies the right container to avoid.
 */
export const TAB_SCROLL_ID_PREFIX = "configFormTabScroll-";

/**
 * The minimum a control has to expose for {@link tabScrollAncestor} to walk up to its tab region:
 * its id, whether it is a given UI5 type, and its parent. `sap.ui.core.Control` satisfies this, and
 * a plain object does too - which is what lets the walk be tested without the `sap/*` runtime this
 * module deliberately does without.
 */
export interface ScrollAncestorNode {
    getId(): string;
    isA(typeName: string): boolean;
    getParent(): ScrollAncestorNode | null | undefined;
}

/**
 * Walks up from a control to the `sap.m.ScrollContainer` that is its enclosing tab scrolling region,
 * or null when there is none on the path to the root.
 *
 * The match is BOTH the type and the `configFormTabScroll-` id prefix, on purpose: a table sits in
 * its own inner horizontal `sap.m.ScrollContainer` (`descriptorControls` builds one so a wide table
 * scrolls sideways), so "the first ScrollContainer above me" is not necessarily the tab region. The
 * id prefix names the vertical, per-tab one specifically.
 *
 * Returning null - rather than falling back to the document - is deliberate: a reveal that cannot
 * find its tab region does not scroll at all, because the alternative (`Element.scrollIntoView`, or
 * a `window` scroll) moves the whole master-detail page, which is exactly the regression this fix
 * removes. For a section this cannot happen; the null branch only guards against a caller that is
 * handed a control outside any tab.
 */
export function tabScrollAncestor(node: ScrollAncestorNode | null | undefined): ScrollAncestorNode | null {
    let current: ScrollAncestorNode | null | undefined = node;
    while (current) {
        if (current.isA("sap.m.ScrollContainer") && current.getId().indexOf(TAB_SCROLL_ID_PREFIX) === 0) {
            return current;
        }
        current = current.getParent();
    }
    return null;
}

/**
 * How many pixels of the viewport are spoken for above (and below) the scrolling region.
 *
 * `top` is the region's own distance from the top of the viewport, which already accounts for every
 * variable piece of chrome above it - one banner or two, a wrapped title - without any of them
 * having to be enumerated here.
 *
 * Clamped so the region keeps `minHeight`: a `top` large enough to leave less than that (a very
 * short window, every banner showing) would otherwise produce a zero-height or negative-height
 * region, i.e. a form that renders as nothing at all. A viewport height that is not known
 * (0, NaN - `window.innerHeight` before layout) skips the clamp rather than guessing at one.
 */
export function formScrollOffset(
    top: number,
    viewportHeight: number,
    gap: number = FORM_SCROLL_BOTTOM_GAP,
    minHeight: number = FORM_SCROLL_MIN_HEIGHT
): number {
    const wanted = Math.round(positive(top) + positive(gap));
    const viewport = positive(viewportHeight);
    if (viewport === 0) {
        return wanted;
    }
    return Math.min(wanted, Math.max(0, Math.round(viewport - positive(minHeight))));
}

/**
 * The same offset as a CSS height for the scrolling region: `calc(100vh - <offset>px)`, or plain
 * `100vh` when nothing sits above it. `sap.ui.core.CSSSize` accepts `calc()`, which is what lets
 * the viewport half stay live.
 */
export function formScrollHeight(
    top: number,
    viewportHeight: number,
    gap: number = FORM_SCROLL_BOTTOM_GAP,
    minHeight: number = FORM_SCROLL_MIN_HEIGHT
): string {
    const offset = formScrollOffset(top, viewportHeight, gap, minHeight);
    return offset === 0 ? "100vh" : `calc(100vh - ${offset}px)`;
}

/** A finite, non-negative reading of a measurement, or 0. */
function positive(value: number): number {
    return Number.isFinite(value) && value > 0 ? value : 0;
}
