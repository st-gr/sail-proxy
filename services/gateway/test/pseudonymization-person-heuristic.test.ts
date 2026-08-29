import { describe, it, expect } from '@jest/globals';
import { detectEntities } from '../src/plugins/pseudonymization/detectors';
import { MaskingConfig } from '../src/plugins/pseudonymization/types';

const personOnly: MaskingConfig = {
  method: 'pseudonymization',
  entities: [{ type: 'profile-person' }],
};

const found = (text: string) =>
  detectEntities(text, personOnly).filter(m => m.type === 'profile-person').map(m => m.original);

describe('capitalised run length', () => {
  it('detects a two-token run', () => {
    expect(found('Ana Ruiz called the office.')).toContain('Ana Ruiz');
  });

  it('detects a four-token run whole', () => {
    expect(found('Maria Elena Gonzalez Rodriguez called the office.'))
      .toContain('Maria Elena Gonzalez Rodriguez');
  });

  // Before this change a five-token run produced NOTHING — a silent miss, which is
  // why the gap was rated medium rather than cosmetic.
  it('truncates a five-token run instead of discarding it', () => {
    const names = found('Ana Lucia Fernandez Ruiz Mendez called the office.');
    expect(names).toHaveLength(1);
    expect(names[0].split(' ')).toHaveLength(4);
  });

  it('truncates from the TAIL, keeping the trailing tokens', () => {
    expect(found('Ana Lucia Fernandez Ruiz Mendez called the office.'))
      .toContain('Lucia Fernandez Ruiz Mendez');
  });

  // The salutation is load-bearing, and only for the SIX-token case. Truncating to the
  // last four drops both given names ("Ana", "Lucia"), so the remaining span is four
  // surnames and nothing in it says "person": the capitalised-run heuristic scores 0.35
  // and the default threshold is 0.5 (spec 2026-08-25-pseudonymization-precision, task 2).
  // "Dear" supplies the missing evidence (+0.3) without joining the run — it is in
  // EXCLUDED_WORDS — so this still measures TRUNCATION and not the threshold.
  it('truncates a six-token run to the last four', () => {
    expect(found('Dear Ana Lucia Fernandez Ruiz Mendez Ortega, thank you for calling.'))
      .toContain('Fernandez Ruiz Mendez Ortega');
  });

  // The reason for tail- rather than head-truncation: placeholders are content-derived,
  // so the same person must produce the same span whether or not a word precedes them.
  it('yields the same span with and without a leading extra token', () => {
    const withExtra = found('Ana Lucia Fernandez Ruiz Mendez called the office.');
    const without = found('Lucia Fernandez Ruiz Mendez called the office.');
    expect(withExtra[0]).toBe(without[0]);
  });

  it('does not detect a single capitalised token', () => {
    expect(found('Ana called the office.')).toHaveLength(0);
  });
});

describe('Spanish stop-words', () => {
  // Every expectation below was measured through the real detector before this plan
  // was written. Note the trigger is a CAPITALISED title only: 'el señor' lowercase
  // already breaks the run via the /^[A-Z]/ check in isNameToken.

  it('excludes a capitalised Spanish honorific from the name run', () => {
    expect(found('Señora Ana Ruiz llamó ayer.')).toEqual(['Ana Ruiz']);
  });

  it('excludes a capitalised Spanish salutation', () => {
    expect(found('Estimada Ana Ruiz, gracias por su mensaje.')).toEqual(['Ana Ruiz']);
  });

  // Controls: these are already correct today and must STAY correct. They are the
  // regression net for the stop-word additions, since EXCLUDED_WORDS is shared.
  it('still detects a name after a lowercase title', () => {
    expect(found('El señor Carlos Mendez está aquí.')).toEqual(['Carlos Mendez']);
  });

  it('still ignores an adjacent lowercase accented verb', () => {
    expect(found('Ana Ruiz llamó ayer por la tarde.')).toEqual(['Ana Ruiz']);
  });

  it('still does not mask Spanish common nouns', () => {
    expect(found('Las flores del campo crecen cerca de la cruz en la vega.')).toHaveLength(0);
  });
});

describe('Spanish articles inside compound surnames are not excluded', () => {
  // Spanish articles ('la', 'el', 'los', 'las', 'un', 'una') and 'don'/'dona'/'doña'/
  // 'buenos'/'buenas' were tried in EXCLUDED_WORDS and reverted: they occur inside real
  // compound surnames common in this heuristic's target region, so excluding them
  // silently dropped part or all of the name instead of just a title. These are the
  // regression tests that would have caught it.

  it('detects a surname built from "La Rosa"', () => {
    expect(found('Ana La Rosa called yesterday.')).toEqual(['Ana La Rosa']);
  });

  it('detects a surname built from "De La Cruz"', () => {
    expect(found('Carlos De La Cruz called yesterday.')).toEqual(['Carlos De La Cruz']);
  });

  it('detects a surname built from "Los Santos"', () => {
    expect(found('Ana Los Santos called yesterday.')).toEqual(['Ana Los Santos']);
  });

  it('detects a surname built from "El Amin"', () => {
    expect(found('Maria El Amin called yesterday.')).toEqual(['Maria El Amin']);
  });

  it('detects a surname that happens to match the salutation word "Buenos"', () => {
    expect(found('Carlos Buenos called yesterday.')).toEqual(['Carlos Buenos']);
  });

  it('detects a given name that happens to match "Dona"', () => {
    expect(found('Dona Elvira called yesterday.')).toEqual(['Dona Elvira']);
  });
});
