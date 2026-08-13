---
title: SAIL-PROXY Developer Guide - Chapter 14
author: st-gr
date: 2026-07-07
mainfont: Helvetica, Arial, sans-serif
fontsize: 18px
---

# SAIL-PROXY Developer Guide
*Multi-provider AI Gateway for SAP AI Core - Developer Documentation*
**Author:** *st-gr*

# Chapter 14: Release & Deployment

This chapter describes how to cut a release: bumping the version across the workspace, publishing the standalone `@st-gr/sail-proxy` CLI to npm, and building and pushing the Docker images. One orchestrator script runs the whole sequence; the individual steps are documented below for when you need to run (or debug) them separately.

## TL;DR — One-Command Release

```bash
# Prerequisites (once per machine/session):
npm login                     # npm publish auth
docker login ghcr.io          # Docker registry auth

# Verify everything is in order without executing:
pnpm release:dry-run

# Cut the release:
pnpm release:patch            # or release:minor / release:major

# Final manual step (printed by the script):
git push origin <branch> && git push origin v<new-version>
```

`pnpm release:*` runs `cli-tools/release.js`, which executes, in order:

1. **Preflight** — tracked working tree clean, npm authenticated, Docker daemon reachable. Aborts before touching anything if a check fails.
2. **Test gate** — `pnpm test` (gateway suite). Skip with `--skip-tests` (not recommended).
3. **Version bump** — `npm version <type>` on the root package. The root `"version"` lifecycle hook (`cli-tools/sync-version.js --stage`) propagates the new version to `libs/*`, `services/*`, `docker/package.json`, and `npm-dist/sail-proxy`, and stages them so the version commit + git tag include every synced manifest.
4. **npm publish** — `cli-tools/publish-npm.js`, the hardened wrapper (see below). sail-proxy's `prepublishOnly` runs its full build, including `bundle:gateway`, so the published package always contains a freshly compiled gateway — the checked-in `bundled/` directory is never shipped stale.
5. **Docker build + push** — `docker/scripts/build-and-tag.js` (tags each image with both the new version and `latest`), then `docker/scripts/push-images.js`.

The script never pushes git commits or tags — it prints the exact `git push` commands at the end so you stay in control of what reaches the remote.

**Partial releases:** `--skip-npm` (Docker-only release), `--skip-docker` (npm-only release), `--skip-tests`.

## Why the Order Matters

- **Bump before publish/build:** both the npm tarball and the Docker image tags read the version from the (already-bumped) manifests. Publishing before bumping ships the old version number with new code.
- **Test before bump:** `npm version` creates a commit and tag; gating tests first keeps broken states out of tagged history.
- **Publish before announcing:** the git tag exists locally after step 3 — only push it once npm and the registry actually have the artifacts.

## The Individual Steps (Manual / Debugging)

### 1. Version Bump

```bash
pnpm version:bump:patch       # npm version patch + workspace sync + commit + tag
pnpm version:check            # verify all manifests agree
```

`cli-tools/sync-version.js` keeps `libs/*`, `services/{gateway,admin,ollama}`, `docker/package.json`, and `npm-dist/sail-proxy` on the root version. It does **not** touch `workspace:*` dependency protocols — those are rewritten only at pack time (see below).

### 2. Publish sail-proxy to npm

```bash
pnpm publish:npm              # from the repo root — ALWAYS use this, never raw npm publish
```

`cli-tools/publish-npm.js` exists because of a real npm bug: `npm publish` re-reads `package.json` from disk *after* packing and ships that manifest to the registry. A `postpack` hook that restores `workspace:*` therefore poisons the registry metadata (consumers get `EUNSUPPORTEDPROTOCOL`) while the tarball itself looks fine. The wrapper:

- refuses to run if a `postpack` hook exists in `npm-dist/sail-proxy/package.json`,
- pre-rewrites `workspace:*` to concrete versions and verifies the on-disk state before publishing,
- restores `workspace:*` in a `finally` block whether publish succeeded, failed, or was interrupted.

Consequence for manual testing: after a bare `npm pack` in `npm-dist/sail-proxy`, `package.json` is left with concrete versions — restore it yourself with `npm run restore-workspace`. See `npm-dist/sail-proxy/DEVELOPER.md` → Publishing.

### 3. Docker Images

```bash
pnpm docker:build             # builds gateway/admin/ollama/nginx images, tags v<version> + latest
pnpm docker:push              # pushes both tags (docker login required)
```

