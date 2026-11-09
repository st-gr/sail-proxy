---
title: The hosted file_search tool
description: Ingestion, chunking, indexing, retrieval, storage and verification.
---

# The hosted `file_search` tool

[Reranker teacher datasets](/developer/reranker-datasets) covers the datasets the retrieval stack produces. This page covers the **tool**: what happens when a client attaches `{"type": "file_search"}` to a `/openai/v1/responses` request and lets the model decide when to search.

The REST surface (`POST /openai/v1/vector_stores/{id}/search`, also mounted at `/openai/api/v1/vector_stores/{id}/search`) and the tool share one entry point, `searchVectorStores`. Everything that differs between them is on this page.

## What a client sends

```jsonc
POST /openai/v1/responses
{
  "model": "gpt-5.4",
  "stream": true,
  "input": "what does the handbook say about expense deadlines?",
  "tools": [
    {
      "type": "file_search",
      "vector_store_ids": ["vs_abc123"],       // required, non-empty
      "max_num_results": 8,                    // optional, 1..50
      "filters": { "type": "eq", "key": "dept", "value": "finance" },
      "ranking_options": { "score_threshold": 0.4 }
    }
  ],
  "include": ["file_search_call.results"]      // see "Reading the results" below
}
```

Only `vector_store_ids` is required. The other three fields configure the search **once, for the whole request** — they are deliberately not projected into the function schema the model sees, so the model cannot widen its own retrieval scope call by call. It gets exactly one argument: `query`.

SAP AI Core deployments reject hosted tool types outright, so the gateway rewrites the hosted entry into a plain function tool named `file_search`, runs the retrieval itself, and hands the client back the hosted-tool response shape. All of the transport machinery is shared with `web_search` and lives in `src/pluginSupport/hostedTool/engine.ts`; what `file_search` *is* lives behind `HostedToolDescriptor` in `src/pluginSupport/fileSearch/descriptor.ts`.

A turn may call the tool several times, and may call `web_search` in the same turn. Both are resolved into **one** continuation POST per round.

### `ne` and `nin` return files that have no such attribute at all

`filters` supports `eq ne gt gte lt lte in nin` plus nested `and`/`or`, compiled to parameterised SQL in `src/fileSearch/filterCompiler.ts`. One behaviour there is a deliberate divergence and is the one most likely to surprise you:

**`ne` and `nin` INCLUDE a file that does not carry the attribute at all. `eq` still excludes it.** A file with no `dept` is not "a file whose dept is legal", so `{"type":"ne","key":"dept","value":"legal"}` returns it. SQL's own reading is the opposite and, worse, it is silent: `(attributes->>'dept') <> 'legal'` evaluates to NULL for a row without the key, and `WHERE` drops NULL rows without error — the caller just never sees those files, and an `ne` on a key nobody set returns an empty page that reads exactly like an empty store. The compiler therefore emits an explicit missing-key arm:

```sql
-- ne
((vsf.attributes ? $1) IS NOT TRUE OR (vsf.attributes->>$2) <> $3)
-- nin
((vsf.attributes ? $1) IS NOT TRUE OR NOT ((vsf.attributes->>$2) = ANY($3)))
```

`IS NOT TRUE` rather than `NOT (…)` because `attributes` is a *nullable* column: `NULL::jsonb ? 'k'` is NULL and `NOT NULL` is NULL, which would drop exactly the rows the arm exists to keep. OpenAI does not specify the behaviour; this is the reading that matches how callers describe the filter, and it is recorded in the spec's parity matrix under *Approximated, with the divergence documented*. The asymmetry with `eq` is intentional and pinned by test in `test/fileSearch/integration/filterCompiler.test.ts`.

## `prepare()`-time 400 versus mid-turn degradation

The tool validates the caller's configuration **before the turn opens**, in the descriptor's `prepare()` hook, and rejects the whole request when it finds a problem:

| Rejected at `prepare()` | Status |
|---|---|
| missing / empty / non-array `vector_store_ids` | 400 |
| a store id that does not exist, or belongs to someone else | 400 (same message for both — see below) |
| no authenticated caller identity (e.g. an AWS SigV4 request, which carries no email) | 400 |
| `max_num_results` not an integer in `1..50` | 400 |
| a store whose `status` is `expired` | 409 |
| a store whose pinned `embedding_dim` has drifted from the live configuration | 409 |

The response body is the same OpenAI error envelope `filesController` and `vectorStoresController` emit, so a `file_search` mistake reads identically whether you hit the REST surface or the tool. `POST /vector_stores/{id}/search` refuses a `max_num_results` outside `1..50` (or not an integer) with the same `400 invalid_max_num_results`: both search paths follow OpenAI's bound ("between 1 and 50 inclusive", openai-python `vector_store_search_params.py`) rather than clamping. `searchVectorStores` still clamps to that range, as a backstop for an internal caller; the bound is `MIN_MAX_NUM_RESULTS`/`MAX_MAX_NUM_RESULTS` in `fileSearch/search.ts` (the tool's prepare checks `configService`'s `MIN_RESULTS_DEFAULT`/`MAX_RESULTS_DEFAULT`, the same 1 and 50).

**Why this is worth a hard failure, when almost everything else in the gateway degrades.** Once the response has started, a typo'd `vector_store_id` is *indistinguishable from an empty corpus*: both are "no passages found". There is no error to surface, no status left to set, and on the streaming path no way to tell the client anything at all. `prepare()` is the only honest moment in the flow, so anything not rejected there is never reported — in any form, ever.

The rule that decides reject-versus-degrade is structural rather than a list of error classes: **an error carrying a numeric HTTP `status` describes something the caller got wrong and can fix, so the request fails with it. An error with no `status` is infrastructure** — `file_search database is not configured` when the pool is null, a connection refused — which the caller cannot act on, and one tool being unavailable must not take down a request that may never call it. Infrastructure failures therefore leave the turn open with no prepared configuration.

An unknown store id and someone else's store produce the **same** 400 on purpose. A distinct status would make the response an oracle for which store ids exist, which is also why `searchVectorStores` answers 404 and never 403.

**Mid-turn, the tool degrades instead.** A store deleted between the turn opening and a call running, a search that times out, a reranker outage — each produces a `file_search_call` with `status: "failed"`, a `function_call_output` telling the model the search could not be completed, and a turn that still reaches the model's own answer. A call that never ran (no prepared configuration, no caller identity) refuses to search rather than falling back to the request body's `vector_store_ids`: those were never validated against the caller, and reading them here would turn a database outage into a tenant-isolation break.

## The masked/raw split

The gateway's own retrieval stack — Postgres, the embedder, the reranker, the query rewriter — is this tenant's own infrastructure and sees **raw** text. The generative deployment never does. That gives every result two renderings, and they are materialised at search time, not at render time:

| Rendering | Destination | Text |
|---|---|---|
| `renderOutput` → `function_call_output` | the generative deployment | **masked** |
| `renderCallItem` → `file_search_call.results` | the client | **raw** |
| `renderResultMessage` → the fallback result dump | the client | **raw** |

*Masked for the deployment*, because a retrieved chunk is the one place a document leaves the tenant. It is masked through `maskThroughRequestMap` using the request's own resolved masking config — which is what carries the caller's `custom_entities`. A chunk masked without it ships exactly the identifiers the caller flagged as sensitive.

*Raw for the client*, because the client owns these documents. Showing a document's own owner placeholders for their own file would be a bug, not a safeguard.

Masking happens once, in `execute`, while the live `ReplacementMap` is still in reach and before either the continuation POST or the first client-facing frame. Extending that map is the point: whatever placeholder is minted for a passage is what the model will quote back, and the client is owed the real text when it does.

Chunk masking runs on `ctx.maskingConfig`, the request's own resolved configuration, so the precision keys apply here too: a value in `pseudonymization.allowlist` stays raw in a retrieved passage exactly as it would in the prompt, and `min_confidence` / `thresholds` decide passage spans the same way. `saturation_warn` does **not** cover them — the count is taken in the plugin's before handler, which runs before any search, so the warning line and the SIEM block describe the request the caller sent and never the corpus text pulled in afterwards.

### The query travels the other way, and the two transports disagree

`web_search` sends the query **out** to a third party. `file_search` brings it **in**, to our own corpus, which is stored raw. So the query is deliberately *not* re-masked — re-masking it would search for placeholder tokens that appear in no document.

Where it must be unmasked depends on the transport, because the two paths read the query at different points in the pipeline:

| Transport | The query arrives | Because | Action |
|---|---|---|---|
| non-streaming | **raw** | `pseudonymizationPlugin`'s after handler (hook index 0) already unmasked the model's `function_call` arguments | use as-is |
| streaming | **masked** | the hosted-tool interceptor sits *behind* pseudonymization's `res.write` and reads bytes still in flight | unmask before searching |

Implemented backwards, this searches a raw corpus for `MASKED_PERSON_3` and returns **zero hits rather than throwing** — indistinguishable from an empty store, in the one part of the flow that can no longer tell the caller anything. `test/responses-filesearch-stream.test.ts` therefore asserts on hit *counts* against a fixture corpus that only matches the real address, on both transports; a test asserting "the code ran" would stay green through this bug.

## Per-tool caps are termination guarantees, not tuning knobs

`capabilities.file_search.tool.max_searches_per_request` (default 3, valid range 1..10) bounds how many searches one request may run. A configured value outside that range — or a non-integer, or a string — does **not** clamp to the nearer bound; it falls back to the default of 3, with a warning (`resolveMaxSearchesPerRequest`). Garbage config is treated as "not configured" rather than silently coerced into something the operator never asked for. `capabilities.web_search.max_searches_per_request` bounds `web_search` independently — two unrelated config accessors, two budgets, and a request that has exhausted one may still spend the other. They happen to ship with the same number; nothing shares it, and a shared counter would silently collapse the two.

**These exist so the continuation loop terminates.** Each round the model may answer with more tool calls, and each round costs a deployment call; without a bound, a model that keeps calling the tool keeps the request open forever. Turning the cap up to make retrieval "better" does not make it better — it makes the worst case longer and more expensive. If searches are coming back unhelpful, the fix is in `max_num_results`, `ranking_options.score_threshold`, the chunking configuration, or the reranker, none of which change how long a pathological turn can run.

Two more bounds guard the same property and are equally not knobs: `MAX_PENDING_CALLS_PER_TURN` (4) caps the before-handler's drain of calls replayed from a previous turn, and the continuation loop as a whole shares one wall-clock budget with `responsesController`'s idle timeout.

Once any tool's cap is reached, the turn stops continuing at the end of that round — a round containing an unanswerable call cannot be POSTed at all, because a turn with a `function_call` lacking its `function_call_output` is malformed and the deployment rejects it outright. Calls over the cap still receive a `failed` call item and a `function_call_output`, for the same reason.

## Reading `file_search_call` in a response

```jsonc
{
  "type": "file_search_call",
  "id": "fs_m9x2k1",
  "status": "completed",              // or "failed"
  "queries": ["expense claim deadline"],
  "results": [                        // ONLY under the include gate, see below
    {
      "file_id": "file_abc",
      "filename": "handbook.md",
      "score": 0.87,
      "attributes": { "dept": "finance" },
      "text": "Expense claims must be submitted within thirty calendar days…"
    }
  ]
}
```

`queries` is what was actually searched for, unmasked — the client's own view. `status` is `failed` for a call the tool could not serve; the item is still emitted, because a hosted-tool call with no output item at all is exactly what this machinery exists to prevent.

### The `include` gate

`results` is omitted **entirely** — not sent as an empty array — unless the request asked for it, matching OpenAI.

The token is OpenAI's own: **`file_search_call.results`**, named after the OUTPUT ITEM (`file_search_call`) rather than after the tool. `hostedTool/engine.ts`'s `renderOptsFor` builds it as `` `${descriptor.type}_call.results` ``, which gives `web_search` the matching `web_search_call.results`.

> **This was wrong until Task 12, and the failure was silent.** The key used to be built as `` `${descriptor.type}.results` ``, so the only token that opened the gate was `file_search.results` — a token no client sends. A client sending exactly what OpenAI documents got a `file_search_call` with no `results` field and no way to tell that from not having asked. If you see that symptom again, check `renderOptsFor` first; `test/responses-filesearch-stream.test.ts` pins both halves (see its `GATE_KEY` note and the test named `opens on OpenAI's documented file_search_call.results…`), so a regression flips a named test.

### `file_citation` annotations

When the model's answer quotes a retrieved passage, the assistant `message` carries `file_citation` annotations pointing back at the file the passage came from:

```jsonc
{ "type": "file_citation", "file_id": "file-9f2c0a7b1e4d6835c07a1b92", "filename": "handbook.pdf",
  "index": 23, "start_index": 23, "end_index": 96, "pages": { "first": 4, "last": 5 } }
```

`pages` is present only for a passage from a paged file (PDF, pptx) whose chunk has page numbers; it names the
pages of the whole cited hit (see [Page numbers](#page-numbers-pages-ts)).

The offsets are indices into the text **the client receives**, i.e. after unmasking. On the streaming path that is not the string the annotation was computed against — the frame is still masked when the gateway lets go of it — so `citations.ts` unmasks a *copy* to compute the offsets and emits only the integers. `MASKED_EMAIL_04871336` is 21 characters and the `j.doe@example.com` it unmasks to is 17, so an offset computed against the frame's own text would be wrong by a different amount for every message, nothing would throw, and the client would underline the wrong words. (Placeholder ids are **decimal**, not hex — `replacementMap.ts`'s `HASH_ID_DIGITS`, 8 digits, widening to 10 or 12 only on a collision probe. Models copy short digit runs far more reliably than hex, and a garbled placeholder is unrecoverable, so that is part of the security design rather than a formatting choice.)

**Three things about citations that look like bugs and are not:**

1. **Most answers carry ZERO annotations, and that is the expected result.** An annotation is anchored by finding a passage's text verbatim inside the model's answer. Models paraphrase; they very rarely quote. A turn that retrieved three excellent passages and produced a good answer will normally have an empty `annotations` array. This is not a broken anchor, a bad offset, or a lost hit — it is what paraphrase does. Do not go looking for a defect until you have confirmed the model actually quoted something. (Nothing in the pipeline attempts semantic matching; that would produce confident citations to text the model never took from the document, which is worse than none.)

2. **Annotations arrive AFTER `response.output_text.done`, not interleaved before it.** OpenAI emits `response.output_text.annotation.added` frames as the text streams. The gateway cannot: an annotation is a pair of offsets into the complete message, and the gateway only learns the complete text at `.done`. So the annotations appear on the `response.output_item.done` frame and inside the terminal `response.completed` — both of which carry the finished item — and never on a delta. This is a deliberate ordering divergence, not an omission. A client that renders citations from the final item is unaffected; a client that renders them incrementally sees them all at once, at the end.

3. **They ride on SIX sites in the engine, not three.** The original design named three. The drain shape and the non-continued terminal needed three more, each verified by test rather than argued:

   | Site | Where | Covers |
   |---|---|---|
   | 1 | after handler, the merged `output` | the whole non-streaming turn |
   | 1b | after handler, the early return when the response has no hosted-tool call | the pending-drain shape on the non-streaming path — the tools ran in the *before* handler, so this response is already the model's answer |
   | 2 | `processContinuationBlock`, `output_item.done` | the streaming continuation's message |
   | 2b | `patchedWrite`, `output_item.done` | the pending-drain shape on the streaming path — the model's *first* response is already the citing message and there is no continuation stream for site 2 to read |
   | 3 | `writeFinalTerminal` | the terminal frame, which rebuilds `response.output` wholesale from items that never passed through site 2 |
   | 3b | `writeClosingTerminal` | every terminal frame no continuation took over — the drain shape above all, where `writeFinalTerminal` is never reached at all |

   Sites 3 and 3b exist because reading only the terminal frame is a perfectly ordinary way to consume this stream; without them such a client would see no citations at all while `output_item.done` carried them.

   Every site *replaces* items, never mutates them. The engine's own copies are what `history` carries into the next continuation POST, and an in-place edit would ship the annotations — and, one careless edit later, the unmasked text they were computed against — straight back to the deployment.

## `rewrite_query` now defaults **off**

`capabilities.file_search.rewrite_query` sends the query to the tenant's orchestration deployment to be rewritten into a keyword-rich form before embedding. It costs roughly **1.3 seconds per search**. The shipped default is now `false`, and `FILE_SEARCH_DEFAULTS.rewriteQuery` is `false` too — which is what an install whose configuration predates the `file_search` block resolves to.

**No existing install picks this up.** New installs get `false`; existing installs keep whatever they have, which is `true`, until an operator changes it:

- **Standalone** — `api_config.json` is copied from the template **once**, at first run, and is never updated by a version bump. Edit `~/.sail-proxy/api_config.json`.
- **Docker and Kyma** — the admin-activated configuration **replaces** the file configuration wholesale, with no merge, so a new template key is invisible until an admin activates a configuration containing it. Change it in the cockpit and activate.

On the **tool** path the config value is moot in either direction: the descriptor passes `rewriteQuery: false` explicitly, because the model has already turned the user's turn into a search query and rewriting that a second time drifts it further from what was asked. The setting therefore only affects the REST endpoint `POST /openai/v1/vector_stores/{id}/search`.

To turn it back on, set `api_config.capabilities.file_search.rewrite_query` to `true`. `rewrite_query_model` (default `gpt-5-mini`) picks the model; it is config-driven rather than hardcoded because a model name that works on one SAP AI Core tenant's orchestration deployment is not guaranteed to work on another's. Rewriting is best-effort throughout: any failure degrades to the caller's original query, logged with a reason code (a warning when the request failed, was cut off or came back empty), and never fails the search. Sampling parameters the model refuses (gpt-5-family models take no `temperature`) are dropped, and each completed rewrite is recorded as `file_search/rewrite` usage.

## `ranking_options.hybrid_search` weights

Both `POST /openai/v1/vector_stores/{id}/search` and the Responses `file_search` tool accept OpenAI's `ranking_options.hybrid_search: { embedding_weight, text_weight }`, and the retrieval guide's spellings `rrf_embedding_weight` / `rrf_text_weight` for the same two weights. Both spellings of one weight in one request are refused as ambiguous (a 400 `invalid_hybrid_search` on the REST route, dropped on the tool like any invalid `hybrid_search`); `parseHybridSearch` in `src/fileSearch/rrf.ts` is the one parser for both surfaces. The weights scale the two lists the reciprocal rank fusion merges: a chunk's contribution from a list is `weight / (rrfK + rank)`, `embedding_weight` for every vector list and `text_weight` for the full-text list. A weight of 0 leaves its list out: chunks only that list recalled are not candidates at all, so they never reach the reranker. A missing field counts as 1; without `hybrid_search` the fusion is unweighted, exactly as before. With `hybrid.lexicalEnabled=false` only the vector list exists, so the weights cannot change the order.

Each weight must be a finite number >= 0, and they must not both be 0. On the REST route anything else is a 400 with code `invalid_hybrid_search`. On the Responses tool an invalid `hybrid_search` is dropped and the search runs unweighted, the same way an invalid `score_threshold` is dropped there. The `score_threshold` still applies to the reranker score, so weights change which candidates reach the reranker, not the final order when the reranker is on. In RRF-only mode (reranker off or unavailable) `score_threshold` applies to the weighted fused score instead, and the weights rescale that score: with `embedding_weight` 2 every vector contribution doubles, so a threshold tuned for unweighted fusion keeps more chunks, and weights below 1 make it drop more.

## `ranking_options.ranker`

`none` skips the rerank: no call to the reranker deployment and no `file_search/rerank` usage, the
search answers in RRF-only mode (the fused order and scores, `score_threshold` against the fused
score as above). `auto`, `default-2024-11-15` and the Assistants v2 spelling `default_2024_08_21`
rerank exactly as a request without `ranker` (or with `ranker: null`) does: this deployment has one
reranker, so there is nothing for them to choose between. `SEARCH_RANKERS` in
`src/fileSearch/search.ts` is the one list both surfaces check. Any other value is refused, a 400 `invalid_ranker` on the REST route and a 400 from `prepare()` on the
Responses tool (before the turn opens). Internally the REST parser and the tool translation both map
`none` to `rankingOptions.rerank: false`, which `searchVectorStores` reads.

## Several queries in one search

`POST /vector_stores/{id}/search` takes `query` as a string or as an array of 1 to 10 non-empty
strings (OpenAI's `string | string[]`; it documents no bound, `MAX_SEARCH_QUERIES` in
`vectorStoresController.ts` sets ours). Anything else is a 400 `invalid_query`; the queries share
the single query's 8192-character bound, as a total (`query_too_long`). In `searchVectorStores`:

1. With `rewrite_query` on, each query is rewritten on its own (one rewrite call, and one
   `file_search/rewrite` usage record, per query).
2. All queries go to the embedding model in **one** request per model group (the stores' own models,
   as for one query), so one `file_search/search` usage record per group, and the request has the
   query embeddings' timeout and retry.
3. Each query is recalled on its own (`recallCandidates`, one after the other: each is a pooled
   connection), and the per-query candidate lists are fused by RRF (`fuseRrf`, `k` =
   `hybrid.rrfK`, chunks identified by `candidateId`), capped at `hybrid.candidates`. A chunk
   several queries found rises; each query's own top hits interleave by rank.
4. The fused set is reranked **once**, against the queries joined by newlines, so a query array costs
   one rerank like a single query.

In RRF-only mode (`ranker: "none"`, reranker off or unavailable) the scores of a query array are the
across-query fused RRF scores, sums of `1 / (rrfK + rank)` over the queries that found the chunk, so
they grow with the number of queries: a `score_threshold` tuned for single-query RRF scores keeps more
chunks for an array. With the reranker on, `score_threshold` applies to its calibrated score as for one
query. A multi-query search writes **no** teacher-label row (a row describes one query against its
recall candidates; a fused set would mix meanings in the reranker dataset).

`search_query` in the response lists every query searched (after a rewrite), in request order; for a
single query it is the one-element array it always was. The Responses tool still searches one query
per call (the model's argument). The fusion is pinned in `test/fileSearch/search.test.ts` ("several
queries") and end to end in `test/fileSearch/integration/endToEnd.test.ts` ("OpenAI parity").

## Files: `purpose`, `status`, paging and delete

- Upload takes purpose `assistants` or `user_data` (openai-node `FilePurpose` calls `user_data` a
  "flexible file type for any purpose", and OpenAI's file-search guide uploads with it in its Java and Ruby
  samples). The value is stored in `fs_files.purpose` and returned; attaching to a vector store does not look
  at it, so both can be attached. Any other purpose is `400 invalid_purpose` (`SUPPORTED_PURPOSES` in
  `filesController.ts`).
- `GET /files` pages as OpenAI's: `limit` default **10,000** and at most 10,000 (openai-python
  `types/file_list_params.py`: "Limit can range between 1 and 10,000, and the default is 10,000"), via
  `parsePageParams(query, FILES_PAGE_LIMITS)`; everything else about the keyset paging is unchanged, and the
  vector-store lists keep 20 / 100. A file row is a few hundred bytes on the wire, so a full page is a few MB.

- The File object carries `status: "processed"` and `status_details: null`: OpenAI's SDK type
  requires `status`, and openai-node's `files.waitForProcessing()` (Python's
  `wait_for_processing`) polls it. A file here is stored and ready when its upload is answered.
- `GET /files?purpose=assistants` (or `user_data`) lists the files of that purpose (`AND purpose = $2`, keyset
  cursor unchanged); any other purpose lists nothing without a query, since upload accepts only those two. A
  bracketed or non-string value is ignored like an absent one.
- `DELETE /files/{id}` follows OpenAI ("Delete a file and remove it from all vector stores"): it calls
  `deleteFileDetachingEverywhere` (`src/fileSearch/storeFiles.ts`), the transaction the cockpit's
  `?detach=true` already used. The caller's stores holding the file are locked first, then the file
  row; its `vector_store_files` rows, chunks (every generation) and re-embed items go, the stores'
  `last_active_at`/`expires_at` are recomputed, and the file row and blob reference are released,
  all or nothing. A file that was a **member of a file batch** leaves the batch with it: the batch's
  `file_counts` and status are derived from the remaining members (a batch whose last member went
  reads `completed` with zero counts), its job stays, and an ingestion already running for the file
  finds the attachment gone at commit and discards its work. `409 file_in_use` remains only for a
  file a store of **another** owner still references. A deadlock victim answers `409
  concurrent_modification`. The cockpit keeps sending `?detach=true` (now redundant) and keeps its
  confirmation.
- File expiry (G11): `expires_after {anchor: created_at, seconds 3600–2592000}` on upload sets the nullable
  `fs_files.expires_at` (database clock, `insertFileRow`; partial index `idx_fs_files_expires_at`). Reads,
  attaches and deletes treat a file past it as gone at once (`notExpiredSql` / `attachedFileNotExpiredSql` in
  `fileRows.ts`); the expiry sweeper's file pass (`sweepExpiredFiles`, keyset-resumed batches of 200 every
  5 minutes) deletes it through `deleteFileDetachingEverywhere(…, 'expired')`, exactly as a user delete.

