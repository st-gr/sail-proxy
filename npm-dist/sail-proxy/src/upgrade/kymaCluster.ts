// Cluster operations of `sail-proxy upgrade kyma` that act on the installation only: its namespace
// plus its own named objects outside it (ClusterRole/ClusterRoleBinding <ns>-dex, the per-install
// istio-system AuthorizationPolicies and EnvoyFilter). Every kubectl call goes through the runner.
import * as fs from 'fs';
import * as path from 'path';
import { Kubectl, isNotFound } from './kubectl';

export type KubeObject = {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string>; ownerReferences?: unknown[]; [k: string]: unknown };
  spec?: { replicas?: number; [k: string]: unknown };
  [k: string]: unknown;
};

export const PART_OF_LABEL = 'app.kubernetes.io/part-of';
const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';
export const NAMESPACE_LABEL = 'sail-proxy/namespace';
export const DEFAULT_NAMESPACE = 'sail-proxy';

/** In-namespace kinds the release applies (the snapshot covers them). */
export const NAMESPACED_RESOURCES = [
  'deployments.apps', 'statefulsets.apps', 'services', 'configmaps', 'secrets', 'serviceaccounts',
  'networkpolicies.networking.k8s.io', 'destinationrules.networking.istio.io',
  'peerauthentications.security.istio.io', 'authorizationpolicies.security.istio.io',
  'virtualservices.networking.istio.io', 'apirules.gateway.kyma-project.io',
];
const CLUSTER_RESOURCES = ['clusterroles.rbac.authorization.k8s.io', 'clusterrolebindings.rbac.authorization.k8s.io'];
const ISTIO_RESOURCES = ['authorizationpolicies.security.istio.io', 'envoyfilters.networking.istio.io'];
export const MIGRATION_JOBS = ['sail-proxy-migrate-admin', 'sail-proxy-migrate-file-search'];

// Objects in the namespace that the cluster makes, not the release
const SYSTEM_OBJECTS = new Set(['ConfigMap/kube-root-ca.crt', 'ConfigMap/istio-ca-root-cert', 'ServiceAccount/default']);

const prefixOf = (ns: string) => (ns === DEFAULT_NAMESPACE ? '' : `${ns}-`);

/** Whether an istio-system object belongs to this installation (deploy-kyma.js's naming). */
export function ownsIstioObject(obj: KubeObject, ns: string): boolean {
  const name = obj.metadata.name;
  const owner = obj.metadata.labels?.[NAMESPACE_LABEL];
  const p = prefixOf(ns);
  if (ns !== DEFAULT_NAMESPACE && owner === ns) return true;
  if (owner !== undefined && owner !== ns) return false;
  if (['allowlist-cp-tunnel', 'allowlist-cp-healthcheck', 'health-check-external-deny', 'streaming-timeouts'].map((n) => p + n).includes(name)) return true;
  return ns === DEFAULT_NAMESPACE ? name.includes('allowlist-sail-proxy') : name.startsWith(`${p}allowlist-`);
}

const resourceOf = (obj: KubeObject): string => {
  const group = obj.apiVersion.includes('/') ? obj.apiVersion.split('/')[0] : '';
  return `${obj.kind.toLowerCase()}${group ? `.${group}` : ''}`;
};

const singular = (resource: string): string => {
  const [plural, ...group] = resource.split('.');
  return `${plural.replace(/ies$/, 'y').replace(/s$/, '')}${group.length ? `.${group.join('.')}` : ''}`;
};
const NAMESPACED_KINDS = new Set(NAMESPACED_RESOURCES.map(singular));
const ISTIO_KINDS = new Set(ISTIO_RESOURCES.map(singular));
const CLUSTER_KINDS = new Set(CLUSTER_RESOURCES.map(singular));

/** Whether readInstallObjects could have snapshotted this object of installation ns (nothing else may be restored from a bundle). */
export function isInstallObject(obj: KubeObject, ns: string): boolean {
  if (!obj || typeof obj !== 'object' || typeof obj.kind !== 'string' || typeof obj.apiVersion !== 'string' || !obj.metadata || typeof obj.metadata.name !== 'string') return false;
  const kind = resourceOf(obj);
  const namespace = obj.metadata.namespace;
  if (namespace === ns) return NAMESPACED_KINDS.has(kind);
  if (namespace === 'istio-system') return ISTIO_KINDS.has(kind) && ownsIstioObject(obj, ns);
  if (namespace === undefined) return CLUSTER_KINDS.has(kind) && obj.metadata.name === `${ns}-dex`;
  return false;
}

