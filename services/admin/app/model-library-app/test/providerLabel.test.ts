/**
 * The provider facet showed "UN unknown" for a deployment whose base model the gateway no longer
 * lists. The vendor-prefix fallback resolves that for every id shaped <vendor>--<model>; what is
 * left reads "Other" (L). The value behind it is untouched - it is the filter's key.
 */
import { providerLabel, providerMarkName, UNKNOWN_PROVIDER } from '../webapp/model/providerLabel';
import { providerMark } from '../webapp/model/providerMarks';

describe('providerLabel', () => {
  it('calls the literal "unknown" provider "Other", whatever its case', () => {
    expect(providerLabel(UNKNOWN_PROVIDER)).toBe('Other');
    expect(providerLabel('Unknown')).toBe('Other');
    expect(providerLabel('  unknown  ')).toBe('Other');
  });
  it('leaves every real provider name alone', () => {
    expect(providerLabel('Anthropic')).toBe('Anthropic');
    expect(providerLabel('Mistral AI')).toBe('Mistral AI');
    expect(providerLabel('unknown vendor')).toBe('unknown vendor');
  });
  it('is empty for nothing, so the facet drops the row rather than showing a blank name', () => {
    expect(providerLabel(null)).toBe('');
    expect(providerLabel(undefined)).toBe('');
  });
  it('gives the avatar "OT" rather than "UN"', () => {
    expect(providerMark(providerLabel(UNKNOWN_PROVIDER))).toEqual({ initials: 'OT' });
  });
});

describe('providerLabel in the cockpit language', () => {
  it('translates "Other" but keeps the mark token and the filter value', () => {
    const t = (key: string) => (key === 'providerOther' ? 'Andere' : key);
    expect(providerLabel(UNKNOWN_PROVIDER, t)).toBe('Andere');
    expect(providerLabel('Anthropic', t)).toBe('Anthropic');
    expect(providerMark(providerMarkName(UNKNOWN_PROVIDER))).toEqual({ initials: 'OT' });
  });
  it('falls back to English while the bundle has not loaded (the translator returns the key)', () => {
    expect(providerLabel(UNKNOWN_PROVIDER, (key) => key)).toBe('Other');
  });
});
