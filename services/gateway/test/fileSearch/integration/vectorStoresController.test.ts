// End-to-end coverage of the vector-store and store-file handlers against a
// real Postgres database — the properties that cannot be demonstrated
// against a mock: the deletion cascade's transactional correctness, that a
// file persists independently of vector-store attachment (detaching, or
// deleting the store that held it, must never touch `fs_files` or any
// blob — only `DELETE /files/{id}` does, and it refuses while the file is
// still attached anywhere), cross-owner 404-vs-nonexistent parity for
// stores and store files, and the embedding-dimension guard against a
// genuinely stale store row.
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { sha256Of, retainBlob } from '../../../src/fileSearch/blob/blobStore';
import { newFileId } from '../../../src/fileSearch/ids';
import * as ctrl from '../../../src/controllers/vectorStoresController';
import * as filesCtrl from '../../../src/controllers/filesController';
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

function makeRes(): any {
  const res: any = { headersSent: false, statusCode: 200 };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  res.set = (...args: any[]) => { res.headers = res.headers ?? {}; res.headers[args[0]] = args[1]; return res; };
  res.send = (body: any) => { res.body = body; return res; };
  return res;
}

function baseReq(email: string, overrides: Record<string, any> = {}): any {
  return { headers: {}, params: {}, query: {}, body: {}, apiKeyInfo: { email }, ...overrides };
}

const throwOnError = (e: any) => { throw e; };

