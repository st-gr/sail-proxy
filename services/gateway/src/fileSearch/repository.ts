// The hybrid recall stage: runs a pgvector cosine-distance ranking and (when
// enabled) a Postgres full-text `ts_rank` ranking over `vector_store_chunks`,
// each capped at `hybrid.candidates` rows, and fuses them with `fuseRrf` into
// one ordered list of ~50 candidate chunks. Task 12's reranker narrows that
// list further; this module's only job is cheap, correct recall.
//
// SECURITY: ownership is enforced INSIDE the SQL, not as a post-hoc filter —
// `(vs.owner_email = $2 OR vs.is_shared = true)` is ANDed into both CTEs'
// WHERE clauses. A caller passing a store id it does not own must get zero
// rows for that store, not rows that are then discarded by the caller. This
// is deliberate: Task 12 turns "no rows for a store id" into a 404 rather than
// a 403, so store ids can't be enumerated by observing 403 vs 404.
//
// The attribute filter (attacker-controlled, from the client's file_search
// tool call) is compiled by filterCompiler.ts, which is pure and already
// hardened against injection, prototype-chain tricks and NUL bytes. This
// module's own responsibility is just correct placeholder bookkeeping: always
// resume numbering from compileFilter's returned `nextIndex`, never from a
// hardcoded per-leaf offset (ordinal leaves consume 3 placeholders, not 2 —
// see filterCompiler.ts and the Task 7 "Post-review correction" note), and to
// map compileFilter's thrown validation errors (oversized/malformed filter) to
// a client-input error rather than letting them look like a database failure.
import { getPool } from './db';
import { compileFilter } from './filterCompiler';
import { getFileSearchConfig } from '../services/configService';
import { getDefaultLogger } from '@libs/logger';
import { fuseRrf } from './rrf';
import { newVectorStoreId } from './ids';
import { publishIngestHint } from './ingestHint';

const logger = getDefaultLogger();

/** Thrown for malformed/oversized client input (e.g. an invalid attribute
 *  filter, or a query embedding of the wrong dimension). Callers should map
 *  this to an HTTP 400 — never a 500. */
export class RecallInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'RecallInputError';
  }
}

/**
 * The SQLSTATE a `pg` error carries (`22P02`, `22P05`, …), or the class name when there
 * is none (a socket error, say). Both are fixed tokens chosen by the driver or by Node —
 * never anything the caller supplied — which is what makes them safe to log.
 */
export function driverErrorCode(error: any): string {
  const code = error?.code;
  return typeof code === 'string' && code.length > 0 ? code : (error?.name ?? 'unknown_error');
}

/**
 * A stand-in for a driver error that is safe to hand to `logger.error`'s `error`
 * parameter, which serializes `name`, `message` and `stack`.
 *
 * The message is replaced by the SQLSTATE. The stack keeps only its FRAMES: V8 builds
 * `stack` as `${name}: ${message}\n    at …`, so shipping it verbatim would re-log the
 * message this function exists to withhold.
 */
export function redactDriverError(error: any): Error {
  const redacted = new Error(driverErrorCode(error));
  redacted.name = error?.name ?? 'Error';
  const frames = typeof error?.stack === 'string'
    ? error.stack.split('\n').filter((line: string) => /^\s+at\s/.test(line))
    : [];
  redacted.stack = [`${redacted.name}: ${redacted.message}`, ...frames].join('\n');
  return redacted;
}

export interface RecallOptions {
  /** Vector store ids the search is scoped to. Every id not owned by
   *  `ownerEmail` (and not `is_shared`) yields no rows for that store. */
  storeIds: string[];
  ownerEmail: string;
  /** Raw query text, used for the lexical (`ts_rank`) ranking. Never logged. */
  queryText: string;
  /** Already-embedded query vector, same dimensionality as the store's
   *  `embedding` column. Never logged. */
  queryEmbedding: number[];
  /** An OpenAI-style attribute filter AST, or undefined for no filter. */
  filter?: unknown;
  /** Max candidates to return after fusion. Defaults to `hybrid.candidates`. */
  limit?: number;
}

export interface CandidateChunk {
  storeId: string;
  fileId: string;
  filename: string;
  ord: number;
  text: string;
  attributes: Record<string, unknown>;
  /** The fused RRF score — not a cosine similarity or a ts_rank value. */
  score: number;
  /** Rank (1-based) and raw score from the vector arm, when this chunk was
   *  recalled by it. `vectorScore` is a cosine DISTANCE — lower is better —
   *  never inverted here; the consumer decides how to use it. Undefined when
   *  this chunk was recalled only by the lexical arm. */
  vectorRank?: number;
  vectorScore?: number;
  /** Rank (1-based) and raw `ts_rank` score from the lexical arm, when this
   *  chunk was recalled by it — higher is better. Undefined when this chunk
   *  was recalled only by the vector arm, or when hybrid.lexicalEnabled is
   *  false. */
  lexicalRank?: number;
  lexicalScore?: number;
}

interface CandidateRow {
  source: 'vec' | 'lex';
  store_id: string;
  file_id: string;
  ord: number;
  text: string;
  attributes: Record<string, unknown> | null;
  filename: string;
  rnk: string; // bigint from ROW_NUMBER() arrives as a string via node-pg
  score: number;
}

// Composite key uniquely identifying a chunk across both rankings. JSON-encoded
// (rather than a delimiter-joined string) so nothing about store_id/file_id's
// own contents — however they're generated — can forge a collision. Exported
// for teacherLogger.ts, which uses this exact key to test selectedIds
// membership — deliberately not a second, independently-defined key format.
export function candidateId(storeId: string, fileId: string, ord: number): string {
  return JSON.stringify([storeId, fileId, ord]);
}

