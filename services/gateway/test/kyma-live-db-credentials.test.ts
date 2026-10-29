/**
 * The Postgres credentials of an existing Kyma namespace are carried over.
 *
 * The Postgres volume keeps the user and password it was initialised with;
 * re-running setup-kyma.js used to prompt for (or generate) new ones and
 * render them into postgres-env, admin-env and gateway-migration-env, which
 * the database then refuses. setup-kyma.js now reads them read-only from the
 * live namespace (with the file_search runtime role's credentials) and
 * renders them unchanged; a different password typed at the prompt stops the
 * setup instead of silently overriding either value.
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

// Characters that URL encoding and YAML quoting must both survive.
const LIVE_USER = 'live_admin';
const LIVE_PASSWORD = 'live:p@ss/w"rd\\x+%';
const LIVE_RUNTIME_USER = 'file_search_app';
const LIVE_RUNTIME_PASSWORD = 'live-runtime:p@ss/%';
const enc = encodeURIComponent;
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
  'secret postgres-env': secretJson({
    POSTGRES_DB: 'sap_llm_gateway',
    POSTGRES_USER: LIVE_USER,
    POSTGRES_PASSWORD: LIVE_PASSWORD,
  }),
  'secret admin-env': secretJson({
    DATABASE_URL: `postgres://${LIVE_USER}:${LIVE_PASSWORD}@postgres:5432/sap_llm_gateway`,
    'cds.requires.db.credentials.password': LIVE_PASSWORD,
    VALIDATION_TOKEN_SECRET: 'live-vts',
  }),
  'secret gateway-migration-env': secretJson({
    FILE_SEARCH_MIGRATION_DATABASE_URL: `postgresql://${enc(LIVE_USER)}:${enc(LIVE_PASSWORD)}@postgres:5432/sap_llm_gateway`,
  }),
  'secret gateway-env': secretJson({
    VALIDATION_TOKEN_SECRET: 'live-vts',
    FILE_SEARCH_DATABASE_URL: `postgresql://${enc(LIVE_RUNTIME_USER)}:${enc(LIVE_RUNTIME_PASSWORD)}@postgres:5432/sap_llm_gateway`,
  }),
  ...overrides,
});

/** Scripted inquirer: answers by question name, else the question's default. */
function scriptPrompts(answers: Record<string, unknown>) {
  const asked: Array<Record<string, unknown>> = [];
  KymaSetup.useInquirer({
    prompt: async (questions: Array<Record<string, unknown>>) => {
      asked.push(...questions);
      return Object.fromEntries(
        questions.map((q) => [q.name, q.name as string in answers ? answers[q.name as string] : q.default])
      );
    },
  });
  return asked;
}

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

