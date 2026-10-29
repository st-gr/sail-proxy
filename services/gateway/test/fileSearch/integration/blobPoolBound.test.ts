// A slow S3 cannot exhaust the file_search pool: uploads of new content PUT inside their
// transaction, but at most S3_SLOTS of them hold a connection at once (the slot is taken before
// the connection), so search and list queries still get one. Real Postgres, a fake S3 backend
// whose PUTs hang until the test lets them go.
import * as crypto from 'crypto';
import { Pool } from 'pg';
import { getPool, runMigration, __resetForTests } from '../../../src/fileSearch/db';
import { retainBlob, sha256Of, setBlobS3CredentialsForTests, BlobUnavailableError } from '../../../src/fileSearch/blob/blobStore';
import { S3_SLOTS, s3SlotStateForTests } from '../../../src/fileSearch/blob/s3Slots';
import * as filesController from '../../../src/controllers/filesController';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

let mockConfig: any;
jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

const held: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
const fakeS3 = {
  put: jest.fn((sha: string) => new Promise<{ location: string }>((resolve, reject) => {
    held.push({ resolve: () => resolve({ location: `blobs/${sha.slice(0, 2)}/${sha}` }), reject });
  })),
  get: jest.fn(async () => null),
  delete: jest.fn(async () => undefined),
  exists: jest.fn(async () => false),
};
jest.mock('../../../src/fileSearch/blob/s3Backend', () => {
  const actual: any = jest.requireActual('../../../src/fileSearch/blob/s3Backend');
  return { ...actual, createS3Backend: () => fakeS3 };
});

const POOL_MAX = 10; // getPool()'s size
const UPLOADS = POOL_MAX + 4;

function freshContent(i: number): { bytes: Buffer; sha: string } {
  const bytes = Buffer.concat([Buffer.from(`pool-bound-${i}:`), crypto.randomBytes(64)]);
  return { bytes, sha: sha256Of(bytes) };
}

async function until(cond: () => boolean, ms = 15000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not reached');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Rejects if `p` takes longer than `ms`: a starved pool would make it wait 15 s for the connect timeout. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_r, reject) => setTimeout(() => reject(new Error(`took over ${ms} ms`)), ms))]);
}

d('S3 work under a connection is bounded (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;

  beforeAll(async () => {
    mockConfig = {
      enabled: true,
      embeddingModel: 'test-model',
      embeddingDimensions: 3,
      limits: { maxFilesPerStore: 10000, maxFileBytes: 1024 * 1024 },
      blobStorage: { backend: 's3', localPath: '', s3: { bucket: 'pool-bound', prefix: 'blobs', endpoint: 'http://127.0.0.1:1', region: 'us-east-1' } },
    };
    setBlobS3CredentialsForTests({ accessKeyId: 'fake-test-key', secretAccessKey: 'fake-test-secret' });
    fixture = await createIsolatedSchema(DSN!, 3);
    process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
    __resetForTests();
    await runMigration();
    pool = getPool()!;
  });

  afterAll(async () => {
    for (const h of held.splice(0)) h.resolve();
    setBlobS3CredentialsForTests(null);
    __resetForTests();
    await pool.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await fixture.teardown();
  });

  it(`${UPLOADS} concurrent uploads of new content against a hanging S3 leave connections for search and list`, async () => {
    const contents = Array.from({ length: UPLOADS }, (_v, i) => freshContent(i));
    let settled = 0;
    const retains = contents.map((c) => {
      const p = retainBlob(c.sha, c.bytes, 'text/plain');
      p.finally(() => { settled += 1; }).catch(() => undefined);
      return p;
    });
    await until(() => held.length === S3_SLOTS);
    await new Promise((r) => setTimeout(r, 100)); // nothing else gets to S3 meanwhile
    expect(held.length).toBe(S3_SLOTS);
    expect(s3SlotStateForTests().waiting).toBe(UPLOADS - S3_SLOTS);
    expect(pool.totalCount - pool.idleCount).toBeLessThanOrEqual(S3_SLOTS);

    // A plain query, and the files list as the API serves it, both answer at once.
    await within(pool.query('SELECT count(*) FROM fs_files'), 5000);
    const listed = await within(new Promise<{ status: number; body: any }>((resolve, reject) => {
      const res: any = {
        statusCode: 200,
        status(code: number) { this.statusCode = code; return this; },
        json(body: unknown) { resolve({ status: this.statusCode, body }); return this; },
      };
      filesController.listFiles({ apiKeyInfo: { email: 'owner@example.com' }, query: {} } as any, res, reject);
    }), 5000);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual([]);

    // Let the PUTs go: every upload completes, never more than S3_SLOTS at a time. Loop until every
    // retain has settled, not until `held` is empty: a released slot passes straight to the next
    // waiter, whose upload still has to connect, BEGIN and INSERT before its PUT reaches `held`.
    const deadline = Date.now() + 20000;
    while (settled < UPLOADS) {
      if (Date.now() > deadline) throw new Error(`only ${settled} of ${UPLOADS} uploads settled`);
      expect(held.length).toBeLessThanOrEqual(S3_SLOTS);
      for (const h of held.splice(0)) h.resolve();
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 20));
    }
    const results = await Promise.all(retains);
    expect(results.every((r) => r.deduplicated === false)).toBe(true);
    expect(fakeS3.put).toHaveBeenCalledTimes(UPLOADS);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM file_blobs WHERE sha256 = ANY($1)', [contents.map((c) => c.sha)]);
    expect(rows[0].n).toBe(UPLOADS);
    expect(s3SlotStateForTests()).toEqual({ free: S3_SLOTS, waiting: 0 });
  }, 60000);

  it('a failing PUT releases its slot and its connection', async () => {
    const c = freshContent(999);
    const retain = retainBlob(c.sha, c.bytes, 'text/plain').catch((e) => e);
    await until(() => held.length === 1);
    held.splice(0)[0].reject(new Error('socket hang up'));
    expect(await retain).toBeInstanceOf(BlobUnavailableError);
    expect(s3SlotStateForTests()).toEqual({ free: S3_SLOTS, waiting: 0 });
    expect(pool.totalCount - pool.idleCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM file_blobs WHERE sha256 = $1', [c.sha])).rowCount).toBe(0);
  });
});