// Same rationale and construction as filterCompiler.ts's own NUL_BYTE guard:
// a NUL byte is valid JSON/JS inside a string but Postgres's text encoding
// cannot represent it (`[22021] invalid byte sequence for encoding "UTF8":
// 0x00`). `opts.queryText` is bound straight into `plainto_tsquery(...)`
// below with no other validation between the HTTP body and this parameter —
// unlike the attribute filter (compiled, and NUL-checked, by
// filterCompiler.ts), nothing upstream of this module ever rejected it.
// Left unchecked this reaches Postgres as a raw, unhandled exception —
// verified live: `POST /vector_stores/{id}/search {"query":"a<NUL>b"}`
// against the default configuration (hybrid.lexicalEnabled: true) 500s with
// the driver's own message in the response body. Checked here, up front,
// so it becomes a clean 400 regardless of whether hybrid.lexicalEnabled
// ends up including queryText in the query at all.
const NUL_BYTE = String.fromCharCode(0);

function assertQueryTextIsSafe(queryText: string): void {
  if (queryText.includes(NUL_BYTE)) {
    throw new RecallInputError('queryText must not contain a NUL byte');
  }
}

function toVectorLiteral(embedding: number[], expectedDim: number): string {
  if (!Array.isArray(embedding) || embedding.length !== expectedDim) {
    throw new RecallInputError(
      `queryEmbedding must have length ${expectedDim} (the configured embeddingDimensions), got ${
        Array.isArray(embedding) ? embedding.length : typeof embedding
      }`
    );
  }
  for (const value of embedding) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new RecallInputError('queryEmbedding must contain only finite numbers');
    }
  }
  // pgvector's text input format: '[v1,v2,...]', bound as a plain string
  // parameter and cast with `::vector` in the SQL — never string-templated
  // into the query itself.
  return `[${embedding.join(',')}]`;
}

/**
 * THE tenant boundary for reading a vector store, as one SQL fragment shared
 * by every reader rather than copied per call site.
 *
 * `recallCandidates` (via `buildCte`) and `assertStoresAccessible` both AND
 * this into their WHERE clause, and both bind `$1 = storeIds`, `$2 =
 * ownerEmail` in those exact positions — which is what makes one fragment
 * reusable across them. It is deliberately NOT duplicated as literal text in
 * two places: a second copy of the ownership rule is a second place for the
 * boundary to drift, and the drift would be silent (each query keeps
 * returning rows, just the wrong set). Anything else that learns to read
 * `vector_stores` on a caller's behalf must use this constant too.
 *
 * The alias is `vs`, matching `buildCte`'s join alias; `assertStoresAccessible`
 * aliases `vector_stores AS vs` purely so this one fragment fits it unchanged.
 */
export const STORE_ACCESS_PREDICATE_SQL = '(vs.owner_email = $2 OR vs.is_shared = true)';

/** Builds one ranked CTE. `orderExpr`/`extraPredicate` reference `c` (chunks),
 *  `vsf` (vector_store_files) and `vs` (vector_stores) — the same aliases
 *  `compileFilter`'s fragment expects for `vsf`. `scoreExpr` is the bare
 *  per-arm score value (no ASC/DESC — `orderExpr` carries that, and isn't
 *  itself selectable, e.g. the lexical arm's is `ts_rank(...) DESC`). */
function buildCte(
  name: string,
  orderExpr: string,
  scoreExpr: string,
  extraPredicate: string,
  filterSql: string,
  limitPlaceholder: string,
): string {
  // A deterministic tiebreaker appended after `orderExpr` in BOTH places it's
  // used below: without one, rows tied on `orderExpr` (a cosine distance or a
  // ts_rank score — both plausible to tie exactly, e.g. two chunks at cosine
  // distance 0 from an identical embedding) get an UNSPECIFIED ROW_NUMBER
  // ordering from Postgres, and fuseRrf's RRF fusion is only deterministic
  // given deterministic input rankings. `c.store_id, c.file_id, c.ord` is
  // already a unique key per chunk (see candidateId above), so appending it
  // makes the ORDER BY total, not just deterministic-in-practice.
  const orderByWithTiebreaker = `${orderExpr}, c.store_id, c.file_id, c.ord`;
  return `
${name} AS (
  SELECT c.store_id, c.file_id, c.ord, c.text, vsf.attributes, f.filename,
         ROW_NUMBER() OVER (ORDER BY ${orderByWithTiebreaker}) AS rnk,
         ${scoreExpr} AS score
  FROM vector_store_chunks c
  JOIN vector_store_files vsf ON vsf.store_id = c.store_id AND vsf.file_id = c.file_id
  JOIN vector_stores vs ON vs.id = c.store_id
  JOIN fs_files f ON f.id = c.file_id
  WHERE vs.id = ANY($1)
    AND ${STORE_ACCESS_PREDICATE_SQL}
    ${filterSql}
    ${extraPredicate}
  ORDER BY ${orderByWithTiebreaker}
  LIMIT ${limitPlaceholder}
)`;
}

/**
 * Recall ~`limit` candidate chunks across `storeIds`, scoped to what
 * `ownerEmail` may see, by fusing a vector-similarity ranking with (when
 * `hybrid.lexicalEnabled`) a full-text ranking via RRF.
 *
 * Throws `RecallInputError` (map to HTTP 400) for a malformed attribute
 * filter or a query embedding of the wrong dimension. Any other thrown error
 * is an unexpected database/connectivity failure.
 */