Registry and organization default to `ghcr.io` / `st-gr`; override with `DOCKER_REGISTRY`, `DOCKER_ORGANIZATION`, `DOCKER_TAG`. `--service NAME` limits either script to one image; `push-images.js --tag-only` skips the `latest` tag.

### 4. Push Commit and Tag

```bash
git push origin <branch>
git push origin v<new-version>
```

CI (`.github/workflows/ci.yml`) runs tests and Trivy scans on push — it does **not** publish to npm or push images. Releases are operator-driven by design.

## What Reaches Users When

| Artifact | Updated by | Users receive it |
|---|---|---|
| npm `@st-gr/sail-proxy` | `pnpm publish:npm` (step 4 of release) | `npm install -g @st-gr/sail-proxy@latest` |
| Docker images (`ghcr.io/st-gr/sail-proxy-*`) | `pnpm docker:push` (step 5) | `pnpm docker:pull` / redeploy |
| Bundled gateway inside the npm package | Rebuilt automatically by `prepublishOnly` → `bundle:gateway` | With the npm package |
| `api_config.json` for **existing** standalone installs | **Never automatically** — the template is copied once at setup | User re-runs setup or hand-merges new keys (e.g. `supported_beta_headers`) |
| `api_config.json` for **existing** distributed installs | **Never automatically** — the admin-activated configuration REPLACES the file config wholesale (no merge) | Admin activates a configuration containing the new keys |

The last two rows matter after config-schema releases: existing installs keep their old `api_config.json`. Ship code that degrades gracefully when new keys are absent (the beta-header allowlist and runtime quarantine were designed this way) — or, where absent keys would silently disable a security control, fail closed.

**file_search deployment prerequisites.** Unlike the config-key upgrades above, `file_search` (the OpenAI-compatible `/v1/files` and `/v1/vector_stores` endpoints) depends on things outside `api_config.json` that Docker and Kyma deployments must provision explicitly — an existing install that pulls a new image does **not** get them for free:

