/**
 * Cost section display: mirrors the admin's modelPriceService.capacityUnitsPerMillion
 * (cost per 1K tokens × 1000 × cuFactor = capacity units per 1M tokens, five decimals).
 */
export function capacityUnitsPerMillion(costPer1k: string | number | null | undefined, cuFactor: number): string | null {
  if (costPer1k === null || costPer1k === undefined || costPer1k === '') return null;
  const n = Number(costPer1k);
  if (!Number.isFinite(n) || !Number.isFinite(cuFactor)) return null;
  return (n * 1000 * cuFactor).toFixed(5);
}

export function operandsBracket(costPer1k: string | number, cuFactor: number): string {
  return `(${costPer1k} per 1K × ${cuFactor})`;
}

/** SAP-RPT models (and their pricing-only `--deep-context` rows) price per 1K cells; everything
 * else prices per 1K tokens - drives the Cost section's header in Detail.view.xml. */
export function costUnitLabel(modelId: string): 'tokens' | 'cells' {
  return /^sap-rpt-/.test(modelId) ? 'cells' : 'tokens';
}

export interface SnapshotCosts { sapInputCost: string | null; sapOutputCost: string | null; sapCacheReadCost: string | null; sapCacheCreationCost: string | null; }
export interface PriceRow { source: string; inputCost: string | null; outputCost: string | null; cacheReadInputCost: string | null; cacheCreationInputCost: string | null; imageOutputCost: string | null; audioInputCost: string | null; audioOutputCost: string | null; }
export interface CostRow { label: string; key: 'input' | 'output' | 'cacheRead' | 'cacheCreation' | 'imageOutput' | 'audioInput' | 'audioOutput'; value: string | null; bracket: string; factor: string | null; }

// Labels match SAP AI Launchpad's Cost tab ("Input Token Cost Factor", ...). imageOutputCost and
// the audio rates have no SAP counterpart (sap: null) - they only ever come from an admin's manual price.
const DIRECTIONS: { key: CostRow['key']; label: string; sap: keyof SnapshotCosts | null; price: keyof PriceRow }[] = [
  { key: 'input', label: 'Input Token Cost Factor', sap: 'sapInputCost', price: 'inputCost' },
  { key: 'output', label: 'Output Token Cost Factor', sap: 'sapOutputCost', price: 'outputCost' },
  { key: 'cacheRead', label: 'Cache Read Cost Factor', sap: 'sapCacheReadCost', price: 'cacheReadInputCost' },
  { key: 'cacheCreation', label: 'Cache Creation Cost Factor', sap: 'sapCacheCreationCost', price: 'cacheCreationInputCost' },
  { key: 'imageOutput', label: 'Image Output Cost Factor', sap: null, price: 'imageOutputCost' },
  { key: 'audioInput', label: 'Audio Input Cost Factor', sap: null, price: 'audioInputCost' },
  { key: 'audioOutput', label: 'Audio Output Cost Factor', sap: null, price: 'audioOutputCost' }
];

/** One row per direction that has a SAP price or a manual price. `factor` is the raw per-1K
 * price actually in effect (mirrors SAP's own "Cost Factor" figure); `value`/`bracket` keep the
 * capacity-units headline the admin console derives from it. */
export function costRows(model: SnapshotCosts, current: PriceRow | null, cuFactor: number): CostRow[] {
  const manual = !!current && current.source === 'manual';
  return DIRECTIONS.flatMap(d => {
    const sap = d.sap ? model[d.sap] : null;
    const mine = manual ? (current as PriceRow)[d.price] : null;
    const shown = manual && mine !== null && mine !== undefined && mine !== '' ? mine : sap;
    if (shown === null || shown === undefined || shown === '') return [];
    return [{ label: d.label, key: d.key, value: capacityUnitsPerMillion(shown, cuFactor), bracket: operandsBracket(shown as string, cuFactor),
      factor: String(shown) }];
  });
}