## Uploads API (`/uploads`)

OpenAI's multi-part upload (G12): `POST /uploads` → `POST /uploads/{id}/parts` (multipart field `data`) →
`POST /uploads/{id}/complete` (`part_ids` in file order, optional `md5`) or `POST /uploads/{id}/cancel`.
HTTP side `controllers/uploadsController.ts`, database side `fileSearch/uploads.ts`, routes from
`routes/uploadRouteTable.ts` on the same prefixes, guard chain and NUL-byte guard as `/files` (the cockpit's
grounding routes have no uploads mount).

- **Tables.** `fs_uploads` (metadata, `status` pending/completed/cancelled/expired, `expires_at` = created +
  1 h, the file's own `expires_after_seconds`, `file_id` once completed) and `fs_upload_parts` (`bytea`
  `data`, `size_bytes`, FK to the upload ON DELETE CASCADE). Parts are staged in Postgres whatever
  `blob_storage.backend` is: the blob backends store whole files only. Staging in Postgres is deliberate
  (it works for every blob backend, and the per-owner pending limit below caps what one owner can stage);
  there is no upload size cap beyond `max_file_bytes`, the admin's limit for direct uploads too. Both tables are created by one DO
  block that runs only for the owner of `fs_files` and are in `REQUIRED_TABLES`. `kyma-db-manager.js
  --exclude-blobs` leaves out `fs_upload_parts` data with `file_blobs` data.
- **Rules.** Create runs `checkNewFile` (filename, purpose, `expires_after`, shared with `POST /files`), so the
  completed file obeys the direct upload's rules; declared `bytes` ≤ `limits.max_file_bytes`.
- **Completion** is one transaction (`withRetainTransaction` in `blob/blobStore.ts`): lock the upload row,
  check the part ids and that their sizes sum to `bytes`, then fill one `Buffer.alloc(bytes)` reading the parts
  one query at a time in `part_ids` order (peak: the file plus one part, bounded by `max_file_bytes`), check
  `md5`, retain the blob,
  `insertFileRow(row, client)`, delete every part, mark the upload completed. Any refusal or failure rolls
  all of it back and leaves the parts for a retry. Cancel deletes the parts with the status change.
- **Lock order:** the upload row (`FOR UPDATE`, taken first by every operation), then the blob's per-sha
  advisory lock, then its `file_blobs` row (inside the retain). Nothing that locks a blob locks an upload, so
  complete/cancel/part/sweeper serialise on the upload row and never cross the blob paths. Creates of one
  owner serialise on `pg_advisory_xact_lock(0x75706c64 'upld', hashtext(owner))` for the pending count.
- **Limits** (constants in `uploads.ts`): part ≤ `min(48 MiB, max_file_bytes)` (below nginx's 50M
  `client_max_body_size`; streamed, `413 part_too_large` naming it); parts never stage more than `bytes`;
  1,000 parts per upload; 10 pending uploads per owner, counting a lapsed one while it still holds parts, so
  staged bytes per owner stay ≤ 10 × `max_file_bytes`.
- **Sweeper.** `sweepExpiredUploads` is the expiry sweeper's third pass (after stores and files, each caught
  on its own): one `WITH … FOR UPDATE SKIP LOCKED` statement marks up to 200 pending uploads past
  `expires_at` expired and deletes their parts; a row another transaction holds is skipped (that transaction
  already answers it as expired). A second CTE deletes terminal uploads older than 30 days. Until the sweep,
  every operation on a lapsed pending upload answers `400 upload_not_pending` naming `expired`.

## Chunking strategy

One resolver, `resolveChunking` in `src/fileSearch/chunkingSetting.ts`, decides how a file is cut:
a file's explicit OpenAI `static` strategy (given on store create, attach or file batch) wins; `auto`
or none takes the store's setting, `vector_stores.chunking` (`{type: 'static' | 'structure',
max_tokens, overlap_tokens, contextual, vision?}`; `vision` see [Vision transcription](#vision-transcription-visiontranscriber-ts)). `createStore` resolves `file_search.chunking` from the
configuration and writes it onto every new store, so a store never follows a later configuration
change; a store created before the column exists holds NULL, which means static 800/400. An invalid
configured default is logged and replaced by static 800/400.

**Defaults.** The shipped `file_search.chunking` is `{"strategy": "structure", "max_chunk_size_tokens": 800,
"chunk_overlap_tokens": 0, "contextual": true}`, and `hybrid.rerank.input` is `"context_and_text"`; both were
chosen by the chunking evaluation of 2026-10-09 (below) and are set explicitly in the shipped file. Within
`file_search.chunking` an absent key means what the Configuration form shows for it (`chunkingConfig` in
`configService.ts`; the schema `default`s agree): `strategy` "static", `contextual` false,
`max_chunk_size_tokens` 800, and `chunk_overlap_tokens` 400 for `static` or 0 for `structure`. So a missing or
empty block, `{"strategy": "static"}`, and a block that sets sizes but no `strategy` (every configuration written
before the key existed) are static without contexts: an upgrade never starts context calls by itself, and
`{"strategy": "structure"}` alone is structure without contexts. The one exception is `"contextual": true`
without a `strategy`, which means `structure` (contexts exist only there); the form cannot show that shape, so its
gate refuses `contextual` on unless `strategy` is set to "structure" (an `allOf` `if`/`then` in the schema), and only a
hand-edited file reaches it. `FILE_SEARCH_DEFAULTS.chunking` (no `file_search` block at all) is static 800/400
without contexts as well. The defaults reach only stores created afterwards: a NULL store stays static 800/400, a
recorded setting stays as recorded, and a file's explicit static strategy still wins.

The OpenAI routes take only OpenAI's two request types. `static` must carry both
`max_chunk_size_tokens` (100–4096) and `chunk_overlap_tokens` (0 to half of it); anything else,
including an unknown `type`, is a 400 with `param` naming the field (for example
`chunking_strategy.type`, code `invalid_value`) before anything is written. A
`vector_store.file` reports its effective strategy: the resolved static parameters, as OpenAI
does, or `{"type": "other"}` for a `structure` file. The OpenAI store object carries no chunking
field.

### `structure`: chunks that follow the document

`static` is the word-window chunker it always was (`chunker.ts`), byte for byte: existing stores, their
re-embeds and the evaluation baseline stay comparable. `structure` (`structureChunker.ts`) cuts along the
document instead:

- **Extraction keeps the structure** (`extractStructuredText` in `extractors/registry.ts`; `static` keeps
  `extractText`). Markdown is read as is; docx, odt, epub and rst go through pandoc as GitHub-flavoured
  Markdown (headings, pipe tables, fenced code, no re-wrapping); HTML loses its tags but keeps headings and
  `<pre>` blocks; PDFs are read as pages and paragraphs (pdftotext carries no headings); every other text
  format as blank-line blocks.
- **Sections, then chunks.** A section runs from a heading (or a PDF page) to the next. Sections under 100
  tokens merge into the next one. A section that fits `max_tokens` is one chunk. A longer one is packed from
  its blocks (paragraphs, lists, tables, fenced code), which stay whole when they fit; a larger block falls
  apart into lines, and a line too long for a chunk into pieces cut after a sentence or at whitespace.
  Overlap is applied between the chunks of one section, never across sections.
  Tokens are counted with `cl100k_base`, the tokenizer of the embedding models.
- **Exact substrings.** Every chunk is `text.slice(sectionStart + sectionOffset, …)` of its section, and the
  chunks of a section cover it without a gap. Parent sections (below) are rebuilt from the chunks alone; the
  extracted text is not stored.
- **Metadata per chunk:** `section` (ordinal in the file), `section_offset`, `heading_path` ("Install >
  Docker > Ports"), and for a chunk that starts inside a Markdown table the table's header rows (prepended to
  its context, never to its text). Static and legacy chunks have all of them NULL.
- **Off the event loop.** A megabyte of hostile text can take over a second to tokenize, so structure chunking
  runs in one worker thread per gateway process (`structureChunkThread.ts`, `structureChunkWorker.ts`); files
  queue in it one at a time. If the thread cannot start (its compiled file missing, for example), chunking runs
  in-process with a warning, for texts up to 2 Mi characters only (see *Memory during ingestion*).
- **Whitespace-only chunks** are stored (parents need them to be gapless) but never embedded:
  `vector_store_chunks.embedding` is nullable, and the vector arm skips NULL vectors.

The per-file token limit (`limits.max_tokens_per_file`) is checked on the extracted text before chunking with
the same estimate for both strategies, so a file is accepted or refused whatever its store's setting.

### Contextual chunks

With `contextual: true` (only with `structure`) a language model writes one or two sentences per chunk that
place it in its document (Anthropic's "contextual retrieval"). `contextWriter.ts` sends, per chunk, the whole
document (or, above `contextual.max_document_tokens`, a window of that size around the chunk) and the chunk,
through the internal completion helper (`orchestrationCompletion.ts`, the same SAP orchestration call the query
rewriter uses; no caller text goes into the template SAP parses). The first chunk of a file is sent alone so a
provider cache can be written, the rest `contextual.concurrency` at a time.

- **Stored, not returned.** `vector_store_chunks.context` = the heading path line, the model's sentence(s)
  and the table header, those present. The embedding input is `context + "\n\n" + text`; the full-text arm
  matches `tsv OR context_tsv` (`context_tsv` = `to_tsvector('simple', context)`, written by the insert);
  search results, citations, the file content route and `usage_bytes` stay chunk text only. The reranker reads
  `context + "\n\n" + text` where a chunk has a context, else the text (`hybrid.rerank.input`, default
  `"context_and_text"`; `"text"` reads the text only). `setRerankInput` in `search.ts` overrides the setting for
  the evaluation runner.
- **Best effort.** A failed, timed-out, truncated or empty reply leaves that chunk with its heading path only
  and is counted in the job (`context_failed_chunks`, "Chunks Without Context" in the cockpit). The writer
  stops early, counting the rest as failed, when the model is not served, after a run of consecutive failures,
  at its soft deadline (`contextual.file_deadline_ms`, at most half of the time left for the file) or once the
  file has spent `contextual.max_input_tokens_per_file`. A file never fails because of its contexts.
- **A plain re-embed reuses the stored contexts**; only a re-chunk writes new ones.

Configuration, `file_search.contextual`: `model` (default `gemini-3.5-flash-lite`), `max_document_tokens`
(32,000), `concurrency` (4), `request_timeout_ms` (30,000), `file_deadline_ms` (360,000),
`max_input_tokens_per_file` (20,000,000). Whether chunks are contextual is a store setting, not a key here.

**The context model.** Every call repeats the document, so a file of N chunks sends about N times the
document; what matters is the input price and whether the provider caches that prefix. The default,
`gemini-3.5-flash-lite`, is cheap per token, but Gemini caches implicitly and unreliably (measured on the
evaluation corpus: 8.8% of the prompt read from a cache), so count the full prompt at the input price. `anthropic--claude-4.5-haiku` costs
more per token but gets explicit cache breakpoints from the helper and read the document from the cache in
the probe (cache reads are about a tenth of the input price). OpenAI-family
models cache automatically above 1,024 prompt tokens; gpt-5-family models also spend output on reasoning.
`contextWriterLive.test.ts` (opt-in, `FILE_SEARCH_CONTEXT_LIVE_PROBE=1`) shows a model's usage and replies on
three calls. **Reasoning models are not supported as the context model** (gpt-5 family, o-series): the writer
asks for at most 200 output tokens (`max_tokens`, passed to the orchestration unchanged), which such a model
can spend on reasoning, so its replies come back truncated and the chunks stay without context.

### Parent sections

`file_search.parent_sections` (`max_tokens` default 1,500, range 200–8,000; `scope` `tool` (default), `all`
or `off`). On the surfaces the scope names, a structured hit is returned as its section: the sibling chunks
of the same store, file, generation and section, joined by `section_offset`; when the section is longer than
`max_tokens`, a window around the hit chunk, which is always included (a hit chunk that alone exceeds the
limit is returned alone). Several hits of one section collapse into the best-scored one and the list is
refilled from the ranking. Static and legacy chunks are returned as chunks. With `tool`, only the Responses
`file_search` tool returns parents (what the model reads, the client's `file_search_call.results` and the
citations agree); `POST /vector_stores/{id}/search` keeps returning chunks, as OpenAI's does. A database error
while reading siblings falls back to the chunks.

### The store setting and re-chunking

`vector_stores.chunking` is written at creation (`createStore`): the cockpit's create dialog sends a setting,
anything else gets the installation default. Changing it means cutting every file again, so it is a job:

- `GET /api/admin/grounding/stores/:id/chunking/estimate?type=…&max_tokens=…&overlap_tokens=…&contextual=…`
  answers files, current and estimated chunks, estimated embedding tokens and, for a contextual target, the
  context model and estimated context input (the prompt as sent, cache reads included) and output (an upper
  bound). The numbers come from the stored chunk counts and token sums, no blob or model is touched; every
  figure is an estimate (`rechunk.ts`, `estimateFileRechunk` + `estimateContextTokens`).
- `POST /api/admin/grounding/stores/:id/chunking` with `{ "chunking": {…} }` starts a `reembed_store` job
  with `fs_jobs.target_chunking` set. It is refused with 409 `reembed_running`, `chunking_current`,
  `store_expired`, `store_dimension_mismatch` or `store_model_unavailable` (one tiny embedding call checks the
  store's model before any context call), and for a contextual target with `context_model_unavailable`: one tiny
  context call (`checkContextModel` in `contextWriter.ts`, billed as `file_search/context` usage, not counted in the
  job) found no deployment or was refused with HTTP 400, 404 or 422; a timeout or 5xx lets the start go on. The
  admin variants live under `/admin/stores/:id/chunking…`.
- **Filling missing contexts.** A target equal to the store's setting is `chunking_current`, except for a
  contextual setting whose active chunks lack their model-written sentence (a context call failed during
  ingestion, for example in an outage): the estimate reports them as `chunks_without_context` and the start
  re-chunks the store with its own setting, which writes every file's contexts again. A chunk counts as missing
  when its context, after the heading-path line, is empty or starts with a table row (a line holding `|`), which
  is how `chunkContext` lays it out; a sentence that itself holds a `|` is counted too (the harmless side).
  Only structured chunks count: a file attached with an explicit static strategy stays static through a
  re-chunk and has no contexts to fill.
- **Per-file context stops (`contextStop.ts`).** When the writer stops a file at its deadline or its
  `contextual.max_input_tokens_per_file` ceiling, the commit records why in `vector_store_files.context_stopped`
  (and, for a re-chunk item, `fs_reembed_items.context_stopped`; both nullable `text`, guarded `DO` blocks, in
  `REQUIRED_COLUMNS`): `deadline`, `budget` or `deadline_retried`. Outages (`failing`, `no_deployment`) are not
  recorded; their chunks keep counting as missing and a later fill mends them. A `budget` stop is final at
  once (a second try would spend the same tokens and stop at the same place); a `deadline` stop is retried once
  by the fill, a re-chunk item having its own `PROCESS_BUDGET_MS`, and one that stops again becomes
  `deadline_retried`, final too. `chunksWithoutContext` leaves out files whose stop is final
  (`FINAL_CONTEXT_STOPS`), so the estimate and the start's refusal agree and the fill cannot loop. Any re-chunk
  to the setting the stop was recorded under counts as the retry (a re-extract too, whose copied file keeps the
  value); a re-chunk to another setting or a new ingestion is a first try; a retry that writes every context
  clears it. The cockpit's store file list (grounding routes only; the OpenAI-shaped `/v1` objects are
  unchanged) shows **Context incomplete** with a tooltip saying whether a re-chunk with the current setting
  still retries the file. Tests: `contextStop.test.ts`, `integration/migrationContextStop.test.ts`, the
  re-chunk and re-extract suites, `groundingAdminRoutes.test.ts`.
- Each item reads the file's blob again, resolves the file's own strategy against the target (a file attached
  with an explicit `static` keeps it), runs the same `prepareFileChunks` as ingestion, embeds with the store's
  own model into the next generation and commits. The store switches generation and setting in one update
  when every item is done; cancel or failure leaves the old chunks and setting active. Files attached during a
  re-chunk are chunked for both generations.
- Turning `contextual` off is a re-chunk too (no context calls): the stored context cannot be split back into
  heading path and sentence reliably.
- Job summaries carry `target_chunking` and the four context counters.

### Costs

A contextual ingestion costs about `chunks × document tokens` of context input per file (plus the chunks
themselves and a small fixed prompt), capped per file by `max_input_tokens_per_file`. On the evaluation
corpus (16 files, about 160 structure chunks at 800) that is about 1.3 million input tokens and at most
31,000 output tokens; one long developer document alone (about 20,000 tokens and 40 chunks) is more than half of it.

- Every context call is recorded as `file_search/context` usage, billed like the file's embeddings (the
  store's owner), with cache writes and reads in their own fields; a model without a Model Library price
  costs 0. The default `gemini-3.5-flash-lite` is priced by SAP's catalogue (its SAP Cost Factors per 1K tokens in
  the Model Library) like other models.
- **Not recorded:** a context call that times out on our side (`contextual.request_timeout_ms`) may still have
  been run and billed by SAP; no usage event is written for it.
- **Contexts written twice.** A file attached while a contextual store is re-chunked to another contextual
  setting is chunked for both generations, so its contexts are written (and billed) twice; a fill re-chunk
  (the store's own setting) writes every file's contexts again, not only the missing ones.
- `fs_jobs.context_input_tokens` counts uncached input with cache writes included, `context_cached_tokens`
  cache reads, `context_output_tokens` output.
- **Retries spend again.** A file whose ingestion fails after its contexts were written (an embedding error,
  the time budget) is retried from the start, and the retry writes its contexts again. The usage events
  record every attempt; the job counters only the attempt whose chunks were committed. A re-chunk item that
  is retried behaves the same way.
- A re-chunk to a contextual setting costs the same as ingesting the store's files anew; the cockpit shows the
  estimate before it starts.

### The evaluation behind the defaults

Measured on 2026-10-09 with the evaluation runner (`ci/file-search-eval/baseline.json` holds every run; 145
questions, 127 of them answerable from text):

| Configuration | recall@5 | recall@10 | MRR | nDCG@10 |
|---|---|---|---|---|
| `baseline` (static 800/400) | 0.807 | 0.834 | 0.711 | 0.764 |
| `structure` (800/0) | 0.772 | 0.814 | 0.659 | 0.730 |
| `contextual` (flash-lite contexts, reranker reads text) | 0.772 | 0.814 | 0.658 | 0.729 |
| `contextual-rerank-ctx` (reranker reads context + text) | **0.834** | **0.848** | **0.725** | **0.793** |
| `contextual-haiku` | 0.779 | 0.821 | 0.660 | 0.733 |
| `structure-no-rerank` | 0.676 | 0.752 | 0.543 | 0.621 |
| `contextual-no-rerank` | 0.786 | 0.834 | 0.617 | 0.703 |
| `structure-c20` | 0.759 | 0.807 | 0.650 | 0.722 |
| `contextual-c20` | 0.793 | 0.848 | 0.665 | 0.742 |

- **Structure alone is worse on this corpus** than static 800/400 with its 50% overlap, mostly on PDFs and
  multihop questions.
- **Contexts help the first stage**: without the reranker recall@10 rises from 0.752 to 0.834, and with only 20
  candidates per arm (as a larger store would leave the reranker) every measure rises. They change nothing while
  the reranker reads the chunk text alone, which is why the reranker now reads context and text: that run is the
  best on every measure, above the static baseline, and best on PDFs (0.925 at @5) and multihop questions (0.889).
- **Haiku as the context model gains nothing** over `gemini-3.5-flash-lite`, at about three times the context cost
  at list prices, so the default stays flash-lite.
- **Parent sections** (`parent --judge 40`, `gemini-3.5-flash` as judge): faithfulness 5.00, correctness 4.80 of 5;
  `parent_sections.scope` stays `tool`.
- **Cost on the corpus**: one contextual ingestion made 157 context calls, 1.30 million uncached and 0.12 million
  cached input tokens and 6,000 output tokens with flash-lite. Structure chunks (157 of about 400 tokens instead of
  97 of up to 800) cost the reranker one search unit per question instead of two.

### Upgrade

The gateway adds, on its first start, through the guarded `DO $$` blocks and the `missingRequiredSchema` probe
(non-owner installs report file search unavailable until `cli-tools/file-search-migrate.js` or
`FILE_SEARCH_MIGRATION_DATABASE_URL` has run as the owner):

- nullable `vector_store_chunks.context`, `context_tsv`, `section`, `section_offset`, `heading_path`;
  `vector_stores.chunking`; `fs_jobs.target_chunking`; `fs_jobs.context_input_tokens`,
  `context_cached_tokens`, `context_output_tokens`, `context_failed_chunks` (`bigint NOT NULL DEFAULT 0`). All
  catalog-only, no table rewrite.
- `vector_store_chunks.embedding` loses its `NOT NULL` (catalog-only).
- `idx_chunks_context_tsv` (`gin (context_tsv) WHERE context_tsv IS NOT NULL`), built in a second transaction
  after the columns have committed: during the build writes to the chunks wait, searches go on. It scans the
  chunk table once (all rows are NULL, nothing is indexed). An install that cannot build it stays available.

Existing stores keep NULL (static 800/400) and their chunks until they are re-chunked. Which default new stores
get depends on the configuration in effect: an install whose configuration was written before this release (an
activated configuration on Docker or Kyma, or a standalone install's copied `api_config.json`) has a `chunking`
block with sizes but no `strategy`, and keeps static chunking without contexts until an operator sets
`"strategy": "structure"` and `"contextual": true` (an absent `contextual` is off). New installs, and installs that use the shipped file, get
structure 800/0 with contexts, so ingesting into new stores makes one context call per chunk. A standalone (npm) install that runs `sail-proxy config reset`
after the upgrade gets `api_config.json` rewritten from the new template, which switches new stores to
structure with contexts. During a rolling deploy with several replicas, an old replica that commits a file
while a store is re-chunked writes static chunks into the target generation (it does not know the target
setting); a single replica is not affected, and a later re-chunk repairs it. The migration takes its advisory
lock per phase (the columns, then the post-commit index), not once for both; when the index build fails, the
privileged migrate CLI (`cli-tools/file-search-migrate.js`, `FILE_SEARCH_MIGRATION_DATABASE_URL`) exits non-zero,
while a gateway migrating with its single DSN logs a warning and stays available. The configuration
ranges of `file_search.chunking` are tighter than before (`max_chunk_size_tokens` 100–4096,
`chunk_overlap_tokens` 0–2048 and at most half the maximum); a stored configuration outside them opens in the
JSON editor and is refused on save until corrected, and the gateway falls back to static 800/400 with a
warning.

Tests: `structureChunker*.test.ts`, `chunkerStaticPin.test.ts` (static output pinned), `chunkingSetting.test.ts`,
`vectorStoresChunking.test.ts`, `contextWriter.test.ts`, `orchestrationCompletion.test.ts`,
`structureChunkThread.test.ts`, `chunkPipeline.test.ts`, `parentSections.test.ts`, `searchParentSections.test.ts`,
and under `integration/` `migrationChunking`, `storeChunking`, `structuredIngest`, `parentSearch` and the re-chunk
suites.

## Document parsing: OCR, Office files, pages and vision

How a file becomes text before it is chunked.

| Format | Read by | Pages |
|---|---|---|
| PDF | `pdftotext - -` (a form feed ends each page), then vision (opt-in) and OCR for the pages that need it | yes |
| pptx | built-in OOXML reader (`extractors/ooxml/pptx.ts`), in a worker thread | yes: slide N = page N |
| xlsx | built-in OOXML reader (`extractors/ooxml/xlsx.ts`), in a worker thread | no |
| docx, odt, epub, rst, html, tex | pandoc | no |
| doc (Word 97–2003) | antiword, where installed and not switched off (`extractors/legacyDoc.ts`) | no |
| text, Markdown, code | as is | no |

`.ppt` and `.xls` stay refused (`UnsupportedFileTypeError`). Dispatch is by extension only
(`extractors/registry.ts`), and both chunking strategies get the same text: `extractText` (static) and
`extractStructuredText` (structure) run the same OCR and vision pass, so the static output of a text PDF stays
byte-identical to raw pdftotext (`chunkerStaticPin.test.ts` and the gated `integration/pdfOcr.test.ts` pin it).

### The tool runner

Every external tool runs through `extractors/runners.ts`: `runExtractor` (text) and `runExtractorBuffer` (bytes,
for pdftoppm's images) spawn the binary from the gateway's PATH with no shell, the input on stdin, an output cap and
a wall-clock timeout armed before any I/O (`runExtractorOnFile`, for antiword, passes a private temporary file
instead of stdin). A non-zero exit rejects with `ExtractorExitError` (its `name` stays `Error`, as stored
`last_error` rows carry it). The child's environment is empty except for names in
`ALLOWED_CHILD_ENV` (`OMP_THREAD_LIMIT`, `TESSDATA_PREFIX`); anything else throws at the call site.
`lowPriority: true` runs the tool through `nice -n 10` (one debug log line where `nice` is missing). A timeout kills
the whole process group (SIGTERM, then SIGKILL) and destroys the pipes, so it settles even when a descendant holds
them. Tests feed tools through this runner, never through a synchronous child with `input:` (such a call hung
`pdftotext - -` on macOS with nothing to stop it); `noSyncChildInput.test.ts` guards that.

### OCR (`extractors/pdfOcr.ts`)

After pdftotext, every page with fewer than 16 non-whitespace characters is an OCR candidate. A text PDF has none,
so it never even asks whether OCR is on. Per candidate page, in order:

1. `pdfinfo -f N -l N -box -` reads the page size. The render resolution is `min(300, 5000 × 72 / long side in
   pt)` dpi, taking the largest of the size line and every box line (pdftoppm renders the MediaBox, the size line
   reports the CropBox). A4 and A3 keep 300 dpi; a 10,000 pt page renders at 36 dpi (5000 px, 25 MB) instead of
   1.7 gigapixels. A page whose size cannot be read is skipped.
2. `pdftoppm -f N -l N -r <dpi> -gray -` writes a grey PGM to stdout (no temp files; 48 MiB cap).
3. `tesseract stdin stdout -l <languages> --dpi <dpi> --psm 3` with `OMP_THREAD_LIMIT=1` and the gateway's
   `TESSDATA_PREFIX`, both at low priority.

The recognised text replaces the page in place and every form feed stays, so page numbers survive. Limits
(`OCR_LIMITS`): 60 s per page; per file min(5 min, 40 % of the time left for the file), fixed at its first OCR page;
at most 200 pages per file; one page OCR at a time per gateway process (`OcrSemaphore`, FIFO, so concurrent scans
interleave page by page). Best effort: a page that fails, times out, or comes back empty keeps its text (empty)
and is counted; the pass never throws. `OcrMemo` keeps the outcome per blob sha256 and page, so a re-chunk's second
extraction runs no OCR again. Counters: `fs_jobs.ocr_pages`, `ocr_skipped_pages`, and one info log line per file;
the job summary carries them with `vision_pages`/`vision_skipped_pages`, and the cockpit's job page shows each one
above zero.

Whether OCR runs is `extractors/ocrAvailability.ts`: `FILE_SEARCH_OCR=off` (also `false`, `0`, `no`, `disabled`)
switches it off; otherwise it is on when `tesseract --list-langs` lists at least one configured language (see
[OCR languages](#ocr-languages)). The npm standalone CLI (the lite gateway) always starts the gateway with
`FILE_SEARCH_OCR=off` and strips `DOTENV_CONFIG_*`, so neither the shell nor a `.env` can turn it on there.

### Legacy Word `.doc` (`extractors/legacyDoc.ts`)

The gateway reads `.doc` with **antiword** (Alpine `antiword` 0.37, about 0.5 MiB; LibreOffice reads more but is about
330 MiB). antiword is unmaintained and parses hostile bytes, so it runs only through the runner: no shell, an
empty environment, the extraction timeout, the 64 MiB output cap, `lowPriority`. It seeks in its input (an OLE
container), so it cannot read a pipe: `runExtractorOnFile` writes the bytes to a fresh `mkdtemp` directory (0700,
the file 0600, named `input`, never the upload's name), appends the path to the argv, and removes the directory
when the run settles, also after a timeout. Arguments `-m UTF-8.txt -w 0`: UTF-8 output (the child has no locale)
and a paragraph per line. The structure strategy reads the text as plain blank-line blocks.

- antiword exiting non-zero (not a Word file, encrypted, damaged) is a permanent `DocumentReadError('Word', …)`;
  its stderr is not echoed (it names the temporary file and can quote the document). A timeout or the output cap
  stay the runner's transient errors, as for pandoc.
- Off where `FILE_SEARCH_DOC=off` (also `false`, `0`, `no`, `disabled`) or antiword is not on PATH: `.doc` is then
  not a supported extension and fails permanently with `LegacyDocUnsupportedError` ("legacy .doc files are not
  supported on this deployment"), an `UnsupportedFileTypeError` by class and name, so a re-extract queues such
  files again once `.doc` is read (`reextract.ts`). The npm standalone CLI always sets `FILE_SEARCH_DOC=off`
  (`LITE_GATEWAY_ENV`, pinned by `npm-dist/sail-proxy/test/gateway-env.test.js`).
- The Docker image installs it (`docker/gateway.Dockerfile`; Kyma runs the same image); CI apt-installs `antiword`
  for the `FILE_SEARCH_TEST_BINARIES` suite `integration/legacyDoc.test.ts` (fixture `fixtures/legacy-word.doc`,
  invented text). antiword has no Homebrew formula: on macOS `.doc` stays off and that suite skips with a warning.
  The switch, the limits and the temp-file handling are tested with a fake antiword in `legacyDoc.test.ts`.

### PowerPoint and Excel (`extractors/ooxml/`)

A read-only zip reader (`zip.ts`, central directory, parts inflated on demand in the thread pool, no file
written, entry names only lookup keys), a streaming XML scanner (`xml.ts`: any DTD refused, so no entity
expansion; only the predefined entities and character references), and the two readers:

- **pptx**: slides in the presentation's order, each `## Slide N: <title>` (`(hidden)` for a hidden slide), its text
  frames in shape-tree order, tables as pipe tables, then `### Notes` with the notes body. Every slide ends with a
  form feed, empty slides too, so slide N is page N; a form feed inside slide text becomes a space. Lines that would
  read as Markdown structure are escaped. Not read: charts, SmartArt, images, comments, masters and layouts.
