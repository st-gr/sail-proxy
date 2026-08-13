// The single most valuable test in this plan: the full deliverable, proven
// against a real Postgres/pgvector database. Upload a .md file, create a
// vector store, attach the file, wait for ingestion to reach status
// completed, search for a phrase unique to the document, and assert the
// planted chunk comes back with a score.
//
// embed() and rerank() reach SAP AI Core over the network — out of scope for
// a live-Postgres-only test. embed() is mocked with a deterministic vector
// assignment (the chunk containing the planted phrase gets a distinct
// vector from every other chunk; the query for that same phrase embeds to
// the identical vector), and hybrid.rerank.enabled: false exercises the
// REAL reranker.ts degrade path — no deployment discovery call, no network,
// see reranker.ts's own doc comment — rather than mocking the reranker
// module away. Everything else is real: extraction (.md is a direct
// in-process decode, no subprocess), chunking, the ingestion worker's
// claim/commit transaction, hybrid recall (real pgvector cosine ranking
// fused via RRF with a real Postgres full-text ranking), and search.ts's
// own ownership check and activity-touching logic.
import * as crypto from 'crypto';
import { Readable } from 'stream';
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import * as filesController from '../../../src/controllers/filesController';
import * as vectorStoresController from '../../../src/controllers/vectorStoresController';
import { processOne } from '../../../src/fileSearch/ingestWorker';
import { searchVectorStores } from '../../../src/fileSearch/search';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

const EMBED_DIM = 3;
const UNIQUE_PHRASE = 'the zorbaxian quokka migrates biannually beneath the aurora';

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
  // search.ts's real (non-mocked) teacherLogger.record() reads this on
  // every search; without it, record()'s config lookup throws "is not a
  // function" and every search logs a WARN. Kept disabled here: this suite
  // exercises search.ts's own real-Postgres wiring, not the teacher-logging
  // write path (that's covered by teacherLogger.test.ts and search.test.ts).
  getTeacherLoggingConfig: () => ({
    enabled: false, storeChunkText: false, sampleRate: 1, source: 'test', maxConcurrentWrites: 5,
  }),
  // reranker.ts imports the default export (mirroring searchExecutor.ts's
  // own style) rather than the named getFileSearchConfig above — hybrid.
  // rerank.enabled: false short-circuits before this real reranker.ts code
  // ever needs getSAPAICoreConfig/getAccessToken, so only this one method
  // needs to be present here.
  default: { getFileSearchConfig: () => mockConfig },
}));

jest.mock('../../../src/fileSearch/embedder', () => ({
  __esModule: true,
  embed: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { embed } = require('../../../src/fileSearch/embedder');

/** The chunk (or query) containing the planted phrase gets a distinct,
 *  identical-across-calls vector from everything else — deterministic
 *  stand-in for "semantically similar", entirely sufficient to prove
 *  end-to-end wiring without a real embedding model. */
function fakeEmbedding(text: string): number[] {
  return text.includes(UNIQUE_PHRASE) ? [1, 0, 0] : [0, 1, 0];
}

// ---------------------------------------------------------------------------
// Minimal fake Express req/res — same shape every other integration suite in
// this directory uses.
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
  return { headers: {}, params: {}, query: {}, body: {}, apiKeyInfo: { email }, ...overrides };
}

const throwOnError = (e: any) => { throw e; };

function buildMultipartBody(boundary: string, opts: { filename: string; content: Buffer; purpose?: string | null }): Buffer {
  const parts: Buffer[] = [];
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${opts.filename}"\r\n` +
    `Content-Type: text/markdown\r\n\r\n`, 'latin1'));
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
  await filesController.uploadFile(req, res, throwOnError);
  return res;
}

const DISTRACTOR_PARAGRAPHS = [
  'Quarterly revenue figures show a modest increase across every regional division, driven mostly by renewed subscription contracts and a handful of enterprise renewals signed late in the reporting period under review.',
  'The facilities team completed routine maintenance on the north wing elevators and replaced several aging light fixtures throughout the building over the long holiday weekend without incident.',
  'Meeting minutes from the planning committee note ongoing discussion about parking allocation, cafeteria vendor contracts, and the proposed relocation of the mailroom to the second floor next quarter.',
  'A new onboarding checklist was circulated to department heads, covering badge issuance, laptop provisioning, and the mandatory security awareness training module every new hire must complete promptly.',
  'The marketing team is finalizing creative assets for the upcoming trade show booth, including banners, printed brochures, and a short looping product demonstration video for attendees.',
];

