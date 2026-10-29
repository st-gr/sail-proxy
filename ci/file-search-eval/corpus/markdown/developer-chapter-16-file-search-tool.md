---
title: SAIL-PROXY Developer Guide - Chapter 16
author: st-gr
date: 2026-08-04
mainfont: Helvetica, Arial, sans-serif
fontsize: 18px
---

# SAIL-PROXY Developer Guide
*Multi-provider AI Gateway for SAP AI Core - Developer Documentation*
**Author:** *st-gr*

# Chapter 16: The hosted `file_search` tool

Chapter 15 covers the retrieval *stack* — hybrid recall, the reranker, the teacher datasets it produces. This chapter covers the **tool**: what happens when a client attaches `{"type": "file_search"}` to a `/openai/v1/responses` request and lets the model decide when to search.

The REST surface (`POST /openai/v1/vector_stores/{id}/search`, also mounted at `/openai/api/v1/vector_stores/{id}/search`) and the tool share one entry point, `searchVectorStores`. Everything that differs between them is in this chapter.

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

SAP AI Core deployments reject hosted tool types outright, so the gateway rewrites the hosted entry into a plain function tool named `file_search`, runs the retrieval itself, and hands the client back the hosted-tool response shape. All of the transport machinery is shared with `web_search` and lives in `src/plugins/hostedTool/engine.ts`; what `file_search` *is* lives behind `HostedToolDescriptor` in `src/plugins/fileSearch/descriptor.ts`.

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

The response body is the same OpenAI error envelope `filesController` and `vectorStoresController` emit, so a `file_search` mistake reads identically whether you hit the REST surface or the tool.

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
{ "type": "file_citation", "file_id": "file-9f2c0a7b1e4d6835c07a1b92", "filename": "handbook.md",
  "index": 23, "start_index": 23, "end_index": 96 }
