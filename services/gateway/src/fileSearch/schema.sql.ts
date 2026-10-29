import {
  MAX_EMBEDDING_DIMENSIONS, VECTOR_HNSW_MAX_DIMENSIONS, VECTOR_INDEX_NAME, HALFVEC_MIN_PGVECTOR, halfvecIndexDefinition,
} from './vectorIndex';

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

/**
 * Indexes the schema runner builds in a transaction of their own, after the
 * one that adds columns has committed. A column addition holds ACCESS
 * EXCLUSIVE on its table until its transaction ends; an index built over the
 * same table in that transaction would hold every read of it for the length of
 * the build's scan. Built separately, the scan blocks only writes. Listed here
 * are the performance indexes on tables that gained columns in the same
 * release; the statement itself stays in buildSchemaSql(), so the full script
 * still builds the whole schema when run as one.
 */
export const POST_COMMIT_INDEXES: readonly string[] = ['idx_chunks_context_tsv', 'idx_fs_files_expires_at'];

/** The schema's statements split into the main transaction's and the
 *  post-commit index builds (POST_COMMIT_INDEXES), each in script order. */
export function splitSchemaPhases(sql: string): { main: string[]; post: string[] } {
  const main: string[] = [];
  const post: string[] = [];
  for (const statement of splitSqlStatements(sql)) {
    const index = /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/.exec(statement)?.[1];
    (index && POST_COMMIT_INDEXES.includes(index) ? post : main).push(statement);
  }
  return { main, post };
}

export { MAX_EMBEDDING_DIMENSIONS, VECTOR_HNSW_MAX_DIMENSIONS };

/** Why a configured embedding width cannot be used, or null when it can. */
export function embeddingDimensionsProblem(embeddingDim: unknown): string | null {
  if (typeof embeddingDim === 'number' && Number.isInteger(embeddingDim)
    && embeddingDim >= 1 && embeddingDim <= MAX_EMBEDDING_DIMENSIONS) return null;
  return `file_search.embedding_dimensions must be a whole number from 1 to ${MAX_EMBEDDING_DIMENSIONS} `
    + `(got ${String(embeddingDim)}): pgvector cannot index wider vectors`;
}

export const buildSchemaSql = (embeddingDim: number): string => {
  const problem = embeddingDimensionsProblem(embeddingDim);
  if (problem) throw new Error(`Invalid embedding dimension: ${problem}`);
  // The previous plain-vector index, for pgvector older than 0.7 (no halfvec), where
  // pgvector can build it at all (2000 dimensions).
  const previousKind = embeddingDim <= VECTOR_HNSW_MAX_DIMENSIONS
    ? `ELSE
    EXECUTE 'CREATE INDEX ${VECTOR_INDEX_NAME} ON vector_store_chunks USING hnsw (embedding vector_cosine_ops)';
  `
    : '';
  // The approximate-search index (vectorIndex.ts), created on a new install only:
  // when no index of that name exists AND the chunk table is empty, so the build is
  // free. An existing install keeps the index it has, whatever its kind, until an
  // operator runs `file-search-migrate.js rebuild-index`; and an install with chunks
  // but no index (e.g. one first migrated above 2000 dimensions) is never built at
  // boot either: over existing chunks the build takes minutes to hours, holds the
  // schema transaction and blocks writes. db.ts logs that case. Not
  // `CREATE INDEX IF NOT EXISTS`, which would build over a populated table.
  const hnswIndex = `DO $$
DECLARE
  pgvector int[];
BEGIN
  IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
              WHERE i.indrelid = 'vector_store_chunks'::regclass AND ic.relname = '${VECTOR_INDEX_NAME}')
     OR EXISTS (SELECT 1 FROM vector_store_chunks) THEN
    RETURN;
  END IF;
  SELECT (regexp_match(extversion, '^(\\d+)\\.(\\d+)'))::int[] INTO pgvector FROM pg_extension WHERE extname = 'vector';
  IF pgvector >= ARRAY[${HALFVEC_MIN_PGVECTOR[0]}, ${HALFVEC_MIN_PGVECTOR[1]}] THEN
    EXECUTE 'CREATE INDEX ${VECTOR_INDEX_NAME} ON vector_store_chunks ${halfvecIndexDefinition(embeddingDim)}';
  ${previousKind}END IF;
END
$$;
`;
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
  created_at  timestamptz NOT NULL DEFAULT now(),
  delete_after timestamptz
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
  created_at      timestamptz NOT NULL DEFAULT now(),
  active_generation int NOT NULL DEFAULT 0,
  chunking        jsonb
);
CREATE INDEX IF NOT EXISTS idx_vector_stores_owner ON vector_stores (owner_email, created_at, id);