function buildDocument(): Buffer {
  const paragraphs = [
    ...DISTRACTOR_PARAGRAPHS.slice(0, 2),
    `${UNIQUE_PHRASE}, according to the expedition log recovered from the research station.`,
    ...DISTRACTOR_PARAGRAPHS.slice(2),
  ];
  return Buffer.from(`# Field notes\n\n${paragraphs.join('\n\n')}\n`, 'utf8');
}

d('file_search end-to-end (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;

  beforeAll(async () => {
    mockConfig = {
      enabled: true,
      embeddingModel: 'test-model',
      embeddingDimensions: EMBED_DIM,
      rewriteQuery: false, // exercised separately in search.test.ts; no network rewrite call here
      hybrid: { rrfK: 60, lexicalEnabled: true, candidates: 50, rerank: { enabled: false, model: 'unused' } },
      chunking: { maxChunkSizeTokens: 800, chunkOverlapTokens: 400 },
      limits: { maxFileBytes: 33554432, maxTokensPerFile: 5000000, maxFilesPerStore: 10000 },
      ingestion: { concurrency: 4, extractTimeoutMs: 60000, maxRetries: 3 },
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
    embed.mockReset();
    embed.mockImplementation(async (texts: string[]) => ({
      vectors: texts.map(fakeEmbedding),
      usage: { promptTokens: texts.length, totalTokens: texts.length },
    }));
    await pool.query('DELETE FROM vector_store_chunks');
    await pool.query('DELETE FROM vector_store_files');
    await pool.query('DELETE FROM vector_stores');
    await pool.query('DELETE FROM fs_files');
    await pool.query('DELETE FROM file_blobs');
  });

  it('upload -> create store -> attach -> ingest -> search returns the planted chunk with a score', async () => {
    const owner = 'e2e@example.com';

    // 1. Upload a .md file with the unique phrase buried among distractor
    // paragraphs.
    const uploadRes = await uploadFile(owner, 'field-notes.md', buildDocument());
    expect(uploadRes.statusCode).toBe(200);
    const fileId = uploadRes.body.id;

    // 2. Create an empty store.
    const createRes = makeRes();
    await vectorStoresController.createVectorStore(baseReq(owner, { body: { name: 'e2e store' } }), createRes, throwOnError);
    expect(createRes.statusCode).toBe(200);
    const storeId = createRes.body.id;
    const createdAtLastActive: number = createRes.body.last_active_at;

    // 3. Attach the file, forcing a small static chunk size so the short
    // document genuinely splits into multiple chunks — proving retrieval
    // discriminates the planted chunk from its neighbours, not merely
    // returning "the only chunk there is".
    const attachRes = makeRes();
    await vectorStoresController.createVectorStoreFile(
      baseReq(owner, {
        params: { id: storeId },
        body: { file_id: fileId, chunking_strategy: { type: 'static', static: { max_chunk_size_tokens: 100, chunk_overlap_tokens: 20 } } },
      }),
      attachRes, throwOnError,
    );
    expect(attachRes.statusCode).toBe(200);
    expect(attachRes.body.status).toBe('in_progress');

    // 4. Run ingestion directly — processOne is safe to call on a
    // freshly-attached row (see ingestWorker.ts's own doc comment) and
    // avoids depending on the polling loop's timing in a test.
    await processOne(storeId, fileId);

    const fileStatusRes = makeRes();
    await vectorStoresController.retrieveVectorStoreFile(
      baseReq(owner, { params: { id: storeId, file_id: fileId } }), fileStatusRes, throwOnError,
    );
    expect(fileStatusRes.statusCode).toBe(200);
    expect(fileStatusRes.body.status).toBe('completed');

    const { rows: chunkCountRows } = await pool.query('SELECT COUNT(*)::int AS n FROM vector_store_chunks WHERE store_id=$1', [storeId]);
    expect(chunkCountRows[0].n).toBeGreaterThan(1); // genuinely multiple chunks, not a trivial single-chunk case

    // 5. Search for the unique phrase and get the planted chunk back with a
    // score — the proof this plan's deliverable actually works.
    const result = await searchVectorStores({
      storeIds: [storeId],
      query: UNIQUE_PHRASE,
      ownerEmail: owner,
    });

    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data[0].fileId).toBe(fileId);
    expect(result.data[0].filename).toBe('field-notes.md');
    expect(result.data[0].content[0].text).toContain(UNIQUE_PHRASE);
    expect(typeof result.data[0].score).toBe('number');
    expect(Number.isFinite(result.data[0].score)).toBe(true);
    expect(result.mode).toBe('rrf_only'); // hybrid.rerank.enabled: false
    expect(result.searchQuery).toBe(UNIQUE_PHRASE);
    expect(result.object).toBe('vector_store.search_results.page');

    // last_active_at was touched by the search itself (the anchor-sliding fix).
    const { rows: storeRows } = await pool.query('SELECT last_active_at FROM vector_stores WHERE id=$1', [storeId]);
    expect(storeRows[0].last_active_at.getTime()).toBeGreaterThan(createdAtLastActive * 1000);

    // And the same search reachable through the HTTP endpoint returns the
    // OpenAI page shape with no internal `mode` field on the wire.
    const searchRes = makeRes();
    await vectorStoresController.searchVectorStore(
      baseReq(owner, { params: { id: storeId }, body: { query: UNIQUE_PHRASE } }), searchRes, throwOnError,
    );
    expect(searchRes.statusCode).toBe(200);
    expect(searchRes.body.object).toBe('vector_store.search_results.page');
    expect(searchRes.body).not.toHaveProperty('mode');
    expect(searchRes.body.data[0].content[0].text).toContain(UNIQUE_PHRASE);
  });

  it('a store the caller does not own 404s from search, even though the store and its chunks genuinely exist', async () => {
    const owner = 'e2e-owner@example.com';
    const attacker = 'e2e-attacker@example.com';

    const uploadRes = await uploadFile(owner, 'private.md', Buffer.from(`# Notes\n\n${UNIQUE_PHRASE}\n`, 'utf8'));
    const fileId = uploadRes.body.id;

    const createRes = makeRes();
    await vectorStoresController.createVectorStore(baseReq(owner, { body: { name: 'private store' } }), createRes, throwOnError);
    const storeId = createRes.body.id;

    await vectorStoresController.createVectorStoreFile(
      baseReq(owner, { params: { id: storeId }, body: { file_id: fileId } }), makeRes(), throwOnError,
    );
    await processOne(storeId, fileId);

    await expect(searchVectorStores({ storeIds: [storeId], query: UNIQUE_PHRASE, ownerEmail: attacker }))
      .rejects.toMatchObject({ status: 404 });

    const searchRes = makeRes();
    await vectorStoresController.searchVectorStore(
      baseReq(attacker, { params: { id: storeId }, body: { query: UNIQUE_PHRASE } }), searchRes, throwOnError,
    );
    expect(searchRes.statusCode).toBe(404);
    expect(searchRes.body.error.code).toBe('vector_store_not_found');
  });

  // Final whole-branch review, Critical #1. Endpoint-level regression guard
  // for repository.ts's queryText NUL-byte check: reproduced live, pre-fix,
  // as `POST /vector_stores/{id}/search {"query":"a<NUL>b"}` against this
  // exact default configuration (hybrid.lexicalEnabled: true) throwing a raw
  // `[22021] invalid byte sequence for encoding "UTF8": 0x00` out of
  // pool.query, caught by nothing, surfacing as a 500 with the driver's own
  // message in the response body (errorHandler.ts echoes `err.message`
  // verbatim). Asserts both the status AND that no driver-string fragment
  // reaches the client.
  it('a NUL byte in the search query 400s instead of leaking a raw Postgres driver string', async () => {
    const owner = 'e2e-nul-byte@example.com';

    const createRes = makeRes();
    await vectorStoresController.createVectorStore(
      baseReq(owner, { body: { name: 'nul-byte-query store' } }), createRes, throwOnError,
    );
    expect(createRes.statusCode).toBe(200);
    const storeId = createRes.body.id;

    const searchRes = makeRes();
    await vectorStoresController.searchVectorStore(
      baseReq(owner, { params: { id: storeId }, body: { query: `a${String.fromCharCode(0)}b` } }),
      searchRes, throwOnError, // throwOnError would surface an unmapped error as a thrown exception, not a 500 body -- either way, this must never happen
    );

    expect(searchRes.statusCode).toBe(400);
    expect(searchRes.body.error.message).toMatch(/NUL byte/i);
    const rawBody = JSON.stringify(searchRes.body);
    expect(rawBody).not.toMatch(/22021/);
    expect(rawBody).not.toMatch(/invalid byte sequence/i);
    expect(rawBody).not.toMatch(/utf8/i);
    expect(rawBody).not.toMatch(/postgres/i);
  });
});
