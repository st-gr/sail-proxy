// What `sail-proxy upgrade docker` does on the Docker host: find the installation's compose project,
// read its containers, dump and restore its database through `docker compose exec`, and check health
// over HTTP from Node. Every docker/git call is an argument array (no shell on the host); the only
// `sh -c` runs inside the postgres container, which is Linux.
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as readline from 'readline';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { CommandRunner } from './kubectl';
import { Refusal } from './kymaChecks';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type ComposeTarget = { project: string; dir: string; files: string[] };
export type Container = { id: string; service: string; image: string; state: string; oneoff: boolean };
/** The pure SQL builders the Kyma restore uses (kit: cli-tools/kyma-db-manager.js, kyma-pod-files.js). */
export type DbBuilders = {
  buildPgDumpCommand: (credentials: any, options: any) => string;
  buildRestorePsqlCommand: (credentials: any) => string;
  dumpRelations: (lines: string[]) => Array<{ schema: string; name: string }>;
  buildDropRelationsStatement: (relations: Array<{ schema: string; name: string }>) => string;
  createRestoreLineFilter: () => (line: string) => boolean;
  assertCompleteDump: (text: string) => void;
};

const TAB = '\t';
const LABEL = (name: string) => `{{.Label "${name}"}}`;
// The credentials stay in the container: its shell reads them from the postgres service's env
const CREDENTIALS = { user: '"$POSTGRES_USER"', database: '"$POSTGRES_DB"' };
const PGPASSWORD = 'PGPASSWORD="$POSTGRES_PASSWORD"';

/** docker-compose.yml, plus docker-compose.override.yml when it exists (compose's own default pair). */
export function composeFiles(dir: string): string[] {
  const docker = path.join(dir, 'docker');
  const override = path.join(docker, 'docker-compose.override.yml');
  return [path.join(docker, 'docker-compose.yml'), ...(fs.existsSync(override) ? [override] : [])];
}

/** `docker compose` with the project, its directory and files pinned, then `args`. */
export function composeArgs(t: ComposeTarget, args: string[]): string[] {
  return ['compose', '-p', t.project, '--project-directory', path.join(t.dir, 'docker'), ...t.files.flatMap((f) => ['-f', f]), ...args];
}

/** Whether the override file makes compose build images here (a locally built install). */
export function overrideBuildsLocally(dir: string): boolean {
  const file = path.join(dir, 'docker', 'docker-compose.override.yml');
  if (!fs.existsSync(file)) return false;
  return /^\s*(build:|pull_policy:\s*["']?build\b)/m.test(fs.readFileSync(file, 'utf8'));
}

/**
 * The compose project whose running postgres container was started from `<dir>/docker`
 * (labels com.docker.compose.project / .project.working_dir). Refuses when there is none or
 * several. pathApi: path (default) or path.win32, whose paths compare case-insensitively.
 */
export async function findComposeProject(docker: CommandRunner, dir: string, o: { pathApi?: path.PlatformPath } = {}): Promise<string> {
  const p = o.pathApi || path;
  const fold = (s: string) => (p.sep === '\\' ? s.toLowerCase() : s);
  const want = fold(p.resolve(dir, 'docker'));
  const { stdout } = await docker(['ps', '--filter', 'label=com.docker.compose.service=postgres',
    '--format', `${LABEL('com.docker.compose.project')}${TAB}${LABEL('com.docker.compose.project.working_dir')}`]);
  const projects = new Set<string>();
  for (const line of stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const [project, workingDir] = line.split(TAB);
    if (project && workingDir && fold(p.resolve(workingDir)) === want) projects.add(project);
  }
  if (projects.size === 0) {
    throw new Refusal(`No running sail-proxy installation was started from ${p.resolve(dir, 'docker')} (no running postgres container of a compose project there). Start it, or pass --dir <install dir>.`);
  }
  if (projects.size > 1) {
    throw new Refusal(`several compose projects (${[...projects].sort().join(', ')}) run from ${p.resolve(dir, 'docker')}; stop all but one, then run the upgrade again.`);
  }
  return [...projects][0];
}

/** Every container of the project (running or not), one-off `run` containers included. */
export async function projectContainers(docker: CommandRunner, project: string, oneoffOnly = false): Promise<Container[]> {
  const { stdout } = await docker(['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`,
    ...(oneoffOnly ? ['--filter', 'label=com.docker.compose.oneoff=True'] : []),
    '--format', ['{{.ID}}', LABEL('com.docker.compose.service'), '{{.Image}}', '{{.State}}', LABEL('com.docker.compose.oneoff')].join(TAB)]);
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const [id, service, image, state, oneoff] = line.split(TAB);
    return { id, service, image, state, oneoff: oneoff === 'True' };
  });
}

