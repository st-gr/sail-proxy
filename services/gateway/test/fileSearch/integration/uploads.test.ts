// OpenAI's Uploads API (G12) against a real Postgres database, driven over HTTP through the real
// uploads and files routers (auth and quota middlewares replaced by pass-throughs that set the
// caller), with the request shapes openai-node's `client.uploads.*` sends: JSON create/complete/
// cancel and a multipart part whose field is `data`.
//
// Covers the object shapes; a 3-part flow added in shuffled order and completed in the declared
// order into a normal file; md5 (match, mismatch keeps the parts); size mismatch; the limits (part
// cap 413, declared size, part count, staged bytes, pending uploads per owner); the purpose and
// expires_after rules answering exactly as POST /files; cancel; the expiry sweep; another owner's
// upload (404); complete racing cancel and complete racing complete (60 iterations each); and that
// no part row or blob reference is left behind on any path.
import * as crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import type { Server } from 'http';
import { Client, Pool, PoolClient } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { sweepExpiredUploads, startExpirySweeper, stopExpirySweeper } from '../../../src/fileSearch/expirySweeper';
import { MAX_PARTS_PER_UPLOAD, MAX_PENDING_UPLOADS_PER_OWNER } from '../../../src/fileSearch/uploads';
import { nulByteGuard } from '../../../src/middlewares/nulByteGuard';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
const OWNER = 'uploads-owner@example.com';
const OTHER = 'uploads-other@example.com';
const RACE_ITERATIONS = 60;
const MAX_FILE_BYTES = 64 * 1024;

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

// The caller's identity comes from a test header; every request still passes through the
// routers' real guard positions, and the quota pass-through records each pass.
const mockQuotaPasses: string[] = [];
jest.mock('../../../src/middlewares/unifiedTokenAuth', () => ({
  __esModule: true,
  createUnifiedTokenAuth: () => (req: any, _res: any, next: any) => {
    req.apiKeyInfo = { email: req.get('x-test-owner') };
    next();
  },
}));
jest.mock('../../../src/middlewares/quotaEnforcement', () => ({
  __esModule: true,
  default: (req: any, _res: any, next: any) => { mockQuotaPasses.push(`${req.method} ${req.originalUrl}`); next(); },
}));
jest.mock('../../../src/services/unifiedAuthProxyService', () => ({
  __esModule: true,
  unifiedAuthProxyService: { createServiceAuthMiddleware: () => (_req: any, _res: any, next: any) => next() },
  serviceConfigurations: { openai: {}, openrouter: {} },
}));

const md5 = (b: Buffer): string => crypto.createHash('md5').update(b).digest('hex');
const sha256 = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex');

