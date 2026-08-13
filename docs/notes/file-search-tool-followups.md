# `file_search` tool — carried follow-ups

**Written:** 2026-08-05, at the close of the tool branch (`afddc65..c636268`, 35 commits).
**Source:** the whole-branch review's triage, plus items each task review parked deliberately.

None of these block merge. Each was found, adjudicated, and carried on purpose.

---

## Needs someone with tenant access

~~**The live gate has never been run green.** `services/gateway/test/fileSearch/integration/fileSearchToolLive.test.ts`
builds its schema and fails at the first live call (`embed()` → "Failed to authenticate with
SAP AI Core") because this environment has no SAP AI Core credentials. Everything past that
point is unexercised.~~

**Fixed, 2026-08-05, commit `9b62b8a`.** That diagnosis was itself wrong about *why* it failed —
it read as a credential problem and was not one. Jest loads no `.env` (`jest.config.json` has no
`setupFiles`, and the only `dotenv/config` import is `src/index.ts`, which no test pulls in), so
`CLIENT_ID`/`CLIENT_SECRET`/`AUTH_URL`/`SAP_AI_AUTO_DISCOVER_DEPLOYMENT` were simply absent from
`process.env` and `embed()` died on "No SAP AI Core orchestration deployment available." Separately,
the test drove the engine without importing the plugin shim, so the descriptor registry was empty
and the hosted `file_search` entry was never rewritten. With both fixed, **the gate ran green on
2026-08-05 against the live tenant at `FILE_SEARCH_LIVE_GATE=reranked`, reporting `mode: "reranked"`**
— stage 2, the SAP-hosted Cohere reranker, really ran.

The gate now loads `services/gateway/.env` itself (`dotenv.config({ override: false })`, so an
explicitly exported value still wins) — you no longer need to source it in a shell, which was
unreliable anyway: `CLIENT_ID`'s value contains a `!`, which zsh splits on, leaving the credential
half-set and the failure looking like a tenant problem rather than a shell one. Run it with:

```bash
FILE_SEARCH_LIVE_GATE=reranked FILE_SEARCH_TEST_DSN=... npm test -- --testPathPattern=fileSearchToolLive
```

`FILE_SEARCH_LIVE_GATE=reranked` is stricter than "report the mode": it **requires** stage 2, so
an `'auto'` degrade to RRF-only fails rather than warns. That matters because `hybrid.rerank`
defaults to `'auto'`, and a green gate that never says which path it took can silently be
testing half the pipeline.

One sharp edge: the gate is truthiness-checked, so `FILE_SEARCH_LIVE_GATE=0` would **arm** it,
not disable it.

**Still needs tenant access to *re*-run** — a green run is not self-renewing evidence, and the
credentials are not available in every environment. `file_citation.index` semantics were separately
resolved against OpenAI's published reference on 2026-08-05 (see "Needs an external artefact"
below) — but that is documentation, and a live gate run proves only that the pipeline executes,
neither of which is a captured OpenAI `file_citation`.

## Needs an external artefact

Neither item below was a code change we could make from inside this repo — each needed an artefact
nobody on this branch had. **Both were resolved on 2026-08-05** against OpenAI's published API
reference. They are kept here rather than deleted: that they were open, for how long, and on what
evidence they were closed is the record, and the closing evidence is documentation rather than a
captured live response — which is worth knowing if either is ever re-opened.

**~~`file_citation.index` semantics.~~ RESOLVED 2026-08-05 — our reading was right.**
The original entry: `docs/superpowers/specs/2026-07-29-responses-file-search-design.md`'s parity
matrix listed `file_citation` annotations as **Approximated, UNVERIFIED** rather than Exact,
because nobody on this project had observed a real OpenAI `file_search` response carrying one, so
`index`'s exact meaning (start of the span? end?) was read off OpenAI's published documentation,
never off a captured response — this codebase's reading, set to the span start, not a confirmed
fact. The exact check recorded to close it was: capture a real response from OpenAI's own
`/v1/responses` API using the `file_search` tool with `include: ["file_search_call.results"]` and
diff the annotation object's fields against `FileCitationAnnotation` in
`services/gateway/src/plugins/fileSearch/citations.ts`.

**What was found.** OpenAI's published API reference documents exactly four fields on the
`file_citation` annotation — `type`, `index`, `file_id`, `filename` — and `index` is a character
offset into the message text, with a reference example of `"index": 992`. Our code assigns
`index = start`, which matches. The parity matrix now records `index` as verified and drops the
"no real `file_citation` has ever been observed, so `index`'s meaning is our reading" caveat.
**What is still open:** this was closed on the *published reference*, not the captured response
the check above asked for. A captured live response remains stronger evidence — it is the only
artefact that can catch a documented-but-untrue field — so if a live `file_search` response ever
becomes available, diffing it is still worth doing. `start_index`/`end_index` are unchanged and
remain an **extension**, not parity: OpenAI documents that pair on `url_citation`, not
`file_citation`.

