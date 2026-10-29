// Document vectors travel as Float32Array from the embedder to the commit (embedder.ts DocumentVector).
// pgvector's `vector` stores float4, so the conversion loses nothing that was stored before: the same
// SAP-shaped doubles written through insertChunkRows as numbers (before) and as Float32Array (now)
// store identical vectors, and reading them back gives exactly the float32 values.
import { createIsolatedSchema, IsolatedSchema } from './schemaFixture';
import { insertChunkRows } from '../../../src/fileSearch/chunkRows';

const DSN = process.env.FILE_SEARCH_TEST_DSN;
const d = DSN ? describe : describe.skip;
const DIM = 1536;

/** Deterministic doubles shaped like an embedding (unit-ish, many significant digits, a few extremes). */
function vectors(count: number): number[][] {
  let seed = 12345;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  return Array.from({ length: count }, (_, v) => Array.from({ length: DIM }, (__, i) => {
    if (v === 0 && i < 6) return [0, -0, 1e-30, -1.5, 0.1, 1 / 3][i];
    return (next() - 0.5) * 0.08;
  }));
}

d('document vectors as float32 (requires FILE_SEARCH_TEST_DSN)', () => {
  let fixture: IsolatedSchema;

  beforeAll(async () => {
    fixture = await createIsolatedSchema(DSN!, DIM);
    await fixture.pool.query(`INSERT INTO vector_stores (id, owner_email, embedding_model, embedding_dim) VALUES ('vs', 'o@example.test', 'm', ${DIM})`);
  });

  afterAll(async () => {
    await fixture.teardown();
  });

  it('stores exactly what the number arrays stored: identical vectors, read back as the float32 values', async () => {
    const source = vectors(200);
    const row = (ord: number, vector: Float32Array | number[]) => ({
      ord, text: `chunk ${ord}`, tokens: 2, vector, context: null, section: null, sectionOffset: null, headingPath: null,
      pageStart: null, pageEnd: null,
    });
    const client = await fixture.pool.connect();
    try {
      await insertChunkRows(client, 'vs', 'numbers', 0, source.map((v, i) => row(i, v)));
      await insertChunkRows(client, 'vs', 'float32', 0, source.map((v, i) => row(i, Float32Array.from(v))));
    } finally {
      client.release();
    }
    const { rows } = await fixture.pool.query(
      `SELECT a.ord, a.embedding = b.embedding AS same, b.embedding::text AS stored
         FROM vector_store_chunks a JOIN vector_store_chunks b ON b.ord = a.ord AND b.file_id = 'float32'
        WHERE a.file_id = 'numbers' ORDER BY a.ord`);
    expect(rows).toHaveLength(200);
    expect(rows.every((r) => r.same === true)).toBe(true);
    // pgvector prints the shortest text of each float4; parsed back as float32 it is the very value sent.
    for (const r of rows) {
      const back = Float32Array.from(JSON.parse(r.stored) as number[]);
      const sent = Float32Array.from(source[r.ord]);
      expect(back.length).toBe(DIM);
      expect(back.every((x, i) => x === sent[i])).toBe(true);
    }
  }, 60_000);
});
