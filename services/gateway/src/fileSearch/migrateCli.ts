/**
 * Standalone entry point for the file_search schema migration — the "deploy
 * step, independent of the gateway process" that lets an operator (or
 * Docker/Kyma deploy tooling) apply the schema and provision the runtime
 * DML-only role without starting the whole Express app.
 *
 * Reuses runMigration() from ./db verbatim: same credential-selection logic
 * (FILE_SEARCH_MIGRATION_DATABASE_URL, falling back to
 * FILE_SEARCH_DATABASE_URL/POSTGRES_URL), same advisory-lock guard, same
 * embedding-dimension resolution — so this and the gateway's own boot-time
 * migration can never disagree about what "migrated" means.
 *
 * Usage: node <dist>/services/gateway/src/fileSearch/migrateCli.js
 * (invoked via the top-level cli-tools/file-search-migrate.js wrapper, which
 * resolves this compiled path for both a local dev checkout and the Docker
 * image — see that file's own header for details.)
 *
 * Exit codes:
 *  - 0 when the schema ends up present (migration applied or already there),
 *    AND when no database is configured at all — that is the supported
 *    feature-off state (see db.ts's getPool()), not a failure, and must not
 *    be treated as one: this script's exit code gates whether the main
 *    `gateway` container/pod is even allowed to start (docker-compose.yml's
 *    `gateway-migrate` service, the Kyma `migrate-file-search`
 *    initContainer), and a fresh clone that hasn't run setup yet must still
 *    start the gateway, exactly as promised by FILE_SEARCH_DATABASE_URL's
 *    `required: false` env_file entry.
 *  - 1 when a database *is* configured but migration genuinely failed —
 *    unless FILE_SEARCH_MIGRATE_NEVER_BLOCK=true (see below).
 *
 * FILE_SEARCH_MIGRATE_NEVER_BLOCK=true always exits 0, regardless of
 * outcome (the failure is still logged loudly). Before this migration step
 * existed, a broken migration cost file_search a 503 and nothing else —
 * runMigration() ran as one non-fatal step deep in the gateway's own async
 * startup, wrapped in try/catch, with startIngestWorker()/
 * startExpirySweeper() and the rest of the app unaffected either way. Once
 * this script's success became a hard gate for the whole gateway container
 * (compose's service_completed_successfully / a Kubernetes initContainer),
 * a genuine migration failure would instead take down all LLM proxying, not
 * just file_search — a strictly larger blast radius than the defect this
 * step exists to fix. docker-compose.yml's `gateway-migrate` service and
 * the Kyma `migrate-file-search` initContainer both set this flag for
 * exactly that reason: ordering (migrate, then start the gateway) is still
 * useful in the success case, but migration failing must not be more
 * disruptive than it already was. Direct/manual/CI invocation (this script
 * without the flag — e.g. via cli-tools/file-search-migrate.js run by an
 * operator or a release pipeline) keeps a real, meaningful nonzero exit
 * code, since that caller's whole point in running it is to get a pass/fail
 * signal for THIS step specifically.
 *
 * Never throws past main() — a rejected promise here would print a raw
 * Node stack instead of the structured FileSearchDb log runMigration()
 * already produced.
 */
import { runMigration, getPool } from './db';
import { getConfigAsync } from '../services/configService';
import { isStandaloneMode } from '../config/unifiedAuthConfig';
import { getDefaultLogger } from '@libs/logger';

const logger = getDefaultLogger();

function hasAnyDsnConfigured(): boolean {
  return !!(
    process.env.FILE_SEARCH_MIGRATION_DATABASE_URL ||
    process.env.FILE_SEARCH_DATABASE_URL ||
    process.env.POSTGRES_URL
  );
}

async function main(): Promise<void> {
  const neverBlock = process.env.FILE_SEARCH_MIGRATE_NEVER_BLOCK === 'true';

  try {
    if (!hasAnyDsnConfigured()) {
      // Matches db.ts's own getPool()/runMigration() no-op exactly: no
      // FILE_SEARCH_MIGRATION_DATABASE_URL, FILE_SEARCH_DATABASE_URL, or
      // POSTGRES_URL means file_search is a supported, deliberately
      // disabled feature (e.g. a fresh clone that has not run setup yet) —
      // not a migration failure. Checked here, before calling
      // runMigration(), because runMigration()'s own boolean return does
      // not distinguish "nothing to do" from "tried and failed".
      logger.info('FileSearchMigrateCli', 'No database configured; nothing to migrate, exiting cleanly');
      return;
    }

    // This is a short-lived deploy step, not the gateway's own long-running
    // process, but it needs the same accurate embeddingDimensions (it
    // determines the vector column width) that the real gateway resolves
    // during its own startup. configService.ts's getFileSearchConfig() —
    // which runMigration() calls internally — reads a *synchronous*
    // getConfig(), which in standalone mode reads api_config.json straight
    // off disk (correct, no action needed) but outside standalone mode
    // either throws (if called mid-startup, "waiting for admin events") or
    // returns a bare default config — neither of which is the real,
    // admin-configured value. The gateway process itself avoids this by
    // awaiting getConfigAsync() once during its own startup, before ever
    // calling runMigration(); do the same thing here, for the same reason,
    // so this step and the gateway agree on the schema's vector width. A
    // failure here (Valkey/admin unreachable) is caught and logged, not
    // fatal — the fallback is FILE_SEARCH_DEFAULTS, exactly what would
    // happen anyway without this pre-fetch.
    if (!isStandaloneMode()) {
      await getConfigAsync().catch((error: any) => {
        logger.warn('FileSearchMigrateCli',
          `could not fetch configuration asynchronously before migrating (${error.message}); ` +
          'file_search.embedding_dimensions may fall back to the default if not resolvable locally');
      });
    }

    const ok = await runMigration();
    if (!ok) {
      logger.error('FileSearchMigrateCli',
        'file_search migration did not complete successfully — see the FileSearchDb log above for the reason' +
        (neverBlock ? ' (FILE_SEARCH_MIGRATE_NEVER_BLOCK=true: exiting 0 anyway so the gateway still starts; ' +
          'file_search will report unavailable until this is fixed and migration is re-run)' : ''),
        new Error('file_search migration failed'));
      if (!neverBlock) {
        process.exitCode = 1;
      }
      return;
    }
    logger.info('FileSearchMigrateCli', 'file_search migration completed successfully');
  } catch (error: any) {
    logger.error('FileSearchMigrateCli',
      `file_search migration crashed: ${error.message}` +
      (neverBlock ? ' (FILE_SEARCH_MIGRATE_NEVER_BLOCK=true: exiting 0 anyway so the gateway still starts)' : ''),
      error);
    if (!neverBlock) {
      process.exitCode = 1;
    }
  } finally {
    // Never leave the runtime pool's connections keeping this short-lived
    // process's event loop alive.
    await getPool()?.end().catch(() => {});
  }
}

if (require.main === module) {
  main().finally(() => {
    // configService.ts starts its own background timers outside standalone
    // mode (Valkey subscriber, periodic admin-service health checks) as a
    // side effect of being imported — those are meant to outlive the
    // long-running gateway process. This is a one-shot deploy step; without
    // an explicit exit here it hangs forever after finishing (verified
    // against a real docker-compose gateway-migrate run before this fix was
    // added).
    process.exit(process.exitCode ?? 0);
  });
}

export { main };
