// Every timestamp on a vector store must come from the DATABASE clock.
//
// repository.ts argues at length (see RECOMPUTE_EXPIRES_AT_SQL) that every site
// touching `last_active_at` has to agree on its clock, because
// `expires_after.anchor = 'last_active_at'` slides the deadline forward from
// whatever that column says. attachFile, deleteStoreFile, touchStoreActivity
// and the expiry sweeper all use Postgres `now()`. createStore did not: it
// bound a JS `new Date()` for `created_at`, `last_active_at` AND the
// `expires_at` derived from it.
//
// Two consequences, both bounded by clock skew rather than impossible:
// `last_active_at` moves BACKWARDS the first time a store sees real activity,
// and `expires_at` jumps by the skew on that first touch because it was
// computed in JS at creation and in SQL forever after.
//
// This is not hypothetical. vectorStoresController.test.ts's `last_active_at`
// assertion failed whenever the Docker VM's clock drifted behind the host and
// passed when it drifted ahead. Note the trap that fooled two earlier readings
// of that failure: `RETURNING *` is NOT evidence of a server-generated value.
// It echoes back whatever was bound, so a JS Date looks server-side in the
// result. These tests compare against a clock read from Postgres itself.
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { sha256Of, retainBlob } from '../../../src/fileSearch/blob/blobStore';
import { newFileId } from '../../../src/fileSearch/ids';
import * as repo from '../../../src/fileSearch/repository';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const OWNER = 'clock@example.com';

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

d('store timestamp provenance (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;

  beforeAll(async () => {
    mockConfig = {
      enabled: true,
      embeddingModel: 'test-model',
      embeddingDimensions: EMBED_DIM,
      limits: { maxFilesPerStore: 10000 },
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
    await pool.query('DELETE FROM vector_store_chunks');
    await pool.query('DELETE FROM vector_store_files');
    await pool.query('DELETE FROM vector_stores');
    await pool.query('DELETE FROM fs_files');
    await pool.query('DELETE FROM file_blobs');
  });

  async function seedFile(filename: string): Promise<string> {
    const content = Buffer.from('x');
    const sha = sha256Of(content);
    await retainBlob(sha, content, 'text/plain');
    const id = newFileId();
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at)
       VALUES ($1,$2,$3,'assistants',$4,$5, now())`,
      [id, OWNER, filename, sha, content.length],
    );
    return id;
  }

  async function dbNow(): Promise<number> {
    const { rows } = await pool.query('SELECT clock_timestamp() AS t');
    return rows[0].t.getTime();
  }

  it('stamps created_at and last_active_at from the database clock', async () => {
    const before = await dbNow();
    const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
    const after = await dbNow();

    // A JS-bound value falls outside this window as soon as the two clocks
    // differ by more than the statement takes. With both bounds read from
    // Postgres, the window is real and tight.
    expect(store.last_active_at.getTime()).toBeGreaterThanOrEqual(before);
    expect(store.last_active_at.getTime()).toBeLessThanOrEqual(after);
    expect(store.created_at.getTime()).toBeGreaterThanOrEqual(before);
    expect(store.created_at.getTime()).toBeLessThanOrEqual(after);
  });

  it('derives expires_at from the same database clock, not a JS one', async () => {
    const before = await dbNow();
    const store = await repo.createStore({
      ownerEmail: OWNER, name: 's', expiresAfter: { anchor: 'last_active_at', days: 7 },
    });
    const after = await dbNow();

    expect(store.expires_at).not.toBeNull();
    expect(store.expires_at!.getTime()).toBeGreaterThanOrEqual(before + 7 * DAY_MS);
    expect(store.expires_at!.getTime()).toBeLessThanOrEqual(after + 7 * DAY_MS);
    // And it is anchored to this store's OWN last_active_at, exactly as every
    // later recomputation will be — the property RECOMPUTE_EXPIRES_AT_SQL
    // exists to preserve.
    expect(store.expires_at!.getTime() - store.last_active_at.getTime()).toBe(7 * DAY_MS);
  });

  it('leaves expires_at null when the store has no expires_after', async () => {
    const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
    expect(store.expires_at).toBeNull();
  });

  it('never moves last_active_at backwards on the store\'s first activity', async () => {
    const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
    await repo.attachFile(store.id, await seedFile('a.txt'), {}, null);

    const { rows } = await pool.query(
      'SELECT last_active_at FROM vector_stores WHERE id = $1', [store.id]);
    // attachFile sets last_active_at = now(). If creation used a JS clock that
    // ran ahead of the database's, this goes backwards.
    expect(rows[0].last_active_at.getTime()).toBeGreaterThanOrEqual(store.last_active_at.getTime());
  });

  it('stamps an attached file\'s created_at from the database clock too', async () => {
    // Not cosmetic: vector_store_files.created_at is the keyset pagination
    // cursor (both file-list endpoints order by created_at, file_id). Two
    // gateway replicas with skewed clocks would write rows whose stored order
    // disagrees with their true insertion order, and a cursor built from one
    // replica's value can then skip or repeat rows on the other's page.
    const store = await repo.createStore({ ownerEmail: OWNER, name: 's' });
    const before = await dbNow();
    const row = await repo.attachFile(store.id, await seedFile('c.txt'), {}, null);
    const after = await dbNow();

    expect(row.created_at.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.created_at.getTime()).toBeLessThanOrEqual(after);
  });

  it('slides expires_at forward, never backward, on that first activity', async () => {
    const store = await repo.createStore({
      ownerEmail: OWNER, name: 's', expiresAfter: { anchor: 'last_active_at', days: 3 },
    });
    await repo.attachFile(store.id, await seedFile('b.txt'), {}, null);

    const { rows } = await pool.query(
      'SELECT expires_at FROM vector_stores WHERE id = $1', [store.id]);
    // The jump this guards against is exactly the skew between the two clocks:
    // creation computed the deadline in JS, the recomputation in SQL, so it
    // shifted by their difference in whichever direction that lay.
    expect(rows[0].expires_at.getTime()).toBeGreaterThanOrEqual(store.expires_at!.getTime());
  });
});
