/**
 * The approximate-search (HNSW) index on vector_store_chunks: its definition, how to recognise which kind an
 * install has, and the rough size and build time the rebuild command prints before it builds.
 *
 * Two kinds exist under the one name `idx_chunks_hnsw`:
 *  - the previous kind, `USING hnsw (embedding vector_cosine_ops)` with pgvector's defaults (m 16,
 *    ef_construction 64), which installs created before W4 keep until an operator runs `rebuild-index`;
 *  - the new kind, an expression index over the vectors cast to halfvec, m 16, ef_construction 200: half the
 *    size, up to 4000 dimensions, and no dead spots in the scale bench. New installs get it from the boot
 *    schema; `rebuild-index` replaces the previous kind with it.
 * The table keeps full-precision vectors either way.
 *
 * Pure apart from readVectorIndex (one catalog query), so schema.sql.ts and the gateway can both import it.
 */

/** The widest vector the schema accepts. pgvector indexes `halfvec` up to 4000 dimensions
 *  (and `vector` only up to 2000), so a wider column could never be indexed. */
export const MAX_EMBEDDING_DIMENSIONS = 4000;

/** The widest vector pgvector's HNSW indexes as a plain `vector` column. */
export const VECTOR_HNSW_MAX_DIMENSIONS = 2000;

/** The one index name the gateway reads. */
export const VECTOR_INDEX_NAME = 'idx_chunks_hnsw';
/** The name `rebuild-index` builds under before the swap. */
export const VECTOR_INDEX_BUILD_NAME = 'idx_chunks_hnsw_v2';

export const HNSW_M = 16;
export const HNSW_EF_CONSTRUCTION = 200;
/** pgvector's defaults, i.e. what an index without a WITH clause was built with. */
const PGVECTOR_DEFAULT_M = 16;
const PGVECTOR_DEFAULT_EF_CONSTRUCTION = 64;

/** halfvec and HNSW over it arrived in pgvector 0.7.0. */
export const HALFVEC_MIN_PGVECTOR: readonly [number, number, number] = [0, 7, 0];

export interface HnswParameters { m: number; efConstruction: number }

/** `USING hnsw (...) WITH (...)` for the new kind; the boot schema and `rebuild-index` both use it. */
export function halfvecIndexDefinition(
  dimensions: number, { m, efConstruction }: HnswParameters = { m: HNSW_M, efConstruction: HNSW_EF_CONSTRUCTION },
): string {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > MAX_EMBEDDING_DIMENSIONS) {
    throw new Error(`a halfvec index needs a width from 1 to ${MAX_EMBEDDING_DIMENSIONS} (got ${dimensions})`);
  }
  return `USING hnsw ((embedding::halfvec(${dimensions})) halfvec_cosine_ops) `
    + `WITH (m = ${m}, ef_construction = ${efConstruction})`;
}

export type VectorIndexKind = 'halfvec' | 'vector' | 'other' | 'none';

export interface VectorIndexDescription {
  /** halfvec: the new kind; vector: the previous kind; other: any other definition; none: no index. */
  kind: VectorIndexKind;
  /** The halfvec width the index casts to (the new kind only). */
  dimensions: number | null;
  m: number | null;
  efConstruction: number | null;
}

// Type and operator class may come back schema-qualified when their schema is not on the search_path.
const QUALIFIER = String.raw`(?:"?[\w$]+"?\.)?`;
const HALFVEC_COSINE = new RegExp(
  String.raw`USING hnsw \(\(\(embedding\)::${QUALIFIER}halfvec\((\d+)\)\) ${QUALIFIER}halfvec_cosine_ops\)`);
const VECTOR_COSINE = new RegExp(String.raw`USING hnsw \(embedding ${QUALIFIER}vector_cosine_ops\)`);

function withParameter(definition: string, name: string, fallback: number): number {
  const value = new RegExp(String.raw`\bWITH \(.*\b${name}='?(\d+)'?`).exec(definition)?.[1];
  return value === undefined ? fallback : Number(value);
}

/** Reads an index definition as pg_get_indexdef / pg_indexes.indexdef prints it. */
export function describeVectorIndex(definition: string | null | undefined): VectorIndexDescription {
  if (!definition) return { kind: 'none', dimensions: null, m: null, efConstruction: null };
  const halfvec = HALFVEC_COSINE.exec(definition);
  const kind: VectorIndexKind = halfvec ? 'halfvec' : VECTOR_COSINE.test(definition) ? 'vector' : 'other';
  if (kind === 'other') return { kind, dimensions: null, m: null, efConstruction: null };
  return {
    kind,
    dimensions: halfvec ? Number(halfvec[1]) : null,
    m: withParameter(definition, 'm', PGVECTOR_DEFAULT_M),
    efConstruction: withParameter(definition, 'ef_construction', PGVECTOR_DEFAULT_EF_CONSTRUCTION),
  };
}

