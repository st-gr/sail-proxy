/**
 * The suffix the gateway puts on a SAP-RPT model id when the response reports context_mode
 * 'deep', and the pure id-resolution helper both pricing lookups share. Pulled out of
 * modelCostService.ts (its natural home) because that module does `const { ... } = cds.ql;` at
 * top level: sapCapacityService.ts importing it for this helper alone would drag that eager
 * destructure along, which breaks any suite that `jest.mock('@sap/cds', ...)`s without a `.ql`
 * (see cost-recalculation.test.ts). No I/O and no @sap/cds dependency here, so either service can
 * import it for free.
 */
export const DEEP_CONTEXT_SUFFIX = '--deep-context';

/**
 * The ids a price may be maintained under, in lookup order. A deep-context id tries itself, then
 * the bare model (so the tier is never priced at nothing when only the base rate exists); a bare
 * id tries its deployed twin; a deployed id tries its bare model. Pure; used by
 * modelCostService.getModelPricing and by sapCapacityService._lookupRate so both resolve
 * identically.
 */
export function pricingTwins(modelId: string): string[] {
  const out: string[] = [modelId];
  if (modelId.endsWith(DEEP_CONTEXT_SUFFIX)) out.push(modelId.slice(0, -DEEP_CONTEXT_SUFFIX.length));
  for (const id of [...out]) {
    if (id.endsWith('--deployed')) out.push(id.slice(0, -'--deployed'.length)); else out.push(`${id}--deployed`);
  }
  return [...new Set(out)];
}
