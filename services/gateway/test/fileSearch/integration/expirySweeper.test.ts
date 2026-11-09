// Live-Postgres coverage of the expiry sweeper for the properties that
// cannot be demonstrated against a mock: that it genuinely deletes chunks
// and vector_store_files rows for a past-deadline store while leaving
// fs_files and blob bytes completely untouched (the corrected scope — see
// expirySweeper.ts's own doc comment on why this must NOT run the deletion
// cascade's refcount logic), that it leaves a not-yet-expired store alone,
// and that its FOR UPDATE re-check reads live data rather than the stale
// candidate list from the initial scan (the mechanism that keeps a store
// whose activity was just touched from being expired out from under a
// caller who just used it).
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { sha256Of, retainBlob } from '../../../src/fileSearch/blob/blobStore';
import { newFileId } from '../../../src/fileSearch/ids';
import * as repo from '../../../src/fileSearch/repository';
import { sweepExpiredStores } from '../../../src/fileSearch/expirySweeper';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

d('expirySweeper against a real Postgres database (requires FILE_SEARCH_TEST_DSN)', () => {
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

  async function seedFile(ownerEmail: string, filename: string, content: Buffer): Promise<{ id: string; sha: string }> {
    const sha = sha256Of(content);
    await retainBlob(sha, content, 'text/plain');
    const id = newFileId();
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at)
       VALUES ($1,$2,$3,'assistants',$4,$5, now())`,
      [id, ownerEmail, filename, sha, content.length],
    );
    return { id, sha };
  }

  async function seedChunk(storeId: string, fileId: string, ord: number, text: string): Promise<void> {
    const embedding = `[${Array.from({ length: EMBED_DIM }, () => Math.random()).join(',')}]`;
    await pool.query(
      `INSERT INTO vector_store_chunks (store_id, file_id, ord, text, embedding) VALUES ($1,$2,$3,$4,$5::vector)`,
      [storeId, fileId, ord, text, embedding],
    );
  }

  /** Directly backdates a store's expires_at/status, bypassing the app-level
   *  anchoring logic under test — this file is testing the sweeper, not how
   *  a deadline was originally computed. */
  async function backdateExpiry(storeId: string, msAgo: number): Promise<void> {
    await pool.query(`UPDATE vector_stores SET expires_at = now() - ($2 * interval '1 millisecond') WHERE id = $1`, [storeId, msAgo]);
  }

  it('expires a past-deadline store: deletes its chunks and vector_store_files rows, sets status, but never touches fs_files or blob bytes', async () => {
    const owner = 'sweep-owner@example.com';
    const file = await seedFile(owner, 'doc.txt', Buffer.from('some content'));
    const store = await repo.createStore({ ownerEmail: owner, name: 's', expiresAfter: { anchor: 'last_active_at', days: 1 } });
    await repo.attachFile(store.id, file.id, {});
    await seedChunk(store.id, file.id, 0, 'chunk text');
    await backdateExpiry(store.id, 60_000); // 1 minute in the past

    const swept = await sweepExpiredStores();
    expect(swept).toBe(1);

    const { rows: storeRows } = await pool.query('SELECT status FROM vector_stores WHERE id=$1', [store.id]);
    expect(storeRows).toHaveLength(1); // the row itself survives
    expect(storeRows[0].status).toBe('expired');

    const { rows: chunkRows } = await pool.query('SELECT 1 FROM vector_store_chunks WHERE store_id=$1', [store.id]);
    expect(chunkRows).toHaveLength(0);
    const { rows: vsfRows } = await pool.query('SELECT 1 FROM vector_store_files WHERE store_id=$1', [store.id]);
    expect(vsfRows).toHaveLength(0);

    // Never touched — files persist independently of vector-store expiry,
    // exactly as they do across a detach or a store delete.
    const { rows: fsFileRows } = await pool.query('SELECT 1 FROM fs_files WHERE id=$1', [file.id]);
    expect(fsFileRows).toHaveLength(1);
    const { rows: blobRows } = await pool.query('SELECT ref_count, bytes FROM file_blobs WHERE sha256=$1', [file.sha]);
    expect(blobRows[0].ref_count).toBe(1);
    expect(blobRows[0].bytes).not.toBeNull();
  });

  it('leaves a store whose deadline has not passed completely untouched', async () => {
    const owner = 'sweep-not-yet@example.com';
    const file = await seedFile(owner, 'doc.txt', Buffer.from('some content'));
    const store = await repo.createStore({ ownerEmail: owner, name: 's', expiresAfter: { anchor: 'last_active_at', days: 30 } });
    await repo.attachFile(store.id, file.id, {});
    await seedChunk(store.id, file.id, 0, 'chunk text');

    const swept = await sweepExpiredStores();
    expect(swept).toBe(0);

    const { rows: storeRows } = await pool.query('SELECT status FROM vector_stores WHERE id=$1', [store.id]);
    expect(storeRows[0].status).not.toBe('expired');
    const { rows: chunkRows } = await pool.query('SELECT 1 FROM vector_store_chunks WHERE store_id=$1', [store.id]);
    expect(chunkRows).toHaveLength(1);
  });

  it('a store with no expires_after (expires_at NULL) is never swept', async () => {
    const owner = 'sweep-no-expiry@example.com';
    const store = await repo.createStore({ ownerEmail: owner, name: 's' }); // no expiresAfter
    const { rows: before } = await pool.query('SELECT expires_at FROM vector_stores WHERE id=$1', [store.id]);
    expect(before[0].expires_at).toBeNull();

    const swept = await sweepExpiredStores();
    expect(swept).toBe(0);
    const { rows: after } = await pool.query('SELECT status FROM vector_stores WHERE id=$1', [store.id]);
    expect(after[0].status).not.toBe('expired');
  });

  it('does not re-expire an already-expired store on a second sweep (idempotent)', async () => {
    const owner = 'sweep-twice@example.com';
    const store = await repo.createStore({ ownerEmail: owner, name: 's', expiresAfter: { anchor: 'last_active_at', days: 1 } });
    await backdateExpiry(store.id, 60_000);

    expect(await sweepExpiredStores()).toBe(1);
    expect(await sweepExpiredStores()).toBe(0); // status != 'expired' guard excludes it the second time
  });

  // -------------------------------------------------------------------
  // NOTE ON THIS TEST'S OWN HISTORY (Task 12 review, I2): an earlier version
  // of this test called touchStoreActivity BEFORE invoking
  // sweepExpiredStores() at all. That only proves the CANDIDATE SCAN's own
  // `WHERE expires_at < now()` (expirySweeper.ts's line ~100) correctly
  // excludes an already-active store — it never reaches, and so never
  // defends, the per-store `FOR UPDATE ... AND expires_at < now() AND
  // status != 'expired'` RE-CHECK inside sweepOneStore (line ~64). Proof:
  // dropping that entire AND clause from the re-check left the old test
  // green, because the store was never a "candidate" in the first place —
  // the same "passes by coincidence" shape that produced three defects in
  // Tasks 9-11. This test constructs the race genuinely, via
  // sweepExpiredStores's onBeforeStoreForTests hook (mirroring
  // ingestWorker.ts's commitChunks test-only hooks for the identical class
  // of problem): the store IS present in the initial candidate scan, and
  // only becomes active again in the window between that scan and its own
  // per-store transaction.
  // -------------------------------------------------------------------
  it('the CANDIDATE SCAN excludes a store whose activity was touched before the sweep ever ran', async () => {
    const owner = 'sweep-race-scan@example.com';
    const store = await repo.createStore({ ownerEmail: owner, name: 's', expiresAfter: { anchor: 'last_active_at', days: 1 } });
    await backdateExpiry(store.id, 60_000); // would be a sweep candidate...

    // ...except activity lands BEFORE sweepExpiredStores is even called, so
    // it is excluded at the initial scan and the per-store re-check is
    // never reached for it at all.
    await repo.touchStoreActivity([store.id]);

    const swept = await sweepExpiredStores();
    expect(swept).toBe(0);
    const { rows } = await pool.query('SELECT status, expires_at FROM vector_stores WHERE id=$1', [store.id]);
    expect(rows[0].status).not.toBe('expired');
    expect(rows[0].expires_at.getTime()).toBeGreaterThan(Date.now());
  });

  it("the per-store FOR UPDATE RE-CHECK is genuinely load-bearing: a store already IN the candidate scan that becomes active again before its own turn is skipped, not expired", async () => {
    const owner = 'sweep-race-recheck@example.com';
    // A is backdated further, so ORDER BY expires_at ASC processes it
    // first — the hook fires for A first, then for B, giving a
    // deterministic window to touch B's activity strictly AFTER the
    // candidate scan already captured it as expired, but strictly BEFORE
    // B's own per-store transaction runs.
    const storeA = await repo.createStore({ ownerEmail: owner, name: 'a', expiresAfter: { anchor: 'last_active_at', days: 1 } });
    const storeB = await repo.createStore({ ownerEmail: owner, name: 'b', expiresAfter: { anchor: 'last_active_at', days: 1 } });
    await backdateExpiry(storeA.id, 120_000);
    await backdateExpiry(storeB.id, 60_000);

    let hookFiredForB = false;
    const swept = await sweepExpiredStores(async (storeId) => {
      if (storeId === storeB.id) {
        hookFiredForB = true;
        // storeB is ALREADY in `candidates` (the scan ran before this hook
        // ever fires) — this simulates a concurrent search/attach/detach
        // landing on it between that scan and its own turn in the loop.
        await repo.touchStoreActivity([storeB.id]);
      }
    });

    expect(hookFiredForB).toBe(true);
    expect(swept).toBe(1); // only A

    const { rows } = await pool.query(
      'SELECT id, status, expires_at FROM vector_stores WHERE id = ANY($1)', [[storeA.id, storeB.id]],
    );
    const byId = new Map(rows.map((r: any) => [r.id, r]));
    expect(byId.get(storeA.id).status).toBe('expired');
    expect(byId.get(storeB.id).status).not.toBe('expired');
    expect(byId.get(storeB.id).expires_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('sweeps multiple expired stores independently, leaving an unrelated non-expired store alone', async () => {
    const owner = 'sweep-multi@example.com';
    const expiredA = await repo.createStore({ ownerEmail: owner, name: 'a', expiresAfter: { anchor: 'last_active_at', days: 1 } });
    const expiredB = await repo.createStore({ ownerEmail: owner, name: 'b', expiresAfter: { anchor: 'last_active_at', days: 1 } });
    const stillActive = await repo.createStore({ ownerEmail: owner, name: 'c', expiresAfter: { anchor: 'last_active_at', days: 30 } });
    await backdateExpiry(expiredA.id, 60_000);
    await backdateExpiry(expiredB.id, 60_000);

    const swept = await sweepExpiredStores();
    expect(swept).toBe(2);

    const { rows } = await pool.query(
      'SELECT id, status FROM vector_stores WHERE id = ANY($1) ORDER BY id',
      [[expiredA.id, expiredB.id, stillActive.id]],
    );
    const statusById = new Map(rows.map((r: any) => [r.id, r.status]));
    expect(statusById.get(expiredA.id)).toBe('expired');
    expect(statusById.get(expiredB.id)).toBe('expired');
    expect(statusById.get(stillActive.id)).not.toBe('expired');
  });
});
