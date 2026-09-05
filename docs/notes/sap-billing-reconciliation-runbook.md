# SAP billing reconciliation — run procedure

Operational runbook for the reconciliation inference profile. Design and rationale:
[`docs/superpowers/specs/2026-08-31-sap-billing-reconciliation-inference-profile-design.md`](../superpowers/specs/2026-08-31-sap-billing-reconciliation-inference-profile-design.md).
Tools: `cli-tools/sail-recon-profile.js` (runner), `cli-tools/sail-recon-report.js` (reporter).

## Purpose & when to run

The SAP AI Core portal bills one monthly aggregate per metric per subaccount, typed in by
hand, with no per-request breakdown. This profile drives a deterministic, well-defined set
of requests through sail-proxy against a **dormant** subaccount
(`development-aws-us-east-1`) so that the following month's SAP bill can be reconciled
against sail-proxy's own captured usage, pinning down every "missing factor" between the
two (Cache Read ≈2×, Cache Write unknown, image-token capture on `/anthropic`, and the
GenAI/Capacity-Unit rate).

Run this **once, in September 2026** (the subaccount bills on US-Eastern and 8/31 leaves
too few hours for the full run). Single model: `anthropic--claude-4.5-sonnet--deployed`.
Sizing is tier-c (~$300–500, landing around **~$310** at $1.38/CU), ≈3,900 requests. See
the spec's "Sizing" and "Methodology principles" sections for the full reasoning.

## Prereqs

- Local sail-proxy stack running: gateway (`pnpm run dev:gateway` from repo root,
  `http://localhost:3000`) and admin (`pnpm run dev:admin` from repo root,
  `http://localhost:4004`).
- A SAP AI Core service key + endpoint for the dormant subaccount
  `development-aws-us-east-1`, ready to drop into `services/gateway/.env`
  (`SAP_AI_CORE_URL`, `AUTH_URL`, `CLIENT_ID`, `CLIENT_SECRET`, `SAP_AI_RESOURCE_GROUP`,
  `SAP_AI_REGION`) — not yet applied until Step 4.
- `anthropic--claude-4.5-sonnet--deployed` deployed and RUNNING on that subaccount.
- `sqlite3` CLI available locally (the reporter shells out to it).

## Step 0 — August baseline

When the August bill posts (early September), record its line items as the dormancy
baseline. It should show only the tiny pre-existing shape (a recent month showed ~1,728
input / 1,990 output tokens) and **zero** Cache Read, Cache Write, GenAI Tokens, Capacity
Units, and Image. If August shows unexpected non-zero cache/GenAI/image, **stop and
investigate** before running the profile — something else is hitting the subaccount and
the "sole-path capture" assumption is broken.

## Step 1 — reset the local admin DB

From `services/admin/`:

```bash
npm run db:reset
```

This is `rimraf "db/admin.db" "db/admin.db-shm" "db/admin.db-wal" && npm run db:migrate`
(`db:migrate` = `cds deploy --to sqlite:db/admin.db`) — it deletes the sqlite file (and its
WAL/SHM siblings) outright and redeploys a fresh schema, which is the actual clean slate.
(`db:migrate:safe` only re-deploys onto the existing file with `--auto-undeploy` and is not
a reset.) Confirm afterwards that `sap_llm_gateway_admin_ApiKeyUsage` is empty:

```bash
sqlite3 services/admin/db/admin.db "SELECT COUNT(*) FROM sap_llm_gateway_admin_ApiKeyUsage;"
```

## Step 1b — repopulate ModelCosts, or capture lands EMPTY (do not skip)

The reset also **wipes `ModelCosts`** (the `/v2` model pricing), and usage capture is gated on
it: `usageEventProcessor.processBatch` only persists a batch when
`modelCostService.hasValidModelData()` is true. With `ModelCosts` empty, every captured event is
silently buffered in the admin (and lost if the admin restarts) — `ApiKeyUsage` stays empty and
the reconciliation reads nothing.

The admin fills `ModelCosts` from the gateway's `model-list-updated` Valkey message, which is
**fire-and-forget** — a reset that restarts the admin *after* the gateway last published misses
it, and pub/sub never replays. The admin now self-heals ~20 s after boot (it fetches `/v1/models`
directly if no event arrived — see `modelCostService.scheduleModelDataFallback`), but **force it
and verify anyway**:

```bash
# with the admin running, restart the gateway so it re-publishes the model list:
pnpm run dev:gateway
# then confirm ModelCosts is populated (must be non-zero, ~40-50 models):
sqlite3 services/admin/db/admin.db "SELECT COUNT(*) FROM sap_llm_gateway_admin_ModelCosts;"
```

