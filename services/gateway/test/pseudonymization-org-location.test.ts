import { describe, it, expect } from '@jest/globals';
import { detectEntities } from '../src/plugins/pseudonymization/detectors';
import { MaskingConfig } from '../src/plugins/pseudonymization/types';
import { DEFAULT_MASKING_CONFIG } from '../src/plugins/pseudonymization/defaultMaskingConfig';

const SUFFIXES = ['Inc', 'Inc.', 'LLC', 'Ltd', 'Corporation', 'GmbH'];

function cfg(over: Partial<MaskingConfig>): MaskingConfig {
  return { method: 'pseudonymization', entities: [], ...over };
}

const found = (text: string, c: MaskingConfig) =>
  detectEntities(text, c).map(m => `${m.original}[${m.type}]`);

// Raw matches (not the formatted strings `found` returns) — needed by Group 3 below,
// which asserts on the number of DISTINCT `original` values, not just their formatting.
const detectOrgMatches = (text: string, c: MaskingConfig) => detectEntities(text, c);

describe('profile-org — legal-form suffixes only', () => {
  const c = cfg({ entities: [{ type: 'profile-org' }], org_suffixes: SUFFIXES });

  it('masks a name carrying a legal form, including the suffix', () => {
    expect(found('Acme Industries Inc filed today.', c)).toEqual(['Acme Industries Inc[profile-org]']);
  });

  it('does NOT mask a capitalised phrase with no legal form', () => {
    expect(found('The Water Department approved it.', c)).toEqual([]);
  });

  it('does NOT match the ordinary word "limited" in prose', () => {
    expect(found('This was a limited edition release.', c)).toEqual([]);
  });

  it('detects nothing when org_suffixes is empty', () => {
    expect(found('Acme Industries Inc filed today.', cfg({ entities: [{ type: 'profile-org' }], org_suffixes: [] }))).toEqual([]);
  });

  it('discards a blank entry in org_suffixes: still matches the valid suffix, never a bare capitalised run', () => {
    const withBlank = cfg({ entities: [{ type: 'profile-org' }], org_suffixes: ['Inc', ''] });
    expect(found('Acme Industries Inc filed today.', withBlank)).toEqual(['Acme Industries Inc[profile-org]']);
    expect(found('We spoke with Jane Doe -- she agreed.', withBlank)).toEqual([]);
  });

  it('detects nothing when org_suffixes contains only a blank entry', () => {
    expect(found('Acme Industries Inc filed today.', cfg({ entities: [{ type: 'profile-org' }], org_suffixes: [''] }))).toEqual([]);
  });

  it('detects nothing when the category is disabled', () => {
    expect(found('Acme Industries Inc filed today.', cfg({ entities: [], org_suffixes: SUFFIXES }))).toEqual([]);
  });

  describe('leading prose is not absorbed into the organisation name', () => {
    it('drops a leading verb phrase: "Please Contact" is not part of the org', () => {
      expect(found('Please Contact Acme Industries Inc now.', c)).toEqual(['Acme Industries Inc[profile-org]']);
    });

    it('drops a single leading verb: "Contact" is not part of the org', () => {
      expect(found('Contact Acme Industries Inc today.', c)).toEqual(['Acme Industries Inc[profile-org]']);
    });

    it('still masks the whole name when the org opens the sentence (no leading prose to drop)', () => {
      expect(found('Acme Industries Inc filed today.', c)).toEqual(['Acme Industries Inc[profile-org]']);
    });

    it('still masks the whole name when a prior, unrelated sentence precedes it', () => {
      expect(found('The board met. Acme Industries Inc filed.', c)).toEqual(['Acme Industries Inc[profile-org]']);
    });

    it('does NOT trim a leading "The" that is part of the legal name itself', () => {
      expect(found('The Home Depot Inc reported earnings.', c)).toEqual(['The Home Depot Inc[profile-org]']);
    });
  });

  describe('a trailing suffix period is trimmed context-free (bare "Inc" is configured)', () => {
    it('does not swallow the sentence period into the mask', () => {
      expect(found('The contract is with Acme Industries Inc.', c)).toEqual(['Acme Industries Inc[profile-org]']);
    });

    it('trims the period even when the sentence continues past it, because bare "Inc" is also configured', () => {
      // Old (removed) behaviour looked at the RIGHT CONTEXT and kept the period here
      // because a lowercase letter follows. The new rule looks only at the span
      // itself: stripping the period leaves "Acme Industries Inc", which is itself a
      // configured suffix, so it trims regardless of what follows in the sentence.
      expect(found('Acme Industries Inc. filed today.', c)).toEqual(['Acme Industries Inc[profile-org]']);
    });

    it('mints the SAME placeholder id for the same organisation regardless of sentence position', () => {
      const [sentenceFinal] = found('The contract is with Acme Industries Inc.', c);
      const [midSentence] = found('We work with Acme Industries Inc on that project.', c);
      expect(sentenceFinal).toEqual(midSentence);
    });
  });

  it('does not absorb a hyphenated continuation into the organisation match', () => {
    expect(found('Acme Corporation-wide policy applies.', cfg({ entities: [{ type: 'profile-org' }], org_suffixes: ['Corporation'] })))
      .toEqual([]);
  });
});

