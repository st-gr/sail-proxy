/**
 * Read-only kubectl access shared by setup-kyma.js and deploy-kyma.js, for
 * reading a live namespace's Secrets before anything is generated or applied.
 *
 * Only `kubectl get …` and the two config reads below can run through here,
 * without a shell. The failure classification is deliberately strict: only
 * the API server's own NotFound for exactly the object asked for means
 * "absent". Client-side failures ("context was not found…", "executable
 * kubectl-oidc_login not found") say "not found" too without reaching the
 * cluster, and treating them as absence would rotate a running deployment's
 * keys.
 */

const { execFileSync } = require('child_process');

// The only kubectl config commands allowed: read the current context and its
// cluster server, to show which cluster a "new namespace" was checked on.
const KUBECTL_CONFIG_READS = [
  ['config', 'current-context'],
  ['config', 'view', '--minify', '-o', 'jsonpath={.clusters[0].cluster.server}']
];

/**
 * Run a read-only kubectl command and return its stdout: `kubectl get ...`,
 * or exactly one of KUBECTL_CONFIG_READS. Anything else is refused, so this
 * path can never change the cluster or the kubeconfig. Throws kubectl's error
 * (with .stderr) on failure.
 */
function runKubectlRead(args) {
  const allowedConfigRead = KUBECTL_CONFIG_READS.some(read =>
    read.length === args.length && read.every((part, i) => part === args[i]));
  if (args[0] !== 'get' && !allowedConfigRead) {
    throw new Error(`runKubectl is read-only; refusing "kubectl ${args.join(' ')}"`);
  }
  return execFileSync('kubectl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** First line of kubectl's stderr (or the error message), for error messages. */
function stderrOf(error) {
  return String((error && (error.stderr || error.message)) || '').trim().split('\n')[0];
}

/** True only for the API server's NotFound for exactly this object, e.g. resource "namespaces". */
function isServerNotFound(error, resource, name) {
  const expected = `Error from server (NotFound): ${resource} "${name}" not found`;
  return String((error && error.stderr) || '').split('\n').some(line => line.trim() === expected);
}

/** A cluster that is positively unreachable (setup --ci may then generate keys). */
function isUnreachable(error) {
  if (error && error.code === 'ENOENT') return true; // kubectl not installed
  const stderr = String((error && error.stderr) || '');
  if (/getting credentials/i.test(stderr)) return false;
  return /^Unable to connect to the server: dial tcp[ :]/m.test(stderr) ||
    /^The connection to the server \S+ was refused/m.test(stderr);
}

/**
 * Whether the namespace exists: true, false only for the server's exact
 * NotFound; any other failure is rethrown unchanged for the caller to judge.
 */
function namespaceExists(run, namespace) {
  try {
    run(['get', 'namespace', namespace, '-o', 'name']);
    return true;
  } catch (error) {
    if (isServerNotFound(error, 'namespaces', namespace)) return false;
    throw error;
  }
}

/**
 * The data of a Secret (base64-decoded) or ConfigMap in the namespace, or null
 * when the server reports it NotFound. Any other failure throws an error
 * naming the object (never its content).
 */
function readResourceData(run, kind, name, namespace) {
  let output;
  try {
    output = run(['get', kind, name, '-n', namespace, '-o', 'json']);
  } catch (error) {
    if (isServerNotFound(error, `${kind}s`, name)) return null;
    throw new Error(`Cannot read ${kind} ${name} in namespace ${namespace} (kubectl: ${stderrOf(error)}).`);
  }
  const data = JSON.parse(output).data || {};
  if (kind !== 'secret') return data;
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Buffer.from(v, 'base64').toString('utf8')]));
}

module.exports = {
  KUBECTL_CONFIG_READS,
  runKubectlRead,
  stderrOf,
  isServerNotFound,
  isUnreachable,
  namespaceExists,
  readResourceData
};