**Gate:** this count MUST be non-zero before Step 3. If it is 0, do not run the profile — the run
would capture an empty `ApiKeyUsage`. (A quick way to prove capture works end-to-end without a
real inference is the synthetic-event check in the troubleshooting note below.)

## Step 2 — create the reconciliation API key

With admin running (`pnpm run dev:admin`), open the API Keys app in a browser:

```
http://localhost:4004/api-keys/index.html?sap-ui-xx-viewCache=false
```

Use the standard Fiori Elements **Create** action on the list report, set **API Key
Name** to `reconciliation`, and save. The object page then shows the generated key in the
"API Key (Full)" field with a copy-to-clipboard button (`key` is only ever surfaced here —
`maskedKey` is what the list shows afterwards). Copy it, then export it in the shell you'll
run the profile from:

```bash
export RECON_API_KEY=<the copied key>
```

## Step 3 — smoke run here (current subaccount)

Before repointing anything, prove the whole path works against the subaccount the gateway
is already configured for:

```bash
node cli-tools/sail-recon-profile.js --smoke --gateway http://localhost:3000
```

Confirm:
- The deployment gate passes (`GET /v1/models` lists
  `anthropic--claude-4.5-sonnet--deployed`; a failure aborts with exit code 2 and points at
  `sail-model-deploy.js`).
- The cache-read cell prints `cache-read self-check OK: <n> cache-read tokens observed`
  (a failure aborts with exit code 3 — the cache never hit and the cell is void).
- Capture landed under the `reconciliation` key — via the admin usage-analytics app, or
  directly:

```bash
sqlite3 services/admin/db/admin.db \
  "SELECT keyName, COUNT(*), SUM(inputTokens), SUM(cacheReadInputTokens), SUM(imageInputTokens) \
   FROM sap_llm_gateway_admin_ApiKeyUsage WHERE keyName='reconciliation';"
```

`--smoke` forces every cell to 2 requests regardless of the full-run sizing, so this is
fast — a handful of requests, not thousands.

## Step 4 — repoint and restart the gateway

Edit `services/gateway/.env` and replace `SAP_AI_CORE_URL`, `AUTH_URL`, `CLIENT_ID`,
`CLIENT_SECRET`, `SAP_AI_RESOURCE_GROUP`, and `SAP_AI_REGION` with the dormant
`development-aws-us-east-1` subaccount's service key + endpoint. Then restart the gateway
process (stop it and re-run):

```bash
pnpm run dev:gateway
```

(`services/gateway/.env` sets `PORT=3000`, matching the runner's default
`--gateway http://localhost:3000` — no flag override needed unless you changed the port.)

## Step 5 — deployment gate

