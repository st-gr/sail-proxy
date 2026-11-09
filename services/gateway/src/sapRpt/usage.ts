/**
 * SAP-RPT usage, folded from the response.
 *
 * SAP prices these models per 1,000 cells - its price list calls them "Generative AI Tokens
 * (per 1000 cells)" - so cells ride the token fields of the usage event and the whole cost,
 * quota and analytics pipeline applies unchanged. The counts come from `metadata`, which SAP
 * returns only on success: a rejected call bills nothing, and a Parquet call, whose request the
 * gateway cannot read, still bills. Measured on sap-rpt-1-small and sap-rpt-1.6 (2026-09-22):
 * `num_rows` counts every row sent, context and query alike; `num_columns` counts every column,
 * index and targets included; `num_predictions` is query rows × target columns.
 */
export const DEEP_CONTEXT_SUFFIX = '--deep-context';

export interface RptCells { inputCells: number; predictCells: number; contextMode: string | null; }

const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

export function cellsFromResponse(body: unknown): RptCells | null {
  const meta = (body as any)?.metadata;
  if (!meta || typeof meta !== 'object') return null;
  const rows = int(meta.num_rows);
  const columns = int(meta.num_columns);
  const predictions = int(meta.num_predictions);
  if (rows === null || columns === null || predictions === null) return null;
  const contextMode = typeof meta.context_mode === 'string' ? meta.context_mode : null;
  return { inputCells: rows * columns, predictCells: predictions, contextMode };
}

/**
 * The model id usage is accounted against. Deep Context is a separate SAP price tier of the
 * large model, so a call the response reports as `context_mode: "deep"` is accounted on
 * `<bare-model>--deep-context` - any `--deployed` suffix is stripped first, since the admin's
 * Deep Context row is a pricing-only library entry derived from the bare id, falling back to the
 * base model's (modelCostService / sapCapacityService twin rules). A non-deep call is accounted
 * on `model` unchanged, `--deployed` and all.
 */
export function accountedModel(model: string, contextMode: string | null): string {
  if (contextMode !== 'deep') return model;
  const base = model.endsWith('--deployed') ? model.slice(0, -'--deployed'.length) : model;
  return `${base}${DEEP_CONTEXT_SUFFIX}`;
}
