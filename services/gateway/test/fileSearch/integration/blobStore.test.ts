import * as crypto from 'crypto';
import { Pool } from 'pg';
import { getPool, __resetForTests } from '../../../src/fileSearch/db';
import { retainBlob, releaseBlob } from '../../../src/fileSearch/blob/blobStore';
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;

function sha256Of(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

d('blob store refcounting (requires FILE_SEARCH_TEST_DSN pointing at pgvector)', () => {
  let fixture: IsolatedSchema;
  let pool: Pool;

  beforeAll(async () => {
    fixture = await createIsolatedSchema(DSN!, 1536);
    // blobStore.ts (the code under test) reaches the database through
    // src/fileSearch/db.ts's getPool() singleton, which builds its own Pool
    // from this env var rather than accepting one — point it at the isolated
    // schema the same way the fixture's own pool is scoped.
    process.env.FILE_SEARCH_DATABASE_URL = fixture.dsn;
    __resetForTests();
    pool = getPool()!;
  });

  afterAll(async () => {
    __resetForTests();
    await pool.end();
    delete process.env.FILE_SEARCH_DATABASE_URL;
    await fixture.teardown();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM file_blobs');
  });

  it('writes physical bytes and sets ref_count=1 on first retain', async () => {
    const bytes = Buffer.from('integration-test-bytes-1');
    const sha = sha256Of(bytes);
    const { deduplicated } = await retainBlob(sha, bytes, 'text/plain');
    expect(deduplicated).toBe(false);
    const { rows } = await pool.query('SELECT ref_count, bytes FROM file_blobs WHERE sha256=$1', [sha]);
    expect(rows[0].ref_count).toBe(1);
    expect(Buffer.from(rows[0].bytes).equals(bytes)).toBe(true);
  });

  it('increments ref_count and reports deduplicated on a second retain of the same content', async () => {
    const bytes = Buffer.from('integration-test-bytes-2');
    const sha = sha256Of(bytes);
    await retainBlob(sha, bytes, 'text/plain');
    const second = await retainBlob(sha, bytes, 'text/plain');
    expect(second.deduplicated).toBe(true);
    const { rows } = await pool.query('SELECT ref_count FROM file_blobs WHERE sha256=$1', [sha]);
    expect(rows[0].ref_count).toBe(2);
  });

  it('does not lose an update when two uploads of brand-new identical content race', async () => {
    // Two concurrent first-time retains of the same never-before-seen content.
    // The row lock only protects existing rows, so this exercises the
    // INSERT ... ON CONFLICT DO UPDATE safety net for the phantom-row case:
    // whichever commits second must still land on ref_count=2, never 1
    // (a lost update) and never throw.
    const bytes = Buffer.from('integration-test-bytes-concurrent');
    const sha = sha256Of(bytes);
    await expect(Promise.all([
      retainBlob(sha, bytes, 'text/plain'),
      retainBlob(sha, bytes, 'text/plain'),
    ])).resolves.toBeDefined();
    const { rows } = await pool.query('SELECT ref_count FROM file_blobs WHERE sha256=$1', [sha]);
    expect(rows[0].ref_count).toBe(2);
  });

  it('decrements ref_count without removing bytes while another owner remains', async () => {
    const bytes = Buffer.from('integration-test-bytes-3');
    const sha = sha256Of(bytes);
    await retainBlob(sha, bytes, 'text/plain');
    await retainBlob(sha, bytes, 'text/plain');
    const { removed } = await releaseBlob(sha);
    expect(removed).toBe(false);
    const { rows } = await pool.query('SELECT ref_count, bytes FROM file_blobs WHERE sha256=$1', [sha]);
    expect(rows[0].ref_count).toBe(1);
    expect(rows[0].bytes).not.toBeNull();
  });

  it('removes the row and bytes once the last owner releases', async () => {
    const bytes = Buffer.from('integration-test-bytes-4');
    const sha = sha256Of(bytes);
    await retainBlob(sha, bytes, 'text/plain');
    const { removed } = await releaseBlob(sha);
    expect(removed).toBe(true);
    const { rows } = await pool.query('SELECT * FROM file_blobs WHERE sha256=$1', [sha]);
    expect(rows.length).toBe(0);
  });

  it('releasing an unknown sha256 is a no-op, not an error', async () => {
    const { removed } = await releaseBlob('f'.repeat(64));
    expect(removed).toBe(false);
  });
});
