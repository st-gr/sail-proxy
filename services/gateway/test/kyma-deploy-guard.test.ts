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
let mockKubectlAnswer: (args: string[]) => string = () => '';

jest.mock('child_process', () => ({
  exec: (command: string, callback: (e: Error | null, r: { stdout: string; stderr: string }) => void) => {
    mockExecCommands.push(command);
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
});