**~~`purpose: 'file_search'`.~~ RESOLVED 2026-08-05 — the value was wrong, and it was a parity break.**
The original entry: `services/gateway/src/controllers/filesController.ts:23` set
`const SUPPORTED_PURPOSE = 'file_search'`, and the upload handler rejected any upload whose
`purpose` field did not match with `400 invalid_purpose`. That value was inferred from fixtures
during Plan 1 and had never been checked against OpenAI's documented `purpose` enum. The exact
check recorded to close it was: confirm against OpenAI's `/v1/files` documentation or a real
upload, then either keep the value with a comment recording the verification, or widen it.

**What was found.** `file_search` is **not in the enum at all.** OpenAI documents `assistants`,
`assistants_output`, `batch`, `batch_output`, `fine-tune`, `fine-tune-results`, `vision` and
`user_data` for `POST /v1/files`, and OpenAI's own file-search guide — the upload example a
developer copies — uses `purpose: "assistants"`. So a client following OpenAI's documentation,
including the OpenAI SDK, got `400 invalid_purpose` on its first call and the whole feature was
unreachable through a compliant client.

**What was done, commit `c4b7312`.** `SUPPORTED_PURPOSE` is now `'assistants'`; `file_search` is no longer accepted.
Not "accept both" — the feature is actively developed with no upstream and no consumers, so there
was no compatibility to preserve, and keeping a value OpenAI never defined would have invented a
divergence rather than closed one. The rest of the enum stays rejected with the same `400`, which
is a named deliberate gap in the design doc and remains one; `user_data` was **not** speculatively
added, and should only be added on evidence of a real client needing it.

## Worth its own branch

~~**`test/usage-tracking-integration.test.ts` is genuinely flaky at roughly 1-in-4.** Root-caused
during this work: one cause, two failures. A flaky HTTP parse error aborts the queue-limit test
before it drains `usageEmitter`'s **module-level** queue, so the next test reading that shared
queue finds 1000 undrained events. Reproduced on the pre-branch baseline as well, so it is not
this work — but the rate is high enough to bite CI.~~

**Fixed, 2026-08-05, commit `08bd04f`.** The queue-drain diagnosis above is wrong, and a later task
implemented it verbatim (`afterEach` unconditional drain) and proved it a no-op — the flake still
reproduced 3/3. The queue was already drained in `beforeEach`
(`test/usage-tracking-integration.test.ts:117-121`), and the leaked count was **723, not the
1000-event cap** an undrained queue would produce. The real cause is **unawaited in-flight
requests**: `should handle memory queue size limits` fires 1005 requests via `request(app)`, which
stands up an **ephemeral server per request**; at that concurrency the socket layer intermittently
throws (`Parse Error: Expected HTTP/, RTSP/ or ICE/`), and `Promise.all` rejects on the first
failure and abandons the other ~1004 still-running requests. Those stragglers keep completing and
pushing into the shared module-level queue for hundreds of milliseconds — straight through the
next tests' `beforeEach` drain and into their assertions. Proved with a forced mid-test rejection:
the leaked counts split across the two following tests summed to exactly 1005, every run. Fixed
with bounded batches of 25 against the suite's already-listening `server` (not `app`), awaited with
`Promise.allSettled` instead of `Promise.all`. Flake rate: 2/16 before, 0/30 after. No production
code changed.

~~**`test/fileSearch/integration/vectorStoresController.test.ts:128` compares a Node clock to a
Postgres clock.** It fails whenever the Docker VM's clock drifts behind the host (~28 ms here),
and `docker restart` does not resync it. Independent of the environment, a cross-clock
`toBeGreaterThan` can never be reliable — the assertion needs rethinking, not the container.~~

**Fixed, 2026-08-05, commit `d44fc26`.** The claim above is correct that this compares two clocks,
but for a reason that both this note and a later rebuttal of it got wrong — worth recording because
it is the kind of mistake that will be made again. The rebuttal claimed "both sides are Postgres
values" because the baseline arrives via `createStore`'s `RETURNING`. **`RETURNING` is not evidence
of a server-generated value**: `repository.ts`'s `createStore` binds a JS `new Date()` as a bind
parameter and `RETURNING` simply echoes that parameter back. So the baseline genuinely tracks the
**Node** clock, while `attachFile`'s `UPDATE vector_stores SET last_active_at = now()` tracks
**Postgres**'s. Measured live skew was +34.5 ms (Postgres ahead of the host) at fix time, against
the ~28 ms-behind figure recorded earlier — same machine, same containers, opposite sign — which is
exactly why the failure is intermittent rather than permanent. Fixed by re-stamping the baseline
from Postgres's own clock (`UPDATE ... RETURNING last_active_at`) immediately before the sleep, so
both sides read the same clock. The strict `>` was kept, not loosened, and confirmed still
load-bearing by mutation (deleting `attachFile`'s `last_active_at` update fails the test with
`received` exactly equal to `expected`).

