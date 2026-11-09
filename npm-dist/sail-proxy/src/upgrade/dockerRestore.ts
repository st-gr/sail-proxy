// `sail-proxy restore docker`: puts a backup `upgrade docker` wrote back by hand — the install
// directory's files (byte-identical; files the backup lacks are removed) and the database — and
// starts the previous containers. Nothing is changed before the bundle's GCM tag and every entry's
// sha256 have been checked (openBundle).
import * as fs from 'fs';
import * as path from 'path';
import { BundleError, openBundle, resolvePassphrase } from './bundle';
import { materializeKit } from './kit';
import { CommandRunner, SECRET_ENV, spawnCommand } from './kubectl';
import { PromptOne } from './kymaRender';
import { describe } from './kyma';
import { HttpGet, ImageCoordinates, composeArgs, composeFiles, findComposeProject, healthUrls, httpStatus, isSafeRelativePath, restoreDatabase, waitHealthy, withComposeEnv } from './dockerHost';
import { SignalSource, runPhase } from './steps';
import { loadDockerKit } from './dockerRender';
import { OWN_SERVICES } from './dockerChecks';
import { removeOneOffs } from './docker';

export type DockerRestoreContext = {
  dir: string;
  input: string;
  yes?: boolean;
  prompt: PromptOne;
  docker?: CommandRunner;
  httpGet?: HttpGet;
  env?: NodeJS.ProcessEnv;
  log?: (m: string) => void;
  materializeKit?: typeof materializeKit;
  healthTimeoutSeconds?: number;
  pollMs?: number;
  signals?: SignalSource;
};

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

type FileEntry = { rel: string; existed: boolean; mode?: number };

