# Orchestration cache-probe fixtures

These files were captured from a **live SAP orchestration deployment**, not
synthesized. `cache-probe-result.md` records the verbatim `usage` objects
returned by two real, paid calls to the gateway's
`POST /openai/v1/chat/completions`, made against a non-`--deployed` Anthropic
model in the orchestration catalogue (`anthropic--claude-4.8-opus` at capture
time).

`bridge-cache-probe.sh` / `bridge-cache-probe-result.md` are a SEPARATE,
later probe of a different endpoint: `POST /openai/v1/responses` through the
same orchestration bridge (`responsesController.ts`'s
`dispatchOrchestration`). That endpoint's usage arithmetic
(`recordOrchestrationUsage`) had been built around a live capture that looked
INCLUSIVE (`prompt_tokens` already containing the cached tokens) — the
opposite of what `cache-probe-result.md` above found on
`/chat/completions`. `bridge-cache-probe-result.md` tests the leading
hypothesis for why the two endpoints disagreed: `requestTranslator.ts` puts
the same system message into BOTH `prompt.template` and `messages_history`,
and only the `messages_history` copy gets a cache breakpoint — four arms (one
baseline, three temp source edits reverted after capture) on the SAME model
established that de-duplicating the system message flips the `/responses`
endpoint's accounting to the same exclusive shape `/chat/completions`
already showed. See that file for the full per-arm data and verdict.

SAP's documentation states that cache activity is reported on
`usage.prompt_tokens_details`, but it does not name the fields inside that
object, and it does not say whether orchestration forwards a `cache_control`
breakpoint through to Anthropic or strips it. This directory exists to answer
both questions with a real measurement instead of a guess.

**No field name in this directory may be guessed, assumed from Anthropic's
direct-API docs, or filled in for convenience.** Every field name recorded
here was read off an actual JSON response body. If a re-capture ever shows
different field names, this directory must be updated to match — do not
reconcile the discrepancy by editing toward what "should" be there.

## How to re-capture

The full probe is one command: `cache-probe.sh` in this directory. It is the
actual script used to capture the results in `cache-probe-result.md` — not a
paraphrase of it.

1. Confirm the gateway is running locally and reachable at
   `http://127.0.0.1:3000` (health check: `GET /health`).
2. Confirm the target model is still served:
   `curl -s --noproxy '*' -H "Authorization: Bearer $K" \
   http://127.0.0.1:3000/openai/v1/models`
   and set `MODEL=<entry>` when running the script if the previously-used one
   (`anthropic--claude-4.8-opus`) is gone. Pick any non-`--deployed`
   Anthropic entry.
3. Run `bash services/gateway/test/fixtures/orchestration/cache-probe.sh`.
   It reads the gateway API key out of `~/.zshrc` itself (the
   `ANTHROPIC_AUTH_TOKEN` value, pattern `sk-ant-api03-[A-Za-z0-9_-]*`) via
   `grep -o` into a shell variable — it is never printed, logged, or written
   to a file. **This script never contains a key value; if you edit it, keep
   it that way.**
   - Default (`PREFIX_STYLE=narrative` or unset): the original prefix text.
     This is what produced the recorded result, but it happened to trip a
     content filter on this deployment (`finish_reason: "content_filter"`,
     empty `content`) even though `usage` still came back complete.
   - `PREFIX_STYLE=neutral bash cache-probe.sh`: inert Lorem-ipsum filler
     instead, which reliably returns a clean `finish_reason: "stop"` with
     real content. Use this if you want a non-filtered response as well as
     the cache numbers — this variant is what was used to confirm the cache
     field names are not an artifact of the content-filter condition.
4. The script prints each run's `usage`, `finish_reason`, and `content` to
   stdout. Do not touch or transform the JSON — copy the `usage` object into
   `cache-probe-result.md` verbatim, record the model actually used, the
   date, the HTTP status of each call, and state one of the three possible
   verdicts explicitly (forwarded and honored / accepted but not honored or
   stripped / rejected with a 400).

This is a paid, real-tenant probe. Do not loop it or run it more than the two
calls needed to answer the question — re-run only when the answer is actually
in doubt (e.g. before Task 6 ships, or if SAP changes orchestration behavior).