-- Columns added after a table first shipped are added by a DO block that looks
-- in the catalog first, not by a bare ALTER: ALTER TABLE takes an ACCESS
-- EXCLUSIVE lock even when ADD COLUMN IF NOT EXISTS has nothing to do, and this
-- script runs on every boot of every replica — a bare ALTER would wait for every
-- running search and ingestion on the table and block every new one meanwhile.
-- The guard makes the steady-state re-application read-only. A role that does not own
-- the table cannot add the column; db.ts probes for every column the code
-- needs and reports file_search unavailable when one is missing.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'vector_stores'::regclass
                    AND attname = 'active_generation' AND NOT attisdropped) THEN
    ALTER TABLE vector_stores ADD COLUMN IF NOT EXISTS active_generation int NOT NULL DEFAULT 0;
  END IF;
  -- The store's chunking setting (strategy, sizes, contextual), written at
  -- creation; NULL (a store from before the column) means static 800/400.
  -- Not in metadata, which is the caller's own.
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'vector_stores'::regclass
                    AND attname = 'chunking' AND NOT attisdropped) THEN
    ALTER TABLE vector_stores ADD COLUMN IF NOT EXISTS chunking jsonb;
  END IF;
END
$$;

-- A blob whose last reference is gone keeps its row (and its bytes or object)
-- until delete_after: readers that resolved the row just before the release
-- still find it, and a retain within the grace revives it. NULL is a live
-- blob. The blob sweeper deletes the row and then the object once it is due.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'file_blobs'::regclass
                    AND attname = 'delete_after' AND NOT attisdropped) THEN
    ALTER TABLE file_blobs ADD COLUMN IF NOT EXISTS delete_after timestamptz;
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS idx_file_blobs_delete_after ON file_blobs (delete_after) WHERE delete_after IS NOT NULL;

-- OpenAI's file expiry (expires_after {anchor: created_at, seconds} on upload): the instant the file
-- expires, from the database clock; NULL never expires. Nullable without a default: a catalog change
-- only. The expiry sweeper (expirySweeper.ts) deletes due files the way DELETE /files/{id} does, and
-- finds them through the partial index, which holds only the files that expire at all.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'fs_files'::regclass
                    AND attname = 'expires_at' AND NOT attisdropped) THEN
    ALTER TABLE fs_files ADD COLUMN IF NOT EXISTS expires_at timestamptz;
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS idx_fs_files_expires_at ON fs_files (expires_at) WHERE expires_at IS NOT NULL;

