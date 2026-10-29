/**
 * Who each action of the configuration list acts on.
 *
 * The list has two selections that must never be mixed up. The ticked rows (the table's
 * checkboxes) are what the toolbar's Delete, Duplicate and Activate act on. The open row (the one
 * pressed, shown in the detail column and marked as navigated) is what the detail's own actions -
 * Save, and its title-bar Activate and Duplicate - act on. Pressing a row never ticks it and
 * ticking a row never opens it, so a toolbar action can only reach a row the user ticked.
 *
 * It lives here rather than in the controller because this repo's jest cannot resolve `sap/*`,
 * and a rule written inside a module that imports it cannot be unit-tested.
 */

/** The fields of an ApiConfigurations row these rules read. */
export interface ConfigRow {
    ID: string;
    isActive: boolean;
    isValid?: boolean | null;
}

export interface SelectionState {
    /** The ticked rows Delete removes; Delete is offered only while `canDelete`. */
    deleteIds: string[];
    /**
     * At least one row is ticked and none of them is active. The service refuses to delete an
     * active configuration (`DELETE ... where: 'isActive = false'`), so a selection holding one
     * would end in a partial delete and a generic "forbidden" - Delete is off instead, exactly as
     * it already is for a single ticked active row.
     */
    canDelete: boolean;
    /** Delete removes the open configuration, so the detail column closes with it. */
    deleteClosesDetail: boolean;
    /** The one ticked row Duplicate copies, or null (nothing or several ticked). */
    duplicateId: string | null;
    /**
     * The copy takes the open editor's text (possibly unsaved) only when the ticked row is the open
     * one; any other ticked row is copied from its own stored document.
     */
    duplicateFromEditor: boolean;
    /** The one ticked row Activate activates: exactly one, inactive and valid. Otherwise null. */
    activateId: string | null;
    /** The open configuration can be saved: it exists and is not active. Ticked rows play no part. */
    canSave: boolean;
}

/** Whether the open configuration may be saved; judged by that row alone. */
export function canSave(open: ConfigRow | null): boolean {
    return open !== null && open.isActive !== true;
}

/** What each list action acts on, from the ticked rows and the open row (null when none is open). */
export function selectionState(ticked: ConfigRow[], open: ConfigRow | null): SelectionState {
    const ids = ticked.map((row) => row.ID);
    const one = ticked.length === 1 ? ticked[0] : null;
    const openId = open?.ID ?? null;
    return {
        deleteIds: ids,
        canDelete: ticked.length > 0 && ticked.every((row) => row.isActive !== true),
        deleteClosesDetail: openId !== null && ids.includes(openId),
        duplicateId: one?.ID ?? null,
        duplicateFromEditor: one !== null && one.ID === openId,
        activateId: one !== null && one.isActive !== true && one.isValid === true ? one.ID : null,
        canSave: canSave(open)
    };
}