export async function recallCandidates(opts: RecallOptions): Promise<CandidateChunk[]> {
  const pool = getPool();
  if (!pool) {
    throw new Error('recallCandidates: file_search database is not configured');
  }

  const config = getFileSearchConfig();
  const limit = opts.limit ?? config.hybrid.candidates;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RecallInputError('limit must be a positive integer');
  }

  // `limit` and `queryEmbedding` (via toVectorLiteral below) are validated;
  // `ownerEmail` is the highest-stakes parameter in this module — it is
  // ANDed into both CTEs' WHERE clauses as the entire ownership boundary
  // (see this file's header comment) — and was the one bare string passed
  // straight through with no check at all. A caller bug that drops it
  // (`undefined`, `null`, `''`) degrades SILENTLY today: the SQL predicate
  // `(vs.owner_email = $2 OR vs.is_shared = true)` just never matches on
  // the owner_email side, so the query still runs and returns only
  // `is_shared` stores — fail-safe, but a caller error should throw here,
  // loudly, rather than quietly narrowing to "everything shared" and
  // looking like a correct empty/partial result.
  if (typeof opts.ownerEmail !== 'string' || opts.ownerEmail.length === 0) {
    throw new RecallInputError('ownerEmail must be a non-empty string');
  }

  assertQueryTextIsSafe(opts.queryText);

  const vectorLiteral = toVectorLiteral(opts.queryEmbedding, config.embeddingDimensions);

  if (!Array.isArray(opts.storeIds) || opts.storeIds.length === 0) {
    return [];
  }

  // $1 storeIds, $2 ownerEmail, $3 query vector, $4 limit — fixed base params
  // every CTE shares; the attribute filter and (if lexical is enabled) the
  // query text are appended after them, continuing from compileFilter's own
  // returned nextIndex rather than a hardcoded offset.
  const params: any[] = [opts.storeIds, opts.ownerEmail, vectorLiteral, limit];
  let nextIndex = 5;

  let filterSql = '';
  if (opts.filter !== undefined && opts.filter !== null) {
    let compiled;
    try {
      compiled = compileFilter(opts.filter, nextIndex);
    } catch (error: any) {
      // compileFilter throws on malformed filter shapes AND on the
      // MAX_TOTAL_LEAVES/MAX_FILTER_DEPTH DoS guards — all of those are
      // client-input problems, never a 500.
      throw new RecallInputError(`Invalid attribute filter: ${error.message}`);
    }
    filterSql = `AND ${compiled.sql}`;
    params.push(...compiled.params);
    nextIndex = compiled.nextIndex;
  }

  const lexicalEnabled = config.hybrid.lexicalEnabled;

  const vecCte = buildCte(
    'vec',
    'c.embedding <=> $3::vector',
    'c.embedding <=> $3::vector',
    '',
    filterSql,
    '$4',
  );

  let sql: string;
  if (lexicalEnabled) {
    const queryTextIndex = nextIndex;
    params.push(opts.queryText);
    nextIndex += 1;

    const tsQuery = `plainto_tsquery('simple', $${queryTextIndex})`;
    const lexCte = buildCte(
      'lex',
      `ts_rank(c.tsv, ${tsQuery}) DESC`,
      `ts_rank(c.tsv, ${tsQuery})`,
      `AND c.tsv @@ ${tsQuery}`,
      filterSql,
      '$4',
    );
    sql = `
WITH${vecCte},${lexCte}
SELECT 'vec' AS source, store_id, file_id, ord, text, attributes, filename, rnk, score FROM vec
UNION ALL
SELECT 'lex' AS source, store_id, file_id, ord, text, attributes, filename, rnk, score FROM lex`;
  } else {
    // hybrid.lexicalEnabled=false: run the vector CTE only, still through
    // fuseRrf (a single ranking degrades to plain 1/(k+rank) ordering, which
    // is order-preserving — see rrf.test.ts) so there's exactly one scoring
    // code path regardless of how many rankings contributed.
    sql = `
WITH${vecCte}
SELECT 'vec' AS source, store_id, file_id, ord, text, attributes, filename, rnk, score FROM vec`;
  }

  let rows: CandidateRow[];
  try {
    const result = await pool.query(sql, params);
    rows = result.rows;
  } catch (error: any) {
    // NOT `error.message`, and not the raw error object either. Everything that can be
    // thrown here comes out of the `pg` driver, and a DatabaseError's message QUOTES THE
    // INPUT that offended Postgres -- reproduced live, an ordinal filter carrying a
    // non-numeric `value` yields
    //   [22P02] invalid input syntax for type numeric: "Jane Doe, MRN 4471"
    // where the quoted string is the caller's own filter value, which `body.filters` never
    // has pseudonymization applied to. `filterCompiler` now rejects that filter at 400, but
    // this line must not depend on every future 22P02-shaped input being caught upstream.
    //
    // `redactDriverError` keeps what is diagnostic (the class, the SQLSTATE, the frames)
    // and drops what is not ours to log (the message, and the stack's first line, which is
    // `${name}: ${message}` and therefore carries a second copy of it).
    logger.error('FileSearchRepository',
      `Hybrid recall query failed: ${driverErrorCode(error)}`, redactDriverError(error), {
        storeCount: opts.storeIds.length,
        lexicalEnabled,
      });
    throw error;
  }

  // Each CTE contributes at most one row per chunk, but a chunk recalled by
  // BOTH arms produces two rows here — one per source. Collapsing them with a
  // single `byId.set(id, row)` (as this used to) keeps only whichever row
  // arrived last and silently drops the other arm's rank/score, which is
  // exactly the per-arm data this function exists to preserve. Instead, each
  // id accumulates into one entry with an optional `vec` and/or `lex` hit, so
  // a chunk present in both arms surfaces both.
  interface ArmHit { rank: number; score: number }
  const byId = new Map<string, { row: CandidateRow; vec?: ArmHit; lex?: ArmHit }>();
  const vecRanking: string[] = [];
  const lexRanking: string[] = [];

  for (const row of rows) {
    const id = candidateId(row.store_id, row.file_id, row.ord);
    const entry = byId.get(id) ?? { row };
    const rank = Number(row.rnk);
    const hit: ArmHit = { rank, score: Number(row.score) };
    if (row.source === 'vec') {
      entry.vec = hit;
      vecRanking[rank - 1] = id;
    } else {
      entry.lex = hit;
      lexRanking[rank - 1] = id;
    }
    byId.set(id, entry);
  }

  const rankings = lexicalEnabled ? [vecRanking, lexRanking] : [vecRanking];
  const fused = fuseRrf(rankings, config.hybrid.rrfK).slice(0, limit);

  return fused.map(({ id, score }) => {
    const { row, vec, lex } = byId.get(id)!;
    return {
      storeId: row.store_id,
      fileId: row.file_id,
      filename: row.filename,
      ord: row.ord,
      text: row.text,
      attributes: row.attributes ?? {},
      score,
      vectorRank: vec?.rank,
      vectorScore: vec?.score,
      lexicalRank: lex?.rank,
      lexicalScore: lex?.score,
    };
  });
}