-- OpenAI's Uploads API (uploadsController.ts, uploads.ts): an upload and the parts staged for it until
-- it is completed into an fs_files row, cancelled or expired (one hour after creation; the expiry
-- sweeper deletes the parts of a pending upload past expires_at). Parts are staged here as bytea
-- whatever the blob backend, and every path that ends an upload deletes its parts in the same
-- transaction. expires_after_seconds is the file's own expiry (OpenAI's expires_after), applied when
-- the completion creates the file.
--
-- Created only by a role that owns fs_files, for file_blob_garbage's reason: a non-owner with CREATE
-- on the schema would own the new tables, and the owner's later CREATE INDEX IF NOT EXISTS would be
-- rejected (42501). A non-owner leaves them absent and db.ts reports file_search unavailable.
DO $$
BEGIN
  IF pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'fs_files'::regclass), 'USAGE') THEN
    CREATE TABLE IF NOT EXISTS fs_uploads (
      id                    text PRIMARY KEY,
      owner_email           text NOT NULL,
      filename              text NOT NULL,
      purpose               text NOT NULL,
      mime_type             text NOT NULL,
      bytes                 bigint NOT NULL,
      expires_after_seconds int,
      status                text NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'completed', 'cancelled', 'expired')),
      file_id               text,
      created_at            timestamptz NOT NULL DEFAULT now(),
      expires_at            timestamptz NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fs_uploads_owner_pending ON fs_uploads (owner_email) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_fs_uploads_pending_due ON fs_uploads (expires_at, id) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_fs_uploads_created ON fs_uploads (created_at) WHERE status <> 'pending';
    CREATE TABLE IF NOT EXISTS fs_upload_parts (
      id         text PRIMARY KEY,
      upload_id  text NOT NULL REFERENCES fs_uploads(id) ON DELETE CASCADE,
      size_bytes bigint NOT NULL,
      data       bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_fs_upload_parts_upload ON fs_upload_parts (upload_id);
  END IF;
END
$$;

-- Stores shared with teams (spec 2026-10-14 §8): a member of a team named here may read and search
-- the store (recallSql.ts storeAccessPredicateSql); everything else about the store stays the
-- owner's. team_id is the admin's Teams.ID; a team the admin deletes has its rows removed through
-- DELETE /admin/teams/:teamId/shares. Created only by a role that owns vector_stores, for
-- file_blob_garbage's reason: a non-owner leaves the table absent and db.ts reports file_search
-- unavailable, instead of owning a table the owner cannot index.
DO $$
BEGIN
  IF pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'vector_stores'::regclass), 'USAGE') THEN
    CREATE TABLE IF NOT EXISTS vector_store_team_shares (
      store_id   text NOT NULL REFERENCES vector_stores(id) ON DELETE CASCADE,
      team_id    text NOT NULL,
      shared_by  text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (store_id, team_id)
    );
    CREATE INDEX IF NOT EXISTS idx_vector_store_team_shares_team ON vector_store_team_shares (team_id);
  END IF;
END
$$;

-- Objects in external storage awaiting deletion that no file_blobs row points
-- to: a migration's source copy, and the object of a swept row that the
-- sweeper could not delete from its storage then. (A revive under a changed
-- prefix enqueues nothing: it re-PUTs to the current key and leaves the old
-- object, which the backend cannot address outside its prefix.) Keyed on
-- the object (storage + logical location), not on a row. No foreign key to
-- file_blobs: an entry names a key that no current row points to, and an FK
-- would also collide with the sweeper's use of 23503 on a row delete as its
-- refcount-drift signal. Keys are content-addressed, so a later write of the
-- same blob reuses the key; whoever is about to write a key deletes its entry
-- here first.
--
-- Created only by a role that owns file_blobs. The table references nothing,
-- so any role with CREATE on the schema could create it — and would then own
-- it, and the owner's later migration would be rejected (42501) on its
-- CREATE INDEX IF NOT EXISTS, which checks ownership before existence. A
-- non-owner leaves it absent and db.ts reports file_search unavailable.
DO $$
BEGIN
  IF pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'file_blobs'::regclass), 'USAGE') THEN
    CREATE TABLE IF NOT EXISTS file_blob_garbage (
      storage      text NOT NULL,
      location     text NOT NULL,
      sha256       text NOT NULL,
      enqueued_at  timestamptz NOT NULL DEFAULT now(),
      delete_after timestamptz NOT NULL DEFAULT now(),
      attempts     int NOT NULL DEFAULT 0,
      last_error   jsonb,
      PRIMARY KEY (storage, location)
    );
    CREATE INDEX IF NOT EXISTS idx_file_blob_garbage_due ON file_blob_garbage (delete_after);
    CREATE INDEX IF NOT EXISTS idx_file_blob_garbage_sha ON file_blob_garbage (sha256);
  END IF;