/**
 * Tracked files git reports as changed in `dir` (porcelain -z), without the ones whose sha256
 * equals `exempt[path]` (what the last upgrade wrote, from the install record).
 */
export async function trackedChanges(git: CommandRunner, dir: string, exempt: Record<string, string>): Promise<string[]> {
  const { stdout } = await git(['-C', dir, 'status', '--porcelain', '-z', '--untracked-files=no']);
  const fields = stdout.split('\0');
  const out: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const rel = entry.slice(3);
    if (/[RC]/.test(status)) i++; // a rename's source path follows
    const file = path.join(dir, ...rel.split('/'));
    if (exempt[rel] && fs.existsSync(file) && sha256(fs.readFileSync(file)) === exempt[rel]) continue;
    out.push(rel);
  }
  return out;
}

export const sha256 = (data: Buffer | string): string => crypto.createHash('sha256').update(data).digest('hex');

const execPostgres = (t: ComposeTarget, script: string) => composeArgs(t, ['exec', '-T', 'postgres', 'sh', '-c', script]);

/** pg_database_size of the application database, in bytes. */
export async function databaseSize(docker: CommandRunner, t: ComposeTarget): Promise<number> {
  const { stdout } = await docker(execPostgres(t,
    `${PGPASSWORD} psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-password -t -A -c "SELECT pg_database_size(current_database())"`));
  const size = parseInt(stdout.trim(), 10);
  if (!Number.isFinite(size)) throw new Error('Could not read the database size');
  return size;
}

/**
 * A full pg_dump (--clean --if-exists) streamed to `file`, gzip-compressed here (never held in
 * memory); it must end with pg_dump's completion line. `signal` aborts it. A failing file (a full
 * disk) stops the dump and rejects with that error.
 */
export async function dumpDatabase(docker: CommandRunner, t: ComposeTarget, file: string, o: { builders: DbBuilders; signal?: AbortSignal }): Promise<void> {
  const gzip = zlib.createGzip({ level: 1 });
  const written = pipeline(gzip, fs.createWriteStream(file, { mode: 0o600 }));
  written.catch(() => { /* reported through the dump command (gzip errors) or awaited below */ });
  try {
    await docker(execPostgres(t, `${PGPASSWORD} ${o.builders.buildPgDumpCommand(CREDENTIALS, {})}`), { stdout: gzip, signal: o.signal });
  } catch (error) {
    gzip.destroy();
    await written.catch(() => {});
    throw error;
  }
  await written;
  let tail = '';
  for await (const chunk of fs.createReadStream(file).pipe(zlib.createGunzip())) tail = (tail + chunk.toString('utf8')).slice(-4096);
  o.builders.assertCompleteDump(tail);
}

/**
 * Restores a dumpDatabase dump in one psql run with ON_ERROR_STOP and --single-transaction: first
 * the CASCADE drop of every relation in the dump's schemas, then the dump without its DROP EXTENSION (the same
 * builders the Kyma restore uses). Errors name psql's first stderr line only.
 */
export async function restoreDatabase(docker: CommandRunner, t: ComposeTarget, file: string, o: { builders: DbBuilders }): Promise<void> {
  const lines = () => readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  const ddl: string[] = [];
  for await (const line of lines()) if (line.startsWith('CREATE ') || line.startsWith('COPY ')) ddl.push(line);
  const prefix = o.builders.buildDropRelationsStatement(o.builders.dumpRelations(ddl));
  const skip = o.builders.createRestoreLineFilter();
  async function* input() {
    yield Buffer.from(prefix, 'utf8');
    for await (const line of lines()) if (!skip(line)) yield Buffer.from(`${line}\n`, 'utf8');
  }
  // Best effort, as in the Kyma restore: a dump with vector columns needs the extension
  await docker(execPostgres(t, `${PGPASSWORD} psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-password -c "CREATE EXTENSION IF NOT EXISTS vector"`))
    .catch(() => {});
  try {
    await docker(execPostgres(t, `${PGPASSWORD} ${o.builders.buildRestorePsqlCommand(CREDENTIALS)} > /dev/null`), { input: Readable.from(input()) });
  } catch (error) {
    const first = String((error as { stderr?: string }).stderr || (error as Error).message || '').trim().split('\n')[0];
    throw new Error(`The database restore failed and was rolled back (psql: ${first})`);
  }
}