## Deliberate, recorded so they are not rediscovered

**`ToolRequestError` carries a caller-supplied store id into logs.** Store ids are treated as
loggable identifiers throughout this feature — a decision an earlier review blessed explicitly.
Named in the `LOGGABLE_MESSAGE_CLASSES` comment so the next reader sees the choice.

**`renderResultMessage` has no length cap and needs none.** Bounded at 50 × 4096 tokens,
client-facing text the client already owns, and symmetric with `web_search`'s equivalent, which
also has no cap.

**Annotations arrive after `output_text.done`, not interleaved before it** as OpenAI does. The
gateway only learns the full text at `.done`, so emitting in OpenAI's exact position would
require buffering the whole response. Documented in chapter 16.

**Most answers anchor zero `file_citation` annotations.** Models paraphrase rather than quote,
and the anchor requires a ≥30-character verbatim sentence match. This is the expected result,
not a defect — chapter 16 says so, and anyone reading "few annotations" as a bug should read it.

## Small, cheap, not done

~~**Other routers take identifiers that reach the database without a NUL guard** —
`apiKeyRoutes`, `awsCredentialsRoutes`, `modelRoutes` and friends carry `:accessKeyId`,
`:author`, `:key`, `:model_id`, `:modelId`, `:router`, `:slug`, `:subpath` against different
tables. `router.param` guards only `:id` and `:file_id` on the two `file_search` routers. A
separate surface if NUL hardening is meant to generalise.~~

**Fixed, 2026-08-05, commit `05635d4`.** `router.param(nulByteParamGuard)` now covers every
router that declares a path-param identifier: `filesRoutes` (`:id`), `vectorStoresRoutes`
(`:id`, `:file_id`), `openRouterRoutes` (`:id`, `:author`, `:slug`), `apiKeyRoutes` (`:key`,
`:id`), `awsCredentialsRoutes` (`:accessKeyId`), `awsBedrockRoutes` (`:modelId`, `:subpath`) and
`modelRoutes` (`:model_id`) — 7 routers, 12 registrations, proven through real Express (a
malicious NUL gets 400, a clean id does not) rather than a hand-built `req` object. Note the
original enumeration above was itself slightly off: `:router` does not exist anywhere in the
codebase, and it omitted `apiKeyRoutes`'s `:id` — the reviewer's independent re-derivation is
what the fix actually covers.

~~**`expiredStoreSemantics.test.ts` has an `await` before its
`delete process.env.FILE_SEARCH_DATABASE_URL`**, where `storeAccessGuard.test.ts` deletes
first. It cannot leak cross-file under Jest's process model — each worker is its own OS process
and files run sequentially within one — but the ordering is worth tightening.~~

**Tidied, 2026-08-05, commit `d44fc26`.** Reordered to delete first, matching
`storeAccessGuard.test.ts`, with a comment recording that the two orderings were never actually
distinguishable under Jest's process model — this was cosmetic consistency, not a fix for a live
bug.

~~**The plan document still says "three annotation sites."**
`docs/superpowers/plans/2026-08-04-file-search-tool.md` records what Task 9b's plan said before
the pending-drain shape was found. There are six, and the code, `citations.ts`'s table and
chapter 16 all say six. Left as the historical record.~~

**Closed, 2026-08-05, in this same documentation pass.** `docs/superpowers/plans/2026-08-04-file-search-tool.md`
now carries a correction note at Task 9b (the `engine.ts` "three sites" line) pointing at
`citations.ts`'s six-site table and `docs/developer/chapter-16-file-search-tool.md`, rather than
being silently left to mislead a reader who does not already know the count changed. The plan's
original text is kept, per this project's convention of correcting rather than rewriting history.

**ESLint cannot run in a worktree.** `eslint.config.mjs` imports `@sap/cds`, which is not
installed there. Pre-existing and unrelated to this work, but it means lint never ran on any of
these 35 commits, or on the 9 commits of the loose-ends follow-up plan that closed the items
above (that plan's controller ran with an explicit "do not run ESLint" instruction, for the same
reason).

## The pattern worth carrying forward

**Five defects on this branch were found behind a comment asserting the thing was safe.** The
final reviewer called it "the single most reliable defect predictor on this branch":

- `assertStoreDimension` "deliberately not mirrored" — disproved live; the guard admitted a
  drifted store the search 409s on
- chunk masking "over-masks but never under-masks" — `custom_entities` under-masks
- the text-unchanged guard "makes it a caught bug" — it returns before the check
- "every error reachable from `searchVectorStores` was audited" — omitted `pg`'s `DatabaseError`
- "`JSON.stringify` escapes an embedded NUL, which is why those two are safe" — Postgres
  `jsonb` rejects the escape outright

`cli-tools/check-nul-bytes.js` now guards the last of those mechanically. The rest are a reading
habit: when a comment explains why something is safe, that is the place to test rather than
trust.
