/**
 * setup-kyma.js must leave the developer's local configuration as it found it.
 *
 * It runs docker/setup-docker.js --config to produce the service .env files it
 * turns into Kyma ConfigMaps, and setup-docker.js writes those files into the
 * checkout: services/admin/.env switched to Postgres, new database passwords in
 * docker/.env*, a rewritten dex.config.yaml. setup-kyma.js now snapshots every
 * file setup-docker.js can write or delete and restores it once the ConfigMaps
 * are built — also when setup fails half-way.
 *
 * Everything runs against a temp project root. setup-docker.js itself is never
 * run: its volume cleanup talks to the local Docker daemon.
 */
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-var-requires */
const KymaSetup = require('../../../kyma/scripts/setup-kyma.js');
const snapshot = require('../../../kyma/scripts/local-config-snapshot.js');
/* eslint-enable @typescript-eslint/no-var-requires */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

KymaSetup.useYaml({
  dump: (obj: unknown) => JSON.stringify(obj, null, 2) + '\n',
  load: () => {
    throw new Error('yaml.load is not available in tests');
  },
});

// A developer's checkout before setup: local dev on SQLite, a hand-edited
// compose file, a leftover editor temp file. The gateway and ollama .env files
// and the compose override do not exist.
const BEFORE: Record<string, string> = {
  'services/admin/.env': '# local dev\ncds.requires.db.kind=sqlite\ncds.requires.db.credentials.database=db/admin.db\n',
  'docker/.env': 'DOCKER_TAG=0.10.0\nPOSTGRES_PASSWORD=local-dev-password\n',
  'docker/.env.postgres': 'cds.requires.db.credentials.password=local-dev-password\n',
  'docker/dex.config.yaml': 'storage:\n  config:\n    password: local-dev-password\n',
  'docker/docker-compose.yml': 'services: {} # hand edit\n',
  'docker/..tmp-editor': 'unsaved\n',
};
const ABSENT = ['services/gateway/.env', 'services/ollama/.env', 'docker/docker-compose.override.yml', 'docker/okta-saml-ca.pem'];

function writeTree(root: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

/** What setup-docker.js --config does to a checkout, in miniature. */
function clobber(root: string) {
  writeTree(root, {
    'services/admin/.env': 'cds.requires.db.kind=postgres\ncds.requires.db.credentials.host=postgres\n',
    'services/gateway/.env': 'LOG_LEVEL=debug\n',
    'services/ollama/.env': 'OLLAMA_HOST=0.0.0.0\n',
    'docker/.env.postgres': 'cds.requires.db.credentials.password=generated\n',
    'docker/dex.config.yaml': 'storage:\n  config:\n    password: generated\n',
    'docker/docker-compose.override.yml': 'services: {}\n',
    'docker/okta-saml-ca.pem': '# placeholder\n',
  });
  fs.rmSync(path.join(root, 'docker', '.env'));
  fs.rmSync(path.join(root, 'docker', '..tmp-editor'));
}

function expectUntouched(root: string) {
  for (const [rel, content] of Object.entries(BEFORE)) {
    expect({ rel, content: fs.readFileSync(path.join(root, rel), 'utf8') }).toEqual({ rel, content });
  }
  expect(fs.statSync(path.join(root, 'services/admin/.env')).mode & 0o777).toBe(0o600);
  for (const rel of ABSENT) {
    expect({ rel, exists: fs.existsSync(path.join(root, rel)) }).toEqual({ rel, exists: false });
  }
}

describe('local-config-snapshot', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-local-config-'));
    writeTree(root, BEFORE);
    fs.chmodSync(path.join(root, 'services/admin/.env'), 0o600);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('covers every file setup-docker.js writes, including editor temp files it deletes', () => {
    const outputs = snapshot.dockerSetupOutputs(root);
    for (const rel of [...Object.keys(BEFORE), ...ABSENT]) {
      expect(outputs).toContain(rel);
    }
  });

  it('lists every file name setup-docker.js joins onto docker/ or the project root for writing', () => {
    // Guards the enumeration against drift: a new output file in
    // setup-docker.js must be added to DOCKER_SETUP_OUTPUTS.
    const source = fs.readFileSync(path.join(REPO_ROOT, 'docker', 'setup-docker.js'), 'utf8');
    const readOnly = new Set(['docker/configs', 'package.json', 'services/admin/.env.sample',
      'services/gateway/.env.sample', 'services/ollama/.env.sample']);
    const joined = [...source.matchAll(/path\.join\(this\.(dockerDir|projectRoot), '([^']+)'\)/g)]
      .map(([, base, name]) => (base === 'dockerDir' ? `docker/${name}` : name))
      .filter((rel) => !readOnly.has(rel));
    const sharedFiles = source.match(/const sharedFiles = \[([^\]]+)\]/)?.[1] ?? '';
    const providerFiles = [...source.matchAll(/files: \[([^\]]+)\]/g)].map((m) => m[1]).join(',');
    const listed = [...`${sharedFiles},${providerFiles}`.matchAll(/'([^']+)'/g)].map(([, name]) => `docker/${name}`);
    const all = new Set([...joined, ...listed]);
    expect(all.size).toBeGreaterThan(10);
    for (const rel of all) {
      expect(snapshot.DOCKER_SETUP_OUTPUTS).toContain(rel);
    }
  });

  it('restores changed files, recreates deleted ones and removes new ones', () => {
    const snap = snapshot.snapshotFiles(root, snapshot.dockerSetupOutputs(root));
    clobber(root);
    const changed = snapshot.restoreFiles(snap);
    expectUntouched(root);
    expect(changed).toEqual(expect.arrayContaining(['services/admin/.env', 'services/gateway/.env', 'docker/.env']));
    // Only this snapshot's own backup dir: other suites create theirs in parallel.
    expect(fs.existsSync(snap.backupDir)).toBe(false);
  });

  it('keeps a private copy of the originals while setup runs', () => {
    const snap = snapshot.snapshotFiles(root, snapshot.dockerSetupOutputs(root));
    try {
      expect(fs.statSync(snap.backupDir).mode & 0o777).toBe(0o700);
      expect(fs.readFileSync(path.join(snap.backupDir, 'services/admin/.env'), 'utf8')).toBe(BEFORE['services/admin/.env']);
    } finally {
      snapshot.restoreFiles(snap);
    }
  });
});