d('Uploads API against a real Postgres database (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;
  let server: Server;

  beforeAll(async () => {
    mockConfig = {
      enabled: true,
      embeddingModel: 'test-model',
      embeddingDimensions: EMBED_DIM,
      limits: { maxFilesPerStore: 10000, maxFileBytes: MAX_FILE_BYTES },
      blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
      hybrid: { rrfK: 60, lexicalEnabled: true, lexicalQuery: 'any', candidates: 50 },
    };
    fixture = await createIsolatedSchema(DSN!, EMBED_DIM);
    process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
    __resetForTests();
    await runMigration();
    pool = getPool()!;

    /* eslint-disable @typescript-eslint/no-var-requires, global-require */
    const filesRoutes = require('../../../src/routes/filesRoutes').default;
    const uploadsRoutes = require('../../../src/routes/uploadsRoutes').default;
    /* eslint-enable @typescript-eslint/no-var-requires, global-require */
    const app = express();
    app.use(express.json());
    // As src/index.ts mounts them.
    app.use(['/openai/v1/files', '/openai/v1/uploads'], nulByteGuard);
    app.use('/openai/v1/files', filesRoutes);
    app.use('/openai/v1/uploads', uploadsRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    __resetForTests();
    await pool.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await fixture.teardown();
  });

  beforeEach(async () => {
    mockConfig.limits.maxFileBytes = MAX_FILE_BYTES;
    mockQuotaPasses.length = 0;
    await pool.query('DELETE FROM fs_upload_parts');
    await pool.query('DELETE FROM fs_uploads');
    await pool.query('DELETE FROM fs_files');
    await pool.query('DELETE FROM file_blobs');
  });

  // --- openai-node shaped calls -------------------------------------------------------------

  const create = (body: Record<string, unknown>, owner = OWNER) =>
    request(server).post('/openai/v1/uploads').set('x-test-owner', owner).send(body);
  const addPart = (uploadId: string, data: Buffer, owner = OWNER) =>
    request(server).post(`/openai/v1/uploads/${uploadId}/parts`).set('x-test-owner', owner)
      .attach('data', data, { filename: 'blob', contentType: 'application/octet-stream' });
  const complete = (uploadId: string, body: Record<string, unknown>, owner = OWNER) =>
    request(server).post(`/openai/v1/uploads/${uploadId}/complete`).set('x-test-owner', owner).send(body);
  const cancel = (uploadId: string, owner = OWNER) =>
    request(server).post(`/openai/v1/uploads/${uploadId}/cancel`).set('x-test-owner', owner).send();

  const createFor = async (bytes: number, extra: Record<string, unknown> = {}): Promise<string> => {
    const res = await create({ bytes, filename: 'notes.txt', mime_type: 'text/plain', purpose: 'assistants', ...extra });
    expect(res.status).toBe(200);
    return res.body.id;
  };

  const count = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await pool.query(sql, params)).rows[0].n);
  const partsOf = (uploadId: string) => count('SELECT count(*) AS n FROM fs_upload_parts WHERE upload_id = $1', [uploadId]);
  const statusOf = async (uploadId: string): Promise<string> =>
    (await pool.query('SELECT status FROM fs_uploads WHERE id = $1', [uploadId])).rows[0].status;
  const refCount = async (sha: string): Promise<number | null> =>
    (await pool.query('SELECT ref_count FROM file_blobs WHERE sha256 = $1', [sha])).rows[0]?.ref_count ?? null;

  // --- shapes and the full flow ----------------------------------------------------------------

  it('creates a pending Upload with OpenAI\'s fields, expiring an hour after creation', async () => {
    const res = await create({ bytes: 12, filename: 'notes.txt', mime_type: 'text/plain', purpose: 'assistants' });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(
      ['id', 'object', 'bytes', 'created_at', 'filename', 'purpose', 'status', 'expires_at', 'file']);
    expect(res.body).toMatchObject({ object: 'upload', bytes: 12, filename: 'notes.txt', purpose: 'assistants', status: 'pending', file: null });
    expect(res.body.id).toMatch(/^upload_[0-9a-f]{24}$/);
    expect(res.body.expires_at - res.body.created_at).toBe(3600);
    expect(Math.abs(res.body.created_at - Date.now() / 1000)).toBeLessThan(60);
  });

  it('three parts added in shuffled order and completed in the declared order become one normal file', async () => {
    const pieces = [Buffer.from('alpha-'), Buffer.from('bravo-'), Buffer.from('charlie')];
    const whole = Buffer.concat(pieces);
    const uploadId = await createFor(whole.length, { purpose: 'user_data' });

    const partIds: string[] = [];
    for (const index of [2, 0, 1]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await addPart(uploadId, pieces[index]);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body)).toEqual(['id', 'object', 'created_at', 'upload_id']);
      expect(res.body).toMatchObject({ object: 'upload.part', upload_id: uploadId });
      expect(res.body.id).toMatch(/^part_[0-9a-f]{24}$/);
      partIds[index] = res.body.id;
    }

    const done = await complete(uploadId, { part_ids: partIds, md5: md5(whole) });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ id: uploadId, object: 'upload', status: 'completed', bytes: whole.length });
    const file = done.body.file;
    expect(Object.keys(file)).toEqual(['id', 'object', 'bytes', 'created_at', 'filename', 'purpose', 'status', 'status_details']);
    expect(file).toMatchObject({ object: 'file', bytes: whole.length, filename: 'notes.txt', purpose: 'user_data', status: 'processed' });

    // A normal file: listed, retrievable, its content the parts in the declared order.
    const content = await request(server).get(`/openai/v1/files/${file.id}/content`).set('x-test-owner', OWNER)
      .buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (x: Buffer) => c.push(x)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(content.status).toBe(200);
    expect(content.headers['content-type']).toMatch(/^text\/plain/);
    expect(Buffer.compare(content.body, whole)).toBe(0);
    const retrieved = await request(server).get(`/openai/v1/files/${file.id}`).set('x-test-owner', OWNER);
    expect(retrieved.body).toEqual(file);

    expect(await partsOf(uploadId)).toBe(0);
    expect(await refCount(sha256(whole))).toBe(1);
    expect((await pool.query('SELECT file_id FROM fs_uploads WHERE id = $1', [uploadId])).rows[0].file_id).toBe(file.id);

    // Every uploads request passed the routers' quota position exactly once.
    expect(mockQuotaPasses.filter((p) => p.includes('/uploads'))).toHaveLength(5);
  });

  it('completion reads the parts one per query, in part_ids order (one part in memory beside the file)', async () => {
    const pieces = [Buffer.from('first-'), Buffer.from('second-'), Buffer.from('third-'), Buffer.from('fourth')];
    const whole = Buffer.concat(pieces);
    const uploadId = await createFor(whole.length);
    const partIds: string[] = [];
    for (const index of [3, 1, 0, 2]) {
      // eslint-disable-next-line no-await-in-loop
      partIds[index] = (await addPart(uploadId, pieces[index])).body.id;
    }
    const querySpy = jest.spyOn(Client.prototype, 'query');
    const done = await complete(uploadId, { part_ids: partIds, md5: md5(whole) });
    expect(done.status).toBe(200);
    const dataReads = querySpy.mock.calls
      .filter(([text]) => typeof text === 'string' && /SELECT\s+(?:id,\s*)?data\s+FROM fs_upload_parts/.test(text))
      .map(([, params]) => params as unknown[]);
    // One query per part, each naming exactly that part, in the order of part_ids.
    expect(dataReads).toEqual(partIds.map((partId) => [uploadId, partId]));
    querySpy.mockRestore();
    const content = await request(server).get(`/openai/v1/files/${done.body.file.id}/content`).set('x-test-owner', OWNER)
      .buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (x: Buffer) => c.push(x)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(Buffer.compare(content.body, whole)).toBe(0);
  });

  it('expires_after applies to the completed file, as on POST /files', async () => {
    const whole = Buffer.from('expiring upload');
    const uploadId = await createFor(whole.length, { expires_after: { anchor: 'created_at', seconds: 7200 } });
    const part = await addPart(uploadId, whole);
    const done = await complete(uploadId, { part_ids: [part.body.id] });
    expect(done.status).toBe(200);
    expect(done.body.file.expires_at - done.body.file.created_at).toBe(7200);
  });

  it('a completion whose content another file has already shares the blob (dedup), like POST /files', async () => {
    const whole = Buffer.from('shared content');
    const direct = await request(server).post('/openai/v1/files').set('x-test-owner', OWNER)
      .field('purpose', 'assistants').attach('file', whole, { filename: 'a.txt', contentType: 'text/plain' });
    expect(direct.status).toBe(200);
    const uploadId = await createFor(whole.length);
    const part = await addPart(uploadId, whole);
    expect((await complete(uploadId, { part_ids: [part.body.id] })).status).toBe(200);
    expect(await refCount(sha256(whole))).toBe(2);
  });

  // --- md5 and sizes ------------------------------------------------------------------------------

  it('an md5 mismatch is a 400 that leaves the parts, and a corrected completion then succeeds', async () => {
    const whole = Buffer.from('checksum me');
    const uploadId = await createFor(whole.length);
    const part = await addPart(uploadId, whole);
    const wrong = await complete(uploadId, { part_ids: [part.body.id], md5: md5(Buffer.from('other')) });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatchObject({ type: 'invalid_request_error', code: 'md5_mismatch', param: 'md5' });
    expect(await partsOf(uploadId)).toBe(1);
    expect(await statusOf(uploadId)).toBe('pending');
    expect(await count('SELECT count(*) AS n FROM fs_files')).toBe(0);
    expect(await refCount(sha256(whole))).toBeNull();

    const malformed = await complete(uploadId, { part_ids: [part.body.id], md5: 'nothex' });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.param).toBe('md5');

    const right = await complete(uploadId, { part_ids: [part.body.id], md5: md5(whole).toUpperCase() });
    expect(right.status).toBe(200);
  });

  it('parts that do not add up to the declared bytes are a 400 that leaves the parts', async () => {
    const uploadId = await createFor(10);
    const part = await addPart(uploadId, Buffer.from('12345'));
    const res = await complete(uploadId, { part_ids: [part.body.id] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'upload_size_mismatch', param: 'part_ids' });
    expect(await partsOf(uploadId)).toBe(1);
    expect(await statusOf(uploadId)).toBe('pending');
  });

  it('refuses unknown, foreign, duplicate or missing part ids', async () => {
    const a = await createFor(3);
    const b = await createFor(3);
    const partA = await addPart(a, Buffer.from('abc'));
    const partB = await addPart(b, Buffer.from('xyz'));
    const foreign = await complete(a, { part_ids: [partB.body.id] });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toMatchObject({ code: 'invalid_part_id', param: 'part_ids' });
    expect((await complete(a, { part_ids: [partA.body.id, partA.body.id] })).body.error.param).toBe('part_ids');
    expect((await complete(a, { part_ids: [] })).status).toBe(400);
    const none = await complete(a, {});
    expect(none.status).toBe(400);
    expect(none.body.error).toMatchObject({ code: 'missing_required_parameter', param: 'part_ids' });
    expect((await complete(a, { part_ids: 'part_x' })).status).toBe(400);
    expect(await partsOf(a)).toBe(1);
    expect(await partsOf(b)).toBe(1);
  });

  // --- limits -----------------------------------------------------------------------------------

  it('a part above the part limit is a 413 naming the limit; nothing is staged', async () => {
    const uploadId = await createFor(MAX_FILE_BYTES);
    const res = await addPart(uploadId, Buffer.alloc(MAX_FILE_BYTES + 1, 0x61));
    expect(res.status).toBe(413);
    expect(res.body.error).toMatchObject({ type: 'invalid_request_error', code: 'part_too_large', param: 'data' });
    expect(res.body.error.message).toContain(`${MAX_FILE_BYTES} bytes`);
    expect(await partsOf(uploadId)).toBe(0);
    const atLimit = await addPart(uploadId, Buffer.alloc(MAX_FILE_BYTES, 0x61));
    expect(atLimit.status).toBe(200);
  });

  it('the declared bytes are bounded by the file limit, and a part may not stage more than declared', async () => {
    const tooBig = await create({ bytes: MAX_FILE_BYTES + 1, filename: 'a.txt', mime_type: 'text/plain', purpose: 'assistants' });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.error).toMatchObject({ code: 'file_too_large', param: 'bytes' });
    expect(tooBig.body.error.message).toBe(`The file exceeds the maximum allowed size of ${MAX_FILE_BYTES} bytes.`);
    for (const bytes of [0, -1, 1.5, '12']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await create({ bytes, filename: 'a.txt', mime_type: 'text/plain', purpose: 'assistants' });
      expect([bytes, res.status, res.body.error.param]).toEqual([bytes, 400, 'bytes']);
    }

    const uploadId = await createFor(4);
    expect((await addPart(uploadId, Buffer.from('abc'))).status).toBe(200);
    const over = await addPart(uploadId, Buffer.from('de'));
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe('upload_bytes_exceeded');
    expect(await partsOf(uploadId)).toBe(1);

    // The file limit lowered after the upload was created: its completion is refused.
    const part = await addPart(uploadId, Buffer.from('d'));
    mockConfig.limits.maxFileBytes = 3;
    const res = await complete(uploadId, { part_ids: [(await pool.query('SELECT id FROM fs_upload_parts WHERE upload_id = $1 AND id <> $2', [uploadId, part.body.id])).rows[0].id, part.body.id] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('file_too_large');
    expect(await partsOf(uploadId)).toBe(2);
  });

  it(`an upload accepts at most ${MAX_PARTS_PER_UPLOAD} parts`, async () => {
    const uploadId = await createFor(MAX_PARTS_PER_UPLOAD + 1);
    await pool.query(
      `INSERT INTO fs_upload_parts (id, upload_id, size_bytes, data)
       SELECT 'part_seed_' || g, $1, 1, '\\x61'::bytea FROM generate_series(1, $2) AS g`,
      [uploadId, MAX_PARTS_PER_UPLOAD]);
    const res = await addPart(uploadId, Buffer.from('a'));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('too_many_parts');
    const tooMany = await complete(uploadId, { part_ids: Array.from({ length: MAX_PARTS_PER_UPLOAD + 1 }, (_, i) => `part_seed_${i + 1}`) });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.param).toBe('part_ids');
  });

  it(`an owner may have at most ${MAX_PENDING_UPLOADS_PER_OWNER} pending uploads; another owner is not affected`, async () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_PENDING_UPLOADS_PER_OWNER; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      ids.push(await createFor(5));
    }
    const refused = await create({ bytes: 5, filename: 'a.txt', mime_type: 'text/plain', purpose: 'assistants' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('too_many_pending_uploads');
    expect((await create({ bytes: 5, filename: 'a.txt', mime_type: 'text/plain', purpose: 'assistants' }, OTHER)).status).toBe(200);
    // A cancelled one frees a slot; so does one past its deadline.
    expect((await cancel(ids[0])).status).toBe(200);
    expect((await create({ bytes: 5, filename: 'a.txt', mime_type: 'text/plain', purpose: 'assistants' })).status).toBe(200);
    await pool.query(`UPDATE fs_uploads SET expires_at = now() - interval '1 second' WHERE id = $1`, [ids[1]]);
    expect((await create({ bytes: 5, filename: 'a.txt', mime_type: 'text/plain', purpose: 'assistants' })).status).toBe(200);
  });

  it('a lapsed upload still holding parts counts toward the pending limit until the sweep deletes them', async () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_PENDING_UPLOADS_PER_OWNER; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      ids.push(await createFor(5));
    }
    await addPart(ids[0], Buffer.from('abc'));
    await pool.query(`UPDATE fs_uploads SET expires_at = now() - interval '1 second' WHERE id = $1`, [ids[0]]);
    const body = { bytes: 5, filename: 'a.txt', mime_type: 'text/plain', purpose: 'assistants' };
    const refused = await create(body);
    expect([refused.status, refused.body.error.code]).toEqual([400, 'too_many_pending_uploads']);
    expect(await sweepExpiredUploads()).toBe(1);
    expect((await create(body)).status).toBe(200);
  });

  it('concurrent creates cannot pass the pending limit', async () => {
    const results = await Promise.all(Array.from({ length: MAX_PENDING_UPLOADS_PER_OWNER + 5 }, () =>
      create({ bytes: 5, filename: 'a.txt', mime_type: 'text/plain', purpose: 'assistants' })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(MAX_PENDING_UPLOADS_PER_OWNER);
    expect(await count(`SELECT count(*) AS n FROM fs_uploads WHERE status = 'pending'`)).toBe(MAX_PENDING_UPLOADS_PER_OWNER);
  });

  // --- the same rules as POST /files ---------------------------------------------------------------

  /** The answer POST /files gives for a purpose/expires_after, next to the one POST /uploads gives. */
  async function bothAnswers(purpose: string, expiresAfter: { anchor?: string; seconds?: string } | null) {
    let direct = request(server).post('/openai/v1/files').set('x-test-owner', OWNER).field('purpose', purpose);
    if (expiresAfter?.anchor !== undefined) direct = direct.field('expires_after[anchor]', expiresAfter.anchor);
    if (expiresAfter?.seconds !== undefined) direct = direct.field('expires_after[seconds]', expiresAfter.seconds);
    const directRes = await direct.attach('file', Buffer.from('rules'), { filename: 'rules.txt', contentType: 'text/plain' });
    const jsonExpiry = expiresAfter === null ? {} : {
      expires_after: {
        ...(expiresAfter.anchor !== undefined ? { anchor: expiresAfter.anchor } : {}),
        ...(expiresAfter.seconds !== undefined ? { seconds: Number.isNaN(Number(expiresAfter.seconds)) ? expiresAfter.seconds : Number(expiresAfter.seconds) } : {}),
      },
    };
    const uploadRes = await create({ bytes: 5, filename: 'rules.txt', mime_type: 'text/plain', purpose, ...jsonExpiry });
    await pool.query('DELETE FROM fs_upload_parts');
    await pool.query('DELETE FROM fs_uploads');
    const shape = (r: request.Response) => ({ status: r.status, error: r.body.error ?? null });
    return { direct: shape(directRes), upload: shape(uploadRes) };
  }

  it.each([
    ['assistants', null], ['user_data', null], ['batch', null], ['fine-tune', null], ['vision', null], ['evals', null], ['', null],
    ['assistants', { anchor: 'created_at', seconds: '3600' }],
    ['assistants', { anchor: 'created_at', seconds: '3599' }],
    ['assistants', { anchor: 'created_at', seconds: '2592001' }],
    ['assistants', { anchor: 'created_at', seconds: 'soon' }],
    ['assistants', { anchor: 'last_active_at', seconds: '3600' }],
    ['assistants', { seconds: '3600' }],
    ['assistants', { anchor: 'created_at' }],
  ] as Array<[string, { anchor?: string; seconds?: string } | null]>)(
    'purpose %j with expires_after %j: POST /uploads answers as POST /files',
    async (purpose, expiresAfter) => {
      const { direct, upload } = await bothAnswers(purpose, expiresAfter);
      expect(upload.status).toBe(direct.status);
      expect(upload.error).toEqual(direct.error);
    },
  );

  it('refuses a filename POST /files refuses, with the same answer', async () => {
    const long = 'x'.repeat(256);
    const directRes = await request(server).post('/openai/v1/files').set('x-test-owner', OWNER).field('purpose', 'assistants')
      .attach('file', Buffer.from('n'), { filename: long, contentType: 'text/plain' });
    const uploadRes = await create({ bytes: 1, filename: long, mime_type: 'text/plain', purpose: 'assistants' });
    expect(directRes.status).toBe(400);
    expect([uploadRes.status, uploadRes.body]).toEqual([directRes.status, directRes.body]);
  });

  it('checks the required parameters and the mime_type', async () => {
    const base = { bytes: 5, filename: 'a.txt', mime_type: 'text/plain', purpose: 'assistants' };
    for (const param of Object.keys(base)) {
      const body: Record<string, unknown> = { ...base };
      delete body[param];
      // eslint-disable-next-line no-await-in-loop
      const res = await create(body);
      expect([param, res.status, res.body.error.code, res.body.error.param]).toEqual([param, 400, 'missing_required_parameter', param]);
    }
    for (const mimeType of ['', 'text', 'text/plain\nx', 'a'.repeat(300)]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await create({ ...base, mime_type: mimeType });
      expect([mimeType, res.status, res.body.error.param]).toEqual([mimeType, 400, 'mime_type']);
    }
    expect((await create({ ...base, mime_type: 'text/plain; charset=utf-8' })).status).toBe(200);
    expect((await create({ ...base, expires_after: 'soon' })).body.error.param).toBe('expires_after');
    expect((await create({ ...base, expires_after: {} })).body.error.param).toBe('expires_after.anchor');
  });

  // --- cancel, ownership, non-pending --------------------------------------------------------------

  it('cancel deletes the parts, answers the cancelled Upload, and no operation is accepted after it', async () => {
    const uploadId = await createFor(6);
    const part = await addPart(uploadId, Buffer.from('abc'));
    const res = await cancel(uploadId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: uploadId, object: 'upload', status: 'cancelled', file: null });
    expect(await partsOf(uploadId)).toBe(0);
    for (const op of [() => addPart(uploadId, Buffer.from('def')), () => complete(uploadId, { part_ids: [part.body.id] }), () => cancel(uploadId)]) {
      // eslint-disable-next-line no-await-in-loop
      const again = await op();
      expect(again.status).toBe(400);
      expect(again.body.error).toMatchObject({ type: 'invalid_request_error', code: 'upload_not_pending' });
      expect(again.body.error.message).toContain('cancelled');
    }
    expect(await partsOf(uploadId)).toBe(0);
  });

  it('a completed upload accepts no more operations', async () => {
    const uploadId = await createFor(3);
    const part = await addPart(uploadId, Buffer.from('abc'));
    expect((await complete(uploadId, { part_ids: [part.body.id] })).status).toBe(200);
    for (const op of [() => addPart(uploadId, Buffer.from('d')), () => complete(uploadId, { part_ids: [part.body.id] }), () => cancel(uploadId)]) {
      // eslint-disable-next-line no-await-in-loop
      const again = await op();
      expect([again.status, again.body.error.code]).toEqual([400, 'upload_not_pending']);
    }
    expect(await count('SELECT count(*) AS n FROM fs_files')).toBe(1);
  });

  it('another owner\'s upload answers exactly as one that does not exist', async () => {
    const uploadId = await createFor(3);
    await addPart(uploadId, Buffer.from('abc'));
    const missingId = 'upload_000000000000000000000000';
    const answer = (r: request.Response, id: string) => ({ status: r.status, body: JSON.parse(JSON.stringify(r.body).split(id).join('<id>')) });
    for (const op of [
      (id: string) => addPart(id, Buffer.from('x'), OTHER),
      (id: string) => complete(id, { part_ids: ['part_x'] }, OTHER),
      (id: string) => cancel(id, OTHER),
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const foreign = await op(uploadId);
      // eslint-disable-next-line no-await-in-loop
      const missing = await op(missingId);
      expect(foreign.status).toBe(404);
      expect(answer(foreign, uploadId)).toEqual(answer(missing, missingId));
      expect(foreign.body.error.code).toBe('upload_not_found');
    }
    expect(await partsOf(uploadId)).toBe(1);
    expect(await statusOf(uploadId)).toBe('pending');
  });

  it('refuses a NUL byte in an upload id or a part id before it reaches the database', async () => {
    expect((await request(server).post('/openai/v1/uploads/upload_a%00b/cancel').set('x-test-owner', OWNER)).status).toBe(400);
    const uploadId = await createFor(3);
    const res = await complete(uploadId, { part_ids: ['part_\u0000x'] });
    expect([res.status, res.body.error.code]).toEqual([400, 'invalid_identifier']);
  });

  // --- expiry --------------------------------------------------------------------------------------

  it('a pending upload past its hour is expired for every operation at once, and the sweep deletes its parts', async () => {
    const due = await createFor(6);
    const partDue = await addPart(due, Buffer.from('abc'));
    const live = await createFor(6);
    await addPart(live, Buffer.from('abc'));
    await pool.query(`UPDATE fs_uploads SET expires_at = now() - interval '1 second' WHERE id = $1`, [due]);

    for (const op of [() => addPart(due, Buffer.from('def')), () => complete(due, { part_ids: [partDue.body.id] }), () => cancel(due)]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await op();
      expect([res.status, res.body.error.code]).toEqual([400, 'upload_not_pending']);
      expect(res.body.error.message).toContain('expired');
    }

    expect(await sweepExpiredUploads()).toBe(1);
    expect(await statusOf(due)).toBe('expired');
    expect(await partsOf(due)).toBe(0);
    expect(await statusOf(live)).toBe('pending');
    expect(await partsOf(live)).toBe(1);
    expect(await sweepExpiredUploads()).toBe(0);
  });

  it('the sweep skips an upload another transaction holds, and takes it on the next pass', async () => {
    const due = await createFor(3);
    await addPart(due, Buffer.from('abc'));
    await pool.query(`UPDATE fs_uploads SET expires_at = now() - interval '1 second' WHERE id = $1`, [due]);
    const holder: PoolClient = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM fs_uploads WHERE id = $1 FOR UPDATE', [due]);
      expect(await sweepExpiredUploads()).toBe(0);
      await holder.query('COMMIT');
    } finally {
      holder.release();
    }
    expect(await sweepExpiredUploads()).toBe(1);
    expect(await partsOf(due)).toBe(0);
  });

  it('the sweep honours its batch limit and deletes terminal uploads after their retention', async () => {
    const ids = [await createFor(3), await createFor(3), await createFor(3)];
    await pool.query(`UPDATE fs_uploads SET expires_at = now() - interval '1 second'`);
    expect(await sweepExpiredUploads(2)).toBe(2);
    expect(await sweepExpiredUploads(2)).toBe(1);
    const old = await createFor(3);
    await cancel(old);
    await pool.query(`UPDATE fs_uploads SET created_at = now() - interval '31 days' WHERE id = ANY($1)`, [[old, ids[0]]]);
    await sweepExpiredUploads();
    expect(await count('SELECT count(*) AS n FROM fs_uploads WHERE id = ANY($1)', [[old, ids[0]]])).toBe(0);
    expect(await count('SELECT count(*) AS n FROM fs_uploads WHERE id = ANY($1)', [ids.slice(1)])).toBe(2);
  });

  it('the sweeper\'s timer tick runs the upload pass', async () => {
    const due = await createFor(3);
    await addPart(due, Buffer.from('abc'));
    await pool.query(`UPDATE fs_uploads SET expires_at = now() - interval '1 second' WHERE id = $1`, [due]);
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    startExpirySweeper();
    try {
      const tick = setIntervalSpy.mock.calls[0][0] as () => void;
      tick();
      for (let i = 0; i < 100; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        if (await statusOf(due) === 'expired') break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(await statusOf(due)).toBe('expired');
      expect(await partsOf(due)).toBe(0);
    } finally {
      stopExpirySweeper();
    }
  });

  // --- races ---------------------------------------------------------------------------------------

  it(`complete racing cancel: exactly one wins and nothing is orphaned (${RACE_ITERATIONS} iterations)`, async () => {
    const winners = { complete: 0, cancel: 0 };
    for (let i = 0; i < RACE_ITERATIONS; i += 1) {
      const whole = Buffer.from(`race-cancel-${i}-${crypto.randomBytes(4).toString('hex')}`);
      /* eslint-disable no-await-in-loop */
      const uploadId = await createFor(whole.length);
      const part = await addPart(uploadId, whole);
      // Sent in alternating order, so each side gets to arrive first.
      const [done, cancelled] = i % 2 === 0
        ? await Promise.all([complete(uploadId, { part_ids: [part.body.id] }), cancel(uploadId)])
        : (await Promise.all([cancel(uploadId), complete(uploadId, { part_ids: [part.body.id] })])).reverse();
      expect([done.status, cancelled.status].sort()).toEqual([200, 400]);
      expect(await partsOf(uploadId)).toBe(0);
      const files = await count('SELECT count(*) AS n FROM fs_files WHERE sha256 = $1', [sha256(whole)]);
      if (done.status === 200) {
        winners.complete += 1;
        expect(await statusOf(uploadId)).toBe('completed');
        expect(files).toBe(1);
        expect(await refCount(sha256(whole))).toBe(1);
      } else {
        winners.cancel += 1;
        expect(await statusOf(uploadId)).toBe('cancelled');
        expect(files).toBe(0);
        expect(await refCount(sha256(whole))).toBeNull();
      }
      /* eslint-enable no-await-in-loop */
    }
    expect(winners.complete + winners.cancel).toBe(RACE_ITERATIONS);
  }, 120_000);

  it(`complete racing complete: one file, one blob reference (${RACE_ITERATIONS} iterations)`, async () => {
    for (let i = 0; i < RACE_ITERATIONS; i += 1) {
      const whole = Buffer.from(`race-double-${i}-${crypto.randomBytes(4).toString('hex')}`);
      /* eslint-disable no-await-in-loop */
      const uploadId = await createFor(whole.length);
      const part = await addPart(uploadId, whole);
      const results = await Promise.all([complete(uploadId, { part_ids: [part.body.id] }), complete(uploadId, { part_ids: [part.body.id] })]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
      expect(results.find((r) => r.status === 400)!.body.error.code).toBe('upload_not_pending');
      expect(await count('SELECT count(*) AS n FROM fs_files WHERE sha256 = $1', [sha256(whole)])).toBe(1);
      expect(await refCount(sha256(whole))).toBe(1);
      expect(await partsOf(uploadId)).toBe(0);
      /* eslint-enable no-await-in-loop */
    }
  }, 120_000);

  it('a completion that fails after the blob retain rolls back everything: no file, no blob reference, parts kept', async () => {
    const whole = Buffer.from('rolled back');
    const uploadId = await createFor(whole.length);
    const part = await addPart(uploadId, whole);
    // Make the fs_files insert fail inside the completion's transaction.
    await pool.query(`ALTER TABLE fs_files ADD CONSTRAINT w10t3_no_insert CHECK (filename <> 'notes.txt') NOT VALID`);
    try {
      const res = await complete(uploadId, { part_ids: [part.body.id] });
      expect(res.status).toBe(500);
    } finally {
      await pool.query('ALTER TABLE fs_files DROP CONSTRAINT w10t3_no_insert');
    }
    expect(await statusOf(uploadId)).toBe('pending');
    expect(await partsOf(uploadId)).toBe(1);
    expect(await refCount(sha256(whole))).toBeNull();
    expect((await complete(uploadId, { part_ids: [part.body.id] })).status).toBe(200);
  });
});
