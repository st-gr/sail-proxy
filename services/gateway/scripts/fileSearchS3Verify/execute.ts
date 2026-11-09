/**
 * The steps of --execute (see plan.ts planSteps for the requests each sends), run in-process through
 * the gateway's own blob store, migration job and sweeper against the throwaway database. Each step
 * checks its result; the first mismatch stops the run (the caller still cleans up).
 */
import { getPool } from '../../src/fileSearch/db';
import { getFileSearchConfig } from '../../src/services/configService';
import {
  backendForStorage, openBlob, releaseBlobIn, retainBlob,
} from '../../src/fileSearch/blob/blobStore';
import { checkMigrationTarget, startBlobMigration, blobMigrationJob } from '../../src/fileSearch/blob/blobMigration';
import { claimNextBlobMigrationItem } from '../../src/fileSearch/blob/blobMigrationQueue';
import { processBlobMigrationItem } from '../../src/fileSearch/blob/blobMigrationWorker';
import { errorSummary, sweepBlobs } from '../../src/fileSearch/blob/blobSweeper';
import { S3RequestError } from '../../src/fileSearch/blob/s3Backend';
import type { VerifySettings } from './options';
import type { Plan, TestFile } from './plan';
import { GuardViolation } from './guard';
import { ScriptError } from './errors';

export class Mismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Mismatch';
  }
}

/**
 * The exact-key HEAD after a delete. The deletion itself is confirmed only by the DELETE's own
 * success (204), which the sweeper and the garbage pass require; the HEAD adds: 404 = absent, 403 =
 * not readable with these credentials (S3 may answer 403 for a missing key under a prefix-scoped
 * policy, so it proves neither presence nor absence).
 */
export interface GoneReport {
  /** HeadObject answered 404: absent. */
  confirmed: string[];
  /** HeadObject answered 403: not readable with these credentials; absence not shown by the HEAD. */
  notReadable: string[];
}

const ACTOR = { email: 'file-search-s3-verify@localhost', authType: 'verification' };

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Mismatch(message);
}

function db() {
  const pool = getPool();
  if (!pool) throw new Error('no database');
  return pool;
}

async function rows(): Promise<Map<string, { storage: string; location: string | null; has_bytes: boolean; ref_count: number }>> {
  const { rows: r } = await db().query(
    'SELECT sha256, storage, location, bytes IS NOT NULL AS has_bytes, ref_count FROM file_blobs');
  return new Map(r.map((x: any) => [x.sha256, x]));
}

async function garbageCount(): Promise<number> {
  const { rows: r } = await db().query("SELECT count(*)::int AS n FROM file_blob_garbage WHERE storage = 's3'");
  return r[0].n;
}

async function readBack(files: TestFile[], what: string): Promise<void> {
  for (const f of files) {
    // eslint-disable-next-line no-await-in-loop
    const bytes = await openBlob(f.sha256);
    expect(bytes.equals(f.content), `${what}: file ${f.index} read back different bytes`);
  }
}

async function expectRows(files: TestFile[], storage: 'db' | 's3', what: string): Promise<void> {
  const current = await rows();
  for (const f of files) {
    const row = current.get(f.sha256);
    expect(!!row, `${what}: the row of file ${f.index} is missing`);
    expect(row!.storage === storage, `${what}: file ${f.index} is stored in ${row!.storage}, expected ${storage}`);
    if (storage === 's3') {
      expect(row!.location === f.key, `${what}: file ${f.index} has an unexpected location`);
      expect(!row!.has_bytes, `${what}: file ${f.index} still has bytes in the database`);
    } else {
      expect(row!.has_bytes, `${what}: file ${f.index} has no bytes in the database`);
    }
  }
}

/** Runs the migration job to `target` in-process (no background worker) and checks it completed. */
async function migrate(target: 'db' | 's3', files: TestFile[], maxRetries: number): Promise<void> {
  const started = await startBlobMigration(target, ACTOR);
  if (!started.ok) {
    throw new Mismatch(`migration to ${target} refused: ${started.error} ${JSON.stringify(started.detail ?? {})}`);
  }
  const limit = files.length * (maxRetries + 1) + 2;
  for (let i = 0; i < limit; i++) {
    // eslint-disable-next-line no-await-in-loop
    const item = await claimNextBlobMigrationItem();
    if (!item) break;
    // eslint-disable-next-line no-await-in-loop
    await processBlobMigrationItem(item);
  }
  const job = await blobMigrationJob(started.job.id);
  expect(job?.state === 'completed' && job.done === files.length,
    `migration to ${target}: job ${job?.state ?? 'missing'}, ${job?.done ?? 0}/${files.length} done`);
}

