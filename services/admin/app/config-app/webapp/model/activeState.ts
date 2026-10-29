/**
 * What the open configuration's detail allows, from whether that configuration is active.
 *
 * Activating a configuration, rolling back, or another configuration's activation can change the
 * open configuration's `isActive` while its detail is on screen. Every part of the detail that
 * depends on it - the read-only strip (JSON view and form view), the JSON editor's editability,
 * Save, the title-bar Activate - is derived here, in one place, so it is the same rule at load and
 * after every change, in both directions.
 *
 * It lives here rather than in the controller because this repo's jest cannot resolve `sap/*`,
 * and a rule written inside a module that imports it cannot be unit-tested.
 */

/** The open detail's edit state, beside the row's own `isActive`. */
export interface DetailEdits {
    /**
     * The JSON editor holds the open configuration's own document. Until its read has answered the
     * editor still shows the previous configuration's, which must not be editable under this one.
     */
    editorLoaded: boolean;
    /** The editor or the form holds edits that are not saved yet. */
    unsavedEdits: boolean;
}

export interface ActiveState {
    /** The configuration is read-only: the strip shows in both views (viewModel `/selectedConfigIsActive`). */
    readOnly: boolean;
    /** The JSON editor takes edits, and its Cancel and Save are shown (viewModel `/isEditMode`). */
    editorEditable: boolean;
    /** Save may store the editor's document (Save's `enabled`, and its guard). */
    canSave: boolean;
    /** The title bar offers Activate for it. */
    canActivate: boolean;
    /**
     * Activating it has to ask about the unsaved edits first: activation takes the stored
     * document, so they would silently not be part of what is activated.
     */
    activateAsksFirst: boolean;
}

/** The open configuration's detail state, from its row's `isActive` and the detail's edits. */
export function activeState(isActive: boolean, edits: DetailEdits): ActiveState {
    return {
        readOnly: isActive,
        editorEditable: !isActive && edits.editorLoaded,
        canSave: !isActive,
        canActivate: !isActive,
        activateAsksFirst: !isActive && edits.unsavedEdits
    };
}