// ---------------------------------------------------------------------------
// Vector stores and vector-store files (Task 10)
//
// `embedding_model`/`embedding_dim` are pinned on `vector_stores` at creation
// time (see `createStore`) because `vector_store_chunks.embedding` is a
// fixed-width `vector(N)` column set once at schema migration — if the
// configured embedding model changes later without a matching migration,
// every existing store's pinned dimension stops matching the live config,
// and any code path that would create NEW vectors for that store (attaching
// a file, or Task 12's search) must refuse with `assertStoreDimension`
// rather than let a dimension-mismatched INSERT reach pgvector as a raw,
// unexplained 500.
// ---------------------------------------------------------------------------

/** Thrown by `assertStoreDimension` when a store's pinned `embedding_dim`
 *  no longer matches the currently configured embedding model. Callers
 *  should map this to an HTTP 409 — the store is not gone or forbidden,
 *  it is stuck until an operator re-embeds it into a new store. */
export class StoreDimensionMismatchError extends Error {
  readonly status = 409;
  /** The wire `code` every HTTP surface emits for this error. Declared here so the
   *  file_search TOOL's rejection (`hostedTool/engine.ts` reads `error.code` generically,
   *  knowing nothing about this module) and `vectorStoresController`'s
   *  `sendDimensionConflict` cannot drift apart. */
  readonly code = 'embedding_dimension_mismatch';
  constructor(message: string) {
    super(message);
    this.name = 'StoreDimensionMismatchError';
  }
}

/** Thrown by `validateAttributes` for a client-supplied `attributes` (or
 *  `metadata`, which follows the identical OpenAI constraint) object that
 *  violates the shape rules. Callers should map this to an HTTP 400. */
export class AttributeValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'AttributeValidationError';
  }
}

// Recomputes `expires_at` from `expires_after`'s `days`, anchored to the SAME
// `now()` the calling statement sets `last_active_at` to (Postgres evaluates
// `now()` once per transaction, so two references to it within one statement
// agree). Every site that touches `last_active_at` because of genuine store
// *activity* -- attachFile and deleteStoreFile below, and search.ts's
// touchStoreActivity -- must recompute expires_at with this exact fragment,
// or expires_after:{anchor:'last_active_at'} silently degrades back into a
// fixed deadline pinned at creation (or at whichever call last forgot this;
// this was a real, shipped defect: vectorStoresController.ts's modify path
// computed expires_at from Date.now() instead of the store's own anchor, and
// neither attachFile nor deleteStoreFile recomputed it at all). Kept as one
// named constant so a future call site can't recompute it slightly
// differently and drift.
const RECOMPUTE_EXPIRES_AT_SQL =
  `CASE WHEN expires_after IS NOT NULL ` +
  `THEN now() + ((expires_after->>'days')::int * interval '1 day') ` +
  `ELSE expires_at END`;

// The same deadline formula as RECOMPUTE_EXPIRES_AT_SQL, written for the INSERT
// in createStore where the row does not exist yet, so `expires_after` has to be
// read from the bound parameter rather than the column.
//
// It is SQL and not a JS `new Date()` for the reason the comment above gives:
// every site that writes `last_active_at` must agree on one clock. createStore
// was the site that did not — it bound a JS Date for `created_at`,
// `last_active_at` and the `expires_at` derived from them, so a store's
// `last_active_at` moved backwards on its first real activity whenever the
// application clock ran ahead of the database's, and `expires_at` jumped by
// that skew the first time anything recomputed it. Postgres evaluates `now()`
// once per transaction, so the two columns this expression feeds are stamped
// from the identical instant.
const initialExpiresAtSql = (expiresAfterParam: string): string =>
  `CASE WHEN ${expiresAfterParam}::jsonb IS NOT NULL `
  + `THEN now() + ((${expiresAfterParam}::jsonb->>'days')::int * interval '1 day') `
  + 'ELSE NULL END';

const MAX_ATTRIBUTE_KEYS = 16;
const MAX_ATTRIBUTE_KEY_LENGTH = 64;
const MAX_ATTRIBUTE_VALUE_LENGTH = 512;

// Same constant, same construction and same reason as filterCompiler.ts's and
// vectorStoresController.ts's: built via fromCharCode so no raw NUL byte lives
// in this source file.
const ATTR_NUL_BYTE = String.fromCharCode(0);

/**
 * OpenAI's metadata/attributes constraint, applied exact-value: at most 16
 * keys, each key at most 64 characters, each value at most 512 characters
 * (the length bound only applies to string values), and only string, number
 * or boolean values — no nested objects or arrays, which is what keeps the
 * attribute filter compiler's job (and its injection-hardening) bounded.
 * `null`/`undefined` is treated as "no attributes", matching an omitted
 * field in the request body — never a validation error.
 *
 * NUL BYTES ARE REJECTED, in keys and in string values alike. Being
 * `JSON.stringify`'d before binding does NOT make them safe, which is what
 * `parseOptionalName`'s comment used to claim: `stringify` does turn a NUL into
 * the six-character escape `\u0000`, and Postgres's `jsonb` then rejects that
 * escape SPECIFICALLY, because `jsonb` stores decoded text and has no way to
 * hold a NUL:
 *   [22P05] unsupported Unicode escape sequence
 * — confirmed live, an unhandled 500 (the driver error carries no `status`) on
 * every one of the four entry points that reach here: create-store `metadata`,
 * modify-store `metadata`, attach-file `attributes` and update-file-attributes
 * `attributes`. `nulByteGuard` does not cover it; that middleware scans only
 * `file_ids` / `file_id` / `vector_store_ids`. Same bug class, and the same
 * fix, as `parseOptionalName`, `filterCompiler`'s key/value guards and
 * `assertQueryTextIsSafe`.
 *
 * The offending key is deliberately NOT interpolated into the message: it is
 * the thing carrying the NUL, and this message is logged.
 */
