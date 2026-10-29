/**
 * Interactive setup-docker.js re-run: every question defaults to the value the configuration
 * already has (read from the files the script wrote), Enter keeps it, and generated secrets are
 * kept unless the user regenerates them. --force starts from today's defaults instead.
 * Runs against a temporary project root with every docker call stubbed and a prompter that
 * presses Enter (takes the shown default) unless an answer is given for the question.
 */
import * as fs from 'fs';
import * as path from 'path';
import { forbidChildProcess, makeDockerRoot, newDockerSetup, walk } from './helpers/setupDockerHarness';

const savedArgv = process.argv;
process.argv = [savedArgv[0], 'setup-docker.js'];
// eslint-disable-next-line @typescript-eslint/no-var-requires
const DockerSetup = require('../../../docker/setup-docker.js');
process.argv = savedArgv;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PromptSession, REVIEW, WRITE } = require('../../../docker/setup-flow/session');

let root: string;
let savedEnv: NodeJS.ProcessEnv;
let printed: string[];
let dockerCalls: string[];

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const key of ['SAP_AI_CORE_SERVICE_KEY', 'POSTGRES_USER', 'POSTGRES_PASSWORD']) delete process.env[key];
  root = makeDockerRoot();
  printed = [];
  const capture = (...a: unknown[]) => {
    printed.push(a.map(String).join(' '));
  };
  jest.spyOn(console, 'log').mockImplementation(capture);
  jest.spyOn(console, 'warn').mockImplementation(capture);
  jest.spyOn(console, 'error').mockImplementation(capture);
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

interface Shown {
  id: string;
  type: string;
  default: any;
  message: string;
  choices?: any[];
}

/** Every file under the root, raw (secrets included). */
function files(): Record<string, string> {
  const out: Record<string, string> = {};
  walk(root, root, out);
  return out;
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

/**
 * One interactive run: answers[id] (a value, or a list of values for a question asked more than
 * once) where given, Enter everywhere else, Write configuration on the review screen.
 */
async function run(
  answers: Record<string, any> = {},
  options: Record<string, unknown> = {},
  volumes: string[] = []
): Promise<Shown[]> {
  const shown: Shown[] = [];
  const queue: Record<string, any[]> = {};
  // pullImages is a confirmation, not configuration: never pull in a test.
  for (const [id, value] of Object.entries({ pullImages: false, ...answers })) queue[id] = Array.isArray(value) ? [...value] : [value];
  const promptFn = async (question: any) => {
    shown.push({ id: question.id, type: question.type, default: question.default, message: question.message, choices: question.choices });
    if (question.id === REVIEW) return WRITE;
    const value = queue[question.id] && queue[question.id].length ? queue[question.id].shift() : enter(question);
    if (question.type === 'list' && !question.choices.some((c: any) => (c && typeof c === 'object' ? c.value : c) === value)) {
      throw new Error(`answer for ${question.id} is not a choice: ${String(value)}`);
    }
    const valid = question.validate ? await question.validate(value) : true;
    if (valid !== true) throw new Error(`answer for ${question.id} rejected: ${valid}`);
    return value;
  };
  const { setup, calls } = newDockerSetup(DockerSetup, root, options, volumes);
  dockerCalls = calls;
  setup.createSession = (current?: Record<string, any>) => new PromptSession({ promptFn, current });
  try {
    await setup.run();
  } catch (error) {
    // run() reports a failure through console.error and process.exit: surface the reason.
    throw new Error(`${(error as Error).message}: ${printed[printed.length - 1]}`);
  }
  return shown;
}

/** Lines of `after` that differ from `before`, per file (files present in both). */
function changedLines(before: Record<string, string>, after: Record<string, string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const rel of Object.keys(after)) {
    if (before[rel] === after[rel]) continue;
    const a = (before[rel] || '').split('\n');
    const b = after[rel].split('\n');
    const diff: string[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) diff.push(b[i] === undefined ? '' : b[i]);
    out[rel] = diff;
  }
  return out;
}

