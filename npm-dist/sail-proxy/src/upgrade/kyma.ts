// `sail-proxy upgrade kyma`: moves an installation to this package's release, all or nothing. Any
// failure after the outage starts ends in a rollback to the previous version on the pre-upgrade
// database; a failed rollback says so, keeps every file and names the manual restore command.
import * as fs from 'fs';
import * as path from 'path';
import { BundleManifest, backupFileName, defaultBackupDir, resolvePassphrase, writeBundle } from './bundle';
import { UpgradePolicy, materializeKit } from './kit';
import { Kubectl, KubectlRead, SECRET_ENV, commandAdapter, guarded, isAuthError, spawnKubectl } from './kubectl';
import { KubeObject, checkHealth, deleteNewObjects, objectKey, readInstallObjects, restoreObjects, stopMigrationJobs } from './kymaCluster';
import { Refusal, defaultStatfs, preflight, readInstallation } from './kymaChecks';
import { ImageTarget, KitScripts, PromptOne, loadKitScripts, renderTarget } from './kymaRender';
import { OUTAGE_STEPS, SignalSource, StepId, StepRunner, quotePath, runPhase } from './steps';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type UpgradeContext = {
  namespace: string;
  packageVersion: string;
  prompt: PromptOne;
  backupDir?: string;
  encrypt?: boolean;
  yes?: boolean;
  /** Test mode: these images (an rc tag allowed), "newer" not checked */
  testImages?: ImageTarget;
  kubectl?: Kubectl;
  /** read-only kubectl for the kit's setup/deploy code (default: theirs, execFileSync kubectl) */
  kubectlRead?: KubectlRead;
  lookupDigest?: (config: unknown, image: string, tag: string) => Promise<string>;
  statfs?: (dir: string) => Promise<number>;
  writeBundle?: typeof writeBundle;
  materializeKit?: typeof materializeKit;
  policy?: Partial<UpgradePolicy>;
  signals?: SignalSource;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  /** a signal before the outage ends the process (default process.exit) */
  exit?: (code: number) => void;
  healthTimeoutSeconds?: number;
  /** how long the rollback waits for migration pods to go (default 120 s) */
  jobStopTimeoutSeconds?: number;
  pollMs?: number;
  now?: () => Date;
  /** test seam: adjust the kit's KymaSetup instance (e.g. stub a metadata fetch) */
  adjustSetup?: (setup: any) => void;
};

export type UpgradeResult =
  | { ok: true; from: string; to: string; backup: string }
  | { ok: false; failedAt: StepId; rolledBack: boolean; from: string; backup?: string; error: string; restoreCommand?: string };

export const exitCodeOf = (r: UpgradeResult): number =>
  r.ok ? 0 : !OUTAGE_STEPS.includes(r.failedAt) ? 1 : r.rolledBack ? 2 : 3;

const firstLine = (s: unknown) => String(s || '').trim().split('\n')[0];

/** What went wrong, for the user: never a manifest or a value, only kubectl's first stderr line. */
export function describe(error: unknown): string {
  const e = error as { name?: string; code?: string; step?: string; stderr?: string; message?: string; signal?: string };
  let text: string;
  if (e?.code === 'ENOSPC') text = 'the disk is full (ENOSPC)';
  else if (e?.name === 'DeployError') text = `${e.step} failed: ${firstLine(e.stderr) || 'see the output above'}`;
  else text = firstLine(e?.message || error);
  if (isAuthError(error)) text += ' — kubectl is no longer logged in to the cluster; log in again';
  return text;
}

