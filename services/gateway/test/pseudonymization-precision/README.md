# Pseudonymization precision/recall harness

Spec: `docs/superpowers/specs/2026-08-25-pseudonymization-precision-design.md`, "Evaluation
harness" row. Task brief:
`.superpowers/sdd/2026-08-25-pseudonymization-precision/task-4-brief.md`.

This is the regression gate for the pseudonymization detectors. It answers one question on
every change: did this make masking *worse* — either by masking machinery that isn't PII
(precision), or by missing PII that used to be caught (recall)? CI runs it via
`pnpm run test:pseudonymization` (Phase 4, `ci/ci-pipeline.js`).

## Files

| File | What it is |
|---|---|
| `corpus.ts` | The labelled corpus — three sets (`technical`, `prose`, `mixed`), each a list of `{ text, labels }` documents. `labels` are the spans that SHOULD be masked. |
| `scorer.ts` | Turns a corpus set's labels + a detector's predictions into precision/recall/F1, overall and per entity type. No dependency on the plugin — see its doc comment for why that matters. |
| `precision.test.ts` | The gate: runs `corpus.ts` through the shipped `detectEntities`, scores it with `scorer.ts`, asserts thresholds. |

## What each set is for

- **`technical`** — SAP/BW object names, SQL, JSON, logs, paths, code fences: the machinery
  the 2026-08-25 incident's request was built from. Scored for **precision** (`>= 0.9`,
  asserted absolutely; must also beat the recorded baseline — see below). A few documents in
  this set carry real PII too (a name in a quoted SQL literal, an email in a JSON payload),
  so the ratio is meaningful rather than division by zero.
- **`prose`** — names, emails, phones, credentials as they appear in ordinary requests:
  sentences, tables, CSV, bullets, signatures, chat, a saturated 41-name roster. Scored for
  **recall** (must not fall below the recorded baseline).
- **`mixed`** — the incident's own shape: technical noise with a small number of real people
  in it. Used for the combined check and the wall-time budget.

## Two label policies (read before adding a case)

1. **Label a span even when the shipped detector is known to miss it**, if it is genuinely
   someone's personal data — a name inside a code fence, a path, or split by a double space.
   A miss like that costs **recall only**, never precision, so labelling it honestly
   documents the gap instead of hiding it by leaving the case out. Every such case in
   `corpus.ts` carries a `note` explaining why it is expected to miss, so a green run and a
   documented defect can both be true at once.
2. **Never label a Title-Case product name or an ordinary noun phrase as PII**, even on the
   cases where today's detector masks it anyway (`Watson Studio`, `Redis Sentinel`,
   `Data Transfer Process`). That is a real precision cost, and the coordinator's instruction
   was to record it honestly rather than curate the corpus to hide it. Leaving the label out
   means the detector's mask on it counts as a false positive, which is the correct scoring.

## Baseline: how `30747f6`'s numbers were produced

The brief's method, precisely, and *not* automated — the entire point of "temp dir outside
the repo" is that this code must never land in the tree, not even transiently.

```bash
# 1. Copy every pseudonymization source file at 30747f6 into a temp dir OUTSIDE the repo.
#    Never `git stash`, never `git checkout` — `git show` only.
SCRATCH=/path/outside/this/repo/baseline-30747f6
mkdir -p "$SCRATCH/src/plugins/pseudonymization"
for f in $(git ls-tree -r 30747f6 --name-only -- services/gateway/src/plugins/pseudonymization); do
  rel=${f#services/gateway/src/plugins/pseudonymization/}
  mkdir -p "$(dirname "$SCRATCH/src/plugins/pseudonymization/$rel")"
  git show 30747f6:"$f" > "$SCRATCH/src/plugins/pseudonymization/$rel"
done

# 2. Copy corpus.ts and scorer.ts in UNMODIFIED. Both are dependency-free of the plugin
#    (see scorer.ts's doc comment), which is what lets the same two files score both
#    30747f6's output and HEAD's.
cp test/pseudonymization-precision/corpus.ts test/pseudonymization-precision/scorer.ts "$SCRATCH/"

# 3. The old detectors/index.ts chain pulls in exactly one workspace import,
#    `@libs/logger` (via entityToggles.ts). It is a TS path alias (tsconfig "paths"),
#    not a real npm package, so a plain `require` needs a symlink:
mkdir -p "$SCRATCH/node_modules/@libs"
ln -sfn /absolute/path/to/repo/libs/dist/logger "$SCRATCH/node_modules/@libs/logger"

# 4. Write a driver.ts that imports detectEntities + DEFAULT_MASKING_CONFIG (from the copied
#    src/), the three corpus sets, and scoreSet; runs each set through detectEntities; prints
#    the scores as JSON; times detectEntities on INCIDENT_SHAPED_TEXT (warm-up, then best of
#    20). Run it with wink-nlp resolved from the real gateway package:

cd "$SCRATCH"
NODE_PATH="/absolute/path/to/repo/services/gateway/node_modules:/absolute/path/to/repo/node_modules" \
  npx --prefix /absolute/path/to/repo/services/gateway ts-node --transpile-only \
  -O '{"module":"commonjs","target":"es2020","moduleResolution":"node","esModuleInterop":true,"skipLibCheck":true,"resolveJsonModule":true,"strict":false}' \
  driver.ts
```

(`-O` sidesteps the gateway's own `tsconfig.json`, which sets `moduleResolution: "NodeNext"`
— a setting `ts-node --transpile-only` cannot combine with `module: "commonjs"` — and it has
no reason to see the workspace's `paths` alias anyway, since step 3 already resolved the one
import that needed it.)