describe('profile-location — explicit gazetteer only', () => {
  const c = cfg({ entities: [{ type: 'profile-location' }], location_gazetteer: ['Springfield', 'Rivertown Heights'] });

  it('masks a configured single-word term', () => {
    expect(found('The office moved to Springfield last year.', c)).toEqual(['Springfield[profile-location]']);
  });

  it('masks a configured multi-word term as one phrase', () => {
    expect(found('We opened in Rivertown Heights.', c)).toEqual(['Rivertown Heights[profile-location]']);
  });

  it('matches case-insensitively', () => {
    expect(found('the office moved to springfield.', c)).toEqual(['springfield[profile-location]']);
  });

  it('does NOT infer an unconfigured place name', () => {
    expect(found('The office moved to Metropolis.', c)).toEqual([]);
  });

  it('respects word boundaries — no partial-word matches', () => {
    expect(found('Springfielder is not a place.', c)).toEqual([]);
  });

  it('detects nothing with an empty gazetteer — the shipped default', () => {
    expect(found('The office moved to Springfield.', cfg({ entities: [{ type: 'profile-location' }], location_gazetteer: [] }))).toEqual([]);
  });

  it('beats the NER person heuristic that currently mislabels locations', () => {
    const both = cfg({
      entities: [{ type: 'profile-location' }, { type: 'profile-person' }],
      location_gazetteer: ['Rivertown Heights'],
    });
    expect(found('We opened in Rivertown Heights.', both)).toEqual(['Rivertown Heights[profile-location]']);
  });
});

describe('allow_list applies to both new categories', () => {
  it('exempts an allow-listed org and location', () => {
    const c = cfg({
      entities: [{ type: 'profile-org' }, { type: 'profile-location' }],
      org_suffixes: SUFFIXES,
      location_gazetteer: ['Springfield'],
      allow_list: ['Acme Industries Inc', 'Springfield'],
    });
    expect(found('Acme Industries Inc is in Springfield.', c)).toEqual([]);
  });
});

