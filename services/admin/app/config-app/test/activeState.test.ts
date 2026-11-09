import { activeState } from '../webapp/model/activeState';

const loaded = { editorLoaded: true, unsavedEdits: false };
const dirty = { editorLoaded: true, unsavedEdits: true };
const loading = { editorLoaded: false, unsavedEdits: false };

// The open detail follows its row's isActive (plan Decision 3): the read-only strip in both views,
// the editor, Save and the title-bar Activate all come from this one rule, in both directions.
describe('activeState: the open configuration\'s detail', () => {
  it('an active configuration is read-only: strip shown, editor and Save off, no Activate', () => {
    expect(activeState(true, loaded)).toEqual({
      readOnly: true,
      editorEditable: false,
      canSave: false,
      canActivate: false,
      activateAsksFirst: false
    });
  });

  it('an inactive configuration is editable once its document is in the editor', () => {
    expect(activeState(false, loaded)).toEqual({
      readOnly: false,
      editorEditable: true,
      canSave: true,
      canActivate: true,
      activateAsksFirst: false
    });
  });

  it('inactive -> active (Activate of the open one): the editor and Save go read-only', () => {
    const before = activeState(false, loaded);
    const after = activeState(true, loaded);
    expect([before.editorEditable, before.canSave, before.readOnly]).toEqual([true, true, false]);
    expect([after.editorEditable, after.canSave, after.readOnly]).toEqual([false, false, true]);
  });

  it('active -> inactive (another one activated, or a rollback): the editor and Save come back', () => {
    const after = activeState(false, loaded);
    expect([after.editorEditable, after.canSave, after.readOnly, after.canActivate]).toEqual([true, true, false, true]);
  });

  it('keeps the editor read-only while it still holds another configuration\'s document', () => {
    const state = activeState(false, loading);
    expect(state.editorEditable).toBe(false);
    // Whether it may be saved is the row's own state; the strip follows the row at once.
    expect([state.readOnly, state.canSave]).toEqual([false, true]);
  });

  it('asks before activating an open configuration with unsaved edits: activation takes the stored one', () => {
    expect(activeState(false, dirty).activateAsksFirst).toBe(true);
    expect(activeState(false, loaded).activateAsksFirst).toBe(false);
  });

  it('never asks for an active configuration, which has nothing to activate', () => {
    expect(activeState(true, dirty)).toEqual(expect.objectContaining({ canActivate: false, activateAsksFirst: false }));
  });

  it('keeps unsaved edits of a configuration that turned active, without offering to save them', () => {
    // The edits are not thrown away (the controls keep them); they just cannot be saved any more.
    const state = activeState(true, dirty);
    expect([state.readOnly, state.editorEditable, state.canSave]).toEqual([true, false, false]);
  });
});
