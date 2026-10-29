// The one statement that writes chunk rows, used by ingestion (commitChunks)
// and the re-embed (commitItem). `context_tsv` is not a generated column (adding
// one rewrites the table), so it is written here, always as
// to_tsvector('simple', context) — the same configuration as `tsv` — and
// nowhere else: a context and its tsvector cannot disagree.
import type { PoolClient } from 'pg';

export interface ChunkRow {
  ord: number;
  text: string;
  tokens: number | null;
  /** Null for a chunk that is not embedded (only whitespace); such a row is never a search hit.
   *  Float32Array from the embedder (lossless for the float4 `vector` column), or numbers. */
  vector: Float32Array | number[] | null;
  context: string | null;
  section: number | null;
  sectionOffset: number | null;
  headingPath: string | null;
  /** Paged formats only (else null): the pages of the chunk's first and last character. */
  pageStart: number | null;
  pageEnd: number | null;
}

/** A chunk of only whitespace: stored (its section's rebuild needs it), never embedded. */
export const isBlank = (text: string): boolean => !/\S/.test(text);

/** What a chunk is embedded with: its context and text, or its text alone; null = not embedded
 *  (a chunk of only whitespace). Used by ingestion and by the re-embed of stored chunks alike. */
export function embeddingInputOf(chunk: { text: string; context?: string | null }): string | null {
  if (isBlank(chunk.text)) return null;
  return chunk.context ? `${chunk.context}\n\n${chunk.text}` : chunk.text;
}

/** Rows per INSERT: bounds one statement's parameter size (each vector travels as text). */
const ROWS_PER_STATEMENT = 500;

export const INSERT_CHUNK_ROWS_SQL = `INSERT INTO vector_store_chunks
       (store_id, file_id, generation, ord, text, tokens, embedding, context, context_tsv, section, section_offset, heading_path,
        page_start, page_end)
     SELECT $1, $2, $3, u.ord, u.text, u.tokens, u.embedding::vector,
            u.context, to_tsvector('simple', u.context), u.section, u.section_offset, u.heading_path,
            u.page_start, u.page_end
       FROM unnest($4::int[], $5::text[], $6::int[], $7::text[], $8::text[], $9::int[], $10::int[], $11::text[],
                   $12::int[], $13::int[])
            AS u(ord, text, tokens, embedding, context, section, section_offset, heading_path, page_start, page_end)`;

/** Inserts `rows` into one generation of one file, inside the caller's transaction. */
export async function insertChunkRows(
  client: Pick<PoolClient, 'query'>, storeId: string, fileId: string, generation: number, rows: ChunkRow[],
): Promise<void> {
  for (let from = 0; from < rows.length; from += ROWS_PER_STATEMENT) {
    const slice = rows.slice(from, from + ROWS_PER_STATEMENT);
    // eslint-disable-next-line no-await-in-loop
    await client.query(INSERT_CHUNK_ROWS_SQL, [
      storeId, fileId, generation,
      slice.map((r) => r.ord),
      slice.map((r) => r.text),
      slice.map((r) => r.tokens),
      slice.map((r) => (r.vector ? `[${r.vector.join(',')}]` : null)),
      slice.map((r) => r.context),
      slice.map((r) => r.section),
      slice.map((r) => r.sectionOffset),
      slice.map((r) => r.headingPath),
      slice.map((r) => r.pageStart),
      slice.map((r) => r.pageEnd),
    ]);
  }
}