END
$$;

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
  credential_id     text,
  auth_type         text,
  on_behalf_of      text,
  PRIMARY KEY (store_id, file_id)
);
-- Who pays for the file's ingestion: the credential of the attach call, and on
-- a cockpit (grounding) call the store's owner. Null on rows attached before
-- usage was recorded (the ingest worker then falls back to the batch's job).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'vector_store_files'::regclass
                    AND attname = 'credential_id' AND NOT attisdropped) THEN
    ALTER TABLE vector_store_files ADD COLUMN IF NOT EXISTS credential_id text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'vector_store_files'::regclass
                    AND attname = 'auth_type' AND NOT attisdropped) THEN
    ALTER TABLE vector_store_files ADD COLUMN IF NOT EXISTS auth_type text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'vector_store_files'::regclass
                    AND attname = 'on_behalf_of' AND NOT attisdropped) THEN
    ALTER TABLE vector_store_files ADD COLUMN IF NOT EXISTS on_behalf_of text;
  END IF;
END
$$;
-- The extractor version (extractors/registry.ts EXTRACTION_VERSION) the file's chunks were read
-- with: written by every ingestion and by a re-chunk's switch; NULL for files read before it
-- existed. A re-extract (reextract.ts) reads again the files whose format the extractor reads
-- better since their version. ocr_pending: the read left PDF pages without text because OCR could
-- not run on that gateway (switched off, tesseract missing) — a re-extract on a gateway where OCR
-- runs reads the file again; pages past the cap or whose OCR failed do not make it pending. NULL
-- for files read before it existed. Nullable without defaults: a catalog change only.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'vector_store_files'::regclass
                    AND attname = 'extraction_version' AND NOT attisdropped) THEN
    ALTER TABLE vector_store_files ADD COLUMN IF NOT EXISTS extraction_version int;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'vector_store_files'::regclass
                    AND attname = 'ocr_pending' AND NOT attisdropped) THEN
    ALTER TABLE vector_store_files ADD COLUMN IF NOT EXISTS ocr_pending boolean;
  END IF;
END
$$;
-- context_stopped: the context writer stopped before it tried every chunk of the file because the
-- file reached its time ('deadline') or token ('budget') limit, so some chunks have no written
-- context; 'deadline_retried' when a re-chunk to the same setting (the fill) tried once more and
-- stopped again. The fill leaves 'budget' and 'deadline_retried' files alone (contextStop.ts). Written by every ingestion
-- and by a re-chunk's switch; NULL: no such stop (or read before it existed). Nullable, no default.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'vector_store_files'::regclass
                    AND attname = 'context_stopped' AND NOT attisdropped) THEN
    ALTER TABLE vector_store_files ADD COLUMN IF NOT EXISTS context_stopped text;
  END IF;
END
$$;
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

-- A store's chunks carry the generation they were embedded in. Readers see only
-- the store's active_generation; a re-embed writes generation active+1 next to
-- it and switches the store over in one transaction once every file is done.
-- Deleting a file or a store removes every generation.
CREATE TABLE IF NOT EXISTS vector_store_chunks (
  store_id   text NOT NULL,
  file_id    text NOT NULL,
  ord        int  NOT NULL,
  text       text NOT NULL,
  tokens     int,
  embedding  vector(${embeddingDim}),
  tsv        tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
  generation int  NOT NULL DEFAULT 0,
  context        text,
  context_tsv    tsvector,
  section        int,
  section_offset int,
  heading_path   text,
  page_start     int,
  page_end       int,
  PRIMARY KEY (store_id, file_id, generation, ord)
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'vector_store_chunks'::regclass
                    AND attname = 'generation' AND NOT attisdropped) THEN
    ALTER TABLE vector_store_chunks ADD COLUMN IF NOT EXISTS generation int NOT NULL DEFAULT 0;
  END IF;
