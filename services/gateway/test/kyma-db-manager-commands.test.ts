// Tests for the command builders in cli-tools/kyma-db-manager.js.
//
// Lives here rather than under cli-tools/ because this repo's only Jest runner is
// services/gateway's — the same reason test/check-nul-bytes.test.ts and
// test/docker-manifest-sync.test.ts cover files outside services/gateway.
//
// Every assertion is on a BUILT COMMAND STRING. Nothing here runs kubectl, psql or
// pg_dump: the flag logic is the part that can be wrong in a way that only shows up
// during a real restore, which is exactly when nobody wants to discover it.
//
// Requiring this module is safe only because kyma-db-manager.js guards its
// `program.parse(process.argv)` behind `require.main === module`. Without that guard
// commander would receive Jest's argv on import.

import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const kymaDbManager = require('../../../cli-tools/kyma-db-manager.js');
const {
  buildPgDumpCommand, buildEnsureVectorCommand, buildPgvectorProbeCommand, buildRestorePsqlCommand,
  buildTruncateStatement, buildRestoreInput,
} = kymaDbManager;

const CREDS = { user: 'admin_user', password: 'pw', database: 'gateway' };

describe('buildPgDumpCommand', () => {
  it('excludes only the blob DATA, never the table definition', () => {
    const cmd = buildPgDumpCommand(CREDS, { excludeBlobs: true });

    expect(cmd).toContain('--exclude-table-data=file_blobs');
    // The distinction IS the feature. `--exclude-table` omits the table
    // definition too, and fs_files.sha256 REFERENCES file_blobs(sha256), so a
    // dump built that way cannot be restored at all — it fails the moment
    // fs_files is created. A backup that cannot be restored is worse than no
    // backup, because it is discovered during a recovery.
    expect(cmd).not.toContain('--exclude-table=file_blobs');
  });

  it('also excludes the staged upload parts\' DATA (transient bytea), never their table', () => {
    const cmd = buildPgDumpCommand(CREDS, { excludeBlobs: true });

    expect(cmd).toContain('--exclude-table-data=fs_upload_parts');
    expect(cmd).not.toContain('--exclude-table=fs_upload_parts');
  });

  it('mentions file_blobs nowhere when the flag is absent', () => {
    expect(buildPgDumpCommand(CREDS, {})).not.toContain('file_blobs');
    expect(buildPgDumpCommand(CREDS, {})).not.toContain('fs_upload_parts');
  });

  it('composes with --exclude-table rather than replacing it', () => {
    const cmd = buildPgDumpCommand(CREDS, { excludeBlobs: true, excludeTable: 'cds_model' });

    expect(cmd).toContain('--exclude-table=cds_model');
    expect(cmd).toContain('--exclude-table-data=file_blobs');
  });

  it('trims whitespace in a comma-separated --exclude-table list', () => {
    const cmd = buildPgDumpCommand(CREDS, { excludeTable: 'cds_model, sessions ,logs' });

    expect(cmd).toContain('--exclude-table=cds_model');
    expect(cmd).toContain('--exclude-table=sessions');
    expect(cmd).toContain('--exclude-table=logs');
  });

  it('preserves the pre-existing data-only, schema-only and clean behaviour', () => {
    // Guards the extraction itself: this logic moved out of executePgDump and
    // must not have changed on the way.
    expect(buildPgDumpCommand(CREDS, { dataOnly: true })).toContain('--data-only');
    expect(buildPgDumpCommand(CREDS, { dataOnly: true })).not.toContain('--clean');
    expect(buildPgDumpCommand(CREDS, { schemaOnly: true })).toContain('--schema-only');
    expect(buildPgDumpCommand(CREDS, {})).toContain('--clean --if-exists');
  });

  it('targets the credentials it is given, and never puts the password on the command line', () => {
    // A distinctive password, not a single character: `not.toContain('p')`
    // matches the `p` in `pg_dump` and asserts nothing.
    const cmd = buildPgDumpCommand(
      { user: 'u1', password: 'sup3rs3cr3t-pw', database: 'db1' }, {},
    );

    expect(cmd).toContain('-U u1');
    expect(cmd).toContain('-d db1');
    // The password belongs in PGPASSWORD, which the caller supplies — not here.
    // kyma-db-manager redacts it from logs, but an argv leak bypasses that.
    expect(cmd).not.toContain('sup3rs3cr3t-pw');
    expect(cmd).toContain('--no-password');
  });
});

