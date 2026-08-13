/**
 * Splits a SQL script into individual statements on top-level semicolons.
 *
 * Written as a scanner rather than `sql.split(';')` because a mis-split is
 * silent: it produces statements that still execute, just not the ones that
 * were written. The schema below contains `--` comments and single-quoted
 * literals today; dollar-quoting and block comments are handled so that adding
 * a function body or a DO block later cannot quietly corrupt the split.
 *
 * Leading comments and whitespace are stripped from each statement, so the
 * first line of a returned statement is the SQL itself. That matters beyond
 * tidiness: db.ts quotes it when reporting a rejected statement, and the
 * schema's largest comment block sits directly above `vector_store_batches` —
 * an unstripped statement would report the prose and not the DDL. A trailing
 * statement without a semicolon is still returned.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let i = 0;

  /** Drops comment-only and whitespace prefixes; keeps comments that sit
   *  inside a statement, which are part of the SQL being sent. */
  const stripLeadingComments = (text: string): string => {
    let s = text.trim();
    for (;;) {
      if (s.startsWith('--')) {
        const nl = s.indexOf('\n');
        if (nl === -1) return '';
        s = s.slice(nl + 1).trim();
      } else if (s.startsWith('/*')) {
        const end = s.indexOf('*/');
        if (end === -1) return '';
        s = s.slice(end + 2).trim();
      } else {
        return s;
      }
    }
  };

  while (i < sql.length) {
    const ch = sql[i];

    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
    } else if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
    } else if (ch === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; } // escaped quote, not the end
          i += 1;
          break;
        }
        i += 1;
      }
    } else if (ch === '"') {
      i += 1;
      while (i < sql.length && sql[i] !== '"') i += 1;
      i += 1;
    } else if (ch === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? sql.length : end + tag.length;
      } else {
        i += 1;
      }
    } else if (ch === ';') {
      const statement = stripLeadingComments(sql.slice(start, i));
      if (statement) statements.push(statement);
      i += 1;
      start = i;
    } else {
      i += 1;
    }
  }

  const tail = stripLeadingComments(sql.slice(start));
  if (tail) statements.push(tail);
  return statements;
}