- **A Postgres image with the pgvector extension.** `docker/docker-compose.yml` and `kyma/templates/manifests/core/postgres.yaml` both pin `pgvector/pgvector:pg16-trixie` instead of plain `postgres:16`. The gateway runs `CREATE EXTENSION IF NOT EXISTS vector` at startup and only *logs* on failure — it never throws — so a deployment still running plain `postgres:16` silently reports the feature unavailable rather than crashing.
- **`pandoc` and `pdftotext` (poppler-utils) in the gateway image.** The extractor registry spawns these to convert `.docx`/`.odt`/`.epub`/`.rst`/`.html`/`.tex` (pandoc) and `.pdf` (pdftotext) uploads. `docker/gateway.Dockerfile` installs both (`apk add --no-cache pandoc poppler-utils`) in the **production** stage. An older image built before this change lacks them and those upload types fail; plain-text uploads are unaffected.
- **`FILE_SEARCH_DATABASE_URL`.** The gateway reads this (falling back to `POSTGRES_URL`) to get a DSN for the pgvector database. Compose loads it from `docker/.env.filesearch-runtime` via `env_file` (`required: false`, so a fresh clone that hasn't run setup yet still starts the gateway) — that file is generated by `docker/setup-docker.js` from credentials it also gives the `postgres` service, the actual single source of truth (not a compose `${VAR}` substitution: those resolve only from the shell or `docker/.env`, never from another service's `environment:` block, so they cannot see the `postgres` service's password at all). The username and password segments are percent-encoded (`encodeURIComponent`) when written into the DSN, since a manually-entered password containing `/` produces an unparseable URL otherwise. Kyma's `setup-kyma.js` writes the same DSN, encoded the same way, into the `gateway-env` Secret alongside `ADMIN_SERVICE_URL`. Omitting the DSN entirely is a supported configuration, not a bug: `getPool()` returns `null` and every `file_search` endpoint answers `503 file_search_unavailable` — this is the intended, fail-closed behaviour for standalone npm installs, which have no database by default (see `services/gateway/.env.sample`).

- **The gateway's runtime role is DML-only — DDL happens in a separate migration step, on a separate credential.** The role named by `FILE_SEARCH_DATABASE_URL` has exactly `SELECT`/`INSERT`/`UPDATE`/`DELETE` on the five `file_search` tables (`file_blobs`, `fs_files`, `vector_stores`, `vector_store_files`, `vector_store_chunks`) — no `CREATE`, ever, even transiently. This matters because the gateway is the internet-facing component and shares this database with the admin service's CAP schema (API keys, usage records); before this, `FILE_SEARCH_DATABASE_URL` carried the Postgres image's bootstrap-superuser credential (`POSTGRES_USER`/`POSTGRES_PASSWORD`), so an RCE in the gateway could `CREATE`/`ALTER`/`DROP` anything in the database, admin's tables included.

  DDL — `CREATE EXTENSION IF NOT EXISTS vector`, `CREATE TABLE IF NOT EXISTS` for the five tables, and provisioning the restricted role itself — now happens only via a separate, optional, privileged credential: `FILE_SEARCH_MIGRATION_DATABASE_URL`. When that env var is set, `runMigration()` (`services/gateway/src/fileSearch/db.ts`) uses it for the DDL and to `GRANT`/`REVOKE` the runtime role's privileges; the runtime pool (`getPool()`, used by every request handler) never reads it, not even transiently. When it is unset, behaviour is unchanged from before this release: DDL is attempted against `FILE_SEARCH_DATABASE_URL` itself — the still-supported path for local dev and any install that has not adopted the split. If the schema is already present, no DDL is attempted at all (a fast existence check short-circuits it); if the schema is absent *and* the configured role cannot create it, no DDL is attempted either — the feature just reports `503 file_search_unavailable`, exactly as with no database configured.

  - **Docker**: `docker/.env.postgres` now carries `FILE_SEARCH_MIGRATION_DATABASE_URL` (the bootstrap-superuser DSN, what `FILE_SEARCH_DATABASE_URL` used to be) instead. It is loaded **only** by the new one-shot `gateway-migrate` compose service — never by the long-running `gateway` service, whose `env_file` list no longer includes `.env.postgres` at all. `gateway`'s `depends_on` requires `gateway-migrate: condition: service_completed_successfully`, so the schema (and the runtime role) always exist before the gateway's own boot-time migration attempt runs.
  - **Kyma**: the privileged DSN lives in a new `gateway-migration-env` Secret, attached only to the `gateway` Deployment's new `migrate-file-search` initContainer (`kyma/templates/manifests/core/gateway.yaml`) — initContainers have their own independent environment, so it is never present in the long-running `gateway` container's env either.
  - **Either way**, the migration is also runnable as a standalone deploy step, independent of the gateway process: `node cli-tools/file-search-migrate.js` (repo root; requires `pnpm build:gateway` first) drives the same code (`services/gateway/src/fileSearch/migrateCli.ts`) that both the Docker service and the Kyma initContainer invoke directly from the built image (`node services/gateway/dist/services/gateway/src/fileSearch/migrateCli.js`).
  - **A migration failure never blocks the gateway from starting.** Both the compose `gateway-migrate` service and the Kyma `migrate-file-search` initContainer set `FILE_SEARCH_MIGRATE_NEVER_BLOCK=true`, which makes `migrateCli.ts` always exit `0` — even when migration genuinely failed — while still logging the failure loudly (`docker compose logs gateway-migrate` / `kubectl logs <pod> -c migrate-file-search`). This is deliberate: before this migration step existed, a broken migration cost `file_search` a `503` and nothing else; making this script's exit code a hard gate for the whole gateway container/pod would otherwise turn a migration failure into a total outage of all LLM proxying, a strictly larger blast radius than the defect the migration step exists to fix. Direct/manual/CI invocation via `cli-tools/file-search-migrate.js` does not set this flag, so it keeps a real, meaningful nonzero exit code for that use case. If `file_search` unexpectedly reports `503` after a deploy, check the migration step's own logs — the schema/role were probably never applied.

  **Existing installs adopting the restricted role**: re-run `docker/setup-docker.js` (Docker) or `kyma/scripts/setup-kyma.js` (Kyma) for this release. Both now generate a `file_search_app` runtime credential in addition to the existing Postgres credential, and (Docker) split `.env.postgres` into that file plus the new `.env.filesearch-runtime`, or (Kyma) add the `gateway-migration-env` Secret and the `migrate-file-search` initContainer. The next `docker compose up` / `kubectl apply` then provisions the restricted role and switches the running gateway over to it automatically — there is no separate manual `GRANT`/`REVOKE` step. An install that skips this re-run keeps working exactly as before (unchanged single-DSN fallback, still using the superuser credential) since that path is deliberately preserved for backwards compatibility, but does not get the privilege reduction.

- **The migration step's `embedding_dimensions` accuracy depends on when it runs.** `buildSchemaSql()` bakes `file_search.embedding_dimensions` into the `vector(N)` column at creation time, so the migration step needs the real admin-configured value, not the shipped default (1536). The Docker `gateway-migrate` service forces `GATEWAY_STANDALONE=true` and an absolute `CONFIG_FILE_PATH`, so it reads `api_config.json` directly off the same volume the gateway container mounts — accurate as of the last time that file was written. The Kyma `migrate-file-search` initContainer runs after `wait-for-admin`, so Admin/Valkey are already reachable, and `migrateCli.ts` proactively awaits the same async configuration fetch the gateway's own startup uses before migrating — also accurate, as long as Admin/Valkey are actually healthy at that point. Either way, if configuration truly cannot be resolved (Valkey/Admin down, file missing), migration still completes using the default rather than failing — verify `information_schema.columns` for `vector_store_chunks.embedding`'s dimension after upgrading a deployment with a non-default `embedding_dimensions` for the first time.

- **Concurrent migrations are now safe; they were not before this release.** `runMigration()` used to run its `CREATE EXTENSION`/`CREATE TABLE ... IF NOT EXISTS` DDL unguarded. Postgres's `IF NOT EXISTS` is a check-then-act that is not safe against genuinely concurrent execution: with more than one gateway replica booting cold against a not-yet-migrated database, all but one lose a race for `duplicate key value violates unique constraint`, and — because a migration failure is deliberately logged-and-swallowed rather than crashing the process — the losing replicas used to boot healthy and answer `503 file_search_unavailable` forever, silently, while one replica in the fleet worked. `runMigration()` now serializes the whole migration behind `pg_advisory_xact_lock` (a well-known key shared with the test suite's own equivalent guard in `schemaFixture.ts`), so N concurrent callers against a fresh database all succeed and apply the schema exactly once. This does not require any deployment change to benefit from — it applies unconditionally, on both the single-DSN fallback path and the new privileged-migration-DSN path.