END
$$;
-- Structured and contextual chunks. A structured chunk is an exact substring of
-- its section: section is the section's ordinal within the file,
-- section_offset the chunk's character offset within the section, and
-- heading_path the section's headings joined by ' > '. context is what the
-- chunk is embedded and lexically matched with besides its text (never
-- returned); context_tsv is written with it by the INSERT — not a generated
-- column, since adding a stored generated column rewrites the table. Nullable
-- without defaults, so adding them is a catalog change only; static and
-- earlier chunks keep NULL. embedding is NULL for a structured chunk of only
-- whitespace (a run longer than a chunk): stored so its section can be rebuilt,
-- never embedded and never a search hit. Dropping NOT NULL is catalog-only too.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'vector_store_chunks'::regclass
                AND attname = 'embedding' AND attnotnull AND NOT attisdropped) THEN
    ALTER TABLE vector_store_chunks ALTER COLUMN embedding DROP NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'vector_store_chunks'::regclass
                    AND attname = 'context' AND NOT attisdropped) THEN
    ALTER TABLE vector_store_chunks ADD COLUMN IF NOT EXISTS context text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'vector_store_chunks'::regclass
                    AND attname = 'context_tsv' AND NOT attisdropped) THEN
    ALTER TABLE vector_store_chunks ADD COLUMN IF NOT EXISTS context_tsv tsvector;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'vector_store_chunks'::regclass
                    AND attname = 'section' AND NOT attisdropped) THEN
    ALTER TABLE vector_store_chunks ADD COLUMN IF NOT EXISTS section int;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'vector_store_chunks'::regclass
                    AND attname = 'section_offset' AND NOT attisdropped) THEN
    ALTER TABLE vector_store_chunks ADD COLUMN IF NOT EXISTS section_offset int;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'vector_store_chunks'::regclass
                    AND attname = 'heading_path' AND NOT attisdropped) THEN
    ALTER TABLE vector_store_chunks ADD COLUMN IF NOT EXISTS heading_path text;
  END IF;
END
$$;
-- Page numbers: page_start and page_end are the pages (from 1) of a chunk's
-- first and last character, for formats whose text marks its pages (PDF);
-- NULL for every other format, for a chunk of only whitespace, and for chunks
-- written before they existed. Nullable without defaults: a catalog change only.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'vector_store_chunks'::regclass
                    AND attname = 'page_start' AND NOT attisdropped) THEN
    ALTER TABLE vector_store_chunks ADD COLUMN IF NOT EXISTS page_start int;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'vector_store_chunks'::regclass
                    AND attname = 'page_end' AND NOT attisdropped) THEN
    ALTER TABLE vector_store_chunks ADD COLUMN IF NOT EXISTS page_end int;
  END IF;
END
$$;
-- Installs created before generations have the primary key
-- (store_id, file_id, ord), which would refuse a second generation of a chunk.
-- Swapped only while generation is not yet a key column; the constraint name is
-- looked up rather than assumed. Building the new key locks the table for the
-- length of one unique index build over every chunk (it cannot fail on
-- duplicates: the old key is a subset of the new one).
DO $$
DECLARE
  pk_name text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'vector_store_chunks'::regclass
                    AND attname = 'generation' AND NOT attisdropped) THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint con
               JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
              WHERE con.conrelid = 'vector_store_chunks'::regclass AND con.contype = 'p'
                AND a.attname = 'generation') THEN
    RETURN;
  END IF;
  SELECT conname INTO pk_name FROM pg_constraint
   WHERE conrelid = 'vector_store_chunks'::regclass AND contype = 'p';
  IF pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE vector_store_chunks DROP CONSTRAINT %I', pk_name);
  END IF;
  ALTER TABLE vector_store_chunks ADD PRIMARY KEY (store_id, file_id, generation, ord);
