# `file_search` follow-ups — what is left after Tasks 5, 7, 8 and 9

**Superseded 2026-08-06.** This file previously listed Tasks 5–8 as open. Four of the five remaining
tasks have since shipped on `worktree-followups-tail`. What follows is the state after that branch.

**Verified at `14b4bfd`.** Every line number in the *previous* two generations of these notes had gone
stale before anyone read them, and one recorded item turned out to be simply false. Re-check before
editing.

---

## Shipped

| Task | Commit | What |
|---|---|---|
| 1 | `678535d` | `ingestion.max_retries` clamped — `0` silently disabled all ingestion |
| 2 | `e62053b` | six no-op `ROLLBACK`s guarded |
| 3 | `4ced9db` | `/vector_stores` on the OpenRouter prefix, and that prefix under the NUL guard |
| 4 | `4c42152` | one keyset builder for both file-list endpoints |
| 5 | `a9ad2cb` | savepoint per schema statement |
| 7 | `6440941` | store and file timestamps from the database clock, and the keyset cursor precision fix it exposed |
| 8 | `14b4bfd` | teacher-logging `failed` counter, config fallback pinned, db fixture de-duplicated |
| 9 | `cb6a030` | one vector-store route table, all six NUL-guard prefixes pinned |

---

## Task 6 — RESOLVED, but not as the plan described

**Fixed in `0f71610`.** The intermittent `Test suite failed to run: Connection is closed.` came from a
single discarded promise in a test:

```ts
// test/integration/valkeyDistributedCacheAdapter.test.ts
await expect(async () => {
  await testAdapter.set(testKey, testEntry, 60);
}).not.toThrow();
```

`toThrow` invokes the function and **discards** the promise it returns — the outer `await` applies to
`expect()`'s own result. So `set()` kept running unawaited against `redis://invalid-host:6379`, past
the end of the test. When that socket closed, iovalkey's close handler called
`flushQueue(new Error('Connection is closed'))`; `establishConnection` rethrew, `set()` rethrew, and
nothing held the promise. **Jest attributes an unhandled rejection to whichever suite is LOADING in
that worker**, which is why the failure never appeared anywhere near its cause — five different
innocent files were hit (`token-count-service`, `docker-manifest-sync`, `rrf`,
`responses-namespace-tools-plugin`, one unidentified), always with every test passing.

The assertion was vacuous too: an async function never throws synchronously, so `.not.toThrow()`
could never fail. It now reads `await expect(...).rejects.toThrow()`.

**Verified: 416 consecutive full-suite runs, zero occurrences**, against a pre-fix rate that hit at
run 3 and run 10 and in 4 of 12 probe runs.

### Three corrections to what the earlier version of this note claimed

1. **"The plan's premise is DISPROVED" was too strong.** The plan named three supertest suites. They
   were not the cause of *this* failure — but two of them do flake on their own, which only showed up
   after far more runs than the 30 that produced the original "cannot reproduce" verdict. See below.
2. **The first diagnosis — an iovalkey client with no `'error'` listener — was wrong.** Line 189 of
   `event_handler.js` is `close()` → `flushQueue(...)`, which *rejects pending command promises*. It
   never emits `'error'`. A listener could not have fixed it, and adding one did not: the flake
   recurred at run 10 of a 250-run verification.
3. **The second diagnosis was wrong too**, and for an instructive reason. The probe that produced it
   attached a `.catch` to every command promise — which marks the rejection *handled*, so it reported
   handled rejections as suspects. It fingered `valkey-model-storage.integration.test.ts:157`, which
   uses `.rejects` and was always correct. **A probe that suppresses the thing it measures cannot
   identify it.** The rebuilt probe tagged promises via a WeakMap without catching them.

### The other flakes — also fixed (`5ab59c6`)

Seven suites called supertest as `request(app)`, which stands up an **ephemeral server per call** and
tears it down when the response completes. Under `forceExit: true` with workers competing for cores,
that teardown races the response still being written. Two signatures, one mechanism:

| Signature | What it is |
|---|---|
| `Parse Error: Expected HTTP/, RTSP/ or ICE/` | the parser reading something that is not a response |
| `socket hang up` | the socket gone before any of it arrived |

Each lands on a passing assertion in a suite that is otherwise fine, which is why they read as
unrelated. Measured at **7 / 160 runs unloaded** and **5 / 124 under CPU contention**; after the fix,
**182 consecutive runs with zero failures**, including 36 under that same load.

