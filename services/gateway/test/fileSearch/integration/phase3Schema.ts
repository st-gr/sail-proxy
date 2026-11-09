// The file_search schema exactly as it stood at the end of Grounding phase 3
// (buildSchemaSql at db0d2b27), frozen here so the phase-4a upgrade test starts
// from the real pre-generation shape: chunk primary key (store_id, file_id,
// ord), no generation or active_generation, fs_jobs without the re-embed
// columns, no fs_reembed_items. A copy rather than a slice of the live schema,
// because the live CREATE TABLE statements already carry the new shape.
// Never edit it to follow the live schema.
export const phase3SchemaSql = (embeddingDim: number): string => {
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

-- The admin's all-owner lists (admin.ts): newest first, keyset-paged on
-- (created_at, id), so each is an index walk and not a scan and sort of the
-- whole table. idx_vsf_file serves every lookup by file alone (the primary key
-- leads with store_id). idx_vsf_failed carries the failed list's filter AND its
-- order; idx_vsf_claim serves the filter only.
CREATE INDEX IF NOT EXISTS idx_vector_stores_created ON vector_stores (created_at, id);
CREATE INDEX IF NOT EXISTS idx_fs_files_created ON fs_files (created_at, id);
CREATE INDEX IF NOT EXISTS idx_vsf_file ON vector_store_files (file_id);
CREATE INDEX IF NOT EXISTS idx_vsf_failed ON vector_store_files (created_at, store_id, file_id) WHERE status = 'failed';

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

-- A job tracks a unit of long-running work the cockpit follows. Today the only
-- kind is 'file_batch', one job per vector_store_batches row. Like the batch,
-- a job's state and counters are NOT stored: they are derived on read from the
-- batch's member files and its cancel latch (see jobs.ts), so they cannot drift
-- from what the worker did. Stored here is only what the member rows cannot
-- say: who started it with which credential, timestamps, tokens and an error.
CREATE TABLE IF NOT EXISTS fs_jobs (
  id               text PRIMARY KEY,
  kind             text NOT NULL,
  parent_id        text,
  owner_email      text,
  started_by       text,
  credential_id    text,
  auth_type        text,
  store_id         text REFERENCES vector_stores(id) ON DELETE CASCADE,
  batch_id         text UNIQUE,
  embedding_tokens bigint NOT NULL DEFAULT 0,
  error            jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz
);
CREATE INDEX IF NOT EXISTS idx_fs_jobs_owner ON fs_jobs (owner_email, created_at, id);
CREATE INDEX IF NOT EXISTS idx_fs_jobs_finished ON fs_jobs (finished_at);
-- Backfill: batches created before fs_jobs existed get their job row. The id
-- is derived from the batch id, and NOT EXISTS makes a re-run on every boot a
-- no-op; createBatch creates the job for every batch made since.
--
-- Only the last 29 days, because the history sweeper deletes jobs finished
-- more than 30 days ago and this runs on every boot: a swept job's batch is
-- older than 30 days, so the window is what keeps it from being recreated.
-- The day of margin is for the clocks: a batch's created_at comes from the
-- gateway, finished_at and the sweep cutoff from the database.
-- A batch with no member in_progress is finished now, so its job ages out of
-- history like any other.
INSERT INTO fs_jobs (id, kind, owner_email, started_by, store_id, batch_id, created_at, finished_at)
  SELECT 'job_' || substr(md5(b.id), 1, 24), 'file_batch', s.owner_email, s.owner_email, b.store_id, b.id, b.created_at,
         CASE WHEN EXISTS (SELECT 1 FROM vector_store_files f
                            WHERE f.store_id = b.store_id AND f.batch_id = b.id AND f.status = 'in_progress')
              THEN NULL ELSE now() END
    FROM vector_store_batches b JOIN vector_stores s ON s.id = b.store_id
   WHERE b.created_at > now() - interval '29 days'
     AND NOT EXISTS (SELECT 1 FROM fs_jobs j WHERE j.batch_id = b.id);
`;
};