END
$$;
${hnswIndex}CREATE INDEX IF NOT EXISTS idx_chunks_tsv ON vector_store_chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS idx_chunks_store ON vector_store_chunks (store_id, file_id);
-- A store's generations, found without reading its chunks: the orphan sweep
-- (jobSweeper.ts) probes it once per generation a store holds, and the
-- re-embed DELETEs of a whole generation use it, and recall's store scan may
-- pick it over idx_chunks_store (it is smaller). A performance index — nothing
-- is wrong without it, only slower, so db.ts does not require it. Its one-time
-- build on an upgrade blocks writes to the chunks (not reads) until the schema
-- transaction commits; the build takes about 0.6 s per 1M chunks
-- (warm cache, small vectors; unmeasured at 1536 dims or cold)
-- (test/fileSearch/integration/migrationStoreGenIndex.test.ts).
CREATE INDEX IF NOT EXISTS idx_chunks_store_gen ON vector_store_chunks (store_id, generation);
-- The lexical match on chunk contexts. Partial: static and earlier chunks have
-- none. A performance index like idx_chunks_store_gen, not required by db.ts.
-- Its one-time build on an upgrade scans every chunk (with every context_tsv
-- still NULL it inserts nothing). The upgrade that builds it also adds the
-- chunk columns above, whose ALTER holds ACCESS EXCLUSIVE to the end of its
-- transaction, so it is in POST_COMMIT_INDEXES: the runner builds it in a
-- transaction of its own after the columns commit, and the scan blocks writes
-- to the chunks, not reads.
CREATE INDEX IF NOT EXISTS idx_chunks_context_tsv ON vector_store_chunks USING gin (context_tsv) WHERE context_tsv IS NOT NULL;

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
  finished_at      timestamptz,
  cancel_requested  boolean NOT NULL DEFAULT false,
  target_model      text,
  target_dim        int,
  target_generation int,
  target_storage    text,
  target_chunking   jsonb,
  context_input_tokens  bigint NOT NULL DEFAULT 0,
  context_output_tokens bigint NOT NULL DEFAULT 0,
  context_cached_tokens bigint NOT NULL DEFAULT 0,
  context_failed_chunks bigint NOT NULL DEFAULT 0,
  ocr_pages             bigint NOT NULL DEFAULT 0,
  ocr_skipped_pages     bigint NOT NULL DEFAULT 0,
  vision_pages          bigint NOT NULL DEFAULT 0,
  vision_skipped_pages  bigint NOT NULL DEFAULT 0
);
-- The re-embed kinds: cancel_requested is their cancel latch (a file batch
-- keeps using vector_store_batches.cancel_requested), and the target is pinned
-- when the job starts so a configuration change mid-job cannot mix models.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'fs_jobs'::regclass
                    AND attname = 'cancel_requested' AND NOT attisdropped) THEN
    ALTER TABLE fs_jobs ADD COLUMN IF NOT EXISTS cancel_requested boolean NOT NULL DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'fs_jobs'::regclass
                    AND attname = 'target_model' AND NOT attisdropped) THEN
    ALTER TABLE fs_jobs ADD COLUMN IF NOT EXISTS target_model text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'fs_jobs'::regclass
                    AND attname = 'target_dim' AND NOT attisdropped) THEN
    ALTER TABLE fs_jobs ADD COLUMN IF NOT EXISTS target_dim int;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'fs_jobs'::regclass
                    AND attname = 'target_generation' AND NOT attisdropped) THEN
    ALTER TABLE fs_jobs ADD COLUMN IF NOT EXISTS target_generation int;
  END IF;
  -- A blob migration's target backend, pinned when it starts.
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'fs_jobs'::regclass
                    AND attname = 'target_storage' AND NOT attisdropped) THEN
    ALTER TABLE fs_jobs ADD COLUMN IF NOT EXISTS target_storage text;
  END IF;
  -- A re-chunk's target chunking, pinned when it starts (a reembed_store job
  -- with it set re-chunks), and what the job's context requests used:
  -- context_input_tokens counts input tokens NOT read from a prompt cache
  -- (cache writes included), context_cached_tokens the input tokens read from
  -- one — the two are disjoint and their sum is the whole input;
  -- context_output_tokens the output; context_failed_chunks the chunks left
  -- without an LLM context. A constant default is a catalog change only
  -- (PostgreSQL 11+): no rewrite.
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'fs_jobs'::regclass
                    AND attname = 'target_chunking' AND NOT attisdropped) THEN
    ALTER TABLE fs_jobs ADD COLUMN IF NOT EXISTS target_chunking jsonb;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'fs_jobs'::regclass
                    AND attname = 'context_input_tokens' AND NOT attisdropped) THEN
    ALTER TABLE fs_jobs ADD COLUMN IF NOT EXISTS context_input_tokens bigint NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'fs_jobs'::regclass
                    AND attname = 'context_output_tokens' AND NOT attisdropped) THEN
    ALTER TABLE fs_jobs ADD COLUMN IF NOT EXISTS context_output_tokens bigint NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'fs_jobs'::regclass
                    AND attname = 'context_cached_tokens' AND NOT attisdropped) THEN
    ALTER TABLE fs_jobs ADD COLUMN IF NOT EXISTS context_cached_tokens bigint NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'fs_jobs'::regclass
                    AND attname = 'context_failed_chunks' AND NOT attisdropped) THEN
    ALTER TABLE fs_jobs ADD COLUMN IF NOT EXISTS context_failed_chunks bigint NOT NULL DEFAULT 0;
  END IF;
  -- PDF pages without a text layer: ocr_pages those OCR read, ocr_skipped_pages those left
  -- without OCR text (failed, timed out, past the per-file cap or budget, or OCR off). A
  -- constant default: no rewrite.
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'fs_jobs'::regclass
                    AND attname = 'ocr_pages' AND NOT attisdropped) THEN
    ALTER TABLE fs_jobs ADD COLUMN IF NOT EXISTS ocr_pages bigint NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'fs_jobs'::regclass
                    AND attname = 'ocr_skipped_pages' AND NOT attisdropped) THEN
    ALTER TABLE fs_jobs ADD COLUMN IF NOT EXISTS ocr_skipped_pages bigint NOT NULL DEFAULT 0;
  END IF;
  -- PDF pages a store's vision mode selected: vision_pages those the model transcribed,
  -- vision_skipped_pages those that kept their text (failed, blank, past the cap, a ceiling or a
  -- stop, or vision unavailable). A constant default: no rewrite.
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'fs_jobs'::regclass
                    AND attname = 'vision_pages' AND NOT attisdropped) THEN
    ALTER TABLE fs_jobs ADD COLUMN IF NOT EXISTS vision_pages bigint NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'fs_jobs'::regclass
                    AND attname = 'vision_skipped_pages' AND NOT attisdropped) THEN
    ALTER TABLE fs_jobs ADD COLUMN IF NOT EXISTS vision_skipped_pages bigint NOT NULL DEFAULT 0;
  END IF;
  -- A re-chunk to the store's own setting that reads again only the files an older extractor
  -- read (reextract.ts); the others are copied with their vectors. NULL is false. Nullable
  -- without a default: a catalog change only.
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'fs_jobs'::regclass
                    AND attname = 'reextract' AND NOT attisdropped) THEN
    ALTER TABLE fs_jobs ADD COLUMN IF NOT EXISTS reextract boolean;
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS idx_fs_jobs_owner ON fs_jobs (owner_email, created_at, id);
CREATE INDEX IF NOT EXISTS idx_fs_jobs_finished ON fs_jobs (finished_at);
CREATE INDEX IF NOT EXISTS idx_fs_jobs_parent ON fs_jobs (parent_id);
-- At most one unfinished re-embed per store, enforced by the database rather
-- than by a check-then-insert that two concurrent starts could both pass.
CREATE UNIQUE INDEX IF NOT EXISTS idx_fs_jobs_reembed_running ON fs_jobs (store_id)
  WHERE kind = 'reembed_store' AND finished_at IS NULL;

