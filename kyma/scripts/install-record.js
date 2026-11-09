/**
 * The install record: a ConfigMap `sail-proxy-install` in the namespace that holds the release
 * version and the non-secret setup answers of the installation, so a later setup or upgrade run
 * started without the original clone's rendered files can offer them again.
 *
 * setup-kyma.js renders it to manifests/core/install-record.yaml; deploy-kyma.js applies it after
 * the workloads (applyInstallRecord there), stamping recordedAt at that moment. Secrets never go
 * in the record: every answer id in SECRET_ANSWER_IDS, and any id that looks like one, is dropped.
 */
const { readResourceData } = require('./kubectl-read');

const INSTALL_RECORD_NAME = 'sail-proxy-install';
const INSTALL_RECORD_FILE = 'install-record.yaml';

// Answer ids whose values are secrets, and the filter: shared with the Docker record
// (docker/setup-flow/install-record.js, where they live so docker/ needs nothing from kyma/).
const { SECRET_ANSWER_IDS, isSecretAnswerId } = require('../../docker/setup-flow/install-record');

/** The registry question's answers for a registry host. */
function registryAnswers(registry) {
  if (registry === 'ghcr.io' || registry === 'docker.io') return { registry };
  return { registry: registry.endsWith('.azurecr.io') ? 'custom-acr' : 'custom', customRegistry: registry };
}

/**
 * The answers worth recording, keyed by question id (the ids loadCurrentValues offers), from
 * what generateManifests is given. Derived values (ROLE_MAPPING) and secrets are left out.
 */
function recordAnswers({ deploymentType, provider, providerConfig, publicConfig, containerConfig, dbConfig, sapConfig }) {
  const answers = { deploymentType, provider };
  for (const [id, value] of Object.entries(providerConfig || {})) {
    // The certificate itself is no answer: the question offers auto-fetch or manual entry.
    if (id === 'ROLE_MAPPING' || id === 'OKTA_SAML_CA_DATA') continue;
    answers[id] = value;
  }
  if (publicConfig) {
    answers.domain = publicConfig.domain;
    answers.clusterSubdomain = publicConfig.clusterSubdomain;
    const allowlist = Array.isArray(publicConfig.ipAllowlist) ? publicConfig.ipAllowlist.join(',') : publicConfig.ipAllowlist;
    answers.ipAllowlist = allowlist;
    if (typeof publicConfig.allowIstioSystemChanges === 'boolean') answers.allowIstioSystemChanges = publicConfig.allowIstioSystemChanges;
    if (typeof publicConfig.sccTunnel === 'boolean') answers.sccTunnel = publicConfig.sccTunnel;
  }
  if (containerConfig) {
    if (containerConfig.registry) Object.assign(answers, registryAnswers(containerConfig.registry));
    answers.organization = containerConfig.organization;
    answers.imagePullSecrets = containerConfig.imagePullSecrets === true;
    // The tag the images (digest-pinned or not) were chosen by: the version question's answer.
    answers.imageTag = containerConfig.tag;
  }
  if (dbConfig) answers.POSTGRES_USER = dbConfig.POSTGRES_USER;
  if (sapConfig && sapConfig.SAP_AI_CORE_URL) {
    answers.configMethod = 'manual';
    for (const id of ['SAP_AI_CORE_URL', 'AUTH_URL', 'CLIENT_ID', 'SAP_AI_REGION', 'SAP_AI_RESOURCE_GROUP']) answers[id] = sapConfig[id];
  } else if (sapConfig !== undefined) {
    answers.configMethod = 'skip';
  }
  return answers;
}

/** answers without secrets and empty values, keys sorted (a stable rendering). */
function publicAnswers(answers) {
  const out = {};
  for (const id of Object.keys(answers || {}).sort()) {
    const value = answers[id];
    if (isSecretAnswerId(id) || value === undefined || value === null || value === '') continue;
    out[id] = value;
  }
  return out;
}

/**
 * The record as a ConfigMap manifest. Every value is a JSON string, which YAML reads as a quoted
 * scalar. recordedAt is left to the apply (stampInstallRecord), so a re-render is byte-identical.
 */
function renderInstallRecord({ namespace, version, answers, recordedBy, recordedAt }) {
  const data = { version: String(version || ''), answers: JSON.stringify(publicAnswers(answers)), recordedBy: recordedBy || 'setup' };
  if (recordedAt) data.recordedAt = recordedAt;
  return `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${INSTALL_RECORD_NAME}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/part-of: sail-proxy
data:
${Object.entries(data).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`).join('\n')}
`;
}

/** The rendered record with recordedAt (and recordedBy, when given) set, for the apply. */
function stampInstallRecord(text, { recordedAt = new Date().toISOString(), recordedBy } = {}) {
  let out = text.replace(/^ {2}recordedAt: .*\n/m, '');
  if (recordedBy) out = out.replace(/^ {2}recordedBy: .*$/m, `  recordedBy: ${JSON.stringify(recordedBy)}`);
  return out.replace(/^data:\n/m, `data:\n  recordedAt: ${JSON.stringify(recordedAt)}\n`);
}

/**
 * The live record of the namespace, or null when there is none. answers is {} when unreadable.
 * Throws (naming the object only) when the ConfigMap cannot be read for another reason.
 */
async function readInstallRecord(runKubectl, namespace) {
  const data = readResourceData(runKubectl, 'configmap', INSTALL_RECORD_NAME, namespace);
  if (!data) return null;
  let answers = {};
  try {
    const parsed = JSON.parse(data.answers || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) answers = publicAnswers(parsed);
  } catch {
    // An edited, unreadable record offers no answers; the other sources still do.
  }
  return {
    version: data.version || null,
    answers,
    recordedAt: data.recordedAt || null,
    recordedBy: data.recordedBy || null
  };
}

module.exports = {
  INSTALL_RECORD_NAME,
  INSTALL_RECORD_FILE,
  SECRET_ANSWER_IDS,
  isSecretAnswerId,
  registryAnswers,
  recordAnswers,
  renderInstallRecord,
  stampInstallRecord,
  readInstallRecord
};
