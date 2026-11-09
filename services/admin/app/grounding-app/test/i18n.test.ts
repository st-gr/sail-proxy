import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const DIR = join(__dirname, '..', 'webapp', 'i18n');

function parse(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}
const placeholders = (value: string): string[] => (value.match(/\{\d+\}/g) || []).sort();

const files = readdirSync(DIR).filter((name) => name.endsWith('.properties')).sort();
const bundles: Record<string, Record<string, string>> = {};
for (const name of files) bundles[name] = parse(readFileSync(join(DIR, name), 'utf8'));
const reference = bundles['i18n.properties'];

describe('grounding i18n bundles', () => {
  it('has the default bundle and the seven languages', () => {
    expect(files).toEqual(['i18n.properties', 'i18n_de.properties', 'i18n_en.properties', 'i18n_es.properties', 'i18n_fr.properties', 'i18n_it.properties', 'i18n_nl.properties', 'i18n_pt.properties']);
  });
  it('keeps English and the default bundle byte-identical', () => {
    expect(readFileSync(join(DIR, 'i18n_en.properties'), 'utf8')).toBe(readFileSync(join(DIR, 'i18n.properties'), 'utf8'));
  });
  for (const name of files) {
    describe(name, () => {
      it('has exactly the default bundle\'s keys', () => {
        expect(Object.keys(bundles[name]).sort()).toEqual(Object.keys(reference).sort());
      });
      it('keeps every {n} placeholder of the default text', () => {
        for (const key of Object.keys(reference)) expect([key, placeholders(bundles[name][key] ?? '')]).toEqual([key, placeholders(reference[key])]);
      });
      it('has no empty value and no ASCII apostrophe in a text with a placeholder (MessageFormat eats it)', () => {
        for (const [key, value] of Object.entries(bundles[name])) {
          expect([key, value.trim() !== '']).toEqual([key, true]);
          if (/\{\d+\}/.test(value)) expect([key, value.includes("'")]).toEqual([key, false]);
        }
      });
    });
  }
});
