import { anchoredFirstRow, type Entry, type Order } from "../model/liveLog";
import { isAtBottom } from "../model/logFormat";

/**
 * Following the newest entries in the Gateway Log table. Newest last: the view stays at the bottom
 * while the last row is visible and pauses once the person scrolls up; then rows dropped or inserted
 * above keep the same entry at the top. The first visible row the page sets itself is remembered, so
 * the table's event for it is not read as the person scrolling. The arithmetic is in model/. No UI5
 * imports (the table is the part of sap.ui.table.Table it uses), so it runs under jest.
 */
export interface TableLike {
    getRows(): unknown[];
    getFirstVisibleRow(): number;
    setFirstVisibleRow(index: number): unknown;
}

export default class TableFollower {
    public following = true;
    private expectedFirstRow = -1;

    constructor(
        private readonly table: () => TableLike,
        private readonly order: () => Order,
        private readonly setNewBelow: (value: boolean) => void,
        /** Called when following switches on or off (the status line says it in words). */
        private readonly followingChanged: () => void = () => undefined
    ) {}

    private setFollowing(value: boolean): void {
        if (this.following === value) return;
        this.following = value;
        this.followingChanged();
    }

    private visibleRows(): number {
        return Math.max(1, this.table().getRows().length);
    }

    private setFirstRow(index: number): void {
        // The table fires no event for the row it already shows: nothing to wait for then.
        if (this.table().getFirstVisibleRow() === index) {
            this.expectedFirstRow = -1;
            return;
        }
        this.expectedFirstRow = index;
        this.table().setFirstVisibleRow(index);
    }

    /** Newest last: the last row comes into view and following resumes. Newest first: the top. */
    public scrollToNewest(length: number): void {
        this.setFollowing(true);
        this.setNewBelow(false);
        this.setFirstRow(this.order() === "newestLast" ? Math.max(0, length - this.visibleRows()) : 0);
    }

    /** After a poll changed the rows: follow, or keep the reader's place. */
    public afterMerge(before: Entry[], firstBefore: number, after: Entry[], added: number): void {
        if (this.order() === "newestLast" && this.following) {
            this.scrollToNewest(after.length);
            return;
        }
        if (firstBefore > 0) this.setFirstRow(anchoredFirstRow(before, firstBefore, after));
        if (this.order() === "newestLast" && added > 0) this.setNewBelow(true);
    }

    public onFirstVisibleRowChanged(first: number, length: number): void {
        const ours = first === this.expectedFirstRow;
        this.expectedFirstRow = -1;
        if (ours || this.order() !== "newestLast") return;
        this.setFollowing(isAtBottom(first, this.visibleRows(), length));
        if (this.following) this.setNewBelow(false);
    }
}