const DB_PASSWORD = 'first-run-pw-1';
const FIRST_RUNS: Record<string, Record<string, any>> = {
  local: {
    POSTGRES_USER: 'custom_user',
    POSTGRES_PASSWORD: '',
    configMethod: 'skip',
    provider: 'local',
    LOGOUT_REDIRECT_URL: 'https://logout.example.invalid/bye'
  },
  github: {
    POSTGRES_USER: 'gh_user',
    POSTGRES_PASSWORD: DB_PASSWORD,
    confirmPassword: DB_PASSWORD,
    configMethod: 'skip',
    provider: 'github',
    GITHUB_CLIENT_ID: 'gh-client-id-1',
    GITHUB_CLIENT_SECRET: 'gh-client-secret-1',
    GITHUB_ORG: 'acme',
    GITHUB_ADMIN_TEAM: 'platform-admins',
    GITHUB_USER_TEAM: 'platform-users',
    useDevelopment: false,
    baseUrl: 'https://gateway.example.invalid',
    imageMode: 'registry',
    registry: 'registry.example.invalid',
    organization: 'acme-images',
    pullImages: false
  },
  'ldap external': {
    POSTGRES_PASSWORD: '',
    configMethod: 'skip',
    provider: 'ldap',
    LDAP_SERVER_TYPE: 'external',
    LDAP_ADMIN_GROUP: 'dir-admins',
    LDAP_USER_GROUP: 'dir-users',
    LDAP_HOST: 'ldap.example.invalid:636',
    LDAP_BIND_DN: 'cn=svc,dc=example,dc=invalid',
    LDAP_BIND_PASSWORD: 'bind-secret-1',
    LDAP_USER_BASE_DN: 'ou=people,dc=example,dc=invalid',
    LDAP_GROUP_BASE_DN: 'ou=groups,dc=example,dc=invalid'
  }
};