describe('buildEnsureVectorCommand', () => {
  it('creates the extension idempotently, in the target database and namespace', () => {
    const cmd = buildEnsureVectorCommand('sail-proxy', CREDS);

    // IF NOT EXISTS matters: a restore into a database that already has the
    // extension must not fail before the dump is even streamed.
    expect(cmd).toContain('CREATE EXTENSION IF NOT EXISTS vector');
    expect(cmd).toContain('-n sail-proxy');
    expect(cmd).toContain('-d gateway');
    expect(cmd).toContain('-U admin_user');
  });

  it('passes the password via PGPASSWORD rather than a psql argument', () => {
    const cmd = buildEnsureVectorCommand('ns', { user: 'u', password: 'sup3rs3cr3t-pw', database: 'db' });

    expect(cmd).toContain('PGPASSWORD=sup3rs3cr3t-pw');
    // psql has no --password-taking form here; the secret must not appear as
    // a bare argument where it could be read from another process's argv.
    expect(cmd).not.toContain('--password=sup3rs3cr3t-pw');
  });
});

// A pure builder that nobody calls protects nothing. The tests above prove
// buildEnsureVectorCommand produces the right SQL; this proves the restore path
// actually runs it, and runs it BEFORE the dump is streamed — after would be
// useless, since the failing statement is in the dump. executePsql cannot be
// invoked from a test (it shells out to kubectl and spawns psql), so the
// ordering is asserted against the source, the same way
// openRouterVectorStores.test.ts parses index.ts for its guard mount.
describe('buildPgvectorProbeCommand', () => {
  it('asks the two questions separately: available on the server, installed in this database', () => {
    const cmd = buildPgvectorProbeCommand('sail-proxy', CREDS);

    // These are different states with different remedies. pg_available_extensions
    // says the server COULD have it; pg_extension says this database DOES. An
    // operator who only learns the second cannot tell "run the migration" from
    // "you booted the wrong Postgres image".
    expect(cmd).toContain('pg_available_extensions');
    expect(cmd).toContain('pg_extension');
    expect(cmd).toContain("name = 'vector'");
    expect(cmd).toContain("extname = 'vector'");
  });

  it('returns one unadorned field so the output can be parsed', () => {
    const cmd = buildPgvectorProbeCommand('ns', CREDS);

    // -t strips the header, -A the column padding. Without both, the caller's
    // split('/') sees psql's box drawing instead of two numbers.
    expect(cmd).toContain('-t -A');
    expect(cmd).toContain("|| '/' ||");
  });

  it('targets the given namespace and database', () => {
    const cmd = buildPgvectorProbeCommand('other-ns', { user: 'u', password: 'pw', database: 'db2' });

    expect(cmd).toContain('-n other-ns');
    expect(cmd).toContain('-d db2');
  });
});

describe('the restore path wires the extension check in', () => {
  const SOURCE = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'cli-tools', 'kyma-db-manager.js'), 'utf8',
  );

  function executePsqlBody(): string {
    const start = SOURCE.indexOf('async function executePsql(');
    expect(start).toBeGreaterThan(-1);
    // Ends at the next top-level function; the closing brace of executePsql is
    // the only `\n}` before it.
    const end = SOURCE.indexOf('\n}', start);
    expect(end).toBeGreaterThan(start);
    return SOURCE.slice(start, end);
  }

  it('calls buildEnsureVectorCommand before building the psql command', () => {
    const body = executePsqlBody();

    const ensureAt = body.indexOf('buildEnsureVectorCommand(');
    const psqlAt = body.indexOf('let psqlCmd =');

    expect(ensureAt).toBeGreaterThan(-1);
    expect(psqlAt).toBeGreaterThan(-1);
    expect(ensureAt).toBeLessThan(psqlAt);
  });

  it('does not let a failed extension creation abort the restore', () => {
    const body = executePsqlBody();
    const ensureAt = body.indexOf('buildEnsureVectorCommand(');

    // The call sits inside a try/catch whose catch warns rather than rethrows:
    // a cluster without pgvector must still be able to restore dumps that
    // contain no vector columns.
    const around = body.slice(Math.max(0, ensureAt - 200), ensureAt + 400);
    expect(around).toContain('try {');
    expect(around).toContain('logWarning(');
    expect(around).not.toContain('throw');
  });
});

