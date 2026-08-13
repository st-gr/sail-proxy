import { getFileSearchConfig } from '../../src/services/configService';

describe('getFileSearchConfig', () => {
  it('returns the shipped defaults', () => {
    const c = getFileSearchConfig();
    expect(c.enabled).toBe(true);
    expect(c.embeddingDimensions).toBe(1536);
    expect(c.chunking.maxChunkSizeTokens).toBe(800);
    expect(c.chunking.chunkOverlapTokens).toBe(400);
    expect(c.hybrid.candidates).toBe(50);
    expect(c.hybrid.rerank.enabled).toBe('auto');
    expect(c.hybrid.rerank.model).toBe('cohere-reranker');
    expect(c.blobStorage.backend).toBe('db');
  });

  it('never returns cohere-reranker-35, which this tenant does not deploy', () => {
    expect(getFileSearchConfig().hybrid.rerank.model).not.toBe('cohere-reranker-35');
  });
});
