/**
 * deploy-kyma.js refuses to rotate a running deployment's keys or credentials.
 *
 * setup-kyma.js carries the encryption keys and Postgres credentials of an
 * existing namespace over, but deploy-kyma.js is the step that changes the
 * cluster: it applies whatever Secrets are on disk (an old render, a render
 * made against the wrong context, a hand edit). Before applying anything it now
 * reads the live values read-only and refuses if a rendered Secret would change
 * one that exists.
 *
 * child_process is mocked for the whole file: every kubectl command deploy
 * issues is recorded and answered here, nothing reaches a cluster.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockExecCommands: string[] = [];
const mockKubectlReads: string[][] = [];
// The content of each file `kubectl apply -f "<file>"` was given, read when the command ran.
const mockAppliedFiles = new Map<string, string>();
let mockKubectlAnswer: (args: string[]) => string = () => '';
// Commands for which exec fails (default: none).
let mockExecFails: (command: string) => boolean = () => false;

jest.mock('child_process', () => ({
  exec: (command: string, callback: (e: Error | null, r: { stdout: string; stderr: string }) => void) => {
    mockExecCommands.push(command);
    const file = /^kubectl apply -f "([^"]+)"$/.exec(command);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodeFs = require('fs');
    if (file && nodeFs.existsSync(file[1]) && nodeFs.statSync(file[1]).isFile()) {
      mockAppliedFiles.set(file[1], nodeFs.readFileSync(file[1], 'utf8'));
    }
    if (mockExecFails(command)) {
      callback(new Error(`Command failed: ${command}`), { stdout: '', stderr: '' });
      return;
    }
    callback(null, { stdout: '', stderr: '' });
  },
  execFileSync: (file: string, args: string[]) => {
    if (file !== 'kubectl') throw new Error(`unexpected ${file}`);
    mockKubectlReads.push(args);
    return mockKubectlAnswer(args);
  },
  execSync: () => {
    throw new Error('execSync not expected');
  },
  spawn: () => {
    throw new Error('spawn not expected');
  },
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const deployKyma = require('../../../kyma/scripts/deploy-kyma.js');
const { renderRegistrySecret } = require('../../../kyma/scripts/registry-secret.js');
const { renderInstallRecord } = require('../../../kyma/scripts/install-record.js');
/* eslint-enable @typescript-eslint/no-var-requires */

class KubectlError extends Error {
  stderr: string;
  constructor(stderr: string) {
    super(`Command failed: kubectl\n${stderr}`);
    this.stderr = stderr;
  }
}
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

const RENDERED: Record<string, Record<string, string>> = {
  'admin-env': {
    DATABASE_URL: 'postgres://gw_admin:db-pass@postgres:5432/sap_llm_gateway',
    VALIDATION_TOKEN_SECRET: 'vts-1',
    METADATA_ENCRYPTION_KEY: 'mek-1',
    AWS_SECRET_ENCRYPTION_KEY: 'aws-1',
    SIEM_CREDENTIAL_KEY: 'siem-1',
    CONNECTION_CREDENTIAL_KEY: 'conn-1',
    'cds.requires.db.credentials.password': 'db-pass',
  },
  'gateway-env': {
    VALIDATION_TOKEN_SECRET: 'vts-1',
    METADATA_ENCRYPTION_KEY: 'mek-1',
    FILE_SEARCH_DATABASE_URL: 'postgresql://file_search_app:rt-pass@postgres:5432/sap_llm_gateway',
  },
  'postgres-env': { POSTGRES_DB: 'sap_llm_gateway', POSTGRES_USER: 'gw_admin', POSTGRES_PASSWORD: 'db-pass' },
  'gateway-migration-env': {
    FILE_SEARCH_MIGRATION_DATABASE_URL: 'postgresql://gw_admin:db-pass@postgres:5432/sap_llm_gateway',
  },
};

/** A render in setup-kyma.js's format: yamlQuote'd stringData. */
function writeRender(kymaDir: string, namespace: string) {
  fs.mkdirSync(path.join(kymaDir, 'manifests', 'core'), { recursive: true });
  fs.writeFileSync(
    path.join(kymaDir, 'manifests', 'core', 'namespace.yaml'),
    `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${namespace}\n  labels:\n    app: sail-proxy\n`
  );
  fs.mkdirSync(path.join(kymaDir, 'templates', 'secrets'), { recursive: true });
  for (const [name, data] of Object.entries(RENDERED)) {
    const body = Object.entries(data)
      .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
      .join('\n');
    fs.writeFileSync(
      path.join(kymaDir, 'templates', 'secrets', `${name}.yaml`),
      `apiVersion: v1\nkind: Secret\nmetadata:\n  name: ${name}\n  namespace: ${namespace}\ntype: Opaque\nstringData:\n${body}\n`
    );
  }
}