export function validateAttributes(attributes: unknown): Record<string, string | number | boolean> {
  if (attributes === null || attributes === undefined) return {};
  if (typeof attributes !== 'object' || Array.isArray(attributes)) {
    throw new AttributeValidationError('attributes must be an object mapping keys to string, number or boolean values');
  }
  const entries = Object.entries(attributes as Record<string, unknown>);
  if (entries.length > MAX_ATTRIBUTE_KEYS) {
    throw new AttributeValidationError(`attributes must have at most ${MAX_ATTRIBUTE_KEYS} keys, got ${entries.length}`);
  }
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of entries) {
    if (key.length > MAX_ATTRIBUTE_KEY_LENGTH) {
      throw new AttributeValidationError(
        `attribute keys must be at most ${MAX_ATTRIBUTE_KEY_LENGTH} characters, got a ${key.length}-character key`);
    }
    if (key.includes(ATTR_NUL_BYTE)) {
      throw new AttributeValidationError('attribute keys must not contain a NUL byte');
    }
    const valueType = typeof value;
    if (valueType !== 'string' && valueType !== 'number' && valueType !== 'boolean') {
      throw new AttributeValidationError(`attribute "${key}" must be a string, number or boolean value`);
    }
    if (valueType === 'string' && (value as string).length > MAX_ATTRIBUTE_VALUE_LENGTH) {
      throw new AttributeValidationError(
        `attribute "${key}" must be at most ${MAX_ATTRIBUTE_VALUE_LENGTH} characters`);
    }
    if (valueType === 'number' && !Number.isFinite(value as number)) {
      throw new AttributeValidationError(`attribute "${key}" must be a finite number`);
    }
    if (valueType === 'string' && (value as string).includes(ATTR_NUL_BYTE)) {
      throw new AttributeValidationError(`attribute "${key}" must not contain a NUL byte`);
    }
    result[key] = value as string | number | boolean;
  }
  return result;
}

/**
 * Refuses to proceed on a store whose pinned `embedding_dim` disagrees with
 * the currently configured embedding model. Only called from code paths
 * that would create NEW vectors for the store (attaching a file here;
 * search in Task 12) — read-only paths (get/list/modify-metadata/delete)
 * don't touch the `vector` column and stay available so a stuck store can
 * still be inspected and removed.
 */
export async function assertStoreDimension(store: { embedding_dim: number }): Promise<void> {
  const currentDim = getFileSearchConfig().embeddingDimensions;
  if (store.embedding_dim !== currentDim) {
    throw new StoreDimensionMismatchError(
      `This vector store was created with a ${store.embedding_dim}-dimensional embedding model, but this ` +
      `deployment is now configured for ${currentDim} dimensions. Embedding columns are fixed-width once ` +
      'created, so this store cannot accept new files until it is recreated under the current configuration.',
    );
  }
}

/**
 * Thrown by `assertStoreNotExpired` for a store whose `status` is
 * `'expired'`. Callers should map this to HTTP 409 — the store still
 * exists, and remains listable/retrievable/deletable (OpenAI's own
 * semantics: an expired store keeps its row and reports `status:
 * "expired"` rather than 404-ing), but per this deployment's chosen
 * semantics `'expired'` is TERMINAL for use: it can no longer accept new
 * files or be searched.
 *
 * This was a deliberate choice between two options (Task 12 review, I4),
 * not the only possible one: the alternative — treating a search or attach
 * as "activity" that revives an expired store back into a live, sweepable
 * one — was rejected because `status` is never cleared off `'expired'` by
 * anything in this codebase, so a revived store would never become
 * sweepable again, and `touchStoreActivity` sliding `expires_at` forward
 * on every subsequent search would make its storage unbounded. Terminal
 * status with no revival keeps the sweeper's reclamation permanent.
 */
export class StoreExpiredError extends Error {
  readonly status = 409;
  /** The wire `code` every HTTP surface emits for this error — same single-definition
   *  reason as `StoreDimensionMismatchError.code`; the peer is
   *  `vectorStoresController`'s `sendStoreExpired`. */
  readonly code = 'vector_store_expired';
  constructor(readonly storeId: string) {
    super(
      `Vector store ${storeId} has expired and no longer accepts new files or searches. ` +
      'It can still be retrieved, listed or deleted.',
    );
    this.name = 'StoreExpiredError';
  }
}

/**
 * Refuses to proceed on a store whose `status` is `'expired'`. Called from
 * the same two code paths as `assertStoreDimension` — attaching a file
 * (`vectorStoresController.createVectorStoreFile`) and search
 * (`search.ts`) — for the same reason: both would otherwise create new
 * activity (new chunks, or a `touchStoreActivity` call sliding `expires_at`
 * forward) on a store the expiry sweeper already reclaimed.
 */
export function assertStoreNotExpired(store: { id: string; status: string }): void {
  if (store.status === 'expired') {
    throw new StoreExpiredError(store.id);
  }
}

export interface VectorStoreRow {
  id: string;
  owner_email: string;
  is_shared: boolean;
  name: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
  embedding_model: string;
  embedding_dim: number;
  expires_after: { anchor: string; days: number } | null;
  expires_at: Date | null;
  last_active_at: Date;
  created_at: Date;
}

export interface VectorStoreFileRow {
  store_id: string;
  file_id: string;
  attributes: Record<string, unknown> | null;
  chunking_strategy: Record<string, unknown> | null;
  status: string;
  last_error: Record<string, unknown> | null;
  usage_bytes: number | null;
  claimed_at: Date | null;
  attempts: number;
  batch_id: string | null;
  created_at: Date;
}

/** Every value `vector_store_files.status` may hold — and therefore exactly
 *  the countable keys of `FileCounts` below. One list, so the store-level
 *  count path, the batch-level count path and the `?filter=` query-parameter
 *  validator cannot disagree about what a valid status is. */
export const VALID_FILE_STATUSES = ['in_progress', 'completed', 'failed', 'cancelled'] as const;
export type FileStatus = (typeof VALID_FILE_STATUSES)[number];

/**
 * Per-status counts over a set of `vector_store_files` rows — the shape both
 * `vector_store.file_counts` (grouped by `store_id`) and
 * `vector_store.file_batch.file_counts` (grouped by `batch_id`) are emitted
 * from.
 *
 * Declared HERE, in the data layer, rather than in either consumer: it was
 * originally local to `vectorStoresController.ts`, and `batches.ts` needs the
 * identical shape. Re-declaring it there would have produced two structurally
 * identical count types that agree today and drift later; importing the
 * controller's copy would have made `src/fileSearch/` depend on
 * `src/controllers/`, a direction that exists nowhere else in this codebase
 * (controllers import the repository, never the reverse). One definition, in
 * the layer that actually produces the numbers.
 */
