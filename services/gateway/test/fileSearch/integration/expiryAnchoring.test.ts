// Live-Postgres coverage of Task 12's headline defect fix, at each of its
// three call sites: `expires_after: {anchor: 'last_active_at', days: N}`
// must slide `expires_at` forward from the store's OWN `last_active_at`
// every time attach, detach, or a modify-with-expires_after touches it —
// not stay pinned at whatever it was computed from the first time.
//
// Each test below backdates a store's anchor (its `last_active_at` and/or
// `expires_at`) to simulate a store that has been idle, then exercises ONE
// specific call site and asserts `expires_at` moved forward to reflect
// that site's own anchor — a value that could only be produced by the
// fixed code, never by the reverted (pre-Task-12) behaviour at that same
// site:
//   - attachFile (repository.ts) previously touched ONLY last_active_at
//     and never recomputed expires_at at all — reverting it leaves
//     expires_at frozen at its stale pre-attach value.
//   - deleteStoreFile (repository.ts) had the identical defect.
//   - modifyVectorStore (vectorStoresController.ts) previously computed
//     expires_at from Date.now() rather than the store's OWN
//     last_active_at — reverting it produces a DIFFERENT (later, by
//     exactly however stale last_active_at was) expires_at than the fixed
//     code does, which this file's test distinguishes explicitly.
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { sha256Of, retainBlob } from '../../../src/fileSearch/blob/blobStore';
import { newFileId } from '../../../src/fileSearch/ids';
import * as repo from '../../../src/fileSearch/repository';
import * as ctrl from '../../../src/controllers/vectorStoresController';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

function makeRes(): any {
  const res: any = { headersSent: false, statusCode: 200 };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
}

function baseReq(email: string, overrides: Record<string, any> = {}): any {
  return { headers: {}, params: {}, query: {}, body: {}, apiKeyInfo: { email }, ...overrides };
}

const throwOnError = (e: any) => { throw e; };