/** A stable name for an object: <scope>/<Kind>-<name>. */
export const objectKey = (obj: KubeObject): string =>
  `${obj.metadata.namespace || '_cluster'}/${obj.kind}-${obj.metadata.name}`;

/**
 * The object as it can be re-applied: without server-set fields and status. The last-applied
 * annotation stays: a rollback that dropped it would leave the next `kubectl apply` without its
 * three-way merge base (a warning per object, and fields removed since could not be pruned).
 */
export function cleanObject(obj: KubeObject): KubeObject {
  const out = JSON.parse(JSON.stringify(obj)) as KubeObject;
  for (const k of ['uid', 'resourceVersion', 'generation', 'creationTimestamp', 'managedFields', 'selfLink']) delete out.metadata[k];
  delete out.status;
  return out;
}

async function list(kubectl: Kubectl, resource: string, ns: string | null): Promise<KubeObject[]> {
  try {
    const { stdout } = await kubectl(['get', resource, ...(ns ? ['-n', ns] : []), '-o', 'json']);
    return (JSON.parse(stdout).items || []) as KubeObject[];
  } catch (error) {
    // A cluster without the CRD (istio, Kyma APIRule) has no such objects
    if (/doesn't have a resource type|the server could not find the requested resource/.test(String((error as { stderr?: string }).stderr || ''))) return [];
    throw error;
  }
}

async function getOne(kubectl: Kubectl, resource: string, name: string): Promise<KubeObject | null> {
  try {
    return JSON.parse((await kubectl(['get', resource, name, '-o', 'json'])).stdout) as KubeObject;
  } catch (error) {
    if (isNotFound(error) || /doesn't have a resource type/.test(String((error as { stderr?: string }).stderr || ''))) return null;
    throw error;
  }
}

/** The installation's live objects (what the release applies, without controller-made ones). */
export async function readInstallObjects(kubectl: Kubectl, ns: string): Promise<KubeObject[]> {
  const objects: KubeObject[] = [];
  for (const resource of NAMESPACED_RESOURCES) {
    for (const obj of await list(kubectl, resource, ns)) {
      if ((obj.metadata.ownerReferences || []).length > 0) continue;
      if (SYSTEM_OBJECTS.has(`${obj.kind}/${obj.metadata.name}`)) continue;
      if (obj.kind === 'Secret' && obj.type === 'kubernetes.io/service-account-token') continue;
      objects.push(obj);
    }
  }
  for (const resource of CLUSTER_RESOURCES) {
    const obj = await getOne(kubectl, resource, `${ns}-dex`);
    if (obj) objects.push(obj);
  }
  for (const resource of ISTIO_RESOURCES) {
    for (const obj of await list(kubectl, resource, 'istio-system')) if (ownsIstioObject(obj, ns)) objects.push(obj);
  }
  return objects.map(cleanObject);
}

// Apply order: what pods read first, workloads last
const KIND_ORDER = ['ServiceAccount', 'ClusterRole', 'ClusterRoleBinding', 'Secret', 'ConfigMap', 'Service', 'NetworkPolicy',
  'PeerAuthentication', 'DestinationRule', 'AuthorizationPolicy', 'EnvoyFilter', 'VirtualService', 'APIRule', 'StatefulSet', 'Deployment'];
const rank = (o: KubeObject) => { const i = KIND_ORDER.indexOf(o.kind); return i < 0 ? KIND_ORDER.length : i; };

/** The API server's answer to an update at a resourceVersion that is no longer current. */
export const isConflict = (error: unknown): boolean =>
  /\(Conflict\)/.test(String((error as { stderr?: string })?.stderr || ''));
const REPLACE_ATTEMPTS = 5;

/** An error the API server gives for a field that cannot change (the object must be recreated). */
export const isInvalid = (error: unknown): boolean =>
  /\(Invalid\)|field is immutable|is immutable/.test(String((error as { stderr?: string })?.stderr || ''));

/**
 * Puts the snapshot objects back as they were: each is replaced as a whole (so fields the new
 * version added go too) at the live object's resourceVersion (custom resources require it), created
 * when it is gone, and deleted and recreated only when the server calls a changed field immutable.
 * A Conflict (a controller wrote it meanwhile) is retried at the new resourceVersion, up to
 * REPLACE_ATTEMPTS times; any other error (Unauthorized) stops the rollback. Deployments named in holdAtZero
 * come back with 0 replicas.
 */
export async function restoreObjects(kubectl: Kubectl, objects: KubeObject[], tmpDir: string, holdAtZero: string[] = []): Promise<void> {
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const sorted = [...objects].sort((a, b) => rank(a) - rank(b));
  for (const [i, original] of sorted.entries()) {
    const obj = JSON.parse(JSON.stringify(original)) as KubeObject;
    delete obj.metadata.resourceVersion;
    if (obj.kind === 'Deployment' && holdAtZero.includes(obj.metadata.name)) obj.spec = { ...obj.spec, replicas: 0 };
    const file = path.join(tmpDir, `object-${i}.json`);
    const write = () => fs.writeFileSync(file, JSON.stringify(obj), { mode: 0o600 });
    write();
    try {
      for (let attempt = 1; ; attempt++) {
        let live: KubeObject | null = null;
        try {
          live = JSON.parse((await kubectl(['get', '-f', file, '-o', 'json'])).stdout) as KubeObject;
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        if (!live) {
          delete obj.metadata.resourceVersion;
          write();
          await kubectl(['create', '-f', file]);
          break;
        }
        obj.metadata.resourceVersion = live.metadata.resourceVersion;
        write();
        try {
          await kubectl(['replace', '-f', file]);
          break;
        } catch (error) {
          // A controller wrote the object between get and replace: read the new version, again
          if (isConflict(error) && attempt < REPLACE_ATTEMPTS) continue;
          if (!isInvalid(error)) throw error;
          delete obj.metadata.resourceVersion;
          write();
          await kubectl(['replace', '--force', '-f', file]);
          break;
        }
      }
      // create and replace rewrite an existing last-applied annotation from the file they sent,
      // resourceVersion included, and the next `kubectl apply` would patch that away (refused for
      // custom resources): put the snapshot's annotation back as it was.
      const lastApplied = original.metadata.annotations?.[LAST_APPLIED];
      if (lastApplied) {
        fs.writeFileSync(file, lastApplied, { mode: 0o600 });
        await kubectl(['apply', 'set-last-applied', '-f', file]);
      }
    } finally {
      fs.rmSync(file, { force: true });
    }
  }
}

/**
 * Deletes the upgrade's migration Jobs in the foreground and waits until none of their pods is
 * left, so nothing writes while the database is restored. Throws after timeoutSeconds.
 */
export async function stopMigrationJobs(kubectl: Kubectl, ns: string, { timeoutSeconds = 120, pollMs = 2000 } = {}): Promise<void> {
  await kubectl(['delete', 'jobs.batch', ...MIGRATION_JOBS, '-n', ns, '--ignore-not-found', '--cascade=foreground', '--wait=true', `--timeout=${timeoutSeconds}s`]);
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const { stdout } = await kubectl(['get', 'pods', '-n', ns, '-l', `job-name in (${MIGRATION_JOBS.join(',')})`, '-o', 'name']);
    if (!stdout.trim()) return;
    if (Date.now() >= deadline) throw new Error(`Migration pods are still running after ${timeoutSeconds}s (${stdout.trim().split('\n').join(', ')}); the database was not restored`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Deletes what the new version created that the snapshot lacks: only objects labelled as this
 * installation's (part-of sail-proxy, or the namespace label). The migration Jobs: stopMigrationJobs.
 */
export async function deleteNewObjects(kubectl: Kubectl, ns: string, snapshot: KubeObject[]): Promise<string[]> {
  const before = new Set(snapshot.map(objectKey));
  const deleted: string[] = [];
  for (const obj of await readInstallObjects(kubectl, ns)) {
    const labels = obj.metadata.labels || {};
    if (before.has(objectKey(obj))) continue;
    if (labels[PART_OF_LABEL] !== 'sail-proxy' && labels[NAMESPACE_LABEL] !== ns) continue;
    await kubectl(['delete', resourceOf(obj), obj.metadata.name, ...(obj.metadata.namespace ? ['-n', obj.metadata.namespace] : []), '--ignore-not-found']);
    deleted.push(objectKey(obj));
  }
  return deleted;
}

const probe = (port: number, urlPath: string) =>
  `require('http').get('http://127.0.0.1:${port}${urlPath}',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))`;
const ENDPOINTS: Record<string, { port: number; path: string }> = {
  gateway: { port: 8080, path: '/health' },
  admin: { port: 4004, path: '/api/health' },
};

/**
 * Health of the installation: every Deployment and StatefulSet with replicas rolled out, then the
 * gateway's /health and the admin's /api/health answering 200 from inside their own container
 * (kubectl exec + node; no port-forward, no extra pod, no network policy in the way), within
 * timeoutSeconds in total.
 */
export async function checkHealth(kubectl: Kubectl, ns: string, { timeoutSeconds = 300, pollMs = 5000 } = {}): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const left = () => Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
  const replicas: Record<string, number> = {};
  for (const [resource, kind] of [['deployments.apps', 'deployment'], ['statefulsets.apps', 'statefulset']]) {
    for (const obj of await list(kubectl, resource, ns)) {
      const n = obj.spec?.replicas ?? 1;
      if (kind === 'deployment') replicas[obj.metadata.name] = n;
      if (n > 0) await kubectl(['rollout', 'status', `${kind}/${obj.metadata.name}`, '-n', ns, `--timeout=${left()}s`]);
    }
  }
  for (const [name, endpoint] of Object.entries(ENDPOINTS)) {
    if (!replicas[name]) continue;
    for (;;) {
      try {
        await kubectl(['exec', `deploy/${name}`, '-n', ns, '-c', name, '--', 'node', '-e', probe(endpoint.port, endpoint.path)]);
        break;
      } catch (error) {
        if (Date.now() + pollMs > deadline) throw new Error(`${name} did not answer ${endpoint.path} with 200 within ${timeoutSeconds}s`);
        await new Promise((r) => setTimeout(r, pollMs));
      }
    }
  }
}

/** Every verb/resource the run and its rollback need; returns the ones kubectl may not use. */
export async function missingPermissions(kubectl: Kubectl, ns: string, concurrency = 8): Promise<string[]> {
  const all = ['get', 'list', 'create', 'update', 'patch', 'delete'];
  const checks: Array<[string, string, string | null]> = [];
  for (const r of [...NAMESPACED_RESOURCES, 'jobs.batch']) for (const v of all) checks.push([v, r, ns]);
  for (const r of CLUSTER_RESOURCES) for (const v of all) checks.push([v, r, null]);
  for (const r of ISTIO_RESOURCES) for (const v of all) checks.push([v, r, 'istio-system']);
  // rollout status and delete --wait watch; subresources are asked with --subresource (a
  // "pods/exec" resource argument would ask about a pod named exec)
  for (const r of ['deployments.apps', 'statefulsets.apps', 'jobs.batch', 'pods']) checks.push(['watch', r, ns]);
  checks.push(['get', 'pods', ns], ['list', 'pods', ns], ['create', 'pods --subresource=exec', ns], ['get', 'pods --subresource=log', ns],
    ['update', 'deployments.apps --subresource=scale', ns], ['patch', 'deployments.apps --subresource=scale', ns],
    ['get', 'namespaces', null], ['patch', 'namespaces', null]);
  const missing: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < checks.length) {
      const [verb, resource, where] = checks[next++];
      const label = `${verb} ${resource}${where ? ` -n ${where}` : ''}`;
      try {
        const { stdout } = await kubectl(['auth', 'can-i', verb, ...resource.split(' '), ...(where ? ['-n', where] : [])]);
        if (stdout.trim() !== 'yes') missing.push(label);
      } catch (error) {
        // can-i exits 1 with "no"; anything else (Unauthorized, unreachable) is not an answer
        if (String((error as { stdout?: string }).stdout || '').trim() === 'no') missing.push(label);
        else throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return missing.sort();
}

/** The image of a workload's first container, or null when the workload is absent. */
export async function workloadImage(kubectl: Kubectl, ns: string, kind: 'deployment' | 'statefulset', name: string): Promise<string | null> {
  try {
    const { stdout } = await kubectl(['get', kind, name, '-n', ns, '-o', 'json']);
    const containers = (JSON.parse(stdout).spec?.template?.spec?.containers || []) as Array<{ image?: string }>;
    return containers[0]?.image || null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Free bytes for the backup directory (created when missing). */
export async function freeBytes(dir: string): Promise<number> {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const s = await fs.promises.statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}
