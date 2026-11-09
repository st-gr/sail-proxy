'use strict';
/**
 * The Docker install record: docker/.sail-proxy-install.json, the Docker counterpart of the Kyma
 * ConfigMap `sail-proxy-install` (kyma/scripts/install-record.js). It holds the release version
 * and the non-secret setup answers, plus who wrote it: setup-docker.js on every interactive or
 * --ci run (not in --config mode, which setup-kyma.js uses to produce .env files only), and
 * `sail-proxy upgrade docker` as its very last step.
 *
 * An upgrade also records the sha256 of the tracked files it wrote from the release (`files`), so
 * the next upgrade can tell its own writes from local changes in a git clone.
 *
 * Secrets never go in the record (the same filter as the Kyma record).
 */

const fs = require('fs');
const path = require('path');

const INSTALL_RECORD_FILE = '.sail-proxy-install.json';

/**
 * Answer ids whose values are secrets. The password-type questions (setup-kyma.js: the provider
 * prompts marked `secret: true`, the SAP client secret, the database password and its
 * confirmation, the registry token) plus the generated secrets a re-run carries. Shared with the
 * Kyma record (kyma/scripts/install-record.js); pinned by kyma-install-record.test.ts, which walks the real question definitions.
 */
const SECRET_ANSWER_IDS = Object.freeze([
  'GITHUB_CLIENT_SECRET',
  'LDAP_BIND_PASSWORD',
  'CLIENT_SECRET',
  'POSTGRES_PASSWORD',
  'POSTGRES_PASSWORD_CONFIRM',
  'dockerPassword',
  'OAUTH2_PROXY_CLIENT_SECRET',
  'OAUTH2_PROXY_COOKIE_SECRET',
  'serviceKeyJson'
]);

// A second line of defence for an id added later and missed above (not imagePullSecrets, a yes/no).
const SECRET_LIKE_ID = /(SECRET|PASSWORD|TOKEN)(_CONFIRM)?$|(Secret|Password|Token)$|^serviceKey/;

function isSecretAnswerId(id) {
  return SECRET_ANSWER_IDS.includes(id) || SECRET_LIKE_ID.test(id);
}


/** answers without secrets and empty values, keys sorted. */
function publicAnswers(answers) {
  const out = {};
  for (const id of Object.keys(answers || {}).sort()) {
    const value = answers[id];
    if (isSecretAnswerId(id) || value === undefined || value === null || value === '') continue;
    if (typeof value === 'object') continue;
    out[id] = value;
  }
  return out;
}

/** The answers worth recording, keyed by setup-docker.js question id, from its DockerAnswers. */
function recordDockerAnswers({ provider, providerConfig, baseUrl, imageMode, registry, organization, dbConfig }) {
  const answers = { provider };
  for (const [id, value] of Object.entries(providerConfig || {})) {
    // Derived (ROLE_MAPPING) or no answer (the certificate itself)
    if (id === 'ROLE_MAPPING' || id === 'OKTA_SAML_CA_DATA') continue;
    answers[id] = value;
  }
  if (baseUrl) answers.baseUrl = baseUrl;
  if (imageMode) answers.imageMode = imageMode;
  if (imageMode === 'registry') {
    answers.registry = registry;
    answers.organization = organization;
  }
  if (dbConfig && dbConfig.POSTGRES_USER) answers.POSTGRES_USER = dbConfig.POSTGRES_USER;
  return publicAnswers(answers);
}

/**
 * Writes the record (mode 600 where the OS supports it). A record that would differ only in
 * recordedAt is left as it is, so a setup re-run that changes nothing changes no file.
 * @param {string} dockerDir
 * @param {{ version: string, answers: object, recordedBy?: string, recordedAt?: string, files?: object }} record
 */
function writeInstallRecord(dockerDir, { version, answers, recordedBy = 'setup', recordedAt = new Date().toISOString(), files }) {
  const record = { version: String(version || ''), answers: publicAnswers(answers), recordedAt, recordedBy };
  if (files && Object.keys(files).length > 0) record.files = files;
  const file = path.join(dockerDir, INSTALL_RECORD_FILE);
  const existing = readInstallRecord(dockerDir);
  const same = (r) => JSON.stringify([r.version, r.answers, r.recordedBy, r.files || {}]);
  if (existing && same(existing) === same(record)) return file;
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return file;
}

/** The record, or null when there is none. An unreadable file reads as a record without answers. */
function readInstallRecord(dockerDir) {
  const file = path.join(dockerDir, INSTALL_RECORD_FILE);
  if (!fs.existsSync(file)) return null;
  let data = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
  } catch {
    // An edited, unreadable record offers nothing; the other sources still do.
  }
  const files = data.files && typeof data.files === 'object' && !Array.isArray(data.files) ? data.files : {};
  return {
    version: typeof data.version === 'string' && data.version ? data.version : null,
    answers: publicAnswers(data.answers),
    recordedAt: data.recordedAt || null,
    recordedBy: data.recordedBy || null,
    files
  };
}

module.exports = {
  INSTALL_RECORD_FILE, SECRET_ANSWER_IDS, isSecretAnswerId, publicAnswers, recordDockerAnswers, writeInstallRecord, readInstallRecord
};
