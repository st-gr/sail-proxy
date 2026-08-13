// Task 1 of the file_search follow-ups: `file_search.ingestion.max_retries: 0`
// silently disabled ingestion outright.
//
// Reproduced live before this fix existed (see the task's report): with
// max_retries=0, `reapZombies` (ingestWorker.ts) fires on `attempts >= 0 AND
// claimed_at IS NULL`, which matches every freshly attached row, while
// `claimNext`'s own `attempts < 0` then matches none — three attached files,
// zero extractText/embed calls, all three rows `failed` with
// `last_error.name` `'MaxRetriesExceededZombie'`, and the batch itself
// reporting `completed`. An SDK `createAndPoll` would return *successfully*
// over a store with zero content.
//
// Two levels of coverage, deliberately: `resolveMaxRetries` on its own only
// proves the resolver's math, not that the ingest worker is actually safe —
// that requires driving `claimNext()` against real Postgres through the real
// (unmocked) config-resolution path, which is what the second describe block
// below does.
import { Pool } from 'pg';
import { getDefaultLogger } from '@libs/logger';
import * as configService from '../../src/services/configService';
import { resolveMaxRetries, FILE_SEARCH_DEFAULTS } from '../../src/services/configService';
import { getPool, runMigration, __resetForTests } from '../../src/fileSearch/db';
import { sha256Of, retainBlob } from '../../src/fileSearch/blob/blobStore';
import { newFileId } from '../../src/fileSearch/ids';
import * as repo from '../../src/fileSearch/repository';
import { claimNext } from '../../src/fileSearch/ingestWorker';
import { createIsolatedSchema, IsolatedSchema } from './integration/schemaFixture';

const logger = getDefaultLogger();

describe('resolveMaxRetries', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('passes a sane value through untouched and says nothing', () => {
    const warn = jest.spyOn(logger, 'warn');
    for (const v of [1, 3, 10]) expect(resolveMaxRetries(v)).toBe(v);
    expect(warn).not.toHaveBeenCalled();
  });

  it('clamps 0 to 1 — "no retries" must still mean one attempt — and warns exactly once for repeats', () => {
    const warn = jest.spyOn(logger, 'warn');
    expect(resolveMaxRetries(0)).toBe(1);
    expect(resolveMaxRetries(0)).toBe(1);
    expect(resolveMaxRetries(0)).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][1]);
    expect(message).toContain('max_retries');
    expect(message).toMatch(/clamp/i);
  });

  // Runs after the test above, which already warned once for the value `0` —
  // deliberately exercising the "changed to a *different* offending value"
  // branch of the once-per-distinct-value guard (see resolveMaxConcurrentWrites
  // and resolveMaxSearchesPerRequest, which this resolver's warn-once shape
  // follows), the same way test/fileSearch/teacherLoggingConfig.test.ts's
  // sibling suite for resolveMaxConcurrentWrites does.
  it('warns again when the offending value changes to a different one', () => {
    const warn = jest.spyOn(logger, 'warn');
    expect(resolveMaxRetries(-5)).toBe(FILE_SEARCH_DEFAULTS.ingestion.maxRetries);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('falls back to the default for a non-integer, negative or non-numeric value', () => {
    for (const bad of [-1, 2.5, 'three', null, undefined, NaN]) {
      expect(resolveMaxRetries(bad as any)).toBe(FILE_SEARCH_DEFAULTS.ingestion.maxRetries);
    }
  });
});

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

d('ingestion.max_retries=0 against a real ingest worker (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;

  beforeAll(async () => {
    fixture = await createIsolatedSchema(DSN!, FILE_SEARCH_DEFAULTS.embeddingDimensions);
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

  // jest.config.json sets `restoreMocks: true`, which restores every spy
  // before each test — including ones set up in `beforeAll` — so this has to
  // be (re-)established per test, not once for the whole suite.
  //
  // Stubs only `getConfig` (the disk/admin-service read `getFileSearchConfig`
  // itself calls internally), never `getFileSearchConfig`. That leaves the
  // real resolution path — including the real `resolveMaxRetries` clamp this
  // task adds — in the loop for every `getFileSearchConfig()`/`claimNext()`
  // call below, which is the whole point: a mock of `getFileSearchConfig`
  // itself would prove nothing about whether the fix is actually wired in.
  beforeEach(() => {
    jest.spyOn(configService, 'getConfig').mockReturnValue({
      api_config: { file_search: { ingestion: { max_retries: 0 } } },
    } as any);
  });

  it('resolves the configured 0 through to a clamped 1, not the raw value', () => {
    // Sanity check that the stub above is actually reaching the real
    // resolver before trusting the claimNext() behaviour below.
    expect(configService.getFileSearchConfig().ingestion.maxRetries).toBe(1);
  });

  it('still claims a fresh file when max_retries is configured to 0', async () => {
    const store = await repo.createStore({ ownerEmail: 'task1@x.com' });
    const content = Buffer.from('lorem ipsum dolor sit amet '.repeat(50));
    const sha = sha256Of(content);
    await retainBlob(sha, content, 'text/plain');
    const fileId = newFileId();
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at)
       VALUES ($1,$2,'doc.txt','assistants',$3,$4, now())`,
      [fileId, 'task1@x.com', sha, content.length],
    );
    await repo.attachFile(store.id, fileId, null);

    // Before the fix: reapZombies (attempts >= 0 AND claimed_at IS NULL)
    // reaped this row to `failed` on the very first line of claimNext(), and
    // claimNext's own claim query (attempts < 0) could never match anything —
    // this call returned null and the row was already terminal.
    const claimed = await claimNext();
    expect(claimed).not.toBeNull();
    expect(claimed).toEqual({ storeId: store.id, fileId });

    const { rows } = await pool.query(
      'SELECT status, attempts FROM vector_store_files WHERE store_id=$1 AND file_id=$2',
      [store.id, fileId],
    );
    expect(rows[0].status).toBe('in_progress');
    expect(rows[0].attempts).toBe(1);
  });
});
