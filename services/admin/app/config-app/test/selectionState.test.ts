import { canSave, selectionState, ConfigRow } from '../webapp/model/selectionState';

const row = (ID: string, isActive = false, isValid = true): ConfigRow => ({ ID, isActive, isValid });
const A = row('A');
const B = row('B');
const C = row('C');
const activeB = row('B', true);
const activeC = row('C', true);

// The five wrong-target defects of the shared press/tick state (plan Finding 1). Each case is the
// user's sequence: which row is open in the detail, which rows are ticked.
describe('selectionState: the five wrong-target defects', () => {
  it('1. Duplicate with A open and B ticked copies B from its stored document, not A\'s editor', () => {
    const state = selectionState([B], A);
    expect(state.duplicateId).toBe('B');
    expect(state.duplicateFromEditor).toBe(false);
  });

  it('2. Delete with B and C ticked and A open deletes B and C and leaves A open', () => {
    const state = selectionState([B, C], A);
    expect(state.deleteIds).toEqual(['B', 'C']);
    expect(state.canDelete).toBe(true);
    expect(state.deleteClosesDetail).toBe(false);
  });

  it('3. Save on an open inactive A is judged by A, whatever is ticked', () => {
    expect(selectionState([activeB], A).canSave).toBe(true);
    expect(selectionState([B], activeB).canSave).toBe(false);
  });

  it('4. Activate with A open and B ticked activates B; with nothing ticked it activates nothing', () => {
    expect(selectionState([B], A).activateId).toBe('B');
    expect(selectionState([], A).activateId).toBeNull();
  });

  it('5. Delete is off while any ticked row is active, as the service refuses to delete it', () => {
    expect(selectionState([B, activeC], A).canDelete).toBe(false);
    expect(selectionState([activeB], null).canDelete).toBe(false);
  });
});

describe('selectionState: the toolbar with no row open', () => {
  it('offers nothing while nothing is ticked', () => {
    expect(selectionState([], null)).toEqual({
      deleteIds: [],
      canDelete: false,
      deleteClosesDetail: false,
      duplicateId: null,
      duplicateFromEditor: false,
      activateId: null,
      canSave: false
    });
  });

  it('acts on ticked rows without any row being open', () => {
    const state = selectionState([B], null);
    expect([state.canDelete, state.duplicateId, state.duplicateFromEditor, state.activateId]).toEqual([true, 'B', false, 'B']);
  });
});

describe('selectionState: the open row among the ticked ones', () => {
  it('duplicates the open row from the editor, which may hold unsaved edits', () => {
    expect(selectionState([A], A)).toMatchObject({ duplicateId: 'A', duplicateFromEditor: true });
  });

  it('closes the detail when Delete removes the open row', () => {
    expect(selectionState([A, B], A).deleteClosesDetail).toBe(true);
  });
});

describe('selectionState: cardinality', () => {
  it('duplicates exactly one ticked row', () => {
    expect(selectionState([A, B], null).duplicateId).toBeNull();
  });

  it('activates exactly one ticked row that is inactive and valid', () => {
    expect(selectionState([A, B], null).activateId).toBeNull();
    expect(selectionState([activeB], null).activateId).toBeNull();
    expect(selectionState([row('B', false, false)], null).activateId).toBeNull();
    expect(selectionState([{ ID: 'B', isActive: false, isValid: null }], null).activateId).toBeNull();
  });
});

describe('canSave', () => {
  it('needs an open, inactive configuration', () => {
    expect(canSave(null)).toBe(false);
    expect(canSave(A)).toBe(true);
    expect(canSave(activeB)).toBe(false);
  });
});
