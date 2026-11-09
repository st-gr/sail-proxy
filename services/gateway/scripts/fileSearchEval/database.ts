/**
 * The evaluation database: the --dsn given, or a throwaway pgvector container `fseval-pg` on
 * 127.0.0.1:55463 that this run starts (or reuses, when an earlier --keep-db run left it) and removes
 * by name at the end unless --keep-db. Never prunes, never touches another container.
 *
 * The file_search schema goes into its own Postgres schema `fseval` (search_path `fseval,public`, as
 * the integration tests' schemaFixture does) through the gateway's own runMigration. A database whose
 * `public` schema already holds file_search tables is refused: they would shadow the `fseval` ones.
 */
import { execFileSync } from 'child_process';
import { Pool } from 'pg';

export const CONTAINER = 'fseval-pg';
export const CONTAINER_DSN = 'postgresql://postgres:postgres@127.0.0.1:55463/fs';
export const EVAL_SCHEMA = 'fseval';
const IMAGE = 'pgvector/pgvector:pg16-trixie';

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Starts (or reuses) the container and waits until it accepts connections. */
export async function startContainer(log: (m: string) => void): Promise<string> {
  const state = docker(['ps', '-a', '--filter', `name=^/${CONTAINER}$`, '--format', '{{.State}}']);
  if (state === 'running') {
    log(`reusing the running ${CONTAINER} container`);
  } else if (state) {
    docker(['start', CONTAINER]);
    log(`restarted the ${CONTAINER} container`);
  } else {
    docker(['run', '-d', '--name', CONTAINER, '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_PASSWORD=postgres',
      '-e', 'POSTGRES_DB=fs', '-p', '127.0.0.1:55463:5432', IMAGE]);
    log(`started the ${CONTAINER} container`);
  }
  const deadline = Date.now() + 60000;
  for (;;) {
    const pool = new Pool({ connectionString: CONTAINER_DSN, max: 1 });
    try {
      // eslint-disable-next-line no-await-in-loop
      await pool.query('SELECT 1');
      return CONTAINER_DSN;
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`${CONTAINER} did not accept connections within 60 s`);
    } finally {
      // eslint-disable-next-line no-await-in-loop
      await pool.end().catch(() => {});
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export function removeContainer(): void {
  docker(['rm', '-f', '-v', CONTAINER]);
}

/**
 * Runs `fn` against the --dsn database, or against the fseval-pg container, which is removed afterwards
 * unless keepDb, also when it never became ready. A failed removal is logged and never replaces the
 * run's own error or result.
 */
export async function withDatabase<T>(
  opts: { dsn: string | null; keepDb: boolean; log: (m: string) => void },
  fn: (baseDsn: string) => Promise<T>,
  ops: { start: (log: (m: string) => void) => Promise<string>; remove: () => void } = { start: startContainer, remove: removeContainer },
): Promise<T> {
  if (opts.dsn) return fn(opts.dsn);
  try {
    return await fn(await ops.start(opts.log));
  } finally {
    if (!opts.keepDb) {
      try {
        ops.remove();
        opts.log(`removed the ${CONTAINER} container`);
      } catch (error: any) {
        opts.log(`could not remove ${CONTAINER}: ${error?.name ?? 'Error'}: ${String(error?.message ?? error).split('\n')[0]}`);
      }
    }
  }
}

export function schemaDsn(baseDsn: string, schema: string = EVAL_SCHEMA): string {
  const options = encodeURIComponent(`-c search_path=${schema},public`);
  return `${baseDsn}${baseDsn.includes('?') ? '&' : '?'}options=${options}`;
}

/** Creates the `fseval` schema and the vector extension; refuses a database with file_search tables in public. */
export async function prepareDatabase(baseDsn: string): Promise<string> {
  const pool = new Pool({ connectionString: baseDsn, max: 1 });
  try {
    const { rows } = await pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('vector_stores', 'fs_files')`);
    if (rows.length > 0) {
      throw new Error('this database holds file_search tables in its public schema; give the evaluation its own '
        + 'database (or omit --dsn to use the fseval-pg container)');
    }
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${EVAL_SCHEMA}`);
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  } finally {
    await pool.end();
  }
  return schemaDsn(baseDsn);
}
