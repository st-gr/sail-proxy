// Task 2 (2026-08-07 file_search follow-ups plan): a DIFFERENT defect from
// rollbackMasking.test.ts's. That file guards ROLLBACKs sitting inside a
// genuine error-handling `catch` block, where a failing ROLLBACK would
// REPLACE the original error. The six sites here are the opposite shape:
// no-op early-return paths where nothing has gone wrong and there is no
// original error to protect. Before this fix they issued a bare
// `await client.query('ROLLBACK')` with no guard at all, so a ROLLBACK that
// fails (which happens precisely when the connection is already dying —
// i.e. in production) turned a legitimate "nothing to do" outcome into a
// thrown error:
//
//   - repository.ts's deleteStoreFile/deleteStoreCascade documented their
//     no-op branches as returning `{ deleted: false }` — "never a
//     distinguishing error". A failing ROLLBACK on that branch broke that
//     contract, surfacing as an unmapped 500 instead.
//   - ingestWorker.ts's commitChunks documents its two guards as "a
//     legitimate race with a delete, not an ingestion failure" that
//     "[s]ilently rolls back and returns (no throw, no error recorded)".
//     commitChunks has no inner catch, so a failing ROLLBACK here escaped
//     to the OUTER catch, re-threw, and reached processOne's handleFailure
//     — consuming a retry attempt and writing a spurious `last_error` for a
//     file that was never broken.
//   - expirySweeper.ts's sweepOneStore no-op branch (a concurrent activity
//     touch or another sweep already resolved this store) IS caught by the
//     function's own outer catch, so the returned boolean does not change
//     either way. What changes is that the outer catch also logs
//     "Failed to expire vector store" — mislabeling a benign race as a
//     failure. The guard keeps that log silent for the true no-op case.
//
// Per the task brief's bar: each test gives the failing ROLLBACK a
// distinctive message and asserts the function RESOLVES with its documented
// value, not merely that it doesn't reject -- a test that only asserted
// "does not throw" would already pass today for every site whose no-op
// branch happens to be unreachable in the test, which is exactly the kind
// of vacuous coverage this task's brief warns against.

let mockPool: any = null;

jest.mock('../../src/fileSearch/db', () => ({
  __esModule: true,
  getPool: jest.fn(() => mockPool),
  isFileSearchAvailable: jest.fn(() => true),
}));

const mockConfig = {
  enabled: true,
  embeddingModel: 'test-model',
  embeddingDimensions: 3,
  limits: { maxFileBytes: 1000000, maxTokensPerFile: 1000000, maxFilesPerStore: 10000 },
  ingestion: { concurrency: 1, extractTimeoutMs: 1000, maxRetries: 3 },
  blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
};

jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

// A single shared object (not a fresh literal per call) so the module-level
// `logger` that expirySweeper.ts captures at import time is the exact same
// instance the "no spurious error log" test below asserts against.
const mockLogger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
};
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => mockLogger,
}));

// eslint-disable-next-line import/first
import { deleteStoreFile, deleteStoreCascade } from '../../src/fileSearch/repository';
// eslint-disable-next-line import/first
import { __commitChunksForTests } from '../../src/fileSearch/ingestWorker';
// eslint-disable-next-line import/first
import { sweepExpiredStores } from '../../src/fileSearch/expirySweeper';

const DYING_ROLLBACK = 'connection terminated: no-op ROLLBACK died mid-shutdown';

/** Same shape as rollbackMasking.test.ts's fakeClient: `onQuery` is keyed on
 *  SQL text so each test scripts exactly which statement returns what,
 *  independent of call-count ordering. */
function fakeClient(onQuery: (sql: string, params?: any[]) => any): { query: jest.Mock; release: jest.Mock } {
  return {
    query: jest.fn(async (sql: string, params?: any[]) => onQuery(sql, params)),
    release: jest.fn(),
  };
}

function fakePool(client: { query: jest.Mock; release: jest.Mock }, poolQuery?: (sql: string, params?: any[]) => any): any {
  return {
    connect: jest.fn(async () => client),
    query: jest.fn(async (sql: string, params?: any[]) => (poolQuery ? poolQuery(sql, params) : undefined)),
  };
}