describe('setup-kyma.js around setup-docker.js', () => {
  let root: string;
  let outputRoot: string;

  const render = (setup: any) => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    return setup
      .generateManifests(
        'internal',
        'local',
        { LOGOUT_REDIRECT_URL: 'auto-shell' },
        null,
        { registry: 'ghcr.io', organization: 'example-org', tag: '1.2.3', imagePullSecrets: false, useDigests: false },
        { POSTGRES_USER: 'gw_admin', POSTGRES_PASSWORD: 'not-a-real-password' },
        {}
      )
      .finally(() => {
        log.mockRestore();
        warn.mockRestore();
      });
  };

  const makeSetup = (namespace: string) => {
    const setup = new KymaSetup({ namespace, outputRoot });
    setup.projectRoot = root; // never the real checkout
    setup._k8sApiClusterIp = '10.0.0.1';
    return setup;
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-local-config-'));
    outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-local-output-'));
    writeTree(root, BEFORE);
    fs.chmodSync(path.join(root, 'services/admin/.env'), 0o600);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outputRoot, { recursive: true, force: true });
  });

  it.each(['sail-proxy', 'sail-proxy-test'])(
    'builds the ConfigMaps from setup-docker.js output, then restores the checkout (%s)',
    async (namespace) => {
      const setup = makeSetup(namespace);
      setup.runDockerSetup = async (config: Record<string, unknown>) => {
        clobber(root);
        // postProcessEnvFiles reads the .env files setup-docker.js just wrote.
        await setup.postProcessEnvFiles(config);
      };
      await render(setup);

      expectUntouched(root);
      const configmaps = path.join(
        namespace === 'sail-proxy' ? outputRoot : path.join(outputRoot, 'deployments', namespace),
        'templates',
        'configmaps'
      );
      const adminConfig = fs.readFileSync(path.join(configmaps, 'admin-config.yaml'), 'utf8');
      expect(adminConfig).toContain('cds.requires.db.kind: "postgres"');
      expect(fs.readFileSync(path.join(configmaps, 'gateway-config.yaml'), 'utf8')).toContain('LOG_LEVEL: "debug"');
    }
  );

  it('restores the checkout when setup fails half-way', async () => {
    const setup = makeSetup('sail-proxy-test');
    setup.runDockerSetup = async () => {
      clobber(root);
      throw new Error('Docker setup failed');
    };
    await expect(render(setup)).rejects.toThrow('Docker setup failed');
    expectUntouched(root);
  });

  it('tells setup-docker.js to keep the local Docker volumes', async () => {
    // With the .env files restored, the old Postgres password stays in use,
    // so deleting the volumes would only destroy local data.
    const setup = makeSetup('sail-proxy-test');
    let passed: Record<string, unknown> | undefined;
    setup.spawnDockerSetup = (_scriptPath: string, dockerConfig: Record<string, unknown>) => {
      passed = dockerConfig;
      return Promise.resolve(1);
    };
    fs.mkdirSync(path.join(root, 'docker'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docker', 'setup-docker.js'), '// stand-in\n');
    await expect(render(setup)).rejects.toThrow('Docker setup failed');
    expect(passed?.keepDockerVolumes).toBe(true);
    expectUntouched(root);
  });
});

