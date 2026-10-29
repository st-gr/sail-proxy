import * as fs from 'fs';
import * as path from 'path';

/**
 * The schema-text generator's translation helpers (ci/scripts/schema-texts.js):
 * - `--apply <lang> <map.json>` fills a language file's placeholders by their English and never
 *   overwrites a value that already differs from the English;
 * - a key added to a language file reuses that file's translation of the same English;
 * - `--accept` lists the keys it is about to accept that still read as English in a language file.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const generator = require('../../../../../ci/scripts/schema-texts.js') as {
  collectSchemaTexts(schema: unknown): Array<[string, string]>;
  parseValue(raw: string): string;
  renderBundle(text: string, entries: Array<[string, string]>, keepExisting: boolean, previousEnglish?: Map<string, string>): string;
  applyTranslations(text: string, entries: Array<[string, string]>, translations: Record<string, string>): {
    text: string;
    counts: { filled: number; identical: number; alreadyTranslated: number; untranslated: number };
    missing: string[];
  };
  renderLock(entries: Array<[string, string]>): string;
  untranslatedPlaceholders(entries: Array<[string, string]>, lock: Record<string, string>, languageTexts: Record<string, string>): Array<[string, string[]]>;
  placeholderWarning(groups: Array<[string, string[]]>): string[];
  SCHEMA_FILE: string;
  BUNDLE_DIR: string;
};

const entries: Array<[string, string]> = [
  ['schema.a.label', 'Enabled'],
  ['schema.a.description', 'Turns it on.'],
  ['schema.b.label', 'Enabled'],
  ['schema.c.label', 'Timeout'],
  ['schema.d.description', 'Line one\nline two with a \\ backslash'],
  ['schema.e.description', 'Turns it off.']
];

describe('the generator --apply', () => {
  const before = [
    'x=1',
    '',
    'schema.a.label=Aktiviert (schon)',
    'schema.a.description=Turns it on.',
    'schema.b.label=Enabled',
    'schema.c.label=Timeout',
    'schema.d.description=Line one\\nline two with a \\\\ backslash',
    'schema.e.description=Turns it off.',
    ''
  ].join('\n');
  const map = {
    Enabled: 'Aktiviert',
    'Turns it on.': 'Schaltet es ein.',
    'Line one\nline two with a \\ backslash': 'Zeile eins\nZeile zwei mit einem \\ Backslash',
    'Turns it off.': 'Turns it off.'
  };

  it('fills every placeholder by its English and keeps a value that is already translated', () => {
    const { text, counts, missing } = generator.applyTranslations(before, entries, map);
    expect(text).toContain('schema.a.label=Aktiviert (schon)\n');
    expect(text).toContain('schema.a.description=Schaltet es ein.\n');
    expect(text).toContain('schema.b.label=Aktiviert\n');
    expect(text).toContain('schema.c.label=Timeout\n');
    expect(text).toContain('schema.d.description=Zeile eins\\nZeile zwei mit einem \\\\ Backslash\n');
    expect(text.startsWith('x=1\n')).toBe(true);
    expect(text).toContain('schema.e.description=Turns it off.\n');
    expect(counts).toEqual({ filled: 3, identical: 1, alreadyTranslated: 1, untranslated: 1 });
    expect(missing).toEqual(['Timeout']);
  });

  it('is idempotent and leaves the bundle up to date for the write mode', () => {
    const once = generator.applyTranslations(before, entries, map).text;
    const twice = generator.applyTranslations(once, entries, map);
    expect(twice.text).toBe(once);
    expect(twice.counts).toEqual({ filled: 0, identical: 1, alreadyTranslated: 4, untranslated: 1 });
    expect(generator.renderBundle(once, entries, true)).toBe(once);
  });

  it('adds a key missing from the file before filling it', () => {
    const { text } = generator.applyTranslations('x=1\n', entries, map);
    expect(text).toContain('schema.b.label=Aktiviert\n');
    expect(text).toContain('schema.c.label=Timeout\n');
  });
});

describe('the generator write mode', () => {
  it('reuses the file\'s translation of the same English for an added key, else the English', () => {
    const before = 'x=1\n\nschema.a.label=Aktiviert\nschema.c.label=Timeout\n';
    const after = generator.renderBundle(before, entries, true);
    expect(after).toContain('schema.b.label=Aktiviert\n');
    expect(after).toContain('schema.a.description=Turns it on.\n');
    // An existing placeholder is not a translation to reuse, and an existing key is kept as it is.
    expect(after).toContain('schema.c.label=Timeout\n');
    expect(after).toContain('schema.a.label=Aktiviert\n');
    expect(generator.renderBundle(after, entries, true)).toBe(after);
  });

  it('moves a placeholder still holding the OLD English to the new English, and keeps a translation', () => {
    // The default bundle before the run said "Turns it on." / "Enabled"; the schema now says otherwise.
    const previous = new Map([['schema.a.description', 'Turns it on.'], ['schema.a.label', 'Enabled'], ['schema.b.label', 'Enabled']]);
    const reworded: Array<[string, string]> = [
      ['schema.a.label', 'Active'],
      ['schema.a.description', 'Switches it on.'],
      ['schema.b.label', 'Active']
    ];
    const before = 'x=1\n\nschema.a.label=Aktiviert\nschema.a.description=Turns it on.\nschema.b.label=Enabled\n';
    const after = generator.renderBundle(before, reworded, true, previous);
    expect(after).toContain('schema.a.description=Switches it on.\n');
    expect(after).toContain('schema.a.label=Aktiviert\n');
    // The stale placeholder is not a translation of the new English either: b takes the file's own one.
    expect(after).toContain('schema.b.label=Aktiviert\n');
    expect(generator.renderBundle(after, reworded, true, new Map(reworded))).toBe(after);
    // Without the old English nothing is treated as stale.
    expect(generator.renderBundle(before, reworded, true)).toContain('schema.a.description=Turns it on.\n');
  });

  it('never reuses into the English files', () => {
    const before = 'schema.a.label=Aktiviert\n';
    expect(generator.renderBundle(before, entries, false)).toContain('schema.b.label=Enabled\n');
  });

  it('reads back the exact English of every generated key in the default bundle', () => {
    const schema = JSON.parse(fs.readFileSync(generator.SCHEMA_FILE, 'utf8'));
    const real = generator.collectSchemaTexts(schema);
    const text = fs.readFileSync(path.join(generator.BUNDLE_DIR, 'i18n.properties'), 'utf8');
    const lines = text.split('\n');
    const differing = real.filter(([key, english]) => {
      const at = lines.findIndex(line => line.startsWith(`${key}=`));
      return at < 0 || generator.parseValue(lines[at]) !== english;
    });
    expect(differing).toEqual([]);
  });
});

describe('the generator --accept', () => {
  // a and c were checked before; b is new and d's English was reworded since.
  const lock = JSON.parse(generator.renderLock([
    ['schema.a.label', 'Enabled'], ['schema.a.description', 'Turns it on.'], ['schema.c.label', 'Timeout'],
    ['schema.d.description', 'Line one'], ['schema.e.description', 'Turns it off.']
  ])) as Record<string, string>;
  const languageTexts = {
    de: 'x=1\n\nschema.a.label=Enabled\nschema.b.label=Enabled\nschema.c.label=Timeout\n' +
      'schema.d.description=Zeile eins\\nZeile zwei mit einem \\\\ Backslash\nschema.e.description=Turns it off.\n',
    fr: 'schema.b.label=Activé\nschema.d.description=Line one\\nline two with a \\\\ backslash\n',
    it: 'schema.b.label=Attivato\nschema.d.description=Riga uno\n'
  };

  it('lists, by language, each key not yet accepted whose value still equals its English', () => {
    // a and c still read as English in de, but they were accepted before (identical by design): not listed.
    expect(generator.untranslatedPlaceholders(entries, lock, languageTexts)).toEqual([
      ['de', ['schema.b.label']],
      ['fr', ['schema.d.description']]
    ]);
  });

  it('counts a key missing from a language file as untranslated there', () => {
    expect(generator.untranslatedPlaceholders([['schema.z.label', 'New']], {}, { nl: 'x=1\n' })).toEqual([['nl', ['schema.z.label']]]);
  });

  it('prints a warning per language, and nothing when every changed key is translated', () => {
    expect(generator.placeholderWarning([['de', ['schema.b.label']], ['fr', ['schema.d.description', 'schema.b.label']]])).toEqual([
      'schema-texts: warning: 3 changed values still read as English (accepted anyway; fine where identical by design):',
      '  de (1): schema.b.label',
      '  fr (2): schema.d.description, schema.b.label'
    ]);
    expect(generator.placeholderWarning([])).toEqual([]);
  });
});
