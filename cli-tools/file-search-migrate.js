#!/usr/bin/env node

/**
 * file_search schema migration — deploy-time entry point.
 *
 * Applies services/gateway/src/fileSearch/schema.sql.ts's schema (creating
 * the `vector` extension and the file_search tables, guarded against
 * concurrent callers by a Postgres advisory lock) and, when
 * FILE_SEARCH_MIGRATION_DATABASE_URL is set, provisions the runtime
 * DML-only role named by FILE_SEARCH_DATABASE_URL/POSTGRES_URL. This is the
 * one place that needs DDL privileges; running it as its own step is what
 * lets the gateway process itself run with a role that only ever has
 * SELECT/INSERT/UPDATE/DELETE on the file_search tables.
 *
 * kyma-db-manager.js (this same directory) is Kyma-only — it drives
 * `kubectl exec`/`psql` against a cluster and requires --namespace. This
 * script has no such dependency: it speaks Postgres directly (via the
 * gateway's own compiled fileSearch/db.ts, reusing its exact credential and
 * lock logic), so the same command works for local dev, Docker Compose, and
 * as a Kyma pre-install/init Job — see docs/developer/chapter-14-release.md
 * for how each deployment target wires it in.
 *
 * Credentials are read from the environment exactly as the gateway process
 * itself reads them (see fileSearch/db.ts's runMigration doc comment):
 *   - FILE_SEARCH_MIGRATION_DATABASE_URL — optional, privileged DSN used
 *     only for this step.
 *   - FILE_SEARCH_DATABASE_URL (falling back to POSTGRES_URL) — the
 *     runtime DSN; with no migration DSN set, this is used for the DDL too
 *     (today's single-DSN behaviour, unchanged, for local dev and existing
 *     installs).
 *
 * Usage:
 *   node cli-tools/file-search-migrate.js
 *   FILE_SEARCH_MIGRATION_DATABASE_URL=postgresql://... \
 *     FILE_SEARCH_DATABASE_URL=postgresql://... \
 *     node cli-tools/file-search-migrate.js
 *
 * Requires the gateway to already be built (`pnpm build:gateway` from the
 * repo root, or the Docker image, which builds it as part of its image
 * build) — this wrapper does not build on the fly, so failures here fail
 * fast and loud rather than silently doing a slow rebuild mid-deploy.
 *
 * Exit code: 0 on success, 1 on any migration failure (see printed log).
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const gatewayDist = path.join(projectRoot, 'services/gateway/dist');
const compiledEntry = path.join(gatewayDist, 'services/gateway/src/fileSearch/migrateCli.js');

// The compiled gateway resolves `@libs/*` (e.g. `@libs/logger`) via a
// tsconfig `paths` mapping, which only affects TypeScript's type checker —
// the emitted `require('@libs/logger')` calls are plain Node module
// resolution at runtime and need a real `@libs` entry somewhere on the
// lookup path. docker/gateway.Dockerfile solves this for the built image
// with its own `node_modules/@libs` symlink; this does the equivalent for
// a local checkout, scoped to the (gitignored, disposable) dist/ output
// rather than touching the repo's real node_modules.
function ensureLibsAlias() {
  const libsTarget = path.join(gatewayDist, 'libs');
  if (!fs.existsSync(libsTarget)) return; // build didn't produce it; let the real error surface below
  const nodeModulesDir = path.join(gatewayDist, 'node_modules');
  const libsLink = path.join(nodeModulesDir, '@libs');
  if (fs.existsSync(libsLink)) return;
  fs.mkdirSync(nodeModulesDir, { recursive: true });
  fs.symlinkSync(libsTarget, libsLink, 'dir');
}

function main() {
  if (!fs.existsSync(compiledEntry)) {
    console.error(`\n❌ Not built: ${path.relative(projectRoot, compiledEntry)} does not exist.`);
    console.error('   Run "pnpm build:gateway" (or "pnpm --filter @sap-llm-gateway/gateway build")');
    console.error('   from the repo root first, then re-run this script.\n');
    process.exit(1);
  }

  ensureLibsAlias();

  // Run with cwd = services/gateway, matching how the gateway process
  // itself is always started (`pnpm --filter gateway ...` locally, this
  // package's own directory as WORKDIR-relative target in Docker) — several
  // of configService.ts's defaults (e.g. CONFIG_FILE_PATH's fallback to
  // `./api_config.json`) are resolved relative to cwd, and running from the
  // repo root instead would silently read/create the wrong file.
  const result = spawnSync(process.execPath, [compiledEntry], {
    stdio: 'inherit',
    cwd: path.join(projectRoot, 'services/gateway'),
    env: process.env,
  });

  if (result.error) {
    console.error(`\n❌ Failed to launch migration: ${result.error.message}\n`);
    process.exit(1);
  }

  process.exit(result.status === null ? 1 : result.status);
}

if (require.main === module) {
  main();
}

module.exports = { main };