/**
 * Whether an index definition is the new kind: HNSW over `embedding::halfvec(N)` with cosine distance, and,
 * when `dimensions` is given, N equal to it (the column's width; a query must cast to the same N to use it).
 */
export function isHalfvecVectorIndex(definition: string | null | undefined, dimensions?: number): boolean {
  const d = describeVectorIndex(definition);
  return d.kind === 'halfvec' && (dimensions === undefined || d.dimensions === dimensions);
}

/**
 * For a halfvec index built with another m or ef_construction than HNSW_M / HNSW_EF_CONSTRUCTION (rebuild-index
 * --m / --ef-construction): what the operator should know, starting "built with"; null for the defaults and for
 * any other kind. The approximate search serves such an index all the same (annPath.ts checks kind and width).
 */
export function nonDefaultBuildNote(index: VectorIndexDescription | null): string | null {
  if (index?.kind !== 'halfvec' || index.m === null || index.efConstruction === null) return null;
  const parts: string[] = [];
  if (index.efConstruction !== HNSW_EF_CONSTRUCTION) parts.push(`ef_construction ${index.efConstruction} (default ${HNSW_EF_CONSTRUCTION})`);
  if (index.m !== HNSW_M) parts.push(`m ${index.m} (default ${HNSW_M})`);
  if (parts.length === 0) return null;
  const lower = index.efConstruction < HNSW_EF_CONSTRUCTION || index.m < HNSW_M;
  return `built with ${parts.join(' and ')}: ${lower ? 'lower recall than' : 'not'} the defaults the approximate search `
    + 'was measured with; rebuild-index without --m or --ef-construction rebuilds it with the defaults';
}

/** Compares pgvector's extversion with a minimum; an unreadable version is not new enough. */
export function pgvectorVersionAtLeast(version: string, min: readonly [number, number, number]): boolean {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  if (!match) return false;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  for (let i = 0; i < 3; i += 1) {
    if (parts[i] !== min[i]) return parts[i] > min[i];
  }
  return true;
}

export interface VectorIndexState extends VectorIndexDescription {
  name: string;
  definition: string;
  /** pg_index.indisvalid: false while a concurrent build runs or after one failed. */
  valid: boolean;
  sizeBytes: number;
}

interface Queryable { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }

/** The named index on vector_store_chunks (in the table's own schema), or null when there is none. */
export async function readVectorIndex(client: Queryable, name = VECTOR_INDEX_NAME): Promise<VectorIndexState | null> {
  const { rows } = await client.query(
    `SELECT pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid AS valid,
            pg_relation_size(i.indexrelid)::bigint AS size
       FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
      WHERE i.indrelid = to_regclass('vector_store_chunks') AND ic.relname = $1`, [name]);
  if (rows.length === 0) return null;
  const { definition, valid, size } = rows[0];
  return { name, definition, valid, sizeBytes: Number(size), ...describeVectorIndex(definition) };
}

// ---------------------------------------------------------------------------------------------------------
// Estimates. pgvector keeps an element's tuple (the halfvec plus ten heap TIDs) and its layer-0 neighbour
// tuple (2 x m TIDs) on one 8 kB page, so the size is whole elements per page. Checked against the scale bench
// (pg16.15, pgvector 0.8.6): 288k x 1536 dims 1125 MiB measured, 1125 estimated; 1.08M x 384 dims 1208 measured,
// 1205 estimated.
// ---------------------------------------------------------------------------------------------------------
const PAGE_BYTES = 8192;
const PAGE_USABLE_BYTES = PAGE_BYTES - 24 - 16;
const ELEMENT_OVERHEAD_BYTES = 82;
const NEIGHBOUR_OVERHEAD_BYTES = 8;
const LINE_POINTERS_BYTES = 8;

export function estimateHalfvecIndexBytes(rows: number, dimensions: number, m: number): number {
  if (rows <= 0) return 0;
  const perElement = ELEMENT_OVERHEAD_BYTES + 2 * dimensions + NEIGHBOUR_OVERHEAD_BYTES + 2 * m * 6
    + LINE_POINTERS_BYTES;
  const perPage = Math.max(1, Math.floor(PAGE_USABLE_BYTES / perElement));
  return Math.ceil(rows / perPage) * PAGE_BYTES;
}

/**
 * A rough serial build time with the graph in maintenance_work_mem, from the scale bench on 4 vCPU
 * (ef_construction 200: 1.54 ms per chunk at 1536 dims, 0.89 ms at 384; ef_construction 64 took 0.52 of that;
 * a parallel build with two workers 0.35). Data without structure built up to 4x slower, and a graph that
 * does not fit maintenance_work_mem several times slower.
 */
export function estimateBuildSeconds(rows: number, dimensions: number, efConstruction: number, parallel: boolean): number {
  const perRowMs = (0.677 + 0.000561 * dimensions) * (0.29 + 0.71 * (efConstruction / 200));
  return (rows * perRowMs) / 1000 / (parallel ? 2.86 : 1);
}
