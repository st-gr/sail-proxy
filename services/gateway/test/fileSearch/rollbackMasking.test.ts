// Task 5 (2026-08-05 Responses API loose-ends plan): an unguarded
// `await client.query('ROLLBACK')` inside an error-handling `catch` block is
// a trap — it fires exactly when the connection is already in a bad state
// (that's *why* the surrounding statement failed), so it is disproportionately
// likely to throw itself. When it does, its own error REPLACES the original
// one in the rejection the caller sees, destroying the information that
// explains what actually went wrong. `db.ts`'s `withTransaction`/`withClient`
// helpers already guard every ROLLBACK with `.catch(() => {})`; this file
// pins down the same guard on every OTHER call site in `src/fileSearch` that
// issues a raw `ROLLBACK` from inside a genuine error-handling `catch` block.
//
// Full site inventory (grep -rn "ROLLBACK" src/), and disposition. Line
// numbers re-derived 2026-08-07 (Task 2 of the file_search follow-ups plan),
// which guarded the six no-op-path sites this file's PREVIOUS header left
// deliberately unguarded (see task-2-report.md for the full rationale: an
// unguarded ROLLBACK on a no-op early-return path has no original error to
// mask, but a dying connection still turns "nothing to do" into a thrown
// error -- a different defect from the error-masking one this file guards).
// Every ROLLBACK call site in src/fileSearch is now guarded with
// `.catch(() => {})`; only the REASON differs per site:
//   - db.ts:166, :213                              - already guarded (unchanged)
//   - teacherLogger.ts:196                          - already guarded (unchanged)
//   - repository.ts:778  (attachFile catch)         - error-masking guard (Task 5)
//   - repository.ts:853  (deleteStoreFile, "store not found" no-op)
//   - repository.ts:866  (deleteStoreFile, "file not attached" no-op)
//       - no-op guard (Task 2): NOT an error path (documented as "never a
//         distinguishing error" in the function's own doc comment) -- guarded
//         so a dying connection can't turn the no-op into a thrown error.
//   - repository.ts:879  (deleteStoreFile catch)    - error-masking guard (Task 5)
//   - repository.ts:914  (deleteStoreCascade, "store not found" no-op)
//       - no-op guard (Task 2): same shape as deleteStoreFile's no-op above.
//   - repository.ts:925  (deleteStoreCascade catch) - error-masking guard (Task 5)
//   - blob/blobStore.ts:115 (retainBlob catch)      - error-masking guard (Task 5)
//   - blob/blobStore.ts:157 (releaseBlob catch)     - error-masking guard (Task 5)
//   - batches.ts:202 (discardPartialBatch catch)    - guarded from the start,
//       and pinned by the last two tests below. This site is a stronger case
//       than the rest: the whole function runs inside createBatch's own catch
//       purely to clean up, so ANY escape from it - not just from the ROLLBACK
//       - replaces the caller's real error. The guard therefore has to cover
//       the connection handling too (see the two `connection handling` tests).
//   - expirySweeper.ts:73  (sweepOneStore, rowCount===0 branch)
//       - no-op guard (Task 2): the function's own doc comment says this
//         branch fires when "a concurrent activity touch or another sweep
//         already resolved it" -- a legitimate race, not a failure. Before
//         Task 2, a dying ROLLBACK here fell through to the outer catch below
//         and logged a spurious "Failed to expire vector store" error for a
//         store that was never broken; guarded so that no-op stays silent.
//   - expirySweeper.ts:82  (sweepOneStore catch)    - already guarded (unchanged)
//   - ingestWorker.ts:389  (commitChunks, vector_stores row gone)
//   - ingestWorker.ts:414  (commitChunks, vector_store_files row gone/not
//         in_progress)
//       - no-op guard (Task 2): the function's doc comment is explicit
//         ("Silently rolls back and returns (no throw, no error recorded) if
//         either check fails: that is a legitimate race with a delete, not an
//         ingestion failure"). commitChunks has no inner catch, so before
//         Task 2 a dying ROLLBACK here reached the OUTER catch, re-threw, and
//         landed in processOne's handleFailure -- consuming a retry attempt
//         and writing a spurious last_error for a file that was never broken.
//   - ingestWorker.ts:447  (commitChunks catch)     - already guarded (unchanged)
//
// noOpRollback.test.ts (Task 2) covers the six no-op sites above; this file
// covers only the error-masking (catch-block) sites.
//
// Every test below proves the SPECIFIC bar this task sets: a rollback failure
// and the original failure carry different, identifiable messages, and the
// assertion is on the ORIGINAL's message -- a test that only asserted
// "rejects" would pass whether or not the guard exists, which is exactly the
// trap the brief calls out.

let mockPool: any = null;

jest.mock('../../src/fileSearch/db', () => ({
  __esModule: true,
  getPool: () => mockPool,
  isFileSearchAvailable: () => true,
}));

jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => ({
    limits: { maxFileBytes: 33554432, maxTokensPerFile: 5000000, maxFilesPerStore: 10000 },
    blobStorage: { backend: 'db', localPath: '/tmp/unused', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
  }),
}));

// eslint-disable-next-line import/first
import { attachFile, deleteStoreFile, deleteStoreCascade } from '../../src/fileSearch/repository';
// eslint-disable-next-line import/first
import { retainBlob, releaseBlob } from '../../src/fileSearch/blob/blobStore';
// eslint-disable-next-line import/first
import { createBatch } from '../../src/fileSearch/batches';

const ROLLBACK_MESSAGE = 'connection terminated unexpectedly';
const REAL_CAUSE_MESSAGE = 'THE REAL CAUSE: duplicate key value violates unique constraint';
const CLEANUP_MESSAGE = 'CLEANUP NOISE: connection terminated while discarding a partial batch';

/**
 * A fake pg PoolClient whose `query` behavior is driven by `onQuery`, keyed
 * on the SQL text so each test can script exactly which statement in a given
 * function's transaction fails and which succeeds -- without depending on
 * call-count ordering, which would silently break if an unrelated statement
 * were ever added upstream of the one under test.
 */
function fakeClient(onQuery: (sql: string, params?: any[]) => any): { query: jest.Mock; release: jest.Mock } {
  return {
    query: jest.fn(async (sql: string, params?: any[]) => onQuery(sql, params)),
    release: jest.fn(),
  };
}

function fakePool(client: { query: jest.Mock; release: jest.Mock }): any {
  return { connect: jest.fn(async () => client) };
}

describe('a failing ROLLBACK does not mask the original error (rollback masking, Task 5)', () => {
  afterEach(() => {
    mockPool = null;
  });

  it('repository.attachFile: reports the ORIGINAL error when ROLLBACK also fails', async () => {
    const client = fakeClient((sql) => {
      if (sql === 'BEGIN') return undefined;
      if (sql.startsWith('INSERT INTO vector_store_files')) throw new Error(REAL_CAUSE_MESSAGE);
      if (sql === 'ROLLBACK') throw new Error(ROLLBACK_MESSAGE);
      throw new Error(`unexpected query in test: ${sql}`);
    });
    mockPool = fakePool(client);

    await expect(attachFile('vs_1', 'file_1', null, null)).rejects.toThrow(REAL_CAUSE_MESSAGE);
  });

  it('repository.deleteStoreFile: reports the ORIGINAL error when ROLLBACK also fails', async () => {
    const client = fakeClient((sql) => {
      if (sql === 'BEGIN') return undefined;
      if (sql.includes('SELECT id FROM vector_stores')) return { rowCount: 1, rows: [{ id: 'vs_1' }] };
      if (sql.includes('DELETE FROM vector_store_files')) return { rowCount: 1, rows: [{ file_id: 'file_1' }] };
      if (sql.includes('DELETE FROM vector_store_chunks')) throw new Error(REAL_CAUSE_MESSAGE);
      if (sql === 'ROLLBACK') throw new Error(ROLLBACK_MESSAGE);
      throw new Error(`unexpected query in test: ${sql}`);
    });
    mockPool = fakePool(client);

    await expect(deleteStoreFile('vs_1', 'file_1', 'owner@example.com')).rejects.toThrow(REAL_CAUSE_MESSAGE);
  });

  it('repository.deleteStoreCascade: reports the ORIGINAL error when ROLLBACK also fails', async () => {
    const client = fakeClient((sql) => {
      if (sql === 'BEGIN') return undefined;
      if (sql.includes('SELECT id FROM vector_stores')) return { rowCount: 1, rows: [{ id: 'vs_1' }] };
      if (sql.includes('DELETE FROM vector_store_chunks')) throw new Error(REAL_CAUSE_MESSAGE);
      if (sql === 'ROLLBACK') throw new Error(ROLLBACK_MESSAGE);
      throw new Error(`unexpected query in test: ${sql}`);
    });
    mockPool = fakePool(client);

    await expect(deleteStoreCascade('vs_1', 'owner@example.com')).rejects.toThrow(REAL_CAUSE_MESSAGE);
  });

  it('blobStore.retainBlob: reports the ORIGINAL error when ROLLBACK also fails', async () => {
    const client = fakeClient((sql) => {
      if (sql === 'BEGIN') return undefined;
      if (sql.includes('SELECT sha256 FROM file_blobs')) return { rowCount: 1, rows: [{ sha256: 'a'.repeat(64) }] };
      if (sql.includes('UPDATE file_blobs SET ref_count = ref_count + 1')) throw new Error(REAL_CAUSE_MESSAGE);
      if (sql === 'ROLLBACK') throw new Error(ROLLBACK_MESSAGE);
      throw new Error(`unexpected query in test: ${sql}`);
    });
    mockPool = fakePool(client);

    await expect(retainBlob('a'.repeat(64), Buffer.from('x'), 'text/plain')).rejects.toThrow(REAL_CAUSE_MESSAGE);
  });

  it('blobStore.releaseBlob: reports the ORIGINAL error when ROLLBACK also fails', async () => {
    const client = fakeClient((sql) => {
      if (sql === 'BEGIN') return undefined;
      // ref_count 2 -> remaining 1 -> takes the UPDATE branch, never the
      // DELETE/physical-delete branch, so this stays a pure transaction test.
      if (sql.includes('SELECT ref_count FROM file_blobs')) return { rowCount: 1, rows: [{ ref_count: 2 }] };
      if (sql.includes('UPDATE file_blobs SET ref_count = $2')) throw new Error(REAL_CAUSE_MESSAGE);
      if (sql === 'ROLLBACK') throw new Error(ROLLBACK_MESSAGE);
      throw new Error(`unexpected query in test: ${sql}`);
    });
    mockPool = fakePool(client);

    await expect(releaseBlob('a'.repeat(64))).rejects.toThrow(REAL_CAUSE_MESSAGE);
  });
});