d('expires_at anchoring against a real Postgres database (requires FILE_SEARCH_TEST_DSN)', () => {
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

  async function seedFile(ownerEmail: string, filename: string, content: Buffer): Promise<{ id: string }> {
    const sha = sha256Of(content);
    await retainBlob(sha, content, 'text/plain');
    const id = newFileId();
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at)
       VALUES ($1,$2,$3,'assistants',$4,$5, now())`,
      [id, ownerEmail, filename, sha, content.length],
    );
    return { id };
  }

  /** Backdates BOTH last_active_at and expires_at to simulate a store that
   *  has been idle for `daysAgo` days, anchored consistently (expires_at =
   *  last_active_at + the store's own expires_after.days) so the "before"
   *  state is itself a value the fixed formula could plausibly have
   *  produced — the test is about whether it moves forward, not about an
   *  already-inconsistent starting point. */
  async function backdateAnchor(storeId: string, daysAgo: number, expiresAfterDays: number): Promise<Date> {
    const staleLastActive = new Date(Date.now() - daysAgo * DAY_MS);
    const staleExpiresAt = new Date(staleLastActive.getTime() + expiresAfterDays * DAY_MS);
    await pool.query(
      'UPDATE vector_stores SET last_active_at = $2, expires_at = $3 WHERE id = $1',
      [storeId, staleLastActive, staleExpiresAt],
    );
    return staleLastActive;
  }

  // ---------------------------------------------------------------------
  // attachFile
  // ---------------------------------------------------------------------
  it('attachFile slides expires_at forward from a fresh last_active_at, not merely touching last_active_at while leaving expires_at stale', async () => {
    const owner = 'anchor-attach@example.com';
    const days = 30;
    const store = await repo.createStore({ ownerEmail: owner, name: 's', expiresAfter: { anchor: 'last_active_at', days } });
    const staleLastActive = await backdateAnchor(store.id, 20, days); // idle 20 of its 30 days
    const file = await seedFile(owner, 'f.txt', Buffer.from('x'));

    await repo.attachFile(store.id, file.id, {});

    const { rows } = await pool.query('SELECT expires_at, last_active_at FROM vector_stores WHERE id=$1', [store.id]);
    const newExpiresAt = rows[0].expires_at.getTime();
    const newLastActive = rows[0].last_active_at.getTime();

    // The reverted (pre-fix) behaviour never touches expires_at during
    // attach at all, so it would still read staleLastActive + days —
    // roughly `days - 20` days from now. The fix anchors to a FRESH
    // last_active_at, so the new expires_at must be close to now + days,
    // well past that stale value.
    const staleFormulaResult = staleLastActive.getTime() + days * DAY_MS;
    expect(newExpiresAt).toBeGreaterThan(staleFormulaResult + DAY_MS); // clearly moved, not a rounding artifact
    expect(newExpiresAt).toBeGreaterThan(Date.now() + (days - 1) * DAY_MS);
    expect(newExpiresAt).toBeLessThan(Date.now() + (days + 1) * DAY_MS);
    // And expires_at is anchored to the SAME last_active_at this call set.
    expect(newExpiresAt).toBeCloseTo(newLastActive + days * DAY_MS, -4);
  });

  // ---------------------------------------------------------------------
  // deleteStoreFile
  // ---------------------------------------------------------------------
  it('deleteStoreFile slides expires_at forward from a fresh last_active_at', async () => {
    const owner = 'anchor-detach@example.com';
    const days = 14;
    const store = await repo.createStore({ ownerEmail: owner, name: 's', expiresAfter: { anchor: 'last_active_at', days } });
    const file = await seedFile(owner, 'f.txt', Buffer.from('x'));
    await repo.attachFile(store.id, file.id, {}); // this itself already slides it — backdate AFTER

    const staleLastActive = await backdateAnchor(store.id, 10, days);

    await repo.deleteStoreFile(store.id, file.id, owner);

    const { rows } = await pool.query('SELECT expires_at, last_active_at FROM vector_stores WHERE id=$1', [store.id]);
    const newExpiresAt = rows[0].expires_at.getTime();
    const newLastActive = rows[0].last_active_at.getTime();

    const staleFormulaResult = staleLastActive.getTime() + days * DAY_MS;
    expect(newExpiresAt).toBeGreaterThan(staleFormulaResult + DAY_MS);
    expect(newExpiresAt).toBeGreaterThan(Date.now() + (days - 1) * DAY_MS);
    expect(newExpiresAt).toBeLessThan(Date.now() + (days + 1) * DAY_MS);
    expect(newExpiresAt).toBeCloseTo(newLastActive + days * DAY_MS, -4);
  });

  // ---------------------------------------------------------------------
  // modifyVectorStore — distinguishes "anchored to last_active_at" from
  // "anchored to Date.now()" explicitly, since both would otherwise look
  // similar for a store modified right after creation.
  // ---------------------------------------------------------------------
  it("modifyVectorStore's new expires_after anchors to the store's OWN (stale) last_active_at, not to Date.now()", async () => {
    const owner = 'anchor-modify@example.com';
    const store = await repo.createStore({ ownerEmail: owner, name: 's' }); // no expires_after yet
    const staleLastActive = new Date(Date.now() - 10 * DAY_MS);
    await pool.query('UPDATE vector_stores SET last_active_at = $2 WHERE id = $1', [store.id, staleLastActive]);

    const newDays = 5;
    const res = makeRes();
    await ctrl.modifyVectorStore(
      baseReq(owner, { params: { id: store.id }, body: { expires_after: { anchor: 'last_active_at', days: newDays } } }),
      res, throwOnError,
    );
    expect(res.statusCode).toBe(200);

    const { rows } = await pool.query('SELECT expires_at, last_active_at FROM vector_stores WHERE id=$1', [store.id]);
    const newExpiresAt = rows[0].expires_at.getTime();

    // Fixed formula: last_active_at (10 days ago) + 5 days = 5 days AGO —
    // already in the past. Reverted (Date.now()-based) formula: now + 5
    // days — 5 days in the FUTURE. These differ by exactly ~10 days and
    // land on opposite sides of "now", so this is unambiguous either way.
    const fixedFormulaResult = staleLastActive.getTime() + newDays * DAY_MS;
    expect(newExpiresAt).toBeCloseTo(fixedFormulaResult, -4);
    expect(newExpiresAt).toBeLessThan(Date.now()); // already expired — proves it did NOT anchor to now()

    // And last_active_at itself was NOT touched by modify (a metadata/policy
    // edit is not "activity" per the design spec's explicit list — only
    // search, attach and detach are).
    expect(rows[0].last_active_at.getTime()).toBe(staleLastActive.getTime());
  });
});