describe('setup-kyma.js when the existing SAP AI Core configuration is declined', () => {
  // Declining "Use existing SAP AI Core configuration?" makes setup-docker.js
  // regenerate both service .env files from their samples, so the ConfigMaps
  // do not carry the old SAP AI Core settings. The originals must still come
  // back afterwards.
  const GATEWAY_ENV =
    'SAP_AI_CORE_URL=https://api.ai.example.test\nAUTH_URL=https://auth.example.test\n' +
    'CLIENT_ID=local-client\nCLIENT_SECRET=local-client-secret\nVALIDATION_TOKEN_SECRET=local-dev-secret\n';
  let root: string;
  let outputRoot: string;

  const answers: Record<string, unknown> = { useExisting: false, confirmDelete: true, configMethod: 'skip' };
  const fakeInquirer = {
    prompt: async (questions: Array<{ name: string }>) =>
      Object.fromEntries(questions.map((q) => [q.name, answers[q.name]])),
  };

  // After a decline, promptForServiceKey takes SAP_AI_CORE_SERVICE_KEY from the
  // process environment (a documented setup feature). CI exports a real one
  // for its end-to-end phase, so the test must not see the ambient variable.
  let savedServiceKey: string | undefined;

  beforeEach(() => {
    savedServiceKey = process.env.SAP_AI_CORE_SERVICE_KEY;
    delete process.env.SAP_AI_CORE_SERVICE_KEY;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-local-config-'));
    outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-local-output-'));
    writeTree(root, { ...BEFORE, 'services/gateway/.env': GATEWAY_ENV });
    KymaSetup.useInquirer(fakeInquirer);
  });

  afterEach(() => {
    if (savedServiceKey === undefined) delete process.env.SAP_AI_CORE_SERVICE_KEY;
    else process.env.SAP_AI_CORE_SERVICE_KEY = savedServiceKey;
    KymaSetup.useInquirer(null);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outputRoot, { recursive: true, force: true });
  });

  it('uses SAP_AI_CORE_SERVICE_KEY from the environment after a decline (why the test clears it)', async () => {
    process.env.SAP_AI_CORE_SERVICE_KEY = JSON.stringify({
      clientid: 'env-client',
      clientsecret: 'env-secret',
      url: 'https://auth.env.example.test',
      serviceurls: { AI_API_URL: 'https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com' },
    });
    const setup = new KymaSetup({ namespace: 'sail-proxy-test', outputRoot });
    setup.projectRoot = root;
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const sapConfig = await setup.promptForServiceKey();
      expect(sapConfig.CLIENT_ID).toBe('env-client');
    } finally {
      log.mockRestore();
    }
  });

  it('lets setup-docker.js start from fresh .env files and restores the originals afterwards', async () => {
    const setup = new KymaSetup({ namespace: 'sail-proxy-test', outputRoot });
    setup.projectRoot = root;
    setup._k8sApiClusterIp = '10.0.0.1';
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let seenBySetupDocker: Record<string, boolean> = {};
    try {
      const sapConfig = await setup.promptForServiceKey();
      expect(sapConfig).toBeNull();
      // Nothing is deleted before the snapshot is taken.
      expect(fs.readFileSync(path.join(root, 'services/gateway/.env'), 'utf8')).toBe(GATEWAY_ENV);

      setup.runDockerSetup = async (config: Record<string, unknown>) => {
        seenBySetupDocker = {
          gateway: fs.existsSync(path.join(root, 'services/gateway/.env')),
          admin: fs.existsSync(path.join(root, 'services/admin/.env')),
        };
        clobber(root);
        await setup.postProcessEnvFiles(config);
      };
      await setup.generateManifests(
        'internal',
        'local',
        { LOGOUT_REDIRECT_URL: 'auto-shell' },
        null,
        { registry: 'ghcr.io', organization: 'example-org', tag: '1.2.3', imagePullSecrets: false, useDigests: false },
        { POSTGRES_USER: 'gw_admin', POSTGRES_PASSWORD: 'not-a-real-password' },
        sapConfig
      );
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }

    expect(seenBySetupDocker).toEqual({ gateway: false, admin: false });
    expect(fs.readFileSync(path.join(root, 'services/gateway/.env'), 'utf8')).toBe(GATEWAY_ENV);
    expect(fs.readFileSync(path.join(root, 'services/admin/.env'), 'utf8')).toBe(BEFORE['services/admin/.env']);
  });
});