- **xlsx**: sheets in workbook order, `## Sheet: <name>` (`(hidden)`), one pipe table per sheet with the first
  non-empty row as header; empty rows, columns and sheets dropped. Values: shared and inline strings, booleans,
  errors, a formula's cached value (never recalculated), numbers to 15 significant digits, built-in and custom
  date/time formats as ISO dates (1900 and 1904 systems), formats 9/10 as percent, everything else raw.

**Limits** (`ooxml/limits.ts`, `OOXML_LIMITS`; reaching one is a permanent `DocumentReadError`, `Could not read the
PowerPoint|Excel file: <reason>`, never document content):

| Limit | Value |
|---|---|
| zip entries / one entry / all entries inflated | 10,000 / 64 MiB / 256 MiB |
| compression ratio (parts over 1 MiB) | 200 |
| XML nesting depth / one XML token (tag, text node, comment, CDATA) | 256 / 1 Mi characters |
| slides / sheets / non-empty cells | 2,000 / 1,000 / 500,000 |
| rows of one slide table | 100,000 |
| sheet columns | 16,384 (XFD); a cell beyond it fails the file |
| number format code | over 1,024 characters it is not read (the number shows raw) |
| text produced | 32 Mi characters |

ZIP64, multi-disk, encrypted entries, unknown methods, duplicate part names, size mismatches and OLE files
(password-protected or legacy Office) are refused. Any `RangeError` becomes a `DocumentReadError` as a backstop.

