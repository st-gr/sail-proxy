// `sail-proxy restore kyma`: puts a backup an upgrade wrote back by hand — the database, and with
// --manifests the previous version's objects. Nothing is applied before the bundle's GCM tag and
// every entry's sha256 have been checked (openBundle).
import * as fs from 'fs';
import * as path from 'path';
import { BundleError, openBundle, resolvePassphrase } from './bundle';
import { materializeKit } from './kit';
import { Kubectl, SECRET_ENV, spawnKubectl } from './kubectl';
import { KubeObject, checkHealth, deleteNewObjects, isInstallObject, restoreObjects, stopMigrationJobs } from './kymaCluster';
import { PromptOne, loadKitScripts } from './kymaRender';
import { describe } from './kyma';
import { SignalSource, runPhase } from './steps';

export type RestoreContext = {
  namespace: string;
  input: string;
  manifests?: boolean;
  yes?: boolean;
  prompt: PromptOne;
  kubectl?: Kubectl;
  env?: NodeJS.ProcessEnv;
  log?: (m: string) => void;
  materializeKit?: typeof materializeKit;
  healthTimeoutSeconds?: number;
  pollMs?: number;
  signals?: SignalSource;
};

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

export async function runRestore(ctx: RestoreContext): Promise<{ ok: boolean; error?: string }> {
  const ns = ctx.namespace;
  const log = ctx.log || ((m: string) => console.log(m));
  const kubectl = ctx.kubectl || spawnKubectl();
  // Once something changes a signal does not stop the restore (half-restored is worse): it is noted
  const signals: SignalSource = ctx.signals || process;
  let phase = '';
  const onSignal = (signal: string) => {
    log(`\n${signal} received: the restore is ${phase}; it runs to completion (signal ignored). If this process is killed anyway, run the same \`sail-proxy restore kyma\` command again.`);
  };
  const input = path.resolve(ctx.input);
  const ask = async (q: Record<string, unknown>) => ctx.prompt({ ...q, id: q.name, noBack: true });
  const work = fs.mkdtempSync(path.join(path.dirname(input), '.sail-proxy-restore-'));
  const cleanup = () => fs.rmSync(work, { recursive: true, force: true });
  process.on('exit', cleanup);
  // The passphrase is read once; no child process inherits it
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
    if (bundle.manifest.kind !== 'kyma') throw new Error(`${input} is a ${bundle.manifest.kind} backup, not a Kyma one`);
    const names = bundle.manifest.entries.map((e) => e.name);
    const objects: KubeObject[] = ctx.manifests
      ? names.filter((n) => /^previous\/.+\/[^/]+\.json$/.test(n)).map((n) => JSON.parse(fs.readFileSync(bundle!.path(n), 'utf8')) as KubeObject)
      : [];
    const foreign = objects.filter((o) => o.metadata.namespace && o.metadata.namespace !== ns && o.metadata.namespace !== 'istio-system');
    if (foreign.length > 0) throw new Error(`The backup was taken from namespace ${foreign[0].metadata.namespace}, not ${ns}`);
    const alien = objects.find((o) => !isInstallObject(o, ns));
    if (alien) throw new Error(`The backup holds ${alien && alien.kind}/${alien && alien.metadata && alien.metadata.name}, which is not an object of installation ${ns}; nothing was changed`);
    const replicas = names.includes('previous/replicas.json')
      ? JSON.parse(fs.readFileSync(bundle.path('previous/replicas.json'), 'utf8'))
      : { gateway: 1, admin: 1 };

    log(`Backup of ${bundle.manifest.fromVersion} from ${bundle.manifest.createdAt}: database${ctx.manifests ? ` and ${objects.length} objects` : ''}.`);
    if (!ctx.yes && !(await ask({ type: 'confirm', name: 'confirmRestore', default: false,
      message: `Replace the database${ctx.manifests ? ' and the objects' : ''} of namespace ${ns} with this backup? The gateway and admin stop meanwhile.` }))) {
      return { ok: false, error: 'cancelled' };
    }
    kit = await (ctx.materializeKit || materializeKit)();
    const { dbOps } = loadKitScripts(kit.root);
    for (const name of SIGNALS) signals.on(name, onSignal);
    const dumpFile = bundle.path('database.sql.gz');
    // `phase` names what a signal interrupts (the restore runs on regardless)
    const step = <T>(label: string, fn: () => Promise<T>): Promise<T> => {
      phase = `${label.charAt(0).toLowerCase()}${label.slice(1)}`;
      return runPhase(log, label, fn);
    };
    await step('Stopping the gateway and admin', async () => {
      await dbOps.pauseDeployments(ns, { kubectl, pollMs: ctx.pollMs });
      await stopMigrationJobs(kubectl, ns, { pollMs: ctx.pollMs ?? 2000 });
    });
    if (ctx.manifests) {
      const removed = await step('Re-applying the previous version\'s objects', async () => {
        await restoreObjects(kubectl, objects, path.join(work, 'apply'), ['gateway', 'admin']);
        return deleteNewObjects(kubectl, ns, objects);
      });
      if (removed.length) log(`Removed objects the backup does not have: ${removed.join(', ')}`);
    }
    await step('Restoring the database from the backup', async () => {
      await kubectl(['rollout', 'status', 'statefulset/postgres', '-n', ns, '--timeout=300s']);
      await dbOps.restoreFromLocalFile(ns, dumpFile, { kubectl, log });
    });
    await step('Starting the previous version', () => dbOps.resumeDeployments(ns, replicas, { kubectl }));
    await step('Waiting for the previous version to report healthy',
      () => checkHealth(kubectl, ns, { timeoutSeconds: ctx.healthTimeoutSeconds ?? 300, pollMs: ctx.pollMs ?? 5000 }));
    log(`Restored namespace ${ns} from ${input}.`);
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