describe('withLocalConfigRestored failure handling', () => {
  let root: string;

  const makeSetup = () => {
    const setup = new KymaSetup({});
    setup.projectRoot = root;
    return setup;
  };

  // Makes restoring services/admin/.env impossible: its directory becomes a file.
  const breakRestore = () => {
    fs.rmSync(path.join(root, 'services', 'admin'), { recursive: true, force: true });
    fs.writeFileSync(path.join(root, 'services', 'admin'), 'not a directory\n');
  };

  let log: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-local-config-'));
    writeTree(root, BEFORE);
    fs.chmodSync(path.join(root, 'services/admin/.env'), 0o600);
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    log.mockRestore();
    error.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports both the setup error and a failed restore, with the backup location', async () => {
    const failure = makeSetup()
      .withLocalConfigRestored(async () => {
        breakRestore();
        throw new Error('setup-docker exploded');
      })
      .catch((e: Error) => e);
    const e = (await failure) as AggregateError;
    expect(e).toBeInstanceOf(AggregateError);
    expect(e.errors.map((x: Error) => x.message)).toEqual([
      'setup-docker exploded',
      expect.stringMatching(/Could not restore services\/admin\/\.env.*sail-proxy-local-config-/),
    ]);
    expect(e.message).toMatch(/setup-docker exploded/);
    expect(e.message).toMatch(/sail-proxy-local-config-/);
    const kept = e.message.match(/(\/\S*sail-proxy-local-config-[^\s)]+)/)?.[1] ?? '';
    expect(fs.existsSync(kept)).toBe(true);
    fs.rmSync(kept, { recursive: true, force: true });
  });

  it('still reports the setup error alone when the restore succeeds', async () => {
    await expect(
      makeSetup().withLocalConfigRestored(async () => {
        clobber(root);
        throw new Error('setup-docker exploded');
      })
    ).rejects.toThrow(/^setup-docker exploded$/);
    expectUntouched(root);
  });
});