-- One work item per file of a re-embed job, with the ingestion queue's claim,
-- lease and retry semantics (the file's own vector_store_files.status is the
-- OpenAI-visible status and stays 'completed' throughout). The job's state is
-- derived from these rows, like a batch's from its member files.
CREATE TABLE IF NOT EXISTS fs_reembed_items (
  job_id     text NOT NULL REFERENCES fs_jobs(id) ON DELETE CASCADE,
  store_id   text NOT NULL,
  file_id    text NOT NULL,
  status     text NOT NULL DEFAULT 'in_progress'
             CHECK (status IN ('in_progress', 'completed', 'failed', 'cancelled')),
  attempts   int NOT NULL DEFAULT 0,
  claimed_at timestamptz,
  last_error jsonb,
  tokens     bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, file_id)
);
-- The claim picks the oldest open item; idx_reembed_items_file serves the
-- per-file lookups of a detach or delete during a re-embed.
CREATE INDEX IF NOT EXISTS idx_reembed_items_claim ON fs_reembed_items (created_at, job_id, file_id)
  WHERE status = 'in_progress';
CREATE INDEX IF NOT EXISTS idx_reembed_items_file ON fs_reembed_items (store_id, file_id);
-- The extractor version an item's file was read with, and whether that read left OCR pending,
-- when the item (or ingestion during the job) extracted it; NULL when its chunks were copied. The
-- switch writes both to the file.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'fs_reembed_items'::regclass
                    AND attname = 'extraction_version' AND NOT attisdropped) THEN
    ALTER TABLE fs_reembed_items ADD COLUMN IF NOT EXISTS extraction_version int;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'fs_reembed_items'::regclass
                    AND attname = 'ocr_pending' AND NOT attisdropped) THEN
    ALTER TABLE fs_reembed_items ADD COLUMN IF NOT EXISTS ocr_pending boolean;
  END IF;
