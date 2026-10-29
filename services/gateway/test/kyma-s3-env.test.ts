/**
 * The optional gateway-s3-env Secret (file_search blobs in S3).
 *
 * The operator creates it by hand; setup-kyma.js never generates it. A re-run
 * of setup renders the live values unchanged, so deploy-kyma.js re-applies
 * exactly what runs, and renders nothing when the Secret does not exist. The
 * gateway Deployment references it as optional, so a gateway without S3 starts.
 *
 * kubectl and the prompts are mocked; no test reaches a cluster.
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

const ACCESS_KEY = 'AKIDFAKEFORTESTS';
const SECRET_KEY = 'fake-secret:with/"quotes"\\and+%';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

class KubectlError extends Error {
  stderr: string;
  constructor(stderr: string) {
    super(`Command failed: kubectl\n${stderr}`);
    this.stderr = stderr;
  }
}

type Cluster = Record<string, (() => string) | Error>;
const secretJson = (data: Record<string, string>) => () =>
  JSON.stringify({ data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, b64(v)])) });

function mockKubectl(setup: any, cluster: Cluster) {
  setup.runKubectl = (args: string[]) => {
    if (args[0] !== 'get' && args[0] !== 'config') throw new Error('mock: read-only');
    const answer = cluster[`${args[1]} ${args[2]}`];
    if (answer === undefined) {
      if (args[0] === 'config') throw new KubectlError('error: current-context is not set\n');
      throw new KubectlError(`Error from server (NotFound): ${args[1]}s "${args[2]}" not found\n`);
    }
    if (answer instanceof Error) throw answer;
    return answer();
  };
}

const liveCluster = (namespace: string, overrides: Cluster = {}): Cluster => ({
  [`namespace ${namespace}`]: () => `namespace/${namespace}\n`,
  'secret postgres-env': secretJson({ POSTGRES_USER: 'live_admin', POSTGRES_PASSWORD: 'live-password' }),
  'secret admin-env': secretJson({ VALIDATION_TOKEN_SECRET: 'live-vts' }),
  'secret gateway-env': secretJson({ VALIDATION_TOKEN_SECRET: 'live-vts' }),
  ...overrides,
});

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
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.slice(text.indexOf('\nstringData:')).matchAll(/^ {2}([A-Za-z0-9_.]+): (.*)$/gm)) {
    out[m[1]] = m[2].startsWith('"') ? JSON.parse(m[2]) : m[2];
  }
  return out;
}

describe('setup-kyma.js and the optional gateway-s3-env Secret', () => {
  let outputRoot: string;
  let projectRoot: string;
  let out: ReturnType<typeof captureOutput>;

  beforeEach(() => {
    outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-s3-out-'));
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-s3-project-'));
    out = captureOutput();
    KymaSetup.useInquirer({
      prompt: async (questions: Array<Record<string, unknown>>) =>
        Object.fromEntries(questions.map((q) => [q.name, q.name === 'POSTGRES_PASSWORD' ? '' : q.default])),
    });
  });

  afterEach(() => {
    out.restore();
    KymaSetup.useInquirer(null);
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  const makeSetup = (namespace: string) => {
    const setup = new KymaSetup({ namespace, outputRoot });
    setup.projectRoot = projectRoot;
    setup._k8sApiClusterIp = '10.0.0.1';
    setup.runDockerSetup = async (config: Record<string, unknown>) => setup.postProcessEnvFiles(config);
    return setup;
  };

  const render = async (setup: any) => {
    const dbConfig = await setup.promptForDatabaseCredentials();
    await setup.generateManifests(
      'internal', 'local', { LOGOUT_REDIRECT_URL: 'auto-shell' }, null,
      { registry: 'ghcr.io', organization: 'example-org', tag: '1.2.3', imagePullSecrets: false, useDigests: false },
      dbConfig, null,
    );
  };

  const secretsDir = (namespace: string) =>
    path.join(namespace === 'sail-proxy' ? outputRoot : path.join(outputRoot, 'deployments', namespace),
      'templates', 'secrets');

  it.each(['sail-proxy', 'sail-proxy-test'])('renders the live values unchanged on a re-run (%s)', async (namespace) => {
    const setup = makeSetup(namespace);
    mockKubectl(setup, liveCluster(namespace, {
      'secret gateway-s3-env': secretJson({
        FILE_SEARCH_S3_ACCESS_KEY_ID: ACCESS_KEY,
        FILE_SEARCH_S3_SECRET_ACCESS_KEY: SECRET_KEY,
        UNRELATED_KEY: 'not carried',
      }),
    }));
    await setup.loadExistingKeys();
    await render(setup);

    const file = path.join(secretsDir(namespace), 'gateway-s3-env.yaml');
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('name: gateway-s3-env');
    expect(text).toContain(`namespace: ${namespace}`);
    expect(stringData(file)).toEqual({
      FILE_SEARCH_S3_ACCESS_KEY_ID: ACCESS_KEY,
      FILE_SEARCH_S3_SECRET_ACCESS_KEY: SECRET_KEY,
    });
    const printed = out.lines.join('\n');
    expect(printed).toContain('gateway-s3-env');
    expect(printed).not.toContain(ACCESS_KEY);
    expect(printed).not.toContain(SECRET_KEY);
  });

  it('renders nothing when the live namespace has no gateway-s3-env', async () => {
    const setup = makeSetup('sail-proxy');
    mockKubectl(setup, liveCluster('sail-proxy'));
    await setup.loadExistingKeys();
    await render(setup);
    expect(fs.existsSync(path.join(secretsDir('sail-proxy'), 'gateway-env.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(secretsDir('sail-proxy'), 'gateway-s3-env.yaml'))).toBe(false);
  });

  it('removes a stale rendered gateway-s3-env.yaml when the live Secret is gone', async () => {
    const dir = secretsDir('sail-proxy');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'gateway-s3-env.yaml'), 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: gateway-s3-env\n');
    const setup = makeSetup('sail-proxy');
    mockKubectl(setup, liveCluster('sail-proxy'));
    await setup.loadExistingKeys();
    await render(setup);
    expect(fs.existsSync(path.join(dir, 'gateway-s3-env.yaml'))).toBe(false);
    expect(out.lines.join('\n')).toContain('Removed the stale rendered gateway-s3-env.yaml');
  });

  it('renders nothing for an empty gateway-s3-env', async () => {
    const setup = makeSetup('sail-proxy');
    mockKubectl(setup, liveCluster('sail-proxy', { 'secret gateway-s3-env': secretJson({}) }));
    await setup.loadExistingKeys();
    await render(setup);
    expect(fs.existsSync(path.join(secretsDir('sail-proxy'), 'gateway-s3-env.yaml'))).toBe(false);
  });

  it('stops rather than drop the credentials when the Secret cannot be read', async () => {
    const setup = makeSetup('sail-proxy');
    mockKubectl(setup, liveCluster('sail-proxy', {
      'secret gateway-s3-env': new KubectlError('Error from server (Forbidden): secrets "gateway-s3-env" is forbidden\n'),
    }));
    await expect(setup.loadExistingKeys()).rejects.toThrow(/S3 credentials/);
  });
});

describe('the Kyma wiring of gateway-s3-env', () => {
  const ROOT = path.join(__dirname, '..', '..', '..');

  it('the gateway container references it as optional, the init containers not at all', () => {
    const manifest = fs.readFileSync(path.join(ROOT, 'kyma', 'templates', 'manifests', 'core', 'gateway.yaml'), 'utf8');
    const refs = [...manifest.matchAll(/- secretRef:\n\s+name: gateway-s3-env\n(\s+optional: true\n)?/g)];
    expect(refs).toHaveLength(1);
    expect(refs[0][1]).toBeDefined();
    const containersAt = manifest.indexOf('\n      containers:');
    expect(containersAt).toBeGreaterThan(-1);
    expect(refs[0].index).toBeGreaterThan(containersAt);
  });

  it('deploy-kyma.js applies the rendered file when it exists', () => {
    const deploy = fs.readFileSync(path.join(ROOT, 'kyma', 'scripts', 'deploy-kyma.js'), 'utf8');
    expect(deploy).toMatch(/const secretFiles = \[[^\]]*'gateway-s3-env\.yaml'[^\]]*\]/);
  });

  it('the tracked template holds placeholders only', () => {
    const template = fs.readFileSync(
      path.join(ROOT, 'kyma', 'templates', 'secrets', 'gateway-s3-env.yaml.template'), 'utf8');
    expect(template).toContain('FILE_SEARCH_S3_ACCESS_KEY_ID: <access-key-id>');
    expect(template).toContain('FILE_SEARCH_S3_SECRET_ACCESS_KEY: <secret-access-key>');
    expect(template).not.toMatch(/AKIA[0-9A-Z]{12,}/);
  });
});
