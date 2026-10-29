/**
 * The shared secrets a Kyma deployment runs with come from setup-kyma.js alone.
 *
 * setup-kyma.js generates VALIDATION_TOKEN_SECRET, METADATA_ENCRYPTION_KEY and
 * AWS_SECRET_ENCRYPTION_KEY and writes them into the gateway-env and admin-env
 * Secrets. It then runs docker/setup-docker.js --config, whose setupGatewayEnv
 * adopts the values of an existing local services/gateway/.env instead - so
 * the .env files postProcessEnvFiles reads can hold the developer's local
 * secrets. Those files only feed the gateway-config and admin-config
 * ConfigMaps, which must never carry these keys: the pods load envFrom the
 * Secret first and the ConfigMap second, and the later source wins, so a copy
 * in a ConfigMap would override the Secret and could give the gateway and the
 * admin different VALIDATION_TOKEN_SECRETs (breaking SigV4 key fetches and
 * usage events).
 *
 * The .env content setup-docker.js produces is written by a stand-in; setup-
 * docker.js itself never runs. Temp project and output roots only.
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

const LOCAL = {
  VALIDATION_TOKEN_SECRET: 'local-dev-validation-secret-0000000000000000000000000000000000000',
  METADATA_ENCRYPTION_KEY: 'local-dev-metadata-key-000000000000000000000000000000000000000000',
  AWS_SECRET_ENCRYPTION_KEY: 'local-dev-aws-key-00000000000000000000000000000000000000000000000',
  SIEM_CREDENTIAL_KEY: 'local-dev-siem-key-0000000000000000000000000000000000000000000000',
  CONNECTION_CREDENTIAL_KEY: 'local-dev-conn-key-0000000000000000000000000000000000000000000000',
};
const SHARED_KEYS = Object.keys(LOCAL) as Array<keyof typeof LOCAL>;

function stringData(file: string): Record<string, string> {
  const text = fs.readFileSync(file, 'utf8');
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/^ {2}([A-Za-z_.]+): (.*)$/gm)) {
    out[m[1]] = m[2].startsWith('"') ? JSON.parse(m[2]) : m[2];
  }
  return out;
}

/** The envFrom sources of the named container, in order. */
function envFromOrder(manifest: string, container: string): string[] {
  const text = fs.readFileSync(manifest, 'utf8');
  const start = text.indexOf(`- name: ${container}\n`);
  const block = text.slice(start, text.indexOf('ports:', start));
  return [...block.matchAll(/- (secretRef|configMapRef):\s*\n\s+name: (\S+)/g)].map(([, kind, name]) => `${kind}/${name}`);
}

describe.each(['sail-proxy', 'sail-proxy-test'])('Kyma shared secrets for namespace %s', (namespace) => {
  let projectRoot: string;
  let outputRoot: string;
  let root: string;
  let setup: any;

  beforeAll(async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-secret-project-'));
    outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-secret-output-'));
    root = namespace === 'sail-proxy' ? outputRoot : path.join(outputRoot, 'deployments', namespace);

    // A developer checkout with its own local secrets.
    const localEnv = SHARED_KEYS.map((k) => `${k}=${LOCAL[k]}`).join('\n') + '\n';
    fs.mkdirSync(path.join(projectRoot, 'services', 'gateway'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'services', 'admin'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'services', 'gateway', '.env'), `LOG_LEVEL=info\n${localEnv}`);
    fs.writeFileSync(path.join(projectRoot, 'services', 'admin', '.env'), `NODE_ENV=production\n${localEnv}`);

    setup = new KymaSetup({ namespace, outputRoot });
    setup.projectRoot = projectRoot;
    setup._k8sApiClusterIp = '10.0.0.1';
    // Worst case: the .env files setup-docker.js leaves behind hold the local
    // secrets (it adopts them from an existing .env). The stand-in writes
    // exactly that, then the real postProcessEnvFiles builds the ConfigMaps.
    setup.runDockerSetup = async (config: Record<string, unknown>) => {
      fs.writeFileSync(path.join(projectRoot, 'services', 'gateway', '.env'), `LOG_LEVEL=info\n${localEnv}`);
      fs.writeFileSync(path.join(projectRoot, 'services', 'admin', '.env'), `NODE_ENV=production\n${localEnv}`);
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
        {}
      );
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  afterAll(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(outputRoot, { recursive: true, force: true });
  });

  it('puts setup-kyma.js\'s generated values into both Secrets, identical for gateway and admin', () => {
    const gateway = stringData(path.join(root, 'templates', 'secrets', 'gateway-env.yaml'));
    const admin = stringData(path.join(root, 'templates', 'secrets', 'admin-env.yaml'));
    expect(gateway.VALIDATION_TOKEN_SECRET).toBe(setup.sharedSecrets.VALIDATION_TOKEN_SECRET);
    expect(admin.VALIDATION_TOKEN_SECRET).toBe(setup.sharedSecrets.VALIDATION_TOKEN_SECRET);
    expect(gateway.METADATA_ENCRYPTION_KEY).toBe(setup.sharedSecrets.METADATA_ENCRYPTION_KEY);
    expect(admin.METADATA_ENCRYPTION_KEY).toBe(setup.sharedSecrets.METADATA_ENCRYPTION_KEY);
    expect(admin.AWS_SECRET_ENCRYPTION_KEY).toBe(setup.sharedSecrets.AWS_SECRET_ENCRYPTION_KEY);
    expect(admin.SIEM_CREDENTIAL_KEY).toBe(setup.sharedSecrets.SIEM_CREDENTIAL_KEY);
    expect(admin.SIEM_CREDENTIAL_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(admin.CONNECTION_CREDENTIAL_KEY).toBe(setup.sharedSecrets.CONNECTION_CREDENTIAL_KEY);
    expect(admin.CONNECTION_CREDENTIAL_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(setup.sharedSecrets.VALIDATION_TOKEN_SECRET).not.toBe(LOCAL.VALIDATION_TOKEN_SECRET);
  });

  it('keeps the shared secrets and the local values out of both ConfigMaps', () => {
    for (const name of ['gateway-config.yaml', 'admin-config.yaml']) {
      const text = fs.readFileSync(path.join(root, 'templates', 'configmaps', name), 'utf8');
      for (const key of SHARED_KEYS) {
        expect({ name, key, present: text.includes(key) }).toEqual({ name, key, present: false });
        expect({ name, key, leaked: text.includes(LOCAL[key]) }).toEqual({ name, key, leaked: false });
      }
    }
  });

  it('never renders a local secret value anywhere', () => {
    const files = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]
      );
    for (const file of files(root)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const key of SHARED_KEYS) {
        expect({ file, key, leaked: text.includes(LOCAL[key]) }).toEqual({ file, key, leaked: false });
      }
    }
  });

  it('loads each pod\'s Secret before its ConfigMap, so a ConfigMap key would override the Secret', () => {
    // Documents the precedence the ConfigMap filter above protects.
    expect(envFromOrder(path.join(root, 'manifests', 'core', 'gateway.yaml'), 'gateway')).toEqual([
      'secretRef/gateway-env',
      'secretRef/gateway-s3-env',
      'configMapRef/gateway-config',
    ]);
    expect(envFromOrder(path.join(root, 'manifests', 'core', 'admin.yaml'), 'admin')).toEqual([
      'secretRef/admin-env',
      'configMapRef/admin-config',
    ]);
  });
});
