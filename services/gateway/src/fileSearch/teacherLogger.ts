// Fire-and-forget logger for reranker teacher-label data: one
// `reranker_search_events` row plus N `reranker_candidate_labels` rows,
// written in a single transaction. Called from the search path (search.ts,
// a later task) after a response has already been assembled — this module
// never influences what gets returned to a caller.
//
// The property that matters above all others: a failure here must never
// become a failure of the search request that triggered it. record()
// therefore:
//  - returns void, never a Promise, so it cannot accidentally be awaited by
//    a caller and pull a slow/failing write onto the request's critical path;
//  - launches its work in an async IIFE (writeRecord) that it deliberately
//    does not return;
//  - catches every error inside that IIFE and only ever logs at `warn`.
//
// It also protects the connection pool it shares with search, ingestion and
// the expiry sweeper (`max: 10`, see db.ts): a semaphore of
// `maxConcurrentWrites` in-flight writes, and when saturated the write is
// DROPPED, not queued. An unbounded queue behind a slow write would let a
// burst of searches occupy every pool connection writing labels while real
// search queries queue behind them — a dropped label costs one training
// example, a starved pool costs the feature.
//
// It self-disables on a structural database error (42501 insufficient
// privilege, 42P01 undefined table): every subsequent write would fail
// identically, so this sets a module flag and stops attempting rather than
// warning on every single search forever.
//
// Text storage is gated independently of logging itself (`storeChunkText`):
// `chunk_hash` (a sha256 of the raw chunk text) is always written, so
// agreement between the teacher and RRF orderings can be measured even when
// document text is never persisted; `chunk_text` is only populated when
// `storeChunkText` is true. Enabling logging must never, by itself, start
// persisting document contents.
import * as crypto from 'crypto';
import { getPool } from './db';
import { getTeacherLoggingConfig, TeacherLoggingConfig } from '../services/configService';
import { CandidateChunk, candidateId } from './repository';
import { getDefaultLogger } from '@libs/logger';

const logger = getDefaultLogger();

export interface TeacherLogInput {
  queryText: string;
  queryRewritten?: string;
  rewriteUsed: boolean;
  storeIds: string[];
  ownerEmail: string;
  source?: string;
  /** The full set handed to the teacher (the reranker), in recall/request order. */
  candidates: CandidateChunk[];
  /** Reranker output, relevance-descending; null when the search was rrf_only. */
  teacher: Array<{ index: number; relevanceScore: number }> | null;
  /** candidateId()s that survived top-k/threshold filtering. */
  selectedIds: Set<string>;
  rerankerProvider?: string;
  rerankerModel?: string;
  rerankerSearchUnits?: number;
  embeddingModel: string;
  embeddingDim: number;
  candidatesRequested: number;
  rrfK: number;
  lexicalEnabled: boolean;
  topK?: number;
  scoreThreshold?: number;
  requestId?: string;
  embedLatencyMs?: number;
  rerankLatencyMs?: number;
  totalLatencyMs?: number;
}

let inFlight = 0;
let disabled = false;
let dropped = 0;
let written = 0;
// Counts writes that FAILED, whether or not the failure was structural enough
// to self-disable. Kept separate from `disabled` so a test can wait on "a write
// failed" without coupling itself to the 42501/42P01 self-disable list — a test
// that waits on `disabled` silently stops testing the failure path the moment
// that list changes.
let failed = 0;
let rng: () => number = Math.random;

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

// 42501 = insufficient_privilege, 42P01 = undefined_table. Either means every
// subsequent write will fail identically (a role/migration problem, never a
// transient one) — self-disable instead of warning on every search forever.
function isSelfDisablingError(err: any): boolean {
  return !!err && (err.code === '42501' || err.code === '42P01');
}

// Never logs the query or chunk text here — those are user content, and this
// path is a `warn`, which (unlike the DB rows themselves) is not gated by
// storeChunkText at all.
function handleWriteFailure(err: any): void {
  failed++;
  logger.warn('TeacherLogger', `Teacher-label write failed: ${err?.message ?? String(err)}`);
  if (isSelfDisablingError(err)) {
    disabled = true;
    logger.warn('TeacherLogger',
      'Disabling teacher-label logging after a structural database error (insufficient privilege or ' +
      'undefined table); it will not be retried until the process restarts');
  }
}

