/**
 * Setup answers read back from a live namespace, for a run that has none of the original clone's
 * rendered files (an upgrade runs the release's setup from a temp copy). The same ids, from the
 * same parsing, as setup-kyma.js's valuesFromRenderedFiles reads from those files:
 * - the Dex config Secret `dex-config`, or the ConfigMap of that name an install of 0.11.0 has (provider settings),
 * - the admin, gateway and nginx Deployments (registry, organization, tag or digest),
 * - the Secret `registry-secret` (a private registry's pull secret),
 * - the owned istio-system AuthorizationPolicies (IP allowlist, SCC tunnel).
 * plus the generated OAuth2 proxy secrets (readLiveOauth2Secrets), which a re-render must keep or
 * everyone is signed out. Read-only (`kubectl get` through the caller's runKubectl); values read
 * from Secrets are base64-decoded `data` and never printed.
 */
const { readResourceData, isServerNotFound, stderrOf } = require('./kubectl-read');
const { istioSystemName } = require('./kyma-namespace');
const { registryAnswers } = require('./install-record');

const IMAGE_NAMES = ['admin', 'gateway', 'nginx'];

/** Provider answers from a parsed Dex config (its first connector). */
function valuesFromDexConfig(dex) {
  const values = {};
  const connector = dex && Array.isArray(dex.connectors) ? dex.connectors[0] : null;
  const config = connector && connector.config ? connector.config : null;
  if (config && connector.type === 'github') {
    values.GITHUB_CLIENT_ID = config.clientID;
    values.GITHUB_CLIENT_SECRET = config.clientSecret;
    if (Array.isArray(config.orgs) && config.orgs[0]) values.GITHUB_ORG = config.orgs[0].name;
  } else if (config && connector.type === 'ldap') {
    const userSearch = config.userSearch || {};
    const groupSearch = config.groupSearch || {};
    const matcher = Array.isArray(groupSearch.userMatchers) ? groupSearch.userMatchers[0] || {} : {};
    Object.assign(values, {
      LDAP_HOST: config.host,
      LDAP_INSECURE_NO_SSL: config.insecureNoSSL === undefined ? undefined : String(config.insecureNoSSL),
      LDAP_BIND_DN: config.bindDN,
      LDAP_BIND_PASSWORD: config.bindPW,
      LDAP_USER_BASE_DN: userSearch.baseDN,
      LDAP_USER_FILTER: userSearch.filter,
      LDAP_USERNAME_ATTR: userSearch.username,
      LDAP_ID_ATTR: userSearch.idAttr,
      LDAP_EMAIL_ATTR: userSearch.emailAttr,
      LDAP_NAME_ATTR: userSearch.nameAttr,
      LDAP_PREFERRED_USERNAME_ATTR: userSearch.preferredUsernameAttr,
      LDAP_GROUP_BASE_DN: groupSearch.baseDN,
      LDAP_GROUP_FILTER: groupSearch.filter,
      LDAP_GROUP_NAME_ATTR: groupSearch.nameAttr,
      LDAP_GROUP_MEMBER_ATTR: matcher.groupAttr
    });
  } else if (config && connector.type === 'saml') {
    values.OKTA_SSO_URL = config.ssoURL;
  }
  return values;
}

/**
 * Image answers from the image references by name (admin, gateway, nginx; missing ones skipped):
 * <registry>/<organization>/sail-proxy-<name>:<tag>, or @<digest>, which has no tag.
 */
function valuesFromImages(images) {
  const values = {};
  for (const name of IMAGE_NAMES) {
    const ref = images[name];
    if (!ref) continue;
    const image = new RegExp(`^(\\S+)/([^/\\s]+)/sail-proxy-${name}([:@])(\\S+)$`).exec(ref);
    if (!image) continue;
    if (values.registry === undefined) {
      Object.assign(values, registryAnswers(image[1]));
      values.organization = image[2];
    }
    if (image[3] === ':' && values.imageTag === undefined) values.imageTag = image[4];
    if (image[3] === '@' && values.imageDigest === undefined) values.imageDigest = `sail-proxy-${name}@${image[4]}`;
  }
  return values;
}

/**
 * The IP allowlist answers from the owned istio-system allowlist policy, which exists only when
 * istio-system changes were allowed; the SCC tunnel policy goes with it.
 */
function valuesFromAllowlistPolicy(policy, hasTunnelPolicy) {
  const sources = policy && policy.spec && policy.spec.rules && policy.spec.rules[0] && policy.spec.rules[0].when;
  if (!Array.isArray(sources) || !sources[0] || !Array.isArray(sources[0].values)) return {};
  return { ipAllowlist: sources[0].values.join(','), allowIstioSystemChanges: true, sccTunnel: hasTunnelPolicy };
}

/** A live object as parsed JSON, or null for the server's NotFound; other failures throw. */
function getObject(runKubectl, kind, name, namespace) {
  let output;
  try {
    output = runKubectl(['get', kind, name, '-n', namespace, '-o', 'json']);
  } catch (error) {
    if (isServerNotFound(error, `${kind}s`, name)) return null;
    throw new Error(`Cannot read ${kind} ${name} in namespace ${namespace} (kubectl: ${stderrOf(error)}).`);
  }
  try {
    return JSON.parse(output);
  } catch (error) {
    // JSON.parse quotes a snippet of its input, which can be Secret data: never pass its text on
    throw new Error(`unreadable JSON from kubectl get ${kind} ${name}`);
  }
}