describe('setup-docker.js re-run: the current configuration is the default', () => {
  it.each(Object.keys(FIRST_RUNS))('enter-only re-run keeps every file byte-identical (%s)', async (name) => {
    await run(FIRST_RUNS[name]);
    const before = files();
    printed = [];

    const shown = await run();
    expect(changedLines(before, files())).toEqual({});

    // No current secret reached a prompt (default or message) or the console.
    const secrets: Record<string, string> = { DB_PASSWORD, GITHUB: 'gh-client-secret-1', LDAP: 'bind-secret-1' };
    for (const rel of ['services/admin/.env', 'services/gateway/.env', 'docker/.env', 'docker/.env.auth']) {
      for (const line of before[rel].split('\n')) {
        const match = line.match(/^([A-Z0-9_]*(SECRET|KEY|PASSWORD)[A-Z0-9_]*)=(.{8,})$/);
        if (match && !/^(admin_password|changeme|__.*__|deadbeef.*)$/.test(match[3])) secrets[match[1]] = match[3];
      }
    }
    for (const question of shown) {
      for (const secret of Object.values(secrets)) {
        // choices covers the review screen's rendered entries as well.
        expect(JSON.stringify([question.default, question.message, question.choices])).not.toContain(secret);
      }
    }
    // The completion summary masks every secret, the OAuth2 proxy secrets included.
    const output = printed.join('\n');
    expect(Object.keys(secrets)).toEqual(expect.arrayContaining(['OAUTH2_PROXY_CLIENT_SECRET', 'OAUTH2_PROXY_COOKIE_SECRET']));
    for (const [key, secret] of Object.entries(secrets)) {
      expect({ [key]: output.includes(secret) }).toEqual({ [key]: false });
    }
    expect(output).toContain('Client Secret: ********');
  });

  it('a local-builds re-run defaults to local builds and does not offer a pull', async () => {
    await run(FIRST_RUNS.local);
    const before = files();
    const shown = await run();
    expect(shown.find((q) => q.id === 'imageMode')!.default).toBe('local');
    expect(shown.some((q) => q.id === 'pullImages')).toBe(false);
    expect(changedLines(before, files())).toEqual({});
  });

  it('a local LDAP + custom registry re-run offers the registry and keeps .env.docker', async () => {
    await run({
      POSTGRES_PASSWORD: '',
      configMethod: 'skip',
      provider: 'ldap',
      LDAP_SERVER_TYPE: 'local',
      imageMode: 'registry',
      registry: 'reg.example.invalid',
      organization: 'org1'
    });
    const before = files();
    const shown = await run();
    const defaults = Object.fromEntries(shown.map((q) => [q.id, q.default]));
    expect(defaults).toMatchObject({ LDAP_SERVER_TYPE: 'local', imageMode: 'registry', registry: 'reg.example.invalid', organization: 'org1' });
    expect(files()['docker/.env.docker']).toBe(before['docker/.env.docker']);
    expect(changedLines(before, files())).toEqual({});
  });

  it('a newly typed database password is not offered for regeneration', async () => {
    await run(FIRST_RUNS.github);
    const typed = 'second-run-pw-2';
    const shown = await run({
      POSTGRES_PASSWORD: 'new',
      'POSTGRES_PASSWORD:new': typed,
      confirmPassword: typed,
      'key-regeneration': 'regenerate',
      'regenerate-key': ['SIEM_CREDENTIAL_KEY', '__done__'],
      'regenerate-confirm': true
    });
    const offered = shown.find((q) => q.id === 'regenerate-key')!.choices!.map((c: any) => c.value);
    expect(offered).not.toContain('POSTGRES_PASSWORD');
    expect(offered).toContain('OAUTH2_PROXY_CLIENT_SECRET');
    expect(fs.readFileSync(path.join(root, 'docker', '.env'), 'utf8')).toContain(`POSTGRES_PASSWORD=${typed}`);
  });

  it('shows the current values as defaults', async () => {
    await run(FIRST_RUNS.github);
    const shown = await run();
    const defaults = Object.fromEntries(shown.map((q) => [q.id, q.default]));
    expect(defaults).toMatchObject({
      POSTGRES_USER: 'gh_user',
      POSTGRES_PASSWORD: 'keep',
      provider: 'github',
      GITHUB_CLIENT_ID: 'gh-client-id-1',
      GITHUB_ORG: 'acme',
      GITHUB_ADMIN_TEAM: 'platform-admins',
      GITHUB_USER_TEAM: 'platform-users',
      useDevelopment: false,
      baseUrl: 'https://gateway.example.invalid',
      imageMode: 'registry',
      registry: 'registry.example.invalid',
      organization: 'acme-images'
    });
    // The client secret is set: Enter keeps it, its value is never the prompt's default.
    const secret = shown.find((q) => q.id === 'GITHUB_CLIENT_SECRET')!;
    expect(secret.default).toBeUndefined();
    expect(secret.message).toContain('Enter keeps it');
  });

  it('changing one answer changes only its lines', async () => {
    await run(FIRST_RUNS.local);
    const before = files();
    await run({ LOGOUT_REDIRECT_URL: 'https://logout.example.invalid/changed' });
    expect(changedLines(before, files())).toEqual({
      'docker/.env.auth': ['LOGOUT_REDIRECT_URL=https://logout.example.invalid/changed'],
      'docker/.env.nginx': ['LOGOUT_REDIRECT_URL=https://logout.example.invalid/changed']
    });
  });

  it('a current value outside the choices falls back to the default', async () => {
    await run(FIRST_RUNS.local);
    const authPath = path.join(root, 'docker', '.env.auth');
    fs.writeFileSync(authPath, fs.readFileSync(authPath, 'utf8').replace(/^IDENTITY_PROVIDER=.*$/m, 'IDENTITY_PROVIDER=kerberos'));
    const dockerEnvPath = path.join(root, 'docker', '.env');
    fs.writeFileSync(dockerEnvPath, fs.readFileSync(dockerEnvPath, 'utf8').replace(/^POSTGRES_USER=.*$/m, 'POSTGRES_USER=pg_reserved'));

    const shown = await run({ provider: 'local' });
    const defaults = Object.fromEntries(shown.map((q) => [q.id, q.default]));
    // Today's defaults: the provider list has none, the database user is admin_user.
    expect(defaults.provider).toBeUndefined();
    expect(defaults.POSTGRES_USER).toBe('admin_user');
    // Valid current values are still offered.
    expect(defaults.LOGOUT_REDIRECT_URL).toBe('https://logout.example.invalid/bye');
  });

  it("--force starts from today's defaults", async () => {
    await run(FIRST_RUNS.github);
    const shown = await run({ configMethod: 'skip', 'key-regeneration': 'keep', provider: 'local' }, { forceOverwrite: true });
    const byId = Object.fromEntries(shown.map((q) => [q.id, q]));
    expect(byId.POSTGRES_USER.default).toBe('admin_user');
    // The password is asked as on a fresh install, not as Keep / Enter new.
    expect(byId.POSTGRES_PASSWORD.type).toBe('password');
    expect(byId.POSTGRES_PASSWORD.default).toBeUndefined();
    expect(byId.provider.default).toBeUndefined();
    expect(byId.LOGOUT_REDIRECT_URL.default).toBe('auto-shell');
    expect(byId.useDevelopment.default).toBe(true);
    expect(byId.imageMode.default).toBe('local');
  });

  it('existing generated keys are kept unless regenerated', async () => {
    await run(FIRST_RUNS.local);
    const before = files();
    await run({
      'key-regeneration': 'regenerate',
      'regenerate-key': ['SIEM_CREDENTIAL_KEY', '__done__'],
      'regenerate-confirm': true
    });
    const changed = changedLines(before, files());
    expect(Object.keys(changed)).toEqual(['services/admin/.env']);
    expect(changed['services/admin/.env']).toHaveLength(1);
    expect(changed['services/admin/.env'][0]).toMatch(/^SIEM_CREDENTIAL_KEY=[0-9a-f]{64}$/);
  });

  it('the keys generated afresh before are offered for regeneration and kept otherwise', async () => {
    await run(FIRST_RUNS.local);
    const before = files();
    const shown = await run({
      'key-regeneration': 'regenerate',
      'regenerate-key': ['OAUTH2_PROXY_COOKIE_SECRET', '__done__'],
      'regenerate-confirm': true
    });
    const offered = shown.find((q) => q.id === 'regenerate-key')!.choices!.map((c: any) => c.value);
    expect(offered).toEqual(
      expect.arrayContaining([
        'AWS_SECRET_ENCRYPTION_KEY',
        'POSTGRES_PASSWORD',
        'FILE_SEARCH_RUNTIME_PASSWORD',
        'OAUTH2_PROXY_CLIENT_SECRET',
        'OAUTH2_PROXY_COOKIE_SECRET'
      ])
    );
    const changed = changedLines(before, files());
    expect(Object.keys(changed)).toEqual(['docker/.env.auth']);
    expect(changed['docker/.env.auth']).toHaveLength(1);
    expect(changed['docker/.env.auth'][0]).toMatch(/^OAUTH2_PROXY_COOKIE_SECRET=[0-9a-f]{32}$/);
  });

  it('a regenerated database password reaches every file that holds it', async () => {
    await run(FIRST_RUNS.github);
    const old = DB_PASSWORD;
    await run({
      'key-regeneration': 'regenerate',
      'regenerate-key': ['POSTGRES_PASSWORD', '__done__'],
      'regenerate-confirm': true,
      pullImages: false
    });
    const text = Object.entries(files())
      .filter(([rel]) => rel.startsWith('docker/') || rel.startsWith('services/'))
      .filter(([rel]) => !rel.startsWith('docker/configs/'))
      .map(([, content]) => content)
      .join('\n');
    expect(text).not.toContain(old);
    expect(fs.readFileSync(path.join(root, 'docker', '.env'), 'utf8')).toMatch(/^POSTGRES_PASSWORD=[0-9a-f]{16}$/m);
  });
});

