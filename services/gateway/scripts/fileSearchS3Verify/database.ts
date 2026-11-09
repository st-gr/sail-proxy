/**
 * The verification's own throwaway database: a pgvector container `fs-s3verify-pg` on
 * 127.0.0.1:55470, started for the run and removed by name at its end. Never the dev gateway's
 * database, never another container, never a prune. A container of that name left by an earlier run
 * is not reused: the run refuses and names the command that removes it. A start that fails after
 * `docker run` was issued (not started, never ready) removes the container it created.
 */
import { execFileSync } from 'child_process';
import { Pool } from 'pg';
import { ScriptError } from './errors';

export const CONTAINER = 'fs-s3verify-pg';
export const PORT = 55470;
export const CONTAINER_DSN = `postgresql://postgres:postgres@127.0.0.1:${PORT}/fs`;
const IMAGE = 'pgvector/pgvector:pg16-trixie';

export interface ContainerOps {
  docker(args: string[]): string;
  /** One connection attempt; true when the database answered. */
  ready(): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export const DOCKER_OPS: ContainerOps = {
  docker: (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
  ready: async () => {
    const pool = new Pool({ connectionString: CONTAINER_DSN, max: 1 });
    try {
      await pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    } finally {
      await pool.end().catch(() => {});
    }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

/** Removes the container by name, with its anonymous volume. */
export function removeContainer(ops: ContainerOps = DOCKER_OPS): void {
  ops.docker(['rm', '-f', '-v', CONTAINER]);
}

/**
 * `state.created` is true from the moment `docker run` returned until a failed start removed the
 * container again, so an end-of-run triggered meanwhile (a signal during the readiness wait) knows
 * to remove it.
 */
export async function startContainer(
  log: (m: string) => void, ops: ContainerOps = DOCKER_OPS, readyWithinMs = 60000,
  state: { created: boolean } = { created: false },
): Promise<string> {
  const existing = ops.docker(['ps', '-a', '--filter', `name=^/${CONTAINER}$`, '--format', '{{.State}}']);
  if (existing) {
    throw new ScriptError(`a container named ${CONTAINER} already exists (${existing}); remove it with `
      + `"docker rm -f -v ${CONTAINER}" and run again`);
  }
  // From here on a container of that name is this run's: none existed a moment ago.
  const discard = (why: string): ScriptError => {
    try {
      removeContainer(ops);
      state.created = false;
    } catch {
      // nothing was created, or it is gone already
    }
    return new ScriptError(`${CONTAINER} ${why}; the container was removed`);
  };
  try {
    ops.docker(['run', '-d', '--name', CONTAINER, '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_PASSWORD=postgres',
      '-e', 'POSTGRES_DB=fs', '-p', `127.0.0.1:${PORT}:5432`, IMAGE]);
  } catch (error: any) {
    const reason = String(error?.stderr ?? error?.message ?? error).trim().split('\n')[0];
    // It may exist (created, not started): until removed, the end of the run must remove it.
    state.created = true;
    throw discard(`could not be started (${reason})`);
  }
  state.created = true;
  log(`started the ${CONTAINER} container on 127.0.0.1:${PORT}`);
  const deadline = ops.now() + readyWithinMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    if (await ops.ready()) return CONTAINER_DSN;
    if (ops.now() > deadline) throw discard(`did not accept connections within ${Math.round(readyWithinMs / 1000)} s`);
    // eslint-disable-next-line no-await-in-loop
    await ops.sleep(1000);
  }
}