An install upgrading from before `file_search` shipped needs to pull the new Postgres image and rebuild/pull the new gateway image; neither happens automatically from a version bump alone. Unlike most image bumps, an in-place upgrade of the Postgres image (same volume/PVC, image swap and restart, no data loss) **works** — but read the collation-version note below before doing it, if the image you're swapping to isn't `pgvector/pgvector:pg16-trixie` specifically.

**It also needs `docker/setup-docker.js` re-run, and this is the step most likely to be missed.** `docker/.env.postgres` and `docker/.env.filesearch-runtime` are generated once and never regenerated by a version bump, so an install whose copy predates this release either has no `FILE_SEARCH_DATABASE_URL` at all, or (for an install already running `file_search` before the restricted-role release) still has the old single, superuser-backed `.env.postgres` and no `.env.filesearch-runtime`. The symptom is silent and looks like success either way: compose renders without error, the gateway starts normally, and either `file_search` reports `503 file_search_unavailable` forever (no DSN case — `env_file` is `required: false`), or it keeps working exactly as before on the unrestricted single-DSN fallback (stale-but-present case). Verify after upgrading with `docker compose -f docker/docker-compose.yml config | grep -A1 FILE_SEARCH` — expect to see both `FILE_SEARCH_MIGRATION_DATABASE_URL` (on the `gateway-migrate` service only) and `FILE_SEARCH_DATABASE_URL` (on `gateway`, pointing at `file_search_app`, not `POSTGRES_USER`'s value); if the gateway's own DSN still shows the same username as `POSTGRES_USER`, setup has not been re-run for this release. The same applies to Kyma: `setup-kyma.js` writes the runtime DSN into the `gateway-env` Secret and the privileged one into the new `gateway-migration-env` Secret.

**Postgres collation version after an image swap (Docker volumes and Kyma PVCs alike).** `postgres:16` and `pgvector/pgvector:pg16` currently build on different Debian releases with different glibc versions (trixie/glibc 2.41 vs bookworm/glibc 2.36); that's exactly why the compose file and Kyma manifest pin `pgvector/pgvector:pg16-trixie` — it matches plain `postgres:16`'s base exactly, so the in-place upgrade path (existing install, same volume, image swap only) never crosses a glibc boundary and this problem cannot occur. If that pin is ever changed to a differently-based pgvector image (or to a plain `pgvector/pgvector:pg16` on an install that hasn't upgraded past that tag), the symptom on next startup is:

```
WARNING: database "sap_llm_gateway" has a collation version mismatch
DETAIL: The database was created using collation version 2.41, but the
        operating system provides version 2.36.
```

This is not a startup failure — Postgres starts and answers queries — but text btree indexes built under one glibc's collation rules are silently read under another's, on the *same* database `admin`'s CAP schema lives in. That's a wrong-results/index-corruption hazard, not a crash, so it won't surface as an error anywhere obvious. If you ever see that warning, run, once, against that database:

```sql
REINDEX DATABASE sap_llm_gateway;
ALTER DATABASE sap_llm_gateway REFRESH COLLATION VERSION;
```

`REINDEX` rebuilds every index under the collation rules Postgres is *actually* running with now; `REFRESH COLLATION VERSION` clears the warning so it isn't repeated on every future startup for the same already-fixed database. Apply this exactly the same way whether the volume is a Docker named volume or a Kyma PVC — the mismatch is a property of the on-disk database files versus the glibc the container currently runs, not of the orchestrator.

**Upgrade step for `/openai/v1/responses`:** the route's plugin hooks live under `defaultHooks.openai.responses` / `.responses-stream`. A distributed install whose active configuration predates the route has neither key, so PII masking would be skipped on an endpoint that is force-enabled with `allow_user_bypass: false`. The route therefore answers HTTP 503 `pseudonymization_hook_missing` until an admin activates a configuration that includes them. Existing **standalone** installs are in the same position for the same reason (see the table above — their `api_config.json` is never updated automatically), so they must re-run setup or hand-merge the two keys. Fresh installs ship with them. No other endpoint is affected.

**Later additions to those same two hook arrays.** Subsequent releases added two more plugin entries and two config keys. An install whose activated configuration predates them gets the endpoint without the corresponding feature — the route still answers, it just behaves as it did before:

| Added | Effect if the activated configuration predates it |
|---|---|
| `responsesWebSearchPlugin` hook entries | a hosted `web_search` tool reaches the deployment unrewritten and is rejected with `400 … tools are not allowed for model` |
| `responsesNamespaceToolsPlugin` hook entries | Codex's `namespace` sub-agent wrapper is rejected the same way, and clients need `--disable multi_agent` again |
| `web_search.max_searches_per_request` | none — absent falls back to the built-in default of 3 |
| `namespace_tools.mode` | none — absent falls back to the built-in default of `flatten` |

The two plugin entries are what matter on upgrade; both config keys degrade safely.

**`file_search.rewrite_query` now defaults to `false` — and no existing install picks that up.** Query rewriting sends the search query to the tenant's orchestration deployment to be rewritten before embedding, at a cost of roughly 1.3 seconds per search. The shipped template now sets `rewrite_query: false`, and `FILE_SEARCH_DEFAULTS.rewriteQuery` became `false` too — the latter being what an install whose activated configuration predates the `file_search` block resolves to.

This is a **new-installs-only** change, by the same rule the table above states for every other config key ("`api_config.json` for existing installs — never automatically"):

| Deployment shape | What an existing install gets | How an operator changes it |
|---|---|---|
| Standalone (npm) | keeps `true` — the template is copied **once**, at first run, and never re-merged | edit `~/.sail-proxy/api_config.json` |
| Docker | keeps `true` — the admin-activated configuration **replaces** the file configuration wholesale, with no merge, so a new template key is invisible until it is in an activated configuration | activate a configuration containing the new value, in the cockpit |
| Kyma | keeps `true`, for the same reason | activate a configuration containing the new value, in the cockpit |
| Any install predating the `file_search` block | gets `false`, from `FILE_SEARCH_DEFAULTS` | add the key to opt back in |

Nothing degrades either way: rewriting is best-effort and a search works identically with it on or off, only slower. Note also that the hosted `file_search` **tool** passes `rewriteQuery: false` explicitly regardless of configuration — the model has already turned the user's turn into a search query — so this setting only affects the REST endpoint `POST /v1/vector_stores/{id}/search`. See [chapter 16](chapter-16-file-search-tool.md).

**The order of those two plugin entries differs between the two arrays, deliberately.** `responses-stream` lists `responsesNamespaceToolsPlugin` *before* `responsesWebSearchPlugin`; `responses` lists it *after*. Write interceptors nest inside-out, while after-handlers chain in array order, so the two paths need opposite orders. When hand-merging, copy each array verbatim rather than normalising them to match — `test/responses-tool-plugin-layering.test.ts` fails by name if they agree.

## Release Checklist

- [ ] `git status` clean (tracked files), on the intended branch
- [ ] `npm whoami` succeeds; `docker login ghcr.io` done
- [ ] `pnpm release:dry-run` passes preflight
- [ ] `pnpm release:patch|minor|major`
- [ ] Push the version commit and tag
- [ ] Spot-check: `npm view @st-gr/sail-proxy version` and the registry image tags match the new version
