/**
 * Golden render of setup-kyma.js for the default namespace.
 *
 * A production cluster was set up from these manifests; any change to what
 * setup-kyma.js renders for sail-proxy (a template edit, a renamed object, a
 * reformatted secret) reaches that cluster on its next deploy. This renders a
 * fixed public configuration into a temp dir and compares every file with the
 * committed copy in test/fixtures/kyma-golden/sail-proxy/, so such a change is
 * a reviewed fixture update instead of a surprise.
 *
 * Every input is fixed and fake: generated secrets are stubbed, kubectl and
 * setup-docker.js never run, and the project root is an empty temp dir (Dex
 * falls back to its built-in configuration). admin-api-config.yaml is left out:
 * it embeds api_config.json, which kyma-api-config-sync.test.ts covers.
 * js-yaml is replaced by JSON output, as in kyma-namespace.test.ts, so the
 * Dex config and istio-system policies are pinned in that form.
 *
 * After an intended change, regenerate with:
 *   UPDATE_KYMA_GOLDEN=1 pnpm test -- test/kyma-golden.test.ts
 * and review the fixture diff.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const KymaSetup = require('../../../kyma/scripts/setup-kyma.js');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'kyma-golden', 'sail-proxy');

KymaSetup.useYaml({
  dump: (obj: unknown) => JSON.stringify(obj, null, 2) + '\n',
  load: () => {
    throw new Error('yaml.load is not available in tests');
  },
});

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

function relativeFiles(dir: string): string[] {
  return listFiles(dir)
    .map((f) => path.relative(dir, f).split(path.sep).join('/'))
    .sort();
}

async function renderDefault(outputRoot: string, projectRoot: string, setup = new KymaSetup({ outputRoot })) {
  setup.projectRoot = projectRoot;
  setup._k8sApiClusterIp = '10.0.0.1';
  let token = 0;
  setup.generateSecureToken = () => `test-token-${++token}`.padEnd(64, '0');
  setup.generateOAuth2ClientSecret = () => 'test-client-secret'.padEnd(64, '0');
  setup.generateOAuth2CookieSecret = () => 'test-cookie-secret'.padEnd(32, '0');
  setup.generateDatabasePassword = () => 'test-db-password';
  setup.generateSiemCredentialKey = () => 'test-siem-credential-key'.padEnd(64, '0');
  setup.runDockerSetup = async (config: Record<string, unknown>) => {
    // Stands in for setup-docker.js + postProcessEnvFiles with fixed .env content.
    await setup.createEnvConfigMaps(
      { LOG_LEVEL: 'info', ADMIN_URL: 'http://localhost:4004', PORT: '3000' },
      {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
        'cds.requires.db.kind': 'postgres',
        'cds.requires.db.credentials.user': 'placeholder',
        // setup-docker.js writes one; it must stay out of admin-config (it lives in admin-env).
        SIEM_CREDENTIAL_KEY: 'from-setup-docker',
      },
      config
    );
    await setup.updateDeploymentManifests(config);
  };

  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    return await setup.generateManifests(
      'public',
      'local',
      { LOGOUT_REDIRECT_URL: 'auto-shell', ROLE_MAPPING: '{"admin@example.com":"admin"}' },
      {
        domain: 'sail-proxy',
        clusterSubdomain: 'c-abc123',
        ipAllowlist: ['198.51.100.0/24', '203.0.113.12/32'],
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
        useDigests: true,
        imageDigests: {
          'sail-proxy-gateway': `sha256:${'a'.repeat(64)}`,
          'sail-proxy-admin': `sha256:${'b'.repeat(64)}`,
        },
      },
      { POSTGRES_USER: 'gw_admin', POSTGRES_PASSWORD: 'not-a-real-password' },
      {
        SAP_AI_CORE_URL: 'https://api.ai.example.test',
        AUTH_URL: 'https://auth.example.test',
        CLIENT_ID: 'example-client',
        CLIENT_SECRET: 'not-a-real-client-secret',
        SAP_AI_REGION: 'example-region',
        SAP_AI_RESOURCE_GROUP: 'default',
      }
    );
  } finally {
    log.mockRestore();
    warn.mockRestore();
  }
}

describe('setup-kyma.js golden render for the default namespace', () => {
  let outputRoot: string;
  let projectRoot: string;
  let rendered: string[];

  beforeAll(async () => {
    outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-golden-out-'));
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-golden-project-'));
    await renderDefault(outputRoot, projectRoot);
    rendered = relativeFiles(outputRoot).filter((rel) => rel !== 'templates/configmaps/admin-api-config.yaml');

    if (process.env.UPDATE_KYMA_GOLDEN) {
      fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
      for (const rel of rendered) {
        const target = path.join(FIXTURE_DIR, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(outputRoot, rel), target);
      }
    }
  });

  afterAll(() => {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('renders exactly the committed set of files', () => {
    expect(rendered).toEqual(relativeFiles(FIXTURE_DIR));
  });

  it('renders every file byte for byte as committed', () => {
    expect(relativeFiles(FIXTURE_DIR).length).toBeGreaterThan(20);
    for (const rel of relativeFiles(FIXTURE_DIR)) {
      const actual = fs.readFileSync(path.join(outputRoot, rel), 'utf8');
      const expected = fs.readFileSync(path.join(FIXTURE_DIR, rel), 'utf8');
      expect({ rel, content: actual }).toEqual({ rel, content: expected });
    }
  });
});

// Every rendered Secret holds keys or passwords; only the owner may read it, also when an earlier
// render (before this rule) left the file world-readable.
(process.platform === 'win32' ? describe.skip : describe)('setup-kyma.js secret file modes', () => {
  let outputRoot: string;
  let projectRoot: string;
  const secretsDir = () => path.join(outputRoot, 'templates', 'secrets');
  const modes = () =>
    Object.fromEntries(
      fs.readdirSync(secretsDir()).map((f) => [f, (fs.statSync(path.join(secretsDir(), f)).mode & 0o777).toString(8)])
    );

  beforeAll(async () => {
    outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-modes-out-'));
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-modes-project-'));
    await renderDefault(outputRoot, projectRoot);
  });

  afterAll(() => {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('writes every secret file readable by the owner only', () => {
    const found = modes();
    expect(Object.keys(found)).toEqual(
      expect.arrayContaining(['admin-env.yaml', 'gateway-env.yaml', 'gateway-migration-env.yaml', 'oauth2-proxy-secrets.yaml', 'postgres-env.yaml'])
    );
    expect(Object.values(found).every((m) => m === '600')).toBe(true);
    expect(found).toEqual(Object.fromEntries(Object.keys(found).map((f) => [f, '600'])));
  });

  // Dex's config holds the oauth2-proxy client secret and the GitHub client secret or LDAP bind
  // password: a Secret on the cluster, not a ConfigMap anyone with read access to the namespace sees.
  it('renders the Dex config, which holds client secrets, as a Secret readable by the owner only', () => {
    const file = path.join(outputRoot, 'templates', 'secrets', 'dex-config.yaml');
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toMatch(/^kind: Secret$/m);
    expect(text).toMatch(/^stringData:\n {2}config\.yaml: \|$/m);
    expect(text).toMatch(/"secret": "test-client-secret/);
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
    expect(fs.existsSync(path.join(outputRoot, 'templates', 'configmaps', 'dex-config.yaml'))).toBe(false);
  });

  // An upgrade's rollback deletes only labelled objects the snapshot lacks: objects that 0.11.0 did
  // not have must carry part-of sail-proxy, or a rollback to 0.11.0 leaves them behind (the Secret
  // dex-config would then shadow the ConfigMap the restored 0.11.0 keeps editing).
  it('labels the objects that are new since 0.11.0 as part of sail-proxy, so a rollback removes them', () => {
    const partOf = /^ {2}labels:\n {4}app\.kubernetes\.io\/part-of: sail-proxy$/m;
    expect(fs.readFileSync(path.join(outputRoot, 'templates', 'secrets', 'dex-config.yaml'), 'utf8')).toMatch(partOf);
    const policies = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'kyma', 'templates', 'manifests', 'core', 'network-policies.yaml'), 'utf8').split(/^---$/m);
    for (const name of ['allow-migrations-to-admin', 'allow-migrations-egress']) {
      const doc = policies.find((d) => new RegExp(`^ {2}name: ${name}$`, 'm').test(d));
      expect(doc).toMatch(partOf);
    }
  });

  it('mounts the Dex config from that Secret', () => {
    const dex = fs.readFileSync(path.join(outputRoot, 'manifests', 'auth', 'dex.yaml'), 'utf8');
    expect(dex).toMatch(/- name: dex-config\n {8}secret:\n {10}secretName: dex-config\n/);
    expect(dex).not.toMatch(/configMap:\n\s+name: dex-config/);
  });

  it('removes the Dex ConfigMap render an earlier version left, which holds the same secrets', async () => {
    const old = path.join(outputRoot, 'templates', 'configmaps', 'dex-config.yaml');
    fs.writeFileSync(old, 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: dex-config\n', { mode: 0o644 });
    await renderDefault(outputRoot, projectRoot);
    expect(fs.existsSync(old)).toBe(false);
  });

  it('tightens secret files an earlier render left world-readable', async () => {
    for (const f of fs.readdirSync(secretsDir())) fs.chmodSync(path.join(secretsDir(), f), 0o644);
    await renderDefault(outputRoot, projectRoot);
    expect(Object.values(modes())).toEqual(Object.values(modes()).map(() => '600'));
  });
});

// The registry token reaches the cluster only through the rendered Secret file:
// never through the printed deploy command (terminal, shell history) and never
// as a placeholder the user has to fill in by hand.
describe('setup-kyma.js registry pull Secret', () => {
  const TOKEN = 'not-a-real-token';
  let outputRoot: string;
  let projectRoot: string;
  let setup: InstanceType<typeof KymaSetup>;
  let config: Record<string, unknown>;

  beforeAll(async () => {
    outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-registry-out-'));
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-registry-project-'));
    setup = new KymaSetup({ outputRoot });
    config = await renderDefault(outputRoot, projectRoot, setup);
  });

  afterAll(() => {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('writes registry-secret.yaml with the credentials instead of the placeholder template', () => {
    const secrets = path.join(outputRoot, 'templates', 'secrets');
    expect(fs.existsSync(path.join(secrets, 'registry-secret.yaml.template'))).toBe(false);
    const yaml = fs.readFileSync(path.join(secrets, 'registry-secret.yaml'), 'utf8');
    expect(yaml).toMatch(/^type: kubernetes\.io\/dockerconfigjson$/m);
    const encoded = /\.dockerconfigjson: (\S+)/.exec(yaml)![1];
    const docker = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    expect(docker).toEqual({
      auths: {
        'ghcr.io': { username: 'robot', password: TOKEN, auth: Buffer.from(`robot:${TOKEN}`).toString('base64') },
      },
    });
  });

  (process.platform === 'win32' ? it.skip : it)('writes registry-secret.yaml readable by the owner only', () => {
    const stat = fs.statSync(path.join(outputRoot, 'templates', 'secrets', 'registry-secret.yaml'));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it.each([
    ['own images', {}],
    ['the published images', { containerOrganization: 'st-gr' }],
  ])('prints a deploy command without the registry token (%s)', async (_label, override) => {
    const printed: string[] = [];
    const log = jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      printed.push(a.join(' '));
    });
    try {
      await setup.showCompletion({ ...config, ...override });
    } finally {
      log.mockRestore();
    }
    const text = printed.join('\n');
    expect(text).toMatch(/node \S*deploy-kyma\.js/);
    expect(text).not.toContain('KYMA_DEPLOY_CONFIG');
    expect(text).not.toContain(TOKEN);
    // The old hand-over was the whole config, token included, as one base64 run.
    expect(text).not.toMatch(/[A-Za-z0-9+/=]{80,}/);
  });
});
