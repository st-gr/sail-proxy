# `.env.sample` drift audit

**Run 2026-08-06.** Method: every `process.env.X` in each service's real source (excluding
`node_modules`, `dist`, `gen`, `test`, `logs`), diffed against the variables its `.env.sample`
either declares as `KEY=` or names in prose. Findings below were each confirmed by reading the
call site — the raw diff had false positives.

**`services/ollama/.env.sample` is clean**: 7 variables read, 7 documented.

---

## `services/gateway/.env.sample` — CLOSED

Fixed 2026-08-06 across two commits: the four `FILE_SEARCH_*` variables with the cli-tools plan
(`f79dc0b`), the remaining three concepts here. All seven now documented; 58 of 61 read
variables carry a `KEY=` entry, and the three that do not are the exclusions below.

| Variable | Call site | Note |
|---|---|---|
| `FILE_SEARCH_MIGRATION_DATABASE_URL` | `fileSearch/db.ts` (×7) | split-credential path |
| `FILE_SEARCH_S3_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | `fileSearch/blob/s3Backend.ts:39` | credentials only; bucket/region/endpoint/prefix live in `api_config.json` |
| `FILE_SEARCH_MIGRATE_NEVER_BLOCK` | `fileSearch/migrateCli.ts:71` | deploy behaviour on migration failure |
| `VALKEY_HOST` / `VALKEY_PORT` | `plugins/pseudonymization/entityCache.ts:32` | **a second, separate mechanism** — see below |
| `CONFIG_CHANGE_CHANNEL` | `services/configService.ts:104` | pub/sub channel; global, not scoped by DB index |
| `LOG_FOLDER_PATH` | `utils/payloadLogger.ts:47` | **fallback only** — see below |
| `WEBSEARCH_FORCE_ORCHESTRATION` | `plugins/webSearch/searchExecutor.ts:164` | degrades citation quality; not for normal operation |

### Three things the call sites revealed that the variable names do not

**`VALKEY_HOST`/`VALKEY_PORT` are not an alternative spelling of `VALKEY_URL`.** The
pseudonymization entity cache reads host/port and never parses the URL. So a gateway configured
only with `VALKEY_URL` — which is every documented setup — runs that cache in **memory-only
mode**. Correct, but per-process: two replicas do not share pseudonym mappings. Documented as a
distinct mechanism rather than as a synonym.

**`LOG_FOLDER_PATH` does not override anything.** The path normally comes from the admin
configuration (`logging.log_folder_path`); the environment variable is consulted only when that
lookup throws. Someone setting it to redirect payload logs on a working install would see no
effect and no error.

**`CONFIG_CHANGE_CHANNEL` exists because of an incident.** `configService.ts:100-104` records it:
a test publishing on the default channel wiped a live gateway's configuration mid-session, because
Valkey pub/sub channels are global and are *not* scoped by database index. The sample carries that
warning rather than just the default value.

## `services/admin/.env.sample` — CLOSED

Fixed 2026-08-06. Six variables documented; four turned out not to be configuration at all.

| Variable | Call site | Outcome |
|---|---|---|
| `IDENTITY_PROVIDER` | `src/middleware/authMiddleware.ts:148` | documented — only `'local'` changes behaviour |
| `LOCAL_USER_MAPPING` | `src/middleware/authMiddleware.ts:460` | documented — JSON email→role map; a missing entry silently yields `user` |
| `BASE_URL` | `src/srv/config-rest-api.ts:372` | documented — otherwise reconstructed from the request, wrong behind a rewriting proxy |
| `LOGOUT_REDIRECT_URL` | `src/srv/config-rest-api.ts:373` | documented — defaults from `BASE_URL` |
| `DEV_SESSION_SECRET` | `server.js:71` | documented, and **the earlier entry here overstated it** |
| `DEBUG_METADATA` | `src/index.ts:468` | documented — logs decoded JWT metadata |
| `SAP_AI_REGION` | `src/srv/admin-service.ts:1398` | documented — default `us-east-1` |
| `X_AUTH_REQUEST_*` (×4) | `server.js:57-60` | **not configuration** — see below |

### Correction: `DEV_SESSION_SECRET` is narrower than this note first claimed

The earlier version said "an install that never sets it runs on a hardcoded value". That
overstated it. `server.js:70` gates the entire session middleware behind
`deployTarget === 'development'`, so for `docker`, `xsuaa`, `btp` and `xsa` the middleware is
never mounted and the variable is never read. The real exposure is narrower and worth stating
precisely: a **development-target** instance reachable by anyone else runs on the literal
`'dev-unsafe-secret'`. Documented on those terms.

### The four `X_AUTH_REQUEST_*` variables were never configuration

They appeared only inside a `logger.info` call at `server.js:57-60`. The header names the service
actually reads are hardcoded at `authMiddleware.ts:79-81` and `index.ts:107-109`. Setting
`X_AUTH_REQUEST_EMAIL_HEADER` changed one line of the startup log and nothing else, while the
middleware went on reading `x-auth-request-email`.

Documenting them in `.env.sample` would have invented configuration — the same trap as
`SAP_AI_API_KEY` below. Instead the log now prints the literal names with a comment saying they
are fixed, so the false affordance is gone. **If they should be configurable, the change belongs
in the middleware first** — this was a log-only fix and deliberately changed no behaviour.

## Deliberately excluded, and why

- **`SAP_AI_API_KEY`, `SAP_AI_API_URL`** — these appear ONLY inside commented-out code at
  `services/gateway/src/services/sapAIService.ts:88-89`. Nothing reads them. A naive
  `grep process.env` reports them as drift; they are not. Do not "document" them.
- **`TS_NODE_DEV`, `TS_NODE_TRANSPILE_ONLY`** — set by the dev tooling, not operator configuration.
- **`CDS_ENV`, `CDS_PROFILE`, `NODE_CONFIG_ENV`** — CAP and node-config framework standards,
  documented upstream.
- **`NODE_ENV`** and other ambient process variables.

## Method note

The first version of the audit script reported all three services clean. That was false: zsh
expanded the unquoted `--include=*.ts` as a glob, grep never received the flag, and the "0 read"
in its own totals line was the only clue. Quote grep's pattern flags in zsh, and treat a
zero-input clean result as a bug until the input count is verified.