// ---------------------------------------------------------------------------
// batches.discardPartialBatch -- the same property, extended to the CONNECTION
// handling, not just the ROLLBACK statement.
//
// `createBatch` calls `discardPartialBatch` from inside its own catch and then
// rethrows the original error, unguarded. So anything that escapes the cleanup
// -- including its `pool.connect()` and its `client.release()` -- replaces the
// caller's error, not merely supplements it. That matters because of WHEN the
// cleanup runs: the realistic reason an attach fails mid-batch is that the
// database is unreachable or the pool is saturated, which is exactly when a
// second `connect()` also fails. Without the guard, the 23505/23503 that the
// HTTP layer maps to a 409/404 becomes an opaque connection error -- a 500.
//
// Both tests below assert on the ORIGINAL message and additionally assert the
// cleanup path really executed, so neither can pass vacuously by simply never
// reaching the code under test.
// ---------------------------------------------------------------------------

/** A pool whose `connect()` hands out a scripted client (or failure) per call:
 *  call 1 is the failing `attachFile`, call 2 is the cleanup's own. */
function fakeBatchPool(connectImpls: Array<() => any>): any {
  let call = 0;
  return {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO vector_store_batches')) {
        return {
          rowCount: 1,
          rows: [{ id: 'vsfb_1', store_id: 'vs_1', cancel_requested: false, created_at: new Date() }],
        };
      }
      throw new Error(`unexpected pool query in test: ${sql}`);
    }),
    connect: jest.fn(async () => {
      const impl = connectImpls[call];
      call += 1;
      if (!impl) throw new Error('unexpected extra pool.connect() in test');
      return impl();
    }),
  };
}

/** The `attachFile` transaction that fails, triggering the cleanup. Its own
 *  ROLLBACK succeeds, so anything the test observes comes from the cleanup. */
function failingAttachClient(): { query: jest.Mock; release: jest.Mock } {
  return fakeClient((sql) => {
    if (sql === 'BEGIN') return undefined;
    if (sql.startsWith('INSERT INTO vector_store_files')) throw new Error(REAL_CAUSE_MESSAGE);
    if (sql === 'ROLLBACK') return undefined;
    throw new Error(`unexpected query in test: ${sql}`);
  });
}

describe('batches.discardPartialBatch: cleanup failures never mask createBatch\'s original error', () => {
  afterEach(() => {
    mockPool = null;
  });

  it('connection handling: reports the ORIGINAL error when the cleanup\'s own pool.connect() fails', async () => {
    const pool = fakeBatchPool([
      () => failingAttachClient(),
      () => { throw new Error(CLEANUP_MESSAGE); },
    ]);
    mockPool = pool;

    await expect(createBatch('vs_1', ['file_1'], null, null)).rejects.toThrow(REAL_CAUSE_MESSAGE);
    // ...and the cleanup was genuinely attempted, so this is not vacuous.
    expect(pool.connect).toHaveBeenCalledTimes(2);
  });

  it('connection handling: reports the ORIGINAL error when the cleanup\'s client.release() throws', async () => {
    const cleanupClient = fakeClient((sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return undefined;
      if (sql.includes('SELECT id FROM vector_stores')) return { rowCount: 1, rows: [{ id: 'vs_1' }] };
      if (sql.startsWith('DELETE FROM')) return { rowCount: 0, rows: [] };
      throw new Error(`unexpected query in test: ${sql}`);
    });
    // An already-destroyed client throws from release(); every statement above
    // it succeeded, so release() is the only thing left that can fail.
    cleanupClient.release = jest.fn(() => { throw new Error(CLEANUP_MESSAGE); });

    const pool = fakeBatchPool([() => failingAttachClient(), () => cleanupClient]);
    mockPool = pool;

    await expect(createBatch('vs_1', ['file_1'], null, null)).rejects.toThrow(REAL_CAUSE_MESSAGE);
    expect(cleanupClient.release).toHaveBeenCalled();
  });
});
