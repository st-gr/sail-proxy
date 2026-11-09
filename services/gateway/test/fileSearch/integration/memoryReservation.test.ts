// The memory reservation of ingestion against a real Postgres at 4000 dimensions (memoryBudget.ts):
// the vectors are admitted with the text as an estimate, so small texts cut small cannot all start
// on their text alone and then grow past the budget; a structure file whose real chunk count is
// above the estimate grows by the difference only.
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { sha256Of, retainBlob } from '../../../src/fileSearch/blob/blobStore';
import { newFileId } from '../../../src/fileSearch/ids';
import * as repo from '../../../src/fileSearch/repository';
import { createBatch } from '../../../src/fileSearch/batches';
import { closeStructureChunkThread } from '../../../src/fileSearch/structureChunkThread';
import { __memoryBudgetForTests } from '../../../src/fileSearch/memoryBudget';
import { getDefaultLogger } from '@libs/logger';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;
const DIM = 4000;
const OWNER = 'memory-owner@example.test';

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
  getTeacherLoggingConfig: () => ({ enabled: false }),
  default: { getFileSearchConfig: () => mockConfig, isPseudonymizationForcedForFileSearch: () => false },
}));

const embedMock: any = jest.fn();
jest.mock('../../../src/fileSearch/embedder', () => ({
  ...jest.requireActual<any>('../../../src/fileSearch/embedder'),
  __esModule: true,
  embed: (...a: any[]) => embedMock(...a),
}));

// eslint-disable-next-line import/first
import { processOne } from '../../../src/fileSearch/ingestWorker';

function config(): any {
  return {
    enabled: true,
    embeddingModel: 'model-a',
    embeddingDimensions: DIM,
    rewriteQuery: false,
    limits: { maxFileBytes: 10_000_000, maxTokensPerFile: 5_000_000, maxFilesPerStore: 10000 },
    ingestion: { concurrency: 4, extractTimeoutMs: 10000, maxRetries: 3 },
    contextual: { model: 'unused', maxDocumentTokens: 32000, concurrency: 1, requestTimeoutMs: 5000, fileDeadlineMs: 60000 },
    chunking: { strategy: 'static', maxChunkSizeTokens: 800, chunkOverlapTokens: 400, contextual: false },
    blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
  };
}

const words = (seed: string, n: number) => Array.from({ length: n }, (_, i) => `${seed}${i % 97}`).join(' ');

