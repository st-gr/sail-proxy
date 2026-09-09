/**
 * The provider facet showed "UN unknown" for a deployment whose base model the gateway no longer
 * lists. The vendor-prefix fallback resolves that for every id shaped <vendor>--<model>; what is
 * left reads "Other" (L). The value behind it is untouched - it is the filter's key.
 */
import { providerLabel, UNKNOWN_PROVIDER } from '../webapp/model/providerLabel';
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