describe('the info path reports pgvector', () => {
  const SOURCE = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'cli-tools', 'kyma-db-manager.js'), 'utf8',
  );

  it('calls the probe from getDatabaseInfo', () => {
    const start = SOURCE.indexOf('function getDatabaseInfo(');
    expect(start).toBeGreaterThan(-1);
    const end = SOURCE.indexOf('\n}', start);
    const body = SOURCE.slice(start, end);

    expect(body).toContain('buildPgvectorProbeCommand(');
  });

  it('warns loudly only when the extension is UNAVAILABLE, not merely uninstalled', () => {
    const start = SOURCE.indexOf('function getDatabaseInfo(');
    const body = SOURCE.slice(start, SOURCE.indexOf('\n}', start));
    const section = body.slice(body.indexOf('buildPgvectorProbeCommand('));

    // Not installed is self-healing: the gateway creates the extension at
    // startup. Warning about it would train operators to ignore the warning
    // that actually matters.
    expect(section).toContain('logWarning(');
    expect(section).toContain('logInfo(');
    expect(section).toContain('pgvector/pgvector');
  });
});

describe('buildRestorePsqlCommand', () => {
  // Without ON_ERROR_STOP psql runs every remaining statement after a failure and still exits 0,
  // so a restore that lost tables reported "completed successfully". --single-transaction makes the
  // first failure roll the whole restore back instead of leaving a half-restored database.
  it('stops at the first failing statement and restores in one transaction', () => {
    const cmd = buildRestorePsqlCommand(CREDS);
    expect(cmd).toContain('-v ON_ERROR_STOP=1');
    expect(cmd).toContain('--single-transaction');
    expect(cmd).toContain('-U admin_user -d gateway');
    expect(cmd).not.toContain('--no-owner');
  });

  it('is the command the restore actually runs', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'cli-tools', 'kyma-db-manager.js'), 'utf8');
    const start = source.indexOf('async function executePsql(');
    const body = source.slice(start, source.indexOf('\n}', start));
    expect(body).toContain('let psqlCmd = buildRestorePsqlCommand(credentials);');
  });
});

describe('buildTruncateStatement', () => {
  it('TRUNCATEs the given tables with CASCADE, to survive foreign key constraints', () => {
    expect(buildTruncateStatement(['sessions', 'file_blobs'])).toBe('TRUNCATE TABLE sessions, file_blobs CASCADE;');
  });

  it('returns an empty string for no tables, rather than the syntax error TRUNCATE TABLE; would be', () => {
    expect(buildTruncateStatement([])).toBe('');
  });
});

