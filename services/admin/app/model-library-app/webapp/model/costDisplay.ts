/**
 * Cost section display: mirrors the admin's modelPriceService.capacityUnitsPerMillion
 * (cost per 1K tokens × 1000 × cuFactor = capacity units per 1M tokens, five decimals).
 */
/** A figure's digits as given, with the locale's decimal sign: English stays byte-identical to the input. */
function decimalSign(digits: string, locale: string): string {
  const sign = new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === 'decimal')?.value ?? '.';
  return digits.replace('.', sign);
}

/**
 * A figure shown as stored (benchmark score, price history cost) with the locale's decimal sign;
 * missing shows nothing. No rounding and no grouping, so English stays byte-identical.
 */
export function localeDecimal(value: string | number | null | undefined, locale = 'en-US'): string {
  if (value === null || value === undefined || value === '') return '';
  return decimalSign(String(value), locale);
}

/** `locale` is the cockpit language the controller passes; jest passes none and gets 'en-US'. */
export function capacityUnitsPerMillion(costPer1k: string | number | null | undefined, cuFactor: number, locale = 'en-US'): string | null {
  if (costPer1k === null || costPer1k === undefined || costPer1k === '') return null;
  const n = Number(costPer1k);
  if (!Number.isFinite(n) || !Number.isFinite(cuFactor)) return null;
  return decimalSign((n * 1000 * cuFactor).toFixed(5), locale);
}

export function operandsBracket(costPer1k: string | number, cuFactor: number, locale = 'en-US', t: Translator = defaultTranslate): string {
  return t('costOperands', [decimalSign(String(costPer1k), locale), decimalSign(String(cuFactor), locale)]);
}

/** SAP-RPT models (and their pricing-only `--deep-context` rows) price per 1K cells; everything
 * else prices per 1K tokens - drives the Cost section's header in Detail.view.xml. */
export function costUnitLabel(modelId: string): 'tokens' | 'cells' {
  return /^sap-rpt-/.test(modelId) ? 'cells' : 'tokens';
}

export interface SnapshotCosts { sapInputCost: string | null; sapOutputCost: string | null; sapCacheReadCost: string | null; sapCacheCreationCost: string | null; }
export interface PriceRow { source: string; inputCost: string | null; outputCost: string | null; cacheReadInputCost: string | null; cacheCreationInputCost: string | null; imageOutputCost: string | null; audioInputCost: string | null; audioOutputCost: string | null; }
export interface CostRow { label: string; key: 'input' | 'output' | 'cacheRead' | 'cacheCreation' | 'imageOutput' | 'audioInput' | 'audioOutput'; value: string | null; bracket: string; factor: string | null; }

/**
 * Resolves an i18n key — the controller injects the resource bundle; jest passes none and gets the
 * English defaults below, so the module keeps no UI5 imports (like shell/model/homeTiles.ts).
 */
export type Translator = (key: string, args?: (string | number)[]) => string;
/** English defaults: each value is byte-identical to the literal it replaced, so the pure tests hold. */
const EN_LABELS: Record<string, string> = {
  inputTokenCostFactor: 'Input Token Cost Factor',
  outputTokenCostFactor: 'Output Token Cost Factor',
  cacheReadCostFactor: 'Cache Read Cost Factor',
  cacheCreationCostFactor: 'Cache Creation Cost Factor',
  imageOutputCostFactor: 'Image Output Cost Factor',
  audioInputCostFactor: 'Audio Input Cost Factor',
  audioOutputCostFactor: 'Audio Output Cost Factor',
  costOperands: '({0} per 1K × {1})',
  inputPer1K: 'Input / 1K',
  outputPer1K: 'Output / 1K',
  cacheReadPer1K: 'Cache read / 1K',
  cacheCreationPer1K: 'Cache creation / 1K'
};
function defaultTranslate(key: string, args?: (string | number)[]): string {
  const pattern = EN_LABELS[key] ?? key;
  return args ? pattern.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? '')) : pattern;
}

// Labels match SAP AI Launchpad's Cost tab ("Input Token Cost Factor", ...). imageOutputCost and
// the audio rates have no SAP counterpart (sap: null) - they only ever come from an admin's manual price.
const DIRECTIONS: { key: CostRow['key']; labelKey: string; sap: keyof SnapshotCosts | null; price: keyof PriceRow }[] = [
  { key: 'input', labelKey: 'inputTokenCostFactor', sap: 'sapInputCost', price: 'inputCost' },
  { key: 'output', labelKey: 'outputTokenCostFactor', sap: 'sapOutputCost', price: 'outputCost' },
  { key: 'cacheRead', labelKey: 'cacheReadCostFactor', sap: 'sapCacheReadCost', price: 'cacheReadInputCost' },
  { key: 'cacheCreation', labelKey: 'cacheCreationCostFactor', sap: 'sapCacheCreationCost', price: 'cacheCreationInputCost' },
  { key: 'imageOutput', labelKey: 'imageOutputCostFactor', sap: null, price: 'imageOutputCost' },
  { key: 'audioInput', labelKey: 'audioInputCostFactor', sap: null, price: 'audioInputCost' },
  { key: 'audioOutput', labelKey: 'audioOutputCostFactor', sap: null, price: 'audioOutputCost' }
];

/** One row per direction that has a SAP price or a manual price. `factor` is the raw per-1K
 * price actually in effect (mirrors SAP's own "Cost Factor" figure); `value`/`bracket` keep the
 * capacity-units headline the admin console derives from it. */
export function costRows(model: SnapshotCosts, current: PriceRow | null, cuFactor: number, t: Translator = defaultTranslate, locale = 'en-US'): CostRow[] {
  const manual = !!current && current.source === 'manual';
  return DIRECTIONS.flatMap(d => {
    const sap = d.sap ? model[d.sap] : null;
    const mine = manual ? (current as PriceRow)[d.price] : null;
    const shown = manual && mine !== null && mine !== undefined && mine !== '' ? mine : sap;
    if (shown === null || shown === undefined || shown === '') return [];
    return [{ label: t(d.labelKey), key: d.key, value: capacityUnitsPerMillion(shown, cuFactor, locale), bracket: operandsBracket(shown as string, cuFactor, locale, t),
      factor: decimalSign(String(shown), locale) }];
  });
}

const EXTERNAL_DIRECTIONS: { key: CostRow['key']; labelKey: string; price: keyof PriceRow }[] = [
  { key: 'input', labelKey: 'inputPer1K', price: 'inputCost' },
  { key: 'output', labelKey: 'outputPer1K', price: 'outputCost' },
  { key: 'cacheRead', labelKey: 'cacheReadPer1K', price: 'cacheReadInputCost' },
  { key: 'cacheCreation', labelKey: 'cacheCreationPer1K', price: 'cacheCreationInputCost' }
];

/** The Cost rows of a Connection model: its list price per 1K tokens as stored (the view adds the
 * currency as the unit). Not an SAP Cost Factor, so no capacity-unit value, operands or factor. */
export function externalCostRows(current: PriceRow | null, t: Translator = defaultTranslate, locale = 'en-US'): CostRow[] {
  if (!current) return [];
  return EXTERNAL_DIRECTIONS.flatMap(d => {
    const v = current[d.price];
    if (v === null || v === undefined || v === '') return [];
    return [{ label: t(d.labelKey), key: d.key, value: decimalSign(String(v), locale), bracket: '', factor: null }];
  });
}