describe('withLocalConfigRestored signal handling', () => {
  let root: string;

  const makeSetup = () => {
    const setup = new KymaSetup({});
    setup.projectRoot = root;
    return setup;
  };

  let log: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-local-config-'));
    writeTree(root, BEFORE);
    fs.chmodSync(path.join(root, 'services/admin/.env'), 0o600);
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    log.mockRestore();
    error.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('listens for SIGINT and SIGTERM only while setup-docker.js may be running', async () => {
    const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') };
    let during = { int: 0, term: 0 };
    await makeSetup().withLocalConfigRestored(async () => {
      during = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') };
    });
    expect(during).toEqual({ int: before.int + 1, term: before.term + 1 });
    expect({ int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') }).toEqual(before);
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ])('on %s stops setup-docker.js, restores the checkout, then exits with %i', async (signal, code) => {
    // The handler is called directly: no real signal reaches the test runner.
    const setup = makeSetup();
    const snap = snapshot.snapshotFiles(root, snapshot.dockerSetupOutputs(root));
    clobber(root);
    const events: string[] = [];
    const child: any = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (sig: string) => {
      events.push(`kill ${sig}`);
      setImmediate(() => {
        events.push('child closed');
        child.emit('close', null, sig);
      });
      return true;
    };
    setup.dockerSetupProcess = child;
    const exit = jest.fn((exitCode: number) => {
      events.push(`exit ${exitCode}`);
    });

    await setup.signalRestorer(snap, exit)(signal);

    expect(events).toEqual([`kill ${signal}`, 'child closed', `exit ${code}`]);
    expect(exit).toHaveBeenCalledWith(code);
    expectUntouched(root);
    expect(fs.existsSync(snap.backupDir)).toBe(false);
  });
});

describe('setup-kyma.js renders from .env.sample, never from a local .env', () => {
  // setup-docker.js keeps an existing services/*/.env (and adopts its
  // secrets), so every non-secret key of a developer's local .env used to
  // reach gateway-config / admin-config. setup-kyma.js now moves the local
  // files aside, after the snapshot, before every setup-docker.js run.
  const LOCAL: Record<string, string> = {
    'services/gateway/.env': 'SAP_AI_CORE_URL=https://local-only.example.test\nTEST_AWS_ACCESS_KEY_ID=LOCALONLYKEYID\nLOG_LEVEL=local-debug\n',
    'services/admin/.env': 'cds.requires.db.kind=sqlite\nSIEM_CREDENTIAL_KEY=local-only-siem-key\nLOG_LEVEL=local-debug\n',
    'services/ollama/.env': 'OLLAMA_HOST=local-only-host\n',
  };
  const SAMPLE: Record<string, string> = {
    'services/gateway/.env.sample': 'SAP_AI_CORE_URL=https://sample.example.test\nLOG_LEVEL=info\n',
    'services/admin/.env.sample': 'NODE_ENV=production\nLOG_LEVEL=info\n',
    'services/ollama/.env.sample': 'OLLAMA_HOST=0.0.0.0\n',
  };
  let root: string;
  let outputRoot: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-local-config-'));
    outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-local-output-'));
    writeTree(root, { ...LOCAL, ...SAMPLE });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outputRoot, { recursive: true, force: true });
  });

  it.each(['sail-proxy', 'sail-proxy-test'])('keeps every local .env value out of the render (%s)', async (namespace) => {
    const setup = new KymaSetup({ namespace, outputRoot });
    setup.projectRoot = root;
    setup._k8sApiClusterIp = '10.0.0.1';
    let seen: Record<string, boolean> = {};
    // Behaves like setup-docker.js: an existing .env is kept, a missing one
    // is created from its .env.sample.
    setup.runDockerSetup = async (config: Record<string, unknown>) => {
      for (const svc of ['gateway', 'admin', 'ollama']) {
        const env = path.join(root, 'services', svc, '.env');
        seen[svc] = fs.existsSync(env);
        if (!fs.existsSync(env)) fs.copyFileSync(`${env}.sample`, env);
      }
      await setup.postProcessEnvFiles(config);
    };
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await setup.generateManifests(
        'internal',
        'local',
        { LOGOUT_REDIRECT_URL: 'auto-shell' },
        null,
        { registry: 'ghcr.io', organization: 'example-org', tag: '1.2.3', imagePullSecrets: false, useDigests: false },
        { POSTGRES_USER: 'gw_admin', POSTGRES_PASSWORD: 'not-a-real-password' },
        null
      );
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }

    expect(seen).toEqual({ gateway: false, admin: false, ollama: false });
    const rendered = namespace === 'sail-proxy' ? outputRoot : path.join(outputRoot, 'deployments', namespace);
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]
      );
    for (const file of walk(rendered)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const local of ['local-only', 'LOCALONLYKEYID', 'local-debug']) {
        expect({ file, local, leaked: text.includes(local) }).toEqual({ file, local, leaked: false });
      }
    }
    expect(fs.readFileSync(path.join(rendered, 'templates/configmaps/gateway-config.yaml'), 'utf8')).toContain(
      'SAP_AI_CORE_URL: "https://sample.example.test"'
    );
    // And the developer's files are back.
    for (const [rel, content] of Object.entries(LOCAL)) {
      expect({ rel, content: fs.readFileSync(path.join(root, rel), 'utf8') }).toEqual({ rel, content });
    }
  });

  it('passes a skipped SAP AI Core configuration on as empty, so setup-docker.js does not ask again', async () => {
    const setup = new KymaSetup({ outputRoot });
    setup.projectRoot = root;
    let passed: Record<string, unknown> | undefined;
    setup.spawnDockerSetup = (_p: string, dockerConfig: Record<string, unknown>) => {
      passed = dockerConfig;
      return Promise.resolve(1);
    };
    fs.mkdirSync(path.join(root, 'docker'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docker', 'setup-docker.js'), '// stand-in\n');
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(setup.runDockerSetup({ provider: 'local', baseUrl: 'http://localhost:22001' })).rejects.toThrow(
        'Docker setup failed'
      );
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
    expect(passed?.sapConfig).toEqual({});
  });
});
