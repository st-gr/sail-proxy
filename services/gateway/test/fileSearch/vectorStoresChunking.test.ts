/**
 * The OpenAI vector-store routes and chunking (W2 Q4): an unknown or invalid
 * `chunking_strategy` is a 400 with OpenAI's error shape on store create, attach and
 * file batch (it used to be stored and silently chunked at 800/400), a valid one is
 * stored normalised, and a `vector_store.file` reports `{type: 'other'}` when the
 * effective strategy is `structure`, else its resolved static parameters.
 *
 * Same mock split as vectorStoresController.test.ts: the DB-touching primitives are
 * mocked; their SQL is covered by the integration suite.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const loggerWarn: any = jest.fn();
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: (...a: any[]) => loggerWarn(...a), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));

const poolQuery: any = jest.fn();
jest.mock('../../src/fileSearch/db', () => ({
  isFileSearchAvailable: () => true,
  getPool: () => ({ query: poolQuery }),
}));

jest.mock('../../src/services/configService', () => ({
  getFileSearchConfig: () => ({
    embeddingModel: 'text-embedding-3-large',
    embeddingDimensions: 1536,
    limits: { maxFilesPerStore: 10000 },
  }),
}));

jest.mock('../../src/fileSearch/repository', () => {
  const actual: any = jest.requireActual('../../src/fileSearch/repository');
  return { ...actual, createStore: jest.fn(), attachFile: jest.fn(), enqueueIngestion: jest.fn() };
});

const createBatch: any = jest.fn();
jest.mock('../../src/fileSearch/batches', () => {
  const actual: any = jest.requireActual('../../src/fileSearch/batches');
  return { ...actual, createBatch: (...a: any[]) => createBatch(...a) };
});

import * as ctrl from '../../src/controllers/vectorStoresController';
import { createStore, attachFile, enqueueIngestion } from '../../src/fileSearch/repository';

const mockCreateStore = createStore as any;
const mockAttachFile = attachFile as any;
const mockEnqueue = enqueueIngestion as any;

const STORE_ID = 'vs_aaaaaaaaaaaaaaaaaaaaaaaa';
const FILE_ID = 'file-aaaaaaaaaaaaaaaaaaaaaaaa';
const STRUCTURE = { type: 'structure', max_tokens: 800, overlap_tokens: 0, contextual: false };
const STATIC_300 = { type: 'static', max_tokens: 300, overlap_tokens: 100, contextual: false };

function makeRes(): any {
  const res: any = { statusCode: 200 };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((body: any) => { res.body = body; return res; });
  return res;
}

function req(overrides: Record<string, any> = {}): any {
  return { headers: {}, params: {}, query: {}, body: {}, apiKeyInfo: { email: 'owner@example.com' }, ...overrides };
}

function storeRow(overrides: Record<string, any> = {}): any {
  return {
    id: STORE_ID, owner_email: 'owner@example.com', is_shared: false, name: 's', status: 'completed', metadata: {},
    embedding_model: 'text-embedding-3-large', embedding_dim: 1536, active_generation: 1, chunking: null,
    expires_after: null, expires_at: null, last_active_at: new Date(0), created_at: new Date(0), ...overrides,
  };
}

function fileRow(overrides: Record<string, any> = {}): any {
  return {
    store_id: STORE_ID, file_id: FILE_ID, attributes: {}, chunking_strategy: null, status: 'completed',
    last_error: null, usage_bytes: 10, claimed_at: null, attempts: 0, batch_id: null, created_at: new Date(0),
    ...overrides,
  };
}

const ROUTES: Array<[string, (body: Record<string, unknown>) => Promise<any>]> = [
  ['store create', async (body) => {
    const res = makeRes();
    await ctrl.createVectorStore(req({ body: { file_ids: [FILE_ID], ...body } }), res, jest.fn());
    return res;
  }],
  ['attach', async (body) => {
    const res = makeRes();
    await ctrl.createVectorStoreFile(req({ params: { id: STORE_ID }, body: { file_id: FILE_ID, ...body } }), res, jest.fn());
    return res;
  }],
  ['file batch', async (body) => {
    const res = makeRes();
    await ctrl.createVectorStoreFileBatch(req({ params: { id: STORE_ID }, body: { file_ids: [FILE_ID], ...body } }), res, jest.fn());
    return res;
  }],
];

beforeEach(() => {
  poolQuery.mockReset();
  mockCreateStore.mockReset();
  mockAttachFile.mockReset();
  mockEnqueue.mockReset();
  createBatch.mockReset();
});

describe('an invalid chunking_strategy is a 400 before anything is written', () => {
  it.each(ROUTES)('%s: an unknown type', async (_name, call) => {
    for (const type of ['structure', 'other', 'semantic']) {
      poolQuery.mockReset();
      // eslint-disable-next-line no-await-in-loop
      const res = await call({ chunking_strategy: { type } });
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        error: {
          message: `Invalid value: '${type}'. Supported values are: 'auto' and 'static'.`,
          type: 'invalid_request_error',
          param: 'chunking_strategy.type',
          code: 'invalid_value',
        },
      });
      expect(poolQuery).not.toHaveBeenCalled();
    }
    expect(mockCreateStore).not.toHaveBeenCalled();
    expect(mockAttachFile).not.toHaveBeenCalled();
    expect(createBatch).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('%s: static out of range', async (_name, call) => {
    const res = await call({ chunking_strategy: { type: 'static', static: { max_chunk_size_tokens: 800, chunk_overlap_tokens: 401 } } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatchObject({
      type: 'invalid_request_error', param: 'chunking_strategy.static.chunk_overlap_tokens', code: 'invalid_value',
    });
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('%s: static without its parameters', async (_name, call) => {
    const res = await call({ chunking_strategy: { type: 'static' } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatchObject({ param: 'chunking_strategy.static', code: 'missing_required_parameter' });
  });
});

describe('a valid chunking_strategy reaches the file rows normalised', () => {
  const STATIC = { type: 'static', static: { max_chunk_size_tokens: 200, chunk_overlap_tokens: 50 } };

  it('store create: applies to the files attached at creation', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ id: FILE_ID }] }); // findUnownedFileId: all owned
    mockCreateStore.mockResolvedValueOnce(storeRow({ chunking: STRUCTURE }));
    poolQuery.mockResolvedValue({ rows: [] }); // usage
    const res = await ROUTES[0][1]({ chunking_strategy: { ...STATIC, extra: 1 } });
    expect(res.statusCode).toBe(200);
    expect(mockAttachFile.mock.calls[0][3]).toEqual(STATIC);
    // the OpenAI body never chooses the store setting; createStore resolves the installation default
    expect(mockCreateStore.mock.calls[0][0]).not.toHaveProperty('chunking');
    expect(res.body).not.toHaveProperty('chunking');
  });

  it('attach: stores auto as auto and reports the store setting it resolves to', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [storeRow({ chunking: STRUCTURE })] })
      .mockResolvedValueOnce({ rows: [{ id: FILE_ID }] })
      .mockResolvedValueOnce({ rows: [{ count: 0 }] });
    mockAttachFile.mockResolvedValueOnce(fileRow({ chunking_strategy: { type: 'auto' }, status: 'in_progress' }));
    const res = await ROUTES[1][1]({ chunking_strategy: { type: 'auto' } });
    expect(res.statusCode).toBe(200);
    expect(mockAttachFile.mock.calls[0][3]).toEqual({ type: 'auto' });
    expect(res.body.chunking_strategy).toEqual({ type: 'other' });
  });

  it('attach: an explicit static file in a structure store reports its static parameters', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [storeRow({ chunking: STRUCTURE })] })
      .mockResolvedValueOnce({ rows: [{ id: FILE_ID }] })
      .mockResolvedValueOnce({ rows: [{ count: 0 }] });
    mockAttachFile.mockResolvedValueOnce(fileRow({ chunking_strategy: STATIC }));
    const res = await ROUTES[1][1]({ chunking_strategy: STATIC });
    expect(res.body.chunking_strategy).toEqual(STATIC);
  });

  it('file batch: passes the normalised strategy to every member', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [storeRow()] })
      .mockResolvedValueOnce({ rows: [{ id: FILE_ID }] }) // findUnownedFileId: all owned
      .mockResolvedValueOnce({ rows: [] }) // already attached
      .mockResolvedValueOnce({ rows: [{ count: 0 }] });
    createBatch.mockResolvedValueOnce({ id: 'vsfb_x', store_id: STORE_ID, created_at: new Date(0) });
    poolQuery.mockResolvedValue({ rows: [] });
    await ROUTES[2][1]({ chunking_strategy: { ...STATIC, junk: true } });
    expect(createBatch.mock.calls[0][3]).toEqual(STATIC);
  });
});

describe('vector_store.file chunking_strategy', () => {
  it.each<[string, unknown, unknown, unknown]>([
    ['auto in a NULL (legacy) store: static 800/400', { type: 'auto' }, null,
      { type: 'static', static: { max_chunk_size_tokens: 800, chunk_overlap_tokens: 400 } }],
    ['none in a NULL store: static 800/400', null, null,
      { type: 'static', static: { max_chunk_size_tokens: 800, chunk_overlap_tokens: 400 } }],
    ['none in a static store: the store\'s parameters', null, STATIC_300,
      { type: 'static', static: { max_chunk_size_tokens: 300, chunk_overlap_tokens: 100 } }],
    ['none in a structure store: other', null, STRUCTURE, { type: 'other' }],
    ['explicit static in a structure store: its own parameters',
      { type: 'static', static: { max_chunk_size_tokens: 200, chunk_overlap_tokens: 0 } }, STRUCTURE,
      { type: 'static', static: { max_chunk_size_tokens: 200, chunk_overlap_tokens: 0 } }],
    ['a legacy static row without parameters: static 800/400, as the old worker chunked it', { type: 'static' }, STRUCTURE,
      { type: 'static', static: { max_chunk_size_tokens: 800, chunk_overlap_tokens: 400 } }],
    ['a legacy out-of-range static row: static 800/400', { type: 'static', static: { max_chunk_size_tokens: 5, chunk_overlap_tokens: 0 } }, null,
      { type: 'static', static: { max_chunk_size_tokens: 800, chunk_overlap_tokens: 400 } }],
    ['an invalid store setting: other, never auto', null, { type: 'semantic', max_tokens: 800, overlap_tokens: 0 }, { type: 'other' }],
  ])('retrieve — %s', async (_name, fileStrategy, storeChunking, expected) => {
    poolQuery.mockResolvedValueOnce({ rows: [{ ...fileRow({ chunking_strategy: fileStrategy }), store_chunking: storeChunking }] });
    const res = makeRes();
    await ctrl.retrieveVectorStoreFile(req({ params: { id: STORE_ID, file_id: FILE_ID } }), res, jest.fn());
    expect(res.statusCode).toBe(200);
    expect(res.body.chunking_strategy).toEqual(expected);
    expect(res.body).not.toHaveProperty('store_chunking');
    expect(poolQuery.mock.calls[0][0]).toMatch(/vs\.chunking AS store_chunking/);
  });

  it('an invalid store setting is logged as a warning', async () => {
    loggerWarn.mockReset();
    poolQuery.mockResolvedValueOnce({ rows: [{ ...fileRow(), store_chunking: { type: 'static', max_tokens: 5, overlap_tokens: 0 } }] });
    const res = makeRes();
    await ctrl.retrieveVectorStoreFile(req({ params: { id: STORE_ID, file_id: FILE_ID } }), res, jest.fn());
    expect(res.body.chunking_strategy).toEqual({ type: 'other' });
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(String(loggerWarn.mock.calls[0][1])).toContain(STORE_ID);
  });

  it('modify reports the same', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ ...fileRow(), store_chunking: STRUCTURE }] });
    const res = makeRes();
    await ctrl.modifyVectorStoreFile(req({ params: { id: STORE_ID, file_id: FILE_ID }, body: { attributes: { a: 'b' } } }), res, jest.fn());
    expect(res.body.chunking_strategy).toEqual({ type: 'other' });
    expect(poolQuery.mock.calls[0][0]).toMatch(/vs\.chunking AS store_chunking/);
  });

  it('the store file list reports it from the store\'s setting', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [{ id: STORE_ID, chunking: STRUCTURE }] })
      .mockResolvedValueOnce({ rows: [fileRow(), fileRow({ file_id: 'file-b', chunking_strategy: { type: 'static', static: { max_chunk_size_tokens: 100, chunk_overlap_tokens: 0 } } })] });
    const res = makeRes();
    await ctrl.listVectorStoreFiles(req({ params: { id: STORE_ID } }), res, jest.fn());
    expect(res.statusCode).toBe(200);
    expect(res.body.data.map((f: any) => f.chunking_strategy)).toEqual([
      { type: 'other' },
      { type: 'static', static: { max_chunk_size_tokens: 100, chunk_overlap_tokens: 0 } },
    ]);
    expect(poolQuery.mock.calls[0][0]).toMatch(/SELECT id, chunking FROM vector_stores/);
  });

  it('the batch file list reports it from the store\'s setting', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [{ id: STORE_ID, chunking: STRUCTURE }] })
      .mockResolvedValue({ rows: [] });
    poolQuery.mockImplementation(async (sql: string) => {
      if (/FROM vector_store_batches/.test(sql)) return { rows: [{ id: 'vsfb_x', store_id: STORE_ID, created_at: new Date(0) }] };
      return { rows: [fileRow({ batch_id: 'vsfb_x' })] };
    });
    const res = makeRes();
    await ctrl.listVectorStoreFileBatchFiles(req({ params: { id: STORE_ID, batch_id: 'vsfb_x' } }), res, jest.fn());
    expect(res.statusCode).toBe(200);
    expect(res.body.data[0].chunking_strategy).toEqual({ type: 'other' });
  });
});
