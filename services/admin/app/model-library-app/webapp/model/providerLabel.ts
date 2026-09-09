/**
 * L: what the provider facet, its mark and the "View settings" tokens call a provider.
 *
 * The gateway hands over the literal "unknown" for a deployment whose base model it no longer
 * lists and whose id carries no vendor prefix to read (see librarySnapshot.providerFor, which
 * resolves every prefix it recognises). "unknown" is not a provider anyone can act on, so the
 * facet reads "Other"; the filter value stays "unknown", which is what LibraryModels holds.
 */
export const UNKNOWN_PROVIDER = 'unknown';
export const UNKNOWN_PROVIDER_LABEL = 'Other';

export function providerLabel(provider: string | null | undefined): string {
  const name = (provider || '').trim();
  return name.toLowerCase() === UNKNOWN_PROVIDER ? UNKNOWN_PROVIDER_LABEL : name;
}