/** HTTP GET → status code (Node's http, no curl). */
export type HttpGet = (url: string) => Promise<number>;
export const httpStatus: HttpGet = (url) => new Promise((resolve, reject) => {
  const req = http.get(url, { timeout: 5000 }, (res) => { res.resume(); resolve(res.statusCode || 0); });
  req.on('timeout', () => req.destroy(new Error(`timeout: ${url}`)));
  req.on('error', reject);
});

/**
 * NGINX_PORT from docker/.env (quoted or with a trailing comment), else from this shell (compose
 * substitutes it from both; a key docker/.env defines is never taken from the shell, see
 * withComposeEnv), default 8080.
 */
export function nginxPort(dir: string): string {
  const file = path.join(dir, 'docker', '.env');
  const match = fs.existsSync(file) ? /^\s*NGINX_PORT\s*=\s*(["']?)(\d+)\1\s*(?:#.*)?$/m.exec(fs.readFileSync(file, 'utf8')) : null;
  if (match) return match[2];
  return /^\d+$/.test(process.env.NGINX_PORT || '') ? process.env.NGINX_PORT! : '8080';
}

const IMAGE_KEYS = ['DOCKER_REGISTRY', 'DOCKER_ORGANIZATION', 'DOCKER_TAG'];
export type ImageCoordinates = { registry?: string | null; organization?: string | null; tag?: string | null };

/** DOCKER_REGISTRY/ORGANIZATION/TAG for the coordinates that are known. */
export function imageEnv(images: ImageCoordinates | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (images?.registry) out.DOCKER_REGISTRY = images.registry;
  if (images?.organization) out.DOCKER_ORGANIZATION = images.organization;
  if (images?.tag) out.DOCKER_TAG = images.tag;
  return out;
}

/** The keys docker/.env defines (compose's other interpolation source), read at call time. */
function dotenvKeys(dir: string): string[] {
  const file = path.join(dir, 'docker', '.env');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').map((l) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1]).filter((k): k is string => !!k);
}

/**
 * Compose calls with the install's configuration, whatever this shell exports: the keys docker/.env
 * defines and the image coordinates are not inherited (a shell value would win over docker/.env),
 * and the coordinates `images()` names now are passed explicitly. Other calls run as they are.
 */
export function withComposeEnv(docker: CommandRunner, dir: string, images: () => ImageCoordinates | null): CommandRunner {
  return (args, opts = {}) => (args[0] !== 'compose' ? docker(args, opts) : docker(args, {
    ...opts,
    unsetEnv: [...new Set([...IMAGE_KEYS, ...dotenvKeys(dir), ...(opts.unsetEnv || [])])],
    env: { ...imageEnv(images()), ...(opts.env || {}) },
  }));
}

const SAFE_REL = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
/** A relative path with '/' that stays inside the install directory (from a backup's file list). */
export function isSafeRelativePath(rel: unknown): rel is string {
  return typeof rel === 'string' && SAFE_REL.test(rel) && !rel.split('/').some((seg) => seg === '.' || seg === '..');
}

export const healthUrls = (dir: string) => ({
  gateway: 'http://127.0.0.1:3000/health',
  admin: 'http://127.0.0.1:4004/api/health',
  nginx: `http://127.0.0.1:${nginxPort(dir)}/gateway/health`,
});

/** Waits until every URL answers 200, within one deadline. */
export async function waitHealthy(get: HttpGet, urls: Record<string, string>, { timeoutSeconds = 300, pollMs = 5000 } = {}): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (const [name, url] of Object.entries(urls)) {
    for (;;) {
      const status = await get(url).catch((e: Error) => e.message);
      if (status === 200) break;
      if (Date.now() >= deadline) throw new Error(`${name} is not healthy (${url}: ${status}) after ${timeoutSeconds}s`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}