The runner gates automatically on every invocation (`GET /v1/models` against the
now-repointed gateway; aborts exit 2 if
`anthropic--claude-4.5-sonnet--deployed` isn't served). Optionally cross-check from the
SAP side directly, bypassing the gateway:

```bash
node cli-tools/sail-model-deploy.js --status anthropic--claude-4.5-sonnet--deployed
```

(reads SAP AI Core credentials from the same `services/gateway/.env` you just edited; lists
matching deployments with their `RUNNING`/other status.)

## Step 6 — full run

```bash
node cli-tools/sail-recon-profile.js --full
```

(defaults to `--gateway http://localhost:3000`; pass `--gateway <url>` if the gateway is
listening elsewhere, and `--key <k>` if `RECON_API_KEY` isn't exported in this shell.) This
drives the full sizing across all four cells — baseline, cache-write, cache-read, image —
≈**3,900 requests**, expected to take a few hours. The runner logs each cell's request
count as it starts, and re-runs the cache-read self-check at full scale.

## Step 7 — snapshot / wait for the bill

Optionally take an immediate snapshot right after the full run (a placeholder bill of all
zeros still exercises the snapshot + captured-sums path and leaves a `.bak-recon-<runId>`
marker for "run completed"):

```bash
node cli-tools/sail-recon-report.js --key-name reconciliation --month 2026-09 --bill bill.json
```

Then wait for the actual September SAP bill (posts early October).

## Step 8 — reconcile

Write the bill's line items into `bill.json` (repo-root-relative path is fine, it is never
committed — see Safeguards):

```json
{
  "input": 0,
  "output": 0,
  "cacheRead": 0,
  "cacheWrite": 0,
  "image": 0,
  "genAi": 0,
  "capacityUnits": 0
}
```

Run the reporter:

```bash
node cli-tools/sail-recon-report.js --key-name reconciliation --month 2026-09 --bill bill.json
```

It snapshots `services/admin/db/admin.db` to
`services/admin/db/admin.db.bak-recon-<runId>` first, then prints:

```
metric  captured  billed  impliedFactor  expected  delta
```

Read it per metric:
- **input / output** — implied factor should sit at ~1.0 (sanity check on capture).
- **cacheRead** — the confirmed anomaly to pin down; expect an implied factor near **~2×**.
- **cacheWrite** — no prior expectation; this run *establishes* the factor.
- **image** — either implied factor ≈**1×** (capture on `/anthropic` works), or `captured`
  is 0 while `billed` is non-zero, in which case the reporter prints an explicit
  `IMAGE CAPTURE GAP` warning — that billed count becomes ground truth for a follow-on fix
  (out of scope here; this profile only quantifies it).
- **genAi / capacityUnits** — compare against the `/v2`-derived rate prediction from
  captured model tokens and the bill-confirmed **1.90385** CU factor
  (`capacityUnits ≈ genAi × 1.90385`); a large delta means the rate assumption needs
  revisiting, not that the run failed.

## Safeguards recap

- **Deployment gate (hard):** every run of the profile checks `GET /v1/models` for
  `anthropic--claude-4.5-sonnet--deployed` before sending any inference request; aborts
  (exit 2) otherwise.
- **Cache-hit self-check:** after the cache-read cell, aborts (exit 3) if no request
  reported `cache_read_input_tokens > 0` — a silent cache miss would void that cell.
- **Image-capture flag:** the reporter flags (does not abort on) a captured-image-tokens-
  of-zero vs. billed-image-tokens-nonzero mismatch — the run continues; the gap is the
  finding.
- **Read-only DB + snapshots:** the reporter only ever reads `sap_llm_gateway_admin_ApiKeyUsage`
  and writes its own timestamped `.bak-recon-<runId>` snapshot; it never mutates the live
  table.
- **Never commit `bill.json`, the `RECON_API_KEY` value, or any `admin.db*` snapshot** —
  `services/admin/db/*` is already `.gitignore`d, but `bill.json` and the exported key are
  not paths git ignores by default, so keep them out of `git add` explicitly.

## Troubleshooting — `ApiKeyUsage` stays empty

Capture flows: gateway `/anthropic` → publishes to the Valkey `usage-events` channel → the
admin's `usageEventProcessor` subscribes, batches, and persists to `ApiKeyUsage` **only when
`modelCostService.hasValidModelData()` is true**. If rows are missing, check in order.

1. **ModelCosts populated?** (the usual cause — see Step 1b)

   ```bash
   sqlite3 services/admin/db/admin.db "SELECT COUNT(*) FROM sap_llm_gateway_admin_ModelCosts;"
   ```

   Zero ⇒ the gate is closed and every event is silently buffered (and lost if the admin
   restarts). Restart the gateway to re-publish the model list; the admin also self-heals
   ~20 s after boot (`modelCostService.scheduleModelDataFallback`).

2. **Admin actually subscribed?** From `services/admin/`:

   ```bash
   node -e "const R=require('iovalkey');const r=new R(process.env.VALKEY_URL||'redis://localhost:6379');r.pubsub('NUMSUB','usage-events').then(n=>{console.log(n);r.disconnect();});"
   ```

   Must report `[ 'usage-events', 1 ]`. Zero ⇒ the admin's usage subscriber isn't up.

3. **Prove the persist path without a real inference** — publish one synthetic event, confirm it
   lands (with SAP-native fields), then delete the probe row. From `services/admin/`:

   ```bash
   KEYID=$(sqlite3 db/admin.db "SELECT ID FROM sap_llm_gateway_admin_ApiKeys WHERE name='reconciliation';")
   node -e "const R=require('iovalkey');const r=new R(process.env.VALKEY_URL||'redis://localhost:6379');r.publish('usage-events',JSON.stringify({requestId:'probe-'+Date.now(),timestamp:Math.floor(Date.now()/1000),authType:'api_key',credentialId:'$KEYID',provider:'unknown',model:'anthropic--claude-4.5-sonnet--deployed',inputTokens:4242,outputTokens:50,cacheCreationInputTokens:0,cacheReadInputTokens:0,imageInputTokens:0,statusCode:200,endpoint:'/anthropic/v1/messages',usageEstimated:false})).then(n=>{console.log('receivers:',n);r.disconnect();});"
   # wait ~35s for the batch, then:
   sqlite3 db/admin.db "SELECT keyName,genAiTokens,sapCost FROM sap_llm_gateway_admin_ApiKeyUsage WHERE inputTokens=4242;"
   sqlite3 db/admin.db "DELETE FROM sap_llm_gateway_admin_ApiKeyUsage WHERE inputTokens=4242;"
   ```

   A row with non-null `genAiTokens` / `sapCost` proves capture + SAP-native pricing work end to
   end (`receivers: 1` from the publish confirms the admin received it).
