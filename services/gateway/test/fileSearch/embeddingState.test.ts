import { describe, it, expect } from '@jest/globals';
import { embeddingState } from '../../src/fileSearch/embeddingState';

describe('embeddingState', () => {
  const config = { embeddingModel: 'text-embedding-3-large', embeddingDimensions: 1536 };

  it.each([
    ['same model, same dimension → current', 'text-embedding-3-large', 1536, 'current'],
    ['other model, same dimension → outdated', 'text-embedding-3-small', 1536, 'outdated'],
    ['same model, other dimension → dimension_mismatch', 'text-embedding-3-large', 3072, 'dimension_mismatch'],
    ['other model, other dimension → dimension_mismatch (the dimension wins)', 'text-embedding-3-small', 3072, 'dimension_mismatch'],
  ])('%s', (_label, model, dim, expected) => {
    expect(embeddingState({ embedding_model: model as string, embedding_dim: dim as number }, config)).toBe(expected);
  });

  it('compares the model name exactly (no case folding, no trimming)', () => {
    expect(embeddingState({ embedding_model: 'Text-Embedding-3-Large', embedding_dim: 1536 }, config)).toBe('outdated');
  });
});
