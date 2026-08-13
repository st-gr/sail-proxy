/**
 * vectorStoresController + the pure repository helpers it leans on
 * (validateAttributes, assertStoreDimension): availability guard,
 * 404-not-403 ownership scoping (asserted on the SQL text and bound
 * params, not just on what the mock happens to return — mutating the
 * WHERE clause out of any of these sites must make its named test fail),
 * attribute/metadata shape validation, and the embedding-dimension guard.
 *
 * `createStore`/`attachFile`/`enqueueIngestion`/`deleteStoreFile`/
 * `deleteStoreCascade` are mocked here (same split as
 * blobStore.test.ts/blobStore.integration.test.ts: the DB-touching
 * transactional primitives get real Postgres coverage in
 * test/fileSearch/integration/vectorStoresController.test.ts, not a mock
 * standing in for a real INSERT/transaction). `validateAttributes` and
 * `assertStoreDimension` are pure (or config-only) and kept real via
 * `jest.requireActual`.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const loggerError = jest.fn();
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: (...args: any[]) => loggerError(...args),
    warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

const dbState: { available: boolean } = { available: true };
const poolQuery: any = jest.fn();
jest.mock('../../src/fileSearch/db', () => ({
  isFileSearchAvailable: () => dbState.available,
  getPool: () => ({ query: poolQuery }),
}));

const configState = { maxFilesPerStore: 10000, embeddingDimensions: 1536, embeddingModel: 'text-embedding-3-large' };
jest.mock('../../src/services/configService', () => ({
  getFileSearchConfig: () => ({
    embeddingModel: configState.embeddingModel,
    embeddingDimensions: configState.embeddingDimensions,
    limits: { maxFilesPerStore: configState.maxFilesPerStore },
  }),
}));

jest.mock('../../src/fileSearch/repository', () => {
  const actual: any = jest.requireActual('../../src/fileSearch/repository');
  return {
    ...actual,
    createStore: jest.fn(),
    attachFile: jest.fn(),
    enqueueIngestion: jest.fn(),
    deleteStoreFile: jest.fn(),
    deleteStoreCascade: jest.fn(),
  };
});

import * as vectorStoresController from '../../src/controllers/vectorStoresController';
import {
  validateAttributes,
  assertStoreDimension,
  createStore,
  attachFile,
  enqueueIngestion,
  deleteStoreFile,
  deleteStoreCascade,
} from '../../src/fileSearch/repository';

const mockCreateStore = createStore as any;
const mockAttachFile = attachFile as any;
const mockEnqueueIngestion = enqueueIngestion as any;
const mockDeleteStoreFile = deleteStoreFile as any;
const mockDeleteStoreCascade = deleteStoreCascade as any;

function makeRes(): any {
  const res: any = { headersSent: false, statusCode: 200 };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((body: any) => { res.body = body; return res; });
  res.set = jest.fn((..._args: any[]) => res);
  res.send = jest.fn((body: any) => { res.body = body; return res; });
  return res;
}

function baseReq(overrides: Record<string, any> = {}): any {
  return {
    headers: {}, params: {}, query: {}, body: {},
    apiKeyInfo: { email: 'owner@example.com' },
    ...overrides,
  };
}

function storeRow(overrides: Record<string, any> = {}): any {
  return {
    id: 'vs_aaaaaaaaaaaaaaaaaaaaaaaa',
    owner_email: 'owner@example.com',
    is_shared: false,
    name: 'my store',
    status: 'completed',
    metadata: {},
    embedding_model: 'text-embedding-3-large',
    embedding_dim: 1536,
    expires_after: null,
    expires_at: null,
    last_active_at: new Date('2026-01-01T00:00:00Z'),
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function storeFileRow(overrides: Record<string, any> = {}): any {
  return {
    store_id: 'vs_aaaaaaaaaaaaaaaaaaaaaaaa',
    file_id: 'file-aaaaaaaaaaaaaaaaaaaaaaaa',
    attributes: {},
    chunking_strategy: null,
    status: 'in_progress',
    last_error: null,
    usage_bytes: null,
    claimed_at: null,
    attempts: 0,
    batch_id: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  dbState.available = true;
  configState.maxFilesPerStore = 10000;
  configState.embeddingDimensions = 1536;
  poolQuery.mockReset();
  mockCreateStore.mockReset();
  mockAttachFile.mockReset();
  mockEnqueueIngestion.mockReset();
  mockDeleteStoreFile.mockReset();
  mockDeleteStoreCascade.mockReset();
  loggerError.mockReset();
});

// ---------------------------------------------------------------------------
// validateAttributes — pure, exact-value parity with the brief
// ---------------------------------------------------------------------------
describe('validateAttributes', () => {
  it('treats null/undefined as no attributes', () => {
    expect(validateAttributes(null)).toEqual({});
    expect(validateAttributes(undefined)).toEqual({});
  });

  it('passes through a valid attributes object unchanged', () => {
    expect(validateAttributes({ a: 'x', b: 1, c: true })).toEqual({ a: 'x', b: 1, c: true });
  });

  it('rejects attributes with more than 16 keys', () => {
    const attrs = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v']));
    expect(() => validateAttributes(attrs)).toThrow(/16/);
  });

  it('accepts exactly 16 keys', () => {
    const attrs = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, 'v']));
    expect(() => validateAttributes(attrs)).not.toThrow();
  });

  it('rejects an attribute key longer than 64 characters', () => {
    expect(() => validateAttributes({ ['k'.repeat(65)]: 'v' })).toThrow(/64/);
  });

  it('accepts an attribute key exactly 64 characters', () => {
    expect(() => validateAttributes({ ['k'.repeat(64)]: 'v' })).not.toThrow();
  });

  it('rejects an attribute value longer than 512 characters', () => {
    expect(() => validateAttributes({ k: 'v'.repeat(513) })).toThrow(/512/);
  });

  it('accepts an attribute value exactly 512 characters', () => {
    expect(() => validateAttributes({ k: 'v'.repeat(512) })).not.toThrow();
  });

  it('rejects an attribute value that is not string, number or boolean', () => {
    expect(() => validateAttributes({ k: { nested: true } })).toThrow(/string, number or boolean/);
  });

  it('rejects an array value', () => {
    expect(() => validateAttributes({ k: [1, 2] })).toThrow(/string, number or boolean/);
  });

  it('rejects a non-object input', () => {
    expect(() => validateAttributes('nope')).toThrow();
    expect(() => validateAttributes([1, 2])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// assertStoreDimension — the embedding_dim pin vs. live configuration
// ---------------------------------------------------------------------------
describe('assertStoreDimension', () => {
  it('resolves when the store matches the current configuration', async () => {
    configState.embeddingDimensions = 1536;
    await expect(assertStoreDimension({ embedding_dim: 1536 })).resolves.toBeUndefined();
  });

  it('rejects a store whose pinned dimension no longer matches configuration', async () => {
    configState.embeddingDimensions = 1536;
    await expect(assertStoreDimension({ embedding_dim: 768 })).rejects.toMatchObject({ status: 409 });
  });
});

// ---------------------------------------------------------------------------
// Availability guard — every endpoint
// ---------------------------------------------------------------------------
describe('availability guard', () => {
  beforeEach(() => { dbState.available = false; });

  const expectUnavailable = (res: any) => {
    expect(res.statusCode).toBe(503);
    expect(res.body.error.type).toBe('file_search_unavailable');
    expect(res.body.error.code).toBe('file_search_unavailable');
  };

  const cases: [string, (req: any, res: any, next: any) => Promise<void>][] = [
    ['createVectorStore', vectorStoresController.createVectorStore],
    ['listVectorStores', vectorStoresController.listVectorStores],
    ['retrieveVectorStore', vectorStoresController.retrieveVectorStore],
    ['modifyVectorStore', vectorStoresController.modifyVectorStore],
    ['deleteVectorStore', vectorStoresController.deleteVectorStore],
    ['createVectorStoreFile', vectorStoresController.createVectorStoreFile],
    ['listVectorStoreFiles', vectorStoresController.listVectorStoreFiles],
    ['retrieveVectorStoreFile', vectorStoresController.retrieveVectorStoreFile],
    ['modifyVectorStoreFile', vectorStoresController.modifyVectorStoreFile],
    ['deleteVectorStoreFile', vectorStoresController.deleteVectorStoreFile],
    ['downloadVectorStoreFileContent', vectorStoresController.downloadVectorStoreFileContent],
  ];

  for (const [name, handler] of cases) {
    it(`${name}: 503 without a database`, async () => {
      const res = makeRes();
      await handler(baseReq({ params: { id: 'vs_x', file_id: 'file-x' } }), res, jest.fn());
      expectUnavailable(res);
      expect(poolQuery).not.toHaveBeenCalled();
    });
  }
});

// ---------------------------------------------------------------------------
// Unauthorized — no caller email
// ---------------------------------------------------------------------------
describe('unauthorized', () => {
  it('createVectorStore: 401 without an apiKeyInfo.email', async () => {
    const res = makeRes();
    await vectorStoresController.createVectorStore(baseReq({ apiKeyInfo: undefined }), res, jest.fn());
    expect(res.statusCode).toBe(401);
  });

  it('retrieveVectorStore: 401 without an apiKeyInfo.email', async () => {
    const res = makeRes();
    await vectorStoresController.retrieveVectorStore(
      baseReq({ apiKeyInfo: undefined, params: { id: 'vs_x' } }), res, jest.fn(),
    );
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// createVectorStore
// ---------------------------------------------------------------------------
describe('createVectorStore', () => {
  it('rejects metadata with more than 16 keys with 400, never creating a store', async () => {
    const metadata = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v']));
    const req = baseReq({ body: { name: 's', metadata } });
    const res = makeRes();
    await vectorStoresController.createVectorStore(req, res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('invalid_attributes');
    expect(mockCreateStore).not.toHaveBeenCalled();
  });

  it('rejects a name that is not a string with 400', async () => {
    const req = baseReq({ body: { name: 123 } });
    const res = makeRes();
    await vectorStoresController.createVectorStore(req, res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(mockCreateStore).not.toHaveBeenCalled();
  });

  it('rejects a name containing a NUL byte with 400, never creating a store', async () => {
    const req = baseReq({ body: { name: `a${String.fromCharCode(0)}b` } });
    const res = makeRes();
    await vectorStoresController.createVectorStore(req, res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('invalid_name');
    expect(mockCreateStore).not.toHaveBeenCalled();
  });

  it('rejects expires_after with an anchor other than last_active_at with 400', async () => {
    const req = baseReq({ body: { expires_after: { anchor: 'created_at', days: 5 } } });
    const res = makeRes();
    await vectorStoresController.createVectorStore(req, res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(mockCreateStore).not.toHaveBeenCalled();
  });

  it('rejects file_ids beyond the configured per-store limit with 400', async () => {
    configState.maxFilesPerStore = 2;
    const req = baseReq({ body: { file_ids: ['file-1', 'file-2', 'file-3'] } });
    const res = makeRes();
    await vectorStoresController.createVectorStore(req, res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(mockCreateStore).not.toHaveBeenCalled();
  });

  it('creates an empty store with status completed and zeroed file_counts, touching no vector_store_files row', async () => {
    mockCreateStore.mockResolvedValue(storeRow({ status: 'completed' }));
    const req = baseReq({ body: { name: 'empty store' } });
    const res = makeRes();
    await vectorStoresController.createVectorStore(req, res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body.object).toBe('vector_store');
    expect(res.body.status).toBe('completed');
    expect(res.body.file_counts).toEqual({ in_progress: 0, completed: 0, failed: 0, cancelled: 0, total: 0 });
    expect(mockCreateStore).toHaveBeenCalledWith(expect.objectContaining({ ownerEmail: 'owner@example.com', initialStatus: 'completed' }));
    expect(mockAttachFile).not.toHaveBeenCalled();
    expect(mockEnqueueIngestion).not.toHaveBeenCalled();
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('rejects file_ids that do not resolve to a file owned by the caller, before creating a store', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ id: 'file-1' }], rowCount: 1 }); // only file-1 came back owned
    const req = baseReq({ body: { file_ids: ['file-1', 'file-not-mine'] } });
    const res = makeRes();
    await vectorStoresController.createVectorStore(req, res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('file_not_found');
    expect(mockCreateStore).not.toHaveBeenCalled();
  });

  it('scopes the file_ids ownership check itself by owner_email (not just by what the mock happens to return)', async () => {
    // Regression class: the test above mocks the row count the SQL returns,
    // so it stays green even if `AND owner_email = $2` were mutated out of
    // the query entirely -- the mock doesn't care what SQL produced its
    // canned rows. This asserts the query text and bound params directly,
    // the same way every other ownership site in this file is guarded; the
    // live-DB counterpart is in integration/vectorStoresController.test.ts.
    poolQuery.mockResolvedValueOnce({ rows: [{ id: 'file-1' }], rowCount: 1 });
    const req = baseReq({ body: { file_ids: ['file-1'] }, apiKeyInfo: { email: 'someone@example.com' } });
    const res = makeRes();
    await vectorStoresController.createVectorStore(req, res, jest.fn());
    const [sql, params]: [string, any[]] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/owner_email = \$2/);
    expect(params).toEqual([['file-1'], 'someone@example.com']);
  });

  it('honours file_ids by creating the store in_progress, attaching and enqueueing each file', async () => {
    const created = storeRow({ status: 'in_progress' });
    poolQuery.mockResolvedValueOnce({ rows: [{ id: 'file-1' }, { id: 'file-2' }], rowCount: 2 }); // ownership check
    mockCreateStore.mockResolvedValue(created);
    mockAttachFile.mockResolvedValue(storeFileRow());
    poolQuery.mockResolvedValueOnce({ // computeUsageForStores
      rows: [{ store_id: created.id, status: 'in_progress', count: 2, bytes: '0' }],
    });

    const req = baseReq({ body: { file_ids: ['file-1', 'file-2'] } });
    const res = makeRes();
    await vectorStoresController.createVectorStore(req, res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(mockCreateStore).toHaveBeenCalledWith(expect.objectContaining({ initialStatus: 'in_progress' }));
    expect(mockAttachFile).toHaveBeenCalledTimes(2);
    expect(mockAttachFile).toHaveBeenCalledWith(created.id, 'file-1', {}, null);
    expect(mockAttachFile).toHaveBeenCalledWith(created.id, 'file-2', {}, null);
    expect(mockEnqueueIngestion).toHaveBeenCalledWith(created.id, 'file-1');
    expect(mockEnqueueIngestion).toHaveBeenCalledWith(created.id, 'file-2');
  });

  it('dedupes repeated file_ids rather than attaching the same file twice', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ id: 'file-1' }], rowCount: 1 });
    mockCreateStore.mockResolvedValue(storeRow({ status: 'in_progress' }));
    mockAttachFile.mockResolvedValue(storeFileRow());
    poolQuery.mockResolvedValueOnce({ rows: [] });

    const req = baseReq({ body: { file_ids: ['file-1', 'file-1'] } });
    const res = makeRes();
    await vectorStoresController.createVectorStore(req, res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(mockAttachFile).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// listVectorStores — ownership scoping in the SQL
// ---------------------------------------------------------------------------
describe('listVectorStores', () => {
  it('scopes the query by owner_email and over-fetches limit+1 rows', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const req = baseReq({ query: { limit: '5' } });
    const res = makeRes();
    await vectorStoresController.listVectorStores(req, res, jest.fn());

    expect(res.statusCode).toBe(200);
    const [sql, params]: [string, any[]] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/owner_email = \$1/);
    expect(params[0]).toBe('owner@example.com');
    expect(params[params.length - 1]).toBe(6);
  });

  it('scopes the cursor resolution query itself by owner_email', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] }); // cursor lookup finds nothing for this owner
    const req = baseReq({ query: { after: 'vs_someone_elses' } });
    const res = makeRes();
    await vectorStoresController.listVectorStores(req, res, jest.fn());

    expect(res.body).toEqual({ object: 'list', data: [], has_more: false, first_id: null, last_id: null });
    const [sql, params]: [string, any[]] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/owner_email = \$2/);
    expect(params).toEqual(['vs_someone_elses', 'owner@example.com']);
  });

  it('computes file_counts for the returned page in one grouped query, not one per store', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [storeRow({ id: 'vs_1' }), storeRow({ id: 'vs_2' })] });
    poolQuery.mockResolvedValueOnce({
      rows: [
        { store_id: 'vs_1', status: 'completed', count: 3, bytes: '100' },
        { store_id: 'vs_2', status: 'failed', count: 1, bytes: '0' },
      ],
    });
    const res = makeRes();
    await vectorStoresController.listVectorStores(baseReq(), res, jest.fn());

    expect(poolQuery).toHaveBeenCalledTimes(2);
    const [usageSql, usageParams]: [string, any[]] = poolQuery.mock.calls[1];
    expect(usageSql).toMatch(/store_id = ANY\(\$1\)/);
    expect(usageParams[0]).toEqual(['vs_1', 'vs_2']);
    expect(res.body.data[0].file_counts).toEqual({ in_progress: 0, completed: 3, failed: 0, cancelled: 0, total: 3 });
    expect(res.body.data[0].usage_bytes).toBe(100);
    expect(res.body.data[1].file_counts).toEqual({ in_progress: 0, completed: 0, failed: 1, cancelled: 0, total: 1 });
  });
});

// ---------------------------------------------------------------------------
// store status is DERIVED from file_counts, not read off the row
// ---------------------------------------------------------------------------
describe('vector store status', () => {
  // The row's `status` column is stamped once at creation and no writer moves
  // it — the ingestion worker updates the FILE rows. Reading the column made a
  // fully-ingested store report `in_progress` forever, so a client polling
  // status the documented way never stopped. Observed live 2026-08-07:
  // file_counts 1/1 with status in_progress for 30 consecutive polls.
  it('reports completed once no file is in progress, even though the row still says in_progress', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [storeRow({ status: 'in_progress' })] });
    poolQuery.mockResolvedValueOnce({
      rows: [{ store_id: 'vs_aaaaaaaaaaaaaaaaaaaaaaaa', status: 'completed', count: 1, bytes: '42' }],
    });
    const res = makeRes();
    await vectorStoresController.retrieveVectorStore(
      baseReq({ params: { id: 'vs_aaaaaaaaaaaaaaaaaaaaaaaa' } }), res, jest.fn(),
    );

    expect(res.body.file_counts).toEqual({ in_progress: 0, completed: 1, failed: 0, cancelled: 0, total: 1 });
    expect(res.body.status).toBe('completed');
  });

  it('stays in_progress while any file is still ingesting', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [storeRow({ status: 'completed' })] });
    poolQuery.mockResolvedValueOnce({
      rows: [
        { store_id: 'vs_aaaaaaaaaaaaaaaaaaaaaaaa', status: 'completed', count: 1, bytes: '10' },
        { store_id: 'vs_aaaaaaaaaaaaaaaaaaaaaaaa', status: 'in_progress', count: 1, bytes: '0' },
      ],
    });
    const res = makeRes();
    await vectorStoresController.retrieveVectorStore(
      baseReq({ params: { id: 'vs_aaaaaaaaaaaaaaaaaaaaaaaa' } }), res, jest.fn(),
    );
    expect(res.body.status).toBe('in_progress');
  });

  it('does not hold a store open for a file that FAILED — the damage shows in file_counts', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [storeRow({ status: 'in_progress' })] });
    poolQuery.mockResolvedValueOnce({
      rows: [{ store_id: 'vs_aaaaaaaaaaaaaaaaaaaaaaaa', status: 'failed', count: 1, bytes: '0' }],
    });
    const res = makeRes();
    await vectorStoresController.retrieveVectorStore(
      baseReq({ params: { id: 'vs_aaaaaaaaaaaaaaaaaaaaaaaa' } }), res, jest.fn(),
    );
    expect(res.body.status).toBe('completed');
    expect(res.body.file_counts.failed).toBe(1);
  });

  it('keeps expired, which is terminal and not derivable from counts', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [storeRow({ status: 'expired' })] });
    poolQuery.mockResolvedValueOnce({
      rows: [{ store_id: 'vs_aaaaaaaaaaaaaaaaaaaaaaaa', status: 'completed', count: 2, bytes: '99' }],
    });
    const res = makeRes();
    await vectorStoresController.retrieveVectorStore(
      baseReq({ params: { id: 'vs_aaaaaaaaaaaaaaaaaaaaaaaa' } }), res, jest.fn(),
    );
    expect(res.body.status).toBe('expired');
  });
});

// ---------------------------------------------------------------------------
// retrieveVectorStore — 404, never 403
// ---------------------------------------------------------------------------
describe('retrieveVectorStore', () => {
  it('404s for a store that does not exist', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const res = makeRes();
    await vectorStoresController.retrieveVectorStore(baseReq({ params: { id: 'vs_missing' } }), res, jest.fn());
    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe('vector_store_not_found');
  });

  it("404s for another owner's store with a body identical to the nonexistent-store case", async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const resForeign = makeRes();
    await vectorStoresController.retrieveVectorStore(baseReq({ params: { id: 'vs_someone_elses' } }), resForeign, jest.fn());

    poolQuery.mockResolvedValueOnce({ rows: [] });
    const resMissing = makeRes();
    await vectorStoresController.retrieveVectorStore(baseReq({ params: { id: 'vs_does_not_exist' } }), resMissing, jest.fn());

    expect(resForeign.statusCode).toBe(404);
    expect(resForeign.statusCode).toBe(resMissing.statusCode);
    expect(resForeign.body.error.type).toBe(resMissing.body.error.type);
    expect(resForeign.body.error.code).toBe(resMissing.body.error.code);
  });

  it('scopes the lookup query itself by owner_email', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const res = makeRes();
    await vectorStoresController.retrieveVectorStore(
      baseReq({ params: { id: 'vs_x' }, apiKeyInfo: { email: 'someone@example.com' } }), res, jest.fn(),
    );
    const [sql, params]: [string, any[]] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/owner_email = \$2/);
    expect(params).toEqual(['vs_x', 'someone@example.com']);
  });

  it("returns the caller's own store with the OpenAI vector_store shape", async () => {
    poolQuery.mockResolvedValueOnce({ rows: [storeRow()] });
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const res = makeRes();
    await vectorStoresController.retrieveVectorStore(baseReq({ params: { id: 'vs_aaaaaaaaaaaaaaaaaaaaaaaa' } }), res, jest.fn());
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ id: 'vs_aaaaaaaaaaaaaaaaaaaaaaaa', object: 'vector_store', name: 'my store' });
    expect(typeof res.body.created_at).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// modifyVectorStore
// ---------------------------------------------------------------------------
describe('modifyVectorStore', () => {
  it('404s for another owner\'s store, scoped in the UPDATE itself', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const req = baseReq({ params: { id: 'vs_x' }, body: { name: 'new name' } });
    const res = makeRes();
    await vectorStoresController.modifyVectorStore(req, res, jest.fn());
    expect(res.statusCode).toBe(404);
    const [sql, params]: [string, any[]] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE vector_stores/);
    expect(sql).toMatch(/owner_email = \$3/);
    expect(params).toEqual(['new name', 'vs_x', 'owner@example.com']);
  });

  it('rejects invalid metadata with 400 before issuing any query', async () => {
    const req = baseReq({ params: { id: 'vs_x' }, body: { metadata: { k: { nested: true } } } });
    const res = makeRes();
    await vectorStoresController.modifyVectorStore(req, res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('rejects a name containing a NUL byte with 400 before issuing any query', async () => {
    const req = baseReq({ params: { id: 'vs_x' }, body: { name: `a${String.fromCharCode(0)}b` } });
    const res = makeRes();
    await vectorStoresController.modifyVectorStore(req, res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('invalid_name');
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('updates name, metadata and expires_after together and returns the updated shape', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [storeRow({ name: 'renamed', expires_after: { anchor: 'last_active_at', days: 7 } })] });
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const req = baseReq({
      params: { id: 'vs_aaaaaaaaaaaaaaaaaaaaaaaa' },
      body: { name: 'renamed', metadata: { k: 'v' }, expires_after: { anchor: 'last_active_at', days: 7 } },
    });
    const res = makeRes();
    await vectorStoresController.modifyVectorStore(req, res, jest.fn());
    expect(res.statusCode).toBe(200);
    expect(res.body.name).toBe('renamed');
    expect(res.body.expires_after).toEqual({ anchor: 'last_active_at', days: 7 });
  });

  // The `sets.length === 0` branch (a bare `POST /vector_stores/{id}` with an
  // empty/unrecognized body) is a SEPARATE query from the UPDATE tested
  // above -- every other test in this block sends a body with at least one
  // recognized field, so this branch was previously only reachable, never
  // asserted. An unscoped SELECT here would return a foreign store's name,
  // metadata, expires_at, last_active_at and file_counts at 200.
  it('empty-body branch: 404s for another owner\'s store, scoped in the SELECT itself', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const req = baseReq({ params: { id: 'vs_x' }, body: {} });
    const res = makeRes();
    await vectorStoresController.modifyVectorStore(req, res, jest.fn());
    expect(res.statusCode).toBe(404);
    expect(poolQuery).toHaveBeenCalledTimes(1); // no usage query follows a 404
    const [sql, params]: [string, any[]] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/SELECT \* FROM vector_stores/);
    expect(sql).toMatch(/owner_email = \$2/);
    expect(params).toEqual(['vs_x', 'owner@example.com']);
  });

  it('empty-body branch: returns the caller\'s own store unchanged', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [storeRow({ id: 'vs_x' })] });
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const req = baseReq({ params: { id: 'vs_x' }, body: {} });
    const res = makeRes();
    await vectorStoresController.modifyVectorStore(req, res, jest.fn());
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe('vs_x');
  });
});

// ---------------------------------------------------------------------------
// deleteVectorStore
// ---------------------------------------------------------------------------
describe('deleteVectorStore', () => {
  it('404s when the cascade reports nothing deleted (missing or not owned)', async () => {
    mockDeleteStoreCascade.mockResolvedValue({ deleted: false });
    const res = makeRes();
    await vectorStoresController.deleteVectorStore(baseReq({ params: { id: 'vs_x' } }), res, jest.fn());
    expect(res.statusCode).toBe(404);
    expect(mockDeleteStoreCascade).toHaveBeenCalledWith('vs_x', 'owner@example.com');
  });

  it('200s with the deleted shape on success', async () => {
    mockDeleteStoreCascade.mockResolvedValue({ deleted: true });
    const res = makeRes();
    await vectorStoresController.deleteVectorStore(baseReq({ params: { id: 'vs_x' } }), res, jest.fn());
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ id: 'vs_x', object: 'vector_store.deleted', deleted: true });
  });
});

// ---------------------------------------------------------------------------
// createVectorStoreFile (attach)
// ---------------------------------------------------------------------------
describe('createVectorStoreFile', () => {
  it('requires file_id with 400', async () => {
    const req = baseReq({ params: { id: 'vs_x' }, body: {} });
    const res = makeRes();
    await vectorStoresController.createVectorStoreFile(req, res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('404s when the store is not owned by the caller', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const req = baseReq({ params: { id: 'vs_x' }, body: { file_id: 'file-1' } });
    const res = makeRes();
    await vectorStoresController.createVectorStoreFile(req, res, jest.fn());
    expect(res.statusCode).toBe(404);
    const [sql, params]: [string, any[]] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/owner_email = \$2/);
    expect(params).toEqual(['vs_x', 'owner@example.com']);
  });

  it('409s when the store\'s pinned embedding_dim no longer matches configuration', async () => {
    configState.embeddingDimensions = 768; // config moved on since the store was pinned at 1536
    poolQuery.mockResolvedValueOnce({ rows: [storeRow({ embedding_dim: 1536 })] });
    const req = baseReq({ params: { id: 'vs_aaaaaaaaaaaaaaaaaaaaaaaa' }, body: { file_id: 'file-1' } });
    const res = makeRes();
    await vectorStoresController.createVectorStoreFile(req, res, jest.fn());
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('embedding_dimension_mismatch');
    expect(mockAttachFile).not.toHaveBeenCalled();
  });

  it('rejects a file_id not owned by the caller with 400, scoped in the SQL', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [storeRow()] });
    poolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const req = baseReq({ params: { id: 'vs_aaaaaaaaaaaaaaaaaaaaaaaa' }, body: { file_id: 'file-not-mine' } });
    const res = makeRes();
    await vectorStoresController.createVectorStoreFile(req, res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('file_not_found');
    const [sql, params]: [string, any[]] = poolQuery.mock.calls[1];
    expect(sql).toMatch(/owner_email = \$2/);
    expect(params).toEqual(['file-not-mine', 'owner@example.com']);
    expect(mockAttachFile).not.toHaveBeenCalled();
  });

  it('rejects attaching beyond the per-store file limit with 400', async () => {
    configState.maxFilesPerStore = 1;
    poolQuery.mockResolvedValueOnce({ rows: [storeRow()] });
    poolQuery.mockResolvedValueOnce({ rows: [{ id: 'file-1' }], rowCount: 1 });
    poolQuery.mockResolvedValueOnce({ rows: [{ count: 1 }] });
    const req = baseReq({ params: { id: 'vs_aaaaaaaaaaaaaaaaaaaaaaaa' }, body: { file_id: 'file-1' } });
    const res = makeRes();
    await vectorStoresController.createVectorStoreFile(req, res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('vector_store_file_limit_exceeded');
    expect(mockAttachFile).not.toHaveBeenCalled();
  });

  it('409s when the file is already attached (unique_violation surfaced from attachFile)', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [storeRow()] });
    poolQuery.mockResolvedValueOnce({ rows: [{ id: 'file-1' }], rowCount: 1 });
    poolQuery.mockResolvedValueOnce({ rows: [{ count: 0 }] });
    mockAttachFile.mockRejectedValue(Object.assign(new Error('duplicate key'), { code: '23505' }));
    const req = baseReq({ params: { id: 'vs_aaaaaaaaaaaaaaaaaaaaaaaa' }, body: { file_id: 'file-1' } });
    const res = makeRes();
    await vectorStoresController.createVectorStoreFile(req, res, jest.fn());
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('file_already_attached');
  });

  // Reverse race: the existence/ownership checks above pass, but a
  // concurrent DELETE (of the file via /files/{id}, or of the store) commits
  // before attachFile's INSERT does. Postgres raises 23503 for whichever of
  // vector_store_files' two FKs fired; both must map to the same 400/404 a
  // direct lookup of the vanished resource would have produced, never a raw
  // 500 that echoes the table/constraint name to the caller.
  it('400s (never 500) when the file_id disappears in a race between the ownership check and the insert', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [storeRow()] });
    poolQuery.mockResolvedValueOnce({ rows: [{ id: 'file-1' }], rowCount: 1 });
    poolQuery.mockResolvedValueOnce({ rows: [{ count: 0 }] });
    mockAttachFile.mockRejectedValue(Object.assign(
      new Error('insert or update on table "vector_store_files" violates foreign key constraint "vector_store_files_file_id_fkey"'),
      { code: '23503', constraint: 'vector_store_files_file_id_fkey' },
    ));
    const req = baseReq({ params: { id: 'vs_aaaaaaaaaaaaaaaaaaaaaaaa' }, body: { file_id: 'file-1' } });
    const res = makeRes();
    const next = jest.fn();
    await vectorStoresController.createVectorStoreFile(req, res, next);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('file_not_found');
    expect(res.body.error.message).not.toMatch(/foreign key|constraint|vector_store_files/i);
    expect(next).not.toHaveBeenCalled();
  });

  it('404s (never 500) when the store disappears in a race between the ownership check and the insert', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [storeRow()] });
    poolQuery.mockResolvedValueOnce({ rows: [{ id: 'file-1' }], rowCount: 1 });
    poolQuery.mockResolvedValueOnce({ rows: [{ count: 0 }] });
    mockAttachFile.mockRejectedValue(Object.assign(
      new Error('insert or update on table "vector_store_files" violates foreign key constraint "vector_store_files_store_id_fkey"'),
      { code: '23503', constraint: 'vector_store_files_store_id_fkey' },
    ));
    const req = baseReq({ params: { id: 'vs_aaaaaaaaaaaaaaaaaaaaaaaa' }, body: { file_id: 'file-1' } });
    const res = makeRes();
    const next = jest.fn();
    await vectorStoresController.createVectorStoreFile(req, res, next);
    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe('vector_store_not_found');
    expect(res.body.error.message).not.toMatch(/foreign key|constraint|vector_store_files/i);
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches and enqueues on success, returning status in_progress, never completed', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [storeRow()] });
    poolQuery.mockResolvedValueOnce({ rows: [{ id: 'file-1' }], rowCount: 1 });
    poolQuery.mockResolvedValueOnce({ rows: [{ count: 0 }] });
    mockAttachFile.mockResolvedValue(storeFileRow({ status: 'in_progress' }));
    const req = baseReq({ params: { id: 'vs_aaaaaaaaaaaaaaaaaaaaaaaa' }, body: { file_id: 'file-1', attributes: { lang: 'en' } } });
    const res = makeRes();
    await vectorStoresController.createVectorStoreFile(req, res, jest.fn());
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('in_progress');
    expect(mockAttachFile).toHaveBeenCalledWith('vs_aaaaaaaaaaaaaaaaaaaaaaaa', 'file-1', { lang: 'en' }, null);
    expect(mockEnqueueIngestion).toHaveBeenCalledWith('vs_aaaaaaaaaaaaaaaaaaaaaaaa', 'file-1');
  });
});

// ---------------------------------------------------------------------------
// listVectorStoreFiles
// ---------------------------------------------------------------------------
describe('listVectorStoreFiles', () => {
  it('404s when the store is not owned by the caller, before any files query', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const req = baseReq({ params: { id: 'vs_x' } });
    const res = makeRes();
    await vectorStoresController.listVectorStoreFiles(req, res, jest.fn());
    expect(res.statusCode).toBe(404);
    expect(poolQuery).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid filter value with 400', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ id: 'vs_x' }], rowCount: 1 });
    const req = baseReq({ params: { id: 'vs_x' }, query: { filter: 'bogus' } });
    const res = makeRes();
    await vectorStoresController.listVectorStoreFiles(req, res, jest.fn());
    expect(res.statusCode).toBe(400);
  });

  it('scopes the store-existence check by owner_email and applies a valid filter to the files query', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ id: 'vs_x' }], rowCount: 1 });
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const req = baseReq({ params: { id: 'vs_x' }, query: { filter: 'completed' } });
    const res = makeRes();
    await vectorStoresController.listVectorStoreFiles(req, res, jest.fn());

    const [existsSql, existsParams]: [string, any[]] = poolQuery.mock.calls[0];
    expect(existsSql).toMatch(/owner_email = \$2/);
    expect(existsParams).toEqual(['vs_x', 'owner@example.com']);

    const [filesSql, filesParams]: [string, any[]] = poolQuery.mock.calls[1];
    expect(filesSql).toMatch(/status = \$2/);
    expect(filesParams).toEqual(['vs_x', 'completed', 21]);
  });
});

// ---------------------------------------------------------------------------
// retrieveVectorStoreFile
// ---------------------------------------------------------------------------
describe('retrieveVectorStoreFile', () => {
  it('404s for a file not attached to a store owned by the caller', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const req = baseReq({ params: { id: 'vs_x', file_id: 'file-x' } });
    const res = makeRes();
    await vectorStoresController.retrieveVectorStoreFile(req, res, jest.fn());
    expect(res.statusCode).toBe(404);
    const [sql, params]: [string, any[]] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/owner_email = \$3/);
    expect(params).toEqual(['vs_x', 'file-x', 'owner@example.com']);
  });

  it("returns the caller's own store file", async () => {
    poolQuery.mockResolvedValueOnce({ rows: [storeFileRow()] });
    const req = baseReq({ params: { id: 'vs_aaaaaaaaaaaaaaaaaaaaaaaa', file_id: 'file-aaaaaaaaaaaaaaaaaaaaaaaa' } });
    const res = makeRes();
    await vectorStoresController.retrieveVectorStoreFile(req, res, jest.fn());
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ id: 'file-aaaaaaaaaaaaaaaaaaaaaaaa', object: 'vector_store.file', vector_store_id: 'vs_aaaaaaaaaaaaaaaaaaaaaaaa' });
  });
});

// ---------------------------------------------------------------------------
// modifyVectorStoreFile
// ---------------------------------------------------------------------------
describe('modifyVectorStoreFile', () => {
  it('requires attributes with 400 before issuing any query', async () => {
    const req = baseReq({ params: { id: 'vs_x', file_id: 'file-x' }, body: {} });
    const res = makeRes();
    await vectorStoresController.modifyVectorStoreFile(req, res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('missing_attributes');
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('rejects invalid attributes with 400', async () => {
    const req = baseReq({ params: { id: 'vs_x', file_id: 'file-x' }, body: { attributes: { k: {} } } });
    const res = makeRes();
    await vectorStoresController.modifyVectorStoreFile(req, res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('404s when scoped update matches nothing (not owned, or not attached)', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const req = baseReq({ params: { id: 'vs_x', file_id: 'file-x' }, body: { attributes: { k: 'v' } } });
    const res = makeRes();
    await vectorStoresController.modifyVectorStoreFile(req, res, jest.fn());
    expect(res.statusCode).toBe(404);
    const [sql, params]: [string, any[]] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/owner_email = \$4/);
    expect(params).toEqual([JSON.stringify({ k: 'v' }), 'vs_x', 'file-x', 'owner@example.com']);
  });

  it('updates attributes on success', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [storeFileRow({ attributes: { k: 'v' } })] });
    const req = baseReq({ params: { id: 'vs_x', file_id: 'file-x' }, body: { attributes: { k: 'v' } } });
    const res = makeRes();
    await vectorStoresController.modifyVectorStoreFile(req, res, jest.fn());
    expect(res.statusCode).toBe(200);
    expect(res.body.attributes).toEqual({ k: 'v' });
  });
});

// ---------------------------------------------------------------------------
// deleteVectorStoreFile
// ---------------------------------------------------------------------------
describe('deleteVectorStoreFile', () => {
  it('404s when the cascade reports nothing deleted', async () => {
    mockDeleteStoreFile.mockResolvedValue({ deleted: false });
    const req = baseReq({ params: { id: 'vs_x', file_id: 'file-x' } });
    const res = makeRes();
    await vectorStoresController.deleteVectorStoreFile(req, res, jest.fn());
    expect(res.statusCode).toBe(404);
    expect(mockDeleteStoreFile).toHaveBeenCalledWith('vs_x', 'file-x', 'owner@example.com');
  });

  it('200s with the deleted shape on success', async () => {
    mockDeleteStoreFile.mockResolvedValue({ deleted: true });
    const req = baseReq({ params: { id: 'vs_x', file_id: 'file-x' } });
    const res = makeRes();
    await vectorStoresController.deleteVectorStoreFile(req, res, jest.fn());
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ id: 'file-x', object: 'vector_store.file.deleted', deleted: true });
  });
});

// ---------------------------------------------------------------------------
// downloadVectorStoreFileContent — extracted text, not the original bytes
// ---------------------------------------------------------------------------
describe('downloadVectorStoreFileContent', () => {
  it('404s for a file not attached to a store owned by the caller, scoped in the SQL', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const req = baseReq({ params: { id: 'vs_x', file_id: 'file-x' } });
    const res = makeRes();
    await vectorStoresController.downloadVectorStoreFileContent(req, res, jest.fn());
    expect(res.statusCode).toBe(404);
    const [sql, params]: [string, any[]] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/owner_email = \$3/);
    expect(params).toEqual(['vs_x', 'file-x', 'owner@example.com']);
  });

  it('reassembles chunk text in ord order, scoping the chunk query by owner_email too', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ file_id: 'file-x' }], rowCount: 1 });
    poolQuery.mockResolvedValueOnce({ rows: [{ text: 'first ' }, { text: 'second' }] });
    const req = baseReq({ params: { id: 'vs_x', file_id: 'file-x' } });
    const res = makeRes();
    await vectorStoresController.downloadVectorStoreFileContent(req, res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual([{ type: 'text', text: 'first \nsecond' }]);
    const [chunkSql, chunkParams]: [string, any[]] = poolQuery.mock.calls[1];
    expect(chunkSql).toMatch(/owner_email = \$3/);
    expect(chunkSql).toMatch(/ORDER BY c.ord ASC/);
    expect(chunkParams).toEqual(['vs_x', 'file-x', 'owner@example.com']);
  });
});