The numbers this produced on 2026-08-24 are recorded as commented constants at the top of
`precision.test.ts` (`BASELINE_TECHNICAL_PRECISION`, `BASELINE_PROSE_RECALL`,
`BASELINE_MIXED_WALL_TIME_MS`), each naming the revision and the date. They are not
recomputed at test time — CI has no access to the temp dir, and should not: the baseline is
frozen precisely so it cannot silently drift with the code it is there to be compared
against.

## Adding a case

1. Add a `const` holding the text, then a `CorpusCase` entry in the right set's `cases`
   array, using the `at(text, value, type[, occurrence])` helper to compute label offsets —
   don't hand-count character positions. `occurrence` picks the Nth match when a value
   appears more than once in the same text.
2. Decide: is every span you're about to label genuinely PII? If the detector is known to
   miss it, label it anyway and add a `note` saying why (see label policy 1). If it's a
   product name, a business phrase, or anything else that only *looks* like a person, leave
   it unlabelled — a detector mask on it will correctly count as a false positive.
3. Run `pnpm run test:pseudonymization` (or `--testPathPattern=pseudonymization-precision`
   for just this harness) and read the failure — see below.
4. If the case moves an asserted number in `precision.test.ts` (technical precision below
   0.9, prose recall below the baseline, mixed set no longer exactly 5/5), that is either a
   real regression to go fix in the detectors, or a deliberate, known trade-off that belongs
   in the task report and possibly a re-baseline (see below) — not a silent edit to the
   threshold.

## Reading a failure

- **`technical-set precision` — `meets the absolute floor`**: some technical-set document is
  masking more machinery than the corpus's real PII can absorb. Run just that test, then
  find which case regressed by comparing `detectEntities(case.text, DEFAULT_MASKING_CONFIG)`
  against the case's `labels` — anything predicted that isn't a label is the new false
  positive.
- **`technical-set precision` — `beats the 30747f6 baseline`**: precision dropped below what
  the code looked like *before* this plan's fixes. Treat this as a serious regression — it
  means the detectors have moved backward toward the incident's own behaviour.
- **`prose-set recall` — `does not fall below the 30747f6 baseline`**: some prose-set label
  that used to be found no longer is. Check whether a detector, the technical-context veto,
  or a confidence adjustment changed underneath it.
- **`still carries the three documented residual false positives, honestly`**: this test
  fails in the GOOD direction if `Watson Studio`, `today`, or `Redis Sentinel` stop masking —
  which means one of the three known defects got fixed. See "Re-baselining deliberately"
  below; don't just delete the assertion.
- **`the NER entity tier — reachability`**: if this fails, the wink-nlp entity tier started
  firing — almost certainly because the shipped model changed (a `wink-eng-lite-web-model`
  upgrade, or a switch to a fuller model). That is exactly the change this test exists to
  surface: re-run the whole harness, expect precision and recall to move, and re-baseline the
  *harness's own* numbers, not `30747f6`'s.
- **`saturation stability`**: if the masked SET differs between saturation bars, something
  reintroduced a saturation-based confidence penalty (the cliff task 2's fix round 3
  removed). This must never happen; see `saturationReport.ts`'s and `confidenceScores.ts`'s
  doc comments.
- **wall time**: if this fails and the ratio (log it locally — the test only asserts the
  final comparison) is genuinely > 2x on repeat runs, look at what changed in
  `detectors/index.ts`'s pipeline. If it's a slow CI runner with a comfortable local ratio,
  `WALL_TIME_ABSOLUTE_FLOOR_MS` in `precision.test.ts` already accounts for that — see its
  comment before assuming hardware noise.

## Re-baselining deliberately

The `30747f6` baseline constants and the "three documented residual false positives" test
exist to be beaten, not frozen forever. Re-baseline when, and only when, a change is
*intentional* and reviewed — never as a way to make a red test green without understanding
why it went red:

- **A detector fix removes one of the three residual false positives** (`Watson Studio`,
  `today`-as-driver-licence, `Redis Sentinel`): move the case's label from "not PII" to
  "PII" is wrong — the values still aren't PII. Instead delete the now-passing assertion in
  `still carries the three documented residual false positives, honestly`, and delete the
  case's `note` explaining the miss. Precision goes up; no new baseline numbers are needed
  since `BASELINE_TECHNICAL_PRECISION` is a floor, not a target.
- **A detector fix closes a documented recall gap** (the double-space case, the fenced/path
  name cases): the label was already there. Delete the case's `note` — the miss is now a
  hit, and the harness needs no further change; recall only goes up.
- **The wink-nlp model changes and the entity tier becomes reachable**: re-run the NER
  reachability test; when it fails as described above, update it to reflect the new
  behaviour (it may need to become a *positive* assertion, that the tier now fires) and
  re-run the baseline procedure to get fresh precision/recall numbers, since the detector
  that just changed is exactly the one the corpus measures.
- **The corpus itself grows** (more cases, more coverage): re-run the baseline procedure
  above against `30747f6` on the *new* corpus, and replace the `BASELINE_*` constants with
  the new run's numbers, updating the comment's date. Do not compare a bigger HEAD corpus
  against baseline numbers measured on a smaller one — the ratio is meaningless. Then also
  regenerate the numbers in `.superpowers/sdd/2026-08-25-pseudonymization-precision/task-4-report.md` describing this task's work — or wherever this project's task-4 report next records
  them, if it's been moved.