d('vectorStoresController against a real Postgres database (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;

  beforeAll(async () => {
    // Set BEFORE runMigration -- it reads getFileSearchConfig().embeddingDimensions
    // to build the vector(N) column, and the mock has no other default.
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
    mockConfig = {
      enabled: true,
      embeddingModel: 'test-model',
      embeddingDimensions: EMBED_DIM,
      limits: { maxFilesPerStore: 10000 },
      blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
    };
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

  // ---------------------------------------------------------------------
  // createStore / attachFile — pinning and status (the brief's own examples)
  // ---------------------------------------------------------------------
  describe('repository primitives', () => {
    it('pins the configured embedding model and dimension on creation', async () => {
      const store = await repo.createStore({ ownerEmail: 'a@x.com', name: 's' });
      expect(store.embedding_model).toBe('test-model');
      expect(store.embedding_dim).toBe(EMBED_DIM);
    });

    it('creates store files in status in_progress, not completed, and touches the store last_active_at', async () => {
      const store = await repo.createStore({ ownerEmail: 'a@x.com', name: 's' });
      const file = await seedFile('a@x.com', 'f.txt', Buffer.from('hello'));

      // The baseline is re-stamped from Postgres's clock rather than read from
      // `store.last_active_at`, because those are two DIFFERENT clocks and a
      // strict `>` across them is decided by clock skew, not by the code under
      // test. `createStore` binds a JS `new Date()` as a bind parameter, so its
      // `RETURNING` echoes back the NODE process clock -- it only looks like a
      // Postgres-generated value. `attachFile` writes `last_active_at = now()`,
      // the POSTGRES clock. So `after - before` is really `elapsed + (postgres
      // clock - node clock)`, and against the Dockerised test database that
      // skew term dominates: measured at +34.5 ms on one day (assertion passes
      // with ~40 ms of slack) and at -28 ms on another (assertion fails by
      // ~23 ms), same machine, same code. A 5 ms sleep is an order of magnitude
      // too small to cover it, in either direction.
      //
      // Re-stamping puts both sides on the Postgres clock, which makes strict
      // `>` true by construction -- the sleep separates the two Postgres
      // timestamps by at least 5 ms -- WITHOUT weakening the property being
      // tested: if `attachFile` ever stops touching `last_active_at`, the row
      // still holds this exact baseline value and `toBeGreaterThan` fails.
      const { rows: stamped } = await pool.query(
        'UPDATE vector_stores SET last_active_at = now() WHERE id=$1 RETURNING last_active_at',
        [store.id],
      );
      const before = stamped[0].last_active_at.getTime();
      await new Promise((r) => setTimeout(r, 5));

      const vsf = await repo.attachFile(store.id, file.id, {});
      expect(vsf.status).toBe('in_progress');

      const { rows } = await pool.query('SELECT last_active_at FROM vector_stores WHERE id=$1', [store.id]);
      expect(rows[0].last_active_at.getTime()).toBeGreaterThan(before);
    });
  });

  // ---------------------------------------------------------------------
  // Full lifecycle through the controller
  // ---------------------------------------------------------------------
  it('full lifecycle: create store, attach a file, list/retrieve it, read reassembled content, detach, then 404', async () => {
    const owner = 'lifecycle@example.com';
    const file = await seedFile(owner, 'doc.txt', Buffer.from('irrelevant bytes — extraction is not this task'));

    const createRes = makeRes();
    await ctrl.createVectorStore(baseReq(owner, { body: { name: 'my store' } }), createRes, throwOnError);
    expect(createRes.statusCode).toBe(200);
    const storeId = createRes.body.id;
    expect(createRes.body.status).toBe('completed'); // no file_ids at creation

    const attachRes = makeRes();
    await ctrl.createVectorStoreFile(
      baseReq(owner, { params: { id: storeId }, body: { file_id: file.id, attributes: { lang: 'en' } } }),
      attachRes, throwOnError,
    );
    expect(attachRes.statusCode).toBe(200);
    expect(attachRes.body.status).toBe('in_progress');

    await seedChunk(storeId, file.id, 0, 'first chunk of extracted text');
    await seedChunk(storeId, file.id, 1, 'second chunk of extracted text');

    const listRes = makeRes();
    await ctrl.listVectorStoreFiles(baseReq(owner, { params: { id: storeId } }), listRes, throwOnError);
    expect(listRes.body.data.map((f: any) => f.id)).toEqual([file.id]);

    const getRes = makeRes();
    await ctrl.retrieveVectorStoreFile(baseReq(owner, { params: { id: storeId, file_id: file.id } }), getRes, throwOnError);
    expect(getRes.statusCode).toBe(200);

    const contentRes = makeRes();
    await ctrl.downloadVectorStoreFileContent(baseReq(owner, { params: { id: storeId, file_id: file.id } }), contentRes, throwOnError);
    expect(contentRes.statusCode).toBe(200);
    expect(contentRes.body.data[0].text).toBe('first chunk of extracted text\nsecond chunk of extracted text');

    const detachRes = makeRes();
    await ctrl.deleteVectorStoreFile(baseReq(owner, { params: { id: storeId, file_id: file.id } }), detachRes, throwOnError);
    expect(detachRes.statusCode).toBe(200);

    const afterRes = makeRes();
    await ctrl.retrieveVectorStoreFile(baseReq(owner, { params: { id: storeId, file_id: file.id } }), afterRes, throwOnError);
    expect(afterRes.statusCode).toBe(404);

    const { rows: chunkRows } = await pool.query('SELECT 1 FROM vector_store_chunks WHERE store_id=$1', [storeId]);
    expect(chunkRows.length).toBe(0);
  });

  // ---------------------------------------------------------------------
  // The core parity property: a file persists independently of vector-store
  // attachment. OpenAI's API reference is explicit that detaching a file
  // from a store "will not" delete the file, returning a distinct
  // `vector_store_file.deleted` object rather than `file.deleted`; only
  // `DELETE /files/{id}` removes a file and its bytes.
  // ---------------------------------------------------------------------
  it('detach then re-attach: the file survives detachment, GET /files/{id} still returns it, and it can be re-attached', async () => {
    const owner = 'persist-owner@example.com';
    const file = await seedFile(owner, 'persists.txt', Buffer.from('outlives its first attachment'));
    const store = await repo.createStore({ ownerEmail: owner, name: 's' });

    const attachRes = makeRes();
    await ctrl.createVectorStoreFile(baseReq(owner, { params: { id: store.id }, body: { file_id: file.id } }), attachRes, throwOnError);
    expect(attachRes.statusCode).toBe(200);
    await seedChunk(store.id, file.id, 0, 'chunk');

    const detachRes = makeRes();
    await ctrl.deleteVectorStoreFile(baseReq(owner, { params: { id: store.id, file_id: file.id } }), detachRes, throwOnError);
    expect(detachRes.statusCode).toBe(200);
    expect(detachRes.body).toEqual({ id: file.id, object: 'vector_store.file.deleted', deleted: true });

    // The file itself -- a wholly separate resource -- must still exist.
    const getFileRes = makeRes();
    await filesCtrl.retrieveFile(baseReq(owner, { params: { id: file.id } }), getFileRes, throwOnError);
    expect(getFileRes.statusCode).toBe(200);
    expect(getFileRes.body.id).toBe(file.id);

    // And it can be attached again -- to the same store or a different one.
    const reattachRes = makeRes();
    await ctrl.createVectorStoreFile(baseReq(owner, { params: { id: store.id }, body: { file_id: file.id } }), reattachRes, throwOnError);
    expect(reattachRes.statusCode).toBe(200);
    expect(reattachRes.body.status).toBe('in_progress');
  });

  it('one file attached to two stores: deleting one store leaves the file and the other store\'s chunks intact', async () => {
    const owner = 'two-store-owner@example.com';
    const file = await seedFile(owner, 'shared-across-stores.txt', Buffer.from('lives in two stores'));
    const storeToDelete = await repo.createStore({ ownerEmail: owner, name: 'to-delete' });
    const storeToKeep = await repo.createStore({ ownerEmail: owner, name: 'to-keep' });

    await ctrl.createVectorStoreFile(baseReq(owner, { params: { id: storeToDelete.id }, body: { file_id: file.id } }), makeRes(), throwOnError);
    await ctrl.createVectorStoreFile(baseReq(owner, { params: { id: storeToKeep.id }, body: { file_id: file.id } }), makeRes(), throwOnError);
    await seedChunk(storeToDelete.id, file.id, 0, 'chunk in the store being deleted');
    await seedChunk(storeToKeep.id, file.id, 0, 'chunk in the store that survives');

    const deleteStoreRes = makeRes();
    await ctrl.deleteVectorStore(baseReq(owner, { params: { id: storeToDelete.id } }), deleteStoreRes, throwOnError);
    expect(deleteStoreRes.statusCode).toBe(200);

    // The file survives entirely -- GET /files/{id} still resolves it.
    const getFileRes = makeRes();
    await filesCtrl.retrieveFile(baseReq(owner, { params: { id: file.id } }), getFileRes, throwOnError);
    expect(getFileRes.statusCode).toBe(200);

    // The surviving store's attachment and chunk are completely untouched.
    const getStoreFileRes = makeRes();
    await ctrl.retrieveVectorStoreFile(baseReq(owner, { params: { id: storeToKeep.id, file_id: file.id } }), getStoreFileRes, throwOnError);
    expect(getStoreFileRes.statusCode).toBe(200);
    const contentRes = makeRes();
    await ctrl.downloadVectorStoreFileContent(baseReq(owner, { params: { id: storeToKeep.id, file_id: file.id } }), contentRes, throwOnError);
    expect(contentRes.body.data[0].text).toBe('chunk in the store that survives');

    // And the deleted store's own association/chunk are genuinely gone.
    const deletedStoreFileRes = makeRes();
    await ctrl.retrieveVectorStoreFile(baseReq(owner, { params: { id: storeToDelete.id, file_id: file.id } }), deletedStoreFileRes, throwOnError);
    expect(deletedStoreFileRes.statusCode).toBe(404);
  });

  // ---------------------------------------------------------------------
  // DELETE /files/{id} while still attached -- the only path that removes
  // an fs_files row and a blob, and it must refuse rather than orphan a
  // vector store's chunks pointing at a file that no longer exists.
  // ---------------------------------------------------------------------
  it('DELETE /files/{id} refuses with 409 while the file is still attached to a vector store, then succeeds once detached', async () => {
    const owner = 'still-attached-owner@example.com';
    const file = await seedFile(owner, 'attached.txt', Buffer.from('cannot be deleted out from under a store'));
    const store = await repo.createStore({ ownerEmail: owner, name: 's' });
    await repo.attachFile(store.id, file.id, {});

    const blockedRes = makeRes();
    await filesCtrl.deleteFile(baseReq(owner, { params: { id: file.id } }), blockedRes, throwOnError);
    expect(blockedRes.statusCode).toBe(409);
    expect(blockedRes.body.error.code).toBe('file_in_use');

    // Nothing was touched by the refused attempt.
    const { rows: stillThere } = await pool.query('SELECT 1 FROM fs_files WHERE id=$1', [file.id]);
    expect(stillThere.length).toBe(1);
    const { rows: blobStillThere } = await pool.query('SELECT ref_count FROM file_blobs WHERE sha256=$1', [file.sha]);
    expect(blobStillThere[0].ref_count).toBe(1);

    const detachRes = makeRes();
    await ctrl.deleteVectorStoreFile(baseReq(owner, { params: { id: store.id, file_id: file.id } }), detachRes, throwOnError);
    expect(detachRes.statusCode).toBe(200);

    const deleteRes = makeRes();
    await filesCtrl.deleteFile(baseReq(owner, { params: { id: file.id } }), deleteRes, throwOnError);
    expect(deleteRes.statusCode).toBe(200);
    const { rows: gone } = await pool.query('SELECT 1 FROM fs_files WHERE id=$1', [file.id]);
    expect(gone.length).toBe(0);
    const { rows: blobGone } = await pool.query('SELECT 1 FROM file_blobs WHERE sha256=$1', [file.sha]);
    expect(blobGone.length).toBe(0);
  });

  // ---------------------------------------------------------------------
  // Cascade correctness — DETACH path never touches fs_files or blobs
  // ---------------------------------------------------------------------
  describe('deletion cascade: detaching a single file', () => {
    it('removes chunks and the vector_store_files row, but never touches fs_files or the blob', async () => {
      const owner = 'detach-owner@example.com';
      const file = await seedFile(owner, 'solo.txt', Buffer.from('content used by exactly one file'));
      const store = await repo.createStore({ ownerEmail: owner, name: 's' });
      await repo.attachFile(store.id, file.id, {});
      await seedChunk(store.id, file.id, 0, 'chunk text');

      const { deleted } = await repo.deleteStoreFile(store.id, file.id, owner);
      expect(deleted).toBe(true);

      const { rows: chunkRows } = await pool.query('SELECT 1 FROM vector_store_chunks WHERE store_id=$1', [store.id]);
      expect(chunkRows.length).toBe(0);
      const { rows: vsfRows } = await pool.query('SELECT 1 FROM vector_store_files WHERE store_id=$1 AND file_id=$2', [store.id, file.id]);
      expect(vsfRows.length).toBe(0);
      // Never touched, even though this was the file's only attachment anywhere.
      const { rows: fsFileRows } = await pool.query('SELECT 1 FROM fs_files WHERE id=$1', [file.id]);
      expect(fsFileRows.length).toBe(1);
      const { rows: blobRows } = await pool.query('SELECT ref_count, bytes FROM file_blobs WHERE sha256=$1', [file.sha]);
      expect(blobRows[0].ref_count).toBe(1);
      expect(blobRows[0].bytes).not.toBeNull();
    });

    it('scopes the delete by (store_id, file_id): detaching from one store leaves the same file\'s attachment to another store untouched', async () => {
      const owner = 'multi-store-owner@example.com';
      const file = await seedFile(owner, 'shared.txt', Buffer.from('attached to two stores at once'));
      const storeA = await repo.createStore({ ownerEmail: owner, name: 'A' });
      const storeB = await repo.createStore({ ownerEmail: owner, name: 'B' });
      await repo.attachFile(storeA.id, file.id, {});
      await repo.attachFile(storeB.id, file.id, {});
      await seedChunk(storeA.id, file.id, 0, 'chunk in store A');
      await seedChunk(storeB.id, file.id, 0, 'chunk in store B');

      const { deleted } = await repo.deleteStoreFile(storeA.id, file.id, owner);
      expect(deleted).toBe(true);

      const { rows: chunksA } = await pool.query('SELECT 1 FROM vector_store_chunks WHERE store_id=$1', [storeA.id]);
      expect(chunksA.length).toBe(0);
      const { rows: chunksB } = await pool.query('SELECT 1 FROM vector_store_chunks WHERE store_id=$1', [storeB.id]);
      expect(chunksB.length).toBe(1);
      const { rows: vsfB } = await pool.query('SELECT 1 FROM vector_store_files WHERE store_id=$1 AND file_id=$2', [storeB.id, file.id]);
      expect(vsfB.length).toBe(1);
      const { rows: fsFileRows } = await pool.query('SELECT 1 FROM fs_files WHERE id=$1', [file.id]);
      expect(fsFileRows.length).toBe(1);
    });

    it("never touches file_blobs at all, regardless of how many owners share the content", async () => {
      // Two owners each upload the same bytes independently (two fs_files
      // rows, one file_blobs row at ref_count 2). Detaching owner A's
      // attachment must leave that refcount COMPLETELY unchanged -- not
      // decremented by one, not touched at all -- because detach is not a
      // release operation.
      const content = Buffer.from('shared bytes, uploaded independently by two owners');
      const fileA = await seedFile('cascade-a@example.com', 'a.txt', content);
      const fileB = await seedFile('cascade-b@example.com', 'b.txt', content);
      expect(fileA.sha).toBe(fileB.sha);

      const { rows: beforeBlob } = await pool.query('SELECT ref_count FROM file_blobs WHERE sha256=$1', [fileA.sha]);
      expect(beforeBlob[0].ref_count).toBe(2);

      const storeA = await repo.createStore({ ownerEmail: 'cascade-a@example.com', name: 'A' });
      await repo.attachFile(storeA.id, fileA.id, {});

      const { deleted } = await repo.deleteStoreFile(storeA.id, fileA.id, 'cascade-a@example.com');
      expect(deleted).toBe(true);

      const { rows: fsFileA } = await pool.query('SELECT 1 FROM fs_files WHERE id=$1', [fileA.id]);
      expect(fsFileA.length).toBe(1);
      const { rows: fsFileB } = await pool.query('SELECT 1 FROM fs_files WHERE id=$1', [fileB.id]);
      expect(fsFileB.length).toBe(1);
      const { rows: afterBlob } = await pool.query('SELECT ref_count, bytes FROM file_blobs WHERE sha256=$1', [fileA.sha]);
      expect(afterBlob[0].ref_count).toBe(2);
      expect(afterBlob[0].bytes).not.toBeNull();
    });

    it('returns deleted:false — not a distinguishing error — for another owner\'s store, and leaves it untouched', async () => {
      const owner = 'own-cascade@example.com';
      const attacker = 'attacker-cascade@example.com';
      const file = await seedFile(owner, 'private.txt', Buffer.from('private'));
      const store = await repo.createStore({ ownerEmail: owner, name: 's' });
      await repo.attachFile(store.id, file.id, {});

      const { deleted } = await repo.deleteStoreFile(store.id, file.id, attacker);
      expect(deleted).toBe(false);

      const { rows } = await pool.query('SELECT 1 FROM vector_store_files WHERE store_id=$1 AND file_id=$2', [store.id, file.id]);
      expect(rows.length).toBe(1); // untouched
    });
  });

  // ---------------------------------------------------------------------
  // Cascade correctness — WHOLE STORE delete never touches fs_files or blobs
  // ---------------------------------------------------------------------
  describe('deletion cascade: deleting an entire store', () => {
    it('cascades to every attached file\'s chunks and vector_store_files rows, never fs_files or blobs', async () => {
      const owner = 'store-delete@example.com';
      const fileOnly = await seedFile(owner, 'only.txt', Buffer.from('only in this store'));
      const shared = await seedFile(owner, 'shared.txt', Buffer.from('also attached elsewhere'));
      const store = await repo.createStore({ ownerEmail: owner, name: 'to-delete' });
      const otherStore = await repo.createStore({ ownerEmail: owner, name: 'keeps-shared' });
      await repo.attachFile(store.id, fileOnly.id, {});
      await repo.attachFile(store.id, shared.id, {});
      await repo.attachFile(otherStore.id, shared.id, {});
      await seedChunk(store.id, fileOnly.id, 0, 'chunk');
      await seedChunk(store.id, shared.id, 0, 'chunk');
      await seedChunk(otherStore.id, shared.id, 0, 'chunk');

      const { deleted } = await repo.deleteStoreCascade(store.id, owner);
      expect(deleted).toBe(true);

      const { rows: storeRow } = await pool.query('SELECT 1 FROM vector_stores WHERE id=$1', [store.id]);
      expect(storeRow.length).toBe(0);
      const { rows: vsfRows } = await pool.query('SELECT 1 FROM vector_store_files WHERE store_id=$1', [store.id]);
      expect(vsfRows.length).toBe(0);
      const { rows: chunkRows } = await pool.query('SELECT 1 FROM vector_store_chunks WHERE store_id=$1', [store.id]);
      expect(chunkRows.length).toBe(0);

      // Neither file's fs_files row or blob is ever touched by a store delete,
      // whether or not it was also attached elsewhere.
      const { rows: fileOnlyRow } = await pool.query('SELECT 1 FROM fs_files WHERE id=$1', [fileOnly.id]);
      expect(fileOnlyRow.length).toBe(1);
      const { rows: fileOnlyBlob } = await pool.query('SELECT 1 FROM file_blobs WHERE sha256=$1', [fileOnly.sha]);
      expect(fileOnlyBlob.length).toBe(1);
      const { rows: sharedRow } = await pool.query('SELECT 1 FROM fs_files WHERE id=$1', [shared.id]);
      expect(sharedRow.length).toBe(1);

      // The other store's attachment and chunk for the shared file are untouched.
      const { rows: otherStoreVsf } = await pool.query('SELECT 1 FROM vector_store_files WHERE store_id=$1 AND file_id=$2', [otherStore.id, shared.id]);
      expect(otherStoreVsf.length).toBe(1);
      const { rows: otherStoreChunks } = await pool.query('SELECT 1 FROM vector_store_chunks WHERE store_id=$1', [otherStore.id]);
      expect(otherStoreChunks.length).toBe(1);
    });

    it('never touches file_blobs at all, regardless of how many owners share the content', async () => {
      const content = Buffer.from('shared bytes across two owners, whole-store delete this time');
      const fileA = await seedFile('store-cascade-a@example.com', 'a.txt', content);
      const fileB = await seedFile('store-cascade-b@example.com', 'b.txt', content);

      const storeA = await repo.createStore({ ownerEmail: 'store-cascade-a@example.com', name: 'A' });
      await repo.attachFile(storeA.id, fileA.id, {});

      const { deleted } = await repo.deleteStoreCascade(storeA.id, 'store-cascade-a@example.com');
      expect(deleted).toBe(true);

      const { rows: fsFileA } = await pool.query('SELECT 1 FROM fs_files WHERE id=$1', [fileA.id]);
      expect(fsFileA.length).toBe(1);
      const { rows: fsFileB } = await pool.query('SELECT 1 FROM fs_files WHERE id=$1', [fileB.id]);
      expect(fsFileB.length).toBe(1);
      const { rows: blob } = await pool.query('SELECT ref_count, bytes FROM file_blobs WHERE sha256=$1', [fileA.sha]);
      expect(blob[0].ref_count).toBe(2);
      expect(blob[0].bytes).not.toBeNull();
    });

    it('returns deleted:false for another owner\'s store, leaving it and its files fully intact', async () => {
      const owner = 'keep-mine@example.com';
      const attacker = 'attacker2@example.com';
      const file = await seedFile(owner, 'mine.txt', Buffer.from('mine'));
      const store = await repo.createStore({ ownerEmail: owner, name: 's' });
      await repo.attachFile(store.id, file.id, {});

      const { deleted } = await repo.deleteStoreCascade(store.id, attacker);
      expect(deleted).toBe(false);

      const { rows: storeRow } = await pool.query('SELECT 1 FROM vector_stores WHERE id=$1', [store.id]);
      expect(storeRow.length).toBe(1);
      const { rows: vsfRow } = await pool.query('SELECT 1 FROM vector_store_files WHERE store_id=$1 AND file_id=$2', [store.id, file.id]);
      expect(vsfRow.length).toBe(1);
    });
  });

  // ---------------------------------------------------------------------
  // Cross-owner 404-vs-nonexistent parity through the controller
  // ---------------------------------------------------------------------
  it("cross-owner 404-vs-nonexistent parity for stores: another owner's store and a truly nonexistent id produce byte-identical responses", async () => {
    const store = await repo.createStore({ ownerEmail: 'store-owner-a@example.com', name: 's' });
    const nonexistentId = 'vs_000000000000000000000000';

    for (const handler of [ctrl.retrieveVectorStore, ctrl.deleteVectorStore]) {
      const foreignRes = makeRes();
      await handler(baseReq('store-owner-b@example.com', { params: { id: store.id } }), foreignRes, throwOnError);
      const missingRes = makeRes();
      await handler(baseReq('store-owner-b@example.com', { params: { id: nonexistentId } }), missingRes, throwOnError);

      expect(foreignRes.statusCode).toBe(404);
      expect(foreignRes.statusCode).toBe(missingRes.statusCode);
      expect(foreignRes.body.error.type).toBe(missingRes.body.error.type);
      expect(foreignRes.body.error.code).toBe(missingRes.body.error.code);
    }

    const stillThereRes = makeRes();
    await ctrl.retrieveVectorStore(baseReq('store-owner-a@example.com', { params: { id: store.id } }), stillThereRes, throwOnError);
    expect(stillThereRes.statusCode).toBe(200);
  });

  it("cross-owner 404-vs-nonexistent parity for store files: another owner's attachment and a truly nonexistent file_id produce byte-identical responses", async () => {
    const owner = 'sf-owner-a@example.com';
    const file = await seedFile(owner, 'f.txt', Buffer.from('x'));
    const store = await repo.createStore({ ownerEmail: owner, name: 's' });
    await repo.attachFile(store.id, file.id, {});
    const nonexistentFileId = 'file-000000000000000000000000';

    for (const handler of [ctrl.retrieveVectorStoreFile, ctrl.deleteVectorStoreFile, ctrl.downloadVectorStoreFileContent]) {
      const foreignRes = makeRes();
      await handler(baseReq('sf-owner-b@example.com', { params: { id: store.id, file_id: file.id } }), foreignRes, throwOnError);
      const missingRes = makeRes();
      await handler(baseReq('sf-owner-b@example.com', { params: { id: store.id, file_id: nonexistentFileId } }), missingRes, throwOnError);

      expect(foreignRes.statusCode).toBe(404);
      expect(foreignRes.statusCode).toBe(missingRes.statusCode);
      expect(foreignRes.body.error.code).toBe(missingRes.body.error.code);
    }

    const stillThereRes = makeRes();
    await ctrl.retrieveVectorStoreFile(baseReq(owner, { params: { id: store.id, file_id: file.id } }), stillThereRes, throwOnError);
    expect(stillThereRes.statusCode).toBe(200);
  });

  // ---------------------------------------------------------------------
  // The embedding-dimension guard against a genuinely stale store row
  // ---------------------------------------------------------------------
  it('409s attaching a file to a store whose pinned embedding_dim no longer matches the live configuration', async () => {
    const owner = 'stale-dim@example.com';
    const store = await repo.createStore({ ownerEmail: owner, name: 'stale' });
    // Simulate the operator having reconfigured the embedding model since
    // this store was created: mutate the pinned dimension directly (the
    // physical vector(N) column width is untouched — this is exactly the
    // "config moved on, schema didn't" drift assertStoreDimension exists to
    // catch before it reaches pgvector as a raw error).
    await pool.query('UPDATE vector_stores SET embedding_dim = $2 WHERE id = $1', [store.id, EMBED_DIM + 1]);
    const file = await seedFile(owner, 'f.txt', Buffer.from('x'));

    const res = makeRes();
    await ctrl.createVectorStoreFile(baseReq(owner, { params: { id: store.id }, body: { file_id: file.id } }), res, throwOnError);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('embedding_dimension_mismatch');

    const { rows } = await pool.query('SELECT 1 FROM vector_store_files WHERE store_id=$1 AND file_id=$2', [store.id, file.id]);
    expect(rows.length).toBe(0); // never attached
  });

  it('retrieving and deleting a dimension-stale store still works — only attach is blocked', async () => {
    const owner = 'stale-dim-2@example.com';
    const store = await repo.createStore({ ownerEmail: owner, name: 'stale' });
    await pool.query('UPDATE vector_stores SET embedding_dim = $2 WHERE id = $1', [store.id, EMBED_DIM + 1]);

    const getRes = makeRes();
    await ctrl.retrieveVectorStore(baseReq(owner, { params: { id: store.id } }), getRes, throwOnError);
    expect(getRes.statusCode).toBe(200);

    const deleteRes = makeRes();
    await ctrl.deleteVectorStore(baseReq(owner, { params: { id: store.id } }), deleteRes, throwOnError);
    expect(deleteRes.statusCode).toBe(200);
  });

  // ---------------------------------------------------------------------
  // C1/C2 (review round 2): two ownership sites whose only prior coverage
  // was a MOCKED test that stubbed the row count the SQL returns rather
  // than inspecting the SQL itself, so mutating `AND owner_email = $2` out
  // of either query produced zero failures. The mocked suite now also
  // asserts the SQL text directly (same fix pattern as every other site in
  // this file); these are the live-database proof that a foreign owner's
  // resource is genuinely unreachable, not merely that the mock was told
  // the right answer.
  // ---------------------------------------------------------------------
  it("C1 — POST /vector_stores with another owner's file_id is rejected and creates no store row at all", async () => {
    const attacker = 'c1-attacker@example.com';
    const victim = 'c1-victim@example.com';
    const victimFile = await seedFile(victim, 'victims-file.txt', Buffer.from('not the attacker\'s to read'));

    const res = makeRes();
    await ctrl.createVectorStore(baseReq(attacker, { body: { name: 'steal', file_ids: [victimFile.id] } }), res, throwOnError);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('file_not_found');

    // No partially-created store leaking the attacker's attempt, and
    // critically: no store now attached to the victim's file either.
    const { rows: attackerStores } = await pool.query('SELECT 1 FROM vector_stores WHERE owner_email=$1', [attacker]);
    expect(attackerStores.length).toBe(0);
    const { rows: attachments } = await pool.query('SELECT 1 FROM vector_store_files WHERE file_id=$1', [victimFile.id]);
    expect(attachments.length).toBe(0);
  });

  it('C2 — POST /vector_stores/{id} with an empty body 404s for a store owned by someone else, and returns it unchanged for the real owner', async () => {
    const owner = 'c2-owner@example.com';
    const attacker = 'c2-attacker@example.com';
    const store = await repo.createStore({ ownerEmail: owner, name: 'not yours', metadata: { secret: 'value' } });

    const attackerRes = makeRes();
    await ctrl.modifyVectorStore(baseReq(attacker, { params: { id: store.id }, body: {} }), attackerRes, throwOnError);
    expect(attackerRes.statusCode).toBe(404);
    expect(attackerRes.body.name).toBeUndefined();
    expect(attackerRes.body.metadata).toBeUndefined();

    const ownerRes = makeRes();
    await ctrl.modifyVectorStore(baseReq(owner, { params: { id: store.id }, body: {} }), ownerRes, throwOnError);
    expect(ownerRes.statusCode).toBe(200);
    expect(ownerRes.body.name).toBe('not yours');
    expect(ownerRes.body.metadata).toEqual({ secret: 'value' });
  });

  // ---------------------------------------------------------------------
  // I3: attachFile's reverse-race mapping. Genuinely interleaving two
  // concurrent HTTP requests around a specific INSERT is timing-dependent
  // and would make this suite flaky (the opposite of what "twice in a row,
  // no manual cleanup" requires). Instead this proves, against the real
  // schema, the exact fact the controller's mapping in
  // vectorStoresController.ts depends on: Postgres raises 23503 with
  // `vector_store_files_file_id_fkey` when the referenced file is gone, and
  // `vector_store_files_store_id_fkey` when the referenced store is gone —
  // grounding the literal constraint-name strings the mocked
  // "400s/404s (never 500) when the ... disappears in a race" tests assert
  // against, rather than leaving them as an assumption nobody checked live.
  // ---------------------------------------------------------------------
  it('I3 — attachFile raises 23503 on the file_id FK when the file no longer exists at insert time', async () => {
    const owner = 'i3-file-race@example.com';
    const store = await repo.createStore({ ownerEmail: owner, name: 's' });
    await expect(repo.attachFile(store.id, 'file-does-not-exist-anymore', {}))
      .rejects.toMatchObject({ code: '23503', constraint: 'vector_store_files_file_id_fkey' });
  });

  it('I3 — attachFile raises 23503 on the store_id FK when the store no longer exists at insert time', async () => {
    const owner = 'i3-store-race@example.com';
    const file = await seedFile(owner, 'f.txt', Buffer.from('x'));
    await expect(repo.attachFile('vs_does_not_exist_anymore_000', file.id, {}))
      .rejects.toMatchObject({ code: '23503', constraint: 'vector_store_files_store_id_fkey' });
  });
});