describe('setup-docker.js re-run: existing Docker volumes', () => {
  const VOLUMES = ['docker_postgres-data', 'docker_valkey-data'];

  it('an enter-only re-run keeps the volumes (same database credentials)', async () => {
    await run(FIRST_RUNS.github);
    const shown = await run({}, {}, VOLUMES);
    expect(shown.find((q) => q.id === 'deleteVolumes')!.default).toBe(false);
    expect(dockerCalls.filter((c) => c.startsWith('deleteVolumes'))).toEqual([]);
  });

  it('a changed database password defaults to deleting the volumes', async () => {
    await run(FIRST_RUNS.github);
    const typed = 'second-run-pw-2';
    const shown = await run({ POSTGRES_PASSWORD: 'new', 'POSTGRES_PASSWORD:new': typed, confirmPassword: typed }, {}, VOLUMES);
    expect(shown.find((q) => q.id === 'deleteVolumes')!.default).toBe(true);
    expect(dockerCalls).toContain(`deleteVolumes(${VOLUMES.join(',')})`);
  });

  it('a changed database user defaults to deleting the volumes', async () => {
    await run(FIRST_RUNS.github);
    const shown = await run({ POSTGRES_USER: 'other_user' }, {}, VOLUMES);
    expect(shown.find((q) => q.id === 'deleteVolumes')!.default).toBe(true);
  });

  it('a regenerated database password defaults to deleting the volumes', async () => {
    await run(FIRST_RUNS.github);
    const shown = await run(
      { 'key-regeneration': 'regenerate', 'regenerate-key': ['POSTGRES_PASSWORD', '__done__'], 'regenerate-confirm': true },
      {},
      VOLUMES
    );
    expect(shown.find((q) => q.id === 'deleteVolumes')!.default).toBe(true);
  });
});