export interface FileCounts {
  in_progress: number;
  completed: number;
  failed: number;
  cancelled: number;
  total: number;
}

export interface CreateStoreOptions {
  ownerEmail: string;
  name?: string | null;
  metadata?: Record<string, unknown> | null;
  expiresAfter?: { anchor: 'last_active_at'; days: number } | null;
  isShared?: boolean;
  /** 'in_progress' when the caller is about to attach `file_ids` in the same
   *  request, 'completed' for an empty store — mirrors OpenAI's own status
   *  semantics for a freshly created store. Defaults to 'completed'. */
  initialStatus?: 'in_progress' | 'completed';
}

/**
 * Creates a vector store, pinning `embedding_model`/`embedding_dim` to the
 * CURRENT configuration — a freshly created store can never itself trigger
 * `assertStoreDimension` (its pin matches by construction); the check exists
 * for stores that outlive a later configuration change.
 */
export async function createStore(opts: CreateStoreOptions): Promise<VectorStoreRow> {
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');
  const config = getFileSearchConfig();
  const id = newVectorStoreId();
  const { rows } = await pool.query<VectorStoreRow>(
    `INSERT INTO vector_stores
       (id, owner_email, is_shared, name, status, metadata, embedding_model, embedding_dim,
        expires_after, expires_at, last_active_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,${initialExpiresAtSql('$9')}, now(), now())
     RETURNING *`,
    [
      id,
      opts.ownerEmail,
      opts.isShared ?? false,
      opts.name ?? null,
      opts.initialStatus ?? 'completed',
      opts.metadata ? JSON.stringify(opts.metadata) : null,
      config.embeddingModel,
      config.embeddingDimensions,
      opts.expiresAfter ? JSON.stringify(opts.expiresAfter) : null,
    ],
  );
  return rows[0];
}

/**
 * Attaches `fileId` to `storeId` with status `'in_progress'` (never
 * `'completed'` — Task 11's worker owns advancing it) and touches the
 * store's `last_active_at`, since `expires_after.anchor` is
 * `'last_active_at'`. This is a low-level primitive: it does not check
 * store/file ownership, the per-store file-count limit, or the store's
 * pinned embedding dimension — those are the HTTP layer's job (each is its
 * own scoped SQL lookup there), so this function stays usable standalone
 * (e.g. from a future batch-attach path) without re-deriving them.
 *
 * `batchId` stamps `vector_store_files.batch_id`, which is how a file batch
 * records its membership (`batches.ts` has no membership table of its own —
 * see the schema comment). It is OPTIONAL and defaults to `null` precisely so
 * every pre-existing call site keeps its current meaning without an edit: an
 * ordinary single-file attach is an attach with no batch, which is exactly
 * what `null` already meant in that column.
 */