// C9: --truncate-first used to run its TRUNCATE as its own, already-committed psql
// invocation, ahead of the restore's separate --single-transaction one. A restore
// failure then rolled back only the restore, leaving the truncate's damage in
// place — an empty database, which --pause-deployments then resumed services onto.
// The fix moves the truncate SQL into the restore's own input stream so ON_ERROR_STOP
// / --single-transaction covers both: one psql invocation, truncate first, restore
// after, one rollback on failure.
describe('restore --truncate-first runs inside the restore transaction (C9)', () => {
  const SOURCE = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'cli-tools', 'kyma-db-manager.js'), 'utf8',
  );

  function executePsqlBody(): string {
    const start = SOURCE.indexOf('async function executePsql(');
    expect(start).toBeGreaterThan(-1);
    const end = SOURCE.indexOf('\n}', start);
    expect(end).toBeGreaterThan(start);
    return SOURCE.slice(start, end);
  }

  it('never runs the truncate as its own, separately-committed statement', () => {
    // truncateAllTables (used by the `reset` command) execs its TRUNCATE
    // standalone and returns — exactly the shape that committed before the
    // restore could fail. The restore path must not call it.
    const body = executePsqlBody();
    expect(body).not.toContain('truncateAllTables(');
  });

  it('builds the truncate SQL with the pure, unexecuted builder before the restore starts', () => {
    const body = executePsqlBody();
    expect(body).toContain('listTablesToTruncate(namespace, credentials, excludeTables)');
    expect(body).toContain('truncateSql = buildTruncateStatement(tables)');
  });

  it('gives psql the output of buildRestoreInput(truncateSql, filteredSqlContent), not filteredSqlContent alone', () => {
    // The ordering guarantee (truncate ahead of the dump, nothing dropped)
    // lives in buildRestoreInput itself, and is proven behaviourally below —
    // not by grepping for an inline `if` here, which a source-text test
    // cannot tell apart from a broken one (e.g. an inverted guard) as long as
    // the same strings are still present somewhere in the function body.
    const body = executePsqlBody();
    expect(body).toContain('Buffer.from(buildRestoreInput(truncateSql, filteredSqlContent), \'utf8\')');
  });

  it('sends everything through a single psql invocation — one upload, one spawn', () => {
    const body = executePsqlBody();

    const spawnCalls = body.match(/spawn\(/g) || [];
    const uploads = body.match(/writePodFileVerified\(/g) || [];

    // Two psql calls (autocommitting truncate, then --single-transaction
    // restore) is the exact bug: a failure in the second leaves the first's
    // damage standing. There must be exactly one of each.
    expect(spawnCalls.length).toBe(1);
    expect(uploads.length).toBe(1);
  });

  it('a full --clean dump (DROP/CREATE from --clean --if-exists) still gets the truncate first', () => {
    // --clean --if-exists makes pg_dump emit DROP TABLE IF EXISTS ... / CREATE
    // TABLE ... ahead of the COPY data. Combined with --truncate-first, the
    // TRUNCATE runs before those DROP/CREATE statements too — truncating a
    // table that DROP is about to remove anyway is a harmless no-op, and
    // still inside the one rolled-back-together transaction if anything later
    // in the dump fails.
    const cleanDump = 'DROP TABLE IF EXISTS widgets;\nCREATE TABLE widgets (id int);\n'
      + 'COPY widgets (id) FROM stdin;\n1\n\\.\n';
    const input = buildRestoreInput('TRUNCATE TABLE widgets CASCADE;', cleanDump);

    expect(input.startsWith('TRUNCATE TABLE widgets CASCADE;\n')).toBe(true);
    expect(input.indexOf('TRUNCATE')).toBeLessThan(input.indexOf('DROP TABLE'));
    expect(input.endsWith(cleanDump)).toBe(true);
  });
});

// Behavioural, not source-text: these call the actual function with real
// inputs and check its output, so inverting its guard (`truncateSql ? a : b`
// -> `truncateSql ? b : a`, or dropping the truncate entirely) fails these
// tests directly — unlike a grep for a string near the call site, which
// cannot tell a correct guard from an inverted one.
describe('buildRestoreInput', () => {
  it('puts the truncate statement first, immediately followed by the dump', () => {
    const truncateSql = 'TRUNCATE TABLE widgets CASCADE;';
    const dumpSql = 'INSERT INTO widgets VALUES (1);\nINSERT INTO widgets VALUES (2);\n';

    expect(buildRestoreInput(truncateSql, dumpSql)).toBe(`${truncateSql}\n${dumpSql}`);
  });

  it('returns the dump completely unchanged when there is no truncate SQL', () => {
    const dumpSql = 'INSERT INTO widgets VALUES (1);\n';

    expect(buildRestoreInput('', dumpSql)).toBe(dumpSql);
  });
});

