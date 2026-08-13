# file_search Plan 1 — follow-ups carried out of the branch

**Written:** 2026-07-30, at the close of Plan 1 (retrieval core and the files / vector-stores API).
**Source:** the final whole-branch review's triage of 31 deferred items, plus two residuals adjudicated after the fix wave.

Plan 1 shipped: 12 tasks, 28 commits, 79 files, +13k lines, 1185 tests / 90 suites green.
Every task was reviewed adversarially and every review's findings were fixed or parked with a ruling.

This file exists so Plans 2 and 3 do not have to re-derive what was deliberately left undone.

---

## Must fix before this feature is exposed to real users

Nothing. The final review's two merge conditions (a NUL byte in the search query returning
500 with a raw driver string, and the unsafe non-default blob backends) were fixed in the
final wave and independently re-verified.

## Residuals adjudicated after the fix wave

| Item | Ruling |
|---|---|
| **NUL bytes in *other* user-controlled strings** — `file_ids` and every opaque `req.params` / pagination-cursor id reach Postgres as raw text with no guard, confirmed live to throw `22021`. | **Parked → Plan 2.** Real, but not a tenancy or authorization break: the effect is an unhandled 500 carrying a driver string instead of a clean 404 for a deliberately hostile id. The right fix is one shared guard at the middleware layer, not guards sprinkled per call site — which is why it was not folded into a fix wave already touching three files. **Partially closed, 2026-08-05, commit `05635d4`**: every router's path-param (`req.params`) identifiers are now guarded — 7 routers, 12 registrations, proven through real Express (see `docs/notes/file-search-tool-followups.md`'s "Small, cheap, not done" section for detail). `file_ids` arriving in request bodies and pagination-cursor query params were not in that task's scope and remain unguarded. |
| `UnsupportedBlobBackendError` surfaces as a generic 500 rather than a purpose-built status. | **Parked → Plan 2.** The message names the problem and the fix. Cosmetic. |

---

## Plan 2 (the `file_search` tool in the Responses API)

| # | Item | Why |
|---|---|---|
| 13 | `ne`/`nin` exclude rows that lack the attribute entirely (SQL `NULL` → `NOT(NULL)` → excluded) | Product decision. OpenAI arguably includes them. Document whichever is chosen. |
| 15 | ~~No deterministic `ORDER BY` tiebreaker~~ | **Done in the final fix wave.** |
| 17 | ~~`ownerEmail` unvalidated in `recallCandidates`~~ | **Done in the final fix wave.** |
| 10 | No live-probe test for the embedder | This class bit twice: `input_type` (Task 5) and the rewrite model (Task 12). Both passed every mocked test and failed on the first real request. |
| 11 | Embedder trusts `datum.index` without range/duplicate checks | A malformed response yields a sparse array whose holes bypass the dimension guard. |
| 19 | No request timeout | A partial body that never ends hangs until Node's 300 s default. Global decision, but the new upload surface makes it reachable. |
| 6 | ~~Spawned extractor children inherit the gateway's cwd~~ | **Done, 2026-08-05, commit `c4ce7d4`.** Extractor children now spawn with an explicit `cwd: os.tmpdir()`; test asserts it is both defined and `!= process.cwd()`. |
| 7 | ~~`UnsupportedFileTypeError.ext` carries the raw, unbounded extension as a public property~~ | **Done, 2026-08-05, commit `c4ce7d4`.** Zero readers of `.ext` were found, so the property was dropped entirely rather than replaced with a sanitized version. |
| 22 | ~~`purpose: 'file_search'` was inferred from fixtures, never specified~~ | **Done, 2026-08-05, commit `c4b7312`.** The inference was wrong: `file_search` is not in OpenAI's `/v1/files` enum at all (`assistants`, `assistants_output`, `batch`, `batch_output`, `fine-tune`, `fine-tune-results`, `vision`, `user_data`), and OpenAI's file-search guide uploads with `"assistants"` — so this was not a latent risk to a future client, it was a live parity break that made the feature unreachable from the OpenAI SDK. `SUPPORTED_PURPOSE` is now `'assistants'`; the rest of the enum stays rejected. Full record in `docs/notes/file-search-tool-followups.md`'s "Needs an external artefact" section. |
| 20 | ~~Unquoted `name=file` token rejected; no RFC 5987 `filename*`~~; socket reset → 500 | **Partially done, 2026-08-05, commit `91f091f`.** `parsePartHeaders` now accepts an unquoted `name` token and decodes RFC 5987 `filename*` (fails closed on a malformed or NUL-bearing value). The socket-reset → 500 half of this item was **not** addressed and remains open. |
| 24 | ~~Unguarded `ROLLBACK` in cascade `catch` blocks can mask the original error~~ | **Done, 2026-08-05, commit `a0630b5`.** Five real sites guarded (`repository.ts` `attachFile`/`deleteStoreFile`/`deleteStoreCascade`, `blobStore.ts` `retainBlob`/`releaseBlob`) — none of them were the two files the task's own brief named, which needed no change; found only by grepping every `ROLLBACK` rather than trusting the brief. Mutation-verified per site. |
| 28 | ~~`LEASE_MINUTES` interpolated rather than parameterised~~ | **Done, 2026-08-05, commit `1a900e0`.** Both sites now bind `$N::int * interval '1 minute'`; `grep -rn "interval '\${" src/` returns nothing. |
| 29 | ~~`hybrid.rerank.enabled: true` throws a statusless `Error` → generic 500~~ | **Done, 2026-08-05, commits `bbc4557`, `22a80b9`, `8085b90`.** Added `RerankerUnavailableError` (503, `file_search_unavailable`), wired it into `vectorStoresController`'s REST envelope (it previously fell through to a malformed body with the numeric status as `code`), and fixed a test-only `typeof` guard the first fix round had shipped to work around a mock that erased the class. |
| 31 | **~3 s search latency with `rewrite_query` default-on** | Confirmed sequential and unavoidable in that order: rewrite ≈1.3 s → embed ≈0.5 s → rerank ≈1.1 s. The final reviewer recommends defaulting `rewrite_query: false` and letting callers opt in. **A product call worth making before Plan 2 ships clients.** ~~Still open~~ **Done — closed before this loose-ends plan started, commit `9f96a73`** (`feat(gateway): add the file_search tool config block and default rewrite_query off`). `rewrite_query` now defaults `false`; see `docs/developer/chapter-16-file-search-tool.md`'s "`rewrite_query` now defaults off" section. Not one of Tasks 1–8's commits — noted here only so this row is not read as still open. |

