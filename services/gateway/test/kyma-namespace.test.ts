/**
 * Kyma namespace isolation tests.
 *
 * kyma/scripts/setup-kyma.js renders the Kubernetes manifests and
 * kyma/scripts/deploy-kyma.js applies them. The namespace used to be fixed to
 * `sail-proxy`; it is now configurable so a second deployment (for example
 * `sail-proxy-test`) can share a cluster with production. That is only safe if
 * the second deployment never renders into production's gitignored folders,
 * never names a cluster-scoped or istio-system object like production does, and
 * never deletes production's IP allowlist. The default namespace must keep
 * today's paths and names exactly, or the production cluster sees churn.
 *
 * Everything renders into a temp directory. Nothing here runs kubectl,
 * setup-docker.js or an inquirer prompt.
 *
 * Lives here rather than under kyma/ because this repo's only Jest runner is
 * services/gateway's; see test/kyma-db-manager-commands.test.ts.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-var-requires */
const KymaSetup = require('../../../kyma/scripts/setup-kyma.js');
const deployKyma = require('../../../kyma/scripts/deploy-kyma.js');
const kymaNamespace = require('../../../kyma/scripts/kyma-namespace.js');
/* eslint-enable @typescript-eslint/no-var-requires */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const API_CONFIG = path.join(REPO_ROOT, 'services', 'admin', 'api_config.json');

// js-yaml is not a dependency of any service in this repo (setup-kyma.js
// installs it on demand), so the tests hand the script a stand-in. JSON is
// valid YAML, and every assertion below reads names, not formatting.
KymaSetup.useYaml({
  dump: (obj: unknown) => JSON.stringify(obj, null, 2) + '\n',
  load: () => {
    throw new Error('yaml.load is not available in tests');
  },
});

// Names production owns outside its namespace today. A second deployment must
// never create, overwrite or delete any of them.
const PRODUCTION_OUT_OF_NAMESPACE_NAMES = [
  'sail-proxy', // the Namespace object
  'sail-proxy-dex', // ClusterRole + ClusterRoleBinding
  'allowlist-sail-proxy', // istio-system IP allowlist
  'allowlist-cp-tunnel', // istio-system SCC tunnel ALLOW
  'allowlist-cp-healthcheck', // istio-system SCC healthcheck ALLOW
  'health-check-external-deny', // istio-system DENY for health endpoints
  'streaming-timeouts', // istio-system EnvoyFilter
];

const CLUSTER_SCOPED_KINDS = new Set(['Namespace', 'ClusterRole', 'ClusterRoleBinding']);

interface RenderedObject {
  file: string;
  kind: string;
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
}

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

