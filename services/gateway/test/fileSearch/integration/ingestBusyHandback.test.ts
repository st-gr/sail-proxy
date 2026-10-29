// A busy file_search pool is not the file's fault: an ingestion attempt that fails with
// FileSearchBusyError is handed back without spending an attempt, claimable again after a short
// delay, never failed. Real Postgres; the busy error is injected where the attempt reads the blob
// (inside the attempt's error handling) and at its first read (outside it).
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests, FileSearchBusyError } from '../../../src/fileSearch/db';
import { sha256Of, retainBlob } from '../../../src/fileSearch/blob/blobStore';
import * as blobStore from '../../../src/fileSearch/blob/blobStore';
import { newFileId } from '../../../src/fileSearch/ids';
import * as repo from '../../../src/fileSearch/repository';
import { BUSY_RETRY_SECONDS, LEASE_MINUTES } from '../../../src/fileSearch/workQueue';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;
const EMBED_DIM = 3;

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));
jest.mock('../../../src/fileSearch/embedder', () => {
  const actual = jest.requireActual('../../../src/fileSearch/embedder');
  return { ...actual, __esModule: true, embed: jest.fn() };
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { embed } = require('../../../src/fileSearch/embedder');

// eslint-disable-next-line import/first
import { claimNext, processOne } from '../../../src/fileSearch/ingestWorker';

d('ingestion with a busy pool (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;

  beforeAll(async () => {
    mockConfig = {
      enabled: true, embeddingModel: 'test-model', embeddingDimensions: EMBED_DIM,
      limits: { maxFileBytes: 1000000, maxTokensPerFile: 1000000, maxFilesPerStore: 10000 },
      ingestion: { concurrency: 1, extractTimeoutMs: 5000, maxRetries: 3 },
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
    jest.restoreAllMocks();
    embed.mockReset();
    embed.mockImplementation(async (texts: string[]) => ({
      vectors: texts.map(() => Array.from({ length: EMBED_DIM }, () => Math.random())),
      usage: { promptTokens: texts.length, totalTokens: texts.length },
    }));
    await pool.query('DELETE FROM vector_store_chunks');
    await pool.query('DELETE FROM vector_store_files');
    await pool.query('DELETE FROM vector_stores');
    await pool.query('DELETE FROM fs_files');
    await pool.query('DELETE FROM file_blobs');
  });

  async function seedAttached(): Promise<{ storeId: string; fileId: string }> {
    const store = await repo.createStore({ ownerEmail: 'busy@example.com' });
    const content = Buffer.from(`busy pool ${Math.random()} `.repeat(20));
    const sha = sha256Of(content);
    await retainBlob(sha, content, 'text/plain');
    const fileId = newFileId();
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes) VALUES ($1, 'busy@example.com', 'doc.txt', 'assistants', $2, $3)`,
      [fileId, sha, content.length]);
    await repo.attachFile(store.id, fileId, null);
    return { storeId: store.id, fileId };
  }

  const rowOf = async (storeId: string, fileId: string) => (await pool.query(
    `SELECT status, attempts, last_error,
            claimed_at < now() - ($1::int * interval '1 minute') + ($2::int * interval '1 second') + interval '2 seconds' AS backdated,
            (claimed_at IS NULL OR claimed_at < now() - ($1::int * interval '1 minute')) AS claimable_now
       FROM vector_store_files WHERE store_id = $3 AND file_id = $4`,
    [LEASE_MINUTES, BUSY_RETRY_SECONDS, storeId, fileId])).rows[0];

  it('a busy pool during the attempt hands the file back: attempts restored, not failed, claimable after the delay', async () => {
    const { storeId, fileId } = await seedAttached();
    const job = await claimNext();
    expect(job).toEqual({ storeId, fileId });
    expect((await rowOf(storeId, fileId)).attempts).toBe(1);

    jest.spyOn(blobStore, 'openBlob').mockRejectedValue(new FileSearchBusyError());
    await processOne(storeId, fileId);
    const row = await rowOf(storeId, fileId);
    expect(row).toMatchObject({ status: 'in_progress', attempts: 0, backdated: true, claimable_now: false });
    expect(row.last_error.message).toMatch(/file_search is busy/);
    expect(await claimNext()).toBeNull(); // not at once: the pool is busy

    // Many busy rounds never fail the file.
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(`UPDATE vector_store_files SET claimed_at = now() - interval '1 hour' WHERE file_id = $1`, [fileId]);
      // eslint-disable-next-line no-await-in-loop
      expect(await claimNext()).toEqual({ storeId, fileId });
      // eslint-disable-next-line no-await-in-loop
      await processOne(storeId, fileId);
    }
    expect(await rowOf(storeId, fileId)).toMatchObject({ status: 'in_progress', attempts: 0 });

    // Once the pool answers again the file ingests normally.
    jest.restoreAllMocks();
    await pool.query(`UPDATE vector_store_files SET claimed_at = now() - interval '1 hour' WHERE file_id = $1`, [fileId]);
    expect(await claimNext()).toEqual({ storeId, fileId });
    await processOne(storeId, fileId);
    expect((await rowOf(storeId, fileId)).status).toBe('completed');
  });

  it('a busy pool at the attempt\'s first read is handed back the same way', async () => {
    const { storeId, fileId } = await seedAttached();
    expect(await claimNext()).toEqual({ storeId, fileId });
    const realQuery = pool.query.bind(pool);
    let failed = false;
    jest.spyOn(pool, 'query').mockImplementation(((...args: any[]) => {
      if (!failed) { failed = true; return Promise.reject(new FileSearchBusyError()); }
      return (realQuery as any)(...args);
    }) as any);
    await expect(processOne(storeId, fileId)).resolves.toBeUndefined();
    expect(failed).toBe(true);
    expect(await rowOf(storeId, fileId)).toMatchObject({ status: 'in_progress', attempts: 0, backdated: true });
  });

  it('any other error still spends the attempt', async () => {
    const { storeId, fileId } = await seedAttached();
    expect(await claimNext()).toEqual({ storeId, fileId });
    jest.spyOn(blobStore, 'openBlob').mockRejectedValue(new Error('socket hang up'));
    await processOne(storeId, fileId);
    expect(await rowOf(storeId, fileId)).toMatchObject({ status: 'in_progress', attempts: 1, claimable_now: true });
  });
});