export async function runDockerRestore(ctx: DockerRestoreContext): Promise<{ ok: boolean; error?: string }> {
  const dir = path.resolve(ctx.dir);
  const log = ctx.log || ((m: string) => console.log(m));
  // Compose with the backup's image coordinates and docker/.env, whatever this shell exports
  const coordinates: { now: ImageCoordinates | null } = { now: null };
  const docker = withComposeEnv(ctx.docker || spawnCommand('docker'), dir, () => coordinates.now);
  // Once something changes a signal does not stop the restore (half-restored is worse): it is noted
  const signals: SignalSource = ctx.signals || process;
  let phase = '';
  const onSignal = (signal: string) => {
    log(`\n${signal} received: the restore is ${phase}; it runs to completion (signal ignored). If this process is killed anyway, run the same \`sail-proxy restore docker\` command again.`);
  };
  const input = path.resolve(ctx.input);
  const ask = async (q: Record<string, unknown>) => ctx.prompt({ ...q, id: q.name, noBack: true });
  const work = fs.mkdtempSync(path.join(path.dirname(input), '.sail-proxy-restore-'));
  const cleanup = () => fs.rmSync(work, { recursive: true, force: true });
  process.on('exit', cleanup);
  const env = ctx.env || process.env;
  const heldEnv: NodeJS.ProcessEnv = { SAIL_PROXY_BACKUP_PASSPHRASE: env.SAIL_PROXY_BACKUP_PASSPHRASE };
  const removedEnv: NodeJS.ProcessEnv = {};
  for (const key of SECRET_ENV) {
    if (process.env[key] !== undefined) removedEnv[key] = process.env[key];
    delete process.env[key];
  }
  let kit: Awaited<ReturnType<typeof materializeKit>> | undefined;
  try {
    let bundle;
    try {
      bundle = await openBundle(input, null, work);
    } catch (error) {
      if (!(error instanceof BundleError && error.code === 'PASSPHRASE_REQUIRED')) throw error;
      const passphrase = await resolvePassphrase({
        encrypt: true, confirm: false, env: heldEnv,
        prompt: async (qs) => { const out: Record<string, string> = {}; for (const q of qs as Array<{ name: string }>) out[q.name] = await ask(q); return out; },
      });
      bundle = await openBundle(input, passphrase, work);
    }
    if (bundle.manifest.kind !== 'docker') throw new Error(`${input} is a ${bundle.manifest.kind} backup, not a Docker one`);
    const files = JSON.parse(fs.readFileSync(bundle.path('files.json'), 'utf8')) as FileEntry[];
    const unsafe = (Array.isArray(files) ? files : [{ rel: String(files) } as FileEntry]).find((f) => !isSafeRelativePath(f && f.rel));
    if (unsafe) throw new Error(`The backup lists ${JSON.stringify(unsafe.rel)}, which is not a file of the install directory; nothing was changed`);
    const previous = JSON.parse(fs.readFileSync(bundle.path('previous/state.json'), 'utf8')) as {
      running?: string[]; services?: string[]; images?: ImageCoordinates;
    };
    const running = OWN_SERVICES.filter((s) => (previous.running || OWN_SERVICES).includes(s));
    const services = (previous.services || running).filter((s) => typeof s === 'string' && s !== 'postgres' && /^[A-Za-z0-9._-]+$/.test(s));
    coordinates.now = previous.images || null;

    log(`Backup of ${bundle.manifest.fromVersion} from ${bundle.manifest.createdAt}: database and ${files.filter((f) => f.existed).length} files.`);
    if (!ctx.yes && !(await ask({ type: 'confirm', name: 'confirmRestore', default: false,
      message: `Replace the database and the configuration files in ${dir} with this backup? The gateway, admin and nginx stop meanwhile.` }))) {
      return { ok: false, error: 'cancelled' };
    }
    kit = await (ctx.materializeKit || materializeKit)();
    const dk = loadDockerKit(kit.root);
    const project = await findComposeProject(docker, dir);
    const t = { project, dir, files: composeFiles(dir) };
    for (const name of SIGNALS) signals.on(name, onSignal);
    const opened = bundle;
    // `phase` names what a signal interrupts (the restore runs on regardless)
    const step = <T>(label: string, fn: () => Promise<T>, note = ''): Promise<T> => {
      phase = `${label.charAt(0).toLowerCase()}${label.slice(1)}${note ? ` (${note})` : ''}`;
      return runPhase(log, label, fn);
    };
    await step('Stopping the gateway, admin and nginx', async () => {
      await docker(composeArgs(t, ['stop', 'nginx', 'gateway', 'admin']));
      await removeOneOffs(docker, project);
    });
    await step('Putting the previous files back', async () => {
      dk.localConfig.restoreFiles({
        projectRoot: dir,
        backupDir: fs.mkdtempSync(path.join(work, 'files-')),
        entries: files.map((f) => (f.existed
          ? { rel: f.rel, existed: true, content: fs.readFileSync(opened.path(`files/${f.rel}`)), mode: f.mode }
          : { rel: f.rel, existed: false })),
      });
      t.files = composeFiles(dir);
    });
    await step('Restoring the database from the backup',
      () => restoreDatabase(docker, t, opened.path('database.sql.gz'), { builders: dk.builders }), 'one transaction: all of it or nothing');
    await step('Starting the previous version', async () => {
      if (services.length) await docker(composeArgs(t, ['up', '-d', '--no-deps', ...services]));
    });
    const urls = healthUrls(dir);
    const check: Record<string, string> = {};
    for (const s of running) if (s !== 'nginx' || running.includes('gateway')) check[s] = urls[s as keyof typeof urls];
    await step('Waiting for the previous version to report healthy',
      () => waitHealthy(ctx.httpGet || httpStatus, check, { timeoutSeconds: ctx.healthTimeoutSeconds ?? 300, pollMs: ctx.pollMs ?? 5000 }));
    log(`Restored ${dir} from ${input}.`);
    return { ok: true };
  } catch (error) {
    const why = describe(error);
    log(`Restore failed: ${why}`);
    return { ok: false, error: why };
  } finally {
    for (const name of SIGNALS) signals.removeListener(name, onSignal);
    process.removeListener('exit', cleanup);
    if (kit) await kit.cleanup().catch(() => {});
    cleanup();
    Object.assign(process.env, removedEnv);
  }
}