export const buildSchemaSql = (embeddingDim: number): string => {
  if (!Number.isInteger(embeddingDim) || embeddingDim < 1 || embeddingDim > 16000) {
    throw new Error(`Invalid embedding dimension: ${embeddingDim}`);
  }
  return `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS file_blobs (
  sha256      text PRIMARY KEY,
  size_bytes  bigint NOT NULL,
  mime        text,
  ref_count   int NOT NULL DEFAULT 0,
  storage     text NOT NULL,
  bytes       bytea,
  location    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fs_files (
  id          text PRIMARY KEY,
  owner_email text NOT NULL,
  filename    text NOT NULL,
  purpose     text NOT NULL,
  sha256      text NOT NULL REFERENCES file_blobs(sha256),
  size_bytes  bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fs_files_owner ON fs_files (owner_email, created_at, id);

CREATE TABLE IF NOT EXISTS vector_stores (
  id              text PRIMARY KEY,
  owner_email     text NOT NULL,
  is_shared       boolean NOT NULL DEFAULT false,
  name            text,
  status          text NOT NULL DEFAULT 'completed',
  metadata        jsonb,
  embedding_model text NOT NULL,
  embedding_dim   int  NOT NULL,
  expires_after   jsonb,
  expires_at      timestamptz,
  last_active_at  timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vector_stores_owner ON vector_stores (owner_email, created_at, id);

CREATE TABLE IF NOT EXISTS vector_store_files (
  store_id          text NOT NULL REFERENCES vector_stores(id) ON DELETE CASCADE,
  file_id           text NOT NULL REFERENCES fs_files(id),
  attributes        jsonb,
  chunking_strategy jsonb,
  status            text NOT NULL DEFAULT 'in_progress',
  last_error        jsonb,
  usage_bytes       bigint,
  claimed_at        timestamptz,
  attempts          int NOT NULL DEFAULT 0,
  batch_id          text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, file_id)
);
CREATE INDEX IF NOT EXISTS idx_vsf_claim ON vector_store_files (status, claimed_at);
CREATE INDEX IF NOT EXISTS idx_vsf_batch ON vector_store_files (store_id, batch_id);

-- A file batch is a LABEL over vector_store_files rows, not a container of
-- its own: membership lives entirely in vector_store_files.batch_id, which
-- has been in this schema (unwritten and unread) since the column was added
-- for exactly this feature.
--
-- Note what is absent: no status column, no file_counts column. Both are
-- DERIVED from the member rows on read (see batchStatusAndCounts in
-- batches.ts). Storing them would make the ingestion worker maintain a second
-- source of truth on every per-file status transition, under concurrency,
-- with no test able to prove the two agree across all interleavings.
-- cancel_requested is the only mutable state here, and it is a one-way latch.
--
-- store_id carries the same ON DELETE CASCADE as vector_store_files.store_id.
-- deleteStoreCascade() deletes vector_stores rows explicitly and does not
-- know about this table; the FK is what keeps a deleted store from leaving
-- its batch rows behind forever (and from letting getBatch resolve a batch
-- whose store is gone).
CREATE TABLE IF NOT EXISTS vector_store_batches (
  id               text PRIMARY KEY,
  store_id         text NOT NULL REFERENCES vector_stores(id) ON DELETE CASCADE,
  cancel_requested boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_batches_store ON vector_store_batches (store_id);

CREATE TABLE IF NOT EXISTS vector_store_chunks (
  store_id  text NOT NULL,
  file_id   text NOT NULL,
  ord       int  NOT NULL,
  text      text NOT NULL,
  tokens    int,
  embedding vector(${embeddingDim}) NOT NULL,
  tsv       tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
  PRIMARY KEY (store_id, file_id, ord)
);
CREATE INDEX IF NOT EXISTS idx_chunks_hnsw ON vector_store_chunks
  USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_chunks_tsv ON vector_store_chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS idx_chunks_store ON vector_store_chunks (store_id, file_id);

CREATE TABLE IF NOT EXISTS reranker_search_events (
  id                    text PRIMARY KEY,
  created_at            timestamptz NOT NULL DEFAULT now(),
  query_text            text NOT NULL,
  query_hash            text NOT NULL,
  source                text NOT NULL,
  store_ids             text[] NOT NULL,
  owner_email           text,
  retrieval_mode        text NOT NULL,
  candidates_requested  int,
  candidates_returned   int,
  rrf_k                 int,
  lexical_enabled       boolean,
  embedding_model       text,
  embedding_dim         int,
  reranker_provider     text,
  reranker_model        text,
  reranker_available    boolean NOT NULL,
  reranker_search_units int,
  rewrite_used          boolean,
  query_rewritten       text,
  embed_latency_ms      int,
  rerank_latency_ms     int,
  total_latency_ms      int,
  top_k                 int,
  score_threshold       double precision,
  request_id            text,
  metadata              jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_rse_created ON reranker_search_events (created_at);
CREATE INDEX IF NOT EXISTS idx_rse_query_hash ON reranker_search_events (query_hash);
CREATE INDEX IF NOT EXISTS idx_rse_source ON reranker_search_events (source);

CREATE TABLE IF NOT EXISTS reranker_candidate_labels (
  id               text PRIMARY KEY,
  event_id         text NOT NULL REFERENCES reranker_search_events(id) ON DELETE CASCADE,
  candidate_index  int NOT NULL,
  store_id         text NOT NULL,
  file_id          text NOT NULL,
  ord              int  NOT NULL,
  filename         text,
  chunk_hash       text NOT NULL,
  chunk_text       text,
  chunk_tokens     int,
  retrieval_rank   int NOT NULL,
  rrf_score        double precision,
  vector_rank      int,
  vector_score     double precision,
  lexical_rank     int,
  lexical_score    double precision,
  teacher_rank     int,
  teacher_score    double precision,
  selected         boolean NOT NULL DEFAULT false,
  attributes       jsonb,
  UNIQUE (event_id, candidate_index)
);
CREATE INDEX IF NOT EXISTS idx_rcl_event ON reranker_candidate_labels (event_id);
CREATE INDEX IF NOT EXISTS idx_rcl_chunk_hash ON reranker_candidate_labels (chunk_hash);
CREATE INDEX IF NOT EXISTS idx_rcl_teacher_rank ON reranker_candidate_labels (event_id, teacher_rank);
`;
};
