/**
 * Interactive setup-kyma.js runs through the prompt session (docker/setup-flow): every question,
 * the deploy question included, is asked first, with Back and a review screen, and nothing is
 * rendered before the review's "Write configuration". The completion summary masks every secret.
 *
 * kubectl, the registry lookups and setup-docker.js are stubbed; output goes to temp dirs and no
 * test reaches a cluster.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scripted, Step } from './helpers/scriptedPrompter';

/* eslint-disable @typescript-eslint/no-var-requires */
const KymaSetup = require('../../../kyma/scripts/setup-kyma.js');
const { PromptSession, REVIEW } = require('../../../docker/setup-flow/session');
/* eslint-enable @typescript-eslint/no-var-requires */

KymaSetup.useYaml({
  dump: (obj: unknown) => JSON.stringify(obj, null, 2) + '\n',
  load: () => {
    throw new Error('yaml.load is not available in tests');
  },
});

const NAMESPACE = 'sail-proxy-test';
const LIVE = {
  VALIDATION_TOKEN_SECRET: 'live-validation-token-secret-0001',
  METADATA_ENCRYPTION_KEY: 'live-metadata-encryption-key-0002',
  AWS_SECRET_ENCRYPTION_KEY: 'live-aws-secret-encryption-key-03',
  SIEM_CREDENTIAL_KEY: 'live-siem-credential-key-00000004',
  CONNECTION_CREDENTIAL_KEY: 'live-connection-credential-key-05',
};
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

const LIVE_CLUSTER: Cluster = {
  [`namespace ${NAMESPACE}`]: () => `namespace/${NAMESPACE}\n`,
  'secret admin-env': secretJson(LIVE),
  'secret gateway-env': secretJson({
    VALIDATION_TOKEN_SECRET: LIVE.VALIDATION_TOKEN_SECRET,
    METADATA_ENCRYPTION_KEY: LIVE.METADATA_ENCRYPTION_KEY,
  }),
};

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

function stringData(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of fs.readFileSync(file, 'utf8').matchAll(/^ {2}([A-Za-z_.]+): (.*)$/gm)) {
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
  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-interactive-out-'));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-interactive-project-'));
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
  // Nothing may prompt outside the session.
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

function newSetup(cluster: Cluster, options: Record<string, unknown> = {}) {
  const setup = new KymaSetup({ outputRoot, ...options });
  setup.projectRoot = projectRoot;
  setup._k8sApiClusterIp = '10.0.0.1';
  setup.runDockerSetup = async (config: Record<string, unknown>) => setup.postProcessEnvFiles(config);
  const lookups = { tags: 0, digests: 0 };
  setup.fetchImageTags = async () => {
    lookups.tags++;
    return ['1.2.3'];
  };
  setup.fetchImageDigest = async () => {
    lookups.digests++;
    return null;
  };
  const calls = mockKubectl(setup, cluster);
  return { setup, calls, lookups };
}

function interactive(steps: Step[], cluster: Cluster = {}) {
  const script = scripted(steps);
  const made = newSetup(cluster);
  made.setup.createSession = () => new PromptSession({ promptFn: script.promptFn });
  return { ...made, script };
}

const outputDir = () => path.join(outputRoot, 'deployments', NAMESPACE);

const HEAD_NEW: Step[] = [
  ['namespace', NAMESPACE],
  ['confirmNewNamespace', true],
];
const BODY: Step[] = [
  ['deploymentType', 'internal'],
  ['provider', 'local'],
  ['LOGOUT_REDIRECT_URL', 'auto-shell'],
  ['registry', 'ghcr.io'],
  ['organization', 'st-gr'],
  ['imagePullSecrets', false],
  ['version', '1.2.3'],
  ['POSTGRES_USER', 'admin_user'],
  ['POSTGRES_PASSWORD', ''],
  ['configMethod', 'skip'],
];

const BILLING: Step[] = [['SAP_BILLING_CURRENCY', 'USD']];

