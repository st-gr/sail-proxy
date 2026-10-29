// Casts of the Kyma video against a disposable namespace next to production. Values that must not appear in
// a committed file (the laptop's IP, the cluster subdomain, the registry token, the deploy configuration that
// carries it) come from the environment or ~/.config/sail-docs/secrets.env at recording time and are scrubbed
// from the cast (typed values shown as their `show` text, the map, the host, IPv4 and long-token rules).
// The deploy and the teardown are real.
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// HOME is this scratch folder (no real home path on screen); kubectl's oidc-login token cache must be linked
// into it (scratch/.kube/cache/oidc-login → ~/.kube/cache/oidc-login), or every command opens a browser login.
const scratch = process.env.SAIL_DOCS_SCRATCH || join(root, 'screencast', 'out', 'scratch');
export const NS = 'sail-proxy-test';
export const HOST = 'sail-proxy-test';
const ORG = process.env.SAIL_DOCS_KYMA_ORG || 'st-gr/sail-proxy-private';
const TAG = process.env.SAIL_DOCS_KYMA_TAG || 'docs-800da807';
const SUBDOMAIN = process.env.SAIL_DOCS_KYMA_SUBDOMAIN || '';
const env = { HOME: scratch, KUBECONFIG: process.env.KUBECONFIG ?? `${process.env.HOME}/.kube/config`, PATH: process.env.PATH };
const common = { cols: 110, rows: 30, cwd: root, env };
// setup-kyma.js finds inquirer in npm-dist but not js-yaml in a pnpm checkout (no hoisting); without it the setup
// stops to offer an npm install. The workspace's own copy is put on NODE_PATH, off screen.
// Looked up when the setup cast is recorded, so a checkout without node_modules/.pnpm can still import this file.
const setupEnv = () => {
  const pnpmStore = join(root, 'node_modules', '.pnpm');
  const yaml = existsSync(pnpmStore) ? readdirSync(pnpmStore).find((d) => d.startsWith('js-yaml@4.')) : null;
  return { ...env, ...(yaml ? { NODE_PATH: join(pnpmStore, yaml, 'node_modules') } : {}) };
};

// The deploy reads the pull-secret credentials from KYMA_DEPLOY_CONFIG (base64 JSON, as the setup prints it); it
// is handed over through the environment only, never typed and never written into this file.
const deployConfig = () => {
  if (!process.env.KYMA_DEPLOY_CONFIG) throw new Error('KYMA_DEPLOY_CONFIG is not set');
  return process.env.KYMA_DEPLOY_CONFIG;
};

// The prompt texts and their order are those of kyma/scripts/setup-kyma.js (run(): namespace, keys, deployment
// type, provider, public host, registry, version, database, SAP AI Core).
export const casts = {
  prereqs: { ...common, commands: [
    'kubectl version --client',
    'kubectl oidc-login --version',
    'kubectl auth can-i create namespace',
    { cmd: `kubectl get namespace ${NS}`, holdMs: 2000 }
  ] },
  get setup() { return { ...common, env: setupEnv(), commands: [{ cmd: `node kyma/scripts/setup-kyma.js --namespace ${NS}`, timeoutMs: 600000, holdMs: 4000, input: [
    { waitFor: 'Kubernetes namespace to deploy into', send: '<enter>' },
    { waitFor: 'Generate new encryption keys', send: 'y<enter>' },
    { waitFor: 'Select deployment type', send: '<enter>' },
    { waitFor: 'Select authentication provider', send: '<enter>' },
    { waitFor: 'Logout redirect URL', send: '<enter>' },
    { waitFor: 'APIRule host name', send: `${HOST}<enter>` },
    { waitFor: 'Kyma cluster subdomain', send: [{ env: 'SAIL_DOCS_KYMA_SUBDOMAIN', show: 'c-abc123', redraw: true }, '<enter>'] },
    { waitFor: 'IP allowlist (comma-separated', send: [{ env: 'SAIL_DOCS_LAPTOP_CIDR', show: '203.0.113.7/32', redraw: true }, '<enter>'] },
    { waitFor: 'manage IP restrictions in istio-system', send: 'y<enter>' },
    // This cluster carries the cp.* tunnel policies: keep them reachable (the default); the prefixed copies are
    // labelled and go with the teardown.
    { waitFor: 'Cloud Connector', send: '<enter>' },
    { waitFor: 'Select container registry', send: '<enter>' },
    { waitFor: 'Organization/namespace', send: `${ORG}<enter>` },
    { waitFor: 'Requires image pull secrets', send: 'y<enter>' },
    { waitFor: 'Docker registry username', send: 'st-gr<enter>' },
    { waitFor: 'Docker registry password/token', send: [{ env: 'GHCR_PULL_TOKEN' }, '<enter>'] },
    // The registry lists no tags for a nested private package (GitHub API and registry fallback both come back
    // empty), so the setup asks for the tag directly. With a custom tag it never offers "deploy now".
    { waitFor: 'Enter image version or tag', send: `${TAG}<enter>` },
    { waitFor: 'Database username', send: '<enter>' },
    { waitFor: 'Database password', send: '<enter>' },
    { waitFor: 'Use existing SAP AI Core configuration?', send: 'y<enter>' }
  ] }] }; },
  get deploy() { return { ...common, env: { ...env, KYMA_DEPLOY_CONFIG: deployConfig() }, commands: [{ cmd: `node kyma/scripts/deploy-kyma.js --namespace ${NS}`, timeoutMs: 900000, holdMs: 3000 }] }; },
  rollout: { ...common, commands: [
    { cmd: `kubectl -n ${NS} get pods`, holdMs: 3000 },
    // The setup removes the APIRule in favour of a streaming VirtualService on the shared kyma-gateway.
    { cmd: `kubectl -n ${NS} get virtualservice`, holdMs: 3000 },
    { cmd: `curl -s https://${HOST}.${SUBDOMAIN}.kyma.ondemand.com/gateway/health`, holdMs: 3000 }
  ] },
  // The namespace goes into a shell variable first: a full prefixed name is long enough to read as a token to the
  // scrub rules, and a typed line that wraps and is scrubbed shorter garbles readline's redraw.
  cleanup: { ...common, commands: [
    `NS=${NS}`,
    { cmd: 'kubectl delete namespace $NS', timeoutMs: 600000 },
    'kubectl delete clusterrole,clusterrolebinding $NS-dex',
    'kubectl delete authorizationpolicy -n istio-system -l sail-proxy/namespace=$NS',
    'kubectl delete authorizationpolicy -n istio-system $NS-health-check-external-deny --ignore-not-found',
    'kubectl delete envoyfilter -n istio-system $NS-streaming-timeouts --ignore-not-found',
    { cmd: 'kubectl get namespace $NS', holdMs: 2500 }
  ] }
};