/** Kind, name and namespace of every document in a rendered file. */
function parseObjects(file: string): RenderedObject[] {
  const text = fs.readFileSync(file, 'utf8');
  return text
    .split(/^---\s*$/m)
    .map((doc) => doc.trim())
    .filter((doc) => doc && !doc.split('\n').every((line) => !line.trim() || line.trim().startsWith('#')))
    .map((doc) => {
      if (doc.startsWith('{')) {
        const obj = JSON.parse(doc);
        return {
          file,
          kind: obj.kind,
          name: obj.metadata?.name,
          namespace: obj.metadata?.namespace,
          labels: obj.metadata?.labels,
        };
      }
      const kind = doc.match(/^kind:\s*(\S+)/m)?.[1] ?? '';
      const name = doc.match(/^metadata:\s*\n(?:[ \t]*#.*\n)*  name:\s*(\S+)/m)?.[1] ?? '';
      const namespace = doc.match(/^metadata:\s*\n(?:(?: {2,}|[ \t]*#).*\n)*?  namespace:\s*(\S+)/m)?.[1];
      return { file, kind, name, namespace, labels: yamlMetadataLabels(doc) };
    })
    .filter((obj) => obj.kind);
}

/** metadata.labels of a YAML document (flat string map), or undefined without a labels block. */
function yamlMetadataLabels(doc: string): Record<string, string> | undefined {
  const metadata = `${doc}\n`.match(/^metadata:[ \t]*\n((?:(?: {2,}.*|[ \t]*#.*|[ \t]*)\n)*)/m)?.[1] ?? '';
  const block = metadata.match(/^  labels:[ \t]*\n((?: {4,}.*\n)*)/m)?.[1];
  if (block === undefined) return undefined;
  const labels: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const m = line.match(/^ {4}([^:#\s][^:]*):\s*(.*?)\s*(?:#.*)?$/);
    if (m) labels[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return labels;
}

function outOfNamespaceObjects(objects: RenderedObject[]): RenderedObject[] {
  return objects.filter((obj) => CLUSTER_SCOPED_KINDS.has(obj.kind) || obj.namespace === 'istio-system');
}

const tempProjectRoots: string[] = [];
afterAll(() => {
  for (const dir of tempProjectRoots) fs.rmSync(dir, { recursive: true, force: true });
});

/** A KymaSetup that renders deterministically and never leaves the temp dir. */
function makeSetup(options: Record<string, unknown>) {
  const setup = new KymaSetup(options);
  setup._k8sApiClusterIp = '10.0.0.1'; // never shell out to kubectl
  // Its local-config snapshot must never read the real checkout's .env files.
  setup.projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-ns-project-'));
  tempProjectRoots.push(setup.projectRoot);
  setup.runDockerSetup = async (config: Record<string, unknown>) => {
    // Stands in for setup-docker.js + postProcessEnvFiles, which read and
    // write the repository's .env files.
    await setup.createEnvConfigMaps({ LOG_LEVEL: 'info' }, { NODE_ENV: 'production' }, config);
    await setup.createApiConfigMap(API_CONFIG, config);
    await setup.updateDeploymentManifests(config);
  };
  return setup;
}

/** Public deployment with every out-of-namespace feature switched on. */
async function renderPublic(setup: any, domain: string) {
  const silence = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  const silenceWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    return await setup.generateManifests(
      'public',
      'local',
      { LOGOUT_REDIRECT_URL: 'auto-shell' },
      {
        domain,
        clusterSubdomain: 'c-abc123',
        ipAllowlist: ['198.51.100.0/24'],
        allowIstioSystemChanges: true,
        sccTunnel: true,
      },
      {
        registry: 'ghcr.io',
        organization: 'example-org',
        tag: '1.2.3',
        imagePullSecrets: true,
        dockerUsername: 'robot',
        dockerPassword: 'not-a-real-token',
        useDigests: false,
      },
      { POSTGRES_USER: 'gw_admin', POSTGRES_PASSWORD: 'not-a-real-password' },
      {}
    );
  } finally {
    silence.mockRestore();
    silenceWarn.mockRestore();
  }
}

describe('kyma namespace helpers', () => {
  it('defaults to sail-proxy', () => {
    expect(kymaNamespace.DEFAULT_NAMESPACE).toBe('sail-proxy');
  });

  it('keeps the default namespace at the kyma root and moves any other under deployments/<ns>', () => {
    expect(kymaNamespace.outputRoot('/k', 'sail-proxy')).toBe('/k');
    expect(kymaNamespace.outputRoot('/k', 'sail-proxy-test')).toBe(path.join('/k', 'deployments', 'sail-proxy-test'));
  });

  it('keeps default istio-system names and prefixes any other namespace', () => {
    expect(kymaNamespace.istioSystemName('sail-proxy', 'allowlist-cp-tunnel')).toBe('allowlist-cp-tunnel');
    expect(kymaNamespace.istioSystemName('sail-proxy-test', 'allowlist-cp-tunnel')).toBe(
      'sail-proxy-test-allowlist-cp-tunnel'
    );
  });

  it('reads --namespace in both spellings and rejects a missing value', () => {
    expect(kymaNamespace.parseNamespaceArg(['--ci'])).toBeUndefined();
    expect(kymaNamespace.parseNamespaceArg(['--namespace', 'sail-proxy-test'])).toBe('sail-proxy-test');
    expect(kymaNamespace.parseNamespaceArg(['--namespace=sail-proxy-test', '--ci'])).toBe('sail-proxy-test');
    expect(() => kymaNamespace.parseNamespaceArg(['--namespace'])).toThrow(/--namespace/);
    expect(() => kymaNamespace.parseNamespaceArg(['--namespace', '--ci'])).toThrow(/--namespace/);
  });

  it('rejects names that are not RFC 1123 labels or are system namespaces', () => {
    expect(kymaNamespace.validateNamespace('sail-proxy-test')).toBe(true);
    expect(kymaNamespace.validateNamespace('Sail_Proxy')).not.toBe(true);
    expect(kymaNamespace.validateNamespace('a'.repeat(64))).not.toBe(true);
    expect(kymaNamespace.validateNamespace('x; kubectl delete ns sail-proxy')).not.toBe(true);
    expect(kymaNamespace.validateNamespace('istio-system')).not.toBe(true);
    expect(kymaNamespace.validateNamespace('kube-system')).not.toBe(true);
    expect(kymaNamespace.validateNamespace('default')).not.toBe(true);
  });
});

describe('setup-kyma.js namespace selection', () => {
  it('rejects an invalid namespace instead of rendering it', () => {
    expect(() => new KymaSetup({ namespace: 'Bad_Namespace' })).toThrow();
  });

  it('asks for the Kubernetes namespace with the --namespace value as the default', () => {
    const setup = new KymaSetup({ namespace: 'sail-proxy-test' });
    const question = setup.namespaceQuestion();
    expect(question.message).toMatch(/Kubernetes namespace to deploy into/);
    expect(question.default).toBe('sail-proxy-test');
    expect(question.validate('sail-proxy-test')).toBe(true);
    expect(question.validate('Not Valid')).not.toBe(true);
    expect(question.validate('istio-system')).not.toBe(true);
  });

  it('defaults the prompt to sail-proxy without --namespace', () => {
    expect(new KymaSetup({}).namespaceQuestion().default).toBe('sail-proxy');
  });

  it('keeps the --namespace value in CI mode without prompting', async () => {
    const setup = new KymaSetup({ namespace: 'sail-proxy-test', ciMode: true });
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await expect(setup.selectNamespace()).resolves.toBe('sail-proxy-test');
    } finally {
      log.mockRestore();
    }
    expect(setup.namespace).toBe('sail-proxy-test');
  });
});

describe('setup-kyma.js public host for a non-default namespace', () => {
  const question = (setup: any, name: string) =>
    setup.publicConfigQuestions().find((q: { name: string }) => q.name === name);

  it('refuses production\'s host name at the prompt', () => {
    const host = question(new KymaSetup({ namespace: 'sail-proxy-test' }), 'domain');
    expect(host.default).toBe('sail-proxy-test');
    expect(host.validate('sail-proxy')).toMatch(/production/);
    expect(host.validate('sail-proxy-test')).toBe(true);
  });

  it('keeps sail-proxy as the default namespace\'s host', () => {
    const host = question(new KymaSetup({}), 'domain');
    expect(host.default).toBe('sail-proxy');
    expect(host.validate('sail-proxy')).toBe(true);
  });

  it('refuses to render a non-default namespace on production\'s host (the --ci path)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-ns-host-'));
    try {
      await expect(
        renderPublic(makeSetup({ namespace: 'sail-proxy-test', outputRoot: tmp }), 'sail-proxy')
      ).rejects.toThrow(/production/);
      expect(listFiles(tmp)).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('setup-kyma.js IP allowlist prompt', () => {
  const ipQuestion = (setup: any) =>
    setup.publicConfigQuestions().find((q: { name: string }) => q.name === 'ipAllowlist');

  const gatewayPolicies = (items: unknown[]) => () => JSON.stringify({ items });
  const allow = (name: string, extra: Record<string, unknown> = {}) => ({
    metadata: { name },
    spec: { selector: { matchLabels: { istio: 'ingressgateway' } }, action: 'ALLOW', ...extra },
  });

  /** A KymaSetup whose read-only kubectl answers the istio-system listing (or fails). */
  const withIngress = (answer: (() => string) | Error) => {
    const setup = new KymaSetup({ namespace: 'sail-proxy-test' });
    setup.runKubectl = (args: string[]) => {
      expect(args).toEqual(['get', 'authorizationpolicies', '-n', 'istio-system', '-o', 'json']);
      if (answer instanceof Error) throw answer;
      return answer();
    };
    setup.ingressHasAllowPolicies = setup.detectIngressAllowPolicies();
    return setup;
  };

  it('tells a non-default namespace it NEEDS its own allowlist when the gateway already has ALLOW policies', () => {
    const setup = withIngress(gatewayPolicies([allow('allowlist-sail-proxy'), allow('allowlist-cp-tunnel')]));
    expect(setup.ingressHasAllowPolicies).toBe(true);
    const message = ipQuestion(setup).message;
    expect(message).toMatch(/already has ALLOW policies/);
    expect(message).toMatch(/NEEDS its own IP allowlist/);
    expect(message).not.toMatch(/no ALLOW policies yet/);
    expect(message).toMatch(/IP allowlist \(comma-separated CIDRs/);
  });

  it('counts a policy without an action (Istio defaults to ALLOW) and one without a selector in istio-system', () => {
    expect(withIngress(gatewayPolicies([{ metadata: { name: 'a' }, spec: { selector: { matchLabels: { istio: 'ingressgateway' } } } }])).ingressHasAllowPolicies).toBe(true);
    expect(withIngress(gatewayPolicies([{ metadata: { name: 'mesh-wide' }, spec: { action: 'ALLOW', rules: [{}] } }])).ingressHasAllowPolicies).toBe(true);
  });

  it('warns that an allowlist makes every other host deny-by-default when the gateway has no ALLOW policies', () => {
    const setup = withIngress(
      gatewayPolicies([
        allow('deny-something', { action: 'DENY' }),
        { metadata: { name: 'other-workload' }, spec: { selector: { matchLabels: { app: 'x' } }, action: 'ALLOW' } },
      ])
    );
    expect(setup.ingressHasAllowPolicies).toBe(false);
    const message = ipQuestion(setup).message;
    expect(message).toMatch(/no ALLOW policies yet/);
    expect(message).toMatch(/every other host/);
    expect(message).not.toMatch(/NEEDS its own/);
  });

  it('states the rule for both cases when the gateway cannot be read', () => {
    const setup = withIngress(new Error('Error from server (Forbidden): authorizationpolicies is forbidden'));
    expect(setup.ingressHasAllowPolicies).toBeNull();
    const message = ipQuestion(setup).message;
    expect(message).toMatch(/If the shared ingress gateway already has ALLOW policies/);
    expect(message).toMatch(/NEEDS its own IP allowlist/);
    expect(message).toMatch(/Only on a gateway with no ALLOW policies/);
  });

  it('states the rule for both cases before anything was checked', () => {
    const message = ipQuestion(new KymaSetup({ namespace: 'sail-proxy-test' })).message;
    expect(message).toMatch(/NEEDS its own IP allowlist/);
    expect(message).toMatch(/Only on a gateway with no ALLOW policies/);
  });

  it('keeps the default namespace\'s prompt unchanged', () => {
    expect(ipQuestion(new KymaSetup({})).message).toBe(
      'IP allowlist (comma-separated CIDRs, e.g., 198.51.100.0/24,203.0.113.12/32):'
    );
  });
});

describe('setup-kyma.js rendering for a non-default namespace', () => {
  let tmp: string;
  let config: Record<string, unknown>;
  let files: string[];
  let objects: RenderedObject[];

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-ns-test-'));
    config = await renderPublic(makeSetup({ namespace: 'sail-proxy-test', outputRoot: tmp }), 'sail-proxy-test');
    files = listFiles(tmp);
    objects = files.filter((f) => /\.ya?ml$/.test(f)).flatMap(parseObjects);
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('carries the namespace in the returned config', () => {
    expect(config.namespace).toBe('sail-proxy-test');
  });

  it('writes only under deployments/<ns>, never to the default folders', () => {
    expect(files.length).toBeGreaterThan(10);
    const root = path.join(tmp, 'deployments', 'sail-proxy-test') + path.sep;
    expect(files.filter((f) => !f.startsWith(root))).toEqual([]);
    expect(fs.existsSync(path.join(tmp, 'manifests'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'templates'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'manifests', 'core', 'namespace.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'manifests', 'istio-system', 'authorization-policy.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'templates', 'secrets', 'admin-env.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'templates', 'configmaps', 'admin-api-config.yaml'))).toBe(true);
  });

  it('never targets the sail-proxy namespace', () => {
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      expect({ file, hit: /namespace: sail-proxy\s*$/m.test(text) }).toEqual({ file, hit: false });
      expect({ file, hit: /\.sail-proxy\.svc/.test(text) }).toEqual({ file, hit: false });
      expect({ file, hit: /"sail-proxy"/.test(text) }).toEqual({ file, hit: false });
      expect({ file, hit: /--namespace=sail-proxy\s*$/m.test(text) }).toEqual({ file, hit: false });
    }
    const namespaces = new Set(objects.map((o) => o.namespace).filter(Boolean));
    expect([...namespaces].sort()).toEqual(['istio-system', 'sail-proxy-test']);
  });

  it('gives every cluster-scoped and istio-system object a namespace-derived name', () => {
    const outside = outOfNamespaceObjects(objects);
    expect(outside.map((o) => `${o.kind}/${o.name}`).sort()).toEqual([
      'AuthorizationPolicy/sail-proxy-test-allowlist-cp-healthcheck',
      'AuthorizationPolicy/sail-proxy-test-allowlist-cp-tunnel',
      'AuthorizationPolicy/sail-proxy-test-allowlist-sail-proxy-test',
      'AuthorizationPolicy/sail-proxy-test-health-check-external-deny',
      'ClusterRole/sail-proxy-test-dex',
      'ClusterRoleBinding/sail-proxy-test-dex',
      'EnvoyFilter/sail-proxy-test-streaming-timeouts',
      'Namespace/sail-proxy-test',
    ]);
    for (const obj of outside) {
      expect(PRODUCTION_OUT_OF_NAMESPACE_NAMES).not.toContain(obj.name);
    }
  });

  // deploy-kyma.js and the teardown find a namespace's istio-system objects by this label.
  it('labels every istio-system object with its namespace', () => {
    const istioSystem = objects.filter((o) => o.namespace === 'istio-system');
    expect(istioSystem.map((o) => o.name).sort()).toEqual([
      'sail-proxy-test-allowlist-cp-healthcheck',
      'sail-proxy-test-allowlist-cp-tunnel',
      'sail-proxy-test-allowlist-sail-proxy-test',
      'sail-proxy-test-health-check-external-deny',
      'sail-proxy-test-streaming-timeouts',
    ]);
    for (const obj of istioSystem) {
      expect({ name: obj.name, label: obj.labels?.[kymaNamespace.NAMESPACE_LABEL] })
        .toEqual({ name: obj.name, label: 'sail-proxy-test' });
    }
  });

  it('binds the dex ClusterRole to the dex ServiceAccount of its own namespace', () => {
    const rbac = fs.readFileSync(
      path.join(tmp, 'deployments', 'sail-proxy-test', 'manifests', 'auth', 'dex-rbac.yaml'),
      'utf8'
    );
    expect(rbac).toMatch(/roleRef:[\s\S]*name: sail-proxy-test-dex/);
    expect(rbac).toMatch(/subjects:\n- kind: ServiceAccount\n {2}name: dex\n {2}namespace: sail-proxy-test/);
  });
});

describe('setup-kyma.js rendering for the default namespace', () => {
  let tmp: string;
  let files: string[];
  let objects: RenderedObject[];

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-ns-default-'));
    await renderPublic(makeSetup({ outputRoot: tmp }), 'sail-proxy');
    files = listFiles(tmp);
    objects = files.filter((f) => /\.ya?ml$/.test(f)).flatMap(parseObjects);
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('keeps today\'s paths', () => {
    expect(fs.existsSync(path.join(tmp, 'deployments'))).toBe(false);
    const relative = files.map((f) => path.relative(tmp, f).split(path.sep).join('/'));
    expect(relative).toEqual(
      expect.arrayContaining([
        'manifests/core/namespace.yaml',
        'manifests/auth/dex-rbac.yaml',
        'manifests/networking/streaming-virtualservice.yaml',
        'manifests/istio-system/authorization-policy.yaml',
        'manifests/istio-system/connectivity-proxy-allow.yaml',
        'templates/secrets/admin-env.yaml',
        'templates/configmaps/admin-api-config.yaml',
      ])
    );
  });

  it('keeps today\'s cluster-scoped and istio-system names, without new labels', () => {
    const outside = outOfNamespaceObjects(objects);
    expect(outside.map((o) => `${o.kind}/${o.name}`).sort()).toEqual([
      'AuthorizationPolicy/allowlist-cp-healthcheck',
      'AuthorizationPolicy/allowlist-cp-tunnel',
      'AuthorizationPolicy/allowlist-sail-proxy',
      'AuthorizationPolicy/health-check-external-deny',
      'ClusterRole/sail-proxy-dex',
      'ClusterRoleBinding/sail-proxy-dex',
      'EnvoyFilter/streaming-timeouts',
      'Namespace/sail-proxy',
    ]);
    const allowlist = objects.find((o) => o.name === 'allowlist-sail-proxy');
    expect(allowlist?.labels).toBeUndefined();
    const cp = objects.find((o) => o.name === 'allowlist-cp-tunnel');
    expect(cp?.labels).toEqual({ app: 'connectivity-proxy' });
    expect(objects.find((o) => o.name === 'health-check-external-deny')?.labels).toEqual({ app: 'sail-proxy' });
    expect(objects.find((o) => o.name === 'streaming-timeouts')?.labels)
      .toEqual({ app: 'sail-proxy', purpose: 'streaming-optimization', issue: 'claude-code-timeouts' });
  });

  it('targets only sail-proxy and istio-system', () => {
    const namespaces = new Set(objects.map((o) => o.namespace).filter(Boolean));
    expect([...namespaces].sort()).toEqual(['istio-system', 'sail-proxy']);
  });
});

describe('deploy-kyma.js namespace handling', () => {
  const policy = (name: string, labels?: Record<string, string>) => ({ metadata: { name, labels } });
  const LIVE_POLICIES = [
    policy('allowlist-sail-proxy'),
    policy('allowlist-cp-tunnel', { app: 'connectivity-proxy' }),
    policy('allowlist-cp-healthcheck', { app: 'connectivity-proxy' }),
    policy('health-check-external-deny', { app: 'sail-proxy' }),
    policy('sail-proxy-test-allowlist-sail-proxy-test', { 'sail-proxy/namespace': 'sail-proxy-test' }),
    policy('sail-proxy-test-allowlist-cp-tunnel', { app: 'connectivity-proxy', 'sail-proxy/namespace': 'sail-proxy-test' }),
    policy('sail-proxy-test-allowlist-old-host', { 'sail-proxy/namespace': 'sail-proxy-test' }),
    policy('sail-proxy-test2-allowlist-sail-proxy-test2', { 'sail-proxy/namespace': 'sail-proxy-test2' }),
    policy('some-other-app-allowlist'),
  ];

  it('cleans up only its own IP allowlist policies for a non-default namespace', () => {
    const owned = deployKyma.selectOwnedAllowlistPolicies(LIVE_POLICIES, 'sail-proxy-test');
    expect(owned.sort()).toEqual(['sail-proxy-test-allowlist-old-host', 'sail-proxy-test-allowlist-sail-proxy-test']);
    for (const name of owned) {
      expect(PRODUCTION_OUT_OF_NAMESPACE_NAMES).not.toContain(name);
    }
  });

  it('never matches another namespace\'s policies when deploying the default namespace', () => {
    expect(deployKyma.selectOwnedAllowlistPolicies(LIVE_POLICIES, 'sail-proxy')).toEqual(['allowlist-sail-proxy']);
  });

  it('names the runtime SCC tunnel ALLOW policies after the namespace', () => {
    const hosts = ['cp.c-abc123.kyma.ondemand.com', 'healthcheck.cp.c-abc123.kyma.ondemand.com'];
    const prod = deployKyma.renderConnectivityProxyAllow(hosts, 'sail-proxy');
    expect(prod).toMatch(/name: allowlist-cp-tunnel\n/);
    expect(prod).toMatch(/name: allowlist-cp-healthcheck\n/);
    expect(prod).not.toMatch(/sail-proxy\/namespace/);

    const test = deployKyma.renderConnectivityProxyAllow(hosts, 'sail-proxy-test');
    expect(test).toMatch(/name: sail-proxy-test-allowlist-cp-tunnel\n/);
    expect(test).toMatch(/name: sail-proxy-test-allowlist-cp-healthcheck\n/);
    expect(test).toMatch(/"sail-proxy\/namespace": "sail-proxy-test"/);
    expect(test).not.toMatch(/name: allowlist-cp-/);
  });

  it('does not count any deployment\'s own cp ALLOW policies as a deny-by-default gateway', () => {
    const gw = { selector: { matchLabels: { istio: 'ingressgateway' } }, action: 'ALLOW' };
    const cpOnly = [
      { metadata: { name: 'allowlist-cp-tunnel' }, spec: gw },
      { metadata: { name: 'sail-proxy-test-allowlist-cp-tunnel' }, spec: gw },
    ];
    expect(deployKyma.isIngressDenyByDefault(cpOnly)).toBe(false);
    expect(deployKyma.isIngressDenyByDefault([...cpOnly, { metadata: { name: 'allowlist-sail-proxy' }, spec: gw }])).toBe(
      true
    );
  });

  describe('resolveDeployTarget', () => {
    let kymaDir: string;

    const writeNamespace = (root: string, ns: string) => {
      fs.mkdirSync(path.join(root, 'manifests', 'core'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'manifests', 'core', 'namespace.yaml'),
        `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${ns}\n  labels:\n    app: sail-proxy\n`
      );
    };

    beforeEach(() => {
      kymaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-deploy-'));
    });

    afterEach(() => {
      fs.rmSync(kymaDir, { recursive: true, force: true });
    });

    it('defaults to sail-proxy and the kyma root folders', () => {
      writeNamespace(kymaDir, 'sail-proxy');
      const target = deployKyma.resolveDeployTarget({ args: [], savedConfig: {}, kymaDir });
      expect(target).toEqual({
        namespace: 'sail-proxy',
        manifestPath: path.join(kymaDir, 'manifests'),
        templatesPath: path.join(kymaDir, 'templates'),
      });
    });

    it('reads a non-default namespace from --namespace and uses its own folder', () => {
      writeNamespace(path.join(kymaDir, 'deployments', 'sail-proxy-test'), 'sail-proxy-test');
      const target = deployKyma.resolveDeployTarget({ args: ['--namespace', 'sail-proxy-test'], savedConfig: {}, kymaDir });
      expect(target).toEqual({
        namespace: 'sail-proxy-test',
        manifestPath: path.join(kymaDir, 'deployments', 'sail-proxy-test', 'manifests'),
        templatesPath: path.join(kymaDir, 'deployments', 'sail-proxy-test', 'templates'),
      });
    });

    it('reads the namespace from the saved setup config', () => {
      writeNamespace(path.join(kymaDir, 'deployments', 'sail-proxy-test'), 'sail-proxy-test');
      const target = deployKyma.resolveDeployTarget({ args: [], savedConfig: { namespace: 'sail-proxy-test' }, kymaDir });
      expect(target.namespace).toBe('sail-proxy-test');
    });

    it('refuses a --namespace that contradicts the saved setup config', () => {
      expect(() =>
        deployKyma.resolveDeployTarget({
          args: ['--namespace', 'sail-proxy'],
          savedConfig: { namespace: 'sail-proxy-test' },
          kymaDir,
        })
      ).toThrow(/sail-proxy-test/);
    });

    it('refuses an invalid namespace before it reaches a shell', () => {
      expect(() =>
        deployKyma.resolveDeployTarget({ args: ['--namespace=x;rm'], savedConfig: {}, kymaDir })
      ).toThrow();
    });

    it('refuses when the folder holds no render for that namespace', () => {
      expect(() =>
        deployKyma.resolveDeployTarget({ args: ['--namespace', 'sail-proxy-test'], savedConfig: {}, kymaDir })
      ).toThrow(/setup-kyma/);
    });

    it('refuses when the rendered namespace.yaml names a different namespace', () => {
      writeNamespace(path.join(kymaDir, 'deployments', 'sail-proxy-test'), 'sail-proxy');
      expect(() =>
        deployKyma.resolveDeployTarget({ args: ['--namespace', 'sail-proxy-test'], savedConfig: {}, kymaDir })
      ).toThrow(/namespace\.yaml/);
    });
  });

  it('has no hard-coded sail-proxy namespace left in any kubectl call or manifest', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'kyma', 'scripts', 'deploy-kyma.js'), 'utf8');
    expect(source).not.toMatch(/-n sail-proxy\b/);
    expect(source).not.toMatch(/--namespace=sail-proxy\b/);
    expect(source).not.toMatch(/namespace: sail-proxy\b/);
    expect(source).not.toMatch(/label namespace sail-proxy\b/);
    expect(source).not.toMatch(/replace\('sail-proxy\/'/);
  });
});
