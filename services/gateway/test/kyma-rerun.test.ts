/**
 * Interactive setup-kyma.js re-run: every question defaults to the value the deployment already
 * has. Values shared with Docker come from the Docker files (docker/.env, .env.auth, .env.nginx,
 * .env.docker, dex.config.yaml); Kyma-only values from the namespace's generated files (templates/
 * secrets, templates/configmaps, manifests/), then from the cluster where the script already reads
 * it, then today's default. The OAuth2 proxy secrets are kept unless regenerated. --force starts
 * from today's defaults.
 *
 * kubectl, the registry lookups and setup-docker.js are stubbed; output goes to temp dirs and no
 * test reaches a cluster. The prompter presses Enter (takes the shown default) unless an answer is
 * given for the question.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-var-requires */
const KymaSetup = require('../../../kyma/scripts/setup-kyma.js');
const { PromptSession, REVIEW, WRITE } = require('../../../docker/setup-flow/session');
/* eslint-enable @typescript-eslint/no-var-requires */

// js-yaml is not installed for the tests: JSON is YAML, so JSON stands in both ways.
KymaSetup.useYaml({
  dump: (obj: unknown) => JSON.stringify(obj, null, 2) + '\n',
  load: (text: string) => JSON.parse(text),
});

const NAMESPACE = 'sail-proxy-test';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

class KubectlError extends Error {
  stderr: string;
  constructor(stderr: string) {
    super(`Command failed: kubectl\n${stderr}`);
    this.stderr = stderr;
  }
}

type Cluster = Record<string, () => string>;

/** kubectl `get` answered from "<kind> <name>"; anything else is the server's NotFound. */
function mockKubectl(setup: any, cluster: Cluster) {
  const calls: string[][] = [];
  setup.runKubectl = (args: string[]) => {
    calls.push(args);
    const key = args[0] === 'config' ? `config ${args[1]}` : `${args[1]} ${args[2]}`;
    const answer = cluster[key];
    if (answer) return answer();
    if (args[0] === 'config') return 'test-context\n';
    throw new KubectlError(`Error from server (NotFound): ${args[1]}s "${args[2]}" not found\n`);
  };
  return calls;
}

const secretJson = (data: Record<string, string>) => () =>
  JSON.stringify({ data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, b64(v)])) });

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

/** Every file under a dir, raw (secrets included), by relative path. */
function files(dir: string): Record<string, string> {
  return Object.fromEntries(listFiles(dir).map((f) => [path.relative(dir, f), fs.readFileSync(f, 'utf8')]));
}

/** The stringData of a rendered Secret. */
function stringData(file: string): Record<string, string> {
  const text = fs.readFileSync(file, 'utf8');
  const out: Record<string, string> = {};
  for (const m of text.slice(text.indexOf('stringData:')).matchAll(/^ {2}([A-Za-z_.-]+): (.*)$/gm)) {
    out[m[1]] = m[2].startsWith('"') ? JSON.parse(m[2]) : m[2];
  }
  return out;
}

let outputRoot: string;
let projectRoot: string;
let printed: string[];
let exits: Array<number | undefined>;
let savedServiceKey: string | undefined;

beforeEach(() => {
  savedServiceKey = process.env.SAP_AI_CORE_SERVICE_KEY;
  delete process.env.SAP_AI_CORE_SERVICE_KEY;
  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-rerun-out-'));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-rerun-project-'));
  // The GitHub Dex connector template generateDexConfig adapts (JSON, read by the stand-in above).
  const githubDex = path.join(projectRoot, 'docker/configs/providers/github/dex.config.yaml');
  fs.mkdirSync(path.dirname(githubDex), { recursive: true });
  fs.writeFileSync(
    githubDex,
    JSON.stringify({
      connectors: [
        {
          type: 'github',
          id: 'github-org',
          name: 'GitHub Organization',
          config: {
            clientID: 'GITHUB_CLIENT_ID',
            clientSecret: 'GITHUB_CLIENT_SECRET',
            redirectURI: 'BASE_URL/dex/callback',
            orgs: [{ name: 'GITHUB_ORG', teams: ['GITHUB_ADMIN_TEAM', 'GITHUB_USER_TEAM'] }],
          },
        },
      ],
    })
  );
  printed = [];
  exits = [];
  const capture = (...a: unknown[]) => {
    printed.push(a.map(String).join(' '));
  };
  jest.spyOn(console, 'log').mockImplementation(capture);
  jest.spyOn(console, 'warn').mockImplementation(capture);
  jest.spyOn(console, 'error').mockImplementation(capture);
  jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code);
  }) as any);
  KymaSetup.useInquirer({
    prompt: async (questions: unknown) => {
      throw new Error(`inquirer.prompt called outside the session: ${JSON.stringify(questions)}`);
    },
  });
});

