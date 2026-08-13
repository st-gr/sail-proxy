# Reranker teacher-logging — carried follow-ups

Deferred items from the five-task teacher-logging branch (`47d276f..195bf5d`).
None block merge. Each was found by review, adjudicated, and deliberately carried
rather than fixed in a final fix wave. Recorded here so they are not lost.

## 1. `applySchemaLocked()` sends the whole schema as one transaction

`services/gateway/src/fileSearch/db.ts`

`buildSchemaSql()` is applied as a single multi-statement query in one
transaction. On an install where the schema exists but the gateway role does
not own the pre-existing tables — schema created by `postgres`, gateway
connecting as `gateway` — re-application aborts at `idx_fs_files_owner`
(`schema.sql.ts:28`) with `42501`, long before the reranker tables at `:77`
and `:110`. The whole statement rolls back, so that install never receives the
two new tables automatically; it gets a warn telling a human to run
`cli-tools/file-search-migrate.js`.

This is avoidable. That role provably *can* create brand-new tables and index
them (verified live on PG 16.14), and the only foreign key
(`reranker_candidate_labels.event_id → reranker_search_events(id)`) is between
the two new tables, both of which it would own. A savepoint-per-statement
application would deliver them without operator action.

Not done here because it changes migration transaction semantics, which is not
a final-fix-wave change.

## 2. `missingSchemaTables()` probes tables only

`services/gateway/src/fileSearch/db.ts`

The post-DDL completeness probe checks for tables, not columns, indexes or
constraints. A future schema addition that is index-only or column-only, and
that fails with `42501` on the non-owner install shape, leaves every table
present and is therefore reported at `info`. The `42501` gate added in
`195bf5d` removes the silent-failure mode for every *other* error class;
follow-up 1 is the real fix for this residual case.

## 3. `chunk_tokens` is always NULL

`services/gateway/src/fileSearch/teacherLogger.ts`

The column ships permanently NULL and `docs/developer/chapter-15-reranker-datasets.md`
documents it as reserved. The data is one column away: `vector_store_chunks.tokens`
already exists (`schema.sql.ts:67`), so populating it means widening the recall
SELECT list — the same tenant-isolation boundary Task 1 already proved safe to
widen (the `FROM … LIMIT` region hashed byte-identical before and after).

Kept rather than dropped: removing it now would only mean a second migration to
re-add.

## 4. Zero-candidate searches are not logged

`services/gateway/src/fileSearch/search.ts`

The empty-recall early return precedes `teacherLogger.record()`, so a query that
recalls nothing produces no event row at all. Deliberate, tested, and documented
in chapter 15 §1 — an analyst computing a recall-failure rate from these tables
must know events exist only for searches that recalled at least one candidate.

Revisit if recall failures become something the dataset should measure.

## 5. `getTeacherLoggingConfig()`'s fallback arm has no committed test

`services/gateway/src/services/configService.ts`

`api_config.json` always ships the full `teacher_logging` block, and the
accessor's `??` reads the file value first — so mutating a default does not
fail any test. The fallback arm is exactly what an *upgrading* install hits,
since its existing `api_config.json` has no such block.

Behaviour was verified directly during the final review (deleting the whole
block yields `{enabled: false, storeChunkText: false, sampleRate: 1, source:
'production', maxConcurrentWrites: 2}`), and it mirrors a pre-existing gap in
`getFileSearchConfig`'s own test. A committed guard would be better.

## 6. The teacher-logging suite cannot reach recall's tenant boundary

`services/gateway/test/fileSearch/integration/teacherLogging.test.ts`

`search.ts` throws `SearchStoreNotFoundError` from an ownership pre-check that
runs before `recallCandidates`, so the logger is never reached on the
foreign-store path. Neutralizing recall's own ownership predicate leaves that
suite fully green.

The boundary *is* proven — by two named tests in
`integration/hybridSearch.test.ts`, which the teacher-logging test names in a
comment. **Do not delete those two tests.** Nothing in the teacher-logging
suite would notice.

## 7. No `failed` counter in `__statsForTests()`

`services/gateway/src/fileSearch/teacherLogger.ts`

The mid-transaction-failure test waits on the logger's `disabled` flag, which
couples it to the `42501`/`42P01` self-disable list. A `failed` counter would
let it wait on "a write failed" instead. Declined: adding a production
affordance for a test signal, when today's failure mode is a loud timeout
rather than a false pass.

## 8. `createFreshDatabase` duplicated across two test files

`migration.test.ts` carries a near-verbatim copy of the helper from
`restrictedRuntimeRole.test.ts`, minus an explanatory comment and a returned
field. The two can drift.
