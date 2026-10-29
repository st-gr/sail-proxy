/**
 * searchVectorStores and parent sections (`file_search.parent_sections`), with recall,
 * rerank and the sibling read mocked: which surface gets parents under which scope,
 * same-section collapse with refill, static hits untouched, the chunk as fallback, and
 * the reranker's input option. Parent assembly itself: parentSections.test.ts; against
 * Postgres: integration/structuredIngestSearch.test.ts.
 */
import { describe, it, expect, jest, beforeEach, afterAll } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));

let mockConfig: any;
jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
  getTeacherLoggingConfig: () => ({ enabled: false, storeChunkText: false, sampleRate: 1, source: 'file_search', maxConcurrentWrites: 5 }),
}));

const poolQuery = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../../src/fileSearch/db', () => ({
  __esModule: true,
  getPool: () => ({ query: (...a: any[]) => poolQuery(...a), connect: jest.fn() }),
  isFileSearchAvailable: () => true,
}));

const embedMock = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../../src/fileSearch/embedder', () => {
  const actual: any = jest.requireActual('../../src/fileSearch/embedder');
  return { ...actual, embed: (...a: any[]) => embedMock(...a) };
});

const rerankMock = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../../src/fileSearch/reranker', () => {
  const actual: any = jest.requireActual('../../src/fileSearch/reranker');
  return { ...actual, rerank: (...a: any[]) => rerankMock(...a) };
});

const recallMock = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../../src/fileSearch/repository', () => {
  const actual: any = jest.requireActual('../../src/fileSearch/repository');
  return { ...actual, recallCandidates: (...a: any[]) => recallMock(...a), touchStoreActivity: async () => undefined };
});

const loadParentsMock = jest.fn<(...args: any[]) => Promise<Array<{ text: string; pages?: { first: number; last: number } } | null>>>();
jest.mock('../../src/fileSearch/parentSections', () => {
  const actual: any = jest.requireActual('../../src/fileSearch/parentSections');
  return { ...actual, loadParentSections: (...a: any[]) => loadParentsMock(...a) };
});

import { searchVectorStores, setRerankInput } from '../../src/fileSearch/search';
import type { CandidateChunk } from '../../src/fileSearch/repository';

/** A structured candidate of section `section` of file `file`. */
function structured(i: number, file: string, section: number, extra: Partial<CandidateChunk> = {}): CandidateChunk {
  return {
    storeId: 'vs_owned', fileId: file, filename: `${file}.md`, ord: i, text: `chunk ${i}`, attributes: {},
    score: 1 - i / 100, generation: 0, section, sectionOffset: i * 10, ...extra,
  };
}
function legacy(i: number, file: string): CandidateChunk {
  return { storeId: 'vs_owned', fileId: file, filename: `${file}.txt`, ord: i, text: `legacy ${i}`, attributes: {}, score: 1 - i / 100 };
}

// Ranked best first: two hits of section A (0, 2), one of B, a legacy chunk, another of A, one of C.
const CANDIDATES = [
  structured(0, 'f1', 0), structured(1, 'f1', 1), structured(2, 'f1', 0), legacy(3, 'f2'),
  structured(4, 'f1', 0), structured(5, 'f3', 0),
];

const base = { storeIds: ['vs_owned'], query: 'q', ownerEmail: 'owner@example.com', maxNumResults: 4 };

beforeEach(() => {
  jest.clearAllMocks();
  setRerankInput(null);
  mockConfig = {
    embeddingModel: 'm', embeddingDimensions: 3, rewriteQuery: false,
    hybrid: { candidates: 50, rrfK: 60, lexicalEnabled: true, lexicalQuery: 'any', rerank: { enabled: 'auto', model: 'cohere-reranker', input: 'text' } },
    parentSections: { maxTokens: 1500, scope: 'tool' },
  };
  poolQuery.mockResolvedValue({ rows: [{ id: 'vs_owned', embedding_dim: 3, embedding_model: 'm', status: 'completed' }] });
  embedMock.mockResolvedValue({ vectors: [[1, 0, 0]], usage: { promptTokens: 1, totalTokens: 1 } });
  recallMock.mockResolvedValue(CANDIDATES);
  rerankMock.mockResolvedValue(null); // RRF order
  loadParentsMock.mockImplementation(async (hits: any[]) => hits.map((h) => ({ text: `parent of ${h.fileId}#${h.section} around ${h.ord}` })));
});
afterAll(() => setRerankInput(null));

const texts = (r: any) => r.data.map((d: any) => d.content[0].text);