type Cluster = Record<string, Record<string, string> | Error>;

/** Answers `kubectl get <kind> <name>` from a table; a missing entry is the server's NotFound. */
function cluster(namespace: string, table: Cluster, namespaceAnswer: Error | null = null) {
  return (args: string[]) => {
    if (args[0] !== 'get') throw new Error(`mock: unexpected kubectl ${args.join(' ')}`);
    if (args[1] === 'namespace') {
      if (namespaceAnswer) throw namespaceAnswer;
      return `namespace/${namespace}\n`;
    }
    const answer = table[`${args[1]} ${args[2]}`];
    if (answer === undefined) {
      throw new KubectlError(`Error from server (NotFound): ${args[1]}s "${args[2]}" not found\n`);
    }
    if (answer instanceof Error) throw answer;
    const data =
      args[1] === 'secret' ? Object.fromEntries(Object.entries(answer).map(([k, v]) => [k, b64(v)])) : answer;
    return JSON.stringify({ data });
  };
}

const liveMatching = (): Cluster => Object.fromEntries(Object.entries(RENDERED).map(([n, d]) => [`secret ${n}`, { ...d }]));

describe('deploy-kyma.js live credential guard', () => {
  let kymaDir: string;
  let out: jest.SpyInstance[];
  let printed: string[];

  beforeEach(() => {
    kymaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-deploy-guard-'));
    writeRender(kymaDir, 'sail-proxy');
    mockExecCommands.length = 0;
    mockKubectlReads.length = 0;
    mockAppliedFiles.clear();
    mockExecFails = () => false;
    printed = [];
    out = ['log', 'warn', 'error'].map((m) =>
      jest.spyOn(console, m as 'log').mockImplementation((...a: unknown[]) => {
        printed.push(a.join(' '));
      })
    );
    delete process.env.KYMA_DEPLOY_CONFIG;
  });

  afterEach(() => {
    out.forEach((s) => s.mockRestore());
    fs.rmSync(kymaDir, { recursive: true, force: true });
  });

  const deploy = () => deployKyma.deployToKyma({ kymaDir, argv: [] });
  const applied = () => mockExecCommands.filter((c) => /kubectl (apply|label|delete|create|rollout restart)/.test(c));

  it('refuses a render that would change a live key, before applying anything', async () => {
    const live = liveMatching();
    live['secret admin-env'] = { ...RENDERED['admin-env'], VALIDATION_TOKEN_SECRET: 'vts-LIVE' };
    live['secret gateway-env'] = { ...RENDERED['gateway-env'], VALIDATION_TOKEN_SECRET: 'vts-LIVE' };
    mockKubectlAnswer = cluster('sail-proxy', live);
    const failure = await deploy().catch((e: Error) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(/admin-env\/VALIDATION_TOKEN_SECRET/);
    expect(failure.message).toMatch(/gateway-env\/VALIDATION_TOKEN_SECRET/);
    expect(failure.message).not.toMatch(/vts-LIVE|vts-1/);
    expect(printed.join('\n')).not.toMatch(/vts-LIVE|vts-1/);
    expect(mockExecCommands).toEqual([]);
  });

  it.each([
    ['postgres-env', 'POSTGRES_PASSWORD', 'other-pass'],
    ['admin-env', 'DATABASE_URL', 'postgres://gw_admin:other-pass@postgres:5432/sap_llm_gateway'],
    ['gateway-migration-env', 'FILE_SEARCH_MIGRATION_DATABASE_URL', 'postgresql://gw_admin:x@postgres:5432/db'],
    ['gateway-env', 'FILE_SEARCH_DATABASE_URL', 'postgresql://file_search_app:x@postgres:5432/db'],
    ['admin-env', 'AWS_SECRET_ENCRYPTION_KEY', 'aws-LIVE'],
    ['admin-env', 'SIEM_CREDENTIAL_KEY', 'siem-LIVE'],
    ['admin-env', 'CONNECTION_CREDENTIAL_KEY', 'conn-LIVE'],
  ])('refuses when live %s %s differs', async (secret, key, liveValue) => {
    const live = liveMatching();
    live[`secret ${secret}`] = { ...(live[`secret ${secret}`] as Record<string, string>), [key]: liveValue };
    mockKubectlAnswer = cluster('sail-proxy', live);
    await expect(deploy()).rejects.toThrow(new RegExp(`${secret}/${key}`));
    expect(mockExecCommands).toEqual([]);
  });

  it('compares the SIEM key with admin-config for a deployment made before it moved into admin-env', async () => {
    const live = liveMatching();
    const { SIEM_CREDENTIAL_KEY: _dropped, ...adminWithoutSiem } = RENDERED['admin-env'];
    live['secret admin-env'] = adminWithoutSiem;
    live['configmap admin-config'] = { SIEM_CREDENTIAL_KEY: 'siem-from-configmap' };
    mockKubectlAnswer = cluster('sail-proxy', live);
    await expect(deploy()).rejects.toThrow(/admin-config\/SIEM_CREDENTIAL_KEY/);
    expect(mockExecCommands).toEqual([]);
  });

  // kubectl apply removes a key that was in the last-applied configuration but
  // is missing from the new render, so pods would lose it on their next start.
  it.each([
    ['gateway-env', 'FILE_SEARCH_DATABASE_URL'],
    ['admin-env', 'AWS_SECRET_ENCRYPTION_KEY'],
    ['postgres-env', 'POSTGRES_PASSWORD'],
  ])('refuses a render that drops live %s %s', async (secret, key) => {
    const file = path.join(kymaDir, 'templates', 'secrets', `${secret}.yaml`);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(new RegExp(`^  ${key}: .*\\n`, 'm'), ''));
    mockKubectlAnswer = cluster('sail-proxy', liveMatching());
    const failure = await deploy().catch((e: Error) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(new RegExp(`${secret}/${key} \\(removed\\)`));
    expect(mockExecCommands).toEqual([]);
  });

  const writeRenderedAdminConfig = (withSiem: string | null) => {
    fs.mkdirSync(path.join(kymaDir, 'templates', 'configmaps'), { recursive: true });
    fs.writeFileSync(
      path.join(kymaDir, 'templates', 'configmaps', 'admin-config.yaml'),
      'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: admin-config\n  namespace: sail-proxy\ndata:\n' +
        '  LOG_LEVEL: "info"\n' +
        (withSiem === null ? '' : `  SIEM_CREDENTIAL_KEY: ${JSON.stringify(withSiem)}\n`)
    );
  };
  const preChangeLive = (configMapSiem: string) => {
    const live = liveMatching();
    const { SIEM_CREDENTIAL_KEY: _dropped, ...adminWithoutSiem } = RENDERED['admin-env'];
    live['secret admin-env'] = adminWithoutSiem;
    live['configmap admin-config'] = { LOG_LEVEL: 'info', SIEM_CREDENTIAL_KEY: configMapSiem };
    return live;
  };

  it('lets the SIEM key move from admin-config into admin-env unchanged', async () => {
    writeRenderedAdminConfig(null);
    mockKubectlAnswer = cluster('sail-proxy', preChangeLive(RENDERED['admin-env'].SIEM_CREDENTIAL_KEY));
    await deploy();
    expect(applied().length).toBeGreaterThan(0);
  });

  it('refuses to drop the SIEM key from admin-config when admin-env does not take it over', async () => {
    writeRenderedAdminConfig(null);
    const file = path.join(kymaDir, 'templates', 'secrets', 'admin-env.yaml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^ {2}SIEM_CREDENTIAL_KEY: .*\n/m, ''));
    mockKubectlAnswer = cluster('sail-proxy', preChangeLive('siem-live'));
    await expect(deploy()).rejects.toThrow(/admin-config\/SIEM_CREDENTIAL_KEY \(removed\)/);
    expect(mockExecCommands).toEqual([]);
  });

  it('refuses to drop the SIEM key from admin-config when admin-env takes over a different value', async () => {
    writeRenderedAdminConfig(null);
    mockKubectlAnswer = cluster('sail-proxy', preChangeLive('siem-something-else'));
    await expect(deploy()).rejects.toThrow(/admin-config\/SIEM_CREDENTIAL_KEY/);
    expect(mockExecCommands).toEqual([]);
  });

  it('proceeds when every live value matches the render', async () => {
    mockKubectlAnswer = cluster('sail-proxy', liveMatching());
    await deploy();
    expect(applied().length).toBeGreaterThan(0);
  });

  it('proceeds when a live key is absent and the render introduces it (SIEM moving into admin-env)', async () => {
    const live = liveMatching();
    const { SIEM_CREDENTIAL_KEY: _dropped, ...adminWithoutSiem } = RENDERED['admin-env'];
    live['secret admin-env'] = adminWithoutSiem;
    mockKubectlAnswer = cluster('sail-proxy', live);
    await deploy();
    expect(applied().length).toBeGreaterThan(0);
  });

  it('proceeds for a namespace the API server reports as NotFound', async () => {
    mockKubectlAnswer = cluster(
      'sail-proxy',
      {},
      new KubectlError('Error from server (NotFound): namespaces "sail-proxy" not found\n')
    );
    await deploy();
    expect(applied().length).toBeGreaterThan(0);
  });

  it.each([
    ['an auth failure', 'error: You must be logged in to the server (Unauthorized)\n'],
    ['a missing context', 'error: context was not found for specified context: kyma-prod\n'],
    ['an unreachable cluster', 'Unable to connect to the server: dial tcp: lookup api.example.test: no such host\n'],
    ['a NotFound for another namespace', 'Error from server (NotFound): namespaces "sail-proxy-other" not found\n'],
  ])('refuses on %s at the namespace check, --ci or not', async (_label, stderr) => {
    mockKubectlAnswer = cluster('sail-proxy', liveMatching(), new KubectlError(stderr));
    await expect(deploy()).rejects.toThrow(/Cannot tell whether namespace sail-proxy/);
    expect(mockExecCommands).toEqual([]);
  });

  it('refuses when a live Secret of an existing namespace cannot be read', async () => {
    const live = liveMatching();
    live['secret admin-env'] = new KubectlError('Error from server (Forbidden): secrets "admin-env" is forbidden\n');
    mockKubectlAnswer = cluster('sail-proxy', live);
    await expect(deploy()).rejects.toThrow(/Cannot read secret admin-env/);
    expect(mockExecCommands).toEqual([]);
  });

  it('two deploys at once use their own temp manifests (no shared fixed path in the temp folder)', async () => {
    mockKubectlAnswer = cluster('sail-proxy', liveMatching());
    await Promise.all([deploy(), deploy()]);
    const files = mockExecCommands.filter((c) => /PeerAuthentication|peerauthentication/i.test(c)).map((c) => c.match(/-f "([^"]+)"/)![1]);
    expect(files).toHaveLength(2);
    expect(new Set(files).size).toBe(2);
    for (const f of files) expect(fs.existsSync(f)).toBe(false);
  });

  it('only ever reads: every kubectl call the guard makes is a get', async () => {
    mockKubectlAnswer = cluster('sail-proxy', liveMatching());
    await deploy();
    expect(mockKubectlReads.length).toBeGreaterThan(0);
    for (const args of mockKubectlReads) expect(args[0]).toBe('get');
  });

  // The registry token reaches the cluster only through the Secret file: a
  // kubectl command line would show it in the process list and, on failure,
  // in the error text deploy prints.
  describe('registry pull Secret', () => {
    const TOKEN = 'tok-registry-123';
    const secretFile = () => path.join(kymaDir, 'templates', 'secrets', 'registry-secret.yaml');
    const expectTokenNowhere = () => {
      for (const c of mockExecCommands) expect(c).not.toContain(TOKEN);
      expect(printed.join('\n')).not.toContain(TOKEN);
    };

    it('applies the registry-secret.yaml setup rendered, before the networking step', async () => {
      fs.writeFileSync(
        secretFile(),
        renderRegistrySecret({ namespace: 'sail-proxy', server: 'ghcr.io', username: 'robot', password: TOKEN })
      );
      mockKubectlAnswer = cluster('sail-proxy', liveMatching());
      await deploy();
      const apply = mockExecCommands.findIndex((c) => c === `kubectl apply -f "${secretFile()}"`);
      expect(apply).toBeGreaterThan(-1);
      expect(apply).toBeLessThan(mockExecCommands.findIndex((c) => /peer-authentication|PeerAuthentication/i.test(c)));
      expect(printed.join('\n')).toMatch(/Step 2: Applying image pull secret/);
      expectTokenNowhere();
    });

    it('writes an old-style KYMA_DEPLOY_CONFIG password to the Secret file and applies that', async () => {
      process.env.KYMA_DEPLOY_CONFIG = b64(
        JSON.stringify({
          namespace: 'sail-proxy',
          imagePullSecrets: true,
          containerRegistry: 'ghcr.io',
          dockerUsername: 'robot',
          dockerPassword: TOKEN,
        })
      );
      mockKubectlAnswer = cluster('sail-proxy', liveMatching());
      await deploy();
      const yaml = fs.readFileSync(secretFile(), 'utf8');
      const encoded = /\.dockerconfigjson: (\S+)/.exec(yaml)![1];
      expect(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')).auths['ghcr.io'].password).toBe(TOKEN);
      expect(mockExecCommands).toContain(`kubectl apply -f "${secretFile()}"`);
      expectTokenNowhere();
    });

    it('skips the pull secret step when there is neither a file nor credentials', async () => {
      mockKubectlAnswer = cluster('sail-proxy', liveMatching());
      await deploy();
      expect(mockExecCommands.some((c) => c.includes('registry-secret'))).toBe(false);
      expect(printed.join('\n')).toMatch(/Step 2: Applying mesh-at-edge networking/);
    });
  });

  // The Dex config holds client secrets. It used to be the ConfigMap dex-config; a render from
  // setup since then is the Secret dex-config, and the old ConfigMap must not stay behind.
  describe('Dex config Secret', () => {
    const secretFile = () => path.join(kymaDir, 'templates', 'secrets', 'dex-config.yaml');
    const DELETE_OLD = 'kubectl -n sail-proxy delete configmap dex-config --ignore-not-found';

    it('applies the dex-config Secret before Dex and deletes the old ConfigMap once Dex runs on it', async () => {
      fs.writeFileSync(
        secretFile(),
        'apiVersion: v1\nkind: Secret\nmetadata:\n  name: dex-config\n  namespace: sail-proxy\ntype: Opaque\nstringData:\n  config.yaml: |\n    issuer: x\n'
      );
      mockKubectlAnswer = cluster('sail-proxy', liveMatching());
      await deploy();
      const apply = mockExecCommands.indexOf(`kubectl apply -f "${secretFile()}"`);
      const dexReady = mockExecCommands.findIndex((c) => c.includes('rollout status deployment/dex '));
      const removed = mockExecCommands.indexOf(DELETE_OLD);
      expect(apply).toBeGreaterThan(-1);
      expect(dexReady).toBeGreaterThan(apply);
      expect(removed).toBeGreaterThan(dexReady);
    });

    it('keeps the ConfigMap for a render made before the Dex config became a Secret', async () => {
      mockKubectlAnswer = cluster('sail-proxy', liveMatching());
      await deploy();
      expect(mockExecCommands).not.toContain(DELETE_OLD);
    });
  });

  // The installation records its version and non-secret answers (install-record.js) once the
  // workloads are applied; recordedAt is the time of the apply, not of the render.
  describe('install record', () => {
    const recordFile = () => path.join(kymaDir, 'manifests', 'core', 'install-record.yaml');
    const recordApplies = () =>
      [...mockAppliedFiles.entries()].filter(([file]) => path.basename(file) === 'install-record.yaml');

    it('applies the rendered record after the workloads, stamped with recordedAt', async () => {
      fs.writeFileSync(
        recordFile(),
        renderInstallRecord({ namespace: 'sail-proxy', version: '1.2.3', answers: { provider: 'local' }, recordedBy: 'setup' })
      );
      mockKubectlAnswer = cluster('sail-proxy', liveMatching());
      await deploy();
      const applies = recordApplies();
      expect(applies).toHaveLength(1);
      const [file, content] = applies[0];
      expect(content).toMatch(/^ {2}recordedAt: "\d{4}-\d\d-\d\dT[^"]+Z"$/m);
      expect(content).toMatch(/^ {2}recordedBy: "setup"$/m);
      const at = mockExecCommands.indexOf(`kubectl apply -f "${file}"`);
      expect(at).toBeGreaterThan(mockExecCommands.findIndex((c) => c.includes('rollout status deployment/nginx ')));
      // The render stays as setup wrote it; the stamped copy is gone.
      expect(fs.readFileSync(recordFile(), 'utf8')).not.toMatch(/recordedAt/);
      expect(fs.existsSync(file)).toBe(false);
    });

    it('applyInstallRecord can record an upgrade', async () => {
      fs.writeFileSync(
        recordFile(),
        renderInstallRecord({ namespace: 'sail-proxy', version: '1.2.3', answers: {}, recordedBy: 'setup' })
      );
      await deployKyma.applyInstallRecord(path.join(kymaDir, 'manifests'), { recordedBy: 'upgrade', recordedAt: '2026-01-01T00:00:00.000Z' });
      const [, content] = recordApplies()[0];
      expect(content).toMatch(/^ {2}recordedBy: "upgrade"$/m);
      expect(content).toMatch(/^ {2}recordedAt: "2026-01-01T00:00:00.000Z"$/m);
    });

    it('a deploy whose rollout fails records nothing, and says so', async () => {
      fs.writeFileSync(
        recordFile(),
        renderInstallRecord({ namespace: 'sail-proxy', version: '1.2.3', answers: {}, recordedBy: 'setup' })
      );
      mockKubectlAnswer = cluster('sail-proxy', liveMatching());
      mockExecFails = (c) => c.includes('rollout status deployment/gateway ');
      await deploy();
      expect(recordApplies()).toHaveLength(0);
      expect(mockExecCommands.some((c) => c.includes('install-record'))).toBe(false);
      expect(printed.join('\n')).toContain('Not recording the installation (sail-proxy-install): 1 step(s) failed above.');
      // The failures are counted per run: the next, successful deploy records again.
      mockExecFails = () => false;
      await deploy();
      expect(recordApplies()).toHaveLength(1);
    });

    it('a render without a record applies none', async () => {
      mockKubectlAnswer = cluster('sail-proxy', liveMatching());
      await deploy();
      expect(mockExecCommands.some((c) => c.includes('install-record'))).toBe(false);
    });
  });

  // sail-proxy-test 2026-11-06: the oauth2-proxy Secret changed, the deploy said "deployment
  // unchanged", the pods kept the old client secret, and logins failed once Dex restarted.
  describe('Secrets checksum in the pod template', () => {
    const rendered = () => path.join(kymaDir, 'manifests', 'auth', 'oauth2-proxy.yaml');
    const secretFile = () => path.join(kymaDir, 'templates', 'secrets', 'oauth2-proxy-secrets.yaml');
    const GOLDEN = path.join(__dirname, 'fixtures', 'kyma-golden', 'sail-proxy', 'manifests', 'auth', 'oauth2-proxy.yaml');
    const writeOauthSecret = (clientSecret: string) =>
      fs.writeFileSync(
        secretFile(),
        `apiVersion: v1\nkind: Secret\nmetadata:\n  name: oauth2-proxy-secrets\n  namespace: sail-proxy\ntype: Opaque\nstringData:\n  client-secret: "${clientSecret}"\n  cookie-secret: "c"\n`
      );
    /** The oauth2-proxy manifest deploy applied, and the file it applied it from. */
    const appliedOauth = () => {
      const entries = [...mockAppliedFiles.entries()].filter(([, content]) => /name: oauth2-proxy\n/.test(content) && /kind: Deployment/.test(content));
      expect(entries).toHaveLength(1);
      return { file: entries[0][0], content: entries[0][1] };
    };
    const checksumOf = (content: string) => /sail-proxy\/secrets-checksum: "([0-9a-f]{64})"/.exec(content)?.[1];

    beforeEach(() => {
      fs.mkdirSync(path.dirname(rendered()), { recursive: true });
      fs.copyFileSync(GOLDEN, rendered());
      writeOauthSecret('client-1');
      mockKubectlAnswer = cluster('sail-proxy', liveMatching());
    });

    it('applies oauth2-proxy with a checksum of its Secret, leaving the render as setup wrote it', async () => {
      await deploy();
      const { file, content } = appliedOauth();
      expect(checksumOf(content)).toMatch(/^[0-9a-f]{64}$/);
      expect(content).not.toContain('client-1');
      expect(fs.readFileSync(rendered(), 'utf8')).toBe(fs.readFileSync(GOLDEN, 'utf8'));
      // The copy deploy applied is gone afterwards.
      expect(file).not.toBe(rendered());
      expect(fs.existsSync(file)).toBe(false);
      expect(mockExecCommands.findIndex((c) => c.includes('rollout status deployment/oauth2-proxy '))).toBeGreaterThan(
        mockExecCommands.indexOf(`kubectl apply -f "${file}"`)
      );
    });

    it('applies a different checksum once the Secret changed, and the same one while it did not', async () => {
      await deploy();
      const first = checksumOf(appliedOauth().content);
      mockAppliedFiles.clear();
      await deploy();
      expect(checksumOf(appliedOauth().content)).toBe(first);
      mockAppliedFiles.clear();
      writeOauthSecret('client-2');
      await deploy();
      expect(checksumOf(appliedOauth().content)).not.toBe(first);
    });
  });
});
