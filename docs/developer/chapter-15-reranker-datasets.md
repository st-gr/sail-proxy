---
title: SAIL-PROXY Developer Guide - Chapter 15
author: st-gr
date: 2026-08-03
mainfont: Helvetica, Arial, sans-serif
fontsize: 18px
---

# SAIL-PROXY Developer Guide
*Multi-provider AI Gateway for SAP AI Core - Developer Documentation*
**Author:** *st-gr*

# Chapter 15: Reranker Teacher Datasets

`file_search` retrieval runs in two stages: a hybrid recall (pgvector cosine + Postgres full-text, fused with RRF) produces a wide candidate set, and a cross-encoder reranker — the *teacher* — reorders it. The teacher is accurate, and it is also the slowest and most expensive part of every search.

Teacher-label logging exists to make that trade optional later: it records, for every search, the candidate set the retrieval stage produced *and* the ordering the teacher imposed on it. That pairing is a supervised training set. With enough of it you can train or evaluate a cheaper student reranker, measure how much the teacher actually improves on the raw RRF ordering, or compare a candidate open-weights reranker against the Cohere deployment on your own corpus rather than on a public benchmark.

Collection is **off by default** and writes nothing until you turn it on.

---

## 1. What the two tables hold

Both tables are declared in `services/gateway/src/fileSearch/schema.sql.ts` and created by the migration (`cli-tools/file-search-migrate.js`, or the gateway's own boot migration); with collection disabled they simply stay empty.

The boot migration re-applies that schema on every start, so an install that migrated *before* these tables existed picks them up on its next restart — provided the database role it connects as may create them. Where it may not (a locked-down deployment whose gateway role has no DDL rights, or one whose tables are owned by a different role), the gateway logs a `warn` at startup naming exactly which tables are missing and telling you to run the migration step; file_search itself keeps working, and teacher logging writes nothing until the tables exist. **If you enable collection and see no rows, read the startup log first** — that warning, or the `42P01` self-disable warning described in §5, is the answer.

**An event row exists only for a search that recalled at least one candidate.** A search whose hybrid recall returned nothing (no chunk matched, an over-narrow attribute filter, an empty store) returns early and is deliberately not logged: there would be no candidate list to label, and an event with zero labels would break the per-event invariant in §6. The consequence for analysis: **these tables cannot tell you your recall-failure rate.** The denominator they carry is "searches that found something", not "searches", so any ratio computed from them silently excludes every total miss. Get that number from request-level metrics or the application log instead.

### `reranker_search_events` — one row per search

The query and the conditions it ran under.

| Column | Meaning |
| --- | --- |
| `id` | `rse_…` primary key; `reranker_candidate_labels.event_id` references it `ON DELETE CASCADE`. |
| `created_at` | Insert time. |
| `query_text`, `query_hash` | The caller's original query, and its sha256. The hash is what you group by to find repeated queries without reading them. |
| `source` | Free-text tag from `teacher_logging.source` — how you separate `production` traffic from an offline harvesting run in the same table. |
| `store_ids`, `owner_email` | Which vector stores were searched, and by whom. |
| `retrieval_mode` | `reranked` or `rrf_only`. |
| `reranker_available` | `false` for an `rrf_only` search. **Rows with `reranker_available = false` carry no teacher signal** — they have retrieval ranks but every `teacher_rank` is `NULL`. Filter them out of any training export. |
| `candidates_requested` / `candidates_returned` | The configured recall width (`hybrid.candidates`) vs. how many chunks recall actually produced and handed to the teacher. `candidates_returned` is the number of label rows this event has. |
| `rrf_k`, `lexical_enabled`, `embedding_model`, `embedding_dim` | The retrieval configuration in force. Retrieval config drifts; a dataset that does not record it cannot be pooled across time. |
| `reranker_provider`, `reranker_model` | Which teacher produced the labels. `NULL` when none did. |
| `reranker_search_units` | Billed search units reported by the reranker deployment — the cost side of the "is the teacher worth it?" question. |
| `rewrite_used`, `query_rewritten` | Whether the LLM query rewriter fired, and what it produced. The *rewritten* query is what was actually embedded and matched. |
| `embed_latency_ms`, `rerank_latency_ms`, `total_latency_ms` | Measured with a monotonic clock (`process.hrtime.bigint()`), not wall-clock. `rerank_latency_ms` is `NULL` for `rrf_only`. |
| `top_k`, `score_threshold` | The truncation the caller asked for — the reason a chunk can be highly ranked by the teacher and still not `selected`. |
| `request_id`, `metadata` | Correlation id and a free `jsonb` slot. |

### `reranker_candidate_labels` — one row per candidate of one search

The candidate set, with every ranking signal that was available for it.

| Column | Meaning |
| --- | --- |
| `id`, `event_id` | Primary key and the owning event; `UNIQUE (event_id, candidate_index)`. |
| `candidate_index` | 0-based position within the array handed to the teacher. This is the join key between an event's candidates and the teacher's output. |
| `store_id`, `file_id`, `ord`, `filename` | Identifies the chunk. |
| `chunk_hash` | sha256 of the chunk text — **always written**, whether or not the text itself is. |
| `chunk_text` | The verbatim chunk text, or `NULL`. See §4. |
| `chunk_tokens` | Reserved; **always `NULL` today**. Nothing on the write path populates it — the chunk's token count is not carried through recall. Do not filter or aggregate on it. |
| `retrieval_rank` | 1-based rank in the fused RRF ordering, i.e. what retrieval alone would have returned. |
| `rrf_score` | The fused RRF score: the sum of `1/(rrf_k + rank)` over the arms that recalled this chunk. Not a similarity and not calibrated. |
| `vector_rank`, `vector_score` | The vector arm's rank and its raw **cosine distance** (lower is better, never inverted). `NULL` when only the lexical arm recalled this chunk. |
| `lexical_rank`, `lexical_score` | The lexical arm's rank and raw `ts_rank` (higher is better). `NULL` when only the vector arm recalled it, or when `hybrid.lexical_enabled` is false. |
| `teacher_rank` | **The training signal.** 1-based position in the teacher's relevance-descending output. `NULL` on an `rrf_only` event. |
| `teacher_score` | The teacher's raw relevance score. Auxiliary, uncalibrated — see §2. |
| `selected` | Whether this chunk survived `score_threshold` and `top_k` and was actually served to the caller. |
| `attributes` | The file's attribute `jsonb`, as it was at search time. |

`retrieval_rank` and `candidate_index + 1` are the same number today, because the candidate array is handed to the teacher in RRF order. They are stored separately on purpose: `candidate_index` is a *join key* into the teacher's output and must stay stable even if the candidate set is ever shuffled or deduplicated before being sent, whereas `retrieval_rank` is a *ranking signal* and must keep meaning "what recall thought" regardless.

---

## 2. `teacher_rank` is the label; `teacher_score` is not

Train on `teacher_rank`.

`teacher_rank` is an **ordering**, and orderings are what the teacher is actually good at and what every ranking loss (pairwise, listwise, NDCG-style) consumes. It is comparable across events, across models, and across time.

`teacher_score` is the raw number the reranker deployment returned. It is recorded because it is free and occasionally informative (a search where every score is low probably had no good answer at all), but it is **uncalibrated**:

- It is not a probability, and it is not comparable between two different reranker models — or necessarily between two deployments of the same model.
- Its distribution depends on the query and on the composition of the candidate set. The same chunk against the same query can score differently depending on what it was ranked *against*.
- Nothing in the pipeline normalizes it. `score_threshold` in `reranked` mode is applied to this raw value.

Treat it as an auxiliary feature or a diagnostic, never as a regression target and never as a cross-model comparison.

Two more things worth stating plainly:

- **`selected` is not relevance.** It is the intersection of the teacher's ordering with whatever `top_k`/`score_threshold` that particular caller happened to ask for. A chunk with `teacher_rank = 3` can be `selected = false` simply because the caller asked for two results. Do not use `selected` as a label.
- **Absence of a chunk from the candidate set is not a negative.** These labels only ever tell you how the teacher ordered what recall found. Chunks recall never surfaced appear nowhere, so this dataset can improve reranking; it cannot by itself tell you what recall missed.

---

## 3. Enabling collection

Configured in `api_config.json` under `file_search.teacher_logging` — **not** through environment variables, so it can be flipped at runtime from the admin cockpit without a redeploy.

```json
"file_search": {
  "teacher_logging": {
    "enabled": false,
    "store_chunk_text": false,
    "sample_rate": 1.0,
    "source": "production",
    "max_concurrent_writes": 2
  }
}
```

| Key | Default | Effect |
| --- | --- | --- |
| `enabled` | `false` | Master switch. While false the search path writes nothing at all. |
| `store_chunk_text` | `false` | Whether `chunk_text` is persisted verbatim. `chunk_hash` is written either way. |
| `sample_rate` | `1.0` | Fraction of searches recorded, sampled per search. Lower it on a high-traffic gateway; each event costs one transaction and `candidates_returned + 1` rows. |
| `source` | `"production"` | Tag written to every event, for separating collection runs. |
| `max_concurrent_writes` | `2` | Ceiling on in-flight label writes. Beyond it, writes are **dropped, not queued** — see §5. Validated range 1–10. |

### Why `enabled` and `store_chunk_text` are two separate keys

Because they are two different decisions, with two different blast radii.

`enabled` turns on the collection of *rankings*: hashes, ranks, scores, latencies. That is enough to answer most of the questions the dataset exists for — how often the teacher disagrees with RRF, how much latency and how many billed search units it costs, whether the lexical arm is contributing anything.

`store_chunk_text` turns on the retention of *document contents*. Model training needs it; measurement mostly does not.

Collapsing them into one flag would mean that anyone enabling measurement silently starts a document-retention program. Keeping them separate makes "collect rankings" the cheap, low-consequence default and forces content retention to be its own deliberate, separately-reviewable decision.

---

## 4. Chunk text, and what actually controls exposure

**With `store_chunk_text: true`, `chunk_text` holds the verbatim text of every recalled chunk — the document contents themselves, in a plain, unencrypted, queryable column.** Not an embedding, not a summary, not a hash. The teacher-label tables are as sensitive as the corpus they were collected from, and they must be backed up, access-controlled, and retained accordingly.

Neither the query text nor the chunk text is ever written to the application log — not at `info`, not at `warn`, not on the error path. Storing them in the database is a deliberate, configured act; leaking them into logs is not, and the logger is written to keep those two things distinct.

The control that matters most is not a flag: **it is which corpus you point collection at.** `sample_rate` reduces volume, and `store_chunk_text: false` keeps text out of the table, but if collection is enabled against stores holding confidential documents, then every ranking row still records `owner_email`, `store_ids`, `file_id`, `filename`, and the caller's `query_text` — which is frequently the most revealing field of the lot.

If the dataset is destined to leave the environment that produced it, harvest it from a corpus that is allowed to leave: a synthetic or public document set, searched with a generated query workload, tagged with its own `source`. That is the exposure control. The config keys only decide how much of an already-chosen corpus you keep.

---

## 5. Operational behaviour

- **Fire-and-forget.** `teacherLogger.record()` returns `void`, never a `Promise`. A slow or failing write can never delay or fail the search that triggered it; every error is caught internally and surfaces only as a `warn`.
- **One transaction per search.** The event row and all its label rows are written together. A failure partway through rolls the event back with its labels — you never get an event with no candidates, which would otherwise silently skew every aggregate below.
- **Bounded, and dropped rather than queued.** The pool is shared with search, ingestion and the expiry sweeper (`max: 10`). Above `max_concurrent_writes` in-flight writes the record is discarded. A dropped label costs one training example; a starved pool costs the feature.
- **Raising `max_concurrent_writes` trades labels for latency, and it is capped at 10.** Measured against this pool (a 100-search burst, plus one unrelated query on the shared pool as the probe): at the default `2`, 98 of 100 records were dropped and the probe query was unaffected (2 ms); at `20`, nothing was dropped and the probe went from 14 ms to 86 ms. Degraded, not starved — each label write is one short transaction — but the direction is clear. `10` is the ceiling because that is the pool's own size: past it the setting bounds nothing, since the surplus writes just wait inside pg's connection queue instead of being dropped. The configuration schema rejects anything higher, **and the gateway clamps it again when reading the config** — a hand-edited `api_config.json` never passes through the schema validator — logging one `warn` that names the configured value, the ceiling and the reason rather than overriding you silently. Raise it toward `10` only for a deliberate, time-boxed harvesting run, and prefer lowering `sample_rate` for steady-state collection.
- **Self-disabling on structural errors.** On `42501` (insufficient privilege) or `42P01` (undefined table) the logger stops trying until the process restarts, rather than warning on every search forever. If collection is enabled and no rows are appearing, check the gateway log for exactly that warning first.

---

## 6. Verifying rows are arriving

Enable collection, run a search, then:

```sql
SELECT source, retrieval_mode, count(*) AS events,
       avg(candidates_returned)::numeric(5,1) AS avg_candidates,
       avg(rerank_latency_ms)::int AS avg_rerank_ms,
       sum(reranker_search_units) AS billed_units
FROM reranker_search_events GROUP BY 1, 2;
```

A `rrf_only` group with a `NULL` `avg_rerank_ms` means the reranker was unavailable or disabled for those searches; those events have no teacher labels.

Per-event sanity check — every event must have exactly `candidates_returned` labels:

```sql
SELECT e.id, e.candidates_returned, count(l.id) AS labels
FROM reranker_search_events e
LEFT JOIN reranker_candidate_labels l ON l.event_id = e.id
GROUP BY e.id, e.candidates_returned
HAVING count(l.id) <> e.candidates_returned;
```

How much the teacher actually changes the ordering (if this is near zero, the teacher is not earning its latency on your corpus):

```sql
SELECT avg(abs(teacher_rank - retrieval_rank))::numeric(6,2) AS mean_rank_shift,
       count(*) AS labelled_candidates
FROM reranker_candidate_labels
WHERE teacher_rank IS NOT NULL;
```

## 7. Exporting a training set

One row per (query, candidate) pair, grouped by event and ordered by the teacher's judgement. Restricted to events that genuinely carry a teacher signal:

```sql
SELECT e.id            AS event_id,
       e.created_at,
       e.source,
       e.reranker_model,
       coalesce(e.query_rewritten, e.query_text) AS query,   -- what was actually matched
       l.candidate_index,
       l.chunk_hash,
       l.chunk_text,                                          -- NULL unless store_chunk_text was on
       l.teacher_rank,                                        -- the label
       l.teacher_score,                                       -- auxiliary, uncalibrated
       l.retrieval_rank,
       l.rrf_score,
       l.vector_rank, l.vector_score,
       l.lexical_rank, l.lexical_score,
       l.selected
FROM reranker_search_events e
JOIN reranker_candidate_labels l ON l.event_id = e.id
WHERE e.reranker_available          -- excludes rrf_only events, which have no labels
  AND e.source = 'production'
  AND e.created_at >= now() - interval '30 days'
ORDER BY e.created_at, e.id, l.teacher_rank;
```

Notes on using the output:

- Group by `event_id`. A single row is meaningless; the label is the *ordering within one event's candidate list*.
- `query` uses `query_rewritten` when the rewriter fired, because that — not the caller's original wording — is the text retrieval and the teacher actually saw.
- Filter on `reranker_model` (and `embedding_model` / `rrf_k` / `lexical_enabled` on the event) before pooling data collected across a configuration change.
- With `store_chunk_text: false`, `chunk_text` is `NULL` and the export is usable only for agreement/ranking-shift analysis. Join `chunk_hash` back to a corpus you hold separately to reconstitute text without ever having stored it here.

---

*Related: `services/gateway/src/fileSearch/teacherLogger.ts` (the writer), `services/gateway/src/fileSearch/search.ts` (the call site), `services/gateway/test/fileSearch/integration/teacherLogging.test.ts` (live-Postgres coverage of everything above).*
