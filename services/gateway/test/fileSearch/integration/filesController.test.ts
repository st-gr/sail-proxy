// End-to-end coverage of the five /files handlers against a real Postgres
// database — the properties a reviewer confirmed live but that Task 9's
// mocked unit tests can't actually guard against regressing: blob refcount
// survival across a delete, cross-owner 404-vs-nonexistent parity, cursor
// scoping, and the forward/backward keyset walk.
import * as crypto from 'crypto';
import { Readable } from 'stream';
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import * as filesController from '../../../src/controllers/filesController';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Minimal fake Express req/res — same shape as the mocked unit tests use,
// but here the controllers reach a real Pool through the real db.ts/blobStore.ts.
// ---------------------------------------------------------------------------
function makeRes(): any {
  const res: any = { headersSent: false, statusCode: 200 };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  res.set = (...args: any[]) => { res.headers = res.headers ?? {}; res.headers[args[0]] = args[1]; return res; };
  res.send = (body: any) => { res.body = body; return res; };
  return res;
}

function baseReq(email: string, overrides: Record<string, any> = {}): any {
  return { headers: {}, params: {}, query: {}, apiKeyInfo: { email }, ...overrides };
}

function buildMultipartBody(boundary: string, opts: { filename: string; content: Buffer; contentType?: string; purpose?: string | null }): Buffer {
  const parts: Buffer[] = [];
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${opts.filename}"\r\n` +
    `Content-Type: ${opts.contentType ?? 'application/octet-stream'}\r\n\r\n`, 'latin1'));
  parts.push(opts.content);
  parts.push(Buffer.from('\r\n', 'latin1'));
  if (opts.purpose !== undefined && opts.purpose !== null) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\n${opts.purpose}\r\n`, 'latin1'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'latin1'));
  return Buffer.concat(parts);
}

function makeUploadReq(email: string, body: Buffer, boundary: string): any {
  const req: any = new Readable({ read() {} });
  req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
  req.method = 'POST';
  req.params = {};
  req.query = {};
  req.apiKeyInfo = { email };
  req.push(body);
  req.push(null);
  return req;
}

async function uploadFile(email: string, filename: string, content: Buffer): Promise<any> {
  const boundary = `b${crypto.randomBytes(8).toString('hex')}`;
  const req = makeUploadReq(email, buildMultipartBody(boundary, { filename, content, purpose: 'assistants' }), boundary);
  const res = makeRes();
  await filesController.uploadFile(req, res, (err: any) => { throw err; });
  return res;
}

d('filesController against a real Postgres database (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;

  beforeAll(async () => {
    fixture = await createIsolatedSchema(DSN!, 3);
    // db.ts's getPool()/isFileSearchAvailable() reach the database through
    // their own singleton Pool built from this env var — point it at the
    // isolated schema, then run the real migration so `migrated` flips true
    // (buildSchemaSql is idempotent — the fixture already applied it once).
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
    await pool.query('DELETE FROM fs_files');
    await pool.query('DELETE FROM file_blobs');
  });

  it('full lifecycle: upload, list, retrieve, download original bytes, delete, then 404', async () => {
    const owner = 'lifecycle@example.com';
    const content = Buffer.from('the quick brown fox jumps over the lazy dog');

    const uploadRes = await uploadFile(owner, 'fox.txt', content);
    expect(uploadRes.statusCode).toBe(200);
    const id = uploadRes.body.id;

    const listRes = makeRes();
    await filesController.listFiles(baseReq(owner), listRes, (e: any) => { throw e; });
    expect(listRes.body.data.map((f: any) => f.id)).toEqual([id]);

    const getRes = makeRes();
    await filesController.retrieveFile(baseReq(owner, { params: { id } }), getRes, (e: any) => { throw e; });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.body.id).toBe(id);

    const contentRes = makeRes();
    await filesController.downloadFileContent(baseReq(owner, { params: { id } }), contentRes, (e: any) => { throw e; });
    expect(contentRes.statusCode).toBe(200);
    expect(Buffer.isBuffer(contentRes.body)).toBe(true);
    expect((contentRes.body as Buffer).equals(content)).toBe(true);

    const deleteRes = makeRes();
    await filesController.deleteFile(baseReq(owner, { params: { id } }), deleteRes, (e: any) => { throw e; });
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.body).toEqual({ id, object: 'file', deleted: true });

    const afterDeleteRes = makeRes();
    await filesController.retrieveFile(baseReq(owner, { params: { id } }), afterDeleteRes, (e: any) => { throw e; });
    expect(afterDeleteRes.statusCode).toBe(404);
  });

  it('refcount survives a delete: another owner with identical content keeps their bytes after the first owner deletes', async () => {
    const content = Buffer.from('shared content, uploaded twice by two different owners');
    const sha = crypto.createHash('sha256').update(content).digest('hex');

    const ownerARes = await uploadFile('owner-a@example.com', 'shared-a.txt', content);
    const ownerBRes = await uploadFile('owner-b@example.com', 'shared-b.txt', content);
    expect(ownerARes.statusCode).toBe(200);
    expect(ownerBRes.statusCode).toBe(200);

    const { rows: beforeDelete } = await pool.query('SELECT ref_count FROM file_blobs WHERE sha256=$1', [sha]);
    expect(beforeDelete[0].ref_count).toBe(2);

    const deleteRes = makeRes();
    await filesController.deleteFile(
      baseReq('owner-a@example.com', { params: { id: ownerARes.body.id } }), deleteRes, (e: any) => { throw e; },
    );
    expect(deleteRes.statusCode).toBe(200);

    // The physical bytes must still be there — releaseBlob only decremented
    // the refcount, it did not destroy the row while owner B still references it.
    const { rows: afterDelete } = await pool.query('SELECT ref_count FROM file_blobs WHERE sha256=$1', [sha]);
    expect(afterDelete[0].ref_count).toBe(1);

    const ownerBContentRes = makeRes();
    await filesController.downloadFileContent(
      baseReq('owner-b@example.com', { params: { id: ownerBRes.body.id } }), ownerBContentRes, (e: any) => { throw e; },
    );
    expect(ownerBContentRes.statusCode).toBe(200);
    expect((ownerBContentRes.body as Buffer).equals(content)).toBe(true);

    // Owner A's own row and only their row is gone.
    const ownerAAfterRes = makeRes();
    await filesController.retrieveFile(
      baseReq('owner-a@example.com', { params: { id: ownerARes.body.id } }), ownerAAfterRes, (e: any) => { throw e; },
    );
    expect(ownerAAfterRes.statusCode).toBe(404);

    // And once owner B also deletes theirs, the blob genuinely disappears.
    const ownerBDeleteRes = makeRes();
    await filesController.deleteFile(
      baseReq('owner-b@example.com', { params: { id: ownerBRes.body.id } }), ownerBDeleteRes, (e: any) => { throw e; },
    );
    expect(ownerBDeleteRes.statusCode).toBe(200);
    const { rows: afterBothDeleted } = await pool.query('SELECT 1 FROM file_blobs WHERE sha256=$1', [sha]);
    expect(afterBothDeleted.length).toBe(0);
  });

  it("cross-owner 404-vs-nonexistent parity: another owner's file and a truly nonexistent id produce byte-identical responses", async () => {
    const ownerARes = await uploadFile('owner-a2@example.com', 'private.txt', Buffer.from('private to owner A'));
    const foreignId = ownerARes.body.id;
    const nonexistentId = 'file-000000000000000000000000';

    for (const handler of [filesController.retrieveFile, filesController.deleteFile, filesController.downloadFileContent]) {
      const foreignRes = makeRes();
      await handler(baseReq('owner-b2@example.com', { params: { id: foreignId } }), foreignRes, (e: any) => { throw e; });
      const missingRes = makeRes();
      await handler(baseReq('owner-b2@example.com', { params: { id: nonexistentId } }), missingRes, (e: any) => { throw e; });

      expect(foreignRes.statusCode).toBe(404);
      expect(foreignRes.statusCode).toBe(missingRes.statusCode);
      // The message legitimately echoes back the id the caller already sent
      // (not itself an oracle — they know their own request), so it differs
      // between the two cases; type/code, and the message TEMPLATE, must not.
      expect(foreignRes.body.error.type).toBe(missingRes.body.error.type);
      expect(foreignRes.body.error.code).toBe(missingRes.body.error.code);
      expect(foreignRes.body.error.message).toBe(`No such file: ${foreignId}`);
      expect(missingRes.body.error.message).toBe(`No such file: ${nonexistentId}`);
    }

    // And owner A's file must still be intact — the failed foreign delete attempt above must not have removed it.
    const stillThereRes = makeRes();
    await filesController.retrieveFile(baseReq('owner-a2@example.com', { params: { id: foreignId } }), stillThereRes, (e: any) => { throw e; });
    expect(stillThereRes.statusCode).toBe(200);
  });

  it('cursor scoping: using another owner\'s file id as after= returns an empty page, not their data', async () => {
    const ownerA = 'owner-a3@example.com';
    const ownerB = 'owner-b3@example.com';
    const ownerAFile = await uploadFile(ownerA, 'a-file.txt', Buffer.from('owner a content'));
    // Force owner A's file strictly OLDER than owner B's file below. This is
    // what makes the assertion actually prove the CURSOR-RESOLUTION lookup
    // itself is owner-scoped (not just the outer list query, which was never
    // broken): if the cursor lookup ever resolved cross-owner, the outer
    // `owner_email = A AND created_at < cursor` clause would find owner A's
    // own (older) file and return a non-empty page. With insert-order timing
    // alone (both created "now"), that distinction is coincidental — this
    // makes it deterministic.
    await pool.query('UPDATE fs_files SET created_at = $2 WHERE id = $1', [ownerAFile.body.id, new Date('2020-01-01T00:00:00Z')]);
    const ownerBFile = await uploadFile(ownerB, 'b-file.txt', Buffer.from('owner b content'));
    await pool.query('UPDATE fs_files SET created_at = $2 WHERE id = $1', [ownerBFile.body.id, new Date('2025-01-01T00:00:00Z')]);

    const res = makeRes();
    await filesController.listFiles(
      baseReq(ownerA, { query: { after: ownerBFile.body.id } }), res, (e: any) => { throw e; },
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ object: 'list', data: [], has_more: false, first_id: null, last_id: null });
  });

  it('keyset walk: forward via after= and backward via before= both reconstruct the full order with no gaps, no duplicates, and terminate', async () => {
    const owner = 'walker@example.com';
    const N = 7;
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await uploadFile(owner, `f${i}.txt`, Buffer.from(`content number ${i}`));
      ids.push(res.body.id);
      // Distinct created_at is essential for a deterministic order — force
      // it explicitly rather than trust timer resolution between inserts.
      // eslint-disable-next-line no-await-in-loop
      await pool.query('UPDATE fs_files SET created_at = $2 WHERE id = $1', [res.body.id, new Date(2026, 0, 1, 0, 0, i)]);
    }

    const { rows: canonicalRows } = await pool.query(
      'SELECT id FROM fs_files WHERE owner_email=$1 ORDER BY created_at DESC, id DESC', [owner],
    );
    const canonical = canonicalRows.map((r) => r.id);
    expect(canonical.length).toBe(N);

    // Forward walk (after=), default order (desc, newest first).
    const forward: string[] = [];
    let afterCursor: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const query: any = { limit: '3' };
      if (afterCursor) query.after = afterCursor;
      const res = makeRes();
      // eslint-disable-next-line no-await-in-loop
      await filesController.listFiles(baseReq(owner, { query }), res, (e: any) => { throw e; });
      const pageIds = res.body.data.map((f: any) => f.id);
      forward.push(...pageIds);
      if (!res.body.has_more) break;
      afterCursor = res.body.last_id;
    }
    expect(forward).toEqual(canonical);
    expect(new Set(forward).size).toBe(N); // no duplicates

    // Backward walk (before=), starting just beyond the oldest item so the
    // walk reconstructs everything else. Each page is prepended (not
    // appended): "before" pages move toward the NEWEST end of the list, so
    // the page fetched last covers the newest items and must end up first.
    const backward: string[] = [];
    let beforeCursor: string = canonical[canonical.length - 1]; // the oldest item
    let terminated = false;
    for (let guard = 0; guard < 20; guard++) {
      const res = makeRes();
      // eslint-disable-next-line no-await-in-loop
      await filesController.listFiles(baseReq(owner, { query: { before: beforeCursor, limit: '3' } }), res, (e: any) => { throw e; });
      const pageIds = res.body.data.map((f: any) => f.id);
      if (pageIds.length === 0) { terminated = true; break; }
      backward.unshift(...pageIds);
      if (!res.body.has_more) { terminated = true; break; }
      beforeCursor = res.body.first_id;
    }
    expect(terminated).toBe(true); // must terminate, not loop forever
    // The starting cursor (the oldest item) is excluded by "before" semantics.
    expect(backward).toEqual(canonical.slice(0, N - 1));
    expect(new Set(backward).size).toBe(N - 1);
  });

  describe('created_at provenance', () => {
    it('stamps an uploaded file from the DATABASE clock, not the application clock', async () => {
      // fs_files.created_at is the keyset cursor for GET /v1/files
      // (ORDER BY created_at, id) and was the last of the three file_search
      // tables still using the application clock. Two replicas with skewed
      // clocks would store rows in an order contradicting their true insertion
      // order, and a cursor resolved on one can skip or repeat rows on the
      // other's page.
      const before = (await pool.query('SELECT clock_timestamp() AS t')).rows[0].t.getTime();
      const res = await uploadFile('clock@example.com', 'clock.txt', Buffer.from('x'));
      const after = (await pool.query('SELECT clock_timestamp() AS t')).rows[0].t.getTime();

      expect(res.statusCode).toBe(200);

      const { rows } = await pool.query('SELECT created_at FROM fs_files WHERE id = $1', [res.body.id]);
      expect(rows[0].created_at.getTime()).toBeGreaterThanOrEqual(before);
      expect(rows[0].created_at.getTime()).toBeLessThanOrEqual(after);

      // The response must report what was STORED. The previous form bound a JS
      // Date and echoed it back, which looked right for exactly this assertion
      // while being wrong — so compare against the row, not against a value the
      // handler chose.
      expect(res.body.created_at).toBe(Math.floor(rows[0].created_at.getTime() / 1000));
    });
  });
});