```

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

To turn it back on, set `api_config.capabilities.file_search.rewrite_query` to `true`. `rewrite_query_model` (default `gpt-5-mini`) picks the model; it is config-driven rather than hardcoded because a model name that works on one SAP AI Core tenant's orchestration deployment is not guaranteed to work on another's. Rewriting is best-effort throughout: any failure degrades to the caller's original query, logged at debug only, and never fails the search.

## `ranking_options.hybrid_search` weights

Both `POST /openai/v1/vector_stores/{id}/search` and the Responses `file_search` tool accept OpenAI's `ranking_options.hybrid_search: { embedding_weight, text_weight }`. The weights scale the two lists the reciprocal rank fusion merges: a chunk's contribution from a list is `weight / (rrfK + rank)`, `embedding_weight` for every vector list and `text_weight` for the full-text list. A missing field counts as 1; without `hybrid_search` the fusion is unweighted, exactly as before. With `hybrid.lexicalEnabled=false` only the vector list exists, so the weights cannot change the order.

Each weight must be a finite number >= 0, and they must not both be 0. On the REST route anything else is a 400 with code `invalid_hybrid_search`. On the Responses tool an invalid `hybrid_search` is dropped and the search runs unweighted, the same way an invalid `score_threshold` is dropped there. `ranking_options.ranker` stays ignored. The `score_threshold` still applies to the reranker score, so weights change which candidates reach the reranker, not the final order when the reranker is on.

## File batches

Attaching files one at a time is fine by hand and painful from an SDK, so OpenAI has a batch surface — and its client helpers (`fileBatches.createAndPoll`, `fileBatches.uploadAndPoll`) are built on it. All four endpoints are part of the shared vector-store route table (`src/routes/vectorStoreRouteTable.ts`), so like every other vector-store route they are served under `/openai/v1/vector_stores`, `/openai/api/v1/vector_stores` and `/openrouter/api/v1/vector_stores`.

| Endpoint | Does |
|---|---|
| `POST /vector_stores/{id}/file_batches` | Attaches every id in `file_ids` (required, non-empty) to the store in one call, with one shared `attributes` and `chunking_strategy`. Returns the batch object. |
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

`POST` create is a **400 `invalid_file_ids`** for missing or empty `file_ids`, a **404 `vector_store_not_found`** for a store the caller does not own, a **400 `file_not_found`** for a `file_id` they do not own (the status differs from the store case because it mirrors the single-file attach path), a **409 `file_already_attached`** for a file already in the store, and a 400 `vector_store_file_limit_exceeded` when the batch would push the store past `capabilities.file_search.limits.max_files_per_store`. A `batch_id` in another store is **404 `vector_store_file_batch_not_found`**, indistinguishable from one that never existed — every batch query is scoped by `store_id` as well as by id, because an unguessable id is not authorization. Attachment is **all-or-nothing when the cleanup succeeds**: a failure partway through takes `discardPartialBatch`, which removes the batch and every row it had already written before the original error is rethrown, so a client normally never has to reason about a half-attached batch.

**That guarantee has a condition, and it is worth knowing which way it fails.** The batch row and its N attachments are not one transaction — `attachFile` opens its own per file — and `discardPartialBatch` **never throws**: it runs inside a `catch`, and letting a cleanup failure escape would replace the error that explains what actually went wrong with a less informative one. A cleanup that itself fails is therefore *logged*, not surfaced, and leaves an **orphaned batch holding some of its files**. This is not hypothetical bookkeeping: the realistic reason a batch fails partway through is a saturated pool or an unreachable database, which is precisely when the cleanup's own `pool.connect()` also fails. `src/fileSearch/batches.ts` says so in its own words — *"A cleanup that fails leaves an orphaned batch with some members, which is bad; masking the cause is worse, so it is logged instead."* If you are looking at a batch whose `file_counts` do not match what a client says it submitted, search the logs for `Failed to roll back a partially created file batch`.

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

## Where to look when something is wrong

| Symptom | Look at |
|---|---|
| `400` before any output | `prepare()` in `src/plugins/fileSearch/descriptor.ts` — the table above names every case |
| the tool never runs; the deployment rejects the request | the plugin hook entries under `hooks.defaults.openai.responses` / `responses-stream` are missing from the activated configuration |
| every search returns nothing | check the store is not empty *before* suspecting the query path; then check the masked/raw asymmetry above |
| `400 invalid_purpose` on upload | the `purpose` part of a `POST /v1/files` upload must be **`assistants`** — the value OpenAI's own file-search guide uploads with, and therefore the value the OpenAI SDK sends. It was `file_search` until 2026-08-05, which is not in OpenAI's documented enum at all and made the feature unreachable from a compliant client. The other documented values (`assistants_output`, `batch`, `batch_output`, `fine-tune`, `fine-tune-results`, `vision`, `user_data`) stay rejected on purpose: this endpoint is not general file storage |
| `503 file_search_unavailable` | no `FILE_SEARCH_DATABASE_URL`, the migration never ran (see chapter 14), a non-owner install that could not add the re-embedding columns (the boot warning names `cli-tools/file-search-migrate.js`; see *Upgrading an existing install* below), or `capabilities.file_search.blob_storage.backend` is set to something other than `"db"` — the message says which. `"local"` and `"s3"` are refused deliberately (`blobStore.ts`); this is a configuration fault, which is why it is a `503` and not a `500` |
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

Routes of its own: `GET /status` (always 200; says why file_search is unavailable),
`GET /file-attachments?file_ids=` (the stores of each file), and `DELETE /files/:id?detach=true`
(detach everywhere, then delete).

Routes of its own for the Jobs screen and retries (all scoped to the acting user as owner):

| Route | Does |
|---|---|
| `GET /jobs?limit=&after=&state=` | the caller's jobs, newest first; `limit` 1–100 (default 20), `state` one of the derived states; a bad value is `400 invalid_limit` / `invalid_state` |
| `GET /jobs/:job_id` | one job, `404 not_found` for an unknown id or another owner's job |
| `POST /jobs/:job_id/cancel` | sets the batch's cancel latch for a `queued` or `running` job; any other job is answered unchanged (latching a finished batch would flip it to `cancelled`). A re-embed job goes to the re-embed engine instead; a `reembed_bulk` parent only while the acting role is `admin`, else `404` (ruling R10). A deadlock with the worker is `409 concurrent_modification` |
| `POST /jobs/:job_id/retry` | re-opens the job's failed files (or a failed re-embed's items); answers the job plus `retried` |
| `POST /stores/:id/files/:file_id/retry` | re-opens one failed file; answers `{job_id, job, retried}`, `job_id` null for a file outside any batch |

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
`repository.ts`):

| Route | Does |
|---|---|
| `GET /storage` | the acting user's `{owner_email, file_count, logical_bytes}` (the Files screen header) |
| `GET /stores?limit=&after=` | the caller's stores **and every shared store**, newest first; each carries `is_shared`, `owned` and `owner_email`. `order=asc` and `before` are `400 unsupported_parameter` |
| `GET /stores/:id` | one store under the same visibility; `404 vector_store_not_found` otherwise |
| `GET /admin/overview` | stores, files, `logical_bytes`, `physical_bytes`, `savings_bytes`, `failed_ingestions`, `outdated_stores` (expired stores are not counted: the bulk re-embed skips them, ruling R9) |
| `GET /admin/stores?owner=&status=&shared=&embedding_state=` | every user's stores; `status` is `in_progress`, `completed` or `expired`, `shared` is `true` or `false`, `embedding_state` is `current`, `outdated` or `dimension_mismatch` (against the configured model, by `embeddingState`'s rule, in SQL) |
| `GET /admin/files?owner=` | every user's files with `owner_email` and `attachment_count` |
| `GET /admin/failed?owner=` | attachments with `status = 'failed'`; `id` is `<store_id>/<file_id>`, `last_error` only `{message, name}` |
| `GET /admin/storage` | files and logical bytes per owner, paged on the owner e-mail (`first_id`/`last_id` are e-mails) |
| `GET /admin/jobs?owner=&state=` | every user's jobs with `owner_email` |
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
Phase 4a (plan `docs/superpowers/plans/2026-10-06-grounding-phase-4a-reembedding-plan.md`, spec §5.4)
makes that safe: every store keeps its own model, and an outdated store is re-embedded **in place** —
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
  (ruling R3): an outdated store stays single-model until it is re-embedded.
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
running re-embed job, `null` when none runs — and always `null` on another owner's shared store,
ruling R8). Admin store rows carry the same fields with the job id.

**A model that is no longer served** (plan Decision 13) is not papered over. The embedder recognises
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
(`ACTIVE_GENERATION_PREDICATE_SQL` in `repository.ts`); recall states the same rule as a
`store:generation` key match inside its chunk scan (`ACTIVE_GENERATION_KEY_SQL`); `commitChunks(…, generation)` deletes and
inserts only its own generation; deleting a file or a store removes every generation.

A re-embed copies the active generation's stored chunk text (`ord`, `text`, `tokens`) into
generation `active + 1` with vectors from the target model (Decision 1). No blob is read and no
extractor runs, so chunking stays as ingested and the estimate is exactly what gets embedded.

### Jobs and work items

A re-embed is an `fs_jobs` row of kind `reembed_store` with the target pinned at its start
(`target_model`, `target_dim`, `target_generation`; Decision 3) and one `fs_reembed_items` row per
completed file `(job_id, store_id, file_id, status, attempts, claimed_at, last_error, tokens)`. A
configuration change during the job therefore leaves the store outdated again after the switch,
never mixed. The partial unique index `idx_fs_jobs_reembed_running` allows one unfinished
`reembed_store` per store; a concurrent start that loses the race is answered `reembed_running`.

**Start** (`startReembed`, `reembed.ts`) runs in one transaction under the lock order — the store
`FOR UPDATE`, its completed files `FOR SHARE` in `file_id` order, then the job and its items — and
refuses, writing nothing: another dimension (`store_dimension_mismatch`), an expired store, a
running re-embed, and a store that is already `current` (`store_current`, ruling R1: the same model
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

**Bulk** (`startBulkReembed`, Decision 11). A `reembed_bulk` parent is owned by the starting admin
(`owner_email` = the admin, `store_id` NULL — ruling R2: it shows only in that admin's Jobs and in
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
The cockpit shows it as sent, as it does a batch's error (ruling R11).

**Sweeping.** `settleIdleReembedJobs` (run by the idle worker loops and by the job sweeper's orphan
settling) finishes what nothing else will: a store job with no open item left (its last item was
detached, or the process died between an item and the switch) and a bulk parent whose children are
all finished. After the 30-day job sweep, `dropOrphanedGenerations` (`jobSweeper.ts`) deletes chunk
generations that are not the store's active one and that no non-cancelled re-embed job targets, in
transactions of at most 5,000 rows; each takes the store's lock and only then re-checks the
generation in a second statement, whose fresh snapshot sees a job that started meanwhile. A failed job protects its generation for Retry until the sweep
deletes the job, so a failed re-embed's chunks occupy space for up to 30 days (ruling R6). The
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
once and cached), `SET LOCAL hnsw.iterative_scan = 'strict_order'` (ruling R5: strict keeps exact
distance order for `ROW_NUMBER` and `LIMIT`). A server that rejects the hnsw settings as
unsupported (`42704`, `22023`) is remembered and they are not tried again in that process, and any
other failure skips them for that call only. A setting never fails a search, and a rejected hnsw
batch cannot switch `jit = off` off.

> **Ruling R4 - the HNSW index is not used, and recall is exact.** What kept recall off the index
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

> **Next: B2.** An ANN path through the HNSW index, plus an index rebuild, would remove that scan.
> It is gated on a recall probe on real data, because an approximate path trades exactness for
> speed; until then recall stays on the exact path above.

### Routes

User level, owner only (`controllers/groundingReembedController.ts`; a non-owner of a shared store
gets the same `404` as for an unknown store):

| Route | Does |
|---|---|
| `GET /stores/:id/reembed/estimate` | `{files, chunks, estimated_tokens, state}` of the active generation (`estimated_tokens` is `SUM(tokens)`, the chunker's estimate; no money in the gateway) |
| `POST /stores/:id/reembed` | starts the re-embed with the configured model; answers the job |
| `POST /jobs/:job_id/cancel`, `/retry` | as for a batch, for the owner's re-embed jobs (see *Jobs* above); a `reembed_bulk` parent answers `404` unless the acting role is `admin` (ruling R10: a demoted admin no longer controls the bulk runs it started) |
| `GET /jobs/:job_id/failures?limit=&after=` | the files the owner's re-embed job could not re-embed: `{id, job_id, store_id, store_name, file_id, filename, last_error: {message}, attempts}` per failed item (a `reembed_bulk` parent: its children's, each with the child's store), keyset-paged on `(job_id, file_id)` — `id` is `<job_id>/<file_id>` and `after` takes the previous page's `last_id`; `limit` 1–100 (default 20). Resolved owner-scoped like `GET /jobs/:job_id`: another owner's job, a file batch, and a bulk parent while the acting role is not `admin` all get the unknown-job `404`. Data layer `fileSearch/reembedFailures.ts`; never chunk text, and of `last_error` only the sanitised `message` |

Admin level, behind the `groundingAdmin` guard:

| Route | Does |
|---|---|
| `GET /admin/stores/:id/reembed/estimate` | the owner's estimate (as above) of **any** owner's store, the owner resolved first (ruling R12); the cockpit's admin confirmation shows it |
| `POST /admin/stores/:id/reembed` | resolves the owner first and runs the owner-scoped start with the admin as actor: the job is the owner's (in their Jobs), `started_by` the admin |
| `GET /admin/reembed-outdated/estimate` | `{stores, files, chunks, estimated_tokens, skipped: [{store_id, owner_email, reason}]}` over every owner; `reason` is `dimension_mismatch`, `expired` or `reembed_running` |
| `POST /admin/reembed-outdated` | starts the bulk job; answers `{job, skipped}` |
| `POST /admin/jobs/:job_id/cancel`, `/retry` | a re-embed job of **any** owner; a file batch is `404 not_found` here (Decision 10, phase 3 ruling P2) |
| `GET /admin/jobs/:job_id/failures?limit=&after=` | the failures (as above) of a re-embed job of **any** owner; a file batch is `404 not_found`. The cockpit's job page reads a bulk parent's failures here, since they span other owners' stores |

Every re-embed job records `credential_id`, `auth_type` and the acting e-mail like a batch does
(Decision 14); no usage events are emitted yet. The admin layer (`src/srv/grounding-rest-api.ts`)
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
| `retry_conflict` | 503 | a deadlock on retry (ruling R7: the existing retry mapping) |

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
- **Owner, single DSN** and **split credentials** (`FILE_SEARCH_MIGRATION_DATABASE_URL`, chapter
  14) upgrade automatically; the split path also grants the runtime role its privileges on the new
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

## Usage recording

Every billed file_search call emits a usage event (`fileSearch/usage.ts`, `emitFileSearchUsage`),
fire-and-forget through the usual usage emitter. Endpoints and units:

| Endpoint | Unit | Emitted by |
|---|---|---|
| `file_search/ingest` | tokens | the ingest worker, per embedding request |
| `file_search/reembed` | tokens | the re-embed worker, per embedding request |
| `file_search/search` | tokens | a search, per query-embedding request |
| `file_search/rerank` | units | a search that reranks; the rerank's search units |

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

**Record only.** Grounding routes do not check quotas. The usage counts toward the user's quota for
their other requests, but a grounding request is not refused when the quota is exhausted. Blocking
there is a follow-up.

Tests: `test/fileSearch/usage.test.ts`, `embedder.test.ts`, `search.test.ts`,
`integration/usageRecording.test.ts`, `integration/migrationUsageStamp.test.ts`, and on the admin
side `usage-event-processor-on-behalf-of.test.ts` and `usage-statistics-on-behalf.test.ts`.

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

---

*Previous: [Chapter 15 — Reranker Teacher Datasets](chapter-15-reranker-datasets.md) · Index: [Developer Guide](README.md)*
