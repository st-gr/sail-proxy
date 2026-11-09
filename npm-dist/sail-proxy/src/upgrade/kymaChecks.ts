// The checks of `sail-proxy upgrade kyma` before anything is stopped: what is installed (read) and
// whether the run can succeed and be rolled back (preflight). Each failure is a Refusal.
import * as path from 'path';
import { Kubectl, KubectlRead, commandAdapter, isNotFound } from './kubectl';
import { freeBytes, missingPermissions, workloadImage } from './kymaCluster';
import { KitScripts, ImageTarget, PromptOne } from './kymaRender';
import { UpgradePolicy } from './kit';
import { compareVersions } from '../utils/version';

export class Refusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Refusal';
  }
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
export const isSemver = (v: string) => SEMVER.test(v);

/** Refuses a source below minUpgradeFrom and, outside test mode, a non-release source or a target that is not newer. */
export function checkVersions(from: string, tag: string, policy: UpgradePolicy, testMode: boolean): void {
  if (isSemver(from) && compareVersions(from, policy.minUpgradeFrom) < 0) {
    throw new Refusal(`The installation runs ${from}; \`upgrade\` starts from ${policy.minUpgradeFrom}. Upgrade to ${policy.minUpgradeFrom} with that release's setup first.`);
  }
  if (!testMode) {
    if (!isSemver(from)) throw new Refusal(`The installation runs ${from}, not a release; only a test run (--registry, --organization, --tag) can upgrade it.`);
    if (compareVersions(tag, from) <= 0) throw new Refusal(`The installation already runs ${from}; this package (${tag}) is not newer.`);
  }
}

export type Installation = { from: string; replicas: { gateway: number; admin: number } };

async function replicasOf(kubectl: Kubectl, ns: string, name: string): Promise<number> {
  const { stdout } = await kubectl(['get', 'deployment', name, '-n', ns, '-o', 'json']);
  const n = JSON.parse(stdout).spec?.replicas;
  return typeof n === 'number' ? n : 1;
}

/** Step `read`: the installed version and replica counts; refuses what cannot be upgraded. */
export async function readInstallation(o: {
  kubectl: Kubectl; read: KubectlRead; kit: KitScripts; ns: string; policy: UpgradePolicy;
  target: ImageTarget; testMode: boolean; prompt: PromptOne;
}): Promise<Installation> {
  const { kubectl, ns, policy, target } = o;
  try {
    await kubectl(['get', 'namespace', ns, '-o', 'name']);
  } catch (error) {
    if (isNotFound(error)) throw new Refusal(`Namespace ${ns} does not exist on this cluster: there is no installation to upgrade.`);
    throw error;
  }
  const gateway = await workloadImage(kubectl, ns, 'deployment', 'gateway');
  if (!gateway || !/sail-proxy-gateway[:@]/.test(gateway)) throw new Refusal(`Namespace ${ns} holds no sail-proxy installation (no gateway Deployment).`);
  if (policy.storageLayoutChange) {
    throw new Refusal('This release changes the layout of file storage or Valkey data; it cannot be installed by `upgrade`. See its release notes.');
  }
  const postgres = await workloadImage(kubectl, ns, 'statefulset', 'postgres');
  if (postgres !== policy.postgresImage) {
    throw new Refusal(`The installation runs Postgres image ${postgres || '(none)'}, this release needs ${policy.postgresImage}; a Postgres image change is not done by \`upgrade\`.`);
  }

  const record = await o.kit.installRecord.readInstallRecord(o.read, ns);
  const tag = /:([^@/:]+)$/.exec(gateway)?.[1];
  let from: string = (record && record.version) || tag || '';
  if (!from) {
    // Images pinned by digest and no install record: held nowhere, asked once
    from = String(await o.prompt({
      type: 'input', name: 'installedVersion', id: 'installedVersion', noBack: true,
      message: 'The installed images are pinned by digest. Which sail-proxy version is installed (e.g. 0.11.0)?',
      validate: (v: string) => (String(v).trim() ? true : 'A version is required'),
    })).trim();
  }

  checkVersions(from, target.tag, policy, o.testMode);
  return { from, replicas: { gateway: await replicasOf(kubectl, ns, 'gateway'), admin: await replicasOf(kubectl, ns, 'admin') } };
}

const MB = 1024 * 1024;

/**
 * Free space the backup directory needs for a database of `dbBytes`: the run writes up to three
 * copies of the (gzip) dump there - the dump fetched from the pod, the backup bundle, and, should the
 * rollback restore, the filtered restore input - each at most the database's size, plus 100 MB.
 */
export function backupSpaceNeeded(dbBytes: number): number {
  return 3 * dbBytes + 100 * MB;
}
const IMAGES = ['sail-proxy-admin', 'sail-proxy-gateway', 'sail-proxy-nginx'];

/** Step `preflight`: rights, images, no rebuild running, disk space, and a server-side dry run. */
export async function preflight(o: {
  kubectl: Kubectl; read?: KubectlRead; kit: KitScripts; ns: string; backupDir: string;
  containerConfig: { registry: string; organization: string; tag: string };
  lookupDigest: (config: unknown, image: string, tag: string) => Promise<string>;
  statfs: (dir: string) => Promise<number>;
  outputDir: string; manifestsDir: string; log: (m: string) => void;
}): Promise<void> {
  const { kubectl, ns } = o;
  const missing = await missingPermissions(kubectl, ns);
  if (missing.length > 0) {
    throw new Refusal(`kubectl may not do everything the upgrade and its rollback need (${missing.length} missing, e.g. ${missing.slice(0, 5).join('; ')}). Nothing was changed.`);
  }
  for (const image of IMAGES) {
    const ref = `${o.containerConfig.registry}/${o.containerConfig.organization}/${image}:${o.containerConfig.tag}`;
    try {
      await o.lookupDigest(o.containerConfig, image, o.containerConfig.tag);
    } catch (error) {
      throw new Refusal(`Image ${ref} cannot be found with the installation's registry login (${(error as Error).message}). Nothing was changed.`);
    }
  }
  const rebuild = await o.kit.dbOps.findRunningIndexRebuild(ns, { kubectl });
  if (rebuild.length > 0) {
    throw new Refusal(`A file_search rebuild-index Job is running (${rebuild.join(', ')}). Wait for it to finish, then run the upgrade again.`);
  }
  const size = await o.kit.dbOps.databaseSize(ns, { kubectl });
  const need = backupSpaceNeeded(size);
  const free = await o.statfs(o.backupDir);
  if (free < need) {
    throw new Refusal(`Not enough free space for the backup in ${o.backupDir}: ${Math.ceil(need / MB)} MB needed (3 × the ${Math.ceil(size / MB)} MB database - dump, backup and a possible rollback's restore input - plus 100 MB), ${Math.floor(free / MB)} MB free.`);
  }
  o.log('Validating the new manifests on the server (dry run)...');
  try {
    await o.kit.deployKyma.deployToKyma({
      kymaDir: o.outputDir, argv: ['--namespace', ns], strict: true, dryRun: true,
      kubectl: commandAdapter(kubectl), ...(o.read ? { kubectlRead: o.read } : {}),
    });
    await kubectl(['apply', '-f', path.join(o.manifestsDir, 'upgrade', 'migrate-jobs.yaml'), '--dry-run=server']);
  } catch (error) {
    const e = error as { step?: string; stderr?: string; message: string };
    throw new Refusal(`The server rejected the new manifests in a dry run (${e.step || 'apply'}: ${String(e.stderr || e.message).trim().split('\n')[0]}). Nothing was changed.`);
  }
}

export const defaultStatfs = freeBytes;