async function writeRecord(input: TeacherLogInput, config: TeacherLoggingConfig): Promise<void> {
  const pool = getPool();
  if (!pool) return; // no database configured — normal for standalone installs, not an error

  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    handleWriteFailure(err);
    return;
  }

  try {
    await client.query('BEGIN');

    const eventId = newId('rse');
    const teacherAvailable = input.teacher !== null;
    const retrievalMode = teacherAvailable ? 'reranked' : 'rrf_only';
    const source = input.source ?? config.source;

    await client.query(
      `INSERT INTO reranker_search_events (
         id, query_text, query_hash, source, store_ids, owner_email, retrieval_mode,
         candidates_requested, candidates_returned, rrf_k, lexical_enabled,
         embedding_model, embedding_dim, reranker_provider, reranker_model,
         reranker_available, reranker_search_units, rewrite_used, query_rewritten,
         embed_latency_ms, rerank_latency_ms, total_latency_ms, top_k, score_threshold, request_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
      [
        eventId, input.queryText, sha256Hex(input.queryText), source, input.storeIds, input.ownerEmail, retrievalMode,
        input.candidatesRequested, input.candidates.length, input.rrfK, input.lexicalEnabled,
        input.embeddingModel, input.embeddingDim, input.rerankerProvider ?? null, input.rerankerModel ?? null,
        teacherAvailable, input.rerankerSearchUnits ?? null, input.rewriteUsed, input.queryRewritten ?? null,
        input.embedLatencyMs ?? null, input.rerankLatencyMs ?? null, input.totalLatencyMs ?? null,
        input.topK ?? null, input.scoreThreshold ?? null, input.requestId ?? null,
      ],
    );

    // teacher[i].index is the position within `candidates` (== candidate_index);
    // the array's own position i is the teacher's rank (results already arrive
    // relevance-descending, see reranker.ts).
    const teacherByIndex = new Map<number, { rank: number; score: number }>();
    if (input.teacher) {
      input.teacher.forEach((hit, i) => teacherByIndex.set(hit.index, { rank: i + 1, score: hit.relevanceScore }));
    }

    if (input.candidates.length > 0) {
      const columns = [
        'id', 'event_id', 'candidate_index', 'store_id', 'file_id', 'ord', 'filename',
        'chunk_hash', 'chunk_text', 'chunk_tokens', 'retrieval_rank', 'rrf_score',
        'vector_rank', 'vector_score', 'lexical_rank', 'lexical_score',
        'teacher_rank', 'teacher_score', 'selected', 'attributes',
      ];
      const values: unknown[] = [];
      const placeholderGroups: string[] = [];

      // Single walk over `candidates`: candidate_index is the array position,
      // retrieval_rank is index + 1 (see the module doc comment on why both
      // are kept despite being identical today), teacher_rank/_score come
      // from the map above, selected from selectedIds via the shared
      // candidateId() key format.
      input.candidates.forEach((candidate, index) => {
        const teacherHit = teacherByIndex.get(index);
        const selected = input.selectedIds.has(candidateId(candidate.storeId, candidate.fileId, candidate.ord));
        const row: unknown[] = [
          newId('rcl'), eventId, index, candidate.storeId, candidate.fileId, candidate.ord, candidate.filename,
          sha256Hex(candidate.text), config.storeChunkText ? candidate.text : null, null,
          index + 1, candidate.score,
          candidate.vectorRank ?? null, candidate.vectorScore ?? null,
          candidate.lexicalRank ?? null, candidate.lexicalScore ?? null,
          teacherHit ? teacherHit.rank : null, teacherHit ? teacherHit.score : null,
          selected, candidate.attributes,
        ];
        const base = values.length;
        placeholderGroups.push(`(${row.map((_, i) => `$${base + i + 1}`).join(',')})`);
        values.push(...row);
      });

      // One multi-row INSERT for all labels — not N round-trips — so a crash
      // partway through never leaves some of a search's labels written and
      // others missing.
      await client.query(
        `INSERT INTO reranker_candidate_labels (${columns.join(', ')}) VALUES ${placeholderGroups.join(', ')}`,
        values,
      );
    }

    await client.query('COMMIT');
    written++;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    handleWriteFailure(err);
  } finally {
    client.release();
  }
}

/**
 * Fire-and-forget: records one search event plus its candidate labels.
 *
 * Returns void, never a Promise — callers must not be able to `await` this
 * by accident, since a slow or failing write must never delay or fail the
 * search response that triggered it. Every error raised anywhere in the
 * write path is caught internally and only ever surfaces as a `warn` log.
 */
export function record(input: TeacherLogInput): void {
  // The synchronous prologue below (config lookup, the sample-rate RNG call,
  // the semaphore check) runs before any async boundary, so a throw here
  // would otherwise propagate straight out of record() as a real, synchronous
  // exception into the search path — the one outcome this module exists to
  // prevent. Own that guarantee here rather than relying on
  // getTeacherLoggingConfig()'s own try/catch never going away.
  try {
    const config = getTeacherLoggingConfig();
    if (!config.enabled) return;
    if (disabled) return;
    if (rng() >= config.sampleRate) return;

    if (inFlight >= config.maxConcurrentWrites) {
      dropped++;
      return;
    }

    inFlight++;
    writeRecord(input, config)
      .catch((err) => handleWriteFailure(err)) // defensive: writeRecord already catches everything itself
      .finally(() => { inFlight--; });
  } catch (err) {
    handleWriteFailure(err);
  }
}

export function __statsForTests(): { dropped: number; written: number; failed: number; disabled: boolean } {
  return { dropped, written, failed, disabled };
}

export function __setRngForTests(fn: () => number): void {
  rng = fn;
}

export function __resetForTests(): void {
  inFlight = 0;
  disabled = false;
  dropped = 0;
  written = 0;
  failed = 0;
  rng = Math.random;
}