describe('parent sections by surface and scope', () => {
  it('the tool gets parents by default: one result per section (its best hit), refilled, legacy chunks as they are', async () => {
    const r = await searchVectorStores({ ...base, surface: 'tool' });
    expect(texts(r)).toEqual([
      'parent of f1#0 around 0', // A, best hit 0; hits 2 and 4 collapse into it
      'parent of f1#1 around 1', // B
      'legacy 3', // static/legacy: unchanged
      'parent of f3#0 around 5', // refilled: C (another file's section 0 is another section)
    ]);
    expect(r.data.map((d) => d.score)).toEqual([CANDIDATES[0].score, CANDIDATES[1].score, CANDIDATES[3].score, CANDIDATES[5].score]);
    expect(loadParentsMock).toHaveBeenCalledTimes(1);
    const [hits, maxTokens] = loadParentsMock.mock.calls[0];
    expect(maxTokens).toBe(1500);
    expect(hits).toEqual([
      { storeId: 'vs_owned', fileId: 'f1', generation: 0, section: 0, ord: 0, sectionOffset: 0, text: 'chunk 0' },
      { storeId: 'vs_owned', fileId: 'f1', generation: 0, section: 1, ord: 1, sectionOffset: 10, text: 'chunk 1' },
      { storeId: 'vs_owned', fileId: 'f3', generation: 0, section: 0, ord: 5, sectionOffset: 50, text: 'chunk 5' },
    ]);
  });

  it('the REST search keeps returning chunks under scope "tool": no collapse, no sibling read', async () => {
    const r = await searchVectorStores(base);
    expect(texts(r)).toEqual(['chunk 0', 'chunk 1', 'chunk 2', 'legacy 3']);
    expect(loadParentsMock).not.toHaveBeenCalled();
  });

  it('scope "all" gives the REST search parents too; scope "off" gives nobody parents', async () => {
    mockConfig.parentSections.scope = 'all';
    expect(texts(await searchVectorStores(base))[0]).toBe('parent of f1#0 around 0');
    mockConfig.parentSections.scope = 'off';
    expect(texts(await searchVectorStores({ ...base, surface: 'tool' }))).toEqual(['chunk 0', 'chunk 1', 'chunk 2', 'legacy 3']);
  });

  it('a hit whose section could not be rebuilt is returned as its chunk', async () => {
    loadParentsMock.mockImplementation(async (hits: any[]) => hits.map((h, i) => (i === 1 ? null : { text: `parent ${h.ord}` })));
    expect(texts(await searchVectorStores({ ...base, surface: 'tool' }))).toEqual(['parent 0', 'chunk 1', 'legacy 3', 'parent 5']);
  });

  it('an invalid configuration falls back to 1500 tokens and the tool scope', async () => {
    mockConfig.parentSections = { maxTokens: 50, scope: 'everywhere' };
    await searchVectorStores({ ...base, surface: 'tool' });
    expect(loadParentsMock.mock.calls[0][1]).toBe(1500);
    loadParentsMock.mockClear();
    await searchVectorStores(base);
    expect(loadParentsMock).not.toHaveBeenCalled();
  });

  it('score_threshold applies before the collapse', async () => {
    rerankMock.mockResolvedValue({ hits: CANDIDATES.map((_, index) => ({ index, relevanceScore: index === 0 ? 0.1 : 0.9 - index / 100 })) });
    const r = await searchVectorStores({ ...base, surface: 'tool', rankingOptions: { scoreThreshold: 0.5 } });
    // hit 0 is below the threshold, so section A is represented by its next hit, 2
    expect(texts(r)[0]).toBe('parent of f1#1 around 1');
    expect(texts(r)).toContain('parent of f1#0 around 2');
  });
});

describe('pages on hits', () => {
  it('a chunk carries its stored pages, a parent its own, a hit without pages none; the hit\'s pages reach the parent loader', async () => {
    recallMock.mockResolvedValue([
      structured(0, 'f1', 0, { pages: { first: 4, last: 4 } }), structured(1, 'f1', 1, { pages: { first: 6, last: 7 } }),
      legacy(3, 'f2'),
    ]);
    loadParentsMock.mockImplementation(async (hits: any[]) => hits.map((h) => (h.ord === 0
      ? { text: 'parent 0', pages: { first: 3, last: 5 } } : null)));
    const api = await searchVectorStores(base);
    expect(api.data.map((d) => d.pages)).toEqual([{ first: 4, last: 4 }, { first: 6, last: 7 }, undefined]);
    expect(api.data.map((d) => 'pages' in d)).toEqual([true, true, false]);
    const tool = await searchVectorStores({ ...base, surface: 'tool' });
    expect(tool.data.map((d) => [d.content[0].text, d.pages])).toEqual([
      ['parent 0', { first: 3, last: 5 }], ['chunk 1', { first: 6, last: 7 }], ['legacy 3', undefined],
    ]);
    expect(loadParentsMock.mock.calls[0][0].map((h: any) => h.pages)).toEqual([{ first: 4, last: 4 }, { first: 6, last: 7 }]);
  });
});

describe('reranker input', () => {
  beforeEach(() => { recallMock.mockResolvedValue([structured(0, 'f1', 0, { context: 'Guide > Ports' }), legacy(1, 'f2')]); });

  it('follows hybrid.rerank.input: context + text where a chunk has a context, else the text', async () => {
    mockConfig.hybrid.rerank.input = 'context_and_text';
    await searchVectorStores(base);
    expect(rerankMock.mock.calls[0][1]).toEqual(['Guide > Ports\n\nchunk 0', 'legacy 1']);
    mockConfig.hybrid.rerank.input = 'text';
    await searchVectorStores(base);
    expect(rerankMock.mock.calls[1][1]).toEqual(['chunk 0', 'legacy 1']);
  });

  it('an invalid configured input reads context + text, the default', async () => {
    mockConfig.hybrid.rerank.input = 'both';
    await searchVectorStores(base);
    expect(rerankMock.mock.calls[0][1]).toEqual(['Guide > Ports\n\nchunk 0', 'legacy 1']);
  });

  it('the evaluation runner\'s override wins over the configuration until it is cleared', async () => {
    mockConfig.hybrid.rerank.input = 'context_and_text';
    setRerankInput('text');
    await searchVectorStores(base);
    expect(rerankMock.mock.calls[0][1]).toEqual(['chunk 0', 'legacy 1']);
    setRerankInput(null);
    await searchVectorStores(base);
    expect(rerankMock.mock.calls[1][1]).toEqual(['Guide > Ports\n\nchunk 0', 'legacy 1']);
    expect(() => setRerankInput('both' as any)).toThrow();
  });
});
