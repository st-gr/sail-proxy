// `sail-proxy upgrade docker`: moves a Docker Compose installation (set up from a clone with
// docker/setup-docker.js) to this package's release, all or nothing. Same steps, signal handling
// and result as `upgrade kyma`; any failure after the outage starts ends in a rollback to the
// previous files, images and pre-upgrade database. Never `down`, never `-v`, never a volume.
import * as fs from 'fs';
import * as path from 'path';
import { BundleManifest, backupFileName, defaultBackupDir, writeBundle } from './bundle';
import { UpgradePolicy, materializeKit } from './kit';
import { CommandRunner, guarded, spawnCommand } from './kubectl';
import { Refusal, defaultStatfs } from './kymaChecks';
import { ImageTarget, PromptOne } from './kymaRender';
import { UpgradeResult, askBeforeOutage, describe, withoutSecretEnv } from './kyma';
import { OUTAGE_STEPS, SignalSource, StepRunner, quotePath, runPhase } from './steps';
import { ComposeTarget, HttpGet, ImageCoordinates, composeArgs, withComposeEnv, composeFiles, dumpDatabase, healthUrls, httpStatus, projectContainers, restoreDatabase, sha256, waitHealthy } from './dockerHost';
import { DockerKit, applyDockerAnswers, collectDockerAnswers, loadDockerKit, managedFiles, recordUpgrade } from './dockerRender';
import { DockerInstallation, OWN_SERVICES, preflightDocker, readDockerInstallation } from './dockerChecks';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type DockerUpgradeContext = {
  /** the install directory (the clone setup-docker.js ran in); default the current directory */
  dir?: string;
  packageVersion: string;
  prompt: PromptOne;
  backupDir?: string;
  encrypt?: boolean;
  yes?: boolean;
  testImages?: ImageTarget;
  docker?: CommandRunner;
  git?: CommandRunner;
  httpGet?: HttpGet;
  statfs?: (dir: string) => Promise<number>;
  writeBundle?: typeof writeBundle;
  materializeKit?: typeof materializeKit;
  policy?: Partial<UpgradePolicy>;
  signals?: SignalSource;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  exit?: (code: number) => void;
  healthTimeoutSeconds?: number;
  pollMs?: number;
  now?: () => Date;
  adjustSetup?: (setup: any) => void;
};

type Snapshot = { projectRoot: string; backupDir: string; entries: Array<{ rel: string; existed: boolean; content?: Buffer; mode?: number }> };
type State = { applied: boolean; snapshot: Snapshot | null; dump: string | null; installed: DockerInstallation | null };

