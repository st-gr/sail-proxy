/**
 * The image pull Secret for a private registry.
 *
 * setup-kyma.js writes it next to the other generated Secrets
 * (templates/secrets/), and deploy-kyma.js applies the file. The registry
 * token therefore never travels through a printed command or a kubectl
 * command line, where it would show in the terminal, the process list and
 * kubectl's error text.
 */
const fs = require('fs');
const path = require('path');

const REGISTRY_SECRET_FILE = 'registry-secret.yaml';

function renderRegistrySecret({ namespace, server, username, password }) {
  const auth = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  const dockerConfig = { auths: { [server]: { username, password, auth } } };
  const encoded = Buffer.from(JSON.stringify(dockerConfig), 'utf8').toString('base64');
  return `apiVersion: v1
kind: Secret
metadata:
  name: registry-secret
  namespace: ${namespace}
type: kubernetes.io/dockerconfigjson
data:
  .dockerconfigjson: ${encoded}
`;
}

// Owner-only on macOS and Linux. Windows ignores the mode; the file is
// protected by the folder's ACL like the other generated Secrets.
function writeRegistrySecret(secretsDir, values) {
  const file = path.join(secretsDir, REGISTRY_SECRET_FILE);
  fs.writeFileSync(file, renderRegistrySecret(values), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/**
 * The registry login stored in secretsDir's registry-secret.yaml, as { server, username, password },
 * or null when there is none or it cannot be read.
 */
function readRegistrySecret(secretsDir) {
  try {
    const yaml = fs.readFileSync(path.join(secretsDir, REGISTRY_SECRET_FILE), 'utf8');
    const match = /^\s+\.dockerconfigjson:\s*(\S+)\s*$/m.exec(yaml);
    if (!match) return null;
    const auths = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')).auths || {};
    const servers = Object.keys(auths);
    if (servers.length !== 1) return null;
    const { username, password } = auths[servers[0]];
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) return null;
    return { server: servers[0], username, password };
  } catch {
    return null;
  }
}

module.exports = { REGISTRY_SECRET_FILE, renderRegistrySecret, writeRegistrySecret, readRegistrySecret };