/** Exact-key HEAD of every file's key: 404 confirms, 403 is "not readable", anything readable fails. */
async function checkGone(files: TestFile[], what: string): Promise<GoneReport> {
  const backend = backendForStorage('s3');
  const report: GoneReport = { confirmed: [], notReadable: [] };
  for (const f of files) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const exists = await backend.exists(f.sha256, f.key);
      expect(!exists, `${what}: ${f.key} still exists`);
      report.confirmed.push(f.key);
    } catch (error) {
      if (error instanceof S3RequestError && error.status === 403) report.notReadable.push(f.key);
      else throw error;
    }
  }
  return report;
}

export interface StepDeps {
  /** Switches the configured blob_storage.backend (the script rewrites its generated api_config.json). */
  switchBackend(backend: 'db' | 's3'): void;
  log(message: string): void;
}

export async function executeSteps(
  plan: Plan, settings: VerifySettings, deps: StepDeps,
): Promise<{ garbage: GoneReport; final: GoneReport }> {
  const { log } = deps;
  const files = plan.files;
  const n = files.length;
  const cfg = getFileSearchConfig();
  expect(cfg.blobStorage.backend === 's3' && cfg.blobStorage.s3.prefix === settings.runFolder,
    'the configured blob storage is not the run folder');

  const problem = await checkMigrationTarget('s3');
  if (problem) throw new Mismatch(`preflight probe failed: ${JSON.stringify(problem)}`);
  log('1. preflight: the probe object was written and read back under the run folder');

  for (const f of files) {
    // eslint-disable-next-line no-await-in-loop
    await retainBlob(f.sha256, f.content, 'application/octet-stream');
  }
  await expectRows(files, 's3', 'upload');
  log(`2. uploaded ${n} files to s3`);

  await readBack(files, 'read back');
  log('3. read back from s3: bytes equal');

  deps.switchBackend('db');
  expect(getFileSearchConfig().blobStorage.backend === 'db', 'the configured backend did not switch to db');
  await readBack(files, 'read back with backend db');
  await expectRows(files, 's3', 'backend switched to db');
  log('4. backend switched to db: the s3 blobs still read back equal');

  await migrate('db', files, cfg.ingestion.maxRetries);
  await expectRows(files, 'db', 'migration to db');
  expect(await garbageCount() === n, `migration to db: expected ${n} source copies queued for deletion`);
  log(`5. migrated s3 -> db: ${n}/${n} completed, ${n} source copies queued`);

  await db().query("UPDATE file_blob_garbage SET delete_after = now() - interval '1 second' WHERE storage = 's3'");
  const garbageSweep = await sweepBlobs();
  expect(garbageSweep.garbageDeleted === n && garbageSweep.garbageFailed === 0,
    `garbage pass: deleted ${garbageSweep.garbageDeleted}, failed ${garbageSweep.garbageFailed}`);
  expect(await garbageCount() === 0, 'garbage pass: entries left');
  log(`6. garbage pass deleted ${n} source copies`);

  const garbage = await checkGone(files, 'garbage pass');
  log(`7. source copies: deleted (DELETE succeeded); HEAD: ${garbage.confirmed.length} absent (404), `
    + `${garbage.notReadable.length} not readable with these credentials (403)`);

  await migrate('s3', files, cfg.ingestion.maxRetries);
  await expectRows(files, 's3', 'migration to s3');
  expect(await garbageCount() === 0, 'migration to s3: garbage entries left');
  log(`8. migrated db -> s3: ${n}/${n} completed and verified`);

  await readBack(files, 'read back after migration');
  log('9. read back from s3 (backend db): bytes equal');

  const client = await db().connect();
  try {
    await client.query('BEGIN');
    for (const f of files) {
      // eslint-disable-next-line no-await-in-loop
      const released = await releaseBlobIn(client, f.sha256, { graceSeconds: 0 });
      expect(released.pendingDelete, `release: file ${f.index} was not the last reference`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  const rowSweep = await sweepBlobs();
  expect(rowSweep.deleted === n && rowSweep.failed === 0, `sweeper: deleted ${rowSweep.deleted}, failed ${rowSweep.failed}`);
  expect((await rows()).size === 0, 'sweeper: rows left');
  log(`10. files deleted; the sweeper deleted ${n} rows and objects`);

  const final = await checkGone(files, 'after the sweeper');
  log(`11. created keys: deleted (DELETE succeeded); HEAD: ${final.confirmed.length} absent (404), `
    + `${final.notReadable.length} not readable with these credentials (403)`);
  return { garbage, final };
}

/**
 * What the run prints for an error: the script's own errors by their message (the caller still
 * scrubs it); an S3 error by op, status and code only; anything else by errorSummary.
 */
export function describeError(error: unknown): string {
  if (error instanceof Mismatch || error instanceof ScriptError || error instanceof GuardViolation) return error.message;
  if (error instanceof S3RequestError) return JSON.stringify({ op: error.op, status: error.status, code: error.code });
  return JSON.stringify(errorSummary(error));
}
