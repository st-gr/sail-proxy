/**
 * How a store's pinned embedding model relates to the configured one (spec §5.4):
 * - `current`: same model and dimension;
 * - `outdated`: another model with the same dimension — the store keeps answering with its
 *   own model and can be re-embedded in place;
 * - `dimension_mismatch`: another dimension — wins over `outdated`, because a re-embed
 *   cannot fit the fixed-width vector column, so no action is offered.
 * Pure; the caller passes the configuration it holds.
 */
export type EmbeddingState = 'current' | 'outdated' | 'dimension_mismatch';

export function embeddingState(
  store: { embedding_model: string; embedding_dim: number },
  config: { embeddingModel: string; embeddingDimensions: number },
): EmbeddingState {
  if (store.embedding_dim !== config.embeddingDimensions) return 'dimension_mismatch';
  if (store.embedding_model !== config.embeddingModel) return 'outdated';
  return 'current';
}