afterEach(() => {
  if (savedServiceKey === undefined) delete process.env.SAP_AI_CORE_SERVICE_KEY;
  else process.env.SAP_AI_CORE_SERVICE_KEY = savedServiceKey;
  KymaSetup.useInquirer(null);
  jest.restoreAllMocks();
  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

interface Shown {
  id: string;
  type: string;
  default: any;
  message: string;
  choices?: any[];
}

/** What pressing Enter answers for a question. */
function enter(question: any): any {
  if (question.type === 'list') {
    return question.default !== undefined ? question.default : question.choices[0].value;
  }
  if (question.type === 'confirm') return question.default !== false;
  if (question.type === 'password') return '';
  return question.default !== undefined ? question.default : '';
}

interface RunOptions {
  cluster?: Cluster;
  force?: boolean;
  /** false: the run ends on the review screen without writing. */
  write?: boolean;
  /** Review screen answers given before Write configuration (e.g. { jump: id }). */
  review?: any[];
  /** Registry digests by "<image>:<tag>" (default: none found, images use tags). */
  digest?: (image: string, tag: string) => string | null;
}

/** A sha256 digest derived from a seed, as the registry would report it. */
const fakeDigest = (seed: string) => `sha256:${require('crypto').createHash('sha256').update(seed).digest('hex')}`;

/**
 * One interactive run for NAMESPACE (as with --namespace): answers[id] where given (a list for a
 * question asked more than once), Enter everywhere else, then Write configuration (or abort).
 */
async function run(answers: Record<string, any> = {}, options: RunOptions = {}) {
  const shown: Shown[] = [];
  const queue: Record<string, any[]> = {};
  // Deploying is a confirmation, not configuration: never deploy in a test.
  for (const [id, value] of Object.entries({ autoDeploy: false, ...answers })) {
    queue[id] = Array.isArray(value) ? [...value] : [value];
  }
  const review = [...(options.review || [])];
  const promptFn = async (question: any) => {
    shown.push({ id: question.id, type: question.type, default: question.default, message: question.message, choices: question.choices });
    if (question.id === REVIEW) {
      if (review.length) return review.shift().jump;
      if (options.write === false) throw new Error('aborted on the review screen');
      return WRITE;
    }
    let value = queue[question.id] && queue[question.id].length ? queue[question.id].shift() : enter(question);
    if (question.type === 'list' && !question.choices.some((c: any) => (c && typeof c === 'object' ? c.value : c) === value)) {
      throw new Error(`answer for ${question.id} is not a choice: ${String(value)}`);
    }
    if (question.filter) value = await question.filter(value);
    const valid = question.validate ? await question.validate(value) : true;
    if (valid !== true) throw new Error(`answer for ${question.id} rejected: ${valid}`);
    return value;
  };

  const setup = new KymaSetup({ outputRoot, namespace: NAMESPACE, forceOverwrite: options.force === true });
  setup.projectRoot = projectRoot;
  setup._k8sApiClusterIp = '10.0.0.1';
  setup.runDockerSetup = async (config: Record<string, unknown>) => setup.postProcessEnvFiles(config);
  setup.fetchImageTags = async () => ['1.2.3', '1.2.2'];
  const digestLookups: string[] = [];
  setup.fetchImageDigest = async (_config: unknown, image: string, tag: string) => {
    digestLookups.push(`${image}:${tag}`);
    return options.digest ? options.digest(image, tag) : null;
  };
  const calls = mockKubectl(setup, options.cluster || {});
  setup.createSession = () => new PromptSession({ promptFn });
  const exitsBefore = exits.length;
  await setup.run();
  if (options.write !== false && exits.slice(exitsBefore).some((code) => code !== 0)) {
    throw new Error(`setup failed: ${printed.slice(-3).join(' | ')}`);
  }
  const byId = (id: string) => shown.find((q) => q.id === id);
  return { shown, byId, calls, setup, digestLookups };
}

const outputDir = () => path.join(outputRoot, 'deployments', NAMESPACE);
const secretsDir = () => path.join(outputDir(), 'templates/secrets');

const GITHUB_CLIENT_SECRET = 'gh-client-secret-kyma-1';
const SAP_CLIENT_SECRET = 'sap-client-secret-kyma-1';

/** A first run into a namespace that does not exist yet, with non-default answers throughout. */
const FIRST_RUN: Record<string, any> = {
  confirmNewNamespace: true,
  deploymentType: 'public',
  provider: 'github',
  GITHUB_CLIENT_ID: 'gh-client-id-kyma',
  GITHUB_CLIENT_SECRET,
  GITHUB_ORG: 'acme',
  GITHUB_ADMIN_TEAM: 'platform-admins',
  GITHUB_USER_TEAM: 'platform-users',
  domain: 'kyma-test-host',
  clusterSubdomain: 'c-abc123',
  ipAllowlist: '198.51.100.0/24,203.0.113.12/32',
  allowIstioSystemChanges: true,
  sccTunnel: false,
  registry: 'docker.io',
  organization: 'acme-images',
  imagePullSecrets: false,
  version: '1.2.2',
  POSTGRES_USER: 'kyma_user',
  POSTGRES_PASSWORD: '',
  configMethod: 'manual',
  SAP_AI_CORE_URL: 'https://api.ai.example.test',
  AUTH_URL: 'https://auth.example.test/oauth/token',
  CLIENT_ID: 'sap-client-id',
  CLIENT_SECRET: SAP_CLIENT_SECRET,
  SAP_AI_REGION: 'prod.example-1',
  SAP_AI_RESOURCE_GROUP: 'team-rg',
};

/** The live namespace as deploy-kyma.js leaves it: the rendered Secrets applied. */
function deployedCluster(): Cluster {
  const cluster: Cluster = { [`namespace ${NAMESPACE}`]: () => `namespace/${NAMESPACE}\n` };
  for (const name of ['admin-env', 'gateway-env', 'postgres-env', 'gateway-migration-env']) {
    cluster[`secret ${name}`] = secretJson(stringData(path.join(secretsDir(), `${name}.yaml`)));
  }
  return cluster;
}

/** Every secret value of the first run's rendered output (the values a re-run must never print). */
function renderedSecrets(): string[] {
  const values = new Set<string>([GITHUB_CLIENT_SECRET, SAP_CLIENT_SECRET]);
  const keys = /SECRET|KEY|PASSWORD|DATABASE_URL|password|cookie/;
  for (const name of ['admin-env', 'gateway-env', 'postgres-env', 'gateway-migration-env', 'oauth2-proxy-secrets']) {
    for (const [key, value] of Object.entries(stringData(path.join(secretsDir(), `${name}.yaml`)))) {
      if (keys.test(key) && value.length >= 8) values.add(value);
    }
  }
  return [...values];
}

/** No secret value in any prompt (default, message, choices) or on the console. */
function expectNoLeak(shown: Shown[], secrets: string[]) {
  const surfaces = [
    ...shown.map((q) => JSON.stringify({ default: q.default, message: q.message, choices: q.choices })),
    printed.join('\n'),
  ].join('\n');
  for (const secret of secrets) expect({ secret: secret.slice(0, 4), leaked: surfaces.includes(secret) }).toEqual({ secret: secret.slice(0, 4), leaked: false });
}

describe('setup-kyma.js re-run defaults to the current configuration', () => {
  it('enter-only re-run keeps every generated file byte-identical', async () => {
    await run(FIRST_RUN);
    const before = files(outputRoot);
    expect(Object.keys(before).length).toBeGreaterThan(15);
    const secrets = renderedSecrets();
    expect(secrets.length).toBeGreaterThan(8);

    printed = [];
    const { shown, byId } = await run({}, { cluster: deployedCluster() });

    expect(files(outputRoot)).toEqual(before);
    // The OAuth2 proxy secrets are kept and offered for regeneration.
    const regenerate = byId('key-regeneration');
    expect(regenerate).toBeDefined();
    expect(byId('GITHUB_CLIENT_SECRET')!.message).toContain('Enter keeps it');
    expect(byId('CLIENT_SECRET')!.message).toContain('Enter keeps it');
    expectNoLeak(shown, secrets);
  });

  it('offers the kept OAuth2 proxy secrets for regeneration and replaces only the one chosen', async () => {
    await run(FIRST_RUN);
    const before = stringData(path.join(secretsDir(), 'oauth2-proxy-secrets.yaml'));
    const dexBefore = fs.readFileSync(path.join(outputDir(), 'templates/configmaps/dex-config.yaml'), 'utf8');

    const { shown } = await run(
      {
        'key-regeneration': 'regenerate',
        'regenerate-key': ['OAUTH2_PROXY_COOKIE_SECRET', '__done__'],
        'regenerate-confirm': true,
      },
      { cluster: deployedCluster() }
    );

    const offered = shown.find((q) => q.id === 'regenerate-key')!.choices!.map((c: any) => c.value);
    expect(offered).toEqual(expect.arrayContaining(['OAUTH2_PROXY_CLIENT_SECRET', 'OAUTH2_PROXY_COOKIE_SECRET']));
    const after = stringData(path.join(secretsDir(), 'oauth2-proxy-secrets.yaml'));
    expect(after['client-secret']).toBe(before['client-secret']);
    expect(after['cookie-secret']).not.toBe(before['cookie-secret']);
    expect(after['cookie-secret']).toMatch(/^[0-9a-f]{32}$/);
    expect(fs.readFileSync(path.join(outputDir(), 'templates/configmaps/dex-config.yaml'), 'utf8')).toBe(dexBefore);
  });

  it('generated kyma files win; docker env only fills gaps', async () => {
    // A namespace rendered with GitHub auth, its own client id/secret and a private registry.
    const registryLogin = { dockerUsername: 'robot', dockerPassword: 'registry-token-1' };
    await run({ ...FIRST_RUN, registry: 'custom', customRegistry: 'reg.kyma.invalid', imagePullSecrets: true, ...registryLogin });
    const before = files(outputRoot);
    const secrets = renderedSecrets();
    // The local Docker stack: local auth and other values throughout.
    const docker = path.join(projectRoot, 'docker');
    fs.writeFileSync(path.join(docker, '.env'), 'POSTGRES_USER=docker_user\nPOSTGRES_PASSWORD=docker-password-1\n');
    fs.writeFileSync(path.join(docker, '.env.auth'), 'IDENTITY_PROVIDER=local\nROLE_MAPPING={"admin@example.com":"admin"}\n');
    fs.writeFileSync(
      path.join(docker, '.env.docker'),
      'DOCKER_REGISTRY=reg.docker.invalid\nDOCKER_ORGANIZATION=docker-org\nDOCKER_IMAGE_MODE=registry\n'
    );
    fs.writeFileSync(
      path.join(docker, 'dex.config.yaml'),
      'connectors:\n- type: github\n  config:\n    clientID: docker-client-id\n    clientSecret: docker-client-secret\n    orgs:\n    - name: dockerorg\n'
    );

    // Enter everywhere; the registry login is asked again because no file holds it.
    const { shown, byId } = await run(registryLogin, { cluster: deployedCluster() });

    expect(byId('provider')!.default).toBe('github');
    expect(byId('GITHUB_CLIENT_ID')!.default).toBe('gh-client-id-kyma');
    expect(byId('GITHUB_ORG')!.default).toBe('acme');
    expect(byId('GITHUB_ADMIN_TEAM')!.default).toBe('platform-admins');
    expect(byId('registry')!.default).toBe('custom');
    expect(byId('customRegistry')!.default).toBe('reg.kyma.invalid');
    expect(byId('organization')!.default).toBe('acme-images');
    expect(byId('POSTGRES_USER')!.default).toBe('kyma_user');
    expect(files(outputRoot)).toEqual(before);
    expectNoLeak(shown, [...secrets, 'docker-client-secret', 'docker-password-1', 'registry-token-1']);
  });

  it('a value the kyma files do not hold is taken from the docker env', async () => {
    // Rendered with local auth: no GitHub settings in the Kyma files.
    await run({ ...FIRST_RUN, provider: 'local', LOGOUT_REDIRECT_URL: 'auto-shell' });
    const docker = path.join(projectRoot, 'docker');
    fs.writeFileSync(
      path.join(docker, '.env.auth'),
      'IDENTITY_PROVIDER=github\nROLE_MAPPING={"dockerorg:docker-admins":"admin","dockerorg:docker-users":"user"}\n'
    );
    fs.writeFileSync(
      path.join(docker, 'dex.config.yaml'),
      'connectors:\n- type: github\n  config:\n    clientID: docker-client-id\n    clientSecret: docker-client-secret\n    orgs:\n    - name: dockerorg\n'
    );

    // Switching to GitHub: the Docker stack's settings are offered.
    const { shown, byId } = await run({ confirmNewNamespace: true, provider: 'github' }, { write: false });
    expect(byId('provider')!.default).toBe('local');
    expect(byId('GITHUB_CLIENT_ID')!.default).toBe('docker-client-id');
    expect(byId('GITHUB_CLIENT_SECRET')!.message).toContain('Enter keeps it');
    expect(byId('GITHUB_ORG')!.default).toBe('dockerorg');
    expect(byId('GITHUB_ADMIN_TEAM')!.default).toBe('docker-admins');
    expect(byId('GITHUB_USER_TEAM')!.default).toBe('docker-users');
    // Held by the Kyma files: still theirs.
    expect(byId('registry')!.default).toBe('docker.io');
    expect(byId('organization')!.default).toBe('acme-images');
    expectNoLeak(shown, ['docker-client-secret']);
  });

  it('missing docker env falls through to generated files', async () => {
    await run(FIRST_RUN);
    const { shown, byId } = await run({ confirmNewNamespace: true }, { write: false });

    const defaults = Object.fromEntries(
      [
        'deploymentType', 'provider', 'GITHUB_CLIENT_ID', 'GITHUB_ORG', 'GITHUB_ADMIN_TEAM', 'GITHUB_USER_TEAM',
        'domain', 'clusterSubdomain', 'ipAllowlist', 'allowIstioSystemChanges', 'sccTunnel',
        'registry', 'organization', 'version', 'POSTGRES_USER', 'configMethod',
        'SAP_AI_CORE_URL', 'AUTH_URL', 'CLIENT_ID', 'SAP_AI_REGION', 'SAP_AI_RESOURCE_GROUP',
      ].map((id) => [id, byId(id)?.default])
    );
    expect(defaults).toEqual({
      deploymentType: 'public',
      provider: 'github',
      GITHUB_CLIENT_ID: 'gh-client-id-kyma',
      GITHUB_ORG: 'acme',
      GITHUB_ADMIN_TEAM: 'platform-admins',
      GITHUB_USER_TEAM: 'platform-users',
      domain: 'kyma-test-host',
      clusterSubdomain: 'c-abc123',
      ipAllowlist: '198.51.100.0/24,203.0.113.12/32',
      allowIstioSystemChanges: true,
      sccTunnel: false,
      registry: 'docker.io',
      organization: 'acme-images',
      version: '1.2.2',
      POSTGRES_USER: 'kyma_user',
      configMethod: 'manual',
      SAP_AI_CORE_URL: 'https://api.ai.example.test',
      AUTH_URL: 'https://auth.example.test/oauth/token',
      CLIENT_ID: 'sap-client-id',
      SAP_AI_REGION: 'prod.example-1',
      SAP_AI_RESOURCE_GROUP: 'team-rg',
    });
    expectNoLeak(shown, [GITHUB_CLIENT_SECRET, SAP_CLIENT_SECRET]);
  });

  it('without generated files the values come from the live namespace', async () => {
    const cluster: Cluster = {
      [`namespace ${NAMESPACE}`]: () => `namespace/${NAMESPACE}\n`,
      'secret admin-env': secretJson({
        VALIDATION_TOKEN_SECRET: 'live-validation-token-secret-0001',
        IDENTITY_PROVIDER: 'github',
        ROLE_MAPPING: '{"liveorg:live-admins":"admin","liveorg:live-users":"user"}',
        BASE_URL: 'https://live-host.c-live01.kyma.ondemand.com',
      }),
      'secret gateway-env': secretJson({ VALIDATION_TOKEN_SECRET: 'live-validation-token-secret-0001' }),
      'secret postgres-env': secretJson({ POSTGRES_USER: 'live_user', POSTGRES_PASSWORD: 'live-db-password-1' }),
    };
    const { shown, byId } = await run({ GITHUB_CLIENT_ID: 'typed-id', GITHUB_CLIENT_SECRET: 'typed-secret-1' }, { cluster, write: false });
    expect(byId('provider')!.default).toBe('github');
    expect(byId('GITHUB_ORG')!.default).toBe('liveorg');
    expect(byId('GITHUB_ADMIN_TEAM')!.default).toBe('live-admins');
    expect(byId('deploymentType')!.default).toBe('public');
    expect(byId('domain')!.default).toBe('live-host');
    expect(byId('clusterSubdomain')!.default).toBe('c-live01');
    expect(byId('POSTGRES_USER')!.default).toBe('live_user');
    expect(byId('configMethod')!.default).toBe('skip');
    expectNoLeak(shown, ['live-validation-token-secret-0001', 'live-db-password-1']);
  });

  it('images pinned by digest: the re-run defaults to the pinned version, not the newest', async () => {
    const digest = (image: string, tag: string) => fakeDigest(`${image}:${tag}`);
    await run(FIRST_RUN, { digest });
    const admin = fs.readFileSync(path.join(outputDir(), 'manifests/core/admin.yaml'), 'utf8');
    expect(admin).toContain(`sail-proxy-admin@${digest('sail-proxy-admin', '1.2.2')}`);
    const before = files(outputRoot);

    // 1.2.3 is newer and listed first: Enter must not move the deployment to it.
    const { byId } = await run({}, { cluster: deployedCluster(), digest });
    expect(byId('version')!.default).toBe('1.2.2');
    expect(files(outputRoot)).toEqual(before);
  });

  it('images pinned by a digest no listed version has: the version must be chosen explicitly', async () => {
    await run(FIRST_RUN, { digest: (image, tag) => fakeDigest(`old:${image}:${tag}`) });
    const { byId } = await run(
      { confirmNewNamespace: true, customVersion: '1.2.2' },
      { digest: (image, tag) => fakeDigest(`${image}:${tag}`), write: false }
    );
    expect(byId('version')!.default).toBe('custom');
    expect(byId('customVersion')!.default).toBeUndefined();
    expect(printed.join('\n')).toContain('pinned by a digest that none of the listed versions has');
  });

  it('--force starts from today\'s defaults', async () => {
    await run(FIRST_RUN);
    const before = stringData(path.join(secretsDir(), 'oauth2-proxy-secrets.yaml'));
    const { byId } = await run(
      {
        confirmNewNamespace: true,
        deploymentType: 'internal',
        provider: 'local',
        POSTGRES_PASSWORD: '',
        configMethod: 'skip',
      },
      { force: true }
    );
    expect(byId('deploymentType')!.default).toBeUndefined();
    expect(byId('provider')!.default).toBeUndefined();
    expect(byId('registry')!.default).toBe('ghcr.io');
    expect(byId('organization')!.default).toBe('st-gr');
    expect(byId('version')!.default).toBeUndefined();
    expect(byId('POSTGRES_USER')!.default).toBe('admin_user');
    expect(byId('configMethod')!.default).toBeUndefined();
    expect(byId('key-regeneration')).toBeUndefined();
    const after = stringData(path.join(secretsDir(), 'oauth2-proxy-secrets.yaml'));
    expect(after['cookie-secret']).not.toBe(before['cookie-secret']);
    expect(after['client-secret']).not.toBe(before['client-secret']);
  });

  it('existing namespace: choosing a regeneration and aborting at the review writes nothing', async () => {
    const live = {
      VALIDATION_TOKEN_SECRET: 'live-validation-token-secret-0001',
      METADATA_ENCRYPTION_KEY: 'live-metadata-encryption-key-0002',
      AWS_SECRET_ENCRYPTION_KEY: 'live-aws-secret-encryption-key-03',
      SIEM_CREDENTIAL_KEY: 'live-siem-credential-key-00000004',
      CONNECTION_CREDENTIAL_KEY: 'live-connection-credential-key-05',
    };
    const cluster: Cluster = {
      [`namespace ${NAMESPACE}`]: () => `namespace/${NAMESPACE}\n`,
      'secret admin-env': secretJson(live),
      'secret gateway-env': secretJson({
        VALIDATION_TOKEN_SECRET: live.VALIDATION_TOKEN_SECRET,
        METADATA_ENCRYPTION_KEY: live.METADATA_ENCRYPTION_KEY,
      }),
    };
    const { shown, calls } = await run(
      {
        deploymentType: 'internal',
        provider: 'local',
        POSTGRES_PASSWORD: '',
        configMethod: 'skip',
        'key-regeneration': 'regenerate',
        'regenerate-key': ['SIEM_CREDENTIAL_KEY', '__done__'],
        'regenerate-confirm': true,
      },
      { cluster, write: false }
    );
    expect(shown[shown.length - 1].id).toBe(REVIEW);
    const review = shown[shown.length - 1].choices!.map((c: any) => c.name).join('\n');
    expect(review).toContain('Regenerated keys: SIEM_CREDENTIAL_KEY');
    expect(exits).toEqual([1]);
    expect(listFiles(outputRoot)).toEqual([]);
    expect(listFiles(path.join(projectRoot, 'services'))).toEqual([]);
    for (const args of calls) expect(['get', 'config']).toContain(args[0]);
    expectNoLeak(shown, Object.values(live));
  });

  it('a namespace changed by a review jump starts from that namespace\'s values, not the old answers', async () => {
    const OTHER = 'sail-proxy-beta';
    await run(FIRST_RUN);
    const OTHER_RUN = {
      ...FIRST_RUN,
      namespace: OTHER,
      GITHUB_CLIENT_ID: 'gh-client-id-beta',
      GITHUB_ORG: 'beta-org',
      GITHUB_ADMIN_TEAM: 'beta-admins',
      GITHUB_USER_TEAM: 'beta-users',
      ipAllowlist: '192.0.2.0/24',
      POSTGRES_USER: 'beta_user',
      SAP_AI_RESOURCE_GROUP: 'beta-rg',
    };
    await run(OTHER_RUN);
    const otherConfig = () =>
      fs.readFileSync(path.join(outputRoot, 'deployments', OTHER, 'templates/configmaps/dex-config.yaml'), 'utf8');
    const dexBefore = otherConfig();

    // Enter through the first namespace, jump back to the namespace, switch, Enter through.
    printed = [];
    // Then jump once more, to a later question: the switch's own answers replay silently.
    const { shown } = await run(
      { namespace: [NAMESPACE, OTHER], confirmNewNamespace: [true, true] },
      { review: [{ jump: 'namespace' }, { jump: 'POSTGRES_USER' }] }
    );
    const reviewAt = shown.map((q, i) => (q.id === REVIEW ? i : -1)).filter((i) => i >= 0);
    const afterSecondJump = shown.slice(reviewAt[1] + 1).map((q) => q.id);
    expect(afterSecondJump[0]).toBe('POSTGRES_USER');
    expect(afterSecondJump).not.toContain('confirmNewNamespace');
    expect(afterSecondJump).not.toContain('namespace');
    expect(shown.slice(reviewAt[1]).find((q) => q.id === 'POSTGRES_USER')!.default).toBe('beta_user');

    // Defaults shown in the first namespace's pass and in the second's, up to the second jump.
    const after = (id: string) => shown.slice(0, reviewAt[1]).filter((q) => q.id === id).map((q) => q.default);
    expect(after('GITHUB_ORG')).toEqual(['acme', 'beta-org']);
    expect(after('GITHUB_CLIENT_ID')).toEqual(['gh-client-id-kyma', 'gh-client-id-beta']);
    expect(after('ipAllowlist')).toEqual(['198.51.100.0/24,203.0.113.12/32', '192.0.2.0/24']);
    expect(after('POSTGRES_USER')).toEqual(['kyma_user', 'beta_user']);
    expect(after('SAP_AI_RESOURCE_GROUP')).toEqual(['team-rg', 'beta-rg']);
    expect(otherConfig()).toBe(dexBefore);

    // The review marks changes against the second namespace's values: besides the namespace only
    // what any run into a namespace absent from the cluster changes (the confirmation, a new password).
    const reviews = shown.filter((q) => q.id === REVIEW);
    const changed = reviews[reviews.length - 1].choices!.filter((c: any) => c.type !== 'separator').map((c: any) => c.name).filter((n: string) => n.endsWith('(changed)'));
    expect(changed).toEqual([
      expect.stringMatching(/^Kubernetes namespace to deploy into: sail-proxy-beta/),
      expect.stringMatching(/^Is this the right cluster\? .*: Yes \(changed\)$/),
      'Database password: generated (changed)',
    ]);
  });
});

// The pull-secret credentials live only in the namespace's registry-secret.yaml: a re-run offers
// them from there, for the registry they were made for and never in clear.
describe('setup-kyma.js re-run and the registry pull secret', () => {
  const TOKEN = 'registry-token-1';
  const PRIVATE = { registry: 'custom', customRegistry: 'reg.kyma.invalid', imagePullSecrets: true };
  const registrySecret = () => path.join(secretsDir(), 'registry-secret.yaml');
  const storedLogin = () => {
    const encoded = /\.dockerconfigjson: (\S+)/.exec(fs.readFileSync(registrySecret(), 'utf8'))![1];
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')).auths;
  };

  beforeEach(async () => {
    await run({ ...FIRST_RUN, ...PRIVATE, dockerUsername: 'robot', dockerPassword: TOKEN });
    printed = [];
  });

  it('offers the stored username and token; Enter keeps them and every file', async () => {
    const before = files(outputRoot);
    const { shown, byId } = await run({}, { cluster: deployedCluster() });

    expect(byId('imagePullSecrets')!.default).toBe(true);
    expect(byId('dockerUsername')!.default).toBe('robot');
    expect(byId('dockerPassword')!.default).toBeUndefined();
    expect(byId('dockerPassword')!.message).toContain('Enter keeps it');
    expect(files(outputRoot)).toEqual(before);
    expectNoLeak(shown, [TOKEN, Buffer.from(`robot:${TOKEN}`).toString('base64')]);
    // The review shows the kept token as set, not as typed in this session.
    const review = shown.find((q) => q.id === REVIEW)!;
    expect(review.choices!.find((c: any) => c.value === 'dockerPassword')!.name).toMatch(/: set$/);
  });

  it('a registry needing no pull secret by default still defaults to one when the namespace stores it', async () => {
    await run({ registry: 'docker.io', dockerUsername: 'robot', dockerPassword: TOKEN }, { cluster: deployedCluster() });
    const { byId } = await run({}, { cluster: deployedCluster() });
    expect(byId('imagePullSecrets')!.default).toBe(true);
    expect(byId('dockerUsername')!.default).toBe('robot');
  });

  it('a new token typed on the re-run replaces the stored one', async () => {
    await run({ dockerPassword: 'registry-token-2' }, { cluster: deployedCluster() });
    expect(storedLogin()['reg.kyma.invalid']).toMatchObject({ username: 'robot', password: 'registry-token-2' });
  });

  it('offers nothing stored for a different registry', async () => {
    const { byId } = await run(
      { customRegistry: 'other.kyma.invalid', dockerUsername: 'robot-2', dockerPassword: 'registry-token-2' },
      { cluster: deployedCluster() }
    );
    expect(byId('dockerUsername')!.default).toBeUndefined();
    expect(byId('dockerPassword')!.message).not.toContain('Enter keeps it');
    expect(Object.keys(storedLogin())).toEqual(['other.kyma.invalid']);
  });

  it('a review jump to another registry forgets the login kept for the first one', async () => {
    const { shown } = await run(
      {
        customRegistry: ['reg.kyma.invalid', 'other.kyma.invalid'],
        dockerUsername: ['robot', 'robot-2'],
        dockerPassword: ['', 'registry-token-2'],
      },
      { cluster: deployedCluster(), review: [{ jump: 'customRegistry' }] }
    );
    const asked = (id: string) => shown.filter((q) => q.id === id);
    expect(asked('dockerUsername').map((q) => q.default)).toEqual(['robot', undefined]);
    expect(asked('dockerPassword').map((q) => String(q.message).includes('Enter keeps it'))).toEqual([true, false]);
    expect(storedLogin()).toEqual({
      'other.kyma.invalid': expect.objectContaining({ username: 'robot-2', password: 'registry-token-2' }),
    });
  });

  it('--force offers nothing stored', async () => {
    const { byId } = await run(
      { ...FIRST_RUN, ...PRIVATE, dockerUsername: 'robot', dockerPassword: TOKEN },
      { cluster: deployedCluster(), force: true }
    );
    expect(byId('dockerUsername')!.default).toBeUndefined();
    expect(byId('dockerPassword')!.message).not.toContain('Enter keeps it');
  });

  it('a registry without a pull secret leaves no stored token behind', async () => {
    await run({ imagePullSecrets: false }, { cluster: deployedCluster() });
    expect(fs.existsSync(registrySecret())).toBe(false);
  });
});
