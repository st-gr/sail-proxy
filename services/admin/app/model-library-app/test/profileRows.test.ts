import * as fs from 'fs';
import * as path from 'path';
import { toCatalogShapedUsers, PROFILE_LIMIT_FIELDS } from '../webapp/model/profileRows';

const webapp = (...parts: string[]) => path.join(__dirname, '..', 'webapp', ...parts);
const read = (...parts: string[]) => fs.readFileSync(webapp(...parts), 'utf8');

describe('toCatalogShapedUsers', () => {
  it('renames profileId/profileName so the assignments table needs no second version', () => {
    expect(toCatalogShapedUsers([
      { email: 'a@x', displayName: 'A', status: 'active', profileId: 'p1', profileName: 'Standard' },
      { email: 'b@x', displayName: null, status: 'active', profileId: null, profileName: null }
    ])).toEqual([
      { email: 'a@x', displayName: 'A', status: 'active', catalogId: 'p1', catalogName: 'Standard' },
      { email: 'b@x', displayName: null, status: 'active', catalogId: null, catalogName: null }
    ]);
  });
  it('a missing field is null, never undefined - mergeUsers compares against null', () => {
    expect(toCatalogShapedUsers([{ email: 'a@x' }])).toEqual([
      { email: 'a@x', displayName: null, status: null, catalogId: null, catalogName: null }
    ]);
  });
  it('no rows at all (an unanswered call) is an empty table, not a crash', () => {
    expect(toCatalogShapedUsers(null)).toEqual([]);
    expect(toCatalogShapedUsers(undefined)).toEqual([]);
  });
});

// The Limits form is written out in XML rather than generated, so this is what keeps the three
// copies of the seven fields - the list, the form and the bundles - from drifting apart.
describe('PROFILE_LIMIT_FIELDS', () => {
  const names = PROFILE_LIMIT_FIELDS.map(f => f.name);

  it('is the seven limits, grouped requests, tokens, spend', () => {
    expect(names).toEqual([
      'requestsPerMinute', 'tokensPerDay', 'tokensPerWeek', 'tokensPerMonth',
      'spendPerDay', 'spendPerWeek', 'spendPerMonth'
    ]);
  });

  it('has an Input in Catalogs.view.xml per field, in this order, keyed by the field name', () => {
    const view = read('view', 'Catalogs.view.xml');
    const ids = Array.from(view.matchAll(/<Input id="([A-Za-z]+)" type="Number"/g)).map(m => m[1]);
    expect(ids).toEqual(names);
    for (const field of PROFILE_LIMIT_FIELDS) {
      expect(view).toContain(`<Label text="{i18n>${field.labelKey}}"/><Input id="${field.name}" type="Number"`);
      expect(view).toContain(`value="{path: '${field.name}'`);
    }
  });

  it('has its label in both bundles', () => {
    for (const bundle of ['i18n.properties', 'i18n_en.properties']) {
      const text = read('i18n', bundle);
      for (const field of PROFILE_LIMIT_FIELDS) {
        expect(text).toMatch(new RegExp(`^${field.labelKey}=.+$`, 'm'));
      }
    }
  });
});

// The two modes' texts are picked by expression bindings, so a key that only one mode reaches is
// never seen until somebody switches. This holds every key the view names - both modes' - against
// both bundles at build time instead.
describe('the Catalogs view against the bundles', () => {
  const keys = () => {
    const view = read('view', 'Catalogs.view.xml');
    // both spellings the view uses: {i18n>key} in a binding or an expression, 'i18n>key' in parts
    return Array.from(new Set(Array.from(view.matchAll(/['{]i18n>([A-Za-z0-9_.]+)['}]/g)).map(m => m[1]))).sort();
  };

  it('names at least the profile-mode texts', () => {
    expect(keys()).toEqual(expect.arrayContaining([
      'assignHintProfile', 'assignSelectedProfile', 'assignedProfile', 'deleteProfile',
      'limits', 'modeCatalogs', 'modeProfiles', 'newProfile', 'noProfile', 'usersCount'
    ]));
  });

  it('names no key that is missing from either bundle', () => {
    for (const bundle of ['i18n.properties', 'i18n_en.properties']) {
      const text = read('i18n', bundle);
      const missing = keys().filter(key => !new RegExp(`^${key}=`, 'm').test(text));
      expect(missing).toEqual([]);
    }
  });
});