describe('setup-kyma.js Postgres credentials of an existing namespace', () => {
  let outputRoot: string;
  let projectRoot: string;
  let out: ReturnType<typeof captureOutput>;

  beforeEach(() => {
    outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-db-out-'));
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-db-project-'));
    out = captureOutput();
  });

  afterEach(() => {
    out.restore();
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

  const render = (setup: any, dbConfig: Record<string, unknown>) =>
    setup.generateManifests(
      'internal',
      'local',
      { LOGOUT_REDIRECT_URL: 'auto-shell' },
      null,
      { registry: 'ghcr.io', organization: 'example-org', tag: '1.2.3', imagePullSecrets: false, useDigests: false },
      dbConfig,
      null
    );

  const rootOf = (namespace: string) =>
    namespace === 'sail-proxy' ? outputRoot : path.join(outputRoot, 'deployments', namespace);

  it.each(['sail-proxy', 'sail-proxy-test'])(
    'keeps the live credentials when the prompt is left empty and renders them byte for byte (%s)',
    async (namespace) => {
      const setup = makeSetup(namespace);
      mockKubectl(setup, liveCluster(namespace));
      const asked = scriptPrompts({ POSTGRES_PASSWORD: '' });
      await setup.loadExistingKeys();
      const dbConfig = await setup.promptForDatabaseCredentials();
      expect(dbConfig.POSTGRES_USER).toBe(LIVE_USER);
      expect(dbConfig.POSTGRES_PASSWORD).toBe(LIVE_PASSWORD);
      expect(asked.find((q) => q.name === 'POSTGRES_USER')?.default).toBe(LIVE_USER);
      await render(setup, dbConfig);

      const secrets = path.join(rootOf(namespace), 'templates', 'secrets');
      const postgres = stringData(path.join(secrets, 'postgres-env.yaml'));
      const admin = stringData(path.join(secrets, 'admin-env.yaml'));
      const migration = stringData(path.join(secrets, 'gateway-migration-env.yaml'));
      const gateway = stringData(path.join(secrets, 'gateway-env.yaml'));
      expect(postgres.POSTGRES_USER).toBe(LIVE_USER);
      expect(postgres.POSTGRES_PASSWORD).toBe(LIVE_PASSWORD);
      expect(admin.DATABASE_URL).toBe(`postgres://${LIVE_USER}:${LIVE_PASSWORD}@postgres:5432/sap_llm_gateway`);
      expect(admin['cds.requires.db.credentials.password']).toBe(LIVE_PASSWORD);
      expect(migration.FILE_SEARCH_MIGRATION_DATABASE_URL).toBe(
        `postgresql://${enc(LIVE_USER)}:${enc(LIVE_PASSWORD)}@postgres:5432/sap_llm_gateway`
      );
      expect(gateway.FILE_SEARCH_DATABASE_URL).toBe(
        `postgresql://${enc(LIVE_RUNTIME_USER)}:${enc(LIVE_RUNTIME_PASSWORD)}@postgres:5432/sap_llm_gateway`
      );
      const printed = out.lines.join('\n');
      for (const secret of [LIVE_PASSWORD, LIVE_RUNTIME_PASSWORD, enc(LIVE_PASSWORD)]) {
        expect(printed).not.toContain(secret);
      }
    }
  );

  it('stops when a different password is typed for an existing namespace', async () => {
    const setup = makeSetup('sail-proxy');
    mockKubectl(setup, liveCluster('sail-proxy'));
    scriptPrompts({ POSTGRES_PASSWORD: 'a-different-password', POSTGRES_PASSWORD_CONFIRM: 'a-different-password' });
    await setup.loadExistingKeys();
    const failure = await setup.promptForDatabaseCredentials().catch((e: Error) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(/volume/);
    expect(failure.message).not.toContain('a-different-password');
    expect(failure.message).not.toContain(LIVE_PASSWORD);
  });

  it('stops when a different user is typed for an existing namespace', async () => {
    const setup = makeSetup('sail-proxy');
    mockKubectl(setup, liveCluster('sail-proxy'));
    scriptPrompts({ POSTGRES_USER: 'someone_else', POSTGRES_PASSWORD: '' });
    await setup.loadExistingKeys();
    await expect(setup.promptForDatabaseCredentials()).rejects.toThrow(/volume/);
  });

  it('refuses to render other credentials for an existing namespace, whatever the caller passes', async () => {
    const setup = makeSetup('sail-proxy-test');
    mockKubectl(setup, liveCluster('sail-proxy-test'));
    await setup.loadExistingKeys();
    await expect(render(setup, { POSTGRES_USER: LIVE_USER, POSTGRES_PASSWORD: 'other-password' })).rejects.toThrow(
      /volume/
    );
    expect(fs.existsSync(path.join(outputRoot, 'deployments'))).toBe(false);
  });

  it('--ci uses the live credentials without prompting', async () => {
    const setup = makeSetup('sail-proxy', true);
    mockKubectl(setup, liveCluster('sail-proxy'));
    const asked = scriptPrompts({});
    await setup.loadExistingKeys();
    const dbConfig = await setup.promptForDatabaseCredentials();
    expect(asked).toEqual([]);
    expect(dbConfig).toEqual(expect.objectContaining({ POSTGRES_USER: LIVE_USER, POSTGRES_PASSWORD: LIVE_PASSWORD }));
  });

  it('keeps today\'s prompt and generation for a namespace that does not exist', async () => {
    const setup = makeSetup('sail-proxy-test');
    mockKubectl(setup, {});
    const asked = scriptPrompts({ POSTGRES_PASSWORD: '', confirmNewNamespace: true });
    await setup.loadExistingKeys();
    const dbConfig = await setup.promptForDatabaseCredentials();
    expect(asked.find((q) => q.name === 'POSTGRES_USER')?.default).toBe('admin_user');
    expect(dbConfig.POSTGRES_USER).toBe('admin_user');
    expect(dbConfig.passwordWasGenerated).toBe(true);
    expect(dbConfig.POSTGRES_PASSWORD).toMatch(/\S{8,}/);
  });

  it('stops when the live Secrets disagree on the database credentials', async () => {
    const setup = makeSetup('sail-proxy');
    mockKubectl(
      setup,
      liveCluster('sail-proxy', {
        'secret admin-env': secretJson({
          DATABASE_URL: `postgres://${LIVE_USER}:another-password@postgres:5432/sap_llm_gateway`,
        }),
      })
    );
    const failure = await setup.loadExistingKeys().catch((e: Error) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(/Postgres credentials/);
    expect(failure.message).not.toContain('another-password');
  });

  it('stops when the postgres-env Secret of an existing namespace cannot be read', async () => {
    const setup = makeSetup('sail-proxy');
    mockKubectl(
      setup,
      liveCluster('sail-proxy', {
        'secret postgres-env': new KubectlError('Error from server (Forbidden): secrets "postgres-env" is forbidden\n'),
      })
    );
    await expect(setup.loadExistingKeys()).rejects.toThrow(/postgres-env/);
  });

  it('--ci renders one generated, non-empty password everywhere for a new namespace', async () => {
    const setup = makeSetup('sail-proxy-test', true);
    mockKubectl(setup, {});
    const asked = scriptPrompts({});
    await setup.loadExistingKeys();
    const dbConfig = await setup.promptForDatabaseCredentials();
    expect(asked).toEqual([]);
    await render(setup, dbConfig);

    const secrets = path.join(rootOf('sail-proxy-test'), 'templates', 'secrets');
    const postgres = stringData(path.join(secrets, 'postgres-env.yaml'));
    const admin = stringData(path.join(secrets, 'admin-env.yaml'));
    const migration = stringData(path.join(secrets, 'gateway-migration-env.yaml'));
    const password = postgres.POSTGRES_PASSWORD;
    expect(password).toMatch(/\S{8,}/);
    expect(postgres.POSTGRES_USER).toBe('admin_user');
    expect(admin.DATABASE_URL).toBe(`postgres://admin_user:${password}@postgres:5432/sap_llm_gateway`);
    expect(admin['cds.requires.db.credentials.password']).toBe(password);
    expect(migration.FILE_SEARCH_MIGRATION_DATABASE_URL).toBe(
      `postgresql://admin_user:${enc(password)}@postgres:5432/sap_llm_gateway`
    );
  });
});
