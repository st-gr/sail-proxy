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
const { buildPgDumpCommand, buildEnsureVectorCommand, buildPgvectorProbeCommand } = kymaDbManager;

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

  it('mentions file_blobs nowhere when the flag is absent', () => {
    expect(buildPgDumpCommand(CREDS, {})).not.toContain('file_blobs');
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
