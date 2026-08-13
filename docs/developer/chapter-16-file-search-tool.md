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

### The query travels the other way, and the two transports disagree

`web_search` sends the query **out** to a third party. `file_search` brings it **in**, to our own corpus, which is stored raw. So the query is deliberately *not* re-masked — re-masking it would search for placeholder tokens that appear in no document.

Where it must be unmasked depends on the transport, because the two paths read the query at different points in the pipeline:

| Transport | The query arrives | Because | Action |
|---|---|---|---|
| non-streaming | **raw** | `pseudonymizationPlugin`'s after handler (hook index 0) already unmasked the model's `function_call` arguments | use as-is |
| streaming | **masked** | the hosted-tool interceptor sits *behind* pseudonymization's `res.write` and reads bytes still in flight | unmask before searching |

Implemented backwards, this searches a raw corpus for `MASKED_PERSON_3` and returns **zero hits rather than throwing** — indistinguishable from an empty store, in the one part of the flow that can no longer tell the caller anything. `test/responses-filesearch-stream.test.ts` therefore asserts on hit *counts* against a fixture corpus that only matches the real address, on both transports; a test asserting "the code ran" would stay green through this bug.

## Per-tool caps are termination guarantees, not tuning knobs

`file_search.tool.max_searches_per_request` (default 3, valid range 1..10) bounds how many searches one request may run. A configured value outside that range — or a non-integer, or a string — does **not** clamp to the nearer bound; it falls back to the default of 3, with a warning (`resolveMaxSearchesPerRequest`). Garbage config is treated as "not configured" rather than silently coerced into something the operator never asked for. `web_search.max_searches_per_request` bounds `web_search` independently — two unrelated config accessors, two budgets, and a request that has exhausted one may still spend the other. They happen to ship with the same number; nothing shares it, and a shared counter would silently collapse the two.

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

`file_search.rewrite_query` sends the query to the tenant's orchestration deployment to be rewritten into a keyword-rich form before embedding. It costs roughly **1.3 seconds per search**. The shipped default is now `false`, and `FILE_SEARCH_DEFAULTS.rewriteQuery` is `false` too — which is what an install whose configuration predates the `file_search` block resolves to.

**No existing install picks this up.** New installs get `false`; existing installs keep whatever they have, which is `true`, until an operator changes it:

- **Standalone** — `api_config.json` is copied from the template **once**, at first run, and is never updated by a version bump. Edit `~/.sail-proxy/api_config.json`.
- **Docker and Kyma** — the admin-activated configuration **replaces** the file configuration wholesale, with no merge, so a new template key is invisible until an admin activates a configuration containing it. Change it in the cockpit and activate.

On the **tool** path the config value is moot in either direction: the descriptor passes `rewriteQuery: false` explicitly, because the model has already turned the user's turn into a search query and rewriting that a second time drifts it further from what was asked. The setting therefore only affects the REST endpoint `POST /openai/v1/vector_stores/{id}/search`.

To turn it back on, set `api_config.file_search.rewrite_query` to `true`. `rewrite_query_model` (default `gpt-4o-mini`) picks the model; it is config-driven rather than hardcoded because a model name that works on one SAP AI Core tenant's orchestration deployment is not guaranteed to work on another's — this codebase's usual fallback, `gpt-35-turbo-16k`, returns HTTP 400 from the tenant this was verified against. Rewriting is best-effort throughout: any failure degrades to the caller's original query, logged at debug only, and never fails the search.

## File batches

Attaching files one at a time is fine by hand and painful from an SDK, so OpenAI has a batch surface — and its client helpers (`fileBatches.createAndPoll`, `fileBatches.uploadAndPoll`) are built on it. All four endpoints are mounted on `/openai/v1/vector_stores` and `/openai/api/v1/vector_stores` (`src/routes/vectorStoresRoutes.ts`); like every other vector-store route, they are **not** on `/openrouter/api/v1`.

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

`POST` create is a **400 `invalid_file_ids`** for missing or empty `file_ids`, a **404 `vector_store_not_found`** for a store the caller does not own, a **400 `file_not_found`** for a `file_id` they do not own (the status differs from the store case because it mirrors the single-file attach path), a **409 `file_already_attached`** for a file already in the store, and a 400 `vector_store_file_limit_exceeded` when the batch would push the store past `limits.max_files_per_store`. A `batch_id` in another store is **404 `vector_store_file_batch_not_found`**, indistinguishable from one that never existed — every batch query is scoped by `store_id` as well as by id, because an unguessable id is not authorization. Attachment is **all-or-nothing when the cleanup succeeds**: a failure partway through takes `discardPartialBatch`, which removes the batch and every row it had already written before the original error is rethrown, so a client normally never has to reason about a half-attached batch.

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
| the tool never runs; the deployment rejects the request | the plugin hook entries under `defaultHooks.openai.responses` / `responses-stream` are missing from the activated configuration |
| every search returns nothing | check the store is not empty *before* suspecting the query path; then check the masked/raw asymmetry above |
| `400 invalid_purpose` on upload | the `purpose` part of a `POST /v1/files` upload must be **`assistants`** — the value OpenAI's own file-search guide uploads with, and therefore the value the OpenAI SDK sends. It was `file_search` until 2026-08-05, which is not in OpenAI's documented enum at all and made the feature unreachable from a compliant client. The other documented values (`assistants_output`, `batch`, `batch_output`, `fine-tune`, `fine-tune-results`, `vision`, `user_data`) stay rejected on purpose: this endpoint is not general file storage |
| `503 file_search_unavailable` | no `FILE_SEARCH_DATABASE_URL`, the migration never ran (see chapter 14), or `blob_storage.backend` is set to something other than `"db"` — the message says which. `"local"` and `"s3"` are refused deliberately (`blobStore.ts`); this is a configuration fault, which is why it is a `503` and not a `500` |
| a `file_search_call` with `status: "failed"` | the `function_call_output` carries an error code: `store_not_found`, `query_too_long`, `file_search_not_prepared`, `file_search_no_owner`, `file_search_unavailable` |
| no citations on a good answer | expected — see point 1 under *`file_citation` annotations* |
| `results` missing despite `include` | the token is `file_search_call.results`, named after the output item — see *The `include` gate* above |
| a batch `cancel` returned `status: "in_progress"` | expected — cancellation is cooperative and the worker checks it between files; poll until it settles. See *Cancellation is cooperative* |
| a batch is `completed` but documents are missing | read `file_counts.failed`, not `status`: a failed member never makes the batch `failed`. `GET .../file_batches/{batch_id}/files?filter=failed` names them, and each carries `last_error` |
| `createAndPoll` returned a store that is still filling up | a contract violation, not a tuning issue — `batchPollContract.test.ts` is the test that should have caught it |

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

---

*Previous: [Chapter 15 — Reranker Teacher Datasets](chapter-15-reranker-datasets.md) · Index: [Developer Guide](README.md)*
