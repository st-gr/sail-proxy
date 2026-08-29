import { describe, it, expect } from '@jest/globals';
import { NATIONALITIES } from '../src/plugins/pseudonymization/dictionaries/nationalities';
import { ETHNICITIES } from '../src/plugins/pseudonymization/dictionaries/ethnicities';
import { GENDERS } from '../src/plugins/pseudonymization/dictionaries/genders';
import { POLITICAL_GROUPS } from '../src/plugins/pseudonymization/dictionaries/politicalGroups';
import { RELIGIONS } from '../src/plugins/pseudonymization/dictionaries/religions';
import { SEXUAL_ORIENTATIONS } from '../src/plugins/pseudonymization/dictionaries/sexualOrientations';
import { TRADE_UNIONS } from '../src/plugins/pseudonymization/dictionaries/tradeUnions';

// A duplicate entry does not change detection (the term still matches), but it is dead
// weight and a sign the list was edited by hand without checking what was already there
// (see nationalities.ts, which carried 'Tongan' twice — once in the alphabetical body,
// once in a short addendum — until this test was added). Comparing array length against
// the Set size catches a repeat regardless of where in the list it lands.
describe('dictionary word-lists contain no duplicate entries', () => {
  const dictionaries: Array<[string, string[]]> = [
    ['NATIONALITIES', NATIONALITIES],
    ['ETHNICITIES', ETHNICITIES],
    ['GENDERS', GENDERS],
    ['POLITICAL_GROUPS', POLITICAL_GROUPS],
    ['RELIGIONS', RELIGIONS],
    ['SEXUAL_ORIENTATIONS', SEXUAL_ORIENTATIONS],
    ['TRADE_UNIONS', TRADE_UNIONS],
  ];

  it.each(dictionaries)('%s has no duplicate entries', (_name, list) => {
    expect(new Set(list).size).toBe(list.length);
  });

  // Pinned so a future edit to the alphabetical body or an addendum can't silently
  // reintroduce a duplicate without this count moving too — matches the "172
  // nationalities" figure in docs/security/pseudonymization-security-assessment.md.
  it('NATIONALITIES has exactly 172 entries', () => {
    expect(NATIONALITIES.length).toBe(172);
  });
});