// file_search blobs outside the database (blob_storage.backend s3, or after a
// migration to s3): a row keeps only a key, the bytes live in the bucket, and a
// database backup silently lacks them. backup and info count and warn; restore
// counts the dump's own rows and warns.
describe('file_search blobs outside the database', () => {
  const {
    buildExternalBlobCountCommand, parseExternalBlobCounts, externalBlobBackupWarning,
    countExternalBlobsInDump, externalBlobRestoreWarning,
  } = kymaDbManager;
  const SOURCE = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'cli-tools', 'kyma-db-manager.js'), 'utf8',
  );
  const bodyOf = (signature: string): string => {
    const start = SOURCE.indexOf(signature);
    expect(start).toBeGreaterThan(-1);
    return SOURCE.slice(start, SOURCE.indexOf('\n}', start));
  };

  it('counts per storage other than db, in one unadorned line each', () => {
    const cmd = buildExternalBlobCountCommand('sail-proxy', CREDS);
    expect(cmd).toContain("FROM file_blobs WHERE storage <> 'db' GROUP BY storage");
    expect(cmd).toContain('sum(size_bytes)');
    expect(cmd).toContain('-t -A');
    expect(cmd).toContain('-n sail-proxy');
    expect(cmd).toContain('-d gateway');
  });

  it('parses the count output and ignores blank and colour-coded noise', () => {
    expect(parseExternalBlobCounts('\x1b[0ms3|12|3145728\n\nlocal|1|10\n')).toEqual([
      { storage: 's3', blobs: 12, bytes: 3145728 },
      { storage: 'local', blobs: 1, bytes: 10 },
    ]);
    expect(parseExternalBlobCounts('')).toEqual([]);
  });

  it('warns about the bucket without naming it, and is silent when every blob is in the database', () => {
    const warning = externalBlobBackupWarning([{ storage: 's3', blobs: 12, bytes: 3 * 1024 * 1024 }]);
    expect(warning).toContain('12 blob(s), 3.00 MiB in "s3"');
    expect(warning).toContain('does NOT contain their bytes');
    expect(warning).toContain('S3 bucket configured for file_search');
    expect(externalBlobBackupWarning([])).toBeNull();
  });

  it('backup counts before pg_dump runs, and info reports the same', () => {
    const backup = bodyOf('async function executePgDump(');
    expect(backup.indexOf('reportExternalBlobs(namespace, credentials)'))
      .toBeLessThan(backup.indexOf('const pgDumpCmd = buildPgDumpCommand('));
    expect(backup.indexOf('reportExternalBlobs(')).toBeGreaterThan(-1);
    expect(bodyOf('function getDatabaseInfo(')).toContain('reportExternalBlobs(namespace, credentials)');
  });

  it('a failed count never fails the backup', () => {
    const body = bodyOf('function reportExternalBlobs(');
    expect(body).toContain('try {');
    expect(body).toContain('catch (error)');
    expect(body).not.toContain('throw');
    expect(body).not.toContain('process.exit');
  });

  const DUMP = [
    'SET statement_timeout = 0;',
    'COPY public.fs_files (id, owner_email, sha256) FROM stdin;',
    'file-1\tuser@example.invalid\taaaa',
    '\\.',
    '',
    'COPY public.file_blobs (sha256, size_bytes, mime, ref_count, storage, bytes, location, created_at, delete_after) FROM stdin;',
    'aaaa\t100\ttext/plain\t1\tdb\t\\\\x6869\t\\N\t2026-10-08 10:00:00+00\t\\N',
    'bbbb\t2048\ttext/plain\t1\ts3\t\\N\tgrounding/bb/bbbb\t2026-10-08 10:00:00+00\t\\N',
    'cccc\t1024\ttext/plain\t0\ts3\t\\N\tgrounding/cc/cccc\t2026-10-08 10:00:00+00\t2026-10-08 10:15:00+00',
    '\\.',
    '',
    'COPY public.other (storage) FROM stdin;',
    's3',
    '\\.',
    '',
  ].join('\n');

  it('counts the dump\'s file_blobs rows outside the database, reading only that COPY block', () => {
    expect(countExternalBlobsInDump(DUMP)).toEqual([{ storage: 's3', blobs: 2, bytes: 3072 }]);
  });

  it('finds the storage column by name, whatever the column order', () => {
    const reordered = 'COPY public.file_blobs (storage, sha256, size_bytes) FROM stdin;\ns3\tdddd\t5\ndb\teeee\t7\n\\.\n';
    expect(countExternalBlobsInDump(reordered)).toEqual([{ storage: 's3', blobs: 1, bytes: 5 }]);
  });

  it('returns nothing for a dump without file_blobs data', () => {
    expect(countExternalBlobsInDump('COPY public.fs_files (id) FROM stdin;\nx\n\\.\n')).toEqual([]);
    expect(countExternalBlobsInDump('COPY public.file_blobs (sha256, size_bytes, storage) FROM stdin;\n\\.\n'))
      .toEqual([]);
  });

  it('the restore warning says the bytes must still be in the bucket, and what happens when they are not', () => {
    const warning = externalBlobRestoreWarning([{ storage: 's3', blobs: 2, bytes: 3072 }]);
    expect(warning).toContain('2 blob(s)');
    expect(warning).toContain('S3 bucket configured for file_search');
    expect(warning).toContain('503');
    expect(warning).toContain('unreferenced');
    expect(externalBlobRestoreWarning([])).toBeNull();
  });

  it('restore warns from the dump it is about to stream, also in a dry run', () => {
    const body = bodyOf('async function executePsql(');
    expect(body).toContain('countExternalBlobsInDump(filteredSqlContent)');
    expect(body).toContain('countExternalBlobsInDump(fs.readFileSync(inputPath');
  });
});

