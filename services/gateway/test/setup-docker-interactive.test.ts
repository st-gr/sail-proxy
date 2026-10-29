/**
 * Interactive setup-docker.js runs through the prompt session (docker/setup-flow): every question
 * is asked first, with Back and a review screen, and nothing is written, deleted or pulled before
 * the review's "Write configuration". Runs against a temporary project root with every docker
 * call stubbed and a scripted prompter in place of the terminal.
 */
import * as fs from 'fs';
import * as path from 'path';
import { forbidChildProcess, makeDockerRoot, newDockerSetup, snapshotRoot, walk } from './helpers/setupDockerHarness';
import { scripted, Step } from './helpers/scriptedPrompter';

const savedArgv = process.argv;
process.argv = [savedArgv[0], 'setup-docker.js'];
// eslint-disable-next-line @typescript-eslint/no-var-requires
const DockerSetup = require('../../../docker/setup-docker.js');
process.argv = savedArgv;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PromptSession, REVIEW } = require('../../../docker/setup-flow/session');

const FIXTURES = path.join(__dirname, 'fixtures', 'setup-docker-golden');
const FAKE_VOLUMES = ['docker_postgres_data', 'docker_valkey_data'];
const SERVICE_KEY = JSON.stringify({
  serviceurls: { AI_API_URL: 'https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com' },
  url: 'https://golden.authentication.eu10.hana.ondemand.com',
  clientid: 'golden-client-id',
  clientsecret: 'golden-client-secret'
});

let root: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const key of ['SAP_AI_CORE_SERVICE_KEY', 'POSTGRES_USER', 'POSTGRES_PASSWORD']) delete process.env[key];
  root = makeDockerRoot();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as any);
  forbidChildProcess();
});