describe('a dying ROLLBACK on a no-op early-return path does not turn it into a failure (Task 2)', () => {
  beforeEach(() => {
    mockPool = null;
    mockLogger.error.mockClear();
    mockLogger.warn.mockClear();
  });

  it('repository.deleteStoreFile: resolves {deleted:false}, not a rejection, when the store is not found and ROLLBACK fails', async () => {
    const client = fakeClient((sql) => {
      if (sql === 'BEGIN') return undefined;
      if (sql.includes('SELECT id FROM vector_stores')) return { rowCount: 0, rows: [] };
      if (sql === 'ROLLBACK') throw new Error(DYING_ROLLBACK);
      throw new Error(`unexpected query in test: ${sql}`);
    });
    mockPool = fakePool(client);

    await expect(deleteStoreFile('vs_1', 'file_1', 'owner@example.com')).resolves.toEqual({ deleted: false });
  });

  it('repository.deleteStoreFile: resolves {deleted:false}, not a rejection, when the file is not attached and ROLLBACK fails', async () => {
    const client = fakeClient((sql) => {
      if (sql === 'BEGIN') return undefined;
      if (sql.includes('SELECT id FROM vector_stores')) return { rowCount: 1, rows: [{ id: 'vs_1' }] };
      if (sql.includes('DELETE FROM vector_store_files')) return { rowCount: 0, rows: [] };
      if (sql === 'ROLLBACK') throw new Error(DYING_ROLLBACK);
      throw new Error(`unexpected query in test: ${sql}`);
    });
    mockPool = fakePool(client);

    await expect(deleteStoreFile('vs_1', 'file_1', 'owner@example.com')).resolves.toEqual({ deleted: false });
  });

  it('repository.deleteStoreCascade: resolves {deleted:false}, not a rejection, when the store is not found and ROLLBACK fails', async () => {
    const client = fakeClient((sql) => {
      if (sql === 'BEGIN') return undefined;
      if (sql.includes('SELECT id FROM vector_stores')) return { rowCount: 0, rows: [] };
      if (sql === 'ROLLBACK') throw new Error(DYING_ROLLBACK);
      throw new Error(`unexpected query in test: ${sql}`);
    });
    mockPool = fakePool(client);

    await expect(deleteStoreCascade('vs_1', 'owner@example.com')).resolves.toEqual({ deleted: false });
  });

  it('ingestWorker.commitChunks: resolves (does not throw, does not reach handleFailure) when the store row is gone and ROLLBACK fails', async () => {
    const client = fakeClient((sql) => {
      if (sql === 'BEGIN') return undefined;
      if (sql.includes('FROM vector_stores') && sql.includes('FOR SHARE')) return { rowCount: 0, rows: [] };
      if (sql === 'ROLLBACK') throw new Error(DYING_ROLLBACK);
      throw new Error(`unexpected query in test: ${sql}`);
    });
    mockPool = fakePool(client);

    await expect(__commitChunksForTests('vs_1', 'file_1', [], [])).resolves.toBeUndefined();
  });

  it('ingestWorker.commitChunks: resolves (does not throw, does not reach handleFailure) when the vector_store_files row is gone/not in_progress and ROLLBACK fails', async () => {
    const client = fakeClient((sql) => {
      if (sql === 'BEGIN') return undefined;
      if (sql.includes('FROM vector_stores') && sql.includes('FOR SHARE')) return { rowCount: 1, rows: [{ id: 'vs_1' }] };
      if (sql.includes('FROM vector_store_files') && sql.includes('FOR UPDATE')) return { rowCount: 0, rows: [] };
      if (sql === 'ROLLBACK') throw new Error(DYING_ROLLBACK);
      throw new Error(`unexpected query in test: ${sql}`);
    });
    mockPool = fakePool(client);

    await expect(__commitChunksForTests('vs_1', 'file_1', [], [])).resolves.toBeUndefined();
  });

  it('expirySweeper.sweepOneStore: resolves 0 and does NOT log a spurious "Failed to expire" error when the re-check race resolves the store and ROLLBACK fails', async () => {
    const client = fakeClient((sql) => {
      if (sql === 'BEGIN') return undefined;
      if (sql.includes('SELECT id FROM vector_stores') && sql.includes('FOR UPDATE')) return { rowCount: 0, rows: [] };
      if (sql === 'ROLLBACK') throw new Error(DYING_ROLLBACK);
      throw new Error(`unexpected query in test: ${sql}`);
    });
    mockPool = fakePool(client, (sql) => {
      if (sql.includes('SELECT id FROM vector_stores')) return { rows: [{ id: 'vs_1' }] };
      throw new Error(`unexpected pool query in test: ${sql}`);
    });

    await expect(sweepExpiredStores()).resolves.toBe(0);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});
