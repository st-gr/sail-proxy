#!/usr/bin/env node

/**
 * SQLite WAL checkpoint helper for the CI pipeline.
 *
 * Runs `PRAGMA wal_checkpoint(TRUNCATE)` against a SQLite database so that
 * every committed write sitting in the -wal file is folded into the main
 * .db file before it is copied for backup. After a successful TRUNCATE
 * checkpoint the -wal file is truncated to 0 bytes, so the main .db file
 * alone is a complete, consistent snapshot and it is safe to omit
 * -wal/-shm from the backup.
 *
 * Strategy, in order:
 *   1. The `sqlite3` CLI, if available - no extra dependency required.
 *   2. `better-sqlite3`, resolved from the admin service's dependency tree
 *      (it is a transitive dependency of @cap-js/sqlite under pnpm). Only
 *      used as a fallback, and only if it resolves - it is an optional
 *      dependency here.
 *   3. Neither is available, or the checkpoint reports "busy" (another
 *      connection - typically the admin service - holds the database open
 *      and blocked the checkpoint): throw. Never proceed with a backup of
 *      an incomplete database.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execFileAsync = promisify(execFile);

async function hasSqlite3Cli() {
  try {
    await execFileAsync('which', ['sqlite3']);
    return true;
  } catch {
    return false;
  }
}

async function checkpointWithCli(dbPath) {
  try {
    // Explicit format flags so a user's ~/.sqliterc (.mode column, .headers
    // on, a different separator, ...) can't change the output we parse.
    const { stdout } = await execFileAsync('sqlite3', [
      '-batch', '-noheader', '-list', '-separator', '|',
      dbPath, 'PRAGMA wal_checkpoint(TRUNCATE);'
    ]);
    const [busyStr, logStr, checkpointedStr] = stdout.trim().split('|');
    const busy = Number(busyStr);
    const log = Number(logStr);
    const checkpointed = Number(checkpointedStr);
    if (![busy, log, checkpointed].every(Number.isInteger)) {
      // Unexpected output shape - don't guess, treat as "not available".
      return null;
    }
    return { busy, log, checkpointed };
  } catch {
    // sqlite3 exited non-zero for any reason (can't open the file, an
    // exclusive lock, a stderr-only failure, ...) - treat as "not
    // available" and let the caller fail closed with the actionable message.
    return null;
  }
}

function checkpointWithBetterSqlite3(dbPath, projectRoot) {
  let db;
  try {
    const modulePath = require.resolve('better-sqlite3', {
      paths: [path.join(projectRoot, 'services/admin')]
    });
    const Database = require(modulePath);
    db = new Database(dbPath);
    const result = db.pragma('wal_checkpoint(TRUNCATE)');
    const row = Array.isArray(result) ? result[0] : result;
    return { busy: row.busy, log: row.log, checkpointed: row.checkpointed };
  } catch {
    // better-sqlite3 isn't resolvable, or the pragma failed - treat as
    // "not available" and let the caller fail closed.
    return null;
  } finally {
    if (db) db.close();
  }
}

/**
 * Checkpoints the WAL of the SQLite database at dbPath, truncating it to
 * 0 bytes so the main .db file alone is a complete snapshot.
 *
 * @param {string} dbPath - absolute path to the .db file
 * @param {string} projectRoot - repo root, used to resolve better-sqlite3
 *   from the admin service's dependency tree when the sqlite3 CLI is missing
 * @returns {Promise<{ log: number, checkpointed: number, walSize: number }>}
 */
async function checkpointSqliteWal(dbPath, projectRoot) {
  const result = (await hasSqlite3Cli())
    ? await checkpointWithCli(dbPath)
    : checkpointWithBetterSqlite3(dbPath, projectRoot);

  if (!result || result.busy !== 0) {
    throw new Error(
      'Could not checkpoint admin.db WAL - stop the admin service (it holds the DB open) ' +
      'or install sqlite3; refusing to back up an incomplete database'
    );
  }

  const walPath = `${dbPath}-wal`;
  const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
  if (walSize !== 0) {
    throw new Error(
      `Checkpoint reported success but ${walPath} is still ${walSize} bytes - ` +
      'refusing to back up an incomplete database'
    );
  }

  return { log: result.log, checkpointed: result.checkpointed, walSize };
}

module.exports = { checkpointSqliteWal };
