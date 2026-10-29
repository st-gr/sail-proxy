/**
 * How a model in the usage statistics is reached: 'foundation' (called by its bare name) or
 * 'deployment' (served by a deployment). A model and its deployment-served twin share one
 * display name, so the Usage app needs this to tell their rows apart.
 *
 * The Model Library stores it per model and is trusted first: a deployment row need not carry
 * the id suffix (the derived `--deep-context` rows do not). For a model the library has no row
 * for, the gateway's `--deployed` id suffix decides; an unknown bare id stays null rather than
 * guessed.
 */
export type ModelAccessType = 'foundation' | 'deployment';

const DEPLOYED_SUFFIX = '--deployed';

export function modelAccessType(libraryAccessType: unknown, modelId: unknown): ModelAccessType | null {
  if (libraryAccessType === 'foundation' || libraryAccessType === 'deployment') return libraryAccessType;
  return typeof modelId === 'string' && modelId.endsWith(DEPLOYED_SUFFIX) ? 'deployment' : null;
}