**The worker thread.** Every pptx/xlsx is read in one worker thread per gateway process
(`ooxmlThread.ts` + entry `ooxmlWorker.ts`, the pattern of the structure chunker's thread): FIFO, one file at a time,
a hard limit of the extraction timeout + 1 s after which the thread is terminated (the queue waits for the
terminate) and the file fails as a transient `ExtractionTimeoutError` (retried like a pandoc timeout). The heap is
capped with `resourceLimits`: old generation a fifth of `process.constrainedMemory()`, clamped to 256–384 MB (384
without a known limit; Kyma's 2 GiB gives 384), young generation 32 MB, stack 4 MB. Running out of it is a permanent
`DocumentReadError` ("needs more memory than the reader may use"); the gateway lives on. If the thread cannot start,
files are read in-process (sliced, with a warning and a back-off retry). Measured: the worst crafted files stall the
gateway's event loop by at most 16 ms. No dependency was added; the npm-dist bundle carries `dist/**`.

### Page numbers (`pages.ts`)

`vector_store_chunks.page_start` / `page_end` (nullable `int`) hold the pages of a chunk's first and last
non-whitespace character, for paged files only (`PAGED_EXTENSIONS`: pdf, pptx; by extension, so a `.txt` with form
feeds gets none). Structure chunks take them from their document offsets (empty pages skipped and short pages merged
forward keep their real numbers); static chunks from chunkText's own word windows, so static chunk text does not
change. A re-embed copies them; a re-chunk recomputes them. Chunks written before page tracking hold NULL until re-read.

Search results carry `pages: {first, last}` when known, never inside `attributes`: on `POST
/vector_stores/{id}/search` results, on `file_search_call.results[]` and in the tool output the model reads (a
parent section gets its own window's pages), and on `file_citation` beside `start_index`/`end_index` (the cited
hit's pages, not the quoted sentence's). The text passage list reads `report.pdf, p. 4–5`. The field is additive
and omitted when unknown, like the citation offsets.

### Vision transcription (`visionTranscriber.ts`)

Opt-in per store: `ChunkingSetting.vision` (`off`, `no_text`, `auto`, `all`) with either strategy. A setting
carries `vision` only when it is not `off`, so every earlier setting and its `chunkingKey` are unchanged; with a
mode the key gets `:vision-<mode>`. A file with its own static strategy keeps the store's vision mode.

- **Selection** (the evaluation recommends `no_text`, see [Parsing configurations](#parsing-configurations)):
  `no_text` = OCR's rule (< 16 characters); `auto` adds pages under 200 characters and table-heavy pages, replacing
  their text layer even where it read correctly (in one `pdftotext -layout` pass, ≥ 15 lines with a 3-space column gap making ≥ 30 % of the page's lines;
  measured on the evaluation corpus: every table page, no prose page); `all` every page. At most
  `max_pages_per_file` pages are sent per file, counted across a re-chunk's two extractions.
- **Call**: pdfinfo box → pdftoppm grey PGM at ≤ 200 dpi → sharp → grey PNG within 1568 px, sent as an
  `image_url` data URL in `messages_history` through `orchestrationCompletion.ts` (only `data:image/...;base64`
  URLs are accepted); temperature 0, `max_tokens` 4096; the reply is GitHub-flavoured Markdown, sanitised (control
  characters removed, so a reply cannot shift pages; at most 20,000 characters a page).
- **Order and fallback**: vision runs before OCR; a page vision transcribed is not OCRed, a textless page whose
  call failed goes to OCR, and a page with a text layer whose call failed keeps pdftotext's text.
- **Stops and ceilings** (`file_search.parsing.vision`): `concurrency` 2, `request_timeout_ms` 90 s,
  `file_deadline_ms` 240 s (and at most 40 % of the time left), `max_input_tokens_per_file` 150,000,
  `max_output_tokens_per_file` 120,000; it also stops after its first 3 calls fail or after max(4, 2 ×
  concurrency) failures in a row. The ceilings apply **per ingestion attempt**: a retried file spends again, so the
  worst case is (1 + `ingestion.max_retries`) × each ceiling.
- **Billing**: every call is a `file_search/vision` usage event (request id `fs-vision-<uuid>`) to the file's
  payer, like the contexts. Job counters `fs_jobs.vision_pages`, `vision_skipped_pages`.
- **Unavailable**: `FILE_SEARCH_VISION=off` (always so in npm-dist), or pdfinfo/pdftoppm missing, or sharp not
  loading (it is required lazily on first use, so a host without its native package still starts): no call, one
  warning, the pages count as skipped. A create with a mode is then a 400, a re-chunk start a 409
  `vision_model_unavailable`, and the estimate says `vision_switched_off`.
- **Model check**: a re-chunk or re-extract start with a mode sends one blank 16×16 image
  (`checkVisionModel`, billed as `file_search/vision`); no deployment or HTTP 400/404/422 refuses the start with
  409 `vision_model_unavailable`, a timeout or 5xx lets it go on. Store create runs no check.
- **Model**: `gemini-3.5-flash-lite` by default. The live probe (2026-10-09, two A4 scan pages) found every word with
  both flash-lite and `gemini-3.8-flash`; flash-lite wrote 323–382 output tokens a page in 2.3–2.5 s, 3.8-flash
  863–1,590 in 5.7–10.5 s; input was 1,235 tokens a page for both. flash-lite is priced by SAP's catalogue in the
  Model Library like the other models.
- **Estimate**: the re-chunk and re-extract estimates count every PDF at `max_pages_per_file` pages × 1,250 input
  and 4,096 output tokens (`estimated_vision_*`, an upper bound: the real page count is not stored); the cockpit
  prices it through the admin's `GET /api/grounding/model-cost` and labels it "up to". A model without a
  price shows `chunkingEstimateVisionCostUnknown`, which names the vision model (the one the estimate priced)
  and says to add a price for it in the Model Library (`visionCostText` in the grounding app's
  `model/chunking.ts`); there is no link into the Model Library app (the shell has no cross-app navigation
  for it). Only the vision row can be unpriced: the context row shows tokens, no cost.
- **Pseudonymization**: masking works on text, so page images reach the model unmasked. When pseudonymization is
  force-enabled for file_search content (`hooks.defaults.openai.pseudonymization.enabled`, or any
  `models.overrides.*.pseudonymization.enabled`; `isPseudonymizationForcedForFileSearch`), the estimate sets
  `vision_unmasked_warning`, `GET /status` sets `vision.unmaskedWarning`, the cockpit shows a warning strip, and the
  gateway logs `VISION_UNMASKED_WARNING`. The shipped configuration forces it for `openai`, so the warning shows on a
  default installation whenever a mode is chosen. Masking asked for by one request (a trigger word, a `masking`
  field) cannot be foreseen and is not warned about.

Configuration, `file_search.parsing.vision`: `model`, `default_mode` (`off`; the mode new stores get),
`max_pages_per_file` (50, 1–1000), `concurrency` (2, 1–8), `request_timeout_ms` (90,000), `file_deadline_ms`
(240,000), `max_input_tokens_per_file` (150,000), `max_output_tokens_per_file` (120,000); configured values are
clamped into the schema ranges with one warning. An installation whose configuration predates the block reads
`off`, so an upgrade makes no vision call.

### Re-reading files (re-extract)

An upgrade reads nothing again by itself. `vector_store_files.extraction_version` (nullable `int`; NULL = read
before the stamp) records the extractor version a file's chunks were read with: every ingestion commit writes
`EXTRACTION_VERSION` (1), and a re-chunk stamps every file it reads (through `fs_reembed_items.extraction_version`
and the switch's `COALESCE`). `READ_BETTER_SINCE` in `extractors/registry.ts` names, per version, the format it reads
better (version 1: PDF); a later version adds a row for its format only. `ocr_pending` (nullable `boolean`, on the
file and the item) marks a read that left PDF pages without text because OCR could not run there (switched off,
tesseract missing); pages past the cap, failed pages and pages OCR found empty never set it.

A file is read again when `readAgain(filename, version, ocrPending, isOcrEnabled())` holds:
`readBetterNow(...) || (ocr_pending && OCR is on here)`. Failed files whose error was `UnsupportedFileTypeError` and
whose type is now supported (pptx, xlsx) are queued again through the existing `jobs.retryFile`.

- Routes (owner): `GET /api/admin/grounding/stores/:id/reextract/estimate` and
  `POST /api/admin/grounding/stores/:id/reextract`; admin: `GET /api/admin/grounding/admin/stores/:id/reextract/estimate`
  and `POST /api/admin/grounding/admin/stores/:id/reextract` (the job belongs to the owner, `started_by` is the admin).
- The job is a `reembed_store` job with `target_chunking` = the store's own resolved setting and
  `fs_jobs.reextract = true`: the re-chunk machinery (claim, lease, retry, cancel, one running job per store,
  the switch) with two kinds of item: an affected file is extracted, chunked and embedded; any other completed file
  has its rows **copied with their vectors** into the new generation (`INSERT … SELECT`, no extraction, no
  embedding). The switch keeps `vector_stores.chunking`. The store answers from the old generation until then;
  cancel deletes the new one and leaves the stamps.
- The estimate (no blob, no model call) answers `files`, `kept_files`, `retry_files`, chunk and embedding figures,
  context figures for a contextual setting, vision figures for a mode, `ocr_available`, `files_without_text`,
  `running_job_id`. A PDF without any chunk counts at the most pages OCR or vision reads × 500 tokens
  (`OCR_TOKENS_PER_PAGE`).
- Refusals (409): the re-chunk's (`store_dimension_mismatch`, `store_expired`, `reembed_running`, the three model
  checks, run only when files are read), plus `nothing_to_reextract` and `store_chunking_invalid`. A start with
  only retries creates no job: `{job: null, retried_files, refused_files}`.
- Known gap: a scanned PDF read by a version before the stamp on a gateway without OCR is version-affected and
  offered; one read by this version where OCR was off is offered through `ocr_pending` once OCR runs. Changing the
  OCR language list offers nothing: re-chunk the store, or detach and attach the file.

The cockpit's **Re-read Files** (store page for the owner; the Administration store rows for an admin, through the
admin routes: `ReextractFlow(host, admin)`) shows the estimate and starts the job; tests `reextract.test.ts`, `reextractRules.test.ts`,
`migrationReextract.test.ts`.

### Upgrade

On its first start the gateway adds, through guarded `DO $$` blocks and the `missingRequiredSchema` probe
(non-owner installs report file search unavailable until `cli-tools/file-search-migrate.js` or
`FILE_SEARCH_MIGRATION_DATABASE_URL` has run as the owner):

- `fs_jobs.ocr_pages`, `ocr_skipped_pages`, `vision_pages`, `vision_skipped_pages` (`bigint NOT NULL DEFAULT 0`,
  catalog-only like the contextual-chunking counters) and `fs_jobs.reextract` (nullable `boolean`);
- `vector_store_chunks.page_start`, `page_end` (nullable `int`);
- `vector_store_files.extraction_version` (nullable `int`), `ocr_pending` (nullable `boolean`), and the same two on
  `fs_reembed_items`.

No table is rewritten and no index is added. Nothing starts by itself: no file is read again, no vision call is
made (an installation without `parsing.vision` reads `off`; the shipped file sets `default_mode: "off"`). Existing
chunks have no page numbers until their store is re-read or re-chunked; PowerPoint and Excel files that failed as
unsupported stay failed until retried or re-read. The new configuration keys (`file_search.parsing.ocr.languages`,
`file_search.parsing.vision.*`) are absent from configurations written before this release; their built-in
defaults (OCR in `eng`, vision off with `gemini-3.5-flash-lite`) apply until an administrator activates a
configuration that sets them. On Kyma the admin's file configuration is the `admin-api-config` ConfigMap, a local
artifact under `kyma/templates/configmaps/` (gitignored): `deploy-kyma.js` renders it again from
`services/admin/api_config.json` before applying it, so deploy from the new checkout (or re-run `setup-kyma.js`);
applying an old rendered copy by hand keeps the old file configuration. The image grows by tesseract (see
[Release procedure](/developer/release#what-reaches-users-when)).

Tests (under `test/fileSearch/`): `pdfOcr.test.ts`, `ocrAvailability.test.ts`, `ocrLanguagesConfig.test.ts`,
`pages.test.ts`, `chunkPipelinePages.test.ts`, `ooxml*.test.ts`, `visionTranscriber.test.ts`, `visionWiring.test.ts`,
`pageImage.test.ts`, `chunkingSettingVision.test.ts`, `visionConfig.test.ts`, `reextractRules.test.ts`,
`runners-extensions.test.ts`, `noSyncChildInput.test.ts`; under `integration/` `pdfOcrIngest`, `pagesIngest`,
`reextract`, the migration suites, and the `FILE_SEARCH_TEST_BINARIES` suites `pdfOcr`, `visionRender`, `extractors`;
the opt-in live probe `visionLive.test.ts` (`FILE_SEARCH_VISION_LIVE_PROBE=1`).

## OCR languages

PDF pages without a text layer (scans) are read with tesseract. The gateway image (Docker and Kyma) ships tesseract
with **English** only (Alpine's `tesseract-ocr-data-eng`, the standard model); local dev and CI install the same.
The npm standalone CLI is the lite gateway and never runs OCR: it starts the gateway with `FILE_SEARCH_OCR=off`,
whatever the host has installed. `FILE_SEARCH_OCR=off` switches OCR off in any deployment.

The languages OCR uses are `capabilities.file_search.parsing.ocr.languages` (default `["eng"]`): tesseract codes
such as `deu`, `fra` or `chi_sim` (three lower-case letters, optional `_suffix` parts; anything else is ignored with
a warning, because the codes become a tesseract argument). The gateway compares the list with
`tesseract --list-langs`: a configured language without installed data is skipped with one warning naming it
(`OCR languages without installed language data are skipped: …`); with none left OCR is off with a warning. Each
language makes OCR of a page slower, so list only the languages your documents use.

tesseract is asked when OCR is first needed, again whenever the configured list changes, and — while tesseract
could not be run at all — again every 60 s. A successful answer is otherwise kept. So language data that appears
while the gateway runs (a local install, a volume mounted later) is picked up when you then change the list; data
replaced without a list change needs a gateway restart. A new image or a new mount at container start needs
nothing extra.

Adding a language takes two steps: install its language data where the gateway runs, then add the code to the
list. German (`deu`) as the example:

**1. Install the language data**

- **Docker: keep your change in a compose file of its own.** `docker/docker-compose.override.yml` is not yours:
  `docker/setup-docker.js` writes it (local build mode) and deletes it (registry mode, or an auth provider that needs
  none) on every run, so anything added there is lost. Put the change into a separately named file, for example
  `docker/docker-compose.ocr-languages.yml`, and pass it with an extra `-f`. `pnpm docker:up` runs
  `docker-compose -f docker/docker-compose.yml up -d` only, so it does not pick the file up: start the stack with

  ```bash
  docker compose -f docker/docker-compose.yml -f docker/docker-compose.ocr-languages.yml up -d
  ```

  every time instead (an explicit `-f` also skips `docker-compose.override.yml`; add `-f
  docker/docker-compose.override.yml` before your file if you rely on it, and `--profile ollama` as `pnpm
  docker:up-with-ollama` does). Either of the two ways below goes into that file.
- **Docker, derived image (recommended).** Build on the released image and add the Alpine package, which carries
  the same standard model as `eng`:

  ```dockerfile
  FROM ghcr.io/st-gr/sail-proxy-gateway:<version>
  USER root
  RUN apk add --no-cache tesseract-ocr-data-deu
  USER nodejs
  ```

  ```bash
  docker build -t local/sail-proxy-gateway-ocr:<version> -f Dockerfile.ocr .
  ```

  ```yaml
  # docker/docker-compose.ocr-languages.yml
  services:
    gateway:
      image: local/sail-proxy-gateway-ocr:<version>
      pull_policy: never
  ```

  Do not pass `--build` with this file: the `gateway` service keeps its `build:` section, and a build would replace
  the derived image with a plain one under the same name. Rebuild the derived image for every gateway release.
- **Docker, mounted directory.** Put **every** language the gateway should have into one directory, `eng` included
  (`osd` too if you add it): `TESSDATA_PREFIX` replaces the image's own data directory rather than adding to it.
  Take the files from [tesseract-ocr/tessdata](https://github.com/tesseract-ocr/tessdata) (the standard models,
  matching the image; `tessdata_fast` is smaller and less accurate, `tessdata_best` larger and slower), e.g.
  `curl -fLO https://github.com/tesseract-ocr/tessdata/raw/main/deu.traineddata` and the same for `eng`, into
  `docker/tessdata/`. Then:

  ```yaml
  # docker/docker-compose.ocr-languages.yml (paths are relative to this file)
  services:
    gateway:
      volumes:
        - ./tessdata:/opt/tessdata:ro
      environment:
        TESSDATA_PREFIX: /opt/tessdata
  ```

  The gateway passes its own `TESSDATA_PREFIX` on to tesseract.
- **Kyma.** Push the derived image above to your registry as `<registry>/<organisation>/sail-proxy-gateway:<tag>`
  and deploy with it (the manifests take the registry, organisation and tag from the deploy settings and the name
  `sail-proxy-gateway` as fixed); repeat for every release. The alternative, a PersistentVolumeClaim holding all
  wanted `.traineddata` files mounted into the gateway container with `TESSDATA_PREFIX` set to its mount path, means
  editing the shipped gateway manifest (`kyma/templates/manifests/core/gateway.yaml` declares no volumes today) and
  carrying that edit over on every upgrade. A ConfigMap is too small for language data (`eng` alone is 22 MiB).
- **Local dev.** `brew install tesseract` ships `eng` (and `osd`); for one more language download its file into
  Homebrew's data directory, e.g. `curl -fL -o "$(brew --prefix)/share/tessdata/deu.traineddata"
  https://github.com/tesseract-ocr/tessdata/raw/main/deu.traineddata` (`tesseract-lang` would install every
  language, several hundred MB). On Debian/Ubuntu: `apt-get install tesseract-ocr-deu`.

Check with `tesseract --list-langs` (in the container: `docker exec <gateway container> tesseract --list-langs`).

**2. Configure it.** In the cockpit, open the active configuration and add the code to the file search capability's **Document
parsing → Text recognition (OCR) → OCR languages** (JSON: `capabilities.file_search.parsing.ocr.languages`, e.g.
`["eng", "deu"]`), then activate it. The gateway logs `OCR is on: tesseract with eng+deu`, or the warning above when
a language's data is missing. Activating the changed list makes the gateway ask tesseract again, so data installed
before this step is seen without a restart. Files already ingested are not read again, and **Re-read Files** does
not offer them for a language change (only for a newer extractor or OCR that did not run); re-chunk the store, or
detach and attach the file, to read it with the new language.

Code: `fileSearch/extractors/ocrAvailability.ts` (the decision; `getOcrStatus()` / `getOcrLanguages()`),
`ocrLanguagesConfig` in `services/configService.ts` (validation); tests `ocrAvailability.test.ts`,
`ocrLanguagesConfig.test.ts` and the `FILE_SEARCH_TEST_BINARIES` suite `integration/extractors.test.ts`.

## File batches

Attaching files one at a time is fine by hand and painful from an SDK, so OpenAI has a batch surface — and its client helpers (`fileBatches.createAndPoll`, `fileBatches.uploadAndPoll`) are built on it. All four endpoints are part of the shared vector-store route table (`src/routes/vectorStoreRouteTable.ts`), so like every other vector-store route they are served under `/openai/v1/vector_stores`, `/openai/api/v1/vector_stores` and `/openrouter/api/v1/vector_stores`.

| Endpoint | Does |
|---|---|
| `POST /vector_stores/{id}/file_batches` | Attaches every id in `file_ids` to the store in one call, with one shared `attributes` and `chunking_strategy`; or every entry of `files: [{ file_id, attributes?, chunking_strategy? }]`, each with its own values. One of the two is required, not both; at most 2,000 entries (OpenAI's `maxItems`, `MAX_FILE_IDS_PER_BATCH`; a store create keeps 500, `MAX_FILE_IDS_PER_CREATE`), and never more than `limits.max_files_per_store` — the 400 names the cap that applied. The attaches run one after another in the request (about 3 s for 2,000 on a local Postgres). Returns the batch object. |
| `GET /vector_stores/{id}/file_batches/{batch_id}` | Retrieves it. This is what a poll loop calls. |
| `POST /vector_stores/{id}/file_batches/{batch_id}/cancel` | **Requests** cancellation — see below. Returns the same batch object. |
| `GET /vector_stores/{id}/file_batches/{batch_id}/files` | The store-level file list restricted to this batch: same `limit` / `order` / `after` / `before` / `filter` and the same page envelope. |

```jsonc
{
  "id": "vsfb_9f2c0a7b1e4d6835c07a1b92",
  "object": "vector_store.file_batch",
  "created_at": 1785000000,                 // Unix SECONDS, not milliseconds
  "vector_store_id": "vs_abc123",
  "status": "in_progress",                  // in_progress | completed | cancelled
  "file_counts": { "in_progress": 2, "completed": 4, "failed": 0, "cancelled": 0, "total": 6 }
}
```

`POST` create is a **400 `invalid_file_ids`** for missing or empty `file_ids`, a **400 `invalid_files`** for `files` and `file_ids` together or a malformed `files` (not a non-empty array, an entry without a `file_id`, a file listed twice, more entries than `file_ids` allows), a **404 `vector_store_not_found`** for a store the caller does not own, a **400 `file_not_found`** for a `file_id` they do not own (the status differs from the store case because it mirrors the single-file attach path), a **409 `file_already_attached`** for a file already in the store, and a 400 `vector_store_file_limit_exceeded` when the batch would push the store past `capabilities.file_search.limits.max_files_per_store`. A `batch_id` in another store is **404 `vector_store_file_batch_not_found`**, indistinguishable from one that never existed — every batch query is scoped by `store_id` as well as by id, because an unguessable id is not authorization. Attachment is **all-or-nothing when the cleanup succeeds**: a failure partway through takes `discardPartialBatch`, which removes the batch and every row it had already written before the original error is rethrown, so a client normally never has to reason about a half-attached batch.

**That guarantee has a condition, and it is worth knowing which way it fails.** The batch row and its N attachments are not one transaction — `attachFile` opens its own per file — and `discardPartialBatch` **never throws**: it runs inside a `catch`, and letting a cleanup failure escape would replace the error that explains what actually went wrong with a less informative one. A cleanup that itself fails is therefore *logged*, not surfaced, and leaves an **orphaned batch holding some of its files**. This is not hypothetical bookkeeping: the realistic reason a batch fails partway through is a saturated pool or an unreachable database, which is precisely when the cleanup's own `pool.connect()` also fails. `src/fileSearch/batches.ts` says so in its own words — *"A cleanup that fails leaves an orphaned batch with some members, which is bad; masking the cause is worse, so it is logged instead."* If you are looking at a batch whose `file_counts` do not match what a client says it submitted, search the logs for `Failed to roll back a partially created file batch`.

With `files`, each entry's `attributes` and `chunking_strategy` get the single-file attach's
validation and error codes, the entry named in the message (`files[1]: …`) or, for a chunking
error, in `param` (`files[0].chunking_strategy…`); the top-level `attributes` and
`chunking_strategy` are ignored, as OpenAI documents for `files`. An entry without values is stored
as a `file_ids` member without shared values is. `createBatch` takes plain ids and `BatchFile`
members alike. The NUL-byte guard checks `files[].file_id` as it checks `file_ids`.

### `status` and `file_counts` are derived on read, never stored

`vector_store_batches` holds four columns — `id`, `store_id`, `cancel_requested`, `created_at` — and nothing else. A batch is a **label** over `vector_store_files` rows, and membership is the `batch_id` column on those rows; there is no join table and no stored status. Every read recomputes both from the member rows with one aggregate query (`batchStatusAndCounts` in `src/fileSearch/batches.ts`).

That is a deliberate trade. Storing them would make the ingestion worker maintain a second source of truth on every per-file status transition, correctly, across every interleaving of concurrent ingestions, cancellations and retries — an invariant no test can demonstrate for all of them. The derivation has no such invariant to violate. The cost is one aggregate over `idx_vsf_batch` per read.

The rules, **in this order**:

| Condition | Batch status |
|---|---|
| any member file still `in_progress` | `in_progress` |
| cancellation requested, nothing running | `cancelled` |
| otherwise | `completed` |

**A failed member does not make the batch `failed`.** `BatchStatus` includes `'failed'` because OpenAI's enum does; nothing in this implementation ever returns it. A batch with three good files and one that could not be extracted is `completed`, with `file_counts.failed: 1` — a batch is a unit of work *submitted*, not a unit that succeeds or fails as a whole. If you are looking for ingestion failures, read `file_counts` (or list the batch's files with `?filter=failed`), never the status.

### Cancellation is cooperative

`POST .../cancel` sets `cancel_requested` and returns. It does not stop a file mid-ingestion, and it does not rewrite member statuses itself.

The worker checks the flag **between files** — after claiming, before extracting. A file already past that point runs to completion, because interrupting it mid-embed would leave chunks partially written and the transaction that commits them is what keeps the store consistent. On the next claim of any member of a cancelled batch, the worker marks **every** still-`in_progress` member of that batch `cancelled` in one statement and stops; files that already completed keep their status and their chunks.

So a `cancel` call **legitimately returns `in_progress`** whenever a member was being ingested at that moment, and only reports `cancelled` once nothing is running. That is not the endpoint being slow to update — it is the only honest answer, and special-casing the response to `cancelled` would be a lie with teeth (see the next section). A cancelled batch's ingestion is swept exactly once; sibling batches in the same store, and files attached outside any batch, are never touched.

### The `createAndPoll` guarantee

`createAndPoll` and `uploadAndPoll` are not server operations. They are **client-side loops over `retrieve` that stop the moment the status is not `in_progress`**, and then hand the caller back a vector store they have promised is ready to search. The gateway therefore guarantees:

> **A batch never reports a terminal status while a member file is still `in_progress`**, and `in_progress + completed + failed + cancelled === total` at every poll, not merely at the end.

If that were ever violated, the helper would return a store that is still being written — **silently**. Nothing throws, no status is `failed`, no log line fires; the caller simply searches a corpus missing the documents it just uploaded and concludes retrieval is broken. It is why the ordering of the first two derivation rules above is load-bearing rather than stylistic: cancellation requested while members are still running is `in_progress`, *not* `cancelled`.

`services/gateway/test/fileSearch/integration/batchPollContract.test.ts` pins it by polling exactly as the SDK helper does over a six-file batch, asserting both invariants on **every** observation — including with a member that fails, with cancellation latched from the start, and with two batches draining in one store at once.

## The data layer's modules

`src/fileSearch/repository.ts` is the data layer's one import path: a barrel over the modules that
hold the code (split by responsibility, behaviour-neutral, every SQL text unchanged):

| Module | Holds |
|---|---|
| `recall.ts` | `recallCandidates`: hybrid recall (vector arms and the full-text arm, fused by RRF); the ownership note in its header |
| `recallTypes.ts` | `RecallOptions`, `VectorArm`, `CandidateChunk`, the row shape, `candidateId` |
| `recallInput.ts` | recall's checks of the query text (NUL bytes), the query vectors and the vector arms |
| `recallErrors.ts` | `RecallInputError`, `driverErrorCode`, `redactDriverError` |
| `recallSql.ts` | `storeAccessPredicateSql`, `ACTIVE_GENERATION_PREDICATE_SQL`, `chunkScopeSql`, `buildArm`, the full-text queries and `orArmRankedSetSql` |
| `recallSettings.ts` | `ef_search`, the iterative-scan probe, `applyRecallSettings` |
| `recallAnn.ts` | the approximate path of a vector arm: `annCandidateArms`, `runAnnArm` |
| `storeValidation.ts` | attribute, dimension and expiry checks and their errors (`assertStoreDimension`, `StoreExpiredError`) |
| `stores.ts` | store rows: create, share, list, read; `RECOMPUTE_EXPIRES_AT_SQL` |
| `storeFiles.ts` | attach, enqueue, detach and the deletes (`deleteStoreFile`, `deleteFileDetachingEverywhere`, `deleteStoreCascade`) |
| `storeAccess.ts` | `touchStoreActivity`, `ToolRequestError`, `assertStoresAccessible` |

Import from `./repository`, never from a module directly: tests replace it (`jest.mock`) or one of
its functions (`jest.spyOn`), and only a caller that imports through it sees the replacement. That is
also why the barrel re-exports every value as a plain property (`export const x = mod.x`) and not
with `export *`, whose getters `jest.spyOn` cannot replace. The modules call each other directly, so
a replacement on the barrel never reaches a call between them, as with the single file before.

## Where to look when something is wrong

| Symptom | Look at |
|---|---|
| `400` before any output | `prepare()` in `src/pluginSupport/fileSearch/descriptor.ts` — the table above names every case |
| the tool never runs; the deployment rejects the request | the plugin hook entries under `hooks.defaults.openai.responses` / `responses-stream` are missing from the activated configuration |
| every search returns nothing | check the store is not empty *before* suspecting the query path; then check the masked/raw asymmetry above |
| `400 invalid_purpose` on upload | the `purpose` part of a `POST /v1/files` upload must be **`assistants`** or **`user_data`** — the values OpenAI's own file-search guide uploads with. It was `file_search` until 2026-08-05, which is not in OpenAI's documented enum at all and made the feature unreachable from a compliant client; `user_data` is accepted as well. The other documented values (`batch`, `fine-tune`, `vision`, `evals`) stay rejected on purpose: this endpoint is not general file storage |
| `503 file_search_unavailable` | file_search switched off, no `FILE_SEARCH_DATABASE_URL`, `embedding_dimensions` out of range, the migration never ran (see *Upgrading an existing install* below), a non-owner install that could not add the re-embedding or blob columns (the boot warning names `cli-tools/file-search-migrate.js`; see *Upgrading an existing install* below), a failed migration (the boot log has the error; the body never carries it), or `capabilities.file_search.blob_storage.backend` is `"local"` — the message says which (`fileSearch/unavailable.ts`; the migration records its cause in `unavailableCause.ts`, and `GET /status` names it as `reason`). `"local"` is refused deliberately (`getBackend` in `blobStore.ts`); this is a configuration fault, which is why it is a `503` and not a `500` |
| `503 blob_storage_unavailable` on a download or upload | the blob's own storage cannot be reached: S3 configuration or credentials missing, a stored location outside the configured prefix (the prefix changed), a failed S3 request, or bytes missing from the storage (older versions answered `500 blob_missing`), or more uploads waiting for S3 than its slots allow for 15 s. With s3 configured an upload of content that exists already answers the same as new content. The client gets no detail; the gateway log line `Blob storage is unavailable` carries the reason and the S3 op/status/code (never a key, bucket or host). See *Blob storage: database and S3* below |
| `503 file_search_busy` (type `file_search_unavailable`) | the request waited 15 s (`POOL_CONNECTION_TIMEOUT_MS` in `fileSearch/db.ts`) for one of the pool's 10 connections, or for a new one to connect (`FileSearchBusyError`, `fileSearch/dbBusy.ts`). Retry; if it persists, look for long-running work holding connections. The ingest, re-embed and blob-migration workers hand such an item back without spending an attempt, claimable again after 30 s (`BUSY_HANDBACK_SET` in `workQueue.ts`) |
| a `file_search_call` with `status: "failed"` | the `function_call_output` carries an error code: `store_not_found`, `query_too_long`, `file_search_not_prepared`, `file_search_no_owner`, `file_search_unavailable`, `store_model_unavailable` (the store's embedding model is no longer served; re-embed it) |
| no citations on a good answer | expected — see point 1 under *`file_citation` annotations* |
| `results` missing despite `include` | the token is `file_search_call.results`, named after the output item — see *The `include` gate* above |
| a batch `cancel` returned `status: "in_progress"` | expected — cancellation is cooperative and the worker checks it between files; poll until it settles. See *Cancellation is cooperative* |
| a batch is `completed` but documents are missing | read `file_counts.failed`, not `status`: a failed member never makes the batch `failed`. `GET .../file_batches/{batch_id}/files?filter=failed` names them, and each carries `last_error` |
| `createAndPoll` returned a store that is still filling up | a contract violation, not a tuning issue — `batchPollContract.test.ts` is the test that should have caught it |
| `409 store_model_unavailable` on a search | the store's `embedding_model` is no longer served upstream. Nothing falls back to another model: configure a served model and re-embed the store — see *Embedding models, generations and re-embedding* |
| a re-embed job stays `running` with no progress | the items are claimed only when no upload is waiting; check the ingest queue first, then `fs_reembed_items` for the job (`attempts`, `claimed_at`, `last_error`) |
| a store is still `outdated` right after its re-embed completed | the configured model changed while the job ran; the job's target was pinned at its start. Re-embed again |

Queries and chunk text are **user content and are never logged at info or above**, anywhere in `file_search`. Call ids, store ids and error codes are not user content and are logged freely. If you add a thrower reachable from `searchVectorStores` that interpolates a query or a chunk into its message, the descriptor's `catch` starts logging user content and must be narrowed to the code alone.

## The test suites, and what each one is for

| Suite | Pins |
|---|---|
| `test/responses-filesearch-prepare.test.ts` | the `prepare()` table above |
| `test/responses-filesearch-execute.test.ts` | the masked/raw split and the query asymmetry, at descriptor level |
| `test/filesearch-citations-wiring.test.ts` | citation offsets against the bytes the client actually receives |
| `test/filesearch-annotation-ordering.test.ts` | *when* a citation may appear in the stream: never before `output_text.done`, never on a delta, and no `output_text.annotation.added` frames — the ordering divergence documented above |
| `test/hosted-tool-both-tools.test.ts` | a turn calling `web_search` and `file_search` together: one continuation, independent caps, frame-level index/sequence shifting |
| `test/responses-filesearch-stream.test.ts` | end-to-end streaming/non-streaming parity, one `response.created` + one `response.completed`, real hits for a PII-bearing query on both transports, the include gate |
| `test/fileSearch/s3Backend.minio.test.ts` | the S3 backend against a real MinIO: SigV4 with path-style addressing, the probe and the put/get/exists/delete round trip, and that a wrong secret is refused. Skipped unless `FILE_SEARCH_TEST_S3_*` is set (see [Testing strategy](/developer/testing-strategy)) |
| `test/fileSearch/integration/batches.test.ts` | the batch data layer against real Postgres: the derivation rules, counts scoped to one batch, and the `store_id` predicate on every query |
| `test/fileSearch/integration/batchesController.test.ts` | the four endpoints' HTTP contract — statuses, error codes, the object shape, pagination |
| `test/fileSearch/integration/batchCancellation.test.ts` | that the worker actually honours `cancel_requested`, between files, without touching a sibling batch |
| `test/fileSearch/integration/batchPollContract.test.ts` | **the `createAndPoll` guarantee** — a terminal status never while a member runs, and counts summing to `total`, asserted at every poll of a six-file batch |
| `test/fileSearch/integration/fileSearchToolLive.test.ts` | the live gate — real pgvector, real embedder, real reranker. Off unless `FILE_SEARCH_LIVE_GATE` **and** `FILE_SEARCH_TEST_DSN` are set; skips loudly otherwise, and reports which retrieval mode it exercised. Set `FILE_SEARCH_LIVE_GATE=reranked` to make a degraded (RRF-only) run a failure rather than a warning. Its last test drives a **real file batch** from bytes through the real extractor and the real embedder, then searches for every member's content |

## The cockpit's route group

The admin cockpit reaches file_search through the gateway only. `/api/admin/grounding/*`
(`routes/groundingRoutes.ts`) accepts the admin service key and nothing else, and it is not
mounted in standalone mode.

For that key, `middlewares/groundingActingUser.ts` reads the acting user from
`X-Grounding-Acting-Email` and `X-Grounding-Acting-Role` and sets `req.apiKeyInfo.email`. The
OpenAI-shaped file and vector-store tables are then registered again under `/files` and `/stores`,
so the cockpit runs the same handlers under the same ownership rules as an API client.

Whether a caller is the admin service is decided from the key's e-mail and the registry in
`libs/service-auth/service-keys.ts`. `req.serviceAuth.permissions` is the stored permission list
and is empty for the service key; do not test it.

Routes of its own: `GET /status` (always 200; says why file_search is unavailable: `reason` is `disabled`,
`no_database`, `embedding_dimensions`, `schema_not_provisioned`, `schema_outdated`, `migration_failed` or `not_migrated`),
`GET /file-attachments?file_ids=` (the stores of each file), and `DELETE /files/:id?detach=true`
(detach everywhere, then delete).

Routes of its own for the Jobs screen and retries (all scoped to the acting user as owner):

| Route | Does |
|---|---|
| `GET /jobs?limit=&after=&state=` | the caller's jobs, newest first; `limit` 1–100 (default 20), `state` one of the derived states; a bad value is `400 invalid_limit` / `invalid_state` |
| `GET /jobs/:job_id` | one job, `404 not_found` for an unknown id or another owner's job |
| `POST /jobs/:job_id/cancel` | sets the batch's cancel latch for a `queued` or `running` job; any other job is answered unchanged (latching a finished batch would flip it to `cancelled`). A re-embed job goes to the re-embed engine instead; a `reembed_bulk` parent only while the acting role is `admin`, else `404`. A deadlock with the worker is `409 concurrent_modification` |
| `POST /jobs/:job_id/retry` | re-opens the job's failed files (or a failed re-embed's items); answers the job plus `retried` |
| `POST /stores/:id/files/:file_id/retry` | re-opens one failed file; answers `{job_id, job, retried}`, `job_id` null for a file outside any batch |

`GET /jobs` answers `has_more` and `last_id`. The cockpit's **My jobs** page shows 20 and pages with
**More** (`after` = the last shown id). Its quiet refresh reloads only the head (`refreshHead` in the
grounding app's `model/paging.ts`: the rows down to the deepest active job plus one page, the tail kept
behind its cursor; the whole loaded window once after a cancel or retry, and from the top when the
cursor row was deleted), backs off from 3 s to 15 s while nothing changes, and pauses while the tab is
hidden. The Administration screen's Jobs tab refreshes the same way.

The cockpit also uses the existing `POST /stores/:id/search` (Test Retrieval) and
`/stores/:id/file_batches[/…]` (Upload and Attach with several files) through the same group.

### Jobs (`fs_jobs`)

A job is the cockpit's view of a long embedding run. There are three kinds: `file_batch`, and the
re-embed kinds `reembed_store` and `reembed_bulk` (see *Embedding models, generations and
re-embedding* below, which also gives their state rules). A file batch is one
`fs_jobs` row per `vector_store_batches` row, created by `createBatch` in the same data layer, so
batches created by API clients get a job too. Batches created before the table existed are
backfilled by an idempotent `INSERT … WHERE NOT EXISTS` in the schema script, for the last 29 days
only (see the sweeper below). The data layer is `src/fileSearch/jobs.ts`; the table is created by
`schema.sql.ts` with `CREATE TABLE IF NOT EXISTS`, so it gets the runtime-role grants automatically.

Stored per job: identity (`id job_…`, `kind`, `store_id`, `batch_id`), ownership (`owner_email`,
`started_by`, `credential_id`, `auth_type`), `embedding_tokens`, `error`, and `created_at`,
`started_at`, `finished_at`. **State and counters are not stored.** They are derived on every read
from the member rows and the batch's cancel latch, exactly like a batch's status, so they cannot
drift from what the worker did. The rules for a file batch, in order:

| Condition | Job state |
|---|---|
| a member `in_progress`, cancel requested | `cancelling` |
| a member `in_progress`, none ever claimed (all `attempts = 0`) | `queued` |
| a member `in_progress` | `running` |
| cancel requested | `cancelled` |
| a member `failed` | `completed_with_errors` |
| otherwise | `completed` |

A job is therefore never terminal while a member is `in_progress`, and `done + failed + cancelled +
in_progress = total` at every read. `failed` (the job as a whole) belongs to the re-embed kinds; a
file batch never produces it.

The worker maintains the stored columns through three hooks, each run on the worker's own
transaction client: `markStartedIfNeeded` (`started_at` on the first claim of a member),
`addTokens` (the provider's `usage.totalTokens` for an embedded member, inside the transaction that
commits its chunks, so a rolled-back commit counts nothing), and `settleFinishedIfTerminal`
(`finished_at` once no member is `in_progress`; it locks the job row first so two members finishing
together cannot both miss the transition). Attaching a member to a batch clears `finished_at` again
in the same transaction. Lock order everywhere: `vector_stores`, then `vector_store_files` (several
rows in `file_id` order), then `fs_jobs`.

**Retry** (`retryJob`, `retryFile`) re-opens `failed` members — `status = 'in_progress'`,
`attempts = 0`, `last_error` and the lease cleared — clears the job's `finished_at`, and sends
ingest hints after commit. It locks the owner's store first and refuses with:

| Code | Status | When |
|---|---|---|
| `not_found` | 404 | no such job, store or file for this owner |
| `job_running` | 409 | a member of the batch is still `in_progress` |
| `store_expired` | 409 | the store has expired |
| `nothing_to_retry` | 409 | no failed file, or the batch was cancelled (a cancel is the user's decision; cancelled files are never re-opened) |

A deadlock with the worker over the same rows is answered `503 retry_conflict` ("try again").

**History.** `src/fileSearch/jobSweeper.ts` runs every 6 hours (started and stopped in
`src/index.ts` next to the expiry sweeper). It first finishes orphaned jobs — no member
`in_progress` but `finished_at` still NULL, which happens when the expiry sweeper or a detach
removes members mid-ingestion; jobs younger than 5 minutes are left alone because `createBatch`
commits the job before its first member — and then deletes job rows finished more than 30 days ago.
Only the job row goes; the batch and its files belong to the store. The backfill's 29-day window is
what keeps a swept job from being recreated on the next boot.

Tests: `test/fileSearch/integration/jobs.test.ts` (derivation, hooks, retry rules and locking),
`jobSweeper.test.ts`, the worker hooks in `ingestWorker.test.ts`, and the route contract in
`test/fileSearch/groundingController.test.ts` and `test/grounding-route-auth.test.ts`.

### Administration and sharing

The cockpit's **Administration** screen and shared stores add routes in front of the tables
(`controllers/groundingAdminController.ts`, data layer `src/fileSearch/admin.ts` and
`stores.ts`):

| Route | Does |
|---|---|
| `GET /storage` | the acting user's `{owner_email, file_count, logical_bytes}` (the Files screen header) |
| `GET /stores?limit=&after=` | the caller's stores **and every shared store**, newest first; each carries `is_shared`, `owned` and `owner_email`. `order=asc` and `before` are `400 unsupported_parameter` |
| `GET /stores/:id` | one store under the same visibility; `404 vector_store_not_found` otherwise |
| `GET /admin/overview` | stores, files, `logical_bytes`, `physical_bytes`, `savings_bytes`, `failed_ingestions`, `outdated_stores` (expired stores are not counted: the bulk re-embed skips them) |
| `GET /admin/stores?owner=&status=&shared=&embedding_state=` | every user's stores; `status` is `in_progress`, `completed` or `expired`, `shared` is `true` or `false`, `embedding_state` is `current`, `outdated` or `dimension_mismatch` (against the configured model, by `embeddingState`'s rule, in SQL) |
| `GET /admin/files?owner=` | every user's files with `owner_email` and `attachment_count` |
| `GET /admin/failed?owner=&batch_id=` | attachments with `status = 'failed'`; `id` is `<store_id>/<file_id>`, `last_error` only `{message, name}`; `batch_id` narrows to one file batch (the job page of another owner's batch) |
| `GET /admin/storage` | files and logical bytes per owner, paged on the owner e-mail (`first_id`/`last_id` are e-mails) |
| `GET /admin/jobs?owner=&state=` | every user's jobs with `owner_email` |
| `GET /admin/jobs/:job_id` | one job of any owner with `owner_email`; the cockpit's job page falls back to it (and to the admin failure, cancel and retry routes) when an admin opens another owner's job |
| `DELETE /admin/stores/:id` | deletes anyone's store |
| `DELETE /admin/files/:id` | deletes anyone's file, detaching it everywhere first |
| `POST /admin/stores/:id/files/:file_id/retry` | retries anyone's failed attachment |
| `POST /admin/stores/:id/share`, `/unshare` | shares an admin's **own** store with all users, or stops sharing it |

Admin lists take `limit` 1–100 (default 20, else `400 invalid_limit`) and `after` = the previous
page's `last_id`; a bad filter is `400 invalid_status` / `invalid_shared` / `invalid_state` /
`invalid_embedding_state` / `invalid_parameter`. All read the query through `queryString()`.

**The role guard.** `middlewares/groundingAdmin.ts` is mounted on `/admin` before any admin route,
so an unknown `/admin/*` path is refused too. It passes only when all three hold: the caller is the
`ADMIN_TO_GATEWAY` service key (re-checked from the key's e-mail, not trusted from
`groundingActingUser`), that key's registry entry lists `grounding:admin`, and the acting role is
`admin`. Anything else is `403 grounding_admin_required`, before a handler runs. The admin layer
sends `admin` only for a session where `user.is('admin')`; an ordinary API key that forges the role
header is refused with `403` by `groundingActingUser`, before the guard.

**What each role sees.**

| | Owner | Other user, store shared | Other user, store not shared | Admin (`/admin/*`) |
|---|---|---|---|---|
| Store in `GET /stores`, metadata | yes | yes, `owned: false` | no | every store |
| Search (`/stores/:id/search`, `file_search`) | yes | yes | no | as an owner, own and shared stores |
| Store file list, attach, detach, rename, expiry, delete | yes | `404` | `404` | delete only |
| File list, download | own files | no | no | file metadata of everyone, no download |
| Retry a failed attachment | yes | `404` | `404` | yes |
| Chunk text, extracted text, file bytes | through search only | through search only | no | never |

Search results name the source file of each passage, also for a store shared by someone else: the
passage itself is returned, so hiding the file name would protect nothing. The **list** of a shared
store's files stays with the owner and admins (every store-file route is owner-only).

**Share semantics.** `setStoreShared` is one `UPDATE … WHERE id = $1 AND owner_email = $2`: only
the owner can share, sharing is with all users, and a non-owner or unknown id is `404`. Listing,
reading and searching use the same predicate (`owner_email = $2 OR is_shared`), so a listed store is
a searchable one and an unshare takes effect on the next request.

**Admin mutations resolve the owner first.** `ownerOfStore`/`ownerOfFile` read the owner, then the
handler calls the owner-scoped repository function with it (`deleteStoreCascade`,
`deleteFileDetachingEverywhere`, `jobs.retryFile`) and answers like the owner's route — same SQL,
same lock order (`vector_stores` → `vector_store_files` → `fs_jobs`), same blob release and the same
`409 concurrent_modification`, `409 job_running` and `503 retry_conflict`. This is safe because
`owner_email` never changes after creation. File-batch jobs of other users are read-only to an
admin: the job routes keep their owner gate. Re-embed jobs are the exception, through their own
admin routes (below).

**Indexes.** The all-owner keyset lists have their own indexes, created by `schema.sql.ts` with
`CREATE INDEX IF NOT EXISTS`: `idx_vector_stores_created (created_at, id)`,
`idx_fs_files_created (created_at, id)`, `idx_vsf_file (file_id)` (attachment counts) and the partial
`idx_vsf_failed (created_at, store_id, file_id) WHERE status = 'failed'`. The overview counts never
read `vector_store_chunks`; storage per owner is a sequential scan with a hash aggregate.
`test/fileSearch/integration/groundingAdmin.test.ts` asserts the plans with EXPLAIN.

Tests: `groundingAdmin.test.ts` (data layer), `groundingAdminRoutes.test.ts` (non-owner `404`s on a
shared store, admin delete and retry of another user's data), `groundingAdminController.test.ts`
and `test/grounding-admin-guard.test.ts`, `test/grounding-route-auth.test.ts` (the guard on every
admin route).

On the admin side, `src/srv/grounding-rest-api.ts` serves `/api/grounding/*`. It takes the user
from the cockpit session, forwards with `src/services/groundingGatewayClient.ts`, and streams
uploads without buffering them. Its route table is explicit: add a row there when a screen needs a
new gateway route.

## Embedding models, generations and re-embedding

`capabilities.file_search.embedding_model` and `embedding_dimensions` can change after stores exist.
Re-embedding makes that safe: every store keeps its own model, and an outdated store is re-embedded **in place** —
same store id, the old vectors answering until the new ones are complete.

### One model per store

`vector_stores.embedding_model` / `embedding_dim` are pinned at creation and are the only model a
store is ever embedded or searched with:

- **Search** (`search.ts`) groups the requested stores by `embedding_model`, embeds the query once
  per model, and runs one vector arm per model; the arms and the lexical arm are fused by the
  existing RRF. Each arm is scoped to its own stores and carries `vs.embedding_model = <arm model>`,
  so a switch committed between the query embedding and the recall can never compare an old-model
  query with new-model vectors.
- **Ingestion** embeds a new file with its store's model, also when the configured model has changed
 : an outdated store stays single-model until it is re-embedded.
- **The embedder** (`embedder.ts`) takes `{model, dimensions}` per call, sends `dimensions` as the
  orchestration `params.dimensions`, checks every returned vector's length against it, and splits
  inputs into requests of `EMBED_BATCH_SIZE` (256), so a large file no longer depends on one 30 s
  request.

`embeddingState(store, config)` (`embeddingState.ts`) is the one rule everything shares:
`dimension_mismatch` when `embedding_dim` differs from the configured dimension (it wins: a re-embed
cannot change a store's width), else `outdated` when the model differs, else `current`. A
`dimension_mismatch` store keeps the old behaviour — `409 embedding_dimension_mismatch` on search
and attach — and needs an operator migration; the cockpit offers no action for it.

Grounding store objects (`/api/admin/grounding/stores…`, never the OpenAI-shaped ones) carry
`embedding_model`, `embedding_dim`, `active_generation`, `embedding_state` and `reembed_job_id` (the
running re-embed job, `null` when none runs — and always `null` on another owner's shared store). Admin store rows carry the same fields with the job id.

**A model that is no longer served** is not papered over. The embedder recognises
the provider's `400 … Model name '<model>' is not supported` — that message only; any other failure
is rethrown as before — and raises `EmbeddingModelUnavailableError`. Search answers
`409 store_model_unavailable` naming the store ids and the model, the `file_search` tool fails the
call with the same code, and ingestion fails the file permanently with that error's name. At the
switch of a later re-embed, files whose `last_error` carries it are re-queued (`in_progress`,
`attempts = 0`) so they ingest with the new model.

### Generations

`vector_store_chunks` has a `generation int NOT NULL DEFAULT 0` column in its primary key
`(store_id, file_id, generation, ord)`, and `vector_stores.active_generation` names the one readers
see. The content endpoint filters `c.generation = vs.active_generation`
(`ACTIVE_GENERATION_PREDICATE_SQL` in `recallSql.ts`); recall states the same rule as a
`store:generation` key match inside its chunk scan (`ACTIVE_GENERATION_KEY_SQL`); `commitChunks(…, generation)` deletes and
inserts only its own generation; deleting a file or a store removes every generation.

A re-embed copies the active generation's stored chunk text (`ord`, `text`, `tokens`) into
generation `active + 1` with vectors from the target model. No blob is read and no
extractor runs, so chunking stays as ingested and the estimate is exactly what gets embedded.

### Jobs and work items

A re-embed is an `fs_jobs` row of kind `reembed_store` with the target pinned at its start
(`target_model`, `target_dim`, `target_generation`) and one `fs_reembed_items` row per
completed file `(job_id, store_id, file_id, status, attempts, claimed_at, last_error, tokens)`. A
configuration change during the job therefore leaves the store outdated again after the switch,
never mixed. The partial unique index `idx_fs_jobs_reembed_running` allows one unfinished
`reembed_store` per store; a concurrent start that loses the race is answered `reembed_running`.

**Start** (`startReembed`, `reembed.ts`) runs in one transaction under the lock order — the store
`FOR UPDATE`, its completed files `FOR SHARE` in `file_id` order, then the job and its items — and
refuses, writing nothing: another dimension (`store_dimension_mismatch`), an expired store, a
running re-embed, and a store that is already `current` (`store_current`: the same model
over the same text gives the same vectors). It deletes any non-active generation the store still
holds (a failed, never-cancelled earlier job, which this one supersedes). A store without files
switches at once.

**The claim.** The ingest worker's loops (`ingestion.concurrency`, default 4) call
`claimNextReembedItem` only when `claimNext` found no upload (`runLoop`), so uploads keep priority.
The claim uses the same `WITH picked AS (… LIMIT 1 FOR UPDATE SKIP LOCKED) UPDATE … FROM picked`
shape as `claimNext` (one claim, exactly one row), the 15-minute lease (`LEASE_MINUTES`) and the
retry budget `ingestion.maxRetries`; items whose budget ran out while their lease expired are reaped
`failed`, like ingestion's zombies. Priority is not pre-emption: a loop that has just claimed an
item finishes it, so **a new upload can wait up to one item's embedding time** when every loop is
busy with re-embed items.

**An item** (`processReembedItem`, `reembedWorker.ts`) reads its file's chunk text of the active
generation, embeds it with the target model in sub-batches and commits it into the target
generation (job row locked before the item, store `FOR SHARE`). A permanent failure (the target
model is not served) or a spent budget marks the item `failed` with a sanitised `last_error`;
anything else re-opens it at once. The last item finalizes the job.

**Dual-write.** A file attached while its store re-embeds is ingested by the normal worker, and
`commitChunks` reads the running job **under the store lock**: it writes the active generation with
the store's model and the target generation with the job's model, and records the file's item
completed. When the store moved on between the embedding and the commit (a re-embed started or
switched), the commit answers `stale` and `processOne` embeds the missing model and commits again,
at most `MAX_STALE_COMMITS` (3) times. Every embed call of one ingestion shares one deadline,
`PROCESS_BUDGET_MS` (12 minutes, below the lease), so a file still being embedded is never claimed
twice. A detach or file delete removes the item with the file.

**The switch** (`finalizeJob`) is one transaction under the lock order (store `FOR UPDATE`, files,
job):

| Found | Outcome |
|---|---|
| the store expired | open items cancelled, the target generation deleted, the job `failed` |
| an item still open | nothing — the worker is not done |
| an item failed | the job `failed`, the store untouched, the target generation **kept** for Retry |
| a completed file without a completed item, or with another chunk count in the target generation than in the active one | that item (re)opened; the switch waits — never a switch that loses a file |
| otherwise | **the switch**: `active_generation`, `embedding_model`, `embedding_dim` become the target, the old generation is deleted, files that failed for an unserved model are re-queued, the job `completed` |

Search reads the generation and the model in one recall snapshot, so a concurrent search sees the
store entirely before or entirely after the switch.

**Cancel** (`cancelReembed`) of a store job cancels its open items, deletes its target generation and
finishes the job as cancelled, under the store lock; the store keeps its active generation
throughout. A failed job can be cancelled too, to discard its generation — unless it is
**superseded** (another re-embed of the store started after it, or its target is no longer
`active + 1`): a newer start reuses the number `active + 1`, so that generation may belong to the
successor, and only the cancel latch is set. A job that switched, or one already cancelled, is left
as it is.

**Retry** (`retryReembed`) re-opens the failed items of a failed store job and un-finishes it (and
its bulk parent). It refuses `job_running`, `store_expired`, and `nothing_to_retry` — not failed,
cancelled, or superseded. The target stays the one pinned at the start: retrying a job whose target
model is not served fails again; start a new re-embed after fixing the configuration.

**Bulk** (`startBulkReembed`). A `reembed_bulk` parent is owned by the starting admin
(`owner_email` = the admin, `store_id` NULL — it shows only in that admin's Jobs and in
`/admin/jobs`) with one `reembed_store` child per outdated store, owned by the store's owner and
`started_by` the admin. The parent and all children are created in **one** transaction, the stores
locked in id order, so a child finishing early cannot finish the parent while siblings are still
being created. That transaction holds every included store's lock until it commits — about a
second per few hundred stores — so ingestion commits and searches on those stores wait briefly
while a large bulk starts. Dimension-mismatch, expired and already-running stores are skipped and
reported; a store that changed between the estimate and its own start is skipped with its
refusal's reason (the start's answer lists it, and the cockpit shows it).
Cancelling the parent latches it and cancels every child that is still running or failed; retrying
it retries every failed child.

State is derived per kind (`jobs.ts`), never stored:

| Kind | Condition, in order | State |
|---|---|---|
| `reembed_store` | cancel requested, not finished | `cancelling` |
| | cancel requested | `cancelled` |
| | not finished, an item open, none ever claimed | `queued` |
| | not finished | `running` |
| | `error` set | `failed` |
| | otherwise | `completed` |
| `reembed_bulk` | a child unfinished, cancel requested | `cancelling` |
| | a child unfinished, none started | `queued` |
| | a child unfinished | `running` |
| | cancel requested | `cancelled` |
| | a child failed and one completed | `completed_with_errors` |
| | a child failed | `failed` |
| | only cancelled children | `cancelled` |
| | otherwise | `completed` |

A store job's counters are its items; a bulk parent's are its children, and its
`embedding_tokens` is their sum. A failed job's `error.message` is the gateway's sanitised English
diagnostic ("1 file(s) could not be re-embedded; the store still answers with its previous model.").
The cockpit shows it as sent, as it does a batch's error.

**Sweeping.** `settleIdleReembedJobs` (run by the idle worker loops and by the job sweeper's orphan
settling) finishes what nothing else will: a store job with no open item left (its last item was
detached, or the process died between an item and the switch) and a bulk parent whose children are
all finished. After the 30-day job sweep, `dropOrphanedGenerations` (`jobSweeper.ts`) deletes chunk
generations that are not the store's active one and that no non-cancelled re-embed job targets, in
transactions of at most 5,000 rows; each takes the store's lock and only then re-checks the
generation in a second statement, whose fresh snapshot sees a job that started meanwhile. A failed job protects its generation for Retry until the sweep
deletes the job, so a failed re-embed's chunks occupy space for up to 30 days. The
orphan lookup no longer scans `vector_store_chunks`: it walks each store's generations by index
(`ORPHANED_GENERATIONS_SQL`, a recursive skip scan of one `min(generation)` probe per distinct
generation on `idx_chunks_store_gen (store_id, generation)`), so a store holding only its active
generation costs two probes whatever its size, and a protected generation is stepped over rather
than hiding a stale one behind it. The index is part of the boot schema (`schema.sql.ts`), not the
migrate CLI, and `db.ts` does not require it: a non-owner install without it stays available and
the sweep is correct, only slower. Its one-time build on an upgrade takes a SHARE lock until the
schema transaction commits, so writes to the chunks wait and reads (search) do not. The build
measured about 0.6 s per 1M chunks, with a warm cache and 3-dimensional vectors; at 1536 dimensions
or on a cold cache it is unmeasured. The re-embed `DELETE`s by `(store_id, generation)` use the same
index (EXPLAIN-tested in `integration/orphanSweepIndex.test.ts`).

### Recall settings: `ef_search` and `iterative_scan`

pgvector's HNSW scan returns at most `hnsw.ef_search` neighbours (default 40) **before** the store,
owner, generation and attribute predicates filter them, and the index is shared by every store. If
a plan ever used the index, a recall asking for `hybrid.candidates` (50) could come back short. So
recall runs in a transaction with `SET LOCAL jit = off`, sent on its own first (JIT compilation
costs more than these statements run for, and `jit` is a core setting on every supported Postgres,
so it needs no savepoint), and then, in one savepoint batch, `SET LOCAL hnsw.ef_search =
clamp(candidates x 2, 100, 1000)` and, on pgvector 0.8 or later (the installed version is probed
once and cached), `SET LOCAL hnsw.iterative_scan = 'strict_order'` (strict keeps exact
distance order for `ROW_NUMBER` and `LIMIT`). A server that rejects the hnsw settings as
unsupported (`42704`, `22023`) is remembered and they are not tried again in that process, and any
other failure skips them for that call only. A setting never fails a search, and a rejected hnsw
batch cannot switch `jit = off` off.

> **The HNSW index is not used, and recall is exact.** What kept recall off the index
> was not the tiebreaker alone but the joins and the `ROW_NUMBER()` window over every candidate
> row: each arm sorted all chunks of the searched stores together with their joined rows, in an
> external merge on disk. Each arm is now a chunks-only bounded top-N: an inner query over
> `vector_store_chunks` alone (store, generation, owner and model predicates, an `EXISTS` on
> `vector_store_files`, and for the lexical arm `tsv @@ q`) ending in
> `ORDER BY <score>, store_id, file_id, ord LIMIT n`, with the rank window and the joins to
> `vector_store_files` and `fs_files` outside it, over at most `n` rows. The result is exact, not
> approximate, because the inner `ORDER BY` carries the tiebreaker, which the HNSW index cannot
> supply: Postgres sorts the matching chunks (top-N heapsort) instead of using the index. That is
> verified on pg16 / pgvector 0.8.x; newer Postgres majors are untested, and one that can put an
> incremental sort on an ordering-operator scan could make recall approximate. The EXPLAIN tests
> in `integration/recallShape.test.ts` guard this (one Sort below each Limit, no window below it,
> no `idx_chunks_hnsw` below it, also with seqscan, bitmapscan and sort discouraged, no external
> sort, no JIT node); check them when the Postgres major is bumped. An oracle in the same file runs
> the previous statement against the new one over 160 random and 7 hand-picked cases and requires
> identical rows per arm and identical fused output.

Measured on pg16.15 / pgvector 0.8.6, 64 dimensions, one store of 50,000 chunks among 70,000,
warm cache, limit 50 (p50, before to after): vector only 49 to 32 ms; hybrid with a common word 79
to 48 ms; vector with a filter 13 to 8 ms; hybrid common word with a filter 38 to 16 ms. What is
left is the linear scan of the store's chunks (about 21 to 24 ms per arm); the cost still grows
with store size.

**Few stores in the table.** Each arm resolves the readable store ids inside the statement
(`c.store_id = ANY(ARRAY(SELECT vs.id …))`); the planner cannot see that array and estimates it from
the column's distinct count. With few stores (a single-tenant install) that estimate is "a large
share of the table", and the plan scanned every chunk even for a small store. Every arm therefore
starts with `c.store_id = ANY($1)` (a vector arm of several: its own ids), a bound value the planner
reads the store statistics for (`recallSql.ts` `chunkScopeSql`). It is implied by the sub-select,
so no row changes; `integration/recallStoreScope.test.ts` EXPLAINs it (a store index under every
arm, and the statement without the line scanning the table) and compares the rows with and without
it, and the `recallShape` oracle stays green unchanged. Scale bench shape, 384 dimensions, stores of
2k/10k/20k/50k/1M chunks and no other stores (pg16.15, warm cache, limit 50), p50 before to after:
2k 225 to 9 ms, 10k 203 to 38 ms, 20k 214 to 76 ms, 50k 238 to 133 ms (a parallel scan of the table
before, `idx_chunks_store` after); the 1M store keeps its parallel scan (1.46 / 1.56 s, noise).
Identical rows for every query.

### Approximate search (`file_search.ann`)

Off by default (`annPath.ts`, `recallAnn.ts` `annCandidateArms` / `runAnnArm`). With `enabled`,
each vector arm (one per embedding model) decides on its own; it stays exact unless all of these
hold: pgvector ≥ 0.8 (the iterative-scan probe), `idx_chunks_hnsw` valid and the halfvec kind at the
column width (read from the catalog, trusted for 60 s, forgotten after any failure), no attribute
filter, and its searched active chunks (counted with `LIMIT max(exact_max_chunks + 1,
ceil(min_fraction × reltuples))`) above `exact_max_chunks` and at least `min_fraction` of
`pg_class.reltuples` (unknown, i.e. never analyzed: exact). The table size and each arm's count are remembered
for a minute (the full-text bound's caches, `lexicalBound.ts`; counts keyed by cap, owner, model and store set),
so a store shared or grown within that minute is searched exactly until then. The checks run in a savepoint; a
failure leaves every arm exact and is not remembered.

An approximate arm is its own statement, the recall probe's B2 shape: the inner query orders by
`embedding::halfvec(N) <=> $q::halfvec(N)` alone and keeps `limit` rows, its score is the
full-precision `embedding <=> $q::vector`, and the arm's `ROW_NUMBER` re-sorts by that score and the
tiebreaker. It runs with `enable_sort`, `enable_seqscan`, `enable_bitmapscan` off,
`hnsw.ef_search = clamp(4 × limit, 200, 1000)` and `hnsw.iterative_scan = relaxed_order`, set inside a
savepoint that is rolled back after it, so no other statement sees them. If it returns fewer than
`limit` rows, or fails, the arm runs exactly in the main statement; otherwise its CTE there gets a
constant-false predicate (`AND false`), so the parameters stay numbered as before. With `enabled`
the recall transaction is REPEATABLE READ, so its statements share one snapshot. Off, recall sends
exactly what it sent before (no catalog read, no count, a plain `BEGIN`). Tests:
`annPath.test.ts` (thresholds, cap, TTL) and `integration/annRecall.test.ts` (EXPLAIN on the index,
recall on the scale bench's clustered data, the short-set re-run, filtered/small/fraction/
re-embed/multi-model/old-kind/missing/invalid index/pgvector 0.7 stay exact).

The index can return a full but wrong set (scale bench: 1 of 20 clustered queries per store near zero
recall at ef_construction 200), which the re-run does not catch; that is why it ships off and why an operator
runs the recall probe on their own data first.

**Where the defaults come from** (scale bench `scripts/file-search-scale.ts`, Colima 4 vCPU / 8 GiB, pg16.15,
pgvector 0.8.6, clustered vectors, 20 in-distribution queries per store, limit 50; raw numbers in the bench's JSON
output):

| store (1536 d, 308k chunks with 200 tenant stores) | exact p50 / p95 ms | ANN halfvec ef200 p50 / p95 ms | ANN recall mean (min) |
|---|---|---|---|
| 1k | 6 / 7 | 296 / 981 | 0.57 (0.46) |
| 5k | 25 / 27 | 182 / 235 | 0.96 |
| 10k | 57 / 91 | 75 / 116 | 0.99 |
| 20k | 173 / 179 | 36 / 43 | 0.95 (0.00) |
| 50k | 456 / 491 | 35 / 40 | 0.99 (0.96) |
| 200k | 2943 / 4718 | 33 / 43 | 0.97 (0.92) |

- `exact_max_chunks` 20,000: the index does not beat the exact path below about 10,000 chunks and wins 5x at
  20,000, 13x at 50,000 and 90x at 200,000. At 384 dimensions the exact path is about 4x cheaper per chunk
  (38 ms at 20,000 in a 1.1M table), so ANN pays only for larger stores there; the fraction rule covers that.
- `min_fraction` 0.05 (not 0.02): with the store post-filter the index is slower than exact below about 5 % of
  the table (308k at 1536 d: 182 vs 25 ms at 1.6 %, 75 vs 57 at 3.3 %, 36 vs 173 at 6.5 %; 1.1M at 384 d: 313 vs
  38 ms at 1.85 %, 154 vs 88 at 4.6 %), and below 1 % recall drops to 0.48–0.73; at 0.18 % ANN returned too few
  rows for 27 of 40 queries (re-run exactly).
- halfvec vs vector at ef_construction 200: no measurable recall difference (stores of 5k or more: 0.952 vs
  0.935 in-distribution, 0.615 vs 0.625 off-topic, within build-to-build variation), half the index size (1125
  vs 2250 MiB at 288k × 1536), a 16 % faster build (443 vs 526 s), faster answers (23–26 vs 39–46 ms p50 at 20k
  and more) and half the insert cost (11.3 vs 23.4 s per 1,000 chunks in 100-row statements at 288k).
- ef_construction 200 vs the previous 64 (halfvec, stores of 5k or more): recall 0.80 to 0.95; ef 64 fell to
  0.57 on the 200k store. The build costs 1.9x (443 vs 231 s serial).
- Random (structureless) 1536-d vectors: recall 0.04–0.19 (every point almost equidistant) — a worst case
  real embeddings do not reach, but the reason the probe on real data is the gate.
- Insert cost with the index, default `shared_buffers`: on a small install (21k chunks) the new index costs
  about 1.8x the previous one per insert (6.4 vs 3.6 s per 1,000 chunks), at 288k half of it (11.3 vs 25 s).

The bench's other tables (lexical arm, insert cost, 384-d 1M loads) are in `ci/file-search-eval/README.md`
*Scale bench* (how to run it) and the sections below.

### Measuring approximate search on your data

`cli-tools/file-search-recall-probe.js` (in a checkout, after `pnpm install`) compares the exact path with the
approximate one on a real database. It takes stored chunk embeddings as query vectors (no text, no embedding
call), runs both shapes per query in a READ ONLY transaction that is rolled back (the session is
`default_transaction_read_only`; nothing is written, no index is built) and reports per store: chunks, share of
the table, tie-aware recall@limit (mean, min, queries below 0.5), under-returned answers, exact and ANN p50/p95
and whether the ANN plan used `idx_chunks_hnsw`. Run it after `rebuild-index`: it reads `idx_chunks_hnsw` and,
when it is the halfvec kind, the ANN shape orders by the halfvec expression the index is built on (the header
says which; `--halfvec` forces that shape, `--no-halfvec` the full-precision one):

```bash
node cli-tools/file-search-recall-probe.js --dsn "$FILE_SEARCH_DATABASE_URL" --min-chunks 20000
node cli-tools/file-search-recall-probe.js --dsn "$FILE_SEARCH_DATABASE_URL" --min-chunks 20000 --source other
```

`--source other` takes query vectors from other stores (off-topic questions); `--attribute k=v` adds a filter
(filtered searches stay exact in the gateway, so this only shows what a filter would cost); `--queries`, `--limit`,
`--stores`, `--seed`, `--json`. Look at the minimum and the failure count, not only the mean: the risk is a
full answer that misses most of the best chunks. On the previous index kind the probe measures an index the
gateway never uses for approximate search. The DSN is never printed.

### Routes

User level, owner only (`controllers/groundingReembedController.ts`; a non-owner of a shared store
gets the same `404` as for an unknown store):

| Route | Does |
|---|---|
| `GET /stores/:id/reembed/estimate` | `{files, chunks, estimated_tokens, state}` of the active generation (`estimated_tokens` is `SUM(tokens)`, the chunker's estimate; no money in the gateway) |
| `POST /stores/:id/reembed` | starts the re-embed with the configured model; answers the job |
| `POST /jobs/:job_id/cancel`, `/retry` | as for a batch, for the owner's re-embed jobs (see *Jobs* above); a `reembed_bulk` parent answers `404` unless the acting role is `admin` (a demoted admin no longer controls the bulk runs it started) |
| `GET /jobs/:job_id/failures?limit=&after=` | the files the owner's re-embed job could not re-embed: `{id, job_id, store_id, store_name, file_id, filename, last_error: {message}, attempts}` per failed item (a `reembed_bulk` parent: its children's, each with the child's store), keyset-paged on `(job_id, file_id)` — `id` is `<job_id>/<file_id>` and `after` takes the previous page's `last_id`; `limit` 1–100 (default 20). Resolved owner-scoped like `GET /jobs/:job_id`: another owner's job, a file batch, and a bulk parent while the acting role is not `admin` all get the unknown-job `404`. Data layer `fileSearch/reembedFailures.ts`; never chunk text, and of `last_error` only the sanitised `message` |

Admin level, behind the `groundingAdmin` guard:

| Route | Does |
|---|---|
| `GET /admin/stores/:id/reembed/estimate` | the owner's estimate (as above) of **any** owner's store, the owner resolved first; the cockpit's admin confirmation shows it |
| `POST /admin/stores/:id/reembed` | resolves the owner first and runs the owner-scoped start with the admin as actor: the job is the owner's (in their Jobs), `started_by` the admin |
| `GET /admin/reembed-outdated/estimate` | `{stores, files, chunks, estimated_tokens, skipped: [{store_id, owner_email, reason}]}` over every owner; `reason` is `dimension_mismatch`, `expired` or `reembed_running` |
| `POST /admin/reembed-outdated` | starts the bulk job; answers `{job, skipped}` |
| `POST /admin/jobs/:job_id/cancel`, `/retry` | a re-embed job of **any** owner; a file batch is `404 not_found` here |
| `GET /admin/jobs/:job_id/failures?limit=&after=` | the failures (as above) of a re-embed job of **any** owner; a file batch is `404 not_found`. The cockpit's job page reads a bulk parent's failures here, since they span other owners' stores |

Every re-embed job records `credential_id`, `auth_type` and the acting e-mail like a batch does; no usage events are emitted yet. The admin layer (`src/srv/grounding-rest-api.ts`)
has a forwarding row for each route.

**Failure detail.** Both failures routes answer `{object: 'list', data, has_more, first_id, last_id}`
(`buildPage` over `limit + 1` rows). `listReembedFailures` (`fileSearch/reembedFailures.ts`) runs one
statement for both job kinds: the `failed` `fs_reembed_items` of the `reembed_store` jobs with
`id = $1 OR parent_id = $1`, so a store job lists its own items and a bulk parent its children's,
grouped by child (the keyset is the primary key `(job_id, file_id)`, ascending). A file batch has no
items and is refused before the query. `store_name` and `filename` come from LEFT JOINs and are
`null` for a store or file deleted since; `last_error` carries only `last_error->>'message'`, never
the error's name, stack or any chunk text. `limit` outside 1–100 answers `400 invalid_limit`; a
malformed `after` (not `<job_id>/<file_id>`, too long, or holding a NUL byte) answers
`400 invalid_parameter`. Both are read with `queryString()`, so a bracketed parameter
(`?limit[a]=1`) counts as absent. The owner route resolves the job with the same owner predicate as
`GET /jobs/:job_id`, `cancel` and `retry`, so its `404` is byte-equal to the unknown-job answer;
a bulk parent there also needs the acting role `admin` (R10). Tests: the integration suites
`reembedRoutes` and `groundingAdminRoutes` (owner and admin reads, paging, the privacy checks) and
`groundingReembedController` (handler branches).

The cockpit's job page (`grounding-app` `JobDetail`) shows the table for re-embed jobs, 50 rows
a page with **More**. A store job reads the owner route; a bulk parent reads the admin route and adds
a Store column, and a demoted administrator gets the guard's `403` as an error. While the job is
polled (every 3 s) the first page reloads only when the job's failed count changes, so pages already
shown stay. The load carries the job id it started for, so a job switch mid-load never reads the
newly opened job's failures under the old job; a polling reload that fails retries silently instead of
repeating its error; and a **More** answer arriving after the first page reloaded is dropped.
Mapper: `model/jobs.ts` `toReembedFailureRows`; controller tests: `test/jobDetailFailures.test.ts`.

Error codes added by re-embedding:

| Code | Status | When |
|---|---|---|
| `store_current` | 409 | start on a store that already uses the configured model |
| `store_dimension_mismatch` | 409 | start on a store of another dimension |
| `store_expired` | 409 | start or retry on an expired store |
| `reembed_running` | 409 | start while a re-embed of the store runs (also the lost race on the unique index) |
| `nothing_to_reembed` | 409 | bulk start with no qualifying store; no job is created |
| `store_model_unavailable` | 409 | search (REST and tool) on a store whose model is no longer served |
| `invalid_embedding_state` | 400 | `GET /admin/stores` with an unknown `embedding_state` |
| `invalid_limit`, `invalid_parameter` | 400 | a failures route with `limit` outside 1–100, or a malformed `after` cursor |
| `job_running`, `nothing_to_retry` | 409 | retry of a running job, or of a cancelled, completed or superseded one |
| `concurrent_modification` | 409 | a deadlock (`40P01`) on start, bulk start or cancel — and now on a file batch's `POST /jobs/:job_id/cancel` too |
| `retry_conflict` | 503 | a deadlock on retry (the existing retry mapping) |

### Upgrading an existing install

The schema script (`schema.sql.ts`) brings a phase-3 database to the new shape idempotently, on
every boot of every replica: `ADD COLUMN IF NOT EXISTS` inside guarded `DO $$` blocks that run only
when `pg_attribute` says a column is missing (a bare `ALTER TABLE` takes `ACCESS EXCLUSIVE` even
when there is nothing to add), the new `fs_reembed_items` table and indexes, and one guarded block
that swaps the chunk primary key to `(store_id, file_id, generation, ord)` only when `generation` is
not yet part of it. Fresh installs get the new shape from `CREATE TABLE`. Existing chunks become
generation 0, which is every store's `active_generation`.

- **The PK swap locks `vector_store_chunks` once.** It holds `ACCESS EXCLUSIVE` for the swap:
  measured **24 ms at 50,000 chunks** and **1.23 s at 1,000,000 chunks** (the whole upgrade of the
  50,000-chunk database took 126 ms; a re-apply 59 ms). Searches and ingestion wait for it. A search
  that is running at exactly that moment can **fail once with a deadlock** (`40P01`; the reader is
  the victim) — the next search succeeds. On a very large install, upgrade off-peak.
- **Start re-embeds only after the rollout has finished.** A pod still running the previous
  version knows nothing of generations: it ingests into generation 0 and searches without the
  generation filter. Once a re-embed has switched a store, such a pod would write new files into a
  generation nobody reads. Wait until every replica runs this version before re-embedding.
- **Owner, single DSN** and **split credentials** (`FILE_SEARCH_MIGRATION_DATABASE_URL`, see
  [Environment variables](/reference/environment-variables)) upgrade automatically; the split path also grants the runtime role its privileges on the new
  table.
- **A non-owner single-DSN install** (the runtime role does not own the tables, no migration
  credential) cannot add the columns. A probe (`missingRequiredSchema` in `db.ts`) checks the six
  new columns, the new chunk key, `fs_reembed_items` and `idx_fs_jobs_reembed_running`; when any is
  missing, file_search reports **unavailable** (`503 file_search_unavailable`) with a boot warning
  naming the missing parts and `cli-tools/file-search-migrate.js`, instead of failing every search
  with `42703`. Run the migration step as the tables' owner (`cli-tools/file-search-migrate.js`, or
  set `FILE_SEARCH_MIGRATION_DATABASE_URL`); the next boot is available. Such an install that lacked
  `fs_jobs` used to boot with a warning; it is now unavailable for the same reason.

Tests (under `test/fileSearch/`): `integration/migrationGenerations.test.ts` (the upgrade in the
three role shapes, one probe case per required part), `integration/generations.test.ts` (recall and
content see only the active generation), `integration/reembed.test.ts` and
`integration/reembedConcurrency.test.ts` (start, items, dual-write, switch, cancel, retry, bulk, a
concurrent search seeing one generation throughout), `integration/reembedRoutes.test.ts`,
`integration/jobSweeper.test.ts` (orphaned generations), `embeddingState.test.ts`, and the route
contract in `groundingReembedController.test.ts` and `test/grounding-route-auth.test.ts`.

## The approximate-search index and `rebuild-index`

`idx_chunks_hnsw` comes in two kinds (`vectorIndex.ts`):

| Kind | Definition | Who has it |
|---|---|---|
| previous | `USING hnsw (embedding vector_cosine_ops)`, pgvector defaults m 16 / ef_construction 64 | installs migrated before the memory and scale bounds |
| new | `USING hnsw ((embedding::halfvec(N)) halfvec_cosine_ops) WITH (m = 16, ef_construction = 200)`, N = the column's width | new installs; any install after `rebuild-index` |

The new kind is half the size, indexes up to 4000 dimensions (plain `vector` stops at 2000) and had no
dead spots in the scale bench; the table keeps its full-precision vectors. halfvec holds values up to
about ±65,504: with this index in place, inserting a vector with a larger component fails (the cast
errors). Embedding models produce values in [-1, 1]. `describeVectorIndex` /
`isHalfvecVectorIndex` read the kind from `pg_get_indexdef` (the text `pg_indexes.indexdef` shows),
and `readVectorIndex` returns it with `indisvalid` and the size.

**Boot.** The schema creates the new kind in a guarded `DO` block only when no index of that name
exists **and** `vector_store_chunks` is empty, i.e. on a new install, where the build is free. On
pgvector older than 0.7 (no `halfvec`) it creates the previous kind instead, up to 2000 dimensions.
It never builds over existing chunks: that takes minutes to hours, would hold the schema transaction
and block writes. So an upgrade changes no index, and an install with chunks but no index (for
example one first migrated above 2000 dimensions) stays without one. The boot logs, at info, when
the index is the previous kind or missing over existing chunks, or when an `idx_chunks_hnsw_v2`
from a running or interrupted `rebuild-index` exists, and at warn when `idx_chunks_hnsw` is invalid,
naming `rebuild-index`. Searches are exact either way.

**`rebuild-index`** (`rebuildIndex.ts`, a subcommand of `migrateCli.ts`) is an operator command,
never part of a boot or the deploy step. It needs the role that owns the tables (the migration
credential), connects with `FILE_SEARCH_MIGRATION_DATABASE_URL` (else `FILE_SEARCH_DATABASE_URL`,
else `POSTGRES_URL`), and ignores `FILE_SEARCH_MIGRATE_NEVER_BLOCK`.

```
migrateCli.js rebuild-index [--dry-run] [--ef-construction 200] [--m 16] [--parallel]
                            [--maintenance-work-mem <MB>]
```

1. **Preflight**: pgvector version (0.7 or later, for `halfvec`), the column's width, the chunk
   count (the planner's estimate, `reltuples`; counted only for a table never analyzed: -1 on Postgres 14+, 0
   before), the current index (kind, parameters, validity, size; a note when it was built with another `m` or
   `ef_construction` than the defaults, also logged at boot), `maintenance_work_mem`, the
   estimated index size and build time, and whether a run is in progress. Free disk is not readable
   from SQL; the volume needs room for the new index while the old one still exists. The runtime
   (DML-only) role is refused here. The preflight runs with `statement_timeout` 30 s and `lock_timeout` 2 s,
   whatever the role's own settings. `--dry-run` prints this and the plan and stops; it takes no lock.
2. A session advisory lock: a second run is refused at once, naming the running backend's pid.
3. A leftover `idx_chunks_hnsw_v2` from an interrupted run is dropped (`DROP INDEX CONCURRENTLY`),
   unless it is valid and exactly the requested index, which is then reused. If `idx_chunks_hnsw`
   already is the requested index, nothing happens. From here on the session runs with
   `statement_timeout` and `lock_timeout` off.
4. `CREATE INDEX CONCURRENTLY idx_chunks_hnsw_v2`, serial (`max_parallel_maintenance_workers = 0`)
   unless `--parallel`, with `client_connection_check_interval` 10 s (a CLI that dies cancels its build instead of leaving it
   running). Ingestion and searches go on; rows written during the build are in the index when it
   completes. Progress from `pg_stat_progress_create_index` every 15 s. A failed build (or Ctrl-C /
   SIGTERM, which cancels it) drops the invalid index it leaves; `idx_chunks_hnsw` is unchanged.
5. `indisvalid` is checked, then the swap: `DROP INDEX idx_chunks_hnsw` and `ALTER INDEX
   idx_chunks_hnsw_v2 RENAME TO idx_chunks_hnsw` in **one** transaction, so a reader sees the old
   index or the new one, never neither. The `DROP` takes a brief `ACCESS EXCLUSIVE` lock on the
   chunk table. While an attempt waits for it behind a running query, new searches **and** ingestion
   writes on the chunk table queue behind the attempt, for at most its `lock_timeout` of 2 s: a
   pause, not a failure. It retries up to 15 times with a growing pause in between, so in the worst
   case vector-store traffic pauses up to 15 times for 2 s. Once the build has succeeded nothing
   drops it: if the swap never gets its lock, fails, or is interrupted (Ctrl-C, SIGTERM), the valid
   index stays as `idx_chunks_hnsw_v2` (both are maintained on every write until then) and a re-run
   swaps it in without building again.

Exit codes: 0 done, nothing to do, or dry run; 1 refused or failed; 2 usage error.

### Running it

Run `--dry-run` first; it prints the estimates below for the actual data.

- **Docker Compose**: the `gateway-migrate` service has the migration credential:
  ```bash
  docker compose -f docker/docker-compose.yml run --rm gateway-migrate \
    node services/gateway/dist/services/gateway/src/fileSearch/migrateCli.js rebuild-index --dry-run
  ```
  then the same without `--dry-run`. `docker compose run` stays attached; Ctrl-C cancels the build and
  cleans up.
- **Kyma**: the migration credential is only in the `gateway-migration-env` Secret, which the
  `gateway` container does not mount, and the build can outlast a `kubectl exec` session. Run it as a
  one-off Job from the gateway image, with a label of its own (not `app: gateway`: backups, the
  deploy tooling and an autoscaler select pods by that label) and two NetworkPolicies that let that
  label reach Postgres (the namespace admits Postgres traffic only from listed labels, and the
  namespace-wide DNS policy restricts every pod's egress). `terminationGracePeriodSeconds` leaves time
  to cancel the build and drop what it left.
  ```yaml
  apiVersion: networking.k8s.io/v1
  kind: NetworkPolicy
  metadata:
    name: allow-file-search-rebuild-to-postgres
    namespace: <namespace>
  spec:
    podSelector:
      matchLabels:
        app: postgres
    policyTypes:
    - Ingress
    ingress:
    - from:
      - podSelector:
          matchLabels:
            app: file-search-rebuild
      ports:
      - protocol: TCP
        port: 5432
  ---
  apiVersion: networking.k8s.io/v1
  kind: NetworkPolicy
  metadata:
    name: allow-file-search-rebuild-egress-to-postgres
    namespace: <namespace>
  spec:
    podSelector:
      matchLabels:
        app: file-search-rebuild
    policyTypes:
    - Egress
    egress:
    - to:
      - podSelector:
          matchLabels:
            app: postgres
      ports:
      - protocol: TCP
        port: 5432
    - to: []
      ports:
      - protocol: UDP
        port: 53
      - protocol: TCP
        port: 53
  ---
  apiVersion: batch/v1
  kind: Job
  metadata:
    name: file-search-rebuild-index
    namespace: <namespace>
  spec:
    backoffLimit: 0
    ttlSecondsAfterFinished: 3600
    template:
      metadata:
        labels:
          app: file-search-rebuild
          sidecar.istio.io/inject: "false"
      spec:
        restartPolicy: Never
        terminationGracePeriodSeconds: 300
        imagePullSecrets:
        - name: registry-secret
        containers:
        - name: rebuild-index
          image: <the gateway image the Deployment runs>
          command: ["node", "services/gateway/dist/services/gateway/src/fileSearch/migrateCli.js",
                    "rebuild-index"]
          envFrom:
          - secretRef:
              name: gateway-migration-env
          - secretRef:
              name: gateway-env
  ```
  `kubectl apply -f rebuild-index.yaml`, then `kubectl -n <namespace> logs -f
  job/file-search-rebuild-index`. Add `"--dry-run"` to `command` for the preflight (delete the Job
  before applying it again; a Job's template cannot be changed). `kubectl delete job` sends SIGTERM,
  which cancels a running build and drops it (a build that already finished is kept for the next
  run). When the Job has finished, delete the two NetworkPolicies
  (`kubectl -n <namespace> delete networkpolicy allow-file-search-rebuild-to-postgres
  allow-file-search-rebuild-egress-to-postgres`).

  **Do not back up, restore or reset the database while the Job runs**: pausing the deployments does
  not stop it, so the database is not quiet. `kyma-db-manager.js` `backup`, `restore` and `reset`
  refuse while a pod labelled `app=file-search-rebuild` has not finished.
- **npm-dist**: `sail-proxy file-search rebuild-index --dry-run`, then without `--dry-run`. It runs the
  bundled gateway's migration CLI with the database settings from the CLI's `.env` (`~/.sail-proxy/.env`):
  `FILE_SEARCH_MIGRATION_DATABASE_URL` when the runtime role does not own the tables, else
  `FILE_SEARCH_DATABASE_URL`. It needs pgvector 0.7 or later on the user's server.
- **A local checkout**: `node cli-tools/file-search-migrate.js rebuild-index` with the owner's DSN in
  `FILE_SEARCH_MIGRATION_DATABASE_URL` (or `FILE_SEARCH_DATABASE_URL`), after `pnpm build:gateway`.

### Memory, shared memory, time

- **Serial (the default)** builds the graph in the backend's own memory, up to
  `maintenance_work_mem`; past it pgvector continues on disk, several times slower. Raise it for
  the session with `--maintenance-work-mem` when the database host has the memory: the estimated
  index size is the graph's size.
- **`--parallel`** builds in dynamic shared memory sized by `maintenance_work_mem`. Docker and Kyma
  give Postgres 64 MB of `/dev/shm`; above that the build fails ("could not resize shared memory
  segment"). Raise `/dev/shm` first (compose `shm_size`, Kyma an `emptyDir` with `medium: Memory`,
  which counts against the pod's memory limit).
- **Measured** (scale bench, 4 vCPU, pg16.15, pgvector 0.8.6, clustered data, graph in memory):

  | chunks x width | serial | parallel (2 workers) | index size |
  |---|---|---|---|
  | 288k x 1536 | 443 s | 155 s | 1125 MiB |
  | 1.08M x 384 | 963 s | - | 1208 MiB |

  Data without cluster structure built 3.7x slower (1726 s at 290k x 1536). The previous kind at
  288k x 1536 was 2250 MiB.
- **Kyma at its shipped sizing** (Postgres 1Gi memory, 0.5 CPU, 20Gi volume): `maintenance_work_mem`
  can be raised only to a few hundred MB within the 1Gi limit, so graphs above that build on disk,
  and the 0.5-CPU limit makes a serial build at least twice as slow as above. The volume holds both
  indexes during the build: at 1536 dimensions the table's vectors take about 6 GB per million
  chunks (est.) and the new index about 4 GB. Low hundreds of thousands of chunks fit; for millions,
  raise the Postgres resources and volume first.

Tests: `vectorIndex.test.ts` (definition, kind detection, estimates, the boot statement),
`rebuildIndexArgs.test.ts`, `integration/rebuildIndex.test.ts` (new install, upgraded install kept at
boot, a build under concurrent writes with a second run refused, a failed and an interrupted build,
an invalid leftover, a swap that cannot get its lock, an interrupt after a successful build, 3072
dimensions, `--dry-run`, a non-owner), `kyma-db-manager-commands.test.ts` (the Job guard), and in
npm-dist `test/file-search.test.js` (the `file-search rebuild-index` subcommand).

**Upgrading to the memory and scale bounds.** What the first boot does: two nullable `context_stopped text` columns
(`vector_store_files`, `fs_reembed_items`; guarded `DO` blocks, catalog only, in `REQUIRED_COLUMNS`, so a
non-owner single-DSN install is unavailable until the migrate CLI has run as the owner, as for every earlier
column). Nothing else: no index is changed or built, no search changes with `ann` off except the full-text bound
on searches over more than `exact_max_chunks` chunks (below), and no model is called. New installs get the
halfvec index (free on an empty table). The configuration gains `file_search.ann` (`enabled: false`,
`exact_max_chunks: 20000`, `min_fraction: 0.05`); a stored configuration without it uses those defaults. On
Kyma, `deploy-kyma.js` renders the admin's `admin-api-config` ConfigMap again from the new
`services/admin/api_config.json`. The per-file chunk ceiling is a new limit; with the default chunk sizes no
file the limits accept reaches it. Run `rebuild-index` before switching on `ann`.

**Verified in the images.** The gateway image with this work (38 KB larger than the image built just
before it; `dist` +184 KB unpacked) was driven with its own compiled code against a throwaway `pgvector/pgvector:pg16-trixie`
(embeddings replaced by a hashed bag of words, no SAP): a fresh database's boot created the halfvec index;
five Markdown files ingested (475 chunks); with `ann` on and lowered thresholds the search ran its vector arm
through `idx_chunks_hnsw` (`Index Scan … Order By: ((embedding)::halfvec(1536) <=> …)`, REPEATABLE READ,
`relaxed_order`), with `ann` off it sent no index statement and a plain `BEGIN`; on a database holding the
previous index kind the boot kept it (same oid) and logged `rebuild-index`, the search stayed exact, `rebuild-index
--dry-run` printed the plan and the real run swapped in the halfvec index, after which the search used it. The
npm-dist bundle (`sail-proxy file-search rebuild-index`) printed the same plan against pgvector 0.8.6 with a
previous-kind index (exit 0) and refused on pgvector 0.6.2 (exit 1), where the boot creates the previous kind and
searches stay exact.

## Memory during ingestion

A file is held on the gateway's main thread from extraction to commit: its text, its chunks and their vectors.
The gateway bounds what one file and all files together can make the process hold.

- **Worker threads** (`heapLimit.ts` `workerHeapLimitMb`, shared by the Office reader and the structure
  chunker): old generation a fifth of `process.constrainedMemory()`, clamped to 256–384 MB (384 when no limit is
  known; Kyma's 2 GiB gives 384), young generation 32 MB, stack 4 MB. Before these bounds the chunker thread had no limit
  and V8 gave it the same ~1 GB as the main thread (measured 1048 MB heap limit in a 2 GiB container). An
  out-of-memory end of the chunker thread is a permanent `StructureChunkOutOfMemoryError` ("Chunking the file
  needs more memory than the chunker may use (N MB)") in ingestion and re-chunk items; the thread restarts for
  the next file. A thread that runs out of memory before it is ready with a file posted fails that file the same
  way.
- **Measured** (`scripts/structure-chunk-memory.ts`, dev only, not shipped: the compiled worker, 100/50
  chunks, smallest passing `maxOldGenerationSizeMb` in 16 MB steps; 64 MiB is the extractors' output cap, so the
  largest chunker input):

  | shape | text | passes at MB |
  |---|---|---|
  | Markdown (deep headings, 5,000-row tables, a 4 MiB code block) | 32 / 64 MiB | 144 / 192 |
  | same, one character outside Latin-1 (two bytes a character) | 64 MiB | 304 |
  | one "word" without whitespace | 32 / 64 MiB (two-byte 64) | 176 / 320 (384) |
  | two-line sections | 8 / 16 MiB | 144 / 272 (~17 MB per MiB; 32 MiB fails at 384) |
  | one paragraph without a line break | 8 MiB | passes at 384, but takes 306 s (4 MiB: 120 s) |

  So 384 MB reads every measured shape except more than ~22 MiB of two-line sections, which now fails
  permanently instead of taking ~1 GB; a one-paragraph text over ~16 MiB runs into the ingestion time budget
  first (pre-existing).
- **No long text on the event loop** (`structureChunkThread.ts` `IN_PROCESS_MAX_CHARS`): when the thread cannot
  start, only texts up to 2 Mi characters are chunked in-process (0.1–3.5 s per MB blocks every request, up to
  ~35 MB of main heap at the limit); a longer one fails with the transient `StructureChunkThreadUnavailableError`
  and is retried.
- **Chunk ceiling per file** (`chunkPipeline.ts` `maxChunksPerFile`): `max(floor(128 MiB / (dims × 4)),
  ceil(limits.max_tokens_per_file / 400))` — 21,845 chunks at 1536 dimensions, 12,500 at 3072 and 4000 with the
  default 5M-token limit (~146 / ~195 MiB of vectors). The second term means a file the limits let through at the
  default 800/400 setting is never refused; only small chunk sizes on very large files reach it. A constant on
  purpose (no configuration key). Checked right after chunking, in both ingestion and re-chunk items, before any
  context call or embedding; a file over it fails permanently with `FileHasTooManyChunksError` ("The file has N
  chunks, more than the M a file may have at D embedding dimensions. Choose a larger chunk size (max_tokens) or
  split the file."). Its OCR and vision pages were already read (and paid) by then. Before these bounds a 64 MiB text at
  100/50 made ~470k chunks, ~5.8 GB of vectors as JavaScript numbers.
- **float32 vectors** (`embedder.ts`): `embed(…, 'document')` returns `Float32Array`s, half of what an array
  of doubles takes and exactly what pgvector stores (`vector` is float4); `'query'` keeps SAP's numbers, so search
  input is unchanged. `integration/vectorFloat32.test.ts` proves the stored rows equal on both paths.
- **A process-wide reservation** (`memoryBudget.ts`): a budget of a quarter of `constrainedMemory()`, clamped to
  256 MiB–1 GiB (512 MiB when unknown). Right after extraction, before chunking and any context call, a claim
  reserves its text part (`3 × 2 × characters`: the UTF-16 text, its chunks, their embedding inputs) and an
  estimate of the vectors of every chunk set and model it will embed (one chunk per `max_tokens − overlap`
  tokens, within the ceiling; a re-chunk's second set included), waiting in arrival order while the budget is
  full. After chunking each set is settled: a smaller real figure is returned at once, a larger one (structure
  chunks follow sections) grows the reservation without waiting and is logged. A reservation larger than the
  whole budget proceeds when nothing else is held. A wait ends after half of the claim's remaining deadline or
  when the worker stops (`FileSearchMemoryBusyError`); the claim is then handed back without spending an
  attempt, like a busy pool, up to `MAX_MEMORY_HANDBACKS` (3) times (`last_error.memory_handbacks`, reset by a
  commit or another error; a busy-pool or stopping handback in between keeps it); after that a timed-out wait
  spends the attempt. The log line says
  "deferred: the memory budget stayed full". Every way out releases (commit, failure, stale commit, cancel,
  out of memory). Re-chunk and re-embed items reserve the same way; the plain re-embed knows its stored text
  and vectors and reserves them exactly.
- **Arithmetic, a 2 GiB gateway (Kyma), budget 512 MiB**: at 1536 dimensions a largest file (64 Mi
  characters at the 21,845-chunk ceiling) reserves 384 MiB of text part + 128 MiB of vectors = the whole budget,
  so four ingestion loops on such files run extraction to commit one at a time; at 4000 dimensions, four ~6 Mi
  character files at 100-token chunks reserve ~227 MiB each, two at a time. Typical files (1 MiB of text,
  ~600 chunks at 1536: ~10 MiB) never wait. Workers: chunker ≤ 432 MB + Office reader ≤ 432 MB heap. The main
  heap's V8 limit stays ~1 GB (no `--max-old-space-size` is set: a lower cap would only turn a peak the pod could
  hold into a crash).
- **Residuals (accepted):** a waiting file holds its extracted text (≤ 128 MiB as UTF-16) outside the
  reservation; the vector estimate may undercount by one chunk per holder (≤ 16 kB at 4000 dimensions); a
  structure file may grow by (ceiling − estimate) outside the wait (bounded, logged); a plain re-embed of a file
  stored before the ceiling has none and may reserve more than the budget (it then runs alone); an interleaved
  stop or pool-busy handback resets the handback counter. Under sustained memory pressure a file is extracted up
  to 3 + `ingestion.max_retries` times, and a PDF's OCR and vision pages are read (vision pages billed) again on
  each round.

Tests: `memoryBudget.test.ts`, `integration/memoryReservation.test.ts` (at most two holders of four, overshoot
bounded by one chunk per holder; RED with text-only admission), `chunkPipeline.test.ts` (ceiling, both
branches, no writer call), `structureChunkThread.test.ts` (OOM with the compiled worker, in-process limit, OOM
before ready), `integration/vectorFloat32.test.ts`, and the re-chunk suite (budget wait, handbacks, ceiling in
ingestion and re-chunk items).

## Usage recording

Every billed file_search call emits a usage event (`fileSearch/usage.ts`, `emitFileSearchUsage`),
fire-and-forget through the usual usage emitter. Endpoints and units:

| Endpoint | Unit | Emitted by |
|---|---|---|
| `file_search/ingest` | tokens | the ingest worker, per embedding request |
| `file_search/reembed` | tokens | the re-embed worker, per embedding request |
| `file_search/search` | tokens | a search, per query-embedding request |
| `file_search/rerank` | units | a search that reranks; the rerank's search units |
| `file_search/context` | tokens | ingestion and re-chunking of contextual chunks, per context call (with cache writes and reads) |
| `file_search/rewrite` | tokens | a search with `rewrite_query`, per completed rewrite |
| `file_search/vision` | tokens | ingestion and re-chunking of a store with a vision mode, per page call and per model check |

**One event per embedding request.** `embed()` takes an `onUsage` hook, called after each successful
request with that request's own usage, so what SAP billed is recorded even if a later request fails
or a stale commit is dropped. The inputs are split into requests of at most 256 inputs and at most
250,000 tokens, where a request's size is the sum of `estimateTokens` times 1.8 (`planRequests` in
`embedder.ts`). SAP rejects a request over 300,000 tokens, and `estimateTokens` under-counts real
chunks by about 1.8x; before this limit a dense file of roughly 270 chunks or more failed ingestion.
A single input over the budget goes in a request of its own.

**Request ids never repeat.** The admin process remembers the request ids it has persisted
(`processedRequestIds` in `usageEventProcessor.ts`, in memory and bounded) and skips a later event
with one of them; a missing or `unknown` id is never remembered. Within a batch it collapses events
with the same content signature (`computeUsageSignature`: request id, auth type, credential, model,
status, token counts, `responseTime` and `timestamp`), and the database rejects a second row with the
same `usageSignature`, the SHA-256 of that signature. So an event whose id an earlier batch already
persisted is dropped even when its tokens differ. Workers use `fs-ingest-<uuid>` and `fs-reembed-<uuid>`. A search derives its ids from the HTTP
request's id: `<id>-fs-embed-<n>` (n from 1) and `<id>-fs-rerank`; a Responses `file_search` call
uses `<id>-fs-<call>-embed-<n>` and `<id>-fs-<call>-rerank`, `<call>` being a per-request counter
shared by the three executors, so several calls in one response never share an id. Ids are capped at
100 characters by shortening the base, never the suffix.

**The credential stamp.** `vector_store_files` has three nullable columns, `credential_id`,
`auth_type` and `on_behalf_of`, written when a file is attached (`attachStamp` in
`vectorStoresController.ts`; a batch stamps every member). The ingest worker reads them to know who
pays, because it runs long after the attach call returned. The columns are added at boot by the
guarded `DO $$` block in `schema.sql.ts`, and a re-embed bills the job row's credential. A non-owner
install cannot add them: the `missingRequiredSchema` probe lists them, and file_search reports
unavailable until `cli-tools/file-search-migrate.js` (or `FILE_SEARCH_MIGRATION_DATABASE_URL`) has
run as the owner, as for the earlier columns (see Upgrading an existing install).

**Attribution.**

- A cockpit (grounding) call is billed to the admin service key with `onBehalfOf` set to the acting
  user. Searches use the acting user. Ingestion and re-embedding use the store's owner, also when an
  admin attaches or starts the job (the job still records the admin as `started_by`).
- Any other call is billed to its own credential, with no `onBehalfOf`.
- The admin books `onBehalfOf` to the row's e-mail, the per-user buckets, the tool rows and the quota
  refresh only when the key is a platform service key and the value is a well-formed e-mail
  (`rowOwnerEmail` in `usageEventProcessor.ts`). On any other key it is ignored.
- A file attached before the stamp existed (all three columns null) falls back to its batch job's
  credential, with the job's `owner_email` (the store's owner) as `onBehalfOf`, like a stamped
  attach; the admin ignores that for an OpenAI-API batch. A single attach with no stamp, or a batch from before `fs_jobs`, records nothing: a
  credential is never invented.
- A caller with an AWS credential cannot reach the OpenAI-shaped file and vector-store routes:
  they scope every row by the caller's e-mail, which a SigV4 request does not carry, so they answer
  401 (multipart uploads answer 403 before that). The Responses `file_search` tool refuses such a
  caller at `prepare()`. There is therefore no AWS-credential ingestion or search to bill.

**Cost.** An event whose endpoint starts with `file_search/` and whose model has no price in the
Model Library costs zero (total and SAP cost); every other endpoint keeps the fallback price. A
rerank row counts `units`, not tokens.

**Quotas.** The `/v1` file and vector-store routes check the caller's key like every model route
(`quotaEnforcement` in `filesRoutes.ts` and `vectorStoresRoutes.ts`, once per request). A cockpit call
carries the admin service key, not a credential of the user who pays, so `quotaEnforcement` cannot
run there; the cockpit's routes that **start** paid work check the payer instead
(`middlewares/groundingQuota.ts`):

- **Who is checked follows who pays** (the attribution above): store work (attach, file batch, file
  retry, re-embed, re-chunk, re-extract, a store create with `file_ids`, the retry of a job) against
  the store's owner; `POST /stores/:id/search` (Test Retrieval) against the searcher, also an admin
  or another user on a shared store. Every guarded route is owner-scoped by its handler, so the owner
  is the acting user wherever the owner is checked. Each guard is a `router.post(path,
  groundingQuota(payerOf))` registered ahead of its handler and the OpenAI tables; it calls `next()`
  when it admits. A store or job the actor cannot use is never looked up for quota: the handler
  answers its own 404, so nothing about another user's quota leaks.
- **The check** is the model routes' spend/token admission (`checkAdmission`, shared module-level)
  on the payer's state document (`createOwnerAdmission` → `admitOwner(req, email)`): the document's
  effective limits decide, no wire block is needed. No requests-per-minute check (no RPM limit on
  cockpit calls). It fails open like the model routes (unreadable state: admit plus a throttled
  `quota_unenforced` event; standalone: admit) and emits `quota_exceeded` with the payer as owner and
  the service key's id as credential.
- **Exempt:** every route under `/admin` (the admin maintenance routes get no guard), and a
  `reembed_bulk` or `blob_migration` job retried through `/jobs/:id/retry` (`ADMIN_JOB_KINDS`).
  Reads, estimates, cancels, edits, detaches, deletes and `POST /files` start no paid work and are
  not checked.
- **Queued and running work always finishes:** the workers never check a quota; a job is admitted
  once, at its start (an admitted job can overshoot the quota by its own cost).
- **The refusal** is the model routes' 429 body plus `code: 'quota_exceeded'` and a `message`
  (`sendQuotaExceeded`), with `Retry-After`; `limit` and `used` are sent because the payer is always
  the acting user. The cockpit maps the code to its translated `errQuotaExceeded` text
  (`model/errors.ts`).

Tests: `test/grounding-quota.test.ts` (admission, every guarded route, the payer rules, the exempt
and unchecked routes), `test/quota-middleware-wiring.test.ts` (no second check on `/v1`),
`test/fileSearch/integration/groundingQuota.test.ts` (real handlers and SQL: nothing is written on a
refusal, queued work finishes, the admin route is exempt, search follows the searcher).

Tests: `test/fileSearch/usage.test.ts`, `embedder.test.ts`, `search.test.ts`,
`integration/usageRecording.test.ts`, `integration/migrationUsageStamp.test.ts`, and on the admin
side `usage-event-processor-on-behalf-of.test.ts` and `usage-statistics-on-behalf.test.ts`.

## SAP AI Core calls: per-attempt timeouts and one retry

From some network paths SAP AI Core accepted the connection, finished TLS and then sent nothing for a
minute (2026-10-07, about half of the list calls from GitHub runners); a call without a timeout waited
until the socket died, and the startup model-list publish never finished. `src/utils/sapRequest.ts`
bounds every attempt of the calls file search depends on with a wall-clock timer that aborts the
request through an `AbortSignal` (axios's own `timeout` is only an idle timer once headers have
arrived), and retries the ones that are safe to send twice:

| Call | Per attempt | Retry |
|---|---|---|
| Deployment lists (`/v2/lm/deployments` for orchestration, Perplexity and reranker discovery; `/lm/deployments`), the foundation-model list | 10 s | once |
| OAuth token (client-credentials grant) | 10 s | once |
| Query embedding (search) | 10 s | once |
| Document embedding batch (ingestion, re-embed, re-chunk) | 30 s, as before | once |
| Chat, the context writer, vision transcription, rerank | unchanged | never |

- **When it retries:** only after a connection reset, a timeout (`ECONNRESET`, `ETIMEDOUT`,
  `ECONNABORTED`) or HTTP 502/503/504, once, after 250–1000 ms of jitter, and only when the time left
  before the caller's deadline still holds a full attempt (`deadline - now - jitter >=
  attemptTimeoutMs`); otherwise the first error is rethrown with a warning. Never after 4xx, 500 or a
  cancel. So a stalled list costs at most about 21 s instead of a minute or forever.
- **Never twice for an answer that arrived:** `postEmbeddings` reads the embeddings body as a stream;
  a failure after the response headers arrived (a body that stalls past the attempt, closes early or
  is not JSON) is marked `markResponseArrived` and never re-sent, because SAP has billed that request.
  The one case the retry can still pay twice is a request SAP processed whose answer never arrived.
- **Budgets hold:** document batches keep `embed()`'s overall deadline (10 minutes or the caller's),
  so the lease bound of a work item is unchanged.
- **Logs** at warn name the call kind and the reason (`<kind>: retrying once after a timeout`), never
  a request or response body.
- **Not changed:** the client-facing `POST /v1/embeddings` (`embeddingController` →
  `sapAIService.createEmbedding`) keeps its single attempt; a client retries on its own terms.
- **No knobs:** the timings are module constants (`DEFAULT_TIMING`; tests use
  `__setSapTimingForTests`), so there is no environment variable or configuration key.

Boot does not wait for SAP: the server listens once its configuration has arrived. The model-list
publish after a configuration event (`publishModelListAfterConfigUpdate` → `getModels`) is the one
startup step that calls SAP; with a stalled list it now fails within the list bound, is logged
("Failed to publish model list after config update") and runs again on the next configuration event.

Tests (all against `test/fakeSapServer.ts`, a scripted local server that stalls, resets, answers a
status, or sends headers and then stalls): `test/sap-request.test.ts`, `test/sap-list-timeouts.test.ts`,
`test/boot-stalled-sap-list.test.ts`, `test/fileSearch/embedderRetry.test.ts`.

## Measuring retrieval quality

`ci/file-search-eval/` holds an evaluation set: a corpus generated from this repository's own documentation
(Markdown, PDFs with a text layer, a table PDF and image-only "scanned" PDFs) plus a synthetic PowerPoint deck and
Excel workbook, and 165 questions (kinds `markdown`, `pdf`, `table`, `scanned`, `multihop`, `pptx`, `xlsx`; the
chunking measurements below used the first 145), each with the verbatim passage that answers it. `pnpm run eval:file-search` (in `services/gateway`) ingests the corpus with the
gateway's own ingestion code into a throwaway pgvector database, asks every question through `searchVectorStores`,
and reports recall@5/10/20, MRR and nDCG@10 overall and per document kind. It needs SAP credentials (`--env`) and
stops before a cost ceiling (`--max-usd`, default 5). Run it before and after any retrieval change and compare the
two result files with `--compare`; `ci/file-search-eval/README.md` has the commands and what the numbers mean.
`ci/file-search-eval/baseline.json` records the latest decision's runs, with the earlier ones under `previous`.

What the measurements showed:
- Image-only PDFs score 0 without OCR: `pdftotext` finds no text (see [Parsing configurations](#parsing-configurations)).
- The full-text arm used to require every word of a question (`plainto_tsquery`), so natural-language questions
  almost never matched it and hybrid search behaved like vector search. It now matches any of the question's words
  other than English and German stop words and single characters (`hybrid.lexical_query: "any"`, the default;
  `"all"` restores the old query). Without the reranker this raised recall@20 from 0.834 to 0.876 (every question
  whose file has text) and MRR from 0.542 to 0.587; with the reranker recall@10 moved from 0.841 to 0.834 and nDCG@10
  from 0.766 to 0.764, within noise for 145 questions, since the reranker already sees most of the small corpus. `ts_rank` stayed (`ts_rank_cd` measured worse), and the default hybrid weights
  stay 1/1 (text-heavy weights rank the first hits higher but lose some recall at 10 and 20).

The query is built inside Postgres from the bound question text: the question is parsed with the same `simple`
configuration as the stored `tsv` column, stop words (`fileSearch/stopWords.ts`) and one-character terms are
removed, each remaining lexeme is quoted and escaped, and at most the question's first 32 distinct terms are joined
with `|` into a `tsquery` (and with `&` into a second one). This runs as its own statement in the recall transaction,
so the recall statement gets both queries as constants and the planner can estimate them from the column statistics.
The full-text arm first takes the chunks that contain every term; only when fewer than `hybrid.candidates` do, it
ranks every chunk that contains any term. That last case is the expensive one, because every matching chunk is
ranked: on a synthetic store of 200,000 chunks where one term occurs in half of them, a question with that term took
about 280 ms for the whole recall (50 ms when nothing matched, 570 ms for a 32-term question). At 1,000,000 chunks
the same question took about 4.6 s and the 32-term question about 5.3 s, both bound by disk reads on the small test
database used. A question with no terms left skips the full-text arm.

**Large searches (`lexicalBound.ts`).** A search over more than `file_search.ann.exact_max_chunks` active
chunks (default 20,000; the same size the vector arm calls large, whether or not `ann` is enabled) bounds its OR
arm twice:
- the OR query leaves out the question's terms that more than 5 % of the table's chunks contain
  (`COMMON_LEXEME_SHARE`), read from `pg_stats.most_common_elems` / `most_common_elem_freqs` of `tsv` and
  `context_tsv` (a `context_tsv` frequency is scaled by `1 - null_frac`, so it counts chunks, not contexts) and
  remembered for 10 minutes (`BOUNDED_OR_QUERY_SQL`). The AND query keeps every term; when every term is common,
  none is left out. The statistics are per table, not per store or tenant: a word that is common across all
  stores together is left out of one tenant's large search even where it is rare in that tenant's own store (and a
  word common in only that store may stay in), which is why they apply only to large searches; they are as fresh as
  the last (auto)analyze, and list at most about 1,000 lexemes (statistics target 100), so a lexeme above 5 % that
  did not make the list stays in;
- the arm ranks every chunk with all the terms (fewer than the limit, or it would not run) plus at most 5,000 other
  matches (`OR_ARM_RANKED_SET_CEILING`, `recallSql.ts` `orArmRankedSetSql`): the first ones in a fixed order
  (table order, or index order when the planner uses the `(store_id, file_id)` index), the same on every run. A
  synchronized sequential scan would start where the table's previous scan stopped, and parallel workers deliver
  their rows in no fixed order, so the statement runs with `SET LOCAL synchronize_seqscans = off`, and the capped
  scan and its `vector_store_files` check each carry an always-true, parallel-restricted predicate
  (`c.ord <> -pg_backend_pid()`, `SERIAL_SCAN_SQL`; `octet_length(vsf.file_id) > -pg_backend_pid()`,
  `SERIAL_FILES_SCAN_SQL`, since a hash join probed by a parallel scan of the files would emit the chunks in that
  scan's order) that keeps those scans out of parallel workers while the rest of the statement (the exact vector
  arm) keeps its parallel plan. Known limitation: that order favours older chunks, so a common-word match in recent content can miss the 5,000; the chunks with every term are always in,
  and the vector arm is not bounded, so new content is still found through them.

Whether a search is large costs nothing on a table of at most `exact_max_chunks` chunks beyond reading
`pg_class.reltuples` once a minute per gateway process (unknown, i.e. never vacuumed or analysed: not large); in a
larger table, a count of the searched chunks capped at `exact_max_chunks + 1` (`idx_chunks_store_gen`), remembered
per store set for a minute. Every check runs before the recall transaction; a failure logs a warning and leaves the
arm unbounded. `exact_max_chunks = 0` therefore bounds every full-text search on a non-empty table (any such
table is "large", and every search over at least one chunk is above 0), and lowering the threshold for an ANN
trial lowers this bound with it. A search over at most `exact_max_chunks` chunks sends the same statements as before, byte for byte
(`recallLexicalBound.test.ts`, `integration/lexicalBound.test.ts`); so does every search on an install as small as
the evaluation corpus. Tests also cover the dropped term, the AND query, an all-common question (EXPLAIN: the ranked set is
5,003 rows of 8,003), a never-analysed table (nothing dropped, the ceiling kept), the filter in both parts, the
settings staying inside the transaction, and the same ranking twice on a forced sequential scan with free
parallelism (canary: without the predicate the capped scan is planned in parallel). Scale bench tables, forced sequential
scan: at 400,000 chunks the 32-term question ranked 4 different sets in 4 runs with synchronized scans; at
1,000,000 chunks with the fix and free parallelism, every question ranked one set in 4 runs.

Scale bench (`--lexical`, 384 dimensions, 200 tenant stores, pg16.15, warm cache, limit 50), the OR arm alone on
the largest store, p50 before to after (5 % and 5,000): at 200,000 chunks of 600 words (about 800 tokens), a term in
half the chunks plus two rare ones 2,073 to 13 ms, three common terms 2,238 to 77 ms, a 32-term question 3,339 to
84 ms, three rare terms 10 to 13 ms, no match 2 to 2 ms; at 1,000,000 chunks of 120 words 13,909 to 44 ms, 8,439 to
160 ms, 4,815 to 147 ms, 38 to 36 ms and 2.5 to 2.5 ms. The ceiling's own cost at 200,000 × 600 words: 2,000 about
45–70 ms, 5,000 70–100 ms, 10,000 120–160 ms, 20,000 280–360 ms. The whole recall at 1,000,000 chunks (vector arm
exact, about 4 s of it): 12–14 s to 4.3 s for the first question, 10–11 s to 5–5.6 s for the 32-term one. The checks:
`reltuples` 0.05–0.15 ms, the capped count 0.4–0.6 ms for a 100-chunk store and 2.2–2.8 ms at the cap on the
1,000,000-chunk store, `pg_stats` 0.6 ms. The bounded arm ranks other chunks than before (the overlap of its top 50
with the unbounded arm's is 0–0.56: `ts_rank` has no IDF, so the unbounded top 50 are the chunks richest in the
common term); the evaluation corpus is far below the threshold and unchanged.

### Chunking configurations

The runner measures the chunking options with named configurations (`scripts/fileSearchEval/options.ts`).
A configuration's store setting (`storeChunking`) and context model (`contextual`) decide how the corpus is
ingested; `candidates`, `rerankInput` and `parentSections` change only the search:

| Configuration | Store | Search |
|---|---|---|
| `baseline` | static 800/400 | defaults |
| `structure` | structure 800/0 | defaults |
| `structure-no-rerank` | structure 800/0 | reranker off |
| `structure-c20` | structure 800/0 | 20 candidates per arm |
| `contextual` | structure 800/0, contexts by `gemini-3.5-flash-lite` | defaults |
| `contextual-no-rerank` | as `contextual` | reranker off |
| `contextual-c20` | as `contextual` | 20 candidates per arm |
| `contextual-rerank-ctx` | as `contextual` | the reranker reads context and text |
| `contextual-haiku` | structure 800/0, contexts by `anthropic--claude-4.5-haiku` | defaults |
| `parent` | structure 800/0 | parent sections of at most 1,500 tokens, as the Responses tool returns them |

```bash
cd services/gateway
pnpm run eval:file-search -- --env .env --config structure
pnpm run eval:file-search -- --env .env --config contextual
pnpm run eval:file-search -- --env .env --config parent --judge 40
pnpm run eval:file-search -- --compare ../../ci/file-search-eval/results/<structure>.json ../../ci/file-search-eval/results/<contextual>.json
```

- **The runner pins the reranker input**: the chunk text unless a configuration names another
  (`contextual-rerank-ctx`), so every configuration reproduces what it measured whatever `hybrid.rerank.input`
  ships as. A configuration without `storeChunking` uses a static 800/400 store, the original baseline, not the
  installation default.
- **One store per ingestion setting.** The store key holds the chunking setting files are chunked with and,
  for contextual chunks, the context writer's settings with the model, besides the corpus, the embedding
  model and the ingestion fingerprint (whose sources include the structure chunker, the context writer and the
  completion helper). Search-only variants reuse their store; `structure`, `contextual` and
  `contextual-haiku` each build one. A run refuses to start when the gateway configuration it generated would
  write contexts with another model than the configuration names.
- **The no-rerank and 20-candidate variants matter most.** The corpus is small enough that the reranker sees
  half of it for every question, which hides what better first-stage recall (contextual embeddings and
  contextual full-text matches) does on a large store.
- **Context costs are metered.** Before each file the meter checks the file's embedding estimate plus its
  context estimate (`estimateContextTokens` over the file's own extracted text and chunks, raised by 1.2 for the
  context models' own tokenizers, the whole prompt priced as if nothing were cached) against `--max-usd`, and stops before the file otherwise, saying which
  file and how many were done. After each file it books the job's counters; a file that did not complete gets
  its context estimate booked, since its job holds none of the tokens its calls spent. The context models'
  prices are constants in `costMeter.ts` (`CONTEXT_PRICES`, dated, rounded up); check them against SAP's
  current prices before a contextual run. A context or judge model without a row (`CONTEXT_PRICES`,
  `JUDGE_PRICES`) is refused before the run starts. The judge defaults to `gemini-3.5-flash`
  (`--judge-model gpt-4.1` remains selectable).
- **Results.** The store block records chunks per document kind and, for contextual stores, the context input,
  cached and output tokens, the share of the prompt read from a cache and the chunks without context. Every
  run records the returned text volume (`returnedTokens`: mean tokens of the top 5 and of all results). A
  `parent` run counts a returned parent section that contains a quote as a hit (`relevance: "parent"`), which
  larger texts reach more easily; `--compare` warns when the two runs count differently, so read its chunk
  ranking from `structure` and its value from the judge.
- **Cost of a run** at the meter's prices: an ingestion of the corpus costs about $0.02 in embeddings, a
  contextual ingestion at most about $0.87 more with `gemini-3.5-flash-lite` and $2.11 with Haiku (uncached;
  Haiku's cache reads lower the real cost), a reranked search configuration about $0.73 (less with 20
  candidates when the reranker reports one search unit per question instead of two; the meter books what it
  reports), a no-rerank one $0.001, and `--judge 40`
  on parent sections up to about $1.10 with the default judge model ($1.60 with `gpt-4.1`).

### Parsing configurations

The parsing configurations measure how PDFs are read, each on the `baseline` store setting (static 800/400, shipped
search), so only the reading differs:

| Configuration | OCR | Vision |
|---|---|---|
| `ocr` | on (`eng`) | off |
| `vision-no_text` | on | `no_text`, `gemini-3.5-flash-lite` |
| `vision-auto` | on | `auto`, `gemini-3.5-flash-lite` |

```bash
cd services/gateway
pnpm run eval:file-search -- --plan --config vision-auto                        # calls and cost, nothing run
pnpm run eval:file-search -- --env .env --config ocr
pnpm run eval:file-search -- --env .env --config vision-auto --allow-vision
```

- **The runner sets the switches.** `FILE_SEARCH_OCR` and `FILE_SEARCH_VISION` are `off` for every configuration
  that does not ask for them, whatever the host has installed, so the earlier configurations keep measuring the
  text layer. A configuration with OCR refuses to start where tesseract with `eng` cannot run, one with vision where
  poppler or sharp is missing; a vision configuration also needs `--allow-vision`.
- **Store key.** A `parsing` part (OCR's languages, the vision model and limits) joins the key; the vision mode is
  in the chunking part. The ingestion fingerprint covers `visionTranscriber.ts` and `pages.ts` as well.
- **Vision is metered per call.** Before each PDF the meter checks the pages its mode selects (the transcriber's
  own rule over pdftotext) at 1,250 input and 4,096 output tokens a page; afterwards it books what every call
  reported, read from the transcriber's usage events (the corpus is attached with a placeholder credential, and
  standalone mode sends the events nowhere). Prices: `VISION_PRICES` in `costMeter.ts`.
- **`--plan`** prints, per step, the SAP calls, tokens and the expected and upper-bound cost (ingestion as for a
  fresh store, contexts, vision pages per file, query embeddings, rerank), from the corpus alone, with no database,
  credentials or SAP call.
- **The corpus** gained a synthetic deck and workbook (`pptx`, `xlsx` kinds, 20 hand-written questions); the 12
  scanned pages are what OCR and `no_text` read, `auto` adds the table PDF's 5 pages.

Measured on 2026-10-09 (165 questions; `ci/file-search-eval/baseline.json`):

| Configuration | recall@5 | recall@10 | MRR | nDCG@10 | scanned R@5 | table R@5 | Cost |
|---|---|---|---|---|---|---|---|
| `baseline` | 0.830 | 0.855 | 0.746 | 0.792 | 0 | 1.000 | $0.840 |
| `ocr` | 0.921 | 0.945 | 0.827 | 0.876 | 0.833 | 1.000 | $0.841 |
| `vision-no_text` (12 pages) | **0.933** | **0.958** | **0.844** | **0.892** | 0.944 | 1.000 | $0.864 |
| `vision-auto` (17 pages) | 0.879 | 0.903 | 0.789 | 0.837 | 0.944 | 0.550 | $0.880 |

- **OCR** makes the scans searchable at no model cost; **vision `no_text`** reads them better still for about $0.02
  of flash-lite tokens (14,820 input, 5,218 output for 12 pages).
- **`auto` loses on tables.** It also sends the table PDF's pages, whose text layer already reads correctly, and
  replaces it with the model's transcription; the table questions' quotes are verbatim pdftotext text (cell wraps
  included), so they no longer match. That is partly a grading artifact, but it is a real effect too: `auto`
  rewrites pages that were read correctly. **Recommendation: `no_text` for scanned documents;** `auto` stays
  available for PDFs whose figures or tables read badly from their text layer; the default mode stays `off`.
- PowerPoint and Excel questions score 1.000 in every run; Markdown, PDF and multihop questions are unchanged
  (within 0.007 MRR). Each run cost about $0.84 at the meter's prices, nearly all of it rerank (330 search units).

## Blob storage: database and S3

The bytes of an uploaded file are a **blob** in `file_blobs`, keyed by their SHA-256 and
reference-counted (`ref_count` = the `fs_files` rows that use it), so identical content is stored
once. Each row names its own storage: `storage = 'db'` keeps the bytes in `bytes`; `storage = 's3'`
keeps only `location`, the logical key `<prefix>/<sha[0:2]>/<sha>` under
`blob_storage.s3.prefix`. Because keys are content-addressed, **every file_search database needs its
own prefix (or bucket)**: two installations writing under one prefix share objects, and one's
sweeper deletes objects the other still references (nothing guards against it). `blob_storage.backend` decides only where **new** blobs go. Every read
dispatches on the row's own `storage` (`openBlob` in `blob/blobStore.ts`), so switching the
backend strands nothing: s3 rows stay readable while the S3 configuration and credentials are
there, and a **blob migration** moves them. `"local"` is refused (`UnsupportedBlobBackendError`).

### Lifecycle

| State | Row | What happens next |
|---|---|---|
| live | `ref_count > 0`, `delete_after` NULL | readable; a new upload of the same content increments `ref_count` (with s3 configured after the same PUT as new content: see below) |
| released | `ref_count = 0`, `delete_after = now() + 15 min` | still readable; a re-upload **revives** it (and for s3 PUTs the object again, never an exists check); the sweeper deletes it after the grace |
| garbage | no row; an entry in `file_blob_garbage (storage, location)` | an external object no row points to: a migration's source copy, a copy a failed or cancelled migration item discards, or the object of a row the sweeper could not address. Deleted by the garbage pass after its grace |

- **Release does no I/O.** `releaseBlobIn(client, sha)` runs on the caller's transaction (file
  delete, detach-everywhere), so a crash or rollback undoes the release with the file row. Nothing
  deletes an object at release time; that was the delete race the S3 work removed.
- **The per-sha lock.** Every writer and deleter of a sha takes
  `pg_advisory_xact_lock(0x626c6f62, <first 32 bits of the sha>)` (`lockBlobSha`), then the row
  `FOR UPDATE`. Retain, revive, the sweeper, the garbage pass and the migration switch all
  serialise on it. A writer of an s3 key deletes that key's garbage entry under the lock before
  its PUT.
- **Uploads do not reveal existing content.** `deduplicated` is for logs only. With an external
  backend configured, `retainBlob` resolves the backend before any database work and PUTs the bytes
  to the content-addressed key on every retain, under the lock, whether the content exists or not;
  a row already in that storage gets the key as its `location` (back under the current prefix), and
  a row in another storage (db) leaves the object with no row, so it is queued in
  `file_blob_garbage` under the lock (the garbage pass deletes it while no s3 row of the sha exists;
  a later migration to s3 deletes that entry before its own PUT). So status and S3 work are the
  same for new and duplicate content, an S3 outage (503) and a missing configuration included. A
  small database-side difference remains (an INSERT against an UPDATE, possibly a garbage row),
  far below a PUT's own variance. `"local"` refuses every upload. With db configured no upload
  touches external storage (a revive of a released s3 row re-PUTs it to S3).
- **S3 slots and the pool.** A retain's PUT, the migration switch's read-back GET and the
  sweeper's object DELETE each run while holding a pooled connection (the pool has 10). At most
  `S3_SLOTS` (3, `blob/s3Slots.ts`) such requests run per process; the slot is taken **before** the
  connection, so waiters hold neither a connection nor a lock and a slow S3 cannot take the pool
  from search, listing or ingestion. An upload waits at most 15 s for a slot (then
  `503 blob_storage_unavailable`); the sweeper and the migration wait without a limit. Work that
  learns only under the lock that it needs S3 (a db-configured revive of an s3 row, a row the
  sweeper finds moved) rolls back, takes a slot and runs again. A wait for a connection itself is
  bounded at 15 s (`connectionTimeoutMillis`; see the error table above).
- **The sweeper** (`blob/blobSweeper.ts`) runs on every replica: first 60 s after start, then every
  5 minutes, at most 200 rows per pass, candidates claimed with `FOR UPDATE SKIP LOCKED`. Per row:
  lock, re-check `ref_count = 0 AND delete_after < now()`, DELETE the row (23503 = refcount
  drift: the row is repaired from the real `fs_files` count; 40P01 skips it), delete the object,
  COMMIT. A failed object delete rolls back and retries the row after 15 minutes. Only S3's 404/204
  mean "gone"; a **403 on DELETE is a failure**, retried, never counted as deleted. A row it cannot
  address (unknown storage, no S3 config or credentials, a location outside the prefix) is deleted
  and its object parked in `file_blob_garbage` with a 2-minute grace.
- **The garbage pass** (same sweep) claims due entries with a 10-minute lease, then per entry
  takes the sha lock and deletes the object by exact key, unless a row of that sha exists in the
  same storage (then it drops the entry and deletes nothing). Failures keep `attempts`,
  `last_error` (reason and S3 op/status/code only) and back off `2^attempts` minutes, capped at a
  day; entries are never dropped, because a missing credential can come back.

### Migration (`blob_migration` jobs)

`startBlobMigration(target, actor)` (`blob/blobMigration.ts`; admin route
`POST /admin/blob-storage/migrate`) refuses an unknown target, a second unfinished migration (the
unique index `idx_fs_jobs_blob_migration_running`), an s3 target whose probe fails
(`target_unavailable`, no job written; see *S3 requests*) and an empty move. Otherwise it writes one
`fs_blob_migration_items` row per blob not in the target, released blobs included. The target may
differ from `blob_storage.backend`; the panel warns, because new uploads keep going to the
configured backend.

Per item (`blob/blobMigrationWorker.ts`, one loop per replica polling every 5 s; items claimed with
`FOR UPDATE SKIP LOCKED`, a 15-minute lease, `ingestion.max_retries` attempts):

1. read the source bytes from the row's own storage and check their SHA-256 (a mismatch fails the
   item for good);
2. for an s3 target: under the sha lock delete the key's garbage entry, then PUT;
3. switch transaction: sha lock, the item under its claim guard, the row `FOR UPDATE`; for an s3
   target GET the object again and check its SHA-256 **under the lock** (one GET per item; a
   missing or wrong copy rolls back and retries); UPDATE `storage`, `location`, `bytes`; queue an
   external source object as garbage with the 15-minute grace; mark the item completed.

A cancelled, reaped or reclaimed item moves nothing: its copy is queued as garbage and the row
stays at its source. Cancel marks the open items `cancelled` and finishes the job at once (there is
no visible `cancelling` state for this kind), so a new migration can start immediately. An item
whose switch holds its lock at that moment makes the cancel wait for it: at most the S3 GET
deadline (120 s) of the read-back. Retry
re-opens the failed items of a finished, non-cancelled job and is refused with `superseded` once a
newer migration exists. Partial results are `completed_with_errors`.

### S3 requests

`blob/s3Backend.ts` signs SigV4 itself (`libs/aws-signing`), no SDK. Every request has a hard
deadline (`AbortSignal.timeout`: 120 s for PUT/GET, 10 s for DELETE/HEAD; GET also a 30 s idle
timer), `maxRedirects: 0` (a redirect is an error carrying S3's region hint), and one retry on a
reset keep-alive socket. A GET accepts at most the body its caller expects: the row's `size_bytes`
plus 64 KiB (`maxGetBytes`), else `limits.max_file_bytes` plus that margin; a larger 2xx body fails as
`response_too_large`. Every response may still carry 64 KiB, so an S3 error reply (a few hundred
bytes of XML) is always read and reported with its own status and code, also for the probe's GET. Every key lies under the configured prefix; a stored location under
another prefix throws `S3LocationError` before any request. There is no bucket-level request at
all: nothing lists the bucket, and there is no HeadBucket. Reachability (the admin connection test
`POST /admin/blob-storage/test` and `checkMigrationTarget('s3')` at a migration's start) is
`S3Backend.probe()`: a PUT of the fixed object `S3_PROBE_CONTENT` ("sail-proxy file_search
connection probe v1\n") at its content-addressed key `<prefix>/<sha[0:2]>/<sha>`, a GET, and a
SHA-256 check (`probe_mismatch`/`probe_missing` as GetObject codes). It exercises exactly the
permissions file_search needs and works with a prefix-scoped IAM policy, which HeadBucket (it needs
an unconditioned `s3:ListBucket`) does not. The probe object is **never deleted**: its key is
content-addressed, so a user file with identical bytes would share it, and a PUT of identical bytes
is a no-op for such a file. The probe takes no blob lock; at worst it re-creates the object after
the sweeper deleted such a file's row, which leaves an unreferenced object with the probe's bytes.
`S3RequestError` carries op, status and code only, never a URL, host, key or credential.

Leftover objects can occur, always inside the configured prefix: objects under a previous prefix
(a revive under a new prefix writes the current key and leaves the old one, which the backend may
not address), and an object PUT by an upload or a migration worker that crashed before its
transaction committed and whose item is never retried. Both are content-addressed, so a later
upload of the same content reuses the key.

### Upgrade

`file_blobs.delete_after`, `fs_jobs.target_storage`, the tables `file_blob_garbage` and
`fs_blob_migration_items`, and the unique index `idx_fs_jobs_blob_migration_running` are added by
`schema.sql.ts` like the re-embedding columns (guarded `DO` blocks, `IF NOT EXISTS`) and are part
of the `missingRequiredSchema` probe: a non-owner single-DSN install reports unavailable until
`cli-tools/file-search-migrate.js` runs as the owner. Existing rows keep `storage = 'db'`; nothing
is backfilled. `kyma-db-manager.js backup` and `info` count the blobs outside the database and warn
that a database backup does not contain them; `restore` counts the dump's own s3 rows and warns.

### Tests

| Suite | Pins |
|---|---|
| `blobLifecycle.test.ts`, `integration/blobLifecycle.test.ts` | dispatch on the row's storage, release in the caller's transaction, the grace, revive with re-PUT, the lock order |
| `blobRetainUniform.test.ts` | the same PUT and status for new and duplicate content with s3, garbage for a db row's extra object, the S3 slots (taken before the connection, released on error, bounded wait) |
| `integration/blobPoolBound.test.ts` | uploads against a hanging S3 leave pool connections for search and list |
| `poolTimeout.test.ts` | the pool's connect timeouts become `FileSearchBusyError`, and the routes answer it as a 503 without driver text |
| `integration/blobSweeper.test.ts` | the sweeper and garbage pass: re-check, drift repair, 403 as failure, parking, leases, the live-row guard |
| `integration/blobRace.test.ts` | release, retain and two sweepers racing: 0 losses, 0 orphans on db and MinIO (`FILE_SEARCH_RACE_ITERATIONS`, 60 in CI, 300 as the acceptance run) |
| `integration/blobMigration.test.ts`, `integration/blobMigrationMinio.test.ts` | the migration protocol, claims, cancel, retry, `superseded`, a worker killed between PUT and COMMIT |
| `s3Backend.requests.test.ts`, `s3Backend.confinement.test.ts`, `s3Backend.getLimit.test.ts` | timeouts, redirects, retries, the probe, the GET body cap, and that every request URL is under the prefix |
| `s3VerifyScript.test.ts`, `integration/s3VerifyExecute.test.ts` | the verification script below: prefix refusal, plan, guard (no network); its steps and request counts against MinIO |

MinIO for the S3 suites is the helper `ci/scripts/file-search-test-s3.js` (see [Testing strategy](/developer/testing-strategy#ui-journeys-opa5-in-ci)). The suites
read only `FILE_SEARCH_TEST_S3_*` and inject those credentials; `test/setupTests.ts` deletes the
product `FILE_SEARCH_S3_*` variables around every test, so no test run can reach a real bucket.

### S3 verification against a real bucket

`services/gateway/scripts/file-search-s3-verify.ts` exercises the whole lifecycle against a real
AWS bucket, in-process (no gateway, no admin service) against a throwaway pgvector container
`fs-s3verify-pg` on `127.0.0.1:55470` that it starts and removes by name. It reads, from the env
file given with `--env` (default `services/gateway/.env`):

| Variable | Meaning |
|---|---|
| `FILE_SEARCH_S3_VERIFY_BUCKET` | the bucket |
| `FILE_SEARCH_S3_VERIFY_REGION` | its region |
| `FILE_SEARCH_S3_VERIFY_PREFIX` | must be `grounding-test` or start with `grounding-test/`; anything else is refused (exit 2) |
| `FILE_SEARCH_S3_ACCESS_KEY_ID`, `FILE_SEARCH_S3_SECRET_ACCESS_KEY` | the product keys |

These names are verification-only and deliberately absent from `.env.sample`. None of the values
is ever printed; output says "the bucket".

```bash
cd services/gateway
# 1. the plan (the default): sends nothing
npx ts-node -r tsconfig-paths/register --transpile-only scripts/file-search-s3-verify.ts --plan --env <gateway .env>
# 2. after review, exactly that plan (the plan prints this line with its run id)
npx ts-node -r tsconfig-paths/register --transpile-only scripts/file-search-s3-verify.ts \
  --execute --run-id <run id printed by the plan> --plan-fingerprint <from the plan> --files 3 --env <gateway .env>
```

Safety rules, each enforced by the script:

- every key lies in the run folder `<prefix>/w7-<UTC timestamp>/` and is content-addressed from
  test content derived from the run id, so `--plan` prints exactly the keys `--execute` creates;
  `--execute` requires the plan's `--run-id`;
- a request guard (an axios request interceptor, the only one on the instance the backend uses)
  throws **before sending** any request that is not a PUT/GET/DELETE/HEAD of a planned key (the
  test files and the probe object): nothing on the bucket itself, no query string, no other host, no
  path-style or http;
- cleanup deletes only keys this run sent a PUT for, by exact key; nothing lists the bucket;
- an object counts as deleted only by its DELETE's own success (204), which the sweeper and the
  garbage pass require; the exact-key HEAD afterwards reports 404 as absent and 403 as "not
  readable with these credentials" (S3 may answer 403 for a missing key under a prefix-scoped
  policy, so it shows neither presence nor absence), never as a confirmed delete; a 200 fails the
  run;
- `--plan` prints a plan fingerprint (bucket and region, hashed in and never printed, run folder,
  every key, requests per step); `--execute`
  requires `--plan-fingerprint` and refuses one that does not match the plan it would run;
- the pg container is removed on every exit path: a failed start removes what it created, and the
  end of the run (S3 cleanup, guard, pool, container, temporary configuration, each step on its own)
  also runs on SIGINT/SIGTERM, which then exit 130/143.

The probe object is the one key the run does not delete; the plan lists it as "left in place".
The steps, for three files: preflight probe; upload with backend s3; read back; switch the
backend to db and read back (still from s3); migrate s3→db; make the source copies due and run the
garbage pass; check they are gone; migrate db→s3 (probe, PUT, verifying GET); read back;
delete the files with grace 0 and run the sweeper; check every key is gone; cleanup. Requests:
PutObject 8, GetObject 17, DeleteObject 9, HeadObject 6 (40), none on the bucket itself. The run
fails (exit 1) on any mismatch, a guard refusal, a failed cleanup step, or request counts that
differ from the plan (a retried request counts twice); it prints the script's own errors in full
and an S3 error as op, status and code.

## A local file search database

The development gateway has no file search database by default, and the cockpit's Grounding
screens then show "not available". To develop against a real one, start a pgvector container that
stays up and point the gateway at it:

```bash
docker run -d --name sail-dev-pgvector --restart unless-stopped \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=filesearch_dev \
  -p 127.0.0.1:55431:5432 pgvector/pgvector:pg16-trixie
```

and add to `services/gateway/.env`:

```
FILE_SEARCH_DATABASE_URL=postgresql://postgres:postgres@localhost:55431/filesearch_dev
```

The gateway creates the schema on its next start. Port 55431 keeps the container clear of the
pipeline's own (55434) and of the Docker stack's Postgres (5432). The admin service and its SQLite
database are not involved.