// execSync's error.message is "Command failed: kubectl … env PGPASSWORD=<password> psql …": printing
// it, even its first line, prints the database password. Every failure is reported through
// failureSummary (exit status + first stderr line), never the message of a failed command.
describe('kyma-db-manager never prints the database password', () => {
  const { reportExternalBlobs, failureSummary } = kymaDbManager;
  const SECRET = 'secret-db-pw-1234';
  const commandError = () => Object.assign(
    new Error(`Command failed: kubectl -n ns exec postgres-0 -- env PGPASSWORD=${SECRET} psql -U u -d db -t -A -c "SELECT 1"\n`
      + 'ERROR:  relation "file_blobs" does not exist'),
    { status: 1, stderr: 'ERROR:  relation "file_blobs" does not exist\nLINE 1: …' },
  );

  function captured(run: () => void): string {
    const lines: string[] = [];
    const spies = (['log', 'error', 'warn'] as const).map((m) => jest.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      lines.push(a.join(' '));
    }));
    try {
      run();
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    return lines.join('\n');
  }

  it('reportExternalBlobs on the "no file_search tables" path prints a fixed message', () => {
    const out = captured(() => {
      expect(reportExternalBlobs('ns', { user: 'u', password: SECRET, database: 'db' }, () => { throw commandError(); })).toBeNull();
    });
    expect(out).toContain('could not count blobs outside the database');
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain('PGPASSWORD');
    expect(out).not.toContain('Command failed');
  });

  it('failureSummary reports exit status and stderr, never the command line', () => {
    const summary = failureSummary(commandError());
    expect(summary).toBe('exit code 1: ERROR:  relation "file_blobs" does not exist');
    expect(summary).not.toContain(SECRET);
    // A stderr that echoes an assignment is masked too.
    expect(failureSummary({ status: 2, stderr: `sh: PGPASSWORD=${SECRET}: not found`, message: 'Command failed: x' }))
      .not.toContain(SECRET);
    expect(failureSummary(new Error(`Command failed: env PGPASSWORD=${SECRET} psql`))).toBe('command failed');
    expect(failureSummary(new Error('Extracted file not found: /tmp/x.sql'))).toBe('Extracted file not found: /tmp/x.sql');
  });

  it('no log call prints a raw error message or unscrubbed stderr', () => {
    const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'cli-tools', 'kyma-db-manager.js'), 'utf8');
    expect(SOURCE).not.toMatch(/\$\{[A-Za-z]*(?:error|Error|err)\.message/);
    expect(SOURCE).not.toMatch(/String\([A-Za-z]*(?:error|err)\.message\)/);
    expect(SOURCE).not.toMatch(/console\.(?:error|log)\(stderr\)/);
  });
});

