/**
 * ownCatalogsFilter builds the $filter for the AddModelsDialog SelectDialog (Detail's
 * onAddToCatalog and Library's onAddSelectedToCatalog): admins may add to any non-default
 * catalog, non-admins only to catalogs they own (the server independently enforces the same
 * rule, so this is a UX narrowing, not a security boundary).
 */
import { ownCatalogsFilter } from '../webapp/model/catalogPicker';

describe('ownCatalogsFilter', () => {
  it('lets an admin see every non-default catalog', () => {
    expect(ownCatalogsFilter(true, 'admin@example.com')).toBe('isDefault eq false');
  });
  it('narrows a non-admin to their own non-default catalogs', () => {
    expect(ownCatalogsFilter(false, 'user@example.com')).toBe("isDefault eq false and ownerEmail eq 'user@example.com'");
  });
  it('escapes a single quote in the email for the OData string literal', () => {
    expect(ownCatalogsFilter(false, "o'brien@example.com")).toBe("isDefault eq false and ownerEmail eq 'o''brien@example.com'");
  });
});
