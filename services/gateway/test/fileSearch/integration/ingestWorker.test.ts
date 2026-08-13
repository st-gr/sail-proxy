// Live-Postgres coverage of the ingest worker for the properties that
// cannot be demonstrated against a mock: the atomic claim (FOR UPDATE SKIP
// LOCKED never lets two callers claim the same row), lease recovery/holding,
// the retry budget capping a poison document, and — the sharpest one — that
// a store delete racing an ingestion write can never leave orphaned chunks
// behind, even though vector_store_chunks has no foreign key (see Task 10's
// report and ingestWorker.ts's own module doc comment).
//
// extractText and embed are mocked (subprocess/network calls, already
// covered live by Tasks 4-6); chunker and every database interaction here
// are real, against a per-suite isolated Postgres schema.
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { sha256Of, retainBlob } from '../../../src/fileSearch/blob/blobStore';
import { newFileId } from '../../../src/fileSearch/ids';
import * as repo from '../../../src/fileSearch/repository';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

jest.mock('../../../src/fileSearch/extractors/registry', () => {
  const actual = jest.requireActual('../../../src/fileSearch/extractors/registry');
  return { ...actual, extractText: jest.fn() };
});

jest.mock('../../../src/fileSearch/embedder', () => ({
  __esModule: true,
  embed: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { extractText, UnsupportedFileTypeError } = require('../../../src/fileSearch/extractors/registry');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { embed } = require('../../../src/fileSearch/embedder');

import {
  claimNext, processOne, startIngestWorker, stopIngestWorker, __commitChunksForTests,
} from '../../../src/fileSearch/ingestWorker';

function fakeVector(): number[] {
  return Array.from({ length: EMBED_DIM }, () => Math.random());
}

d('ingestWorker against a real Postgres database (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;

  beforeAll(async () => {
    mockConfig = {
      enabled: true,
      embeddingModel: 'test-model',
      embeddingDimensions: EMBED_DIM,
      limits: { maxFileBytes: 1000000, maxTokensPerFile: 1000000, maxFilesPerStore: 10000 },
      ingestion: { concurrency: 4, extractTimeoutMs: 5000, maxRetries: 3 },
      blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
    };
    fixture = await createIsolatedSchema(DSN!, EMBED_DIM);
    process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
    __resetForTests();
    await runMigration();
    pool = getPool()!;
  });

  afterAll(async () => {
    __resetForTests();
    await pool.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await fixture.teardown();
  });

  beforeEach(async () => {
    mockConfig = {
      enabled: true,
      embeddingModel: 'test-model',
      embeddingDimensions: EMBED_DIM,
      limits: { maxFileBytes: 1000000, maxTokensPerFile: 1000000, maxFilesPerStore: 10000 },
      ingestion: { concurrency: 4, extractTimeoutMs: 5000, maxRetries: 3 },
      blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
    };
    extractText.mockReset();
    embed.mockReset();
    extractText.mockImplementation(async (_filename: string, bytes: Buffer) => bytes.toString('utf8'));
    embed.mockImplementation(async (texts: string[]) => ({
      vectors: texts.map(() => fakeVector()),
      usage: { promptTokens: texts.length * 10, totalTokens: texts.length * 10 },
    }));
    await pool.query('DELETE FROM vector_store_chunks');
    await pool.query('DELETE FROM vector_store_files');
    await pool.query('DELETE FROM vector_stores');
    await pool.query('DELETE FROM fs_files');
    await pool.query('DELETE FROM file_blobs');
  });

  afterEach(async () => {
    await stopIngestWorker();
  });

  // -- helpers --------------------------------------------------------

  async function seedAttached(
    ownerEmail: string,
    opts: { content?: Buffer; claimedAt?: Date | null; attempts?: number } = {},
  ): Promise<{ storeId: string; fileId: string }> {
    const store = await repo.createStore({ ownerEmail });
    const content = opts.content ?? Buffer.from('lorem ipsum dolor sit amet '.repeat(50));
    const sha = sha256Of(content);
    await retainBlob(sha, content, 'text/plain');
    const fileId = newFileId();
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at)
       VALUES ($1,$2,'doc.txt','assistants',$3,$4, now())`,
      [fileId, ownerEmail, sha, content.length],
    );
    await repo.attachFile(store.id, fileId, null);
    if (opts.claimedAt !== undefined || opts.attempts !== undefined) {
      await pool.query(
        `UPDATE vector_store_files SET claimed_at = $3, attempts = $4 WHERE store_id = $1 AND file_id = $2`,
        [store.id, fileId, opts.claimedAt ?? null, opts.attempts ?? 0],
      );
    }
    return { storeId: store.id, fileId };
  }

  async function statusOf(storeId: string, fileId: string): Promise<string> {
    const { rows } = await pool.query(
      'SELECT status FROM vector_store_files WHERE store_id=$1 AND file_id=$2', [storeId, fileId]);
    return rows[0]?.status;
  }
  async function attemptsOf(storeId: string, fileId: string): Promise<number> {
    const { rows } = await pool.query(
      'SELECT attempts FROM vector_store_files WHERE store_id=$1 AND file_id=$2', [storeId, fileId]);
    return rows[0]?.attempts;
  }
  async function lastErrorOf(storeId: string, fileId: string): Promise<any> {
    const { rows } = await pool.query(
      'SELECT last_error FROM vector_store_files WHERE store_id=$1 AND file_id=$2', [storeId, fileId]);
    return rows[0]?.last_error;
  }
  async function chunkCount(storeId: string, fileId: string): Promise<number> {
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM vector_store_chunks WHERE store_id=$1 AND file_id=$2', [storeId, fileId]);
    return rows[0].n;
  }
  async function totalChunkCountForStore(storeId: string): Promise<number> {
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM vector_store_chunks WHERE store_id=$1', [storeId]);
    return rows[0].n;
  }
  /** Sweeps the WHOLE schema (not just one store) for the exact corruption
   *  the concurrency hazard produces: a chunk row whose (store_id, file_id)
   *  has no matching vector_store_files row, or whose store_id has no
   *  matching vector_stores row at all. Used after every interleaving test
   *  as a broader net than a single scoped count. */
  async function sweepForOrphanedChunks(): Promise<{ noVsfRow: number; noStoreRow: number }> {
    const { rows: r1 } = await pool.query(`
      SELECT count(*)::int AS n FROM vector_store_chunks c
      LEFT JOIN vector_store_files vsf ON vsf.store_id = c.store_id AND vsf.file_id = c.file_id
      WHERE vsf.store_id IS NULL`);
    const { rows: r2 } = await pool.query(`
      SELECT count(*)::int AS n FROM vector_store_chunks c
      LEFT JOIN vector_stores vs ON vs.id = c.store_id
      WHERE vs.id IS NULL`);
    return { noVsfRow: r1[0].n, noStoreRow: r2[0].n };
  }

  // -- success / failure basics ----------------------------------------

  it('marks a file completed and writes chunks on success', async () => {
    const { storeId, fileId } = await seedAttached('a@x.com');
    await processOne(storeId, fileId);
    expect(await statusOf(storeId, fileId)).toBe('completed');
    expect(await chunkCount(storeId, fileId)).toBeGreaterThan(0);
  });

  it('records usage_bytes and clears claimed_at on success', async () => {
    const { storeId, fileId } = await seedAttached('a@x.com');
    await processOne(storeId, fileId);
    const { rows } = await pool.query(
      'SELECT usage_bytes, claimed_at FROM vector_store_files WHERE store_id=$1 AND file_id=$2', [storeId, fileId]);
    expect(Number(rows[0].usage_bytes)).toBeGreaterThan(0);
    expect(rows[0].claimed_at).toBeNull();
  });

  it('a permanent failure (UnsupportedFileTypeError) marks the file failed immediately, without waiting on the retry budget', async () => {
    const { storeId, fileId } = await seedAttached('a@x.com');
    extractText.mockRejectedValue(new UnsupportedFileTypeError('pptx'));
    await processOne(storeId, fileId);
    expect(await statusOf(storeId, fileId)).toBe('failed');
    expect(await attemptsOf(storeId, fileId)).toBe(0); // never went through claimNext
    const lastError = await lastErrorOf(storeId, fileId);
    expect(lastError.message).toContain('Unsupported file type');
  });

  it('a transient failure (e.g. a timeout / upstream error) is retried, and only marked failed once the claimed attempt budget is exhausted', async () => {
    const { storeId, fileId } = await seedAttached('a@x.com');
    extractText.mockRejectedValue(new Error('pandoc exited 1'));

    // Cycle 1: claim (attempts -> 1) + process (fails, budget remains: 1 < 3)
    let job = await claimNext();
    expect(job).toEqual({ storeId, fileId });
    await processOne(job!.storeId, job!.fileId);
    expect(await statusOf(storeId, fileId)).toBe('in_progress');
    expect(await attemptsOf(storeId, fileId)).toBe(1);

    // Cycle 2: attempts -> 2, still under budget
    job = await claimNext();
    expect(job).toEqual({ storeId, fileId });
    await processOne(job!.storeId, job!.fileId);
    expect(await statusOf(storeId, fileId)).toBe('in_progress');
    expect(await attemptsOf(storeId, fileId)).toBe(2);

    // Cycle 3: attempts -> 3, budget exhausted (maxRetries=3) -> failed
    job = await claimNext();
    expect(job).toEqual({ storeId, fileId });
    await processOne(job!.storeId, job!.fileId);
    expect(await statusOf(storeId, fileId)).toBe('failed');
    expect(await attemptsOf(storeId, fileId)).toBe(3);
    const lastError = await lastErrorOf(storeId, fileId);
    expect(lastError.message).toContain('pandoc exited 1');
  });

  it('stops retrying at max_retries rather than looping forever on a poison document', async () => {
    const { storeId, fileId } = await seedAttached('a@x.com');
    extractText.mockRejectedValue(new Error('always fails'));

    for (let i = 0; i < 10; i++) {
      const job = await claimNext();
      if (job) await processOne(job.storeId, job.fileId);
    }

    expect(await attemptsOf(storeId, fileId)).toBeLessThanOrEqual(3);
    expect(await statusOf(storeId, fileId)).toBe('failed');
    // A file stuck at 'failed' must never be claimable again.
    expect(await claimNext()).toBeNull();
  });

  it('a store whose pinned embedding_dim has drifted from the live config fails immediately as a permanent error', async () => {
    const { storeId, fileId } = await seedAttached('a@x.com');
    mockConfig.embeddingDimensions = EMBED_DIM + 1; // config changed after the store was created/pinned
    await processOne(storeId, fileId);
    expect(await statusOf(storeId, fileId)).toBe('failed');
    expect(await attemptsOf(storeId, fileId)).toBe(0);
    const lastError = await lastErrorOf(storeId, fileId);
    expect(lastError.message).toMatch(/dimension/i);
    expect(embed).not.toHaveBeenCalled();
  });

  it('a file whose extracted text exceeds limits.maxTokensPerFile fails immediately as a permanent error, without ever calling embed (I3)', async () => {
    const { storeId, fileId } = await seedAttached('a@x.com');
    mockConfig.limits.maxTokensPerFile = 5;
    extractText.mockResolvedValue('one two three four five six seven eight nine ten eleven twelve');

    await processOne(storeId, fileId);

    expect(await statusOf(storeId, fileId)).toBe('failed');
    expect(await attemptsOf(storeId, fileId)).toBe(0); // never went through claimNext
    const lastError = await lastErrorOf(storeId, fileId);
    expect(lastError.message).toMatch(/token/i);
    expect(embed).not.toHaveBeenCalled();
  });

  // Final whole-branch review, Important #3: last_error is written
  // unmodified and served back over GET /vector_stores/{id}/files -- it can
  // carry a raw Postgres driver message or a spawn error embedding an
  // extractor binary's absolute filesystem path (see runners.ts's
  // resolveBinary). Only the file's own owner ever sees it, but this
  // branch's rule everywhere else is that no API-facing surface echoes a raw
  // driver string or a filesystem path.
  it('sanitizes a genuine Postgres/pgvector error before persisting it to last_error', async () => {
    const { storeId, fileId } = await seedAttached('a@x.com');
    // A vector of the wrong dimension makes the real `::vector` cast inside
    // commitChunks's INSERT fail with a genuine pgvector error -- not a
    // mock standing in for one. EMBED_DIM is 3; this returns 2.
    embed.mockImplementation(async (texts: string[]) => ({
      vectors: texts.map(() => [1, 2]),
      usage: { promptTokens: texts.length, totalTokens: texts.length },
    }));

    await processOne(storeId, fileId);

    const lastError = await lastErrorOf(storeId, fileId);
    expect(lastError.message.length).toBeLessThanOrEqual(520); // bounded, not raw-unbounded
    // eslint-disable-next-line no-control-regex
    expect(lastError.message).not.toMatch(/[\x00-\x1f\x7f]/); // no raw control characters
  });

  it('sanitizes a spawn-failure message (an absolute binary path) before persisting it to last_error', async () => {
    const { storeId, fileId } = await seedAttached('a@x.com');
    // The exact shape runners.ts's launch-failure handler actually produces
    // (see its `child.on('error', ...)` handler): `resolveBinary` embeds the
    // extractor's fully resolved absolute path in the message.
    extractText.mockRejectedValue(new Error('Failed to launch pandoc: spawn /usr/local/bin/pandoc EACCES'));

    await processOne(storeId, fileId);

    const lastError = await lastErrorOf(storeId, fileId);
    expect(lastError.message).not.toContain('/usr/local/bin/pandoc');
    expect(lastError.message).toContain('[path]');
    // The failure category survives redaction: an owner can still tell what
    // kind of failure this was.
    expect(lastError.message).toContain('EACCES');
    expect(lastError.message).toContain('Failed to launch pandoc');
  });

  it('stores each chunk\'s embedding aligned to that exact chunk, and ord runs contiguously from zero (I2)', async () => {
    // A large, non-repetitive input so the default chunking strategy
    // (800 max / 400 overlap tokens) produces more than one chunk --
    // alignment across chunks only means something when N > 1.
    const words = Array.from({ length: 4000 }, (_, i) => `word${i}`).join(' ');
    const { storeId, fileId } = await seedAttached('a@x.com', { content: Buffer.from(words) });

    // Index-derived, distinguishable-per-chunk vectors (not random): lets
    // this test detect BOTH a reversed vectors[i]/chunks[i] pairing and a
    // scrambled/reversed `ord`, neither of which fakeVector() (uniformly
    // random per call) could ever catch.
    embed.mockImplementation(async (texts: string[]) => ({
      vectors: texts.map((_, i) => [i, i + 0.25, i + 0.5]),
      usage: { promptTokens: 0, totalTokens: 0 },
    }));

    await processOne(storeId, fileId);
    expect(await statusOf(storeId, fileId)).toBe('completed');

    const { rows } = await pool.query(
      `SELECT ord, embedding::text AS embedding FROM vector_store_chunks
       WHERE store_id=$1 AND file_id=$2 ORDER BY ord`,
      [storeId, fileId],
    );
    expect(rows.length).toBeGreaterThan(1); // otherwise alignment across N>1 isn't actually exercised

    // ord is contiguous from zero -- no gaps, no duplicates.
    expect(rows.map((r: any) => r.ord)).toEqual(rows.map((_: any, i: number) => i));

    // Each row's embedding is the vector that corresponds to ITS OWN index
    // -- not some other chunk's. A reversed vectors[i]/chunks[i] pairing, or
    // a reversed ord, both produce a mismatch here.
    for (const row of rows) {
      const parsed = row.embedding.slice(1, -1).split(',').map(Number);
      expect(parsed[0]).toBeCloseTo(row.ord, 5);
      expect(parsed[1]).toBeCloseTo(row.ord + 0.25, 5);
      expect(parsed[2]).toBeCloseTo(row.ord + 0.5, 5);
    }
  });

  it('skips embedding when processOne is called again on an already-completed file (idempotent no-op)', async () => {
    const { storeId, fileId } = await seedAttached('a@x.com');
    await processOne(storeId, fileId);
    expect(await statusOf(storeId, fileId)).toBe('completed');
    const callsBefore = embed.mock.calls.length;

    await processOne(storeId, fileId);

    expect(embed.mock.calls.length).toBe(callsBefore);
    expect(await statusOf(storeId, fileId)).toBe('completed');
  });

  it('processOne is a no-op when the row has already been deleted (e.g. a race with a detach)', async () => {
    const { storeId, fileId } = await seedAttached('a@x.com');
    await repo.deleteStoreFile(storeId, fileId, 'a@x.com');
    await expect(processOne(storeId, fileId)).resolves.toBeUndefined();
    expect(await chunkCount(storeId, fileId)).toBe(0);
  });

  // -- lease semantics --------------------------------------------------

  it('re-claims a row whose lease has expired', async () => {
    const { storeId, fileId } = await seedAttached('a@x.com', { claimedAt: new Date(Date.now() - 3600_000) });
    const job = await claimNext();
    expect(job).toEqual({ storeId, fileId });
  });

  it('does not claim a row whose lease is still held', async () => {
    await seedAttached('a@x.com', { claimedAt: new Date() });
    expect(await claimNext()).toBeNull();
  });

  it('a row that has exhausted its retry budget and lost its lease is reaped to failed, not left as an unreachable zombie (I1)', async () => {
    // Simulates a worker that took the FINAL claim (attempts -> maxRetries,
    // claimed_at set) and then crashed/restarted before ever reaching
    // handleFailure or commitChunks -- the exact gap that used to leave the
    // row permanently 'in_progress' with nothing able to ever touch it
    // again (claimNext's own `attempts < maxRetries` filter forbids it).
    const { storeId, fileId } = await seedAttached('a@x.com', {
      attempts: 3, claimedAt: new Date(Date.now() - 3600_000),
    });

    expect(await claimNext()).toBeNull(); // never reclaimed, by design (budget exhausted)
    // ...but must not be left stuck 'in_progress' forever either: claimNext
    // opportunistically reaps it to a terminal state on the same call.
    expect(await statusOf(storeId, fileId)).toBe('failed');
    const lastError = await lastErrorOf(storeId, fileId);
    expect(lastError.message).toBeTruthy();
  });

  it('does not reap a row that has exhausted its retry budget while its lease is still live (a worker may be actively finishing it)', async () => {
    const { storeId, fileId } = await seedAttached('a@x.com', { attempts: 3, claimedAt: new Date() });
    expect(await claimNext()).toBeNull();
    // A live lease means a worker plausibly still holds this row and is
    // about to call handleFailure/commitChunks itself -- reaping it out
    // from under that in-flight call would race it. Left alone here.
    expect(await statusOf(storeId, fileId)).toBe('in_progress');
  });

  it('two concurrent claimNext calls never return the same row, and each claimable row is claimed exactly once', async () => {
    const seeded = await Promise.all(Array.from({ length: 5 }, (_, i) => seedAttached(`owner${i}@x.com`)));

    const results = await Promise.all(Array.from({ length: 10 }, () => claimNext()));
    const claimed = results.filter((r): r is { storeId: string; fileId: string } => r !== null);

    expect(claimed.length).toBe(5);
    const keys = claimed.map((c) => `${c.storeId}:${c.fileId}`);
    expect(new Set(keys).size).toBe(5); // no duplicates
    for (const s of seeded) {
      expect(keys).toContain(`${s.storeId}:${s.fileId}`);
    }
  });

  it('claiming increments attempts by exactly one per claim, and processOne does not touch attempts at all on success', async () => {
    const { storeId, fileId } = await seedAttached('a@x.com');
    const job = await claimNext();
    expect(await attemptsOf(storeId, fileId)).toBe(1);
    await processOne(job!.storeId, job!.fileId);
    expect(await attemptsOf(storeId, fileId)).toBe(1); // unchanged by processOne itself
    expect(await statusOf(storeId, fileId)).toBe('completed');
  });

  // -- worker loop concurrency -------------------------------------------

  it('never runs more than ingestion.concurrency processOne calls at once, and drains the whole queue via polling alone', async () => {
    mockConfig.ingestion.concurrency = 3;
    const jobs = await Promise.all(Array.from({ length: 12 }, (_, i) => seedAttached(`bulk${i}@x.com`)));

    let inFlight = 0;
    let maxInFlight = 0;
    embed.mockImplementation(async (texts: string[]) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
      return { vectors: texts.map(() => fakeVector()), usage: { promptTokens: 0, totalTokens: 0 } };
    });

    startIngestWorker();

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM vector_store_files WHERE status = 'in_progress'`);
      if (rows[0].n === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await stopIngestWorker();

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1); // proves real concurrency happened, not accidental serialization
    for (const j of jobs) {
      expect(await statusOf(j.storeId, j.fileId)).toBe('completed');
    }
  }, 25000);

  // -- the concurrency hazard: chunks must never outlive their store -----
  //
  // Two DISTINCT orderings, both required (review round 1 only covered the
  // first; the gap it found is exactly why the second exists now):
  //   1. "delete completes first" — the delete fully commits (both rows
  //      gone) before ingestion's write transaction ever starts.
  //   2. "ingestion locks first" — ingestion acquires ITS locks (FOR SHARE
  //      on vector_stores, FOR UPDATE on the vsf row) and holds its
  //      transaction open while a concurrent delete starts and blocks
  //      behind it, then resolves. This is the ordering under which the
  //      FOR SHARE guard is actually load-bearing (see ingestWorker.ts's
  //      module doc comment) — mutation-confirmed to orphan chunks when
  //      that lock is removed, in a way ordering 1 alone never catches.

  it('[delete-completes-first] does not orphan chunks when a store delete races an ingestion write (no FK on vector_store_chunks)', async () => {
    const ownerEmail = 'race@x.com';
    const { storeId, fileId } = await seedAttached(ownerEmail);

    // Force ingestion to be mid-flight (past extraction, blocked inside the
    // mocked embed call) when the cascade delete runs, and let the cascade
    // run to completion (both rows gone) before ingestion's own write
    // transaction ever begins acquiring locks.
    embed.mockImplementation(async (texts: string[]) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { vectors: texts.map(() => fakeVector()), usage: { promptTokens: 0, totalTokens: 0 } };
    });

    const ingestionPromise = processOne(storeId, fileId);
    await new Promise((resolve) => setTimeout(resolve, 60)); // ingestion is now stuck inside embed()

    const { deleted } = await repo.deleteStoreCascade(storeId, ownerEmail);
    expect(deleted).toBe(true);

    await ingestionPromise; // now embed resolves and commitChunks runs against a gone store

    expect(await totalChunkCountForStore(storeId)).toBe(0);
    const { rows: storeRows } = await pool.query('SELECT 1 FROM vector_stores WHERE id=$1', [storeId]);
    expect(storeRows.length).toBe(0);
    expect(await sweepForOrphanedChunks()).toEqual({ noVsfRow: 0, noStoreRow: 0 });
  });

  it('[delete-completes-first] does not orphan chunks when a per-file detach races an ingestion write', async () => {
    const ownerEmail = 'race2@x.com';
    const { storeId, fileId } = await seedAttached(ownerEmail);

    embed.mockImplementation(async (texts: string[]) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { vectors: texts.map(() => fakeVector()), usage: { promptTokens: 0, totalTokens: 0 } };
    });

    const ingestionPromise = processOne(storeId, fileId);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const { deleted } = await repo.deleteStoreFile(storeId, fileId, ownerEmail);
    expect(deleted).toBe(true);

    await ingestionPromise;

    expect(await chunkCount(storeId, fileId)).toBe(0);
    expect(await sweepForOrphanedChunks()).toEqual({ noVsfRow: 0, noStoreRow: 0 });
  });

  it('[ingestion-locks-first] does not orphan chunks when ingestion holds its locks open across a concurrent store-cascade delete', async () => {
    const ownerEmail = 'race3@x.com';
    const { storeId, fileId } = await seedAttached(ownerEmail);
    const chunks = [{ ord: 0, text: 'alpha', tokens: 1 }, { ord: 1, text: 'beta', tokens: 1 }];
    const vectors = [fakeVector(), fakeVector()];

    let cascadePromise: Promise<{ deleted: boolean }> | null = null;
    // __commitChunksForTests's onLocksAcquiredForTests hook fires AFTER
    // both the FOR SHARE (vector_stores) and FOR UPDATE (vector_store_files)
    // locks are held, and BEFORE any write -- exactly the window review
    // round 1's tests never constructed (they only ever exercised delete-
    // completes-before-ingestion-starts). Kicking off the cascade here,
    // while those locks are held, forces the cascade to block on the very
    // FOR SHARE this whole guard exists to prove is load-bearing.
    await __commitChunksForTests(storeId, fileId, chunks, vectors, undefined, async () => {
      cascadePromise = repo.deleteStoreCascade(storeId, ownerEmail);
      // Give the cascade time to actually reach and block on the lock
      // (rather than racing our own subsequent insert/commit) — generous
      // relative to a local Postgres round trip.
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    const { deleted } = await cascadePromise!;
    expect(deleted).toBe(true);

    expect(await totalChunkCountForStore(storeId)).toBe(0);
    const { rows: storeRows } = await pool.query('SELECT 1 FROM vector_stores WHERE id=$1', [storeId]);
    expect(storeRows.length).toBe(0);
    expect(await sweepForOrphanedChunks()).toEqual({ noVsfRow: 0, noStoreRow: 0 });
  });

  it('[ingestion-locks-first] does not orphan chunks when ingestion holds both its locks open across a concurrent per-file detach', async () => {
    // NOTE: this ordering (ingestion already holds the vsf lock before the
    // detach is even kicked off) can never form a lock-order CYCLE — the
    // detach simply blocks entirely behind ingestion's already-held vsf
    // lock, one-sided, regardless of which lock order deleteStoreFile uses
    // internally. It is a real orphan-prevention test, but it is NOT a C2
    // (deadlock) regression guard; see the dedicated C2 test below for that
    // — a review round correctly flagged that this test's name previously
    // implied deadlock coverage it didn't provide.
    const ownerEmail = 'race4@x.com';
    const { storeId, fileId } = await seedAttached(ownerEmail);
    const chunks = [{ ord: 0, text: 'alpha', tokens: 1 }, { ord: 1, text: 'beta', tokens: 1 }];
    const vectors = [fakeVector(), fakeVector()];

    let detachPromise: Promise<{ deleted: boolean }> | null = null;
    await __commitChunksForTests(storeId, fileId, chunks, vectors, undefined, async () => {
      detachPromise = repo.deleteStoreFile(storeId, fileId, ownerEmail);
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    const { deleted } = await detachPromise!;
    expect(deleted).toBe(true);

    expect(await chunkCount(storeId, fileId)).toBe(0);
    expect(await sweepForOrphanedChunks()).toEqual({ noVsfRow: 0, noStoreRow: 0 });
  });

  it('[C2] does not deadlock when a detach acquires the vsf row while ingestion holds only FOR SHARE and is about to request it — the actual lock-order cycle', async () => {
    // This is the interleaving that can actually deadlock under the WRONG
    // lock order, and the one review round 2 pointed out the prior test
    // did not construct: ingestion must be caught HOLDING vector_stores
    // FOR SHARE but NOT YET holding the vsf row when the detach starts, so
    // the detach can grab the vsf row first and then itself block wanting
    // vector_stores — closing the cycle. commitChunks's
    // onStoreShareAcquiredForTests hook fires at exactly that point (after
    // FOR SHARE, before the vsf FOR UPDATE attempt).
    const ownerEmail = 'race5@x.com';
    const { storeId, fileId } = await seedAttached(ownerEmail);
    const chunks = [{ ord: 0, text: 'alpha', tokens: 1 }, { ord: 1, text: 'beta', tokens: 1 }];
    const vectors = [fakeVector(), fakeVector()];

    let detachPromise: Promise<{ deleted: boolean }> | undefined;
    const commitOutcome = await __commitChunksForTests(storeId, fileId, chunks, vectors, async () => {
      detachPromise = repo.deleteStoreFile(storeId, fileId, ownerEmail);
      // Give the detach a head start to actually issue (not necessarily
      // finish) its first lock request before ingestion proceeds to
      // attempt the vsf lock right after this hook returns.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }).then(
      () => ({ ok: true as const }),
      (err: any) => ({ ok: false as const, code: err?.code, message: err?.message }),
    );
    const detachOutcome = await detachPromise!.then(
      (v) => ({ ok: true as const, deleted: v.deleted }),
      (err: any) => ({ ok: false as const, code: err?.code, message: err?.message }),
    );

    // With the current (fixed) lock order, this must resolve cleanly on
    // both sides — one side blocks briefly behind the other, but neither
    // is ever chosen as a deadlock victim. If this assertion fails after a
    // change to deleteStoreFile's lock order, that change reintroduced C2.
    expect(commitOutcome.ok).toBe(true);
    expect(detachOutcome.ok).toBe(true);
    if (detachOutcome.ok) expect(detachOutcome.deleted).toBe(true);

    expect(await chunkCount(storeId, fileId)).toBe(0);
    expect(await sweepForOrphanedChunks()).toEqual({ noVsfRow: 0, noStoreRow: 0 });
  }, 15000);
});
