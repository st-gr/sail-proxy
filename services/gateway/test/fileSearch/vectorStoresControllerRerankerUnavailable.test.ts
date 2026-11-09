/**
 * `POST /vector_stores/{id}/search` is a thin HTTP wrapper over
 * `search.ts`'s `searchVectorStores`, which can throw `RerankerUnavailableError`
 * (reranker.ts) when `hybrid.rerank.enabled: true` and no deployment is found.
 *
 * `handleKnownError` (vectorStoresController.ts) used to have no branch for that
 * class, so it fell through to `next(err)` -> the generic `errorHandler.ts`, which
 * reads `err.status` correctly (503) but writes `code: statusCode` — the NUMBER
 * 503 — into the body instead of the string `'file_search_unavailable'` every
 * other file_search-unavailability response uses. A unit assertion on the error
 * class alone (status/code properties) would not catch that: only driving the
 * real controller and reading the actual response body would. That is what this
 * file does — it never imports `RerankerUnavailableError`'s properties directly,
 * only asserts on `res.statusCode`/`res.body`.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

jest.mock('../../src/fileSearch/db', () => ({
  isFileSearchAvailable: () => true,
  getPool: () => ({ query: jest.fn() }),
}));

jest.mock('../../src/services/configService', () => ({
  getFileSearchConfig: () => ({
    embeddingModel: 'text-embedding-3-large',
    embeddingDimensions: 1536,
    limits: { maxFilesPerStore: 10000 },
  }),
}));

const mockSearchVectorStores = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../../src/fileSearch/search', () => {
  const actual: any = jest.requireActual('../../src/fileSearch/search');
  return { ...actual, searchVectorStores: (...args: any[]) => mockSearchVectorStores(...args) };
});

import * as vectorStoresController from '../../src/controllers/vectorStoresController';
import { RerankerUnavailableError } from '../../src/fileSearch/reranker';
import errorHandler from '../../src/middlewares/errorHandler';

function makeRes(): any {
  const res: any = { headersSent: false, statusCode: 200 };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((body: any) => { res.body = body; return res; });
  return res;
}

function baseReq(overrides: Record<string, any> = {}): any {
  return {
    headers: {}, params: { id: 'vs_aaaaaaaaaaaaaaaaaaaaaaaa' }, query: {},
    body: { query: 'what is x?' },
    apiKeyInfo: { email: 'owner@example.com' },
    ...overrides,
  };
}

describe('vectorStoresController — searchVectorStore, RerankerUnavailableError envelope', () => {
  beforeEach(() => {
    mockSearchVectorStores.mockReset();
  });

  it('responds 503 with the file_search_unavailable string envelope, not the generic numeric one', async () => {
    mockSearchVectorStores.mockRejectedValue(
      new RerankerUnavailableError('No RUNNING SAP AI Core reranker deployment was found for file_search'),
    );
    const req = baseReq();
    const res = makeRes();
    // Wired to the REAL error-handling middleware, not a bare jest.fn(): if
    // handleKnownError's RerankerUnavailableError branch is ever removed, the
    // controller calls next(err), which — unmocked — would fall through to this
    // exact middleware in the running app. Routing it here for real is what makes
    // the mutation check below observe the actual malformed body (numeric `code`)
    // instead of just "next was called".
    const next = (err: unknown) => errorHandler(err as Error, req, res, () => {});

    await vectorStoresController.searchVectorStore(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.body.error.code).toBe('file_search_unavailable');
    expect(typeof res.body.error.code).toBe('string');
    expect(res.body.error.type).toBe('file_search_unavailable');
    expect(res.body.error.message).toBe('No RUNNING SAP AI Core reranker deployment was found for file_search');
  });
});
