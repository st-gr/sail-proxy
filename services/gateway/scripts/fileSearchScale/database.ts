/**
 * The bench database: the --dsn given, or a throwaway pgvector container `fsscale-pg` on 127.0.0.1:55491
 * that this run starts (or reuses, when an earlier --keep-db run left it) and removes by name at the end
 * unless --keep-db (also on SIGINT, SIGTERM and SIGALRM). A container is reused only when the --keep-db run that started it
 * labelled it kept; a leftover of any other run is replaced. Never prunes, never touches another container. /dev/shm is 3 GB so a parallel index
 * build can allocate its shared graph up to that size (Docker's default is 64 MB).
 *
 * The file_search schema goes into its own Postgres schema `fsscale` (search_path `fsscale,public`); a
 * database whose `public` schema holds file_search tables is refused (they would shadow it).
 */
import { execFileSync } from 'child_process';
import { Pool } from 'pg';

export const CONTAINER = 'fsscale-pg';
export const CONTAINER_DSN = 'postgresql://postgres:postgres@127.0.0.1:55491/fs';
export const SCALE_SCHEMA = 'fsscale';
const IMAGE = 'pgvector/pgvector:pg16-trixie';
/** A statement ceiling for every bench session: a killed run cannot leave a build running for long. */
const STATEMENT_TIMEOUT_MS = 30 * 60 * 1000;

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** The label a --keep-db run puts on the container; only a container carrying it is reused. */
const KEEP_LABEL = 'fsscale.keep';

/** What to do with an existing container (`state` '' = none) given its keep label. */
export function containerAction(state: string, keepLabel: string): 'start' | 'reuse' | 'restart' | 'replace' {
  if (!state) return 'start';
  if (keepLabel !== 'true') return 'replace';
  return state === 'running' ? 'reuse' : 'restart';
}

export async function startContainer(log: (m: string) => void, keepDb: boolean): Promise<string> {
  const found = docker(['ps', '-a', '--filter', `name=^/${CONTAINER}$`, '--format',
    `{{.State}}|{{.Label "${KEEP_LABEL}"}}`]);
  const [state = '', label = ''] = found.split('|');
  const action = containerAction(state, label);
  if (action === 'reuse') {
    log(`reusing the running ${CONTAINER} container`);
  } else if (action === 'restart') {
    docker(['start', CONTAINER]);
    log(`restarted the ${CONTAINER} container`);
  } else {
    if (action === 'replace') {
      docker(['rm', '-f', '-v', CONTAINER]);
      log(`removed a leftover ${CONTAINER} container that no --keep-db run kept`);
    }
    docker(['run', '-d', '--name', CONTAINER, '--label', `${KEEP_LABEL}=${keepDb}`, '--shm-size=3g',
      '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'POSTGRES_DB=fs',
      '-p', '127.0.0.1:55491:5432', IMAGE]);
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

export function removeContainer(log: (m: string) => void): void {
  try {
    docker(['rm', '-f', '-v', CONTAINER]);
    log(`removed the ${CONTAINER} container`);
  } catch (error: any) {
    log(`could not remove ${CONTAINER}: ${String(error?.message ?? error).split('\n')[0]}`);
  }
}

export function schemaDsn(baseDsn: string): string {
  const options = encodeURIComponent(`-c search_path=${SCALE_SCHEMA},public -c statement_timeout=${STATEMENT_TIMEOUT_MS}`);
  return `${baseDsn}${baseDsn.includes('?') ? '&' : '?'}options=${options}`;
}

/** The vector extension in public; refuses a database with file_search tables in public. */
export async function prepareDatabase(baseDsn: string): Promise<void> {
  const pool = new Pool({ connectionString: baseDsn, max: 1 });
  try {
    const { rows } = await pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('vector_stores', 'fs_files')`);
    if (rows.length > 0) {
      throw new Error('this database holds file_search tables in its public schema; give the bench its own '
        + 'database (or omit --dsn to use the fsscale-pg container)');
    }
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  } finally {
    await pool.end();
  }
}

/** SIGALRM is what a `perl -e 'alarm N; exec …'` bound sends. */
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGALRM: 142 } as const;

/**
 * On SIGINT/SIGTERM/SIGALRM: removes the container (unless --keep-db) and exits with the signal's code, so an
 * interrupted or time-bounded run leaves nothing behind. The server-side statement dies with the container.
 */
export function installSignalCleanup(opts: {
  keepDb: boolean;
  remove: () => void;
  exit?: (code: number) => void;
  proc?: Pick<NodeJS.EventEmitter, 'once'>;
}): void {
  const proc = opts.proc ?? process;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  for (const signal of Object.keys(SIGNAL_EXIT_CODES) as Array<keyof typeof SIGNAL_EXIT_CODES>) {
    proc.once(signal, () => {
      if (!opts.keepDb) opts.remove();
      exit(SIGNAL_EXIT_CODES[signal]);
    });
  }
}