export async function runUpgrade(ctx: UpgradeContext): Promise<UpgradeResult> {
  const ns = ctx.namespace;
  const log = ctx.log || ((m: string) => console.log(m));
  const env = ctx.env || process.env;
  // The passphrase is read once; no child (kubectl, the kit's setup-docker.js) inherits it
  const heldEnv: NodeJS.ProcessEnv = { SAIL_PROXY_BACKUP_PASSPHRASE: env.SAIL_PROXY_BACKUP_PASSPHRASE };
  const removedEnv = withoutSecretEnv();
  const kubectl = ctx.kubectl || spawnKubectl();
  const backupDir = path.resolve(ctx.backupDir || defaultBackupDir());
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
  // A process.exit anywhere (setup's own signal handling) still removes the plaintext temp files
  process.on('exit', cleanupSync);
  // A closed terminal (SIGHUP) makes writes fail with EIO/EPIPE: the rollback must not die of it
  const ignoreWriteError = () => {};
  process.stdout.on('error', ignoreWriteError);
  process.stderr.on('error', ignoreWriteError);
  runner.start();

  const stepKubectl = guarded(kubectl, () => runner.interrupted !== null);
  let from = 'unknown';
  let backup: string | undefined;
  let kitCleanup: (() => Promise<void>) | undefined;
  let scripts: KitScripts | undefined;
  const state: { applied: boolean; snapshot: KubeObject[] | null; dump: string | null; replicas?: { gateway: number; admin: number } } =
    { applied: false, snapshot: null, dump: null };
  const restoreCommand = () => (backup ? `sail-proxy restore kyma --namespace ${ns} --input ${quotePath(backup)} --manifests` : undefined);

  try {
    const kit = await (ctx.materializeKit || materializeKit)();
    temps.push(kit.root);
    kitCleanup = kit.cleanup;
    scripts = loadKitScripts(kit.root);
    const kitScripts = scripts;
    const read = ctx.kubectlRead || kitScripts.kubectlRead;
    const policy = { ...kit.policy, ...ctx.policy };
    // The installation's registry and organization (a mirror or a private org stays), this package's tag
    const target: ImageTarget = ctx.testImages || { tag: ctx.packageVersion };

    const installed = await runner.step('read', () => readInstallation({
      kubectl, read, kit: kitScripts, ns, policy, target, testMode: !!ctx.testImages, prompt: ctx.prompt,
    }));
    from = installed.from;
    state.replicas = installed.replicas;
    log(`Installed: ${from}. Target: ${target.tag}.`);

    const outputDir = fs.mkdtempSync(path.join(kit.root, '..', 'sail-proxy-render-'));
    temps.push(outputDir);
    const rendered = await runner.step('ask', async () => {
      const ip = await kubectl(['get', 'service', 'kubernetes', '-n', 'default', '-o', 'jsonpath={.spec.clusterIP}'])
        .then((r) => r.stdout.trim(), () => '');
      return renderTarget({
        kit: kitScripts, namespace: ns, outputDir, target, prompt: ctx.prompt,
        clusterIp: /^[0-9a-fA-F.:]+$/.test(ip) ? ip : '', kubectlRead: ctx.kubectlRead, adjustSetup: ctx.adjustSetup,
      });
    });
    log(`Target images: ${rendered.containerConfig.registry}/${rendered.containerConfig.organization}/sail-proxy-*:${target.tag}`);
    const lookupDigest = ctx.lookupDigest || ((c: unknown, i: string, t: string) => rendered.setup.lookupImageDigest(c, i, t));

    const passphrase = await runner.step('preflight', async () => {
      await preflight({
        kubectl, read: ctx.kubectlRead, kit: kitScripts, ns, backupDir, containerConfig: rendered.containerConfig,
        lookupDigest, statfs: ctx.statfs || defaultStatfs, outputDir, manifestsDir: rendered.manifestsDir, log,
      });
      return askBeforeOutage(ctx, heldEnv, log);
    });

    // --- the outage starts: from here on every failure rolls back ---
    runner.enterOutage();
    const work = fs.mkdtempSync(path.join(backupDir, '.sail-proxy-upgrade-'));
    temps.push(work);
    const replicas = installed.replicas;
    await runner.step('outage', () => kitScripts.dbOps.pauseDeployments(ns, { kubectl: stepKubectl, pollMs: ctx.pollMs }));

    await runner.step('backup', async (signal) => {
      state.snapshot = await readInstallObjects(stepKubectl, ns);
      const entries: Array<{ name: string; source: string }> = [];
      const put = (name: string, content: string) => {
        const file = path.join(work, ...name.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, content, { mode: 0o600 });
        entries.push({ name, source: file });
      };
      for (const obj of state.snapshot) put(`previous/${objectKey(obj)}.json`, JSON.stringify(obj, null, 2));
      put('previous/replicas.json', JSON.stringify(replicas));
      state.dump = path.join(work, 'database.sql.gz');
      log('Dumping the database...');
      await kitScripts.dbOps.dumpToLocalFile(ns, state.dump, { kubectl: stepKubectl, cleanupKubectl: kubectl, signal, log });
      entries.push({ name: 'database.sql.gz', source: state.dump });
      backup = path.join(backupDir, backupFileName(ns, from, (ctx.now || (() => new Date()))()));
      const head: Omit<BundleManifest, 'entries'> = { format: 1, kind: 'kyma', fromVersion: from, toVersion: target.tag, createdAt: new Date().toISOString() };
      async function* list() { yield* entries; }
      await (ctx.writeBundle || writeBundle)(backup, passphrase, head, list());
      log(`Backup written: ${backup}`);
    });

    const cmd = commandAdapter(stepKubectl);
    await runner.step('apply', async () => {
      state.applied = true;
      await kitScripts.deployKyma.deployToKyma({
        kymaDir: outputDir, argv: ['--namespace', ns], strict: true, holdAtZero: ['gateway', 'admin'], skipInstallRecord: true,
        kubectl: cmd, ...(ctx.kubectlRead ? { kubectlRead: ctx.kubectlRead } : {}),
      });
    });
    const jobs = (which: string) => kitScripts.migrationJobs.runMigrationJobs({
      namespace: ns, manifestsDir: rendered.manifestsDir, kubectl: cmd, jobs: [which], pollIntervalMs: ctx.pollMs ?? 2000,
    });
    await runner.step('migrate', async () => {
      await jobs('admin');
      // The file_search migration reads embedding settings from the admin: it runs once admin is up
      await kitScripts.dbOps.resumeDeployments(ns, { admin: replicas.admin }, { kubectl: stepKubectl });
      await jobs('file-search');
    });
    await runner.step('health', async () => {
      await kitScripts.dbOps.resumeDeployments(ns, { gateway: replicas.gateway }, { kubectl: stepKubectl });
      await checkHealth(stepKubectl, ns, { timeoutSeconds: ctx.healthTimeoutSeconds ?? 300, pollMs: ctx.pollMs ?? 5000 });
    });
    await runner.step('record', async () => {
      const r = await kitScripts.deployKyma.applyInstallRecord(rendered.manifestsDir, { recordedBy: 'upgrade', kubectl: cmd });
      if (!r.success) throw new Error('Recording the installation (sail-proxy-install) failed');
    });
    log(`\nUpgrade complete: ${from} → ${target.tag}. Backup of the previous version: ${backup}`);
    return { ok: true, from, to: target.tag, backup: backup! };
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
      await rollback({ kubectl, ns, state, dbOps: scripts!.dbOps, log, ctx, failedAt, backupRef: () => backup, dropBackup: () => { backup = undefined; } });
      log(`\nRolled back: the installation runs ${from} again on the database as it was before the upgrade.`);
      return { ok: false, failedAt, rolledBack: true, from, backup, error: why };
    } catch (rollbackError) {
      const cmd = restoreCommand();
      log(`\nTHE ROLLBACK FAILED: ${describe(rollbackError)}.`);
      if (!state.applied) {
        const r = state.replicas!;
        log(`Nothing new was applied and the database is untouched (it was only read). Start the previous version ${from} again by hand:`);
        log(`  kubectl scale deployment admin -n ${ns} --replicas=${r.admin}\n  kubectl scale deployment gateway -n ${ns} --replicas=${r.gateway}`);
      } else {
        log(`The installation may be partly upgraded.${backup ? ` The backup ${quotePath(backup)} was kept.` : ''}`);
        if (cmd) log(`Once kubectl works again, restore the previous version by hand:\n  ${cmd}`);
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

/** Removes SECRET_ENV from process.env (children inherit process.env); returns what it removed. */
export function withoutSecretEnv(): NodeJS.ProcessEnv {
  const removed: NodeJS.ProcessEnv = {};
  for (const key of SECRET_ENV) {
    if (process.env[key] !== undefined) removed[key] = process.env[key];
    delete process.env[key];
  }
  return removed;
}

/** The passphrase (null: --no-encrypt), after the warnings and the outage confirmation. */
export async function askBeforeOutage(ctx: Pick<UpgradeContext, 'prompt' | 'encrypt' | 'yes'>, env: NodeJS.ProcessEnv, log: (m: string) => void): Promise<string | null> {
  const ask = async (q: any) => ctx.prompt({ ...q, id: q.name, noBack: true });
  if (ctx.encrypt === false) {
    log('\nWARNING: --no-encrypt writes the backup unencrypted. It holds the installation\'s API keys and secrets in plain text.');
    if (!ctx.yes && !(await ask({ type: 'confirm', name: 'plainBackup', message: 'Write an unencrypted backup?', default: false }))) {
      throw new Refusal('Cancelled: no unencrypted backup. Nothing was changed.');
    }
  }
  const passphrase = await resolvePassphrase({
    encrypt: ctx.encrypt !== false, confirm: true, env,
    prompt: async (qs) => { const out: Record<string, string> = {}; for (const q of qs as any[]) out[q.name] = await ask(q); return out; },
  });
  if (!ctx.yes) {
    const go = await ask({ type: 'confirm', name: 'startOutage', default: true,
      message: 'The upgrade stops the gateway and admin for a few minutes (backup, new version, migrations). Start?' });
    if (!go) throw new Refusal('Cancelled before anything was stopped.');
  }
  return passphrase;
}

type RollbackState = { applied: boolean; snapshot: KubeObject[] | null; dump: string | null; replicas?: { gateway: number; admin: number } };

/** Back to the previous version: the old objects, the pre-upgrade database, the old replica counts. */
async function rollback(o: {
  kubectl: Kubectl; ns: string; state: RollbackState; dbOps: any; log: (m: string) => void; ctx: UpgradeContext;
  failedAt: StepId; backupRef: () => string | undefined; dropBackup: () => void;
}): Promise<void> {
  const { kubectl, ns, state, log } = o;
  const replicas = state.replicas!;
  if (!state.applied) {
    // Nothing new was applied and the database was only read: the old components come back
    const file = o.backupRef();
    if (file) {
      for (const f of [file, `${file}.partial`]) fs.rmSync(f, { force: true });
      o.dropBackup();
    }
  } else {
    // Both are written by the backup step, before anything is applied
    const { snapshot, dump } = state;
    if (!snapshot || !dump) throw new Error('No snapshot or dump to roll back to');
    await runPhase(log, 'Stopping the new components', async () => {
      for (const name of ['gateway', 'admin']) await kubectl(['scale', 'deployment', name, '-n', ns, '--replicas=0']);
      // No migration pod may still write while the database is restored
      await stopMigrationJobs(kubectl, ns, { timeoutSeconds: o.ctx.jobStopTimeoutSeconds ?? 120, pollMs: o.ctx.pollMs ?? 2000 });
    });
    const removed = await runPhase(log, 'Re-applying the previous version\'s objects', async () => {
      await restoreObjects(kubectl, snapshot, path.join(path.dirname(dump), 'rollback'), ['gateway', 'admin']);
      return deleteNewObjects(kubectl, ns, snapshot);
    });
    if (removed.length) log(`Removed what the new version added: ${removed.join(', ')}`);
    await runPhase(log, 'Restoring the database from the backup', async () => {
      await kubectl(['rollout', 'status', 'statefulset/postgres', '-n', ns, '--timeout=300s']);
      await o.dbOps.restoreFromLocalFile(ns, dump, { kubectl, log });
    });
  }
  await runPhase(log, 'Starting the previous version', () => o.dbOps.resumeDeployments(ns, replicas, { kubectl }));
  await runPhase(log, 'Waiting for the previous version to report healthy',
    () => checkHealth(kubectl, ns, { timeoutSeconds: o.ctx.healthTimeoutSeconds ?? 300, pollMs: o.ctx.pollMs ?? 5000 }));
}
