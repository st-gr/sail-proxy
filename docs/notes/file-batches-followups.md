# Vector store file batches — carried follow-ups

**Written:** 2026-08-06, at the close of the batch branch (`c222bca..30584eb`, 8 commits).
**Source:** the whole-branch review's triage, plus items each task review parked deliberately.

None of these block merge. Each was found, verified, and carried on purpose.

---

## Pre-existing, and worse than it looks

**`ingestion.max_retries: 0` breaks every ingestion, silently.** `claimNext` calls
`reapZombies(maxRetries)`, whose predicate `attempts >= $1 AND claimed_at IS NULL` matches
**every freshly attached row** when the value is `0`; `claimNext`'s own `attempts < $1` then
matches nothing. `configService.ts:1301` reads the value with `??`, so `0` is honoured verbatim
with no clamping — and `0` is exactly how an operator writes "do not retry".

Reproduced live during Task 5, three fresh files:

```
claimNext() -> null
extractText calls: 0    embed calls: 0
rows: all three status="failed", attempts=0, last_error.name="MaxRetriesExceededZombie"
batch: status "completed", file_counts {failed:3, total:3}
```

So an SDK `createAndPoll` returns *successfully* over a store with zero content.

Confirmed pre-existing: `reapZombies`, its predicate and `claimNext`'s filter all exist unchanged
at `c222bca`. Batches make it **more visible**, not more likely. Fix: clamp to `Math.max(1, …)` at
`configService.ts:1301`, or reject `< 1` at config load. Needs its own test.

## A parity gap, small but incoherent

**`/vector_stores` is not mounted on the OpenRouter prefix.** `index.ts:143-144` mounts it on
`/openai/v1` and `/openai/api/v1` only. `/files` *is* additionally available there, because
`openRouterRoutes.ts:50-54` re-declares the five Files paths.

The consequence is sharper than "one prefix is incomplete": `/responses` **is** on all three
prefixes, so a client on the OpenRouter base URL can upload a file and invoke the `file_search`
tool, but cannot create or manage the vector store that tool needs. The surface is incoherent
rather than merely partial.

It is a routing addition, not a behaviour change. Two caveats for whoever takes it:

- the OpenRouter copies run a **different** auth and rate-limit chain, and
- they sit outside the app-level `nulByteGuard`, which is mounted only on the four `/openai/...`
  prefixes (`index.ts:132-136`). So `/openrouter/api/v1/files` already has unguarded NUL bytes in
  `?after` / `?before` and in body fields; `:id` is still guarded via `openRouterRoutes.ts:23`.
  "Just add the mount" would inherit that gap.

## Cheap, deliberately not done at merge time

**The keyset WHERE-clause is duplicated** between `listVectorStoreFiles`
(`vectorStoresController.ts:927-944`) and `listBatchFiles` (`batches.ts:393-410`).

The ledger originally called this a one-line fix. **It is not.** Making `batchId` nullable requires
`($2::text IS NULL OR batch_id = $2)` in **two** statements, which changes index selection on the
hot store-level file list — `idx_vsf_batch` is `(store_id, batch_id)`. That is a query-plan change
to a shipped endpoint, and it was declined at merge time rather than on merit.

The riskier half is already unified: `sendStoreFilePage` is the only place either endpoint builds
`has_more` / `first_id` / `last_id` / the `before` reversal / the empty page, and a test asserts
both endpoints' **full response bodies** are deep-equal, including backwards paging. The residual
risk is drift in a 12-line query builder whose output that test covers — it fails the moment they
diverge. The review confirmed no divergence exists today.

## Verified during this branch, recorded so it is not re-derived

**The cancel endpoint does not return `cancelled`, and that is correct.** `requestBatchCancel` sets
a flag; member rows only flip when a worker next reaches its between-files check. So immediately
after a successful cancel the batch derives `in_progress`. Asserting `cancelled` there would be
asserting a lie, and OpenAI's cancel is likewise a request rather than a completion.

**Cancellation is cooperative — checked between files, never mid-file.** A file already past
`claimNext` runs to completion. Interrupting mid-embed would leave chunks partially written, and
the transaction that commits them is what keeps the store consistent.

**A rejected design that would have looked correct.** Making `claimNext` skip cancelled batches with
a `NOT EXISTS(cancel_requested)` predicate strands the members `in_progress` **forever** — the batch
never reaches a terminal state and `createAndPoll` never stops polling. Something must *reach* those
rows to mark them cancelled.

## The pattern, now at six

Six defects across this feature have been found sitting behind a comment or document asserting the
thing was safe. This branch produced the fifth and sixth:

- `discardPartialBatch`'s doc comment said **"NEVER THROWS"** — `pool.connect()` sat outside the
  `try` and `release()` was unguarded, so a cleanup failure replaced the original error. The scenario
  that matters is the one where they coincide: the attach fails *because* the pool is saturated,
  which is exactly when the cleanup's own `connect()` fails too.
- `chapter-16`'s batch section claimed attachment is "all-or-nothing … a client never has to reason
  about a half-attached batch", while `batches.ts:179-180` was honest that a failed cleanup leaves an
  orphaned batch. The code was truthful; the documentation was not.

When a comment explains why something is safe, that is the place to test rather than trust.