export async function runDockerUpgrade(ctx: DockerUpgradeContext): Promise<UpgradeResult> {
  const dir = path.resolve(ctx.dir || process.cwd());
  const log = ctx.log || ((m: string) => console.log(m));
  const env = ctx.env || process.env;
  const heldEnv: NodeJS.ProcessEnv = { SAIL_PROXY_BACKUP_PASSPHRASE: env.SAIL_PROXY_BACKUP_PASSPHRASE };
  const removedEnv = withoutSecretEnv();
  const docker = ctx.docker || spawnCommand('docker');
  const git = ctx.git || spawnCommand('git');
  const get = ctx.httpGet || httpStatus;
  const backupDir = path.resolve(ctx.backupDir || defaultBackupDir());
  const timing = { timeoutSeconds: ctx.healthTimeoutSeconds ?? 300, pollMs: ctx.pollMs ?? 5000 };
  const temps: string[] = [];
  const cleanupSync = () => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); };
  const runner = new StepRunner({
    signals: ctx.signals || process, env, log,
    onEarlySignal: (signal) => {
      log(`\n${signal} received before anything was stopped: the upgrade is cancelled, nothing was changed.`);
      cleanupSync();
      (ctx.exit || process.exit)(130);
    },
  });
  process.on('exit', cleanupSync);
  const ignoreWriteError = () => {};
  process.stdout.on('error', ignoreWriteError);
  process.stderr.on('error', ignoreWriteError);
  runner.start();

  // Compose runs with the image coordinates of the version on disk: the previous ones until apply,
  // the target's from apply on, the previous ones again once the rollback put the files back
  const coordinates: { now: ImageCoordinates | null } = { now: null };
  const compose = withComposeEnv(docker, dir, () => coordinates.now);
  const stepDocker = guarded(compose, () => runner.interrupted !== null);
  let from = 'unknown';
  let backup: string | undefined;
  let kitCleanup: (() => Promise<void>) | undefined;
  let kit: DockerKit | undefined;
  const state: State = { applied: false, snapshot: null, dump: null, installed: null };

  try {
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const materialized = await (ctx.materializeKit || materializeKit)();
    temps.push(materialized.root);
    kitCleanup = materialized.cleanup;
    const dk = loadDockerKit(materialized.root);
    kit = dk;
    const policy = { ...materialized.policy, ...ctx.policy };
    const target: ImageTarget = ctx.testImages || { tag: ctx.packageVersion };

    const installed = await runner.step('read', () => readDockerInstallation({
      docker, git, kit: dk, dir, policy, target, testMode: !!ctx.testImages, prompt: ctx.prompt,
    }));
    state.installed = installed;
    coordinates.now = installed.previousImages;
    from = installed.from;
    const { images } = installed;
    log(`Installed: ${from} (compose project ${installed.target.project}). Target: ${images.registry}/${images.organization}/sail-proxy-*:${images.tag}.`);

    const collected = await runner.step('ask', () => collectDockerAnswers({ kit: dk, dir, images, prompt: ctx.prompt, adjustSetup: ctx.adjustSetup }));

    const passphrase = await runner.step('preflight', async () => {
      await preflightDocker({ docker: compose, kit: dk, installed, backupDir, statfs: ctx.statfs || defaultStatfs, log });
      return askBeforeOutage(ctx, heldEnv, log);
    });

    // --- the outage starts: from here on every failure rolls back ---
    runner.enterOutage();
    const work = fs.mkdtempSync(path.join(backupDir, '.sail-proxy-upgrade-'));
    temps.push(work);
    const t = installed.target;
    await runner.step('outage', () => stepDocker(composeArgs(t, ['stop', 'nginx', 'gateway', 'admin'])));

    await runner.step('backup', async (signal) => {
      const snapshot: Snapshot = dk.localConfig.snapshotFiles(dir, managedFiles(dk, dir));
      state.snapshot = snapshot;
      temps.push(snapshot.backupDir);
      const entries: Array<{ name: string; source: string }> = [];
      const put = (name: string, content: Buffer | string) => {
        const file = path.join(work, ...name.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, content, { mode: 0o600 });
        entries.push({ name, source: file });
      };
      put('files.json', JSON.stringify(snapshot.entries.map((e) => ({ rel: e.rel, existed: e.existed, mode: e.mode })), null, 2));
      for (const e of snapshot.entries) if (e.existed) put(`files/${e.rel}`, e.content!);
      put('previous/state.json', JSON.stringify({
        project: t.project, running: installed.running, services: installed.services, images: installed.previousImages,
      }, null, 2));
      state.dump = path.join(work, 'database.sql.gz');
      log('Dumping the database...');
      await dumpDatabase(stepDocker, t, state.dump, { builders: dk.builders, signal });
      entries.push({ name: 'database.sql.gz', source: state.dump });
      backup = path.join(backupDir, backupFileName(t.project, from, (ctx.now || (() => new Date()))()));
      const head: Omit<BundleManifest, 'entries'> = { format: 1, kind: 'docker', fromVersion: from, toVersion: images.tag, createdAt: new Date().toISOString() };
      async function* list() { yield* entries; }
      await (ctx.writeBundle || writeBundle)(backup, passphrase, head, list());
      log(`Backup written: ${backup}`);
    });

    await runner.step('apply', async () => {
      state.applied = true;
      coordinates.now = images;
      await applyDockerAnswers(dk, collected.setup, collected.answers, images);
      t.files = composeFiles(dir);
      await stepDocker(composeArgs(t, ['pull', 'gateway', 'admin', 'nginx']));
    });
    const urls = healthUrls(dir);
    await runner.step('migrate', async () => {
      await stepDocker(composeArgs(t, ['run', '--rm', '-T', '--no-deps', 'admin', 'sh', '-c',
        'cd /app/services/admin && /app/node_modules/.bin/cds-deploy --profile pg']));
      await stepDocker(composeArgs(t, ['up', '-d', '--no-deps', 'admin']));
      // The file_search migration reads embedding settings from the admin: it runs once admin is up
      await waitHealthy(get, { admin: urls.admin }, timing);
      // Its exit code counts here: a failed migration rolls the upgrade back
      // --no-deps: postgres runs already and is never recreated
      await stepDocker(composeArgs(t, ['run', '--rm', '-T', '--no-deps', '-e', 'FILE_SEARCH_MIGRATE_NEVER_BLOCK=false', 'gateway-migrate']));
      // Then every other service that was running comes to the new definition (compose recreates
      // only those whose image, configuration or env changed); postgres stays out
      const others = installed.services.filter((s) => !['admin', 'gateway', 'nginx'].includes(s));
      await stepDocker(composeArgs(t, ['up', '-d', '--no-deps', 'gateway', 'nginx', ...others]));
    });
    await runner.step('health', () => waitHealthy(get, urls, timing));
    await runner.step('record', async () => recordUpgrade(dk, dir, collected.answers, images, sha256));
    log(`\nUpgrade complete: ${from} → ${images.tag}. Backup of the previous version: ${backup}`);
    log('This directory now holds the release\'s files: update it with `sail-proxy upgrade docker`, no longer with `git pull`.');
    return { ok: true, from, to: images.tag, backup: backup! };
  } catch (error) {
    const failedAt = runner.current || 'read';
    const why = runner.interrupted ? `interrupted by ${runner.interrupted}` : describe(error);
    if (!OUTAGE_STEPS.includes(failedAt)) {
      if (!(error instanceof Refusal)) log(`\nThe upgrade stopped at step ${failedAt}: ${why}. Nothing was changed.`);
      else log(`\n${why}`);
      return { ok: false, failedAt, rolledBack: false, from, error: why };
    }
    log(`\nThe upgrade failed at step ${failedAt}: ${why}. Rolling back to ${from}...`);
    runner.enterRollback();
    try {
      await rollback({ docker: compose, dir, state, kit: kit!, get, timing, log, coordinates, backupRef: () => backup, dropBackup: () => { backup = undefined; } });
      log(`\nRolled back: the installation runs ${from} again on the database as it was before the upgrade.`);
      return { ok: false, failedAt, rolledBack: true, from, backup, error: why };
    } catch (rollbackError) {
      log(`\nTHE ROLLBACK FAILED: ${describe(rollbackError)}.`);
      const cmd = backup ? `sail-proxy restore docker --dir ${quotePath(dir)} --input ${quotePath(backup)}` : undefined;
      const t = state.installed!.target;
      if (!state.applied) {
        log(`Nothing new was written and the database is untouched (it was only read). Start the previous version ${from} again by hand:`);
        log(`  docker compose -p ${t.project} --project-directory ${quotePath(path.join(dir, 'docker'))} start ${state.installed!.running.join(' ')}`);
      } else {
        log(`The installation may be partly upgraded.${backup ? ` The backup ${quotePath(backup)} was kept.` : ''}`);
        if (cmd) log(`Restore the previous version by hand:\n  ${cmd}`);
      }
      return { ok: false, failedAt, rolledBack: false, from, backup, error: `${why}; rollback failed: ${describe(rollbackError)}`, restoreCommand: cmd };
    }
  } finally {
    runner.stop();
    process.removeListener('exit', cleanupSync);
    process.stdout.removeListener('error', ignoreWriteError);
    process.stderr.removeListener('error', ignoreWriteError);
    if (kitCleanup) await kitCleanup().catch(() => {});
    cleanupSync();
    Object.assign(process.env, removedEnv);
  }
}

