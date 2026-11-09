import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { sha256Of, retainBlob } from '../../../src/fileSearch/blob/blobStore';
import * as repo from '../../../src/fileSearch/repository';
import * as groundingController from '../../../src/controllers/groundingController';
import { listAttachmentsForFiles } from '../../../src/fileSearch/groundingQueries';
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
  return res;
}
function baseReq(email: string, overrides: Record<string, any> = {}): any {
  return { headers: {}, params: {}, query: {}, body: {}, apiKeyInfo: { email }, ...overrides };
}
const rethrow = (e: any) => { if (e) throw e; };

d('grounding queries against a real Postgres database (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;
  const OWNER = 'owner@test.com';
  const OTHER = 'other@test.com';

  /** A file with a fixed id, its bytes in the blob store. Distinct content per id keeps the blobs apart. */
  async function insertFile(id: string, owner: string): Promise<void> {
    const content = Buffer.from(`content of ${id}`);
    const sha = sha256Of(content);
    await retainBlob(sha, content, 'text/plain');
    await pool.query(
      `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes, created_at)
       VALUES ($1,$2,$3,'assistants',$4,$5, now())`,
      [id, owner, `${id}.txt`, sha, content.length]);
  }
  async function createStore(owner: string, name: string): Promise<string> {
    return (await repo.createStore({ ownerEmail: owner, name })).id;
  }
  async function attach(owner: string, storeId: string, fileId: string): Promise<void> {
    await pool.query(
      `INSERT INTO vector_store_files (store_id, file_id, status)
       SELECT $1, $2, 'in_progress' FROM vector_stores WHERE id = $1 AND owner_email = $3`,
      [storeId, fileId, owner]);
  }

  beforeAll(async () => {
    // Set BEFORE runMigration: it reads embeddingDimensions to build the vector(N) column.
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

  it('lists, per file, the owner\'s stores it is attached to, and nothing of another owner', async () => {
    await insertFile('file-a', OWNER); await insertFile('file-b', OWNER); await insertFile('file-x', OTHER);
    const docs = await createStore(OWNER, 'Docs'); const notes = await createStore(OWNER, 'Notes');
    const foreign = await createStore(OTHER, 'Foreign');
    await attach(OWNER, docs, 'file-a'); await attach(OWNER, notes, 'file-a'); await attach(OTHER, foreign, 'file-x');

    const found = await listAttachmentsForFiles(OWNER, ['file-a', 'file-b', 'file-x']);
    expect(Object.keys(found)).toEqual(['file-a']);
    // Sorted before comparing: two stores created within the same millisecond tie on created_at.
    expect(found['file-a'].map((a) => a.store_name).sort()).toEqual(['Docs', 'Notes']);
    expect(found['file-a'].every((a) => a.status === 'in_progress')).toBe(true);
  });

  it.each([['with detach=true (the cockpit)', { detach: 'true' }], ['without the flag (OpenAI\'s delete)', {}]])(
    'DELETE %s detaches an attached file from every store and deletes it', async (_label, query) => {
      await insertFile('file-a', OWNER);
      const docs = await createStore(OWNER, 'Docs');
      await attach(OWNER, docs, 'file-a');

      const done = makeRes();
      await groundingController.deleteFile(baseReq(OWNER, { params: { id: 'file-a' }, query }), done, rethrow);
      expect(done.statusCode).toBe(200);
      expect(done.body).toEqual({ id: 'file-a', object: 'file', deleted: true });
      expect((await pool.query('SELECT 1 FROM fs_files WHERE id = $1', ['file-a'])).rowCount).toBe(0);
      expect((await pool.query('SELECT 1 FROM vector_store_files WHERE file_id = $1', ['file-a'])).rowCount).toBe(0);
      expect((await pool.query('SELECT 1 FROM vector_stores WHERE id = $1', [docs])).rowCount).toBe(1);
    },
  );

  it('a failure after the detach rolls the detach back: the file stays attached and present', async () => {
    // Test-only failure injection: a trigger in the isolated schema that makes the fs_files delete fail
    // after the detach statements have already run in the transaction.
    await insertFile('file-fail', OWNER);
    const docs = await createStore(OWNER, 'Docs');
    await attach(OWNER, docs, 'file-fail');
    await pool.query(`CREATE FUNCTION fail_file_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected delete failure'; END $$ LANGUAGE plpgsql`);
    await pool.query('CREATE TRIGGER fail_file_delete BEFORE DELETE ON fs_files FOR EACH ROW EXECUTE FUNCTION fail_file_delete()');
    try {
      await expect(repo.deleteFileDetachingEverywhere('file-fail', OWNER)).rejects.toThrow('injected delete failure');
      expect((await pool.query('SELECT 1 FROM fs_files WHERE id = $1', ['file-fail'])).rowCount).toBe(1);
      expect((await pool.query('SELECT 1 FROM vector_store_files WHERE file_id = $1', ['file-fail'])).rowCount).toBe(1);
    } finally {
      await pool.query('DROP TRIGGER fail_file_delete ON fs_files');
      await pool.query('DROP FUNCTION fail_file_delete()');
    }
  });

  it('reports inUse and keeps everything when another owner\'s store still references the file', async () => {
    await insertFile('file-shared', OWNER);
    const mine = await createStore(OWNER, 'Mine');
    const theirs = await createStore(OTHER, 'Theirs');
    await attach(OWNER, mine, 'file-shared');
    await pool.query(
      `INSERT INTO vector_store_files (store_id, file_id, status) VALUES ($1, $2, 'completed')`, [theirs, 'file-shared'],
    );
    expect(await repo.deleteFileDetachingEverywhere('file-shared', OWNER)).toEqual({ deleted: false, inUse: true });
    expect((await pool.query('SELECT 1 FROM fs_files WHERE id = $1', ['file-shared'])).rowCount).toBe(1);
    expect((await pool.query('SELECT 1 FROM vector_store_files WHERE file_id = $1', ['file-shared'])).rowCount).toBe(2);
  });

  it('another user cannot delete the file, with or without detach', async () => {
    await insertFile('file-a', OWNER);
    const res = makeRes();
    await groundingController.deleteFile(baseReq(OTHER, { params: { id: 'file-a' }, query: { detach: 'true' } }), res, rethrow);
    expect(res.statusCode).toBe(404);
    expect((await pool.query('SELECT 1 FROM fs_files WHERE id = $1', ['file-a'])).rowCount).toBe(1);
  });
});