describe('setup-kyma.js interactive: ask everything, review, then write', () => {
  it('nothing is written before Write configuration', async () => {
    // The scripted prompter runs out of steps on the review screen: the run aborts there.
    const { setup, calls, script } = interactive([...HEAD_NEW, ...BODY, ...BILLING, ['autoDeploy', false]]);
    await setup.run();
    expect(script.shown[script.shown.length - 1].id).toBe(REVIEW);
    expect(exits).toEqual([1]);
    expect(listFiles(outputRoot)).toEqual([]);
    expect(listFiles(projectRoot)).toEqual([]);
    for (const args of calls) expect(['get', 'config']).toContain(args[0]);
  });

  it('back from the service key to the namespace re-reads keys only once', async () => {
    const back = (ids: string[]): Step[] => ids.map((id) => [id, 'BACK'] as Step);
    const { setup, calls, lookups, script } = interactive(
      [
        ['namespace', NAMESPACE],
        ...BODY.slice(0, -1),
        ['configMethod', 'BACK'],
        ...back([
          'POSTGRES_PASSWORD',
          'POSTGRES_USER',
          'version',
          'imagePullSecrets',
          'organization',
          'registry',
          'LOGOUT_REDIRECT_URL',
          'provider',
          'deploymentType',
        ]),
        ['namespace', NAMESPACE],
        ...BODY,
        ...BILLING,
        ['key-regeneration', 'keep'],
        ['autoDeploy', false],
        [REVIEW, 'WRITE'],
      ],
      LIVE_CLUSTER
    );
    await setup.run();
    script.assertDone();
    const reads = calls.filter((args) => args[0] === 'get').map((args) => `${args[1]} ${args[2]}`);
    expect(reads.filter((r) => r === `namespace ${NAMESPACE}`)).toHaveLength(1);
    expect(reads.filter((r) => r === 'secret admin-env')).toHaveLength(1);
    expect(lookups.tags).toBe(1);
    // The carried keys are rendered unchanged.
    const admin = stringData(path.join(outputDir(), 'templates/secrets/admin-env.yaml'));
    for (const [key, value] of Object.entries(LIVE)) expect({ [key]: admin[key] }).toEqual({ [key]: value });
  });

  it('the deploy question is asked before the review', async () => {
    const { setup, script } = interactive([...HEAD_NEW, ...BODY, ...BILLING, ['autoDeploy', false], [REVIEW, 'WRITE']]);
    await setup.run();
    script.assertDone();
    const ids = script.shown.map((q) => q.id);
    expect(ids.indexOf('autoDeploy')).toBeGreaterThan(-1);
    expect(ids.indexOf('autoDeploy')).toBe(ids.indexOf(REVIEW) - 1);
    // Declined: the manifests are written and the script ends as before.
    expect(fs.existsSync(path.join(outputDir(), 'templates/secrets/admin-env.yaml'))).toBe(true);
    expect(exits).toEqual([0]);
    expect(printed.join('\n')).toContain('You can deploy later');
  });

  it('a regenerated key is replaced and the other carried keys are kept', async () => {
    const { setup, script } = interactive(
      [
        ['namespace', NAMESPACE],
        ...BODY,
        ...BILLING,
        ['key-regeneration', 'regenerate'],
        ['regenerate-key', 'SIEM_CREDENTIAL_KEY'],
        ['regenerate-confirm', true],
        ['regenerate-key', '__done__'],
        ['autoDeploy', false],
        [REVIEW, 'WRITE'],
      ],
      LIVE_CLUSTER
    );
    await setup.run();
    script.assertDone();
    const offered = script.shown.find((q) => q.name === 'regenerate-key')!.question.choices.map((c: any) => c.value);
    expect(offered).toEqual(expect.arrayContaining(Object.keys(LIVE)));
    const admin = stringData(path.join(outputDir(), 'templates/secrets/admin-env.yaml'));
    expect(admin.SIEM_CREDENTIAL_KEY).toMatch(/^[0-9a-f]{64}$/);
    for (const [key, value] of Object.entries(LIVE)) {
      if (key !== 'SIEM_CREDENTIAL_KEY') expect({ [key]: admin[key] }).toEqual({ [key]: value });
    }
  });

  it('back from the manual certificate after a failed metadata fetch fetches only once', async () => {
    const { setup, script } = interactive([
      ...HEAD_NEW,
      ['deploymentType', 'internal'],
      ['provider', 'okta'],
      ['OKTA_METADATA_URL', 'https://okta.example.test/metadata'],
      ['OKTA_SSO_URL', 'https://okta.example.test/sso'],
      ['OKTA_SAML_CA_DATA', 'auto-fetch-from-metadata'],
      ['OKTA_ADMIN_GROUP', 'admins'],
      ['OKTA_USER_GROUP', 'users'],
      ['LOGOUT_REDIRECT_URL', 'auto-shell'],
      ['manualCert', 'BACK'],
      ['LOGOUT_REDIRECT_URL', 'auto-shell'],
      ['manualCert', 'CERTDATA'],
      ...BODY.slice(3),
      ...BILLING,
      ['autoDeploy', false],
    ]);
    let fetches = 0;
    setup.fetchSamlCertificateFromMetadata = async () => {
      fetches++;
      throw new Error('metadata unreachable');
    };
    await setup.run(); // ends on the review screen (no step left)
    expect(script.shown[script.shown.length - 1].id).toBe(REVIEW);
    expect(fetches).toBe(1);
    expect(listFiles(outputRoot)).toEqual([]);
  });

  it('billing answers reach the admin env of the namespace', async () => {
    const { setup, script } = interactive([
      ...HEAD_NEW,
      ...BODY,
      ['SAP_BILLING_CURRENCY', 'eur'],
      ['billingEnterPrices', true],
      ['SAP_CU_PRICE_PRODUCTIVE', '0.35'],
      ['SAP_CU_PRICE_NON_PRODUCTIVE', '0.2'],
      ['autoDeploy', false],
      [REVIEW, 'WRITE'],
    ]);
    await setup.run();
    script.assertDone();
    const admin = stringData(path.join(outputDir(), 'templates/secrets/admin-env.yaml'));
    expect(admin.SAP_BILLING_CURRENCY).toBe('EUR');
    expect(admin.SAP_CU_PRICE_PRODUCTIVE).toBe('0.35');
    expect(admin.SAP_CU_PRICE_NON_PRODUCTIVE).toBe('0.2');
  });

  it('USD with nothing stored writes no billing keys', async () => {
    const { setup, script } = interactive([...HEAD_NEW, ...BODY, ...BILLING, ['autoDeploy', false], [REVIEW, 'WRITE']]);
    await setup.run();
    script.assertDone();
    const admin = stringData(path.join(outputDir(), 'templates/secrets/admin-env.yaml'));
    expect(Object.keys(admin).filter((k) => /^SAP_(BILLING|CU_PRICE)/.test(k))).toEqual([]);
  });

  it('a re-run offers the namespace billing values and USD drops the prices', async () => {
    const cluster: Cluster = {
      ...LIVE_CLUSTER,
      'secret admin-env': secretJson({
        ...LIVE,
        SAP_BILLING_CURRENCY: 'CHF',
        SAP_CU_PRICE_PRODUCTIVE: '0.4',
        SAP_CU_PRICE_NON_PRODUCTIVE: '0.3',
      }),
    };
    const { setup, script } = interactive(
      [
        ['namespace', NAMESPACE],
        ...BODY,
        ['SAP_BILLING_CURRENCY', 'CHF'],
        ['billingEnterPrices', true],
        ['SAP_CU_PRICE_PRODUCTIVE', '0.4'],
        ['SAP_CU_PRICE_NON_PRODUCTIVE', '0.3'],
        ['key-regeneration', 'keep'],
        ['autoDeploy', false],
        [REVIEW, { jump: 'SAP_BILLING_CURRENCY' }],
        ['SAP_BILLING_CURRENCY', 'USD'],
        ['key-regeneration', 'keep'],
        ['autoDeploy', false],
        [REVIEW, 'WRITE'],
      ],
      cluster
    );
    await setup.run();
    script.assertDone();
    const first = script.shown.filter((q) => q.id === 'SAP_BILLING_CURRENCY')[0];
    expect(first.default).toBe('CHF');
    const admin = stringData(path.join(outputDir(), 'templates/secrets/admin-env.yaml'));
    expect(admin.SAP_BILLING_CURRENCY).toBe('USD');
    expect(admin).not.toHaveProperty('SAP_CU_PRICE_PRODUCTIVE');
  });

  it('the completion summary prints no secret value', async () => {
    const { setup, script } = interactive(
      [['namespace', NAMESPACE], ...BODY, ...BILLING, ['key-regeneration', 'keep'], ['autoDeploy', false], [REVIEW, 'WRITE']],
      LIVE_CLUSTER
    );
    await setup.run();
    script.assertDone();
    const output = printed.join('\n');
    const secrets = Object.entries(setup.sharedSecrets).filter(
      ([key, value]) => typeof value === 'string' && value.length >= 8 && key !== 'FILE_SEARCH_RUNTIME_USER'
    );
    expect(secrets.map(([key]) => key)).toEqual(
      expect.arrayContaining([...Object.keys(LIVE), 'OAUTH2_PROXY_CLIENT_SECRET', 'OAUTH2_PROXY_COOKIE_SECRET', 'POSTGRES_PASSWORD'])
    );
    for (const [key, value] of secrets) expect({ [key]: output.includes(value as string) }).toEqual({ [key]: false });
    expect(output).toContain('Validation Token: ********');
    expect(output).toMatch(/Password: \*{8}/);
  });

  it('--ci asks nothing, opens no session and renders', async () => {
    fs.mkdirSync(path.join(projectRoot, 'services/gateway'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'services/gateway/.env'),
      'SAP_AI_CORE_URL=https://api.ai.example.test\nAUTH_URL=https://auth.example.test\nCLIENT_ID=ci-client\nCLIENT_SECRET=ci-client-secret\n'
    );
    const { setup } = newSetup({}, { ciMode: true, namespace: NAMESPACE });
    setup.createSession = () => {
      throw new Error('--ci must not open a prompt session');
    };
    await setup.run();
    expect(exits).toEqual([]);
    expect(fs.existsSync(path.join(outputDir(), 'templates/secrets/admin-env.yaml'))).toBe(true);
  });
});