/** Removes the installation's one-off (`compose run`) containers, e.g. an interrupted migration. */
export async function removeOneOffs(docker: CommandRunner, project: string): Promise<void> {
  const ids = (await projectContainers(docker, project, true)).map((c) => c.id);
  if (ids.length > 0) await docker(['rm', '-f', ...ids]);
}

/** Back to the previous version: the old files, the pre-upgrade database, the old containers. */
async function rollback(o: {
  docker: CommandRunner; dir: string; state: State; kit: DockerKit; get: HttpGet;
  timing: { timeoutSeconds: number; pollMs: number }; log: (m: string) => void;
  backupRef: () => string | undefined; dropBackup: () => void; coordinates: { now: ImageCoordinates | null };
}): Promise<void> {
  const { docker, dir, state, log } = o;
  const installed = state.installed!;
  const t: ComposeTarget = installed.target;
  const running = OWN_SERVICES.filter((s) => installed.running.includes(s));
  const urls = healthUrls(dir);
  if (!state.applied) {
    // Nothing new was written and the database was only read: the stopped containers start again
    const file = o.backupRef();
    if (file) {
      for (const f of [file, `${file}.partial`]) fs.rmSync(f, { force: true });
      o.dropBackup();
    }
    if (running.length) await docker(composeArgs(t, ['start', ...running]));
  } else {
    // Both are written by the backup step, before anything is applied
    const { snapshot, dump } = state;
    if (!snapshot || !dump) throw new Error('No file snapshot or dump to roll back to');
    await runPhase(log, 'Stopping the new components', async () => {
      await docker(composeArgs(t, ['stop', 'nginx', 'gateway', 'admin']));
      // No migration container may still write while the database is restored
      await removeOneOffs(docker, t.project);
    });
    await runPhase(log, 'Putting the previous files back', async () => {
      o.kit.localConfig.restoreFiles(snapshot);
      o.coordinates.now = installed.previousImages;
      t.files = composeFiles(dir);
    });
    await runPhase(log, 'Restoring the database from the backup', () => restoreDatabase(docker, t, dump, { builders: o.kit.builders }));
    await runPhase(log, 'Starting the previous version', async () => {
      // Every service that was running, back to the previous definition (postgres stays out)
      if (installed.services.length) await docker(composeArgs(t, ['up', '-d', '--no-deps', ...installed.services]));
    });
  }
  const check: Record<string, string> = {};
  if (running.includes('admin')) check.admin = urls.admin;
  if (running.includes('gateway')) check.gateway = urls.gateway;
  if (running.includes('nginx') && running.includes('gateway')) check.nginx = urls.nginx;
  await runPhase(log, 'Waiting for the previous version to report healthy', () => waitHealthy(o.get, check, o.timing));
}
