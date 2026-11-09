/**
 * Library tile badges: "Deployed" on a foundation card whose deployment sibling exists,
 * "Deployment" on a deployment row, the retirement date (G) and "Not routable" (M). Kept in its
 * own module - like
 * contextWindow/costDisplay - because formatter.ts pulls in sap/ui/core/IconPool, which this
 * app's jest setup cannot resolve; formatter delegates here.
 */

/**
 * A deployment row's baseModel is its foundation row's modelId, so the controller's
 * /library/deployedBaseModels map is keyed by exactly the modelId this formatter is bound to.
 * Deployment rows never get the badge - they carry their own "Deployment" one.
 */
export function isDeployed(
  modelId: string | null | undefined,
  accessType: string | null | undefined,
  deployedMap: Record<string, boolean> | null | undefined
): boolean {
  return accessType === 'foundation' && !!modelId && !!deployedMap?.[modelId];
}

export function isDeployment(accessType: string | null | undefined): boolean {
  return accessType === 'deployment';
}

/**
 * Resolves an i18n key — the view binds the bundle pattern as the formatter's second part; jest
 * passes none and gets the English default below, so the module keeps no UI5 imports.
 */
export type Translator = (key: string) => string;
/** English defaults: each value is byte-identical to the literal it replaced, so the pure tests hold. */
const EN_TEXTS: Record<string, string> = { retiresOn: 'Retires {0}' };
const defaultTranslate: Translator = (key) => EN_TEXTS[key] ?? key;

/**
 * "Retires <YYYY-MM-DD>" through the bundle pattern `retiresOn` ("Retires {0}"), which the view
 * binds as the second part (the formatter cannot read the async bundle itself). Accepts the raw Edm.Date string the binding
 * hands over with targetType 'any' (see contextWindow), a Date, or an already type-formatted
 * string, which is passed through unchanged after the prefix.
 */
export function retires(date: string | Date | null | undefined, pattern?: string | null): string {
  if (!date) return '';
  const text = (day: string) => (pattern || defaultTranslate('retiresOn')).replace('{0}', day);
  if (date instanceof Date) return text(date.toISOString().slice(0, 10));
  const s = String(date).trim();
  if (!s) return '';
  return text(/^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s);
}

/**
 * M: a foundation model without SAP's orchestration scenario cannot be called by its bare name
 * through the gateway - but its deployment can, and LLM Access (the foundation-models scenario)
 * is what allows deploying it. So such a model is "deployment only", not unusable. A deployment
 * row never gets either badge: it is callable by definition.
 */
export function deploymentOnly(
  accessType: string | null | undefined,
  llmAccess: boolean | null | undefined,
  orchestration: boolean | null | undefined
): boolean {
  return accessType === 'foundation' && !!llmAccess && !orchestration;
}

/** Neither scenario: SAP AI Core lists the model but allows no way to call it. */
export function notCallable(
  accessType: string | null | undefined,
  llmAccess: boolean | null | undefined,
  orchestration: boolean | null | undefined
): boolean {
  return accessType === 'foundation' && !llmAccess && !orchestration;
}
