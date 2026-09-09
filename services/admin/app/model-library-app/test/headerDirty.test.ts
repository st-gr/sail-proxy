/**
 * The catalog header's Save/Discard buttons and the data-loss guard (I) both read this: the OData
 * model's pending-changes flag, widened to cover the keystrokes sap.m.Input has not committed yet.
 */
import { headerDirty, isHeaderClean, catalogDirty, isCatalogClean } from '../webapp/model/headerDirty';

describe('headerDirty', () => {
  it('is dirty while the typed text differs from what the context holds', () => {
    expect(headerDirty('Team B', 'Team A', false)).toBe(true);
  });
  it('is clean again when the text is typed back to the stored value', () => {
    expect(headerDirty('Team A', 'Team A', false)).toBe(false);
  });
  it('treats an empty field and a null property as the same', () => {
    expect(headerDirty('', null, false)).toBe(false);
    expect(headerDirty(undefined, undefined, false)).toBe(false);
    expect(headerDirty('x', null, false)).toBe(true);
  });
  it('stays dirty for a committed edit in the other field, whatever is typed here', () => {
    expect(headerDirty('Team A', 'Team A', true)).toBe(true);
    expect(headerDirty('', null, true)).toBe(true);
  });
});

/**
 * The guard and the footer buttons must agree while a Save is on the wire: the model reports the
 * edit as pending until the batch comes back, but the buttons are already dark and the user has
 * said "save it".
 */
describe('isHeaderClean', () => {
  it('lets a navigation through while the save is in flight, pending or not', () => {
    expect(isHeaderClean({ saveInFlight: true, pending: true })).toBe(true);
    expect(isHeaderClean({ saveInFlight: true, pending: false })).toBe(true);
  });
  it('asks first for an edit nothing has been told to save', () => {
    expect(isHeaderClean({ saveInFlight: false, pending: true })).toBe(false);
  });
  it('lets an untouched header through without asking', () => {
    expect(isHeaderClean({ saveInFlight: false, pending: false })).toBe(true);
  });
});

/** The staged list changes (members, exclusions, assignments) count the same as a header edit. */
describe('catalogDirty / isCatalogClean', () => {
  it('is dirty for a header edit, for staged list changes, or both', () => {
    expect(catalogDirty({ pending: false, pendingCount: 0 })).toBe(false);
    expect(catalogDirty({ pending: true, pendingCount: 0 })).toBe(true);
    expect(catalogDirty({ pending: false, pendingCount: 2 })).toBe(true);
  });
  it('a save in flight counts as clean; staged changes alone ask first', () => {
    expect(isCatalogClean({ saveInFlight: true, pending: true, pendingCount: 3 })).toBe(true);
    expect(isCatalogClean({ saveInFlight: false, pending: false, pendingCount: 1 })).toBe(false);
    expect(isCatalogClean({ saveInFlight: false, pending: false, pendingCount: 0 })).toBe(true);
  });
});
