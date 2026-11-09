/**
 * file_search S3 verification against a real bucket: uploads a few small test files through the
 * gateway's blob store with backend s3, reads them back, switches the configured backend to db and
 * reads again, migrates s3 -> db and db -> s3 with the migration job, deletes the files, runs the
 * sweeper (grace 0) and the garbage pass, and checks every key it created is gone. See
 * docs/developer/file-search-tool.md ("S3 verification against a real bucket").
 *
 * Safety (the bucket may hold unrelated data, and the keys may be broad):
 * - bucket, region and prefix come from FILE_SEARCH_S3_VERIFY_BUCKET/_REGION/_PREFIX in the env file,
 *   the keys from FILE_SEARCH_S3_ACCESS_KEY_ID/_SECRET_ACCESS_KEY; none is ever printed;
 * - the prefix must be `grounding-test` or below it; every key lies in the per-run folder
 *   `<prefix>/w7-<UTC timestamp>/` and is content-addressed from content derived from the run id;
 * - --plan (the default) prints the folder, every key, the requests per operation and the cleanup
 *   list, and sends nothing; --execute needs the --run-id of that plan;
 * - a request guard refuses, before sending, anything but the planned keys (no bucket-level request);
 * - cleanup deletes only keys this run sent a PUT for, by exact key; nothing is ever listed. The
 *   probe object (the reachability check's fixed content) is left in place, as the product does;
 * - everything runs in-process against a throwaway pgvector container (fs-s3verify-pg,
 *   127.0.0.1:55470), never the dev gateway or its database.
 *
 * Exit codes: 0 verified, 1 a mismatch or failure, 2 refused (usage, settings, prefix).
 */
import { options, plan, prepared, settings } from './fileSearchS3Verify/bootstrap';
import * as fs from 'fs';
import axios from 'axios';
import { getPool, runMigration } from '../src/fileSearch/db';
import { getConfig } from '../src/services/configService';
import { createS3Backend } from '../src/fileSearch/blob/s3Backend';
import { prepareDatabase } from './fileSearchEval/database';
import { CONTAINER, removeContainer, startContainer } from './fileSearchS3Verify/database';
import { ScriptError } from './fileSearchS3Verify/errors';
import { onceFinalizer, onSignals } from './fileSearchS3Verify/finalize';
import { apiConfigFor } from './fileSearchS3Verify/environment';
import { countByOp, installGuard } from './fileSearchS3Verify/guard';
import { describeError, executeSteps, GoneReport } from './fileSearchS3Verify/execute';
import { OPS } from './fileSearchS3Verify/plan';

/** Defence in depth: no printed line may carry the bucket or a key value. */
function scrub(text: string): string {
  let out = text;
  for (const secret of [settings.bucket, settings.accessKeyId, settings.secretAccessKey]) {
    if (secret) out = out.split(secret).join('<redacted>');
  }
  return out;
}

const log = (m: string) => console.log(`[file-search-s3-verify] ${scrub(m)}`);

/** Rewrites the generated api_config.json and reloads it (standalone mode reads the file). */
function switchBackend(backend: 'db' | 's3'): void {
  fs.writeFileSync(prepared.configFile, JSON.stringify(apiConfigFor(settings, backend), null, 2), { mode: 0o600 });
  getConfig(true);
}

async function cleanup(created: string[]): Promise<{ deleted: number; failed: number }> {
  const backend = createS3Backend({ bucket: settings.bucket, region: settings.region, prefix: settings.runFolder, endpoint: '' });
  let deleted = 0;
  let failed = 0;
  for (const key of created) {
    const file = plan.files.find((f) => f.key === key);
    if (!file) { failed += 1; continue; }
    try {
      // eslint-disable-next-line no-await-in-loop
      await backend.delete(file.sha256, key);
      deleted += 1;
    } catch (error) {
      failed += 1;
      log(`cleanup: deleting ${key} failed: ${describeError(error)}`);
    }
  }
  return { deleted, failed };
}

async function main(): Promise<number> {
  log(`run ${options.runId}: ${plan.files.length} files under ${settings.runFolder}/ in the bucket`);
  const guard = installGuard(axios, {
    bucket: settings.bucket, region: settings.region, runFolder: settings.runFolder,
    keys: [...plan.files.map((f) => f.key), plan.probeKey],
  });
  const container = { created: false };
  let failure: string | null = null;
  let reports: { garbage: GoneReport; final: GoneReport } | null = null;

  // Every exit path (normal end, error, SIGINT/SIGTERM) runs these once, each step on its own.
  const finalize = onceFinalizer([
    { name: 'S3 cleanup', run: async () => {
      // The probe object is never deleted: a file with identical bytes would share its key.
      const created = guard.created().filter((key) => key !== plan.probeKey);
      const result = await cleanup(created);
      log(`cleanup: ${result.deleted} of ${created.length} recorded keys deleted by exact key`
        + (result.failed ? `, ${result.failed} FAILED` : ''));
      if (result.failed) failure = failure ?? 'cleanup failed';
      if (guard.created().includes(plan.probeKey)) log(`left in place: 1 probe object (${plan.probeKey})`);
    } },
    { name: 'guard removal', run: () => guard.eject() },
    { name: 'database pool', run: async () => { await getPool()?.end(); } },
    { name: `${CONTAINER} removal`, run: () => {
      if (!container.created) return;
      removeContainer();
      log(`removed the ${CONTAINER} container`);
    } },
    { name: 'temporary configuration removal', run: () => fs.rmSync(prepared.configDir, { recursive: true, force: true }) },
  ], log);
  onSignals(finalize, (code) => process.exit(code), log);

  try {
    const dsn = await startContainer(log, undefined, undefined, container);
    process.env.FILE_SEARCH_DATABASE_URL = await prepareDatabase(dsn);
    if (!(await runMigration())) throw new ScriptError('the file_search schema migration did not complete');
    reports = await executeSteps(plan, settings, { switchBackend, log });
  } catch (error) {
    failure = describeError(error);
  } finally {
    const failedSteps = await finalize();
    if (failedSteps.length > 0) failure = failure ?? `cleanup step(s) failed: ${failedSteps.join(', ')}`;
  }

  const actual = countByOp(guard.allowed);
  log(`requests per operation (planned / sent): ${OPS.map((op) => `${op} ${plan.totals[op]}/${actual[op]}`).join(', ')}`);
  if (guard.violations.length > 0) {
    log(`GUARD refused ${guard.violations.length} request(s) before sending: ${guard.violations.join('; ')}`);
    failure = failure ?? 'the guard refused a request';
  }
  if (!failure && OPS.some((op) => actual[op] !== plan.totals[op])) {
    failure = 'the requests sent differ from the plan (a retried request counts twice)';
  }
  if (reports) {
    const notReadable = [...reports.garbage.notReadable, ...reports.final.notReadable];
    if (notReadable.length > 0) {
      log(`NOTE: ${notReadable.length} exact-key HEAD(s) after a delete answered 403: not readable with these `
        + 'credentials. Their deletion rests on the DELETE\'s own success (204), which the run required; the '
        + 'HEAD shows neither presence nor absence: ' + notReadable.join(', '));
    }
  }
  if (failure) {
    log(`FAILED: ${failure}`);
    return 1;
  }
  log('VERIFIED: upload, read, backend switch, both migrations, garbage pass and sweeper behaved as planned');
  return 0;
}

main().then((code) => process.exit(code), (error) => {
  // Only reachable before the finalizer exists (the guard refused to install): nothing else to undo.
  fs.rmSync(prepared.configDir, { recursive: true, force: true });
  log(`FAILED: ${describeError(error)}`);
  process.exit(1);
});