d('ingestion\'s memory reservation at 4000 dimensions (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;
  let samples: Array<{ used: number; budget: number; waiting: number; holders: number }>;

  beforeAll(async () => {
    mockConfig = config();
    fixture = await createIsolatedSchema(DSN!, DIM);
    process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
    __resetForTests();
    expect(await runMigration()).toBe(true);
    pool = getPool()!;
  });

  afterAll(async () => {
    await closeStructureChunkThread();
    __memoryBudgetForTests.reset(null);
    __resetForTests();
    await pool.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await fixture.teardown();
  });

  beforeEach(() => {
    mockConfig = config();
    samples = [];
    embedMock.mockReset();
    embedMock.mockImplementation(async (texts: string[]) => {
      samples.push(__memoryBudgetForTests.state());
      await new Promise((r) => setTimeout(r, 100)); // hold the reservation a little, as a real call does
      return { vectors: texts.map(() => new Float32Array(DIM).fill(0.01)), usage: { promptTokens: texts.length, totalTokens: texts.length } };
    });
  });

  async function storeWithFiles(chunking: unknown, contents: string[]): Promise<{ storeId: string; files: string[] }> {
    const store = await repo.createStore({ ownerEmail: OWNER });
    await pool.query('UPDATE vector_stores SET chunking = $2, embedding_dim = $3 WHERE id = $1', [store.id, JSON.stringify(chunking), DIM]);
    const files: string[] = [];
    for (const [i, content] of contents.entries()) {
      const bytes = Buffer.from(content, 'utf8');
      const sha = sha256Of(bytes);
      // eslint-disable-next-line no-await-in-loop
      await retainBlob(sha, bytes, 'text/markdown');
      const fileId = newFileId();
      // eslint-disable-next-line no-await-in-loop
      await pool.query(`INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at)
                        VALUES ($1, $2, $3, 'assistants', $4, $5, now())`, [fileId, OWNER, `f${i}.md`, sha, bytes.length]);
      files.push(fileId);
    }
    await createBatch(store.id, files, null, null, {});
    return { storeId: store.id, files };
  }

  it('four small texts cut small never hold more than the budget: the vectors are admitted with the text', async () => {
    const SMALL = { type: 'static', max_tokens: 100, overlap_tokens: 0, contextual: false };
    const { storeId, files } = await storeWithFiles(SMALL, ['a', 'b', 'c', 'd'].map((seed) => words(seed, 3000)));
    // One file: ~40 chunks × 4000 × 4 B ≈ 640 KB of vectors and ~110 KB of text; the budget admits two at a time.
    __memoryBudgetForTests.reset(1_600_000);
    const info = jest.spyOn(getDefaultLogger(), 'info');
    info.mockClear();
    await Promise.all(files.map((f) => processOne(storeId, f)));
    expect((await pool.query('SELECT status FROM vector_store_files WHERE store_id = $1', [storeId])).rows.map((r) => r.status))
      .toEqual(['completed', 'completed', 'completed', 'completed']);
    const overshoots = info.mock.calls.filter((c) => String(c[1]).includes('more memory than estimated')).map((c: any[]) => c[2].bytesOverEstimate);
    // Static chunks are what the estimate counts, give or take a rounding chunk: each file overshoots by
    // at most one chunk's vector, so the budget is exceeded by at most that per file held.
    for (const over of overshoots) expect(over).toBeLessThanOrEqual(DIM * 4);
    const maxUsed = Math.max(...samples.map((x) => x.used));
    const maxHolders = Math.max(...samples.map((x) => x.holders));
    expect(maxHolders).toBeLessThanOrEqual(2);
    expect(maxUsed).toBeLessThanOrEqual(1_600_000 + maxHolders * DIM * 4);
    expect(maxUsed).toBeGreaterThan(1_200_000); // two files at a time, vectors included
    expect(Math.max(...samples.map((x) => x.waiting))).toBeGreaterThan(0);
    expect(__memoryBudgetForTests.state()).toMatchObject({ used: 0, holders: 0, waiting: 0 });
  }, 60_000);

  it('a structure file with more chunks than estimated grows by the difference only, logged, and releases it all', async () => {
    const STRUCTURE = { type: 'structure', max_tokens: 200, overlap_tokens: 50, contextual: false };
    // 60 sections of ~120 tokens each: one chunk per section, where the estimate is one per 150 tokens.
    const doc = Array.from({ length: 60 }, (_, i) => `# Section ${i}\n\n${words(`s${i}w`, 90)}`).join('\n\n');
    const { storeId, files: [fileId] } = await storeWithFiles(STRUCTURE, [doc]);
    __memoryBudgetForTests.reset(null);
    const info = jest.spyOn(getDefaultLogger(), 'info');
    info.mockClear();
    await processOne(storeId, fileId);
    expect((await pool.query('SELECT status FROM vector_store_files WHERE file_id = $1', [fileId])).rows[0].status).toBe('completed');
    const chunks = Number((await pool.query('SELECT COUNT(*) AS n FROM vector_store_chunks WHERE file_id = $1', [fileId])).rows[0].n);
    const over = info.mock.calls.find((c) => String(c[1]).includes('more memory than estimated')) as any[] | undefined;
    expect(over).toBeDefined();
    expect(over![2].bytesOverEstimate % (DIM * 4)).toBe(0); // whole chunks' vectors
    expect(over![2].bytesOverEstimate).toBeLessThan(chunks * DIM * 4);
    expect(samples[0].used).toBeGreaterThanOrEqual(chunks * DIM * 4); // embedding ran under the real size
    expect(__memoryBudgetForTests.state()).toMatchObject({ used: 0, holders: 0 });
  }, 60_000);
});