/** The image of a Deployment's container that runs sail-proxy-<name>, or null. */
function deploymentImage(deployment, name) {
  const spec = deployment && deployment.spec && deployment.spec.template && deployment.spec.template.spec;
  const containers = (spec && spec.containers) || [];
  const container = containers.find((c) => c && typeof c.image === 'string' && c.image.includes(`/sail-proxy-${name}`));
  return container ? container.image : null;
}

/** The host label of an admin BASE_URL https://<domain>.<cluster>.kyma.ondemand.com, or null. */
function domainOf(baseUrl) {
  const host = /^https:\/\/([^.]+)\.[^.]+\.kyma\.ondemand\.com$/.exec(baseUrl || '');
  return host ? host[1] : null;
}

/**
 * The answers the live namespace holds outside admin-env/gateway-env/postgres-env (those are read
 * by setup-kyma.js's valuesFromSecretData): provider settings, images, pull secret, allowlist.
 *
 * A read that fails (Forbidden on istio-system, a transient error) only stops setup when its
 * values would be used: with no rendered files, and for the Dex config and pull secret (which hold
 * secrets) also not from the record. Otherwise it is passed to onWarning (the object and kubectl's
 * first stderr line, never content) and the other sources answer.
 * @param {(args: string[]) => string} runKubectl  read-only kubectl
 * @param {string} namespace
 * @param {object} [options]
 * @param {{ load: (text: string) => unknown }} [options.yaml]  the YAML parser setup uses
 * @param {object|null} [options.adminEnv]  the admin-env data when already read (else read here)
 * @param {boolean} [options.rendered]  the namespace's rendered files exist (they answer instead)
 * @param {boolean} [options.record]  an install record exists (it answers the non-secret values)
 * @param {(message: string) => void} [options.onWarning]
 */
async function readLiveValues(runKubectl, namespace, { yaml, adminEnv, rendered = false, record = false, onWarning = () => {} } = {}) {
  const values = {};
  // holdsSecrets: the record never holds the values, so only rendered files can stand in.
  const attempt = (holdsSecrets, read) => {
    try {
      return { ok: true, value: read() };
    } catch (error) {
      if (!(rendered || (record && !holdsSecrets))) {
        throw new Error(`${error.message} Without rendered files, setup needs it to keep this installation's settings; nothing was changed.`);
      }
      onWarning(error.message);
      return { ok: false };
    }
  };

  // 0.11.0 and earlier kept the Dex config in the ConfigMap dex-config; the Secret replaced it in 0.12.0.
  const dexRead = attempt(true, () =>
    readResourceData(runKubectl, 'secret', 'dex-config', namespace) ||
    readResourceData(runKubectl, 'configmap', 'dex-config', namespace));
  const dexData = dexRead.ok ? dexRead.value : null;
  if (dexData && dexData['config.yaml'] && yaml) {
    let dex = null;
    try {
      dex = yaml.load(dexData['config.yaml']);
    } catch {
      // An unreadable Dex config leaves the provider questions at their other sources.
    }
    Object.assign(values, valuesFromDexConfig(dex));
  }
  // The pull-secret login itself is offered by getContainerConfig (readLiveRegistrySecret).
  const pullSecret = attempt(true, () => readResourceData(runKubectl, 'secret', 'registry-secret', namespace));
  if (pullSecret.ok && pullSecret.value) values.imagePullSecrets = true;

  const images = {};
  for (const name of IMAGE_NAMES) {
    const deployment = attempt(false, () => getObject(runKubectl, 'deployment', name, namespace));
    images[name] = deployment.ok ? deploymentImage(deployment.value, name) : null;
  }
  Object.assign(values, valuesFromImages(images));

  const admin = adminEnv !== undefined ? adminEnv : readResourceData(runKubectl, 'secret', 'admin-env', namespace);
  const domain = domainOf(admin && admin.BASE_URL);
  if (domain) {
    const policies = attempt(false, () => {
      const policy = getObject(runKubectl, 'authorizationpolicy', istioSystemName(namespace, `allowlist-${domain}`), 'istio-system');
      const tunnel = policy && getObject(runKubectl, 'authorizationpolicy', istioSystemName(namespace, 'allowlist-cp-tunnel'), 'istio-system');
      return policy ? valuesFromAllowlistPolicy(policy, tunnel !== null) : {};
    });
    if (policies.ok) Object.assign(values, policies.value);
  }
  return values;
}

/** The live OAuth2 proxy client and cookie secrets, or null when the Secret is absent. */
async function readLiveOauth2Secrets(runKubectl, namespace) {
  const data = readResourceData(runKubectl, 'secret', 'oauth2-proxy-secrets', namespace);
  if (!data) return null;
  return { clientSecret: data['client-secret'] || null, cookieSecret: data['cookie-secret'] || null };
}

/** The live pull-secret login as { server, username, password }, or null (as readRegistrySecret). */
async function readLiveRegistrySecret(runKubectl, namespace) {
  const data = readResourceData(runKubectl, 'secret', 'registry-secret', namespace);
  if (!data || !data['.dockerconfigjson']) return null;
  try {
    const auths = JSON.parse(data['.dockerconfigjson']).auths || {};
    const servers = Object.keys(auths);
    if (servers.length !== 1) return null;
    const { username, password } = auths[servers[0]];
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) return null;
    return { server: servers[0], username, password };
  } catch {
    return null;
  }
}

module.exports = {
  valuesFromDexConfig,
  valuesFromImages,
  valuesFromAllowlistPolicy,
  readLiveValues,
  readLiveOauth2Secrets,
  readLiveRegistrySecret
};