describe('the file_search rebuild-index Job guard', () => {
  const { buildIndexRebuildProbeCommand, indexRebuildPods } = kymaDbManager;

  it('looks for unfinished pods of the Job label in the namespace', () => {
    expect(buildIndexRebuildProbeCommand('sail-proxy')).toBe(
      'kubectl -n sail-proxy get pods -l app=file-search-rebuild '
      + '--field-selector=status.phase!=Succeeded,status.phase!=Failed -o name');
  });

  it('lists the running pods, none when the Job is gone, and null when kubectl fails', () => {
    expect(indexRebuildPods('ns', () => 'pod/file-search-rebuild-index-abc12\n')).toEqual(['pod/file-search-rebuild-index-abc12']);
    expect(indexRebuildPods('ns', () => '')).toEqual([]);
    expect(indexRebuildPods('ns', () => { throw new Error('forbidden'); })).toBeNull();
  });
});

// 2026-10-29: kubectl exec lost the tail of a 113 MB dump and still exited 0, so the backup reported
// success with ten tables missing; a restore streamed through stdin is cut the same way, and psql then
// commits the partial COPY. Dumps now cross kubectl only as pod files verified by sha256
// (cli-tools/kyma-pod-files.js, tested in kyma-pod-files.test.ts).
describe('dumps cross kubectl as verified pod files, never as a bare stream', () => {
  const SOURCE = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'cli-tools', 'kyma-db-manager.js'), 'utf8',
  );
  const bodyOf = (signature: string) => {
    const start = SOURCE.indexOf(signature);
    expect(start).toBeGreaterThan(-1);
    return SOURCE.slice(start, SOURCE.indexOf('\n}', start));
  };

  it('backup: pg_dump writes a pod file, which is fetched verified and must be a finished dump', () => {
    const body = bodyOf('async function executePgDump(');
    expect(body).toContain('-f ${podSqlPath}');
    expect(body).toContain('readPodFileVerified(');
    expect(body).toContain('assertCompleteDump(backupData)');
    expect(body.indexOf('assertCompleteDump(backupData)')).toBeLessThan(body.indexOf('fs.writeFileSync(outputPath'));
  });

  it('restore: psql reads the uploaded, verified pod file and never stdin', () => {
    const body = bodyOf('async function executePsql(');
    expect(body).toContain('writePodFileVerified(');
    expect(body).toContain('${psqlCmd} -f ${podSqlPath}');
    expect(body).not.toContain('child.stdin');
    expect(body.indexOf('writePodFileVerified(')).toBeLessThan(body.indexOf('spawn('));
  });
});

describe('the upgrade restore drops the dump\'s relations with CASCADE first', () => {
  const { dumpRelations, buildDropRelationsStatement } = kymaDbManager;

  it('reads the relations a plain dump creates, unquoting and de-duplicating them', () => {
    expect(dumpRelations([
      'CREATE TABLE public.sap_llm_gateway_admin_apikeys (',
      'CREATE VIEW public."Usage View" AS',
      'CREATE MATERIALIZED VIEW public.mv AS',
      'CREATE SEQUENCE public.fs_files_id_seq',
      'CREATE UNLOGGED TABLE public.cache (',
      'CREATE TABLE public.sap_llm_gateway_admin_apikeys (',
      'CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;',
      'CREATE INDEX i ON public.t USING btree (id);',
      'CREATE FUNCTION public.f() RETURNS void',
    ])).toEqual([
      { schema: 'public', name: 'sap_llm_gateway_admin_apikeys' },
      { schema: 'public', name: 'Usage View' },
      { schema: 'public', name: 'mv' },
      { schema: 'public', name: 'fs_files_id_seq' },
      { schema: 'public', name: 'cache' },
    ]);
  });

  it('drops every relation of the dump\'s schemas by its live kind, with CASCADE, and nothing else', () => {
    const sql = buildDropRelationsStatement([{ schema: 'public', name: 't' }, { schema: "it's", name: 'u' }, { schema: 'public', name: 'v' }]);
    // Also the relations a newer version added, which the dump does not recreate (a rolled-back
    // upgrade leaves no empty new tables behind), but never an extension's own relations
    expect(sql).toContain("WHERE n.nspname IN ('public', 'it''s')");
    expect(sql).toContain("AND NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.classid = 'pg_class'::regclass AND e.objid = c.oid AND e.deptype = 'e')");
    expect(sql).not.toContain('VALUES');
    expect(sql).toContain("EXECUTE format('DROP %s IF EXISTS %I.%I CASCADE'");
    expect(sql).toContain("AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')");
    expect(sql).not.toMatch(/DROP (SCHEMA|EXTENSION|ROLE|OWNED)/);
    expect(sql).not.toMatch(/\b(BEGIN|COMMIT)\s*;/); // runs inside psql's --single-transaction
  });

  it('is empty for a dump without relations', () => {
    expect(buildDropRelationsStatement([])).toBe('');
  });

  it('restoreFromLocalFile sends the drop ahead of the dump in the same psql run', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../../cli-tools/kyma-db-manager.js'), 'utf8');
    const body = source.slice(source.indexOf('async restoreFromLocalFile'));
    expect(body).toContain('buildDropRelationsStatement(dumpRelations(createLines))');
    expect(body).toContain('yield prefix;');
    expect(body).toContain('${buildRestorePsqlCommand(POD_CREDENTIALS)} -f ${podPath}');
  });
});