## Plan 3 (~~batches~~, admin CAP app, operations)

**~~Batches~~ — done, 2026-08-05.** The four OpenAI `file_batches` endpoints shipped on branch
`worktree-file-batches`: `eab9a29` (the data-layer primitives and the derived status/counts),
`3c7802a` (a failing cleanup no longer masks the error that caused it), `63b54bf` (cooperative
cancellation in the ingest worker), `060e9a9` (create and retrieve), `723916d` (cancel and
list-files). `vector_store_files.batch_id` — in the schema since Plan 1 and, until now, never
written or read by anything — is what carries membership. `status` and `file_counts` are derived
on read rather than stored, so the worker has no second source of truth to keep in step; the
reasoning and the shipped four-column table are in `docs/superpowers/specs/2026-07-29-responses-file-search-design.md`
and in `docs/developer/chapter-16-file-search-tool.md`'s *File batches* section.
**This row is kept, struck through rather than deleted, because the record that it was open is
the point.** The remaining Plan 3 items below are untouched.

| # | Item | Why |
|---|---|---|
| 1, 2 | The `local` and `s3` blob backends: a post-commit delete race causing permanent content loss (24/300 iterations; `db` 0/300), `file_blobs.storage` written but never read back, and no axios timeout while holding a `FOR UPDATE` row lock on a `max: 10` shared pool | Currently **gated off** — `getBackend()` refuses anything but `db`. All three must be fixed before either backend is re-enabled. |
| 4 | The 64 MiB extractor output cap peaks around 190 MiB per run (~750 MiB at `ingestion.concurrency: 4`) | Real OOM risk under load; the cap is generous against a 32 MiB upload limit. |
| 18 | **The HNSW index is global, not store-partitioned** | Exact recall today, because the planner chooses a sequential scan at current volume. When it *does* choose HNSW, the ownership and attribute predicates become post-filters on an ANN scan and can under-return. Needs a partial or filtered index strategy before scale. |
| 27 | Hardcoded 2 s ingestion poll and 15 min lease | Make configurable. |

## Accept permanently

`slidingWordWindows` widening the chunker's export surface (documented as test-motivated); BOM-less UTF-16 mis-decoded (NUL is rejected downstream); Unicode bidi surviving sanitization; a dotfile literally named `.txt` treated as a `.txt`; the discovery logs omitting the `Error` parameter (pre-existing pattern shared with `getPerplexityDeploymentId`); a bad `hybrid.candidates` config value surfacing as a 400; AWS SigV4 callers being unable to use `/files` (they carry no email anywhere in this codebase — fail-safe 401); `after=` winning over `before=` when both are supplied (document only); the `'\n'` chunk separator in the content endpoint; and the Task 10 concurrent-attach race whose mapping is mutation-covered but whose true interleaving was not reproduced.

---

## One thing worth carrying into how Plans 2 and 3 are executed

**Three separate defects in this plan had the same root cause: a mutation check that exercised only one code path or one ordering.**

- Task 3 shipped a guard its own tests could not reach, because a validation call upstream made the guarded condition impossible.
- Task 11 documented a load-bearing lock as inert, because both its tests slept 60 ms and only ever exercised the delete-first ordering.
- Task 11 then documented the *other* lock as redundant, because that mutation was only run against the cascade path and not the detach path.

Six further tests across Tasks 9–12 passed under mutation because they stubbed a database return instead of asserting the query, or passed by coincidence of insert order.

The countermeasure that worked, every time: **break the defence and require a *named* test to fail — then check the test is not passing for an incidental reason.** Reviewers that attacked the code found defects that reviewers reading the code would not have.