afterEach(() => {
  process.env = savedEnv;
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function interactive(steps: Step[], options: Record<string, unknown> = {}, volumes: string[] = []) {
  const script = scripted(steps);
  const { setup, calls } = newDockerSetup(DockerSetup, root, options, volumes);
  const state: { session: any } = { session: null };
  setup.createSession = (current?: Record<string, unknown>) =>
    (state.session = new PromptSession({ promptFn: script.promptFn, current }));
  return { setup, calls, script, state };
}

const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const allText = () => Object.values(snapshotRoot(root)).join('\n');
const stateChangingCalls = (calls: string[]) => calls.filter((c) => !c.startsWith('checkExistingVolumes'));

const DB: Step[] = [
  ['POSTGRES_USER', 'admin_user'],
  ['POSTGRES_PASSWORD', '']
];
const BILLING: Step[] = [['SAP_BILLING_CURRENCY', 'USD']];
const LOCAL_TAIL: Step[] = [
  ['provider', 'local'],
  ['LOGOUT_REDIRECT_URL', 'auto-shell'],
  ['useDevelopment', true],
  ['imageMode', 'local'],
  ...BILLING
];

describe('setup-docker.js interactive: ask everything, review, then write', () => {
  it('nothing is written before Write configuration', async () => {
    // The scripted prompter runs out of steps on the review screen: the run aborts there.
    const { setup, calls, script } = interactive(
      [...DB, ['configMethod', 'skip'], ...LOCAL_TAIL, ['deleteVolumes', true]],
      {},
      FAKE_VOLUMES
    );
    await expect(setup.run()).rejects.toThrow('process.exit(1)');
    expect(script.shown[script.shown.length - 1].id).toBe(REVIEW);
    expect(snapshotRoot(root)).toEqual({});
    // Listing the volumes is the read-only probe behind the deleteVolumes question.
    expect(stateChangingCalls(calls)).toEqual([]);
  });

  it('aborting during collect leaves the project root untouched', async () => {
    const { setup, calls, script } = interactive(
      [
        ...DB,
        ['configMethod', 'skip'],
        ...LOCAL_TAIL,
        ['deleteVolumes', true],
        [REVIEW, { jump: 'provider' }],
        ['provider', 'github'],
        ['GITHUB_CLIENT_ID', 'gh-id'],
        ['GITHUB_CLIENT_SECRET', 'BACK'],
        ['GITHUB_CLIENT_ID', 'BACK'],
        ['provider', 'BACK'],
        ['configMethod', 'BACK']
        // the prompter throws on the next question (POSTGRES_PASSWORD): an abort mid-collect
      ],
      {},
      FAKE_VOLUMES
    );
    await expect(setup.run()).rejects.toThrow('process.exit(1)');
    expect(script.shown[script.shown.length - 1].id).toBe('POSTGRES_PASSWORD');
    expect(snapshotRoot(root)).toEqual({});
    expect(stateChangingCalls(calls)).toEqual([]);
  });

  it('back from the base URL to the database user changes the written admin env', async () => {
    const { setup, script } = interactive([
      ['POSTGRES_USER', 'first_user'],
      ['POSTGRES_PASSWORD', ''],
      ['configMethod', 'skip'],
      ['provider', 'local'],
      ['LOGOUT_REDIRECT_URL', 'auto-shell'],
      ['useDevelopment', 'BACK'],
      ['LOGOUT_REDIRECT_URL', 'BACK'],
      ['provider', 'BACK'],
      ['configMethod', 'BACK'],
      ['POSTGRES_PASSWORD', 'BACK'],
      ['POSTGRES_USER', 'second_user'],
      ['POSTGRES_PASSWORD', ''],
      ['configMethod', 'skip'],
      ...LOCAL_TAIL,
      [REVIEW, 'WRITE']
    ]);
    await setup.run();
    script.assertDone();
    expect(read('services/admin/.env')).toContain('cds.requires.db.credentials.user=second_user');
    expect(read('docker/.env')).toMatch(/^POSTGRES_USER=second_user$/m);
    expect(allText()).not.toContain('first_user');
  });

  it("switching provider writes only the new provider's settings", async () => {
    const ldapExternal: Step[] = [
      ['LDAP_HOST', 'ldap.example.invalid:636'],
      ['LDAP_INSECURE_NO_SSL', 'false'],
      ['LDAP_BIND_DN', 'cn=svc,dc=example'],
      ['LDAP_BIND_PASSWORD', 'ldap-bind-secret-x'],
      ['LDAP_USER_BASE_DN', 'ou=users,dc=example'],
      ['LDAP_USER_FILTER', '(objectClass=person)'],
      ['LDAP_USERNAME_ATTR', 'sAMAccountName'],
      ['LDAP_ID_ATTR', 'sAMAccountName'],
      ['LDAP_EMAIL_ATTR', 'mail'],
      ['LDAP_NAME_ATTR', 'displayName'],
      ['LDAP_PREFERRED_USERNAME_ATTR', 'sAMAccountName'],
      ['LDAP_GROUP_BASE_DN', 'ou=groups,dc=example'],
      ['LDAP_GROUP_FILTER', '(objectClass=group)'],
      ['LDAP_GROUP_NAME_ATTR', 'cn'],
      ['LDAP_GROUP_MEMBER_ATTR', 'member']
    ];
    const { setup, script, state } = interactive([
      ...DB,
      ['configMethod', 'skip'],
      ['provider', 'ldap'],
      ['LDAP_SERVER_TYPE', 'external'],
      ['LDAP_ADMIN_GROUP', 'ldap-admins-x'],
      ['LDAP_USER_GROUP', 'ldap-users-x'],
      ['LOGOUT_REDIRECT_URL', 'auto-shell'],
      ...ldapExternal,
      ['useDevelopment', true],
      ['imageMode', 'local'],
      ...BILLING,
      [REVIEW, { jump: 'provider' }],
      ['provider', 'github'],
      ['GITHUB_CLIENT_ID', 'gh-client-id'],
      ['GITHUB_CLIENT_SECRET', 'gh-client-secret'],
      ['GITHUB_ORG', 'acme'],
      ['GITHUB_ADMIN_TEAM', 'admins'],
      ['GITHUB_USER_TEAM', 'users'],
      ['LOGOUT_REDIRECT_URL', 'auto-shell'],
      ['useDevelopment', true],
      ['imageMode', 'local'],
      ...BILLING,
      [REVIEW, 'WRITE']
    ]);
    await setup.run();
    script.assertDone();

    const written = allText();
    for (const ldapValue of ['ldap-bind-secret-x', 'ldap-admins-x', 'ldap-users-x', 'ldap.example.invalid', 'LDAP_BIND_DN']) {
      expect(written).not.toContain(ldapValue);
    }
    expect(read('services/admin/.env')).toContain('ROLE_MAPPING={"acme:admins":"admin","acme:users":"user"}');
    expect(read('docker/dex.config.yaml')).toContain('gh-client-id');
    // The review screen no longer lists the LDAP answers.
    expect(state.session.history.map((h: any) => h.id).filter((id: string) => id.startsWith('LDAP_'))).toEqual([]);
  });

  it('late confirmations are asked before the review', async () => {
    // An existing configuration file makes the backup question appear.
    fs.writeFileSync(path.join(root, 'docker', 'nginx.conf'), '# existing\n');
    const childProcess = require('child_process');
    const pulls: string[][] = [];
    jest.spyOn(childProcess, 'spawnSync').mockImplementation(((cmd: string, args: string[]) => {
      pulls.push([cmd, ...args]);
      return { status: 0 };
    }) as any);
    const backups = () => fs.readdirSync(path.join(root, 'docker')).filter((name) => name.startsWith('backup-'));

    const { setup, calls, script, state } = interactive(
      [
        ...DB,
        ['configMethod', 'skip'],
        ['provider', 'local'],
        ['createBackup', true],
        ['LOGOUT_REDIRECT_URL', 'auto-shell'],
        ['useDevelopment', true],
        ['imageMode', 'registry'],
        ['registry', 'ghcr.io'],
        ['organization', 'st-gr'],
        ...BILLING,
        ['deleteVolumes', true],
        ['pullImages', true],
        [REVIEW, 'WRITE']
      ],
      {},
      FAKE_VOLUMES
    );
    const ask = script.promptFn;
    const actionsBeforeAnswer: string[] = [];
    setup.createSession = () =>
      (state.session = new PromptSession({
        promptFn: async (question: any) => {
          if (backups().length || pulls.length || stateChangingCalls(calls).length) actionsBeforeAnswer.push(question.id);
          return ask(question);
        }
      }));

    await setup.run();
    script.assertDone();

    expect(actionsBeforeAnswer).toEqual([]);
    const ids = state.session.history.map((h: any) => h.id);
    expect(ids).toEqual(expect.arrayContaining(['createBackup', 'deleteVolumes', 'pullImages']));
    expect(backups()).toHaveLength(1);
    expect(calls).toContain(`deleteVolumes(${FAKE_VOLUMES.join(',')})`);
    expect(pulls.some((args) => args.includes('pull'))).toBe(true);
  });

  it('Back works from the volume question that used to sit inside a try/catch', async () => {
    const { setup, calls, script } = interactive(
      [
        ...DB,
        ['configMethod', 'skip'],
        ...LOCAL_TAIL,
        ['deleteVolumes', 'BACK'],
        ['SAP_BILLING_CURRENCY', 'USD'],
        ['deleteVolumes', false],
        [REVIEW, 'WRITE']
      ],
      {},
      FAKE_VOLUMES
    );
    await setup.run();
    script.assertDone();
    expect(script.shown.filter((q) => q.id === 'deleteVolumes')).toHaveLength(2);
    expect(calls.filter((c) => c.startsWith('deleteVolumes'))).toEqual([]);
  });

  it('a regenerated key is replaced and every other existing key is kept', async () => {
    const hex = (c: string) => c.repeat(64);
    const fromSample = (rel: string, values: Record<string, string>) => {
      let text = fs.readFileSync(path.join(root, `${rel}.sample`), 'utf8');
      for (const [key, value] of Object.entries(values)) text = text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
      fs.writeFileSync(path.join(root, rel), text);
    };
    fromSample('services/gateway/.env', { VALIDATION_TOKEN_SECRET: hex('1'), METADATA_ENCRYPTION_KEY: hex('2') });
    fromSample('services/admin/.env', {
      VALIDATION_TOKEN_SECRET: hex('1'),
      METADATA_ENCRYPTION_KEY: hex('2'),
      SIEM_CREDENTIAL_KEY: hex('3'),
      CONNECTION_CREDENTIAL_KEY: hex('4')
    });
    const { setup, script } = interactive([
      ...DB,
      ['key-regeneration', 'regenerate'],
      ['regenerate-key', 'SIEM_CREDENTIAL_KEY'],
      ['regenerate-confirm', true],
      ['regenerate-key', '__done__'],
      ['provider', 'local'],
      ['createBackup', false],
      ['LOGOUT_REDIRECT_URL', 'auto-shell'],
      ['useDevelopment', true],
      ['imageMode', 'local'],
      ...BILLING,
      [REVIEW, 'WRITE']
    ]);
    await setup.run();
    script.assertDone();
    const admin = read('services/admin/.env');
    const gateway = read('services/gateway/.env');
    expect(admin).toMatch(/^SIEM_CREDENTIAL_KEY=[0-9a-f]{64}$/m);
    expect(admin).not.toContain(`SIEM_CREDENTIAL_KEY=${hex('3')}`);
    expect(admin).toContain(`CONNECTION_CREDENTIAL_KEY=${hex('4')}`);
    expect(admin).toContain(`VALIDATION_TOKEN_SECRET=${hex('1')}`);
    expect(gateway).toContain(`VALIDATION_TOKEN_SECRET=${hex('1')}`);
    expect(gateway).toContain(`METADATA_ENCRYPTION_KEY=${hex('2')}`);
  });

  it('--config without database credentials asks for them before writing anything', async () => {
    const configFromJson = { provider: 'local', providerConfig: {}, keepDockerVolumes: true, sapConfig: { CLIENT_ID: 'cfg-client' } };
    const writtenWhenAsked: number[] = [];
    const { setup, script } = interactive(
      [['POSTGRES_USER', 'config_user'], ['POSTGRES_PASSWORD', ''], [REVIEW, 'WRITE']],
      { configFromJson }
    );
    const ask = script.promptFn;
    setup.createSession = () =>
      new PromptSession({
        promptFn: async (question: any) => {
          writtenWhenAsked.push(Object.keys(snapshotRoot(root)).length);
          return ask(question);
        }
      });
    await setup.run();
    script.assertDone();
    expect(writtenWhenAsked).toEqual([0, 0, 0]);
    expect(read('services/admin/.env')).toContain('cds.requires.db.credentials.user=config_user');
  });

  it('interactive answers equal to the --ci defaults write the --ci golden', async () => {
    // As the CI pipeline: the service key comes from the environment, --force, volumes present.
    process.env.SAP_AI_CORE_SERVICE_KEY = SERVICE_KEY;
    const { setup, calls, script } = interactive(
      [...DB, ...LOCAL_TAIL, ['deleteVolumes', true], [REVIEW, 'WRITE']],
      { forceOverwrite: true },
      FAKE_VOLUMES
    );
    await setup.run();
    script.assertDone();

    const stored: Record<string, string> = {};
    walk(path.join(FIXTURES, 'ci'), path.join(FIXTURES, 'ci'), stored);
    const expected: Record<string, string> = {};
    for (const [rel, content] of Object.entries(stored)) expected[rel.replace(/(^|\/)dot-env$/, '$1.env')] = content;
    const actual = snapshotRoot(root);
    // Every file the interactive answers determine matches the --ci golden byte for byte; there
    // are no ci-only differences for these answers (createBackup is not asked on a fresh root and
    // --ci skips the backup, regenerateKeys is empty on a fresh root in both modes).
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    for (const rel of Object.keys(expected)) expect({ [rel]: actual[rel] }).toEqual({ [rel]: expected[rel] });
    expect(calls.filter((c) => c.startsWith('deleteVolumes'))).toEqual([`deleteVolumes(${FAKE_VOLUMES.join(',')})`]);
  });

  it('billing answers reach the admin env', async () => {
    const first = interactive([
      ...DB,
      ['configMethod', 'skip'],
      ...LOCAL_TAIL.slice(0, -1),
      ['SAP_BILLING_CURRENCY', 'eur'],
      ['billingEnterPrices', true],
      ['SAP_CU_PRICE_PRODUCTIVE', '0.35'],
      ['SAP_CU_PRICE_NON_PRODUCTIVE', '0.2'],
      [REVIEW, 'WRITE']
    ]);
    await first.setup.run();
    first.script.assertDone();
    const admin = read('services/admin/.env');
    expect(admin).toMatch(/^SAP_BILLING_CURRENCY=EUR$/m);
    expect(admin).toMatch(/^SAP_CU_PRICE_PRODUCTIVE=0\.35$/m);
    expect(admin).toMatch(/^SAP_CU_PRICE_NON_PRODUCTIVE=0\.2$/m);

    // A re-run offers the current values; choosing USD removes the prices and keeps the currency line.
    const second = interactive([
      ['POSTGRES_USER', 'admin_user'],
      ['POSTGRES_PASSWORD', 'keep'],
      ['key-regeneration', 'keep'],
      ['provider', 'local'],
      ['createBackup', false],
      ['LOGOUT_REDIRECT_URL', 'auto-shell'],
      ['useDevelopment', true],
      ['imageMode', 'local'],
      ['SAP_BILLING_CURRENCY', 'USD'],
      [REVIEW, 'WRITE']
    ]);
    await second.setup.run();
    second.script.assertDone();
    const shown = second.script.shown.find((q) => q.id === 'SAP_BILLING_CURRENCY')!;
    expect(shown.default).toBe('EUR');
    const rerun = read('services/admin/.env');
    expect(rerun).toMatch(/^SAP_BILLING_CURRENCY=USD$/m);
    expect(rerun).not.toMatch(/^SAP_CU_PRICE_/m);
  });

  it('USD with nothing stored writes no billing keys', async () => {
    const { setup, script } = interactive([
      ...DB,
      ['configMethod', 'skip'],
      ...LOCAL_TAIL,
      [REVIEW, 'WRITE']
    ]);
    await setup.run();
    script.assertDone();
    expect(read('services/admin/.env')).not.toMatch(/^SAP_(BILLING_CURRENCY|CU_PRICE)/m);
  });

  it('--ci and --config write no billing values', async () => {
    process.env.SAP_AI_CORE_SERVICE_KEY = SERVICE_KEY;
    const { setup } = newDockerSetup(DockerSetup, root, { ciMode: true, forceOverwrite: true }, FAKE_VOLUMES);
    await setup.run();
    expect(read('services/admin/.env')).not.toMatch(/^SAP_(BILLING_CURRENCY|CU_PRICE)/m);
  });
});
