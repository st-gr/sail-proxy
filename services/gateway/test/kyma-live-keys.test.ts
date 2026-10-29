/**
 * Encryption keys of an existing Kyma namespace are carried over, never rotated.
 *
 * VALIDATION_TOKEN_SECRET, METADATA_ENCRYPTION_KEY, AWS_SECRET_ENCRYPTION_KEY
 * and SIEM_CREDENTIAL_KEY protect data the running deployment has already
 * stored (AWS credentials, SIEM sink credentials, issued tokens). Re-running
 * setup-kyma.js used to generate fresh ones, making that data unreadable.
 * setup-kyma.js now reads them - read-only, `kubectl get` - from the live
 * namespace and reuses them verbatim; only a namespace that does not exist
 * gets new keys, and an existing one that cannot be read stops the setup.
 *
 * kubectl is always mocked here; no test reaches a cluster.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-var-requires */
const KymaSetup = require('../../../kyma/scripts/setup-kyma.js');
/* eslint-enable @typescript-eslint/no-var-requires */

KymaSetup.useYaml({
  dump: (obj: unknown) => JSON.stringify(obj, null, 2) + '\n',
  load: () => {
    throw new Error('yaml.load is not available in tests');
  },
});

// Awkward on purpose: quotes, backslash, '=' and non-hex characters must
// survive base64 decoding and YAML quoting byte for byte.
const LIVE = {
  VALIDATION_TOKEN_SECRET: 'live-vts-"quoted"\\back=slash',
  METADATA_ENCRYPTION_KEY: 'live-mek-0123456789abcdef',
  AWS_SECRET_ENCRYPTION_KEY: 'live-aws-key/with+base64=chars',
  SIEM_CREDENTIAL_KEY: 'live-siem-key-fedcba9876543210',
  CONNECTION_CREDENTIAL_KEY: 'live-conn-key-0123/with+chars=',
};
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

class KubectlError extends Error {
  stderr: string;
  constructor(stderr: string) {
    super(`Command failed: kubectl\n${stderr}`);
    this.stderr = stderr;
  }
}
const notFound = (what: string) => new KubectlError(`Error from server (NotFound): ${what} not found\n`);

type Cluster = Record<string, (() => string) | Error>;

/**
 * A mocked kubectl answering `get` from a table keyed by "<kind> <name>" (a
 * missing entry answers with kubectl's real server-side NotFound, plural
 * resource name included) and the two `config` reads from "config
 * current-context" / "config view".
 */
function mockKubectl(setup: any, cluster: Cluster) {
  const calls: string[][] = [];
  setup.runKubectl = (args: string[]) => {
    calls.push(args);
    const key = args[0] === 'config' ? `config ${args[1]}` : `${args[1]} ${args[2]}`;
    const answer = cluster[key];
    if (answer === undefined) {
      if (args[0] === 'config') throw new KubectlError('error: current-context is not set\n');
      throw notFound(`${args[1]}s "${args[2]}"`);
    }
    if (answer instanceof Error) throw answer;
    return answer();
  };
  return calls;
}

/** Scripted inquirer: answers every question with the given value for its name, else its default. */
function scriptPrompts(answers: Record<string, unknown>) {
  const asked: Array<Record<string, unknown>> = [];
  KymaSetup.useInquirer({
    prompt: async (questions: Array<Record<string, unknown>>) => {
      asked.push(...questions);
      return Object.fromEntries(
        questions.map((q) => [q.name, (q.name as string) in answers ? answers[q.name as string] : q.default])
      );
    },
  });
  return asked;
}

// Client-side kubectl failures that never reach the cluster. Both say "not
// found" - neither means the namespace does not exist.
const WRONG_CONTEXT = 'error: context was not found for specified context: kyma-prod\n';
const OIDC_MISSING =
  'Unable to connect to the server: getting credentials: exec: executable kubectl-oidc_login not found\n';

