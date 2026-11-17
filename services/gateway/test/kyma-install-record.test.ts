/**
 * The install record and the live readers of setup-kyma.js.
 *
 * `sail-proxy upgrade kyma` runs a release's setup-kyma.js from a temp copy, with none of the
 * original clone's rendered files. Every current answer and generated secret must then come from
 * the cluster: the install record ConfigMap sail-proxy-install (non-secret answers and version),
 * the live Secrets, the Dex config Secret, the Deployments' images, the pull secret and the owned
 * istio-system policies. The OAuth2 proxy secrets above all: a new cookie secret signs everyone out.
 *
 * kubectl is faked as in kyma-rerun.test.ts; no test reaches a cluster. Secret values are compared
 * by sha256, never printed.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-var-requires */
const KymaSetup = require('../../../kyma/scripts/setup-kyma.js');
const { PromptSession, REVIEW, WRITE } = require('../../../docker/setup-flow/session');
const {
  SECRET_ANSWER_IDS,
  isSecretAnswerId,
  renderInstallRecord,
  stampInstallRecord,
  readInstallRecord,
} = require('../../../kyma/scripts/install-record.js');
const { readLiveValues, readLiveOauth2Secrets } = require('../../../kyma/scripts/live-values.js');
/* eslint-enable @typescript-eslint/no-var-requires */

// js-yaml is not installed for the tests: JSON is YAML, so JSON stands in both ways.
const JSON_YAML = {
  dump: (obj: unknown) => JSON.stringify(obj, null, 2) + '\n',
  load: (text: string) => JSON.parse(text),
};
KymaSetup.useYaml(JSON_YAML);

const NAMESPACE = 'sail-proxy-test';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const sha = (s: string) => crypto.createHash('sha256').update(String(s)).digest('hex');

class KubectlError extends Error {
  stderr: string;
  constructor(stderr: string) {
    super(`Command failed: kubectl\n${stderr}`);
    this.stderr = stderr;
  }
}

type Cluster = Record<string, () => string>;

/** kubectl `get` answered from "<kind> <name>"; anything else is the server's NotFound. */
function fakeKubectl(cluster: Cluster, calls: string[][] = []) {
  return (args: string[]) => {
    calls.push(args);
    if (args[0] !== 'get' && args[0] !== 'config') throw new Error(`not read-only: kubectl ${args.join(' ')}`);
    const key = args[0] === 'config' ? `config ${args[1]}` : `${args[1]} ${args[2]}`;
    const answer = cluster[key];
    if (answer) return answer();
    if (args[0] === 'config') return 'test-context\n';
    throw new KubectlError(`Error from server (NotFound): ${args[1]}s "${args[2]}" not found\n`);
  };
}

const secretJson = (data: Record<string, string>) => () =>
  JSON.stringify({ data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, b64(v)])) });
const configMapJson = (data: Record<string, string>) => () => JSON.stringify({ data });

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

/** The stringData of a rendered Secret (single-line values). */
function stringData(file: string): Record<string, string> {
  const text = fs.readFileSync(file, 'utf8');
  const out: Record<string, string> = {};
  for (const m of text.slice(text.indexOf('stringData:')).matchAll(/^ {2}([A-Za-z_.-]+): (.*)$/gm)) {
    if (m[2] === '|') continue;
    out[m[1]] = m[2].startsWith('"') ? JSON.parse(m[2]) : m[2];
  }
  return out;
}

let outputRoot: string;
let projectRoot: string;
let printed: string[];
let savedServiceKey: string | undefined;
/** Extra KymaSetup options of the test in progress (the --external-database flag). */
let setupOptions: Record<string, unknown> = {};

