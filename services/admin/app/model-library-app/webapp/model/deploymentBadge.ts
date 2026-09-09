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
 * "Retires <YYYY-MM-DD>". The word is a constant here rather than an i18n lookup: the resource
 * bundle is async, so a formatter cannot read it. Accepts the raw Edm.Date string the binding
 * hands over with targetType 'any' (see contextWindow), a Date, or an already type-formatted
 * string, which is passed through unchanged after the prefix.
 */
export function retires(date: string | Date | null | undefined): string {
  if (!date) return '';
  if (date instanceof Date) return `Retires ${date.toISOString().slice(0, 10)}`;
  const s = String(date).trim();
  if (!s) return '';
  return `Retires ${/^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s}`;
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