const secretJson = (data: Record<string, string>) => () =>
  JSON.stringify({ data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, b64(v)])) });
const configMapJson = (data: Record<string, string>) => () => JSON.stringify({ data });

function captureOutput() {
  const lines: string[] = [];
  const spies = ['log', 'warn', 'error'].map((m) =>
    jest.spyOn(console, m as 'log').mockImplementation((...a: unknown[]) => {
      lines.push(a.join(' '));
    })
  );
  return { lines, restore: () => spies.forEach((s) => s.mockRestore()) };
}

function stringData(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of fs.readFileSync(file, 'utf8').matchAll(/^ {2}([A-Za-z_.]+): (.*)$/gm)) {
    out[m[1]] = m[2].startsWith('"') ? JSON.parse(m[2]) : m[2];
  }
  return out;
}

describe('setup-kyma.js encryption keys of an existing namespace', () => {
  let outputRoot: string;
  let projectRoot: string;

  beforeEach(() => {
    outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-keys-out-'));
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-keys-project-'));
  });

  afterEach(() => {
    KymaSetup.useInquirer(null);
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  const makeSetup = (namespace: string, ciMode = false) => {
    const setup = new KymaSetup({ namespace, outputRoot, ciMode });
    setup.projectRoot = projectRoot;
    setup._k8sApiClusterIp = '10.0.0.1';
    setup.runDockerSetup = async (config: Record<string, unknown>) => setup.postProcessEnvFiles(config);
    return setup;
  };

  const render = async (setup: any) => {
    await setup.generateManifests(
      'internal',
      'local',
      { LOGOUT_REDIRECT_URL: 'auto-shell' },
      null,
      { registry: 'ghcr.io', organization: 'example-org', tag: '1.2.3', imagePullSecrets: false, useDigests: false },
      { POSTGRES_USER: 'gw_admin', POSTGRES_PASSWORD: 'not-a-real-password' },
      null
    );
  };

  const liveCluster = (namespace: string): Cluster => ({
    [`namespace ${namespace}`]: () => `namespace/${namespace}\n`,
    'secret admin-env': secretJson(LIVE),
    'secret gateway-env': secretJson({
      VALIDATION_TOKEN_SECRET: LIVE.VALIDATION_TOKEN_SECRET,
      METADATA_ENCRYPTION_KEY: LIVE.METADATA_ENCRYPTION_KEY,
    }),
  });

  it.each(['sail-proxy', 'sail-proxy-test'])(
    'carries every key of a live namespace byte for byte into the rendered Secrets (%s)',
    async (namespace) => {
      const setup = makeSetup(namespace);
      const calls = mockKubectl(setup, liveCluster(namespace));
      const out = captureOutput();
      try {
        await setup.loadExistingKeys();
        await render(setup);
      } finally {
        out.restore();
      }
      const root = namespace === 'sail-proxy' ? outputRoot : path.join(outputRoot, 'deployments', namespace);
      const admin = stringData(path.join(root, 'templates/secrets/admin-env.yaml'));
      const gateway = stringData(path.join(root, 'templates/secrets/gateway-env.yaml'));
      expect(admin.VALIDATION_TOKEN_SECRET).toBe(LIVE.VALIDATION_TOKEN_SECRET);
      expect(admin.METADATA_ENCRYPTION_KEY).toBe(LIVE.METADATA_ENCRYPTION_KEY);
      expect(admin.AWS_SECRET_ENCRYPTION_KEY).toBe(LIVE.AWS_SECRET_ENCRYPTION_KEY);
      expect(admin.SIEM_CREDENTIAL_KEY).toBe(LIVE.SIEM_CREDENTIAL_KEY);
      expect(admin.CONNECTION_CREDENTIAL_KEY).toBe(LIVE.CONNECTION_CREDENTIAL_KEY);
      // Only in the Secret: a ConfigMap copy would override it (envFrom order).
      expect(fs.readFileSync(path.join(root, 'templates/configmaps/admin-config.yaml'), 'utf8')).not.toContain(
        'SIEM_CREDENTIAL_KEY'
      );
      expect(gateway.VALIDATION_TOKEN_SECRET).toBe(LIVE.VALIDATION_TOKEN_SECRET);
      expect(gateway.METADATA_ENCRYPTION_KEY).toBe(LIVE.METADATA_ENCRYPTION_KEY);
      expect(setup.sharedSecrets.SIEM_CREDENTIAL_KEY).toBe(LIVE.SIEM_CREDENTIAL_KEY);

      // Read-only: every call is `kubectl get … -n <namespace>`.
      for (const args of calls) {
        expect(args[0]).toBe('get');
        if (args[1] !== 'namespace') expect(args).toEqual(expect.arrayContaining(['-n', namespace]));
      }
      // Never printed.
      for (const value of Object.values(LIVE)) {
        expect(out.lines.join('\n')).not.toContain(value);
      }
    }
  );

  it('falls back to the admin-config ConfigMap for a SIEM key deployed before it moved into the Secret', async () => {
    const setup = makeSetup('sail-proxy');
    const { SIEM_CREDENTIAL_KEY, ...withoutSiem } = LIVE;
    mockKubectl(setup, {
      ...liveCluster('sail-proxy'),
      'secret admin-env': secretJson(withoutSiem),
      'configmap admin-config': configMapJson({ LOG_LEVEL: 'info', SIEM_CREDENTIAL_KEY }),
    });
    const out = captureOutput();
    try {
      await setup.loadExistingKeys();
    } finally {
      out.restore();
    }
    expect(setup.sharedSecrets.SIEM_CREDENTIAL_KEY).toBe(SIEM_CREDENTIAL_KEY);
  });

  it('generates new keys for a namespace that does not exist yet, after showing the context and confirming', async () => {
    const setup = makeSetup('sail-proxy-test');
    mockKubectl(setup, {
      'config current-context': () => 'kyma-test-context\n',
      'config view': () => 'https://api.c-abc123.kyma.example.test',
    }); // everything else NotFound
    const asked = scriptPrompts({ confirmNewNamespace: true });
    const out = captureOutput();
    try {
      await setup.loadExistingKeys();
      await render(setup);
    } finally {
      out.restore();
    }
    expect(asked.map((q) => q.name)).toEqual(['confirmNewNamespace']);
    expect(asked[0].default).toBe(false);
    expect(out.lines.join('\n')).toContain('kyma-test-context');
    expect(out.lines.join('\n')).toContain('https://api.c-abc123.kyma.example.test');
    const admin = stringData(path.join(outputRoot, 'deployments/sail-proxy-test/templates/secrets/admin-env.yaml'));
    expect(admin.VALIDATION_TOKEN_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(admin.VALIDATION_TOKEN_SECRET).not.toBe(LIVE.VALIDATION_TOKEN_SECRET);
    expect(admin.SIEM_CREDENTIAL_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(out.lines.join('\n')).toMatch(/does not exist yet/);
  });

  it('stops instead of generating when kubectl cannot tell whether the namespace exists', async () => {
    const setup = makeSetup('sail-proxy');
    mockKubectl(setup, {
      'namespace sail-proxy': new KubectlError('Unable to connect to the server: dial tcp: lookup example: no such host\n'),
    });
    await expect(setup.loadExistingKeys()).rejects.toThrow(/namespace sail-proxy.*not.*generat|never.*rotat|carried over/i);
    expect(setup.sharedSecrets.VALIDATION_TOKEN_SECRET).toBeUndefined();
  });

  it('stops when the namespace exists but its Secrets cannot be read', async () => {
    const setup = makeSetup('sail-proxy');
    mockKubectl(setup, {
      ...liveCluster('sail-proxy'),
      'secret admin-env': new KubectlError('Error from server (Forbidden): secrets "admin-env" is forbidden\n'),
    });
    await expect(setup.loadExistingKeys()).rejects.toThrow(/admin-env/);
  });

  it('stops when the live gateway and admin disagree on a shared key', async () => {
    const setup = makeSetup('sail-proxy');
    mockKubectl(setup, {
      ...liveCluster('sail-proxy'),
      'secret gateway-env': secretJson({ VALIDATION_TOKEN_SECRET: 'something-else' }),
    });
    await expect(setup.loadExistingKeys()).rejects.toThrow(/VALIDATION_TOKEN_SECRET/);
    await expect(setup.loadExistingKeys()).rejects.not.toThrow(/something-else/);
  });

  it.each([
    ['a failed network connection', () => new KubectlError('Unable to connect to the server: dial tcp: lookup api.example.test: no such host\n')],
    ['a refused connection (no kubeconfig)', () => new KubectlError('The connection to the server localhost:8080 was refused - did you specify the right host or port?\n')],
    ['no kubectl installed', () => Object.assign(new Error('spawnSync kubectl ENOENT'), { code: 'ENOENT' })],
  ])('--ci keeps generating when the cluster is positively unreachable: %s', async (_label, failure) => {
    const setup = makeSetup('sail-proxy', true);
    mockKubectl(setup, { 'namespace sail-proxy': failure() });
    const out = captureOutput();
    try {
      await setup.loadExistingKeys();
      await render(setup);
    } finally {
      out.restore();
    }
    expect(stringData(path.join(outputRoot, 'templates/secrets/admin-env.yaml')).VALIDATION_TOKEN_SECRET).toMatch(
      /^[0-9a-f]{64}$/
    );
  });

  it('--ci still carries the keys over when the namespace is reachable', async () => {
    const setup = makeSetup('sail-proxy', true);
    mockKubectl(setup, liveCluster('sail-proxy'));
    const out = captureOutput();
    try {
      await setup.loadExistingKeys();
    } finally {
      out.restore();
    }
    expect(setup.sharedSecrets.VALIDATION_TOKEN_SECRET).toBe(LIVE.VALIDATION_TOKEN_SECRET);
  });

  it('refuses any kubectl verb other than get', () => {
    const setup = new KymaSetup({});
    for (const verb of ['apply', 'delete', 'patch', 'create', 'edit', 'label']) {
      expect(() => setup.runKubectl([verb, 'secret', 'admin-env'])).toThrow(/read-only/);
    }
  });

  it('allows exactly the two read-only config commands and no other', () => {
    const setup = new KymaSetup({});
    for (const args of [
      ['config', 'use-context', 'kyma-prod'],
      ['config', 'set-context', '--current', '--namespace=x'],
      ['config', 'view'],
      ['config', 'view', '--raw'],
      ['config', 'current-context', 'extra'],
      ['config', 'view', '--minify', '-o', 'jsonpath={.users}'],
    ]) {
      expect(() => setup.runKubectl(args)).toThrow(/read-only/);
    }
  });

  describe.each([
    ['a missing context', WRONG_CONTEXT],
    ['a missing oidc-login plugin', OIDC_MISSING],
  ])('client-side kubectl failure: %s', (_label, stderr) => {
    it.each([false, true])('never counts as "namespace does not exist" (ciMode=%s)', async (ciMode) => {
      const setup = makeSetup('sail-proxy', ciMode);
      mockKubectl(setup, { 'namespace sail-proxy': new KubectlError(stderr) });
      const asked = scriptPrompts({ confirmNewNamespace: true });
      await expect(setup.loadExistingKeys()).rejects.toThrow(/Cannot tell whether namespace sail-proxy/);
      expect(asked).toEqual([]);
      expect(setup.sharedSecrets.VALIDATION_TOKEN_SECRET).toBeUndefined();
    });

    it('never counts as "Secret absent" when reading an existing namespace', async () => {
      const setup = makeSetup('sail-proxy');
      mockKubectl(setup, { ...liveCluster('sail-proxy'), 'secret admin-env': new KubectlError(stderr) });
      await expect(setup.loadExistingKeys()).rejects.toThrow(/Cannot read secret admin-env/);
    });
  });

  it('counts a NotFound for another namespace name as a failure, not as absence', async () => {
    const setup = makeSetup('sail-proxy');
    mockKubectl(setup, { 'namespace sail-proxy': notFound('namespaces "sail-proxy-other"') });
    await expect(setup.loadExistingKeys()).rejects.toThrow(/Cannot tell whether namespace sail-proxy/);
  });

  it('stops when the operator does not confirm generating keys for a new namespace', async () => {
    const setup = makeSetup('sail-proxy-test');
    mockKubectl(setup, {});
    scriptPrompts({ confirmNewNamespace: false });
    const out = captureOutput();
    try {
      await expect(setup.loadExistingKeys()).rejects.toThrow(/stopped/i);
    } finally {
      out.restore();
    }
    expect(setup.sharedSecrets.VALIDATION_TOKEN_SECRET).toBeUndefined();
  });

  describe.each(['admin-env', 'gateway-env'])('an existing namespace without its %s Secret', (missing) => {
    const clusterWithout = () => {
      const c = liveCluster('sail-proxy');
      delete c[`secret ${missing}`];
      return c;
    };

    it('asks before generating keys (default no) and stops when declined', async () => {
      const setup = makeSetup('sail-proxy');
      mockKubectl(setup, clusterWithout());
      const asked = scriptPrompts({ confirmGenerateInExistingNamespace: false });
      const out = captureOutput();
      try {
        await expect(setup.loadExistingKeys()).rejects.toThrow(new RegExp(`stopped.*${missing}`, 'i'));
      } finally {
        out.restore();
      }
      expect(asked.map((q) => q.name)).toEqual(['confirmGenerateInExistingNamespace']);
      expect(asked[0].default).toBe(false);
    });

    it('carries what exists and generates the rest when confirmed', async () => {
      const setup = makeSetup('sail-proxy');
      mockKubectl(setup, clusterWithout());
      scriptPrompts({ confirmGenerateInExistingNamespace: true });
      const out = captureOutput();
      try {
        await setup.loadExistingKeys();
      } finally {
        out.restore();
      }
      expect(setup.sharedSecrets.VALIDATION_TOKEN_SECRET).toBe(LIVE.VALIDATION_TOKEN_SECRET);
    });

    it('stops under --ci instead of generating', async () => {
      const setup = makeSetup('sail-proxy', true);
      mockKubectl(setup, clusterWithout());
      const asked = scriptPrompts({ confirmGenerateInExistingNamespace: true });
      await expect(setup.loadExistingKeys()).rejects.toThrow(new RegExp(missing));
      expect(asked).toEqual([]);
    });
  });

  it('stops when admin-env and admin-config hold different SIEM keys', async () => {
    const setup = makeSetup('sail-proxy');
    mockKubectl(setup, {
      ...liveCluster('sail-proxy'),
      'configmap admin-config': configMapJson({ SIEM_CREDENTIAL_KEY: 'a-different-siem-key' }),
    });
    const failure = await setup.loadExistingKeys().catch((e: Error) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(/SIEM_CREDENTIAL_KEY/);
    expect(failure.message).not.toContain('a-different-siem-key');
  });

  it('accepts admin-env and admin-config holding the same SIEM key', async () => {
    const setup = makeSetup('sail-proxy');
    mockKubectl(setup, {
      ...liveCluster('sail-proxy'),
      'configmap admin-config': configMapJson({ SIEM_CREDENTIAL_KEY: LIVE.SIEM_CREDENTIAL_KEY }),
    });
    const out = captureOutput();
    try {
      await setup.loadExistingKeys();
    } finally {
      out.restore();
    }
    expect(setup.sharedSecrets.SIEM_CREDENTIAL_KEY).toBe(LIVE.SIEM_CREDENTIAL_KEY);
  });
});
