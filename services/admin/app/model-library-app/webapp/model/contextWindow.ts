/**
 * Context window formatting for the Properties section (thousands with a "k" suffix, like
 * SAP AI Launchpad's "200k"). Kept in its own module — like costDisplay/benchmarks — rather than
 * inline in formatter.ts, because formatter.ts pulls in sap/ui/core/IconPool, which this app's
 * jest setup cannot type-check (no @sapui5/types dependency); formatter.contextWindow delegates here.
 * Accepts the raw number or an already type-formatted string ("200,000"): an OData V4 property
 * binding formats through the EDM type before a custom formatter runs unless targetType is 'any'.
 */
export function contextWindow(n: number | string | null | undefined): string {
  const v = typeof n === 'string' ? Number(n.replace(/[^0-9.]/g, '')) : n;
  if (!v || Number.isNaN(v)) return '';
  return v >= 1000 ? `${Math.round(v / 1000)}k` : String(v);
}