const writeJson = (rel: string, value: unknown) => {
  const file = path.join(projectRoot, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};

beforeEach(() => {
  setupOptions = {};
  savedServiceKey = process.env.SAP_AI_CORE_SERVICE_KEY;
  delete process.env.SAP_AI_CORE_SERVICE_KEY;
  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-record-out-'));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-record-project-'));
  // The Dex connector templates generateDexConfig adapts (JSON, read by the stand-in above).
  writeJson('docker/configs/providers/github/dex.config.yaml', {
    connectors: [
      {
        type: 'github',
        id: 'github-org',
        config: {
          clientID: 'GITHUB_CLIENT_ID',
          clientSecret: 'GITHUB_CLIENT_SECRET',
          redirectURI: 'BASE_URL/dex/callback',
          orgs: [{ name: 'GITHUB_ORG', teams: ['GITHUB_ADMIN_TEAM', 'GITHUB_USER_TEAM'] }],
        },
      },
    ],
  });
  writeJson('docker/configs/providers/ldap/dex.config.external.yaml', {
    connectors: [
      {
        type: 'ldap',
        id: 'ldap-directory',
        config: {
          host: 'LDAP_HOST',
          insecureNoSSL: 'LDAP_INSECURE_NO_SSL',
          bindDN: 'LDAP_BIND_DN',
          bindPW: 'LDAP_BIND_PASSWORD',
          userSearch: {
            baseDN: 'LDAP_USER_BASE_DN',
            filter: 'LDAP_USER_FILTER',
            username: 'LDAP_USERNAME_ATTR',
            idAttr: 'LDAP_ID_ATTR',
            emailAttr: 'LDAP_EMAIL_ATTR',
            nameAttr: 'LDAP_NAME_ATTR',
            preferredUsernameAttr: 'LDAP_PREFERRED_USERNAME_ATTR',
          },
          groupSearch: {
            baseDN: 'LDAP_GROUP_BASE_DN',
            filter: 'LDAP_GROUP_FILTER',
            nameAttr: 'LDAP_GROUP_NAME_ATTR',
            userMatchers: [{ userAttr: 'DN', groupAttr: 'LDAP_GROUP_MEMBER_ATTR' }],
          },
        },
      },
    ],
  });
  writeJson('docker/configs/providers/okta/dex.config.yaml', {
    connectors: [
      {
        type: 'saml',
        id: 'okta-saml',
        config: { ssoURL: 'OKTA_SSO_URL', ca: '/etc/dex/certs/saml-ca.pem', redirectURI: 'BASE_URL/dex/callback' },
      },
    ],
  });
  writeJson('docker/configs/providers/ias/dex.config.yaml', {
    connectors: [
      {
        type: 'oidc',
        id: 'sap-ias',
        name: 'SAP Cloud Identity Services',
        config: {
          issuer: 'IAS_ISSUER_URL',
          clientID: 'IAS_CLIENT_ID',
          clientSecret: 'IAS_CLIENT_SECRET',
          redirectURI: 'BASE_URL/dex/callback',
          scopes: ['email', 'profile', 'groups'],
          insecureEnableGroups: true,
          userNameKey: 'email',
        },
      },
    ],
  });
  printed = [];
  const capture = (...a: unknown[]) => {
    printed.push(a.map(String).join(' '));
  };
  jest.spyOn(console, 'log').mockImplementation(capture);
  jest.spyOn(console, 'warn').mockImplementation(capture);
  jest.spyOn(console, 'error').mockImplementation(capture);
  jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
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

/** What pressing Enter answers for a question. */
function enter(question: any): any {
  if (question.type === 'list') return question.default !== undefined ? question.default : question.choices[0].value;
  if (question.type === 'confirm') return question.default !== false;
  if (question.type === 'password') return '';
  return question.default !== undefined ? question.default : '';
}

interface Shown {
  id: string;
  type: string;
  secret?: boolean;
  default: any;
}

const fakeDigest = (seed: string) => `sha256:${sha(seed)}`;

function newSetup(cluster: Cluster, calls: string[][] = []) {
  const setup = new KymaSetup({ outputRoot, namespace: NAMESPACE, ...setupOptions });
  setup.projectRoot = projectRoot;
  setup._k8sApiClusterIp = '10.0.0.1';
  setup.runDockerSetup = async (config: Record<string, unknown>) => setup.postProcessEnvFiles(config);
  setup.fetchImageTags = async () => ['1.2.3', '1.2.2'];
  setup.runKubectl = fakeKubectl(cluster, calls);
  return setup;
}

/** One interactive run for NAMESPACE: answers[id] where given, Enter elsewhere, then Write. */
async function run(answers: Record<string, any>, cluster: Cluster = {}, digest?: (image: string, tag: string) => string | null) {
  const shown: Shown[] = [];
  const queue: Record<string, any[]> = {};
  for (const [id, value] of Object.entries({ autoDeploy: false, ...answers })) {
    queue[id] = Array.isArray(value) ? [...value] : [value];
  }
  const promptFn = async (question: any) => {
    shown.push({ id: question.id, type: question.type, secret: question.secret, default: question.default });
    if (question.id === REVIEW) return WRITE;
    let value = queue[question.id] && queue[question.id].length ? queue[question.id].shift() : enter(question);
    if (question.filter) value = await question.filter(value);
    const valid = question.validate ? await question.validate(value) : true;
    if (valid !== true) throw new Error(`answer for ${question.id} rejected: ${valid}`);
    return value;
  };
  const setup = newSetup(cluster);
  setup.fetchImageDigest = async (_c: unknown, image: string, tag: string) => (digest ? digest(image, tag) : null);
  setup.createSession = () => new PromptSession({ promptFn });
  await setup.run();
  const failed = printed.find((line) => line.includes('Setup failed'));
  if (failed) throw new Error(failed);
  return { shown, setup };
}

const outputDir = () => path.join(outputRoot, 'deployments', NAMESPACE);
const secretsDir = () => path.join(outputDir(), 'templates/secrets');
const coreDir = () => path.join(outputDir(), 'manifests/core');
const recordFile = () => path.join(coreDir(), 'install-record.yaml');

const GITHUB_CLIENT_SECRET = 'gh-client-secret-record-1';
const SAP_CLIENT_SECRET = 'sap-client-secret-record-1';
const LDAP_BIND_PASSWORD = 'ldap-bind-password-record-1';
const REGISTRY_TOKEN = 'registry-token-record-1';

const BASE_RUN: Record<string, any> = {
  confirmNewNamespace: true,
  deploymentType: 'public',
  domain: 'record-test-host',
  clusterSubdomain: 'c-example1',
  ipAllowlist: '198.51.100.0/24,203.0.113.12/32',
  allowIstioSystemChanges: true,
  sccTunnel: true,
  registry: 'docker.io',
  organization: 'example-images',
  imagePullSecrets: false,
  version: '1.2.2',
  POSTGRES_USER: 'record_user',
  POSTGRES_PASSWORD: '',
  configMethod: 'manual',
  SAP_AI_CORE_URL: 'https://api.ai.example.test',
  AUTH_URL: 'https://auth.example.test/oauth/token',
  CLIENT_ID: 'sap-client-id',
  CLIENT_SECRET: SAP_CLIENT_SECRET,
  SAP_AI_REGION: 'prod.example-1',
  SAP_AI_RESOURCE_GROUP: 'team-rg',
};

const GITHUB_RUN = {
  ...BASE_RUN,
  provider: 'github',
  GITHUB_CLIENT_ID: 'gh-client-id-record',
  GITHUB_CLIENT_SECRET,
  GITHUB_ORG: 'example-org',
  GITHUB_ADMIN_TEAM: 'platform-admins',
  GITHUB_USER_TEAM: 'platform-users',
};

const LDAP_RUN = {
  ...BASE_RUN,
  provider: 'ldap',
  LDAP_ADMIN_GROUP: 'gw-admins',
  LDAP_USER_GROUP: 'gw-users',
  LDAP_HOST: 'ldap.example.com:636',
  LDAP_BIND_DN: 'cn=svc,dc=example,dc=com',
  LDAP_BIND_PASSWORD,
  LDAP_USER_BASE_DN: 'ou=people,dc=example,dc=com',
  LDAP_GROUP_BASE_DN: 'ou=groups,dc=example,dc=com',
};

const OKTA_RUN = {
  ...BASE_RUN,
  provider: 'okta',
  OKTA_METADATA_URL: 'https://idp.example.com/app/example/sso/saml/metadata',
  OKTA_SSO_URL: 'https://idp.example.com/app/example/sso/saml',
  OKTA_SAML_CA_DATA: 'manual',
  manualCert: '-----BEGIN CERTIFICATE-----\nMIIBexample\n-----END CERTIFICATE-----',
  OKTA_ADMIN_GROUP: 'okta-admins',
  OKTA_USER_GROUP: 'okta-users',
};

const IAS_CLIENT_SECRET = 'ias-client-secret-record-1';
const IAS_RUN = {
  ...BASE_RUN,
  provider: 'ias',
  IAS_ISSUER_URL: 'https://example-tenant.accounts.ondemand.com',
  IAS_CLIENT_ID: '11111111-2222-3333-4444-555555555555',
  IAS_CLIENT_SECRET,
  IAS_ADMIN_GROUP: 'ias-admins',
  IAS_USER_GROUP: 'ias-users',
};

/** The data of a rendered install record (every value a JSON string). */
function recordData(text: string): Record<string, string> {
  const data: Record<string, string> = {};
  for (const m of text.slice(text.indexOf('\ndata:\n')).matchAll(/^ {2}(\w+): (.*)$/gm)) data[m[1]] = JSON.parse(m[2]);
  return data;
}

/** The live namespace as deploy-kyma.js leaves it, built from the render in outputDir(). */
function liveFromRender(setup: any, { withRecord = true } = {}): Cluster {
  const cluster: Cluster = { [`namespace ${NAMESPACE}`]: () => `namespace/${NAMESPACE}\n` };
  for (const file of listFiles(secretsDir())) {
    const name = path.basename(file, '.yaml');
    if (name === 'dex-config') {
      const dex = setup.readRenderedYaml(file, 'config.yaml');
      cluster['secret dex-config'] = secretJson({ 'config.yaml': JSON.stringify(dex) });
    } else if (name === 'registry-secret') {
      const encoded = /\.dockerconfigjson: (\S+)/.exec(fs.readFileSync(file, 'utf8'))![1];
      cluster['secret registry-secret'] = () => JSON.stringify({ data: { '.dockerconfigjson': encoded } });
    } else {
      cluster[`secret ${name}`] = secretJson(stringData(file));
    }
  }
  for (const name of ['admin', 'gateway', 'nginx']) {
    const image = new RegExp(`image: (\\S*sail-proxy-${name}[:@]\\S+)`).exec(fs.readFileSync(path.join(coreDir(), `${name}.yaml`), 'utf8'))![1];
    cluster[`deployment ${name}`] = () =>
      JSON.stringify({ spec: { template: { spec: { containers: [{ name, image }] } } } });
  }
  const istioDir = path.join(outputDir(), 'manifests/istio-system');
  for (const file of listFiles(istioDir)) {
    for (const doc of fs.readFileSync(file, 'utf8').split('---\n').filter((d) => d.trim())) {
      const obj = JSON.parse(doc);
      cluster[`authorizationpolicy ${obj.metadata.name}`] = () => JSON.stringify(obj);
    }
  }
  if (withRecord && fs.existsSync(recordFile())) {
    cluster['configmap sail-proxy-install'] = configMapJson(recordData(fs.readFileSync(recordFile(), 'utf8')));
  }
  return cluster;
}

/** The cluster read setup-kyma.js made before this change: the namespace and its env Secrets. */
function envSecretsOnly(cluster: Cluster): Cluster {
  const keep = ['namespace', 'secret admin-env', 'secret gateway-env', 'secret postgres-env', 'secret gateway-migration-env'];
  return Object.fromEntries(Object.entries(cluster).filter(([k]) => keep.some((p) => k.startsWith(p))));
}

const removeRender = () => fs.rmSync(outputDir(), { recursive: true, force: true });

describe('setup-kyma.js reads a namespace without rendered files from the cluster', () => {
  it.each([
    ['GitHub', GITHUB_RUN, []],
    ['LDAP', LDAP_RUN, []],
    ['Okta', OKTA_RUN, ['OKTA_METADATA_URL', 'OKTA_SAML_CA_DATA']],
    ['SAP Cloud Identity Services', IAS_RUN, []],
  ])('a %s install: live-only current equals the rendered-files current', async (_label, answers, absent) => {
    const { setup: first } = await run(answers);
    const live = liveFromRender(first, { withRecord: false });
    const fromFiles = await newSetup(envSecretsOnly(live)).loadCurrentValues(NAMESPACE);
    expect(Object.keys(fromFiles).length).toBeGreaterThan(15);

    removeRender();
    const fromCluster = await newSetup(live).loadCurrentValues(NAMESPACE);
    for (const id of absent as string[]) expect(fromFiles[id]).toBeUndefined();
    expect(fromCluster).toEqual(fromFiles);
  });

  it('SAP Cloud Identity Services: the Dex connector is OIDC against the tenant, groups map to roles, and a re-run finds every answer', async () => {
    const { setup: first, shown } = await run(IAS_RUN);
    expect(shown.find((q) => q.id === 'IAS_CLIENT_SECRET')).toMatchObject({ type: 'password' });
    const dex = first.readRenderedYaml(path.join(secretsDir(), 'dex-config.yaml'), 'config.yaml');
    expect(dex.connectors).toHaveLength(1);
    expect(dex.connectors[0]).toMatchObject({
      type: 'oidc',
      config: {
        issuer: IAS_RUN.IAS_ISSUER_URL,
        clientID: IAS_RUN.IAS_CLIENT_ID,
        clientSecret: IAS_CLIENT_SECRET,
        redirectURI: 'https://record-test-host.c-example1.kyma.ondemand.com/dex/callback',
        scopes: ['email', 'profile', 'groups'],
        insecureEnableGroups: true,
        userNameKey: 'email',
      },
    });
    expect(dex.enablePasswordDB).toBe(false);
    const admin = stringData(path.join(secretsDir(), 'admin-env.yaml'));
    expect(admin.IDENTITY_PROVIDER).toBe('ias');
    expect(JSON.parse(admin.ROLE_MAPPING)).toEqual({ 'ias-admins': 'admin', 'ias-users': 'user' });
    // The client secret is in the Dex Secret only: not in the record, not printed.
    expect(fs.readFileSync(recordFile(), 'utf8')).not.toContain(IAS_CLIENT_SECRET);
    expect(printed.join('\n')).not.toContain(IAS_CLIENT_SECRET);

    const live = liveFromRender(first, { withRecord: false });
    removeRender();
    const current = await newSetup(live).loadCurrentValues(NAMESPACE);
    expect(current).toMatchObject({
      provider: 'ias',
      IAS_ISSUER_URL: IAS_RUN.IAS_ISSUER_URL,
      IAS_CLIENT_ID: IAS_RUN.IAS_CLIENT_ID,
      IAS_CLIENT_SECRET,
      IAS_ADMIN_GROUP: 'ias-admins',
      IAS_USER_GROUP: 'ias-users',
    });
  });

  it('SAP Cloud Identity Services: a client secret holding "$" reaches Dex as it was entered', async () => {
    // "$&", "$$", "$1", "$`" and "$'" are replacement patterns of String.replace: passed as the
    // replacement text they changed the secret, and every sign-in failed with invalid_client.
    const secret = "pa$&ss$$wo$1rd$`x$'y";
    const { setup } = await run({ ...IAS_RUN, IAS_CLIENT_SECRET: secret });
    const dex = setup.readRenderedYaml(path.join(secretsDir(), 'dex-config.yaml'), 'config.yaml');
    expect(dex.connectors[0].config.clientSecret).toBe(secret);
    // The same helper fills in the GitHub client secret and the LDAP bind password.
    expect(setup.replaceInObject({ bindPW: 'LDAP_BIND_PASSWORD' }, { LDAP_BIND_PASSWORD: secret })).toEqual({ bindPW: secret });
  });

  it.each([
    ['https://tenant.example.com/', 'trailing slash'],
    ['http://tenant.example.com', 'not https'],
    ['https://tenant.example.com/.well-known/openid-configuration', 'the discovery document instead of the issuer'],
    ['tenant.example.com', 'no scheme'],
  ])('SAP Cloud Identity Services: the issuer %s is refused (%s)', async (issuer) => {
    await expect(run({ ...IAS_RUN, IAS_ISSUER_URL: issuer })).rejects.toThrow(/IAS_ISSUER_URL rejected/);
  });

  it.each([
    ['GitHub', GITHUB_RUN],
    ['LDAP', LDAP_RUN],
  ])('a %s install of 0.11.0 (Dex config in the ConfigMap dex-config, no Secret, no record) keeps its sign-in settings', async (_label, answers) => {
    // 2026-11-08: the 0.12.0 upgrade of production read only the Secret dex-config, which 0.11.0
    // never created, and asked for the GitHub OAuth client again.
    const { setup: first } = await run(answers);
    const live = liveFromRender(first, { withRecord: false });
    const fromFiles = await newSetup(envSecretsOnly(live)).loadCurrentValues(NAMESPACE);
    const dexYaml = Buffer.from(JSON.parse(String(live['secret dex-config']())).data['config.yaml'], 'base64').toString('utf8');
    delete live['secret dex-config'];
    live['configmap dex-config'] = configMapJson({ 'config.yaml': dexYaml });
    removeRender();
    const fromCluster = await newSetup(live).loadCurrentValues(NAMESPACE);
    expect(fromCluster).toEqual(fromFiles);
  });

  it('a digest-pinned gateway image yields imageDigest', async () => {
    const digest = (image: string, tag: string) => fakeDigest(`${image}:${tag}`);
    const { setup: first } = await run(GITHUB_RUN, {}, digest);
    const live = liveFromRender(first, { withRecord: false });
    removeRender();
    const current = await newSetup(live).loadCurrentValues(NAMESPACE);
    expect(current.imageDigest).toBe(`sail-proxy-admin@${digest('sail-proxy-admin', '1.2.2')}`);
    expect(current.imageTag).toBeUndefined();
  });

  it('with the record, a digest-pinned install is known by its version tag', async () => {
    const digest = (image: string, tag: string) => fakeDigest(`${image}:${tag}`);
    const { setup: first } = await run(GITHUB_RUN, {}, digest);
    const live = liveFromRender(first);
    removeRender();
    const current = await newSetup(live).loadCurrentValues(NAMESPACE);
    expect(current.imageTag).toBe('1.2.2');
  });

  it('a private-registry install yields imagePullSecrets and offers the live login', async () => {
    const PRIVATE = { registry: 'custom', customRegistry: 'reg.example.com', imagePullSecrets: true, dockerUsername: 'robot', dockerPassword: REGISTRY_TOKEN };
    const { setup: first } = await run({ ...GITHUB_RUN, ...PRIVATE });
    const live = liveFromRender(first, { withRecord: false });
    removeRender();
    const current = await newSetup(live).loadCurrentValues(NAMESPACE);
    expect(current).toMatchObject({ imagePullSecrets: true, registry: 'custom', customRegistry: 'reg.example.com' });

    // A re-run from the cluster alone: Enter keeps the stored login, the pull secret is re-rendered.
    const { shown } = await run({}, live);
    const asked = (id: string) => shown.find((q) => q.id === id)!;
    expect(asked('dockerUsername').default).toBe('robot');
    expect(asked('dockerPassword').default).toBeUndefined();
    const encoded = /\.dockerconfigjson: (\S+)/.exec(fs.readFileSync(path.join(secretsDir(), 'registry-secret.yaml'), 'utf8'))![1];
    const auths = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')).auths;
    expect(sha(auths['reg.example.com'].password)).toBe(sha(REGISTRY_TOKEN));
    expect(printed.join('\n')).not.toContain(REGISTRY_TOKEN);
  });

  it('keeps the live OAuth2 proxy secrets: oauth2-proxy-secrets is re-rendered unchanged', async () => {
    const { setup: first } = await run(GITHUB_RUN);
    const before = stringData(path.join(secretsDir(), 'oauth2-proxy-secrets.yaml'));
    const live = liveFromRender(first);
    removeRender();

    expect(await readLiveOauth2Secrets(fakeKubectl(live), NAMESPACE)).toEqual({
      clientSecret: before['client-secret'],
      cookieSecret: before['cookie-secret'],
    });

    const { shown } = await run({}, live);
    const after = stringData(path.join(secretsDir(), 'oauth2-proxy-secrets.yaml'));
    expect(sha(after['cookie-secret'])).toBe(sha(before['cookie-secret']));
    expect(sha(after['client-secret'])).toBe(sha(before['client-secret']));
    // The Dex client secret Dex checks oauth2-proxy against is the same one.
    expect(fs.readFileSync(path.join(secretsDir(), 'dex-config.yaml'), 'utf8')).toContain(before['client-secret']);
    // Offered as kept keys, never shown.
    const surfaces = JSON.stringify(shown) + printed.join('\n');
    for (const value of [before['cookie-secret'], before['client-secret'], GITHUB_CLIENT_SECRET, SAP_CLIENT_SECRET]) {
      expect({ leaked: surfaces.includes(value) }).toEqual({ leaked: false });
    }
  });

  it('the absent OAuth2 proxy Secret leaves the secrets to be generated', async () => {
    expect(await readLiveOauth2Secrets(fakeKubectl({}), NAMESPACE)).toBeNull();
  });

  it("a record's answers win over stale rendered files", async () => {
    const { setup: first } = await run(GITHUB_RUN);
    const live = liveFromRender(first);
    const record = JSON.parse(JSON.parse(live['configmap sail-proxy-install']()).data.answers);
    record.GITHUB_ORG = 'recorded-org';
    record.SAP_AI_RESOURCE_GROUP = 'recorded-rg';
    record.imageTag = '1.2.3';
    live['configmap sail-proxy-install'] = configMapJson({ version: '1.2.3', answers: JSON.stringify(record), recordedBy: 'upgrade' });

    const current = await newSetup(live).loadCurrentValues(NAMESPACE);
    expect(current).toMatchObject({ GITHUB_ORG: 'recorded-org', SAP_AI_RESOURCE_GROUP: 'recorded-rg', imageTag: '1.2.3' });
  });

  it('an Okta install keeps its metadata URL through the record', async () => {
    const { setup: first } = await run(OKTA_RUN);
    const live = liveFromRender(first);
    removeRender();
    const current = await newSetup(live).loadCurrentValues(NAMESPACE);
    expect(current.OKTA_METADATA_URL).toBe(OKTA_RUN.OKTA_METADATA_URL);
    expect(current.OKTA_SAML_CA_DATA).toBeUndefined();
  });

  it('namespace prefix sail-proxy-test- finds sail-proxy-test-allowlist-<domain>', async () => {
    const calls: string[][] = [];
    const policy = { spec: { rules: [{ when: [{ key: 'source.ip', values: ['192.0.2.0/24'] }] }] } };
    const cluster: Cluster = {
      'secret admin-env': secretJson({ BASE_URL: 'https://record-test-host.c-example1.kyma.ondemand.com' }),
      'authorizationpolicy sail-proxy-test-allowlist-record-test-host': () => JSON.stringify(policy),
    };
    const values = await readLiveValues(fakeKubectl(cluster, calls), NAMESPACE, { yaml: JSON_YAML });
    expect(values).toEqual({ ipAllowlist: '192.0.2.0/24', allowIstioSystemChanges: true, sccTunnel: false });
    expect(calls).toContainEqual(['get', 'authorizationpolicy', 'sail-proxy-test-allowlist-record-test-host', '-n', 'istio-system', '-o', 'json']);
    for (const args of calls) expect(args[0]).toBe('get');
  });

  it('kubectl\'s real NotFound text for a missing istio policy or Deployment counts as absent, not as a failed read', async () => {
    // kubectl names CRDs and grouped kinds by plural.group ("authorizationpolicies.security.istio.io",
    // "deployments.apps"); the check expected "authorizationpolicys", so a 0.11.0 namespace (no render, no
    // record) without an SCC tunnel policy stopped the upgrade with "Cannot read authorizationpolicy".
    const realText: Record<string, string> = { authorizationpolicy: 'authorizationpolicies.security.istio.io', deployment: 'deployments.apps' };
    const policy = { spec: { rules: [{ when: [{ key: 'source.ip', values: ['192.0.2.0/24'] }] }] } };
    const cluster: Cluster = {
      'secret admin-env': secretJson({ BASE_URL: 'https://record-test-host.c-example1.kyma.ondemand.com' }),
      'authorizationpolicy sail-proxy-test-allowlist-record-test-host': () => JSON.stringify(policy),
    };
    const kubectl = (args: string[]) => {
      const answer = cluster[`${args[1]} ${args[2]}`];
      if (answer) return answer();
      const resource = realText[args[1]] || `${args[1]}s`;
      throw new KubectlError(`Error from server (NotFound): ${resource} "${args[2]}" not found\n`);
    };
    const values = await readLiveValues(kubectl, NAMESPACE, { yaml: JSON_YAML });
    expect(values).toEqual({ ipAllowlist: '192.0.2.0/24', allowIstioSystemChanges: true, sccTunnel: false });
  });

  it('a live allowlist entry the record and the render lack (added by hand) is offered, and named', async () => {
    // 2026-10-29: a 9th IP added to the live policy by hand was not in the render, so the re-run's
    // default had 8 and the deploy's delete-and-reapply removed the 9th without a word.
    const { setup: first } = await run(GITHUB_RUN);
    const POLICY = `authorizationpolicy ${NAMESPACE}-allowlist-record-test-host`;
    const extra = '203.0.113.9/32';
    const liveList = [...BASE_RUN.ipAllowlist.split(','), extra];
    const live = {
      ...liveFromRender(first),
      [POLICY]: () => JSON.stringify({ spec: { rules: [{ when: [{ key: 'source.ip', values: liveList }] }] } }),
    };
    printed = [];
    const current = await newSetup(live).loadCurrentValues(NAMESPACE);
    expect(current.ipAllowlist).toBe(liveList.join(','));
    const notes = printed.filter((line) => line.includes('IP allowlist'));
    expect(notes.join('\n')).toContain(extra);
  });

  it('a pull secret added to the namespace after the install (the record says none) is used, and named', async () => {
    // 2026-11-17: an install from public images got a registry-secret by hand before an upgrade to a
    // private registry. The record's imagePullSecrets: false won, the upgrade looked the images up
    // without a login and the registry answered 401.
    const { setup: first } = await run(GITHUB_RUN);
    const dockerconfig = Buffer.from(JSON.stringify({ auths: { 'ghcr.io': { username: 'robot', password: REGISTRY_TOKEN } } })).toString('base64');
    const live = {
      ...liveFromRender(first),
      'secret registry-secret': () => JSON.stringify({ data: { '.dockerconfigjson': dockerconfig } }),
    };
    expect((await newSetup(liveFromRender(first)).loadCurrentValues(NAMESPACE)).imagePullSecrets).toBe(false);
    printed = [];
    const current = await newSetup(live).loadCurrentValues(NAMESPACE);
    expect(current.imagePullSecrets).toBe(true);
    expect(printed.filter((line) => line.includes('registry-secret'))).toHaveLength(1);
    expect(printed.join('\n')).not.toContain(REGISTRY_TOKEN);
  });

  describe('a live read that fails (Forbidden on istio-system)', () => {
    const POLICY = `authorizationpolicy ${NAMESPACE}-allowlist-record-test-host`;
    const forbidden = () => {
      throw new KubectlError(
        `Error from server (Forbidden): authorizationpolicies.security.istio.io "${NAMESPACE}-allowlist-record-test-host" is forbidden: User "someone@example.com" cannot get resource "authorizationpolicies" in API group "security.istio.io" in the namespace "istio-system"\n`
      );
    };

    it('with rendered files: the re-run succeeds with one warning and the rendered allowlist', async () => {
      const { setup: first } = await run(GITHUB_RUN);
      const policyFile = path.join(outputDir(), 'manifests/istio-system/authorization-policy.yaml');
      const policyBefore = fs.readFileSync(policyFile, 'utf8');
      const live = { ...liveFromRender(first, { withRecord: false }), [POLICY]: forbidden };
      printed = [];

      const current = await newSetup(live).loadCurrentValues(NAMESPACE);
      expect(current).toMatchObject({ ipAllowlist: BASE_RUN.ipAllowlist, allowIstioSystemChanges: true, sccTunnel: true });
      const warnings = printed.filter((line) => line.includes('Not read from the cluster'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`Cannot read authorizationpolicy ${NAMESPACE}-allowlist-record-test-host in namespace istio-system`);

      // The whole re-run writes the same allowlist policy.
      await run({}, live);
      expect(fs.readFileSync(policyFile, 'utf8')).toBe(policyBefore);
      expect(printed.join('\n')).not.toContain(GITHUB_CLIENT_SECRET);
    });

    it('with the record but no rendered files: the record answers, with a warning', async () => {
      const { setup: first } = await run(GITHUB_RUN);
      const live = { ...liveFromRender(first), [POLICY]: forbidden };
      removeRender();
      const current = await newSetup(live).loadCurrentValues(NAMESPACE);
      expect(current).toMatchObject({ ipAllowlist: BASE_RUN.ipAllowlist, allowIstioSystemChanges: true });
      expect(printed.some((line) => line.includes('Not read from the cluster'))).toBe(true);
    });

    it('without rendered files and record: setup refuses rather than drop the allowlist', async () => {
      const { setup: first } = await run(GITHUB_RUN);
      const live = { ...liveFromRender(first, { withRecord: false }), [POLICY]: forbidden };
      removeRender();
      await expect(newSetup(live).loadCurrentValues(NAMESPACE)).rejects.toThrow(
        new RegExp(`Cannot read authorizationpolicy ${NAMESPACE}-allowlist-record-test-host in namespace istio-system .*Forbidden.*Without rendered files, setup needs it`)
      );
    });

    it('a Dex config Secret read failure is not covered by the record (it holds the client secret)', async () => {
      const { setup: first } = await run(GITHUB_RUN);
      const live = { ...liveFromRender(first), 'secret dex-config': forbidden };
      removeRender();
      await expect(newSetup(live).loadCurrentValues(NAMESPACE)).rejects.toThrow(/Cannot read secret dex-config/);
    });
  });

  it('a namespace that does not exist is not read beyond the namespace check', async () => {
    const calls: string[][] = [];
    const setup = newSetup({}, calls);
    await setup.loadCurrentValues(NAMESPACE);
    expect(calls.filter((a) => a[0] === 'get').map((a) => a[1])).toEqual(['namespace']);
  });
});

describe('the install record', () => {
  it('setup renders manifests/core/install-record.yaml with the version and non-secret answers', async () => {
    await run(GITHUB_RUN);
    const text = fs.readFileSync(recordFile(), 'utf8');
    expect(text).toMatch(/^kind: ConfigMap$/m);
    expect(text).toMatch(/^ {2}name: sail-proxy-install$/m);
    expect(text).toMatch(/^ {4}app\.kubernetes\.io\/part-of: sail-proxy$/m);
    expect(text).toMatch(/^ {2}version: "1\.2\.2"$/m);
    expect(text).toMatch(/^ {2}recordedBy: "setup"$/m);
    expect(text).not.toMatch(/recordedAt/);
    const answers = JSON.parse(JSON.parse(/^ {2}answers: (.*)$/m.exec(text)![1]));
    expect(answers).toMatchObject({ provider: 'github', GITHUB_ORG: 'example-org', domain: 'record-test-host', imageTag: '1.2.2', POSTGRES_USER: 'record_user', imagePullSecrets: false });
    for (const id of SECRET_ANSWER_IDS) expect(answers[id]).toBeUndefined();
    for (const value of [GITHUB_CLIENT_SECRET, SAP_CLIENT_SECRET]) expect(text).not.toContain(value);
    const oauth = stringData(path.join(secretsDir(), 'oauth2-proxy-secrets.yaml'));
    expect(text).not.toContain(oauth['cookie-secret']);
    expect(text).not.toContain(oauth['client-secret']);
  });

  it('isSecretAnswerId also drops a secret-looking id the list misses, but keeps imagePullSecrets', () => {
    expect(['NEW_CLIENT_SECRET', 'SOME_PASSWORD', 'apiToken', 'imagePullSecrets', 'GITHUB_CLIENT_ID'].filter(isSecretAnswerId)).toEqual([
      'NEW_CLIENT_SECRET',
      'SOME_PASSWORD',
      'apiToken',
    ]);
  });

  it('renderInstallRecord never contains the value of a secret question', () => {
    const answers: Record<string, string> = { provider: 'github', domain: 'record-test-host' };
    for (const id of SECRET_ANSWER_IDS) answers[id] = `value-of-${id}-${sha(id).slice(0, 12)}`;
    const text = renderInstallRecord({ namespace: NAMESPACE, version: '1.2.3', answers, recordedBy: 'setup' });
    for (const id of SECRET_ANSWER_IDS) {
      expect({ id, leaked: text.includes(answers[id]) }).toEqual({ id, leaked: false });
    }
    expect(text).toContain('record-test-host');
  });

  it('SECRET_ANSWER_IDS covers every secret question of the real definitions', async () => {
    // The provider prompts marked secret.
    const promptIds = Object.values(KymaSetup.PROVIDER_PROMPTS as Record<string, any[]>)
      .flat()
      .filter((p) => p.secret)
      .map((p) => p.key);
    // Every password question setup-kyma.js and its shared flow define.
    const sources = [
      path.join(__dirname, '../../../kyma/scripts/setup-kyma.js'),
      ...listFiles(path.join(__dirname, '../../../docker/setup-flow')).filter((f) => f.endsWith('.js')),
    ];
    const definedIds = sources.flatMap((file) =>
      [...fs.readFileSync(file, 'utf8').matchAll(/type: 'password',\s*name: '([^']+)'/g)].map((m) => m[1])
    );
    // Every secret question asked in real runs (GitHub, LDAP, private registry, typed DB password).
    const askedIds: string[] = [];
    for (const answers of [
      GITHUB_RUN,
      LDAP_RUN,
      { ...OKTA_RUN, registry: 'custom', customRegistry: 'reg.example.com', imagePullSecrets: true, dockerUsername: 'robot', dockerPassword: REGISTRY_TOKEN, POSTGRES_PASSWORD: 'typed-db-password-1', POSTGRES_PASSWORD_CONFIRM: 'typed-db-password-1' },
    ]) {
      removeRender();
      const { shown } = await run(answers);
      askedIds.push(...shown.filter((q) => q.type === 'password' || q.secret).map((q) => q.id));
    }
    const all = [...new Set([...promptIds, ...definedIds, ...askedIds])];
    expect(promptIds).toEqual(expect.arrayContaining(['GITHUB_CLIENT_SECRET', 'LDAP_BIND_PASSWORD']));
    expect(askedIds).toEqual(expect.arrayContaining(['CLIENT_SECRET', 'POSTGRES_PASSWORD', 'dockerPassword']));
    expect(all.filter((id) => !SECRET_ANSWER_IDS.includes(id))).toEqual([]);
  });

  it('readInstallRecord returns the record, or null when the namespace has none', async () => {
    const text = renderInstallRecord({ namespace: NAMESPACE, version: '1.2.3', answers: { provider: 'local' }, recordedBy: 'upgrade' });
    const stamped = stampInstallRecord(text, { recordedAt: '2026-01-01T00:00:00.000Z' });
    const cluster: Cluster = { 'configmap sail-proxy-install': configMapJson(recordData(stamped)) };
    expect(await readInstallRecord(fakeKubectl(cluster), NAMESPACE)).toEqual({
      version: '1.2.3',
      answers: { provider: 'local' },
      recordedAt: '2026-01-01T00:00:00.000Z',
      recordedBy: 'upgrade',
    });
    expect(await readInstallRecord(fakeKubectl({}), NAMESPACE)).toBeNull();
  });

  it('stampInstallRecord sets recordedAt and can override recordedBy', () => {
    const text = renderInstallRecord({ namespace: NAMESPACE, version: '1.2.3', answers: {}, recordedBy: 'setup' });
    const stamped = stampInstallRecord(stampInstallRecord(text, { recordedAt: 'a' }), { recordedAt: 'b', recordedBy: 'upgrade' });
    expect(stamped.match(/recordedAt/g)).toHaveLength(1);
    expect(stamped).toMatch(/^ {2}recordedAt: "b"$/m);
    expect(stamped).toMatch(/^ {2}recordedBy: "upgrade"$/m);
  });
});

// --external-database <secret>: the installation uses a PostgreSQL outside the cluster (SAP BTP
// "PostgreSQL, hyperscaler option", or any PostgreSQL the Secret describes). The Secret is a
// service binding's: hostname, port, dbname, username, password, sslrootcert. The default,
// in-cluster path is pinned byte for byte by kyma-golden.test.ts and must not move.
describe('setup-kyma.js --external-database', () => {
  const BINDING = 'pg-binding';
  const DB_PASSWORD = 'ext-db-password-record-1';
  const CA = '-----BEGIN CERTIFICATE-----\nMIIBexampleCA\n-----END CERTIFICATE-----\n';
  const bindingSecret = (over: Record<string, string | undefined> = {}) => {
    const data: Record<string, string | undefined> = {
      hostname: '203.0.113.7', port: '5432', dbname: 'ExtDbName', username: 'ext_owner', password: DB_PASSWORD, sslrootcert: CA, ...over,
    };
    return secretJson(Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) as Record<string, string>);
  };
  const external = (over: Record<string, string | undefined> = {}): Cluster => ({ [`secret ${BINDING}`]: bindingSecret(over) });
  const core = (name: string) => path.join(coreDir(), name);
  const configMapData = (name: string) => {
    const text = fs.readFileSync(path.join(outputDir(), 'templates/configmaps', `${name}.yaml`), 'utf8');
    const out: Record<string, string> = {};
    for (const m of text.matchAll(/^ {2}([A-Za-z_.]+): (.*)$/gm)) out[m[1]] = m[2].startsWith('"') ? JSON.parse(m[2]) : m[2];
    return out;
  };

  it('renders no PostgreSQL workload and points the admin service, the gateway and the migrations at the external database over TLS', async () => {
    setupOptions = { externalDatabase: BINDING };
    const { shown } = await run(GITHUB_RUN, external());
    // The database user and password come from the binding: neither is asked.
    expect(shown.map((q) => q.id)).not.toEqual(expect.arrayContaining(['POSTGRES_USER']));
    expect(shown.map((q) => q.id)).not.toEqual(expect.arrayContaining(['POSTGRES_PASSWORD']));
    expect(fs.existsSync(core('postgres.yaml'))).toBe(false);

    const gateway = stringData(path.join(secretsDir(), 'gateway-env.yaml'));
    expect(gateway.FILE_SEARCH_DATABASE_URL).toMatch(/^postgresql:\/\/file_search_app:[^@]+@203\.0\.113\.7:5432\/ExtDbName\?sslmode=no-verify$/);
    const migration = stringData(path.join(secretsDir(), 'gateway-migration-env.yaml'));
    expect(migration.FILE_SEARCH_MIGRATION_DATABASE_URL).toBe(`postgresql://ext_owner:${DB_PASSWORD}@203.0.113.7:5432/ExtDbName?sslmode=no-verify`);
    // The CA for both file-search connections: a gateway that knows the setting verifies the
    // server certificate against it (dbTls.ts); the DSN's no-verify serves an older image.
    expect(gateway.FILE_SEARCH_DATABASE_CA).toBe(CA);
    expect(migration.FILE_SEARCH_DATABASE_CA).toBe(CA);
    const admin = stringData(path.join(secretsDir(), 'admin-env.yaml'));
    expect(admin.DATABASE_URL).toBe(`postgres://ext_owner:${DB_PASSWORD}@203.0.113.7:5432/ExtDbName`);
    expect(admin['cds.requires.db.credentials.password']).toBe(DB_PASSWORD);
    expect(admin['cds.requires.db.credentials.sslrootcert']).toBe(CA);
    const adminConfig = configMapData('admin-config');
    expect(adminConfig['cds.requires.db.credentials.host']).toBe('203.0.113.7');
    expect(String(adminConfig['cds.requires.db.credentials.port'])).toBe('5432');
    expect(adminConfig['cds.requires.db.credentials.database']).toBe('ExtDbName');
    expect(adminConfig['cds.requires.db.credentials.user']).toBe('ext_owner');

    // The pods wait for the external host, not for the Service of a PostgreSQL pod that does not exist.
    for (const file of [core('admin.yaml'), path.join(outputDir(), 'manifests/upgrade/migrate-jobs.yaml')]) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text).toContain('nc -z 203.0.113.7 5432');
      expect(text).not.toContain('POSTGRES_SERVICE_HOST');
    }
    // The record names the Secret, never a credential; nothing prints the password.
    const record = recordData(fs.readFileSync(recordFile(), 'utf8'));
    expect(JSON.parse(record.answers).externalDatabase).toBe(BINDING);
    expect(fs.readFileSync(recordFile(), 'utf8')).not.toContain(DB_PASSWORD);
    expect(printed.join('\n')).not.toContain(DB_PASSWORD);
  });

  it('a new installation is asked for the database, in-cluster by default; answering External asks for the Secret', async () => {
    const { shown } = await run({ ...GITHUB_RUN, databaseMode: 'external', externalDatabaseSecret: BINDING }, external());
    const mode = shown.find((q) => q.id === 'databaseMode')!;
    expect(mode).toMatchObject({ type: 'list', default: 'in-cluster' });
    expect(shown.map((q) => q.id)).toEqual(expect.arrayContaining(['externalDatabaseSecret']));
    expect(shown.map((q) => q.id)).not.toEqual(expect.arrayContaining(['POSTGRES_USER']));
    expect(fs.existsSync(core('postgres.yaml'))).toBe(false);
    expect(stringData(path.join(secretsDir(), 'admin-env.yaml')).DATABASE_URL).toContain('@203.0.113.7:5432/ExtDbName');
  });

  it('an installed namespace is not asked: it keeps its in-cluster database', async () => {
    const { setup: first } = await run(GITHUB_RUN);
    const { shown } = await run(GITHUB_RUN, liveFromRender(first));
    expect(shown.map((q) => q.id)).not.toEqual(expect.arrayContaining(['databaseMode']));
    expect(fs.existsSync(core('postgres.yaml'))).toBe(true);
  });

  it('a re-run without the flag stays external: the record names the Secret', async () => {
    setupOptions = { externalDatabase: BINDING };
    const { setup: first } = await run(GITHUB_RUN, external());
    const live = { ...liveFromRender(first), ...external() };
    setupOptions = {};
    await run(GITHUB_RUN, live);
    expect(fs.existsSync(core('postgres.yaml'))).toBe(false);
    expect(stringData(path.join(secretsDir(), 'admin-env.yaml')).DATABASE_URL).toContain('@203.0.113.7:5432/ExtDbName');
  });

  // Where the database is, is a fact about the installation, not a default for a question: --force
  // (no defaults from the existing configuration) and --ci (no prompt session) must find it too.
  // They did not: without the flag such a re-run went on to render an in-cluster PostgreSQL for an
  // installation whose data lives outside, and with the flag it was refused as "in-cluster".
  it('a --force re-run of an external installation stays external, with the flag and without it', async () => {
    setupOptions = { externalDatabase: BINDING };
    const { setup: first } = await run(GITHUB_RUN, external());
    const live = { ...liveFromRender(first), ...external() };

    for (const flag of [{}, { externalDatabase: BINDING }]) {
      removeRender();
      printed.length = 0;
      setupOptions = { forceOverwrite: true, ...flag };
      await run(GITHUB_RUN, live);
      expect(fs.existsSync(core('postgres.yaml'))).toBe(false);
      expect(stringData(path.join(secretsDir(), 'admin-env.yaml')).DATABASE_URL).toContain('@203.0.113.7:5432/ExtDbName');
      expect(JSON.parse(recordData(fs.readFileSync(recordFile(), 'utf8')).answers).externalDatabase).toBe(BINDING);
    }
  });

  it('a --force re-run of an external installation without an install record is refused without the flag', async () => {
    setupOptions = { externalDatabase: BINDING };
    const { setup: first } = await run(GITHUB_RUN, external());
    const live = { ...liveFromRender(first, { withRecord: false }), ...external() };
    removeRender();
    printed.length = 0;
    setupOptions = { forceOverwrite: true };
    await expect(run(GITHUB_RUN, live)).rejects.toThrow(/uses an external database.*--external-database/);
    expect(listFiles(outputRoot)).toEqual([]);
  });

  // The unattended run asks its SAP AI Core question outside the scripted session, so this takes
  // its database step alone: the same call the interactive run makes.
  it('an unattended (--ci) re-run finds the external database, with the flag and without it', async () => {
    setupOptions = { externalDatabase: BINDING };
    const { setup: first } = await run(GITHUB_RUN, external());
    const live = { ...liveFromRender(first), ...external() };

    for (const flag of [{}, { externalDatabase: BINDING }]) {
      setupOptions = { ciMode: true, ...flag };
      const setup = newSetup(live);
      await setup.loadExistingKeys();
      await setup.selectDatabase(await setup.readDatabaseLocation());
      expect(setup.externalDb).toMatchObject({ secretName: BINDING, host: '203.0.113.7' });
    }

    // Without an install record and without the flag it stops, as the interactive run does.
    setupOptions = { ciMode: true };
    const unrecorded = newSetup({ ...liveFromRender(first, { withRecord: false }), ...external() });
    await unrecorded.loadExistingKeys();
    await expect(unrecorded.readDatabaseLocation().then((location: unknown) => unrecorded.selectDatabase(location)))
      .rejects.toThrow(/uses an external database.*--external-database/);
  });

  it('an external installation without an install record: a re-run without the flag is refused, with the flag it stays external', async () => {
    setupOptions = { externalDatabase: BINDING };
    const { setup: first } = await run(GITHUB_RUN, external());
    const live = { ...liveFromRender(first, { withRecord: false }), ...external() };
    removeRender();
    setupOptions = {};
    await expect(run(GITHUB_RUN, live)).rejects.toThrow(/uses an external database.*--external-database/);
    expect(listFiles(outputRoot)).toEqual([]);
    printed.length = 0; // run() reads the failure line of the run before
    setupOptions = { externalDatabase: BINDING };
    await run(GITHUB_RUN, live);
    expect(fs.existsSync(core('postgres.yaml'))).toBe(false);
  });

  describe('reconnecting an external installation to another binding (a restored instance)', () => {
    const OTHER = 'pg-binding-restored';
    const restored = () => secretJson({
      hostname: '203.0.113.99', port: '5432', dbname: 'ExtDbName', username: 'restored_owner', password: 'restored-db-password-1', sslrootcert: CA,
    });
    const marker = () => path.join(outputDir(), 'templates', 'database-reconnect.json');
    async function installed(): Promise<Cluster> {
      setupOptions = { externalDatabase: BINDING };
      const { setup: first } = await run(GITHUB_RUN, external());
      return { ...liveFromRender(first), ...external(), [`secret ${OTHER}`]: restored() };
    }

    it('is refused unless confirmed: nothing is rendered for the other database', async () => {
      const live = await installed();
      const before = fs.readFileSync(path.join(secretsDir(), 'admin-env.yaml'), 'utf8');
      setupOptions = { externalDatabase: OTHER };
      printed.length = 0;
      await expect(run(GITHUB_RUN, live)).rejects.toThrow(/pg-binding.*pg-binding-restored|reconnect/i);
      expect(fs.readFileSync(path.join(secretsDir(), 'admin-env.yaml'), 'utf8')).toBe(before);
      expect(fs.existsSync(marker())).toBe(false);
    });

    it('confirmed: the render points at the other database, the record names its Secret, and a marker tells the deploy the change is meant', async () => {
      const live = await installed();
      setupOptions = { externalDatabase: OTHER };
      printed.length = 0;
      const { shown } = await run({ ...GITHUB_RUN, confirmDatabaseReconnect: true }, live);
      expect(shown.find((q) => q.id === 'confirmDatabaseReconnect')).toMatchObject({ type: 'confirm', default: false });
      const admin = stringData(path.join(secretsDir(), 'admin-env.yaml'));
      expect(admin.DATABASE_URL).toBe('postgres://restored_owner:restored-db-password-1@203.0.113.99:5432/ExtDbName');
      expect(JSON.parse(recordData(fs.readFileSync(recordFile(), 'utf8')).answers).externalDatabase).toBe(OTHER);
      expect(JSON.parse(fs.readFileSync(marker(), 'utf8'))).toEqual({ from: BINDING, to: OTHER });
      // The file-search runtime role keeps its password: a restored instance holds the role.
      const liveDsn = Buffer.from(JSON.parse(String(live['secret gateway-env']())).data.FILE_SEARCH_DATABASE_URL, 'base64').toString();
      const before = /file_search_app:([^@]+)@/.exec(liveDsn)![1];
      expect(stringData(path.join(secretsDir(), 'gateway-env.yaml')).FILE_SEARCH_DATABASE_URL).toContain(`file_search_app:${before}@203.0.113.99:5432/ExtDbName`);
      expect(printed.join('\n')).not.toContain('restored-db-password-1');
    });

    it('a later run without a change removes the marker', async () => {
      const live = await installed();
      setupOptions = { externalDatabase: OTHER };
      printed.length = 0;
      const { setup: second } = await run({ ...GITHUB_RUN, confirmDatabaseReconnect: true }, live);
      expect(fs.existsSync(marker())).toBe(true);
      const liveAfter = { ...liveFromRender(second), ...external(), [`secret ${OTHER}`]: restored() };
      setupOptions = {};
      printed.length = 0;
      await run(GITHUB_RUN, liveAfter);
      expect(fs.existsSync(marker())).toBe(false);
      expect(stringData(path.join(secretsDir(), 'admin-env.yaml')).DATABASE_URL).toContain('@203.0.113.99:5432/');
    });
  });

  // The binding Secret the installation already uses can come to hold other values: SAP's
  // operator renews a binding's credentials, or the binding is deleted and created again under
  // the same name. That used to be a dead end: the setup refused the changed user and password
  // ("its volume keeps the user and password"), and the deploy refused changed database values
  // unless the Secret had another name.
  describe('the binding Secret in use holds other values (a renewed or re-created binding)', () => {
    const marker = () => path.join(outputDir(), 'templates', 'database-reconnect.json');
    const RENEWED_PASSWORD = 'ext-db-password-renewed-2';
    const renewed = () => external({ username: 'ext_owner_2', password: RENEWED_PASSWORD });
    async function installed(): Promise<Cluster> {
      setupOptions = { externalDatabase: BINDING };
      const { setup: first } = await run(GITHUB_RUN, external());
      setupOptions = {};
      printed.length = 0;
      return liveFromRender(first);
    }

    it('unchanged: no question and no marker', async () => {
      const live = await installed();
      const { shown } = await run(GITHUB_RUN, { ...live, ...external() });
      expect(shown.map((q) => q.id)).not.toEqual(expect.arrayContaining(['confirmDatabaseChange']));
      expect(fs.existsSync(marker())).toBe(false);
    });

    it('other credentials: asked, default no; declined, nothing is rendered for them', async () => {
      const live = await installed();
      const before = fs.readFileSync(path.join(secretsDir(), 'admin-env.yaml'), 'utf8');
      await expect(run(GITHUB_RUN, { ...live, ...renewed() })).rejects.toThrow(/pg-binding.*credentials.*not confirmed/i);
      expect(fs.readFileSync(path.join(secretsDir(), 'admin-env.yaml'), 'utf8')).toBe(before);
      expect(fs.existsSync(marker())).toBe(false);
      expect(printed.join('\n')).not.toContain(RENEWED_PASSWORD);
    });

    it('other credentials, confirmed: rendered with them, and the marker tells the deploy the change is meant', async () => {
      const live = await installed();
      const { shown } = await run({ ...GITHUB_RUN, confirmDatabaseChange: true }, { ...live, ...renewed() });
      expect(shown.find((q) => q.id === 'confirmDatabaseChange')).toMatchObject({ type: 'confirm', default: false });
      const admin = stringData(path.join(secretsDir(), 'admin-env.yaml'));
      expect(admin.DATABASE_URL).toBe(`postgres://ext_owner_2:${RENEWED_PASSWORD}@203.0.113.7:5432/ExtDbName`);
      expect(stringData(path.join(secretsDir(), 'gateway-migration-env.yaml')).FILE_SEARCH_MIGRATION_DATABASE_URL)
        .toBe(`postgresql://ext_owner_2:${RENEWED_PASSWORD}@203.0.113.7:5432/ExtDbName?sslmode=no-verify`);
      expect(JSON.parse(fs.readFileSync(marker(), 'utf8'))).toEqual({ from: BINDING, to: BINDING });
      expect(JSON.parse(recordData(fs.readFileSync(recordFile(), 'utf8')).answers).externalDatabase).toBe(BINDING);
      expect(printed.join('\n')).not.toContain(RENEWED_PASSWORD);
    });

    it('another database under the same name: the question names both addresses', async () => {
      const live = await installed();
      const moved = external({ hostname: '203.0.113.50' });
      const { shown } = await run({ ...GITHUB_RUN, confirmDatabaseChange: true }, { ...live, ...moved });
      const question = shown.find((q) => q.id === 'confirmDatabaseChange') as any;
      expect(question).toMatchObject({ type: 'confirm', default: false });
      expect(stringData(path.join(secretsDir(), 'admin-env.yaml')).DATABASE_URL).toContain('@203.0.113.50:5432/ExtDbName');
      expect(fs.existsSync(marker())).toBe(true);
    });

    it('unattended (--ci): refused, the change needs a confirmation', async () => {
      const live = await installed();
      setupOptions = { ciMode: true };
      const setup = newSetup({ ...live, ...renewed() });
      await setup.loadExistingKeys();
      await expect(setup.readDatabaseLocation().then((location: unknown) => setup.selectDatabase(location)))
        .rejects.toThrow(/pg-binding.*confirmation.*unattended/i);
    });
  });

  it.each([
    ['the Secret does not exist', undefined, /pg-binding.*not found/i],
    ['the Secret lacks the password', { password: undefined }, /pg-binding.*password/],
    ['the Secret lacks the CA certificate', { sslrootcert: undefined }, /pg-binding.*sslrootcert/],
    ['the port is no number', { port: 'abc' }, /pg-binding.*port/],
  ])('refuses before anything is written when %s', async (_name, over, message) => {
    setupOptions = { externalDatabase: BINDING };
    const cluster = over === undefined ? {} : external(over as Record<string, string | undefined>);
    await expect(run(GITHUB_RUN, cluster)).rejects.toThrow(message as RegExp);
    expect(listFiles(outputRoot)).toEqual([]);
  });

  it('refuses to move a namespace that runs its in-cluster database, and the reverse', async () => {
    const { setup: first } = await run(GITHUB_RUN);
    const liveInCluster = { ...liveFromRender(first), ...external() };
    setupOptions = { externalDatabase: BINDING };
    await expect(run(GITHUB_RUN, liveInCluster)).rejects.toThrow(/in-cluster database/);
  });

  it('without the flag nothing changes: the PostgreSQL workload and the in-cluster addresses are rendered', async () => {
    await run(GITHUB_RUN);
    expect(fs.existsSync(core('postgres.yaml'))).toBe(true);
    expect(stringData(path.join(secretsDir(), 'gateway-env.yaml')).FILE_SEARCH_DATABASE_URL).toMatch(/@postgres:5432\/sap_llm_gateway$/);
    expect(stringData(path.join(secretsDir(), 'gateway-env.yaml')).FILE_SEARCH_DATABASE_CA).toBeUndefined();
    expect(stringData(path.join(secretsDir(), 'gateway-migration-env.yaml')).FILE_SEARCH_DATABASE_CA).toBeUndefined();
    expect(fs.readFileSync(core('admin.yaml'), 'utf8')).toContain('nc -z ${POSTGRES_SERVICE_HOST} ${POSTGRES_SERVICE_PORT}');
    expect(JSON.parse(recordData(fs.readFileSync(recordFile(), 'utf8')).answers).externalDatabase).toBeUndefined();
  });
});