| Suite | Sites | In the plan's three? |
|---|---|---|
| `test/integration/aws-credentials-api.test.ts` | 30 | yes — had no server at all |
| `test/multi-provider-usage-tracking.test.ts` | 21 | no — created a server, then sent every request to `app` |
| `test/usage-tracking-integration.test.ts` | 14 | no — same, and its notes claim it was already fixed |
| `test/openRouterVectorStores.test.ts` | 14 | no |
| `test/integration/service-key-auth.test.ts` | 12 | yes — per-test server, it rebuilds its app in `beforeEach` |
| `test/nul-byte-guard.test.ts` | 8 | no |
| `test/nul-byte-guard-routers.test.ts` | 2 | yes |

**The plan's fix was right; its list was not.** It named three suites, and four more had the identical
shape. Two of those four *looked* like they already had a persistent server — one match was the phrase
`app.listen()` inside a comment, and the other genuinely called `app.listen(0)` but then never used
the result. Grep for `request(app)`, not for `.listen(`.

Where a `listen(0)` already existed it is now awaited. `server = app.listen(0)` without waiting for
the callback lets a request be issued before the socket is listening — the same race, smaller window.

**Method note worth keeping.** These are contention-sensitive: the same tree gave 7/160 while other
work was running and 0/120 while idle. Reproducing them reliably meant running the suite against
deliberate CPU load, and any "could not reproduce" verdict from a quiet machine means very little.
---

## Carried from this branch

### `runPrivilegedMigration` still applies the schema as one statement

`db.ts`'s `applySchemaLocked` now applies the schema statement-by-statement under savepoints, but
`runPrivilegedMigration` (the `FILE_SEARCH_MIGRATION_DATABASE_URL` path) still sends
`buildSchemaSql()` as a single multi-statement query. Left alone deliberately — that path uses the
owner credential, where the ownership rejection cannot arise, and it is fatal-on-failure either way —
but the two paths now differ, and the difference is not obvious from either call site.

### Savepoints do not rescue every stranded addition

Pinned by `migrationSavepoints.test.ts`, and worth knowing before someone assumes otherwise: a new
table whose FOREIGN KEY targets a table the gateway role does not own still cannot be created, because
that needs a privilege on the referenced table. `vector_store_batches` REFERENCES `vector_stores` and
is exactly this case. The deploy step remains the answer for that shape. FK-free additions — the
reranker pair — now land on their own.

### `fs_files.created_at` is still written from the application clock

`filesController.ts` binds a JS `createdAt` when inserting into `fs_files`, while `vector_stores` and
`vector_store_files` now use `now()`. Harmless today, and the cursor that reads it is precision-safe
either way after `6440941` — but it means that endpoint's cursor fix is currently defensive rather
than load-bearing, and the one-clock argument in `repository.ts` does not yet hold across the whole
schema.

### The Files routes are still a hand-maintained second copy

Task 9 unified the 16 vector-store routes into `src/routes/vectorStoreRouteTable.ts`, registered by
both `vectorStoresRoutes.ts` and `openRouterRoutes.ts`. The 5 `/files` routes in `openRouterRoutes.ts`
are still duplicated from `filesRoutes.ts` by hand, with the same latent drift: a route added to one
does not reach the other and nothing fails. The same registrar pattern applies.

---

## Test-harness facts worth not rediscovering

These each cost real time on this branch.

- **`jest.config.json` sets `restoreMocks: true`.** A `jest.spyOn` established in `beforeAll` is wiped
  before each test runs, so the test silently exercises the real thing. Put spies in `beforeEach`.
- **`jest.spyOn(configService, 'getConfig')` does not intercept `getTeacherLoggingConfig`** — or any
  other accessor in that module. They call the module-local binding, not the export. Nor can
  `fs.existsSync` be spied (`TypeError: Cannot redefine property`). The way in is
  `process.env.CONFIG_FILE_PATH` pointed at a temp file plus `jest.resetModules()` and a re-`require`.
- **A `jest.mock` factory that enumerates only the export it overrides turns every other export of
  that module into `undefined`.** `migrationUpgrade.test.ts` mocked `schema.sql` for `buildSchemaSql`
  alone; when `db.ts` gained a second import from that module, three tests failed with a message
  blaming the DDL. Spread `...jest.requireActual(...)`.
- **Never restore a mutation with `git checkout -- <file>` while your own work in that file is
  uncommitted** — it takes the fix with the mutation. Restore with an editor. The one safe use is when
  you have confirmed via `git status` that the mangling is the *only* uncommitted change in exactly
  those paths.
- **Backticks in a commit message written through a bash heredoc are shell-substituted.** Two words
  vanished from a commit body this way. Use `git commit -F <file>`.