## How to re-capture the bridge probe (`bridge-cache-probe.sh`)

Four arms, one baseline and three requiring a manual temp source edit — the
edit instructions live as comments at the top of `bridge-cache-probe.sh`
itself, not here, since they name exact line ranges in files that drift.

1. Confirm the gateway is running locally and reachable at
   `http://127.0.0.1:3000`, and that `PAYLOAD_LOGGING_ENABLED=true` is in
   effect (`services/gateway/.env` at capture time) — the script attributes
   every arm from `services/gateway/logs/payloads/*_02_..._to_orchestration`
   and `*_03_..._from_orchestration` files, not from what the edit was
   *intended* to do.
2. `ARM=A0 bash services/gateway/test/fixtures/orchestration/bridge-cache-probe.sh`
   needs no source edit — it exercises the code as shipped.
3. For `ARM=A1`, `ARM=A2`, `ARM=A3`: apply that arm's temp edit (see the
   script's header), `touch services/gateway/src/index.ts`, and wait until
   the SAME nodemon-restarted pid answers `/health` 200 three times in a row
   before running the script for that arm. Revert the edit — and repeat the
   same restart-and-3x-health wait on the revert — before starting the next
   arm's edit.
4. Copy each arm's wire attribution and both runs' raw + client-visible
   `usage` objects into `bridge-cache-probe-result.md` verbatim, exactly as
   the script prints them (it reads them back out of the payload-log
   captures, not out of its own request-building code, specifically so the
   record reflects what went over the wire).
5. Once all four arms are captured and every temp edit is reverted, confirm
   `git diff --stat services/gateway/src` is empty before committing.

Budget for arms A0-A3: 8 paid calls total (2 per arm × 4 arms). Do not loop
beyond that; a failed call may be retried once. Re-run only when the question
is genuinely back in doubt (e.g. after the de-dup fix this probe recommended
actually ships, to confirm the re-derived arithmetic against a fresh
capture).

**Directory-wide running total: 10 paid calls** (the 8 above, plus B4's 2 —
see below; B4's haiku negative-control attempt was rejected pre-orchestration
by a model-eligibility gate and cost nothing, and closing the post-review
config-staleness gap used a free, non-Anthropic-billed `/openai/v1/models`
call, also not counted here).

## `ARM=B4` — proving the default tier, not a config flag, engages caching

A fifth arm, added for task B4, needs no temp source edit either — it exercises
the shipped `resolvePromptCachingSupport` default tier
(`src/utils/promptCachingSupport.ts`) against a config that has been pruned of
every Anthropic `supports_prompt_caching` flag except one explicit `false`.
Two script parameters exist only for this arm (defaulted for A0-A3 to match
their original behavior, so re-running those arms needs no change):

- `REPEAT` (default 300): how many times the arm's filler sentence repeats to
  build the prefix. B4/B4NEG pass a smaller value to land the prefix in a
  specific char count rather than A0-A3's ~34.5k-40.5k.
- `CALLS` (default 2): how many sequential identical calls to make. B4NEG
  passes 1 — a negative control only needs to confirm the wire marker is
  absent, not measure the cache write/read economics.

`ARM=B4 MODEL=anthropic--claude-4.8-opus REPEAT=78 CALLS=2 bash
services/gateway/test/fixtures/orchestration/bridge-cache-probe.sh` — before
running, confirm the target config genuinely lacks the flag (both the repo's
`api_config.json` and, since that file is not necessarily what the live
non-standalone gateway is running, the admin service's own active config —
`curl http://localhost:4004/odata/v4/validation/getConfig()` is unauthenticated
in dev and returns it directly). See `bridge-cache-probe-result.md`'s B4
section for the full precondition-check writeup, the hand-computed prediction
recorded *before* the calls, and why the negative control
(`ARM=B4NEG MODEL=anthropic--claude-3-haiku--deployed REPEAT=78 CALLS=1`) came
back HTTP 400 on this route (a model-eligibility gate unrelated to caching)
and was answered by code inspection instead of a live call.
