/**
 * The Kubernetes namespace a Kyma deployment lives in, and every name derived
 * from it that setup-kyma.js (which renders) and deploy-kyma.js (which applies)
 * must agree on.
 *
 * The default namespace keeps the paths and object names it always had, so a
 * production cluster set up before the namespace became configurable sees no
 * rename. Any other namespace renders into its own folder and gives every
 * object that lives outside its namespace (istio-system policies, cluster-scoped
 * RBAC) a namespace-prefixed name, so a second deployment on the same cluster
 * can neither overwrite nor delete production's.
 */

const path = require('path');

const DEFAULT_NAMESPACE = 'sail-proxy';

// Label on the istio-system policies a non-default namespace generates, so
// deploy-kyma.js can find (and clean up) exactly its own and nothing else.
const NAMESPACE_LABEL = 'sail-proxy/namespace';

// Deploying into one of these would mix the gateway's objects into the
// cluster's own; no deployment of this app belongs there.
const SYSTEM_NAMESPACES = ['default', 'istio-system', 'kyma-system'];

function isDefaultNamespace(namespace) {
  return namespace === DEFAULT_NAMESPACE;
}

/**
 * RFC 1123 label (the Kubernetes namespace rule), and not a system namespace.
 * The label rule matches setup-kyma.js's validateRFC1123Label; it is repeated
 * here because deploy-kyma.js interpolates the namespace into shell commands
 * and cannot load setup-kyma.js.
 */
function validateNamespace(namespace) {
  if (!namespace || typeof namespace !== 'string') {
    return 'Namespace must be a non-empty string';
  }
  if (namespace.length > 63 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(namespace)) {
    return 'Namespace must be an RFC 1123 label: at most 63 lowercase alphanumeric characters or hyphens, starting and ending with an alphanumeric character';
  }
  if (SYSTEM_NAMESPACES.includes(namespace) || namespace.startsWith('kube-')) {
    return `"${namespace}" is a system namespace; choose a namespace of its own`;
  }
  return true;
}

/**
 * Folder that holds a namespace's rendered manifests/ and templates/{secrets,configmaps}/.
 * The default namespace keeps the kyma root; any other gets kyma/deployments/<ns>/.
 */
function outputRoot(kymaDir, namespace) {
  return isDefaultNamespace(namespace) ? kymaDir : path.join(kymaDir, 'deployments', namespace);
}

/** Prefix for names of objects outside the namespace: none for the default. */
function istioSystemPrefix(namespace) {
  return isDefaultNamespace(namespace) ? '' : `${namespace}-`;
}

function istioSystemName(namespace, baseName) {
  return istioSystemPrefix(namespace) + baseName;
}

/** Ownership labels for generated istio-system policies: none for the default. */
function namespaceLabels(namespace) {
  return isDefaultNamespace(namespace) ? {} : { [NAMESPACE_LABEL]: namespace };
}

/**
 * Value of `--namespace <ns>` or `--namespace=<ns>`; undefined when absent.
 * Throws when the flag is given without a value, rather than silently falling
 * back to the default namespace (which is production's).
 */
function parseNamespaceArg(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--namespace=')) {
      const value = arg.slice('--namespace='.length);
      if (!value) throw new Error('--namespace needs a value, e.g. --namespace sail-proxy-test');
      return value;
    }
    if (arg === '--namespace') {
      const value = args[i + 1];
      if (!value || value.startsWith('-')) {
        throw new Error('--namespace needs a value, e.g. --namespace sail-proxy-test');
      }
      return value;
    }
  }
  return undefined;
}

module.exports = {
  DEFAULT_NAMESPACE,
  NAMESPACE_LABEL,
  isDefaultNamespace,
  validateNamespace,
  outputRoot,
  istioSystemPrefix,
  istioSystemName,
  namespaceLabels,
  parseNamespaceArg,
};