END
$$;
-- The file's context stop (vector_store_files.context_stopped) as of the item's chunks in the job's
-- generation: written when the item (or ingestion during the job) chunked the file, copied from the
-- file when a re-extract kept its chunks. A re-chunk's switch writes it to the file.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'fs_reembed_items'::regclass
                    AND attname = 'context_stopped' AND NOT attisdropped) THEN
    ALTER TABLE fs_reembed_items ADD COLUMN IF NOT EXISTS context_stopped text;
  END IF;
END
$$;

-- A blob migration (kind 'blob_migration', no store) moves every blob (released
-- ones included) that is not in the job's target_storage; at most one runs at a
-- time. One item per blob, with the same claim, lease and retry rules as the
-- re-embed items; source_storage is where the blob was when the job began.
CREATE UNIQUE INDEX IF NOT EXISTS idx_fs_jobs_blob_migration_running ON fs_jobs (kind)
  WHERE kind = 'blob_migration' AND finished_at IS NULL;
CREATE TABLE IF NOT EXISTS fs_blob_migration_items (
  job_id         text NOT NULL REFERENCES fs_jobs(id) ON DELETE CASCADE,
  sha256         text NOT NULL,
  source_storage text NOT NULL,
  status         text NOT NULL DEFAULT 'in_progress'
                 CHECK (status IN ('in_progress', 'completed', 'failed', 'cancelled')),
  attempts       int NOT NULL DEFAULT 0,
  claimed_at     timestamptz,
  last_error     jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_blob_migration_items_claim ON fs_blob_migration_items (created_at, job_id, sha256)
  WHERE status = 'in_progress';
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
