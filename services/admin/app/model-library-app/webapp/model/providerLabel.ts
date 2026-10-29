/**
 * L: what the provider facet, its mark and the "View settings" tokens call a provider.
 *
 * The gateway hands over the literal "unknown" for a deployment whose base model it no longer
 * lists and whose id carries no vendor prefix to read (see librarySnapshot.providerFor, which
 * resolves every prefix it recognises). "unknown" is not a provider anyone can act on, so the
 * facet reads "Other" (in the cockpit's language); the filter value stays "unknown", which is
 * what LibraryModels holds. The provider mark keeps reading the English UNKNOWN_PROVIDER_LABEL
 * (initials "OT"): it is a token, not a text, and stays the same in every language.
 */
export const UNKNOWN_PROVIDER = 'unknown';
export const UNKNOWN_PROVIDER_LABEL = 'Other';

/**
 * Resolves an i18n key — the caller injects the resource bundle; jest passes none and gets the
 * English default below, so the module keeps no UI5 imports.
 */
export type Translator = (key: string) => string;
/** English default: byte-identical to UNKNOWN_PROVIDER_LABEL, the literal it replaced. */
const EN_TEXTS: Record<string, string> = { providerOther: 'Other' };
const defaultTranslate: Translator = (key) => EN_TEXTS[key] ?? key;

export function providerLabel(provider: string | null | undefined, t: Translator = defaultTranslate): string {
  const name = (provider || '').trim();
  if (name.toLowerCase() !== UNKNOWN_PROVIDER) return name;
  // A translator without the text (the bundle not loaded yet) falls back to English.
  const text = typeof t === 'function' ? t('providerOther') : undefined;
  return text && text !== 'providerOther' ? text : UNKNOWN_PROVIDER_LABEL;
}

/** The name the provider mark is looked up by: the display name, but "Other" in English always. */
export function providerMarkName(provider: string | null | undefined): string {
  return providerLabel(provider);
}
