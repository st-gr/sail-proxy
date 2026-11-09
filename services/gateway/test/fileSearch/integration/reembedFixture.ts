// Seeding helpers shared by the re-embed suites (reembed.test.ts,
// reembedConcurrency.test.ts). The fake embedder these suites install answers
// every text with ONE vector per model, orthogonal across models, so a vector
// written or compared with the wrong model is visible: within a model the
// cosine distance is 0, across models it is 1.
import * as crypto from 'crypto';
import { Pool } from 'pg';

export const EMBED_DIM = 3;

export const MODEL_VECTOR: Readonly<Record<string, number[]>> = {
  'model-a': [1, 0, 0],
  'model-b': [0, 1, 0],
  'model-c': [0, 0, 1],
};

export function vectorOf(model: string): number[] {
  const v = MODEL_VECTOR[model];
  if (!v) throw new Error(`fake embedder: no vector for model ${model}`);
  return v;
}

/** The model a stored vector (pgvector text form) was embedded with. */
export function modelOfVector(text: string): string {
  const v = JSON.parse(text) as number[];
  const hit = Object.entries(MODEL_VECTOR).find(([, m]) => m.every((x, i) => Math.abs(x - v[i]) < 1e-6));
  return hit ? hit[0] : `unknown:${text}`;
}

const hex = (n: number) => crypto.randomBytes(n).toString('hex');

export interface SeedStoreOptions {
  owner: string;
  model: string;
  dim?: number;
  status?: string;
  files?: number;
  chunksPerFile?: number;
  tokensPerChunk?: number;
  /** Text inserted into the chunk text of file `poisonFile` (0-based), for a
   *  fake embedder that fails on it. */
  poisonFile?: number;
}

export interface SeededStore {
  storeId: string;
  fileIds: string[];
}

/** A store on `model` with `files` completed files of `chunksPerFile` chunks in
 *  generation 0, each chunk embedded with `model`. */
export async function seedStore(pool: Pool, opts: SeedStoreOptions): Promise<SeededStore> {
  const storeId = `vs_${hex(12)}`;
  await pool.query(
    `INSERT INTO vector_stores (id, owner_email, embedding_model, embedding_dim, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [storeId, opts.owner, opts.model, opts.dim ?? EMBED_DIM, opts.status ?? 'completed']);
  const fileIds: string[] = [];
  for (let f = 0; f < (opts.files ?? 0); f += 1) {
    // eslint-disable-next-line no-await-in-loop
    const fileId = await seedFile(pool, opts.owner);
    // eslint-disable-next-line no-await-in-loop
    await pool.query(`INSERT INTO vector_store_files (store_id, file_id, status) VALUES ($1, $2, 'completed')`,
      [storeId, fileId]);
    for (let ord = 0; ord < (opts.chunksPerFile ?? 2); ord += 1) {
      const poison = opts.poisonFile === f ? ' poison' : '';
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `INSERT INTO vector_store_chunks (store_id, file_id, generation, ord, text, tokens, embedding)
         VALUES ($1, $2, 0, $3, $4, $5, $6::vector)`,
        [storeId, fileId, ord, `${fileId} chunk ${ord}${poison}`, opts.tokensPerChunk ?? 3,
          `[${vectorOf(opts.model).join(',')}]`]);
    }
    fileIds.push(fileId);
  }
  return { storeId, fileIds };
}

/** An fs_files row (and its blob row) of `owner`, attached nowhere. */
export async function seedFile(pool: Pool, owner: string): Promise<string> {
  const fileId = `file-${hex(12)}`;
  const sha = crypto.createHash('sha256').update(fileId).digest('hex');
  await pool.query(`INSERT INTO file_blobs (sha256, size_bytes, storage, ref_count) VALUES ($1, 1, 'db', 1)`, [sha]);
  await pool.query(
    `INSERT INTO fs_files (id, owner_email, filename, purpose, sha256, size_bytes)
     VALUES ($1, $2, 'doc.txt', 'assistants', $3, 1)`, [fileId, owner, sha]);
  return fileId;
}

export interface ChunkRow {
  file_id: string;
  generation: number;
  ord: number;
  text: string;
  model: string;
}

export async function chunksOf(pool: Pool, storeId: string): Promise<ChunkRow[]> {
  const { rows } = await pool.query(
    `SELECT file_id, generation, ord, text, embedding::text AS e FROM vector_store_chunks
      WHERE store_id = $1 ORDER BY generation, file_id, ord`, [storeId]);
  return rows.map((r) => ({ file_id: r.file_id, generation: r.generation, ord: r.ord, text: r.text, model: modelOfVector(r.e) }));
}

export async function storeRow(pool: Pool, storeId: string): Promise<any> {
  const { rows } = await pool.query(
    'SELECT embedding_model, embedding_dim, active_generation, status FROM vector_stores WHERE id = $1', [storeId]);
  return rows[0];
}

export async function jobRow(pool: Pool, jobId: string): Promise<any> {
  const { rows } = await pool.query('SELECT * FROM fs_jobs WHERE id = $1', [jobId]);
  return rows[0];
}

export async function itemsOf(pool: Pool, jobId: string): Promise<Array<{ file_id: string; status: string; attempts: number }>> {
  const { rows } = await pool.query(
    'SELECT file_id, status, attempts FROM fs_reembed_items WHERE job_id = $1 ORDER BY file_id', [jobId]);
  return rows;
}