// The test that would have caught the f236892 phone-detector incident: ordinary prose,
// both categories fully configured, nothing to match.
describe('negative space', () => {
  it('masks nothing in prose containing no configured term', () => {
    const c = cfg({
      entities: [{ type: 'profile-org' }, { type: 'profile-location' }],
      org_suffixes: SUFFIXES,
      location_gazetteer: ['Springfield'],
    });
    expect(found('The quarterly report was approved by the committee on Tuesday.', c)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 8 regression matrix: the trailing-period trim is now CONTEXT-FREE — it
// looks only at whether the span without the period still ends in a configured
// suffix, never at what follows the match in the text. See orgLocationDetector.ts
// for the full rationale (commit f236892 / 6b314a7).
// ─────────────────────────────────────────────────────────────────────────────

describe('Task 8 — Group 1: suffix spelling x position all yield the SAME span', () => {
  const c = cfg({ entities: [{ type: 'profile-org' }], org_suffixes: ['Inc', 'Inc.', 'LLC', 'GmbH'] });

  const cases: Array<[string, string]> = [
    ['sentence-final', 'The contract is with Acme Industries Inc.'],
    ['period followed by lowercase', 'Acme Industries Inc. filed today.'],
    ['no period at all', 'We work with Acme Industries Inc on that project.'],
    ['comma', 'Acme Industries Inc, a supplier, agreed.'],
    ['closing paren', '(Acme Industries Inc.)'],
    ['quote follows', '...said Acme Industries Inc.'],
    ['end of input, no trailing char', 'Acme Industries Inc'],
    ['newline', 'Acme Industries Inc.\nNext line.'],
    ['next sentence capitalised', 'Acme Industries Inc. Later we met.'],
  ];

  it.each(cases)('%s (%s) -> "Acme Industries Inc"', (_label, text) => {
    expect(found(text, c)).toEqual(['Acme Industries Inc[profile-org]']);
  });
});

describe('Task 8 — Group 2: period-bearing legal forms stay intact (bare "Inc" not configured)', () => {
  const c = cfg({ entities: [{ type: 'profile-org' }], org_suffixes: ['S.A.', 'L.L.C.', 'B.V.', 'Inc.'] });

  // In every case, stripping the trailing period leaves a span ("Acme S.A", "Contoso
  // L.L.C", "Fabrikam B.V", "Acme Industries Inc") that is NOT itself one of the
  // configured suffixes above — so the context-free rule never trims it.
  const cases: Array<[string, string]> = [
    ['Acme S.A. filed today.', 'Acme S.A.'],
    ['The contract is with Acme S.A.', 'Acme S.A.'],
    ['Contoso L.L.C. reported.', 'Contoso L.L.C.'],
    ['Fabrikam B.V. agreed.', 'Fabrikam B.V.'],
    ['Acme Industries Inc. filed.', 'Acme Industries Inc.'], // bare "Inc" not configured
  ];

  it.each(cases)('%s -> keeps its period (%s)', (text, expected) => {
    expect(found(text, c)).toEqual([`${expected}[profile-org]`]);
  });
});

describe('Task 8 — against the SHIPPED default org_suffixes (defaultMaskingConfig.ts)', () => {
  // The brief's most important constraint: the trim must be CONDITIONAL on the
  // configured suffix list, never unconditional. An unconditional trailing-period
  // trim, measured against these exact shipped defaults, corrupts real legal forms.
  // Verify directly against DEFAULT_MASKING_CONFIG.org_suffixes, not just the
  // brief's illustrative lists, so a future change to the shipped defaults would
  // fail this test if it broke the conditional rule.
  const c = cfg({ entities: [{ type: 'profile-org' }], org_suffixes: DEFAULT_MASKING_CONFIG.org_suffixes });

  it('does NOT corrupt "Acme S.A." (bare "S.A" is not a shipped suffix)', () => {
    expect(found('Acme S.A. filed today.', c)).toEqual(['Acme S.A.[profile-org]']);
  });

  it('does NOT corrupt "Contoso L.L.C." (bare "L.L.C" is not a shipped suffix)', () => {
    expect(found('Contoso L.L.C. reported.', c)).toEqual(['Contoso L.L.C.[profile-org]']);
  });

  it('does NOT corrupt "Fabrikam B.V." (bare "B.V" is not a shipped suffix)', () => {
    expect(found('Fabrikam B.V. agreed.', c)).toEqual(['Fabrikam B.V.[profile-org]']);
  });

  it('DOES unify "Inc"/"Inc." (both are shipped, so stripping the period leaves a valid suffix)', () => {
    expect(found('Acme Industries Inc. filed today.', c)).toEqual(['Acme Industries Inc[profile-org]']);
    expect(found('The contract is with Acme Industries Inc.', c)).toEqual(['Acme Industries Inc[profile-org]']);
  });
});

describe('Task 8 — Group 3: same-document invariant (the bug this task fixes)', () => {
  const c = cfg({ entities: [{ type: 'profile-org' }], org_suffixes: SUFFIXES });

  it('the same literal organisation in two sentence positions produces exactly ONE distinct span', () => {
    const text = 'Acme Industries Inc. Acme Industries Inc. filed today.';
    const matches = detectOrgMatches(text, c);
    expect(matches).toHaveLength(2);
    expect(new Set(matches.map(m => m.original)).size).toBe(1);
  });

  it('holds across three different right-contexts (sentence-final, comma, mid-sentence) in one document', () => {
    const text =
      'The contract is with Acme Industries Inc. ' +
      'Acme Industries Inc, a supplier, agreed. ' +
      'We work with Acme Industries Inc on that project.';
    const matches = detectOrgMatches(text, c);
    expect(matches).toHaveLength(3);
    expect(new Set(matches.map(m => m.original)).size).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 10: the trailing-period trim must compare against the SUFFIX THAT MATCHED,
// not against the span's tail. A raw tail test (`spanWithoutPeriod.endsWith(suffix)`)
// fires wrongly whenever a short configured suffix happens to be a string-tail of a
// longer legal form: with suffixes ['S.A.', 'A'], "Acme S.A" (period stripped) ends
// with the unrelated configured suffix "A", which would wrongly license the trim of
// a real legal form's period. See orgLocationDetector.ts for the fix.
// ─────────────────────────────────────────────────────────────────────────────
describe('Task 10 — trailing-period trim compares the matched suffix, not the span tail', () => {
  it('a short suffix that tails a longer legal form does NOT strip the legal form\'s own period ("S.A."/"A")', () => {
    const c = cfg({ entities: [{ type: 'profile-org' }], org_suffixes: ['S.A.', 'A'] });
    expect(found('Acme S.A. filed today.', c)).toEqual(['Acme S.A.[profile-org]']);
  });

  it('same shape with "B.V."/"V"', () => {
    const c = cfg({ entities: [{ type: 'profile-org' }], org_suffixes: ['B.V.', 'V'] });
    expect(found('Fabrikam B.V. filed today.', c)).toEqual(['Fabrikam B.V.[profile-org]']);
  });

  it('same shape with "L.L.C."/"C"', () => {
    const c = cfg({ entities: [{ type: 'profile-org' }], org_suffixes: ['L.L.C.', 'C'] });
    expect(found('Contoso L.L.C. filed today.', c)).toEqual(['Contoso L.L.C.[profile-org]']);
  });

  it('existing unify-by-matched-suffix behaviour is unchanged: "Inc"/"Inc." still unify', () => {
    const c = cfg({ entities: [{ type: 'profile-org' }], org_suffixes: ['Inc', 'Inc.'] });
    expect(found('Acme Industries Inc. filed today.', c)).toEqual(['Acme Industries Inc[profile-org]']);
    expect(found('Acme Industries Inc filed today.', c)).toEqual(['Acme Industries Inc[profile-org]']);
  });

  it('"S.A." alone (no bare "S.A" configured) still keeps its period', () => {
    const c = cfg({ entities: [{ type: 'profile-org' }], org_suffixes: ['S.A.'] });
    expect(found('Acme S.A. filed today.', c)).toEqual(['Acme S.A.[profile-org]']);
  });

  it('"Inc." alone (no bare "Inc" configured) never trims', () => {
    const c = cfg({ entities: [{ type: 'profile-org' }], org_suffixes: ['Inc.'] });
    expect(found('Acme Industries Inc. filed today.', c)).toEqual(['Acme Industries Inc.[profile-org]']);
  });

  it('same-document invariant still holds: two sentence positions of the same org yield ONE distinct span', () => {
    const c = cfg({ entities: [{ type: 'profile-org' }], org_suffixes: ['Inc', 'Inc.'] });
    const text = 'Acme Industries Inc. Acme Industries Inc. filed today.';
    const matches = detectOrgMatches(text, c);
    expect(matches).toHaveLength(2);
    expect(new Set(matches.map(m => m.original)).size).toBe(1);
  });
});

describe('Task 8 — Group 6: leading-edge regression (unaffected by the trailing-period change)', () => {
  const c = cfg({ entities: [{ type: 'profile-org' }], org_suffixes: SUFFIXES });

  it('leading prose is trimmed', () => {
    expect(found('Please Contact Acme Industries Inc now.', c)).toEqual(['Acme Industries Inc[profile-org]']);
  });

  it('a leading "The" that is part of the legal name itself is kept', () => {
    expect(found('The Home Depot Inc reported earnings.', c)).toEqual(['The Home Depot Inc[profile-org]']);
  });

  it('a hyphenated continuation is not absorbed into the organisation match', () => {
    expect(found('Acme Corporation-wide policy applies.', cfg({ entities: [{ type: 'profile-org' }], org_suffixes: ['Corporation'] })))
      .toEqual([]);
  });

  it('no legal form present -> no match', () => {
    expect(found('The Water Department approved it.', c)).toEqual([]);
  });

  it('blank org_suffixes entries ("" and "  ") are discarded, not matched as an empty suffix', () => {
    const withBlanks = cfg({ entities: [{ type: 'profile-org' }], org_suffixes: ['Inc', '', '  '] });
    expect(found('Acme Industries Inc filed today.', withBlanks)).toEqual(['Acme Industries Inc[profile-org]']);
    expect(found('We spoke with Jane Doe -- she agreed.', withBlanks)).toEqual([]);
  });
});

describe('leading articles and honorifics are kept in organisation names', () => {
  const cfg = (over: any) => ({ method: 'pseudonymization', entities: [{ type: 'profile-org' }], ...over });
  const orgs = (text: string, c: any) =>
    detectEntities(text, c).filter(m => m.type === 'profile-org').map(m => m.original);

  // Spanish articles were added to the shared EXCLUDED_WORDS for person detection.
  // The org detector must not inherit that trim, or a legal name beginning with an
  // article loses part of itself and the remainder leaks into the prompt.
  it('keeps a leading Spanish article', () => {
    expect(orgs('La Cocina Inc reported earnings.', cfg({ org_suffixes: ['Inc'] })))
      .toEqual(['La Cocina Inc']);
  });

  // Spanish honorifics/salutations are also in the shared EXCLUDED_WORDS, added for
  // person detection. Same failure mode as the article case above: an organisation
  // name that happens to open with one of those words must mask whole, not lose its
  // leading token to the trim.
  it('keeps a leading Spanish honorific/salutation', () => {
    expect(orgs('Hola Cafe Inc reported earnings.', cfg({ org_suffixes: ['Inc'] })))
      .toEqual(['Hola Cafe Inc']);
    expect(orgs('Sr Perez Holdings Inc reported earnings.', cfg({ org_suffixes: ['Inc'] })))
      .toEqual(['Sr Perez Holdings Inc']);
  });
});

describe('Task 8 — Group 7: pinned limitations (deliberately unchanged — do NOT "fix" these)', () => {
  const c = cfg({ entities: [{ type: 'profile-org' }], org_suffixes: SUFFIXES });

  it('internal whitespace is NOT normalised: double space vs single space are DIFFERENT spans', () => {
    // Placeholders are content-derived (originalValue -> placeholder in ReplacementMap,
    // which is a plain forward map). Collapsing "Acme  Industries Inc" (double space)
    // onto "Acme Industries Inc" (single space) would mean one of the two originals no
    // longer round-trips byte-exact: the reverse map is placeholder -> original, so the
    // second occurrence masked would get rewritten with the first occurrence's text on
    // unmask. This is a property of every content-derived category, not something this
    // task's change touches — see orgLocationDetector.ts's file header.
    const [doubleSpace] = found('Acme  Industries Inc filed today.', c);
    const [singleSpace] = found('Acme Industries Inc filed today.', c);
    expect(doubleSpace).not.toEqual(singleSpace);
  });

  it('a newline inside the name is retained verbatim in the span', () => {
    // Same reasoning as above: normalising the newline to a space would make the span
    // no longer match the literal source bytes, breaking byte-exact restoration on unmask.
    expect(found('Acme\nIndustries Inc filed today.', c)).toEqual(['Acme\nIndustries Inc[profile-org]']);
  });

  it('gazetteer case is NOT normalised: three different capitalisations are three DISTINCT spans', () => {
    // detectLocations matches case-insensitively but emits m[0] (the literal matched
    // text) as `original`, so "Springfield" / "SPRINGFIELD" / "springfield" mask to
    // three different placeholders. Unifying them would hit the same byte-exact
    // restoration problem as above the moment any one of the three appeared more than
    // once in a document. Not something this task's org-suffix change touches.
    const locCfg = cfg({ entities: [{ type: 'profile-location' }], location_gazetteer: ['Springfield'] });
    const mixed = found('Springfield, SPRINGFIELD, and springfield all filed reports.', locCfg);
    expect(mixed).toEqual([
      'Springfield[profile-location]',
      'SPRINGFIELD[profile-location]',
      'springfield[profile-location]',
    ]);
    expect(new Set(mixed).size).toBe(3);
  });
});