describe('an upgrade restore never drops an extension', () => {
  const { createRestoreLineFilter } = kymaDbManager;
  const kept = (lines: string[]) => { const skip = createRestoreLineFilter(); return lines.filter((l) => !skip(l)); };

  it('leaves out the --clean section\'s DROP EXTENSION and keeps everything else', () => {
    expect(kept([
      'SET client_encoding = \'UTF8\';',
      'DROP TABLE IF EXISTS public.t;',
      'DROP EXTENSION IF EXISTS vector;',
      'DROP SEQUENCE IF EXISTS public.t_id_seq;',
      'CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;',
      'COMMENT ON EXTENSION vector IS \'vector data type\';',
      'CREATE TABLE public.t (',
    ])).toEqual([
      'SET client_encoding = \'UTF8\';',
      'DROP TABLE IF EXISTS public.t;',
      'DROP SEQUENCE IF EXISTS public.t_id_seq;',
      'CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;',
      'COMMENT ON EXTENSION vector IS \'vector data type\';',
      'CREATE TABLE public.t (',
    ]);
  });

  it('never touches a line after the first CREATE (COPY data, function bodies)', () => {
    const lines = ['CREATE TABLE public.notes (', 'COPY public.notes (body) FROM stdin;', 'DROP EXTENSION IF EXISTS vector;', '\\.'];
    expect(kept(lines)).toEqual(lines);
  });

  it('restoreFromLocalFile filters the dump through it, and the CASCADE pre-drop still goes first', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../../cli-tools/kyma-db-manager.js'), 'utf8');
    const body = source.slice(source.indexOf('async restoreFromLocalFile'));
    expect(body).toContain('const skip = createRestoreLineFilter();');
    expect(body).toContain('if (!skip(line)) yield');
    expect(body.indexOf('yield prefix;')).toBeLessThan(body.indexOf('yield* fs.createReadStream(input);'));
  });
});

describe('the CASCADE drop list comes from the DDL part of the dump only', () => {
  it('stops at the first COPY ... FROM stdin; (a data row cannot add a name)', () => {
    expect(kymaDbManager.dumpRelations([
      'CREATE TABLE public.notes (',
      'CREATE VIEW public.v AS',
      'COPY public.notes (body) FROM stdin;',
      'CREATE TABLE public.not_a_relation (',
      '\\.',
      'CREATE TABLE public.after_data (',
    ])).toEqual([{ schema: 'public', name: 'notes' }, { schema: 'public', name: 'v' }]);
  });

  it('restoreFromLocalFile hands it the COPY lines too', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../../cli-tools/kyma-db-manager.js'), 'utf8');
    expect(source).toContain("if (line.startsWith('CREATE ') || line.startsWith('COPY ')) createLines.push(line);");
  });
});