export async function attachFile(
  storeId: string,
  fileId: string,
  attributes: Record<string, unknown> | null | undefined,
  chunkingStrategy?: Record<string, unknown> | null,
  batchId: string | null = null,
): Promise<VectorStoreFileRow> {
  const validAttributes = validateAttributes(attributes);
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // created_at comes from the database clock, like every other timestamp
    // this module writes. It is the keyset pagination cursor for both file-list
    // endpoints (ORDER BY created_at, file_id), so an application-clock value
    // is not merely inconsistent: two gateway replicas whose clocks disagree
    // would store rows in an order that contradicts their true insertion
    // order, and a cursor resolved against one replica's value can skip or
    // repeat rows on a page served by the other.
    const { rows } = await client.query<VectorStoreFileRow>(
      `INSERT INTO vector_store_files (store_id, file_id, attributes, chunking_strategy, status, batch_id, created_at)
       VALUES ($1,$2,$3,$4,'in_progress',$5, now())
       RETURNING *`,
      [
        storeId,
        fileId,
        JSON.stringify(validAttributes),
        chunkingStrategy ? JSON.stringify(chunkingStrategy) : null,
        batchId,
      ],
    );
    // Postgres evaluates now() once per transaction, so this anchors
    // expires_after to the same instant the row above was stamped with, and
    // agrees with RECOMPUTE_EXPIRES_AT_SQL everywhere else last_active_at is
    // touched.
    await client.query(
      `UPDATE vector_stores SET last_active_at = now(), expires_at = ${RECOMPUTE_EXPIRES_AT_SQL} WHERE id = $1`,
      [storeId],
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (e) {
    // Swallow a failing ROLLBACK: it fires precisely when the connection is
    // already broken, and letting it throw replaces the error that explains why.
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Signals that `fileId` in `storeId` is ready for ingestion. Per the design
 * (`docs/superpowers/specs/2026-07-29-responses-file-search-design.md`),
 * "the database row is the source of truth; valkey is an accelerator" — a
 * job *is* the `vector_store_files` row this call's caller already inserted
 * with `status='in_progress'` (see `attachFile`), and the ingestion worker
 * (`ingestWorker.ts`) polls for exactly that, re-claiming rows whose lease
 * has expired even if no hint ever arrived. `publishIngestHint` (Task 11,
 * `ingestHint.ts`) is strictly a low-latency wake-up: absent VALKEY_URL, or
 * if the publish itself fails, this degrades to the same no-op-beyond-a-
 * debug-log this function shipped as originally — never the source of
 * truth, never awaited by anything that would fail the caller's request.
 */
export async function enqueueIngestion(storeId: string, fileId: string): Promise<void> {
  logger.debug('FileSearchRepository', 'Ingestion enqueued', { storeId, fileId });
  await publishIngestHint(storeId, fileId);
}

/**
 * Detaches `fileId` from `storeId` (scoped to `ownerEmail` in the SQL, not
 * applied afterwards): removes its chunks and the `vector_store_files` row,
 * and touches the store's `last_active_at`. One transaction, so a mid-delete
 * crash cannot remove the chunks without removing the attachment row (or
 * vice versa). Returns `deleted: false` — never a distinguishing error —
 * when the store isn't owned by `ownerEmail` or the file isn't attached
 * to it.
 *
 * Deliberately does NOT touch `fs_files` or any blob. Detaching a file from
 * a vector store is not the same operation as deleting the file: OpenAI's
 * own API is explicit that removing a file from a vector store "will not"
 * delete the file itself, and returns a distinct `vector_store_file.deleted`
 * object rather than `file.deleted`. `vector_store_files.file_id` also has
 * no `ON DELETE CASCADE` onto `fs_files` in the schema for exactly this
 * reason — a file can and should serve several stores, or be re-attached
 * after detaching, without losing its blob or its `GET /files/{id}` entry.
 * The ONLY path that ever removes an `fs_files` row or decrements a blob's
 * `ref_count` is `filesController.deleteFile` (`DELETE /files/{id}`).
 *
 * LOCK ORDER (Task 11 review, C2): always locks `vector_stores` FOR UPDATE
 * before touching `vector_store_files`, matching `deleteStoreCascade` below
 * and `ingestWorker.ts`'s `commitChunks` (which takes `FOR SHARE` on
 * `vector_stores` before re-checking the `vector_store_files` row). Before
 * this fix, this function deleted `vector_store_files` FIRST and only
 * touched `vector_stores` afterward (via the trailing `UPDATE
 * last_active_at`) — the reverse order from `commitChunks` and
 * `deleteStoreCascade`. Two transactions taking the same two locks in
 * opposite orders is a textbook deadlock: reproduced live 6/6 (a detach
 * racing an ingestion write for the same file), with THIS function losing
 * 5 of 6 as Postgres's `40P01` victim, surfacing as an unmapped 500 in
 * `vectorStoresController.ts` before that was also fixed. One global rule
 * fixes it structurally rather than case-by-case: every write path that
 * touches both tables locks `vector_stores` first.
 */
export async function deleteStoreFile(storeId: string, fileId: string, ownerEmail: string): Promise<{ deleted: boolean }> {
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const storeRows = await client.query(
      'SELECT id FROM vector_stores WHERE id = $1 AND owner_email = $2 FOR UPDATE', [storeId, ownerEmail],
    );
    if (storeRows.rowCount === 0) {
      // No original error here — this is a no-op early return. But an unguarded
      // ROLLBACK on a dying connection turns "nothing to do" into a thrown error:
      // in commitChunks it reaches processOne's handleFailure and burns a retry
      // attempt on a file that was never broken; in the repository it surfaces as
      // an unmapped 500 instead of the documented {deleted:false}.
      await client.query('ROLLBACK').catch(() => {});
      return { deleted: false };
    }
    const del = await client.query(
      `DELETE FROM vector_store_files WHERE store_id = $1 AND file_id = $2 RETURNING file_id`,
      [storeId, fileId],
    );
    if (del.rowCount === 0) {
      // No original error here — this is a no-op early return. But an unguarded
      // ROLLBACK on a dying connection turns "nothing to do" into a thrown error:
      // in commitChunks it reaches processOne's handleFailure and burns a retry
      // attempt on a file that was never broken; in the repository it surfaces as
      // an unmapped 500 instead of the documented {deleted:false}.
      await client.query('ROLLBACK').catch(() => {});
      return { deleted: false };
    }
    await client.query('DELETE FROM vector_store_chunks WHERE store_id = $1 AND file_id = $2', [storeId, fileId]);
    await client.query(
      `UPDATE vector_stores SET last_active_at = now(), expires_at = ${RECOMPUTE_EXPIRES_AT_SQL} WHERE id = $1`,
      [storeId],
    );
    await client.query('COMMIT');
    return { deleted: true };
  } catch (e) {
    // Swallow a failing ROLLBACK: it fires precisely when the connection is
    // already broken, and letting it throw replaces the error that explains why.
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Deletes `storeId` (scoped to `ownerEmail` in the SQL) and cascades to
 * every file it contains: chunks are removed, then `vector_store_files`
 * rows, then the store itself. One transaction, so a crash mid-cascade
 * cannot leave chunks without their attachment row, or an attachment row
 * without its store. Returns `deleted: false` — never a distinguishing
 * error — for a store that doesn't exist or isn't owned by `ownerEmail`.
 *
 * Deliberately does NOT touch `fs_files` or any blob — see `deleteStoreFile`
 * above for why: deleting a store removes that store's associations and
 * chunks only, never the underlying files, which may still be attached to
 * (or later attached to) other stores.
 */
export async function deleteStoreCascade(storeId: string, ownerEmail: string): Promise<{ deleted: boolean }> {
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const storeRows = await client.query(
      'SELECT id FROM vector_stores WHERE id = $1 AND owner_email = $2 FOR UPDATE', [storeId, ownerEmail],
    );
    if (storeRows.rowCount === 0) {
      // No original error here — this is a no-op early return. But an unguarded
      // ROLLBACK on a dying connection turns "nothing to do" into a thrown error:
      // in commitChunks it reaches processOne's handleFailure and burns a retry
      // attempt on a file that was never broken; in the repository it surfaces as
      // an unmapped 500 instead of the documented {deleted:false}.
      await client.query('ROLLBACK').catch(() => {});
      return { deleted: false };
    }
    await client.query('DELETE FROM vector_store_chunks WHERE store_id = $1', [storeId]);
    await client.query('DELETE FROM vector_store_files WHERE store_id = $1', [storeId]);
    await client.query('DELETE FROM vector_stores WHERE id = $1', [storeId]);
    await client.query('COMMIT');
    return { deleted: true };
  } catch (e) {
    // Swallow a failing ROLLBACK: it fires precisely when the connection is
    // already broken, and letting it throw replaces the error that explains why.
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Search (Task 12)
// ---------------------------------------------------------------------------

/**
 * Touches `last_active_at` (and, via `RECOMPUTE_EXPIRES_AT_SQL`, slides
 * `expires_at` along with it) for every store in `storeIds`, in one grouped
 * UPDATE rather than one per store. Called by `search.ts`'s
 * `searchVectorStores` after a search completes — the design spec requires
 * `last_active_at` to be touched "on every search and every file mutation",
 * since `expires_after.anchor` is `'last_active_at'`.
 *
 * A plain UPDATE (not a transaction with an explicit `FOR UPDATE`): it takes
 * an ordinary row-level write lock on each matched `vector_stores` row for
 * the duration of this one statement, which is enough to serialize safely
 * against the expiry sweeper's own `FOR UPDATE` re-check (see
 * `expirySweeper.ts`) without risking a lock-order deadlock — this function
 * only ever touches the single `vector_stores` table, so there is no second
 * table whose lock order could cycle against it.
 */
export async function touchStoreActivity(storeIds: string[]): Promise<void> {
  if (storeIds.length === 0) return;
  const pool = getPool();
  if (!pool) return;
  await pool.query(
    `UPDATE vector_stores SET last_active_at = now(), expires_at = ${RECOMPUTE_EXPIRES_AT_SQL} WHERE id = ANY($1)`,
    [storeIds],
  );
}

// ---------------------------------------------------------------------------
// The `file_search` tool's pre-turn access guard (Task 6)
// ---------------------------------------------------------------------------

/**
 * Thrown for a `file_search` TOOL request the caller got wrong — an empty
 * `vector_store_ids`, or an id the caller may not read. Callers map this to
 * HTTP 400 with `code: 'invalid_request_error'`.
 *
 * Lives here, next to the other repository-level input errors
 * (`RecallInputError`, `AttributeValidationError`), rather than in
 * `plugins/fileSearch/descriptor.ts` where the tool layer also throws it:
 * `assertStoresAccessible` below is its first thrower, and a descriptor-owned
 * class would make `src/fileSearch/` (core) import from `src/plugins/` — the
 * wrong direction, and a cycle, since the descriptor imports this module.
 */
export class ToolRequestError extends Error {
  readonly status = 400;
  readonly code = 'invalid_request_error';
  constructor(message: string) {
    super(message);
    this.name = 'ToolRequestError';
  }
}

/**
 * Refuses a `file_search` tool request that names a vector store the caller
 * cannot read, or cannot search, BEFORE the turn opens. Throws
 * `ToolRequestError` (400) naming the first inaccessible id,
 * `StoreExpiredError` (409) for an accessible-but-expired store, or
 * `StoreDimensionMismatchError` (409) for one whose pinned `embedding_dim`
 * has drifted from the live configuration; resolves silently when every id is
 * readable and searchable.
 *
 * This is the one honest moment in the whole tool flow. Once the response
 * stream is live, a typo'd `vector_store_id` and an empty corpus are
 * indistinguishable to the caller forever — both are simply "no passages
 * found" — so a mistake that is not caught here is never reported at all.
 *
 * EVERY PRE-CONDITION `searchVectorStores` ENFORCES MUST BE CHECKED HERE TOO,
 * for that same reason: anything it refuses but this admits becomes a turn
 * that opens and then fails on every single call, with nothing the caller can
 * see. That is not a general principle to apply loosely — it is a mechanical
 * one. The per-store loop below mirrors `search.ts`'s own, in the same order,
 * calling the same two assertions on the same three columns its sibling query
 * selects (`id`, `status`, `embedding_dim`). If a third pre-condition is ever
 * added there, it belongs here too, and
 * `storeAccessGuard.test.ts`'s "agrees with searchVectorStores about which
 * stores are usable" is what will say so: it compares the two functions'
 * failures field for field against a real database, on every axis.
 *
 * Both 409s keep their own status rather than being folded into the 400: an
 * expired or dimension-drifted store is a real, actionable state of a store
 * the caller demonstrably may read — not a malformed request — and the
 * distinction leaks nothing, because the ownership check has already passed
 * by the time either can be raised.
 *
 * NOT AN EXISTENCE ORACLE: an unknown id and a live id owned by someone else
 * produce the SAME error, with the same status and the same wording. A
 * distinct status (403 for "exists but not yours", 404 for "no such store")
 * would let any caller enumerate which store ids exist on the deployment by
 * reading the difference. `searchVectorStores` already makes this exact
 * choice — see `SearchStoreNotFoundError`'s "404, never 403" note in
 * `search.ts` — and this must not diverge from it.
 *
 * Ownership is `STORE_ACCESS_PREDICATE_SQL`, the same fragment
 * `recallCandidates` ANDs into both its CTEs — not a second rule that happens
 * to agree today.
 *
 * `ownerEmail` may be undefined (`PrepareCtx` types it so): the predicate then
 * matches shared stores only, which is fail-safe — an unowned private store is
 * rejected rather than admitted. It is not treated as an error here because a
 * request that reaches the model with only shared stores is still a coherent
 * request; `recallCandidates` throws on an empty `ownerEmail` later if the
 * search itself is ever attempted with one.
 */
export async function assertStoresAccessible(
  storeIds: string[],
  ownerEmail: string | undefined,
): Promise<void> {
  if (storeIds.length === 0) return;
  const pool = getPool();
  if (!pool) throw new Error('file_search database is not configured');
  // The same three columns `search.ts`'s sibling ownership query selects, for
  // the same two assertions below.
  const { rows } = await pool.query<{ id: string; status: string; embedding_dim: number }>(
    `SELECT vs.id, vs.status, vs.embedding_dim FROM vector_stores vs
      WHERE vs.id = ANY($1) AND ${STORE_ACCESS_PREDICATE_SQL}`,
    [storeIds, ownerEmail ?? null],
  );
  const found = new Set(rows.map((r) => r.id));
  const missing = storeIds.find((id) => !found.has(id));
  if (missing !== undefined) {
    // Deliberately the same message for "no such store" and "not yours" —
    // see the NOT AN EXISTENCE ORACLE note above.
    throw new ToolRequestError(`Unknown vector store: ${missing}`);
  }
  // Strictly AFTER the accessibility check, never interleaved with it: a 409
  // is only ever raised for a store the caller has already proved it may read,
  // so it can never become the oracle the 400 above is careful not to be.
  // (`rows` contains only readable stores by construction, so this holds
  // whatever order the caller listed its ids in.)
  //
  // Assertion order matches `search.ts`'s loop exactly — expiry, then
  // dimension — so a store that is BOTH expired and drifted fails identically
  // in both places rather than by whichever check happened to run first.
  for (const store of rows) {
    assertStoreNotExpired(store);
    // eslint-disable-next-line no-await-in-loop
    await assertStoreDimension(store);
  }
}
